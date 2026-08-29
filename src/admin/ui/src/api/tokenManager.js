/**
 * ============================================
 * ANITOKU — Sessiya belgisi (Token Manager)
 * ============================================
 *
 * Interfeys dodakino'nikidan — `hasAccessToken()`, `clearTokens()`,
 * `getUserFromToken()`, `isAuthenticated()`. Router va layout aynan
 * shularga tayanadi, shuning uchun nomlar saqlangan.
 *
 * ICHKARIDA ESA BOSHQACHA, va buni bilish muhim:
 *
 * Backend JWT emas, SESSIYA COOKIE ishlatadi (`anitoku_sid`), u esa
 * HttpOnly — JavaScript uni prinsipial jihatdan o'qiy olmaydi. Bu
 * to'g'ri qaror: XSS bo'lganda ham sessiya o'g'irlanmaydi. Lekin
 * router'ga "kirganmi yoki yo'q" degan savolga SINXRON (0 ms) javob
 * kerak — aks holda har sahifa ochilishida avval so'rov kutilib,
 * keyin layout chizilardi.
 *
 * Yechim: login muvaffaqiyatli bo'lganda oddiy, HttpOnly BO'LMAGAN
 * belgi cookie qo'yiladi — ichida faqat admin nomi va roli. U SIR
 * EMAS va hech narsani ochmaydi: uni qo'lda yasagan odam ham API'dan
 * bitta ham javob ololmaydi, chunki server faqat haqiqiy HttpOnly
 * sessiyaga qaraydi. Bu belgining yagona vazifasi — birinchi kadrda
 * qaysi ekranni chizishni bilish. Server 401 qaytarsa (belgi bor,
 * sessiya yo'q) interceptor uni tozalab, /auth ga yuboradi.
 */

const MARKER_KEY = "anitoku_admin";

const setCookie = (name, value, rememberMe) => {
  let cookieString = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Lax;`;

  // Secure faqat https da — http (lokal) da Secure cookie ba'zi
  // brauzerlarda umuman yozilmaydi.
  if (window.location.protocol === "https:") {
    cookieString += " Secure;";
  }

  if (rememberMe) {
    const d = new Date();
    d.setTime(d.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 kun
    cookieString += ` expires=${d.toUTCString()};`;
  }
  document.cookie = cookieString;
};

const getCookie = (name) => {
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[2]) : null;
};

const deleteCookie = (name) => {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax;`;
};

export const TokenManager = {
  // ─── Belgi ────────────────────────────────────────────────────
  /** Login javobidagi admin ma'lumotini belgi sifatida saqlaydi. */
  setSession(admin, rememberMe = true) {
    if (!admin) return;
    setCookie(MARKER_KEY, JSON.stringify({ u: admin.username, r: admin.role }), rememberMe);
  },

  /** Eski nom — auth xizmati shu orqali chaqiradi. */
  setTokens(admin, _unused = null, rememberMe = true) {
    this.setSession(admin, rememberMe);
  },

  clearTokens() {
    deleteCookie(MARKER_KEY);
    // Zaxira: ilgari boshqa saqlagichda qolgan bo'lsa
    localStorage.removeItem(MARKER_KEY);
    sessionStorage.removeItem(MARKER_KEY);
  },

  // ─── O'qish ───────────────────────────────────────────────────
  /**
   * Sessiya belgisi bormi? Sinxron, tarmoqsiz — router aynan shuni
   * so'raydi. "Bor" degani "albatta amal qiladi" degani EMAS: haqiqiy
   * tekshiruv birinchi API so'rovida serverda bo'ladi.
   */
  hasAccessToken() {
    return Boolean(getCookie(MARKER_KEY));
  },

  getUserFromToken() {
    const raw = getCookie(MARKER_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return { username: parsed.u, role: parsed.r };
    } catch {
      // Buzilgan belgi — yo'q deb hisoblaymiz, aks holda panel
      // tushunarsiz holatda qotib qolardi.
      return null;
    }
  },

  isAuthenticated() {
    return this.hasAccessToken();
  },
};
