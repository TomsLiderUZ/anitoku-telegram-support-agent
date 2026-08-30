'use strict';
const { EventEmitter } = require('node:events');
const { db, settings, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');
const { fmtTashkent } = require('./timeparse');

const log = createLogger('tasks');

/**
 * Persistent background work.
 *
 * Anything the founder asks for that is not "answer right now" becomes a row
 * here: a message to send at 15:00, a bot to create, a multi-step instruction
 * to carry out. A ticker picks up due rows, runs the matching executor, and
 * stores the outcome. Rows survive restarts, so a reminder set before a crash
 * still fires.
 */
class TaskRunner extends EventEmitter {
  constructor() {
    super();
    this.executors = new Map();
    this.timer = null;
    this.busy = false;
    // Several jobs at once: a long coding task must not hold up a reminder.
    this.running = new Set();
    this.maxConcurrent = 4;
  }

  register(kind, fn) {
    this.executors.set(kind, fn);
  }

  create({ kind, title = null, payload = {}, runAt = Date.now(), originChat = null, originMsg = null, createdBy = 'founder' }) {
    if (!this.executors.has(kind)) throw new Error(`nomaʼlum vazifa turi: ${kind}`);
    const r = db
      .prepare(
        `INSERT INTO tasks (kind, title, payload, run_at, origin_chat, origin_msg, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(kind, title, JSON.stringify(payload), Math.floor(Number(runAt)), originChat, originMsg, createdBy);
    const id = Number(r.lastInsertRowid);
    log.info('vazifa yaratildi', { id, kind, title, runAt: fmtTashkent(runAt) });
    recordEvent('task', 'Task created', { id, kind, title, runAt: new Date(runAt).toISOString() });
    this.emit('created', { id, kind });
    // Due now? Do not wait for the next tick.
    if (runAt <= Date.now() + 1000) setImmediate(() => this.tick());
    return id;
  }

  get(id) {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
    return r ? { ...r, payload: safeJson(r.payload) } : null;
  }

  list({ status = null, limit = 100 } = {}) {
    const rows = status
      ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY run_at ASC LIMIT ?').all(status, limit)
      : // Single quotes: SQLite's double-quoted strings are identifiers, and
        // Node's build rejects the legacy fallback — "pending" was "no such column".
        db.prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, run_at DESC LIMIT ?").all(limit);
    return rows.map((r) => ({ ...r, payload: safeJson(r.payload) }));
  }

  cancel(id) {
    const r = db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status IN ('pending','running')").run(Number(id));
    if (r.changes) log.info('vazifa bekor qilindi', { id });
    return r.changes > 0;
  }

  start(intervalMs = 20_000) {
    if (this.timer) return;
    // Anything left "running" by a crash goes back to the queue.
    db.prepare("UPDATE tasks SET status = 'pending' WHERE status = 'running'").run();
    this.timer = setInterval(() => this.tick().catch((err) => log.error('tick failed', { error: err.message })), intervalMs);
    this.tick().catch(() => {});
    log.info('vazifa rejalashtiruvchisi faol', { intervalMs });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Pick up due work.
   *
   * Jobs run concurrently, not one after another: a coding task can take
   * minutes and used to block every reminder queued behind it. The cap keeps
   * the API providers from being hammered by a burst.
   *
   * Recurring routines are expanded here too, so a standing order ("every
   * morning at 9…") becomes an ordinary task on the same queue.
   */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      try {
        require('./routines').tick();
      } catch (err) {
        log.warn('routine tick failed', { error: err.message });
      }

      const free = Math.max(0, this.maxConcurrent - this.running.size);
      if (!free) return;
      const due = db
        .prepare("SELECT id FROM tasks WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT ?")
        .all(Date.now(), free)
        .filter(({ id }) => !this.running.has(id));

      await Promise.all(
        due.map(({ id }) => {
          this.running.add(id);
          return this.run(id)
            .catch((err) => log.error('task failed', { id, error: err.message }))
            .finally(() => this.running.delete(id));
        })
      );
    } finally {
      this.busy = false;
    }
  }

  async run(id) {
    const task = this.get(id);
    if (!task || task.status !== 'pending') return;
    const exec = this.executors.get(task.kind);
    if (!exec) {
      this.finish(id, { ok: false, error: `bajaruvchi yoʻq: ${task.kind}` });
      return;
    }

    db.prepare("UPDATE tasks SET status = 'running', attempts = attempts + 1, started_at = datetime('now') WHERE id = ?").run(id);
    log.info('vazifa bajarilmoqda', { id, kind: task.kind, title: task.title });

    try {
      const result = await exec(task.payload, task);
      this.finish(id, { ok: true, result });
      await this.notifyOrigin(task, doneMessage(task, result));
    } catch (err) {
      const retry = task.attempts < 2 && /timeout|network|FLOOD|ulanmagan/i.test(err.message);
      if (retry) {
        db.prepare("UPDATE tasks SET status = 'pending', run_at = ?, error = ? WHERE id = ?").run(Date.now() + 90_000, err.message, id);
        log.warn('vazifa qayta rejalashtirildi', { id, error: err.message });
      } else {
        this.finish(id, { ok: false, error: err.message });
        await this.notifyOrigin(task, `❌ Bajarilmadi: ${task.title || task.kind}\nSabab: ${err.message}`);
      }
    }
  }

  finish(id, { ok, result = null, error = null }) {
    db.prepare("UPDATE tasks SET status = ?, result = ?, error = ?, finished_at = datetime('now') WHERE id = ?").run(
      ok ? 'done' : 'failed',
      result ? JSON.stringify(result).slice(0, 8000) : null,
      error,
      id
    );
    recordEvent('task', ok ? 'Task done' : 'Task failed', { id, error }, ok ? 'info' : 'warn');
    this.emit('finished', { id, ok });
  }

  /** Tell the founder (in the chat the task came from) what happened. */
  async notifyOrigin(task, text) {
    const target = task.origin_chat || settings.get('escalation_chat_id', '');
    if (!target || !tg.isConnected()) return;
    try {
      await tg.sendMessage(target, text, { silent: true });
    } catch (err) {
      log.debug('origin notify failed', { error: err.message });
    }
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/** One-line result for the confirmation message. */
function summarize(result) {
  if (!result || typeof result !== 'object') return '';
  if (result.token) return `\n\n🤖 @${result.username}\nToken: ${result.token}\n${result.link}`;
  if (result.sentTo) return ` — ${result.sentTo}`;
  if (result.summary) return `\n${String(result.summary).slice(0, 600)}`;
  return '';
}

/**
 * Bajarilgan vazifa haqidagi xabar — odam yozgandek.
 *
 * Ilgari bu qator ichki yozuvni to'g'ridan-to'g'ri chatga chiqarardi:
 * "✅ Bajarildi: me ga xabar → ItzToms". "me ga xabar" — bu vazifaning
 * ichki nomi, "→ ItzToms" esa ichki belgi. Rahbar chatda tizimning
 * ichki tilini emas, nima bo'lganini o'qishi kerak.
 */
const DONE_OPENERS = ['Bajardim', 'Tayyor', 'Qildim'];
let doneTick = 0;

function doneMessage(task, result) {
  const opener = DONE_OPENERS[doneTick++ % DONE_OPENERS.length];

  // Rejalashtirilgan xabar — eng ko'p uchraydigan holat, shuning uchun
  // uni alohida, tushunarli qilib yozamiz.
  if (task.kind === 'send_message') {
    const to = (result && result.sentTo) || String(task.title || '').replace(/\s*ga xabar$/i, '');
    return `${opener}: ${to || 'kerakli kishi'}ga xabar yuborildi.`;
  }

  const what = task.title || task.kind;
  return `${opener}: ${what}${summarize(result)}`;
}

module.exports = new TaskRunner();
