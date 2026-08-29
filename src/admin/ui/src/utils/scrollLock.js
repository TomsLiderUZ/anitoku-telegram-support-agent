/**
 * Sahifani surilishdan qulflash — hisoblagich bilan.
 *
 * NEGA HISOBLAGICH: oyna ustiga oyna ochilishi mumkin (masalan
 * "Yana" varag'i ustiga tasdiqlash oynasi). Har biri o'zi qulflab,
 * o'zi ochsa, ichkaridagisi yopilganda tashqarisi hali ochiq bo'lsa
 * ham sahifa qulfdan chiqib ketardi.
 *
 * VA NEGA `overflow` NI ESLAB QOLAMIZ: dodakino globals.css da
 * `body { overflow-y: overlay }` yozilgan. Qulfni "" ga tiklash uni
 * o'chirib yuborardi va sahifa boshqacha surilib qolardi — shuning
 * uchun oldingi QIYMAT saqlanadi, "yo'q" emas.
 */

let depth = 0;
let previousOverflow = "";

export function lockScroll() {
  if (depth === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  depth += 1;

  let released = false;
  // Har bir chaqiruv OʻZ qulfini bir marta ochadi. Ikki marta chaqirish
  // (React'ning qat'iy rejimida effektlar ikki marta ishlaydi) hisobni
  // manfiyga tushirib, keyingi qulfni umuman ishlamas qilib qoʻyardi.
  return function unlock() {
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    if (depth === 0) document.body.style.overflow = previousOverflow;
  };
}

/**
 * Zaxira: nima bo'lganda ham sahifani surilishga qaytaradi.
 *
 * Qulf qoldiqda qolib ketsa (kutilmagan xato, komponent tozalanmay
 * yo'q bo'lsa) foydalanuvchi butunlay qamalib qoladi va buni
 * tuzatishning yagona yo'li sahifani yangilash bo'lardi. Router har
 * sahifa almashganda shuni chaqiradi.
 */
export function releaseScroll() {
  depth = 0;
  document.body.style.overflow = previousOverflow || "";
}
