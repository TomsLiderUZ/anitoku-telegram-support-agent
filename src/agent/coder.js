'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../core/logger');
const { recordEvent } = require('../core/db');
const ai = require('../ai/client');
const projects = require('./projects');
const shell = require('./shell');
const todo = require('./todo');

const log = createLogger('coder');

/**
 * The coding agent.
 *
 * Modelled on how Claude Code works, because that shape is what makes an
 * agent finish real work instead of producing a plausible-looking patch:
 *
 *   explore → plan (written down) → change → VERIFY → repeat until green
 *
 * The verification step is the part that matters. Earlier versions reported
 * "added /top ✅" while the command was missing from the file, so nothing here
 * is trusted on the model's word: files are re-read, code is syntax-checked,
 * and the process is actually started before anything is called done.
 *
 * It works either inside a project (persistent, deployable) or in a throwaway
 * sandbox under data/sandbox (experiments, one-off scripts).
 */

const MAX_ROUNDS = 80;
// How many times a task will wait out a provider outage before giving up.
const MAX_STALLS = 6;
/** Provayderlar bandligini kutishning UMUMIY chegarasi. */
const MAX_STALL_TOTAL_MS = 4 * 60_000;
const CODER_PLAN = [
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'kimi', model: 'kimi-k2-0905-preview' },
  { provider: 'gemini', model: 'gemini-3.7-flash' },
  { provider: 'groq', model: 'qwen/qwen3.8-27b' },
  { provider: 'mistral', model: 'mistral-medium-latest' },
  { provider: 'openrouter', model: 'z-ai/glm-5.2:free' },
];

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const S = (d) => ({ type: 'string', description: d });
const I = (d) => ({ type: 'integer', description: d });

const TOOLS = [
  fn('todo_write', 'Write or rewrite your task checklist. ALWAYS call this FIRST, before any other tool, breaking the task into concrete verifiable steps. Re-call it whenever the plan changes.', { items: { type: 'array', items: { type: 'string' }, description: 'Ordered steps, each a concrete action' } }, ['items']),
  fn('todo_done', 'Mark one checklist item finished (or blocked/skipped) and move to the next. Call it as soon as a step is genuinely complete — never in advance.', { item: S('Step number (1-based) or part of its text'), status: { type: 'string', enum: ['done', 'blocked', 'skipped'] }, note: S('Short result or reason') }, ['item', 'status']),
  fn('list_files', 'List files in the working directory (recursive, skips node_modules/.git).', {}),
  fn('read_file', 'Read a file. Always read before editing.', { path: S('Relative path'), offset: I('Start line, optional'), limit: I('How many lines, optional') }, ['path']),
  fn('write_file', 'Create a file or replace it completely. For small changes use edit_file instead.', { path: S(''), content: S('Full file content') }, ['path', 'content']),
  fn('edit_file', 'Replace an exact snippet in a file. `search` must appear EXACTLY ONCE — include surrounding lines to make it unique.', { path: S(''), search: S('Exact text to find'), replace: S('Replacement text') }, ['path', 'search', 'replace']),
  fn('delete_file', 'Delete a file or directory.', { path: S('') }, ['path']),
  fn('grep', 'Search file contents by regular expression across the working directory.', { pattern: S('Regular expression'), glob: S("Optional file filter, e.g. '*.js'") }, ['pattern']),
  fn('bash', 'Run a shell command in the working directory. Use it to install packages, run tests, syntax-check, start things, inspect output. The working directory persists between calls.', { command: S(''), timeout_seconds: I('Default 120, max 600') }, ['command']),
  fn('set_run_command', 'Set the command that keeps this project running permanently (e.g. "node index.js"). Only for things meant to run continuously.', { command: S('') }, ['command']),
  fn('finish', 'Call ONLY when every checklist item is done and verified. Report what was built and how it was verified.', { summary: S('2-5 sentences, Uzbek, no code'), success: { type: 'boolean' } }, ['summary', 'success']),
];

/**
 * Per-project standing instructions, the way CLAUDE.md works.
 *
 * Conventions a project needs every time — "this bot uses long polling, never
 * webhooks", "run npm test before finishing" — belong with the project, not
 * repeated in each request. The agent reads it at the start of every task and
 * appends to it when it learns something durable.
 */
const MEMORY_FILE = 'AGENT.md';

function projectMemory(dir) {
  const f = path.join(dir, MEMORY_FILE);
  if (!fs.existsSync(f)) return '';
  const text = fs.readFileSync(f, 'utf8').trim();
  return text ? text.slice(0, 6000) : '';
}

