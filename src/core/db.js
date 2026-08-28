'use strict';
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const { createLogger } = require('./logger');
const { DEFAULT_SETTINGS } = require('../config/constants');

const log = createLogger('db');

const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT DEFAULT 'owner',
  last_login_at TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  provider       TEXT NOT NULL,
  label          TEXT,
  key_enc        TEXT NOT NULL,
  key_hash       TEXT NOT NULL,
  key_mask       TEXT,
  status         TEXT DEFAULT 'active',
  failures       INTEGER DEFAULT 0,
  successes      INTEGER DEFAULT 0,
  tokens_used    INTEGER DEFAULT 0,
  cooldown_until INTEGER DEFAULT 0,
  last_error     TEXT,
  last_used_at   TEXT,
  created_at     TEXT DEFAULT (datetime('now')),
  UNIQUE (provider, key_hash)
);

CREATE TABLE IF NOT EXISTS telegram_account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  api_id        INTEGER,
  api_hash_enc  TEXT,
  phone         TEXT,
  session_enc   TEXT,
  status        TEXT DEFAULT 'disconnected',
  tg_user_id    TEXT,
  username      TEXT,
  first_name    TEXT,
  last_error    TEXT,
  connected_at  TEXT,
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chats (
  tg_chat_id   TEXT PRIMARY KEY,
  type         TEXT,
  title        TEXT,
  username     TEXT,
  is_support   INTEGER DEFAULT 0,
  is_muted     INTEGER DEFAULT 0,
  auto_reply   INTEGER DEFAULT 1,
  msg_count    INTEGER DEFAULT 0,
  last_seen_at TEXT,
  meta         TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_chat_id  TEXT NOT NULL,
  tg_msg_id   INTEGER,
  sender_id   TEXT,
  sender_name TEXT,
  is_outgoing INTEGER DEFAULT 0,
  is_agent    INTEGER DEFAULT 0,
  text        TEXT,
  media_type  TEXT,
  reply_to    INTEGER,
  date        INTEGER,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE (tg_chat_id, tg_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages (tg_chat_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_outgoing ON messages (is_outgoing, date DESC);

CREATE TABLE IF NOT EXISTS knowledge (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT,
  source_ref  TEXT,
  title       TEXT,
  content     TEXT NOT NULL,
  tags        TEXT,
  weight      REAL DEFAULT 1.0,
  enabled     INTEGER DEFAULT 1,
  hash        TEXT UNIQUE,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS qa_pairs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  source      TEXT,
  tg_chat_id  TEXT,
  score       REAL DEFAULT 1.0,
  approved    INTEGER DEFAULT 1,
  hash        TEXT UNIQUE,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  triggers       TEXT,
  instructions   TEXT NOT NULL,
  examples       TEXT,
  priority       INTEGER DEFAULT 100,
  enabled        INTEGER DEFAULT 1,
  auto_generated INTEGER DEFAULT 1,
  version        INTEGER DEFAULT 1,
  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  version    INTEGER DEFAULT 1,
  active     INTEGER DEFAULT 0,
  notes      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  tg_chat_id     TEXT PRIMARY KEY,
  state          TEXT DEFAULT 'auto',
  summary        TEXT,
  last_user_at   INTEGER,
  last_agent_at  INTEGER,
  replies_count  INTEGER DEFAULT 0,
  escalated      INTEGER DEFAULT 0,
  updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escalations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_chat_id  TEXT,
  chat_title  TEXT,
  question    TEXT,
  reason      TEXT,
  draft       TEXT,
  status      TEXT DEFAULT 'open',
  created_at  TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS training_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT,
  status      TEXT DEFAULT 'running',
  stats       TEXT,
  error       TEXT,
  started_at  TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS ai_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  provider    TEXT,
  model       TEXT,
  key_id      INTEGER,
  purpose     TEXT,
  ok          INTEGER,
  latency_ms  INTEGER,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  error       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls (created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT,
  level      TEXT,
  message    TEXT,
  meta       TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);
`;

db.exec(SCHEMA);

/**
 * Additive migrations. SQLite has no "ADD COLUMN IF NOT EXISTS", so each is
 * attempted and a duplicate-column error is treated as already-applied.
 */
const MIGRATIONS = [
  // Links an escalation to the notification sent to the founders, so a reply
  // to that message can be routed back to the user who asked.
  'ALTER TABLE escalations ADD COLUMN notify_chat_id TEXT',
  'ALTER TABLE escalations ADD COLUMN notify_msg_id INTEGER',
  'ALTER TABLE escalations ADD COLUMN answer TEXT',
  'ALTER TABLE escalations ADD COLUMN answered_by TEXT',

  // ── Assistant layer ──────────────────────────────────────────────────────
  // Facts the founder told the agent to keep. Scope is global by design: what
  // is said in a private chat must be known when the same thing comes up in a
  // group or in a customer's question.
  `CREATE TABLE IF NOT EXISTS memory_facts (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     fact        TEXT NOT NULL,
     tags        TEXT,
     source_chat TEXT,
     source_msg  INTEGER,
     created_by  TEXT,
     enabled     INTEGER DEFAULT 1,
     hash        TEXT UNIQUE,
     created_at  TEXT DEFAULT (datetime('now'))
   )`,

  // Work the agent has been asked to do, now or later. Runs from a ticker in
  // the background, survives restarts, and records what happened.
  `CREATE TABLE IF NOT EXISTS tasks (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     kind         TEXT NOT NULL,
     title        TEXT,
     payload      TEXT NOT NULL,
     run_at       INTEGER NOT NULL,
     status       TEXT DEFAULT 'pending',
     attempts     INTEGER DEFAULT 0,
     result       TEXT,
     error        TEXT,
     origin_chat  TEXT,
     origin_msg   INTEGER,
     created_by   TEXT,
     created_at   TEXT DEFAULT (datetime('now')),
     started_at   TEXT,
     finished_at  TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (status, run_at)',

  // Resolved people and chats, so "Ma'rufa" or "+998..." maps to an id without
  // re-scanning dialogs every time.
  `CREATE TABLE IF NOT EXISTS contacts (
     tg_id       TEXT PRIMARY KEY,
     kind        TEXT,
     username    TEXT,
     first_name  TEXT,
     last_name   TEXT,
     phone       TEXT,
     title       TEXT,
     aliases     TEXT,
     access_hash TEXT,
     updated_at  TEXT DEFAULT (datetime('now'))
   )`,
  'CREATE INDEX IF NOT EXISTS idx_contacts_username ON contacts (username)',
];
for (const sql of MIGRATIONS) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) log.warn('migration failed', { sql, error: err.message });
  }
}

// ── Full-text search (graceful degradation if FTS5 is unavailable) ──────────
let FTS_OK = true;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      title, content, tags, content='knowledge', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES ('delete', old.id, old.title, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES ('delete', old.id, old.title, old.content, old.tags);
      INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
    END;
  `);
} catch (err) {
  FTS_OK = false;
  log.warn('FTS5 unavailable - falling back to LIKE search', { error: err.message });
}

// ── Settings helpers ────────────────────────────────────────────────────────
const stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtSetSetting = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')'
);

const settings = {
  get(key, fallback = null) {
    const row = stmtGetSetting.get(key);
    if (row && row.value !== null && row.value !== undefined) return row.value;
    if (DEFAULT_SETTINGS[key] !== undefined) return DEFAULT_SETTINGS[key];
    return fallback;
  },
  int(key, fallback = 0) {
    const v = Number(settings.get(key, fallback));
    return Number.isFinite(v) ? v : fallback;
  },
  float(key, fallback = 0) {
    const v = parseFloat(settings.get(key, fallback));
    return Number.isFinite(v) ? v : fallback;
  },
  bool(key, fallback = false) {
    const v = settings.get(key, fallback ? '1' : '0');
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  },
  set(key, value) {
    stmtSetSetting.run(String(key), value === null || value === undefined ? '' : String(value));
    return true;
  },
  all() {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
    return out;
  },
};

// Seed defaults once
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (!stmtGetSetting.get(k)) stmtSetSetting.run(k, v);
}

// Ensure singleton telegram_account row
if (!db.prepare('SELECT id FROM telegram_account WHERE id = 1').get()) {
  db.prepare('INSERT INTO telegram_account (id, status) VALUES (1, ?)').run('disconnected');
}

// ── Event log ───────────────────────────────────────────────────────────────
function recordEvent(type, message, meta = null, level = 'info') {
  try {
    db.prepare('INSERT INTO events (type, level, message, meta) VALUES (?, ?, ?, ?)').run(
      type,
      level,
      String(message).slice(0, 2000),
      meta ? JSON.stringify(meta).slice(0, 4000) : null
    );
  } catch {
    /* telemetry must never throw */
  }
}

/** Prune old rows so the DB stays small on a long-running server. */
function vacuumOld() {
  try {
    db.exec("DELETE FROM events   WHERE created_at < datetime('now', '-30 days')");
    db.exec("DELETE FROM ai_calls WHERE created_at < datetime('now', '-14 days')");
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  } catch (err) {
    log.warn('vacuumOld failed', { error: err.message });
  }
}

/** Run a function inside a transaction. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

module.exports = { db, settings, recordEvent, vacuumOld, tx, FTS_OK };
