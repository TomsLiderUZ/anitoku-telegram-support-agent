/**
 * @asset/static/main.js
 * ─────────────────────────────────────────────────────────────
 * Webpack require.context orqali statik icon/image bundle.
 * Faqat build-time qoidalarga bo'ysunadi — qolgan modullardan
 * mustaqil, shuning uchun alohida `static/` qatlamda turadi.
 * ─────────────────────────────────────────────────────────────
 */

// raw-loader orqali SVG lar string sifatida keladi (craco.config.js kerak)
const iconCtx = require.context('../../assets/icons', false, /\.svg$/);

export const icons = {};
iconCtx.keys().forEach((path) => {
  const name = path.replace('./', '').replace('.svg', '');
  const mod = iconCtx(path);
  // raw-loader → string, file-loader → { default: url }
  const value = typeof mod === 'string' ? mod : (mod.default ?? mod);
  icons[`icon-${name}`] = value;
});

const imageCtx = require.context('../../assets/images', false, /\.(png|jpe?g|gif|webp|svg)$/);

export const images = {};
imageCtx.keys().forEach((path) => {
  const filename = path.replace('./', '');
  const name = filename.replace(/\.[^.]+$/, '');
  const mod = imageCtx(path);
  images[`image-${name}`] = mod.default ?? mod;
});

const assets = { icons, images };
export default assets;