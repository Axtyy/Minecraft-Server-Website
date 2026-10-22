'use strict';
/**
 * The Tebex Headless client. Server-side only.
 *
 * This is the *only* module that knows a token exists. Nothing it returns is
 * handed to a browser unfiltered — see `shape.js` — and nothing outside this
 * file constructs a Tebex URL, so there is exactly one place to audit when
 * asking "can a secret reach the client".
 *
 * Two credentials, and the difference matters:
 *
 *   TEBEX_PUBLIC_TOKEN  identifies the storefront. Tebex documents it as safe
 *                       to ship to a browser. We still keep it here, because a
 *                       token that never leaves the server cannot be lifted and
 *                       used to hammer our storefront's rate limit from
 *                       somewhere else.
 *
 *   TEBEX_SECRET_KEY    full account authority over the *classic* API — reading
 *                       real customer data, issuing refunds. It must never be
 *                       sent to a browser under any circumstance, and it is
 *                       used here for exactly one thing: HTTP Basic auth on
 *                       basket creation, which is what Tebex requires before it
 *                       will accept a customer's ip_address from a server.
 *
 *                       Without it the store still works — see createBasket —
 *                       but every basket is recorded against this machine's
 *                       address, so Tebex sees one French IP for every customer
 *                       in the world and its country detection, which drives
 *                       tax and currency, is wrong for all of them.
 */
require('./env');
const log = require('./log');

/**
 * Overridable so the store can be run against a stub.
 *
 * Without this there is no way to exercise the catalogue, basket and checkout
 * paths without a live storefront and real money — so they went untested, which
 * is how a page that returns 200 for every asset still fails to render.
 */
const HEADLESS = (process.env.TEBEX_API_BASE || 'https://headless.tebex.io/api')
  .replace(/\/+$/, '');

const PUBLIC_TOKEN = process.env.TEBEX_PUBLIC_TOKEN || '';
const SECRET_KEY = process.env.TEBEX_SECRET_KEY || '';

const TIMEOUT_MS = Number(process.env.TEBEX_TIMEOUT_MS || 8000);

const configured = () => Boolean(PUBLIC_TOKEN);

/**
 * An error the route layer can turn into a status code without leaking detail.
 *
 * `upstreamStatus` and `detail` are kept apart from the flattened `status`
 * because some upstream failures are not failures to the buyer at all — a
 * basket that has been paid for is the normal end of a purchase — and telling
 * those apart needs what Tebex actually said, not the 502 we show a browser.
 */
class TebexError extends Error {
  constructor(message, status, upstream, { upstreamStatus, detail } = {}) {
    super(message);
    this.name = 'TebexError';
    this.status = status;
    this.upstream = upstream;
    this.upstreamStatus = upstreamStatus ?? null;
    this.detail = detail ?? '';
  }
}

/**
 * Is this basket no longer usable — paid for, expired, or forgotten?
 *
 * <p>All three mean the same thing to the store: the ident we are holding is
 * spent, and the buyer needs a new basket rather than an error. Payment is the
 * common one, because a completed checkout leaves the session pointing at a
 * basket Tebex will refuse every further write to.
 */
const isBasketGone = (err) => Boolean(err instanceof TebexError
  && (err.status === 404
    || err.upstreamStatus === 404
    || err.upstreamStatus === 410
    || /already been paid|has been completed|basket is complete|expired/i.test(err.detail)));

/**
 * Has this basket already been paid for?
 *
 * <p>This, not the error above, is how a spent basket is actually recognised.
 * Tebex does not fail a request against a paid basket: reading one answers 200,
 * adding to one answers 200 and silently changes nothing, and the basket it
 * hands back still carries its packages AND a working checkout link. Only the
 * `complete` flag says what happened.
 *
 * <p>Which is why trusting the error path alone was not enough - the store
 * happily handed the browser a pay.tebex.io link for a basket that had been
 * paid for minutes earlier, and the first thing telling anybody something was
 * wrong was Tebex's own checkout page saying so.
 */
const isComplete = (basket) => Boolean(basket && basket.complete === true);

/**
 * Did Tebex reject our credentials, rather than the request itself?
 *
 * <p>Matched on the wording because Tebex answers a bad secret key with 422
 * "Invalid basic auth credentials" — the same status it uses for an ordinary
 * payload complaint, so the status alone cannot tell them apart. Verified
 * against the live API.
 */
const isBadCredentials = (err) => Boolean(err instanceof TebexError
  && (err.upstreamStatus === 401
    || err.upstreamStatus === 403
    || /basic auth credentials|unauthori[sz]ed|invalid.*credentials/i.test(err.detail)));

function base() {
  if (!configured()) {
    throw new TebexError('The store is not configured.', 503);
  }
  return `${HEADLESS}/accounts/${encodeURIComponent(PUBLIC_TOKEN)}`;
}

/**
 * Strips both credentials out of anything on its way to a log.
 *
 * The token is in the path of every request, so an upstream error message
 * carries it by default. Logs get shipped to a journal, tailed into a chat, and
 * pasted into an issue; "never expose a secret anywhere" has to include the
 * places we write ourselves, not only the ones a browser can reach.
 */
function redact(text) {
  if (!text) return text;
  let out = String(text);
  if (PUBLIC_TOKEN) out = out.split(PUBLIC_TOKEN).join('<public-token>');
  if (SECRET_KEY) out = out.split(SECRET_KEY).join('<secret-key>');
  return out;
}

