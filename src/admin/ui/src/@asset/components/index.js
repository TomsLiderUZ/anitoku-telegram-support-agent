/**
 * @asset/components/index.js
 * ─────────────────────────────────────────────────────────────
 * `Icon` va `AssetImage` komponentlarini birlashtiradi, hamda
 * `Asset.image()` / `Asset.icon()` — render funksiyasi ICHIDA
 * chaqiriladigan, ICHKARIDA REACT HOOK ishlatadigan funksiyalarni
 * taqdim etadi. Hook ishlatgani uchun bu mantiq `core/`da emas,
 * aynan shu komponent qatlamida turishi kerak.
 * ─────────────────────────────────────────────────────────────
 */

import { useState, useEffect } from 'react';
import { icons } from '../static/main';
import { resolveImage, resolveSvgText, memoryCache } from '../core/cache';
import { aliasRegistry, resolveTargetUrl, loadAssetImage, iconAliasRegistry, loadAssetIcon, subscribeAliasRegistry, subscribeIconAliasRegistry } from '../core/registry';
import { isSvgString, isRemoteUrl, injectSvgProps } from '../utils/svgInject';
import Icon from './Icon';
import AssetImage from './Image';

/* HMR-safe modul-darajasi keshlar (lokal icon uri keshlari) */
const localIconCache =
  typeof window !== 'undefined'
    ? (window.__assetLocalIconCache ??= new Map())
    : new Map();

const localIconStyleCache =
  typeof window !== 'undefined'
    ? (window.__assetLocalIconStyleCache ??= new Map())
    : new Map();

// Canonical blob URL cache per raw SVG content — reuse single blob URL
// for identical SVG text so multiple consumers hit the same resource.
const rawSvgBlobCache =
  typeof window !== 'undefined'
    ? (window.__assetRawSvgBlobCache ??= new Map())
    : new Map();

// Per-style variant cache: stores blob URLs for injected/styled SVG text
const rawSvgVariantCache =
  typeof window !== 'undefined'
    ? (window.__assetRawSvgVariantCache ??= new Map())
    : new Map();

