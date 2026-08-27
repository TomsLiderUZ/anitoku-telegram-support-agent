'use strict';
/** Run one self-training pass from the CLI (headless servers / cron). */
const { createLogger } = require('../src/core/logger');
const tg = require('../src/telegram/client');
const selfTrain = require('../src/training/selfTrain');
const { db } = require('../src/core/db');

const log = createLogger('cli:train');

(async () => {
  const rec = tg.record();
  if (rec && rec.session_enc) {
    log.info('Telegramga ulanmoqda…');
    await tg.resume();
  } else {
    log.warn('Telegram sessiyasi yo\'q — faqat mavjud maʼlumot asosida trening');
  }

  const out = await selfTrain.run({ skipIngest: !tg.isConnected() });
  console.log(JSON.stringify(out, null, 2));

  try { if (tg.client) await tg.client.disconnect(); } catch {}
  db.close();
  process.exit(out.ok ? 0 : 1);
})();
