'use strict';
/**
 * Browser sessions in memory, used when DEMO_MODE=true.
 *
 * The same exports and the same cookie as lib/sessions.js, minus the database.
 * A demo needs to run with nothing installed beside Node, and a session in a
 * demo is worth nothing after a restart.
 */
const real = require('../sessions');

const { COOKIE, parseCookies, setCookie, newId, TTL_HOURS } = real;

/* Bounded for the same reason as the demo baskets: anyone can mint sessions. */
const MAX_SESSIONS = 5000;
const rows = new Map();

async function of(req, res) {
  const now = Date.now();
  const existing = parseCookies(req)[COOKIE];
  const row = existing && rows.get(existing);

  if (row && row.expires_at > now) {
    row.expires_at = now + TTL_HOURS * 3600_000;
    return { ...row, fresh: false };
  }
  if (row) rows.delete(existing);

  if (rows.size >= MAX_SESSIONS) rows.delete(rows.keys().next().value);

  const id = newId();
  const fresh = {
    id, basket_ident: null, username: null, uuid: null, edition: null,
    expires_at: now + TTL_HOURS * 3600_000,
  };
  rows.set(id, fresh);
  setCookie(res, id);
  return { ...fresh, fresh: true };
}

function update(id, values) {
  const row = rows.get(id);
  if (row) Object.assign(row, values);
}

async function attachBasket(id, ident) {
  update(id, { basket_ident: ident });
}

async function setAccount(id, { username, uuid, edition }) {
  update(id, { username: username ?? null, uuid: uuid ?? null, edition: edition ?? null });
}

async function clearBasket(id) {
  update(id, { basket_ident: null });
}

module.exports = {
  of, attachBasket, setAccount, clearBasket, COOKIE, parseCookies, count: () => rows.size,
};
