'use strict';
const { Api } = require('telegram');
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');
const contacts = require('./contacts');

const log = createLogger('tg:ops');

/**
 * Everything the account can do to chats besides talking: join and leave,
 * create channels and groups, read members, promote, ban, kick, invite,
 * delete messages. Thin wrappers over raw MTProto calls; each returns plain
 * JSON the assistant can report from.
 */

const isChannel = (e) => e && e.className === 'Channel';
const isBasicGroup = (e) => e && e.className === 'Chat';

async function resolve(ref) {
  // Callers pass either a human reference ("Yosh Usta", "@x", an id) or an entity
  // we already resolved — promoteAdmin hands its own entity to addMembers.
  if (ref && typeof ref === 'object' && ref.id !== undefined && ref.className) return ref;
  const r = await contacts.resolve(ref);
  return r.entity;
}

function describe(e) {
  if (!e) return null;
  return {
    id: String(e.id),
    kind: e.className === 'User' ? 'user' : e.broadcast ? 'channel' : e.megagroup || isBasicGroup(e) ? 'group' : 'channel',
    title: e.title || [e.firstName, e.lastName].filter(Boolean).join(' ') || null,
    username: e.username || null,
    link: e.username ? `https://t.me/${e.username}` : null,
  };
}

/** Invite hash from t.me/+HASH or t.me/joinchat/HASH; null for public links. */
function inviteHash(link) {
  const m = String(link || '').match(/(?:t\.me\/|^)(?:joinchat\/|\+)([\w-]{10,})/i);
  return m ? m[1] : null;
}

// ── membership ───────────────────────────────────────────────────────────────

async function joinChat(ref) {
  if (!tg.isConnected()) throw new Error('Telegram ulanmagan');
  const hash = inviteHash(ref);
  if (hash) {
    try {
      const upd = await tg.client.invoke(new Api.messages.ImportChatInvite({ hash }));
      const chat = upd.chats && upd.chats[0];
      if (chat) contacts.upsert(chat);
      log.info('taklif havolasi orqali qoʻshildi', { title: chat && chat.title });
      return { ok: true, joined: true, chat: describe(chat) };
    } catch (err) {
      const msg = err.errorMessage || err.message;
      if (/USER_ALREADY_PARTICIPANT/.test(msg)) {
        const info = await tg.client.invoke(new Api.messages.CheckChatInvite({ hash })).catch(() => null);
        return { ok: true, joined: false, already: true, chat: info && info.chat ? describe(info.chat) : null };
      }
      if (/INVITE_REQUEST_SENT/.test(msg)) return { ok: true, joined: false, requestSent: true, note: 'Aʼzolik soʻrovi yuborildi — admin tasdiqlashi kerak' };
      if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID/.test(msg)) throw new Error('Taklif havolasi eskirgan yoki notoʻgʻri');
      throw new Error(msg);
    }
  }
  const entity = await tg.resolveEntity(ref);
  if (!isChannel(entity)) throw new Error('Bu ochiq kanal yoki guruh emas — taklif havolasi kerak');
  try {
    await tg.client.invoke(new Api.channels.JoinChannel({ channel: entity }));
  } catch (err) {
    const msg = err.errorMessage || err.message;
    if (!/USER_ALREADY_PARTICIPANT/.test(msg)) throw new Error(msg);
    return { ok: true, joined: false, already: true, chat: describe(entity) };
  }
  contacts.upsert(entity);
  log.info('kanalga qoʻshildi', { username: entity.username });
  return { ok: true, joined: true, chat: describe(entity) };
}

async function leaveChat(ref) {
  const entity = await resolve(ref);
  if (isChannel(entity)) await tg.client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
  else if (isBasicGroup(entity)) await tg.client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: 'me' }));
  else throw new Error('Bu shaxsiy chat — undan chiqib boʻlmaydi');
  return { ok: true, left: describe(entity) };
}

// ── creation ─────────────────────────────────────────────────────────────────

/**
 * Create a channel or (super)group. Public → username is set and the t.me
 * link returned; private → an invite link is exported instead.
 */
