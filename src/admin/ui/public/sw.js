/* eslint-disable no-restricted-globals */
/**
 * ============================================
 * ANITOKU — Service Worker (offline ekrani)
 * ============================================
 *
 * Bu PWA/manifest EMAS va OFFLINE-ILOVA ham emas.
 * Yagona vazifasi: internet yo'q bo'lganda brauzerning
 * "This site can't be reached" (dinozavr) sahifasi o'rniga
 * o'zimizning "Internetga ulanmagansiz" ekranini ko'rsatish.
 *
 * NEGA SAHIFALAR KESHLANMAYDI (ataylab):
 * Bu admin panel — har bir sahifa (statistika, foydalanuvchilar,
 * filmlar) ma'lumotni API'dan oladi. Internetsiz sahifa ochilsa ham
 * bo'sh yoki ESKIRGAN raqamlar ko'rinardi, admin esa ularni hozirgi
 * holat deb qabul qilishi mumkin — bu foydadan ko'ra zarar.
 * Shu sababli offline'da HAR QANDAY sahifa o'rniga bitta ochiq
 * xabar ko'rsatiladi, internet tiklanishi bilan sahifa o'zi ochiladi.
 *
 * ISTISNO — brend rasmlari (favicon, og-image):
 * Ular ma'lumot emas, ya'ni "eskirgan raqam" xavfi yo'q. Keshlanmasa
 * offline ekranida tab ikonkasi bo'sh chiqadi. Shuning uchun faqat
 * shu ikkitasi saqlanadi.
 *
 * Statik fayllar (JS/CSS/shrift) baribir brauzerning O'Z keshidan
 * keladi — vercel.json dagi `immutable` headerlar shuni ta'minlaydi,
 * bunga Service Worker kerak emas.
 */

const VERSION = "v1";
const STATIC_CACHE = `anitoku-static-${VERSION}`;

// Faqat brend rasmlari — sahifa yoki ma'lumot EMAS
// Panel /ui manzilidan beriladi — yoʻl shunga mos
const STATIC_ASSETS = ["/ui/favicon.svg"];

// Sahifa so'rovi shuncha kutgach "internet yo'q" deb hisoblanadi
const NAVIGATION_TIMEOUT_MS = 10000;

/**
 * Offline ekrani SW ICHIGA yozilgan (alohida fayldan olinmaydi).
 *
 * Sabab: alohida `offline.html` ni fetch qilish server sozlamasiga
 * bog'liq bo'lardi — masalan `serve` "clean URLs" tufayli `.html` ga
 * 301 redirect qiladi. Inline HTML esa hech qanday tarmoq/server
 * sozlamasiga bog'liq emas — istalgan hostingda kafolatli ishlaydi.
 *
 * Bu — ilovadagi YAGONA offline ekrani. React tomonda alohida offline
 * sahifasi YO'Q (ataylab): aloqa uzilganda foydalanuvchi OfflineBanner
 * ogohlantirishini ko'rib, sahifasida qolaveradi; sahifani yangilasa
 * yoki qaytadan ochsa — mana shu ekran chiqadi.
 */
const OFFLINE_HTML = `
<!doctype html>
<html lang="uz">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Internetga ulanmagansiz | ANITOKU</title>
  <meta name="description" content="ANITOKU agent boshqaruv paneli.">
  <meta name="application-name" content="ANITOKU Agent">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#0b0d12">
  <link rel="icon" href="/ui/favicon.svg" type="image/svg+xml">
  <script>
    (function(){try{var t=localStorage.getItem("theme"),d=t!=="light"&&(t!=="auto"||matchMedia("(prefers-color-scheme:dark)").matches);document.documentElement.className=d?"dark":"light";document.querySelector('meta[name=theme-color]').content=d?"#0b0d12":"#f3f4f8"}catch(e){}})()
  </script>
  <style>
    /* Ranglar src/styles/colors.css dan NUSXA — bu yerda var() ishlatib
       bo'lmaydi, chunki offline HTML ilova CSS'isiz ochiladi.
       colors.css o'zgarsa, shu qator ham yangilanishi shart. */
    :root{--b:#0b0d12;--t:#e9ecf3;--s:#a3aab9;--m:#737c8d;--a:#7c6cff;--h:#9184ff}
    .light{--b:#f3f4f8;--t:#12141a;--s:#4c5563;--m:#6b7381;--a:#5b4ae0;--h:#4c3ccc}
    *{box-sizing:border-box;margin:0}
    body{font:14px/1.6 Inter,system-ui,sans-serif;background:var(--b);color:var(--s);display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center}
    container{display:flex;flex-direction:column;align-items:center;gap:14px;max-width:420px;animation:i .25s cubic-bezier(.16,1,.3,1)}
    svg{width:80px;height:80px;color:var(--m);margin-bottom:4px}
    p{max-width:400px}
    h1{color:var(--t);font-size:22px;line-height:1.3}
    button{margin-top:32px;padding:12px 16px;border:0;border-radius:12px;background:var(--a);color:#0a0716;font:600 14px inherit;cursor:pointer;transition:.15s}
    button:hover{background:var(--h)}
    button:disabled{opacity:.6;cursor:default}
    @keyframes i{from{opacity:0;transform:translateY(12px)}}
    @media(prefers-reduced-motion:reduce){container{animation:none}}
  </style>
</head>
<body>
  <main class="container" role="alert" aria-live="polite">
    <svg xmlns="http://www.w3.org/2000/svg" stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" height="1024" width="1024"><g id="Wi-Fi_Off"><g><path d="M10.37,6.564a12.392,12.392,0,0,1,10.71,3.93c.436.476,1.141-.233.708-.708A13.324,13.324,0,0,0,10.37,5.564c-.631.076-.638,1.077,0,1Z"/><path d="M13.907,10.283A8.641,8.641,0,0,1,18.349,12.9c.434.477,1.139-.232.707-.707a9.586,9.586,0,0,0-4.883-2.871c-.626-.146-.893.818-.266.965Z"/><circle cx="12.003" cy="16.922" r="1.12"/><path d="M19.773,19.06a.5.5,0,0,1-.71.71l-5.84-5.84A4.478,4.478,0,0,0,8.7,15.24c-.43.48-1.14-.23-.71-.7a5.47,5.47,0,0,1,4.06-1.78l-2.37-2.37a8.693,8.693,0,0,0-4.03,2.53c-.43.48-1.13-.23-.7-.71A9.439,9.439,0,0,1,8.893,9.6L6.883,7.59a12.557,12.557,0,0,0-3.96,2.94.5.5,0,1,1-.7-.71,13.109,13.109,0,0,1,3.91-2.98l-1.9-1.9a.5.5,0,0,1,.71-.71Z"/></g></g></svg>
    <h1>Internetga ulanmagansiz</h1>
    <p>Aloqa tiklanishi bilan sahifa o'zi ochiladi. Wi-Fi yoki mobil internetni tekshirib ko'ring.</p>
    <button id="retry-button">Qayta urinish</button>
  </main>
  <script>
    var b=document.getElementById("retry-button");b.onclick=function(){b.disabled=!0;b.textContent="Tekshirilmoqda...";location.reload()};addEventListener("online",function(){location.reload()});
  </script>
</body>
</html>
`;

