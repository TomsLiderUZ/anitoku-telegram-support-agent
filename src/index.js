'use strict';
const config = require('./config');
const { createLogger } = require('./core/logger');
const { db, settings, recordEvent, vacuumOld } = require('./core/db');
const keyPool = require('./ai/keyPool');
const tg = require('./telegram/client');
const runtime = require('./agent/runtime');
const skills = require('./agent/skills');
const seed = require('./knowledge/seed');
const selfTrain = require('./training/selfTrain');
const ingest = require('./knowledge/ingest');
const adminServer = require('./admin/server');
const adminAuth = require('./admin/auth');
const tasks = require('./agent/tasks');
const executors = require('./agent/executors');
const contacts = require('./agent/contacts');
const bots = require('./agent/bots');
const projects = require('./agent/projects');
const local = require('./ai/local');

const log = createLogger('main');

const BANNER = `
\x1b[35m  ╭──────────────────────────────────────────╮
  │   ANITOKU · Support Agent  v1.0.0        │
  │   autonomous · self-training · 24/7      │
  ╰──────────────────────────────────────────╯\x1b[0m`;

const timers = [];
let httpServer = null;
let shuttingDown = false;

/** Seed AI keys shipped in .env on first boot (optional convenience). */
function importEnvKeys() {
  const blob = [process.env.OPENROUTER_KEYS || '', process.env.GROQ_KEYS || ''].filter(Boolean).join('\n');
  if (!blob) return;
  const out = keyPool.importKeys(blob);
  if (out.added) log.info('.env dagi kalitlar import qilindi', out);
}

/**
 * Watchdog: MTProto sessions can silently drop on a long-running server.
 * Every minute we verify the connection and transparently resume it.
 */
function startWatchdog() {
  let failures = 0;
  const t = setInterval(async () => {
    if (shuttingDown) return;
    const rec = tg.record();
    if (!rec || !rec.session_enc) return; // never logged in — nothing to watch
    if (tg.isConnected()) {
      failures = 0;
      return;
    }
    if (tg.connecting || tg.status === 'awaiting_code' || tg.status === 'awaiting_password') return;

    failures++;
    log.warn(`Telegram uzilgan (${tg.status}) — qayta ulanmoqda (urinish ${failures})`);
    const ok = await tg.resume().catch(() => false);
    if (ok) {
      failures = 0;
      recordEvent('telegram', 'Reconnected by watchdog');
    } else if (failures % 10 === 0) {
      recordEvent('telegram', 'Watchdog cannot reconnect', { failures, status: tg.status }, 'error');
    }
  }, 60_000);
  timers.push(t);
}

/**
 * Presence: while the agent is live, the account should look online in
 * Telegram — a support account that answers instantly but shows "last seen
 * yesterday" is jarring. Telegram expires the online flag after about a
 * minute, so it is refreshed on a shorter interval.
 */
function startPresence() {
  // Telegram clears the online flag roughly a minute after the last update,
  // and a single missed tick (a slow request, a busy event loop) is enough for
  // the account to look offline. 25 s leaves room for one failure without the
  // status ever dropping.
  const INTERVAL = 25_000;
  let failures = 0;

  const push = async () => {
    if (shuttingDown || !tg.isConnected()) return;
    if (!settings.bool('keep_online', true)) return;
    const live = !settings.bool('agent_paused', false) && settings.bool('auto_reply', true);
    const ok = await tg.setOnline(live);
    if (ok) failures = 0;
    else if (++failures % 8 === 0) log.warn('online holatini yangilab boʻlmayapti', { failures });
  };

  push().catch(() => {});
  timers.push(setInterval(() => push().catch(() => {}), INTERVAL));
  log.info(`Presence yangilash faol (${INTERVAL / 1000}s)`);
}

/**
 * A model file that finishes downloading while the agent is running should be
 * picked up without a restart — the download takes long enough that this is
 * the common case, not the exception.
 */
