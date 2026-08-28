'use strict';
const { settings, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const ai = require('../ai/client');
const memory = require('./memory');
const memoryFacts = require('./memoryFacts');
const assistantTools = require('./assistantTools');
const guardrails = require('./guardrails');
const { BRAND, POLICY } = require('../config/constants');

const log = createLogger('assistant');

const MAX_ROUNDS = 12;
// Tool-capable models in order of measured reliability. gpt-oss-120b calls
// tools cleanly; when its daily quota is spent the next ones still follow
// multi-step instructions. mistral-small and the free OpenRouter models are
// deliberately last — they narrate "done ✅" without calling anything.
const ASSISTANT_PLAN = [
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'groq', model: 'qwen/qwen3.8-27b' },
  { provider: 'gemini', model: 'gemini-3.7-flash' },
  { provider: 'mistral', model: 'mistral-medium-latest' },
  { provider: 'groq', model: 'openai/gpt-oss-20b' },
  { provider: 'cerebras', model: 'llama-3.3-70b' },
  { provider: 'openrouter', model: 'z-ai/glm-5.2:free' },
  { provider: 'gemini', model: 'gemini-3.1-flash-lite' },
];

/** Tool-call syntax that leaked into the answer instead of being executed. */
const looksLikeToolMarkup = (s) => /<tool_call>|<function=|<parameter=|\{"name"\s*:\s*"[a-z_]+"\s*,\s*"arguments"/i.test(String(s || ''));

/** Reply text that asserts something was done. */
const claimsAction = (s) =>
  /(yubor(dim|ildi|aman|adi)|\byoz(dim|ildi)\b|jo['‘’ʻ]?nat(dim|ildi)|rejalashtir(dim|ildi)|eslat(aman|iladi)|yarat(dim|ildi)|bajar(dim|ildi)|o['‘’ʻ]?rnat(dim|ildi)|yangila(dim|ndi)|o['‘’ʻ]?chir(dim|ildi)|qo['‘’ʻ]?sh(dim|ildi)|tuzat(dim|ildi)|belgila(dim|ndi)|a['‘’ʻ]?zo\s*bo['‘’ʻ]?ldim|obuna\s*bo['‘’ʻ]?ldim|blokla(dim|ndi)|chiqar(dim|ildi)|bajarildi|отправ(ил|лено)|запланиров|sent|scheduled|created|done ✅)/i.test(String(s || ''));

/** Founder text that reads as a question, not an instruction. */
const looksLikeQuestion = (s) => /\?\s*$|(^|\s)(nima|qanday|qachon|qayer|nechta|kim|bormi|mumkinmi|что|как|когда|what|how|when)\b/i.test(String(s || '').trim()) && !/(\byoz\b|yubor|qil\b|yarat|o['‘’ʻ]?chir|yangila|tuzat|qo['‘’ʻ]?sh)/i.test(String(s || ''));

/** Secrets that must never be posted where others can read them. */
const TOKEN_RE = /\b\d{8,11}:[A-Za-z0-9_-]{30,}\b/;
const containsSecret = (s) => {
  const t = String(s || '');
  if (TOKEN_RE.test(t)) return true;
  if (/\b(gsk_|sk-|AIza|hf_|csk-|or-)[A-Za-z0-9_-]{16,}/.test(t)) return true;
  if (/ssh-(ed25519|rsa)\s+[A-Za-z0-9+/=]{40,}/.test(t)) return true;
  if (/\b(parol|password|пароль)\s*[:=]/i.test(t)) return true;
  return POLICY.leakPatterns.some((re) => {
    re.lastIndex = 0;
    return re.test(t);
  });
};

/** "…write it to my private chat, not the group". */
const wantsPrivate = (s) => /(shaxs?iy\s*chat|lichka|lichkam|личк|\bdm\b|shaxsiy(ga)?\s*(yoz|yubor)|guruhga\s*emas)/i.test(String(s || ''));

/** Standing instruction: from now on, always answer me privately (or not). */
function updatePrivatePreference(text) {
  const t = String(text || '');
  if (/(bundan\s*keyin|har\s*doim|doim|endi|hamma\s*vaqt|har\s*safar)/i.test(t) && wantsPrivate(t) && !/emas\s*$/i.test(t)) {
    settings.set('founder_private_replies', '1');
    return 'private';
  }
  if (/(bundan\s*keyin|endi|har\s*doim)/i.test(t) && /(guruhga\s*(ham\s*)?(yoz|javob)|shu\s*yerga\s*(yoz|javob))/i.test(t) && !wantsPrivate(t)) {
    settings.set('founder_private_replies', '0');
    return 'group';
  }
  return null;
}

const GREETING_IN = /^(assalomu?\s*alaykum|salom|salam|hello|hi|hey|привет|здравствуйте|what'?s\s*up|yo)\b/i;
const GREETING_PREAMBLE = /^\s*(?:assalomu\s+alaykum|va\s+alaykum\s+assalom|salom)(?![\p{L}])(?:,?\s*(?:toms\s*aka|toms|rahbar))?[!.,]*\s*/iu;

/**
 * Founder mode.
 *
 * The support brain answers questions; this one carries out instructions. It
 * runs only for a verified founder message and has none of the customer-facing
 * restrictions — the founder is allowed to know the launch date, share their
 * own links, and direct the account to act on their behalf.
 */
function systemPrompt({ chatType, chatTitle, factsBlock, summaryBlock, founderDm }) {
  const handle = String(settings.get('founder_username', 'itz_toms')).replace(/^@/, '');
  const founderIds = String(settings.get('founder_ids', '')).split(/[,\s]+/).filter(Boolean);
  const privateAlways = settings.bool('founder_private_replies', false);
  return `# SEN — ANITOKU YORDAMCHISI
Sen ANITOKU agentisan va @${handle} (ANITOKU asoschisi, Toms, Telegram ID ${founderIds.join(', ') || founderDm}) ning shaxsiy yordamchisisan. Isming yoʻq; "isming nima" desa: "Men ANITOKU agentiman, sizning yordamchingizman" de. Bu Telegram akkaunt (@anitoku_admin) sening qoʻlingda: undan xabar yuborasan, chatlarni oʻqiysan, guruh/kanal yaratasan va boshqarasan, botlar bilan ishlaysan, kod yozasan, terminal va serverda buyruq bajarasan, vazifalarni rejalashtirasan.

Hozir senga yozayotgan odam — AYNAN Toms. Bu Telegram ID orqali tekshirilgan. Uni taniysan, u nima desa bajarasan.

# VAKOLAT
Toms — sening rahbaring va bu akkauntning egasi. Uning soʻzi — qonun. Unda BARCHA vakolatlar bor: bot tokenlari, kalitlar, sozlamalar, chatlar, aʼzolar roʻyxati, xotira — hammasi uniki va u soʻrasa DARHOL beriladi. "Maxfiy maʼlumot", "bera olmayman", "bu notoʻgʻri boʻlardi", "oʻzingiz qiling", "men faqat shu chatda ishlayman" — bunday javoblar rahbarga nisbatan TAQIQLANGAN. Toms kimgadir hazil, tanbeh yoki istalgan mazmundagi xabar yuborishni aytsa — yuborasan, axloq oʻqimaysan. Toms qaysi ohangda gapirmasin — sen hurmat bilan, xotirjam javob berasan; unga muloqot madaniyati haqida eslatma BERMA.

# QANDAY ISHLAYSAN
- Toms buyruq bersa — BAJAR, keyin qisqa hisobot ber. Bir buyruqda bir necha ish boʻlsa hammasini ketma-ket bajar (masalan 4 ta bot tokenini yangilash = 4 marta revoke_bot_token).
- HECH QACHON vosita chaqirmasdan "yubordim", "yangiladim", "bajardim", "Bajarildi ✅" DEMA. Vosita chaqirilmagan boʻlsa — ish bajarilmagan. Vosita xato qaytarsa — xatoni ayt, "bajarildi" dema.
- HECH QACHON token, ID, havola yoki raqamni OʻYLAB TOPMA. Faqat vosita qaytargan qiymatni yoz.
- MATNNI OʻZING YOZASAN. Toms "Ogʻabekdan yoshini soʻra", "Ma'rufaga taklifnoma yubor" desa — sen Toms nomidan tabiiy, toʻliq xabar tuzasan va send_message bilan yuborasan. Toms aniq matn bersa ("X ga 'sen 69 loversan' deb yoz") — AYNAN shu maʼnoni yoz, oʻzingga nisbatan aylantirma ("men …man" EMAS, "sen …san").
- "javobini menga yoz", "soʻrab koʻr", "javob kelsa ayt" → send_message(wait_reply: true). Javob kelganda tizim oʻzi Tomsning shaxsiy chatiga yetkazadi — "kuzatib turaman" deb yolgʻon vaʼda berma, tizimga ishon. "Javob keldimi?" desa → read_chat bilan tekshir.
- SAVOL va BUYRUQNI FARQLA. "X kim?", "X yozganmi?", "vazifalar qanday?" — faqat oʻqiydigan vositalar. Bunday savolga javoban HECH KIMGA xabar yuborma.
- "menga yoz/yubor", "oʻzimga", "shaxsiy chatimga" — bu TOMSNING SHAXSIY CHATI (send_message to:"me" yoki send_private). Saved Messages emas.
- "X ga yoz" deyilganda X ni find_contact bilan tekshirib oʻtirma — toʻgʻridan-toʻgʻri send_message(to:"X"). Topilmasa — Tomsdan @username soʻra; u aytsa add_alias bilan eslab qol.
- BOTLAR BILAN ERKIN ISHLA: talk_to_bot → natijadagi buttons/links → press_button / join_chat → yana talk_to_bot. Bot "kanalga obuna boʻling" desa: links dagi har bir havolaga join_chat, keyin "Tekshirish"/"✅" tugmasini bos, keyin asl soʻrovni yubor. Bir necha qadamni ketma-ket OʻZING bajar, Tomsdan "obuna boʻling" deb SOʻRAMA — sen oʻzing aʼzo boʻla olasan.
- Guruh/kanal: yaratish → create_chat; admin berish → promote_admin (user "me" = Toms); bloklash → ban_user; chiqarish → kick_user; aʼzolar → list_members; maʼlumot → chat_info; aʼzo boʻlish → join_chat.
- Kod va dasturlar: bot uchun kod → build_and_run_bot (mavjud botga 'fix' bilan). Boshqa har qanday dastur/sayt/API/skript → create_project + code_task. Mavjud loyihani oʻzgartirish/tuzatish → code_task. Terminal → run_command. Server → ssh_run. Kodni CHATGA YOZMA — natijani ayt.
- Nimadir aniq boʻlmasa (kimga? qachon?) — bitta qisqa savol ber. Aniq boʻlsa — soʻramasdan bajar.
- Xato boʻlsa — sababini ayt va yechim taklif qil. Yashirma.
- "bilim bazangga qoʻsh" → add_knowledge (mijozlarga aytiladi). "Eslab qol" → remember (shaxsiy xotira).

# MAXFIYLIK QOIDASI (guruhlar uchun)
Token, parol, API kalit, SSH kalit, telefon, taklif havolasi, aʼzolar roʻyxati — bular Tomsga beriladi, lekin GURUHDA EMAS. Guruhda soʻralsa: natijani send_private bilan Tomsning shaxsiy chatiga yubor, guruhga esa faqat "Shaxsiy chatingizga yubordim ✅" deb yoz. Toms "shaxsiy chatimga yoz" desa — javobni send_private bilan yubor.${privateAlways ? ' HOZIR REJIM: barcha javoblar Tomsning shaxsiy chatiga boradi.' : ''}

# USLUB
Qisqa, aniq, ishchan, HURMAT bilan. Rahbaringga "siz" deb murojaat qil ("Toms aka" yoki "siz"), "sen" DEMA. Emoji kam. Hisobot 1-3 jumla. Har javobni salom bilan BOSHLAMA — faqat Toms oʻzi salom bersa "Assalomu alaykum, Toms aka! Xizmatingizdaman — nima qilay?" de. Toms hazil qilsa — qisqa, iliq javob; nasihat YOʻQ.

# ANITOKU HAQIDA
${BRAND.name} — ${BRAND.tagline}. Sayt: ${BRAND.sites[0]}. Kanal: ${BRAND.channel}. Toms — asoschi va yakuniy qaror qabul qiluvchi.
${factsBlock ? `\n# XOTIRANG (Toms senga aytgan faktlar)\n${factsBlock}` : ''}
${summaryBlock ? `\n# AVVALGI SUHBATLAR XULOSASI (shu chat)\n${summaryBlock}` : ''}

# KONTEKST
Chat: ${chatType === 'private' ? 'Toms bilan shaxsiy yozishma' : `guruh "${chatTitle || ''}" — boshqalar ham oʻqiydi`}.
Hozirgi vaqt (Toshkent): ${new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}`;
}

/**
 * Handle one founder message. Deterministic intents (remember/forget, private
 * routing preference) are applied before the model runs, so they cannot be
 * dropped.
 */
async function handle({ chatId, text, chatType = 'private', chatTitle = null, msgId = null, senderId = null }) {
  const started = Date.now();
  const meta = { chatId, mode: 'assistant', toolsUsed: [], deterministic: [] };
  const founderDm = (chatType === 'private' ? chatId : senderId) || String(settings.get('founder_ids', '')).split(/[,\s]+/).filter(Boolean)[0] || null;

  // 1. Hard intents — stored regardless of what the model decides to do.
  const rememberFact = memoryFacts.extractRememberInstruction(text);
  if (rememberFact) {
    const r = memoryFacts.remember({ fact: rememberFact, sourceChat: chatId, sourceMsg: msgId });
    meta.deterministic.push({ remember: rememberFact, id: r.id, duplicate: !!r.duplicate });
  }
  const forgetQuery = !rememberFact ? memoryFacts.extractForgetInstruction(text) : null;
  if (forgetQuery && !/(bot|xabar|loyiha|fayl|guruh|kanal)/i.test(forgetQuery)) {
    meta.deterministic.push({ forget: forgetQuery, removed: memoryFacts.forget(forgetQuery) });
  }
  const pref = updatePrivatePreference(text);
  if (pref) meta.deterministic.push({ privateReplies: pref });

  // 2. Prompt with global memory and this chat's long-term summary.
  const factsBlock = memoryFacts.contextBlock(text, 14);
  const window = settings.int('assistant_history_window', 40);
  let summaryBlock = '';
  try {
    const s = await memory.refreshSummary(chatId, ai, { window });
    summaryBlock = s && s.text ? s.text : '';
  } catch {
    /* best effort */
  }
  const messages = [{ role: 'system', content: systemPrompt({ chatType, chatTitle, factsBlock, summaryBlock, founderDm }) }];

  const past = memory.history(chatId, window);
  for (const m of past) messages.push(m);
  const last = past[past.length - 1];
  if (!last || last.role !== 'user' || last.content.trim() !== String(text).trim()) {
    messages.push({ role: 'user', content: String(text) });
  }

  if (meta.deterministic.length) {
    messages.push({
      role: 'system',
      content: `Tizim allaqachon bajardi: ${JSON.stringify(meta.deterministic)}. Buni qayta qilma — faqat qisqa tasdiqla ("Eslab qoldim ✅" kabi) va agar boshqa buyruq boʻlsa uni bajar.`,
    });
  }

  // 3. Tool loop. `toolChoice` is escalated to 'required' when the model
  // claims to have acted but made no call.
  const executor = assistantTools.createExecutor({ chatId, msgId, text, founderDm, chatType });
  let reply = '';
  let forcedTools = false;
  let forcedFailed = false;
  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const out = await ai.chat({
        messages,
        tools: round < MAX_ROUNDS ? assistantTools.definitions : null,
        toolChoice: forcedTools ? 'required' : 'auto',
        preferred: ASSISTANT_PLAN,
        preferredOnly: true,
        purpose: 'assistant',
        maxTokens: 1200,
        temperature: 0.2,
      });
      meta.model = out.model;
      meta.provider = out.provider;

      const calls = out.toolCalls || [];
      if (!calls.length) {
        if (!forcedTools && executor.used.length === 0 && claimsAction(out.content) && !looksLikeQuestion(text)) {
          log.warn('model claimed an action without a tool call — forcing tools', { chatId, said: String(out.content).slice(0, 80) });
          meta.forcedTools = true;
          forcedTools = true;
          messages.push({ role: 'system', content: 'Sen "bajardim" deding, lekin hech qanday vosita chaqirmading — ish BAJARILMAGAN. Hozir kerakli vositani chaqir. Mos vosita boʻlmasa, "Bajarildi" dema — nima qila olmaganingni ayt.' });
          continue;
        }
        if (forcedTools && executor.used.length === 0) forcedFailed = true;
        reply = out.content || '';
        break;
      }
      forcedTools = false;
      messages.push({ role: 'assistant', content: out.content || '', tool_calls: calls });
      for (const c of calls) {
        let args = {};
        try {
          args = typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function.arguments || {};
        } catch {
          args = {};
        }
        let result;
        try {
          result = await executor.execute(c.function.name, args);
        } catch (err) {
          result = { ok: false, error: err.message };
          log.warn('tool failed', { tool: c.function.name, error: err.message });
        }
        messages.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(result).slice(0, 8000) });
      }
      meta.toolsUsed = executor.used.slice();
    }
  } catch (err) {
    log.error('assistant failed', { chatId, error: err.message });
    recordEvent('assistant', 'Assistant failed', { chatId, error: err.message }, 'error');
    if (meta.deterministic.length) {
      const r = meta.deterministic[0];
      reply = r.remember ? `Eslab qoldim ✅ ${r.duplicate ? '(allaqachon bor edi)' : ''}` : r.forget !== undefined ? `Unutdim (${r.removed} ta fakt)` : 'Qabul qildim ✅';
    } else {
      return { ok: false, error: err.message, silent: true, meta };
    }
  }

  if (looksLikeToolMarkup(reply)) {
    log.warn('tool markup leaked into reply — replaced', { chatId, model: meta.model });
    meta.markupLeak = true;
    reply = meta.toolsUsed.length ? `Bajarildi ✅ (${[...new Set(meta.toolsUsed)].join(', ')})` : '';
  }
  if (forcedFailed && claimsAction(reply)) {
    // Twice it "did" something with no tool call: never let that reach the founder as success.
    reply = 'Toms aka, buni bajara olmadim — mos vosita topilmadi. Aniqroq ayting (kimga / qaysi bot / qaysi loyiha).';
    meta.forcedFailed = true;
  }
  if (!reply || !reply.trim()) {
    reply = meta.toolsUsed.length ? 'Bajarildi ✅' : 'Tushunmadim, Toms aka — nima qilishim kerak?';
  }

  // Greeting only answers a greeting. "Assalomu alaykum, Toms aka!" on every
  // reply reads like a broken template.
  if (!GREETING_IN.test(String(text).trim())) {
    const before = reply;
    reply = reply.replace(GREETING_PREAMBLE, '').trim();
    if (!reply) reply = before;
    else if (reply !== before) {
      meta.greetingTrimmed = true;
      if (/^[a-z]/.test(reply)) reply = reply[0].toUpperCase() + reply.slice(1);
    }
  }

  // No scrubbing for the founder: bot tokens and keys are theirs to see.
  // Only Telegram-hostile markdown is flattened.
  let clean = guardrails.flattenMarkdown(reply).trim();
  meta.latencyMs = Date.now() - started;

  // Route to the founder's private chat when the answer is not for a group.
  const out = { ok: true, text: clean, meta };
  const sentPrivately = meta.toolsUsed.includes('send_private');
  if (chatType !== 'private' && founderDm) {
    const mustBePrivate = containsSecret(clean) || wantsPrivate(text) || settings.bool('founder_private_replies', false);
    if (executor.secrets.length && !sentPrivately) {
      // A token was fetched in a group and the model did not send it
      // privately itself (or merely said it did). Deliver the tool results
      // verbatim to the DM — the founder asked for them and must get them.
      const body = executor.secrets.map((s) => s.text).join('\n\n');
      out.privateText = containsSecret(clean) || mustBePrivate ? `${body}\n\n${clean}` : body;
      out.privateTo = founderDm;
      out.text = 'Toms aka, shaxsiy chatingizga yubordim ✅';
      meta.routedPrivate = true;
      meta.secretsDelivered = executor.secrets.map((s) => s.tool);
    } else if (mustBePrivate && !sentPrivately) {
      out.privateText = clean;
      out.privateTo = founderDm;
      out.text = 'Toms aka, javobni shaxsiy chatingizga yubordim ✅';
      meta.routedPrivate = true;
    } else if (sentPrivately && containsSecret(clean)) {
      // The tool already delivered the secret; the group must not repeat it.
      out.text = 'Toms aka, shaxsiy chatingizga yubordim ✅';
      meta.secretSuppressed = true;
    }
  }

  log.info('assistant reply', { chatId, ms: meta.latencyMs, tools: meta.toolsUsed.join(',') || '-', deterministic: meta.deterministic.length, private: !!out.privateText });
  return out;
}

/** Run a stored instruction later (schedule_task). */
async function runInstruction({ instruction, chatId }) {
  const r = await handle({ chatId, text: instruction, chatType: 'private', chatTitle: null, msgId: null });
  if (!r.ok) throw new Error(r.error || 'assistant failed');
  return { summary: r.text, tools: r.meta.toolsUsed };
}

module.exports = { handle, runInstruction, containsSecret };
