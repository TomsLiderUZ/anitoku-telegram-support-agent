'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const config = require('../config');
const { db, recordEvent } = require('../core/db');
const { encrypt, decrypt } = require('../core/crypto');
const { createLogger } = require('../core/logger');

const log = createLogger('projects');

/**
 * General projects the assistant creates and runs on this machine: a Telegram
 * bot, an API, a script, a static site — anything with files and optionally
 * a long-running command. Telegram bots are projects too (kind
 * "telegram-bot") — see bots.js, which is a thin layer over this one.
 *
 * Each project is a directory under data/projects/<slug>. Files are read and
 * written only inside it; commands run with it as the working directory.
 */

const ROOT = path.join(config.dataDir, 'projects');
fs.mkdirSync(ROOT, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    slug        TEXT PRIMARY KEY,
    name        TEXT,
    kind        TEXT DEFAULT 'node',
    run_cmd     TEXT,
    env_enc     TEXT,
    spec        TEXT,
    status      TEXT DEFAULT 'stopped',
    deployed    INTEGER DEFAULT 0,
    pid         INTEGER,
    restarts    INTEGER DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  )
`);

const procs = new Map();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__']);

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/['‘’ʻ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const dirOf = (slug) => path.join(ROOT, slug);

/** Resolve a relative path inside the project; refuses to escape it. */
function safePath(slug, rel) {
  const base = dirOf(slug);
  const p = path.resolve(base, String(rel || '.'));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`Yoʻl loyihadan tashqarida: ${rel}`);
  return p;
}

function envOf(slug) {
  const r = db.prepare('SELECT env_enc FROM projects WHERE slug = ?').get(slug);
  if (!r || !r.env_enc) return {};
  try {
    return JSON.parse(decrypt(r.env_enc));
  } catch {
    return {};
  }
}

function setEnv(slug, patch) {
  const env = { ...envOf(slug), ...patch };
  for (const k of Object.keys(env)) if (env[k] === null || env[k] === undefined) delete env[k];
  db.prepare("UPDATE projects SET env_enc = ?, updated_at = datetime('now') WHERE slug = ?").run(encrypt(JSON.stringify(env)), slug);
  return Object.keys(env);
}

/**
 * Is this project's process actually running?
 *
 * The in-memory child map only knows about processes this run started, so a
 * project that survived an agent restart looked "stopped" while happily
 * serving traffic. The pidfile is the durable answer.
 */
function isAlive(slug) {
  const p = procs.get(slug);
  if (p && !p.killed && p.exitCode === null) return true;
  const f = path.join(dirOf(slug), '.pid');
  if (!fs.existsSync(f)) return false;
  const pid = Number(fs.readFileSync(f, 'utf8').trim());
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    fs.rmSync(f, { force: true });
    return false;
  }
}

function record(slug) {
  const r = db.prepare('SELECT * FROM projects WHERE slug = ?').get(String(slug));
  if (!r) return null;
  return {
    ...r,
    env_enc: undefined,
    envKeys: Object.keys(envOf(r.slug)),
    dir: dirOf(r.slug),
    alive: isAlive(r.slug),
    files: fs.existsSync(dirOf(r.slug)) ? fs.readdirSync(dirOf(r.slug)).filter((f) => !SKIP_DIRS.has(f)).length : 0,
  };
}

/**
 * Projects worth showing.
 *
 * Creating a bot and never running it is an experiment, not a project — it
 * used to clutter the panel all the same. Only something that has actually
 * been deployed (started at least once, or explicitly marked) is listed;
 * `all: true` shows the scratch ones too.
 */
const list = ({ all = false } = {}) => {
  const rows = db.prepare('SELECT slug FROM projects ORDER BY updated_at DESC').all().map((r) => record(r.slug));
  return all ? rows : rows.filter((p) => p.deployed || p.alive);
};

/** Mark a project as a real, running deliverable (or take the mark away). */
function setDeployed(slug, on = true) {
  db.prepare("UPDATE projects SET deployed = ?, updated_at = datetime('now') WHERE slug = ?").run(on ? 1 : 0, String(slug));
  return record(slug);
}

/** Find by slug or name, loosely. */
function find(ref) {
  const s = String(ref || '').trim();
  if (!s) return null;
  return (
    record(s) ||
    record(slugify(s)) ||
    (() => {
      const rows = db.prepare('SELECT slug, name FROM projects').all();
      const hit = rows.find((r) => r.name && r.name.toLowerCase() === s.toLowerCase()) || rows.find((r) => r.slug.includes(slugify(s)) || (r.name || '').toLowerCase().includes(s.toLowerCase()));
      return hit ? record(hit.slug) : null;
    })()
  );
}

function create({ name, slug = null, kind = 'node', runCmd = null, spec = null, env = null }) {
  if (!name) throw new Error('loyiha nomi kerak');
  const s = slugify(slug || name);
  if (!s) throw new Error('nomdan slug chiqmadi');
  if (record(s)) throw new Error(`"${s}" loyihasi allaqachon bor`);
  fs.mkdirSync(dirOf(s), { recursive: true });
  db.prepare('INSERT INTO projects (slug, name, kind, run_cmd, spec) VALUES (?, ?, ?, ?, ?)').run(s, String(name), String(kind || 'node'), runCmd, spec);
  if (env) setEnv(s, env);
  recordEvent('projects', 'Project created', { slug: s, kind });
  log.info('loyiha yaratildi', { slug: s, kind });
  return record(s);
}

function update(slug, { name, kind, runCmd, spec } = {}) {
  const r = record(slug);
  if (!r) throw new Error(`loyiha topilmadi: ${slug}`);
  db.prepare("UPDATE projects SET name = COALESCE(?, name), kind = COALESCE(?, kind), run_cmd = COALESCE(?, run_cmd), spec = COALESCE(?, spec), updated_at = datetime('now') WHERE slug = ?").run(
    name ?? null, kind ?? null, runCmd ?? null, spec ?? null, r.slug
  );
  return record(r.slug);
}

// ── files ────────────────────────────────────────────────────────────────────

function listFiles(slug, { maxEntries = 400 } = {}) {
  const base = dirOf(slug);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (dir, rel) => {
    if (out.length >= maxEntries) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxEntries) return;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) {
          out.push({ path: path.posix.join(rel, ent.name) + '/', dir: true, skipped: true });
          continue;
        }
        walk(path.join(dir, ent.name), path.posix.join(rel, ent.name));
      } else {
        const st = fs.statSync(path.join(dir, ent.name));
        out.push({ path: path.posix.join(rel, ent.name), size: st.size });
      }
    }
  };
  walk(base, '');
  return out;
}

function readFile(slug, rel, { maxChars = 60_000 } = {}) {
  const p = safePath(slug, rel);
  if (!fs.existsSync(p)) throw new Error(`fayl yoʻq: ${rel}`);
  if (fs.statSync(p).isDirectory()) throw new Error(`${rel} — papka`);
  const text = fs.readFileSync(p, 'utf8');
  return text.length > maxChars ? text.slice(0, maxChars) + `\n…[${text.length - maxChars} belgi qisqartirildi]` : text;
}

function writeFile(slug, rel, content) {
  const p = safePath(slug, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content ?? ''), 'utf8');
  db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE slug = ?").run(slug);
  return { ok: true, path: rel, bytes: Buffer.byteLength(String(content ?? '')) };
}

/** Exact-substring replace; the search text must occur exactly once. */
function editFile(slug, rel, search, replace) {
  const p = safePath(slug, rel);
  if (!fs.existsSync(p)) throw new Error(`fayl yoʻq: ${rel}`);
  const text = fs.readFileSync(p, 'utf8');
  const idx = text.indexOf(search);
  if (idx === -1) throw new Error('qidirilgan matn faylda topilmadi (aynan bir xil boʻlishi kerak)');
  if (text.indexOf(search, idx + 1) !== -1) throw new Error('qidirilgan matn bir necha joyda uchraydi — kengroq parcha bering');
  fs.writeFileSync(p, text.slice(0, idx) + replace + text.slice(idx + search.length), 'utf8');
  return { ok: true, path: rel };
}

function deleteFile(slug, rel) {
  const p = safePath(slug, rel);
  if (p === dirOf(slug)) throw new Error('loyiha papkasining oʻzini oʻchirib boʻlmaydi');
  fs.rmSync(p, { recursive: true, force: true });
  return { ok: true };
}

// ── commands ─────────────────────────────────────────────────────────────────

/**
 * Run a one-off shell command. `cwd` defaults to the project directory (or
 * the projects root when no project is given). Output is captured and capped.
 */
function runCommand(command, { slug = null, cwd = null, timeoutMs = 120_000, maxChars = 12_000, env = {} } = {}) {
  const dir = cwd || (slug ? dirOf(slug) : ROOT);
  if (slug && !fs.existsSync(dir)) throw new Error(`loyiha papkasi yoʻq: ${slug}`);
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    const started = Date.now();
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', String(command)], { cwd: dir, windowsHide: true, env: { ...process.env, ...(slug ? envOf(slug) : {}), ...env } })
      : spawn('/bin/sh', ['-c', String(command)], { cwd: dir, env: { ...process.env, ...(slug ? envOf(slug) : {}), ...env } });
    let out = '';
    const take = (d) => {
      if (out.length < maxChars) out += d.toString();
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      log.info('buyruq bajarildi', { slug, command: String(command).slice(0, 80), code, ms: Date.now() - started });
      resolve({ ok: code === 0 && !timedOut, code, timedOut, output: out.slice(0, maxChars) + (out.length > maxChars ? '\n…[qisqartirildi]' : ''), ms: Date.now() - started, cwd: dir });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: err.message, cwd: dir });
    });
  });
}

// ── long-running process ─────────────────────────────────────────────────────

/**
 * Kill a process this project left behind.
 *
 * The in-memory pid map is lost whenever the agent restarts, and a Telegram
 * bot that keeps polling after we forget about it competes with the new
 * instance for the same updates — three copies of one bot were answering at
 * random. A pidfile survives restarts, so the previous instance can always be
 * found and stopped before a new one starts.
 */
function killStray(slug) {
  const f = path.join(dirOf(slug), '.pid');
  if (!fs.existsSync(f)) return false;
  const pid = Number(fs.readFileSync(f, 'utf8').trim());
  fs.rmSync(f, { force: true });
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0); // does it still exist?
  } catch {
    return false; // already gone
  }
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid, 'SIGKILL');
    log.warn('eski jarayon toʻxtatildi', { slug, pid });
    return true;
  } catch (err) {
    log.debug('stray kill failed', { slug, pid, error: err.message });
    return false;
  }
}

function start(slug) {
  const r = record(slug);
  if (!r) throw new Error(`loyiha topilmadi: ${slug}`);
  if (!r.run_cmd) throw new Error(`"${r.slug}" uchun ishga tushirish buyrugʻi (run_cmd) belgilanmagan`);
  if (r.alive) return { ok: true, already: true, pid: r.pid };

  const dir = dirOf(r.slug);
  killStray(r.slug);
  const out = fs.openSync(path.join(dir, 'project.log'), 'a');
  const isWin = process.platform === 'win32';
  const child = isWin
    ? spawn('cmd.exe', ['/d', '/s', '/c', r.run_cmd], { cwd: dir, env: { ...process.env, ...envOf(r.slug), NODE_ENV: 'production' }, stdio: ['ignore', out, out], windowsHide: true })
    : spawn('/bin/sh', ['-c', r.run_cmd], { cwd: dir, env: { ...process.env, ...envOf(r.slug), NODE_ENV: 'production' }, stdio: ['ignore', out, out] });
  procs.set(r.slug, child);
  fs.writeFileSync(path.join(dir, '.pid'), String(child.pid), 'utf8');
  // Starting it is what makes it a real project rather than an experiment.
  db.prepare("UPDATE projects SET status = 'running', deployed = 1, pid = ?, last_error = NULL, updated_at = datetime('now') WHERE slug = ?").run(child.pid, r.slug);
  log.info('loyiha ishga tushdi', { slug: r.slug, pid: child.pid, cmd: r.run_cmd });

  child.on('exit', (code, signal) => {
    procs.delete(r.slug);
    try {
      fs.rmSync(path.join(dir, '.pid'), { force: true });
    } catch {
      /* best effort */
    }
    const cur = db.prepare('SELECT status, restarts FROM projects WHERE slug = ?').get(r.slug);
    if (!cur || cur.status !== 'running') return;
    const restarts = (cur.restarts || 0) + 1;
    db.prepare("UPDATE projects SET restarts = ?, last_error = ?, updated_at = datetime('now') WHERE slug = ?").run(restarts, `exit ${code ?? signal}`, r.slug);
    if (restarts > 20) {
      db.prepare("UPDATE projects SET status = 'crashed' WHERE slug = ?").run(r.slug);
      log.error('loyiha 20 marta yiqildi — toʻxtatildi', { slug: r.slug });
      return;
    }
    const delay = Math.min(60_000, 3_000 * restarts);
    log.warn('loyiha yiqildi, qayta ishga tushirilmoqda', { slug: r.slug, code, delayMs: delay });
    setTimeout(() => {
      try {
        start(r.slug);
      } catch (err) {
        log.error('qayta ishga tushmadi', { slug: r.slug, error: err.message });
      }
    }, delay);
  });
  return { ok: true, pid: child.pid };
}

function stop(slug) {
  const s = String(slug);
  killStray(s);
  db.prepare("UPDATE projects SET status = 'stopped', pid = NULL, updated_at = datetime('now') WHERE slug = ?").run(s);
  const p = procs.get(s);
  if (p) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      else p.kill();
    } catch {
      /* gone */
    }
    procs.delete(s);
  }
  return { ok: true };
}

function restart(slug) {
  stop(slug);
  return new Promise((res) => setTimeout(() => res(start(slug)), 800));
}

/**
 * Delete a project and its files.
 *
 * Windows keeps a handle on the working directory until the process it was
 * running has fully exited, so deleting immediately after `stop()` failed with
 * EPERM and left the folder behind. `retryDelay` lets the OS catch up.
 */
function remove(slug) {
  const s = String(slug);
  stop(s);
  db.prepare('DELETE FROM projects WHERE slug = ?').run(s);
  try {
    fs.rmSync(dirOf(s), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (err) {
    log.warn('loyiha papkasini oʻchirib boʻlmadi — keyinroq tozalanadi', { slug: s, error: err.message });
    return { ok: true, dirRemoved: false, note: 'Fayllar band edi; jarayon toʻxtagach tozalanadi.' };
  }
  return { ok: true, dirRemoved: true };
}

/**
 * Git omboridan loyiha papkasiga ko'chirish.
 *
 * Bu yo'l yo'q edi, va shuning uchun "GitHubdan clone qilib ishlatib
 * qo'y" degan buyruq amalda bajarilmasdi: agent `bash` bilan biror joyga
 * clone qilardi, keyin `write_project_file` "Loyiha topilmadi" deb xato
 * berardi va nusxa loyihalar ro'yxatiga umuman tushmasdi. Ya'ni fayllar
 * bor, lekin agentning o'zi ularni boshqara olmasdi.
 *
 * Endi clone loyihaning o'z papkasiga tushadi — shundan keyin uni
 * ishga tushirish, to'xtatish, jurnalini o'qish va o'chirish mumkin.
 */
function cloneInto(slug, url) {
  const r = record(slug);
  if (!r) throw new Error(`loyiha topilmadi: ${slug}`);
  const clean = String(url).trim();
  if (!/^https:\/\/[\w.-]+\/[\w./~-]+?(\.git)?$/i.test(clean)) {
    throw new Error('faqat https:// bilan boshlanadigan git manzili qabul qilinadi');
  }

  const dir = dirOf(slug);
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (existing.length) throw new Error(`"${slug}" papkasi boʻsh emas (${existing.length} ta element)`);

  try {
    execFileSync('git', ['clone', '--depth', '1', clean, dir], {
      stdio: 'pipe',
      timeout: 180_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (err) {
    const why = String(err.stderr || err.message).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`clone boʻlmadi: ${why}`);
  }

  const files = fs.readdirSync(dir).filter((f) => f !== '.git');
  log.info('loyiha git ombordan koʻchirildi', { slug, url: clean, files: files.length });
  recordEvent('projects', 'Project cloned', { slug, url: clean, files: files.length });
  return { ok: true, files, hasPackageJson: files.includes('package.json') };
}

/** Sweep project folders whose database row is gone. */
function sweepOrphans() {
  if (!fs.existsSync(ROOT)) return 0;
  const known = new Set(db.prepare('SELECT slug FROM projects').all().map((r) => r.slug));
  let removed = 0;
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(ROOT, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      removed++;
    } catch {
      /* still locked — next sweep will get it */
    }
  }
  if (removed) log.info('egasiz loyiha papkalari tozalandi', { removed });
  return removed;
}

function logs(slug, lines = 80) {
  const f = path.join(dirOf(slug), 'project.log');
  if (!fs.existsSync(f)) return '';
  return fs.readFileSync(f, 'utf8').split('\n').slice(-lines).join('\n');
}

function resumeAll() {
  let n = 0;
  for (const r of db.prepare("SELECT slug FROM projects WHERE status = 'running'").all()) {
    try {
      start(r.slug);
      n++;
    } catch (err) {
      log.warn('loyiha tiklanmadi', { slug: r.slug, error: err.message });
    }
  }
  if (n) log.info(`${n} ta loyiha tiklandi`);
}

function stopAll() {
  for (const s of [...procs.keys()]) stop(s);
}

module.exports = {
  ROOT, create, update, find, record, list, remove, sweepOrphans, slugify, dirOf, safePath, setDeployed, killStray, cloneInto,
  listFiles, readFile, writeFile, editFile, deleteFile, runCommand,
  start, stop, restart, logs, resumeAll, stopAll, envOf, setEnv,
};