function systemPrompt(ctx) {
  return `You are an elite senior software engineer working autonomously, in the style of Claude Code. You have a real terminal and a real filesystem. You finish tasks completely — you never hand back a half-done job or a plan instead of working code.
${ctx.memory ? `\n# PROJECT RULES (${MEMORY_FILE} — written by you or the owner, follow it)\n${ctx.memory}\n` : ''}

# WORKSPACE
Working directory: ${ctx.dir}
Mode: ${ctx.mode === 'project' ? `PROJECT "${ctx.name}" (persistent, may be deployed and kept running)` : 'SANDBOX (throwaway experiment area, safe to break)'}
${ctx.runCmd ? `Run command: ${ctx.runCmd}` : 'Run command: not set'}
${ctx.spec ? `Project purpose: ${ctx.spec}` : ''}
${ctx.envKeys && ctx.envKeys.length ? `Environment variables available at runtime (values hidden, read them via process.env): ${ctx.envKeys.join(', ')}` : ''}
Platform: ${process.platform}, Node ${process.versions.node}. npm is available. A POSIX shell is available (use it: mkdir -p, ls, grep, cat, pipes all work).

# HOW YOU WORK
1. PLAN FIRST. Call todo_write immediately with concrete, verifiable steps. This is mandatory.
2. EXPLORE before changing. list_files, read_file, grep. Never edit a file you have not read.
3. CHANGE. edit_file for surgical changes, write_file for new or fully rewritten files.
4. VERIFY EVERY CHANGE — this is the step that separates real work from a guess:
   - syntax: \`node --check <file>\` for JS
   - dependencies: \`npm install <pkg>\` when you import something new
   - behaviour: actually RUN it (\`node script.js\`, \`npm test\`, curl an endpoint) and read the output
   - if it fails, fix it and verify again. Loop until it genuinely passes.
   - ANYTHING THAT DOES NOT EXIT BY ITSELF (a server, a bot, a watcher) must be
     started in the background and stopped when you are done, or you will block
     yourself until the timeout:
       \`node server.js > run.log 2>&1 & echo $!\`   then \`sleep 2 && curl ...\`
       finish with \`kill <pid>\`
     NEVER run a server in the foreground.
5. Mark each todo item done ONLY after it is verified.
6. finish() only when the whole checklist is complete.

# NON-NEGOTIABLE RULES
- NEVER claim something works without having run it and seen the output.
- NEVER remove existing functionality. If asked to add X, everything already there must keep working — re-read the file and confirm.
- NEVER hardcode secrets. Tokens and keys come from process.env only.
- Telegram bots: token from process.env.BOT_TOKEN; admin ids from process.env.ADMIN_IDS (comma separated)${ctx.founderIds ? ` — the owner's id is ${ctx.founderIds}` : ''}.
- Prefer zero dependencies where reasonable (global fetch, node: builtins). Install real packages when they genuinely help.
- Write complete, production-quality code. No TODO comments, no stubs, no "implement this later".
- Handle errors: log them with context, tell the user something useful, never crash the process on a bad input.
- If something is impossible, say so plainly in finish() with success:false — do not fake it.

# PROJECT MEMORY
If you learn something that will matter next time — a convention, a gotcha, how to run the tests — append it to ${MEMORY_FILE} with edit_file or write_file. Keep it short and factual.

# REPORTING
The final summary goes to a non-technical reader in Uzbek: what now works, how you verified it, anything left. No code, no file dumps.`;
}

/**
 * Run one coding task.
 * @param {object} opts
 * @param {string|object} [opts.project] project ref; omit for a sandbox run
 * @param {string} opts.task what to build or fix
 * @returns {{ok:boolean, summary:string, changed:string[], commands:string[], rounds:number, todos:object}}
 */
async function runTask({ project = null, task, extraContext = null, sandboxName = null, onStep = null, maxRounds = MAX_ROUNDS }) {
  const p = project ? (typeof project === 'string' ? projects.find(project) : project) : null;
  if (project && !p) throw new Error(`loyiha topilmadi: ${project}`);

  const owner = `coder:${p ? p.slug : sandboxName || 'sandbox'}:${Date.now().toString(36)}`;
  const sessionId = `coder-${owner}`;
  const dir = p ? p.dir : shell.sandbox(sandboxName || 'code');
  const ctx = {
    dir,
    mode: p ? 'project' : 'sandbox',
    name: p ? p.name || p.slug : 'sandbox',
    runCmd: p ? p.run_cmd : null,
    spec: p ? p.spec : null,
    envKeys: p ? p.envKeys : [],
    founderIds: require('../core/db').settings.get('founder_ids', ''),
    memory: projectMemory(dir),
  };
  // Point the shell session at the working directory for this task.
  shell.session(sessionId, { target: 'local', cwd: dir });

  const changed = new Set();
  const commands = [];
  // Files the model has actually read this run — a full overwrite is only
  // allowed once it has seen what it is replacing.
  const seen = new Map(); // resolved path -> mtime:offset:limit of the last read
  const messages = [
    { role: 'system', content: systemPrompt(ctx) },
    { role: 'user', content: `TASK: ${task}${extraContext ? `\n\nCONTEXT:\n${extraContext}` : ''}` },
  ];

  let summary = '';
  let success = false;
  let rounds = 0;
  let plannedAt = 0;
  let stalls = 0;
  let stallWaitedMs = 0;

  for (; rounds < maxRounds; rounds++) {
    trimHistory(messages, owner);
    let out;
    try {
      out = await ai.chat({
        messages,
        tools: TOOLS,
        toolChoice: rounds === 0 ? 'required' : 'auto',
        preferred: CODER_PLAN,
        preferredOnly: true,
        purpose: 'coder',
        maxTokens: 6000,
        temperature: 0.15,
        timeoutMs: 180_000,
      });
    } catch (err) {
      // Every free provider being rate-limited at once is temporary, not a
      // reason to abandon a half-finished job — the checklist and the files
      // are still there, so wait for capacity and pick up where we left off.
      const transient = /rate_limit|429|Rate limit|temporarily|AI unavailable/i.test(err.message);
      /**
       * Kutish ham CHEGARALANGAN bo'lishi kerak.
       *
       * Kutishning o'zi to'g'ri: yarim bajarilgan ishni tashlab ketmaslik
       * kerak. Lekin eski hisob 20+40+60+80+100+120 = 7 daqiqa sof uxlash
       * berardi, ustiga so'rov vaqtlari. Rahbar chatida bu 15 daqiqalik
       * "yozmoqda…" bo'lib ko'rindi — ya'ni tashqaridan agent qotib
       * qolgandek edi.
       *
       * Muhimi shuki, kunlik kvota tugaganda kutishning ma'nosi yo'q:
       * u ertaga tiklanadi, 7 daqiqada emas. Shuning uchun umumiy kutish
       * to'rt daqiqa bilan chegaralanadi — undan keyin ish to'xtaydi va
       * nima bo'lgani aytiladi. To'xtash yomon, jimgina osilib turish
       * undan ham yomon.
       */
      if (transient && stalls < MAX_STALLS && stallWaitedMs < MAX_STALL_TOTAL_MS) {
        stalls++;
        const waitMs = Math.min(60_000, 15_000 * stalls, MAX_STALL_TOTAL_MS - stallWaitedMs);
        stallWaitedMs += waitMs;
        log.warn('provayderlar band — kutib qayta urinamiz', {
          rounds,
          stall: stalls,
          waitSec: Math.round(waitMs / 1000),
          jamiKutildi: Math.round(stallWaitedMs / 1000),
        });
        await new Promise((r) => setTimeout(r, waitMs));
        rounds--; // this round never happened
        continue;
      }
      log.error('coder model call failed', { error: err.message, rounds, stalls });
      summary = `Model javob bermadi (${stalls} marta kutib koʻrildi): ${String(err.message).slice(0, 200)}`;
      break;
    }

    const calls = out.toolCalls || [];
    if (!calls.length) {
      const t = todo.summary(owner);
      // Prose with work still outstanding means it stopped early — push it on.
      if (t && !t.complete && rounds < maxRounds - 2) {
        messages.push({ role: 'assistant', content: out.content || '' });
        messages.push({ role: 'user', content: `Your checklist is not finished:\n${t.text}\n\nContinue with the next item. Do not stop until every item is done and verified, then call finish().` });
        continue;
      }
      summary = String(out.content || '').trim() || (changed.size ? `Oʻzgartirilgan fayllar: ${[...changed].join(', ')}` : '');
      success = !!(t && t.complete) || changed.size > 0;
      break;
    }

    messages.push({ role: 'assistant', content: out.content || '', tool_calls: calls });
    let finished = false;

    for (const c of calls) {
      let args = {};
      try {
        args = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function.arguments || {};
      } catch {
        args = {};
      }

      let result;
      try {
        result = await execute({ name: c.function.name, args, dir, owner, sessionId, changed, commands, seen, project: p });
        if (c.function.name === 'todo_write') plannedAt = rounds;
        if (c.function.name === 'finish') {
          const t = todo.summary(owner);
          // "Done" with items still open is the failure mode this whole
          // design exists to catch: refuse it and make it keep working.
          if (t && !t.complete && args.success !== false) {
            result = { ok: false, refused: true, error: 'Checklist is not complete — finish the remaining items first.', remaining: t.items.filter((i) => i.status !== 'done' && i.status !== 'skipped').map((i) => i.text) };
          } else {
            finished = true;
            summary = String(args.summary || '');
            success = args.success !== false;
          }
        }
      } catch (err) {
        result = { ok: false, error: err.message };
      }

      if (onStep) onStep({ tool: c.function.name, args, result });
      messages.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(result).slice(0, 9_000) });
    }

    // No plan by round 2 → demand one.
    if (rounds === 1 && !plannedAt && !todo.list(owner).length) {
      messages.push({ role: 'user', content: 'You have not written a checklist yet. Call todo_write now with the concrete steps for this task.' });
    }
    if (finished) break;
  }

  const t = todo.summary(owner);
  shell.closeSession(sessionId);
  recordEvent('coder', 'Coding task finished', { owner, success, changed: [...changed], rounds, todos: t ? `${t.done}/${t.total}` : null });
  log.info('kod vazifasi tugadi', { owner, success, changed: changed.size, commands: commands.length, rounds, todos: t ? `${t.done}/${t.total}` : '-' });

  return {
    ok: success,
    summary: summary || '(hisobot yoʻq)',
    changed: [...changed],
    commands,
    rounds,
    dir,
    todos: t || null,
    project: p ? p.slug : null,
  };
}

/**
 * Keep the conversation inside provider limits during a long task.
 *
 * File reads and command output accumulate fast — a 40-round job hit "request
 * too large" and the whole chain fell over. Old tool results are collapsed to
 * a one-line trace (the model has already acted on them), while the system
 * prompt, the original task and the recent exchanges stay intact. The current
 * checklist is re-injected so the plan is never what gets forgotten.
 */
const MAX_CHARS = 90_000;
const KEEP_RECENT = 14;

function trimHistory(messages, owner) {
  const size = () => messages.reduce((n, m) => n + (m.content ? String(m.content).length : 0), 0);
  if (size() < MAX_CHARS) return;

  const head = 2; // system + original task
  for (let i = head; i < messages.length - KEEP_RECENT && size() > MAX_CHARS; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content && m.content.length > 200) {
      const ok = /"ok":\s*true/.test(m.content);
      m.content = `[${m.name || 'tool'} ${ok ? 'ok' : 'failed'} — older output dropped]`;
    } else if (m.role === 'assistant' && m.content && m.content.length > 400) {
      m.content = m.content.slice(0, 200) + ' …[trimmed]';
    }
  }

  const t = todo.summary(owner);
  if (t) {
    const last = messages[messages.length - 1];
    const reminder = `CURRENT CHECKLIST (older context was trimmed — this is authoritative):\n${t.text}`;
    if (!last || last.role !== 'system' || !String(last.content).startsWith('CURRENT CHECKLIST')) messages.push({ role: 'system', content: reminder });
  }
}

// ── tool implementations ─────────────────────────────────────────────────────

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__', '.next']);

function safe(dir, rel) {
  const target = path.resolve(dir, String(rel || '.'));
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error(`path escapes the working directory: ${rel}`);
  return target;
}

function walk(dir, base = dir, out = [], max = 500) {
  if (out.length >= max || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= max) break;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out, max);
    else out.push({ path: path.relative(base, full).replace(/\\/g, '/'), size: fs.statSync(full).size });
  }
  return out;
}

async function execute({ name, args, dir, owner, sessionId, changed, commands, seen, project }) {
  switch (name) {
    case 'todo_write':
      return { ok: true, items: todo.setList(owner, args.items) };

    case 'todo_done':
      return todo.update(owner, args.item, args.status || 'done', args.note || null);

    case 'list_files':
      return { files: walk(dir) };

    case 'read_file': {
      const p = safe(dir, args.path);
      if (!fs.existsSync(p)) return { ok: false, error: `no such file: ${args.path}` };
      const key = path.resolve(p);
      const stamp = `${fs.statSync(p).mtimeMs}:${args.offset || 0}:${args.limit || 0}`;
      // Re-reading an unchanged file re-sends the whole thing and burns the
      // token budget that the rest of the task needs — a 26 KB bot file was
      // fetched three times in a row before the provider cut us off.
      if (seen.get(key) === stamp) {
        return { ok: true, path: args.path, unchanged: true, note: 'You already read this file and it has not changed — use the copy above.' };
      }
      seen.set(key, stamp);
      let text = fs.readFileSync(p, 'utf8');
      if (args.offset || args.limit) {
        const lines = text.split('\n');
        const from = Math.max(0, (Number(args.offset) || 1) - 1);
        text = lines.slice(from, from + (Number(args.limit) || 400)).join('\n');
      }
      return { path: args.path, content: text.length > 80_000 ? text.slice(0, 80_000) + '\n…[truncated]' : text };
    }

    case 'write_file': {
      const p = safe(dir, args.path);
      // Overwriting a file sight unseen is how existing features get deleted.
      // Reading it first is cheap; losing working code is not.
      if (fs.existsSync(p) && !seen.has(path.resolve(p))) {
        return { ok: false, error: `Read ${args.path} first — you are about to replace a file you have not looked at, and anything already in it would be lost.` };
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(args.content ?? ''), 'utf8');
      changed.add(args.path);
      if (project) require('../core/db').db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE slug = ?").run(project.slug);
      return { ok: true, path: args.path, bytes: Buffer.byteLength(String(args.content ?? '')) };
    }

    case 'edit_file': {
      const p = safe(dir, args.path);
      if (!fs.existsSync(p)) return { ok: false, error: `no such file: ${args.path}` };
      const text = fs.readFileSync(p, 'utf8');
      seen.set(path.resolve(p), String(fs.statSync(p).mtimeMs) + ':0:0');
      const search = String(args.search ?? '');
      const idx = text.indexOf(search);
      if (idx === -1) return { ok: false, error: 'search text not found — read the file again and copy the exact text' };
      if (text.indexOf(search, idx + 1) !== -1) return { ok: false, error: 'search text appears more than once — include more surrounding lines' };
      fs.writeFileSync(p, text.slice(0, idx) + String(args.replace ?? '') + text.slice(idx + search.length), 'utf8');
      changed.add(args.path);
      return { ok: true, path: args.path };
    }

    case 'delete_file': {
      const p = safe(dir, args.path);
      if (p === dir) return { ok: false, error: 'refusing to delete the working directory' };
      fs.rmSync(p, { recursive: true, force: true });
      changed.add(args.path);
      return { ok: true };
    }

    case 'grep': {
      let re;
      try {
        re = new RegExp(args.pattern, 'i');
      } catch (e) {
        return { ok: false, error: `bad regex: ${e.message}` };
      }
      const globRe = args.glob ? new RegExp('^' + String(args.glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i') : null;
      const hits = [];
      for (const f of walk(dir)) {
        if (globRe && !globRe.test(path.basename(f.path))) continue;
        if (f.size > 2_000_000) continue;
        let content;
        try {
          content = fs.readFileSync(path.join(dir, f.path), 'utf8');
        } catch {
          continue;
        }
        content.split('\n').forEach((line, n) => {
          if (hits.length < 120 && re.test(line)) hits.push({ file: f.path, line: n + 1, text: line.trim().slice(0, 200) });
        });
      }
      return { matches: hits.length, hits };
    }

    case 'bash': {
      commands.push(args.command);
      const r = await shell.run(args.command, { sessionId, timeoutMs: Math.min(600, Number(args.timeout_seconds) || 120) * 1000 });
      const out = { ok: r.ok, exitCode: r.code, output: r.output, cwd: r.cwd, timedOut: r.timedOut || false };
      // A blocking server in the foreground eats the whole timeout and the
      // task stalls there. Say so, rather than leaving the model to guess.
      if (r.timedOut) out.hint = 'The command never exited — if it is a server or bot, start it in the background (`cmd > run.log 2>&1 &`) and kill it when done.';
      return out;
    }

    case 'set_run_command':
      if (!project) return { ok: false, error: 'this is a sandbox run — there is no project to configure' };
      projects.update(project.slug, { runCmd: String(args.command) });
      return { ok: true, run_cmd: args.command };

    case 'finish':
      return { ok: true };

    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

module.exports = { runTask, TOOLS, CODER_PLAN };
