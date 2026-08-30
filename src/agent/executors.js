'use strict';
const tasks = require('./tasks');
const tg = require('../telegram/client');
const contacts = require('./contacts');
const ingest = require('../knowledge/ingest');
const botfather = require('./botfather');

/**
 * Executors for background tasks. Registered once at boot; each receives the
 * task payload and returns whatever should be recorded as the result.
 */
function register() {
  tasks.register('send_message', async ({ to, text }) => {
    if (!tg.isConnected()) throw new Error('Telegram ulanmagan');
    const r = await contacts.resolve(to);
    // Xizmat qatlami orqali: formatlash va rad etilganda oddiy matnga qaytish
    // shu yerda ham amal qilsin (assistantTools dagi bilan bir xil sabab).
    const sent = await tg.sendMessage(String(r.entity.id), String(text));
    if (sent) ingest.saveMessage(String(r.entity.id), sent, { isAgent: true });
    return { sentTo: contacts.displayName(r.contact) || to, messageId: Number(sent.id) };
  });

  tasks.register('assistant_run', async ({ instruction, chatId }) => {
    // Lazy require: assistant → assistantTools → tasks would otherwise be circular at load.
    const assistant = require('./assistant');
    return assistant.runInstruction({ instruction, chatId });
  });

  tasks.register('create_bot', async (payload) => botfather.createBot(payload));
}

module.exports = { register };
