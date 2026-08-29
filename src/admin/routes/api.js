'use strict';
const express = require('express');
const QRCode = require('qrcode');
const { db, settings, recordEvent, vacuumOld } = require('../../core/db');
const { recentLogs, searchLogs, knownScopes, levels: LOG_LEVELS, logBus, createLogger } = require('../../core/logger');
const { DEFAULT_SETTINGS, PROVIDERS, MODEL_CHAINS, BRAND } = require('../../config/constants');

const keyPool = require('../../ai/keyPool');
const ai = require('../../ai/client');
const local = require('../../ai/local');
const tg = require('../../telegram/client');
const store = require('../../knowledge/store');
const seed = require('../../knowledge/seed');
const ingest = require('../../knowledge/ingest');
const selfTrain = require('../../training/selfTrain');
const promptBuilder = require('../../training/promptBuilder');
const skills = require('../../agent/skills');
const memory = require('../../agent/memory');
const brain = require('../../agent/brain');
const runtime = require('../../agent/runtime');
const tasks = require('../../agent/tasks');
const memoryFacts = require('../../agent/memoryFacts');
const contacts = require('../../agent/contacts');
const bots = require('../../agent/bots');
const projects = require('../../agent/projects');
const coder = require('../../agent/coder');
const servers = require('../../agent/servers');
const watches = require('../../agent/watches');
const routines = require('../../agent/routines');
const shell = require('../../agent/shell');
const { fmtTashkent } = require('../../agent/timeparse');
const stats = require('../stats');
const auth = require('../auth');

const log = createLogger('admin:api');
const router = express.Router();

/** Wrap an async handler so rejections become 500s instead of hanging. */
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    log.error(`${req.method} ${req.path} failed`, { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
};

// ── dashboard ───────────────────────────────────────────────────────────────
router.get(
  '/status',
  wrap(async (req, res) => {
    res.json({
      agent: runtime.snapshot(),
      telegram: tg.info(),
      keys: keyPool.health(),
      ai: ai.usageStats(),
      knowledge: store.stats(),
      skills: db.prepare('SELECT COUNT(*) AS c FROM skills WHERE enabled = 1').get().c,
      prompt: promptBuilder.activeGeneratedPrompt() ? { version: promptBuilder.activeGeneratedPrompt().version } : null,
      training: {
        running: selfTrain.state.running,
        phase: selfTrain.state.phase,
        progress: selfTrain.state.progress,
        message: selfTrain.state.message,
        lastAt: settings.get('last_training_at', null),
      },
      system: {
        node: process.versions.node,
        uptimeSec: Math.round(process.uptime()),
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        pid: process.pid,
        now: new Date().toISOString(),
      },
      brand: BRAND,
    });
  })
);

/** Chart-ready aggregates for the dashboard. */
router.get('/stats', (req, res) => res.json(stats.all(Math.min(168, Number(req.query.hours) || 24))));

/**
 * The log, filtered.
 *
 * `hours` reaches back into the daily files (1 hour … 7 days); without it
 * this stays the cheap in-memory read the panel uses for its first paint.
 */
router.get('/logs', (req, res) => {
  if (req.query.hours || req.query.scope || req.query.q) {
    return res.json(
      searchLogs({
        hours: Number(req.query.hours) || 1,
        level: req.query.level || null,
        scope: req.query.scope || null,
        q: req.query.q || '',
        limit: Number(req.query.limit) || 500,
      })
    );
  }
  res.json(recentLogs(Number(req.query.limit) || 200, req.query.level || null));
});

/**
 * What the filter dropdowns offer.
 *
 * Scopes come from what has actually been logged in the last day, not from a
 * hardcoded list — a filter offering a scope that never appears is worse
 * than no filter. The in-memory ring is only minutes deep, so the day's file
 * is the honest source; `knownScopes()` fills in anything written since the
 * last flush.
 */
router.get('/logs/facets', (req, res) => {
  const fromFiles = searchLogs({ hours: 24, limit: 5000 }).items.map((e) => e.scope);
  const scopes = [...new Set([...fromFiles, ...knownScopes()].filter(Boolean))].sort();
  res.json({ levels: LOG_LEVELS, scopes });
});

/**
 * What the agent is doing right now.
 *
 * Three things, because they answer one question between them: which jobs
 * are open, how far each has got through its own checklist, and what it is
 * typing into the terminal at this moment. Separately none of them says
 * whether the work is going well.
 */
router.get('/activity', (req, res) => {
  const todo = require('../../agent/todo');

  const running = tasks.list({ limit: 60 }).filter((t) => t.status === 'pending' || t.status === 'running');

  /**
   * Checklists with unfinished items — the live jobs, including coding runs
   * that have no row in `tasks` at all.
   *
   * A list nobody has touched for half an hour is reported as STALLED rather
   * than hidden. Hiding it would be the comfortable lie: the founder would
   * see an empty "in progress" panel and conclude everything finished, when
   * in fact a job stopped halfway. Stalled work is exactly what he needs to
   * see.
   */
  const STALE_AFTER_MS = 30 * 60_000;
  const checklists = todo.openLists({ hours: Number(req.query.hours) || 12 }).map(({ owner, updated_at }) => {
    const s = todo.summary(owner) || { total: 0, done: 0, blocked: 0, items: [] };
    const [kind, subject] = String(owner).split(':');
    const touched = Date.parse(`${String(updated_at).replace(' ', 'T')}Z`);
    return {
      owner,
      kind,                                   // coder | assistant | routine
      subject: subject || null,               // qaysi loyiha yoki chat
      updatedAt: updated_at,
      stalled: Number.isFinite(touched) && Date.now() - touched > STALE_AFTER_MS,
      total: s.total,
      done: s.done,
      blocked: s.blocked,
      percent: s.total ? Math.round((s.done / s.total) * 100) : 0,
      current: s.items.find((i) => i.status === 'in_progress')?.text || null,
      items: s.items,
    };
  });

  res.json({
    tasks: running.map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      status: t.status,
      attempts: t.attempts,
      runAt: t.run_at,
      startedAt: t.started_at,
      // A task and its checklist are linked by the owner key the agent uses.
      checklist: checklists.find((c) => c.owner.includes(String(t.id))) || null,
    })),
    checklists,
    commands: shell.recentCommands({ limit: Number(req.query.commands) || 60 }),
    sessions: shell.listSessions(),
  });
});

