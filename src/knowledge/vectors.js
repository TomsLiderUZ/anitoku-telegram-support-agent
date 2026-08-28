'use strict';
const { db } = require('../core/db');
const { createLogger } = require('../core/logger');

const log = createLogger('vectors');

/**
 * Semantic index over the knowledge base.
 *
 * Embeddings come from a local multilingual model (bge-m3 via node-llama-cpp),
 * so "подписка", "obuna" and "subscription" land near each other without any
 * synonym table. At a few hundred documents a brute-force cosine scan over
 * Float32 blobs in SQLite is faster than any vector database round trip, and
 * needs no extra process.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_vectors (
    knowledge_id INTEGER PRIMARY KEY,
    model        TEXT NOT NULL,
    dim          INTEGER NOT NULL,
    vec          BLOB NOT NULL,
    updated_at   TEXT DEFAULT (datetime('now'))
  )
`);

let embedFn = null; // (text) => Promise<Float32Array>
let modelName = null;

/** Wire the embedding provider once the local model is loaded. */
function setEmbedder(fn, name) {
  embedFn = fn;
  modelName = name;
  log.info('embedding modeli ulandi', { model: name });
}

const ready = () => typeof embedFn === 'function';

function toBlob(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function fromBlob(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function index(knowledgeId, text) {
  if (!ready()) return false;
  const vec = await embedFn(String(text).slice(0, 2000));
  db.prepare(
    `INSERT INTO knowledge_vectors (knowledge_id, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(knowledge_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec, updated_at = datetime('now')`
  ).run(knowledgeId, modelName, vec.length, toBlob(vec));
  return true;
}

/** Embed every document that has no vector yet (or was embedded by another model). */
async function backfill({ batch = 50, onProgress = null } = {}) {
  if (!ready()) return { skipped: 'no embedder' };
  const rows = db
    .prepare(
      `SELECT k.id, k.title, k.content FROM knowledge k
       LEFT JOIN knowledge_vectors v ON v.knowledge_id = k.id
       WHERE k.enabled = 1 AND (v.knowledge_id IS NULL OR v.model != ?)
       LIMIT ?`
    )
    .all(modelName, batch);
  let n = 0;
  for (const r of rows) {
    await index(r.id, `${r.title ? r.title + '. ' : ''}${r.content}`);
    n++;
    if (onProgress && n % 10 === 0) onProgress(n, rows.length);
  }
  if (n) log.info('vektorlar yangilandi', { embedded: n, remaining: pending() });
  return { embedded: n, remaining: pending() };
}

function pending() {
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM knowledge k LEFT JOIN knowledge_vectors v ON v.knowledge_id = k.id
       WHERE k.enabled = 1 AND (v.knowledge_id IS NULL OR v.model != ?)`
    )
    .get(modelName || '').c;
}

/** Nearest documents to a query. Returns [{id, score}] sorted by similarity. */
async function search(query, limit = 6, minScore = 0.35) {
  if (!ready()) return [];
  const q = await embedFn(String(query).slice(0, 1000));
  const rows = db.prepare('SELECT knowledge_id, vec FROM knowledge_vectors WHERE model = ?').all(modelName);
  const scored = [];
  for (const r of rows) {
    const s = cosine(q, fromBlob(r.vec));
    if (s >= minScore) scored.push({ id: r.knowledge_id, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function stats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM knowledge WHERE enabled = 1').get().c;
  const vec = db.prepare('SELECT COUNT(*) AS c, MAX(dim) AS dim FROM knowledge_vectors WHERE model = ?').get(modelName || '');
  return { ready: ready(), model: modelName, documents: total, embedded: vec.c || 0, dim: vec.dim || 0 };
}

const remove = (knowledgeId) => db.prepare('DELETE FROM knowledge_vectors WHERE knowledge_id = ?').run(knowledgeId);

module.exports = { setEmbedder, ready, index, backfill, search, stats, remove, pending };
