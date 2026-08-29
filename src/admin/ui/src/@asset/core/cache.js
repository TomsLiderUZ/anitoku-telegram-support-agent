/**
 * @asset/core/cache.js
 * ─────────────────────────────────────────────────────────────
 * Three cache tiers:
 *   1. In-memory LRU Map  (fastest, HMR-safe — window da saqlanadi)
 *   2. Cache API          (persistent across page reloads, TTL bilan)
 *   3. Network            (fallback fetch)
 *
 * Optimizatsiyalar:
 *   ▸ LRU (Least Recently Used) — memoryCache 50 ta entry dan oshsa
 *     eng eski va kam ishlatilgan entry chiqariladi
 *   ▸ Reference counting — blob URL faqat UNI ISHLATAYOTGAN
 *     hech qanday komponent qolmaganda revokeObjectURL qilinadi.
 *     LRU evict qilganda ham, clearCache da ham — count > 0 bo'lsa
 *     revoke kechiktiriladi, oxirgi unmount o'zi hal qiladi.
 *   ▸ Cache API TTL — 7 kun o'tgan yozuvlar avtomatik o'chiriladi
 *   ▸ Cache API size limit — 50 MB dan oshsa eng eski yozuvlar o'chiriladi
 * ─────────────────────────────────────────────────────────────
 */

import DOMPurify from 'dompurify';

const CACHE_NAME        = 'asset-cache-v1';
const ALLOWED_PROTOCOLS = /^(https?|data|blob):/i;

/**
 * XAVFSIZLIK: remote URL'dan olingan SVG matni keyinchalik
 * dangerouslySetInnerHTML orqali TO'G'RIDAN-TO'G'RI DOM'ga joylanadi
 * (Icon.jsx). Tashqi manba buzilgan/almashtirilgan bo'lsa, SVG ichida
 * <script>, onload= kabi XSS payload bo'lishi mumkin. Shu sababli har
 * qanday remote SVG DOM'ga yetib borishidan OLDIN shu yerda tozalanadi.
 * Lokal (bundle ichidagi assets/icons) SVG'lar ishonchli hisoblanadi.
 */
const sanitizeSvgText = (svgText) =>
  DOMPurify.sanitize(svgText, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
  });

/* ── Limitlar ────────────────────────────────────────────── */
const LRU_MAX_ENTRIES = 50;
const CACHE_TTL_MS    = 7 * 24 * 60 * 60 * 1000;  // 7 kun
const CACHE_MAX_BYTES = 50 * 1024 * 1024;           // 50 MB

/* ═══════════════════════════════════════════════════════════
 *  Blob Reference Counter (HMR-safe)
 *
 *  Har bir blob URL uchun "nechta komponent ishlatmoqda"
 *  sonini saqlaydi. revokeObjectURL FAQAT count 0 ga
 *  tushganda chaqiriladi — DOM da hali ko'rsatilayotgan
 *  blob hech qachon o'chirilmaydi.
 *
 *  MUHIM (bug tuzatish): revoke qilingan blob URL `memoryCache`da
 *  ALOHIDA saqlanadi (kalit — original url, qiymat — blob url).
 *  Agar faqat revokeObjectURL() chaqirilib, memoryCache tozalanmasa,
 *  keyingi murojaat (masalan HMR orqali komponent qayta mount
 *  bo'lganda) memoryCache'dan ENDI O'LIK bo'lgan blob URL'ni
 *  qaytarib beradi — natija: <img src="blob:..."> ERR_FILE_NOT_FOUND.
 *  Shu sababli `dec()`/`tryRevoke()` revoke qilgan paytda
 *  `memoryCache`dagi BOG'LANGAN kalit(lar)ni ham topib o'chiradi.
 *
 *  API:
 *    blobRefs.inc(url)  — komponent mount / blob oldi
 *    blobRefs.dec(url)  — komponent unmount
 *    blobRefs.tryRevoke(url) — count 0 bo'lsa revoke
 * ═══════════════════════════════════════════════════════════ */

// Revoke qilinayotganda memoryCache'dan ham tozalash uchun
// "kechiktirilgan" bog'lanish — pastda memoryCache e'lon qilingandan
// keyin to'ldiriladi (bir fayl ichida bo'lgani uchun xavfsiz).
let _purgeFromMemoryCacheByValue = null;

