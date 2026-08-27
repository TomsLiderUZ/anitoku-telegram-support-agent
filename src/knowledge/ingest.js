'use strict';
const { db, settings, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');
const store = require('./store');
const redact = require('./redact');

const log = createLogger('ingest');

const MEDIA_LABEL = {
  MessageMediaPhoto: 'photo',
  MessageMediaDocument: 'document',
  MessageMediaWebPage: 'link',
  MessageMediaPoll: 'poll',
};

function mediaType(msg) {
  const cls = msg && msg.media && msg.media.className;
  return cls ? MEDIA_LABEL[cls] || 'media' : null;
}

function upsertChat({ id, type, title, username, meta = null }) {
  db.prepare(
    `INSERT INTO chats (tg_chat_id, type, title, username, meta, last_seen_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(tg_chat_id) DO UPDATE SET
       type = excluded.type,
       title = COALESCE(excluded.title, chats.title),
       username = COALESCE(excluded.username, chats.username),
       last_seen_at = datetime('now')`
  ).run(String(id), type, title || null, username || null, meta ? JSON.stringify(meta) : null);
}

const stmtInsertMsg = db.prepare(
  `INSERT INTO messages (tg_chat_id, tg_msg_id, sender_id, sender_name, is_outgoing, is_agent, text, media_type, reply_to, date)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(tg_chat_id, tg_msg_id) DO NOTHING`
);

function saveMessage(chatId, msg, { isAgent = false } = {}) {
  const senderId = msg.senderId ? String(msg.senderId) : null;
  let senderName = null;
  try {
    const s = msg.sender;
    if (s) senderName = [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || s.title || null;
  } catch {
    /* sender may not be resolvable */
  }
  const r = stmtInsertMsg.run(
    String(chatId),
    Number(msg.id) || null,
    senderId,
    senderName,
    msg.out ? 1 : 0,
    isAgent ? 1 : 0,
    msg.message || msg.text || '',
    mediaType(msg),
    msg.replyTo && msg.replyTo.replyToMsgId ? Number(msg.replyTo.replyToMsgId) : null,
    Number(msg.date) || Math.floor(Date.now() / 1000)
  );
  if (r.changes) db.prepare('UPDATE chats SET msg_count = msg_count + 1 WHERE tg_chat_id = ?').run(String(chatId));
  return r.changes > 0;
}

/**
 * Crawl the private training channel and convert every post into a knowledge
 * document. This is the agent's primary source of insider platform truth.
 */
async function ingestChannel(channelId, limit = 400, onProgress = null) {
  if (!tg.isConnected()) throw new Error('Telegram ulanmagan');
  const stats = { channel: String(channelId), posts: 0, docs: 0, skipped: 0 };

  let entity;
  try {
    entity = await tg.resolveEntity(channelId);
  } catch (err) {
    log.warn('training channel not reachable', { channelId, error: err.message });
    stats.error = err.message;
    return stats;
  }

  const title = entity.title || entity.username || String(channelId);
  upsertChat({ id: channelId, type: 'channel', title, username: entity.username || null, meta: { training: true } });

  for await (const msg of tg.client.iterMessages(entity, { limit })) {
    stats.posts++;
    saveMessage(channelId, msg);
    const text = (msg.message || '').trim();
    if (text.length < 25) {
      stats.skipped++;
      continue;
    }
    const safe = redact.clean(text);
    if (!safe.ok) {
      stats.redacted = (stats.redacted || 0) + 1;
      continue;
    }
    const when = msg.date ? new Date(Number(msg.date) * 1000).toISOString().slice(0, 10) : '';
    const id = store.upsert({
      source: 'channel',
      sourceRef: `${channelId}:${msg.id}`,
      title: `${title} — ${when}`,
      content: safe.text,
      tags: 'kanal,ichki,post',
      weight: 1.8,
    });
    if (id) stats.docs++;
    if (onProgress && stats.posts % 25 === 0) onProgress(stats);
  }

  log.info('Channel ingested', stats);
  recordEvent('ingest', 'Training channel ingested', stats);
  return stats;
}

/**
 * Crawl recent dialogs so the agent learns real conversation style and
 * harvests operator answers as Q&A training pairs.
 */
async function ingestDialogs({ dialogLimit = 60, messageLimit = 300, onProgress = null } = {}) {
  if (!tg.isConnected()) throw new Error('Telegram ulanmagan');
  const stats = { dialogs: 0, messages: 0, qaPairs: 0, chats: [] };
  const myId = tg.me ? String(tg.me.id) : null;

  const dialogs = [];
  for await (const d of tg.client.iterDialogs({ limit: dialogLimit })) dialogs.push(d);

  for (const d of dialogs) {
    const chatId = String(d.id);
    const type = d.isUser ? 'private' : d.isChannel ? 'channel' : 'group';
    // Broadcast channels other than the training channel carry no support signal.
    if (type === 'channel' && chatId.replace(/^-100/, '') !== String(settings.get('training_channel_id')).replace(/^-100/, '')) continue;

    upsertChat({ id: chatId, type, title: d.title || d.name, username: (d.entity && d.entity.username) || null });
    stats.dialogs++;

    const buffer = [];
    try {
      for await (const msg of tg.client.iterMessages(d.entity, { limit: messageLimit })) {
        saveMessage(chatId, msg);
        stats.messages++;
        buffer.push({
          out: !!msg.out,
          text: (msg.message || '').trim(),
          id: Number(msg.id),
          date: Number(msg.date),
          senderId: msg.senderId ? String(msg.senderId) : null,
        });
      }
    } catch (err) {
      log.debug('dialog read failed', { chatId, error: err.message });
      continue;
    }

    // iterMessages yields newest-first; flip to chronological for pairing.
    buffer.reverse();
    const pairs = extractQAPairs(buffer, myId);
    for (const p of pairs) {
      // Never let a login code, invite link or personal identifier become
      // retrievable knowledge — it could be surfaced to any other user.
      const q = redact.clean(p.q, p.senderId);
      const a = redact.clean(p.a);
      if (!q.ok || !a.ok) {
        stats.redacted = (stats.redacted || 0) + 1;
        continue;
      }
      if (store.addQA({ question: q.text, answer: a.text, source: 'chat', chatId, score: 1.0 })) stats.qaPairs++;
    }
    stats.chats.push({ chatId, title: d.title || d.name, type, messages: buffer.length, pairs: pairs.length });
    if (onProgress) onProgress(stats);
  }

  log.info('Dialogs ingested', { dialogs: stats.dialogs, messages: stats.messages, qaPairs: stats.qaPairs });
  recordEvent('ingest', 'Dialogs ingested', { dialogs: stats.dialogs, messages: stats.messages, qaPairs: stats.qaPairs });
  return stats;
}

/**
 * Is this exchange worth remembering?
 *
 * Real chats are mostly coordination and small talk ("Aha, ko'rib chiqaman" →
 * "Okey, materialni tashlayman"). Stored as Q&A those become retrieval hits
 * that answer a stranger's question with internal chatter, so only exchanges
 * that carry actual information survive.
 */
function isUsefulQA(question, answer) {
  const q = String(question).trim();
  const a = String(answer).trim();

  if (q.length < 10 || a.length < 20) return false;

  // A bare link or file handoff answers nothing on its own.
  if (/^https?:\/\/\S+$/.test(a)) return false;

  // Pure acknowledgements carry no information.
  if (/^(ok(ey|ay)?|xo['‘’ʻ]?p|ha|yo['‘’ʻ]?q|rahmat|raxmat|zo['‘’ʻ]?r|mayli|albatta)[\s.!,😄🙂👍✅]*$/i.test(a)) return false;

  // Internal production coordination, not user support.
  if (/tashla(y|man|ymiz)|materyal|material yubor|tayming|render|assets|montaj|fayl(ni)? yubor/i.test(a) && a.length < 120) return false;

  // The user side should look like a request, not an acknowledgement.
  const asksSomething = /[?？]|qanday|qachon|nima|qayer|qancha|bormi|mumkinmi|iltimos|kerak|how|what|when|where|как|что|когда|где|сколько/i.test(q);
  if (!asksSomething && q.length < 25) return false;

  return true;
}

/**
 * Pair an incoming question with the operator's next outgoing reply.
 * Only keeps pairs that look like genuine support exchanges.
 */
function extractQAPairs(chronological, myId) {
  const pairs = [];
  for (let i = 0; i < chronological.length - 1; i++) {
    const q = chronological[i];
    if (q.out) continue;
    if (!q.text || q.text.length < 6 || q.text.length > 600) continue;

    // Find the operator's reply within the next few messages.
    let answer = null;
    for (let j = i + 1; j < Math.min(i + 4, chronological.length); j++) {
      const cand = chronological[j];
      if (!cand.out) break; // user spoke again before we answered
      if (cand.text && cand.text.length >= 8 && cand.text.length <= 1500) {
        answer = cand.text;
        break;
      }
    }
    if (!answer) continue;
    if (/^\/(start|help|stop)/i.test(q.text)) continue;
    if (!isUsefulQA(q.text, answer)) continue;
    pairs.push({ q: q.text, a: answer, senderId: q.senderId });
  }
  return pairs.slice(0, 120);
}

/** Full ingestion pass — channel first (highest value), then dialogs. */
async function ingestAll({ onProgress = null } = {}) {
  const out = { channel: null, dialogs: null };
  const channelId = settings.get('training_channel_id');
  if (channelId) {
    try {
      out.channel = await ingestChannel(channelId, settings.int('ingest_message_limit', 350), onProgress);
    } catch (err) {
      out.channel = { error: err.message };
      log.warn('channel ingest failed', { error: err.message });
    }
  }
  try {
    out.dialogs = await ingestDialogs({
      dialogLimit: settings.int('ingest_dialog_limit', 60),
      messageLimit: settings.int('ingest_message_limit', 350),
      onProgress,
    });
  } catch (err) {
    out.dialogs = { error: err.message };
    log.warn('dialog ingest failed', { error: err.message });
  }
  return out;
}

/**
 * Forget chats the account is no longer part of.
 *
 * Left groups and deleted conversations linger in the panel and keep feeding
 * retrieval with dead context. Telegram's dialog list is the source of truth:
 * anything stored but absent from it is gone.
 *
 * Guard: if the dialog listing hits the fetch limit it may be truncated, and
 * pruning against a partial list would delete live chats. In that case nothing
 * is removed.
 */
async function pruneStaleChats({ dryRun = false, limit = 1000 } = {}) {
  if (!tg.isConnected()) throw new Error('Telegram ulanmagan');

  const live = new Set();
  let count = 0;
  for await (const d of tg.client.iterDialogs({ limit })) {
    count++;
    const id = String(d.id);
    live.add(id);
    // Store both marked and bare forms so either representation matches.
    live.add(id.replace(/^-100/, '').replace(/^-/, ''));
  }

  if (count >= limit) {
    log.warn('Dialog roʻyxati toʻliq emas — tozalash oʻtkazib yuborildi', { count, limit });
    return { skipped: true, reason: 'dialog_list_truncated', dialogs: count };
  }

  const stored = db.prepare('SELECT tg_chat_id, title, type FROM chats').all();
  const stale = stored.filter((c) => {
    const id = String(c.tg_chat_id);
    return !live.has(id) && !live.has(id.replace(/^-100/, '').replace(/^-/, ''));
  });

  if (dryRun) return { dryRun: true, dialogs: count, stale: stale.map((s) => ({ id: s.tg_chat_id, title: s.title })) };

  let removed = 0;
  for (const c of stale) {
    const id = String(c.tg_chat_id);
    db.prepare('DELETE FROM messages WHERE tg_chat_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE tg_chat_id = ?').run(id);
    db.prepare('DELETE FROM escalations WHERE tg_chat_id = ?').run(id);
    // Knowledge distilled from that chat goes with it.
    db.prepare("DELETE FROM qa_pairs WHERE tg_chat_id = ?").run(id);
    db.prepare('DELETE FROM chats WHERE tg_chat_id = ?').run(id);
    removed++;
  }

  if (removed) {
    log.info('Tark etilgan chatlar tozalandi', { removed, dialogs: count });
    recordEvent('maintenance', 'Stale chats pruned', { removed, titles: stale.slice(0, 10).map((s) => s.title) });
  }
  return { removed, dialogs: count, stale: stale.map((s) => ({ id: s.tg_chat_id, title: s.title })) };
}

module.exports = { ingestAll, ingestChannel, ingestDialogs, saveMessage, upsertChat, extractQAPairs, pruneStaleChats };