function startLocalModelWatch() {
  timers.push(
    setInterval(() => {
      if (shuttingDown || !settings.bool('local_model_enabled', true)) return;
      const s = local.status();
      if (s.loading) return;
      if ((s.chat.present && !s.chat.loaded) || (s.embed.present && !s.embed.loaded)) {
        log.info('Yangi lokal model fayli topildi — yuklanmoqda');
        local.load().then((r) => {
          if (r.chat.loaded) log.info(`Chat modeli yuklandi: ${r.chat.label} (${r.gpu})`);
        }).catch(() => {});
      }
    }, 60_000)
  );
}

/** Housekeeping: prune old telemetry, revive keys whose cooldown has lapsed. */
function startMaintenance() {
  timers.push(
    setInterval(() => {
      if (shuttingDown) return;
      vacuumOld();
      // Folders left behind by a delete that raced a still-running process.
      projects.sweepOrphans();
      require('./agent/shell').sweepSandboxes();
      // Forget chats the account has left since the last sweep.
      if (tg.isConnected()) ingest.pruneStaleChats().catch((err) => log.debug('prune failed', { error: err.message }));
      db.prepare("UPDATE api_keys SET status = 'active' WHERE status = 'active' AND cooldown_until > 0 AND cooldown_until <= ?").run(Date.now());
    }, 30 * 60_000)
  );
}

/** Periodic self-retraining so the agent keeps absorbing new channel posts. */
function startRetrainSchedule() {
  const hours = settings.int('auto_retrain_cron_hours', 12);
  if (hours <= 0) {
    log.info('Avtomatik qayta trening o\'chirilgan');
    return;
  }
  timers.push(
    setInterval(async () => {
      if (shuttingDown || selfTrain.state.running) return;
      if (!tg.isConnected()) return;
      const available = Object.values(keyPool.health()).some((v) => v && typeof v === 'object' && v.available > 0);
      if (!available) {
        log.warn('Qayta trening o\'tkazib yuborildi — AI kalit yo\'q');
        return;
      }
      log.info('Rejalashtirilgan qayta trening boshlanmoqda');
      await selfTrain.run().catch((err) => log.error('scheduled retrain failed', { error: err.message }));
    }, hours * 3600_000)
  );
  log.info(`Avtomatik qayta trening: har ${hours} soatda`);
}

/**
 * First-run bootstrap: if the agent has never trained but everything it needs
 * is available, kick off a training pass so it is useful immediately.
 */
