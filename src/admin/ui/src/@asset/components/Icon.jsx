/**
 * @asset/components/Icon.jsx
 * ─────────────────────────────────────────────────────────────
 * Lokal (assets/icons/*.svg) yoki Asset.icon.load() orqali
 * ro'yxatdan o'tgan remote SVG iconni inline render qiladi.
 * ─────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useId, memo } from 'react';
import { icons } from '../static/main';
import { validateProtocol, resolveSvgText } from '../core/cache';
import { iconAliasRegistry, subscribeIconAliasRegistry } from '../core/registry';
import { logError, logWarn } from '../utils/logger';
import { isSvgString, injectSvgProps, getCacheKey, ID_TOKEN, AssetError } from '../utils/svgInject';

/* HMR-safe modul-darajasi kesh */
const injectedSvgCache =
  typeof window !== 'undefined'
    ? (window.__assetInjectedSvgCache ??= new Map())
    : new Map();

/* ═══════════════════════════════════════════════════════════
 *  ICON COMPONENT
 * ═══════════════════════════════════════════════════════════ */

const Icon = memo(function Icon({
  name, className, style,
  width, height, color, fill, fontSize, border, stroke, objectFit,
  ...rest
}) {
  // Bu komponent render bo'lganda `name` hali iconAliasRegistry'da
  // yo'q bo'lishi mumkin (masalan, Asset.icon.load() shu komponentdan
  // KEYIN render bo'ladigan boshqa komponentda — masalan Footer, u
  // DOM daraxtida pastda joylashgan bo'lsa-da, render TARTIBI bo'yicha
  // istalgan joyda bo'lishi mumkin). Registry keyinroq to'lganda
  // komponentni majburiy qayta render qilamiz.
  const [, forceTick] = useState(0);
  useEffect(() => subscribeIconAliasRegistry(() => forceTick((v) => v + 1)), []);

  // MUHIM (qirqilish/clipping muammosi uchun): har bir <Icon> NUSXASI
  // uchun React'ning `useId()` orqali BARQAROR va NOYOB suffiks olamiz.
  // Bu suffiks orqali, quyida `finalSvg` DOM'ga joylanishidan oldin,
  // SVG ichidagi (namespaceSvgIds tomonidan tokenlangan) barcha id'lar
  // shu komponent nusxasiga xos noyob qiymatga almashtiriladi — shunda
  // bir xil icon (yoki bir xil auto-id'li turli iconlar) sahifada
  // bir necha marta ishlatilsa ham, ularning `id`/`clip-path`/`url(#..)`
  // havolalari HECH QACHON bir-biriga aralashib (kolliziya qilib)
  // ketmaydi. React ID'sidagi `:` belgisi CSS/URL kontekstida muammoli
  // bo'lishi mumkin bo'lgani uchun xavfsiz belgilarga tozalanadi.
  const rawInstanceId = useId();
  const instanceId = rawInstanceId.replace(/[^a-zA-Z0-9_-]/g, '');

  // Remote alias bo'lsa — iconAliasRegistry'dan URL olamiz
  const aliasUrl = name && iconAliasRegistry.has(name) ? iconAliasRegistry.get(name) : null;
  const key    = name?.startsWith('icon-') ? name : `icon-${name}`;
  const rawVal = aliasUrl || icons[key];

  // GRACE PERIOD: `rawVal` topilmasa, bu HALI "umuman mavjud emas"
  // degani emas — Asset.icon.load(name, url) ilovaning BOSHQA bir
  // joyida (masalan Footer komponentida, u Home'dan keyin render
  // bo'lsa ham) chaqirilgan bo'lishi mumkin va hali ulgurmagan bo'lishi
  // mumkin (mount → effectlar ishga tushishi → notify → bu komponent
  // qayta render bo'lishi — bir nechta tick talab qiladi).
  //
  // Shuning uchun: agar `rawVal` topilmasa, DARHOL xato ko'rsatmaymiz.
  // Bir nechta keyingi tick'larda (~grace period) kutamiz — agar shu
  // vaqt ichida registry to'lib, `rawVal` paydo bo'lsa, hech qanday
  // xato ko'rinmaydi. Faqat grace period tugagandan keyin ham hali
  // topilmasa — bu HAQIQATAN mavjud bo'lmagan nom, xato ko'rsatiladi.
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    if (rawVal) { setGraceExpired(false); return; }
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      if (!cancelled) setGraceExpired(true);
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [rawVal, name]);

  const finalFontSize = fontSize || style?.fontSize;
  const finalWidth    = width  || style?.width;
  const finalHeight   = height || style?.height || finalFontSize;
  const finalColor    = color  || fill;

  // MUHIM TUZATISH (qirqilish/clipping muammosi uchun):
  //
  // Avvalgi versiyada `finalHeight` berilmagan holatda `height`ni
  // umuman uzatmasdik (undefined qoldirilardi), fikr shu ediki —
  // SVG o'z viewBox proporsiyasiga mos avtomatik balandlikda
  // render bo'ladi. AMMO amalda bu muammoli edi: agar SVG shu
  // paytda `width:100%` ga ega, lekin HECH QANDAY height atributiga
  // ega bo'lmasa, brauzer balandlikni SVG'ning O'Z ICHKI ASPEKT
  // NISBATIGA qarab hisoblaydi — bu hisoblangan balandlik esa
  // ko'pincha wrapper <span>ga className orqali berilgan QATTIQ
  // (masalan `height:18px`) balandlik bilan BIR XIL BO'LMAYDI.
  // Natijada SVG span ichida "noto'g'ri" o'lchamda chiqib, uning
  // atrofidagi layout (border-radius, line-height, flex markazlash)
  // sabab qismi qirqilib/kesilib ko'ringandek tuyulardi — va bu
  // FAQAT ba'zi iconlarda (ularning viewBox nisbati mos kelmaganda)
  // sodir bo'lardi, boshqalarida tasodifan mos kelib qolib
  // ko'rinmasdi.
  //
  // Tuzatish: `finalHeight` berilmagan bo'lsa ham, endi SVG'ga
  // ANIQ `height: '100%'` beramiz (span'ning haqiqiy balandligiga
  // har doim mos keladi, `viewBox` proporsiyasiga bog'liq emas).
  // Proporsiya buzilib, ikonka cho'zilib qolmasligi uchun — agar
  // bu "avtomatik" holat bo'lsa (ya'ni foydalanuvchi na width, na
  // height bermagan) — `objectFit`ni ANIQ 'contain'ga (ya'ni
  // preserveAspectRatio="xMidYMid meet") majburlaymiz, shunda SVG
  // o'z nisbatini saqlab, box ICHIGA to'liq sig'adi — hech qachon
  // taftish (crop) yoki cho'zilish (stretch) bo'lmaydi.
  const isAutoFallback = finalWidth === undefined || finalHeight === undefined;
  const props = {
    width: finalWidth ?? '100%',
    height: finalHeight ?? '100%',
    color: finalColor,
    fontSize: finalFontSize, border, stroke,
    objectFit: objectFit || style?.objectFit || (isAutoFallback ? 'contain' : undefined),
  };

  // MUHIM: bu yerda ataylab useMemo ISHLATILMAYDI.
  //
  // Avvalgi versiyada useMemo + qo'lda yozilgan dependency array
  // ishlatilgan edi ([key, rawVal, width, height, color, ...]).
  // Muammo: har safar yangi prop qo'shilganda (masalan `fill`,
  // keyin `stroke`) shu propni deps ro'yxatiga QO'LDA qo'shish
  // kerak bo'lardi — unutilsa, shu prop o'zgarganda UI yangilanmay
  // qoladi (xuddi shu xato ikki marta takrorlandi: avval `fill`,
  // keyin `stroke` bilan).
  //
  // Yechim: `cacheKey` ALLAQACHON `props`ning HAMMA maydonini o'z
  // ichiga oladi (getCacheKey -> JSON.stringify(props)). Demak
  // cacheKey'ni har render HISOBLAB chiqarish — hech qanday deps
  // ro'yxati kerak emas, va HECH QANDAY prop/style/attribute
  // o'zgarishi e'tibordan chetda qolmaydi (hozirgisi ham, kelajakda
  // qo'shiladigani ham). Haqiqiy keshlash (performance) darajasi
  // pastdagi `injectedSvgCache` Map orqali ta'minlanadi: agar
  // cacheKey ilgari hisoblangan bo'lsa, injectSvgProps() qayta
  // ishlamaydi — faqat Map.get() qaytadi (juda tez, ~O(1)).
  const cacheKey = rawVal && isSvgString(rawVal) ? getCacheKey(key, props, rawVal) : null;
  let inlineSvg = null;
  if (cacheKey) {
    if (!injectedSvgCache.has(cacheKey))
      injectedSvgCache.set(cacheKey, injectSvgProps(rawVal, props));
    inlineSvg = injectedSvgCache.get(cacheKey);
  }

  const getInjected = (svgRaw) => {
    const ck = getCacheKey(key, props, svgRaw);
    if (!injectedSvgCache.has(ck))
      injectedSvgCache.set(ck, injectSvgProps(svgRaw, props));
    return injectedSvgCache.get(ck);
  };

  const [finalSvg, setFinalSvg] = useState(inlineSvg);
  const [error, setError] = useState(null);

  // inlineSvg (lokal/inline SVG holati) o'zgarganda state'ni sync qilamiz.
  useEffect(() => {
    if (inlineSvg !== null) setFinalSvg(inlineSvg);
  }, [inlineSvg]);

  // Remote (URL) SVG holati uchun ham xuddi shu prinsip: qo'lda
  // prop sanash o'rniga, `key + JSON.stringify(props)`dan tuzilgan
  // tekshiruv qatorini deps qilib qo'yamiz — har qanday prop/style
  // o'zgarishi (hozirgisi yoki keyin qo'shiladigani) avtomatik
  // ushlanadi, chunki bu qator props'ning HAMMA maydonini qamraydi.
  const propsSignature = `${key}|${JSON.stringify(props)}`;

  useEffect(() => {
    let cancelled = false;
    if (!rawVal) {
      // Grace period hali tugamagan bo'lsa — bu boshqa joyda
      // chaqirilgan Asset.icon.load() ni kutish bosqichi, xato emas.
      if (!graceExpired) { setError(null); return; }
      logError(`Icon topilmadi: "${name}" (kalit: ${key})`);
      setError(`"${name}" icon registrda mavjud emas`);
      return;
    }
    setError(null);
    if (isSvgString(rawVal)) return; // inlineSvg orqali yuqorida hal qilindi

    const urlCheck = validateProtocol(rawVal);
    if (!urlCheck.valid) { logError(`Icon URL xatosi: "${rawVal}"`, urlCheck.reason); setError(urlCheck.reason); return; }

    resolveSvgText(rawVal).then((svgRaw) => {
      if (cancelled) return;
      if (svgRaw) setFinalSvg(getInjected(svgRaw));
      else { logWarn(`Icon SVG yuklanmadi: "${rawVal}"`); setError("SVG yuklab bo'lmadi"); }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawVal, propsSignature, graceExpired]);

  // Hali grace period ichida va rawVal topilmagan bo'lsa — hech
  // narsa ko'rsatmaymiz (xato emas, oddiy "hali kutilmoqda" holati).
  // Bu HMR/race holatlarida foydalanuvchiga bir lahzalik xato
  // miltillashining oldini oladi.
  if (!rawVal && !graceExpired) return null;

  if (error)     return <AssetError type="Icon" name={name} detail={error} />;
  if (!rawVal)   return <AssetError type="Icon" name={name} detail="Registrda topilmadi" />;
  if (!finalSvg) return null;

  return (
    <span
      {...(className ? { className } : {})}
      style={{
        display: 'inline-flex',
        // MUHIM (YANGI): agar bu <span> flex konteyner ichida
        // ishlatilsa (masalan `.button { display:flex }`), default
        // holatda flex-item `flex-shrink: 1` bo'ladi — demak
        // konteyner torayganda (responsive/mobil holatda, yonidagi
        // matn joy talab qilganda) icon ham CSS'da berilgan
        // width/height'dan siqilib, buzilib/kesilib ko'rinishi
        // mumkin edi. `flexShrink: 0` bu siqilishning oldini oladi —
        // icon har doim o'ziga berilgan o'lchamda qoladi, siqiladigan
        // narsa matn yoki boshqa elementlar bo'ladi.
        flexShrink: 0,
        // Cross-axis (masalan vertikal, agar konteyner `flex-direction:
        // row` bo'lsa) markazga tekislanishi uchun — ba'zi konteynerlar
        // `align-items: stretch` (default) qo'yganda span balandligi
        // konteyner balandligiga cho'zilib, ichidagi SVG proporsiyasi
        // buzilishi mumkin edi.
        alignItems: 'center',
        justifyContent: 'center',
        // MUHIM: `finalWidth`/`finalHeight` aniq berilmagan bo'lsa,
        // bu yerga umuman width/height QO'YMAYMIZ. Avval bu yerda
        // har doim `?? 'fit-content'` fallback ishlatilgan edi —
        // bu inline style bo'lgani uchun tashqi className'dagi CSS
        // qoidasidan (masalan `.ilustration { width:100%; height:auto }`)
        // HAR DOIM ustun kelib, className'ni butunlay ishlamay
        // qoldirardi. Endi width/height faqat prop/style orqali
        // ANIQ berilgan bo'lsagina inline qo'yiladi — aks holda
        // o'lchamni to'liq className CSS'i belgilaydi.
        ...(finalWidth !== undefined ? { width: finalWidth } : {}),
        ...(finalHeight !== undefined ? { height: finalHeight } : {}),
        ...style,
      }}
      data-icon={key}
      dangerouslySetInnerHTML={{
        __html: finalSvg.includes(ID_TOKEN)
          ? finalSvg.split(ID_TOKEN).join(instanceId)
          : finalSvg,
      }}
      {...rest}
    />
  );
});

export default Icon;