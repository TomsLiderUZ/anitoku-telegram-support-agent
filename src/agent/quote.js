'use strict';

/**
 * Iqtibos qilingan (reply) xabarni foydalanuvchi xabariga qo'shish.
 *
 * NEGA BU KERAK
 *
 * Telegramda eski xabarga javob berish — gapning YARMINI o'sha xabarga
 * yuklash demak. "shu backendning MongoDB URLini ber", "buni tuzat",
 * "yana bir marta qil" — bu jumlalar o'z-o'zicha ma'nosiz.
 *
 * Ilgari iqtibosdan faqat "menga javob berildimi?" degan ha/yo'q
 * olinardi, MATNI esa modelga umuman yetmasdi. Shuning uchun agent
 * "shu" nimaga ishora qilayotganini yaqin tarixdan taxmin qilardi va
 * ko'pincha butunlay boshqa narsa haqida javob berardi.
 *
 * Iqtibos xabarning OLDIGA qo'yiladi — o'qish tartibi shunday: avval
 * nimaga javob berilayotgani, keyin javobning o'zi.
 */
function withQuote(text, quoted) {
  if (!quoted || !quoted.text) return String(text ?? '');

  const who = quoted.fromMe ? 'SEN yozgan eding' : (quoted.author || 'u') + ' yozgan edi';

  return [
    '[U QUYIDAGI XABARGA JAVOB BERMOQDA — ' + who + ']',
    '"""',
    quoted.text,
    '"""',
    '',
    '[Uning yangi xabari]',
    String(text ?? ''),
    '',
    'DIQQAT: "shu", "buni", "u", "o\'sha" kabi so\'zlar deyarli har doim ' +
      'yuqoridagi iqtibosga ishora qiladi, yaqin suhbatga emas. Avval iqtibosni ' +
      'o\'qib, aynan nima nazarda tutilayotganini aniqla — keyin javob ber.',
  ].join('\n');
}

module.exports = { withQuote };
