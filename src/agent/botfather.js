'use strict';
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');

const log = createLogger('bots');
const BOTFATHER = 'BotFather';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Driving any bot from the user account: send text, wait for its reply, read
 * its buttons, press them. BotFather is just one bot among them — the
 * create/delete/configure helpers below are thin scripts over `talk()` and
 * `pressButton()`.
 */

/** Buttons (inline and reply-keyboard) attached to a message, flattened. */
function buttonsOf(msg) {
  const out = [];
  const markup = msg && msg.replyMarkup;
  if (!markup || !markup.rows) return out;
  markup.rows.forEach((row, r) =>
    (row.buttons || []).forEach((b, c) => {
      out.push({
        text: b.text,
        row: r,
        col: c,
        kind: b.className === 'KeyboardButtonCallback' ? 'inline' : b.className === 'KeyboardButtonUrl' ? 'url' : 'keyboard',
        url: b.url || null,
      });
    })
  );
  return out;
}

/** Wait for messages from the bot newer than `sinceId`. */
async function collectReplies(entity, sinceId, { waitMs = 15_000, pollMs = 700 } = {}) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const msgs = await tg.client.getMessages(entity, { minId: sinceId, limit: 10 });
    const incoming = msgs.filter((m) => !m.out && Number(m.id) > sinceId);
    if (incoming.length) {
      await sleep(900); // bots often send a second message right after the first
      const again = await tg.client.getMessages(entity, { minId: sinceId, limit: 10 });
      const list = again.filter((m) => !m.out).reverse();
      return list;
    }
  }
  return [];
}

function shape(list) {
  const replies = list.map((m) => m.message || '');
  const last = list[list.length - 1];
  return {
    replies,
    text: replies.join('\n\n'),
    buttons: last ? buttonsOf(last) : [],
    lastMessageId: last ? Number(last.id) : null,
  };
}

/** Send text to a bot and return what it answered, including any buttons. */
async function talk(botRef, text, { waitMs = 15_000 } = {}) {
  if (!tg.isConnected()) throw new Error('Telegram ulanmagan');
  const entity = await tg.resolveEntity(botRef);
  // ATAYLAB xom GramJS orqali: botga yuborilgan matn buyruq, ko'rsatiladigan
  // xabar emas. "/setdescription" yoki bot username'i formatlovchidan o'tsa,
  // qabul qiluvchi bot uni tanimay qoladi. Bu yerda hech narsa o'zgarmasin.
  const sent = await tg.client.sendMessage(entity, { message: text });
  const list = await collectReplies(entity, Number(sent.id), { waitMs });
  return { sent: text, ...shape(list) };
}

/**
 * Press a button on the bot's latest message. Inline buttons are clicked;
 * reply-keyboard buttons are sent as text (that is what a tap does).
 */
async function pressButton(botRef, buttonText, { waitMs = 15_000 } = {}) {
  if (!tg.isConnected()) throw new Error('Telegram ulanmagan');
  const entity = await tg.resolveEntity(botRef);
  const recent = await tg.client.getMessages(entity, { limit: 8 });
  const want = String(buttonText).trim().toLowerCase();

  for (const msg of recent) {
    if (msg.out) continue;
    const btns = buttonsOf(msg);
    const hit = btns.find((b) => b.text.toLowerCase() === want) || btns.find((b) => b.text.toLowerCase().includes(want));
    if (!hit) continue;

    if (hit.kind === 'url') return { ok: true, pressed: hit.text, url: hit.url, note: 'bu havola tugmasi — ochish uchun URL' };
    if (hit.kind === 'keyboard') {
      const r = await talk(botRef, hit.text, { waitMs });
      return { ok: true, pressed: hit.text, ...r };
    }
    const sinceId = Number(msg.id);
    await msg.click({ text: hit.text });
    const list = await collectReplies(entity, sinceId, { waitMs });
    // Inline clicks often edit the same message instead of sending a new one.
    if (!list.length) {
      const edited = await tg.client.getMessages(entity, { ids: [sinceId] });
      return { ok: true, pressed: hit.text, ...shape(edited.filter(Boolean)), edited: true };
    }
    return { ok: true, pressed: hit.text, ...shape(list) };
  }

  const available = recent.filter((m) => !m.out).flatMap(buttonsOf).map((b) => b.text);
  return { ok: false, error: `"${buttonText}" tugmasi topilmadi`, availableButtons: [...new Set(available)] };
}

