'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const config = require('../config');
const { db, recordEvent } = require('../core/db');
const { encrypt, decrypt } = require('../core/crypto');
const { createLogger } = require('../core/logger');

const log = createLogger('shell');

/**
 * The agent's terminal.
 *
 * Most of what the founder asks for has no dedicated tool — and never will.
 * A real shell closes that gap: anything a person could do at a prompt, the
 * agent can do here. Two kinds of target:
 *
 *   local   — this machine, inside a sandbox directory
 *   remote  — an SSH host, reached with a password or a key. The founder
 *             pastes "IP + password" into a chat and it works; no panel, no
 *             key exchange ritual. The key is installed on first use so later
 *             commands are fast and password-free.
 *
 * Sessions are persistent: `cd` and exported variables survive between calls,
 * because a shell that forgets where it is cannot follow a multi-step job.
 */

// The emulation area: throwaway code, test runs, scratch files. Separate
// from data/projects, which holds only real deliverables.
const SANDBOX_ROOT = path.join(config.dataDir, 'sandbox');
fs.mkdirSync(SANDBOX_ROOT, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS hosts (
    name        TEXT PRIMARY KEY,
    host        TEXT NOT NULL,
    port        INTEGER DEFAULT 22,
    user        TEXT NOT NULL DEFAULT 'root',
    password_enc TEXT,
    key_path    TEXT,
    note        TEXT,
    key_installed INTEGER DEFAULT 0,
    last_ok     TEXT,
    last_error  TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )
`);

const MAX_OUTPUT = 30_000;
const clip = (s, max = MAX_OUTPUT) => (s.length > max ? s.slice(0, max) + `\n…[${s.length - max} belgi qisqartirildi]` : s);

/**
 * Git bash reports `$PWD` as `/c/Users/...`, but Node's `spawn` treats that as
 * a path relative to the drive root and quietly creates `C:\c\Users\...`.
 * That is how a tree of empty `C:\c\c\c\…` folders appeared on the founder's
 * disk. Every directory that comes back from a shell goes through here.
 */
function toNativePath(p) {
  if (!p || process.platform !== 'win32') return p;
  const s = String(p).trim();
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  if (/^\/[a-zA-Z]$/.test(s)) return `${s[1].toUpperCase()}:\\`;
  return s.replace(/\//g, '\\');
}

/**
 * The reverse of `toNativePath`: a Windows path written for a POSIX shell.
 *
 * `C:\ItzToms\All Codes\x` quoted into a bash command loses its backslashes to
 * escape processing and becomes `C:ItzTomsAll Codesx` — which is how an
 * archive ended up somewhere nobody looked and an upload silently shipped
 * nothing. Commands that name a local path must pass it through here.
 */
function toPosixPath(p) {
  if (!p) return p;
  const s = String(p);
  if (process.platform !== 'win32') return s;
  const m = s.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (m) return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  return s.replace(/\\/g, '/');
}

/** Quote a local path for use inside a shell command. */
const shq = (p) => `'${toPosixPath(p).replace(/'/g, `'\\''`)}'`;

// ── hosts ────────────────────────────────────────────────────────────────────

function saveHost({ name, host, port = 22, user = 'root', password = null, keyPath = null, note = null }) {
  const n = String(name || host).trim();
  db.prepare(
    `INSERT INTO hosts (name, host, port, user, password_enc, key_path, note) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET host=excluded.host, port=excluded.port, user=excluded.user,
       password_enc=COALESCE(excluded.password_enc, hosts.password_enc),
       key_path=COALESCE(excluded.key_path, hosts.key_path),
       note=COALESCE(excluded.note, hosts.note)`
  ).run(n, String(host).trim(), Number(port) || 22, String(user).trim(), password ? encrypt(String(password)) : null, keyPath, note);
  return getHost(n);
}

function getHost(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  const row =
    db.prepare('SELECT * FROM hosts WHERE name = ?').get(s) ||
    db.prepare("SELECT * FROM hosts WHERE host = ? OR (user || '@' || host) = ? LIMIT 1").get(s, s);
  if (!row) return null;
  return { ...row, password: row.password_enc ? decrypt(row.password_enc) : null, password_enc: undefined, hasPassword: !!row.password_enc };
}

