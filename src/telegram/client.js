'use strict';
const { EventEmitter } = require('node:events');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

const { db, settings, recordEvent } = require('../core/db');
const { encrypt, decrypt } = require('../core/crypto');
const { createLogger } = require('../core/logger');

const log = createLogger('telegram');

/** Give up on an unscanned QR after this long so a fresh attempt can start. */
const QR_MAX_WAIT_SEC = 240;

/**
 * Wraps a GramJS MTProto user session.
 *
 * The login flow is driven from the admin panel, so it cannot use GramJS's
 * blocking `client.start()` prompts directly. Instead `start()` is invoked with
 * callbacks that park on deferred promises; the panel resolves them by calling
 * `submitCode()` / `submitPassword()`.
 */
class TelegramService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.me = null;
    this.status = 'disconnected';
    this.lastError = null;
    this.connecting = false;
    this._deferred = { code: null, password: null };
    this._loginPromise = null;
    this._handlerBound = false;
    this.startedAt = null;
    /** Current QR login token, refreshed by GramJS until it is scanned. */
    this.qr = { url: null, expires: 0, generatedAt: 0 };
  }

  // ── persistence ──────────────────────────────────────────────────────────
  record() {
    return db.prepare('SELECT * FROM telegram_account WHERE id = 1').get();
  }

  saveRecord(patch) {
    const cur = this.record() || {};
    const next = { ...cur, ...patch };
    db.prepare(
      `UPDATE telegram_account SET api_id = ?, api_hash_enc = ?, phone = ?, session_enc = ?, status = ?,
       tg_user_id = ?, username = ?, first_name = ?, last_error = ?, connected_at = ?, updated_at = datetime('now')
       WHERE id = 1`
    ).run(
      next.api_id ?? null,
      next.api_hash_enc ?? null,
      next.phone ?? null,
      next.session_enc ?? null,
      next.status ?? 'disconnected',
      next.tg_user_id ?? null,
      next.username ?? null,
      next.first_name ?? null,
      next.last_error ?? null,
      next.connected_at ?? null
    );
  }

  setStatus(status, error = null) {
    this.status = status;
    this.lastError = error;
    this.saveRecord({ status, last_error: error });
    this.emit('status', { status, error });
    log.info(`status → ${status}`, error ? { error } : undefined);
  }

  credentials() {
    const r = this.record();
    if (!r || !r.api_id || !r.api_hash_enc) return null;
    return { apiId: Number(r.api_id), apiHash: decrypt(r.api_hash_enc), phone: r.phone, session: decrypt(r.session_enc || '') };
  }

  isConnected() {
    return !!(this.client && this.client.connected && this.status === 'connected');
  }

  // ── login flow ───────────────────────────────────────────────────────────
  /**
   * Begin (or resume) authentication.
   * @returns {Promise<{status:string}>} resolves as soon as the flow needs input
   *          or has completed — never blocks the HTTP request.
   */
  /**
   * Abandon an in-progress login so a different method can start cleanly.
   *
   * A QR attempt sets `connecting = true` and runs a refresh loop; without
   * this, switching to phone login was rejected with "already in progress"
   * ("QR kutilmoqda") and neither method could recover. Called at the top of
   * both login paths.
   */
  async cancelLogin() {
    if (!this.connecting && !this.qr.url) return;
    log.info('oldingi login urinishi bekor qilinmoqda', { status: this.status });
    try {
      for (const slot of ['code', 'password']) {
        if (this._deferred[slot]) this._deferred[slot].reject(new Error('cancelled'));
        this._deferred[slot] = null;
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.client && !this.isConnected()) await this.client.disconnect().catch(() => {});
    } catch {
      /* ignore */
    }
    this.connecting = false;
    this.qr = { url: null, expires: 0, generatedAt: 0 };
    this._loginPromise = null;
  }

  async login({ apiId, apiHash, phone, forceSms = false } = {}) {
    if (this.isConnected()) return { status: this.status, message: 'already connected' };
    await this.cancelLogin();

    // Only overwrite stored credentials with a genuinely valid api_id. A
    // browser once autofilled the admin username into the API ID field and
    // Number("anitoku") = NaN silently broke the saved account. Phone updates
    // on its own so the founder can re-login without retyping api_id/hash.
    const validApiId = /^\d{5,}$/.test(String(apiId || ''));
    if (validApiId && apiHash) {
      this.saveRecord({ api_id: Number(apiId), api_hash_enc: encrypt(String(apiHash).trim()), phone: phone ? String(phone).trim() : (this.record() || {}).phone, session_enc: '', status: 'connecting' });
    } else if (phone) {
      this.saveRecord({ phone: String(phone).trim(), session_enc: '', status: 'connecting' });
    }
    const creds = this.credentials();
    if (!creds) throw new Error('api_id, api_hash va telefon raqam kiritilishi shart');

    this.connecting = true;
    this._deferred.code = deferred();
    this._deferred.password = deferred();
    this.setStatus('connecting');

    const session = new StringSession(creds.session || '');
    this.client = new TelegramClient(session, creds.apiId, creds.apiHash, {
      connectionRetries: 8,
      retryDelay: 2000,
      autoReconnect: true,
      useWSS: false,
      floodSleepThreshold: 120,
      deviceModel: 'ANITOKU Support Agent',
      systemVersion: 'Node ' + process.versions.node,
      appVersion: '1.0.0',
      langCode: 'uz',
    });
    this.client.setLogLevel('error');

    // Runs in the background; the HTTP handler returns immediately.
    this._loginPromise = this.client
      .start({
        phoneNumber: async () => creds.phone,
        forceSMS: forceSms,
        phoneCode: async () => this._awaitInput('code', 'awaiting_code'),
        password: async () => this._awaitInput('password', 'awaiting_password'),
        onError: (err) => this._onAuthError(err),
      })
      .then(() => this._finalizeLogin('phone'))
      .catch((err) => {
        log.error('login failed', { error: err.message });
        this.setStatus('error', err.message);
        recordEvent('telegram', 'Telegram login failed', { error: err.message }, 'error');
      })
      .finally(() => {
        this.connecting = false;
      });

    // Give the flow a beat to reach its first prompt so the panel sees the real state.
    await sleep(1500);
    return { status: this.status, error: this.lastError };
  }

  /**
   * Park until the panel supplies a code / 2FA password, then re-arm.
   *
   * GramJS drives auth with a `while(1)` retry loop: if a submitted value is
   * rejected it calls this callback again. A one-shot deferred would hand back
   * the same already-resolved value forever, spinning on the bad input — so the
   * slot is refreshed after every consumption and the next call genuinely waits
   * for a fresh submit.
   */
  async _awaitInput(slot, status) {
    if (!this._deferred[slot]) this._deferred[slot] = deferred();
    this.setStatus(status, this.lastError);
    const value = await this._deferred[slot].promise;
    this._deferred[slot] = deferred();
    return value;
  }

  /**
   * Decide whether an auth error is fatal.
   *
   * Returning true makes GramJS abort with AUTH_USER_CANCEL, which throws away
   * the phone-code session — so a mistyped 2FA password would force the user to
   * request a brand new SMS code. Recoverable input errors therefore return
   * false: the loop re-prompts and the panel simply asks again.
   */
  _onAuthError(err) {
    const msg = String(err && (err.errorMessage || err.message) ? err.errorMessage || err.message : err);
    const recoverable = /PASSWORD_HASH_INVALID|PHONE_CODE_INVALID|PHONE_CODE_EMPTY|CODE_INVALID|PASSWORD_EMPTY|Password is empty|Code is empty/i.test(msg);

    if (recoverable) {
      const friendly = /PASSWORD|Password/.test(msg)
        ? "2FA paroli noto'g'ri — qayta kiriting"
        : "Kod noto'g'ri yoki eskirgan — qayta kiriting";
      log.warn('recoverable auth error', { error: msg });
      this.lastError = friendly;
      this.saveRecord({ last_error: friendly });
      return false; // let GramJS re-prompt; the session stays alive
    }

    log.warn('login error', { error: msg });
    this.setStatus('error', msg);
    return true;
  }

  /** Shared success path for every login method. */
  async _finalizeLogin(method) {
    const saved = this.client.session.save();
    this.me = await this.client.getMe();
    this.saveRecord({
      session_enc: encrypt(saved),
      status: 'connected',
      tg_user_id: String(this.me.id),
      username: this.me.username || null,
      first_name: this.me.firstName || null,
      last_error: null,
      connected_at: new Date().toISOString(),
    });
    this.startedAt = Date.now();
    this.qr = { url: null, expires: 0, generatedAt: 0 };
    this.setStatus('connected');
    this.bindHandlers();
    recordEvent('telegram', 'Telegram account connected', { method, username: this.me.username, id: String(this.me.id) });
    this.emit('connected', this.me);
  }

  /**
   * QR login. Telegram issues a short-lived token that the user scans from
   * their phone (Settings → Devices → Link Desktop Device). GramJS refreshes
   * the token automatically until it is accepted, calling `qrCode` each time —
   * the panel just polls `qrState()` and re-renders.
   *
   * Note: api_id / api_hash are still required. They identify the *application*
   * that talks to Telegram, not the account, so no login method can skip them.
   */
  async loginQr({ apiId, apiHash } = {}) {
    if (this.isConnected()) return this.qrState();
    await this.cancelLogin();

    // Never let a non-numeric api_id (browser autofill) overwrite good creds.
    if (/^\d{5,}$/.test(String(apiId || '')) && apiHash) {
      this.saveRecord({
        api_id: Number(apiId),
        api_hash_enc: encrypt(String(apiHash).trim()),
        session_enc: '',
        status: 'connecting',
      });
    }
    const rec = this.record();
    if (!rec || !rec.api_id || !rec.api_hash_enc) throw new Error('api_id va api_hash kiritilishi shart');

    const creds = { apiId: Number(rec.api_id), apiHash: decrypt(rec.api_hash_enc) };

    this.connecting = true;
    this._deferred.password = deferred();
    this.qr = { url: null, expires: 0, generatedAt: 0 };
    this.setStatus('connecting');

    this.client = new TelegramClient(new StringSession(''), creds.apiId, creds.apiHash, {
      connectionRetries: 8,
      retryDelay: 2000,
      autoReconnect: true,
      useWSS: false,
      floodSleepThreshold: 120,
      deviceModel: 'ANITOKU Support Agent',
      systemVersion: 'Node ' + process.versions.node,
      appVersion: '1.0.0',
      langCode: 'uz',
    });
    this.client.setLogLevel('error');

    // Phone login goes through client.start(), which connects for us; the QR
    // flow does not, so signInUserWithQrCode threw "Cannot send requests while
    // disconnected". Connect first, then start the QR exchange.
    this._loginPromise = this.client
      .connect()
      .then(() =>
        this.client.signInUserWithQrCode(
        { apiId: creds.apiId, apiHash: creds.apiHash },
        {
          qrCode: async (code) => {
            const token = Buffer.from(code.token).toString('base64url');
            this.qr = {
              url: `tg://login?token=${token}`,
              expires: Number(code.expires) * 1000,
              generatedAt: Date.now(),
            };
            this.setStatus('awaiting_qr');
            log.info('QR token yangilandi', { expiresInSec: Math.round((this.qr.expires - Date.now()) / 1000) });
          },
          password: async () => this._awaitInput('password', 'awaiting_password'),
          onError: async (err) => this._onAuthError(err),
        }
        )
      )
      .then(() => this._finalizeLogin('qr'))
      .catch((err) => {
        log.error('QR login failed', { error: err.message });
        this.setStatus('error', err.message);
        recordEvent('telegram', 'QR login failed', { error: err.message }, 'error');
      })
      .finally(() => {
        this.connecting = false;
      });

    // Wait briefly for the first token so the panel can render immediately.
    for (let i = 0; i < 30 && !this.qr.url && this.status !== 'error'; i++) await sleep(300);
    return this.qrState();
  }

  /**
   * Current QR login state.
   *
   * GramJS refreshes the token every ~30 s while it waits, but if that loop
   * dies — a dropped socket, a rejected promise nobody surfaced — the panel
   * kept showing "waiting for QR" forever with a token that had long expired.
   * A stale token is therefore reported as such, and after a few minutes with
   * no scan the attempt is abandoned so a fresh one can start cleanly.
   */
  qrState() {
    const expiresInSec = this.qr.expires ? Math.max(0, Math.round((this.qr.expires - Date.now()) / 1000)) : 0;
    const ageSec = this.qr.generatedAt ? Math.round((Date.now() - this.qr.generatedAt) / 1000) : 0;
    const stale = this.status === 'awaiting_qr' && this.qr.url && expiresInSec === 0 && ageSec > 40;
    const abandoned = this.status === 'awaiting_qr' && ageSec > QR_MAX_WAIT_SEC;

    if (abandoned) {
      log.warn('QR login javobsiz qoldi — bekor qilinmoqda', { ageSec });
      this.cancelLogin().catch(() => {});
      this.setStatus('disconnected', 'QR kod skanerlanmadi — qaytadan urinib koʻring');
      return { status: this.status, url: null, expiresInSec: 0, generatedAt: 0, error: this.lastError, expired: true };
    }

    return {
      status: this.status,
      url: this.qr.url,
      expiresInSec,
      generatedAt: this.qr.generatedAt,
      ageSec,
      stale: !!stale,
      error: this.lastError,
      // The panel uses this to offer "try again" instead of spinning forever.
      canRetry: this.status === 'awaiting_qr' || this.status === 'error' || this.status === 'disconnected',
    };
  }

  submitCode(code) {
    if (!this._deferred.code) throw new Error('Kod kutilmayapti');
    this.lastError = null;
    this._deferred.code.resolve(String(code).replace(/\D/g, ''));
    return true;
  }

  submitPassword(password) {
    const pw = String(password ?? '');
    if (!pw) throw new Error("2FA paroli bo'sh");
    if (!this._deferred.password) throw new Error('2FA paroli kutilmayapti');
    this.lastError = null;
    this._deferred.password.resolve(pw);
    return true;
  }

  /** Reconnect using the stored session — used on boot and by the watchdog. */
  async resume() {
    const creds = this.credentials();
    if (!creds || !creds.session) {
      this.setStatus('disconnected');
      return false;
    }
    if (this.connecting) return false;
    this.connecting = true;
    try {
      this.client = new TelegramClient(new StringSession(creds.session), creds.apiId, creds.apiHash, {
        connectionRetries: 10,
        retryDelay: 3000,
        autoReconnect: true,
        useWSS: false,
        floodSleepThreshold: 120,
        deviceModel: 'ANITOKU Support Agent',
        systemVersion: 'Node ' + process.versions.node,
        appVersion: '1.0.0',
        langCode: 'uz',
      });
      this.client.setLogLevel('error');
      await this.client.connect();
      if (!(await this.client.isUserAuthorized())) {
        this.setStatus('disconnected', 'Sessiya yaroqsiz — qayta login qiling');
        return false;
      }
      this.me = await this.client.getMe();
      this.startedAt = Date.now();
      this.saveRecord({
        status: 'connected',
        tg_user_id: String(this.me.id),
        username: this.me.username || null,
        first_name: this.me.firstName || null,
        last_error: null,
      });
      this.setStatus('connected');
      this.bindHandlers();
      this.emit('connected', this.me);
      return true;
    } catch (err) {
      log.error('resume failed', { error: err.message });
      this.setStatus('error', err.message);
      return false;
    } finally {
      this.connecting = false;
    }
  }

  async logout({ revoke = false } = {}) {
    try {
      if (this.client) {
        if (revoke && this.client.connected) await this.client.invoke(new Api.auth.LogOut());
        await this.client.disconnect().catch(() => {});
      }
    } catch (err) {
      log.warn('logout error', { error: err.message });
    }
    this.client = null;
    this.me = null;
    this._handlerBound = false;
    this.qr = { url: null, expires: 0, generatedAt: 0 };
    this.saveRecord({ session_enc: '', status: 'disconnected', tg_user_id: null, username: null, first_name: null, connected_at: null });
    this.setStatus('disconnected');
  }

  // ── incoming messages ────────────────────────────────────────────────────
  bindHandlers() {
    if (!this.client || this._handlerBound) return;
    this._handlerBound = true;
    this.client.addEventHandler(async (event) => {
      try {
        this.emit('message', event);
      } catch (err) {
        log.error('message handler threw', { error: err.message });
      }
    }, new NewMessage({}));
    log.info('Message handler bound');
  }

  // ── outgoing helpers ─────────────────────────────────────────────────────
  async sendMessage(chatId, text, { replyTo = null, silent = false } = {}) {
    if (!this.isConnected()) throw new Error('Telegram ulanmagan');
    const entity = await this.resolveEntity(chatId);
    return this.client.sendMessage(entity, {
      message: text,
      replyTo: replyTo || undefined,
      silent,
      linkPreview: false,
    });
  }

  async setTyping(chatId, on = true) {
    if (!this.isConnected()) return;
    try {
      const entity = await this.resolveEntity(chatId);
      await this.client.invoke(
        new Api.messages.SetTyping({
          peer: entity,
          action: on ? new Api.SendMessageTypingAction() : new Api.SendMessageCancelAction(),
        })
      );
    } catch {
      /* typing indicator is cosmetic */
    }
  }

  /**
   * Set the account's presence.
   *
   * Telegram only keeps a user "online" for roughly a minute after each
   * UpdateStatus, so staying visibly online requires periodic refreshing —
   * see the presence loop in index.js.
   */
  async setOnline(online = true) {
    if (!this.isConnected()) return false;
    try {
      await this.client.invoke(new Api.account.UpdateStatus({ offline: !online }));
      return true;
    } catch (err) {
      log.debug('presence update failed', { error: err.message });
      return false;
    }
  }

  async markRead(chatId) {
    if (!this.isConnected()) return;
    try {
      const entity = await this.resolveEntity(chatId);
      await this.client.markAsRead(entity);
    } catch {
      /* non-critical */
    }
  }

  /**
   * Resolve anything (numeric id, -100 form, @username, t.me link) to an entity.
   * Falls back to scanning dialogs, which is how private channels the account
   * belongs to are found when the raw id form is ambiguous.
   */
  async resolveEntity(idOrName) {
    if (!this.isConnected()) throw new Error('Telegram ulanmagan');
    const raw = String(idOrName).trim();

    const attempts = [];
    if (/^-?\d+$/.test(raw)) {
      const n = raw.replace('-100', '').replace('-', '');
      attempts.push(raw, `-100${n}`, n, `-${n}`);
    } else {
      const uname = raw.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').split('/')[0];
      attempts.push(uname, `@${uname}`);
    }

    for (const a of [...new Set(attempts)]) {
      try {
        return await this.client.getEntity(a);
      } catch {
        /* try next form */
      }
    }

    // Last resort: scan dialogs for a matching id.
    const wanted = raw.replace(/^-100/, '').replace(/^-/, '');
    for await (const d of this.client.iterDialogs({ limit: 400 })) {
      const did = String(d.id).replace(/^-100/, '').replace(/^-/, '');
      if (did === wanted) return d.entity;
      if (d.entity && d.entity.username && d.entity.username.toLowerCase() === raw.replace(/^@/, '').toLowerCase()) return d.entity;
    }
    throw new Error(`Chat topilmadi: ${raw}`);
  }

  async getDialogs(limit = 100) {
    if (!this.isConnected()) return [];
    const out = [];
    for await (const d of this.client.iterDialogs({ limit })) {
      out.push({
        id: String(d.id),
        title: d.title || d.name || 'Unknown',
        username: (d.entity && d.entity.username) || null,
        // A supergroup is a Channel in MTProto terms; isGroup is what people mean.
        type: d.isUser ? 'private' : d.isGroup ? 'group' : 'channel',
        unread: d.unreadCount || 0,
        isUser: !!d.isUser,
      });
    }
    return out;
  }

  info() {
    const r = this.record() || {};
    return {
      status: this.status,
      connected: this.isConnected(),
      phone: r.phone ? String(r.phone).replace(/(\d{3})\d+(\d{2})/, '$1•••••$2') : null,
      username: r.username,
      firstName: r.first_name,
      userId: r.tg_user_id,
      hasApi: !!(r.api_id && r.api_hash_enc),
      hasSession: !!r.session_enc,
      lastError: r.last_error,
      connectedAt: r.connected_at,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
    };
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = new TelegramService();
module.exports.Api = Api;
module.exports.sleep = sleep;
