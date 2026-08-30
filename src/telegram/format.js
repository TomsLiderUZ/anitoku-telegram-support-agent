'use strict';

/**
 * Telegram HTML formatlash.
 *
 * NEGA SANITIZATSIYA KERAK
 *
 * Telegram HTML ni juda tor doirada qabul qiladi: faqat sanab o'tilgan
 * teglar, faqat yopilgan holda. Bitta ortiqcha "<" yoki yopilmagan teg
 * butun xabarni rad ettiradi (400), ya'ni foydalanuvchi HECH NARSA
 * olmaydi. Model esa matnni erkin yozadi: kod ichida "<", matematikada
 * "a < b", ba'zan yopilmagan teg.
 *
 * Shuning uchun matn Telegramga berilishidan oldin shu yerdan o'tadi:
 * ruxsat etilgan teglar saqlanadi, qolgan hamma narsa xavfsiz matnga
 * aylantiriladi, ochiq qolgan teglar yopiladi.
 *
 * Bu — go'zallik uchun emas, ishonchlilik uchun. Formatlash buzilsa
 * xabar yo'qoladi; xabar esa formatdan muhimroq.
 */

/** Telegram qo'llab-quvvatlaydigan teglar (Bot API "HTML style"). */
const ALLOWED = new Set([
  'b', 'strong',
  'i', 'em',
  'u', 'ins',
  's', 'strike', 'del',
  'code', 'pre',
  'a',
  'tg-spoiler',
  'blockquote',
]);

/** Yopilishi shart bo'lmagan teg yo'q — hammasi juftlik. */
const escapeText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * `<a>` uchun faqat href, `<code>` uchun faqat class — boshqa atributlar
 * Telegramda xatolikka olib keladi, shuning uchun tashlab yuboriladi.
 */
function rebuildTag(name, raw) {
  if (name === 'a') {
    const href = raw.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
    const url = href ? (href[2] ?? href[3] ?? '') : '';
    // Faqat xavfsiz sxemalar: javascript: kabi narsa hech qachon o'tmasin
    if (!/^(https?:\/\/|tg:\/\/)/i.test(url)) return null;
    return `<a href="${escapeText(url)}">`;
  }
  // Til belgisi faqat <code> da bo'ladi: Telegram kod blokini
  // <pre><code class="language-js"> ko'rinishida kutadi, <pre class=...> ni emas.
  if (name === 'code') {
    const cls = raw.match(/class\s*=\s*("([^"]*)"|'([^']*)')/i);
    const value = cls ? (cls[2] ?? cls[3] ?? '') : '';
    if (/^language-[\w+#.-]+$/i.test(value)) return `<code class="${escapeText(value)}">`;
    return '<code>';
  }
  return `<${name}>`;
}

/**
 * Model yozgan matnni Telegram qabul qiladigan HTML ga aylantiradi.
 *
 * Ruxsat etilmagan teg — matn sifatida ko'rsatiladi, o'chirilmaydi:
 * model `<div>` yozgan bo'lsa, foydalanuvchi buni ko'rgani ma'qul,
 * jimgina yo'qolganidan ko'ra.
 */
function toTelegramHtml(input) {
  const src = String(input ?? '');
  let out = '';
  let last = 0;
  const stack = [];

  const TAG = /<\/?([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  let m;

  while ((m = TAG.exec(src)) !== null) {
    out += escapeText(src.slice(last, m.index));
    last = TAG.lastIndex;

    const whole = m[0];
    const name = m[1].toLowerCase();
    const closing = whole.startsWith('</');

    if (!ALLOWED.has(name)) {
      out += escapeText(whole);
      continue;
    }

    if (closing) {
      // Ochilmagan yopuvchi teg — matn sifatida qoldiramiz, aks holda
      // Telegram butun xabarni rad etadi.
      const at = stack.lastIndexOf(name);
      if (at === -1) {
        out += escapeText(whole);
        continue;
      }
      // Ichkarida ochiq qolganlarini avval yopamiz
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }

    const rebuilt = rebuildTag(name, m[2] || '');
    if (!rebuilt) {
      out += escapeText(whole);
      continue;
    }
    out += rebuilt;
    stack.push(name);
  }

  out += escapeText(src.slice(last));
  // Yopilmay qolganlarini yopamiz — eng ko'p uchraydigan xato shu
  while (stack.length) out += `</${stack.pop()}>`;

  return out;
}

/** Formatlashsiz yuborish uchun: teglarni olib tashlab, toza matn. */
function toPlainText(input) {
  return String(input ?? '')
    .replace(/<\/?[a-zA-Z][\w-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Matnda formatlash belgilari umuman bormi? Bo'lmasa parse mode kerak emas. */
const hasMarkup = (s) => /<\/?[a-zA-Z][\w-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/.test(String(s ?? ''));

module.exports = { toTelegramHtml, toPlainText, hasMarkup, ALLOWED };
