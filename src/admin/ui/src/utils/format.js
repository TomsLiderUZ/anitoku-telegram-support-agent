/**
 * Raqam va vaqtni odam o'qiydigan ko'rinishga o'girish.
 *
 * Hammasi bitta joyda, chunki bir xil qiymat ikki sahifada ikki xil
 * ko'rinsa ("1.2M" va "1 234 567") foydalanuvchi ularni turli
 * ko'rsatkich deb o'ylaydi.
 *
 * Til — uz-UZ: mingliklar bo'sh joy bilan ajraladi (1 234 567), bu
 * o'zbek tilidagi qabul qilingan yozuv.
 */

const nf = new Intl.NumberFormat("uz-UZ");

/** 1234567 → "1 234 567". Yo'q qiymat "—" bo'ladi, "0" emas: bo'sh
 *  ma'lumot bilan haqiqiy nol farqli narsalar. */
export const num = (v) => (v === null || v === undefined || Number.isNaN(v) ? "—" : nf.format(v));

/** 1234567 → "1.2M". Grafik o'qi va tor kartochkalar uchun. */
export const compact = (v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const n = Number(v);
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return nf.format(n);
};

/** Millisekund → "820 ms" yoki "5.1 s". */
export const ms = (v) => {
  if (!v && v !== 0) return "—";
  const n = Number(v);
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
};

/** Soniya → "3 kun 4 soat". */
export const dur = (sec) => {
  if (!sec && sec !== 0) return "—";
  const s = Number(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} kun ${h} soat`;
  if (h) return `${h} soat ${m} daq`;
  if (m) return `${m} daqiqa`;
  return `${Math.round(s)} soniya`;
};

/** Bayt → "3.4 GB". */
export const gb = (bytes) => {
  if (!bytes && bytes !== 0) return "—";
  const g = Number(bytes) / 1024 ** 3;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${(Number(bytes) / 1024 ** 2).toFixed(0)} MB`;
};

/**
 * Sana → "12:04" (bugun bo'lsa) yoki "14 avg 12:04".
 *
 * MUHIM: server vaqti UTC'da yozadi, foydalanuvchi esa Toshkentda
 * (+5) o'tiradi. Sana satri mintaqasiz kelsa ("2026-08-29 11:20")
 * brauzer uni MAHALLIY deb o'qiydi va soat 5 soatga yanglishadi —
 * shuning uchun bunday satrga ataylab "Z" qo'shiladi.
 */
export const time = (value) => {
  const d = toDate(value);
  if (!d) return "—";

  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();

  return d.toLocaleString("uz-UZ", {
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { day: "numeric", month: "short" }),
  });
};

/** "3 daqiqa oldin". */
export const ago = (value) => {
  const d = toDate(value);
  if (!d) return "—";

  const diff = Math.round((Date.now() - d.getTime()) / 1000);
  if (diff < 0) return "hozir";
  if (diff < 60) return `${diff} soniya oldin`;
  if (diff < 3600) return `${Math.floor(diff / 60)} daqiqa oldin`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} soat oldin`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} kun oldin`;
  return time(value);
};

/** Foiz o'zgarishi → "+12%" / "−4%". */
export const trend = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const n = Math.round(Number(value));
  if (n === 0) return "0%";
  return n > 0 ? `+${n}%` : `−${Math.abs(n)}%`;
};

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;

  if (typeof value === "number") {
    // Soniyalarda kelgan bo'lsa millisekundga o'giramiz
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  const str = String(value);
  // "YYYY-MM-DD HH:MM:SS" — mintaqasiz, ya'ni serverning UTC vaqti
  const utcish = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(str)
    ? `${str.replace(" ", "T")}Z`
    : str;

  const d = new Date(utcish);
  return Number.isNaN(d.getTime()) ? null : d;
}
