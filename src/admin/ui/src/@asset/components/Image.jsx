/**
 * @asset/components/Image.jsx
 * ─────────────────────────────────────────────────────────────
 * Performance siyosati (ikki turdagi asset, ikki xil strategiya):
 *
 * ── STATIC (local, webpack require.context orqali bundle qilingan,
 *    hash'langan fayl nomi — masalan og-image.cf3f68d...png) ──
 *   Bunday assetlar webpack tomonidan immutable deb belgilangan
 *   (hash content'ga bog'liq), brauzerning o'z HTTP disk-cache'i
 *   ularni allaqachon optimal boshqaradi (birinchi yuklashdan keyin
 *   304/"from disk cache", qo'shimcha network deyarli yo'q).
 *   SHUNING UCHUN: static asset uchun HECH QACHON qo'shimcha
 *   fetch()/blob keshlash qilinmaydi — faqat oddiy <img src> orqali
 *   ko'rsatiladi. Bitta asset — bitta network yozuv, har doim.
 *
 * ── REMOTE (https://... — tashqi server, API orqali keladigan) ──
 *   Bu yerda haqiqiy trafikni kamaytirish kerak: bitta URL uchun
 *   BUTUN SAYT bo'ylab faqat BITTA marta tarmoqqa so'rov ketishi
 *   kerak. Shuning uchun remote uchun original URL'ni <img src>
 *   qilib UMUMAN ko'rsatmaymiz — to'g'ridan-to'g'ri resolveImage()
 *   (fetch→blob, Cache API'ga yoziladi) orqali yuklaymiz va natijani
 *   memoryCache'da abadiy saqlaymiz.
 * ─────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef, memo } from 'react';
import { validateProtocol, resolveImage, memoryCache, blobRefs } from '../core/cache';
import { resolveTargetUrl, aliasRegistry, subscribeAliasRegistry } from '../core/registry';
import { logError } from '../utils/logger';
import { isRemoteUrl, AssetError } from '../utils/svgInject';

const AssetImage = memo(function AssetImage({ src: srcProp, name, alt = '', loading, ...rest }) {
  const src       = srcProp || name || null;
  const targetUrl = resolveTargetUrl(src);
  const remote    = isRemoteUrl(targetUrl);

  // `src` hali aliasRegistry'da bo'lmasligi mumkin (load() boshqa
  // komponentda — masalan Footer — render TARTIBI bo'yicha keyinroq
  // chaqirilgan bo'lishi mumkin). Registry to'lganda bu komponentni
  // majburiy qayta render qilamiz, shunda resolveTargetUrl yangi
  // (to'g'ri) qiymatni qaytaradi.
  const [, forceTick] = useState(0);
  useEffect(() => subscribeAliasRegistry(() => forceTick((v) => v + 1)), []);

  // GRACE PERIOD: agar `src` na alias registry'da, na local rasmlar
  // ro'yxatida topilmasa, `resolveTargetUrl` shunchaki `src`ning o'zini
  // qaytaradi (yaroqsiz qiymat) — bu HALI "umuman mavjud emas" degani
  // emas, Asset.image.load(src, url) ilovaning boshqa joyida (boshqa
  // komponentda, render TARTIBI bo'yicha istalgan joyda) hali ulgurmagan
  // bo'lishi mumkin.
  //
  // Asosiy mexanizm — `subscribeAliasRegistry` (yuqorida): load()
  // chaqirilgan zahoti komponent darhol qayta render bo'ladi, demak
  // ODATDA bu kutish bir nechta millisekund (load() chaqirilgan
  // paytdan bu komponent commit bo'lishigacha) ichida tugaydi.
  //
  // Lekin ba'zan (sekin tarmoq/CPU, ko'p sonli boshqa effektlar
  // navbatda turishi) bu signal kutilganidan kech kelishi mumkin.
  // Shu sababli qisqa (50ms) tezkor tekshiruv + uzunroq (500ms)
  // xavfsizlik vaqti — ikkisi ham mavjud: qisqasi tezkor holatlarda
  // foydalanuvchiga hech narsa bildirmaydi, uzunrog'i esa "haqiqatan
  // ham topilmadi" deb hisoblashdan oldin yetarlicha vaqt beradi.
  const unresolved = !!src && targetUrl === src && !aliasRegistry.has(src) && !isRemoteUrl(src);
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    if (!unresolved) { setGraceExpired(false); return; }
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      if (!cancelled) setGraceExpired(true);
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [unresolved, src]);

  // Sinxron boshlang'ich holat:
  //   1) memory cache'da blob bor — eng tez yo'l (ikkala tur uchun ham)
  //   2) `unresolved` (alias/local rasm hali topilmagan) — null,
  //      grace period va keyingi resolveTargetUrl natijasini kutamiz.
  //      MUHIM: bu holatda HECH QACHON `targetUrl`ning o'zini (ya'ni
  //      yaroqsiz `src` qiymatini) qaytarmaymiz — aks holda u
  //      to'g'ridan-to'g'ri <img src="..."> ga tushib, brauzer buni
  //      nisbiy URL deb hisoblab dev-serverga so'rov yuboradi (va
  //      SPA fallback orqali text/html qaytib keladi).
  //   3) REMOTE va hali keshlanmagan — null qaytaramiz, original URL
  //      umuman render qilinmaydi, resolveImage() natijasini kutamiz
  //   4) STATIC — original URL bilan darhol ko'rsatamiz, brauzer
  //      o'zi hal qiladi
  const [resolvedSrc, setResolvedSrc] = useState(() => {
    if (!targetUrl) return null;
    if (memoryCache.has(targetUrl)) return memoryCache.get(targetUrl);
    if (unresolved) return null;
    if (remote) return null;
    return targetUrl;
  });

  const [error, setError] = useState(null);
  const srcRef     = useRef(null);  // joriy src ni track qilish uchun
  const blobUrlRef = useRef(null);  // ref counting uchun

  // Komponent unmount yoki src o'zgarganda — eski blob URL ni
  // blobRefs.dec() orqali bo'shatamiz.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        blobRefs.dec(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!src || !targetUrl) {
      if (!src) {
        logError("Asset.Image: `src` prop bo'sh");
        setError('src prop berilmagan');
      }
      return;
    }

    // Hali grace period ichida (alias/local rasm topilmadi, lekin
    // boshqa joyda load() chaqirilishi mumkin) — kutamiz, xato yo'q,
    // resolvedSrc ham hali o'rnatilmaydi (yaroqsiz qiymat tarqalmasin).
    if (unresolved && !graceExpired) { setError(null); return; }

    // Grace period TUGAGAN, lekin hali ham `unresolved` — demak bu
    // nom HAQIQATAN aliasda ham, local rasmlar ro'yxatida ham yo'q.
    // `targetUrl` (yaroqsiz, src bilan bir xil) HECH QACHON <img src>
    // ga berilmaydi — buning o'rniga aniq xato ko'rsatamiz.
    if (unresolved && graceExpired) {
      logError(`Asset.Image: "${src}" na alias, na local rasmlar ro'yxatida topilmadi`);
      setError(`"${src}" topilmadi (Asset.image.load() chaqirilmaganmi?)`);
      setResolvedSrc(null);
      return;
    }

    srcRef.current = src;
    setError(null);

    // Memory cache'da allaqachon bor → darhol o'rnatamiz
    if (memoryCache.has(targetUrl)) {
      const cached = memoryCache.get(targetUrl);
      if (cached !== resolvedSrc) {
        if (blobUrlRef.current) blobRefs.dec(blobUrlRef.current);
        blobUrlRef.current = cached;
        blobRefs.inc(cached);
        setResolvedSrc(cached);
      }
      return;
    }

    // STATIC (local) asset: hech qanday qo'shimcha fetch/keshlash YO'Q.
    if (!remote) { setResolvedSrc(targetUrl); return; }

    // REMOTE asset: protocol tekshiruv, keyin fetch→blob→Cache API.
    const v = validateProtocol(targetUrl);
    if (!v.valid) {
      logError(`Asset.Image protokol xatosi: "${targetUrl}"`, v.reason);
      setError(v.reason);
      return;
    }

    resolveImage(targetUrl)
      .then((blobUrl) => {
        if (srcRef.current !== src) return; // src o'zgargan, eskisini o'rnatmaymiz
        if (blobUrlRef.current) blobRefs.dec(blobUrlRef.current);
        blobUrlRef.current = blobUrl;
        blobRefs.inc(blobUrl);
        setResolvedSrc(blobUrl);
      })
      .catch((err) => {
        logError(`Asset.Image kesh xatosi`, { src: targetUrl, err });
        if (srcRef.current === src) setResolvedSrc((prev) => prev ?? targetUrl);
      });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, targetUrl, unresolved, graceExpired]);

  // Hali grace period ichida bo'lsa — xato ko'rsatmaymiz, kutamiz.
  if (unresolved && !graceExpired) return null;

  if (error)        return <AssetError type="Rasm" name={src} detail={error} />;
  if (!resolvedSrc) return null;

  // MUHIM (YANGI): agar bu <img> flex konteyner ichida ishlatilsa
  // (masalan `.button { display:flex }` yoki responsive kartochka
  // layoutlari), default holatda flex-item `flex-shrink: 1` bo'ladi —
  // konteyner torayganda (mobil/responsive holatda) rasm CSS'da
  // berilgan width/height'dan siqilib, buzilib/kesilib ko'rinishi
  // mumkin edi (xuddi Icon komponentida kuzatilgan muammoning
  // xuddi shu turi). `flexShrink: 0` ni default qilib beramiz, lekin
  // agar chaqiruvchi `rest.style` orqali o'zi `flexShrink` bergan
  // bo'lsa — o'shani ustun qo'yamiz (merge qilinadi, majburlanmaydi).
  const { style: restStyle, ...restProps } = rest;

  return (
    <img
      src={resolvedSrc}
      alt={alt}
      loading={loading}
      decoding="sync"
      fetchPriority="high"
      style={{ flexShrink: 0, ...restStyle }}
      onError={(e) => {
        const msg = `<img> yuklanmadi: "${src}"`;
        logError(msg);
        setError(msg);
        e.currentTarget.onerror = null;
      }}
      {...restProps}
    />
  );
});

export default AssetImage; // O'zgarishlar amalga oshirildi✅