/**
 * ============================================
 * ANITOKU — API manzillari
 * ============================================
 *
 * Manzillar shu yerda, chaqiriqlar sahifalarda. Backend yo'lni
 * o'zgartirsa faqat shu fayl tahrirlanadi.
 *
 * DIQQAT — IKKI XIL ILDIZ:
 *   /api/...  → himoyalangan ma'lumot (sessiya cookie talab qilinadi)
 *   /login    → sessiyaning O'ZINI yaratadi, shuning uchun /api dan
 *               TASHQARIDA turadi (aks holda kirish uchun avval
 *               kirgan bo'lish kerak bo'lardi).
 * Shu sababli AUTH bo'limi `root: true` bilan belgilangan — client
 * ularni baseURL'siz yuboradi.
 */

export const ENDPOINTS = {
  // ─── Sessiya (baseURL'siz — ildizdan) ─────────────────────────
  AUTH: {
    root: true,
    LOGIN: "/login",
    LOGOUT: "/logout",
  },

  // ─── Kim kirgan ───────────────────────────────────────────────
  ME: "/me",

  // ─── Umumiy holat va statistika ───────────────────────────────
  STATUS: "/status",
  STATS: (hours = 24) => `/stats?hours=${hours}`,
  HEALTH: "/health",
  LOGS: (limit = 120) => `/logs?limit=${limit}`,
  /** Filtrlangan jurnal — 1 soatdan 7 kungacha, kunlik fayllardan o'qiladi. */
  LOGS_SEARCH: ({ hours = 1, level = "", scope = "", q = "", limit = 500 } = {}) => {
    const p = new URLSearchParams({ hours: String(hours), limit: String(limit) });
    if (level) p.set("level", level);
    if (scope) p.set("scope", scope);
    if (q) p.set("q", q);
    return `/logs?${p}`;
  },
  LOGS_FACETS: "/logs/facets",
  LOGS_STREAM: "/logs/stream",
  /** Agent hozir nima qilyapti: vazifalar, todo ro'yxatlari, terminal. */
  ACTIVITY: (commands = 60) => `/activity?commands=${commands}`,
  EVENTS: "/events",

  // ─── Telegram akkaunt ─────────────────────────────────────────
  TELEGRAM: {
    INFO: "/telegram",
    QR: "/telegram/qr",
    CONNECT: "/telegram/connect",
    CODE: "/telegram/code",
    PASSWORD: "/telegram/password",
    LOGOUT: "/telegram/logout",
    DIALOGS: (limit = 150) => `/telegram/dialogs?limit=${limit}`,
  },

  // ─── Suhbatlar ────────────────────────────────────────────────
  CHATS: (limit = 60) => `/chats?limit=${limit}`,
  CHAT_MESSAGES: (id, limit = 60) => `/chats/${id}/messages?limit=${limit}`,
  CHAT_REPLY: (id) => `/chats/${id}/reply`,
  CHAT_STATE: (id) => `/chats/${id}/state`,
  ESCALATIONS: (status = "open") => `/escalations?status=${status}`,
  ESCALATION_ANSWER: (id) => `/escalations/${id}/answer`,

  // ─── Agentga buyruq ───────────────────────────────────────────
  ASSISTANT_RUN: "/assistant/run",
  AGENT_STATE: "/agent/state",

  // ─── Vazifalar va rejalar ─────────────────────────────────────
  TASKS: (limit = 100) => `/tasks?limit=${limit}`,
  TASK_CANCEL: (id) => `/tasks/${id}/cancel`,
  ROUTINES: "/routines",
  ROUTINE_TOGGLE: (id) => `/routines/${id}/toggle`,
  ROUTINE: (id) => `/routines/${id}`,
  WATCHES: "/watches",

  // ─── Loyihalar (bot ham, sayt ham, boshqa kod ham) ────────────
  PROJECTS: (all = false) => `/projects${all ? "?all=1" : ""}`,
  PROJECT: (slug) => `/projects/${slug}`,
  PROJECT_FILES: (slug) => `/projects/${slug}/files`,
  PROJECT_FILE: (slug, path) => `/projects/${slug}/file?path=${encodeURIComponent(path)}`,
  PROJECT_LOGS: (slug, lines = 150) => `/projects/${slug}/logs?lines=${lines}`,
  PROJECT_START: (slug) => `/projects/${slug}/start`,
  PROJECT_STOP: (slug) => `/projects/${slug}/stop`,
  PROJECT_RESTART: (slug) => `/projects/${slug}/restart`,
  PROJECT_SETTINGS: (slug) => `/projects/${slug}/settings`,

  // ─── Bilim va o'qitish ────────────────────────────────────────
  KNOWLEDGE: (limit = 100, q = "") =>
    `/knowledge?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
  /** Qoʻshish uchun — soʻrov qatorisiz toza yoʻl. */
  KNOWLEDGE_ADD: "/knowledge",
  /** Bittasini toʻliq oʻqish (GET), tahrirlash (POST), oʻchirish (DELETE). */
  KNOWLEDGE_ITEM: (id) => `/knowledge/${id}`,
  SKILLS: "/skills",
  SKILL: (slug) => `/skills/${slug}`,
  TRAINING_RUN: "/training/run",
  PROMPT_PREVIEW: "/prompts/preview/runtime",

  // ─── AI modellar ──────────────────────────────────────────────
  KEYS: "/keys",
  KEYS_REVIVE: "/keys/revive",
  LOCAL: "/local",
  LOCAL_LOAD: "/local/load",
  LOCAL_UNLOAD: "/local/unload",
  LOCAL_DOWNLOAD: (kind) => `/local/download/${kind}`,

  // ─── Sozlamalar ───────────────────────────────────────────────
  SETTINGS: "/settings",
};