router.get('/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const onLog = (entry) => {
    try {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  logBus.on('log', onLog);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    logBus.off('log', onLog);
  });
});

// ── telegram ────────────────────────────────────────────────────────────────
router.get('/telegram', wrap(async (req, res) => res.json(tg.info())));

router.post(
  '/telegram/connect',
  wrap(async (req, res) => {
    const { apiId, apiHash, phone, forceSms } = req.body || {};
    // apiId/apiHash may be omitted when they are already stored — the panel
    // sends null rather than risk overwriting good credentials with an
    // autofilled value. Phone is always required to start the code flow.
    const rec = tg.record();
    const haveStored = rec && rec.api_id && rec.api_hash_enc;
    if ((!apiId || !apiHash) && !haveStored) return res.status(400).json({ error: 'apiId va apiHash majburiy' });
    if (!phone) return res.status(400).json({ error: 'Telefon raqam majburiy' });
    if (!/^\+?\d{7,15}$/.test(String(phone).replace(/\s/g, ''))) return res.status(400).json({ error: "Telefon raqam formati noto'g'ri" });
    const out = await tg.login({
      apiId: apiId ? Number(apiId) : null,
      apiHash: apiHash ? String(apiHash).trim() : null,
      phone: String(phone).replace(/\s/g, ''),
      forceSms: !!forceSms,
    });
    res.json({ ...out, info: tg.info() });
  })
);

/**
 * QR login. The SVG is rendered server-side so the page needs no external
 * script — the panel's CSP blocks CDNs by design.
 */
router.post(
  '/telegram/qr',
  wrap(async (req, res) => {
    const { apiId, apiHash } = req.body || {};
    const rec = tg.record();
    if ((!apiId || !apiHash) && (!rec || !rec.api_id || !rec.api_hash_enc)) {
      return res.status(400).json({ error: 'apiId va apiHash majburiy' });
    }
    const state = await tg.loginQr({ apiId: apiId ? Number(apiId) : null, apiHash: apiHash ? String(apiHash).trim() : null });
    res.json({ ...state, svg: state.url ? await renderQr(state.url) : null, info: tg.info() });
  })
);

router.get(
  '/telegram/qr',
  wrap(async (req, res) => {
    const state = tg.qrState();
    res.json({ ...state, svg: state.url ? await renderQr(state.url) : null, info: tg.info() });
  })
);

async function renderQr(text) {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 260,
    color: { dark: '#0a0a12', light: '#ffffff' },
  });
}

