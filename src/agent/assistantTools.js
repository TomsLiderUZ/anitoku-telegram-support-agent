'use strict';
const { db, settings } = require('../core/db');
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');
const store = require('../knowledge/store');
const memoryFacts = require('./memoryFacts');
const contacts = require('./contacts');
const tasks = require('./tasks');
const botfather = require('./botfather');
const { parseWhen, fmtTashkent } = require('./timeparse');
const ingest = require('../knowledge/ingest');

const log = createLogger('assistant:tools');

/**
 * What the assistant can DO for the founder. Every tool acts on the real
 * account, so this executor is only ever constructed for a verified founder
 * message — never for a customer.
 */
const definitions = [
  {
    type: 'function',
    function: {
      name: 'send_message',
      description:
        "Telegramda kimgadir xabar yuborish. `to` — ism, @username, telefon, guruh nomi yoki chat ID boʻlishi mumkin. Asoschi 'X ga yoz', 'X ga ayt', 'X ga xabar ber' desa shu vositani ishlat. Matnni asoschi aytgan maʼnoda, lekin tabiiy va toʻliq jumla qilib yoz.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Qabul qiluvchi: ism / @username / telefon / guruh nomi / ID' },
          text: { type: 'string', description: 'Yuboriladigan xabar matni' },
        },
        required: ['to', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_message',
      description:
        "Kelajakdagi vaqtga xabar rejalashtirish. Asoschi 'soat 15 da X ga yoz', 'ertaga ertalab X ga eslat', '2 soatdan keyin X ga ayt' desa ishlat. `when` — asoschi aytgan vaqt ifodasi, oʻzgartirmasdan.",
      parameters: {
        type: 'object',
        properties: {
          when: { type: 'string', description: "Vaqt ifodasi: 'soat 15:00 da', 'ertaga 9 da', '30 daqiqadan keyin'" },
          to: { type: 'string', description: 'Qabul qiluvchi' },
          text: { type: 'string', description: 'Xabar matni' },
        },
        required: ['when', 'to', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description:
        "Kelajakda bajariladigan HAR QANDAY koʻrsatmani rejalashtirish (xabar emas, ish): 'ertaga treningni qayta ishga tushir', 'soat 18 da guruhni tekshirib menga hisobot ber'. Belgilangan vaqtda yordamchi koʻrsatmani oʻzi bajaradi.",
      parameters: {
        type: 'object',
        properties: {
          when: { type: 'string' },
          instruction: { type: 'string', description: 'Bajarilishi kerak boʻlgan koʻrsatma, toʻliq' },
        },
        required: ['when', 'instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: "Faktni doimiy xotiraga saqlash. Asoschi 'eslab qol', 'yodda tut' desa — MAJBURIY ishlat. Fakt hamma chatlarda va support javoblarida ishlatiladi.",
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string' }, tags: { type: 'string', description: 'vergul bilan, ixtiyoriy' } },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: "Xotiradan faktni oʻchirish. Asoschi 'unut', 'esdan chiqar' desa ishlat.",
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Unutiladigan fakt yoki uning kalit soʻzi' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memory',
      description: 'Xotiradagi barcha faktlarni koʻrsatish.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_knowledge',
      description: "Mijozlarga javob berishda ishlatiladigan bilim bazasiga fakt qoʻshish. Asoschi 'bilim bazangga qoʻsh', 'mijozlarga shuni ayt' desa ishlat.",
      parameters: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_contact',
      description: 'Odam yoki guruhni ism/username/telefon boʻyicha topish va kimligini aniqlash.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_chat',
      description: "Biror chatning soʻnggi xabarlarini oʻqish. 'X bilan nima gaplashdik', 'guruhda nima boʻlyapti', 'X nima yozdi' kabi soʻrovlarda ishlat.",
      parameters: { type: 'object', properties: { chat: { type: 'string' }, limit: { type: 'integer', description: 'nechta xabar, standart 30' } }, required: ['chat'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forward_message',
      description: 'Bir chatdagi xabarni boshqa chatga forward qilish.',
      parameters: {
        type: 'object',
        properties: { from_chat: { type: 'string' }, message_id: { type: 'integer' }, to: { type: 'string' } },
        required: ['from_chat', 'message_id', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_bot',
      description:
        "BotFather orqali yangi Telegram bot yaratish va tokenini olish. Asoschi 'bot yarat', 'bot ochib ber' desa ishlat. Username lotin harflari, kamida 5 belgi va 'bot' bilan tugashi shart — asoschi aytmasa oʻzing mos nom tanla.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Botning koʻrinadigan nomi" },
          username: { type: 'string', description: "@username, 'bot' bilan tugaydi" },
          description: { type: 'string', description: 'Bot tavsifi (ixtiyoriy)' },
          about: { type: 'string', description: 'Qisqa "about" matni (ixtiyoriy)' },
        },
        required: ['name', 'username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'configure_bot',
      description: 'Mavjud botning nomi, tavsifi, about matni yoki buyruqlar roʻyxatini BotFather orqali oʻzgartirish.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          about: { type: 'string' },
          commands: { type: 'string', description: "Har qatorda 'buyruq - tavsif'" },
        },
        required: ['username'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'talk_to_bot',
      description:
        "Boshqa botga xabar yuborib, javobini olish. Asoschi 'X botdan Y ni soʻra', 'X botni ishlatib Y qil' desa ishlat. Bot bir necha qadam talab qilsa, vositani ketma-ket chaqir.",
      parameters: {
        type: 'object',
        properties: { bot: { type: 'string', description: '@username' }, text: { type: 'string' }, wait_seconds: { type: 'integer', description: 'javobni kutish, standart 15' } },
        required: ['bot', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Rejalashtirilgan va bajarilgan vazifalar roʻyxati.',
      parameters: { type: 'object', properties: { status: { type: 'string', description: 'pending | done | failed | cancelled | (boʻsh = hammasi)' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Rejalashtirilgan vazifani bekor qilish.',
      parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Bilim bazasidan qidirish (mijozlarga beriladigan maʼlumot).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agent_status',
      description: 'Agentning hozirgi holati: Telegram, kalitlar, bilim, vazifalar, bugungi javoblar.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_training',
      description: "Oʻz-oʻzini trening jarayonini ishga tushirish (chatlarni qayta oʻqish, koʻnikmalarni yangilash).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_setting',
      description: "Agent sozlamasini oʻzgartirish. Ruxsat etilgan: reply_in_groups, reply_to_private, typing_simulation, keep_online, quiet_hours, min_delay_ms, max_delay_ms, max_replies_per_chat_hour, temperature, primary_provider.",
      parameters: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
    },
  },
];

const SETTABLE = new Set([
  'reply_in_groups', 'reply_to_private', 'typing_simulation', 'keep_online', 'quiet_hours',
  'min_delay_ms', 'max_delay_ms', 'max_replies_per_chat_hour', 'temperature', 'primary_provider',
]);

/** Does the founder's message contain an instruction to send/tell/write? */
const founderAskedToSend = (text) =>
  /(\byoz\b|yozib\s*(qo['‘’ʻ]?y|ber)|yubor|jo['‘’ʻ]?nat|\bayt\b|aytib\s*(qo['‘’ʻ]?y|ber)|xabar\s*(ber|qil|yubor)|eslat|deb\s*(yoz|ayt|yubor)|напиши|отправь|скажи|передай|\bsend\b|\bwrite\b|\btell\b|\bmessage\b)/i.test(
    String(text || '')
  );

function createExecutor(ctx) {
  const used = [];

  async function sendTo(to, text) {
    const r = await contacts.resolve(to);
    const sent = await tg.client.sendMessage(r.entity, { message: String(text), linkPreview: false });
    const chatId = String(r.entity.id);
    if (sent) ingest.saveMessage(chatId, sent, { isAgent: true });
    log.info('xabar yuborildi', { to: contacts.displayName(r.contact) || to, chars: String(text).length });
    return { ok: true, sentTo: contacts.displayName(r.contact) || to, chatId, messageId: Number(sent.id) };
  }

  async function execute(name, args) {
    used.push(name);
    log.debug('tool', { name, args });

    switch (name) {
      case 'send_message': {
        // Sending is irreversible and visible to a real person. It happens only
        // when the founder's own words asked for it — a model that decides to
        // "helpfully" message someone after a "who is X?" question is blocked here.
        if (!founderAskedToSend(ctx.text)) {
          log.warn('send_message blocked: founder did not ask to send', { to: args.to });
          return { ok: false, error: "Asoschi xabar yuborishni soʻramadi — bu savol edi, buyruq emas. Xabar yuborilmadi." };
        }
        return sendTo(args.to, args.text);
      }

      case 'schedule_message': {
        const when = parseWhen(args.when);
        if (!when) return { ok: false, error: `Vaqtni tushunmadim: "${args.when}". Masalan: "soat 15:00 da", "ertaga 9 da", "30 daqiqadan keyin"` };
        const id = tasks.create({
          kind: 'send_message',
          title: `${args.to} ga xabar`,
          payload: { to: args.to, text: args.text },
          runAt: when.at.getTime(),
          originChat: ctx.chatId,
          originMsg: ctx.msgId,
        });
        return { ok: true, taskId: id, runAt: fmtTashkent(when.at), message: `Rejalashtirildi: ${fmtTashkent(when.at)} da ${args.to} ga yuboriladi.` };
      }

      case 'schedule_task': {
        const when = parseWhen(args.when);
        if (!when) return { ok: false, error: `Vaqtni tushunmadim: "${args.when}"` };
        const id = tasks.create({
          kind: 'assistant_run',
          title: String(args.instruction).slice(0, 80),
          payload: { instruction: args.instruction, chatId: ctx.chatId },
          runAt: when.at.getTime(),
          originChat: ctx.chatId,
          originMsg: ctx.msgId,
        });
        return { ok: true, taskId: id, runAt: fmtTashkent(when.at) };
      }

      case 'remember':
        return memoryFacts.remember({ fact: args.fact, tags: args.tags || null, sourceChat: ctx.chatId, sourceMsg: ctx.msgId });

      case 'forget':
        return { ok: true, removed: memoryFacts.forget(args.query) };

      case 'list_memory':
        return { facts: memoryFacts.list({ limit: 100 }).map((f) => ({ id: f.id, fact: f.fact, at: f.created_at })) };

      case 'add_knowledge': {
        const id = store.upsert({ source: 'founder', title: args.title || null, content: args.content, tags: 'founder', weight: 2.5 });
        return { ok: !!id, id };
      }

      case 'find_contact': {
        try {
          const r = await contacts.resolve(args.query);
          const c = r.contact || {};
          const shape = (x) => ({ id: x.tg_id, name: contacts.displayName(x), username: x.username || null, kind: x.kind });
          return {
            found: true,
            id: String(r.entity.id),
            name: contacts.displayName(c),
            username: c.username || r.entity.username || null,
            kind: c.kind,
            phone: c.phone || null,
            confidence: r.confidence,
            alternatives: (r.alternatives || []).map(shape),
          };
        } catch (err) {
          const near = contacts.searchCache(args.query, 5).map((c) => ({ id: c.tg_id, name: contacts.displayName(c), username: c.username }));
          return { found: false, error: err.message, suggestions: near };
        }
      }

      case 'read_chat': {
        const r = await contacts.resolve(args.chat);
        const limit = Math.min(80, Number(args.limit) || 30);
        const msgs = await tg.client.getMessages(r.entity, { limit });
        return {
          chat: contacts.displayName(r.contact) || args.chat,
          messages: msgs
            .reverse()
            .filter((m) => m.message)
            .map((m) => ({ id: Number(m.id), from: m.out ? 'men' : (m.sender && (m.sender.firstName || m.sender.username)) || 'nomaʼlum', at: new Date(Number(m.date) * 1000).toISOString().slice(0, 16), text: String(m.message).slice(0, 400) })),
        };
      }

      case 'forward_message': {
        const from = await contacts.resolve(args.from_chat);
        const to = await contacts.resolve(args.to);
        await tg.client.forwardMessages(to.entity, { messages: [Number(args.message_id)], fromPeer: from.entity });
        return { ok: true, forwardedTo: contacts.displayName(to.contact) };
      }

      case 'create_bot':
        return botfather.createBot({ name: args.name, username: args.username, description: args.description || null, about: args.about || null });

      case 'configure_bot':
        return botfather.configureBot({ username: args.username, name: args.name || null, description: args.description || null, about: args.about || null, commands: args.commands || null });

      case 'talk_to_bot': {
        const r = await botfather.talk(args.bot, args.text, { waitMs: Math.min(60, Number(args.wait_seconds) || 15) * 1000 });
        return { ok: true, replies: r.replies, text: r.text || '(bot javob bermadi)' };
      }

      case 'list_tasks':
        return {
          tasks: tasks.list({ status: args.status || null, limit: 40 }).map((t) => ({
            id: t.id, kind: t.kind, title: t.title, status: t.status, runAt: fmtTashkent(t.run_at), error: t.error || undefined,
          })),
        };

      case 'cancel_task':
        return { ok: tasks.cancel(args.id) };

      case 'search_knowledge': {
        const docs = store.search(args.query, 5);
        return { results: docs.map((d) => ({ title: d.title, content: String(d.content).slice(0, 500) })) };
      }

      case 'agent_status': {
        const keyPool = require('../ai/keyPool');
        const runtime = require('./runtime');
        const h = keyPool.health();
        const snap = runtime.snapshot();
        return {
          telegram: tg.status,
          keys: Object.fromEntries(Object.entries(h).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, `${v.available}/${v.total}`])),
          knowledge: store.stats().documents,
          memoryFacts: memoryFacts.list({ limit: 1000 }).length,
          pendingTasks: tasks.list({ status: 'pending' }).length,
          replies24h: snap.replies24h,
          paused: snap.paused,
        };
      }

      case 'run_training': {
        const selfTrain = require('../training/selfTrain');
        if (selfTrain.state.running) return { ok: false, error: 'trening allaqachon ishlamoqda' };
        selfTrain.run().catch(() => {});
        return { ok: true, message: 'Trening boshlandi, bir necha daqiqa davom etadi.' };
      }

      case 'set_setting': {
        if (!SETTABLE.has(args.key)) return { ok: false, error: `"${args.key}" ni bu yerdan oʻzgartirib boʻlmaydi` };
        settings.set(args.key, String(args.value));
        return { ok: true, key: args.key, value: String(args.value) };
      }

      default:
        return { error: `nomaʼlum vosita: ${name}` };
    }
  }

  return { execute, used };
}

module.exports = { definitions, createExecutor };
