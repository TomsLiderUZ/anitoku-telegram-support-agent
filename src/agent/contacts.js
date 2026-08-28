'use strict';
const { db } = require('../core/db');
const { createLogger } = require('../core/logger');
const tg = require('../telegram/client');
const { normalize } = require('../knowledge/store');

const log = createLogger('contacts');

/**
 * Turn whatever the founder calls someone into a Telegram entity.
 *
 * Accepts: numeric id, -100… channel id, @username, t.me link, phone number,
 * a person's first/last name, or a group title. Names are matched against a
 * local cache first (fast, exact-ish), then against the live dialog list, so
 * "Ma'rufa" resolves without the founder ever typing an id.
 */

function upsert(entity) {
  if (!entity || !entity.id) return;
  const kind = entity.className === 'User' ? 'user' : entity.broadcast ? 'channel' : 'group';
  db.prepare(
    `INSERT INTO contacts (tg_id, kind, username, first_name, last_name, phone, title, access_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(tg_id) DO UPDATE SET
       kind = excluded.kind,
       username = COALESCE(excluded.username, contacts.username),
       first_name = COALESCE(excluded.first_name, contacts.first_name),
       last_name = COALESCE(excluded.last_name, contacts.last_name),
       phone = COALESCE(excluded.phone, contacts.phone),
       title = COALESCE(excluded.title, contacts.title),
       access_hash = COALESCE(excluded.access_hash, contacts.access_hash),
       updated_at = datetime('now')`
  ).run(
    String(entity.id),
    kind,
    entity.username || null,
    entity.firstName || null,
    entity.lastName || null,
    entity.phone || null,
    entity.title || null,
    entity.accessHash ? String(entity.accessHash) : null
  );
}

/** Refresh the cache from the dialog list. Cheap enough to run on connect. */
async function refreshFromDialogs(limit = 300) {
  if (!tg.isConnected()) return 0;
  let n = 0;
  try {
    for await (const d of tg.client.iterDialogs({ limit })) {
      if (d.entity) {
        upsert(d.entity);
        n++;
      }
    }
    log.info('kontaktlar yangilandi', { count: n });
  } catch (err) {
    log.warn('kontaktlarni yangilab boʻlmadi', { error: err.message });
  }
  return n;
}

function displayName(c) {
  if (!c) return '';
  return c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? '@' + c.username : c.tg_id);
}

/** Score a cached contact against a free-text reference. */
function score(c, ref) {
  const q = normalize(ref);
  if (!q) return 0;
  const fields = [c.username, c.first_name, c.last_name, c.title, c.aliases, [c.first_name, c.last_name].filter(Boolean).join(' ')]
    .filter(Boolean)
    .map((s) => normalize(s));

  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    if (f === q) best = Math.max(best, 100);
    else if (f.startsWith(q)) best = Math.max(best, 80);
    else if (f.includes(q)) best = Math.max(best, 60);
    else {
      // Token overlap for multi-word names.
      const ft = new Set(f.split(' '));
      const qt = q.split(' ').filter((t) => t.length > 1);
      const hits = qt.filter((t) => ft.has(t)).length;
      if (hits && hits === qt.length) best = Math.max(best, 70);
      else if (hits) best = Math.max(best, 30 * hits);
    }
  }
  return best;
}