router.post(
  '/telegram/code',
  wrap(async (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Kod kiritilmadi' });
    tg.submitCode(code);
    await new Promise((r) => setTimeout(r, 2500));
    res.json({ status: tg.status, info: tg.info() });
  })
);

router.post(
  '/telegram/password',
  wrap(async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Parol kiritilmadi' });
    tg.submitPassword(password);
    await new Promise((r) => setTimeout(r, 3000));
    res.json({ status: tg.status, info: tg.info() });
  })
);

router.post(
  '/telegram/resume',
  wrap(async (req, res) => {
    const ok = await tg.resume();
    res.json({ ok, info: tg.info() });
  })
);

router.post(
  '/telegram/logout',
  wrap(async (req, res) => {
    await tg.logout({ revoke: !!(req.body && req.body.revoke) });
    res.json({ ok: true, info: tg.info() });
  })
);

router.get(
  '/telegram/dialogs',
  wrap(async (req, res) => {
    if (!tg.isConnected()) return res.status(400).json({ error: 'Telegram ulanmagan' });
    res.json(await tg.getDialogs(Number(req.query.limit) || 100));
  })
);

// ── AI keys ─────────────────────────────────────────────────────────────────
router.get('/keys', (req, res) => res.json({ keys: keyPool.listKeys(), health: keyPool.health(), providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, signup: p.signup || null, prefix: p.keyPrefix || null })), models: MODEL_CHAINS }));

router.post(
  '/keys',
  wrap(async (req, res) => {
    const { keys, provider, label } = req.body || {};
    if (!keys || !String(keys).trim()) return res.status(400).json({ error: 'Kalit kiritilmadi' });
    const out = keyPool.importKeys(keys, provider || null, label || null);
    recordEvent('keys', 'API keys imported', out);
    res.json({ ...out, keys: keyPool.listKeys(), health: keyPool.health() });
  })
);

router.post(
  '/keys/:id/test',
  wrap(async (req, res) => {
    const out = await ai.testKey(Number(req.params.id));
    // A working key is also our chance to learn what that provider serves,
    // so hard-coded model names can never go stale unnoticed.
    if (out.ok) {
      const rec = keyPool.getRawKey(Number(req.params.id));
      if (rec) {
        const found = await ai.discoverModels(rec.provider).catch(() => null);
        if (found && found.ok) out.models = found.models;
      }
    }
    res.json(out);
  })
);

/** Ask a provider which models it serves and cache the list. */
router.post(
  '/keys/discover/:provider',
  wrap(async (req, res) => {
    res.json(await ai.discoverModels(req.params.provider));
  })
);

router.post(
  '/keys/test-all',
  wrap(async (req, res) => {
    const list = keyPool.listKeys();
    const results = [];
    for (const k of list) results.push({ id: k.id, provider: k.provider, mask: k.mask, ...(await ai.testKey(k.id)) });
    res.json({ results, health: keyPool.health() });
  })
);

router.post('/keys/:id/status', (req, res) => {
  const status = String((req.body && req.body.status) || 'active');
  if (!['active', 'disabled', 'dead'].includes(status)) return res.status(400).json({ error: 'noto\'g\'ri status' });
  keyPool.setStatus(Number(req.params.id), status);
  res.json({ ok: true, keys: keyPool.listKeys() });
});

router.delete('/keys/:id', (req, res) => {
  keyPool.removeKey(Number(req.params.id));
  res.json({ ok: true, keys: keyPool.listKeys() });
});

router.post('/keys/revive', (req, res) => res.json({ ok: true, revived: keyPool.reviveAll(), keys: keyPool.listKeys() }));

router.get('/keys/usage', (req, res) => res.json(ai.usageStats()));

/** Full token accounting for the panel. */
router.get('/tokens', (req, res) => res.json(ai.tokenStats()));

// ── knowledge ───────────────────────────────────────────────────────────────
router.get('/knowledge', (req, res) => {
  res.json({
    items: store.list({ q: req.query.q || '', source: req.query.source || '', limit: Number(req.query.limit) || 100 }),
    stats: store.stats(),
  });
});

router.post('/knowledge', (req, res) => {
  const { title, content, tags, weight } = req.body || {};
  if (!content || String(content).trim().length < 8) return res.status(400).json({ error: 'Matn juda qisqa' });
  const id = store.upsert({ source: 'manual', title: title || null, content, tags: tags || null, weight: Number(weight) || 1.5 });
  res.json({ ok: !!id, id, stats: store.stats() });
});

