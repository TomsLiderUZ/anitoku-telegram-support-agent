'use strict';
/**
 * One-shot bootstrap: creates the admin account, seeds knowledge + base skills,
 * imports any API keys found in .env, and prints the panel URL.
 * Safe to re-run — everything is idempotent.
 */
const config = require('../src/config');
const { createLogger } = require('../src/core/logger');
const { db } = require('../src/core/db');
const keyPool = require('../src/ai/keyPool');
const seed = require('../src/knowledge/seed');
const skills = require('../src/agent/skills');
const auth = require('../src/admin/auth');

const log = createLogger('setup');

function run() {
  log.info('ANITOKU Support Agent — setup');

  const created = auth.ensureAdmin();
  if (created) log.info(`Admin: ${created.username}${created.password ? ` / ${created.password}` : ' (parol .env dan)'}`);
  else log.info('Admin allaqachon mavjud');

  const k = seed.run();
  log.info(`Bilim bazasi: ${k.documents} hujjat, ${k.qaPairs} savol-javob`);

  const n = skills.ensureBaseSkills();
  log.info(`Ko'nikmalar: ${n ? n + ' ta o\'rnatildi' : 'allaqachon mavjud'}`);

  const blob = [process.env.OPENROUTER_KEYS || '', process.env.GROQ_KEYS || ''].filter(Boolean).join('\n');
  if (blob) {
    const out = keyPool.importKeys(blob);
    log.info(`AI kalitlar: ${out.added} qo'shildi, ${out.skipped} takror, ${out.invalid} yaroqsiz`);
  }

  const health = keyPool.health();
  for (const [p, v] of Object.entries(health)) {
    if (v && typeof v === 'object') log.info(`  ${p}: ${v.available}/${v.total} faol`);
  }

  log.info('─────────────────────────────────────────────');
  log.info(`Tayyor. Ishga tushiring:  npm start`);
  log.info(`Admin panel: http://${config.admin.host}:${config.admin.port}`);
  log.info('─────────────────────────────────────────────');
  db.close();
}

run();
