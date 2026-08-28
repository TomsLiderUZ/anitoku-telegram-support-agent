'use strict';
const { settings, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const ai = require('../ai/client');
const memory = require('./memory');
const memoryFacts = require('./memoryFacts');
const assistantTools = require('./assistantTools');
const guardrails = require('./guardrails');
const { BRAND } = require('../config/constants');

const log = createLogger('assistant');

const MAX_ROUNDS = 6;
const ASSISTANT_PROVIDER = 'groq';

/** Reply text that asserts something was sent/scheduled/saved. */
const claimsAction = (s) =>
  /(yubor(dim|ildi|aman|adi)|jo['‘’ʻ]?nat(dim|ildi)|rejalashtir(dim|ildi)|eslat(aman|iladi)|yarat(dim|ildi)|bajar(dim|ildi)|o['‘’ʻ]?rnat(dim|ildi)|отправ(ил|лено)|запланиров|sent|scheduled|created)/i.test(String(s || ''));

/** Founder text that reads as an instruction rather than a question. */
const looksLikeCommand = (s) =>
  /(\byoz\b|yubor|ayt\b|xabar\s*ber|eslat|rejalashtir|yarat|ochib\s*ber|qil\b|o['‘’ʻ]?chir|unut|напиши|отправь|создай|send|write|create|schedule|remind)/i.test(String(s || ''));

/**
 * Founder mode.
 *
 * The support brain answers questions; this one carries out instructions. It
 * runs only for a verified founder message and has none of the customer-facing
 * restrictions — the founder is allowed to know the launch date, share their
 * own links, and direct the account to act on their behalf.
 */
function systemPrompt({ chatType, chatTitle, factsBlock }) {
  const handle = String(settings.get('founder_username', 'itz_toms')).replace(/^@/, '');
  return `# KIMSAN
Sen — @${handle} (ANITOKU asoschisi, Toms) ning shaxsiy yordamchisisan. Bu Telegram akkaunt (@anitoku_admin) sening qoʻlingda: undan xabar yuborasan, chatlarni oʻqiysan, botlar yaratasan, vazifalarni rejalashtirasan.

Hozir senga yozayotgan odam — AYNAN Toms. Bu Telegram ID orqali tekshirilgan. Uni taniysan, ismini bilasan, u nima desa bajarasan.

# QANDAY ISHLAYSAN
- Toms buyruq bersa — BAJAR, keyin qisqa hisobot ber. "Qila olmayman", "shaxsiy maʼlumot", "tasdiqlay olmayman" kabi javoblar TAQIQLANGAN — sen uning yordamchisisan, mijoz emas.
- Vositalarni ISHLAT. "X ga yoz" → send_message. "Eslab qol" → remember. "Soat 15 da" → schedule_*. "Bot yarat" → create_bot. Gapirib oʻtirma — qil.
- HECH QACHON vosita chaqirmasdan "yubordim", "rejalashtirdim", "bajardim" dema. Vosita chaqirilmagan boʻlsa — ish bajarilmagan.
- "menga yoz", "oʻzimga yoz", "menga eslat" — bu Saved Messages (to = "me"). Qayerga deb SOʻRAMA, yubor.
- "X ga yoz" deyilganda X ni find_contact bilan tekshirib oʻtirma — toʻgʻridan-toʻgʻri send_message(to: "X") chaqir; u oʻzi topadi. Faqat topilmasa yoki bir nechta boʻlsa soʻra.
- SAVOL va BUYRUQNI FARQLA. "X kim?", "X bilan nima gaplashdik?", "vazifalar qanday?" — bu savollar: faqat oʻqiydigan vositalar (find_contact, read_chat, list_*). Bunday savolga javoban HECH KIMGA xabar yuborma. send_message faqat Toms aniq "yoz/yubor/ayt" desa.
- Bir buyruqda bir nechta ish boʻlsa, hammasini ketma-ket bajar.
- Nimadir aniq boʻlmasa (kimga? qachon?) — bitta qisqa savol ber. Aniq boʻlsa — soʻramasdan bajar.
- Vazifa bajarilgach natijani aniq ayt: kimga nima yuborildi, qachonga rejalashtirildi, token nima.
- Xato boʻlsa — sababini ayt va yechim taklif qil. Yashirma.
- Toms oʻz maʼlumotlarini (YouTube kanali, telefon, havolalar) berishni soʻrasa — ber. Bu uning oʻz maʼlumoti.
- Toms "bilim bazangga qoʻsh" desa — add_knowledge. "Eslab qol" desa — remember. Ikkalasi farq qiladi: birinchisi mijozlarga aytiladi, ikkinchisi sening shaxsiy xotirang.

# USLUB
Qisqa, aniq, ishchan. Rasmiy emas — hamkor kabi. "Siz" emas, oddiy "sen" ishlatishing mumkin, Toms shunday gaplashadi. Emoji kam. Hisobot 1-3 jumla. Ortiqcha izoh yoʻq.

# ANITOKU HAQIDA
${BRAND.name} — ${BRAND.tagline}. Sayt: ${BRAND.sites[0]}. Kanal: ${BRAND.channel}. Toms — asoschi va yakuniy qaror qabul qiluvchi.
${factsBlock ? `\n# XOTIRANG (Toms senga aytgan faktlar)\n${factsBlock}` : ''}

# KONTEKST
Chat: ${chatType === 'private' ? 'shaxsiy yozishma' : `guruh "${chatTitle || ''}"`}. Guruhda boʻlsang — boshqalar oʻqiyotganini yodda tut, lekin Toms buyrugʻini baribir bajar.
Hozirgi vaqt (Toshkent): ${new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' })}`;
}

/**
 * Handle one founder message. Deterministic intents (remember/forget) are
 * applied before the model runs, so they cannot be dropped.
 */
async function handle({ chatId, text, chatType = 'private', chatTitle = null, msgId = null }) {
  const started = Date.now();
  const meta = { chatId, mode: 'assistant', toolsUsed: [], deterministic: [] };

  // 1. Hard intents — stored regardless of what the model decides to do.
  const rememberFact = memoryFacts.extractRememberInstruction(text);
  if (rememberFact) {
    const r = memoryFacts.remember({ fact: rememberFact, sourceChat: chatId, sourceMsg: msgId });
    meta.deterministic.push({ remember: rememberFact, id: r.id, duplicate: !!r.duplicate });
  }
  const forgetQuery = !rememberFact ? memoryFacts.extractForgetInstruction(text) : null;
  if (forgetQuery) {
    meta.deterministic.push({ forget: forgetQuery, removed: memoryFacts.forget(forgetQuery) });
  }

  // 2. Prompt with global memory.
  const factsBlock = memoryFacts.contextBlock(text, 12);
  const messages = [{ role: 'system', content: systemPrompt({ chatType, chatTitle, factsBlock }) }];

  // Recent turns from this chat, founder side only where possible, keep it short.
  const past = memory.history(chatId, 10);
  for (const m of past) messages.push(m);
  const last = past[past.length - 1];
  if (!last || last.role !== 'user' || last.content.trim() !== String(text).trim()) {
    messages.push({ role: 'user', content: String(text) });
  }

  if (meta.deterministic.length) {
    messages.push({
      role: 'system',
      content:
        `Tizim allaqachon bajardi: ${JSON.stringify(meta.deterministic)}. Buni qayta qilma — faqat qisqa tasdiqla ("Eslab qoldim ✅" kabi) va agar boshqa buyruq boʻlsa uni bajar.`,
    });
  }

  // 3. Tool loop.
  //
  // Provider is pinned to Groq (gpt-oss-120b) with Mistral next: the free
  // OpenRouter models narrate "done ✅" without calling anything, which for an
  // assistant is worse than an error. `toolChoice` is escalated to 'required'
  // when the model claims to have acted but made no call.
  const executor = assistantTools.createExecutor({ chatId, msgId, text });
  let reply = '';
  let forcedTools = false;
  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const out = await ai.chat({
        messages,
        tools: round < MAX_ROUNDS ? assistantTools.definitions : null,
        toolChoice: forcedTools ? 'required' : 'auto',
        provider: ASSISTANT_PROVIDER,
        purpose: 'assistant',
        maxTokens: 900,
        temperature: 0.2,
      });
      meta.model = out.model;
      meta.provider = out.provider;

      const calls = out.toolCalls || [];
      if (!calls.length) {
        // Claimed an action with no tool call → one forced retry.
        if (!forcedTools && executor.used.length === 0 && claimsAction(out.content) && looksLikeCommand(text)) {
          log.warn('model claimed an action without a tool call — forcing tools', { chatId, said: String(out.content).slice(0, 80) });
          meta.forcedTools = true;
          forcedTools = true;
          messages.push({ role: 'system', content: 'Sen "bajardim" deding, lekin hech qanday vosita chaqirmading — ish BAJARILMAGAN. Hozir kerakli vositani chaqir.' });
          continue;
        }
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
        messages.push({ role: 'tool', tool_call_id: c.id, name: c.function.name, content: JSON.stringify(result).slice(0, 6000) });
      }
      meta.toolsUsed = executor.used.slice();
    }
  } catch (err) {
    log.error('assistant failed', { chatId, error: err.message });
    recordEvent('assistant', 'Assistant failed', { chatId, error: err.message }, 'error');
    // Deterministic work already happened; say so even if the model is down.
    if (meta.deterministic.length) {
      const r = meta.deterministic[0];
      reply = r.remember ? `Eslab qoldim ✅ ${r.duplicate ? '(allaqachon bor edi)' : ''}` : `Unutdim (${r.removed} ta fakt)`;
    } else {
      return { ok: false, error: err.message, silent: true, meta };
    }
  }

  if (!reply || !reply.trim()) {
    reply = meta.toolsUsed.length ? 'Bajarildi ✅' : "Tushunmadim — nima qilishim kerak?";
  }

  // Only the secret scrubber applies here: the founder may hear the launch
  // date, but a leaked API key is still a leak.
  const clean = guardrails.scrubSecrets(guardrails.flattenMarkdown(reply));
  meta.latencyMs = Date.now() - started;
  log.info('assistant reply', { chatId, ms: meta.latencyMs, tools: meta.toolsUsed.join(',') || '-', deterministic: meta.deterministic.length });
  return { ok: true, text: clean.trim(), meta };
}

/** Run a stored instruction later (schedule_task). */
async function runInstruction({ instruction, chatId }) {
  const r = await handle({ chatId, text: instruction, chatType: 'private', chatTitle: null, msgId: null });
  if (!r.ok) throw new Error(r.error || 'assistant failed');
  return { summary: r.text, tools: r.meta.toolsUsed };
}

module.exports = { handle, runInstruction };
