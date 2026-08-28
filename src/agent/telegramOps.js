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
async function createChat({ kind = 'group', title, about = '', isPublic = false, username = null }) {
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
  log.info(`${broadcast ? 'kanal' : 'guruh'} yaratildi`, { title, public: out.public });
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

async function promoteAdmin(chatRef, userRef, { rank = 'admin' } = {}) {
  const chat = await resolve(chatRef);
  const user = await resolve(userRef);
  if (isChannel(chat)) {
    await tg.client.invoke(new Api.channels.EditAdmin({ channel: chat, userId: user, adminRights: FULL_ADMIN(), rank: String(rank).slice(0, 16) }));
  } else if (isBasicGroup(chat)) {
    await tg.client.invoke(new Api.messages.EditChatAdmin({ chatId: chat.id, userId: user, isAdmin: true }));
  } else throw new Error('Bu guruh yoki kanal emas');
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

async function addMembers(chatRef, userRefs) {
  const chat = await resolve(chatRef);
  const users = [];
  const failed = [];
  for (const ref of [].concat(userRefs)) {
    try {
      users.push(await resolve(ref));
    } catch (err) {
      failed.push({ ref, error: err.message });
    }
  }
  if (!users.length) throw new Error('Hech kim topilmadi: ' + failed.map((f) => f.error).join('; '));
  if (isChannel(chat)) await tg.client.invoke(new Api.channels.InviteToChannel({ channel: chat, users }));
  else if (isBasicGroup(chat)) for (const u of users) await tg.client.invoke(new Api.messages.AddChatUser({ chatId: chat.id, userId: u, fwdLimit: 50 }));
  else throw new Error('Bu guruh yoki kanal emas');
  return { ok: true, chat: describe(chat), added: users.map(describe), failed };
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

module.exports = {
  joinChat, leaveChat, createChat, inviteLink, chatInfo, listMembers,
  promoteAdmin, demoteAdmin, removeUser, unbanUser, addMembers,
  deleteMessages, editChat, pinMessage, myChats, inviteHash, describe,
};