// dec() darhol revoke qilmaydi — kichik kechikish (debounce) bilan.
// Sabab: HMR paytida komponent UNMOUNT + qayta MOUNT bo'ladi (bir xil
// blob URL bilan, chunki memoryCache hali o'zgarmagan). Agar dec()
// darhol revoke qilsa, unmount → revoke → remount → memoryCache hali
// "tirik" deb shu (endi O'LIK) blob URL'ni qaytarib beradi → brauzerda
// ERR_FILE_NOT_FOUND. Kechiktirish davomida (50ms) agar count yana
// > 0 ga ko'tarilsa (remount inc() chaqirsa) — pending revoke bekor
// qilinadi, hech narsa revoke bo'lmaydi.
const _pendingRevokes =
  typeof window !== 'undefined'
    ? (window.__assetPendingRevokes ??= new Map())   // url -> timeoutId
    : new Map();

const DEC_REVOKE_DELAY_MS = 50;

const blobRefs =
  typeof window !== 'undefined'
    ? (window.__assetBlobRefs ??= {
        _counts: new Map(),
        inc(url) {
          if (!url?.startsWith('blob:')) return;
          // Pending revoke bo'lsa — bekor qilamiz, bu URL yana ishlatilmoqda.
          if (_pendingRevokes.has(url)) {
            clearTimeout(_pendingRevokes.get(url));
            _pendingRevokes.delete(url);
          }
          this._counts.set(url, (this._counts.get(url) ?? 0) + 1);
        },
        dec(url) {
          if (!url?.startsWith('blob:')) return;
          const n = (this._counts.get(url) ?? 0) - 1;
          if (n <= 0) {
            this._counts.set(url, 0);
            // Darhol emas — debounce. Agar shu vaqt ichida inc()
            // chaqirilsa (HMR remount, yoki boshqa komponent), yuqoridagi
            // inc() ichidagi clearTimeout buni bekor qiladi.
            if (_pendingRevokes.has(url)) clearTimeout(_pendingRevokes.get(url));
            const timeoutId = setTimeout(() => {
              _pendingRevokes.delete(url);
              if ((this._counts.get(url) ?? 0) > 0) return; // qayta ishlatilgan
              this._counts.delete(url);
              try { URL.revokeObjectURL(url); } catch { /* silent */ }
              _purgeFromMemoryCacheByValue?.(url);
            }, DEC_REVOKE_DELAY_MS);
            _pendingRevokes.set(url, timeoutId);
          } else {
            this._counts.set(url, n);
          }
        },
        // LRU evict yoki clearCache dan chaqiriladi — bu yerda kechikish
        // SHART EMAS, chunki bu "cache'dan butunlay chiqarib tashlash"
        // qarori, HMR remount holati emas.
        tryRevoke(url) {
          if (!url?.startsWith('blob:')) return;
          const n = this._counts.get(url) ?? 0;
          if (n <= 0) {
            if (_pendingRevokes.has(url)) {
              clearTimeout(_pendingRevokes.get(url));
              _pendingRevokes.delete(url);
            }
            this._counts.delete(url);
            try { URL.revokeObjectURL(url); } catch { /* silent */ }
            _purgeFromMemoryCacheByValue?.(url);
          }
          // n > 0 — hali ishlatilmoqda, dec() o'zi hal qiladi
        },
      })
    : {
        inc() {}, dec() {}, tryRevoke() {},
      };

export { blobRefs };

/* ═══════════════════════════════════════════════════════════
 *  Tier 1: LRU In-memory cache (HMR-safe)
 *
 *  Map insertion-order iteratsiyasidan foydalanadi:
 *  - get() → entry "oxiriga" ko'chiriladi (eng yangi)
 *  - set() → limit oshsa birinchi (eng eski) chiqariladi
 *
 *  Evict da blobRefs.tryRevoke() chaqiriladi —
 *  agar hali DOM da bo'lsa revoke kechiktiriladi.
 * ═══════════════════════════════════════════════════════════ */

class LruCache {
  constructor(max) {
    this._max = max;
    this._map = new Map();
  }

  has(key) { return this._map.has(key); }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }

  set(key, val) {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._max) {
      const oldestKey = this._map.keys().next().value;
      const oldestVal = this._map.get(oldestKey);
      this._map.delete(oldestKey);
      // Reference counter orqali xavfsiz revoke
      blobRefs.tryRevoke(oldestVal);
    }
    this._map.set(key, val);
  }

  delete(key) {
    const val = this._map.get(key);
    this._map.delete(key);
    blobRefs.tryRevoke(val);
  }

  values() { return this._map.values(); }
  keys()   { return this._map.keys(); }
  get size() { return this._map.size; }

  clear() {
    for (const val of this._map.values()) blobRefs.tryRevoke(val);
    this._map.clear();
  }
}

