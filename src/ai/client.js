'use strict';
const { db, settings } = require('../core/db');
const { createLogger } = require('../core/logger');
const { PROVIDERS, MODEL_CHAINS } = require('../config/constants');
const keyPool = require('./keyPool');
const local = require('./local');

const log = createLogger('ai');

class AIError extends Error {
  constructor(message, kind = 'unknown', status = 0, retryAfterMs = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Map an HTTP status / network error onto a failure class for the key pool.
 *
 * The distinction that matters on free tiers: a per-minute rate limit clears in
 * seconds, while a daily quota or spent credit is gone for hours. Punishing the
 * former like the latter would idle the whole pool.
 */
function classify(status, bodyText = '') {
  const b = String(bodyText).toLowerCase();
  // OpenRouter answers 403 for a model that is gated ("only available on
  // agentic harnesses") — that is the model's problem, not the key's. Three
  // healthy keys were retired over it before this check existed.
  if (status === 403 && /only available|not available|no endpoints|this model|gated|moderat/.test(b)) return 'client';
  if (status === 401 || status === 403) return 'invalid';
  // An unfunded account is not a rate limit: retrying it every 20 minutes
  // forever burns attempts that other providers could have used. Park the key
  // until someone tops the account up.
  if (status === 402 || /insufficient balance|insufficient_quota|account.*suspended|please recharge|out of funds/i.test(b)) return 'billing';
  if (status === 429) {
    // A per-day budget ("TPD", "tokens per day") does not come back in
    // twenty minutes — retrying every twenty minutes just wastes the whole
    // pool's attempts on a provider that is out until tomorrow.
    const daily = /per day|\bdaily\b|\bper-day\b|requests per day|\brpd\b|\btpd\b|tokens per day/.test(b);
    const credits = /credit|balance|insufficient|out of funds|payment/.test(b);
    return daily ? 'quota_daily' : credits ? 'quota' : 'rate_limit';
  }
  if (status >= 500) return 'server';
  if (status === 0) return 'network';
  return 'client';
}

/**
 * Providers tell us exactly how long to wait — via the Retry-After header or a
 * "try again in 7.2s" hint in the body. Honour it instead of guessing.
 */
function parseRetryAfter(headers, bodyText) {
  const h = headers && headers.get && headers.get('retry-after');
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs) && secs > 0) return Math.min(3_600_000, secs * 1000);
  }
  const m = String(bodyText || '').match(/try again in\s+([\d.]+)\s*(ms|s|m|h)\b/i);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
    if (Number.isFinite(n)) return Math.min(3_600_000, Math.max(1000, n * mult));
  }
  return 0;
}

