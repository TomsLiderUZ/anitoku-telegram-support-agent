'use strict';
const { db } = require('../core/db');
const { sha256 } = require('../core/crypto');
const { createLogger } = require('../core/logger');
const { normalize, tokens } = require('../knowledge/store');

const log = createLogger('memory:facts');

/**
 * Global founder memory.
 *
 * Distinct from per-chat summaries: a fact the founder states once — in any
 * chat — must be available everywhere afterwards, including inside customer
 * support answers. Storage is deterministic: when the founder says "eslab qol"
 * the runtime calls `remember()` directly rather than hoping the model picks a
 * tool, because hoping is exactly what failed.
 */

function remember({ fact, tags = null, sourceChat = null, sourceMsg = null, createdBy = 'founder' }) {
  const body = String(fact || '').trim().replace(/\s+/g, ' ');
  if (body.length < 4) return { ok: false, error: 'fakt juda qisqa' };

  const hash = sha256(normalize(body).slice(0, 400));
  const existing = db.prepare('SELECT id FROM memory_facts WHERE hash = ?').get(hash);
  if (existing) {
    db.prepare('UPDATE memory_facts SET enabled = 1 WHERE id = ?').run(existing.id);
    return { ok: true, id: existing.id, duplicate: true };
  }

  const r = db
    .prepare('INSERT INTO memory_facts (fact, tags, source_chat, source_msg, created_by, hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(body, tags, sourceChat, sourceMsg, createdBy, hash);
  log.info('fakt saqlandi', { id: Number(r.lastInsertRowid), fact: body.slice(0, 80) });
  return { ok: true, id: Number(r.lastInsertRowid) };
}

/** Disable facts matching a phrase. Returns how many were affected. */
function forget(query) {
  const q = normalize(query);
  if (!q) return 0;
  const rows = db.prepare('SELECT id, fact FROM memory_facts WHERE enabled = 1').all();
  let n = 0;
  for (const r of rows) {
    if (normalize(r.fact).includes(q)) {
      db.prepare('UPDATE memory_facts SET enabled = 0 WHERE id = ?').run(r.id);
      n++;
    }
  }
  if (n) log.info('faktlar unutildi', { query, count: n });
  return n;
}

function list({ limit = 200, includeDisabled = false } = {}) {
  return db
    .prepare(`SELECT * FROM memory_facts ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

const remove = (id) => db.prepare('DELETE FROM memory_facts WHERE id = ?').run(Number(id)).changes;

/**
 * Facts relevant to a query, ranked by token overlap, plus the most recent
 * ones regardless — recency matters for "what did I tell you yesterday".
 */
function relevant(query, limit = 8) {
  const all = list({ limit: 500 });
  if (!all.length) return [];
  const qt = new Set(tokens(query || ''));

  const scored = all.map((f) => {
    const ft = new Set(tokens(f.fact));
    let hits = 0;
    for (const t of qt) if (ft.has(t)) hits++;
    return { ...f, score: hits };
  });

  const byScore = scored.filter((f) => f.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  const recent = all.slice(0, 4);
  const seen = new Set(byScore.map((f) => f.id));
  for (const r of recent) if (!seen.has(r.id) && byScore.length < limit + 4) byScore.push(r);
  return byScore;
}

/** Prompt block. Empty string when there is nothing to say. */
function contextBlock(query, limit = 8) {
  const facts = relevant(query, limit);
  if (!facts.length) return '';
  return facts.map((f) => `• ${f.fact}`).join('\n');
}

/**
 * Detect an explicit "remember this" instruction and pull out the fact.
 * Returns null when the message is not such an instruction.
 */
// (?=\s|$|[:,]) instead of \b: JS word boundaries do not fire next to Cyrillic,
// so "запомни" would never match with \b.
const REMEMBER_RE =
  /(?:^|\s)(?:bilim\s*bazangda\s+)?(?:eslab\s*qol|eslab\s*ol|yodda\s*tut|yodingda\s*tut|saqlab\s*qo['‘’ʻ]?y|запомни|remember(?:\s+this)?)(?=\s|$|[:,.-])[\s:,-]*/i;

function extractRememberInstruction(text) {
  const t = String(text || '').trim();
  const m = REMEMBER_RE.exec(t);
  if (!m) return null;

  // The fact is whatever surrounds the trigger phrase.
  const before = t.slice(0, m.index).trim();
  const after = t.slice(m.index + m[0].length).trim();
  const fact = [before, after].filter((s) => s.length > 3).join(' — ').replace(/^[\s:,-]+|[\s:,.]+$/g, '');
  return fact.length > 3 ? fact : null;
}

const FORGET_RE = /(?:^|\s)(?:unut|esdan\s*chiqar|o['‘’ʻ]?chir(?:ib\s*tashla)?|забудь|forget)(?=\s|$|[:,])[\s:,-]*(.+)$/i;

function extractForgetInstruction(text) {
  const m = FORGET_RE.exec(String(text || '').trim());
  return m && m[1] && m[1].trim().length > 2 ? m[1].trim() : null;
}

module.exports = { remember, forget, list, remove, relevant, contextBlock, extractRememberInstruction, extractForgetInstruction };
