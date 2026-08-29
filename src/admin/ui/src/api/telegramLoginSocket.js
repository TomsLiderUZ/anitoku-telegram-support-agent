/**
 * ============================================
 * ANITOKU — Telegram login sessiyasi
 * ============================================
 *
 * Fayl dodakino'dan keldi, u yerda socket.io orqali ishlardi. Bizda
 * backend socket ochmaydi — QR holati oddiy REST bilan so'raladi.
 * Modulning ROLI o'zgarmadi: "Telegram login sessiyasini boshla,
 * o'zgarishlarni xabar qil, to'xtatish funksiyasini qaytar" — shuning
 * uchun nomi ham, chaqirish usuli ham o'sha bo'yicha qoldi.
 *
 * NEGA SO'ROV EMAS, SESSIYA:
 * QR kod ~30 soniyada eskiradi. Ekranda turgan, lekin allaqachon o'lik
 * kodni skanerlash — foydalanuvchi uchun eng yomon holat: u telefonini
 * ko'tarib turadi, hech narsa bo'lmaydi va sabab ko'rinmaydi. Shuning
 * uchun sessiya kodni muntazam yangilab turadi va eskirganini ochiq
 * aytadi.
 *
 * Ishlatilishi:
 *   const stop = startTelegramLoginSession({ onUpdate, onDone, onError });
 *   ...
 *   stop();   // komponent unmount bo'lganda — MAJBURIY
 */

import client from "./client";
import { ENDPOINTS } from "./endpoints";

const POLL_INTERVAL_MS = 3000;

export function startTelegramLoginSession({ onUpdate, onDone, onError } = {}) {
  let timer = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const state = await client.get(ENDPOINTS.TELEGRAM.QR, { silent: true });
      if (stopped) return;

      onUpdate?.(state);

      // Kutish tugadi — ulandi, yiqildi yoki kod umuman skanerlanmadi.
      if (state.status !== "awaiting_qr") {
        stop();
        onDone?.(state);
      }
    } catch (err) {
      if (stopped) return;
      // Tarmoq bir lahzaga uzilishi mumkin — bu sessiyani tugatish
      // uchun sabab emas. Faqat xabar beramiz, keyingi urinish o'z
      // vaqtida davom etadi.
      onError?.(err);
    }
  };

  // Boshlash: sessiyani ochamiz, birinchi kodni darhol ko'rsatamiz.
  client
    .post(ENDPOINTS.TELEGRAM.QR, {})
    .then((state) => {
      if (stopped) return;
      onUpdate?.(state);
      if (state.status !== "awaiting_qr") {
        onDone?.(state);
        return;
      }
      timer = setInterval(poll, POLL_INTERVAL_MS);
    })
    .catch((err) => {
      if (stopped) return;
      onError?.(err);
    });

  return stop;
}
