/**
 * @asset/utils/svgInject.js
 * ─────────────────────────────────────────────────────────────
 * SVG matnini props asosida o'zgartirish (rang, o'lcham, stroke,
 * objectFit) va xatolik holatida ko'rsatiladigan placeholder
 * komponent. React'ga bog'liq emas (faqat AssetError JSX
 * qaytaradi) — shu sababli `utils/` qatlamda turadi.
 * ─────────────────────────────────────────────────────────────
 */

/* ═══════════════════════════════════════════════════════════
 *  SHARED HELPERS
 * ═══════════════════════════════════════════════════════════ */

// MUHIM TUZATISH: avval bu yerda faqat `v.trimStart().startsWith('<svg')`
// tekshirilar edi. Lekin ko'plab real SVG fayllar (masalan dizayn
// dasturlaridan eksport qilingan yoki boshqa manbadan olingan
// assets/icons/*.svg) boshida XML deklaratsiyasi
// (`<?xml version="1.0" ...?>`), komment (`<!-- ... -->`) yoki
// DOCTYPE bo'ladi — bunday holda matn "<svg" bilan emas, "<?xml"
// yoki "<!--" bilan boshlanadi va eski tekshiruv `false` qaytarardi.
//
// Natija (bug): kod bu qiymatni "SVG matni EMAS, balki URL" deb
// noto'g'ri xulosa qilib, XOM SVG MATNINI to'g'ridan-to'g'ri
// <img src=...> ga berardi (blob URL yaratmasdan). Brauzer bu uzun
// matnni nisbiy yo'l deb hisoblab, joriy origin (masalan
// "http://localhost:3000/") bilan qo'shib, URL-encode qilingan
// holda so'rov yuborishga urinardi — aynan shu xato kuzatilgan edi.
//
// Tuzatish: prolog/komment/DOCTYPE qismlarini olib tashlab, undan
// KEYIN "<svg" bilan boshlanishini tekshiramiz — shu orqali bunday
// fayllar ham to'g'ri "SVG matni" deb aniqlanadi va blob URL orqali
// (yoki inline injectSvgProps orqali) to'g'ri ishlanadi.
export const isSvgString = (v) => {
  if (typeof v !== 'string') return false;
  const stripped = v
    .trimStart()
    .replace(/^<\?xml[^>]*\?>/i, '')
    .replace(/^(\s*<!--[\s\S]*?-->\s*)*/g, '')
    .replace(/^<!DOCTYPE[^>]*>/i, '')
    .replace(/^(\s*<!--[\s\S]*?-->\s*)*/g, '')
    .trimStart();
  return stripped.startsWith('<svg');
};
export const isRemoteUrl = (v) => typeof v === 'string' && /^(https?|data|blob):/i.test(v);