async function createChat({ kind = 'group', title, about = '', isPublic = false, username = null, members = [], admins = [] }) {
  if (!tg.isConnected()) throw new Error('Telegram ulanmagan');
  if (!title) throw new Error('nomi kerak');
  const broadcast = kind === 'channel';
  const upd = await tg.client.invoke(
    new Api.channels.CreateChannel({ title: String(title), about: String(about || ''), broadcast, megagroup: !broadcast })
  );
  const chat = upd.chats && upd.chats[0];
  if (!chat) throw new Error('Telegram chat qaytarmadi');
  contacts.upsert(chat);
  const out = { ok: true, chat: describe(chat), public: false };

  if (isPublic) {
    const want = String(username || slugify(title)).replace(/^@/, '');
    const free = await tg.client.invoke(new Api.channels.CheckUsername({ channel: chat, username: want })).catch(() => false);
    if (!free) throw Object.assign(new Error(`@${want} band yoki yaroqsiz — boshqa username ayting (chat yaratildi, hozircha yopiq)`), { chat: out.chat });
    await tg.client.invoke(new Api.channels.UpdateUsername({ channel: chat, username: want }));
    out.public = true;
    out.chat.username = want;
    out.chat.link = `https://t.me/${want}`;
  } else {
    out.chat.link = await inviteLink(chat);
  }

  // "Create a group and add me / make me admin" is one request, not three.
  // Doing it here means the founder never sees a group they are not in.
  const everyone = [...new Set([...[].concat(members || []), ...[].concat(admins || [])])].filter(Boolean);
  if (everyone.length) {
    out.members = await addMembers(chat, everyone).catch((e) => ({ ok: false, error: e.message }));
    if (!out.chat.link) out.chat.link = out.members.inviteLink || null;
  }
  if (admins && admins.length) {
    out.admins = [];
    for (const a of [].concat(admins)) {
      out.admins.push(await promoteAdmin(chat, a, { rank: 'admin' }).catch((e) => ({ ok: false, user: String(a), error: e.message })));
    }
  }
  log.info(`${broadcast ? 'kanal' : 'guruh'} yaratildi`, { title, public: out.public, members: everyone.length });
  return out;
}

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/['‘’ʻ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28) + '_uz';

async function inviteLink(refOrEntity) {
  const entity = typeof refOrEntity === 'string' ? await resolve(refOrEntity) : refOrEntity;
  const r = await tg.client.invoke(new Api.messages.ExportChatInvite({ peer: entity }));
  return r.link || null;
}

// ── info & members ───────────────────────────────────────────────────────────

async function chatInfo(ref) {
  const entity = await resolve(ref);
  const base = describe(entity);
  if (entity.className === 'User') {
    return { ...base, firstName: entity.firstName || null, lastName: entity.lastName || null, phone: entity.phone || null, bot: !!entity.bot };
  }
  let full = null;
  try {
    if (isChannel(entity)) full = (await tg.client.invoke(new Api.channels.GetFullChannel({ channel: entity }))).fullChat;
    else if (isBasicGroup(entity)) full = (await tg.client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }))).fullChat;
  } catch (err) {
    log.debug('full chat oʻqilmadi', { error: err.message });
  }
  const rights = entity.adminRights ? Object.keys(entity.adminRights).filter((k) => entity.adminRights[k] === true) : [];
  return {
    ...base,
    about: (full && full.about) || null,
    members: (full && (full.participantsCount || full.participants?.participants?.length)) || null,
    online: (full && full.onlineCount) || null,
    admins: (full && full.adminsCount) || null,
    iAmCreator: !!entity.creator,
    myAdminRights: rights,
    inviteLink: full && full.exportedInvite ? full.exportedInvite.link : null,
  };
}

async function listMembers(ref, { limit = 200, query = '', admins = false } = {}) {
  const entity = await resolve(ref);
  if (entity.className === 'User') throw new Error('Bu shaxsiy chat — aʼzolar roʻyxati yoʻq');
  const opts = { limit: Math.min(1000, limit) };
  if (query) opts.search = String(query);
  if (admins) opts.filter = new Api.ChannelParticipantsAdmins();
  const users = await tg.client.getParticipants(entity, opts);
  const rows = users.map((u) => {
    contacts.upsert(u);
    const p = u.participant;
    const role = p ? (p.className === 'ChannelParticipantCreator' ? 'creator' : p.className === 'ChannelParticipantAdmin' ? 'admin' : 'member') : 'member';
    return { id: String(u.id), name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null, username: u.username || null, role, bot: !!u.bot, rank: p && p.rank ? p.rank : undefined };
  });
  return { chat: describe(entity), count: rows.length, members: rows };
}

// ── moderation ───────────────────────────────────────────────────────────────

const FULL_ADMIN = () =>
  new Api.ChatAdminRights({
    changeInfo: true, postMessages: true, editMessages: true, deleteMessages: true, banUsers: true,
    inviteUsers: true, pinMessages: true, addAdmins: true, anonymous: false, manageCall: true, other: true,
    manageTopics: true, postStories: true, editStories: true, deleteStories: true,
  });
const NO_ADMIN = () => new Api.ChatAdminRights({});

