'use strict';
const { db, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const tasks = require('./tasks');

const log = createLogger('routines');

/**
 * Standing orders.
 *
 * "Every morning at 9, check the group and report to me" is not a task — it is
 * a job the agent holds forever. A routine stores the instruction and a
 * schedule; the ticker turns each due occurrence into an ordinary task, so the
 * existing queue, retry and reporting machinery carries it out.
 *
 * Schedules kept deliberately simple, because they are set from a chat message:
 *   daily   at HH:MM
 *   weekly  at HH:MM on a weekday
 *   hourly  every N hours
 *   minutes every N minutes
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS routines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT,
    instruction TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'daily',
    at_time     TEXT,
    weekday     INTEGER,
    every_n     INTEGER,
    chat_id     TEXT,
    enabled     INTEGER DEFAULT 1,
    last_run    INTEGER,
    next_run    INTEGER,
    runs        INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`);

const TZ = 'Asia/Tashkent';

/** Local wall-clock parts for a moment, in the founder's timezone. */
function parts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, weekday };
}

/** Epoch ms for a wall-clock time today (or a given day offset) in Tashkent. */
function atLocal({ hh, mm }, dayOffset = 0) {
  const now = new Date();
  const p = parts(now);
  // Tashkent is UTC+5 with no DST, so the offset is a constant.
  const utc = Date.UTC(p.y, p.m - 1, p.d + dayOffset, hh - 5, mm, 0, 0);
  return utc;
}

function computeNext(r, from = Date.now()) {
  const [hh, mm] = String(r.at_time || '09:00').split(':').map((n) => parseInt(n, 10) || 0);
  switch (r.kind) {
    case 'minutes':
      return from + Math.max(1, r.every_n || 30) * 60_000;
    case 'hourly':
      return from + Math.max(1, r.every_n || 1) * 3600_000;
    case 'weekly': {
      for (let i = 0; i <= 7; i++) {
        const t = atLocal({ hh, mm }, i);
        if (t > from && parts(new Date(t)).weekday === (r.weekday ?? 1)) return t;
      }
      return from + 7 * 86400_000;
    }
    case 'daily':
    default: {
      const today = atLocal({ hh, mm }, 0);
      return today > from ? today : atLocal({ hh, mm }, 1);
    }
  }
}

/**
 * Turn a phrase into a schedule. Handles what the founder actually types:
 * "har kuni soat 9 da", "har 2 soatda", "har dushanba 10:00 da".
 */
function parseSchedule(text) {
  const t = String(text || '').toLowerCase();
  const time = t.match(/(?:soat\s*)?(\d{1,2})[:.](\d{2})/) || t.match(/soat\s*(\d{1,2})\b/);
  const at_time = time ? `${String(parseInt(time[1], 10)).padStart(2, '0')}:${time[2] ? time[2] : '00'}` : '09:00';

  const everyH = t.match(/har\s*(\d+)\s*soat|every\s*(\d+)\s*hour/);
  if (everyH) return { kind: 'hourly', every_n: parseInt(everyH[1] || everyH[2], 10), at_time };
  const everyM = t.match(/har\s*(\d+)\s*daqiqa|every\s*(\d+)\s*min/);
  if (everyM) return { kind: 'minutes', every_n: parseInt(everyM[1] || everyM[2], 10), at_time };

  const days = { yakshanba: 0, dushanba: 1, seshanba: 2, chorshanba: 3, payshanba: 4, juma: 5, shanba: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  for (const [name, n] of Object.entries(days)) {
    if (t.includes(name)) return { kind: 'weekly', weekday: n, at_time };
  }
  return { kind: 'daily', at_time };
}

function create({ title, instruction, schedule = null, chatId = null, kind = null, atTime = null, everyN = null, weekday = null }) {
  const parsed = schedule ? parseSchedule(schedule) : {};
  const r = {
    title: title || String(instruction).slice(0, 60),
    instruction: String(instruction),
    kind: kind || parsed.kind || 'daily',
    at_time: atTime || parsed.at_time || '09:00',
    weekday: weekday ?? parsed.weekday ?? null,
    every_n: everyN ?? parsed.every_n ?? null,
    chat_id: chatId,
  };
  const next = computeNext(r);
  const res = db
    .prepare('INSERT INTO routines (title, instruction, kind, at_time, weekday, every_n, chat_id, next_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.title, r.instruction, r.kind, r.at_time, r.weekday, r.every_n, r.chat_id, next);
  const id = Number(res.lastInsertRowid);
  log.info('doimiy vazifa yaratildi', { id, kind: r.kind, at: r.at_time, next: new Date(next).toISOString() });
  recordEvent('routines', 'Routine created', { id, title: r.title, kind: r.kind });
  return get(id);
}

const get = (id) => db.prepare('SELECT * FROM routines WHERE id = ?').get(Number(id));
const list = ({ all = true } = {}) => db.prepare(`SELECT * FROM routines ${all ? '' : 'WHERE enabled = 1'} ORDER BY next_run`).all();
const setEnabled = (id, on) => db.prepare('UPDATE routines SET enabled = ? WHERE id = ?').run(on ? 1 : 0, Number(id)).changes > 0;
const remove = (id) => db.prepare('DELETE FROM routines WHERE id = ?').run(Number(id)).changes > 0;

const describe = (r) =>
  r.kind === 'daily' ? `har kuni ${r.at_time}` :
  r.kind === 'weekly' ? `har hafta ${['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'][r.weekday ?? 1]} ${r.at_time}` :
  r.kind === 'hourly' ? `har ${r.every_n || 1} soatda` :
  `har ${r.every_n || 30} daqiqada`;

/** Queue every routine that has come due. Called from the task ticker. */
function tick(now = Date.now()) {
  const due = db.prepare('SELECT * FROM routines WHERE enabled = 1 AND next_run <= ?').all(now);
  let queued = 0;
  for (const r of due) {
    try {
      tasks.create({
        kind: 'assistant_run',
        title: `[doimiy] ${r.title}`,
        payload: { instruction: r.instruction, chatId: r.chat_id },
        runAt: now,
        originChat: r.chat_id,
        createdBy: `routine:${r.id}`,
      });
      queued++;
    } catch (err) {
      log.warn('doimiy vazifani navbatga qoʻshib boʻlmadi', { id: r.id, error: err.message });
    }
    db.prepare('UPDATE routines SET last_run = ?, runs = runs + 1, next_run = ? WHERE id = ?').run(now, computeNext(r, now), r.id);
  }
  if (queued) log.info('doimiy vazifalar navbatga qoʻshildi', { queued });
  return queued;
}

module.exports = { create, get, list, setEnabled, remove, tick, describe, parseSchedule, computeNext };