router.delete('/knowledge/:id', (req, res) => res.json({ ok: !!store.remove(Number(req.params.id)), stats: store.stats() }));

router.post('/knowledge/:id/toggle', (req, res) => {
  const on = !!(req.body && req.body.enabled);
  res.json({ ok: !!store.setEnabled(Number(req.params.id), on) });
});

router.post('/knowledge/seed', (req, res) => res.json(seed.run({ force: true })));

router.post('/knowledge/search', (req, res) => {
  const q = String((req.body && req.body.q) || '');
  res.json({ results: store.search(q, Number((req.body && req.body.limit) || 8)) });
});

/**
 * One document, in full, and editing it.
 *
 * `:id(\d+)` is not decoration: a bare `:id` declared here would match
 * "/knowledge/qa" too and hand the QA endpoint's traffic to this handler.
 * Constraining it to digits keeps the two apart no matter what order the
 * routes end up in.
 */
router.get('/knowledge/:id(\\d+)', (req, res) => {
  const item = store.get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Hujjat topilmadi' });
  res.json(item);
});

router.post('/knowledge/:id(\\d+)', (req, res) => {
  const { title, content, tags, weight } = req.body || {};
  const out = store.update(Number(req.params.id), { title, content, tags, weight });
  if (!out.ok) return res.status(400).json(out);
  res.json({ ...out, stats: store.stats() });
});

router.get('/knowledge/qa', (req, res) => {
  res.json(db.prepare('SELECT id, question, answer, source, score, created_at FROM qa_pairs ORDER BY id DESC LIMIT ?').all(Number(req.query.limit) || 100));
});

router.delete('/knowledge/qa/:id', (req, res) => {
  db.prepare('DELETE FROM qa_pairs WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── training ────────────────────────────────────────────────────────────────
router.get('/training', (req, res) => {
  res.json({ state: selfTrain.state, history: selfTrain.history(15), lastAt: settings.get('last_training_at', null) });
});

router.post('/training/run', (req, res) => {
  if (selfTrain.state.running) return res.status(409).json({ error: 'Trening allaqachon ishlamoqda' });
  const skipIngest = !!(req.body && req.body.skipIngest);
  // Fire and forget — the panel polls /training for progress.
  selfTrain.run({ skipIngest }).catch((err) => log.error('training crashed', { error: err.message }));
  res.json({ ok: true, started: true });
});

router.post(
  '/ingest',
  wrap(async (req, res) => {
    if (!tg.isConnected()) return res.status(400).json({ error: 'Telegram ulanmagan' });
    const out = await ingest.ingestAll();
    res.json(out);
  })
);

// ── prompts ─────────────────────────────────────────────────────────────────
router.get('/prompts', (req, res) => {
  res.json({
    list: promptBuilder.listPrompts(),
    active: promptBuilder.activeGeneratedPrompt(),
    core: promptBuilder.coreRules(),
  });
});

router.get('/prompts/:id', (req, res) => {
  const p = promptBuilder.getPrompt(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'topilmadi' });
  res.json(p);
});

router.post('/prompts', (req, res) => {
  const { content, notes } = req.body || {};
  if (!content || String(content).trim().length < 50) return res.status(400).json({ error: 'Prompt juda qisqa' });
  res.json(promptBuilder.saveGeneratedPrompt(String(content).trim(), notes || 'manual'));
});

router.post('/prompts/:id/activate', (req, res) => res.json({ ok: promptBuilder.activatePrompt(Number(req.params.id)) }));

router.get('/prompts/preview/runtime', wrap(async (req, res) => {
  const text = String(req.query.q || 'ANITOKU qachon ishga tushadi?');
  const { text: context } = await store.buildContext(text, settings.int('rag_top_k', 6));
  const matched = skills.selectFor(text, settings.int('skill_top_k', 3));
  res.json({
    prompt: promptBuilder.buildRuntimePrompt({ context, skills: matched, chatInfo: { type: 'private', title: 'Test' } }),
    skills: matched.map((s) => s.slug),
  });
}));

// ── skills ──────────────────────────────────────────────────────────────────
router.get('/skills', (req, res) => res.json(skills.list()));

router.post('/skills', (req, res) => {
  const { slug, name, description, triggers, instructions, examples, priority, enabled } = req.body || {};
  if (!name || !instructions) return res.status(400).json({ error: 'name va instructions majburiy' });
  const s = skills.save({
    slug: slug || null,
    name,
    description: description || '',
    triggers: triggers || '',
    instructions,
    examples: examples || '',
    priority: Number(priority) || 100,
    enabled: enabled === undefined ? 1 : enabled ? 1 : 0,
    autoGenerated: 0,
  });
  res.json({ ok: true, slug: s });
});

router.delete('/skills/:slug', (req, res) => {
  skills.remove(req.params.slug);
  res.json({ ok: true });
});

router.post('/skills/:slug/toggle', (req, res) => {
  res.json({ ok: !!skills.setEnabled(req.params.slug, !!(req.body && req.body.enabled)) });
});

router.post('/skills/match', (req, res) => {
  res.json(skills.selectFor(String((req.body && req.body.text) || ''), 5).map((s) => ({ slug: s.slug, name: s.name, score: s.score || null, priority: s.priority })));
});

// ── conversations ───────────────────────────────────────────────────────────
router.get('/chats', (req, res) => {
  res.json(memory.listConversations({ limit: Number(req.query.limit) || 80, state: req.query.state || null }));
});

/** Drop chats the account has left or that were deleted. */
router.post(
  '/chats/prune',
  wrap(async (req, res) => {
    if (!tg.isConnected()) return res.status(400).json({ error: 'Telegram ulanmagan' });
    const out = await ingest.pruneStaleChats({ dryRun: !!(req.body && req.body.dryRun) });
    res.json(out);
  })
);

router.get('/chats/:id/messages', (req, res) => {
  res.json(memory.chatMessages(req.params.id, Number(req.query.limit) || 80));
});

router.post('/chats/:id/state', (req, res) => {
  const state = String((req.body && req.body.state) || 'auto');
  if (!['auto', 'human', 'paused'].includes(state)) return res.status(400).json({ error: 'noto\'g\'ri holat' });
  memory.setState(req.params.id, state);
  res.json({ ok: true, state });
});

router.post('/chats/:id/mute', (req, res) => {
  const muted = !!(req.body && req.body.muted);
  db.prepare('UPDATE chats SET is_muted = ? WHERE tg_chat_id = ?').run(muted ? 1 : 0, req.params.id);
  res.json({ ok: true, muted });
});

router.post(
  '/chats/:id/send',
  wrap(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: "Matn bo'sh" });
    if (!tg.isConnected()) return res.status(400).json({ error: 'Telegram ulanmagan' });
    await runtime.sendManual(req.params.id, text);
    res.json({ ok: true });
  })
);

