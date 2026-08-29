/**
 * @asset/index.js
 * ─────────────────────────────────────────────────────────────
 * Yagona public entry point. Tashqaridan faqat shu fayl import
 * qilinishi kerak — ichki papkalar (components/core/static/utils)
 * implementation detail hisoblanadi.
 * ─────────────────────────────────────────────────────────────
 */

import { Icon, AssetImage, getAssetImage, getAssetIcon } from './components';
import { preCacheUrls, clearCache } from './core/cache';
import { getLogHistory } from './utils/logger';

const Asset = {
  Icon,
  Img:      AssetImage,
  Image:    AssetImage,
  image:    getAssetImage,
  icon:     getAssetIcon,
  useImage: getAssetImage,
};

export default Asset;
export { preCacheUrls, clearCache, getLogHistory };