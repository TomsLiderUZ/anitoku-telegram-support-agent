/**
 * ============================================
 * ANITOKU — Admin sessiya xizmati
 * ============================================
 *
 * Kirish, chiqish va "kim kirgan" — uchtasi. Boshqa hech narsa
 * sessiyaga tegishli emas.
 *
 * `{ baseURL: "" }` — LOGIN/LOGOUT ataylab /api dan tashqarida
 * (endpoints.js dagi izohga qarang): sessiyani yaratadigan so'rov
 * sessiya talab qiladigan ildizda tura olmaydi.
 */

import client from "../client";
import { ENDPOINTS } from "../endpoints";
import { TokenManager } from "../tokenManager";

const AdminService = {
  /**
   * Kirish.
   * @param {{username: string, password: string}} credentials
   * @param {boolean} rememberMe — belgi cookie'si 30 kun tursinmi
   *
   * Javob: { ok: true, admin: { id, username, role } }
   * Haqiqiy sessiya HttpOnly cookie'da keladi — bu yerga tushmaydi.
   */
  async login(credentials, rememberMe = true) {
    const response = await client.post(ENDPOINTS.AUTH.LOGIN, credentials, { baseURL: "" });
    if (response?.admin) TokenManager.setSession(response.admin, rememberMe);
    return response;
  },

  /**
   * Chiqish. Server so'rovi yiqilsa ham belgi MAJBURAN tozalanadi —
   * aks holda foydalanuvchi "chiqdim" deb o'ylab, panelda qolib
   * ketardi.
   */
  async logout() {
    try {
      await client.post(ENDPOINTS.AUTH.LOGOUT, {}, { baseURL: "" });
    } finally {
      TokenManager.clearTokens();
    }
  },

  /** Joriy admin — sessiya haqiqatan amal qilishini ham tekshiradi. */
  async me() {
    return client.get(ENDPOINTS.ME);
  },
};

export default AdminService;
