'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const config = require('../config');
const { db, recordEvent } = require('../core/db');
const { encrypt, decrypt } = require('../core/crypto');
const { createLogger } = require('../core/logger');
const ai = require('../ai/client');

const log = createLogger('bots:managed');

/**
 * Bots the agent has written and runs itself.
 *
 * The founder says "make an anime bot and run it"; the assistant used to
 * answer by pasting Python into the chat. Now: the code is generated to a
 * strict spec (single Node file, Bot API over fetch, long polling, no
 * dependencies), syntax-checked, written under data/bots/<username>/, started
 * as a supervised child process, and smoke-tested through Telegram. Crashes
 * restart it; a restart of the agent restarts every bot marked running.
 */

const BOTS_DIR = path.join(config.dataDir, 'bots');
fs.mkdirSync(BOTS_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS managed_bots (
    username    TEXT PRIMARY KEY,
    name        TEXT,
    token_enc   TEXT,
    spec        TEXT,
    status      TEXT DEFAULT 'stopped',
    pid         INTEGER,
    restarts    INTEGER DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )
`);

const procs = new Map(); // username -> ChildProcess

const dirOf = (u) => path.join(BOTS_DIR, String(u).replace(/^@/, '').replace(/[^\w]/g, '_'));
const clean = (u) => String(u || '').replace(/^@/, '');

function saveToken(username, token, name = null) {
  db.prepare(
    `INSERT INTO managed_bots (username, name, token_enc) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET token_enc = excluded.token_enc, name = COALESCE(excluded.name, managed_bots.name), updated_at = datetime('now')`
  ).run(clean(username), name, encrypt(token));
}

function getToken(username) {
  const r = db.prepare('SELECT token_enc FROM managed_bots WHERE username = ?').get(clean(username));
  return r && r.token_enc ? decrypt(r.token_enc) : null;
}

function record(username) {
  const r = db.prepare('SELECT * FROM managed_bots WHERE username = ?').get(clean(username));
  if (!r) return null;
  const p = procs.get(r.username);
  return { ...r, token: r.token_enc ? decrypt(r.token_enc) : null, token_enc: undefined, alive: !!(p && !p.killed && p.exitCode === null), hasCode: fs.existsSync(path.join(dirOf(r.username), 'bot.js')) };
}

function list() {
  return db.prepare('SELECT username FROM managed_bots ORDER BY created_at DESC').all().map((r) => record(r.username));
}

// ── code generation ─────────────────────────────────────────────────────────

const CODE_RULES = `Talablar (qat'iy):
- Bitta fayl, Node.js 22, CommonJS ('use strict'). HECH QANDAY npm paket yo'q — faqat global fetch va node: modullar.
- Telegram Bot API bilan long polling: getUpdates(offset, timeout=30) tsikli, xatoda 3s kutib davom etadi, hech qachon o'zi to'xtamaydi.
- Token faqat process.env.BOT_TOKEN dan olinadi. Kodga token yozma.
- Har xabarga javob beruvchi handler tuzilmasi: /start, /help va spec'dagi buyruqlar; nomalum matnga qisqa yordam.
- Tashqi API kerak bo'lsa faqat ochiq, kalitsiz API (masalan https://api.jikan.moe/v4 anime uchun). Javoblarni try/catch bilan o'ra, xatoda foydalanuvchiga tushunarli xabar ber.
- Matnlar o'zbek tilida (lotin). parse_mode ishlatma (oddiy matn), 4000 belgidan uzun xabarni bo'l.
- console.log bilan har update ni bir qatorda logla.
- Faqat kodni qaytar. Markdown, izoh matni, \`\`\` belgilari YO'Q.`;

async function generateCode({ username, name, spec, previousError = null, previousCode = null }) {
  const messages = [
    { role: 'system', content: "Sen tajribali Node.js dasturchisan. Telegram bot kodini yozasan. Faqat ishlaydigan kod qaytarasan." },
    {
      role: 'user',
      content:
        `Bot: @${username} (${name || username}).\nVazifa: ${spec}\n\n${CODE_RULES}` +
        (previousError
          ? `\n\nOldingi urinish xato berdi:\n${previousError}\n\nOldingi kod:\n${String(previousCode).slice(0, 6000)}\n\nXatoni tuzatib, TO'LIQ kodni qaytadan yoz.`
          : ''),
    },
  ];
  const out = await ai.chat({ messages, purpose: 'bot:code', provider: 'groq', maxTokens: 3500, temperature: 0.2 });
  let code = String(out.content || '').trim();
  code = code.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
  return code;
}

function syntaxCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return null;
  } catch (err) {
    return String(err.stderr || err.message).slice(0, 1500);
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

async function deploy({ username, name = null, token = null, spec }) {
  const u = clean(username);
  if (!u) throw new Error('username kerak');
  const tok = token || getToken(u);
  if (!tok) throw new Error(`@${u} uchun token yo'q — avval yarating yoki tokenini bering`);
  saveToken(u, tok, name);
  db.prepare('UPDATE managed_bots SET spec = ?, updated_at = datetime(\'now\') WHERE username = ?').run(String(spec || ''), u);

  const dir = dirOf(u);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bot.js');

  let code = null;
  let error = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    code = await generateCode({ username: u, name, spec, previousError: error, previousCode: code });
    if (!code || code.length < 300) {
      error = 'kod juda qisqa yoki bo\'sh';
      continue;
    }
    if (/BOT_TOKEN\s*=\s*["'][0-9]{6,}/.test(code)) {
      error = 'kodga token yozilgan — faqat process.env.BOT_TOKEN ishlat';
      continue;
    }
    fs.writeFileSync(file, code, 'utf8');
    error = syntaxCheck(file);
    if (!error) break;
    log.warn('bot kodi sintaksis xatosi, qayta yozilmoqda', { username: u, attempt, error: error.slice(0, 120) });
  }
  if (error) throw new Error(`Kod 3 urinishda ham to'g'ri chiqmadi: ${error.slice(0, 200)}`);

  await start(u);
  recordEvent('bots', 'Bot deployed', { username: u, chars: code.length });
  return { ok: true, username: u, file, lines: code.split('\n').length };
}

function start(username) {
  const u = clean(username);
  const rec = record(u);
  if (!rec) throw new Error(`@${u} boshqariladigan botlar ro'yxatida yo'q`);
  if (!rec.hasCode) throw new Error(`@${u} uchun kod yo'q — avval deploy qiling`);
  if (rec.alive) return { ok: true, already: true, pid: rec.pid };

  const dir = dirOf(u);
  const out = fs.openSync(path.join(dir, 'bot.log'), 'a');
  const child = spawn(process.execPath, ['bot.js'], {
    cwd: dir,
    env: { PATH: process.env.PATH, BOT_TOKEN: rec.token, NODE_ENV: 'production' },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  procs.set(u, child);
  db.prepare("UPDATE managed_bots SET status = 'running', pid = ?, last_error = NULL, updated_at = datetime('now') WHERE username = ?").run(child.pid, u);
  log.info('bot ishga tushdi', { username: u, pid: child.pid });

  child.on('exit', (code, signal) => {
    procs.delete(u);
    const cur = db.prepare('SELECT status, restarts FROM managed_bots WHERE username = ?').get(u);
    if (!cur || cur.status !== 'running') return; // stopped on purpose
    const restarts = (cur.restarts || 0) + 1;
    db.prepare("UPDATE managed_bots SET restarts = ?, last_error = ?, updated_at = datetime('now') WHERE username = ?").run(restarts, `exit ${code ?? signal}`, u);
    if (restarts > 20) {
      db.prepare("UPDATE managed_bots SET status = 'crashed' WHERE username = ?").run(u);
      log.error('bot 20 marta yiqildi — to\'xtatildi', { username: u });
      return;
    }
    const delay = Math.min(60_000, 3_000 * restarts);
    log.warn('bot yiqildi, qayta ishga tushirilmoqda', { username: u, code, delayMs: delay });
    setTimeout(() => {
      try {
        start(u);
      } catch (err) {
        log.error('qayta ishga tushirib bo\'lmadi', { username: u, error: err.message });
      }
    }, delay);
  });

  return { ok: true, pid: child.pid };
}

function stop(username) {
  const u = clean(username);
  db.prepare("UPDATE managed_bots SET status = 'stopped', pid = NULL, updated_at = datetime('now') WHERE username = ?").run(u);
  const p = procs.get(u);
  if (p) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
    procs.delete(u);
  }
  log.info('bot to\'xtatildi', { username: u });
  return { ok: true };
}

function remove(username) {
  const u = clean(username);
  stop(u);
  db.prepare('DELETE FROM managed_bots WHERE username = ?').run(u);
  try {
    fs.rmSync(dirOf(u), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  return { ok: true };
}

function logs(username, lines = 60) {
  const f = path.join(dirOf(clean(username)), 'bot.log');
  if (!fs.existsSync(f)) return '';
  const text = fs.readFileSync(f, 'utf8');
  return text.split('\n').slice(-lines).join('\n');
}

function code(username) {
  const f = path.join(dirOf(clean(username)), 'bot.js');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

/** Bring every bot marked running back up after the agent restarts. */
function resumeAll() {
  let n = 0;
  for (const r of db.prepare("SELECT username FROM managed_bots WHERE status = 'running'").all()) {
    try {
      start(r.username);
      n++;
    } catch (err) {
      log.warn('bot tiklanmadi', { username: r.username, error: err.message });
    }
  }
  if (n) log.info(`${n} ta boshqariladigan bot tiklandi`);
}

function stopAll() {
  for (const u of [...procs.keys()]) {
    const p = procs.get(u);
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { deploy, start, stop, remove, logs, code, list, record, saveToken, getToken, resumeAll, stopAll, BOTS_DIR };
