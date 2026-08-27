'use strict';
const crypto = require('node:crypto');
const config = require('../config');

const KEY = crypto.scryptSync(config.secret, 'anitoku-agent-v1', 32);

/** AES-256-GCM encrypt → "v1.<iv>.<tag>.<ciphertext>" (all base64url). */
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(parts[1], 'base64url'));
    d.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** scrypt password hashing — "scrypt.<salt>.<hash>" */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt.${salt.toString('base64url')}.${hash.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [alg, saltB, hashB] = String(stored).split('.');
  if (alg !== 'scrypt' || !saltB || !hashB) return false;
  try {
    const expected = Buffer.from(hashB, 'base64url');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB, 'base64url'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const randomId = (n = 24) => crypto.randomBytes(n).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** Mask a secret for display: gsk_abcd…wxyz */
const mask = (s) => {
  const v = String(s || '');
  if (v.length <= 12) return '••••';
  return `${v.slice(0, 8)}…${v.slice(-4)}`;
};

module.exports = { encrypt, decrypt, hashPassword, verifyPassword, randomId, sha256, mask };
