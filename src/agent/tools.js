'use strict';
const { db, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const store = require('../knowledge/store');
const { BRAND } = require('../config/constants');

const log = createLogger('agent:tools');

/** OpenAI-compatible tool definitions exposed to the model. */
const definitions = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        "ANITOKU bilim bazasida qidirish. Foydalanuvchi savoliga javob berish uchun aniq ma'lumot kerak bo'lganda ishlat. Platforma imkoniyatlari, narxlar, jamoa, texnik savollar bo'yicha.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Qidiruv so'rovi — foydalanuvchi savolining kalit so'zlari" },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_official_links',
      description: "ANITOKU rasmiy havolalarini olish (sayt, Telegram kanal, bot, admin kontakti).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        "Savolni ANITOKU rahbariyatiga (asoschilariga) yetkazish. Quyidagi hollarda ishlat: (1) savolga bilim bazasida javob yo'q va o'ylab topish xavfli, (2) shikoyat yoki jiddiy texnik nosozlik, (3) to'lov/hisob bilan bog'liq masala, (4) foydalanuvchi qaror yoki ruxsat so'rayapti, (5) foydalanuvchi aniq odam bilan gaplashishni so'radi. Bu vositani chaqirgach foydalanuvchiga: savolni rahbariyatga yetkazganingni va javob olinishi bilan xabar berishingni ayt.",
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Nima uchun rahbariyat kerakligi' },
          summary: { type: 'string', description: "Foydalanuvchi muammosining qisqa xulosasi" },
          question: { type: 'string', description: "Rahbariyatga beriladigan ANIQ savol — ular shunga javob yozadi" },
        },
        required: ['reason', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description:
        "Suhbatdan olingan yangi, umumiy ahamiyatga ega ANITOKU faktini bilim bazasiga saqlash. Shaxsiy ma'lumotni saqlama. Kamdan-kam ishlat.",
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: "1-2 jumlalik aniq fakt" },
          tags: { type: 'string', description: "Vergul bilan ajratilgan teglar" },
        },
        required: ['fact'],
      },
    },
  },
];

/** Execution context is injected per-call so tools know which chat they serve. */
function createExecutor(ctx) {
  const used = [];

  async function execute(name, args) {
    used.push(name);
    log.debug('tool call', { name, chatId: ctx.chatId, args });

    switch (name) {
      case 'search_knowledge': {
        const q = String(args.query || '').trim();
        if (!q) return { error: "query bo'sh" };
        const docs = store.search(q, 5);
        if (!docs.length) return { found: false, message: "Bilim bazasida bu bo'yicha ma'lumot topilmadi. O'ylab topma — aniqlashtirishni taklif qil yoki operatorga uzat." };
        return {
          found: true,
          results: docs.map((d) => ({ title: d.title, content: String(d.content).replace(/\s+/g, ' ').slice(0, 600) })),
        };
      }

      case 'get_official_links':
        return {
          website: BRAND.sites[0],
          mirror: BRAND.sites[1],
          channel: BRAND.channel,
          bot: BRAND.bot,
          admin: BRAND.adminContact,
        };

      case 'escalate_to_human': {
        const reason = String(args.reason || "noma'lum").slice(0, 500);
        const summary = String(args.summary || '').slice(0, 1000);
        const question = String(args.question || args.summary || ctx.userText || '').slice(0, 1000);

        // One open escalation per chat: repeated asks should not spam the founder.
        const open = db
          .prepare("SELECT id FROM escalations WHERE tg_chat_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
          .get(ctx.chatId);
        if (open) {
          ctx.escalated = { id: open.id, reason, summary, duplicate: true };
          return {
            ok: true,
            message:
              "Bu chat bo'yicha rahbariyatga allaqachon savol yuborilgan va javob kutilmoqda. Foydalanuvchiga: savoli yetkazilganini va javob kelishi bilan xabar berishingni ayt. Qayta yubormaysan.",
          };
        }

        const r = db
          .prepare('INSERT INTO escalations (tg_chat_id, chat_title, question, reason, draft) VALUES (?, ?, ?, ?, ?)')
          .run(ctx.chatId, ctx.chatTitle || null, question, reason, summary);
        db.prepare("UPDATE conversations SET escalated = 1, updated_at = datetime('now') WHERE tg_chat_id = ?").run(ctx.chatId);
        ctx.escalated = { id: Number(r.lastInsertRowid), reason, summary, question };
        recordEvent('escalation', 'Escalated to founders', { chatId: ctx.chatId, reason }, 'warn');
        log.info('escalated', { chatId: ctx.chatId, reason });
        return {
          ok: true,
          message:
            "Savol ANITOKU rahbariyatiga yuborildi. Endi foydalanuvchiga ayt: bu masalani rahbariyatga (ANITOKU asoschilariga) yetkazding va javob olinishi bilan shu yerda xabar berasan. Aniq muddat va'da qilma.",
        };
      }

      case 'remember_fact': {
        const fact = String(args.fact || '').trim();
        if (fact.length < 12) return { ok: false, error: 'fact juda qisqa' };
        if (/\b(\+998|\d{9,})\b/.test(fact)) return { ok: false, error: 'shaxsiy maʼlumot saqlanmaydi' };
        const id = store.upsert({ source: 'learned', sourceRef: ctx.chatId, content: fact, tags: args.tags || 'learned', weight: 0.9 });
        return { ok: !!id, id };
      }

      default:
        return { error: `noma'lum vosita: ${name}` };
    }
  }

  return { execute, used, ctx };
}

module.exports = { definitions, createExecutor };
