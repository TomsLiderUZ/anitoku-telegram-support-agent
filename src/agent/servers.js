'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const config = require('../config');
const { db } = require('../core/db');
const { encrypt, decrypt } = require('../core/crypto');
const { createLogger } = require('../core/logger');

const log = createLogger('servers');

/**
 * Remote servers the assistant may run commands on over SSH.
 *
 * Uses the system `ssh` binary (OpenSSH ships with Windows 10+ and every
 * Linux). Key auth only: the agent keeps its own key pair under data/ssh and
 * the panel shows the public key to paste into the server's authorized_keys.
 * A password can be stored for reference but is never typed into a prompt —
 * there is no portable way to do that without extra binaries.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    name        TEXT PRIMARY KEY,
    host        TEXT NOT NULL,
    port        INTEGER DEFAULT 22,
    user        TEXT NOT NULL,
    key_path    TEXT,
    note        TEXT,
    secret_enc  TEXT,
    last_ok     TEXT,
    last_error  TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`);

const SSH_DIR = path.join(config.dataDir, 'ssh');
const KEY = path.join(SSH_DIR, 'id_ed25519');

/** Generate the agent's key pair once. Returns the public key text. */
function ensureKey() {
  fs.mkdirSync(SSH_DIR, { recursive: true });
  if (!fs.existsSync(KEY)) {
    try {
      execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'anitoku-agent', '-f', KEY], { stdio: 'ignore', timeout: 20_000 });
      log.info('SSH kalit juftligi yaratildi', { file: KEY });
    } catch (err) {
      throw new Error('ssh-keygen ishlamadi: ' + err.message);
    }
  }
  return fs.readFileSync(KEY + '.pub', 'utf8').trim();
}

function publicKey() {
  try {
    return ensureKey();
  } catch {
    return null;
  }
}

function add({ name, host, port = 22, user = 'root', keyPath = null, note = null, secret = null }) {
  if (!name || !host || !user) throw new Error('name, host, user kerak');
  db.prepare(
    `INSERT INTO servers (name, host, port, user, key_path, note, secret_enc) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET host = excluded.host, port = excluded.port, user = excluded.user,
       key_path = COALESCE(excluded.key_path, servers.key_path), note = COALESCE(excluded.note, servers.note),
       secret_enc = COALESCE(excluded.secret_enc, servers.secret_enc)`
  ).run(String(name).trim(), String(host).trim(), Number(port) || 22, String(user).trim(), keyPath, note, secret ? encrypt(secret) : null);
  return get(name);
}

function get(name) {
  const r = db.prepare('SELECT * FROM servers WHERE name = ?').get(String(name).trim());
  if (!r) return null;
  return { ...r, hasSecret: !!r.secret_enc, secret_enc: undefined };
}

function secretOf(name) {
  const r = db.prepare('SELECT secret_enc FROM servers WHERE name = ?').get(String(name).trim());
  return r && r.secret_enc ? decrypt(r.secret_enc) : null;
}

const list = () => db.prepare('SELECT name, host, port, user, key_path, note, last_ok, last_error, created_at FROM servers ORDER BY name').all();
const remove = (name) => db.prepare('DELETE FROM servers WHERE name = ?').run(String(name)).changes > 0;

/** Find by name, host, or "user@host". */
function find(ref) {
  const s = String(ref || '').trim();
  return get(s) || db.prepare('SELECT * FROM servers WHERE host = ? OR (user || \'@\' || host) = ? LIMIT 1').get(s, s) || null;
}

/**
 * Run one shell command remotely. Output is captured (both streams) and
 * truncated so a runaway `cat` cannot flood the model context.
 */
function run(ref, command, { timeoutMs = 120_000, maxChars = 12_000 } = {}) {
  const srv = find(ref);
  if (!srv) throw new Error(`Server topilmadi: ${ref}. Avval panelda yoki add_server bilan qoʻshing`);
  const key = srv.key_path || (fs.existsSync(KEY) ? KEY : ensureKey() && KEY);
  const args = [
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
    '-p', String(srv.port || 22), '-i', key, `${srv.user}@${srv.host}`, String(command),
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('ssh', args, { windowsHide: true });
    let out = '';
    const take = (d) => {
      if (out.length < maxChars) out += d.toString();
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      db.prepare(ok ? "UPDATE servers SET last_ok = datetime('now'), last_error = NULL WHERE name = ?" : 'UPDATE servers SET last_error = ? WHERE name = ?').run(
        ...(ok ? [srv.name] : [out.slice(-300), srv.name])
      );
      if (/Permission denied|publickey/i.test(out) && !ok) {
        out += `\n\n[agent] Kalit qabul qilinmadi. Serverga shu ochiq kalitni qoʻshing (~/.ssh/authorized_keys):\n${publicKey() || '(kalit yoʻq)'}`;
      }
      resolve({ ok, code, output: out.slice(0, maxChars) + (out.length > maxChars ? '\n…[qisqartirildi]' : ''), ms: Date.now() - started, server: srv.name });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: 'ssh ishga tushmadi: ' + err.message, server: srv.name });
    });
  });
}

/** Copy a local file to the server (scp). */
function upload(ref, localPath, remotePath, { timeoutMs = 300_000 } = {}) {
  const srv = find(ref);
  if (!srv) throw new Error(`Server topilmadi: ${ref}`);
  const key = srv.key_path || KEY;
  return new Promise((resolve) => {
    const child = spawn('scp', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-P', String(srv.port || 22), '-i', key, '-r', localPath, `${srv.user}@${srv.host}:${remotePath}`], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, output: out.slice(0, 4000) });
    });
    child.on('error', (err) => resolve({ ok: false, output: err.message }));
  });
}

module.exports = { add, get, find, list, remove, run, upload, publicKey, ensureKey, secretOf, KEY };
