/**
 * ============================================
 * ANITOKU — Axios Client
 * ============================================
 *
 * Markaziy HTTP client.
 *  - Base URL va timeout .env dan
 *  - Sessiya cookie avtomatik yuboriladi (withCredentials)
 *  - 401 → sessiya tugagan: belgi tozalanadi va "auth:logout" chiqadi
 *  - Barcha xatolar ApiError ga keltiriladi
 *
 * DODAKINO'DAN FARQ: bu yerda JWT refresh navbati (failedQueue,
 * isRefreshing) YO'Q. Sabab — backend refresh token bermaydi, sessiya
 * cookie o'z muddatigacha amal qiladi. Muddati tugasa yagona to'g'ri
 * xatti-harakat — qayta kirish so'rash. Ishlamaydigan refresh mantiqini
 * saqlab qo'yish "bor, demak ishlaydi" degan yolg'on taassurot berardi.
 */

import axios from "axios";
import NProgress from "../utils/progress";
import { TokenManager } from "./tokenManager";
import { ApiError } from "./errors";

// ─── NProgress — haqiqiy so'rovlarga bog'langan progress ─────────
// Bar birinchi so'rov boshlanganda chiqadi va OXIRGI faol so'rov
// tugagandagina yakunlanadi — tezlik haqiqiy tarmoq holatini aks
// ettiradi, soxta timer emas.
//
// FON SO'ROVLARI: `client.get(url, { silent: true })` chiziqni umuman
// ko'rsatmaydi. Panel ko'p joyda 10-20 soniyada avtomatik yangilanadi —
// silent bo'lmasa bar tinimsiz miltillardi.
let activeRequests = 0;

const isSilent = (config) => Boolean(config?.silent);

const progressStart = () => {
  if (activeRequests === 0) NProgress.start();
  activeRequests += 1;
};

const progressDone = () => {
  activeRequests = Math.max(0, activeRequests - 1);
  if (activeRequests === 0) NProgress.done();
};

const client = axios.create({
  baseURL: process.env.REACT_APP_API_BASE_URL || "/api",
  timeout: Number(process.env.REACT_APP_API_TIMEOUT) || 20000,
  withCredentials: true, // HttpOnly sessiya cookie'sini yuborish uchun
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ─── Request interceptor ────────────────────────────────────────
client.interceptors.request.use(
  (config) => {
    if (!isSilent(config)) progressStart();
    return config;
  },
  (error) => Promise.reject(error)
);

/**
 * Vaqtinchalik uzilishda qayta urinish.
 *
 * Agent qayta ishga tushganda port bir necha soniya yopiq boʻladi va
 * nginx 502 qaytaradi. Foydalanuvchi uchun bu "panel buzildi" degani —
 * aslida esa u yerda kutish kerak edi, xolos.
 *
 * Faqat OʻQISH soʻrovlari qaytariladi. POST ni qayta yuborish xavfli:
 * xabar ikki marta joʻnab ketishi yoki loyiha ikki marta yaratilishi
 * mumkin — server soʻrovni qabul qilib, javobi yoʻlda yoʻqolgan boʻlsa
 * biz buni bila olmaymiz.
 *
 * Uch urinish, oʻsib boruvchi kutish: 0.6s, 1.5s — jami ~2 soniya,
 * qayta ishga tushish oynasini qoplaydi, lekin haqiqiy nosozlikni
 * uzoq yashirmaydi.
 */
const RETRY_DELAYS_MS = [600, 1500];

const isTransient = (error) => {
  const status = error.response?.status;
  if (status === 502 || status === 503 || status === 504) return true;
  // Javob umuman kelmadi — ulanish rad etildi yoki uzildi
  return !error.response && error.code !== "ECONNABORTED";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Response interceptor ───────────────────────────────────────
client.interceptors.response.use(
  (response) => {
    if (!isSilent(response.config)) progressDone();
    return response.data;
  },

  async (error) => {
    const config = error.config || {};
    const status = error.response?.status;
    const url = config.url || "";

    // Hisobni MAJBURAN yopamiz: bu urinish `progressStart()` bilan
    // ochilgan edi. Qayta urinish o'zining `progressStart()` ini
    // chaqiradi, shuning uchun bu yerda yopilmasa hisoblagich o'sib
    // ketib, yuklanish chizig'i abadiy ekranda qolardi.
    if (!isSilent(config)) progressDone();

    const method = String(config.method || "get").toLowerCase();
    if (method === "get" && isTransient(error)) {
      config.__retries = config.__retries || 0;
      if (config.__retries < RETRY_DELAYS_MS.length) {
        const wait = RETRY_DELAYS_MS[config.__retries];
        config.__retries += 1;
        await sleep(wait);
        // `client(config)` yangi interceptor siklini boshlaydi, lekin
        // `__retries` config'da qolgani uchun sanoq davom etadi.
        return client(config);
      }
    }

    // 401 — sessiya yo'q yoki tugagan. Login so'rovining o'zi istisno:
    // u yerda 401 "parol xato" degani, tizimdan chiqarish emas.
    if (status === 401 && !url.includes("/login")) {
      TokenManager.clearTokens();
      window.dispatchEvent(new CustomEvent("auth:logout"));
    }

    return Promise.reject(ApiError.fromAxios(error));
  }
);

export default client;