function searchCache(ref, limit = 5) {
  const rows = db.prepare('SELECT * FROM contacts').all();
  return rows
    .map((c) => ({ ...c, score: score(c, ref) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Resolve a reference to `{ entity, contact, confidence }`.
 * Throws with a readable message when nothing matches or the match is ambiguous.
 */
async function resolve(ref) {
  const raw = String(ref || '').trim().replace(/^(kimga|to)\s*[:=]?\s*/i, '');
  if (!raw) throw new Error("kimga yozish kerakligi ko'rsatilmagan");

  // "Send it to me" → the account's own Saved Messages.
  if (/^(me|men|menga|o['‘’ʻ]?zim(ga)?|saved|saved messages|мне|себе)$/i.test(raw)) {
    const me = await tg.client.getMe();
    upsert(me);
    return { entity: me, contact: cachedById(me.id), confidence: 100 };
  }

  // Exact forms go straight to Telegram.
  const isId = /^-?\d{5,}$/.test(raw);
  const isExplicitHandle = /^@[a-zA-Z][\w]{3,}$/.test(raw);
  const isPhone = /^\+?\d[\d\s-]{7,}$/.test(raw);
  const isLink = /t\.me\//i.test(raw);

  if (isId || isExplicitHandle || isLink) {
    try {
      const entity = await tg.resolveEntity(raw);
      upsert(entity);
      return { entity, contact: cachedById(entity.id), confidence: 100 };
    } catch (err) {
      throw new Error(`"${raw}" topilmadi: ${err.message}`);
    }
  }

  // A bare word ("Marufa") is a person's name before it is a username: asking
  // Telegram first returned the public channel @marufa instead of the team
  // member Ma'rufabegim. People we actually talk to are checked first.
  const bareWord = /^[a-zA-Z][\w]{3,}$/.test(raw);
  if (bareWord) {
    const known = searchCache(raw, 3);
    const person = known.find((h) => h.kind === 'user' && h.score >= 60);
    if (person) {
      const entity = await tg.resolveEntity(person.tg_id);
      return { entity, contact: person, confidence: person.score, alternatives: known.filter((h) => h !== person).slice(0, 2) };
    }
    try {
      const entity = await tg.resolveEntity(raw);
      upsert(entity);
      return { entity, contact: cachedById(entity.id), confidence: 90 };
    } catch {
      /* not a username either — fall through to the fuzzy name search */
    }
  }

  if (isPhone) {
    const digits = raw.replace(/[^\d]/g, '');
    const hit = db.prepare("SELECT * FROM contacts WHERE replace(replace(phone,'+',''),' ','') LIKE ?").get('%' + digits.slice(-9));
    if (hit) return { entity: await tg.resolveEntity(hit.tg_id), contact: hit, confidence: 95 };
    // Phone not in cache — Telegram can look it up if the number is a contact.
    try {
      const { Api } = require('telegram');
      const res = await tg.client.invoke(new Api.contacts.ResolvePhone({ phone: digits }));
      const user = res.users && res.users[0];
      if (user) {
        upsert(user);
        return { entity: user, contact: cachedById(user.id), confidence: 90 };
      }
    } catch (err) {
      throw new Error(`Telefon raqam ${raw} boʻyicha odam topilmadi (${err.message})`);
    }
  }

  // Free-text name: cache first, then a live dialog scan.
  let hits = searchCache(raw);
  if (!hits.length || hits[0].score < 60) {
    await refreshFromDialogs(300);
    hits = searchCache(raw);
  }
  if (!hits.length) throw new Error(`"${raw}" nomli odam yoki guruh topilmadi`);

  // A plain first name means a person. When a channel called "@marufa" and a
  // user named "Ma'rufabegim" both match, the user is what was meant — unless
  // the founder explicitly typed the @handle or the channel is a far better hit.
  const personLike = !/^@/.test(raw) && !/\b(guruh|kanal|group|channel|chat)\b/i.test(raw);
  if (personLike) {
    const bestUser = hits.find((h) => h.kind === 'user');
    if (bestUser && bestUser.score >= hits[0].score - 25) {
      hits = [bestUser, ...hits.filter((h) => h !== bestUser)];
    }
  }

  const [top, second] = hits;
  if (second && second.score === top.score && top.score < 100 && second.kind === top.kind) {
    throw new Error(`"${raw}" bir nechta kishiga mos keladi: ${hits.slice(0, 3).map(displayName).join(', ')} — aniqroq ayting`);
  }
  const entity = await tg.resolveEntity(top.tg_id);
  return { entity, contact: top, confidence: top.score, alternatives: hits.slice(1, 3) };
}

const cachedById = (id) => db.prepare('SELECT * FROM contacts WHERE tg_id = ?').get(String(id)) || null;

/** Founder can teach a nickname: "Ma'rufani Marufa deb ham chaqiraman". */
function addAlias(tgId, alias) {
  const c = cachedById(tgId);
  if (!c) return false;
  const set = new Set(String(c.aliases || '').split(',').map((s) => s.trim()).filter(Boolean));
  set.add(String(alias).trim());
  db.prepare('UPDATE contacts SET aliases = ? WHERE tg_id = ?').run([...set].join(','), String(tgId));
  return true;
}

module.exports = { resolve, upsert, refreshFromDialogs, searchCache, displayName, addAlias, cachedById };
