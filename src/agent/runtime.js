'use strict';
const { EventEmitter } = require('node:events');
const { db, settings, recordEvent } = require('../core/db');
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');
const ingest = require('../knowledge/ingest');
const guardrails = require('./guardrails');
const memory = require('./memory');
const brain = require('./brain');
const assistant = require('./assistant');
const watches = require('./watches');

const log = createLogger('runtime');

/** Band chat qayta tekshiriladigan oraliq. */
const REQUEUE_WAIT_MS = 1_500;
/**
 * Band chatda xabar eng ko'p shuncha kutadi.
 *
 * Undan keyin javob parallel beriladi — uzoq fon ishi tugashini kutib
 * jim turgandan ko'ra, ikkita javob chiqqani afzal.
 */
const MAX_QUEUE_WAIT_MS = 40_000;

/** Agentni chaqiradigan nomlar — @username dan tashqari. */
const AGENT_NAMES = /(^|[\s,.!?—-])(agent|admin|anitoku[\s_]?admin|bot)([\s,.!?:—-]|$)/i;

/**
 * Guruhdagi xabar agentga qaratilganmi?
 *
 * Uch belgi: agentning xabariga javob, @username bilan chaqirish, yoki
 * nomini aytish. Boshqa hamma narsa — odamlarning o'zaro suhbati.
 */
function addressedToAgent(text, { isReplyToMe = false, selfUser = '' } = {}) {
  if (isReplyToMe) return true;
  const t = String(text || '');
  if (selfUser && new RegExp(`@${selfUser}\\b`, 'i').test(t)) return true;
  return AGENT_NAMES.test(t);
}

/**
 * Bridges Telegram events to the agent brain.
 *
 * Incoming messages are debounced per chat (users often send 2–3 short
 * messages in a row), then processed sequentially per chat so replies never
 * interleave. Sending simulates typing and a human-plausible delay.
 */
