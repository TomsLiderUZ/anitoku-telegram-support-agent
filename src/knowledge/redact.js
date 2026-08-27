'use strict';

/**
 * Training-data hygiene.
 *
 * Everything the agent ingests from real chats can end up in a retrieval hit
 * and therefore in a reply to a stranger. Two levels of defence:
 *
 *   - `isUnsafeForTraining()` — the message is dropped outright (login codes,
 *     private invite links, credentials). These have no support value and
 *     leaking one is a real incident.
 *   - `redact()` — the message is kept but identifiers are masked, so the agent
 *     still learns the shape of the conversation without memorising a phone
 *     number or card.
 */

/** Telegram's own service account — sends login codes and security alerts. */
const SERVICE_SENDER_IDS = new Set(['777000', '42777', '333000']);

const HARD_BLOCK = [
  // Telegram login / verification codes in any of the languages we see.
  /\b(login code|web login|kirish kodi|login kodi|veb login|tasdiqlash kodi|код (для )?вход|verification code|confirmation code)\b/i,
  /\bmy\.telegram\.org\b/i,
  // Private chat/channel invite links — never hand these out.
  /t\.me\/\+[\w-]+/i,
  /t\.me\/joinchat\/[\w-]+/i,
  /\bjoinchat\b/i,
  // Credentials.
  /\b(parol|password|пароль)\s*[:=]\s*\S+/i,
  /\b(2fa|otp|seed phrase|mnemonic)\b/i,
  // Our own secrets, in case an operator ever pasted one into a chat.
  /sk-or-v1-[A-Za-z0-9]{16,}/,
  /gsk_[A-Za-z0-9]{20,}/,
  /\bapi[_-]?hash\b/i,
];

const REDACTIONS = [
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[karta]'],
  [/\+998[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g, '[telefon]'],
  [/\+\d{10,15}\b/g, '[telefon]'],
  [/\b\d{9}\b(?!\d)/g, '[raqam]'],
  [/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, '[email]'],
  [/\bt\.me\/\+[\w-]+/gi, '[maxfiy havola]'],
];

/** True when the text must not enter the knowledge base at all. */
function isUnsafeForTraining(text, senderId = null) {
  if (senderId && SERVICE_SENDER_IDS.has(String(senderId))) return true;
  const t = String(text || '');
  if (!t.trim()) return false;
  return HARD_BLOCK.some((re) => re.test(t));
}

/** Mask identifiers in text that is otherwise safe to keep. */
function redact(text) {
  let out = String(text || '');
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

/**
 * Gate one candidate training item.
 * @returns {{ok: boolean, text?: string, reason?: string}}
 */
function clean(text, senderId = null) {
  if (isUnsafeForTraining(text, senderId)) return { ok: false, reason: 'sensitive' };
  const redacted = redact(text);
  if (redacted.trim().length < 4) return { ok: false, reason: 'empty_after_redaction' };
  return { ok: true, text: redacted };
}

module.exports = { isUnsafeForTraining, redact, clean, SERVICE_SENDER_IDS };