/** What did the bot say last, and which buttons does it show? */
async function readBot(botRef, limit = 5) {
  const entity = await tg.resolveEntity(botRef);
  const msgs = (await tg.client.getMessages(entity, { limit })).reverse();
  return {
    messages: msgs.map((m) => ({ from: m.out ? 'men' : 'bot', text: String(m.message || '').slice(0, 600), buttons: m.out ? [] : buttonsOf(m).map((b) => b.text) })),
  };
}

// ── BotFather scripts ───────────────────────────────────────────────────────

const TOKEN_RE = /\b(\d{8,11}:[A-Za-z0-9_-]{30,})\b/;

/**
 * BotFather answers "Choose a bot" with one button per bot. Typing the
 * username works too — unless the bot is not on the list, which yields
 * "Invalid bot selected" and no hint why. Prefer the button, and when the bot
 * is missing say so with the real list, so the assistant can report honestly
 * instead of retrying.
 */
async function chooseBot(uname, reply, { waitMs = 15_000 } = {}) {
  const want = '@' + String(uname).replace(/^@/, '').toLowerCase();
  const listed = reply.buttons.map((b) => b.text).filter((t) => /^@\w+bot$/i.test(t));
  if (listed.length && !listed.some((t) => t.toLowerCase() === want)) {
    // Buttons may be paginated; if there is a "next" button the bot could still be there.
    const hasMore = reply.buttons.some((b) => /»|next|>>/i.test(b.text));
    if (!hasMore) throw new Error(`${want} bu akkauntda yoʻq. BotFather roʻyxati: ${listed.join(', ')}`);
  }
  const hit = reply.buttons.find((b) => b.text.toLowerCase() === want);
  if (hit) return pressButton(BOTFATHER, hit.text, { waitMs });
  return talk(BOTFATHER, want, { waitMs });
}

async function createBot({ name, username, description = null, about = null, commands = null }) {
  const uname = String(username || '').replace(/^@/, '');
  if (!/^[a-zA-Z][\w]{3,30}bot$/i.test(uname)) {
    throw new Error(`Bot username "${uname}" yaroqsiz: lotin harflari, kamida 5 belgi va "bot" bilan tugashi shart (masalan anitoku_helper_bot)`);
  }
  log.info('bot yaratilmoqda', { name, username: uname });
  const s1 = await talk(BOTFATHER, '/newbot');
  if (!/name|nom|call it/i.test(s1.text)) throw new Error(`BotFather kutilmagan javob berdi: ${s1.text.slice(0, 160)}`);
  const s2 = await talk(BOTFATHER, name);
  if (!/username/i.test(s2.text)) throw new Error(`BotFather nomni qabul qilmadi: ${s2.text.slice(0, 160)}`);
  const s3 = await talk(BOTFATHER, uname, { waitMs: 20_000 });
  const m = s3.text.match(TOKEN_RE);
  if (!m) {
    if (/already taken|taken/i.test(s3.text)) throw new Error(`@${uname} band — boshqa username tanlang`);
    throw new Error(`Token olinmadi. BotFather: ${s3.text.slice(0, 200)}`);
  }
  const extras = [];
  if (description) extras.push(await setBotField(uname, '/setdescription', description));
  if (about) extras.push(await setBotField(uname, '/setabouttext', about));
  if (commands) extras.push(await setBotField(uname, '/setcommands', formatCommands(commands)));
  log.info('bot yaratildi', { username: uname });
  return { ok: true, username: uname, name, token: m[1], link: `https://t.me/${uname}`, extras };
}

/**
 * /deletebot → pick the bot → BotFather asks for the literal confirmation
 * phrase. The phrase is sent only after BotFather actually asked for it.
 */
