'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const projects = require('./projects');
const botfather = require('./botfather');
const builder = require('./build');

const log = createLogger('bots');

/**
 * Telegram bots as ordinary projects.
 *
 * There used to be a second, parallel world under data/bots with its own
 * table, its own code generator and its own supervisor — so a bot was never a
 * "project", its code was written by a weaker one-shot generator, and the
 * panel showed two lists that meant almost the same thing. Now a bot IS a
 * project of kind `telegram-bot`: same directory layout, same process
 * supervision, same coding agent (which plans, runs and verifies), and the
 * token simply lives in the project's encrypted environment.
 */

const clean = (u) => String(u || '').replace(/^@/, '').trim();
const slugOf = (u) => projects.slugify(clean(u));

/** Every bot project, newest first. */
function list() {
  return projects
    .list({ all: true })
    .filter((p) => p.kind === 'telegram-bot')
    .map((p) => ({
      username: p.username || (p.envKeys.includes('BOT_USERNAME') ? null : null) || p.slug,
      slug: p.slug,
      name: p.name,
      status: p.alive ? 'running' : p.status,
      alive: p.alive,
      spec: p.spec,
      restarts: p.restarts,
      last_error: p.last_error,
      hasCode: p.files > 0,
      deployed: !!p.deployed,
    }));
}

function find(username) {
  const slug = slugOf(username);
  return projects.record(slug) || projects.find(clean(username));
}

/** Read the bot's token from the project environment, fetching it if absent. */
async function tokenFor(username, { fetchIfMissing = true } = {}) {
  const u = clean(username);
  const p = find(u);
  if (p) {
    const env = projects.envOf(p.slug);
    if (env.BOT_TOKEN) return env.BOT_TOKEN;
  }
  if (!fetchIfMissing) return null;
  const t = await botfather.getToken(u);
  return t.token;
}

/**
 * Create the project shell for a bot: directory, token, admin ids.
 * Safe to call repeatedly.
 */
async function ensureProject(username, { name = null, spec = null } = {}) {
  const u = clean(username);
  const slug = slugOf(u);
  let p = projects.record(slug);
  if (!p) {
    p = projects.create({ name: name || u, slug, kind: 'telegram-bot', spec, runCmd: 'node index.js' });
    log.info('bot loyihasi yaratildi', { slug, username: u });
  } else if (spec || name) {
    projects.update(slug, { spec: spec || null, name: name || null });
  }
  const env = projects.envOf(slug);
  if (!env.BOT_TOKEN) {
    const token = await tokenFor(u);
    projects.setEnv(slug, { BOT_TOKEN: token });
  }
  const { settings } = require('../core/db');
  projects.setEnv(slug, { BOT_USERNAME: u, ADMIN_IDS: String(settings.get('founder_ids', '')) });
  return projects.record(slug);
}

const BOT_BRIEF = `This is a Telegram bot. Requirements:
- Entry point index.js, started by "node index.js".
- Token from process.env.BOT_TOKEN. Admin Telegram ids from process.env.ADMIN_IDS (comma separated). NEVER hardcode either.
- Long polling with getUpdates(offset, timeout=30) in a loop that never exits on its own: catch errors, wait 3s, continue.
- Prefer global fetch and node: builtins; install a package only if it genuinely helps.
- Answer /start and /help; /help must list every command the bot supports.
- All user-facing text in Uzbek (Latin script). No parse_mode unless you escape correctly; split messages longer than 4000 characters.
- Log every incoming update on one line, and log errors with console.error including which handler failed.
- Verify before finishing: node --check index.js, then start it in the BACKGROUND (node index.js > run.log 2>&1 & echo $!), give it 3 seconds, confirm run.log has no crash, then kill the pid. Never run it in the foreground.`;

/**
 * The bot profile, registered with the shared build pipeline.
 *
 * Everything here is what makes a bot a bot; the seven steps around it —
 * create, stop, write, start, verify, log — live in build.js and are the
 * same ones a website or a plain script goes through. A bot is not a
 * different class of work, only a different way of proving it works.
 */
builder.register('telegram-bot', {
  label: 'Telegram bot',
  defaultRunCmd: 'node index.js',
  brief: () => BOT_BRIEF,

  // A bot needs its token in the environment before any code is written —
  // the coding agent verifies by actually starting it.
  ensure: ({ name, spec, meta }) => ensureProject(meta.username, { name, spec }),

  /**
   * Ask the bot itself whether it is alive.
   *
   * Reading the log would only tell us the process started; sending /start
   * from a real Telegram account is the only check that covers the token,
   * the polling loop and the handler at once.
   */
  verify: async ({ project, meta }) => {
    await new Promise((res) => setTimeout(res, 4000));
    const u = clean(meta.username);
    const probe = await botfather
      .talk('@' + u, '/start', { waitMs: 12_000 })
      .catch((e) => ({ text: '', error: e.message }));

    return probe.text
      ? { ok: true, reply: String(probe.text).slice(0, 300), buttons: (probe.buttons || []).map((b) => b.text) }
      : { ok: false, note: 'bot 12 s ichida /start ga javob bermadi — logni tekshir', error: probe.error };
  },
});

/**
 * Write (or extend) a bot's code and run it.
 *
 * `fix` describes a change to an existing bot; without it the spec defines the
 * bot. Either way the coding agent explores what is already there first, so
 * adding a command cannot quietly delete the others.
 */
