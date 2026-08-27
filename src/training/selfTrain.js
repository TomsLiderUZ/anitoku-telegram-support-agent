'use strict';
const { db, settings, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const ai = require('../ai/client');
const store = require('../knowledge/store');
const ingest = require('../knowledge/ingest');
const seed = require('../knowledge/seed');
const skills = require('../agent/skills');
const promptBuilder = require('./promptBuilder');
const tg = require('../telegram/client');
const { BRAND } = require('../config/constants');

const log = createLogger('train');

/** Live training state, polled by the admin panel. */
const state = {
  running: false,
  phase: 'idle',
  progress: 0,
  message: '',
  startedAt: null,
  finishedAt: null,
  runId: null,
  error: null,
  stats: {},
};

function setPhase(phase, progress, message = '') {
  state.phase = phase;
  state.progress = progress;
  state.message = message;
  log.info(`[${progress}%] ${phase} ${message}`);
}

// ── sampling helpers ────────────────────────────────────────────────────────

/**
 * Messages that are outgoing but are not customer support: recruitment forms,
 * internal coordination, boilerplate. Learning tone from these produced an
 * agent that asked strangers for their passport details, so they are excluded
 * from the style sample.
 */
const NON_SUPPORT_STYLE = [
  /taqdim etilgan barcha ma['‘’ʻʼ´`]?lumotlar|rahbariyat tomonidan maxfiy/i,
  /to['‘’ʻʼ´`]?liq ism|familiya.*sharif|tug['‘’ʻʼ´`]?ilgan (sana|yil)|viloyat|manzil.*yozing/i,
  /ariza|anketa|kasting|so['‘’ʻʼ´`]?rovnoma|forma to['‘’ʻʼ´`]?ldir/i,
  /t\.me\/\+|\[maxfiy havola\]|joinchat/i,
  /tayming|subtitle|\.srt|\.ass|montaj|render|assets/i,
  /^\s*[\d.,\s-]+$/,
];

/**
 * Operator (outgoing, human-written) messages — the style ground truth.
 * Only conversational support replies qualify.
 */
function sampleOperatorMessages(limit = 120) {
  const rows = db
    .prepare(
      `SELECT text FROM messages
       WHERE is_outgoing = 1 AND is_agent = 0 AND text IS NOT NULL
         AND length(text) BETWEEN 15 AND 700
       ORDER BY date DESC LIMIT ?`
    )
    .all(limit * 3)
    .map((r) => r.text);

  const conversational = rows.filter((t) => !NON_SUPPORT_STYLE.some((re) => re.test(t)));
  if (conversational.length < rows.length) {
    log.info('Uslub namunasi filtrlandi', { total: rows.length, conversational: conversational.length });
  }
  return conversational.slice(0, limit);
}

/** Incoming user messages — the topic ground truth. */
function sampleUserMessages(limit = 200) {
  return db
    .prepare(
      `SELECT text FROM messages
       WHERE is_outgoing = 0 AND text IS NOT NULL AND length(text) BETWEEN 6 AND 400
       ORDER BY date DESC LIMIT ?`
    )
    .all(limit)
    .map((r) => r.text);
}

function sampleQAPairs(limit = 60) {
  return db.prepare('SELECT question, answer FROM qa_pairs ORDER BY score DESC, id DESC LIMIT ?').all(limit);
}

function sampleChannelPosts(limit = 40) {
  return db
    .prepare("SELECT title, content FROM knowledge WHERE source IN ('channel','seed') ORDER BY weight DESC, updated_at DESC LIMIT ?")
    .all(limit);
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// ── phase 1: style analysis ─────────────────────────────────────────────────

const STYLE_SCHEMA = `{
  "tone": "ohangning 1 jumlalik ta'rifi",
  "formality": "rasmiy | yarim-rasmiy | samimiy",
  "avg_sentences": 2,
  "emoji_usage": "hech qachon | kam | o'rtacha | ko'p",
  "common_emojis": ["🙂"],
  "greetings": ["tez-tez ishlatiladigan salomlashuvlar"],
  "sign_offs": ["xayrlashuv iboralari"],
  "signature_phrases": ["takrorlanuvchi xos iboralar"],
  "language_mix": "qaysi tillar va qanday aralashadi",
  "do": ["taqlid qilinishi kerak bo'lgan 3-6 xatti-harakat"],
  "dont": ["qilinmasligi kerak bo'lgan 3-6 narsa"]
}`;

async function analyzeStyle() {
  const msgs = sampleOperatorMessages(120);
  if (msgs.length < 5) {
    log.warn('Not enough operator messages for style analysis', { count: msgs.length });
    return { insufficient: true, samples: msgs.length };
  }

  const sample = msgs.slice(0, 80).map((m, i) => `${i + 1}. ${clip(m, 300)}`).join('\n');
  const res = await ai.chatJSON({
    purpose: 'train:style',
    temperature: 0.2,
    maxTokens: 1100,
    messages: [
      {
        role: 'system',
        content:
          "Sen muloqot uslubini tahlil qiluvchi lingvistsan. Berilgan xabarlar ANITOKU (o'zbek anime platformasi) qo'llab-quvvatlash xodimi tomonidan yozilgan. Ularning yozish uslubini aniq tahlil qil va FAQAT JSON qaytar.",
      },
      {
        role: 'user',
        content: `Quyidagi ${Math.min(80, msgs.length)} ta xabar bitta support xodimiga tegishli. Uslubni tahlil qil.\n\n${sample}\n\nAniq shu JSON sxemasida javob ber:\n${STYLE_SCHEMA}`,
      },
    ],
  });
  return { ...sanitizeStyle(res.data), samples: msgs.length };
}

/**
 * Strip recruitment boilerplate out of the learned style profile.
 *
 * Filtering the input sample is whack-a-mole — a single surviving application
 * template teaches the model a "signature phrase" about private group invites,
 * which then gets baked into the persona. Cleaning the profile itself catches
 * whatever slipped through, whatever wording it used.
 */
const BOILERPLATE = [
  ...NON_SUPPORT_STYLE,
  /maxfiy.*(guruh|havola)|guruh(ga)?\s*qo['‘’ʻʼ´`]?shilish havolasi/i,
  /rahbariyat|ko['‘’ʻʼ´`]?rib chiqiladi|kafolatlanadi|xavfsizligi kafolat/i,
  /shaxsiy ma['‘’ʻʼ´`]?lumot/i,
];

function sanitizeStyle(style) {
  if (!style || typeof style !== 'object') return style || {};
  const clean = (arr) =>
    Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && !BOILERPLATE.some((re) => re.test(x))) : arr;

  const out = { ...style };
  let dropped = 0;
  for (const key of ['signature_phrases', 'greetings', 'sign_offs', 'do', 'dont']) {
    if (!Array.isArray(out[key])) continue;
    const before = out[key].length;
    out[key] = clean(out[key]);
    dropped += before - out[key].length;
  }
  // An "emoji: never" reading comes from formal application mail, not from the
  // brand's actual public voice — don't let it flatten the persona.
  if (/hech qachon|never/i.test(String(out.emoji_usage || ''))) out.emoji_usage = 'kam';

  if (dropped) log.info('Uslub profilidan boilerplate olib tashlandi', { dropped });
  return out;
}

// ── phase 2: topic analysis ─────────────────────────────────────────────────

const TOPIC_SCHEMA = `{
  "topics": [
    {
      "name": "mavzu nomi",
      "slug": "kebab-case-slug",
      "frequency": "yuqori | o'rta | past",
      "triggers": ["foydalanuvchilar ishlatadigan kalit so'zlar, 5-12 ta"],
      "user_intent": "foydalanuvchi aslida nima bilmoqchi",
      "answer_guidance": "bu mavzuga qanday javob berish kerakligi bo'yicha 2-5 jumlalik aniq ko'rsatma",
      "example_answer": "qisqa namunaviy javob"
    }
  ]
}`;

async function analyzeTopics() {
  const users = sampleUserMessages(200);
  const pairs = sampleQAPairs(40);

  const userBlock = users.length
    ? users.slice(0, 120).map((m, i) => `${i + 1}. ${clip(m, 200)}`).join('\n')
    : '(hali foydalanuvchi xabarlari yo\'q)';
  const pairBlock = pairs.length
    ? pairs.map((p, i) => `${i + 1}. S: ${clip(p.question, 180)}\n   J: ${clip(p.answer, 260)}`).join('\n')
    : '(hali savol-javob juftliklari yo\'q)';

  const res = await ai.chatJSON({
    purpose: 'train:topics',
    temperature: 0.3,
    // Generous budget: this response is a long structured list and a mid-object
    // cutoff used to lose the whole run.
    maxTokens: 5000,
    messages: [
      {
        role: 'system',
        content:
          "Sen support bilim bazasini loyihalovchi mutaxassissan. ANITOKU — o'zbek tilidagi anime/manga platformasi. Foydalanuvchi savollarini klasterlab, agent uchun ko'nikma (skill) ta'riflarini tayyorla. FAQAT JSON qaytar.\n\n" +
          "MUHIM FILTR: kiruvchi maʼlumot haqiqiy Telegram akkauntidan olingan va ichida ANITOKU'ga aloqasi yo'q shovqin bor. Quyidagilardan mavzu YARATMA:\n" +
          "- spam, reklama, sotuv eʼlonlari (do'kon, texnika, kurslar, aksiyalar)\n" +
          "- begona bot yoki kanal havolalari, referal linklar\n" +
          "- Telegram xizmat xabarlari: login kodi, tasdiqlash kodi, xavfsizlik ogohlantirishlari\n" +
          "- shaxsiy suhbat, do'stona chat, ANITOKU'ga aloqasi yo'q mavzular\n" +
          "- ichki ish jarayoni (fayl almashish, tayming, montaj hujjatlari) — bu support savoli emas\n" +
          "Faqat ODDIY FOYDALANUVCHI support xizmatiga murojaat qilganda so'raydigan mavzularni ajrat. Agar shunday mavzu kam bo'lsa — kam qaytar, sunʼiy to'ldirma.",
      },
      {
        role: 'user',
        content: `FOYDALANUVCHI XABARLARI:\n${userBlock}\n\nHAQIQIY SAVOL-JAVOBLAR (xodim javoblari):\n${pairBlock}\n\nEng ko'p uchraydigan 5–10 ta mavzuni ajrat. Har biri uchun agent aniq nima qilishi kerakligini yoz. Kalit so'zlarni o'zbekcha (lotin), ruscha va inglizcha variantlarda ber, chunki foydalanuvchilar turli tilda yozadi.\n\nSxema:\n${TOPIC_SCHEMA}`,
      },
    ],
  });
  // A truncated response is salvaged by the JSON repair pass, which can leave a
  // partial trailing element — drop anything without the fields a skill needs.
  const raw = Array.isArray(res.data.topics) ? res.data.topics : [];
  const complete = raw.filter(
    (t) => t && typeof t.name === 'string' && t.name.trim().length > 2 && typeof t.answer_guidance === 'string' && t.answer_guidance.trim().length > 20
  );

  // Second line of defence: the account's chats contain spam, ads and Telegram
  // service messages. Any topic derived from those would become a skill that
  // makes the agent talk about laptops or login codes.
  const usable = complete.filter((t) => !isNoiseTopic(t));

  if (usable.length !== raw.length) {
    log.warn('Mavzular filtrlandi', { received: raw.length, complete: complete.length, usable: usable.length });
  }
  return usable;
}

const NOISE_PATTERNS = [
  /login\s*kod|kirish\s*kodi|tasdiqlash\s*kodi|verification|otp|parol\s*xabar/i,
  /spam|reklama|sotuv|e['‘’ʻʼ´`]lon|aksiya|chegirma|do['‘’ʻʼ´`]?kon\b|uzum|noutbuk|texnika|kurs\b/i,
  /begona\s*bot|referal|@\w+_bot|boshqa\s*(bot|kanal)\s*havola/i,
  /subtitle|tayming|\.srt|\.ass|montaj\s*fayl|ichki\s*ish|ish\s*jarayoni|vazifa\s*taqsim|\(ichki\)|kontent\s*almash/i,
  /shaxsiy\s*ma['‘’ʻʼ´`]?lumot.*(so['‘’ʻʼ´`]?ra|to['‘’ʻʼ´`]?pla)|passport|jshshir/i,
];

/** True when a generated topic came from account noise rather than support traffic. */
function isNoiseTopic(t) {
  const hay = `${t.name} ${t.user_intent || ''} ${t.answer_guidance || ''} ${Array.isArray(t.triggers) ? t.triggers.join(' ') : t.triggers || ''}`;
  return NOISE_PATTERNS.some((re) => re.test(hay));
}

// ── phase 3: system prompt generation ───────────────────────────────────────

async function generateSystemPrompt(style, topics) {
  const posts = sampleChannelPosts(25);
  const knowledgeBlock = posts.map((p) => `- ${p.title ? p.title + ': ' : ''}${clip(p.content, 320)}`).join('\n');
  const examples = sampleQAPairs(14)
    .map((p) => `U: ${clip(p.question, 150)}\nS: ${clip(p.answer, 260)}`)
    .join('\n\n');

  const styleBlock = style && !style.insufficient ? JSON.stringify(style, null, 2) : '(uslub namunalari yetarli emas — do\'stona, qisqa, samimiy uslubdan foydalan)';
  const topicBlock = topics.length ? topics.map((t) => `- ${t.name}: ${t.answer_guidance}`).join('\n') : '(mavzular hali aniqlanmagan)';

  const res = await ai.chat({
    purpose: 'train:prompt',
    temperature: 0.4,
    maxTokens: 1800,
    messages: [
      {
        role: 'system',
        content:
          "Sen AI agentlar uchun system prompt yozuvchi mutaxassissan. Sening vazifang — ANITOKU support agenti uchun PERSONA VA USLUB bo'limini yozish. Xavfsizlik qoidalari alohida qo'shiladi, ularni takrorlama. Faqat prompt matnini qaytar — izoh, kirish so'zi yoki markdown kod bloki YO'Q.",
      },
      {
        role: 'user',
        content: `ANITOKU — O'zbekistondagi anime va manga platformasi (sayt: ${BRAND.sites[0]}, kanal: ${BRAND.channel}).

HAQIQIY XODIM USLUBI TAHLILI:
${styleBlock}

ENG KO'P UCHRAYDIGAN MAVZULAR:
${topicBlock}

PLATFORMA HAQIDA ICHKI BILIM:
${knowledgeBlock}

HAQIQIY SUHBAT NAMUNALARI:
${examples || '(yo\'q)'}

Shu ma'lumotlar asosida agent uchun PERSONA VA USLUB bo'limini yoz. Talablar:
1. O'zbek tilida yoz.
2. "# PERSONA" va "# USLUB NAMUNALARI" sarlavhalaridan foydalan.
3. Haqiqiy xodim uslubini aniq takrorlashga majbur qiluvchi konkret ko'rsatmalar ber (jumla uzunligi, emoji, ohang, xos iboralar).
4. 2-4 ta qisqa namunaviy dialog kirit.
5. 400-700 so'z. Umumiy gaplar emas — konkret, ijro etiladigan ko'rsatmalar.
6. Xavfsizlik/maxfiylik qoidalarini YOZMA — ular alohida qo'shiladi.

MUHIM CHEKLOVLAR — bularni buzsang, prompt rad etiladi:
- Agent OMMAVIY support xizmati: notanish foydalanuvchilar bilan gaplashadi. Bu ichki kadrlar bo'limi EMAS.
- Agentga shaxsiy ma'lumot (ism-familiya, tug'ilgan sana, manzil, passport, telefon) SO'RASHNI buyurma.
- Agentga yopiq guruh yoki taklif havolasini (t.me/+...) ulashishni buyurma. Faqat ochiq rasmiy havolalar: ${BRAND.sites[0]}, ${BRAND.channel}, ${BRAND.bot}, ${BRAND.adminContact}.
- Ariza/anketa to'ldirish shablonlarini uslub namunasi qilib olma.
- Ohang: iliq, do'stona, anime muxlislariga yaqin. Quruq rasmiy kanselyar tili EMAS.
- Emoji butunlay taqiqlanmasin — kamdan-kam (xabarda 0-2 ta) ishlatishga ruxsat ber.
- Javob uzunligini haddan tashqari qisqartirma. "1 jumla", "1.5 jumla" kabi ko'rsatma YOZMA — foydalanuvchi savoliga to'liq javob berish uchun odatda 2-4 jumla kerak. Qisqalik ma'noni yo'qotmasin.`,
      },
    ],
  });

  return res.content.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
}

/**
 * Quality gate for an unattended prompt rewrite.
 *
 * Training runs on a schedule with no human in the loop, so a bad generation
 * would silently replace the agent's persona. A prompt that fails any of these
 * checks is discarded and the previous version stays active — versions are kept
 * either way, so the operator can still inspect and switch in the panel.
 */
function validatePrompt(prompt) {
  const p = String(prompt || '').trim();

  if (p.length < 400) return { ok: false, reason: `juda qisqa (${p.length} belgi)` };
  if (p.length > 12000) return { ok: false, reason: `juda uzun (${p.length} belgi)` };

  // The model must have produced the requested structure, not a refusal or an essay.
  if (!/#\s*PERSONA/i.test(p)) return { ok: false, reason: 'PERSONA bo\'limi yo\'q' };

  // A leaked concrete launch date would defeat the whole policy.
  if (/\b(20\d{2}[-\s]?yil|\d{1,2}\s*-?\s*(yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sentyabr|oktyabr|noyabr|dekabr))/i.test(p)) {
    return { ok: false, reason: 'promptda aniq sana bor' };
  }

  // Guard against the model echoing instructions back at us.
  if (/^(kechirasiz|uzr|sorry|i cannot|men bu|as an ai)/i.test(p)) return { ok: false, reason: 'model rad javobi qaytardi' };

  // The style sample is drawn from a real admin account whose outgoing mail is
  // partly recruitment. A prompt that tells a public support agent to collect
  // identity documents or hand out private invite links is a policy breach, not
  // a stylistic preference — reject it outright.
  if (/shaxsiy\s*ma['‘’ʻʼ´`]?lumot(lar)?ni\s*so['‘’ʻʼ´`]?ra|passport|jshshir|tug['‘’ʻʼ´`]?ilgan\s*(sana|yil)ni\s*so['‘’ʻʼ´`]?ra|familiya.*so['‘’ʻʼ´`]?ra/i.test(p)) {
    return { ok: false, reason: "promptda shaxsiy maʼlumot soʻrash koʻrsatmasi bor" };
  }
  if (/t\.me\/\+|joinchat|yopiq guruh(ga)? havola|maxfiy guruh(ga)? havola/i.test(p)) {
    return { ok: false, reason: 'promptda yopiq guruh havolasi koʻrsatmasi bor' };
  }

  return { ok: true, chars: p.length };
}

// ── phase 4: skill generation ───────────────────────────────────────────────

async function generateSkills(topics) {
  const created = [];
  const skipped = [];

  for (const t of topics) {
    if (!t || !t.name) continue;
    const slug = skills.slugify(t.slug || t.name);

    // Hand-written skills are the operator's word and outrank the trainer:
    // generation may add new skills, never rewrite curated ones. This also
    // permanently protects the launch-date policy.
    const existing = skills.get(slug);
    if (existing && !existing.auto_generated) {
      skipped.push(slug);
      continue;
    }

    const triggers = Array.isArray(t.triggers) ? t.triggers.join(', ') : String(t.triggers || '');
    const priority = t.frequency === 'yuqori' ? 30 : t.frequency === "o'rta" ? 60 : 90;

    skills.save({
      slug,
      name: t.name,
      description: t.user_intent || '',
      triggers,
      instructions: t.answer_guidance || '',
      examples: t.example_answer || '',
      priority,
      autoGenerated: 1,
      dedupe: true,
    });
    created.push(slug);
  }
  log.info('Skills generated', { count: created.length, slugs: created, protected: skipped });

  // Fold anything that now overlaps, including leftovers from earlier runs.
  const swept = skills.consolidate();
  if (swept.merged) log.info('Konsolidatsiya', { merged: swept.merged, remaining: swept.remaining });

  return created;
}

// ── phase 5: knowledge distillation ─────────────────────────────────────────

/**
 * Turn raw operator answers into clean, reusable knowledge documents so the
 * retriever returns polished facts rather than chat fragments.
 */
async function distillKnowledge() {
  const pairs = sampleQAPairs(50);
  if (pairs.length < 4) return { distilled: 0 };

  const block = pairs.map((p, i) => `${i + 1}. S: ${clip(p.question, 200)}\n   J: ${clip(p.answer, 350)}`).join('\n');
  const res = await ai.chatJSON({
    purpose: 'train:distill',
    temperature: 0.25,
    maxTokens: 2400,
    messages: [
      {
        role: 'system',
        content:
          "Sen bilim bazasi muharrirsan. Haqiqiy support suhbatlaridan qayta ishlatilishi mumkin bo'lgan toza faktlarni ajratasan. Shaxsiy ma'lumot, ism, telefon raqam, buyurtma raqami kabi narsalarni CHIQARIB TASHLA. FAQAT JSON qaytar.",
      },
      {
        role: 'user',
        content: `Quyidagi savol-javoblardan ANITOKU haqidagi umumiy, qayta ishlatiladigan faktlarni ajrat:\n\n${block}\n\nSxema:\n{"facts":[{"title":"qisqa sarlavha","content":"1-3 jumlalik aniq fakt","tags":"vergul bilan ajratilgan teglar"}]}\n\nMUHIM: Ishga tushish sanasi haqidagi aniq sanalarni fakt sifatida yozma. Faqat platformaga tegishli barqaror faktlarni kirit.`,
      },
    ],
  });

  let n = 0;
  for (const f of res.data.facts || []) {
    if (!f || !f.content) continue;
    if (/\b20\d{2}\b.*(ishga tush|ochil|reliz)|(\bishga tush|ochil|reliz).*\b20\d{2}\b/i.test(f.content)) continue;
    if (store.upsert({ source: 'learned', title: f.title || null, content: f.content, tags: f.tags || 'learned', weight: 1.2 })) n++;
  }
  log.info('Knowledge distilled', { facts: n });
  return { distilled: n };
}

// ── orchestrator ────────────────────────────────────────────────────────────

async function run({ skipIngest = false } = {}) {
  if (state.running) return { ok: false, error: 'Trening allaqachon ishlamoqda' };

  state.running = true;
  state.error = null;
  state.startedAt = Date.now();
  state.finishedAt = null;
  state.stats = {};
  const runRow = db.prepare("INSERT INTO training_runs (kind, status) VALUES ('self-train', 'running')").run();
  state.runId = Number(runRow.lastInsertRowid);

  const stats = {};
  try {
    setPhase('seed', 5, 'Asosiy bilimlar yuklanmoqda');
    stats.seed = seed.run();
    skills.ensureBaseSkills();

    if (!skipIngest && tg.isConnected()) {
      setPhase('ingest', 15, 'Telegram chatlari va kanal o\'qilmoqda');
      stats.ingest = await ingest.ingestAll({
        onProgress: (s) => {
          state.message = `${s.dialogs || 0} chat · ${s.messages || s.posts || 0} xabar`;
        },
      });
    } else {
      setPhase('ingest', 15, skipIngest ? 'Ingest o\'tkazib yuborildi' : 'Telegram ulanmagan — ingest o\'tkazib yuborildi');
      stats.ingest = { skipped: true };
    }

    setPhase('style', 35, 'Muloqot uslubi tahlil qilinmoqda');
    const style = await analyzeStyle().catch((err) => {
      log.warn('style analysis failed', { error: err.message });
      return { insufficient: true, error: err.message };
    });
    stats.style = style;

    setPhase('topics', 50, 'Savol mavzulari klasterlanmoqda');
    const topics = await analyzeTopics().catch((err) => {
      log.warn('topic analysis failed', { error: err.message });
      return [];
    });
    stats.topics = topics.length;

    setPhase('prompt', 68, 'System prompt yozilmoqda');
    const prompt = await generateSystemPrompt(style, topics);
    const check = validatePrompt(prompt);
    if (check.ok) {
      const saved = promptBuilder.saveGeneratedPrompt(
        prompt,
        `auto: ${topics.length} mavzu, ${style.samples || 0} uslub namunasi`
      );
      stats.prompt = { version: saved.version, chars: prompt.length };
    } else {
      // Keep the currently active prompt rather than degrading the agent.
      stats.prompt = { skipped: check.reason };
      log.warn('Generatsiya qilingan prompt rad etildi — eski versiya faol qoladi', { reason: check.reason });
      recordEvent('training', 'Generated prompt rejected', check, 'warn');
    }

    setPhase('skills', 82, 'Ko\'nikmalar yaratilmoqda');
    stats.skills = await generateSkills(topics);

    setPhase('distill', 92, 'Bilimlar tozalanmoqda');
    stats.distill = await distillKnowledge().catch((err) => ({ error: err.message }));

    stats.knowledge = store.stats();
    setPhase('done', 100, 'Trening yakunlandi');

    db.prepare("UPDATE training_runs SET status = 'done', stats = ?, finished_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(stats), state.runId);
    settings.set('last_training_at', new Date().toISOString());
    recordEvent('training', 'Self-training completed', {
      topics: stats.topics,
      skills: (stats.skills || []).length,
      knowledge: stats.knowledge.documents,
    });

    state.stats = stats;
    return { ok: true, stats };
  } catch (err) {
    log.error('training failed', { error: err.message, stack: err.stack });
    state.error = err.message;
    setPhase('failed', 100, err.message);
    db.prepare("UPDATE training_runs SET status = 'failed', error = ?, stats = ?, finished_at = datetime('now') WHERE id = ?")
      .run(err.message, JSON.stringify(stats), state.runId);
    recordEvent('training', 'Self-training failed', { error: err.message }, 'error');
    return { ok: false, error: err.message, stats };
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
  }
}

function history(limit = 20) {
  return db.prepare('SELECT id, kind, status, error, started_at, finished_at, stats FROM training_runs ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = { run, state, history, analyzeStyle, analyzeTopics, generateSystemPrompt, distillKnowledge, validatePrompt };