// ── escalations ─────────────────────────────────────────────────────────────
router.get('/escalations', (req, res) => {
  const status = req.query.status || 'open';
  res.json(
    db.prepare('SELECT * FROM escalations WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, Number(req.query.limit) || 60)
  );
});

router.post('/escalations/:id/resolve', (req, res) => {
  const status = String((req.body && req.body.status) || 'resolved');
  db.prepare("UPDATE escalations SET status = ?, resolved_at = datetime('now') WHERE id = ?").run(status, Number(req.params.id));
  res.json({ ok: true });
});

/** Answer an escalation: the agent delivers this text to the waiting user. */
router.post(
  '/escalations/:id/answer',
  wrap(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: "Javob bo'sh" });
    if (!tg.isConnected()) return res.status(400).json({ error: 'Telegram ulanmagan' });
    const out = await runtime.relayFounderAnswer(Number(req.params.id), text, { by: req.session.admin.username });
    res.json(out);
  })
);

/** Unanswered questions — the panel's notification badge. */
router.get('/escalations/pending', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT e.id, e.tg_chat_id, e.chat_title, e.question, e.reason, e.draft, e.created_at,
                (SELECT sender_name FROM messages m WHERE m.tg_chat_id = e.tg_chat_id AND m.is_outgoing = 0
                 ORDER BY m.date DESC LIMIT 1) AS user_name
         FROM escalations e WHERE e.status = 'open' ORDER BY e.id DESC LIMIT 50`
      )
      .all()
  );
});

// ── local model ─────────────────────────────────────────────────────────────
router.get('/local', (req, res) => res.json(local.status()));
router.post('/local/load', wrap(async (req, res) => res.json(await local.load())));
router.post('/local/unload', wrap(async (req, res) => { await local.unload(); res.json(local.status()); }));
router.post('/local/download/:kind', wrap(async (req, res) => res.json(await local.download(req.params.kind))));
router.post('/local/profile', wrap(async (req, res) => {
  const p = String((req.body && req.body.profile) || 'auto');
  if (p !== 'auto' && !local.PROFILES[p]) return res.status(400).json({ error: 'nomaʼlum profil' });
  settings.set('local_profile', p);
  await local.unload();
  res.json(local.status());
}));

/** Raw completion against the local model — for checking prompt adherence and speed. */
router.post(
  '/local/test',
  wrap(async (req, res) => {
    const { system, user, maxTokens } = req.body || {};
    if (!user) return res.status(400).json({ error: 'user matni kerak' });
    const messages = [];
    if (system) messages.push({ role: 'system', content: String(system) });
    messages.push({ role: 'user', content: String(user) });
    const t = Date.now();
    const out = await local.chat({ messages, maxTokens: Number(maxTokens) || 200, temperature: 0.3 });
    res.json({ text: out.content, latencyMs: Date.now() - t, promptChars: messages.reduce((n, m) => n + m.content.length, 0) });
  })
);
router.post(
  '/local/reindex',
  wrap(async (req, res) => {
    const vectors = require('../../knowledge/vectors');
    if (!vectors.ready()) return res.status(400).json({ error: 'Embedding modeli yuklanmagan' });
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const r = await vectors.backfill({ batch: 50 });
      total += r.embedded || 0;
      if (!r.remaining) break;
    }
    res.json({ embedded: total, ...vectors.stats() });
  })
);

// ── managed bots ────────────────────────────────────────────────────────────
router.get('/bots', (req, res) => res.json(bots.list()));
router.post('/bots/:u/start', wrap(async (req, res) => res.json(bots.start(req.params.u))));
router.post('/bots/:u/stop', (req, res) => res.json(bots.stop(req.params.u)));
router.delete('/bots/:u', (req, res) => res.json(bots.remove(req.params.u)));
router.get('/bots/:u/logs', (req, res) => res.json({ logs: bots.logs(req.params.u, Number(req.query.lines) || 120) }));
router.get('/bots/:u/code', (req, res) => res.json({ code: bots.code(req.params.u) }));

// ── assistant: tasks & memory ───────────────────────────────────────────────

/**
 * Run an instruction as the founder would from Telegram. Acts on the real
 * account (can send messages), so it is the panel's way to test and to issue
 * commands without opening Telegram.
 */
router.post(
  '/assistant/run',
  wrap(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: "Koʻrsatma boʻsh" });
    const assistant = require('../../agent/assistant');
    const founderId = String(settings.get('founder_ids', '')).split(/[,\s]+/).filter(Boolean)[0] || 'panel';
    // `chatType: 'group'` simulates a founder command issued in a group — used
    // to verify that secrets are routed to the private chat, not echoed back.
    const simulateGroup = req.body && req.body.chatType === 'group';
    const out = await assistant.handle({
      chatId: simulateGroup ? 'panel-group' : founderId,
      text,
      chatType: simulateGroup ? 'group' : 'private',
      chatTitle: simulateGroup ? 'Sinov guruhi' : 'Admin panel',
      msgId: null,
      senderId: founderId,
    });
    res.json(out);
  })
);

// ── projects, servers, watches ─────────────────────────────────────────────
router.get('/projects', (req, res) => res.json({ projects: projects.list({ all: req.query.all === '1' }), bots: bots.list(), servers: shell.listHosts(), publicKey: shell.publicKey() }));
router.post(
  '/projects',
  wrap(async (req, res) => {
    const { name, kind, spec, runCmd } = req.body || {};
    res.json(projects.create({ name, kind: kind || 'node', spec: spec || null, runCmd: runCmd || null }));
  })
);
router.get('/projects/:slug/files', (req, res) => res.json({ files: projects.listFiles(req.params.slug) }));
router.get('/projects/:slug/file', (req, res) => {
  try {
    res.json({ content: projects.readFile(req.params.slug, String(req.query.path || '')) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.post('/projects/:slug/file', (req, res) => {
  try {
    res.json(projects.writeFile(req.params.slug, String(req.body.path || ''), String(req.body.content ?? '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.get('/projects/:slug/logs', (req, res) => res.json({ logs: projects.logs(req.params.slug, Number(req.query.lines) || 150) }));
router.post('/projects/:slug/start', wrap(async (req, res) => res.json(projects.start(req.params.slug))));
router.post('/projects/:slug/stop', (req, res) => res.json(projects.stop(req.params.slug)));
router.post('/projects/:slug/restart', wrap(async (req, res) => res.json(await projects.restart(req.params.slug))));
router.post('/projects/:slug/settings', (req, res) => res.json(projects.update(req.params.slug, { runCmd: req.body.runCmd ?? null, name: req.body.name ?? null, spec: req.body.spec ?? null })));
router.post('/projects/:slug/env', (req, res) => res.json({ keys: projects.setEnv(req.params.slug, { [String(req.body.key)]: req.body.value === '' ? null : String(req.body.value) }) }));
router.delete('/projects/:slug', (req, res) => res.json(projects.remove(req.params.slug)));
router.post(
  '/projects/:slug/command',
  wrap(async (req, res) => res.json(await projects.runCommand(String(req.body.command || ''), { slug: req.params.slug, timeoutMs: 180_000 })))
);
router.post(
  '/projects/:slug/task',
  wrap(async (req, res) => {
    const task = String((req.body && req.body.task) || '').trim();
    if (!task) return res.status(400).json({ error: 'Vazifa boʻsh' });
    const p = projects.record(req.params.slug);
    if (!p) return res.status(404).json({ error: 'Loyiha topilmadi' });
    const wasRunning = p.alive;
    const r = await coder.runTask({ project: p, task });
    if (wasRunning) await projects.restart(p.slug).catch(() => {});
    res.json(r);
  })
);

// ── recurring routines ──────────────────────────────────────────────────────
router.get('/routines', (req, res) =>
  res.json(
    routines.list().map((r) => ({
      id: r.id, title: r.title, instruction: r.instruction, schedule: routines.describe(r),
      enabled: !!r.enabled, nextRun: r.next_run ? fmtTashkent(r.next_run) : null, runs: r.runs,
    }))
  )
);
router.post('/routines', (req, res) => {
  const { instruction, schedule, title } = req.body || {};
  if (!instruction || !schedule) return res.status(400).json({ error: "Ko'rsatma va vaqt majburiy" });
  const founderId = String(settings.get('founder_ids', '')).split(/[,\s]+/).filter(Boolean)[0] || null;
  res.json(routines.create({ instruction, schedule, title: title || null, chatId: founderId }));
});
router.post('/routines/:id/toggle', (req, res) => {
  const r = routines.get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'topilmadi' });
  res.json({ ok: routines.setEnabled(r.id, !r.enabled), enabled: !r.enabled });
});
router.delete('/routines/:id', (req, res) => res.json({ ok: routines.remove(Number(req.params.id)) }));

/** A coding task with no project — runs in a throwaway sandbox. */
router.post(
  '/code/task',
  wrap(async (req, res) => {
    const task = String((req.body && req.body.task) || '').trim();
    if (!task) return res.status(400).json({ error: 'Vazifa boʻsh' });
    res.json(await coder.runTask({ task, sandboxName: (req.body && req.body.name) || null }));
  })
);

router.get('/servers', (req, res) => res.json({ servers: shell.listHosts(), sessions: shell.listSessions(), publicKey: shell.publicKey() }));
router.post('/servers', (req, res) => {
  try {
    res.json(servers.add({ name: req.body.name, host: req.body.host, user: req.body.user || 'root', port: Number(req.body.port) || 22, keyPath: req.body.keyPath || null, note: req.body.note || null }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.delete('/servers/:name', (req, res) => res.json({ ok: shell.removeHost(req.params.name) }));
router.post('/servers/:name/run', wrap(async (req, res) => res.json(await shell.run(String(req.body.command || 'uptime'), { sessionId: 'panel-' + req.params.name, target: 'remote', host: req.params.name, timeoutMs: 180_000 }))));

router.get('/watches', (req, res) => res.json(watches.list({ status: req.query.status || null, limit: 100 })));
router.post('/watches/:id/cancel', (req, res) => res.json({ ok: watches.cancel(Number(req.params.id)) }));

/** Call one assistant tool directly — for verifying a capability without the model in between. */
router.post(
  '/assistant/tool',
  wrap(async (req, res) => {
    const { name, args } = req.body || {};
    const assistantTools = require('../../agent/assistantTools');
    if (!assistantTools.definitions.some((d) => d.function.name === name)) return res.status(400).json({ error: 'nomaʼlum vosita' });
    const founderId = String(settings.get('founder_ids', '')).split(/[,\s]+/).filter(Boolean)[0] || 'panel';
    const ex = assistantTools.createExecutor({ chatId: founderId, msgId: null, text: String((req.body && req.body.text) || ''), founderDm: founderId, chatType: 'private' });
    res.json({ result: await ex.execute(name, args || {}) });
  })
);

router.get('/tasks', (req, res) => res.json(tasks.list({ status: req.query.status || null, limit: Number(req.query.limit) || 100 })));
router.post('/tasks/:id/cancel', (req, res) => res.json({ ok: tasks.cancel(Number(req.params.id)) }));
router.post(
  '/tasks/:id/run',
  wrap(async (req, res) => {
    db.prepare("UPDATE tasks SET status = 'pending', run_at = ? WHERE id = ?").run(Date.now(), Number(req.params.id));
    await tasks.tick();
    res.json({ ok: true, task: tasks.get(Number(req.params.id)) });
  })
);

router.get('/memory', (req, res) => res.json(memoryFacts.list({ limit: 300, includeDisabled: req.query.all === '1' })));
router.post('/memory', (req, res) => {
  const { fact, tags } = req.body || {};
  if (!fact || String(fact).trim().length < 4) return res.status(400).json({ error: 'Fakt juda qisqa' });
  res.json(memoryFacts.remember({ fact, tags: tags || null, createdBy: req.session.admin.username }));
});
router.delete('/memory/:id', (req, res) => res.json({ ok: !!memoryFacts.remove(Number(req.params.id)) }));

router.get('/contacts', (req, res) => res.json(contacts.searchCache(String(req.query.q || ''), 30)));
router.post(
  '/contacts/refresh',
  wrap(async (req, res) => res.json({ refreshed: await contacts.refreshFromDialogs(400) }))
);

// ── settings ────────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => res.json({ values: settings.all(), defaults: DEFAULT_SETTINGS }));

/**
 * Keys that control whether the agent talks to real people. A bulk settings
 * save must never touch them: a stale form rendered before someone paused the
 * agent would silently switch it back on. They are changed only through the
 * dedicated endpoints below, which log the decision.
 */
const KILL_SWITCH_KEYS = new Set(['agent_paused', 'auto_reply']);

router.post('/settings', (req, res) => {
  const patch = (req.body && req.body.values) || req.body || {};
  const changed = [];
  const ignored = [];
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'object') continue;
    if (KILL_SWITCH_KEYS.has(k)) {
      ignored.push(k);
      continue;
    }
    // Numeric settings stay numeric: local_context_size once became
    // "50005000500050005000" and llama.cpp aborted trying to honour it.
    if (/^\d+$/.test(String(DEFAULT_SETTINGS[k] ?? '')) && !/^\d{1,8}$/.test(String(v).trim())) {
      ignored.push(k);
      continue;
    }
    settings.set(k, String(v).trim());
    changed.push(k);
  }
  if (changed.length) recordEvent('settings', 'Settings updated', { changed });
  res.json({ ok: true, changed, ignored, values: settings.all() });
});

/** Explicit, audited on/off control for live replying. */
router.post('/agent/state', (req, res) => {
  const { paused, autoReply } = req.body || {};
  const before = { paused: settings.bool('agent_paused', false), autoReply: settings.bool('auto_reply', true) };

  if (paused !== undefined) settings.set('agent_paused', paused ? '1' : '0');
  if (autoReply !== undefined) settings.set('auto_reply', autoReply ? '1' : '0');

  const after = { paused: settings.bool('agent_paused', false), autoReply: settings.bool('auto_reply', true) };
  const live = !after.paused && after.autoReply;
  // Reflect the change in Telegram immediately, not on the next presence tick.
  tg.setOnline(live).catch(() => {});
  recordEvent('agent', live ? 'Agent ENABLED (replying live)' : 'Agent disabled', { before, after, by: req.session.admin.username }, live ? 'warn' : 'info');
  log.warn(`Agent holati oʻzgardi: ${live ? 'JONLI JAVOB BERADI' : 'javob bermaydi'}`, { by: req.session.admin.username });

  res.json({ ok: true, ...after, live });
});

// ── test console ────────────────────────────────────────────────────────────
router.post(
  '/test/reply',
  wrap(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: "Savol bo'sh" });
    const out = await brain.preview({ text, userName: (req.body && req.body.userName) || null });
    res.json(out);
  })
);

// ── account & maintenance ───────────────────────────────────────────────────
router.get('/me', (req, res) => res.json(req.session.admin));

router.post('/account/password', (req, res) => {
  const { current, next } = req.body || {};
  const out = auth.changePassword(req.session.admin.id, current, next);
  res.status(out.ok ? 200 : 400).json(out);
});

router.post('/maintenance/vacuum', (req, res) => {
  vacuumOld();
  res.json({ ok: true });
});

router.get('/events', (req, res) => {
  res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(Number(req.query.limit) || 100));
});

module.exports = router;
