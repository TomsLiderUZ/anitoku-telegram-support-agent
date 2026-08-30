'use strict';
const { db } = require('../core/db');

/**
 * Bir xil javob shakli takrorlanishiga qarshi.
 *
 * MUAMMO
 *
 * Har bir tasdiq bitta qolipdan chiqardi:
 *
 *   "Yosh Usta, Mirvohidga "Xabar" deb yozib yubordim. ✅"
 *   "Yosh Usta, Ogʻabekka "Salom" deb yozib yubordim. ✅"
 *
 * Promptda "har safar ism bilan boshlama, har safar ✅ qo'yma" deb
 * yozilgan, lekin model o'zining oldingi javoblarini ko'rmaydi — u har
 * safar noldan boshlaydi va har safar bitta xil "eng to'g'ri" shaklni
 * tanlaydi. Ko'rsatma yetarli emas, chunki takrorlanish faqat javoblar
 * ketma-ketligida ko'rinadi.
 *
 * YECHIM
 *
 * Ikki qatlam. Birinchisi — modelga o'zining oxirgi javoblarini
 * ko'rsatish, ya'ni nimani takrorlamasligini bilishi uchun. Ikkinchisi —
 * shunda ham takrorlansa, muhrni deterministik olib tashlash.
 *
 * Matnning o'zi qayta yozilmaydi: faqat takrorlangan bezak (boshdagi
 * murojaat, oxiridagi ✅) olinadi. Modelning jumlasini mashina qayta
 * tuzsa, u yanada sun'iyroq chiqadi.
 */

/** Oxirgi N ta chiquvchi xabar, yangisidan eskisiga. */
function recentOutgoing(chatId, limit = 4) {
  try {
    return db
      .prepare(
        `SELECT text FROM messages
         WHERE tg_chat_id = ? AND is_outgoing = 1 AND text IS NOT NULL AND length(trim(text)) > 0
         ORDER BY date DESC, tg_msg_id DESC LIMIT ?`
      )
      .all(String(chatId), limit)
      .map((r) => String(r.text).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Javobning "shakli": boshlanishi — takrorlanish shu yerda ko'rinadi. */
const opening = (s) => String(s).replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');

const endsWithTick = (s) => /[✅✔️☑️👍]\s*$/.test(String(s).trim());

/** Boshidagi murojaat: "Yosh Usta," / "Yosh Usta —" va h.k. */
const ADDRESS = /^\s*yosh\s*usta\s*[,—–:!.]*\s*/i;

/**
 * Modelga o'zining oxirgi javoblarini ko'rsatuvchi eslatma.
 *
 * Bu ta'qiq emas, ma'lumot: model qanday boshlaganini ko'rsa, o'zi
 * boshqacha boshlaydi. Qattiq qoida yozilsa (masalan "ismni ishlatma"),
 * u kerak bo'lgan joyda ham ishlatmay qo'yadi.
 */
function varietyNote(chatId) {
  const last = recentOutgoing(chatId, 3);
  if (last.length < 2) return '';

  const shapes = last.map((t) => `"${opening(t)}…"`).join(', ');
  const ticks = last.filter(endsWithTick).length;

  const lines = [
    '# SENING OXIRGI JAVOBLARING (shu chatda)',
    `Shunday boshlagansan: ${shapes}`,
    'Keyingi javobingni boshqacha boshla — bir xil ochilish ketma-ket kelsa, javob mashina muhriga o‘xshaydi.',
  ];
  if (ticks >= 2) lines.push(`Oxirgi ${ticks} javobing ✅ bilan tugagan. Bu safar ✅ qo‘yma.`);
  return lines.join('\n');
}

/**
 * Ketma-ket takrorlangan bezakni olib tashlash.
 *
 * Faqat OLDINGI javob ham xuddi shunday bo'lgan holatda ishlaydi. Bitta
 * "Yosh Usta," yoki bitta ✅ da yomon narsa yo'q — yomoni ularning har
 * safar takrorlanishi.
 */
function destamp(text, chatId) {
  let out = String(text || '');
  if (!out.trim()) return out;

  const prev = recentOutgoing(chatId, 1)[0];
  if (!prev) return out;

  if (ADDRESS.test(out) && ADDRESS.test(prev)) {
    const stripped = out.replace(ADDRESS, '').trim();
    // Javob faqat murojaatdan iborat bo'lsa, tegmaymiz.
    if (stripped) out = stripped[0].toUpperCase() + stripped.slice(1);
  }

  if (endsWithTick(out) && endsWithTick(prev)) {
    out = out.replace(/\s*[✅✔️☑️👍]+\s*$/, '').trim();
  }

  return out;
}

module.exports = { varietyNote, destamp, recentOutgoing, opening, endsWithTick };
