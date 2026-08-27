'use strict';
const crypto = require('node:crypto');
const { db } = require('../core/db');
const config = require('../config');
const { hashPassword, verifyPassword, randomId } = require('../core/crypto');
const { createLogger } = require('../core/logger');

const log = createLogger('admin:auth');

const COOKIE = 'anitoku_sid';

/** Create the first admin from .env on first boot. */
function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (count > 0) return null;

  const username = config.admin.user || 'admin';
  const password = config.admin.password || randomId(9);
  db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)').run(username, hashPassword(password), 'owner');

  if (!config.admin.password) {
    log.warn('─────────────────────────────────────────────');
    log.warn(`Admin yaratildi → login: ${username} | parol: ${password}`);
    log.warn('Bu parolni saqlab qo\'ying — u faqat bir marta ko\'rsatiladi.');
    log.warn('─────────────────────────────────────────────');
    return { username, password };
  }
  log.info(`Admin yaratildi → login: ${username} (parol .env dan olindi)`);
  return { username, password: null };
}

// ── brute-force protection ──────────────────────────────────────────────────
const attempts = new Map(); // ip -> { count, until }

function throttled(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (a.until > Date.now()) return Math.ceil((a.until - Date.now()) / 1000);
  if (a.until <= Date.now()) attempts.delete(ip);
  return false;
}

function noteFailure(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= 5) {
    a.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (a.count - 5));
    a.count = 5;
  }
  attempts.set(ip, a);
}

const clearFailures = (ip) => attempts.delete(ip);

// ── sessions ────────────────────────────────────────────────────────────────
function createSession(adminId, req) {
  const sid = randomId(32);
  const expires = Date.now() + config.admin.sessionTtlMs;
  db.prepare('INSERT INTO sessions (sid, admin_id, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sid,
    adminId,
    req.ip || '',
    String(req.headers['user-agent'] || '').slice(0, 300),
    expires
  );
  return { sid, expires };
}

function readSession(sid) {
  if (!sid) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    return null;
  }
  const admin = db.prepare('SELECT id, username, role FROM admins WHERE id = ?').get(row.admin_id);
  return admin ? { sid, admin } : null;
}

const destroySession = (sid) => db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function login(username, password, req) {
  const ip = req.ip || 'unknown';
  const wait = throttled(ip);
  if (wait) return { ok: false, error: `Juda ko'p urinish. ${wait} soniyadan keyin qayta urining.` };

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    noteFailure(ip);
    log.warn('failed login', { username, ip });
    return { ok: false, error: "Login yoki parol noto'g'ri" };
  }

  clearFailures(ip);
  db.prepare("UPDATE admins SET last_login_at = datetime('now') WHERE id = ?").run(admin.id);
  const session = createSession(admin.id, req);
  log.info('admin logged in', { username: admin.username, ip });
  return { ok: true, session, admin: { id: admin.id, username: admin.username, role: admin.role } };
}

function changePassword(adminId, current, next) {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!admin) return { ok: false, error: 'Admin topilmadi' };
  if (!verifyPassword(current, admin.password_hash)) return { ok: false, error: "Joriy parol noto'g'ri" };
  if (!next || String(next).length < 6) return { ok: false, error: "Yangi parol kamida 6 belgidan iborat bo'lsin" };
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(next), adminId);
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(adminId);
  return { ok: true };
}

/** Express middleware — attaches req.session or 401s. */
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const sess = readSession(cookies[COOKIE]);
  if (!sess) {
    // req.path is relative to the mount point, so test the full URL instead.
    if (String(req.originalUrl || req.url).startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  }
  req.session = sess;
  next();
}

/** CSRF: same-origin enforcement for state-changing requests. */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return next(); // curl / scripts on localhost
  try {
    const host = new URL(origin).host;
    const expected = req.headers.host;
    if (host !== expected) return res.status(403).json({ error: 'cross-origin request rejected' });
  } catch {
    return res.status(403).json({ error: 'bad origin' });
  }
  next();
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // localhost / behind a reverse proxy that terminates TLS
    maxAge: config.admin.sessionTtlMs,
    path: '/',
  };
}

/** Constant-time compare helper for future API-token auth. */
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

module.exports = {
  COOKIE,
  ensureAdmin,
  login,
  logout: destroySession,
  requireAuth,
  csrfGuard,
  cookieOptions,
  changePassword,
  readSession,
  parseCookies,
  safeEqual,
};