async function maybeBootstrapTraining() {
  if (settings.get('last_training_at', null)) return;
  if (!tg.isConnected()) return;
  const available = Object.values(keyPool.health()).some((v) => v && typeof v === 'object' && v.available > 0);
  if (!available) {
    log.warn('Birinchi trening o\'tkazilmadi — AI kalit qo\'shilmagan');
    return;
  }
  log.info('Birinchi ishga tushirish — avtomatik trening boshlanmoqda');
  selfTrain.run().catch((err) => log.error('bootstrap training failed', { error: err.message }));
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(BANNER);
  log.info('Ishga tushmoqda…', { node: process.versions.node, dataDir: config.dataDir, tz: config.tz });

  // 1. The admin panel goes FIRST — before seeding, before keys, before
  //    anything else that takes time.
  //
  //    While the port is closed nginx has nothing to talk to and answers 502.
  //    That window used to be the whole of steps 1-2 (seeding the knowledge
  //    base, ensuring skills, importing keys) — several seconds on every
  //    restart, and every restart produced a burst of 502s in the log.
  //    Opening the socket first shrinks it to the module-loading time we
  //    cannot avoid.
  //
  //    Nothing below is required to SERVE: every endpoint reads the database,
  //    which is ready as soon as core/db is imported. `ensureAdmin` runs a
  //    moment later, and it only matters for the first-ever login.
  httpServer = await adminServer.start();

  // 2. Baseline data
  seed.run();
  skills.ensureBaseSkills();
  importEnvKeys();

  // 3. Admin credentials
  adminAuth.ensureAdmin();

  // 4. Agent runtime + background task queue
  runtime.attach();
  executors.register();
  tasks.start(20_000);
  // Bots are projects now; one migration brings any legacy ones across.
  bots.migrateLegacy();
  projects.resumeAll();
  tg.on('connected', () => contacts.refreshFromDialogs(300).catch(() => {}));

  // 5. Telegram — resume an existing session if we have one
  const rec = tg.record();
  if (rec && rec.session_enc) {
    log.info('Saqlangan Telegram sessiyasi topildi — ulanmoqda…');
    const ok = await tg.resume();
    if (!ok) log.warn('Sessiyani tiklab bo\'lmadi — admin panel orqali qayta login qiling');
  } else {
    log.warn('Telegram akkaunt ulanmagan → admin panelda "Telegram" bo\'limiga o\'ting');
  }

  // 5b. Local models — loaded after Telegram so replies are never delayed by a
  // 7 GB model load; until it is up, cloud providers serve everything.
  if (settings.bool('local_model_enabled', true)) {
    local
      .load()
      .then(async (s) => {
        if (s.chat.loaded || s.embed.loaded) {
          log.info(`Lokal model: chat ${s.chat.loaded ? '✅' : '—'} · embedding ${s.embed.loaded ? '✅' : '—'} · GPU ${s.gpu}`);
          if (s.embed.loaded) {
            const vectors = require('./knowledge/vectors');
            for (let i = 0; i < 40; i++) {
              const r = await vectors.backfill({ batch: 50 });
              if (!r.remaining) break;
            }
            log.info('Semantik indeks tayyor', vectors.stats());
          }
        } else {
          log.info('Lokal model fayllari yoʻq — cloud provayderlar ishlatiladi');
        }
      })
      .catch((err) => log.warn('lokal model yuklanmadi', { error: err.message }));
  }

  // 6. Background services
  // Answer anything that arrived while the process was down.
  if (tg.isConnected()) {
    runtime
      .catchUp()
      .then((r) => {
        if (r && r.queued) log.info(`Javobsiz qolgan ${r.queued} ta suhbatga javob berilmoqda`);
        else if (r && r.pending === 0) log.info('Javobsiz qolgan xabar yoʻq');
      })
      .catch((err) => log.warn('catchUp failed', { error: err.message }));
  }

  startWatchdog();
  startPresence();
  startLocalModelWatch();
  startMaintenance();
  startRetrainSchedule();
  await maybeBootstrapTraining();

  const health = keyPool.health();
  const totalKeys = Object.values(health).reduce((n, v) => n + (v && typeof v === 'object' ? v.total : 0), 0);
  if (!totalKeys) log.warn('AI kalitlari yo\'q → admin panelda "AI kalitlar" bo\'limiga qo\'shing');

  log.info('─────────────────────────────────────────────');
  log.info(`Admin panel: http://${config.admin.host}:${config.admin.port}`);
  log.info(`Telegram: ${tg.status} · AI kalitlar: ${totalKeys} · Bilim: ${db.prepare('SELECT COUNT(*) AS c FROM knowledge').get().c} hujjat`);
  log.info('Agent tayyor. 24/7 rejimda ishlamoqda.');
  log.info('─────────────────────────────────────────────');
  recordEvent('system', 'Agent started', { keys: totalKeys, telegram: tg.status });
}

// ── graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} qabul qilindi — to'xtatilmoqda…`);
  recordEvent('system', 'Agent stopping', { signal });

  for (const t of timers) clearInterval(t);
  tasks.stop();
  projects.stopAll();
  if (httpServer) await new Promise((r) => httpServer.close(r)).catch(() => {});
  try {
    if (tg.isConnected()) await tg.setOnline(false);
  } catch {
    /* best effort */
  }
  try {
    if (tg.client && tg.client.connected) await tg.client.disconnect();
  } catch {
    /* best effort */
  }
  try {
    db.close();
  } catch {
    /* best effort */
  }
  log.info('To\'xtatildi. Xayr! 👋');
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { error: err.message, stack: err.stack });
  recordEvent('system', 'Uncaught exception', { error: err.message }, 'error');
  // Keep running: a single bad message must never take the agent down.
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  log.error('unhandledRejection', { error: msg });
  recordEvent('system', 'Unhandled rejection', { error: msg }, 'error');
});

main().catch((err) => {
  log.fatal('Ishga tushirishda halokatli xato', { error: err.message, stack: err.stack });
  process.exit(1);
});