/**
 * Make someone an admin.
 *
 * Telegram refuses to promote a non-member, and refuses to add a user whose
 * privacy settings forbid it (USER_PRIVACY_RESTRICTED) — which is exactly what
 * happened when a fresh group was created for the founder: the group existed,
 * the founder was never in it, and "make me admin" failed with a raw error.
 * So: try to add first, and when privacy blocks that, hand back a working
 * invite link instead of a dead end. Once they join, promotion succeeds.
 */
async function promoteAdmin(chatRef, userRef, { rank = 'admin' } = {}) {
  const chat = await resolve(chatRef);
  const user = await resolve(userRef);
  const attempt = async () => {
    if (isChannel(chat)) {
      await tg.client.invoke(new Api.channels.EditAdmin({ channel: chat, userId: user, adminRights: FULL_ADMIN(), rank: String(rank).slice(0, 16) }));
    } else if (isBasicGroup(chat)) {
      await tg.client.invoke(new Api.messages.EditChatAdmin({ chatId: chat.id, userId: user, isAdmin: true }));
    } else throw new Error('Bu guruh yoki kanal emas');
  };

  try {
    await attempt();
  } catch (err) {
    const msg = err.errorMessage || err.message || '';
    if (!/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID|USER_PRIVACY_RESTRICTED|USER_ID_INVALID/i.test(msg)) throw err;

    // Not a member yet — add them, then promote.
    let added = false;
    let addError = null;
    try {
      await addMembers(chat, [user]);
      added = true;
    } catch (e) {
      addError = e.errorMessage || e.message || String(e);
    }

    if (added) {
      try {
        await attempt();
      } catch (again) {
        // Still refused after joining: their privacy settings block being
        // promoted by someone who is not a mutual contact. Nothing we can do
        // from this side — say so plainly instead of throwing a raw API code.
        const link = await inviteLink(chat).catch(() => null);
        return {
          ok: false,
          needsSelfJoin: true,
          chat: describe(chat),
          user: describe(user),
          inviteLink: link,
          reason: again.errorMessage || again.message,
          message: `Telegram uni admin qilishga ruxsat bermadi (maxfiylik sozlamalari). Yosh Usta, ${link ? `shu havola orqali oʻzingiz kiring: ${link} — keyin men darhol admin qilaman` : 'guruhga oʻzingiz kiring, keyin admin qilaman'}. Yoki Telegram → Sozlamalar → Maxfiylik → "Guruhlarga qoʻshish" ni "Hamma" qilib qoʻysangiz, keyingi safar oʻzim bajaraman.`,
        };
      }
    } else {
      // Privacy settings block silent adding. An invite link always works.
      const link = await inviteLink(chat).catch(() => null);
      log.warn('adminlik uchun avval qoʻshib boʻlmadi — taklif havolasi berildi', { chat: chat.title, error: addError });
      return {
        ok: false,
        needsJoin: true,
        chat: describe(chat),
        user: describe(user),
        inviteLink: link,
        reason: addError,
        message: link
          ? `Telegram maxfiylik sozlamalari sababli uni oʻzim qoʻsha olmadim. Shu havola orqali kirsin, keyin darhol admin qilaman: ${link}`
          : `Uni qoʻsha olmadim (${addError}) va taklif havolasi ham olinmadi.`,
      };
    }
  }
  log.info('admin qilindi', { chat: chat.title, user: user.username || user.id });
  return { ok: true, chat: describe(chat), user: describe(user), rank };
}

async function demoteAdmin(chatRef, userRef) {
  const chat = await resolve(chatRef);
  const user = await resolve(userRef);
  if (isChannel(chat)) await tg.client.invoke(new Api.channels.EditAdmin({ channel: chat, userId: user, adminRights: NO_ADMIN(), rank: '' }));
  else if (isBasicGroup(chat)) await tg.client.invoke(new Api.messages.EditChatAdmin({ chatId: chat.id, userId: user, isAdmin: false }));
  else throw new Error('Bu guruh yoki kanal emas');
  return { ok: true, chat: describe(chat), user: describe(user) };
}

const BANNED = (on) =>
  new Api.ChatBannedRights({
    untilDate: 0, viewMessages: on, sendMessages: on, sendMedia: on, sendStickers: on, sendGifs: on, sendGames: on,
    sendInline: on, embedLinks: on, sendPolls: on, changeInfo: on, inviteUsers: on, pinMessages: on,
  });

