/**
 * ============================================
 * ANITOKU — NProgress (yuklanish chizig'i)
 * ============================================
 *
 * Yagona sozlangan nusxa. Barcha joylar shu moduldan import qiladi,
 * shunda sozlama bir marta va bir xil qo'llanadi.
 *
 * Qayerlarda ishga tushadi:
 *  1. Sahifa birinchi ochilishi / reload — index.js da start,
 *     birinchi sahifa chizilganda (PageTransition) done
 *  2. Yangi sahifaga o'tish — router/index.jsx dagi RouteProgress
 *  3. Lazy chunk yuklanishi — renderRoutes.jsx dagi RouteFallback
 *  4. API so'rovlari — api/client.js interceptorlari
 */

import NProgress from "nprogress";

// speed/trickleSpeed kichik — bar tez harakatlanadi va done() bo'lgach
// cho'zilib turmaydi (avvalgi 400ms "sekinlik" hissi berardi)
NProgress.configure({ showSpinner: false, minimum: 0.15, speed: 200, trickleSpeed: 150 });

export default NProgress;
