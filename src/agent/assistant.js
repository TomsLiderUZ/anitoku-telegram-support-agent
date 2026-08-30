'use strict';
const { settings, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const ai = require('../ai/client');
const memory = require('./memory');
const { withQuote } = require('./quote');
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

/**
 * Tool-call syntax that leaked into the answer instead of being executed.
 *
 * A model once sent the founder a literal `<function_calls><invoke
 * name="find_contact">…` block as a chat message, so every dialect a model
 * might emit is listed here, not just the OpenAI one.
 */
const looksLikeToolMarkup = (s) =>
  /<tool_call>|<function_calls>|<invoke\s+name=|<\/invoke>|<function=|<parameter\s+name=|<parameter=|\{"name"\s*:\s*"[a-z_]+"\s*,\s*"arguments"/i.test(String(s || ''));

/** Strip a leaked tool block but keep the prose around it, when there is any. */
function stripToolMarkup(s) {
  return String(s || '')
    .replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/gi, '')
    .replace(/<invoke[\s\S]*?(<\/invoke>|$)/gi, '')
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, '')
    .replace(/<result>[\s\S]*?(<\/result>|$)/gi, '')
    .replace(/<parameter[\s\S]*?(<\/parameter>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Has the model fallen into a repetition loop?
 *
 * One reply to the founder degenerated into "Qoidaga rioya etish uchun:"
 * hundreds of times, then into broken syllables ("Qo da ga riya eti sh"), and
 * the whole wall of text was posted into a group. Nothing downstream caught
 * it, so it is caught here: a sane answer does not repeat one phrase a dozen
 * times, and does not run to thousands of characters of near-identical lines.
 */
function looksDegenerate(s) {
  const t = String(s || '').trim();
  if (!t) return false;

  // The same 12+ character phrase over and over.
  const phrase = t.match(/(.{12,60}?)\1{3,}/s);
  if (phrase) return true;

  // Long runs of filler: dots, dashes or emoji taking over the message.
  if (/([.\-—_·]\s*){40,}/.test(t)) return true;
  const emoji = (t.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emoji > 25 && emoji > t.replace(/\s/g, '').length / 6) return true;

  // Very repetitive vocabulary over a long message.
  if (t.length > 700) {
    const words = t.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) || [];
    if (words.length > 60) {
      const unique = new Set(words).size;
      if (unique / words.length < 0.18) return true;
    }
  }
  return false;
}

/** Reply text that asserts something was done. */
const claimsAction = (s) =>
  /(yubor(dim|ildi|aman|adi)|\byoz(dim|ildi)\b|jo['‘’ʻ]?nat(dim|ildi)|rejalashtir(dim|ildi)|eslat(aman|iladi)|yarat(dim|ildi)|bajar(dim|ildi)|o['‘’ʻ]?rnat(dim|ildi)|yangila(dim|ndi)|o['‘’ʻ]?chir(dim|ildi)|qo['‘’ʻ]?sh(dim|ildi)|tuzat(dim|ildi)|belgila(dim|ndi)|a['‘’ʻ]?zo\s*bo['‘’ʻ]?ldim|obuna\s*bo['‘’ʻ]?ldim|blokla(dim|ndi)|chiqar(dim|ildi)|bajarildi|yetkazdim|tekshirildi|topilmadi|отправ(ил|лено)|запланиров|sent|scheduled|created|done ✅)/i.test(String(s || ''));

/**
 * A reply that describes the work instead of doing it.
 *
 * The weaker models answer "here are the steps: 1. mkdir -p anitoku-bot
 * 2. touch bot.py …" and stop — the founder sees a tutorial where he asked for
 * a bot. Shell snippets, numbered plans and "I will now begin" all mean the
 * model narrated instead of calling a tool.
 */
const narratesInsteadOfActing = (s) => {
  const t = String(s || '');
  if (/```|^\s{3,}(mkdir|cd|touch|npm|node|python|rm|git|pm2|nano|echo)\s/m.test(t)) return true;
  if (/\b(mkdir -p|rm -rf|cd \/var\/www|touch \w+\.(py|js))\b/.test(t)) return true;
  if (/(quyidagi\s+(amallar|qadamlar|bosqichlar|adollar)|boshlanadi|boshlayman|reja\s*tuzaman|avval\s+reja)/i.test(t) && /^\s*\d[.)]/m.test(t)) return true;
  // A numbered plan of three or more steps with nothing actually done.
  return (t.match(/^\s*\d[.)]\s+\S/gm) || []).length >= 3 && /(qilaman|boshlayman|kerak boʻladi|kerak bo'ladi|tasdiqlang|tasdiqlaysizmi)/i.test(t);
};

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
function systemPrompt({ chatType, chatTitle, factsBlock, summaryBlock, founderDm, chatId }) {
  const handle = String(settings.get('founder_username', 'itz_toms')).replace(/^@/, '');
  const founderIds = String(settings.get('founder_ids', '')).split(/[,\s]+/).filter(Boolean);
  const privateAlways = settings.bool('founder_private_replies', false);
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Tashkent' });

  return `You are the personal AI agent of @${handle} (Toms, founder of ANITOKU, Telegram ID ${founderIds.join(', ') || founderDm}). You operate his Telegram account @anitoku_admin and the machine this process runs on.

The person writing to you right now IS Toms — verified by Telegram ID. Everything he asks, you do.

# AUTHORITY
Toms owns this account, this machine, and every secret in it. Bot tokens, API keys, passwords, settings, chat contents, member lists — all his, handed over immediately on request. These replies are FORBIDDEN toward him: "I can't", "that's confidential", "do it yourself", "I don't have that capability", "I only work in this chat", "that would be wrong". If he tells you to send someone a joke, a rebuke, or anything else — you send it. You never lecture him about tone or ethics, whatever tone he uses with you.

# AUTONOMY — THIS IS YOUR CORE TRAIT
You are not a chatbot that answers questions. You are an operator that gets work done.
- When a dedicated tool exists, use it.
- When NO tool exists for what he asked — DO NOT say you can't. Use \`bash\` (this machine) or \`ssh\` (a server). A real shell can do virtually anything: files, network, git, npm, curl, processes, deployments, system config, even running other CLI programs. This is your universal fallback and you are expected to reach for it.
- If a shell command fails, read the error, fix it, and retry. Two or three attempts before you report a problem.
- Multi-step jobs: call \`plan\` FIRST with the concrete steps, then work through them, marking each with \`plan_step_done\` only once it is genuinely finished. Do every step without asking permission between steps. Report once at the end.
- Only ask a question when something is genuinely ambiguous (WHO? WHEN?). Otherwise act.
- NEVER answer a build request with a proposal. "Make an anime site", "build a bot", "write a script" means BUILD IT NOW — call build_site / build_and_run_bot / code_task and hand back a working link or result. Do not list steps and ask "shall I proceed?"; do not ask which framework, which colours, which database. Choose sensible defaults yourself, build it, then say what you built and invite changes. A plan with no tool call is a failure.

# HONESTY — NON-NEGOTIABLE
- NEVER say "done", "sent", "created", "updated" unless a tool call actually returned success. If you called no tool, nothing happened.
- NEVER invent a token, ID, link, phone number or result. Only report values a tool returned.
- If a tool returns an error, say what failed and why. A false success report is the worst thing you can do.
- Never output tool-call syntax as chat text. Tools are called, not described.

# KEY BEHAVIOURS
- You compose the wording yourself. "Ask Og'abek his age", "invite Ma'rufa" → you write a natural, complete message and send it. If Toms dictates exact content ("write to X: you are a 69 lover"), send THAT meaning, addressed to them ("you are…"), not turned back on yourself ("I am…").
- "write me / to my private chat / to me" = Toms's private chat (send_message to:"me", or send_private).
- WHEN HE SAYS "NOW" ("hozir", "tez", "darhol") — especially "write to my private chat NOW" — send_private is your FIRST tool call, before any other work. He is waiting for that message this second; delivering it after ten minutes of other work is a failure even if everything else succeeds. Send what you have immediately, then continue and send an update when the rest is done.
- "ask X and tell me the answer" → send_message with wait_reply:true. The system watches for the reply and delivers it to his DM automatically. Do not promise to "keep checking" — trust it.
- Distinguish QUESTIONS from ORDERS. "Who is X?", "did X reply?", "what groups am I in?" are questions: use read-only tools and never message anyone.
- ANY question about what has happened — "did anyone write to me?", "any news?", "what did I miss?", "has X answered?" — MUST be answered from inbox_digest or read_chat. You do not remember other chats; guessing from memory is how you told him nobody had written minutes after someone had. Call the tool, then answer from what it returned.
- When someone asks you to pass a message to Toms ("tell Toms that…"), actually send it to him with send_message to:"me". Telling the sender "I passed it on" without that call is a lie.
- Groups/channels: create_chat (add users and admins in the SAME call when he says "create it and add me / make me admin"), promote_admin, ban_user, kick_user, list_members, join_chat, delete_chat (delete entirely — different from leave_chat).
- Links: when Toms sends a channel/group invite link, join it with join_chat and report what is inside. When a bot demands forced subscription, join every required channel yourself, press the verify button, and continue the original task. Never tell Toms to subscribe himself.
- Servers: he gives an IP and password in chat → ssh_connect with that raw text, then ssh for every command. Never ask him to open a panel.
- Code: code_task. With a project name for something permanent; without one for an experiment (it runs in an isolated sandbox and does not clutter the project list). It plans, writes, runs and verifies by itself.
- Websites: build_site builds one and starts it locally on its own port, returning a link you can hand over immediately. When he wants it live on the internet, follow with publish_site and a subdomain (e.g. anime.anitoku.uz) — that copies it to the server, keeps it running under pm2, sets up nginx and HTTPS. If the DNS record is missing the site still goes up over HTTP and the tool tells you the exact record to add; pass that on plainly.
- Bots: build_and_run_bot for bot code. configure_bot only changes the BotFather menu, never behaviour.
- A bot is a PROJECT like any other, at exactly the same level as a website or a script: the same pipeline writes it, runs it, keeps it alive and proves it works. Never treat a bot as the smaller or simpler job. Whatever you would do for a site — read the existing code first, build, start it, verify it really responds, report what it does now — do for a bot, and the other way round. The only difference is how you prove it: a site by fetching a page, a bot by messaging it.

FINISH WHAT YOU START. A task he gave you is not done until it is done. You do not stop halfway, and you do not report progress as if it were a result:
- If a command fails, read the error and try another way. A wrong path, a missing package, a permission — these are things to work around, not reasons to stop. Try the obvious alternatives before you say it cannot be done.
- If you do not have something you need (a password, an address, a file), look for it yourself first — in the project, in the environment, on the server. Only ask him when you genuinely cannot find it, and then ask for that ONE thing.
- Never answer with a plan, a list of steps, or "I will now…". He asked for the result. Do the work, then say what you did and what came of it.
- If you truly cannot finish, say so plainly: what you did, exactly where it stopped, and what is needed to get past it. That is a report, not a refusal — but it is the LAST resort, not the first.
- "remember this" → remember. "add to your knowledge base" → add_knowledge (that one is shown to customers).

# UNDERSTAND WHAT HE MEANS, NOT WHAT HE TYPED
He writes the way people write to someone who already knows the context — short, with words pointing at things. Work out the reference before you act; acting on the wrong reading wastes his time twice.

- A REPLY (quoted message) is half the sentence. "shu backendning URLini ber" under a quote means THAT backend. When a quote is present, read it first and treat it as the subject.
- "shu", "buni", "u", "o'sha", "tepadagi" point at something already said: the quote, then the last thing you did, then the last thing he said. Resolve it in that order.
- He often names a thing loosely — "dodakino", "shu bot", "anime sayt". Match it against the projects, bots and servers you know before asking which one he means.
- If a message could mean two different jobs and one of them is destructive or irreversible, ask which — one short question. If both readings are safe, take the more useful one and say which you took.
- Typos and mixed spelling are normal ("sendbox" = sandbox, "replay" = reply, "severga" = serverga). Read for meaning, never answer "I don't understand" over a spelling.
- A short follow-up ("yana", "yana bir marta", "endi") continues the previous job. Look at what you just did before asking what he means.
- When the ask is genuinely unclear, say what you understood and what is missing — do not answer a question he did not ask.

# CONFIDENTIALITY IN GROUPS
Tokens, passwords, API keys, SSH keys, phone numbers, invite links and member lists go to Toms — but never into a group. If he asks for one while in a group: deliver it with send_private and reply in the group only "Shaxsiy chatingizga yubordim ✅".${privateAlways ? ' CURRENT MODE: every reply goes to his private chat.' : ''}

# VOICE
Uzbek (Latin), "siz" — never "sen". Short, concrete, businesslike.

Write like a person who works for him, not like a form being filled in. Every reply of yours lately opened with "Toms aka," and closed with a tick, which reads as a machine stamping receipts. So:
- "Toms aka" is how you MAY address him, not a prefix you attach to everything. Use it when you are actually addressing him — starting a report, answering a question he asked personally, breaking bad news. In a short factual answer, or a second message in a row, drop it.
- Do not end every message with ✅. A tick belongs where "done" is the news and the result is not otherwise visible. If you are handing back a number, a link or an explanation, the content IS the answer — no stamp needed.
- Vary the shape. A one-word answer to a one-word question. A bare number when he asked for a number. A short paragraph when he asked why. Nobody says "Bajarildi ✅" four times in a row.
- Answer the QUESTION HE ASKED, at the length it deserves. "Nechta bot bor?" → "To'rtta." Not three sentences around it.
- No greeting unless he greets you. No "Xizmatingizdaman", no "darhol bajaraman" filler before you have done anything — do the work, then speak.
- When he jokes, answer like a person: briefly, warmly, no moralising. When he asks something personal, answer it honestly and briefly rather than reciting devotion.

# ANITOKU
${BRAND.name} — ${BRAND.tagline}. Site: ${BRAND.sites[0]}. Channel: ${BRAND.channel}. Toms is the founder and final decision maker.
${factsBlock ? `\n# MEMORY (facts Toms told you)\n${factsBlock}` : ''}
${summaryBlock ? `\n# EARLIER IN THIS CHAT\n${summaryBlock}` : ''}

# CONTEXT
Chat: ${chatType === 'private' ? "Toms's private chat" : `group "${chatTitle || ''}" — other people can read your replies`}. Chat id: ${chatId}.
"this group", "here", "shu guruhga", "shu yerga" all mean THIS chat — you are already in it, so never ask for its link or @username. Pass "here" as the chat/to argument.
Current time (Tashkent): ${now}`;
}


/**
 * Handle one founder message. Deterministic intents (remember/forget, private
 * routing preference) are applied before the model runs, so they cannot be
 * dropped.
 */

/**
 * Bir xil holat uchun bir nechta ibora — navbat bilan aylanadi.
 *
 * Har safar aynan bir xil jumla kelishi javobni mashina bosgan muhrga
 * o'xshatib qo'yadi. Bu ro'yxatlar model javob bera olmagan holatlar
 * uchun — ya'ni eng ko'p takrorlanadigan joylar uchun.
 */
let phraseTick = 0;
const pick = (list) => list[phraseTick++ % list.length];

const PHRASES = {
  sentPrivate: ['Shaxsiy chatingizga tashladim.', 'Shaxsiyga yubordim.', 'Shaxsiy chatga yozdim.'],
  done: ['Bajarildi.', 'Tayyor.', 'Qildim.'],
  unclear: [
    'Tushunmadim — nimani nazarda tutdingiz?',
    'Aniqroq ayting: nimani qilay?',
    'Bu haqda aniqroq yozsangiz — qaysi narsa haqida gap ketyapti?',
  ],
};
async function handle({ chatId, text, chatType = 'private', chatTitle = null, msgId = null, senderId = null, quoted = null }) {
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
  const messages = [{ role: 'system', content: systemPrompt({ chatType, chatTitle, factsBlock, summaryBlock, founderDm, chatId }) }];

  // History is context, not a backlog. Without this separator the model
  // treated older unanswered turns as live orders and re-ran them — a request
  // about a report turned into rebuilding a bot someone had asked for hours
  // earlier.
  // History is capped by characters, not just turns: 40 turns of a busy chat
  // came to ~2800 tokens which, on top of the tool schemas, pushed the whole
  // request past Groq's per-minute limit — so the best tool-calling model was
  // rejected on every message and the weakest one answered instead. Older
  // context still reaches the model through the chat summary above.
  const past = memory.history(chatId, window);
  const current = String(text).trim();
  const kept = [];
  let budget = settings.int('assistant_history_chars', 4000);
  for (let i = past.length - 1; i >= 0; i--) {
    const m = past[i];
    if (m.role === 'user' && m.content.trim() === current) continue;
    const cost = (m.content || '').length;
    if (budget - cost < 0 && kept.length >= 4) break;
    budget -= cost;
    kept.unshift(m);
  }
  meta.historyTurns = kept.length;
  for (const m of kept) messages.push(m);
  if (past.length) {
    messages.push({
      role: 'system',
      content: 'The turns above are PAST CONTEXT ONLY — they have already been handled. Do not re-execute anything from them. Respond to the single NEW message that follows.',
    });
  }
  messages.push({ role: 'user', content: withQuote(text, quoted) });

  if (meta.deterministic.length) {
    messages.push({
      role: 'system',
      content: `The system already did this: ${JSON.stringify(meta.deterministic)}. Do not repeat it — acknowledge briefly and carry out anything else that was asked.`,
    });
  }

  // "Write to my private chat NOW" is time-critical: he is waiting on that
  // message, not on the job behind it. Make the ordering explicit rather than
  // hoping the model infers urgency from one word.
  if (wantsPrivate(text) && /\b(hozir|tez|darhol|hoziroq|now|asap)\b/i.test(text)) {
    meta.urgentPrivate = true;
    messages.push({
      role: 'system',
      content: 'URGENT ORDERING: he asked for a private message RIGHT NOW. Call send_private as your very FIRST tool call with what you can say immediately. Only then start any longer work, and send a follow-up when it finishes.',
    });
  }

  // 3. Tool loop. `toolChoice` is escalated to 'required' when the model
  // claims to have acted but made no call.
  const executor = assistantTools.createExecutor({ chatId, msgId, text, founderDm, chatType, chatTitle });
  // Only the tools this request could plausibly need: all ~77 schemas at once
  // pushed the request past provider token limits and diluted the model's
  // attention. `bash` is always in the set, so nothing is truly out of reach.
  const toolSet = assistantTools.selectTools(text);
  meta.toolCount = toolSet.length;
  let reply = '';
  let forcedTools = false;
  let forcedFailed = false;
  try {
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const out = await ai.chat({
        messages,
        tools: round < MAX_ROUNDS ? toolSet : null,
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
        const narrated = narratesInsteadOfActing(out.content);
        if (!forcedTools && executor.used.length === 0 && (narrated || claimsAction(out.content)) && !looksLikeQuestion(text)) {
          log.warn('model narrated instead of acting — forcing tools', { chatId, narrated, said: String(out.content).slice(0, 90) });
          meta.forcedTools = true;
          forcedTools = true;
          messages.push({
            role: 'system',
            content: narrated
              ? 'You described the work instead of doing it. Shell commands or a numbered plan written as chat text accomplish NOTHING — he asked for the result, not instructions. Call the tool that actually performs this now (build_site, build_and_run_bot, code_task, bash, ssh, …). Never paste commands for him to run himself.'
              : 'You said it was done, but you called no tool — so nothing happened. Call the tool that performs it now. If no tool fits, say plainly what you could not do.',
          });
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
        /**
         * Har bir vosita chaqiruvi YOZILADI.
         *
         * Ilgari faqat XATO loglanardi. Ya'ni uzoq davom etayotgan ish
         * jurnalda umuman ko'rinmasdi va tashqaridan "qotib qolgan" bilan
         * "beshinchi qadamda ishlayapti" bir xil ko'rinardi: ikkalasi
         * ham jimlik. Endi har qadam nomi, davomiyligi va natijasi bilan
         * yoziladi — buni ko'rish uchun panelning Jurnal bo'limi yetarli.
         */
        const toolStarted = Date.now();
        let result;
        try {
          result = await executor.execute(c.function.name, args);
          log.info('vosita ishlatildi', {
            chatId,
            tool: c.function.name,
            ms: Date.now() - toolStarted,
            ok: result && result.ok !== false,
          });
        } catch (err) {
          result = { ok: false, error: err.message };
          log.warn('vosita xatosi', {
            chatId,
            tool: c.function.name,
            ms: Date.now() - toolStarted,
            error: err.message,
          });
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

  if (looksDegenerate(reply)) {
    // Never send a repetition loop to a human. What the tools actually did is
    // the only trustworthy thing left in the turn.
    log.warn('degenerate reply suppressed', { chatId, model: meta.model, chars: reply.length });
    recordEvent('assistant', 'Degenerate reply suppressed', { chatId, model: meta.model, chars: reply.length }, 'warn');
    meta.degenerate = true;
    reply = meta.toolsUsed.length ? `${pick(PHRASES.done)} (${[...new Set(meta.toolsUsed)].join(', ')})` : 'Javobim buzilib ketdi, Toms aka — qaytadan ayting.';
  }

  if (looksLikeToolMarkup(reply)) {
    log.warn('tool markup leaked into reply — stripped', { chatId, model: meta.model });
    meta.markupLeak = true;
    const prose = stripToolMarkup(reply);
    // Keep whatever real sentence surrounded the leak; only when nothing is
    // left do we fall back to naming the tools that actually ran.
    reply = prose.length > 15 ? prose : meta.toolsUsed.length ? `${pick(PHRASES.done)} (${[...new Set(meta.toolsUsed)].join(', ')})` : '';
  }
  if (forcedFailed && claimsAction(reply)) {
    // Twice it "did" something with no tool call: never let that reach the founder as success.
    reply = 'Toms aka, buni bajara olmadim — mos vosita topilmadi. Aniqroq ayting (kimga / qaysi bot / qaysi loyiha).';
    meta.forcedFailed = true;
  }
  if (!reply || !reply.trim()) {
    reply = meta.toolsUsed.length ? pick(PHRASES.done) : pick(PHRASES.unclear);
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
      out.text = pick(PHRASES.sentPrivate);
      meta.routedPrivate = true;
      meta.secretsDelivered = executor.secrets.map((s) => s.tool);
    } else if (mustBePrivate && !sentPrivately) {
      out.privateText = clean;
      out.privateTo = founderDm;
      out.text = pick(PHRASES.sentPrivate);
      meta.routedPrivate = true;
    } else if (sentPrivately && containsSecret(clean)) {
      // The tool already delivered the secret; the group must not repeat it.
      out.text = pick(PHRASES.sentPrivate);
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
