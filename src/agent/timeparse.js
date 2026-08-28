'use strict';

/**
 * Turn the ways a person says "when" into a timestamp.
 *
 * Handles Uzbek, Russian and English: "soat 15:00 da", "ertaga 9 da",
 * "5 daqiqadan keyin", "2 soatdan keyin", "bugun kechqurun", "завтра в 10",
 * "in 30 minutes", "tomorrow at 9am", ISO strings. Returns null when nothing
 * time-like is present so the caller can ask instead of guessing.
 *
 * All wall-clock times are interpreted in Asia/Tashkent (UTC+5, no DST).
 */

const TZ_OFFSET_MIN = 5 * 60;

function nowTashkent() {
  const d = new Date();
  return new Date(d.getTime() + (TZ_OFFSET_MIN + d.getTimezoneOffset()) * 60_000);
}

/** Build a UTC Date from a Tashkent wall-clock date + hh:mm. */
function tashkentToUtc(y, m, d, hh, mm) {
  return new Date(Date.UTC(y, m, d, hh, mm) - TZ_OFFSET_MIN * 60_000);
}

const WORD_NUM = {
  bir: 1, ikki: 2, uch: 3, tort: 4, "to'rt": 4, besh: 5, olti: 6, yetti: 7, sakkiz: 8, toqqiz: 9, "to'qqiz": 9, on: 10,
  yarim: 0.5, один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, десять: 10, one: 1, two: 2, three: 3, five: 5, ten: 10, half: 0.5,
};

function num(s) {
  if (s === undefined || s === null) return null;
  const t = String(s).toLowerCase().replace(/[‘’ʻ]/g, "'");
  if (/^\d+([.,]\d+)?$/.test(t)) return parseFloat(t.replace(',', '.'));
  return WORD_NUM[t] ?? null;
}

function parseWhen(text, { from = null } = {}) {
  const t = String(text || '').toLowerCase().replace(/[‘’ʻ]/g, "'");
  const base = from ? new Date(from) : new Date();
  const local = from ? new Date(from.getTime() + (TZ_OFFSET_MIN + from.getTimezoneOffset()) * 60_000) : nowTashkent();

  // ISO / explicit datetime
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})[t\s](\d{1,2}):(\d{2})\b/);
  if (iso) return { at: tashkentToUtc(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5]), kind: 'absolute' };

  // Relative: "5 daqiqadan keyin", "2 soatdan so'ng", "через 10 минут", "in 30 minutes"
  const rel = t.match(
    /(?:(\d+|[a-zа-я']+)\s*)(daqiqa|minut|min|минут|soat|час|hour|kun|день|дн|day|hafta|недел|week)\w*\s*(?:dan\s*(?:keyin|so'ng)|ichida|o'tgach|через|in|later)?/
  );
  const relPrefix = t.match(/(?:через|in)\s+(\d+|[a-zа-я']+)\s*(daqiqa|minut|min|минут|soat|час|hour|kun|день|дн|day|hafta|недел|week)/);
  const r = relPrefix || rel;
  if (r && /(keyin|so'ng|ichida|o'tgach|через|\bin\b|later)/.test(t)) {
    const n = num(r[1]);
    if (n !== null) {
      const unit = r[2];
      const ms = /daqiqa|minut|min|минут/.test(unit) ? 60_000 : /soat|час|hour/.test(unit) ? 3_600_000 : /kun|день|дн|day/.test(unit) ? 86_400_000 : 7 * 86_400_000;
      return { at: new Date(base.getTime() + n * ms), kind: 'relative' };
    }
  }

  // Day anchor
  let dayOffset = 0;
  if (/\b(ertaga|завтра|tomorrow)\b/.test(t)) dayOffset = 1;
  else if (/\b(indinga|послезавтра|day after tomorrow)\b/.test(t)) dayOffset = 2;
  else if (/\b(bugun|сегодня|today)\b/.test(t)) dayOffset = 0;

  // Clock time: "soat 15:00", "15:30 da", "9 da", "в 10", "at 9am", "kechqurun 8 da"
  let hh = null;
  let mm = 0;
  // No \b around Cyrillic: JS word boundaries only know ASCII, so "в 10" needs
  // explicit whitespace anchors.
  const clock =
    t.match(/(?:soat\s*)?(\d{1,2})[:.](\d{2})/) ||
    t.match(/\bsoat\s*(\d{1,2})\b/) ||
    t.match(/(?:^|\s)в\s*(\d{1,2})(?=\s|$|[.,!?])/) ||
    t.match(/\b(\d{1,2})\s*(?:da|ga|at|:00)\b/) ||
    t.match(/(?:^|\s)(\d{1,2})\s*(?:де|часов|час)(?=\s|$)/) ||
    t.match(/\bat\s*(\d{1,2})\s*(am|pm)?/);
  if (clock) {
    hh = parseInt(clock[1], 10);
    mm = clock[2] && /^\d{2}$/.test(clock[2]) ? parseInt(clock[2], 10) : 0;
    if (/\bpm\b/.test(t) && hh < 12) hh += 12;
    if (/\b(kechqurun|kechasi|вечером|evening|tonight)\b/.test(t) && hh < 12) hh += 12;
    if (/\b(tushdan keyin|kunduzi|днём|afternoon)\b/.test(t) && hh < 12) hh += 12;
  } else if (/\b(ertalab|утром|morning)\b/.test(t)) hh = 9;
  else if (/\b(tushda|обед|noon|peshin)\b/.test(t)) hh = 13;
  else if (/\b(kechqurun|вечером|evening)\b/.test(t)) hh = 19;
  else if (/\b(kechasi|ночью|night)\b/.test(t)) hh = 22;

  if (hh === null && dayOffset === 0) return null;
  if (hh === null) hh = 9;
  if (hh > 23 || mm > 59) return null;

  let target = tashkentToUtc(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, hh, mm);
  // "soat 9 da" said at 10:00 with no day word means tomorrow 9, not the past.
  if (dayOffset === 0 && target.getTime() <= base.getTime() + 30_000) target = new Date(target.getTime() + 86_400_000);
  return { at: target, kind: 'clock' };
}

/** Human-readable Tashkent time for confirmations. */
function fmtTashkent(date) {
  return new Date(date).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

module.exports = { parseWhen, fmtTashkent };
