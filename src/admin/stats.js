'use strict';
const { db } = require('../core/db');

/**
 * Chart-ready aggregates for the panel.
 *
 * The panel used to show bare counters; a number tells you the state now, a
 * series tells you whether things are getting better or worse. Every query
 * here is bounded and grouped in SQL so the browser receives points, not raw
 * rows it would have to bucket itself.
 */

const rows = (sql, ...a) => {
  try {
    return db.prepare(sql).all(...a);
  } catch {
    return [];
  }
};
const one = (sql, ...a) => {
  try {
    return db.prepare(sql).get(...a) || {};
  } catch {
    return {};
  }
};

/** Fill gaps so a quiet hour draws as zero instead of vanishing from the line. */
function densify(series, hours, key = 'hour') {
  const byKey = new Map(series.map((r) => [r[key], r]));
  const fields = Object.keys(series[0] || { c: 0 }).filter((x) => x !== key);
  const out = [];
  for (let i = hours - 1; i >= 0; i--) {
    // SQLite groups on UTC hour strings, so the bucket key is built the same
    // way; the label is that same hour shown in Tashkent time — labelling the
    // current minute instead made every point read "16:12".
    const d = new Date(Date.now() - i * 3600_000);
    const k = d.toISOString().slice(0, 13) + ':00';
    const hit = byKey.get(k) || {};
    out.push({
      t: k,
      label: new Date(k + ':00Z').toLocaleTimeString('uz-UZ', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }),
      ...Object.fromEntries(fields.map((x) => [x, hit[x] || 0])),
    });
  }
  return out;
}

/** Messages in and replies out, hour by hour. */
function traffic(hours = 24) {
  const series = rows(
    `SELECT strftime('%Y-%m-%dT%H:00', created_at) hour,
            SUM(CASE WHEN is_agent = 1 THEN 1 ELSE 0 END) replies,
            SUM(CASE WHEN is_outgoing = 0 THEN 1 ELSE 0 END) incoming
       FROM messages WHERE created_at > datetime('now', ?)
      GROUP BY hour ORDER BY hour`,
    `-${hours} hours`
  );
  return densify(series, hours);
}

/** AI calls and how long they took, hour by hour. */
function aiTimeline(hours = 24) {
  const series = rows(
    `SELECT strftime('%Y-%m-%dT%H:00', created_at) hour,
            COUNT(*) calls,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) failed,
            CAST(AVG(latency_ms) AS INTEGER) avgMs
       FROM ai_calls WHERE created_at > datetime('now', ?)
      GROUP BY hour ORDER BY hour`,
    `-${hours} hours`
  );
  return densify(series, hours);
}

/** Which providers actually carried the load, and at what cost. */
function providers(hours = 24) {
  return rows(
    `SELECT provider,
            COUNT(*) calls,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) ok,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) failed,
            CAST(AVG(latency_ms) AS INTEGER) avgMs,
            SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) tokens
       FROM ai_calls WHERE created_at > datetime('now', ?)
      GROUP BY provider ORDER BY calls DESC`,
    `-${hours} hours`
  );
}

/** Where the tokens go — which kind of work is expensive. */
const purposes = (hours = 24) =>
  rows(
    `SELECT purpose,
            COUNT(*) calls,
            SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) tokens,
            CAST(AVG(latency_ms) AS INTEGER) avgMs
       FROM ai_calls WHERE created_at > datetime('now', ?)
      GROUP BY purpose ORDER BY tokens DESC LIMIT 10`,
    `-${hours} hours`
  );

/** The busiest conversations. */
const topChats = (hours = 24, limit = 8) =>
  rows(
    `SELECT COALESCE(c.title, m.tg_chat_id) title, c.type,
            COUNT(*) messages,
            SUM(CASE WHEN m.is_agent = 1 THEN 1 ELSE 0 END) replies
       FROM messages m LEFT JOIN chats c ON c.tg_chat_id = m.tg_chat_id
      WHERE m.created_at > datetime('now', ?)
      GROUP BY m.tg_chat_id ORDER BY messages DESC LIMIT ?`,
    `-${hours} hours`,
    limit
  );

/** Knowledge base composition. */
const knowledgeBySource = () =>
  rows("SELECT source, COUNT(*) c FROM knowledge WHERE enabled = 1 GROUP BY source ORDER BY c DESC");

/** Headline numbers with a day-over-day comparison, so a card can show a trend. */
function summary() {
  const now = one(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE is_agent = 1 AND created_at > datetime('now','-24 hours')) replies,
       (SELECT COUNT(*) FROM messages WHERE is_outgoing = 0 AND created_at > datetime('now','-24 hours')) incoming,
       (SELECT COUNT(*) FROM ai_calls WHERE created_at > datetime('now','-24 hours')) calls,
       (SELECT COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)),0) FROM ai_calls WHERE created_at > datetime('now','-24 hours')) tokens,
       (SELECT CAST(AVG(latency_ms) AS INTEGER) FROM ai_calls WHERE ok = 1 AND created_at > datetime('now','-24 hours')) avgMs`
  );
  const prev = one(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE is_agent = 1 AND created_at BETWEEN datetime('now','-48 hours') AND datetime('now','-24 hours')) replies,
       (SELECT COUNT(*) FROM ai_calls WHERE created_at BETWEEN datetime('now','-48 hours') AND datetime('now','-24 hours')) calls,
       (SELECT COALESCE(SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)),0) FROM ai_calls WHERE created_at BETWEEN datetime('now','-48 hours') AND datetime('now','-24 hours')) tokens`
  );
  const pct = (a, b) => (!b ? null : Math.round(((a - b) / b) * 100));
  return {
    replies: now.replies || 0,
    incoming: now.incoming || 0,
    calls: now.calls || 0,
    tokens: now.tokens || 0,
    avgMs: now.avgMs || 0,
    trend: {
      replies: pct(now.replies || 0, prev.replies || 0),
      calls: pct(now.calls || 0, prev.calls || 0),
      tokens: pct(now.tokens || 0, prev.tokens || 0),
    },
  };
}

/** Recent failures, so a problem is visible without opening the log. */
const recentErrors = (limit = 8) =>
  rows(
    `SELECT created_at, provider, model, purpose, substr(error, 1, 160) error
       FROM ai_calls WHERE ok = 0 AND error IS NOT NULL
      ORDER BY id DESC LIMIT ?`,
    limit
  );

function all(hours = 24) {
  return {
    hours,
    summary: summary(),
    traffic: traffic(hours),
    ai: aiTimeline(hours),
    providers: providers(hours),
    purposes: purposes(hours),
    topChats: topChats(hours),
    knowledge: knowledgeBySource(),
    errors: recentErrors(),
  };
}

module.exports = { all, summary, traffic, aiTimeline, providers, purposes, topChats, knowledgeBySource, recentErrors };