function recordCall(row) {
  try {
    db.prepare(
      `INSERT INTO ai_calls (provider, model, key_id, purpose, ok, latency_ms, tokens_in, tokens_out, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.provider,
      row.model,
      row.keyId ?? null,
      row.purpose || 'chat',
      row.ok ? 1 : 0,
      row.latencyMs || 0,
      row.tokensIn || 0,
      row.tokensOut || 0,
      row.error ? String(row.error).slice(0, 500) : null
    );
  } catch {
    /* telemetry must never throw */
  }
}

/** One raw HTTP call to an OpenAI-compatible chat endpoint. */
async function callOnce({ provider, key, model, body, timeoutMs = 90_000 }) {
  const p = PROVIDERS[provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        ...(p.extraHeaders || {}),
      },
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new AIError(
        text.slice(0, 600) || `HTTP ${res.status}`,
        classify(res.status, text),
        res.status,
        parseRetryAfter(res.headers, text)
      );
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AIError('Invalid JSON from provider', 'server', res.status);
    }

    // OpenRouter can return a 200 with an embedded error object.
    if (json.error) {
      const st = Number(json.error.code || json.error.status) || 500;
      const raw = JSON.stringify(json.error);
      throw new AIError(String(json.error.message || 'provider error').slice(0, 600), classify(st, raw), st, parseRetryAfter(res.headers, raw));
    }

    const choice = json.choices && json.choices[0];
    if (!choice) throw new AIError('Empty choices from provider', 'server', res.status);

    return {
      content: (choice.message && choice.message.content) || '',
      toolCalls: (choice.message && choice.message.tool_calls) || [],
      finishReason: choice.finish_reason,
      usage: json.usage || {},
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof AIError) throw err;
    if (err.name === 'AbortError') throw new AIError('Request timed out', 'network', 0);
    throw new AIError(err.message || 'network failure', 'network', 0);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the ordered (provider, model) attempt plan.
 *
 * Only providers that actually have a usable key are included, so a pool of six
 * configured providers does not mean six wasted round trips when five of them
 * have no keys. The preferred provider goes first; the rest follow as fallbacks.
 */
function buildPlan({ provider, model }) {
  const primary = provider || settings.get('primary_provider', 'groq');
  const health = keyPool.health();

  const usable = Object.keys(PROVIDERS).filter((p) => health[p] && health[p].available > 0);
  // If nothing looks available (stats can lag a cooldown expiry), fall back to
  // every provider that has keys at all rather than giving up early.
  const candidates = usable.length ? usable : Object.keys(PROVIDERS).filter((p) => health[p] && health[p].total > 0);

  const order = [
    ...candidates.filter((p) => p === primary),
    ...candidates.filter((p) => p !== primary),
  ];

  const plan = [];
  for (const p of order) {
    const chain = modelsFor(p);
    const models = model && p === primary ? [model, ...chain.filter((m) => m !== model)] : chain;
    for (const m of models) plan.push({ provider: p, model: m });
  }
  return plan;
}

/**
 * Model list for a provider: the discovered list when we have one, otherwise
 * the static chain. Discovery keeps working when a provider renames models.
 */
function modelsFor(providerId) {
  const raw = settings.get(`models_${providerId}`, '');
  if (raw) {
    const found = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (found.length) return found;
  }
  return MODEL_CHAINS[providerId] || [];
}

/**
 * Strip provider-specific extras from a conversation before replaying it.
 *
 * Providers echo their own fields back inside `tool_calls` (Groq adds
 * `extra_content`, others add indexes and reasoning blobs). Sending one
 * provider's shape to another is rejected outright — Mistral answered
 * "extra_forbidden" and the whole fallback chain died mid-task. Only the
 * fields the OpenAI schema defines survive.
 */
/**
 * Rewrite a tool-calling history as plain text.
 *
 * Gemini 3.x refuses a `tool_calls` history it did not produce itself:
 *
 *   400 — "Function call is missing a thought_signature in functionCall
 *          parts. This is required for tools to work correctly"
 *
 * That signature is Gemini's own opaque token, attached to calls IT made.
 * Our history comes from whichever provider answered the previous round —
 * usually a different one — so the request is rejected outright. And it is
 * rejected on the FIRST fallback, meaning Gemini's remaining capacity is
 * unreachable exactly when the others have run out. That is what happened:
 * mistral and openrouter were rate-limited, gemini 400'd on the history,
 * and the founder was told "AI unavailable" while a working key sat idle.
 *
 * So the exchange is flattened. The model loses the structured link but
 * keeps the only thing it needs to continue: which tool was called, with
 * what, and what came back. New calls it makes are structured as normal —
 * this touches history only.
 */
function flattenToolHistory(messages) {
  const out = [];

  const push = (role, content) => {
    if (!content) return;
    const last = out[out.length - 1];
    // Ketma-ket bir xil rol — Gemini buni yoqtirmaydi, birlashtiramiz
    if (last && last.role === role) last.content += `\n${content}`;
    else out.push({ role, content });
  };

  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls
        .map((c) => {
          const name = c.function?.name || 'tool';
          const args =
            typeof c.function?.arguments === 'string'
              ? c.function.arguments
              : JSON.stringify(c.function?.arguments || {});
          return `${name}(${String(args).slice(0, 600)})`;
        })
        .join(', ');
      push('assistant', `${m.content ? m.content + '\n' : ''}[Called: ${calls}]`);
      continue;
    }

    if (m.role === 'tool') {
      // Natija foydalanuvchi roli bilan qaytadi: "mana nima qaytdi" —
      // Gemini uchun bu tabiiy o'qiladi va tool_call_id talab qilmaydi.
      push('user', `[Result of ${m.name || 'tool'}]: ${String(m.content ?? '').slice(0, 4000)}`);
      continue;
    }

    push(m.role, typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
  }

  return out;
}

/** Providers that cannot take a foreign tool-calling history. */
const FLATTENS_TOOL_HISTORY = new Set(['gemini']);

function normalizeMessages(messages, provider = null) {
  if (provider && FLATTENS_TOOL_HISTORY.has(provider) && messages.some((m) => m.role === 'tool' || m.tool_calls)) {
    return flattenToolHistory(messages);
  }

  return messages.map((m) => {
    const out = { role: m.role };
    if (m.content !== undefined && m.content !== null) out.content = m.content;
    else if (m.role !== 'assistant') out.content = '';
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.content = m.content || '';
      out.tool_calls = m.tool_calls.map((c, i) => ({
        id: c.id || `call_${i}`,
        type: 'function',
        function: {
          name: c.function && c.function.name,
          arguments: typeof (c.function && c.function.arguments) === 'string' ? c.function.arguments : JSON.stringify((c.function && c.function.arguments) || {}),
        },
      }));
    }
    if (m.role === 'tool') {
      out.tool_call_id = m.tool_call_id;
      if (m.name) out.name = m.name;
    }
    return out;
  });
}

/**
 * Resilient chat completion.
 *
 * Walks provider -> model -> key. A key that rate-limits is put on cooldown and
 * the next key is tried immediately; a model that is unavailable falls through
 * to the next model, then the next provider. Only when the entire plan is
 * exhausted does this throw.
 */
async function chat({
  messages,
  tools = null,
  toolChoice = 'auto',
  model = null,
  provider = null,
  temperature = null,
  maxTokens = null,
  json = false,
  purpose = 'chat',
  maxAttempts = 10,
  timeoutMs = 90_000,
  preferred = null,
  preferredOnly = false,
}) {
  // `preferred`: an explicit [{provider, model}] ladder tried first — the
  // assistant and coder need tool-capable models in a specific order, not
  // "whatever provider comes next". The generic plan follows as a safety net
  // unless `preferredOnly`: for an agent that acts on the real account, a
  // weak model that narrates "done" is worse than no answer.
  let plan = buildPlan({ provider, model });
  if (Array.isArray(preferred) && preferred.length) {
    const health = keyPool.health();
    const head = preferred.filter((s) => s && health[s.provider] && health[s.provider].total > 0);
    const seen = new Set(head.map((s) => `${s.provider}/${s.model}`));
    plan = preferredOnly ? head : [...head, ...plan.filter((s) => !seen.has(`${s.provider}/${s.model}`))];
  }
  const temp = temperature ?? settings.float('temperature', 0.55);
  const mt = maxTokens ?? settings.int('max_tokens', 700);

  const errors = [];
  let attempts = 0;

  // Local model first for the purposes it is allowed to serve (support replies
  // by default). No tools, no JSON mode — those stay on the cloud. Any failure
  // simply falls through to the provider plan below.
  // `available(purpose)` — maqsadsiz emas. Lokal model GPU'siz mashinada
  // odam kutayotgan ish uchun yaramaydi va ketma-ket sekinlashsa o'zini
  // tez yo'ldan chetga oladi; sozlamada nima yozilganidan qat'i nazar.
  const localPurposes = String(settings.get('local_purposes', 'reply,reply:retry,memory:summary')).split(',').map((s) => s.trim());
  if (!provider && !json && local.available(purpose) && localPurposes.includes(purpose)) {
    const started = Date.now();
    try {
      const out = await local.chat({ messages, maxTokens: mt, temperature: temp });
      recordCall({ provider: 'local', model: local.CATALOG.chat.file, purpose, ok: true, latencyMs: out.latencyMs });
      log.debug('completion ok (local)', { purpose, ms: out.latencyMs });
      return { ...out, provider: 'local', model: local.CATALOG.chat.label, keyId: null };
    } catch (err) {
      errors.push(`local: ${err.message.slice(0, 120)}`);
      recordCall({ provider: 'local', model: local.CATALOG.chat.file, purpose, ok: false, latencyMs: Date.now() - started, error: err.message });
      log.warn('lokal model xatosi — cloudga oʻtildi', { error: err.message });
    }
  }

  for (const step of plan) {
    const triedKeys = [];
    // Give each model up to 3 different keys before moving on.
    for (let keyTry = 0; keyTry < 3; keyTry++) {
      if (attempts >= maxAttempts) break;
      const cred = keyPool.acquire(step.provider, triedKeys);
      if (!cred) break;
      triedKeys.push(cred.id);
      attempts++;

      const body = {
        messages: normalizeMessages(messages, step.provider),
        temperature: temp,
        max_tokens: mt,
        stream: false,
      };
      if (json) body.response_format = { type: 'json_object' };
      if (tools && tools.length && PROVIDERS[step.provider].supportsTools) {
        body.tools = tools;
        body.tool_choice = toolChoice;
      }

      try {
        const out = await callOnce({ provider: step.provider, key: cred.key, model: step.model, body, timeoutMs });
        const tokensIn = out.usage.prompt_tokens || 0;
        const tokensOut = out.usage.completion_tokens || 0;
        keyPool.markSuccess(cred.id, tokensIn + tokensOut);
        recordCall({ provider: step.provider, model: step.model, keyId: cred.id, purpose, ok: true, latencyMs: out.latencyMs, tokensIn, tokensOut });
        log.debug('completion ok', { provider: step.provider, model: step.model, purpose, ms: out.latencyMs, attempts });
        return { ...out, provider: step.provider, model: step.model, keyId: cred.id };
      } catch (err) {
        const kind = err.kind || 'unknown';
        errors.push(`${step.provider}/${step.model}: ${kind} ${err.message.slice(0, 120)}`);
        recordCall({ provider: step.provider, model: step.model, keyId: cred.id, purpose, ok: false, error: `${kind}: ${err.message}` });

        if (kind === 'billing') {
          // Whole account is unfunded — every key on this provider will fail
          // the same way, so stop trying it this run.
          keyPool.setStatus(cred.id, 'disabled');
          log.warn('kalit balansi yoʻq — oʻchirildi', { provider: step.provider, keyId: cred.id });
          continue;
        }
        if (kind === 'client') {
          // Bad request for this model (unsupported tools, bad params) — do not
          // punish the key, just move to the next model.
          log.debug('model rejected request', { provider: step.provider, model: step.model, err: err.message.slice(0, 160) });
          break;
        }
        keyPool.markFailure(cred.id, kind, err.message, err.retryAfterMs || 0);
        if (kind === 'quota' || kind === 'quota_daily' || kind === 'invalid') continue; // try another key
        if (kind === 'rate_limit') continue;
        if (kind === 'server' || kind === 'network') continue;
      }
    }
  }

  const summary = errors.slice(-6).join(' | ') || 'no usable API keys';
  log.error('all AI providers failed', { purpose, attempts, summary });
  throw new AIError(`AI unavailable: ${summary}`, 'exhausted', 0);
}

/** Chat that must return JSON. Repairs common model formatting mistakes. */
async function chatJSON(opts) {
  const out = await chat({ ...opts, json: true });
  const parsed = parseLooseJSON(out.content);
  if (parsed === null) throw new AIError('Model did not return parseable JSON', 'parse', 0);
  return { ...out, data: parsed };
}

/** Tolerant JSON extraction — handles code fences and leading prose. */
function parseLooseJSON(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const candidates = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  candidates.push(raw);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  const fa = raw.indexOf('[');
  const la = raw.lastIndexOf(']');
  if (fa !== -1 && la > fa) candidates.push(raw.slice(fa, la + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim());
    } catch {
      /* try next candidate */
    }
  }

  // Last resort: the model hit its token limit mid-structure. Salvage the
  // complete elements by cutting at the last finished one and closing the
  // containers that were left open.
  const repaired = repairTruncatedJSON(raw);
  if (repaired) {
    try {
      return JSON.parse(repaired);
    } catch {
      /* unrecoverable */
    }
  }
  return null;
}

/**
 * Rebuild parseable JSON from a truncated response.
 * Walks the text tracking string/escape state and the open-container stack,
 * remembering the last position where an element was complete, then closes
 * whatever was open at that point.
 */
function repairTruncatedJSON(text) {
  const s = String(text || '');
  const start = ['{', '['].map((c) => s.indexOf(c)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return null;

  const stack = [];
  let inStr = false;
  let esc = false;
  let cut = -1;
  let cutStack = null;

  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      if (inStr) esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;

    if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
    } else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length) {
        cut = i;
        cutStack = [...stack];
      }
    } else if (c === ',' && stack.length) {
      cut = i - 1;
      cutStack = [...stack];
    }
  }

  if (!stack.length) return null; // wasn't truncated — a different problem
  if (cut < start || !cutStack) return null;

  let out = s.slice(start, cut + 1);
  for (let i = cutStack.length - 1; i >= 0; i--) out += cutStack[i];
  return out;
}

/**
 * Ask a provider which models it actually serves.
 *
 * Hard-coded model names go stale — a renamed model silently burns the whole
 * chain. Every provider here implements the OpenAI /models endpoint, so the
 * list is discovered once per key test and cached in settings.
 */
async function discoverModels(providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return { ok: false, error: 'unknown provider' };

  const cred = keyPool.acquire(providerId);
  if (!cred) return { ok: false, error: 'no usable key' };

  try {
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cred.key}`, ...(p.extraHeaders || {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const json = await res.json();
    const all = (json.data || json.models || [])
      .map((m) => m.id || m.name || '')
      .map((s) => String(s).replace(/^models\//, ''))
      .filter(Boolean);
    if (!all.length) return { ok: false, error: 'empty model list' };

    // Keep chat models, drop embeddings/audio/vision-only endpoints, then
    // prefer whatever the static chain already knew as the head of the list.
    const chat = all.filter((m) => !/embed|whisper|tts|audio|image|video|guard|rerank|moderation|veo|imagen/i.test(m));
    const known = (MODEL_CHAINS[providerId] || []).filter((m) => chat.includes(m));
    const rest = chat.filter((m) => !known.includes(m));
    const ordered = [...known, ...rest].slice(0, 8);

    settings.set(`models_${providerId}`, ordered.join(','));
    log.info('Modellar aniqlandi', { provider: providerId, count: ordered.length, models: ordered.slice(0, 4) });
    return { ok: true, models: ordered, total: all.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Verify a single key works, without touching pool state. */
async function testKey(id) {
  const rec = keyPool.getRawKey(id);
  if (!rec) return { ok: false, error: 'key not found' };
  // Probe with the chain's primary model — the one real traffic will use.
  const model = modelsFor(rec.provider)[0] || (MODEL_CHAINS[rec.provider] || [])[0];
  if (!model) return { ok: false, error: 'model chain empty' };
  try {
    const out = await callOnce({
      provider: rec.provider,
      key: rec.key,
      model,
      body: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, temperature: 0 },
      timeoutMs: 25_000,
    });
    keyPool.markSuccess(id, 0);
    return { ok: true, model, latencyMs: out.latencyMs };
  } catch (err) {
    keyPool.markFailure(id, err.kind || 'unknown', err.message);
    return { ok: false, error: err.message.slice(0, 240), kind: err.kind };
  }
}

/**
 * Full token accounting for the panel: lifetime, 24h and 7d totals, plus a
 * per-provider and per-model breakdown. Operators need to see where the budget
 * actually goes when several free tiers are in play.
 */
function tokenStats() {
  const window = (since) =>
    db
      .prepare(
        `SELECT COUNT(*) AS calls, SUM(ok) AS ok, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
                AVG(latency_ms) AS avg_ms
         FROM ai_calls ${since ? `WHERE created_at > datetime('now', ?)` : ''}`
      )
      .get(...(since ? [since] : []));

  const shape = (r) => ({
    calls: r.calls || 0,
    ok: r.ok || 0,
    failed: (r.calls || 0) - (r.ok || 0),
    tokensIn: r.tin || 0,
    tokensOut: r.tout || 0,
    tokensTotal: (r.tin || 0) + (r.tout || 0),
    avgLatencyMs: Math.round(r.avg_ms || 0),
  });

  const byProvider = db
    .prepare(
      `SELECT provider, COUNT(*) AS calls, SUM(ok) AS ok, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
              AVG(latency_ms) AS avg_ms
       FROM ai_calls GROUP BY provider ORDER BY (SUM(tokens_in) + SUM(tokens_out)) DESC`
    )
    .all()
    .map((r) => ({
      provider: r.provider,
      calls: r.calls,
      ok: r.ok || 0,
      tokensIn: r.tin || 0,
      tokensOut: r.tout || 0,
      tokensTotal: (r.tin || 0) + (r.tout || 0),
      avgLatencyMs: Math.round(r.avg_ms || 0),
    }));

  const byPurpose = db
    .prepare(
      `SELECT purpose, COUNT(*) AS calls, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout
       FROM ai_calls GROUP BY purpose ORDER BY (SUM(tokens_in) + SUM(tokens_out)) DESC`
    )
    .all()
    .map((r) => ({ purpose: r.purpose, calls: r.calls, tokensTotal: (r.tin || 0) + (r.tout || 0) }));

  // Per-key totals expose an unevenly used pool at a glance.
  const byKey = db
    .prepare(
      `SELECT provider, key_mask, successes, failures, tokens_used, status, last_used_at
       FROM api_keys ORDER BY tokens_used DESC LIMIT 12`
    )
    .all();

  return {
    lifetime: shape(window(null)),
    last24h: shape(window('-24 hours')),
    last7d: shape(window('-7 days')),
    byProvider,
    byPurpose,
    byKey,
  };
}

/** Rolling usage stats for the dashboard. */
function usageStats() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              SUM(ok) AS ok,
              SUM(tokens_in) AS tin,
              SUM(tokens_out) AS tout,
              AVG(latency_ms) AS avg_ms
       FROM ai_calls WHERE created_at > datetime('now', '-24 hours')`
    )
    .get();
  const byModel = db
    .prepare(
      `SELECT provider, model, COUNT(*) AS calls, SUM(ok) AS ok FROM ai_calls
       WHERE created_at > datetime('now', '-24 hours') GROUP BY provider, model ORDER BY calls DESC LIMIT 8`
    )
    .all();
  return {
    calls24h: row.calls || 0,
    ok24h: row.ok || 0,
    tokensIn24h: row.tin || 0,
    tokensOut24h: row.tout || 0,
    avgLatencyMs: Math.round(row.avg_ms || 0),
    byModel,
  };
}

module.exports = { chat, chatJSON, testKey, discoverModels, modelsFor, parseLooseJSON, usageStats, tokenStats, normalizeMessages, AIError };