class Runtime extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();   // chatId -> { texts, timer, meta }
    // chatId -> nechta javob ayni paytda tayyorlanmoqda. Set emas, hisoblagich:
    // kutish chegarasidan keyin ikkinchi javob parallel boshlanishi mumkin, va
    // birinchisi tugaganda qulf butunlay ochilib qolmasligi kerak.
    this.processing = new Map();
    this.bound = false;
    this.stats = { received: 0, replied: 0, skipped: 0, failed: 0, escalated: 0, startedAt: Date.now() };
  }

  attach() {
    if (this.bound) return;
    this.bound = true;
    tg.on('message', (event) => {
      this.onEvent(event).catch((err) => log.error('event handling failed', { error: err.message }));
    });
    log.info('Runtime attached to Telegram events');
  }

  async onEvent(event) {
    const msg = event.message;
    if (!msg) return;

    const chatId = String(msg.chatId ?? (msg.peerId && (msg.peerId.userId || msg.peerId.channelId || msg.peerId.chatId)) ?? '');
    if (!chatId) return;

    this.stats.received++;

    // Resolve chat metadata (best effort — never block on it).
    let chatType = 'private';
    let chatTitle = null;
    let userName = null;
    let senderUsername = null;
    try {
      const chat = await msg.getChat();
      if (chat) {
        chatType = chat.className === 'User' ? 'private' : chat.broadcast ? 'channel' : 'group';
        chatTitle = chat.title || [chat.firstName, chat.lastName].filter(Boolean).join(' ') || null;
      }
      const sender = await msg.getSender();
      if (sender) {
        userName = sender.firstName || sender.username || null;
        senderUsername = sender.username || null;
      }
    } catch {
      /* metadata is optional */
    }

    // Messages from bots are never customer traffic. The assistant talks to
    // bots on purpose through its own tools; letting the support brain answer
    // them produced the agent lecturing its own anime bot about /help, and
    // two auto-responders facing each other is a loop waiting to happen.
    let senderIsBot = false;
    try {
      const sender = await msg.getSender();
      senderIsBot = !!(sender && sender.bot);
    } catch {
      /* unknown sender — treat as human */
    }
    if (senderIsBot) {
      log.debug('skip: sender is a bot', { chatId });
      return;
    }

    ingest.upsertChat({ id: chatId, type: chatType, title: chatTitle, username: null });
    ingest.saveMessage(chatId, msg);

    const text = (msg.message || '').trim();
    if (!msg.out) memory.noteUserMessage(chatId, Number(msg.date) || Math.floor(Date.now() / 1000));

    // Someone the founder is waiting on has answered → report privately.
    if (!msg.out && text) await this.reportWatchedReply(chatId, msg, text, userName);

    // A reply to an escalation notification is an answer for a waiting user,
    // not a support request — handle it and stop.
    if (await this.tryHandleFounderReply(msg, chatId)) return;

    // Is the agent addressed?
    let isMentioned = false;
    let isReplyToMe = false;

    /**
     * Iqtibos qilingan xabar — MATNI bilan.
     *
     * Ilgari bu yerdan faqat "menga javob berildimi?" degan ha/yo'q
     * olinardi, iqtibosning MATNI esa hech qayerga uzatilmasdi. Natijada
     * eski xabarga javob berib "shu backendning MongoDB URLini ber"
     * deyilganda, agent "shu" nimaga ishora qilayotganini bilmasdi va
     * yaqin tarixdan taxmin qilardi — ko'pincha noto'g'ri.
     *
     * Iqtibos — gapning yarmi. Usiz gap tugallanmagan bo'ladi.
     */
    let quoted = null;
    try {
      const myUser = tg.me && tg.me.username ? '@' + tg.me.username.toLowerCase() : null;
      if (myUser && text.toLowerCase().includes(myUser)) isMentioned = true;

      if (msg.replyTo && msg.replyTo.replyToMsgId) {
        const replied = await msg.getReplyMessage();
        if (replied) {
          if (replied.out) isReplyToMe = true;
          const body = String(replied.message || '').trim();
          if (body) {
            quoted = {
              fromMe: !!replied.out,
              author: replied.out
                ? 'agent'
                : (replied.sender && (replied.sender.firstName || replied.sender.username)) || 'foydalanuvchi',
              // Uzun iqtibos kontekstni bosib ketmasin: gapning kimga
              // tegishli ekanini anglash uchun boshi yetarli.
              text: body.slice(0, 1200),
              at: replied.date ? new Date(replied.date * 1000).toISOString() : null,
            };
          }
        }
      }
    } catch {
      /* iqtibosni o'qib bo'lmadi — xabarning o'zi baribir qayta ishlanadi */
    }

    const senderId = msg.senderId ? String(msg.senderId) : null;
    const isFounder = !msg.out && guardrails.isFounder(senderId, senderUsername);

    // The founder is never filtered: not by topic relevance, not by mute, not
    // by the kill switch. Their messages are instructions to the account, and
    // "the agent ignored me" is the one failure mode that must not exist.
    if (isFounder) {
      if (!text) return;
      // "/start@some_other_bot" is addressed to that bot, not to us. Answering
      // it made the agent butt into the founder's game with another bot — and
      // he had to tell it to stop.
      const selfUser = (tg.me && tg.me.username) || '';
      const addressedElsewhere = text.match(/^\/[a-z0-9_]+@([a-z0-9_]+)/i);
      if (addressedElsewhere && addressedElsewhere[1].toLowerCase() !== selfUser.toLowerCase()) {
        log.debug('skip: command addressed to another bot', { chatId, bot: addressedElsewhere[1] });
        return;
      }

      /**
       * GURUHDA rahbarning har gapi buyruq EMAS.
       *
       * Shaxsiy chatda u faqat agent bilan gaplashadi, shuning uchun har
       * xabar ko'rsatma. Guruhda esa u boshqa odamlar bilan gaplashadi —
       * va aynan shu farq hisobga olinmagan edi. Natijasi guruhda ko'rindi:
       * u boshqa a'zoga javoban "Bugla ko'p" deb yozdi, agent buni o'ziga
       * buyruq deb tushunib, o'sha matnni chatga qayta yubordi va "xabar
       * yuborildi" deb hisobot berdi. Hech kim so'ramagan ish.
       *
       * Qoida ataylab TOR: faqat rahbar BOSHQA ODAMNING xabariga javob
       * yozayotgan holat chetlab o'tiladi — bu suhbat kim bilan
       * ketayotganining eng aniq belgisi. Manzilsiz buyruq ("Mirvohidga
       * salom yoz") avvalgidek bajarilaveradi, chunki "agent meni
       * eshitmadi" bundan ham yomon nuqson.
       *
       * Rahbar shu javobda agentni ham chaqirsa (@username yoki nomi),
       * u baribir bajaradi. Shaxsiy chat o'zgarishsiz — u yerda hamma
       * narsa ko'rsatma.
       */
      const replyingToSomeoneElse = !!(msg.replyTo && msg.replyTo.replyToMsgId) && !isReplyToMe;
      if (chatType !== 'private' && replyingToSomeoneElse && !addressedToAgent(text, { selfUser })) {
        this.stats.skipped++;
        log.debug('skip: rahbar guruhda boshqa odamga javob yozmoqda', { chatId, preview: text.slice(0, 60) });
        return;
      }

      this.enqueue({
        chatId, text, chatTitle, chatType, userName, senderId, senderUsername,
        msgId: Number(msg.id),
        quoted,
        mode: 'assistant',
      });
      return;
    }

    const verdict = guardrails.shouldRespond({
      chatType,
      isReplyToMe,
      isOutgoing: !!msg.out,
      text,
      senderId,
      chatId,
      selfUsername: (tg.me && tg.me.username) || null,
    });

    if (!verdict.ok) {
      if (verdict.reason !== 'outgoing') this.stats.skipped++;
      log.debug('skip', { chatId, reason: verdict.reason });
      return;
    }

    // Chat-level override from the admin panel.
    const chatRow = db.prepare('SELECT auto_reply, is_muted FROM chats WHERE tg_chat_id = ?').get(chatId);
    if (chatRow && (chatRow.is_muted || chatRow.auto_reply === 0)) {
      this.stats.skipped++;
      return;
    }
    const conv = memory.conversation(chatId);
    if (conv.state === 'human' || conv.state === 'paused') {
      this.stats.skipped++;
      log.debug('skip: chat handled by human', { chatId });
      return;
    }

    this.enqueue({
      chatId,
      text,
      chatTitle,
      chatType,
      userName,
      msgId: Number(msg.id),
      senderId,
      senderUsername,
      quoted,
      mode: 'support',
    });
  }

  /**
   * Answer what arrived while the agent was down.
   *
   * A user who writes at 21:44 and gets nothing because the process was
   * restarted has simply been ignored. On connect, unread dialogs are scanned
   * and any conversation whose last message is an unanswered question is put
   * through the normal pipeline.
   *
   * Deliberately conservative: only recent messages, only a bounded number of
   * chats, and each one still passes every normal filter (relevance, rate
   * limit, mute, human-handover).
   */
  async catchUp() {
    if (!settings.bool('catchup_enabled', true)) return { skipped: 'disabled' };
    if (!tg.isConnected()) return { skipped: 'not_connected' };
    if (!brain.aiAvailable()) return { skipped: 'no_ai_key' };

    const maxAgeH = settings.int('catchup_max_age_hours', 12);
    const maxChats = settings.int('catchup_max_chats', 15);
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeH * 3600;

    const found = [];
    try {
      for await (const d of tg.client.iterDialogs({ limit: 100 })) {
        if (found.length >= maxChats) break;
        if (!d.unreadCount) continue;

        const chatId = String(d.id);
        const type = d.isUser ? 'private' : d.isChannel ? 'channel' : 'group';
        if (type === 'channel') continue;

        const last = d.message;
        if (!last || last.out) continue;                       // we spoke last — nothing pending
        if (Number(last.date) < cutoff) continue;              // too old to answer now
        const text = (last.message || '').trim();
        if (!text) continue;

        found.push({ chatId, type, title: d.title || d.name || null, text, msgId: Number(last.id), date: Number(last.date) });
      }
    } catch (err) {
      log.warn('catchUp dialog scan failed', { error: err.message });
      return { error: err.message };
    }

    if (!found.length) return { pending: 0 };
    log.info(`Javobsiz qolgan ${found.length} ta suhbat topildi — javob berilmoqda`, {
      chats: found.map((f) => f.title || f.chatId),
    });

    let queued = 0;
    for (const f of found) {
      let senderUsername = null;
      let userName = null;
      try {
        const entity = await tg.resolveEntity(f.chatId);
        if (entity) {
          userName = entity.firstName || entity.username || null;
          senderUsername = entity.username || null;
        }
      } catch {
        /* metadata is optional */
      }

      const senderId = f.type === 'private' ? f.chatId : null;
      const founder = guardrails.isFounder(senderId, senderUsername);

      if (!founder) {
        const verdict = guardrails.shouldRespond({
          chatType: f.type,
          isReplyToMe: false,
          isOutgoing: false,
          text: f.text,
          senderId,
          chatId: f.chatId,
          selfUsername: (tg.me && tg.me.username) || null,
        });
        if (!verdict.ok) continue;

        const conv = memory.conversation(f.chatId);
        if (conv.state !== 'auto') continue;
        if (conv.last_agent_at && conv.last_agent_at >= f.date) continue; // already answered
      }

      this.enqueue({
        chatId: f.chatId,
        text: f.text,
        chatTitle: f.title,
        chatType: f.type,
        userName,
        senderUsername,
        msgId: f.msgId,
        senderId,
        mode: founder ? 'assistant' : 'support',
      });
      queued++;
      // Space the backlog out so a restart does not look like a burst of spam.
      await sleep(1500);
    }

    if (queued) recordEvent('agent', 'Answered missed messages after restart', { queued, scanned: found.length });
    return { pending: found.length, queued };
  }

  /**
   * Debounce: wait a moment in case the user is still typing follow-ups.
   *
   * Merging only ever applies to the SAME sender. In a group several people
   * talk at once, and folding their messages into one turn attributed the whole
   * batch to whoever spoke first — which is how the founder stopped being
   * recognised in busy groups.
   */
  enqueue(item) {
    // The founder is usually mid-conversation and waiting; a customer often
    // sends two or three fragments in a row. Waiting the same three seconds
    // for both made every reply to him feel slow.
    const wait = item.mode === 'assistant' ? Math.min(1200, settings.int('debounce_ms', 2500)) : settings.int('debounce_ms', 2500);
    const cur = this.pending.get(item.chatId);

    if (cur) {
      const sameSender = String(cur.meta.senderId || '') === String(item.senderId || '');
      if (sameSender) {
        cur.texts.push(item.text);
        cur.meta = { ...cur.meta, msgId: item.msgId };
        clearTimeout(cur.timer);
        cur.timer = setTimeout(() => this.flush(item.chatId), wait);
        return;
      }
      // Different person — answer what is already queued, then start fresh.
      clearTimeout(cur.timer);
      this.flush(item.chatId).catch((err) => log.debug('flush on sender switch failed', { error: err.message }));
    }

    const entry = {
      texts: [item.text],
      meta: item,
      timer: setTimeout(() => this.flush(item.chatId), wait),
    };
    this.pending.set(item.chatId, entry);
  }

  async flush(chatId) {
    const entry = this.pending.get(chatId);
    if (!entry) return;
    this.pending.delete(chatId);

    const running = this.processing.get(chatId) || 0;
    if (running) {
      /**
       * Chat band — lekin CHEKSIZ kutmaydi.
       *
       * Ilgari bu yerda shart yo'q edi: xabar har 1.5 soniyada navbatga
       * qaytaverardi, qancha kerak bo'lsa shuncha. Bir marta shaxsiy
       * chatdagi `code_task` provayder limitlarini kutib 15 daqiqa
       * ushlab turdi (jurnalda: rounds 38, stalls 6) va rahbarning shu
       * orada yozgan xabarlari o'sha aylanada qoldi — tashqaridan bu
       * "agent javob bermayapti" bo'lib ko'rindi, holbuki u ishlayotgan
       * edi.
       *
       * Chegaradan keyin javob PARALLEL boshlanadi. Ikkita javob bir
       * chatga chiqishi mumkin, lekin jimlikdan ko'ra shu yaxshi:
       * rahbar savol berganda javob olishi kerak, uzoq fon ishi esa
       * o'z yo'lida davom etadi.
       */
      const waited = (entry.meta.waitedMs || 0) + REQUEUE_WAIT_MS;
      if (waited < MAX_QUEUE_WAIT_MS) {
        setTimeout(() => this.enqueue({ ...entry.meta, waitedMs: waited, text: entry.texts.join('\n') }), REQUEUE_WAIT_MS);
        return;
      }
      log.warn('chat band, kutish chegarasi oshdi — javob parallel beriladi', {
        chatId,
        waitedSec: Math.round(waited / 1000),
        running,
      });
    }

    this.processing.set(chatId, running + 1);
    try {
      await this.process(chatId, entry);
    } catch (err) {
      this.stats.failed++;
      log.error('process failed', { chatId, error: err.message });
      recordEvent('agent', 'Processing failed', { chatId, error: err.message }, 'error');
    } finally {
      const left = (this.processing.get(chatId) || 1) - 1;
      if (left > 0) this.processing.set(chatId, left);
      else this.processing.delete(chatId);
    }
  }

  /**
   * Hold the "typing…" indicator up for as long as we are working.
   * Returns the function that takes it down again.
   */
  /**
   * Keep the "typing…" cue alive while we work.
   *
   * MAX_TYPING_MS is a promise, not a decoration. The indicator says "an
   * answer is coming"; if the work behind it wedges, it goes on saying that
   * for as long as the process lives. That is worse than no indicator —
   * the founder waited on a message that was never going to arrive and had
   * no way to tell. After the cap it stops, and silence at least reads as
   * silence.
   */
  keepTyping(chatId, { maxMs = 8 * 60_000 } = {}) {
    let stopped = false;
    const startedAt = Date.now();

    const push = () => {
      if (stopped) return;
      if (Date.now() - startedAt > maxMs) {
        log.warn('yozmoqda holati juda uzoq davom etdi — toʻxtatildi', {
          chatId,
          minutes: Math.round((Date.now() - startedAt) / 60_000),
        });
        stop();
        return;
      }
      tg.setTyping(chatId, true).catch(() => {});
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      tg.setTyping(chatId, false).catch(() => {});
    };

    push();
    const timer = setInterval(push, 4000);
    return stop;
  }

  async process(chatId, entry) {
    const text = entry.texts.join('\n').trim();
    if (!text) return;

    // No usable AI key → do nothing at all: no typing indicator, no read
    // receipt, no reply. The agent must look untouched rather than answer with
    // something canned.
    if (!brain.aiAvailable()) {
      this.stats.skipped++;
      this.stats.skippedNoAi = (this.stats.skippedNoAi || 0) + 1;
      log.warn('AI kaliti yoʻq — xabar javobsiz qoldirildi', { chatId });
      recordEvent('agent', 'Reply skipped: no AI key available', { chatId }, 'warn');
      return;
    }

    const meta = entry.meta;
    const assistantMode = meta.mode === 'assistant';

    // Rate limits protect the account from customers; the founder is exempt.
    if (!assistantMode) {
      const limit = memory.rateCheck(chatId);
      if (!limit.ok) {
        this.stats.skipped++;
        log.warn('rate limited', { chatId, reason: limit.reason });
        return;
      }
    }

    await tg.markRead(chatId).catch(() => {});

    // Telegram drops the "typing…" indicator about five seconds after each
    // update, but composing a reply takes longer than that — so it appeared,
    // vanished, and the answer arrived out of nowhere. Refreshing it keeps the
    // cue visible for the whole time we are actually working, the way a person
    // typing looks.
    const typing = settings.bool('typing_simulation', true);
    const stopTyping = typing ? this.keepTyping(chatId) : () => {};

    /**
     * Ish boshlangani YOZILADI.
     *
     * Ilgari bu yerda hech narsa loglanmasdi: xabar kelgani ham, ish
     * boshlangani ham. Agent uzoq ishlab qolsa jurnal butunlay bo'sh
     * ko'rinardi va tashqaridan "o'lib qolgan" bilan "ishlayapti" ni
     * ajratib bo'lmasdi — faqat to'xtamaydigan "yozmoqda" qolardi.
     */
    const startedAt = Date.now();
    log.info(assistantMode ? 'rahbar buyrugʻi bajarilmoqda' : 'javob tayyorlanmoqda', {
      chatId,
      chat: meta.chatTitle || meta.chatType,
      chars: text.length,
      preview: text.slice(0, 80),
    });

    /**
     * Ishni tugatmasdan to'xtash — YO'Q.
     *
     * Ilgari barcha provayderlar band bo'lsa, ish yarmida to'xtardi va
     * rahbarga UMUMAN hech narsa yozilmasdi: "yozmoqda" o'chardi, javob
     * kelmasdi, vazifa bajarilmay qolardi. Buyruq bergan odam uchun bu
     * eng yomon holat — u nima bo'lganini bilmaydi ham.
     *
     * Endi bandlik sabab to'xtash yakuniy javob emas: kutib, boshidan
     * qayta uriniladi. Vosita chaqiruvlari takrorlanishi mumkin, lekin
     * ular o'qish amallari (ls, cat, ssh) va agent qayta boshlaganda
     * bir xil xulosaga keladi — ishni yarmida tashlab ketishdan ko'ra
     * yaxshiroq.
     */
    const RETRY_WAITS_MS = [20_000, 60_000];
    let result;

    for (let attempt = 0; ; attempt++) {
      result = assistantMode
        ? await assistant.handle({
            chatId,
            text,
            chatType: meta.chatType,
            chatTitle: meta.chatTitle,
            msgId: meta.msgId,
            senderId: meta.senderId,
            quoted: meta.quoted || null,
          })
        : await brain.respond({
            chatId,
            text,
            chatTitle: meta.chatTitle,
            chatType: meta.chatType,
            userName: meta.userName,
            senderId: meta.senderId,
            senderUsername: meta.senderUsername,
            quoted: meta.quoted || null,
          });

      // Faqat "modellar band" holati qayta uriniladi. Boshqa xato —
      // masalan vosita ishlamadi — takrorlansa ham o'zgarmaydi.
      const busy = !result.ok && result.silent;
      if (!busy || attempt >= RETRY_WAITS_MS.length) break;

      const wait = RETRY_WAITS_MS[attempt];
      log.warn('modellar band — ishni tashlamay qayta urinamiz', {
        chatId,
        attempt: attempt + 1,
        waitMs: wait,
      });
      await new Promise((r) => setTimeout(r, wait));
    }

    // Model va provayder `meta` ichida keladi (assistant), yoki yuqori
    // darajada (brain) — ikkalasidan ham o'qiymiz, aks holda jurnalda
    // "model: null" turib, qaysi model javob berganini aytmaydi.
    log.info('javob tayyor', {
      chatId,
      ms: Date.now() - startedAt,
      ok: !!result.ok,
      model: result.model || result.meta?.model || null,
      provider: result.provider || result.meta?.provider || null,
      tools: (result.meta?.toolsUsed || result.tools || []).length || undefined,
    });

    if (!result.ok) {
      stopTyping();
      if (result.silent) {
        this.stats.skipped++;
        log.warn('javob yuborilmadi (AI mavjud emas)', { chatId });

        /**
         * Mijozga jim qolamiz, RAHBARGA — yo'q.
         *
         * Mijoz uchun jimlik to'g'ri: u agent borligini bilmaydi va
         * "texnik nosozlik" xabari faqat tashvish tug'diradi. Lekin
         * rahbar aniq vazifa bergan va uni kutib turibdi. Unga hech
         * narsa demaslik — vazifani jimgina tashlab ketish demak.
         */
        if (assistantMode) {
          await tg
            .sendMessage(
              chatId,
              'Yosh Usta, hamma AI provayderlar hozir band (limit tugagan) — bir necha marta urinib koʻrdim, ' +
                'ishni oxiriga yetkaza olmadim. Bir necha daqiqadan keyin qaytadan yozing yoki kalitlarni tekshiring.'
            )
            .catch((err) => log.warn('bandlik xabari yuborilmadi', { chatId, error: err.message }));
        }
      } else {
        this.stats.failed++;
        log.warn('no reply produced', { chatId, error: result.error });
      }
      return;
    }

    // Human-plausible pacing for customers. The founder gets the answer as
    // soon as it exists — a delayed "done" on a command feels like a stall.
    if (!assistantMode) {
      // Composing already took real time; only top it up to a human-looking
      // minimum instead of adding a fixed wait on top of it.
      const min = settings.int('min_delay_ms', 1200);
      const max = settings.int('max_delay_ms', 4200);
      const target = min + Math.random() * Math.max(0, max - min);
      const delay = Math.max(0, Math.min(target, target - (result.meta.latencyMs || 0)));
      if (delay > 250) await sleep(delay);
    }

    // Secrets and "write to my private chat" answers go to the founder's DM;
    // the group only sees a one-line pointer (result.text).
    if (result.privateText && result.privateTo) {
      try {
        const dm = await tg.sendMessage(result.privateTo, result.privateText);
        if (dm) ingest.saveMessage(String(result.privateTo), dm, { isAgent: true });
        log.info('javob shaxsiy chatga yuborildi', { from: chatId, to: result.privateTo });
      } catch (err) {
        log.warn('shaxsiy chatga yuborib boʻlmadi', { error: err.message });
        result.text = `Yosh Usta, shaxsiy chatingizga yozolmadim (${err.message}). Avval menga shaxsiy xabar yozing.`;
      }
      if (!result.text) {
        stopTyping();
        return;
      }
    }

    try {
      const sent = await tg.sendMessage(chatId, result.text, { replyTo: meta.chatType !== 'private' ? meta.msgId : null });
      this.stats.replied++;
      memory.noteAgentReply(chatId, Math.floor(Date.now() / 1000));

      // Record our own reply so it becomes conversation history (flagged as agent-written
      // so it is never mistaken for human style during future training).
      if (sent) ingest.saveMessage(chatId, sent, { isAgent: true });

      recordEvent('reply', 'Agent replied', {
        chatId,
        model: result.meta.model,
        docs: result.meta.docs,
        tools: result.meta.toolsUsed,
        flags: result.meta.flags,
      });
      this.emit('replied', { chatId, text: result.text, meta: result.meta });
    } catch (err) {
      this.stats.failed++;
      log.error('send failed', { chatId, error: err.message });
      recordEvent('agent', 'Send failed', { chatId, error: err.message }, 'error');
    } finally {
      stopTyping();
    }

    if (result.meta.escalated) {
      this.stats.escalated++;
      await this.notifyEscalation(chatId, meta, result.meta.escalated);
    }
  }

  /**
   * Ask the founders. The notification's message id is stored so that a plain
   * Telegram reply to it can be routed straight back to the user who asked —
   * answering from the admin panel is the other path.
   */
  async notifyEscalation(chatId, meta, esc) {
    const target = String(settings.get('escalation_chat_id', '')).trim();
    if (!target || esc.duplicate) return;

    const body =
      `❓ Savol #${esc.id} — javob kerak\n\n` +
      `👤 Kimdan: ${meta.userName || 'nomaʼlum'}\n` +
      `💬 Chat: ${meta.chatTitle || chatId}\n` +
      `📌 Savol: ${esc.question || esc.summary}\n` +
      `ℹ️ Sabab: ${esc.reason}\n\n` +
      `➡️ Shu xabarga REPLY qilib javob yozing — men uni foydalanuvchiga yetkazaman.\n` +
      `(yoki admin panel → Eskalatsiya boʻlimidan javob bering)`;

    try {
      const sent = await tg.sendMessage(target, body, { silent: false });
      if (sent) {
        db.prepare('UPDATE escalations SET notify_chat_id = ?, notify_msg_id = ? WHERE id = ?')
          .run(String(target), Number(sent.id), esc.id);
      }
    } catch (err) {
      log.warn('escalation notify failed', { error: err.message });
    }
  }

  /**
   * The founder replied to an escalation notification — deliver that answer to
   * the user who originally asked, in the agent's own voice.
   */
  async relayFounderAnswer(escalationId, answerText, { by = 'rahbariyat' } = {}) {
    const esc = db.prepare('SELECT * FROM escalations WHERE id = ?').get(Number(escalationId));
    if (!esc) throw new Error('Eskalatsiya topilmadi');
    if (esc.status !== 'open') throw new Error('Bu savol allaqachon yopilgan');

    const text = String(answerText || '').trim();
    if (!text) throw new Error("Javob boʻsh");

    // The founder often answers with an instruction ("yes, give them my
    // channel link") rather than words meant for the user. Forwarding that
    // verbatim reads wrong and — worse — nothing actually gets done. When the
    // reply looks like a directive, the assistant composes the real answer
    // from it, with the founder's memory available.
    let message;
    const directive = /(\bber\b|berib|\bayt\b|aytib|\byoz\b|yozib|yubor|tasdiqla|ruxsat|mumkin|qil\b|скажи|передай|отправь|дай|tell|send|give)/i.test(text) && text.length < 400;
    if (directive) {
      try {
        const composed = await assistant.handle({
          chatId: esc.tg_chat_id,
          chatType: 'private',
          chatTitle: esc.chat_title,
          msgId: null,
          text:
            `Foydalanuvchi (${esc.chat_title || esc.tg_chat_id}) shuni soʻragan edi: "${String(esc.question || '').slice(0, 400)}".\n` +
            `Rahbar (Yosh Usta) javobi/koʻrsatmasi: "${text}".\n` +
            `Vazifa: shu koʻrsatmaga asoslanib foydalanuvchiga yuboriladigan YAKUNIY javob matnini yoz. Kerakli maʼlumotni (havola, fakt) xotirangdan ol. ` +
            `Faqat javob matnini qaytar — "rahbar dedi" deb tushuntirma, vosita chaqirma, oʻzing xabar yuborma.`,
        });
        if (composed.ok && composed.text && composed.text.length > 10) message = composed.text;
      } catch (err) {
        log.debug('directive compose failed, forwarding verbatim', { error: err.message });
      }
    }
    if (!message) message = `Savolingizga rahbariyatdan javob keldi 🙂\n\n${text}`;
    const clean = guardrails.sanitizeOutgoing(message);

    const sent = await tg.sendMessage(esc.tg_chat_id, clean.text);
    if (sent) ingest.saveMessage(esc.tg_chat_id, sent, { isAgent: true });

    db.prepare("UPDATE escalations SET status = 'resolved', answer = ?, answered_by = ?, resolved_at = datetime('now') WHERE id = ?")
      .run(text, by, esc.id);
    db.prepare("UPDATE conversations SET escalated = 0, updated_at = datetime('now') WHERE tg_chat_id = ?").run(esc.tg_chat_id);

    memory.noteAgentReply(esc.tg_chat_id, Math.floor(Date.now() / 1000));
    recordEvent('escalation', 'Founder answer relayed', { id: esc.id, chatId: esc.tg_chat_id, by });
    log.info('escalation answered', { id: esc.id, chatId: esc.tg_chat_id, by });
    return { ok: true, chatId: esc.tg_chat_id, text: clean.text };
  }

  /**
   * Detect "reply to an escalation notification" in the founders' chat.
   * Returns true when the message was consumed as an answer.
   */
  async tryHandleFounderReply(msg, chatId) {
    if (!msg.replyTo || !msg.replyTo.replyToMsgId) return false;
    const esc = db
      .prepare("SELECT * FROM escalations WHERE notify_chat_id = ? AND notify_msg_id = ? AND status = 'open'")
      .get(String(chatId), Number(msg.replyTo.replyToMsgId));
    if (!esc) return false;

    const answer = (msg.message || '').trim();
    if (!answer) return false;

    try {
      await this.relayFounderAnswer(esc.id, answer, { by: 'telegram' });
      await tg.sendMessage(chatId, `✅ Javob #${esc.id} foydalanuvchiga yetkazildi.`, { silent: true });
    } catch (err) {
      log.warn('founder reply relay failed', { error: err.message });
      await tg.sendMessage(chatId, `⚠️ Javobni yetkazib boʻlmadi: ${err.message}`, { silent: true }).catch(() => {});
    }
    return true;
  }

  /**
   * A reply arrived in a chat the founder asked to be told about
   * ("ask Og'abek his age, write me when he answers"). Forward it to the
   * founder's private chat and close the watch.
   */
  async reportWatchedReply(chatId, msg, text, userName) {
    let hits;
    try {
      hits = watches.consume(chatId, Number(msg.id), text);
    } catch (err) {
      log.debug('watch check failed', { error: err.message });
      return;
    }
    for (const w of hits) {
      const who = w.chat_name || userName || chatId;
      const body = `📩 ${who} javob berdi${w.note ? ` (${w.note})` : ''}:\n«${text.slice(0, 1500)}»`;
      try {
        await tg.sendMessage(w.notify_chat, body);
        recordEvent('watch', 'Watched reply forwarded', { watch: w.id, chatId });
        log.info('kuzatilgan javob rahbarga yetkazildi', { watch: w.id, from: who });
      } catch (err) {
        log.warn('kuzatilgan javobni yetkazib boʻlmadi', { error: err.message });
      }
    }
  }

  /** Manual send from the admin panel — bypasses the AI. */
  async sendManual(chatId, text) {
    const sent = await tg.sendMessage(chatId, text);
    if (sent) ingest.saveMessage(chatId, sent, { isAgent: false });
    memory.noteAgentReply(chatId, Math.floor(Date.now() / 1000));
    recordEvent('reply', 'Manual reply sent', { chatId });
    return true;
  }

  snapshot() {
    const uptimeSec = Math.round((Date.now() - this.stats.startedAt) / 1000);
    const today = db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE is_agent = 1 AND created_at > datetime('now', '-24 hours')")
      .get().c;
    const incoming24 = db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE is_outgoing = 0 AND created_at > datetime('now', '-24 hours')")
      .get().c;
    const openEsc = db.prepare("SELECT COUNT(*) AS c FROM escalations WHERE status = 'open'").get().c;
    return {
      ...this.stats,
      uptimeSec,
      queued: this.pending.size,
      processing: this.processing.size,
      replies24h: today,
      incoming24h: incoming24,
      openEscalations: openEsc,
      paused: settings.bool('agent_paused', false),
      autoReply: settings.bool('auto_reply', true),
    };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = new Runtime();