/* ═══════════════════════════════════════════════════════════
 *  ID NAMESPACING (DOM-wide id collision fix)
 * ═══════════════════════════════════════════════════════════
 * MUHIM (qirqilish/clipping muammosining haqiqiy sababi):
 *
 * Ko'p SVG eksport vositalari (Figma va h.k.) har bir iconga
 * `<clipPath id="clip0_86_3">`, `<linearGradient id="paint0_...">`
 * kabi AVTOMATIK, ko'pincha BIR XIL nomlangan id'lar beradi —
 * chunki har bir fayl mustaqil holda, xuddi shu counter'dan
 * boshlab eksport qilingan.
 *
 * `Icon.jsx` bu SVG matnini `dangerouslySetInnerHTML` orqali
 * TO'G'RIDAN-TO'G'RI sahifa DOM'iga (blob/alohida hujjat emas)
 * joylaydi. HTML/SVG qoidasiga ko'ra bitta `id` BUTUN HUJJAT
 * bo'ylab NOYOB bo'lishi shart. Agar sahifada shu nomdagi id
 * ikkinchi marta uchrasa (masalan xuddi shu icon ikki joyda
 * ishlatilsa, yoki ikki xil icon tasodifan bir xil auto-id
 * bilan eksport qilingan bo'lsa), brauzer `url(#clip0_86_3)`
 * havolasini sahifadagi BIRINCHI topilgan elementga bog'laydi —
 * bu boshqa iconning butunlay boshqa o'lcham/shakldagi
 * clipPath'i bo'lishi mumkin. Natija: ikonka NOTO'G'RI (ba'zan
 * qirqilgan, ba'zan normal) ko'rinadi — aynan sahifada qaysi
 * ikonlar birga renderlanishiga bog'liq holda "ba'zida bo'ladi,
 * ba'zida yo'q" xatti-harakati.
 *
 * Yechim: har bir SVG ichidagi barcha `id="..."` larni va ularga
 * bo'lgan HAMMA havolalarni (`url(#...)`, `href="#..."`,
 * `xlink:href="#..."`) bitta umumiy TOKEN bilan belgilab qo'yamiz
 * (masalan `id="clip0_86_3__ID__"`). Bu qadam CONTENT asosida
 * keshlanadi (bir marta hisoblanadi). Keyin har bir komponent
 * NUSXASI DOM'ga joylanish oldidan `__ID__` tokenini React'ning
 * `useId()` orqali olingan HAQIQIY NOYOB qiymat bilan almashtiradi
 * (arzon, oddiy string almashtirish) — shunda bir xil kontent
 * bir nechta joyda ishlatilsa ham, har birining id'lari sahifada
 * mutlaqo mustaqil bo'ladi.
 */
export const ID_TOKEN = '__ID__';

export function namespaceSvgIds(svgString, token = ID_TOKEN) {
  if (typeof svgString !== 'string' || !svgString.includes('id=')) return svgString;

  const idRegex = /\bid="([^"]+)"/g;
  const ids = new Set();
  let match;
  while ((match = idRegex.exec(svgString))) ids.add(match[1]);
  if (ids.size === 0) return svgString;

  let result = svgString;
  ids.forEach((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Definition: id="foo" -> id="foo__ID__"
    result = result.replace(new RegExp(`\\bid="${escaped}"`, 'g'), `id="${id}${token}"`);
    // CSS/attr references: url(#foo), url('#foo'), url("#foo")
    result = result.replace(
      new RegExp(`url\\((['"]?)#${escaped}\\1\\)`, 'g'),
      `url($1#${id}${token}$1)`
    );
    // href="#foo" and xlink:href="#foo"
    result = result.replace(
      new RegExp(`((?:xlink:)?href="#)${escaped}(")`, 'g'),
      `$1${id}${token}$2`
    );
  });
  return result;
}

/* ── SVG prop injection ──────────────────────────────────── */

let uidCounter = 0;