async function deleteBot(username) {
  const uname = '@' + String(username || '').replace(/^@/, '');
  const s1 = await talk(BOTFATHER, '/deletebot');
  if (!/choose|bot/i.test(s1.text)) throw new Error(`BotFather: ${s1.text.slice(0, 160)}`);
  const s2 = await chooseBot(uname, s1);
  if (/invalid|not found|no such|don'?t own/i.test(s2.text)) throw new Error(`Bot topilmadi yoki sizniki emas: ${s2.text.slice(0, 160)}`);
  if (!/sure|delete|yes/i.test(s2.text)) throw new Error(`Kutilmagan javob: ${s2.text.slice(0, 160)}`);
  const s3 = await talk(BOTFATHER, 'Yes, I am totally sure.', { waitMs: 15_000 });
  const ok = /done|deleted|gone|removed/i.test(s3.text);
  log.info('bot oʻchirildi', { username: uname, ok });
  return { ok, username: uname, reply: s3.text.slice(0, 200) };
}

async function setBotField(username, command, value) {
  const s1 = await talk(BOTFATHER, command);
  if (!/choose|bot/i.test(s1.text)) return { command, ok: false, reply: s1.text.slice(0, 120) };
  const s2 = await chooseBot(username, s1);
  if (/invalid bot/i.test(s2.text)) return { command, ok: false, reply: s2.text.slice(0, 120) };
  const s3 = await talk(BOTFATHER, value, { waitMs: 12_000 });
  return { command, ok: /success|updated|done/i.test(s3.text), reply: s3.text.slice(0, 160) };
}

function formatCommands(commands) {
  if (typeof commands === 'string') return commands;
  return (commands || []).map((c) => `${String(c.command || c.name).replace(/^\//, '')} - ${c.description || ''}`).join('\n');
}

async function configureBot({ username, description = null, about = null, commands = null, name = null }) {
  const out = { username, steps: [] };
  if (name) out.steps.push(await setBotField(username, '/setname', name));
  if (description) out.steps.push(await setBotField(username, '/setdescription', description));
  if (about) out.steps.push(await setBotField(username, '/setabouttext', about));
  if (commands) out.steps.push(await setBotField(username, '/setcommands', formatCommands(commands)));
  out.ok = out.steps.every((s) => s.ok);
  return out;
}

/**
 * All bots this account owns. BotFather shows a button per bot — except when
 * there is exactly one, where it jumps straight to that bot's menu and the
 * name is only in the text. Both shapes are read.
 */
async function listMyBots() {
  const r = await talk(BOTFATHER, '/mybots');
  const fromButtons = r.buttons.map((b) => b.text).filter((t) => /^@\w+bot$/i.test(t));
  const fromText = (r.text.match(/@\w+bot\b/gi) || []);
  const bots = [...new Set([...fromButtons, ...fromText])];
  if (!bots.length && /don'?t have any bots|no bots/i.test(r.text)) return { bots: [], raw: r.text.slice(0, 200) };
  return { bots, raw: r.text.slice(0, 200) };
}

/** Read a bot's token from BotFather (/token → choose bot). */
async function getToken(username) {
  const uname = '@' + String(username || '').replace(/^@/, '');
  const s1 = await talk(BOTFATHER, '/token');
  let reply = s1;
  if (/choose|bot/i.test(s1.text) && !TOKEN_RE.test(s1.text)) reply = await chooseBot(uname, s1, { waitMs: 12_000 });
  const m = reply.text.match(TOKEN_RE);
  if (!m) throw new Error(`Token olinmadi: ${reply.text.slice(0, 160)}`);
  return { ok: true, username: uname, token: m[1] };
}

/** Revoke the current token and get a fresh one (/revoke → choose bot). */
async function revokeToken(username) {
  const uname = '@' + String(username || '').replace(/^@/, '');
  const s1 = await talk(BOTFATHER, '/revoke');
  let reply = s1;
  if (!TOKEN_RE.test(s1.text)) {
    if (!/choose|bot/i.test(s1.text)) throw new Error(`BotFather: ${s1.text.slice(0, 160)}`);
    reply = await chooseBot(uname, s1);
  }
  const m = reply.text.match(TOKEN_RE);
  if (!m) throw new Error(`Yangi token olinmadi: ${reply.text.slice(0, 160)}`);
  log.info('bot tokeni yangilandi', { username: uname });
  return { ok: true, username: uname, token: m[1], revoked: true };
}

module.exports = { talk, pressButton, readBot, buttonsOf, createBot, deleteBot, configureBot, setBotField, listMyBots, getToken, revokeToken };
