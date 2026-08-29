'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const config = require('../config');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const COLORS = { trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', fatal: '\x1b[35m' };
const RESET = '\x1b[0m';

const threshold = LEVELS[config.logLevel] || 30;

/** In-memory ring buffer so the admin panel can render recent logs instantly. */
const RING_SIZE = 800;
const ring = [];

/** Live stream for SSE in the admin panel. */
const bus = new EventEmitter();
bus.setMaxListeners(50);

let stream = null;
let streamDay = null;
function fileStream() {
  const day = new Date().toISOString().slice(0, 10);
  if (stream && streamDay === day) return stream;
  if (stream) stream.end();
  streamDay = day;
  stream = fs.createWriteStream(path.join(config.logsDir, `agent-${day}.log`), { flags: 'a' });
  return stream;
}

function safeMeta(meta) {
  if (!meta) return undefined;
  if (meta instanceof Error) return { error: meta.message, stack: meta.stack };
  try {
    return JSON.parse(
      JSON.stringify(meta, (k, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (v instanceof Error) return { error: v.message, stack: v.stack };
        if (typeof v === 'string' && v.length > 1200) return v.slice(0, 1200) + '…';
        return v;
      })
    );
  } catch {
    return { meta: String(meta) };
  }
}

function emit(level, scope, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, scope, msg: String(msg), meta: safeMeta(meta) };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  bus.emit('log', entry);

  if (LEVELS[level] < threshold) return;

  const time = entry.ts.slice(11, 23);
  const color = COLORS[level] || '';
  const tail = entry.meta ? ' ' + JSON.stringify(entry.meta) : '';
  // eslint-disable-next-line no-console
  console.log(`${color}${time} ${level.toUpperCase().padEnd(5)}${RESET} \x1b[1m[${scope}]\x1b[0m ${entry.msg}${tail}`);
  try { fileStream().write(JSON.stringify(entry) + '\n'); } catch { /* disk issues must never crash the agent */ }
}

function createLogger(scope = 'app') {
  const l = {};
  for (const lvl of Object.keys(LEVELS)) l[lvl] = (msg, meta) => emit(lvl, scope, msg, meta);
  l.child = (sub) => createLogger(`${scope}:${sub}`);
  return l;
}

/**
 * Search the log across a time range, not just the in-memory ring.
 *
 * The ring holds the last 800 lines — a few minutes on a busy day. When the
 * founder asks for "yesterday between 3 and 5", those lines are long gone
 * from memory but they are on disk, one JSONL file per day. So: read the
 * day files the range touches, then fold in the ring for the newest lines
 * (the current day's file lags by a write).
 *
 * @param {object}  opts
 * @param {number}  [opts.hours]   how far back, capped at 7 days
 * @param {string}  [opts.level]   minimum level (info → info/warn/error/fatal)
 * @param {string}  [opts.scope]   exact scope, or a prefix like "ai:"
 * @param {string}  [opts.q]       free text, matched against message and meta
 * @param {number}  [opts.limit]   newest N after filtering
 */
function searchLogs({ hours = 1, level = null, scope = null, q = '', limit = 500 } = {}) {
  const span = Math.min(Math.max(Number(hours) || 1, 1), 24 * 7); // 1 soat … 7 kun
  const since = Date.now() - span * 3600_000;
  const min = level ? LEVELS[level] || 0 : 0;
  const needle = String(q || '').trim().toLowerCase();

  const matches = (e) => {
    if (Date.parse(e.ts) < since) return false;
    if (min && (LEVELS[e.level] || 0) < min) return false;
    if (scope && !String(e.scope || '').startsWith(scope)) return false;
    if (needle) {
      const hay = `${e.scope} ${e.msg} ${e.meta ? JSON.stringify(e.meta) : ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  };

  // Which day files the range covers. More than one only when the range
  // crosses midnight UTC.
  const days = new Set();
  for (let t = since; t <= Date.now() + 86_400_000; t += 86_400_000) {
    days.add(new Date(t).toISOString().slice(0, 10));
  }
  days.add(new Date().toISOString().slice(0, 10));

  const found = [];
  for (const day of [...days].sort()) {
    const file = path.join(config.logsDir, `agent-${day}.log`);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // o'sha kun uchun fayl yo'q — normal holat
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // yarim yozilgan qator — tashlab yuboramiz
      }
      if (matches(entry)) found.push(entry);
    }
  }

  // Ringdagi eng yangi qatorlar hali diskka tushmagan bo'lishi mumkin.
  // Takrorlanmasligi uchun ts+msg bo'yicha tekshiramiz.
  const seen = new Set(found.map((e) => e.ts + e.msg));
  for (const e of ring) {
    if (matches(e) && !seen.has(e.ts + e.msg)) found.push(e);
  }

  found.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return {
    hours: span,
    total: found.length,
    truncated: found.length > limit,
    items: found.slice(-Math.min(Number(limit) || 500, 5000)),
  };
}

/** Scopes seen in the ring — feeds the panel's filter dropdown. */
const knownScopes = () => [...new Set(ring.map((e) => e.scope).filter(Boolean))].sort();

module.exports = {
  createLogger,
  logBus: bus,
  levels: Object.keys(LEVELS),
  knownScopes,
  searchLogs,
  recentLogs: (n = 200, level = null) => {
    const items = level ? ring.filter((e) => LEVELS[e.level] >= (LEVELS[level] || 0)) : ring;
    return items.slice(-n);
  },
};
