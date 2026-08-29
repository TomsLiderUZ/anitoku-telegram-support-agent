/** Shared formatters. Uzbek locale, Tashkent time — the founder's frame. */

export const num = (n) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString('uz-UZ');

/** 12 400 → "12.4k". Keeps stat cards from wrapping. */
export const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace('.0', '') + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.0', '') + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace('.0', '') + 'k';
  return String(v);
};

export const dur = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} kun ${h} soat`;
  if (h) return `${h} soat ${m} daq`;
  if (m) return `${m} daq`;
  return `${s} soniya`;
};

export const ms = (v) => (!v && v !== 0 ? '—' : v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms');

export const time = (ts) => {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  if (isNaN(d)) return String(ts);
  return d.toLocaleString('uz-UZ', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const ago = (ts) => {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts < 1e12 ? ts * 1000 : ts) : new Date(ts);
  if (isNaN(d)) return String(ts);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'hozir';
  if (s < 3600) return `${Math.floor(s / 60)} daq oldin`;
  if (s < 86400) return `${Math.floor(s / 3600)} soat oldin`;
  return time(ts);
};

export const gb = (b) => (Number(b || 0) / 1073741824).toFixed(2) + ' GB';