export function injectSvgProps(svgRaw, options = {}) {
  let svg = String(svgRaw).trim();
  let { width, height, color, fill, fontSize, border, stroke, objectFit, ...inlineStyles } = options;

  if (fontSize) height = height || fontSize;
  if (fill) color = color || fill;

  let strokeConfig = stroke || border;
  let strokeW = null, strokeC = null;
  if (strokeConfig) {
    if (typeof strokeConfig === 'string') {
      const parts = strokeConfig.trim().split(/\s+/);
      if (parts.length === 1) { strokeC = parts[0]; strokeW = '1px'; }
      else {
        strokeW = parts[0];
        if (!isNaN(strokeW)) strokeW += 'px';
        strokeC = parts[parts.length - 1];
      }
    } else if (typeof strokeConfig === 'object') {
      strokeW = (strokeConfig.width || 1) + 'px';
      strokeC = strokeConfig.color || 'currentColor';
    }
  }

  if (color) {
    svg = svg.replace(/\sfill="(?!none)[^"]*"/ig, ` fill="${color}"`);
    if (!strokeConfig) svg = svg.replace(/\sstroke="(?!none)[^"]*"/ig, ` stroke="${color}"`);
  }
  if (strokeConfig) {
    svg = svg.replace(/\sstroke-width="[^"]*"/ig, '');
    svg = svg.replace(/\sstroke="[^"]*"/ig, '');
  }

  const styleString = Object.entries(inlineStyles)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}:${v}`)
    .join(';');

  const svgUid = strokeConfig ? `svg-s-${++uidCounter}` : '';

  // Border/stroke ICHKARIGA o'ssin (tashqariga emas) uchun ishlatiladigan
  // usul: SVG stroke odatda path CHETIGA "markazlashgan" holda chiziladi —
  // chiziq qalinligining yarmi ichkariga, yarmi tashqariga chiqadi.
  //
  // (Eslatma: avvalgi versiyada bu muammo viewBox'ni sun'iy kengaytirish
  // orqali "hal qilingan" edi — lekin bu usul kichik/murakkab iconlarda
  // (masalan ko'p pathli logotip harflarida) proporsiyani buzib, iconni
  // singan/qirqilgan ko'rinishga olib keldi. Shu sababli bu yondashuv
  // butunlay OLIB TASHLANDI.)
  //
  // Hozirgi (xavfsiz) usul — "self-clip" texnikasi:
  //   1) Har bir chizilayotgan shakl (path/circle/rect/...) uchun
  //      stroke-width IKKI BARAVAR qilib beriladi (masalan 2px so'ralsa — 4px).
  //   2) Shu shaklning O'ZI clip-path sifatida ishlatiladi (o'sha shaklning
  //      nusxasi <use> orqali <clipPath> ichiga joylanadi).
  //   3) Natijada — 2 baravar qalin stroke'ning TASHQARIGA chiqqan yarmi
  //      clip orqali "kesib tashlanadi", faqat ICHKARIGA o'sgan yarmi
  //      (ya'ni so'ralgan asl qalinlik) ko'rinib qoladi.
  //   4) `vector-effect: non-scaling-stroke` — stroke qalinligi viewBox
  //      masshtabidan mustaqil, doim ANIQ piksel qiymatida chiziladi.
  //
  // Bu usul viewBox, koordinatalar yoki iconning o'z geometriyasiga
  // HECH QANDAY tegmaydi — shu sababli hech qanday singan/buzilgan
  // ko'rinishga olib kelmaydi, icon o'lchamidan qat'i nazar ishlaydi.
  if (strokeConfig && svgUid) {
    let clipDefs = '';
    let elIdx = 0;
    svg = svg.replace(
      /<(path|circle|rect|ellipse|polygon|polyline|line)((?:\s+[^<>]*?)?)\/>/gi,
      (fullMatch, tag, attrs) => {
        elIdx += 1;
        let elId = attrs.match(/\sid="([^"]+)"/i)?.[1];
        let a = attrs;
        if (!elId) {
          elId = `${svgUid}-el-${elIdx}`;
          a = a + ` id="${elId}"`;
        }
        const clipId = `${svgUid}-clip-${elIdx}`;
        clipDefs += `<clipPath id="${clipId}"><use href="#${elId}"/></clipPath>`;
        a = a + ` clip-path="url(#${clipId})"`;
        return `<${tag}${a}/>`;
      }
    );

    if (clipDefs) {
      if (/<defs[^>]*>/i.test(svg)) {
        svg = svg.replace(/<defs([^>]*)>/i, (m) => `${m}${clipDefs}`);
      } else {
        svg = svg.replace(/(<svg[^>]*>)/i, (m) => `${m}<defs>${clipDefs}</defs>`);
      }
    }
  }

  const doubledStrokeW = strokeConfig ? `${(parseFloat(strokeW) || 0) * 2}px` : null;

  svg = svg.replace(/<svg([^>]*)>/i, (_, attrs) => {
    let a = attrs;
    const origW = a.match(/\bwidth="([^"]+)"/i)?.[1] ?? null;
    const origH = a.match(/\bheight="([^"]+)"/i)?.[1] ?? null;
    const vbMatch = a.match(/\bviewBox="([^"]+)"/i);

    a = a.replace(/\s?\bwidth="[^"]*"/gi, '').replace(/\s?\bheight="[^"]*"/gi, '');

    if (!vbMatch && origW && origH && !origW.includes('%') && !origH.includes('%')) {
      const wNum = parseFloat(origW), hNum = parseFloat(origH);
      if (!isNaN(wNum) && !isNaN(hNum)) a += ` viewBox="0 0 ${wNum} ${hNum}"`;
    }

    if (width !== undefined)   a += ` width="${width}"`;
    else if (origW && !height) a += ` width="${origW}"`;
    if (height !== undefined)  a += ` height="${height}"`;
    else if (origH && !width)  a += ` height="${origH}"`;

    if (styleString) {
      a = a.match(/\bstyle="/i)
        ? a.replace(/\bstyle="/i, `style="${styleString};`)
        : a + ` style="${styleString}"`;
    }

    a = a.replace(/\bpreserveAspectRatio="[^"]*"/gi, '');
    if (width !== undefined && height !== undefined && !objectFit) objectFit = 'fill';
    a += objectFit === 'fill'   ? ` preserveAspectRatio="none"`
       : objectFit === 'cover'  ? ` preserveAspectRatio="xMidYMid slice"`
       :                          ` preserveAspectRatio="xMidYMid meet"`;

    if (svgUid) {
      a = a.match(/\bclass="/i)
        ? a.replace(/\bclass="/i, `class="${svgUid} `)
        : a + ` class="${svgUid}"`;
    }
    return `<svg${a}>`;
  });

  if (strokeConfig && svgUid) {
    svg = svg.replace(
      '</svg>',
      `<style>.${svgUid} path,.${svgUid} circle,.${svgUid} rect,.${svgUid} ellipse,.${svgUid} polygon,.${svgUid} polyline,.${svgUid} line{stroke:${strokeC} !important;stroke-width:${doubledStrokeW} !important;vector-effect:non-scaling-stroke;}</style></svg>`
    );
  }

  // MUHIM: barcha id'larni (ushbu SVG'ning o'z ORIGINAL id'lari,
  // masalan Figma eksportidagi `clip0_86_3`, HAMDA yuqorida biz
  // o'zimiz qo'shgan self-clip id'lari) DOM-xavfsiz token bilan
  // belgilaymiz. Haqiqiy noyob qiymat bilan almashtirish har bir
  // komponent NUSXASIDA (Icon.jsx) alohida amalga oshiriladi.
  svg = namespaceSvgIds(svg);

  return svg;
}

export function getCacheKey(key, props, rawVal) {
  // `rawVal` (SVG matnining o'zi) kalitga ATAYLAB qo'shiladi.
  // Sabab: HMR yoki Asset.icon.load() bilan bir xil `key`/`props`
  // ostida SVG MATNI o'zgarishi mumkin (masalan, fayl tahrirlandi,
  // yoki remote URL ortidagi server javobi yangilandi). Agar kalit
  // faqat `key+props`dan tuzilsa, eski (stale) inject qilingan
  // natija abadiy qaytarilib qoladi, chunki Map kaliti bir xil
  // bo'lib qolaveradi. Shuning uchun rawVal contentga bog'liq
  // qisqa hash qo'shamiz.
  let hash = 0;
  const s = rawVal || '';
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return `${key}|${JSON.stringify(props)}|${hash}`;
}

/* ── Error placeholder ───────────────────────────────────── */

export function AssetError({ type, name, detail }) {
  return (
    <span
      className="asset-error"
      role="alert"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        padding: '4px 8px', borderRadius: '4px',
        background: 'var(--color-danger-soft, #ef44441a)',
        border: '1px solid var(--color-danger, #ef4444)',
        color: 'var(--color-danger-text, #b91c1c)',
        fontSize: '12px', fontFamily: 'monospace', lineHeight: 1.4,
      }}
      title={detail || undefined}
    >
      ⚠ {type}: <strong>{name || "(noma'lum)"}</strong>
      {detail && <span style={{ opacity: 0.7 }}> — {detail}</span>}
    </span>
  );
}