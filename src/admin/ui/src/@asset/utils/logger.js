/**
 * @asset/utils/logger.js
 * ─────────────────────────────────────────────────────────────
 * Centralised error/warning logger for the asset system.
 *
 * ▸ Logs to console (with styled prefix)
 * ▸ Provides React-renderable error components for DOM display
 * ─────────────────────────────────────────────────────────────
 */

const LOG_PREFIX = '%c[Asset]';
const STYLE_ERR  = 'color:#ff4d4f;font-weight:bold';
const STYLE_WARN = 'color:#faad14;font-weight:bold';
const STYLE_INFO = 'color:#1890ff;font-weight:bold';

/**
 * Log levels with console method mapping.
 */
export const LogLevel = Object.freeze({
  ERROR: 'error',
  WARN:  'warn',
  INFO:  'info',
});

/**
 * Structured log entry for internal tracking.
 * @typedef {{ level: string, message: string, detail?: any, timestamp: number }} LogEntry
 */

/** @type {LogEntry[]} */
const logHistory = [];
const MAX_HISTORY = 200;

/**
 * Core log function — writes to console and stores in history.
 */
function log(level, message, detail) {
  const entry = { level, message, detail: detail ?? null, timestamp: Date.now() };

  if (logHistory.length >= MAX_HISTORY) logHistory.shift();
  logHistory.push(entry);

  const style = level === LogLevel.ERROR ? STYLE_ERR
    : level === LogLevel.WARN  ? STYLE_WARN
    : STYLE_INFO;

  if (detail !== undefined && detail !== null) {
    console[level](LOG_PREFIX, style, message, detail);
  } else {
    console[level](LOG_PREFIX, style, message);
  }
}

/* ── public shortcuts ───────────────────────────────────── */

export function logError(message, detail) {
  log(LogLevel.ERROR, message, detail);
}

export function logWarn(message, detail) {
  log(LogLevel.WARN, message, detail);
}

export function logInfo(message, detail) {
  log(LogLevel.INFO, message, detail);
}

/**
 * Retrieve a snapshot of the log history (useful for debug panels).
 */
export function getLogHistory() {
  return [...logHistory];
}