// Generate a single canonical empty SVG blob URL to avoid producing
// `data:image/svg+xml` entries in network/devtools. Created once
// at module load and reused across the app.
let EMPTY_IMAGE = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxJyBoZWlnaHQ9JzEnLz4=';
if (typeof window !== 'undefined') {
  try {
    const emptySvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
    const blob = new Blob([emptySvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    EMPTY_IMAGE = url;
    // Keep a reference so HMR doesn't gc the blob URL prematurely
    if (typeof window !== 'undefined') window.__assetEmptySvgBlobUrl = url;
  } catch (_) { /* fallback to data URI above */ }
}

/* ═══════════════════════════════════════════════════════════
 *  Asset.image(src)
 * ═══════════════════════════════════════════════════════════ */

function useResolvedAssetSrc(targetUrl) {
  const [resolved, setResolved] = useState(() => {
    if (!targetUrl) return EMPTY_IMAGE;
    if (memoryCache.has(targetUrl)) return memoryCache.get(targetUrl);
    return EMPTY_IMAGE;
  });

  useEffect(() => {
    if (!targetUrl) { setResolved(EMPTY_IMAGE); return; }
    if (memoryCache.has(targetUrl)) { setResolved(memoryCache.get(targetUrl)); return; }
    if (!isRemoteUrl(targetUrl)) { setResolved(targetUrl); return; }
    let cancelled = false;
    resolveImage(targetUrl)
      .then((blobUrl) => { if (!cancelled) setResolved(blobUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [targetUrl]);

  return resolved;
}

function useAliasRegistryVersion() {
  const [, forceTick] = useState(0);
  useEffect(() => subscribeAliasRegistry(() => forceTick((v) => v + 1)), []);
}

function useIconAliasRegistryVersion() {
  const [, forceTick] = useState(0);
  useEffect(() => subscribeIconAliasRegistry(() => forceTick((v) => v + 1)), []);
}

function getAssetImage(src) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useAliasRegistryVersion();

  const isAlias = !!src && aliasRegistry.has(src);
  const targetUrl = src ? resolveTargetUrl(src) : null;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const resolvedFromHook = useResolvedAssetSrc(isAlias ? targetUrl : null);

  if (isAlias) return resolvedFromHook;

  if (!src) return EMPTY_IMAGE;
  if (!targetUrl) return EMPTY_IMAGE;

  const unresolved = targetUrl === src && !isRemoteUrl(src);
  if (unresolved) return EMPTY_IMAGE;

  if (memoryCache.has(targetUrl)) return memoryCache.get(targetUrl);

  return targetUrl;
}

getAssetImage.load = loadAssetImage;

/* ═══════════════════════════════════════════════════════════
 *  Asset.icon(name)
 * ═══════════════════════════════════════════════════════════ */

class SvgDataUri extends String {
  constructor(src, rawSvg, cacheKey) {
    super(src);
    this.rawSvg    = rawSvg;
    this._cacheKey = cacheKey || null;
  }

  style(props = {}) {
    if (!this.rawSvg) return this;
    const styleKey = `${this._cacheKey}|${JSON.stringify(props)}`;
    if (localIconStyleCache.has(styleKey)) return localIconStyleCache.get(styleKey);

    const styledSvg = injectSvgProps(this.rawSvg, props);

    let url = rawSvgVariantCache.get(styleKey);
    if (!url) {
      const blob = new Blob([styledSvg], { type: 'image/svg+xml;charset=utf-8' });
      url = URL.createObjectURL(blob);
      rawSvgVariantCache.set(styleKey, url);
    }

    const uri = new SvgDataUri(url, styledSvg, styleKey);
    localIconStyleCache.set(styleKey, uri);
    return uri;
  }
}

function getLocalIcon(name) {
  if (!name) return new SvgDataUri(EMPTY_IMAGE, null);

  const key = name.startsWith('icon-') ? name : `icon-${name}`;
  const rawSvg = icons[key];

  const cached = localIconCache.get(key);
  if (cached && cached.rawSvg === (rawSvg ?? null)) return cached;

  if (!rawSvg) {
    const empty = new SvgDataUri(EMPTY_IMAGE, null, key);
    localIconCache.set(key, empty);
    return empty;
  }
  if (!isSvgString(rawSvg)) {
    const uri = new SvgDataUri(rawSvg, null, key);
    localIconCache.set(key, uri);
    return uri;
  }

  let url = rawSvgBlobCache.get(rawSvg);
  if (!url) {
    const blob = new Blob([rawSvg], { type: 'image/svg+xml;charset=utf-8' });
    url = URL.createObjectURL(blob);
    rawSvgBlobCache.set(rawSvg, url);
  }
  const uri = new SvgDataUri(url, rawSvg, key);
  localIconCache.set(key, uri);
  return uri;
}

/* ── Remote icon (alias) uchun hook ─────────────────────── */
function useResolvedIconSvg(targetUrl, props) {
  const [resolved, setResolved] = useState(() => {
    if (!targetUrl) return null;
    const key = `svg:${targetUrl}`;
    const cached = memoryCache.get(key);
    if (cached && isSvgString(cached)) return injectSvgProps(cached, props);
    return null;
  });

  useEffect(() => {
    if (!targetUrl) { setResolved(null); return; }
    const key = `svg:${targetUrl}`;
    const cached = memoryCache.get(key);
    if (cached && isSvgString(cached)) {
      setResolved(injectSvgProps(cached, props));
      return;
    }
    let cancelled = false;
    resolveSvgText(targetUrl).then((svgRaw) => {
      if (cancelled || !svgRaw) return;
      setResolved(injectSvgProps(svgRaw, props));
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUrl, JSON.stringify(props)]);

  return resolved;
}

function getAssetIcon(name) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useIconAliasRegistryVersion();

  // MUHIM TUZATISH: avval bu yerda `resolveIconTargetUrl(name)`
  // ishlatilib, uning natijasi `!!targetUrl` orqali "bu alias/remote"
  // deb xulosa qilinar edi. Lekin `resolveIconTargetUrl` LOCAL iconlar
  // uchun ham har doim biror qiymat qaytaradi (masalan
  // `icons["icon-logo"]` — ya'ni xom SVG matnining O'ZI, chunki
  // funksiya oxirida `|| name` fallback bor). Demak `targetUrl`
  // DEYARLI HAR DOIM "truthy" bo'lib, `isAlias` doim `true` chiqar
  // edi — hatto local iconlar ("logo" kabi) uchun ham.
  //
  // Natijada kod local iconning XOM SVG MATNINI "remote URL" deb
  // hisoblab, uni `useResolvedIconSvg` orqali FETCH qilishga urinar
  // edi. Brauzer bu uzun SVG matnini nisbiy manzil deb talqin qilib,
  // joriy origin bilan qo'shib (masalan
  // "http://localhost:3000/<svg ...>") so'rov yuborardi.
  //
  // Tuzatish: "alias" holatini FAQAT `iconAliasRegistry`da nom
  // ro'yxatdan o'tgan bo'lsa deb aniqlaymiz (xuddi Icon.jsx
  // komponenti qilgani kabi), va uning qiymati chinakam REMOTE URL
  // bo'lsagina fetch qilinadi. Aks holda (alias qiymati local SVG
  // matni bo'lib chiqsa yoki alias umuman yo'q bo'lsa) — local
  // iconga tushiladi.
  const aliasVal = name && iconAliasRegistry.has(name) ? iconAliasRegistry.get(name) : null;
  const isRemoteAlias = !!aliasVal && isRemoteUrl(aliasVal);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const resolvedSvg = useResolvedIconSvg(isRemoteAlias ? aliasVal : null, {});

  if (isRemoteAlias) {
    if (resolvedSvg) {
      let url = rawSvgBlobCache.get(resolvedSvg);
      if (!url) {
        const blob = new Blob([resolvedSvg], { type: 'image/svg+xml;charset=utf-8' });
        url = URL.createObjectURL(blob);
        rawSvgBlobCache.set(resolvedSvg, url);
      }
      return new SvgDataUri(url, resolvedSvg, `icon-alias:${name}`);
    }
    return new SvgDataUri(EMPTY_IMAGE, null, `icon-alias:${name}`);
  }

  // Kamdan-kam holat: alias mavjud, lekin uning qiymati remote URL
  // emas, balki (masalan) allaqachon xom SVG matni. Bunday holatda
  // ham uni to'g'ridan-to'g'ri "URL" sifatida ishlatmaymiz — blob
  // orqali inline SVG sifatida ko'rsatamiz.
  if (aliasVal && isSvgString(aliasVal)) {
    let url = rawSvgBlobCache.get(aliasVal);
    if (!url) {
      const blob = new Blob([aliasVal], { type: 'image/svg+xml;charset=utf-8' });
      url = URL.createObjectURL(blob);
      rawSvgBlobCache.set(aliasVal, url);
    }
    return new SvgDataUri(url, aliasVal, `icon-alias:${name}`);
  }

  return getLocalIcon(name);
}

getAssetIcon.load = loadAssetIcon;

export { Icon, AssetImage, getAssetImage, getAssetIcon }; // O'zgarishlar amalga oshirildi✅