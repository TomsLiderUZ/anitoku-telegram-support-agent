'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const projects = require('./projects');

const log = createLogger('build');

/**
 * One pipeline for every project the agent writes.
 *
 * WHY THIS FILE EXISTS
 *
 * Telegram bots and websites each used to carry their own copy of the same
 * seven steps: make sure the project exists, stop it if it was running, hand
 * the task to the coding agent, work out how to start it, start it, wait,
 * prove it actually answers. Two copies meant two behaviours. The site path
 * learned to detect its own run command; the bot path kept assuming
 * `node index.js`. The site path re-read the project record after the coder
 * ran; the bot path used a stale one. Neither difference was a decision —
 * they were just two places drifting apart.
 *
 * Now there is one pipeline and a KIND holds only what is genuinely
 * different about a kind of project:
 *
 *   brief(ctx)    the technical requirements handed to the coding agent
 *   prepare(ctx)  anything needed before coding (a port, a bot token)
 *   verify(ctx)   how you prove THIS kind of thing works — an HTTP request
 *                 for a site, a /start message for a bot
 *
 * Everything else — planning, editing, running, supervising, logging — is
 * identical, because it always was. A bot is not a lesser kind of project
 * than a website: both are code the agent writes, runs and has to prove.
 */

/** Registered kinds. `register()` is called by bots.js and sites.js. */
const KINDS = new Map();

/**
 * @param {string} kind          project kind stored on the record
 * @param {object} profile
 * @param {(ctx) => string} profile.brief
 * @param {(ctx) => Promise<object|void>} [profile.prepare]
 * @param {(ctx) => Promise<object>} [profile.verify]
 * @param {string} [profile.defaultRunCmd]
 * @param {(dir) => string} [profile.detectRunCmd]
 * @param {string} [profile.label]  human name used in messages
 */
function register(kind, profile) {
  KINDS.set(kind, { label: kind, defaultRunCmd: 'node index.js', ...profile });
}

const kinds = () => [...KINDS.keys()];

/** A generic profile, so an unregistered kind still builds and runs. */
const GENERIC = {
  label: 'dastur',
  defaultRunCmd: 'node index.js',
  brief: () => `Requirements:
- Entry point index.js, started by "node index.js".
- Prefer node: builtins and global fetch; install a package only if it genuinely helps.
- Read configuration from process.env — never hardcode tokens, ids or paths.
- Log what happens on one line each; never crash on bad input.
- Verify before finishing: node --check index.js, then run it and confirm it does
  what the task asked.`,
};

/**
 * Build or extend a project, then leave it running and verified.
 *
 * @param {object}   opts
 * @param {string}   opts.kind      which profile to use
 * @param {string}   [opts.slug]    existing project, if any
 * @param {string}   [opts.name]    display name for a new project
 * @param {string}   [opts.spec]    what it should do (new project)
 * @param {string}   [opts.fix]     what to change (existing project)
 * @param {object}   [opts.meta]    passed through to the profile
 * @param {Function} [opts.onStep]  progress callback from the coding agent
 */
async function run({ kind = 'node', slug = null, name = null, spec = null, fix = null, meta = {}, onStep = null }) {
  const profile = KINDS.get(kind) || GENERIC;
  const coder = require('./coder');

  // ── 1. The project shell ────────────────────────────────────────────────
  // A profile may need to do more than create a directory (a bot has to
  // fetch its token first), so it gets the chance before we fall back to
  // the plain create/update.
  let record = null;
  if (profile.ensure) {
    record = await profile.ensure({ slug, name, spec, meta });
  } else {
    const s = projects.slugify(slug || name);
    record = projects.record(s);
    if (!record) {
      record = projects.create({ name: name || s, slug: s, kind, spec, runCmd: profile.defaultRunCmd });
      log.info('loyiha yaratildi', { slug: s, kind });
    } else if (spec || name) {
      projects.update(s, { spec: spec || null, name: name || null });
      record = projects.record(s);
    }
  }
  if (!record) throw new Error('loyiha yaratilmadi');

  const projectSlug = record.slug;

  // ── 2. Anything the kind needs before coding ────────────────────────────
  const prepared = profile.prepare ? (await profile.prepare({ project: record, meta })) || {} : {};
  const ctx = { project: projects.record(projectSlug), meta, ...prepared };

  // ── 3. The task ─────────────────────────────────────────────────────────
  // Whether this is a first build or a change decides the whole framing:
  // "build from scratch" invites a rewrite, which on an existing project
  // silently deletes work that already runs.
  const existing = fs.existsSync(path.join(record.dir, 'index.js'));
  const brief = profile.brief(ctx);
  const label = profile.label || kind;

  const task = existing
    ? `Modify the existing ${label} in this project.\n\nWHAT TO CHANGE:\n${fix || spec}\n\n` +
      `Everything that already works must keep working — read index.js first and confirm ` +
      `each existing feature still exists afterwards.\n\n${brief}`
    : `Build a ${label} from scratch in this project.\n\nWHAT IT MUST DO:\n${spec || fix}\n\n${brief}`;

  // Running while being rewritten is asking for trouble: a Telegram bot with
  // two pollers fights itself over updates, and a half-written file gets
  // loaded on the next crash-restart.
  const wasAlive = projects.record(projectSlug).alive;
  if (wasAlive) projects.stop(projectSlug);

  // ── 4. Write the code ───────────────────────────────────────────────────
  const result = await coder.runTask({ project: projects.record(projectSlug), task, onStep });

  // ── 5. Start it the way it was actually built ───────────────────────────
  // Not the way we assumed when the project was created: the coding agent
  // may well have chosen a different entry point, and starting the wrong
  // file looks exactly like broken code.
  if (profile.detectRunCmd) {
    const detected = profile.detectRunCmd(projects.dirOf(projectSlug));
    if (detected && detected !== projects.record(projectSlug).run_cmd) {
      projects.update(projectSlug, { runCmd: detected });
      log.info('ishga tushirish buyrugʻi aniqlandi', { slug: projectSlug, runCmd: detected });
    }
  }

  let started = null;
  try {
    await projects.restart(projectSlug);
    started = true;
  } catch (err) {
    started = err.message;
  }

  // ── 6. Prove it works ───────────────────────────────────────────────────
  // "The code was written" is not the same as "it runs". Every kind has to
  // answer for itself before we report success.
  let check = null;
  if (profile.verify) {
    check = await profile
      .verify({ ...ctx, project: projects.record(projectSlug), started })
      .catch((err) => ({ ok: false, error: err.message }));
  }

  recordEvent('projects', 'Loyiha qurildi', { slug: projectSlug, kind, ok: result.ok, verified: check?.ok ?? null });

  return {
    ...result,
    project: projectSlug,
    kind,
    started,
    check,
    logsTail: projects.logs(projectSlug, 15),
  };
}

module.exports = { register, run, kinds, KINDS };