/** Ban (permanent) or kick (removed, may rejoin). */
async function removeUser(chatRef, userRef, { ban = true } = {}) {
  const chat = await resolve(chatRef);
  const user = await resolve(userRef);
  if (isChannel(chat)) {
    await tg.client.invoke(new Api.channels.EditBanned({ channel: chat, participant: user, bannedRights: BANNED(true) }));
    if (!ban) await tg.client.invoke(new Api.channels.EditBanned({ channel: chat, participant: user, bannedRights: BANNED(false) }));
  } else if (isBasicGroup(chat)) {
    await tg.client.invoke(new Api.messages.DeleteChatUser({ chatId: chat.id, userId: user }));
  } else throw new Error('Bu guruh yoki kanal emas');
  log.info(ban ? 'bloklandi' : 'chiqarildi', { chat: chat.title, user: user.username || user.id });
  return { ok: true, action: ban ? 'banned' : 'kicked', chat: describe(chat), user: describe(user) };
}

async function unbanUser(chatRef, userRef) {
  const chat = await resolve(chatRef);
  const user = await resolve(userRef);
  if (!isChannel(chat)) throw new Error('Faqat superguruh/kanalda blokdan chiqarish mumkin');
  await tg.client.invoke(new Api.channels.EditBanned({ channel: chat, participant: user, bannedRights: BANNED(false) }));
  return { ok: true, chat: describe(chat), user: describe(user) };
}

/** Is this user really in the chat? The only trustworthy answer. */
async function isParticipant(chat, user) {
  try {
    if (isChannel(chat)) {
      await tg.client.invoke(new Api.channels.GetParticipant({ channel: chat, participant: user }));
      return true;
    }
    const full = await tg.client.invoke(new Api.messages.GetFullChat({ chatId: chat.id }));
    const ps = (full && full.fullChat && full.fullChat.participants && full.fullChat.participants.participants) || [];
    return ps.some((p) => String(p.userId) === String(user.id));
  } catch {
    return false;
  }
}

/**
 * Add people to a group or channel.
 *
 * One user at a time: a single privacy-restricted account used to make the
 * whole batch throw, so nobody got added. Whoever cannot be added silently
 * gets the invite link instead, which always works.
 */
async function addMembers(chatRef, userRefs) {
  const chat = await resolve(chatRef);
  const added = [];
  const failed = [];

  for (const ref of [].concat(userRefs)) {
    let user;
    try {
      user = await resolve(ref);
    } catch (err) {
      failed.push({ ref: String(ref), error: err.message });
      continue;
    }
    try {
      if (isChannel(chat)) {
        const res = await tg.client.invoke(new Api.channels.InviteToChannel({ channel: chat, users: [user] }));
        // Telegram answers OK even when it quietly refused: a privacy-
        // restricted account comes back in `missingInvitees` and is simply not
        // in the group. Reporting that as success is how the founder ended up
        // outside a group he was told he had joined — so we verify.
        const missing = (res && res.missingInvitees) || [];
        if (missing.length) throw Object.assign(new Error('USER_PRIVACY_RESTRICTED'), { errorMessage: 'USER_PRIVACY_RESTRICTED' });
        if (!(await isParticipant(chat, user))) throw Object.assign(new Error('USER_PRIVACY_RESTRICTED'), { errorMessage: 'USER_PRIVACY_RESTRICTED' });
      } else if (isBasicGroup(chat)) {
        await tg.client.invoke(new Api.messages.AddChatUser({ chatId: chat.id, userId: user, fwdLimit: 50 }));
      } else throw new Error('Bu guruh yoki kanal emas');
      added.push(describe(user));
    } catch (err) {
      const msg = err.errorMessage || err.message || String(err);
      if (/USER_ALREADY_PARTICIPANT/i.test(msg)) {
        added.push({ ...describe(user), already: true });
        continue;
      }
      failed.push({ ref: describe(user), error: msg, privacy: /USER_PRIVACY_RESTRICTED|USER_NOT_MUTUAL_CONTACT/i.test(msg) });
    }
  }

  if (!added.length && !failed.length) throw new Error('Hech kim koʻrsatilmadi');
  const out = { ok: added.length > 0, chat: describe(chat), added, failed };
  if (failed.some((f) => f.privacy)) {
    out.inviteLink = await inviteLink(chat).catch(() => null);
    out.note = out.inviteLink
      ? `Baʼzilarini maxfiylik sozlamalari sababli qoʻsha olmadim — ularga shu havolani yuboring: ${out.inviteLink}`
      : 'Baʼzilarini maxfiylik sozlamalari sababli qoʻsha olmadim.';
  }
  return out;
}

/**
 * Delete a group or channel outright. "Delete that group" used to only make
 * the agent leave it, so the group stayed alive with the founder still in it.
 */
