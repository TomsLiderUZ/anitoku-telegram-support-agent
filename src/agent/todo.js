'use strict';
const { db } = require('../core/db');
const { createLogger } = require('../core/logger');

const log = createLogger('todo');

/**
 * Task checklists.
 *
 * A multi-step job that lives only in the model's head drifts: step four gets
 * forgotten, step two is silently skipped, and the report claims all of it was
 * done. Writing the plan down first, then ticking items off as they actually
 * complete, is what keeps a long job honest — and it lets the founder see
 * exactly where the work stands.
 *
 * Scoped by `owner`: one list per coding task, per assistant request, or per
 * background routine.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner      TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    text       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    note       TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS todos_owner ON todos(owner, seq);
`);

const STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked', 'skipped']);

/** Replace the whole list for an owner. Returns the stored items. */
function setList(owner, items) {
  const rows = [].concat(items || []).map((it, i) =>
    typeof it === 'string' ? { text: it, status: i === 0 ? 'in_progress' : 'pending' } : { text: String(it.text || ''), status: STATUSES.has(it.status) ? it.status : 'pending', note: it.note || null }
  ).filter((r) => r.text.trim());

  db.prepare('DELETE FROM todos WHERE owner = ?').run(String(owner));
  const ins = db.prepare('INSERT INTO todos (owner, seq, text, status, note) VALUES (?, ?, ?, ?, ?)');
  rows.forEach((r, i) => ins.run(String(owner), i, r.text.trim(), r.status, r.note || null));
  log.debug('todo list set', { owner, items: rows.length });
  return list(owner);
}

const list = (owner) => db.prepare('SELECT id, seq, text, status, note FROM todos WHERE owner = ? ORDER BY seq').all(String(owner));

/** Update one item by its 1-based position or its exact text. */
function update(owner, ref, status, note = null) {
  if (!STATUSES.has(status)) throw new Error(`unknown status: ${status}`);
  const items = list(owner);
  if (!items.length) return { ok: false, error: 'list is empty' };
  const idx = Number.isFinite(Number(ref)) ? Number(ref) - 1 : items.findIndex((i) => i.text.toLowerCase().includes(String(ref).toLowerCase()));
  const item = items[idx];
  if (!item) return { ok: false, error: `no such item: ${ref}` };
  db.prepare("UPDATE todos SET status = ?, note = COALESCE(?, note), updated_at = datetime('now') WHERE id = ?").run(status, note, item.id);

  // Move the next pending item into progress so the list always shows what is
  // being worked on right now.
  if (status === 'done' || status === 'skipped') {
    const next = list(owner).find((i) => i.status === 'pending');
    if (next) db.prepare("UPDATE todos SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?").run(next.id);
  }
  return { ok: true, items: list(owner) };
}

const clear = (owner) => db.prepare('DELETE FROM todos WHERE owner = ?').run(String(owner)).changes;

function summary(owner) {
  const items = list(owner);
  if (!items.length) return null;
  const done = items.filter((i) => i.status === 'done').length;
  const blocked = items.filter((i) => i.status === 'blocked');
  return {
    total: items.length,
    done,
    blocked: blocked.length,
    complete: done === items.length,
    items,
    text: items.map((i, n) => `${i.status === 'done' ? '✅' : i.status === 'in_progress' ? '▶️' : i.status === 'blocked' ? '⛔' : i.status === 'skipped' ? '⏭️' : '⬜'} ${n + 1}. ${i.text}${i.note ? ` — ${i.note}` : ''}`).join('\n'),
  };
}

/** Owners with unfinished work, so nothing is quietly abandoned. */
const openOwners = () =>
  db.prepare("SELECT owner, COUNT(*) n FROM todos WHERE status IN ('pending','in_progress','blocked') GROUP BY owner").all();

/**
 * Unfinished lists that were actually touched recently, newest first.
 *
 * `openOwners` returns everything ever abandoned — after a few weeks that is
 * a graveyard of runs whose project no longer exists, and showing it as
 * "current work" would be a lie. A list nobody has touched for a day is not
 * in progress; it stalled.
 */
const openLists = ({ hours = 24, limit = 20 } = {}) =>
  db
    .prepare(
      `SELECT owner, COUNT(*) open, MAX(updated_at) updated_at
         FROM todos
        WHERE status IN ('pending','in_progress','blocked')
        GROUP BY owner
       HAVING MAX(updated_at) > datetime('now', ?)
        ORDER BY updated_at DESC
        LIMIT ?`
    )
    .all(`-${Math.max(1, Number(hours) || 24)} hours`, Number(limit) || 20);

module.exports = { setList, list, update, clear, summary, openOwners, openLists, STATUSES };
