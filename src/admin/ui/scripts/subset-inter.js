/**
 * ============================================
 * Inter shriftini Unicode diapazonlariga bo'lish
 * ============================================
 *
 * Ishga tushirish:  npm run fonts:subset
 *
 * NIMA QILADI:
 * `src/assets/fonts/Inter/Inter-Variable.woff2` (to'liq, 341 KB) dan
 * to'rtta kichik subset yasaydi. `src/styles/fonts/inter.css` da har biri
 * o'z `unicode-range` i bilan e'lon qilingan, shuning uchun brauzer
 * sahifada QAYSI belgilar ishlatilsa faqat o'shani yuklaydi:
 *
 *   o'zbek lotin sahifasi  → latin (103 KB)
 *   kirill ism ko'rinsa    → o'shanda cyrillic (29 KB) ham olinadi
 *
 * Ya'ni "tofu" (bo'sh kvadrat) xavfi yo'q — kerakli diapazon har doim
 * mavjud, shunchaki kerak bo'lgandagina yuklanadi.
 *
 * QACHON QAYTA ISHGA TUSHIRILADI:
 * Faqat Inter-Variable.woff2 yangilansa. Natijada hosil bo'lgan fayllar
 * repoda saqlanadi, build vaqtida bu skript ISHLAMAYDI.
 *
 * Diapazonlar Google Fonts'ning Inter uchun standart bo'linishi bilan bir xil.
 */
const fs = require("fs");
const path = require("path");
const subsetFont = require("subset-font");

const FONT_DIR = path.join(__dirname, "..", "src", "assets", "fonts", "Inter");
const SOURCE = path.join(FONT_DIR, "Inter-Variable.woff2");

const SUBSETS = {
  latin: [
    [0x0000, 0x00ff], [0x0131, 0x0131], [0x0152, 0x0153],
    [0x02bb, 0x02bc], [0x02c6, 0x02c6], [0x02da, 0x02da], [0x02dc, 0x02dc],
    [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329],
    [0x2000, 0x206f], [0x2074, 0x2074], [0x20ac, 0x20ac],
    [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193],
    [0x2212, 0x2212], [0x2215, 0x2215], [0xfeff, 0xfeff], [0xfffd, 0xfffd],
  ],
  "latin-ext": [
    [0x0100, 0x02ba], [0x02bd, 0x02c5], [0x02c7, 0x02cc], [0x02ce, 0x02d7],
    [0x02dd, 0x02ff], [0x1d00, 0x1dbf], [0x1e00, 0x1e9f], [0x1ef2, 0x1eff],
    [0x2020, 0x2020], [0x20a0, 0x20ab], [0x20ad, 0x20c0], [0x2113, 0x2113],
    [0x2c60, 0x2c7f], [0xa720, 0xa7ff],
  ],
  cyrillic: [
    [0x0301, 0x0301], [0x0400, 0x045f], [0x0490, 0x0491],
    [0x04b0, 0x04b1], [0x2116, 0x2116],
  ],
  // O'zbek kirill harflari (ғ, ҳ, қ) aynan shu diapazonda
  "cyrillic-ext": [
    [0x0460, 0x052f], [0x1c80, 0x1c88], [0x20b4, 0x20b4],
    [0x2de0, 0x2dff], [0xa640, 0xa69f], [0xfe2e, 0xfe2f],
  ],
};

const rangesToText = (ranges) => {
  let text = "";
  for (const [lo, hi] of ranges) {
    for (let code = lo; code <= hi; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // surrogate juftliklar
      text += String.fromCodePoint(code);
    }
  }
  return text;
};

(async () => {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Manba topilmadi: ${SOURCE}`);
    process.exit(1);
  }

  const original = fs.readFileSync(SOURCE);
  console.log(`Manba: Inter-Variable.woff2 — ${Math.round(original.length / 1024)} KB\n`);

  for (const [name, ranges] of Object.entries(SUBSETS)) {
    const buf = await subsetFont(original, rangesToText(ranges), { targetFormat: "woff2" });
    const fileName = `Inter-Variable-${name}.woff2`;
    fs.writeFileSync(path.join(FONT_DIR, fileName), buf);
    console.log(`  ${fileName.padEnd(34)} ${String(Math.round(buf.length / 1024)).padStart(4)} KB`);
  }

  console.log("\n✅ Tayyor. `src/styles/fonts/inter.css` dagi unicode-range lar bilan mos bo'lishi kerak.");
})();
