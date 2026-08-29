/**
 * ============================================
 * ANITOKU — API yagona kirish nuqtasi
 * ============================================
 *
 * Sahifalar shu yerdan oladi:
 *   import { api, ENDPOINTS } from "../../api";
 *   const data = await api.client.get(ENDPOINTS.STATS(24));
 */

import client from "./client";
import { ApiError } from "./errors";
import { ENDPOINTS } from "./endpoints";
import { TokenManager } from "./tokenManager";
import AdminService from "./services/authService";
import { startTelegramLoginSession } from "./telegramLoginSocket";

export const api = {
  client,
  auth: AdminService,
  admin: AdminService, // eski nom — chaqiruvlar buzilmasin
  telegramLogin: startTelegramLoginSession,
};

export { ApiError, ENDPOINTS, TokenManager, startTelegramLoginSession };
export default api;
