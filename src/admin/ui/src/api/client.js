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

// ─── Response interceptor ───────────────────────────────────────
client.interceptors.response.use(
  (response) => {
    if (!isSilent(response.config)) progressDone();
    return response.data;
  },

  (error) => {
    if (!isSilent(error.config)) progressDone();

    const status = error.response?.status;
    const url = error.config?.url || "";

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