async function deleteChat(chatRef) {
  const entity = await resolve(chatRef);
  if (isChannel(entity)) {
    await tg.client.invoke(new Api.channels.DeleteChannel({ channel: entity }));
  } else if (isBasicGroup(entity)) {
    // Basic groups have no delete: clear history for everyone and leave.
    await tg.client.invoke(new Api.messages.DeleteChat({ chatId: entity.id })).catch(async () => {
      await tg.client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: 'me' }));
    });
  } else throw new Error('Bu guruh yoki kanal emas');
  log.info('chat oʻchirildi', { title: entity.title });
  return { ok: true, deleted: describe(entity) };
}

// ── messages & settings ──────────────────────────────────────────────────────

/** Delete messages; without ids, the account's own last message in that chat. */
async function deleteMessages(chatRef, ids = null) {
  const entity = await resolve(chatRef);
  let list = [].concat(ids || []).map(Number).filter(Boolean);
  if (!list.length) {
    const recent = await tg.client.getMessages(entity, { limit: 20 });
    const mine = recent.find((m) => m.out);
    if (!mine) throw new Error('Bu chatda oʻzimning xabarim topilmadi');
    list = [Number(mine.id)];
  }
  await tg.client.deleteMessages(entity, list, { revoke: true });
  log.info('xabar oʻchirildi', { chat: entity.title || entity.username || entity.id, ids: list });
  return { ok: true, deleted: list, chat: describe(entity) };
}

async function editChat(chatRef, { title = null, about = null } = {}) {
  const entity = await resolve(chatRef);
  const done = [];
  if (title) {
    if (isChannel(entity)) await tg.client.invoke(new Api.channels.EditTitle({ channel: entity, title }));
    else if (isBasicGroup(entity)) await tg.client.invoke(new Api.messages.EditChatTitle({ chatId: entity.id, title }));
    done.push('title');
  }
  if (about !== null && about !== undefined) {
    await tg.client.invoke(new Api.messages.EditChatAbout({ peer: entity, about: String(about) }));
    done.push('about');
  }
  return { ok: true, changed: done, chat: describe(entity) };
}

async function pinMessage(chatRef, messageId) {
  const entity = await resolve(chatRef);
  await tg.client.pinMessage(entity, Number(messageId), { notify: false });
  return { ok: true };
}

/** Chats the account is in — for "which groups am I in". */
async function myChats({ kind = null, limit = 200 } = {}) {
  const list = await tg.getDialogs(limit);
  return list.filter((d) => d.type !== 'private' && (!kind || d.type === kind)).map((d) => ({ id: d.id, title: d.title, username: d.username, type: d.type }));
}

/**
 * Who wrote today and what happened — "kimlar yozdi, xatlarni ko'rib chiq".
 * Reads the local message store rather than Telegram, so it is instant and
 * covers every chat the agent has seen.
 */
function inboxDigest({ hours = 24, maxChats = 40, perChat = 6 } = {}) {
  const { db } = require('../core/db');
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const chats = db
    .prepare(
      `SELECT m.tg_chat_id, COALESCE(c.title, m.tg_chat_id) title, c.type,
              COUNT(*) total,
              SUM(CASE WHEN m.is_agent = 1 THEN 1 ELSE 0 END) mine,
              MAX(m.date) last_at
         FROM messages m LEFT JOIN chats c ON c.tg_chat_id = m.tg_chat_id
        WHERE m.date > ? AND m.text IS NOT NULL AND m.text != ''
        GROUP BY m.tg_chat_id ORDER BY last_at DESC LIMIT ?`
    )
    .all(since, maxChats);

  const msgStmt = db.prepare(
    `SELECT sender_name, is_agent, text, date FROM messages
      WHERE tg_chat_id = ? AND date > ? AND text IS NOT NULL AND text != ''
      ORDER BY date DESC LIMIT ?`
  );

  return {
    hours,
    chats: chats.map((c) => ({
      chatId: c.tg_chat_id,
      title: c.title,
      type: c.type || 'private',
      messages: c.total,
      fromThem: c.total - (c.mine || 0),
      lastAt: new Date(c.last_at * 1000).toISOString(),
      recent: msgStmt
        .all(c.tg_chat_id, since, perChat)
        .reverse()
        .map((m) => `${m.is_agent ? 'men' : m.sender_name || '?'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 200)}`),
    })),
  };
}

module.exports = {
  joinChat, leaveChat, createChat, deleteChat, inviteLink, chatInfo, listMembers,
  promoteAdmin, demoteAdmin, removeUser, unbanUser, addMembers,
  deleteMessages, editChat, pinMessage, myChats, inviteHash, describe, inboxDigest,
};