/**
 * One call to Tebex.
 *
 * Upstream errors are deliberately not passed through verbatim. A 4xx body from
 * Tebex can name the account, the token prefix and internal package state; the
 * caller gets a status and a flat message, and the detail goes to our log.
 *
 * <p>Headless has two roots, and which one an endpoint lives under is not a
 * pattern you can guess:
 *
 *   /accounts/<token>/...   the catalogue, creating a basket, reading one back,
 *                           and the basket's auth links
 *   /baskets/<ident>/...    changing what is IN a basket
 *
 * Verified against the live API rather than assumed - adding a package under
 * the account root answers 404, and the identical call one level up succeeds.
 * `root` selects the second.
 */
async function call(method, path, { body, query, absolute, auth, root } = {}) {
  const url = new URL(absolute ? path : (root ? HEADLESS : base()) + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        /* Only where Tebex demands it, never on the catalogue. The header is
           built per request rather than held in a module constant so that
           nothing carries it by accident. */
        ...(auth && SECRET_KEY
          ? {
            Authorization: 'Basic '
              + Buffer.from(`${PUBLIC_TOKEN}:${SECRET_KEY}`).toString('base64'),
          }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new TebexError('The store timed out.', 504, `timeout after ${TIMEOUT_MS}ms`);
    }
    throw new TebexError('The store is unreachable.', 502, redact(err.message));
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    throw new TebexError(
      res.status === 404 ? 'Not found.' : 'The store rejected that request.',
      res.status === 404 ? 404 : 502,
      redact(`${method} ${url.pathname} -> ${res.status} ${text.slice(0, 300)}`),
      {
        upstreamStatus: res.status,
        // Tebex puts the human-readable reason in `detail`; it is kept so the
        // route layer can tell "this basket is spent" from "the store broke".
        detail: redact(String(parsed?.detail || parsed?.title || '')),
      },
    );
  }

  // Headless wraps most successful payloads in { data: ... }.
  return parsed && Object.prototype.hasOwnProperty.call(parsed, 'data')
    ? parsed.data
    : parsed;
}

/* ------------------------------------------------------------- catalogue -- */

const categories = () => call('GET', '/categories', { query: { includePackages: 1 } });

const packages = () => call('GET', '/packages');

/* ---------------------------------------------------------------- basket -- */

/**
 * Creates a basket.
 *
 * complete_url / cancel_url are where Tebex sends the buyer after checkout.
 * They must point back at us and are built from STORE_PUBLIC_URL, never from
 * the request's Host header — trusting that header lets anyone who can reach
 * the service mint a basket whose completion redirects wherever they like.
 */
/**
 * Opens a basket for one buyer.
 *
 * ip_address is sent ONLY when there is a secret key to authenticate it with.
 * Tebex rejects the whole request with 422 "Basic auth credentials are
 * required" if a server supplies a customer IP unauthenticated - not a warning,
 * not a dropped field, the basket is simply never created and the buyer gets an
 * error when they click add to cart.
 *
 * So the choice is made here rather than left to fail upstream: with a key, the
 * real buyer's address goes up under Basic auth and Tebex geolocates them
 * correctly for tax and currency. Without one, the field is dropped and Tebex
 * falls back to the address the request came from - this server - which works,
 * but makes every customer look French.
 */
async function createBasket({ username, uuid, completeUrl, cancelUrl, ip }) {
  const authenticated = Boolean(SECRET_KEY);

  const body = {
    username,
    ...(uuid ? { uuid } : {}),
    complete_url: completeUrl,
    cancel_url: cancelUrl,
    complete_auto_redirect: true,
  };

  if (!authenticated) {
    return call('POST', '/baskets', { body });
  }

  try {
    return await call('POST', '/baskets', {
      auth: true,
      body: { ...body, ...(ip ? { ip_address: ip } : {}) },
    });
  } catch (err) {
    /* A key that Tebex will not accept must not close the shop.
     *
     * The secret key is optional here - it buys correct tax and currency, not
     * the ability to sell - so a wrong one should cost exactly that and nothing
     * more. Without this fallback, one bad character in TEBEX_SECRET_KEY turns
     * every "add to cart" on the site into a 502, which is precisely what
     * happened when the literal word PASTE_HERE was pasted into it. */
    if (!isBadCredentials(err)) {
      throw err;
    }

    log.warn('Tebex rejected TEBEX_SECRET_KEY. Falling back to unauthenticated '
      + 'baskets: the store still sells, but Tebex will price and tax every '
      + 'order by this server\'s location instead of the buyer\'s. Check the key.');

    return call('POST', '/baskets', { body });
  }
}

const getBasket = (ident) => call('GET', `/baskets/${encodeURIComponent(ident)}`);

const addPackage = (ident, packageId, quantity = 1) =>
  call('POST', `/baskets/${encodeURIComponent(ident)}/packages`, {
    root: true,
    body: { package_id: Number(packageId), quantity: Number(quantity) },
  });

/* Removal is a POST to .../packages/remove carrying the id, not a DELETE on
   .../packages/<id> - that answers 405. */
const removePackage = (ident, packageId) =>
  call('POST', `/baskets/${encodeURIComponent(ident)}/packages/remove`, {
    root: true,
    body: { package_id: Number(packageId) },
  });

/**
 * Where the buyer must go to prove they own the Minecraft account.
 *
 * Tebex requires this before a Minecraft basket can be paid for, which is what
 * stops someone buying a rank onto an account they do not control.
 */
const basketAuth = (ident, returnUrl) =>
  call('GET', `/baskets/${encodeURIComponent(ident)}/auth`, { query: { returnUrl } });

module.exports = {
  TebexError,
  isBasketGone,
  isComplete,
  redact,
  configured,
  hasSecretKey: () => Boolean(SECRET_KEY),
  categories,
  packages,
  createBasket,
  getBasket,
  addPackage,
  removePackage,
  basketAuth,
};
