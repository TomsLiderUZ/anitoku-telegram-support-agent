'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

// ── tiny .env loader (no dependency) ────────────────────────────────────────
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

// ── APP_SECRET bootstrap ────────────────────────────────────────────────────
// If missing, generate once and persist to data/.secret so encrypted values stay readable.
function resolveSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 16) return process.env.APP_SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const int = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  skillsDir: path.join(DATA_DIR, 'skills'),
  logsDir: path.join(DATA_DIR, 'logs'),
  backupsDir: path.join(DATA_DIR, 'backups'),
  dbFile: path.join(DATA_DIR, 'anitoku.db'),

  secret: resolveSecret(),
  logLevel: process.env.LOG_LEVEL || 'info',
  tz: process.env.TZ || 'Asia/Tashkent',

  admin: {
    host: process.env.ADMIN_HOST || '127.0.0.1',
    port: int(process.env.ADMIN_PORT, 8787),
    user: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || '',
    trustProxy: bool(process.env.TRUST_PROXY, false),
    sessionTtlMs: 1000 * 60 * 60 * 12,
  },
};

for (const d of [config.dataDir, config.skillsDir, config.logsDir, config.backupsDir, path.join(DATA_DIR, 'sessions')]) {
  fs.mkdirSync(d, { recursive: true });
}

module.exports = config;
