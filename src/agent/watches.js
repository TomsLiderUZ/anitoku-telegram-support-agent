'use strict';
const { db } = require('../core/db');
const { createLogger } = require('../core/logger');

const log = createLogger('watches');

/**
 * "Ask Og'abek his age and tell me when he answers."
 *
 * The question goes out through send_message; a watch row remembers which
 * chat to listen to and where to report. The runtime checks every incoming
 * message against open watches and forwards the first reply to the founder's
 * private chat — never to the group the instruction came from.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS watches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id      TEXT NOT NULL,
    chat_name    TEXT,
    since_msg    INTEGER DEFAULT 0,
    note         TEXT,
    notify_chat  TEXT NOT NULL,
    status       TEXT DEFAULT 'open',
    reply        TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    expires_at   INTEGER
  )
`);

function create({ chatId, chatName = null, sinceMsg = 0, note = null, notifyChat, ttlHours = 72 }) {
  const r = db
    .prepare('INSERT INTO watches (chat_id, chat_name, since_msg, note, notify_chat, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(chatId), chatName, Number(sinceMsg) || 0, note, String(notifyChat), Date.now() + ttlHours * 3600_000);
  log.info('javob kuzatuvi yaratildi', { id: Number(r.lastInsertRowid), chat: chatName || chatId, note });
  return Number(r.lastInsertRowid);
}

/** Open watches for a chat whose reply has now arrived. Marks them done. */
function consume(chatId, msgId, text) {
  const rows = db
    .prepare("SELECT * FROM watches WHERE status = 'open' AND chat_id = ? AND (expires_at IS NULL OR expires_at > ?) AND since_msg < ?")
    .all(String(chatId), Date.now(), Number(msgId) || Number.MAX_SAFE_INTEGER);
  for (const w of rows) db.prepare("UPDATE watches SET status = 'done', reply = ? WHERE id = ?").run(String(text).slice(0, 2000), w.id);
  return rows;
}

function list({ status = 'open', limit = 50 } = {}) {
  return status
    ? db.prepare('SELECT * FROM watches WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM watches ORDER BY id DESC LIMIT ?').all(limit);
}

function cancel(id) {
  return db.prepare("UPDATE watches SET status = 'cancelled' WHERE id = ? AND status = 'open'").run(Number(id)).changes > 0;
}

module.exports = { create, consume, list, cancel };