const listHosts = () =>
  db.prepare('SELECT name, host, port, user, note, key_installed, last_ok, last_error FROM hosts ORDER BY name').all();
const removeHost = (name) => db.prepare('DELETE FROM hosts WHERE name = ?').run(String(name)).changes > 0;

/**
 * Pull "root@1.2.3.4:22 password" — in any order, from a sentence — out of
 * free text, so the founder can just paste an IP and a password into a chat.
 */
const COMMON_USERS = /^(root|ubuntu|admin|debian|ec2-user|centos|user|deploy)$/i;

function parseHostSpec(text) {
  const t = String(text || '');
  const host =
    (t.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/) || [])[1] ||
    (t.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i) || [])[1];
  if (!host) return null;

  // `user@` only counts when the host follows it — a password containing "@"
  // once turned "AndroGenda909_@OX" into the username.
  const at = t.match(new RegExp(`([a-z_][\\w.-]*)@${host.replace(/\./g, '\\.')}`, 'i'));
  const tokens = t.split(/[\s,;"'\n]+/).filter(Boolean);
  const bareUser = tokens.find((x) => COMMON_USERS.test(x));
  const user = at ? at[1] : bareUser || 'root';
  const port = (t.match(new RegExp(`${host.replace(/\./g, '\\.')}:(\\d{2,5})`)) || t.match(/\bport\s*[:=]?\s*(\d{2,5})\b/i) || [])[1];

  // Password: a token that is neither the host nor the username, long enough,
  // and not a plain dictionary-ish word from the sentence around it.
  const pw = tokens
    .map((x) => x.replace(/^(parol|password|pass|pw)\s*[:=]?/i, ''))
    .find(
      (x) =>
        x &&
        x !== host &&
        x !== user &&
        !x.includes(host) &&
        x.length >= 8 &&
        /\d/.test(x) &&
        /[A-Za-z]/.test(x) &&
        !/^\d+$/.test(x) &&
        !/^(https?|ssh):/i.test(x)
    );

  return { host, user, port: port ? Number(port) : 22, password: pw || null };
}

// ── local sandbox ────────────────────────────────────────────────────────────

/**
 * A scratch directory for one line of work. Free experimentation happens
 * here, not in a project: temp files, half-finished scripts, test output.
 * Old ones are swept so the disk does not fill with abandoned attempts.
 */
function sandbox(name = null) {
  const slug = (name ? String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) : '') || 'run';
  const dir = path.join(SANDBOX_ROOT, `${slug}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sweepSandboxes(maxAgeHours = 72) {
  const cutoff = Date.now() - maxAgeHours * 3600_000;
  let removed = 0;
  for (const entry of fs.readdirSync(SANDBOX_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = path.join(SANDBOX_ROOT, entry.name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  if (removed) log.info('eski ish papkalari tozalandi', { removed });
  return removed;
}

// ── sessions ─────────────────────────────────────────────────────────────────
//
// A session is a named working context: where commands run and what they
// remember. `cd` inside a command persists because we re-derive the cwd after
// every run; env exports persist because we replay them.

const sessions = new Map(); // id -> { id, target, cwd, env, host, history }

function session(id = 'default', { target = null, host = null, cwd = null } = {}) {
  let s = sessions.get(id);
  if (!s) {
    const t = target || 'local';
    s = { id, target: t, host, cwd: cwd || (t === 'local' ? sandbox(id) : '~'), env: {}, history: [], createdAt: Date.now() };
    sessions.set(id, s);
    log.info('terminal sessiyasi ochildi', { id, target: t, host, cwd: s.cwd });
    return s;
  }
  // Only switch when the caller actually asked for a different target — a
  // follow-up command with no target must stay on the host it was already on,
  // otherwise a remote session silently drops back to the local machine.
  if (target && (target !== s.target || (host && host !== s.host))) {
    s.target = target;
    s.host = host || s.host;
    s.cwd = cwd || (target === 'local' ? sandbox(id) : '~');
    log.info('terminal sessiyasi koʻchirildi', { id, target: s.target, host: s.host });
  }
  return s;
}

const listSessions = () =>
  [...sessions.values()].map((s) => ({ id: s.id, target: s.target, host: s.host, cwd: s.cwd, commands: s.history.length }));

function closeSession(id) {
  return sessions.delete(id);
}

// ── running commands ─────────────────────────────────────────────────────────

/**
 * Run a command locally. The cwd is carried across calls by appending a
 * marker that prints the final directory, which is how `cd build && make`
 * leaves the session inside `build`.
 */
/**
 * Where to find a POSIX shell. A model writes `mkdir -p`, `ls`, `grep` and
 * pipes without thinking about the platform, and cmd.exe understands none of
 * them — so on Windows we use Git's bash when it is installed and fall back to
 * cmd only if it is not.
 */
const BASH = (() => {
  if (process.platform !== 'win32') return '/bin/bash';
  for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
})();

function runLocal(command, { cwd, env = {}, timeoutMs = 120_000 }) {
  const isWin = process.platform === 'win32';
  const useBash = !isWin || !!BASH;
  const marker = '__ANITOKU_CWD__';
  const wrapped = useBash
    ? `${command}\necho ${marker}$PWD`
    : // cmd.exe expands %CD% when it parses the line, so it would report the
      // directory we started in, not the one a `cd` moved us to. Bare `cd`
      // prints the live directory instead.
      `${command}\r\necho ${marker}\r\ncd`;

  return new Promise((resolve) => {
    const started = Date.now();
    const child = useBash
      ? spawn(isWin ? BASH : '/bin/bash', ['-lc', wrapped], { cwd, env: { ...process.env, ...env }, windowsHide: true })
      : spawn('cmd.exe', ['/d', '/s', '/c', wrapped], { cwd, env: { ...process.env, ...env }, windowsHide: true });

    let out = '';
    const take = (d) => {
      if (out.length < MAX_OUTPUT * 2) out += d.toString();
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      let newCwd = null;
      const idx = out.lastIndexOf(marker);
      if (idx !== -1) {
        // POSIX prints the path on the marker line; cmd prints it on the next.
        const after = out.slice(idx + marker.length);
        const raw = (after.split(/\r?\n/).find((l) => l.trim()) || '').trim();
        newCwd = raw ? toNativePath(raw) : null;
        out = out.slice(0, idx);
      }
      resolve({ ok: code === 0 && !timedOut, code, timedOut, output: clip(out.trimEnd()), cwd: newCwd, ms: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: err.message, ms: Date.now() - started });
    });
  });
}

/** Run a command over SSH. Password or key; whichever the host record has. */
function runRemote(hostRef, command, { cwd = null, timeoutMs = 120_000 } = {}) {
  const h = getHost(hostRef);
  if (!h) return Promise.resolve({ ok: false, code: -1, output: `Server topilmadi: ${hostRef}. Avval IP va parolni bering.` });

  const { Client } = require('ssh2');
  const marker = '__ANITOKU_CWD__';
  const full = `${cwd && cwd !== '~' ? `cd ${JSON.stringify(cwd)} 2>/dev/null || cd ~; ` : ''}${command}\necho ${marker}$PWD`;

  return new Promise((resolve) => {
    const started = Date.now();
    const conn = new Client();
    let out = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      if (r.ok) db.prepare("UPDATE hosts SET last_ok = datetime('now'), last_error = NULL WHERE name = ?").run(h.name);
      else db.prepare('UPDATE hosts SET last_error = ? WHERE name = ?').run(String(r.output).slice(-300), h.name);
      resolve({ ...r, host: h.name, ms: Date.now() - started });
    };

    const timer = setTimeout(() => done({ ok: false, code: -1, timedOut: true, output: clip(out) + '\n[timeout]' }), timeoutMs + 15_000);

    conn.on('ready', () => {
      conn.exec(full, { pty: false }, (err, stream) => {
        if (err) return done({ ok: false, code: -1, output: err.message });
        stream
          .on('close', (code) => {
            clearTimeout(timer);
            let newCwd = null;
            const idx = out.lastIndexOf(marker);
            if (idx !== -1) {
              newCwd = out.slice(idx + marker.length).split(/\r?\n/)[0].trim() || null;
              out = out.slice(0, idx);
            }
            done({ ok: code === 0, code, output: clip(out.trimEnd()), cwd: newCwd });
          })
          .on('data', (d) => {
            out += d.toString();
          })
          .stderr.on('data', (d) => {
            out += d.toString();
          });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, code: -1, output: `SSH xato: ${err.message}` });
    });

    const auth = { host: h.host, port: h.port || 22, username: h.user, readyTimeout: 20_000, keepaliveInterval: 10_000 };
    const keyFile = h.key_path || path.join(config.dataDir, 'ssh', 'id_ed25519');
    if (h.password) auth.password = h.password;
    else if (fs.existsSync(keyFile)) auth.privateKey = fs.readFileSync(keyFile);
    else return done({ ok: false, code: -1, output: 'Bu server uchun parol ham, kalit ham yoʻq' });
    conn.connect(auth);
  });
}

/**
 * Install the agent's public key on a host so later commands need no password.
 * Called automatically the first time a password host is used.
 */
async function installKey(hostRef) {
  const h = getHost(hostRef);
  if (!h || h.key_installed) return { ok: !!h, already: true };
  const pub = publicKey();
  if (!pub) return { ok: false, error: 'ochiq kalit yoʻq' };
  const r = await runRemote(hostRef, `mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF ${JSON.stringify(pub.split(' ')[1] || pub)} ~/.ssh/authorized_keys 2>/dev/null || echo ${JSON.stringify(pub)} >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; echo INSTALLED`);
  if (r.ok && /INSTALLED/.test(r.output)) {
    db.prepare('UPDATE hosts SET key_installed = 1 WHERE name = ?').run(h.name);
    log.info('SSH kalit serverga oʻrnatildi', { host: h.name });
    return { ok: true };
  }
  return { ok: false, error: r.output };
}

function publicKey() {
  const dir = path.join(config.dataDir, 'ssh');
  const key = path.join(dir, 'id_ed25519');
  try {
    if (!fs.existsSync(key)) {
      fs.mkdirSync(dir, { recursive: true });
      require('node:child_process').execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'anitoku-agent', '-f', key], { stdio: 'ignore', timeout: 20_000 });
    }
    return fs.readFileSync(key + '.pub', 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * The one entry point the agent uses. Picks local or remote from the session,
 * keeps the working directory, and records what ran.
 */
async function run(command, { sessionId = 'default', target = null, host = null, timeoutMs = 120_000, cwd = null } = {}) {
  const s = session(sessionId, { target, host });
  if (cwd) s.cwd = cwd;

  let result;
  if (s.target === 'remote') {
    if (!s.host) return { ok: false, output: 'Bu sessiya uchun server koʻrsatilmagan' };
    result = await runRemote(s.host, command, { cwd: s.cwd, timeoutMs });
    const h = getHost(s.host);
    if (result.ok && h && h.password && !h.key_installed) installKey(s.host).catch(() => {});
  } else {
    s.cwd = toNativePath(s.cwd);
    // Never silently create a directory that came from a mangled path: only
    // the session's own sandbox is auto-created.
    if (!fs.existsSync(s.cwd)) {
      if (s.cwd.startsWith(SANDBOX_ROOT)) fs.mkdirSync(s.cwd, { recursive: true });
      else {
        log.warn('ish papkasi yoʻq — sandboxga qaytarildi', { was: s.cwd });
        s.cwd = sandbox(sessionId);
      }
    }
    result = await runLocal(command, { cwd: s.cwd, env: s.env, timeoutMs });
  }

  if (result.cwd) s.cwd = s.target === 'remote' ? result.cwd : toNativePath(result.cwd);
  s.history.push({ command, code: result.code, at: Date.now() });
  if (s.history.length > 200) s.history.shift();
  log.info('terminal', { session: sessionId, target: s.target, cmd: String(command).slice(0, 100), code: result.code, ms: result.ms });
  if (!result.ok) recordEvent('shell', 'Command failed', { session: sessionId, command: String(command).slice(0, 200), code: result.code }, 'warn');

  return { ...result, session: sessionId, target: s.target, cwd: s.cwd };
}

module.exports = {
  run, runLocal, runRemote, session, listSessions, closeSession,
  saveHost, getHost, listHosts, removeHost, parseHostSpec, installKey, publicKey, toPosixPath, shq,
  sandbox, sweepSandboxes, SANDBOX_ROOT,
};
