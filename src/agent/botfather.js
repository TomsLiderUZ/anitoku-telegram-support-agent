'use strict';
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');

const log = createLogger('botfather');
const BOTFATHER = 'BotFather';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive a conversation with @BotFather (or any bot) from the user account.
 *
 * Bots reply asynchronously, so each step is: send, then poll the chat for a
 * message newer than what we sent. Nothing here is BotFather-specific except
 * the token regex — `talk()` is reused for "ask @somebot to do X".
 */
async function talk(botRef, text, { waitMs = 15_000, pollMs = 700 } = {}) {
  if (!tg.isConnected()) throw new Error('Telegram ulanmagan');
  const entity = await tg.resolveEntity(botRef);
  const sent = await tg.client.sendMessage(entity, { message: text });
  const sinceId = Number(sent.id);

  const deadline = Date.now() + waitMs;
  const replies = [];
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const msgs = await tg.client.getMessages(entity, { minId: sinceId, limit: 10 });
    const incoming = msgs.filter((m) => !m.out && Number(m.id) > sinceId);
    if (incoming.length) {
      // Bots often send two messages back-to-back; give the second a moment.
      await sleep(900);
      const again = await tg.client.getMessages(entity, { minId: sinceId, limit: 10 });
      for (const m of again.filter((m) => !m.out).reverse()) replies.push(m.message || '');
      break;
    }
  }
  return { sent: text, replies, text: replies.join('\n\n') };
}

const TOKEN_RE = /\b(\d{8,11}:[A-Za-z0-9_-]{30,})\b/;

/**
 * Create a bot end to end and return its token.
 * BotFather's flow: /newbot → asks for a name → asks for a username → issues token.
 */
async function createBot({ name, username, description = null, about = null, commands = null }) {
  const uname = String(username || '').replace(/^@/, '');
  if (!/^[a-zA-Z][\w]{3,30}bot$/i.test(uname)) {
    throw new Error(`Bot username "${uname}" yaroqsiz: lotin harflari, kamida 5 belgi va "bot" bilan tugashi shart (masalan anitoku_helper_bot)`);
  }

  log.info('bot yaratilmoqda', { name, username: uname });
  const s1 = await talk(BOTFATHER, '/newbot');
  if (!/name|nom|как назовём|call it/i.test(s1.text)) throw new Error(`BotFather kutilmagan javob berdi: ${s1.text.slice(0, 160)}`);

  const s2 = await talk(BOTFATHER, name);
  if (!/username/i.test(s2.text)) throw new Error(`BotFather nomni qabul qilmadi: ${s2.text.slice(0, 160)}`);

  const s3 = await talk(BOTFATHER, uname, { waitMs: 20_000 });
  const m = s3.text.match(TOKEN_RE);
  if (!m) {
    if (/already taken|занят|taken/i.test(s3.text)) throw new Error(`@${uname} band — boshqa username tanlang`);
    throw new Error(`Token olinmadi. BotFather: ${s3.text.slice(0, 200)}`);
  }
  const token = m[1];

  const extras = [];
  if (description) extras.push(await setBotField(uname, '/setdescription', description));
  if (about) extras.push(await setBotField(uname, '/setabouttext', about));
  if (commands) extras.push(await setBotField(uname, '/setcommands', formatCommands(commands)));

  log.info('bot yaratildi', { username: uname });
  return { ok: true, username: uname, name, token, link: `https://t.me/${uname}`, extras };
}

/** Generic "/setX → pick bot → send value" sequence. */
async function setBotField(username, command, value) {
  const s1 = await talk(BOTFATHER, command);
  if (!/choose|выберите|bot/i.test(s1.text)) return { command, ok: false, reply: s1.text.slice(0, 120) };
  const s2 = await talk(BOTFATHER, '@' + String(username).replace(/^@/, ''));
  const s3 = await talk(BOTFATHER, value, { waitMs: 12_000 });
  const ok = /success|updated|обновлен|готово|done/i.test(s3.text);
  return { command, ok, reply: s3.text.slice(0, 160) };
}

function formatCommands(commands) {
  if (typeof commands === 'string') return commands;
  return (commands || [])
    .map((c) => `${String(c.command || c.name).replace(/^\//, '')} - ${c.description || ''}`)
    .join('\n');
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

module.exports = { talk, createBot, configureBot, setBotField };