/* HMR-safe singleton */
export const memoryCache =
  typeof window !== 'undefined'
    ? (window.__assetMemoryCache ??= new LruCache(LRU_MAX_ENTRIES))
    : new LruCache(LRU_MAX_ENTRIES);

// blobRefs.dec()/tryRevoke() revoke qilganda memoryCache'dagi mos
// kalit(lar)ni ham tozalashi uchun bog'lanish. `_purgeByValue` ataylab
// blobRefs.tryRevoke()ni QAYTA chaqirmaydigan ichki metod ishlatadi —
// aks holda dec() → purge → LruCache.delete() → tryRevoke() → purge
// kabi cheksiz aylanish yuzaga kelardi.
_purgeFromMemoryCacheByValue = (blobUrl) => {
  for (const [k, v] of memoryCache._map) {
    if (v === blobUrl) memoryCache._map.delete(k);
  }
};

/* ── Inflight dedup (HMR-safe) ──────────────────────────── */
const inflightImages =
  typeof window !== 'undefined'
    ? (window.__assetInflightImages ??= new Map())
    : new Map();

const inflightSvgs =
  typeof window !== 'undefined'
    ? (window.__assetInflightSvgs ??= new Map())
    : new Map();

/* ── helpers ─────────────────────────────────────────────── */

export function validateProtocol(url) {
  if (!url || typeof url !== 'string')
    return { valid: false, protocol: null, reason: "URL bo'sh yoki string emas" };
  if (/^data:/i.test(url)) return { valid: true, protocol: 'data:' };
  if (/^blob:/i.test(url)) return { valid: true, protocol: 'blob:' };
  try {
    const proto = new URL(url).protocol.toLowerCase();
    if (ALLOWED_PROTOCOLS.test(proto)) return { valid: true, protocol: proto };
    return { valid: false, protocol: proto, reason: `"${proto}" protokoli qo'llab-quvvatlanmaydi.` };
  } catch {
    return { valid: true, protocol: 'relative' };
  }
}

/**
 * caches.open() — singleton Promise (HMR-safe).
 */
let cacheStorePromise =
  typeof window !== 'undefined' ? window.__assetCacheStorePromise : null;

function openPersistentCache() {
  if (cacheStorePromise) return cacheStorePromise;
  cacheStorePromise = (async () => {
    try {
      if (typeof caches !== 'undefined') return await caches.open(CACHE_NAME);
    } catch (err) {
      console.warn('[Asset Cache] Cache API mavjud emas:', err);
    }
    return null;
  })();
  if (typeof window !== 'undefined') window.__assetCacheStorePromise = cacheStorePromise;
  return cacheStorePromise;
}

/* ═══════════════════════════════════════════════════════════
 *  Cache API TTL + Size limit tozalash (fon)
 * ═══════════════════════════════════════════════════════════ */

async function evictCacheStore(store) {
  if (!store) return;
  try {
    const keys = await store.keys();
    const now  = Date.now();
    let totalBytes = 0;

    const entries = await Promise.all(
      keys.map(async (req) => {
        const res = await store.match(req);
        if (!res) return null;
        const cachedAt = parseInt(res.headers.get('x-cached-at') || '0', 10);
        const size     = parseInt(res.headers.get('content-length') || '0', 10);
        return { req, cachedAt, size };
      })
    );

    const valid = entries.filter(Boolean).sort((a, b) => a.cachedAt - b.cachedAt);

    for (const entry of valid) {
      totalBytes += entry.size;
      const expired  = entry.cachedAt && (now - entry.cachedAt > CACHE_TTL_MS);
      const overSize = totalBytes > CACHE_MAX_BYTES;

      if (expired || overSize) {
        await store.delete(entry.req);
        const url = typeof entry.req === 'string' ? entry.req : entry.req.url;
        if (memoryCache.has(url)) memoryCache.delete(url);
        totalBytes -= entry.size;
      }
    }
  } catch { /* silent */ }
}

/**
 * Cache API ga yozishda x-cached-at timestamp qo'shamiz.
 */
async function putWithTimestamp(store, url, response) {
  if (!store) return;
  try {
    const blob    = await response.blob();
    const headers = new Headers(response.headers);
    headers.set('x-cached-at', String(Date.now()));
    const stamped = new Response(blob, {
      status: response.status, statusText: response.statusText, headers,
    });
    await store.put(url, stamped);
    evictCacheStore(store); // fonda, bloklamas
  } catch { /* silent */ }
}