const offlineResponse = () =>
  new Response(OFFLINE_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });

// ─── Install: faqat brend rasmlarini keshlash ─────────────────────
// Offline HTML shu faylning o'zida, shuning uchun u keshlanmaydi.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // allSettled — bittasi yuklanmasa ham o'rnatish davom etadi
      // (cache.addAll bo'lsa butun install yiqilardi)
      await Promise.allSettled(STATIC_ASSETS.map((url) => cache.add(url)));
      await self.skipWaiting();
    })()
  );
});

// ─── Activate: eski versiya keshlarini tozalash ───────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("anitoku-") && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ─── Fetch ────────────────────────────────────────────────────────
// Faqat IKKI narsa ushlanadi: sahifa ochish so'rovlari va brend
// rasmlari. Qolgan hamma narsa (JS, CSS, shrift, API, socket) SW'ga
// umuman kirmaydi — ularni brauzer o'z keshi bilan boshqaradi.
self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Brend rasmlari — tarmoqdan, u yiqilsa keshdan.
  // Network-first: online'da har doim yangisi (brauzer HTTP keshi tufayli
  // bu ham arzon), offline'da esa favicon bo'sh chiqib qolmaydi.
  if (url.origin === self.location.origin && STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(request, { cacheName: STATIC_CACHE });
          if (cached) return cached;
          return Response.error();
        }
      })()
    );
    return;
  }

  if (request.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      // TEZ YO'L: brauzer "tarmoq umuman yo'q" desa (Wi-Fi/mobil internet
      // o'chiq), tarmoqqa urinib o'tirmaymiz — javobni kutish shundoq ham
      // muvaffaqiyatsiz tugaydi. Offline ekrani DARHOL ko'rsatiladi.
      //
      // Teskari holat xavfsiz: `onLine === true` bo'lsa-yu, internet
      // aslida ishlamasa (masalan router bor, lekin WAN yo'q yoki server
      // o'chiq) — pastdagi odatiy fetch ishlaydi va xatoni o'zi ushlaydi.
      //
      // `onLine === false` noto'g'ri qaytgan kam uchraydigan holatda ham
      // foydalanuvchi qamalib qolmaydi: offline sahifa `online` hodisasini
      // tinglab, aloqa tiklanishi bilan o'zi qayta yuklanadi.
      if (self.navigator && self.navigator.onLine === false) {
        return offlineResponse();
      }

      try {
        // TIMEOUT: "lie-fi" holati — router/Wi-Fi bor, lekin internet
        // o'tmayapti. Bunda fetch xato bermaydi, shunchaki osilib turadi
        // va brauzerning o'z timeout'igacha (ba'zan 1-2 daqiqa) foydalanuvchi
        // bo'sh ekranga qaraydi. 10s — sekin mobil internet uchun ham
        // yetarli zaxira, lekin cheksiz kutishdan qutqaradi.
        return await Promise.race([
          fetch(request),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("navigation timeout")), NAVIGATION_TIMEOUT_MS)
          ),
        ]);
      } catch {
        return offlineResponse();
      }
    })()
  );
});

// VERSION o'zgarganda brauzer bu faylni yangi deb hisoblaydi va
// activate ishga tushib eski keshlarni tozalaydi.
void VERSION;
