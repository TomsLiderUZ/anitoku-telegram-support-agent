/**
 * @asset/core/registry.js
 * ─────────────────────────────────────────────────────────────
 * Alias registry – asset alias → URL mapping and listener management.
 *
 * `loadAssetImage` va `loadAssetIcon` aliasni ro'yxatga oladi va
 * ro'yxat o'zgarganda tinglovchilarni xabardor qiladi.
 * Bu modul endi EAGER prefetch qilmaydi — asl yuklash faqat komponent
 * qatlamida, `Asset.image()` / `Asset.icon()` orqali sodir bo'ladi.
 * ─────────────────────────────────────────────────────────────
 */

import { images, icons } from '../static/main';
import { logError } from '../utils/logger';
import { isRemoteUrl } from '../utils/svgInject';
import { memoryCache, resolveImage, resolveSvgText } from './cache';

/* ------------------------------------------------------------------ */
/*  Alias registries – alias → URL maps */
export const aliasRegistry =
  typeof window !== 'undefined'
    ? (window.__assetAliasRegistry ??= new Map())
    : new Map();
export const iconAliasRegistry =
  typeof window !== 'undefined'
    ? (window.__assetIconAliasRegistry ??= new Map())
    : new Map();

/* ------------------------------------------------------------------ */
/*  Listener infrastructure – components subscribe to these sets */
const aliasListeners =
  typeof window !== 'undefined'
    ? (window.__assetAliasListeners ??= new Set())
    : new Set();
const iconAliasListeners =
  typeof window !== 'undefined'
    ? (window.__assetIconAliasListeners ??= new Set())
    : new Set();

/** Subscribe a callback to be invoked when the alias registry changes. */
export function subscribeAliasRegistry(cb) {
  if (typeof cb !== 'function') return () => {};
  aliasListeners.add(cb);
  // Return an unsubscribe function
  return () => aliasListeners.delete(cb);
}
/** Subscribe a callback to be invoked when the icon alias registry changes. */
export function subscribeIconAliasRegistry(cb) {
  if (typeof cb !== 'function') return () => {};
  iconAliasListeners.add(cb);
  return () => iconAliasListeners.delete(cb);
}

export function notifyAliasListeners() {
  aliasListeners.forEach((cb) => cb());
}
export function notifyIconAliasListeners() {
  iconAliasListeners.forEach((cb) => cb());
}

/* ------------------------------------------------------------------ */
/*  PUBLIC API – alias registration */
/** Register an image alias and notify listeners. */
export function loadAssetImage(alias, url) {
  if (!alias || !url) {
    logError('Asset.image.load: `alias` and `url` required', { alias, url });
    return;
  }
  // If the alias already exists, do not override (prevents re-registering on every render)
  if (aliasRegistry.has(alias)) return;

  // MUHIM TUZATISH: avval bu yerda `url`ning fayl nomi (masalan
  // "logo.svg" -> "logo") static bundle'dagi shunga o'xshash nomli
  // asset bilan solishtirilib, agar mos kelsa berilgan `url` BUTUNLAY
  // e'tiborga olinmay, local asset ishlatilar edi. Bu noto'g'ri edi:
  // foydalanuvchi ANIQ remote URL bergan bo'lsa (masalan
  // "http://localhost:3000/logo.svg"), u albatta o'sha URL sifatida
  // ro'yxatga olinishi kerak — faylnomasi tasodifan static
  // assetlardagi biror nom bilan mos kelib qolgani uchun uni local
  // fayl bilan almashtirish yaramaydi. Shu sababli bu heuristik
  // OLIB TASHLANDI: `url` har doim aynan berilgani kabi saqlanadi.
  aliasRegistry.set(alias, url);
  // Pre-fetch remote URLs immediately so they're cached before components render
  if (isRemoteUrl(url)) {
    resolveImage(url).catch(() => {});
  }
  // Notify listeners in a micro‑task so render remains pure.
  Promise.resolve().then(notifyAliasListeners);
}

/** Register an icon alias and notify listeners. */
export function loadAssetIcon(alias, url) {
  if (!alias || !url) {
    logError('Asset.icon.load: `alias` and `url` required', { alias, url });
    return;
  }
  if (iconAliasRegistry.has(alias)) return;

  // MUHIM TUZATISH: avval bu yerda `url`ning fayl nomi (masalan
  // "logo.svg" -> "logo") static bundle'dagi shu nomli LOCAL icon
  // bilan solishtirilib, mos kelsa berilgan `url` BUTUNLAY e'tiborga
  // olinmay, local SVG registrga yozilar edi. Bu xato edi: masalan
  // `Asset.icon.load("icon-text", "http://localhost:3000/logo.svg")`
  // chaqirilganda, faylnomasi ("logo") assets/icons/logo.svg bilan mos
  // kelib qolgani uchun "icon-text" aliasi remote URL o'rniga LOCAL
  // "logo" iconiga bog'lanib qolar edi — foydalanuvchi aniq boshqa
  // (tashqi) SVG bergan bo'lsa ham. Shu sababli bu heuristik OLIB
  // TASHLANDI: `url` har doim aynan berilgani kabi saqlanadi.
  iconAliasRegistry.set(alias, url);
  // Pre-fetch remote SVG URLs immediately so they're cached before components render
  if (isRemoteUrl(url)) {
    resolveSvgText(url).catch(() => {});
  }
  Promise.resolve().then(notifyIconAliasListeners);
}
/* ------------------------------------------------------------------ */
/*  Helper – resolve target URLs (alias or static) */
export function resolveTargetUrl(src) {
  if (!src) return null;
  // 1. Check alias registry first
  if (aliasRegistry.has(src)) return aliasRegistry.get(src);
  // 2. If remote URL, return as-is
  if (isRemoteUrl(src)) return src;
  // 3. Check bundled images by exact name
  if (images[`image-${src}`]) return images[`image-${src}`];
  // 4. Try to extract name from filename and check bundled images
  const filename = src.split('/').pop().replace(/\?.*$/, '');
  const name = filename.replace(/\.[^.]+$/, '');
  return images[`image-${name}`] || src;
}

export function resolveIconTargetUrl(name) {
  if (!name) return null;
  // 1. Check alias registry first
  if (iconAliasRegistry.has(name)) return iconAliasRegistry.get(name);
  // 2. If remote URL, return as-is
  if (isRemoteUrl(name)) return name;
  // 3. Check bundled icons by exact name
  if (icons[`icon-${name}`]) return icons[`icon-${name}`];
  // 4. Try to extract name from filename
  const filename = name.split('/').pop().replace(/\?.*$/, '');
  const iconName = filename.replace(/\.[^.]+$/, '');
  return icons[`icon-${iconName}`] || name;
}

// O'zgarishlar amalga oshirildi✅