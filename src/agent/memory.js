'use strict';
const { db, settings } = require('../core/db');

/** Ensure a conversation row exists and return it. */
function conversation(chatId) {
  const id = String(chatId);
  let row = db.prepare('SELECT * FROM conversations WHERE tg_chat_id = ?').get(id);
  if (!row) {
    db.prepare('INSERT INTO conversations (tg_chat_id) VALUES (?)').run(id);
    row = db.prepare('SELECT * FROM conversations WHERE tg_chat_id = ?').get(id);
  }
  return row;
}

function setState(chatId, state) {
  conversation(chatId);
  db.prepare("UPDATE conversations SET state = ?, updated_at = datetime('now') WHERE tg_chat_id = ?").run(state, String(chatId));
}

function noteUserMessage(chatId, ts) {
  conversation(chatId);
  db.prepare("UPDATE conversations SET last_user_at = ?, updated_at = datetime('now') WHERE tg_chat_id = ?").run(ts, String(chatId));
}

function noteAgentReply(chatId, ts) {
  conversation(chatId);
  db.prepare(
    "UPDATE conversations SET last_agent_at = ?, replies_count = replies_count + 1, updated_at = datetime('now') WHERE tg_chat_id = ?"
  ).run(ts, String(chatId));
}

function setSummary(chatId, summary) {
  conversation(chatId);
  db.prepare("UPDATE conversations SET summary = ?, updated_at = datetime('now') WHERE tg_chat_id = ?").run(summary, String(chatId));
}

/**
 * Build the chat-completion history for one chat.
 * Newest N messages, chronological, mapped to user/assistant roles.
 */
function history(chatId, limit = null) {
  const n = limit ?? settings.int('history_window', 14);
  const rows = db
    .prepare(
      `SELECT text, is_outgoing, sender_name, date FROM messages
       WHERE tg_chat_id = ? AND text IS NOT NULL AND text != ''
       ORDER BY date DESC, tg_msg_id DESC LIMIT ?`
    )
    .all(String(chatId), n);

  return rows
    .reverse()
    .map((r) => ({
      role: r.is_outgoing ? 'assistant' : 'user',
      content: String(r.text).slice(0, 1500),
    }));
}

// ── long-term conversation memory ───────────────────────────────────────────
//
// The rolling window only carries the last N turns. For a returning user that
// is not enough — they expect the agent to remember who they are and what was
// already discussed. Older turns are therefore distilled into a compact profile
// stored on the conversation and injected ahead of the window.

const SUMMARY_REFRESH_EVERY = 12; // new messages before the summary is rebuilt

function readSummary(chatId) {
  const row = conversation(chatId);
  if (!row.summary) return null;
  try {
    const parsed = JSON.parse(row.summary);
    return parsed && parsed.text ? parsed : null;
  } catch {
    // Older rows stored plain text.
    return { text: row.summary, uptoId: 0, at: null };
  }
}

function writeSummary(chatId, text, uptoId) {
  db.prepare("UPDATE conversations SET summary = ?, updated_at = datetime('now') WHERE tg_chat_id = ?").run(
    JSON.stringify({ text: String(text).slice(0, 2000), uptoId, at: new Date().toISOString() }),
    String(chatId)
  );
}

/** Messages older than the live window, oldest first. */
function olderMessages(chatId, window, limit = 120) {
  return db
    .prepare(
      `SELECT text, is_outgoing, id FROM messages
       WHERE tg_chat_id = ? AND text IS NOT NULL AND text != ''
         AND id NOT IN (
           SELECT id FROM messages WHERE tg_chat_id = ? AND text IS NOT NULL AND text != ''
           ORDER BY date DESC, tg_msg_id DESC LIMIT ?
         )
       ORDER BY date DESC, tg_msg_id DESC LIMIT ?`
    )
    .all(String(chatId), String(chatId), window, limit)
    .reverse();
}

/**
 * Rebuild the stored profile if enough has happened since the last one.
 * Returns the current summary text (possibly unchanged), or null.
 * `ai` is passed in so this module stays free of a circular import.
 */
