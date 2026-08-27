'use strict';
const { db, FTS_OK } = require('../core/db');
const { sha256 } = require('../core/crypto');
const { createLogger } = require('../core/logger');

const log = createLogger('knowledge');

/**
 * Uzbek text normalisation. Latin Uzbek uses several apostrophe variants
 * (o', o‘, o`, oʻ) that users type inconsistently; folding them prevents
 * search misses. Cyrillic is transliterated coarsely so a Cyrillic question
 * can still hit Latin knowledge.
 */
const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'i', ь: '',
  э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’ʻʼ`´']/g, '')
    .replace(/[а-яёўқғҳ]/g, (c) => (CYR[c] !== undefined ? CYR[c] : c))
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Very common Uzbek/Russian/English words that add noise to retrieval. */
const STOP = new Set(
  ('va ham lekin ammo uchun bilan bu shu u men sen siz biz ular nima qanday qaysi qachon qayerda '
    + 'bor yoq yoq emas edi ekan bolsa bolib kerak mumkin iltimos salom rahmat xayr ok yaxshi '
    + 'the a an is are was were to of in on for and or but i you he she it we they my your '
    + 'что как где когда это и в на не да нет спасибо привет').split(/\s+/)
);

function tokens(text, { keepStop = false } = {}) {
  return normalize(text)
    .split(' ')
    .filter((t) => t.length >= 2 && (keepStop || !STOP.has(t)));
}

/**
 * Cross-language query expansion.
 *
 * The knowledge base is written in Uzbek, but users write in Russian and
 * English too. Transliteration alone does not bridge that — "подписка"
 * normalises to "podpiska", which matches nothing. Mapping the support
 * vocabulary onto its Uzbek equivalents makes one index serve all three
 * languages without embeddings.
 *
 * Keys are already-normalised (transliterated, apostrophe-free) forms.
 */
const SYNONYMS = {
  // narx / to'lov
  cena: 'narx', stoit: 'narx', stoimost: 'narx', podpiska: 'obuna narx', platno: 'narx pullik',
  besplatno: 'bepul', price: 'narx', cost: 'narx', subscription: 'obuna narx', paid: 'pullik', free: 'bepul',
  premium: 'premium narx', tarif: 'narx',
  // reliz / vaqt
  kogda: 'qachon', zapusk: 'ishga tushish', reliz: 'ishga tushish', when: 'qachon',
  launch: 'ishga tushish', release: 'ishga tushish reliz', start: 'ishga tushish',
  // ilova
  prilojenie: 'ilova mobil', app: 'ilova mobil', mobile: 'mobil ilova', android: 'ilova mobil', ios: 'ilova mobil',
  // sayt / havola
  sayt: 'sayt', site: 'sayt', website: 'sayt', ssilka: 'havola sayt', link: 'havola sayt', kanal: 'kanal',
  channel: 'kanal', bot: 'bot',
  // jamoa
  komanda: 'jamoa', vstupit: 'jamoa qoshilish', rabota: 'ish jamoa', vakansiya: 'ish jamoa',
  team: 'jamoa', join: 'jamoa qoshilish', work: 'ish jamoa', vacancy: 'ish jamoa',
  ozvuchka: 'ovoz aktyor', akter: 'ovoz aktyor', aktyor: 'ovoz aktyor', voice: 'ovoz aktyor',
  actor: 'ovoz aktyor', dubbing: 'ovoz dublyaj', perevod: 'tarjima', translator: 'tarjima', translation: 'tarjima',
  // nosozlik
  oshibka: 'xato muammo', error: 'xato muammo', bug: 'xato muammo', problema: 'muammo',
  rabotaet: 'ishlamayapti', otkrivaetsya: 'ochilmayapti', broken: 'xato ishlamayapti', crash: 'xato',
  // kontent
  anime: 'anime', manga: 'manga', serial: 'anime', episode: 'qism anime', seriya: 'qism anime',
  // umumiy
  chto: 'nima', takoe: 'nima', what: 'nima', how: 'qanday', kak: 'qanday',
  akkaunt: 'profil hisob', account: 'profil hisob', profil: 'profil', profile: 'profil',
  registraciya: 'royxat kirish', register: 'royxat kirish', login: 'kirish', voyti: 'kirish',
};

/** Returns the query's own tokens plus any Uzbek equivalents. */
function expandTokens(text) {
  const base = tokens(text);
  const out = new Set(base);
  for (const t of base) {
    const mapped = SYNONYMS[t];
    if (mapped) for (const w of mapped.split(' ')) out.add(w);
  }
  return [...out];
}

function upsert({ source = 'manual', sourceRef = null, title = null, content, tags = null, weight = 1.0 }) {
  const body = String(content || '').trim();
  if (body.length < 8) return null;
  const hash = sha256(normalize(body).slice(0, 600));
  const existing = db.prepare('SELECT id FROM knowledge WHERE hash = ?').get(hash);
  if (existing) {
    db.prepare("UPDATE knowledge SET updated_at = datetime('now'), weight = MAX(weight, ?) WHERE id = ?").run(weight, existing.id);
    return existing.id;
  }
  // Near-duplicate guard. Each distillation pass rephrases the same fact
  // slightly, so an exact-hash check lets copies through — and six paraphrases
  // of "the basics are free" crowd out everything else in the retrieval
  // context. Fold anything that says the same thing into the existing entry.
  const twin = findNearDuplicate(body);
  if (twin) {
    db.prepare("UPDATE knowledge SET updated_at = datetime('now'), weight = MAX(weight, ?) WHERE id = ?").run(weight, twin.id);
    return twin.id;
  }

  const r = db
    .prepare('INSERT INTO knowledge (source, source_ref, title, content, tags, weight, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(source, sourceRef, title, body, tags, weight, hash);
  return Number(r.lastInsertRowid);
}

/** Jaccard similarity over content words. */
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const NEAR_DUPLICATE_THRESHOLD = 0.72;

function findNearDuplicate(body) {
  const sig = new Set(tokens(body));
  if (sig.size < 4) return null;

  const rows = db.prepare('SELECT id, content FROM knowledge ORDER BY updated_at DESC LIMIT 400').all();
  for (const r of rows) {
    const other = new Set(tokens(r.content));
    // Length mismatch this large cannot be a paraphrase — skip the set work.
    if (Math.max(sig.size, other.size) > Math.min(sig.size, other.size) * 2.5) continue;
    if (similarity(sig, other) >= NEAR_DUPLICATE_THRESHOLD) return r;
  }
  return null;
}

function addQA({ question, answer, source = 'chat', chatId = null, score = 1.0 }) {
  const q = String(question || '').trim();
  const a = String(answer || '').trim();
  if (q.length < 4 || a.length < 4) return null;
  const hash = sha256(normalize(q).slice(0, 300) + '|' + normalize(a).slice(0, 300));
  try {
    const r = db
      .prepare('INSERT INTO qa_pairs (question, answer, source, tg_chat_id, score, hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(q, a, source, chatId, score, hash);
    // Q&A pairs also become searchable knowledge documents.
    upsert({
      source: 'qa',
      sourceRef: String(r.lastInsertRowid),
      title: q.slice(0, 120),
      content: `Savol: ${q}\nJavob: ${a}`,
      tags: 'faq',
      weight: 1.3,
    });
    return Number(r.lastInsertRowid);
  } catch {
    return null; // duplicate
  }
}

/** Build a safe FTS5 MATCH expression from a natural-language query. */
function ftsQuery(text) {
  const ts = expandTokens(text).slice(0, 16);
  if (!ts.length) return null;
  return ts.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
}

/**
 * Hybrid retrieval: FTS5/BM25 for ranking plus a normalized-substring pass so
 * short or misspelled Uzbek queries still find documents.
 */
function search(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  const results = new Map();

  if (FTS_OK) {
    const match = ftsQuery(q);
    if (match) {
      try {
        const rows = db
          .prepare(
            `SELECT k.id, k.title, k.content, k.source, k.source_ref, k.tags, k.weight,
                    bm25(knowledge_fts) AS rank
             FROM knowledge_fts f JOIN knowledge k ON k.id = f.rowid
             WHERE knowledge_fts MATCH ? AND k.enabled = 1
             ORDER BY rank LIMIT ?`
          )
          .all(match, limit * 3);
        for (const r of rows) {
          // bm25 returns lower-is-better; convert to a positive score.
          results.set(r.id, { ...r, score: (10 - Math.min(10, Math.abs(r.rank))) * (r.weight || 1) });
        }
      } catch (err) {
        log.debug('fts search failed', { error: err.message });
      }
    }
  }

  if (results.size < limit) {
    const ts = expandTokens(q).slice(0, 8);
    if (ts.length) {
      const rows = db.prepare('SELECT id, title, content, source, source_ref, tags, weight FROM knowledge WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 500').all();
      for (const r of rows) {
        if (results.has(r.id)) continue;
        const hay = normalize(`${r.title || ''} ${r.content}`);
        let hits = 0;
        for (const t of ts) if (hay.includes(t)) hits++;
        if (hits) results.set(r.id, { ...r, score: hits * 1.5 * (r.weight || 1) });
      }
    }
  }

  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Format retrieved docs as a compact context block for the prompt. */
function buildContext(query, limit = 6, maxChars = 3200) {
  const docs = search(query, limit);
  if (!docs.length) return { text: '', docs: [] };
  const parts = [];
  let used = 0;
  for (const d of docs) {
    const chunk = `— ${d.title ? d.title + ': ' : ''}${String(d.content).replace(/\s+/g, ' ').slice(0, 700)}`;
    if (used + chunk.length > maxChars) break;
    parts.push(chunk);
    used += chunk.length;
  }
  return { text: parts.join('\n'), docs };
}

function stats() {
  const k = db.prepare('SELECT COUNT(*) AS c FROM knowledge WHERE enabled = 1').get().c;
  const qa = db.prepare('SELECT COUNT(*) AS c FROM qa_pairs').get().c;
  const bySource = db.prepare('SELECT source, COUNT(*) AS c FROM knowledge GROUP BY source ORDER BY c DESC').all();
  return { documents: k, qaPairs: qa, bySource };
}

function list({ q = '', source = '', limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (source) {
    where.push('source = ?');
    params.push(source);
  }
  if (q) {
    where.push('(title LIKE ? OR content LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const sql = `SELECT id, source, source_ref, title, substr(content, 1, 300) AS preview, tags, weight, enabled, updated_at
               FROM knowledge ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, limit, offset);
}

const remove = (id) => db.prepare('DELETE FROM knowledge WHERE id = ?').run(id).changes;
const setEnabled = (id, on) => db.prepare('UPDATE knowledge SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id).changes;

module.exports = { normalize, tokens, upsert, addQA, search, buildContext, stats, list, remove, setEnabled };
