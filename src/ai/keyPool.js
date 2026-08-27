'use strict';
const { db, settings } = require('../core/db');
const { encrypt, decrypt, sha256, mask } = require('../core/crypto');
const { createLogger } = require('../core/logger');
const { PROVIDERS } = require('../config/constants');

const log = createLogger('ai:keys');

/**
 * Default cooldown (ms) per failure class, used when the provider gives no
 * explicit Retry-After hint. A per-minute rate limit must clear fast; a spent
 * daily quota should not be retried for a long while.
 */
const COOLDOWN = {
  rate_limit: 20_000,
  quota: 20 * 60_000,
  server: 20_000,
  network: 10_000,
  invalid: 0, // handled by marking dead
};

/** Hard ceiling so a bogus provider hint can never park a key for a day. */
const MAX_COOLDOWN_MS = 60 * 60_000;

function detectProvider(key) {
  const k = String(key || '').trim();
  for (const p of Object.values(PROVIDERS)) if (p.keyPrefix && k.startsWith(p.keyPrefix)) return p.id;
  return null;
}

/**
 * Import one or many keys. Accepts raw text blobs (one key per line, optional
 * "1: <key>" numbering) so the operator can paste straight from their notes.
 */
function importKeys(blob, providerHint = null, label = null) {
  const lines = String(blob || '')
    .split(/[\r\n,;\s]+/)
    .map((s) => s.trim().replace(/^\d+\s*[:.)-]\s*/, ''))
    .filter(Boolean);

  const result = { added: 0, skipped: 0, invalid: 0, providers: {} };
  const insert = db.prepare(
    `INSERT INTO api_keys (provider, label, key_enc, key_hash, key_mask, status)
     VALUES (?, ?, ?, ?, ?, 'active')
     ON CONFLICT(provider, key_hash) DO NOTHING`
  );

  for (const raw of lines) {
    const provider = detectProvider(raw) || providerHint;
    if (!provider || !PROVIDERS[provider]) {
      result.invalid++;
      continue;
    }
    const hash = sha256(raw);
    const before = db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE provider = ? AND key_hash = ?').get(provider, hash).c;
    if (before > 0) {
      result.skipped++;
      continue;
    }
    insert.run(provider, label, encrypt(raw), hash, mask(raw));
    result.added++;
    result.providers[provider] = (result.providers[provider] || 0) + 1;
  }

  if (result.added) log.info('API keys imported', result);
  return result;
}

function listKeys(provider = null) {
  const sql = provider
    ? 'SELECT * FROM api_keys WHERE provider = ? ORDER BY provider, id'
    : 'SELECT * FROM api_keys ORDER BY provider, id';
  const rows = provider ? db.prepare(sql).all(provider) : db.prepare(sql).all();
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    mask: r.key_mask,
    status: r.cooldown_until > now ? 'cooldown' : r.status,
    failures: r.failures,
    successes: r.successes,
    tokens_used: r.tokens_used,
    cooldown_left: Math.max(0, Math.round((r.cooldown_until - now) / 1000)),
    last_error: r.last_error,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
  }));
}

/**
 * Select the healthiest available key for a provider.
 * Strategy: only active + off-cooldown keys, ordered by least-recently-used
 * so load spreads evenly across the pool (important for free-tier RPM limits).
 */
function acquire(provider, exclude = []) {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT id, key_enc, failures, successes FROM api_keys
       WHERE provider = ? AND status = 'active' AND cooldown_until <= ?
       ORDER BY COALESCE(last_used_at, '1970-01-01') ASC, failures ASC, id ASC`
    )
    .all(provider, now);

  for (const r of rows) {
    if (exclude.includes(r.id)) continue;
    const key = decrypt(r.key_enc);
    if (!key) {
      db.prepare("UPDATE api_keys SET status = 'dead', last_error = ? WHERE id = ?").run('decrypt_failed', r.id);
      continue;
    }
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(r.id);
    return { id: r.id, key, provider };
  }
  return null;
}

function markSuccess(keyId, tokens = 0) {
  db.prepare(
    `UPDATE api_keys SET successes = successes + 1, failures = 0, tokens_used = tokens_used + ?,
     status = 'active', cooldown_until = 0, last_error = NULL WHERE id = ?`
  ).run(Math.max(0, Number(tokens) || 0), keyId);
}

/**
 * @param {number} keyId
 * @param {string} kind         failure class from the client
 * @param {string} message      provider error text (stored for the dashboard)
 * @param {number} retryAfterMs provider-supplied wait hint; wins over the default
 */
function markFailure(keyId, kind, message = '', retryAfterMs = 0) {
  const hinted = Number(retryAfterMs) > 0 ? Math.min(MAX_COOLDOWN_MS, Number(retryAfterMs) + 500) : 0;
  const cd = hinted || COOLDOWN[kind] || 30_000;
  if (kind === 'invalid') {
    db.prepare("UPDATE api_keys SET status = 'dead', failures = failures + 1, last_error = ? WHERE id = ?")
      .run(String(message).slice(0, 400), keyId);
    log.warn('API key marked dead', { keyId, message: String(message).slice(0, 160) });
    return;
  }
  // Rate limits and quotas are transient and often shared across a whole
  // organisation — they must never retire a key permanently. Only repeated
  // hard failures (server/network/unknown) do.
  const canRetire = !['rate_limit', 'quota'].includes(kind);
  db.prepare(
    `UPDATE api_keys SET failures = failures + 1, cooldown_until = ?, last_error = ?,
     status = CASE WHEN ? = 1 AND failures + 1 >= 12 THEN 'dead' ELSE status END WHERE id = ?`
  ).run(Date.now() + cd, `${kind}: ${String(message).slice(0, 300)}`, canRetire ? 1 : 0, keyId);
}

function reviveAll() {
  const r = db.prepare("UPDATE api_keys SET status = 'active', cooldown_until = 0, failures = 0, last_error = NULL WHERE status != 'disabled'").run();
  return r.changes;
}

function setStatus(id, status) {
  db.prepare('UPDATE api_keys SET status = ?, cooldown_until = 0 WHERE id = ?').run(status, id);
}

function removeKey(id) {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

function getRawKey(id) {
  const r = db.prepare('SELECT key_enc, provider FROM api_keys WHERE id = ?').get(id);
  return r ? { key: decrypt(r.key_enc), provider: r.provider } : null;
}

/** Health snapshot used by the dashboard and the /health endpoint. */
function health() {
  const now = Date.now();
  const out = {};
  for (const p of Object.keys(PROVIDERS)) {
    const rows = db.prepare('SELECT status, cooldown_until FROM api_keys WHERE provider = ?').all(p);
    out[p] = {
      total: rows.length,
      available: rows.filter((r) => r.status === 'active' && r.cooldown_until <= now).length,
      cooldown: rows.filter((r) => r.status === 'active' && r.cooldown_until > now).length,
      dead: rows.filter((r) => r.status === 'dead').length,
      disabled: rows.filter((r) => r.status === 'disabled').length,
    };
  }
  out.primary = settings.get('primary_provider', 'groq');
  return out;
}

module.exports = {
  importKeys,
  listKeys,
  acquire,
  markSuccess,
  markFailure,
  reviveAll,
  setStatus,
  removeKey,
  getRawKey,
  health,
  detectProvider,
};
