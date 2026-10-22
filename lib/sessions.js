'use strict';
/**
 * Browser sessions, and the basket ident each one owns.
 *
 * The cookie holds an opaque 256-bit id and nothing else. Everything the store
 * knows about a visitor — which basket is theirs, which account they are buying
 * for — is looked up here by that id, server-side.
 */
const crypto = require('node:crypto');

const db = require('./db');

const COOKIE = 'solar_store';

const TTL_HOURS = Number(process.env.STORE_SESSION_HOURS || 24);
const SECURE = process.env.COOKIE_SECURE === 'true';

const open = () => db.open();

const newId = () => crypto.randomBytes(32).toString('base64url');

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, id) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: Tebex redirects the buyer back to us after checkout, and
    // Strict would withhold the cookie on that navigation — the buyer would
    // land on the completion page as a stranger with an empty basket.
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL_HOURS * 3600)}`,
  ];
  if (SECURE) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

/**
 * The caller's session, creating one if this is their first request.
 *
 * @return {{ id, basket_ident, username, uuid, edition, fresh }}
 */
async function of(req, res) {
  const now = Date.now();
  const existing = parseCookies(req)[COOKIE];

  if (existing) {
    const row = await open().prepare(
      'SELECT * FROM solar_store_sessions WHERE id = ?').get(existing);

    if (row && Number(row.expires_at) > now) {
      // Touch at most once a minute; every catalogue poll would otherwise be a
      // write, which is a lot of disk for a field nothing reads in real time.
      if (now - Number(row.last_seen) > 60_000) {
        await open().prepare(
          'UPDATE solar_store_sessions SET last_seen = ?, expires_at = ? WHERE id = ?')
          .run(now, now + TTL_HOURS * 3600_000, existing);
      }
      return { ...row, fresh: false };
    }

    if (row) {
      await open().prepare('DELETE FROM solar_store_sessions WHERE id = ?').run(existing);
    }
  }

  const id = newId();
  await open().prepare(
    `INSERT INTO solar_store_sessions(id, created_at, last_seen, expires_at)
     VALUES (?,?,?,?)`).run(id, now, now, now + TTL_HOURS * 3600_000);

  setCookie(res, id);

  // Opportunistic sweep. Cheap, indexed, and it means no cron job exists purely
  // to delete rows that describe browsers which closed days ago.
  await open().prepare('DELETE FROM solar_store_sessions WHERE expires_at < ?')
    .run(now).catch(() => {});

  return {
    id, basket_ident: null, username: null, uuid: null, edition: null, fresh: true,
  };
}

async function attachBasket(sessionId, ident) {
  await open().prepare(
    'UPDATE solar_store_sessions SET basket_ident = ? WHERE id = ?').run(ident, sessionId);
}

async function setAccount(sessionId, { username, uuid, edition }) {
  await open().prepare(
    `UPDATE solar_store_sessions SET username = ?, uuid = ?, edition = ? WHERE id = ?`)
    .run(username ?? null, uuid ?? null, edition ?? null, sessionId);
}

async function clearBasket(sessionId) {
  await open().prepare(
    'UPDATE solar_store_sessions SET basket_ident = NULL WHERE id = ?').run(sessionId);
}

module.exports = {
  of, attachBasket, setAccount, clearBasket, COOKIE, parseCookies, setCookie, newId, TTL_HOURS,
};
