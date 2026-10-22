'use strict';
/**
 * Store funnel events, mirrored to Beacon.
 *
 * The store already writes every step to its own `solar_store_events` table.
 * That table is the record; this is a copy sent to the dashboard so the funnel
 * can be looked at next to everything else Beacon knows. If the two ever
 * disagree, the store's own table is right — Beacon is a view, not a ledger.
 *
 * <h2>Fire and forget, and that is the whole design</h2>
 * Nothing here is awaited by a request handler and nothing here can fail a
 * checkout. Beacon being down, slow, unreachable or misconfigured must cost
 * the buyer nothing: a dashboard is worth strictly less than a sale. Every
 * path swallows its error into a log line.
 *
 * <h2>What is not sent</h2>
 * No basket ident and no session id. An ident is a bearer capability for
 * somebody's basket — whoever holds it can read it, add to it and take it to
 * checkout — so it stays in the one database that needs it. The username is
 * enough to follow a funnel, and Beacon already stores usernames.
 *
 * <h2>What a checkout event means</h2>
 * That the buyer was handed to Tebex. Not that they paid. The store cannot
 * know whether money moved: the completion redirect is a URL the buyer can
 * type themselves, so treating it as a sale would let anyone inflate the
 * revenue figure by visiting a link. Real purchases reach Beacon from Tebex.
 */

const log = require('./log');

require('./env');

const URL_BASE = (process.env.BEACON_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.BEACON_INGEST_TOKEN || '';

/** Unconfigured is normal: no BEACON_URL means the mirror is simply off. */
function enabled() {
  return Boolean(URL_BASE);
}

/**
 * Posts one funnel event.
 *
 * <p>Returns immediately. The caller is a request handler on the hot path of a
 * purchase and must never wait on a dashboard.
 */
function event(name, session, extra = {}) {
  if (!enabled()) {
    return;
  }

  const body = JSON.stringify({
    event: name,
    username: session?.username ?? null,
    package_id: extra.packageId ?? null,
    quantity: extra.quantity ?? null,
  });

  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  /* A short timeout for the same reason: this runs while somebody is waiting
   * for a page, and a hung dashboard must not become a hung store. */
  const abort = AbortSignal.timeout(2000);

  fetch(`${URL_BASE}/api/events/store`, {
    method: 'POST', headers, body, signal: abort,
  })
    .then((res) => {
      if (!res.ok) {
        log.warn(`Beacon rejected ${name}: HTTP ${res.status}`);
      }
    })
    .catch((err) => {
      // Named, not silent — a mirror that quietly stopped working is worse
      // than one that never started, because the graph looks like a drop in
      // sales rather than a broken pipe.
      log.warn(`Beacon ${name} not delivered: ${err.message}`);
    });
}

module.exports = { event, enabled };
