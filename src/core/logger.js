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

module.exports = {
  createLogger,
  logBus: bus,
  recentLogs: (n = 200, level = null) => {
    const items = level ? ring.filter((e) => LEVELS[e.level] >= (LEVELS[level] || 0)) : ring;
    return items.slice(-n);
  },
};
