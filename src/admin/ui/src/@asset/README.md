# @asset — React Asset Manager

Lokal va remote (tashqi URL) rasm/ikonkalarni yagona API orqali yuklash, keshlash va render qilish uchun kichik kutubxona. Webpack `require.context` orqali bundle qilingan statik fayllarni ham, runtime'da `Asset.image.load()` / `Asset.icon.load()` orqali ro'yxatdan o'tkazilgan tashqi URL'larni ham bir xil komponent va funksiyalar bilan ishlatish imkonini beradi.

---

## Mazmuni

- [Fayl tuzilishi](#fayl-tuzilishi)
- [O'rnatish va sozlash](#o'rnatish-va-sozlash)
- [Tezkor boshlash](#tezkor-boshlash)
- [Ommaviy API](#ommaviy-api)
  - [`<Asset.Icon />`](#asseticon-)
  - [`<Asset.Image />` / `<Asset.Img />`](#assetimage---assetimg-)
  - [`Asset.image(src)`](#assetimagesrc)
  - [`Asset.icon(name)`](#asseticonname)
  - [`Asset.image.load(alias, url)`](#assetimageloadalias-url)
  - [`Asset.icon.load(alias, url)`](#asseticonloadalias-url)
  - [`preCacheUrls(urls)`](#precacheurlsurls)
  - [`clearCache()`](#clearcache)
  - [`getLogHistory()`](#getloghistory)
- [Ishlatish bo'yicha qoidalar (muhim!)](#ishlatish-bo'yicha-qoidalar-muhim)
- [Arxitektura — qatlamlar va ichki ishlash mantiqi](#arxitektura--qatlamlar-va-ichki-ishlash-mantiqi)
  - [Nega 4 qatlam?](#nega-4-qatlam)
  - [Qatlamlar orasidagi bog'liqlik yo'nalishi](#qatlamlar-orasidagi-bog'liqlik-yo'nalishi)
  - [`static/` — statik resurslar](#static--statik-resurslar)
  - [`utils/` — React'ga bog'liq bo'lmagan yordamchilar](#utils--reactga-bog'liq-bo'lmagan-yordamchilar)
  - [`core/` — keshlash va registry mantig'i](#core--keshlash-va-registry-mantig'i)
  - [`components/` — React komponentlari va hooklar](#components--react-komponentlari-va-hooklar)
  - [Keshlash darajalari (3 tier)](#keshlash-darajalari-3-tier)
  - [LRU in-memory kesh](#lru-in-memory-kesh)
  - [Blob reference counting](#blob-reference-counting)
  - [Cache API: TTL va hajm limiti](#cache-api-ttl-va-hajm-limiti)
  - [Inflight dedup](#inflight-dedup)
  - [Static vs Remote rasm strategiyasi](#static-vs-remote-rasm-strategiyasi)
  - [Alias registry mexanizmi](#alias-registry-mexanizmi)
  - [SVG prop injection](#svg-prop-injection)
  - [HMR-safe singletonlar](#hmr-safe-singletonlar)
  - [Rules of Hooks bilan ishlash](#rules-of-hooks-bilan-ishlash)
- [Logger](#logger)
- [Xatoliklarni ko'rsatish (`AssetError`)](#xatoliklarni-ko'rsatish-asseterror)
- [Ma'lum cheklovlar](#ma'lum-cheklovlar)

---

## Fayl tuzilishi

```
@asset/
├── components/             ← React'ga bog'liq qatlam (komponent + hook)
│   ├── Icon.jsx              <Asset.Icon /> komponenti
│   ├── Image.jsx             <Asset.Image /> / <Asset.Img /> komponenti
│   └── index.js               getAssetImage/getAssetIcon hooklari + ikkisini eksport
├── core/                   ← React'ga bog'liq bo'lmagan biznes-logika
│   ├── cache.js               3 darajali kesh: LRU, Cache API, network
│   └── registry.js            alias/iconAlias registry, load()/resolveTargetUrl()
├── static/                 ← faqat build-time (webpack) qoidalarga bog'liq
│   └── main.js                require.context orqali icons{}/images{} bundle
├── utils/                  ← umumiy, hech narsaga bog'liq bo'lmagan vositalar
│   ├── logger.js              konsol log + tarixchi
│   └── svgInject.jsx          injectSvgProps, getCacheKey, AssetError
└── index.js                ← YAGONA public entry point
```

| Fayl | Vazifasi |
|---|---|
| `index.js` | Tashqi (public) entry point — `Asset`, `preCacheUrls`, `clearCache`, `getLogHistory` ni eksport qiladi. Ichki papkalar implementation detail hisoblanadi va to'g'ridan-to'g'ri import qilinmasligi kerak |
| `components/Icon.jsx` | `Icon` React komponenti — lokal/remote SVG iconni inline render qiladi |
| `components/Image.jsx` | `AssetImage` React komponenti — static/remote rasmni `<img>` sifatida render qiladi |
| `components/index.js` | `getAssetImage`/`getAssetIcon` (ichida hook ishlatadigan funksiyalar) + `Icon`/`AssetImage` ni qayta eksport qiladi |
| `core/cache.js` | 3 darajali kesh tizimi: in-memory LRU, Cache API, tarmoq fallback. Blob reference counting ham shu yerda |
| `core/registry.js` | `Asset.image.load()` / `Asset.icon.load()` orqali to'ldiriladigan alias registrlar va URL-resolve mantiqi |
| `static/main.js` | Webpack `require.context` orqali `../../assets/icons` va `../../assets/images` papkalarini statik bundle qiladi |
| `utils/logger.js` | Konsolga styled log yozish + so'nggi 200 ta yozuvni xotirada saqlovchi tarixchi |
| `utils/svgInject.jsx` | SVG matnini props asosida o'zgartirish (`injectSvgProps`) va xatolik placeholder (`AssetError`) |

### Import yo'nalishi (bog'liqlik grafigi)

```
index.js
  └── components/   ──┐
        ├── Icon.jsx    │
        ├── Image.jsx   ├──► core/  ──► utils/
        └── index.js  ──┘      │
                               └──► static/
```

Qoida: yuqori qatlam pastki qatlamni import qiladi, lekin **hech qachon teskari emas**. `utils/` va `static/` hech kimga bog'liq emas — eng "tub" qatlam.

---

## O'rnatish va sozlash

`static/main.js` ichida `require.context` ishlatilgani uchun **Webpack** kerak (CRA bo'lsa `craco.config.js` orqali konfiguratsiya qilingan bo'lishi kerak):

```js
// static/main.js
const iconCtx = require.context('../../assets/icons', false, /\.svg$/);
```

> ⚠️ **Diqqat:** yo'l `../../assets/icons` — ikki daraja yuqoriga chiqadi, chunki `main.js` endi `@asset/static/` ichida joylashgan (avvalgi tekis tuzilmada `@asset/` ichida bo'lgani uchun bitta `../` yetarli edi). Agar `@asset/` papkasini boshqa joyga ko'chirsangiz, shu nisbiy yo'lni qayta tekshiring.

Talab qilinadigan papka tuzilishi (`@asset/`dan bitta daraja yuqorida):

```
assets/
  icons/   *.svg   ← raw-loader orqali string sifatida import qilinadi
  images/  *.png|jpg|jpeg|gif|webp|svg  ← file-loader orqali URL sifatida
```

> **Eslatma:** agar `iconCtx(path)` `string` qaytarsa (raw-loader), shu satr saqlanadi; aks holda (`file-loader`) `mod.default ?? mod` ishlatiladi.

---

## Tezkor boshlash

```jsx
import Asset from "@asset"; // doim faqat root index.js dan import qilinadi

function Home() {
  return (
    <div>
      {/* Lokal statik icon (assets/icons/logo.svg) */}
      <Asset.Icon name="logo" fill="red" />

      {/* Lokal statik rasm (assets/images/og-image.png) */}
      <Asset.Image name="og-image" alt="OG rasm" width="800px" />

      {/* Tashqi URL — img src ichida to'g'ridan-to'g'ri */}
      <img src={Asset.icon("logo").style({ width: "500px" })} alt="logo" />
      <img src={Asset.image("og-image")} alt="rasim" width="800px" />
    </div>
  );
}
```

Runtime'da (masalan API javobidan kelgan URL) bir alias bilan oldindan yuklab qo'yish:

```jsx
Asset.image.load("get-og-image", "https://example.com/og-image.png");
Asset.icon.load("get-logo", "http://localhost:3000/logo.svg");

// ...keyinroq, istalgan joyda:
<Asset.Image name="get-og-image" />
<Asset.Icon  name="get-logo" />
```

> **Muhim:** ichki papkalardan (`@asset/core/cache`, `@asset/components/Icon` kabi) to'g'ridan-to'g'ri import qilinmaydi. Faqat `@asset` (root `index.js`) public hisoblanadi — bu qatlamlarni keyinchalik ichki refaktor qilish imkonini beradi, tashqi kod buzilmaydi.

---

## Ommaviy API

### `<Asset.Icon />`

*(Joylashuvi: `components/Icon.jsx`)*

Lokal (`assets/icons/*.svg`) yoki `Asset.icon.load()` orqali ro'yxatdan o'tgan remote SVG iconni inline (`dangerouslySetInnerHTML`) render qiladi.

| Prop | Tur | Tavsif |
|---|---|---|
| `name` | `string` | Icon nomi. `icon-` prefiksisiz ham, bilan ham ishlaydi |
| `width`, `height` | `string\|number` | SVG `<svg>` tegiga to'g'ridan-to'g'ri qo'yiladi |
| `color`, `fill` | `string` | SVG ichidagi barcha `fill="..."` (va `stroke` berilmagan bo'lsa `stroke="..."`) qiymatlarini almashtiradi (`fill="none"` ga tegmaydi) |
| `fontSize` | `string\|number` | Berilmagan `height` ni avtomatik to'ldiradi |
| `stroke` / `border` | `string \| {width, color}` | `"0.5px solid white"` kabi qisqa yozuv yoki obyekt |
| `objectFit` | `'fill'\|'cover'\|'contain'` | `preserveAspectRatio` ni boshqaradi |
| `className`, `style`, `...rest` | — | Tashqi `<span>` wrapper'ga uzatiladi |

Icon topilmasa yoki URL noto'g'ri bo'lsa, `<AssetError type="Icon" .../>` (`utils/svgInject.jsx`dan) render qilinadi va `utils/logger.js` orqali xatolik yoziladi.

### `<Asset.Image />` / `<Asset.Img />`

*(Joylashuvi: `components/Image.jsx`)*

Lokal statik rasm yoki remote URL'ni `<img>` sifatida render qiladi. `Image` va `Img` — bir xil komponentga ikki nom.

| Prop | Tur | Tavsif |
|---|---|---|
| `src` | `string` | To'g'ridan-to'g'ri URL yoki alias |
| `name` | `string` | `src` o'rniga ishlatilishi mumkin |
| `alt` | `string` | Standart `<img alt>` |
| `loading` | `string` | Standart `<img loading>` |
| `...rest` | — | `<img>` ga to'g'ridan-to'g'ri uzatiladi |

Remote rasm hali yuklanmagan bo'lsa, komponent `null` qaytaradi. Statik (lokal) rasm darhol `<img src>` bilan render qilinadi. Yuklash xatosida `<AssetError type="Rasm" .../>` ko'rsatiladi.

### `Asset.image(src)`

*(Joylashuvi: `components/index.js` — `getAssetImage`)*

Render funksiyasi **ichida** chaqiriladigan funksiya (pastga qarang), `<img src={...}>` uchun mos qiymat qaytaradi:

- **Alias** (`Asset.image.load()` orqali) bo'lsa: ichki hook orqali blob tayyor bo'lguncha `EMPTY_IMAGE` qaytaradi, tayyor bo'lgach qayta render bilan haqiqiy blob URL'ni qaytaradi.
- **To'g'ridan-to'g'ri https URL** bo'lsa: darhol original URL'ni qaytaradi, background'da `core/cache.js`dagi `resolveImage()` ham chaqirilib qo'yiladi.
- `memoryCache`da allaqachon bor bo'lsa: darhol tayyor qiymat.

### `Asset.icon(name)`

*(Joylashuvi: `components/index.js` — `getAssetIcon`)*

`SvgDataUri` (`String`dan meros) obyektini qaytaradi — `<img src={...}>` ichida to'g'ridan-to'g'ri ishlatiladi. Qo'shimcha `.style({ ... })` metodi `utils/svgInject.jsx`dagi `injectSvgProps()` orqali yangi variant generatsiya qiladi:

```jsx
<img src={Asset.icon("logo").style({ width: "500px", fill: "red" })} />
```

### `Asset.image.load(alias, url)`

*(Joylashuvi: `core/registry.js` — `loadAssetImage`)*

Bir martalik chaqiriq — `alias` nomini haqiqiy `url` ga bog'laydi va remote bo'lsa darhol `resolveImage(url)` ni boshlab qo'yadi.

```jsx
Asset.image.load("hero-banner", "https://cdn.example.com/banner.png");
```

### `Asset.icon.load(alias, url)`

*(Joylashuvi: `core/registry.js` — `loadAssetIcon`)*

Xuddi yuqoridagi kabi, lekin SVG iconlar uchun — `resolveSvgText(url)` orqali SVG matnini oldindan yuklab qo'yadi.

### `preCacheUrls(urls)`

*(Joylashuvi: `core/cache.js`, root `index.js` orqali qayta eksport qilinadi)*

```js
import { preCacheUrls } from "@asset";

await preCacheUrls([
  "https://example.com/a.png",
  "https://example.com/b.png",
]);
```

Berilgan `https://` URL ro'yxatini Cache API'ga oldindan yozadi. `Promise.allSettled` ishlatadi.

### `clearCache()`

*(Joylashuvi: `core/cache.js`, root `index.js` orqali qayta eksport qilinadi)*

```js
import { clearCache } from "@asset";

await clearCache();
```

Barcha 3 darajani tozalaydi va `window.__asset*` global holatlarni o'chiradi.

> ⚠️ Hali DOM'da ko'rsatilayotgan blob URL'lar darhol revoke qilinmaydi — komponent unmount bo'lganda hal qilinadi.

### `getLogHistory()`

*(Joylashuvi: `utils/logger.js`, root `index.js` orqali qayta eksport qilinadi)*

```js
import { getLogHistory } from "@asset";

console.table(getLogHistory());
```

So'nggi 200 ta log yozuvining nusxasini qaytaradi.

---

## Ishlatish bo'yicha qoidalar (muhim!)

### `Asset.image()` va `Asset.icon()` — faqat komponent render funksiyasi ichida

Ikkisi ham (`components/index.js` ichida) shartsiz `useState`/`useEffect` chaqiradi:

```jsx
// ✅ TO'G'RI — render ichida
function Card() {
  return <img src={Asset.image("alias")} />;
}

// ❌ NOTO'G'RI — event handler ichida "Invalid hook call" xatosi beradi
function Card() {
  const onClick = () => {
    const src = Asset.image("alias"); // XATO!
  };
}
```

### `Asset.image.load()` / `Asset.icon.load()` — istalgan joyda, lekin bir marta

`core/registry.js` ichidagi bu funksiyalar oddiy funksiya, hook emas — istalgan joyda chaqirilishi mumkin. Bir xil `alias` uchun bir necha marta chaqirilsa, oxirgi `url` registrda qoladi.

### Statik nom vs alias vs to'g'ridan-to'g'ri URL

| `name`/`src` qiymati | Manba | Misol |
|---|---|---|
| `assets/icons/`, `assets/images/` dagi fayl nomi | `static/main.js` orqali bundle qilingan statik resurs | `"logo"` → `assets/icons/logo.svg` |
| Avval `*.load()` bilan ro'yxatdan o'tgan nom | `core/registry.js`dagi runtime alias registry | `"get-logo"` → `Asset.icon.load("get-logo", url)` |
| `http(s)://`, `data:`, `blob:` bilan boshlanadigan string | To'g'ridan-to'g'ri URL | `Asset.image("https://...")` |

### Faqat root `index.js`dan import qiling

```js
// ✅ TO'G'RI
import Asset, { clearCache } from "@asset";

// ❌ NOTO'G'RI — ichki implementatsiyaga bog'lanib qolasiz
import { memoryCache } from "@asset/core/cache";
```

---

## Arxitektura — qatlamlar va ichki ishlash mantiqi

### Nega 4 qatlam?

Loyiha aslida 4 mustaqil vazifani bajaradi, va har biri o'z o'zgarish sababiga ega (Single Responsibility):

| Qatlam | Nimaga bog'liq | Nima uchun o'zgaradi |
|---|---|---|
| `static/` | Webpack/build tooling | Bundler yoki loader almashganda |
| `utils/` | Hech narsaga (sof JS) | SVG formatlash qoidasi o'zgarganda |
| `core/` | `utils/`, `static/` | Keshlash strategiyasi, TTL, registry mantig'i o'zgarganda |
| `components/` | `core/`, `utils/`, `static/`, React | UI/render xatti-harakati o'zgarganda |

Bitta faylda hammasi aralash bo'lganda, "keshlash logikasini tuzatish" uchun React komponentini ham qayta o'qishga majbur bo'lasiz. Ajratilganda har bir o'zgarish o'z faylida qoladi.

### Qatlamlar orasidagi bog'liqlik yo'nalishi

```
components/  ──depends on──►  core/  ──depends on──►  utils/, static/
```

Hech qachon teskari emas: `core/cache.js` React haqida hech narsa bilmaydi, `utils/logger.js` esa hech kim haqida bilmaydi. Bu qoida buzilsa (masalan `utils/` ichida `core/`ni import qilsa) — aylanma bog'liqlik (circular dependency) xavfi tug'iladi.

### `static/` — statik resurslar

`static/main.js` — webpack `require.context` orqali `../../assets/icons` va `../../assets/images` papkalarini statik ravishda bundle qiladi:

```js
const iconCtx = require.context('../../assets/icons', false, /\.svg$/);
export const icons = {};
iconCtx.keys().forEach((path) => { /* ... */ });
```

Bu qatlam **faqat build-time** qoidalarga bog'liq (Webpack, raw-loader/file-loader konfiguratsiyasi) — shuning uchun qolgan barcha qatlamlardan ajratilgan: agar ertaga Vite'ga o'tilsa, faqat shu bitta fayl qayta yoziladi.

### `utils/` — React'ga bog'liq bo'lmagan yordamchilar

| Fayl | Eksport qiladi | Vazifasi |
|---|---|---|
| `logger.js` | `logError`, `logWarn`, `logInfo`, `getLogHistory`, `LogLevel` | Konsolga styled log + 200 ta yozuvlik tarixchi |
| `svgInject.jsx` | `isSvgString`, `isRemoteUrl`, `injectSvgProps`, `getCacheKey`, `AssetError` | SVG matnini props asosida o'zgartirish va xatolik placeholder |

`svgInject.jsx` `.jsx` kengaytmasiga ega, chunki `AssetError` JSX qaytaradi — lekin bu hali ham "utils" hisoblanadi, chunki u React state/hook ishlatmaydi, faqat JSX **chiqaradi** (sof funksiya, props kiradi — element chiqadi).

### `core/` — keshlash va registry mantig'i

| Fayl | Eksport qiladi | Vazifasi |
|---|---|---|
| `cache.js` | `resolveImage`, `resolveSvgText`, `memoryCache`, `blobRefs`, `validateProtocol`, `preCacheUrls`, `clearCache` | 3 darajali kesh tizimi (pastga qarang) |
| `registry.js` | `aliasRegistry`, `iconAliasRegistry`, `loadAssetImage`, `loadAssetIcon`, `resolveTargetUrl`, `resolveIconTargetUrl` | `*.load()` orqali to'ldiriladigan alias xaritalari |

Bu qatlam React haqida hech narsa bilmaydi — `cache.js` va `registry.js`ni boshqa frameworkka (Vue, Svelte, vanilla JS) ko'chirib bo'lardi, hech narsa o'zgarmaydi.

### `components/` — React komponentlari va hooklar

| Fayl | Eksport qiladi | Vazifasi |
|---|---|---|
| `Icon.jsx` | `Icon` (default) | `<Asset.Icon />` komponenti |
| `Image.jsx` | `AssetImage` (default) | `<Asset.Image />` / `<Asset.Img />` komponenti |
| `index.js` | `Icon`, `AssetImage`, `getAssetImage`, `getAssetIcon` | Hook ishlatadigan `Asset.image()`/`Asset.icon()` funksiyalari + qayta eksport |

`getAssetImage`/`getAssetIcon` ichida `useState`/`useEffect` chaqirilgani uchun (`useResolvedAssetSrc`, `useResolvedIconSvg`) ular `core/`da emas, aynan shu qatlamda turishi shart — bu React-hook funksiyalari, sof mantiq emas.

### Keshlash darajalari (3 tier)

```
1. In-memory LRU Map (window.__assetMemoryCache)
   └─ eng tez, sahifa ichida instant, lekin reload'da yo'qoladi
2. Cache API (Service Worker Cache Storage, "asset-cache-v1")
   └─ sahifa reload/yangi tab'da ham saqlanadi, TTL=7 kun, max 50MB
3. Network (fetch)
   └─ fallback, har ikkisida ham topilmasa
```

`core/cache.js`dagi `resolveImage(url)` va `resolveSvgText(url)` shu zanjirni ketma-ket tekshiradi.

### LRU in-memory kesh

`LruCache` klassi (`core/cache.js`) `Map`ning insertion-order xususiyatidan foydalanadi:

- `get(key)` — topilgan entry'ni o'chirib, oxiriga qayta qo'shadi
- `set(key, val)` — agar `size >= LRU_MAX_ENTRIES` (50) bo'lsa, birinchi (eng eski) entry chiqariladi va `blobRefs.tryRevoke()` ga yuboriladi

### Blob reference counting

`blobRefs` (HMR-safe `window.__assetBlobRefs`) — bir blob URL'ni bir nechta komponent ishlatganda noto'g'ri `revokeObjectURL()` chaqirilishining oldini oladi:

```
blobRefs.inc(url)        komponent shu blob'ni "egallab oldi" — count++
blobRefs.dec(url)         komponent unmount/almashdi — count--, 0 ga tushsa revoke
blobRefs.tryRevoke(url)   LRU evict / clearCache chaqiradi — count<=0 bo'lsagina revoke
```

`components/Image.jsx`dagi `AssetImage` har safar yangi blob URL olganda `blobRefs.inc()`, unmount bo'lganda `blobRefs.dec()` chaqiradi.

### Cache API: TTL va hajm limiti

`putWithTimestamp(store, url, response)` (`core/cache.js`) — Cache API'ga yozishdan oldin `x-cached-at` header qo'shadi. `evictCacheStore(store)` har bir `put`dan keyin background'da:

1. Barcha yozuvlarni `cachedAt` bo'yicha saralaydi
2. Kumulativ hajmni hisoblaydi
3. Eskirgan (`> 7 kun`) yoki **50MB**dan oshgan yozuvlarni o'chiradi

### Inflight dedup

`core/cache.js`dagi `inflightImages`/`inflightSvgs` Map'lari — bir xil URL uchun bir vaqtda bir necha so'rov kelsa, faqat bitta `fetch()` chaqiriladi, qolganlari mavjud Promise'ni qaytarib oladi.

### Static vs Remote rasm strategiyasi

`components/Image.jsx`dagi `AssetImage` ikkisini farqlaydi (`utils/svgInject.jsx`dagi `isRemoteUrl()` orqali):

| | Static (lokal) | Remote (https://...) |
|---|---|---|
| Render | Darhol `<img src={url}>` | Avval `null` |
| Keshlash | Brauzer disk-cache | `core/cache.js`dagi `resolveImage()` |
| Sabab | Fayl nomi hash'langan, immutable | Sayt bo'ylab 1 marta so'rov kafolati kerak |

### Alias registry mexanizmi

```
core/registry.js:
  aliasRegistry       (rasmlar uchun)   alias -> url
  iconAliasRegistry   (iconlar uchun)   alias -> url
```

`Asset.image.load()`/`Asset.icon.load()` shu Map'larga yozadi va darhol fetch'ni boshlab qo'yadi. `resolveTargetUrl()`/`resolveIconTargetUrl()` render vaqtida bu registrlarni avval tekshiradi.

### SVG prop injection

`injectSvgProps(svgRaw, options)` (`utils/svgInject.jsx`) xom SVG matnini props asosida o'zgartiradi: `fill`/`color`, `stroke`/`border`, `width`/`height`, `objectFit`. Natija `components/Icon.jsx`dagi `injectedSvgCache` yoki `components/index.js`dagi `localIconStyleCache`da keshlanadi.

### HMR-safe singletonlar

Barcha global holat `window` ob'ektida saqlanadi (`??=` bilan):

```js
window.__assetMemoryCache              (core/cache.js)
window.__assetBlobRefs                 (core/cache.js)
window.__assetCacheStorePromise        (core/cache.js)
window.__assetInflightImages/Svgs      (core/cache.js)
window.__assetAliasRegistry            (core/registry.js)
window.__assetIconAliasRegistry        (core/registry.js)
window.__assetInjectedSvgCache         (components/Icon.jsx)
window.__assetLocalIconCache           (components/index.js)
window.__assetLocalIconStyleCache      (components/index.js)
```

SSR holatida har biri oddiy modul-darajasida yaratiladi.

### Rules of Hooks bilan ishlash

`components/index.js`dagi `getAssetImage()`/`getAssetIcon()` ichida ichki hook **har doim** chaqiriladi, lekin argumentga shartli qiymat beriladi:

```js
function getAssetImage(src) {
  const isAlias = !!src && aliasRegistry.has(src);
  const targetUrl = src ? resolveTargetUrl(src) : null;

  // Hook HAR DOIM chaqiriladi — faqat ICHKARIDAGI mantiq shartli
  const resolvedFromHook = useResolvedAssetSrc(isAlias ? targetUrl : null);

  if (isAlias) return resolvedFromHook;
  // ...
}
```

---

## Logger

`utils/logger.js` — markazlashtirilgan log tizimi:

```js
import { logError, logWarn, logInfo, getLogHistory, LogLevel } from "@asset/utils/logger";
// (yoki getLogHistory uchun root: import { getLogHistory } from "@asset";)

logError("Nimadir xato ketdi", { detail: "qo'shimcha ma'lumot" });
```

- Konsolga styled prefiks bilan yoziladi (error=qizil, warn=sariq, info=ko'k)
- `logHistory` massivida (max 200) saqlanadi, `getLogHistory()` orqali olinadi
- `components/` va `core/` ichida xatolik/ogohlantirishlar shu orqali yoziladi

## Xatoliklarni ko'rsatish (`AssetError`)

`utils/svgInject.jsx` ichidagi komponent — icon/rasm topilmagan yoki yuklanmagan holatlarda ko'rinadigan placeholder:

```jsx
<span role="alert" style={{ /* qizil rangli badge */ }}>
  ⚠ Icon: <strong>logo</strong> — Registrda topilmadi
</span>
```

`type` (`"Icon"` / `"Rasm"`), `name` va `detail` qabul qiladi.

---

## Ma'lum cheklovlar

- `static/main.js` faqat Webpack `require.context` muhitida ishlaydi.
- `Asset.image()` / `Asset.icon()` faqat **function component render tanasi** ichida chaqirilishi mumkin.
- Cache API mavjud bo'lmagan muhitlarda avtomatik `null` ga tushib, faqat memory-kesh + tarmoq bilan davom etadi.
- `dangerouslySetInnerHTML` ishlatilgani uchun ishonchsiz tashqi SVG manbalarida XSS xavfini hisobga oling.
- Papkani ko'chirsangiz, `static/main.js`dagi nisbiy `require.context` yo'lini qayta tekshiring (hozir `../../assets/...`).