/**
 * Blob → ObjectURL — LRU orqali, ref count oshirilmaydi bu yerda.
 * Ref count komponent tomonidan boshqariladi (blobRefs.inc/dec).
 */
function blobToObjectUrl(url, blob) {
  if (memoryCache.has(url)) return memoryCache.get(url);
  const objectUrl = URL.createObjectURL(blob);
  memoryCache.set(url, objectUrl);
  return objectUrl;
}

/* ── public API ──────────────────────────────────────────── */

export function resolveImage(url) {
  if (memoryCache.has(url)) return Promise.resolve(memoryCache.get(url));

  if (/^(data|blob):/i.test(url)) {
    memoryCache.set(url, url);
    return Promise.resolve(url);
  }

  if (inflightImages.has(url)) return inflightImages.get(url);

  const promise = (async () => {
    try {
      const store = await openPersistentCache();

      if (store) {
        const cached = await store.match(url);
        if (cached) {
          const cachedAt = parseInt(cached.headers.get('x-cached-at') || '0', 10);
          if (cachedAt && Date.now() - cachedAt > CACHE_TTL_MS) {
            await store.delete(url);
          } else {
            return blobToObjectUrl(url, await cached.blob());
          }
        }
      }

      const fetchOpts = /^https?:\/\//i.test(url) ? { mode: 'cors', cache: 'force-cache' } : { cache: 'force-cache' };
      const res = await fetch(url, fetchOpts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const forCache  = res.clone();
      const objectUrl = blobToObjectUrl(url, await res.blob());
      putWithTimestamp(store, url, forCache);
      return objectUrl;
    } catch (err) {
      console.error(`[Asset Cache] Rasmni yuklash xatosi (${url}):`, err);
      throw err;
    } finally {
      inflightImages.delete(url);
    }
  })();

  inflightImages.set(url, promise);
  return promise;
}

export function resolveSvgText(url) {
  const key = `svg:${url}`;
  if (memoryCache.has(key)) return Promise.resolve(memoryCache.get(key));
  if (inflightSvgs.has(url))  return inflightSvgs.get(url);

  const promise = (async () => {
    try {
      const store = await openPersistentCache();
      if (store) {
        const cached = await store.match(url);
        if (cached) {
          const cachedAt = parseInt(cached.headers.get('x-cached-at') || '0', 10);
          if (cachedAt && Date.now() - cachedAt > CACHE_TTL_MS) {
            await store.delete(url);
          } else {
            const text = sanitizeSvgText(await cached.text());
            if (text.trimStart().startsWith('<svg')) {
              memoryCache.set(key, text);
              return text;
            }
          }
        }
      }

      const res = await fetch(url, { mode: 'cors', cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const forCache = res.clone();
      const text     = sanitizeSvgText(await res.text());
      if (text.trimStart().startsWith('<svg')) {
        memoryCache.set(key, text);
        putWithTimestamp(store, url, forCache);
        return text;
      }

      memoryCache.set(key, null);
      return null;
    } catch (err) {
      console.error(`[Asset Cache] SVG yuklash xatosi (${url}):`, err);
      memoryCache.set(key, null);
      return null;
    } finally {
      inflightSvgs.delete(url);
    }
  })();

  inflightSvgs.set(url, promise);
  return promise;
}

export async function preCacheUrls(urls = []) {
  const store = await openPersistentCache();
  if (!store) return;
  await Promise.allSettled(
    urls
      .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
      .map(async (url) => {
        if (memoryCache.has(url)) return;
        const existing = await store.match(url);
        if (existing) return;
        try {
          const res = await fetch(url, { mode: 'cors', cache: 'force-cache' });
          if (res.ok) await putWithTimestamp(store, url, res);
        } catch { /* silent */ }
      }),
  );
}

export async function clearCache() {
  // Pending (debounce qilingan) revoke'larni ham bekor qilamiz —
  // aks holda clearCache() dan keyin eski timeout ishga tushib,
  // endi mavjud bo'lmagan holatga ta'sir qilishga urinishi mumkin.
  for (const timeoutId of _pendingRevokes.values()) clearTimeout(timeoutId);
  _pendingRevokes.clear();

  memoryCache.clear(); // LruCache.clear() tryRevoke ni o'zi chaqiradi
  cacheStorePromise = null;
  if (typeof window !== 'undefined') {
    delete window.__assetMemoryCache;
    delete window.__assetCacheStorePromise;
    delete window.__assetBlobRefs;
    delete window.__assetPendingRevokes;
  }
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
  } catch { /* silent */ }
}