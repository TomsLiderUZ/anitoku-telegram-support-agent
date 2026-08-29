/**
 * Matndagi havolalarni bosiladigan qiladi.
 *
 * Xabar ichidagi manzil ko'chirib olib, brauzerga qo'lda yopishtirish
 * uchun emas — bosish uchun. Telegram, Instagram va oddiy http
 * havolalari, shuningdek @username va t.me qisqartmalari.
 *
 * NEGA `dangerouslySetInnerHTML` EMAS: xabar matni foydalanuvchidan
 * keladi. HTML sifatida joylash — ixtiyoriy odam panelga skript
 * yuborishi mumkin degani. Bu yerda matn bo'laklarga bo'linib, React
 * elementlari sifatida qaytariladi, ya'ni hech qachon HTML bo'lib
 * talqin qilinmaydi.
 */

// Tartib muhim: to'liq URL avval, keyin t.me, keyin @username.
const PATTERN =
  /(https?:\/\/[^\s<>"']+|(?:^|\s)t\.me\/[A-Za-z0-9_+/-]+|(?:^|\s)@[A-Za-z][A-Za-z0-9_]{3,31})/g;

/** Ko'rinadigan matnni qisqartiradi — uzun URL qatorni buzib yuboradi. */
const shorten = (url, max = 48) => (url.length > max ? `${url.slice(0, max - 1)}…` : url);

export function linkify(text, { max = 48 } = {}) {
  const source = String(text ?? "");
  if (!source) return source;

  const out = [];
  let last = 0;
  let match;

  PATTERN.lastIndex = 0;
  while ((match = PATTERN.exec(source)) !== null) {
    const raw = match[0];
    // Shablon oldidagi bo'sh joyni ham ushlaydi — uni havolaga
    // qo'shib yubormaymiz, aks holda havola matni bo'sh joydan
    // boshlanardi.
    const lead = raw.match(/^\s+/)?.[0] || "";
    const token = raw.slice(lead.length);
    const start = match.index + lead.length;

    if (start > last) out.push(source.slice(last, start));

    let href;
    if (token.startsWith("http")) href = token;
    else if (token.startsWith("t.me/")) href = `https://${token}`;
    else href = `https://t.me/${token.slice(1)}`;

    out.push(
      <a
        key={`${start}-${token}`}
        href={href}
        target="_blank"
        // noreferrer bo'lmasa ochilgan sahifa `window.opener` orqali
        // shu sahifani boshqa manzilga yo'naltira oladi
        rel="noopener noreferrer"
        className="link"
        onClick={(e) => e.stopPropagation()}
      >
        {shorten(token, max)}
      </a>
    );

    last = start + token.length;
  }

  if (!out.length) return source;
  if (last < source.length) out.push(source.slice(last));
  return out;
}
