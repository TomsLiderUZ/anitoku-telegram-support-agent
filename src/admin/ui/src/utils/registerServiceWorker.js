/**
 * Service Worker ro'yxatdan o'tkazish (offline ekrani uchun).
 *
 * Dev-rejimda ham yoqilgan — offline xatti-harakatini `npm start` da
 * ham sinab ko'rish uchun. Bu xavfsiz, chunki sw.js JS/CSS bundle'larga
 * UMUMAN tegmaydi: u faqat sahifa ochish so'rovlarini (offline ekrani
 * uchun) va ikkita brend rasmini ushlaydi. Ya'ni eski kod keshdan
 * berilib qolishi mumkin emas.
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  const register = () => {
    navigator.serviceWorker
      .register(`${process.env.PUBLIC_URL}/sw.js`)
      .catch((err) => {
        console.warn("[SW] ro'yxatdan o'tmadi:", err);
      });
  };

  // Ro'yxatdan o'tkazish sahifa yuklanib bo'lgach — birinchi render
  // uchun tarmoq/protsessor band qilinmasin.
  //
  // MUHIM: `load` ALLAQACHON bo'lib o'tgan bo'lsa (bu funksiya kech
  // chaqirilsa yoki sahifa keshdan tez ochilsa), addEventListener
  // hech qachon ishlamaydi va SW umuman ro'yxatdan o'tmaydi.
  // Shuning uchun avval holatni tekshiramiz.
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}