async function refreshSummary(chatId, ai, { window = null } = {}) {
  const win = window ?? settings.int('history_window', 30);
  const older = olderMessages(chatId, win);
  if (older.length < 4) return readSummary(chatId);

  const existing = readSummary(chatId);
  const newestOlderId = older[older.length - 1].id;
  if (existing && newestOlderId - (existing.uptoId || 0) < SUMMARY_REFRESH_EVERY) {
    return existing;
  }

  const transcript = older
    .map((m) => `${m.is_outgoing ? 'Agent' : 'Foydalanuvchi'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n')
    .slice(0, 9000);

  try {
    const res = await ai.chat({
      purpose: 'memory:summary',
      temperature: 0.2,
      maxTokens: 550,
      messages: [
        {
          role: 'system',
          content:
            "Sen ANITOKU support agentining suhbat xotirasini yurituvchi yordamchisan. Yozishmadan agent kelgusida " +
            "eslashi kerak bo'lgan faktlarni qisqa ro'yxat qil. O'zbek tilida, 3-8 ta punkt, har biri bir qatordan oshmasin.\n\n" +
            'QAMRAB OL: foydalanuvchi kimligi va ANITOKU bilan aloqasi, nima so\'ragani, unga nima aytilgani yoki ' +
            "va'da qilingani, hal qilinmagan masala, aniq afzalliklari (masalan qaysi yo'nalishda ishlamoqchi).\n\n" +
            'YOZMA: ANITOKU\'ga aloqasi yo\'q suhbat — reklama, do\'kon va texnika, chegirma kodlari, begona bot havolalari, ' +
            'oddiy hazil va gaplashuv. Parol, kod, telefon raqam, karta va taklif havolalarini ham yozma.\n\n' +
            "Agar yozishmada ANITOKU'ga tegishli eslashga arziydigan narsa BO'LMASA, faqat shu so'zni qaytar: YO'Q",
        },
        { role: 'user', content: `Yozishma:\n${transcript}\n\nEslab qolinadigan faktlar:` },
      ],
    });

    const text = String(res.content || '').trim();
    if (text.length < 15 || /^yo['‘’ʻ]?q\b/i.test(text)) {
      // Nothing worth carrying forward — better an empty memory than a noisy one.
      return existing;
    }
    writeSummary(chatId, text, newestOlderId);
    return { text, uptoId: newestOlderId };
  } catch {
    return existing; // summarisation is best-effort; never block a reply
  }
}

/** Per-chat and global hourly rate limits — protects the account from flood bans. */
function rateCheck(chatId) {
  const perChat = settings.int('max_replies_per_chat_hour', 25);
  const global = settings.int('max_replies_global_hour', 400);

  const chatCount = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE tg_chat_id = ? AND is_agent = 1 AND created_at > datetime('now', '-1 hour')")
    .get(String(chatId)).c;
  if (chatCount >= perChat) return { ok: false, reason: `chat limiti (${perChat}/soat)` };

  const globalCount = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE is_agent = 1 AND created_at > datetime('now', '-1 hour')")
    .get().c;
  if (globalCount >= global) return { ok: false, reason: `umumiy limit (${global}/soat)` };

  return { ok: true, chatCount, globalCount };
}

function listConversations({ limit = 60, state = null } = {}) {
  const where = state ? 'WHERE c.state = ?' : '';
  const params = state ? [state, limit] : [limit];
  // INNER JOIN, not LEFT: once a chat is pruned (left group, deleted
  // conversation) its row is gone and the panel must not keep listing it.
  return db
    .prepare(
      `SELECT c.tg_chat_id, c.state, c.summary, c.last_user_at, c.last_agent_at, c.replies_count, c.escalated,
              ch.title, ch.type, ch.username, ch.msg_count
       FROM conversations c JOIN chats ch ON ch.tg_chat_id = c.tg_chat_id
       ${where}
       ORDER BY COALESCE(c.last_user_at, 0) DESC LIMIT ?`
    )
    .all(...params);
}

function chatMessages(chatId, limit = 60) {
  return db
    .prepare(
      `SELECT tg_msg_id, sender_name, is_outgoing, is_agent, text, media_type, date
       FROM messages WHERE tg_chat_id = ? ORDER BY date DESC, tg_msg_id DESC LIMIT ?`
    )
    .all(String(chatId), limit)
    .reverse();
}

module.exports = {
  conversation,
  readSummary,
  writeSummary,
  refreshSummary,
  olderMessages,
  setState,
  setSummary,
  noteUserMessage,
  noteAgentReply,
  history,
  rateCheck,
  listConversations,
  chatMessages,
};