async function build({ username, name = null, spec = null, fix = null, onStep = null }) {
  const u = clean(username);
  if (!u) throw new Error('bot username kerak');

  const r = await builder.run({
    kind: 'telegram-bot',
    slug: slugOf(u),
    name,
    spec,
    fix,
    meta: { username: u },
    onStep,
  });

  const commands = detectCommands(path.join(projects.dirOf(r.project), 'index.js'));
  recordEvent('bots', 'Bot built', { username: u, ok: r.ok, commands });

  // `smokeTest` is kept as an alias of the pipeline's `check`: the assistant's
  // tool schema and older transcripts refer to it by that name.
  return { ...r, username: '@' + u, commands, smokeTest: r.check };
}

/**
 * Send a message AS the bot, using its own token.
 *
 * "@mybot should write hello to me" means the bot sends it, not that we send
 * "hello" to the bot — the agent got that backwards. With the token in hand
 * this is a plain Bot API call.
 *
 * Telegram will not let a bot open a conversation: the recipient must have
 * pressed Start at least once, which the error message explains.
 */
async function sendAs(username, chatId, text, extra = {}) {
  const u = clean(username);
  const token = await tokenFor(u);
  if (!token) throw new Error(`@${u} uchun token yoʻq`);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text: String(text), ...extra }),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const d = String(json.description || `HTTP ${res.status}`);
    if (/bot can't initiate conversation|chat not found|blocked/i.test(d)) {
      throw new Error(`@${u} bu odamga birinchi boʻlib yoza olmaydi — u avval botga /start bosishi kerak (Telegram qoidasi). Sabab: ${d}`);
    }
    throw new Error(`@${u} yubora olmadi: ${d}`);
  }
  log.info('bot oʻz nomidan xabar yubordi', { bot: u, chatId });
  return { ok: true, from: '@' + u, chatId: String(chatId), messageId: json.result && json.result.message_id };
}

/** Who the bot is, straight from Telegram — also proves the token works. */
async function whoAmI(username) {
  const token = await tokenFor(clean(username));
  if (!token) throw new Error('token yoʻq');
  const r = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((x) => x.json()).catch(() => ({}));
  if (!r.ok) throw new Error(String(r.description || 'getMe failed'));
  return { ok: true, id: r.result.id, username: '@' + r.result.username, name: r.result.first_name };
}

/** Slash commands the code actually handles — reported instead of guessed. */
function detectCommands(file) {
  if (!fs.existsSync(file)) return [];
  const code = fs.readFileSync(file, 'utf8');
  return [...new Set([...code.matchAll(/['"`]\/([a-z][a-z0-9_]{1,30})\b(?![/a-z0-9_])/gi)].map((m) => '/' + m[1].toLowerCase()))].sort();
}

const start = (u) => projects.start(slugOf(u));
const stop = (u) => projects.stop(slugOf(u));
const logs = (u, n = 60) => projects.logs(slugOf(u), n);
const code = (u) => {
  const f = path.join(projects.dirOf(slugOf(u)), 'index.js');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
const remove = (u) => projects.remove(slugOf(u));

/**
 * Move anything left in the old data/bots world into projects, once.
 * Keeps a running bot running: the code and token come across intact.
 */
function migrateLegacy() {
  const { settings } = require('../core/db');
  // Once only. Re-running it resurrected a bot the founder had deliberately
  // deleted, every single time the agent restarted.
  if (settings.bool('bots_migrated', false)) return 0;

  let moved = 0;
  let rows = [];
  try {
    rows = db.prepare('SELECT username, name, spec, status FROM managed_bots').all();
  } catch {
    settings.set('bots_migrated', '1');
    return 0; // table never existed
  }
  const legacyDir = path.join(require('../config').dataDir, 'bots');

  for (const r of rows) {
    const slug = projects.slugify(r.username);
    if (projects.record(slug)) continue;
    try {
      const src = path.join(legacyDir, r.username.replace(/[^\w]/g, '_'));
      const p = projects.create({ name: r.name || r.username, slug, kind: 'telegram-bot', spec: r.spec, runCmd: 'node index.js' });
      if (fs.existsSync(path.join(src, 'bot.js'))) {
        // The old supervisor ran bot.js; projects run index.js.
        fs.copyFileSync(path.join(src, 'bot.js'), path.join(p.dir, 'index.js'));
      }
      let token = null;
      try {
        token = require('./managedBots').getToken(r.username);
      } catch {
        /* legacy module may be gone */
      }
      const { settings } = require('../core/db');
      projects.setEnv(slug, { BOT_TOKEN: token || '', BOT_USERNAME: r.username, ADMIN_IDS: String(settings.get('founder_ids', '')) });
      if (r.status === 'running') projects.setDeployed(slug, true);
      moved++;
      log.info('eski bot loyihaga koʻchirildi', { username: r.username, slug });
    } catch (err) {
      log.warn('botni koʻchirib boʻlmadi', { username: r.username, error: err.message });
    }
  }
  settings.set('bots_migrated', '1');
  if (moved) recordEvent('bots', 'Legacy bots migrated to projects', { moved });
  return moved;
}

module.exports = { list, find, build, ensureProject, tokenFor, sendAs, whoAmI, start, stop, logs, code, remove, detectCommands, migrateLegacy, slugOf };
