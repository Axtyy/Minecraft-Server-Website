'use strict';
/**
 * SolarWebsite — the site, and the only thing that talks to Tebex.
 *
 *   npm run init   apply db/schema.sql
 *   npm start      serve on http://localhost:3100
 *
 * Deployed on VPS 1 behind nginx or Caddy, which terminates TLS.
 *
 * The browser talks to this service and nothing else. It never holds a Tebex
 * token, and it never holds a basket ident — which is the part people usually
 * miss, because an ident is a bearer capability just as much as a token is.
 * See db/schema.sql and lib/shape.js.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

require('./lib/env');
const db = require('./lib/db');
const shape = require('./lib/shape');
const net = require('./lib/net');
const cache = require('./lib/cache');
const demo = require('./lib/demo/catalogue');
const content = require('./lib/content');
const beacon = require('./lib/beacon');
const { esc } = require('./lib/render/html');
const log = require('./lib/log');

/* DEMO_MODE=true runs the whole site with nothing behind it: Tebex, the
 * sessions table, the stats and punishment databases and the server ping are
 * all swapped for stand-ins in lib/demo/ with the same exports. Every route
 * below is the real one; only what it talks to changes. Checkout goes to
 * /demo/checkout, which takes no money. */
const DEMO = process.env.DEMO_MODE === 'true' || process.argv.includes('--demo');
const fakes = DEMO ? require('./lib/demo/data') : null;
const tebex = DEMO ? require('./lib/demo/tebex') : require('./lib/tebex');
const sessions = DEMO ? require('./lib/demo/sessions') : require('./lib/sessions');
const punishments = DEMO ? fakes.punishments : require('./lib/punishments');
const votes = DEMO ? fakes.votes : require('./lib/votes');
const stats = DEMO ? fakes.stats : require('./lib/stats');
const status = DEMO ? fakes.status : require('./lib/status');

/* Page rendering. The browser is sent finished markup, not data plus a
 * renderer — see lib/render/. */
const render = {
  vote: require('./lib/render/vote'),
  rules: require('./lib/render/rules'),
  store: require('./lib/render/store'),
  punishments: require('./lib/render/punishments'),
  chrome: require('./lib/render/chrome'),
  notfound: require('./lib/render/notfound'),
  purchase: require('./lib/render/purchase'),
  democheckout: require('./lib/render/democheckout'),
  stats: require('./lib/render/stats'),
};

const PORT = Number(process.env.PORT || 3100);
const ROOT = __dirname;

/* The built site, not the source. `npm run build` writes it; the Dockerfile
 * runs that in its own stage. Running `npm start` against a tree that was
 * never built is the one failure worth naming out loud, so boot() checks. */
const PUBLIC = path.join(ROOT, 'dist');

/**
 * Every URL that is a page, and the document that answers it.
 *
 * Each tab is its own document now. The old build served one index.html for
 * any extensionless path and let a client router decide which hidden div to
 * unhide — which is why /terms rendered the store: the router had no case
 * for it and fell through.
 *
 * Anything not on this list is a 404. That is the point of the list.
 */
const PAGES = new Map([
  ['/', 'index.html'],
  ['/vote', 'vote.html'],
  ['/stats', 'stats.html'],
  ['/rules', 'rules.html'],
  ['/punishments', 'punishments.html'],
  ['/purchase', 'purchase.html'],
  ['/terms', 'terms.html'],
  ['/privacy', 'privacy.html'],
]);

/**
 * /category/&lt;slug&gt; is the store page; the category is read in-page.
 *
 * /store and /store/&lt;slug&gt; are gone rather than redirected. The store has its
 * own hostname now, and leaving the old paths answering on the main site is
 * what made one page reachable at two addresses — a split in search results,
 * and a coin toss for anyone linking it.
 */
function pageFor(pathname) {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (PAGES.has(clean)) return PAGES.get(clean);
  if (/^\/category\/[\w-]+$/.test(clean)) return 'index.html';
  return null;
}

/**
 * Where Tebex sends the buyer back to.
 *
 * Built from configuration, never from the request's Host header. Trusting that
 * header would let anyone who can reach this service mint a basket whose
 * completion redirect points wherever they like.
 */
const PUBLIC_URL = (process.env.STORE_PUBLIC_URL || `http://localhost:${PORT}`)
  .replace(/\/+$/, '');

/**
 * Which hostname each half of the site belongs on.
 *
 * The store lives on one and everything else on the other, and one process
 * answers for both. Without this every store URL exists twice — which is why
 * example.net/ was still serving the store after /store was removed.
 *
 * The Host header decides only WHICH of two configured hostnames we are being
 * asked as. It is never used to build the target: that comes from the
 * environment, so a forged header can send a visitor to the real store and
 * nowhere else. Blank config disables all of it, which is what a
 * single-hostname install and local development both want.
 */
const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };

const STORE_HOST = hostOf(process.env.STORE_PUBLIC_URL || '');
const SITE_HOST = hostOf(process.env.SITE_PUBLIC_URL || '');
const SITE_URL = (process.env.SITE_PUBLIC_URL || '').replace(/\/+$/, '');

/* The stats page's own hostname, when it has one (STATS_PUBLIC_URL).
 *
 * There the stats page is the front page: stats.example.com/ is the
 * leaderboards and stats.example.com/?player=Name is a profile. /stats on the
 * other hostnames redirects to it, so the page has one address. Blank leaves
 * the stats at /stats on the main site, which is what local development and a
 * single-hostname install want. */
const STATS_URL = (process.env.STATS_PUBLIC_URL || '').replace(/\/+$/, '');
const STATS_HOST = hostOf(STATS_URL);
const isStatsPath = (pathname) => pathname === '/stats' || pathname === '/stats/';
const hostName = (req) => String(req.headers.host || '').toLowerCase().split(':')[0].replace(/^www\./, '');
const onStatsHost = (req) => Boolean(STATS_HOST) && hostName(req) === STATS_HOST.split(':')[0];

/** A store path: the front page and the category pages. */
const isStorePath = (pathname) => pathname === '/'
  || pathname === '/purchase' || pathname === '/purchase/'
  || /^\/category\/[\w-]+\/?$/.test(pathname);

/**
 * Where this request should have gone, or null if it is already there.
 *
 * 302 rather than 301 deliberately. A permanent redirect is cached by browsers
 * more or less forever, so getting the split wrong once would be very hard to
 * take back. Worth promoting to 301 once the arrangement has settled.
 */
function canonicalRedirect(req, pathname) {
  const raw = String(req.headers.host || '').toLowerCase().split(':')[0];

  /* The stats hostname first, because it is the one place where "/" does not
     mean the store. Its front page stays; the stats page asked for anywhere
     else is sent to it. */
  if (STATS_HOST) {
    if (onStatsHost(req)) {
      if (pathname === '/') return null;
      if (isStatsPath(pathname)) return STATS_URL + '/';
    } else if (isStatsPath(pathname)) {
      return STATS_URL + '/';
    }
  }
  if (!raw || !STORE_HOST || !SITE_HOST || STORE_HOST === SITE_HOST) {
    return null;
  }

  /* Documents only. A file belongs to whichever host asked for it.
   *
   * Every page references /assets/... and /build/... relatively, so on the
   * store those are requested from the store's hostname - and since a file is
   * not a store path, each one was answered with a 302 to the other hostname.
   * That is a full round trip to the origin before the browser may even ask
   * for the picture, it cannot be served from Cloudflare's edge because a
   * redirect carries no-store, and it lands cross-origin. An image that
   * sometimes does not appear is exactly what that looks like. */
  if (!pageFor(pathname)) {
    return null;
  }

  /* www is the same site by another name.
   *
   * Compared without it, so www.example.com is recognised as the site host
   * rather than falling through as unknown - which is what left www serving
   * the store directly, a third address for a page that should have one. */
  const host = raw.replace(/^www\./, '');
  const wasWww = host !== raw;

  const belongsOnStore = isStorePath(pathname);
  const target = belongsOnStore ? PUBLIC_URL : SITE_URL;
  const targetHost = belongsOnStore ? STORE_HOST : SITE_HOST;

  // Already in the right place, under the right name.
  if (host === targetHost && !wasWww) {
    return null;
  }

  // Somewhere we do not answer for; serve it rather than bouncing it about.
  // The stats hostname is ours: any other page asked for there goes home.
  if (host !== STORE_HOST && host !== SITE_HOST && !onStatsHost(req)) {
    return null;
  }

  return target + pathname;
}

/* ------------------------------------------------------------------ output */

/**
 * The CSP is the second half of "no secrets anywhere": even if a token did
 * reach the page, connect-src 'self' means the page cannot send it to a third
 * party, and script-src 'self' means an injected <script> cannot execute.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  /* Package art is served by Tebex's CDN; player heads and body renders by
   * the skin providers. These are <img> sources only — img-src cannot read
   * anything back, so the worst a bad one can do is fail to draw a head. */
  "img-src 'self' data: https://ebassets.tebexcdn.com https://*.tebex.io "
    + "https://minotar.net https://nmsr.nickac.dev https://mc-heads.net https://textures.minecraft.net",
  "connect-src 'self'",
  /* Checkout is Tebex's own hosted page. The other two are this site's own
   * hostnames: the player lookup in the header is a form, and on the store it
   * submits to /stats on the main site. Both come from configuration, so the
   * list cannot be widened by anything a request carries. */
  `form-action 'self' https://checkout.tebex.io${
    [PUBLIC_URL, SITE_URL, STATS_URL].filter((u) => /^https?:\/\//.test(u)).map((u) => ` ${new URL(u).origin}`).join('')}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function headers() {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
  };
  if (process.env.COOKIE_SECURE === 'true') {
    h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}

const acceptsGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

function json(req, res, status, data) {
  const raw = Buffer.from(JSON.stringify(data), 'utf8');
  const out = { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept-Encoding' };

  let body = raw;
  if (raw.length > 1400 && acceptsGzip(req)) {
    body = zlib.gzipSync(raw, { level: 6 });
    out['Content-Encoding'] = 'gzip';
  }
  out['Content-Length'] = body.length;

  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers(), ...out });
  res.end(body);
}

/* ----------------------------------------------------------- static assets */

const assets = new Map();

/**
 * The store-wide values the nav and footer are built from.
 *
 * Almost all of it is environment. The browser is never sent this object — the
 * nav and the footer are rendered from it here (lib/render/chrome.js), so
 * there is nothing for a page to fetch and nothing to keep in sync.
 *
 * The player count is the one live value, and it is read the same way: from
 * what this process already knows. status.current() never blocks — it hands
 * back the last ping and quietly starts the next one when that has gone stale
 * — so the count is at most one refresh window behind and costs the page
 * nothing. That is also why it is not an endpoint the browser polls: a header
 * that fetches its own contents is exactly what this file exists to avoid.
 */
function siteConfig() {
  return {
    name: process.env.STORE_NAME || 'Minecraft Store',
    ip: process.env.STORE_SERVER_IP || (DEMO ? 'play.example.net' : ''),
    legal: process.env.STORE_LEGAL || '',
    links: { social: parseLinks(process.env.STORE_LINKS_SOCIAL) },
    status: status.current(),

    /* The two homes, so the nav can point at the right one from either.
     *
     * The store and the rest of the site live on different hostnames now. A
     * relative /vote from the store would keep you on the store's domain, and a
     * relative / from the main site would land on a store that is no longer
     * served there. Both blank falls back to relative links, which is what a
     * single-hostname install wants. */
    siteUrl: (process.env.SITE_PUBLIC_URL || '').replace(/\/+$/, ''),
    storeUrl: (process.env.STORE_PUBLIC_URL || '').replace(/\/+$/, ''),
    statsUrl: STATS_URL,
  };
}

function asset(rel) {
  // Resolve and confine: a request path must not climb out of public/.
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep) && full !== PUBLIC) return null;

  let stat;
  try { stat = fs.statSync(full); } catch { return null; }
  if (!stat.isFile()) return null;

  const hit = assets.get(full);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;

  const buf = fs.readFileSync(full);

  const entry = {
    buf,
    type: contentType(full),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    etag: `"${crypto.createHash('sha1').update(buf).digest('base64url')}"`,
    gzip: buf.length > 1400 ? zlib.gzipSync(buf, { level: 6 }) : null,
  };
  assets.set(full, entry);
  return entry;
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.webp')) return 'image/webp';
  if (file.endsWith('.ico')) return 'image/x-icon';
  if (file.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

/* How long each kind of file may be held.
 *
 * `immutable` is only ever true for dist/build/*, whose filenames carry a
 * content hash, so those can be kept for a year and never revalidated.
 *
 * Pictures and fonts get a week. They used to be lumped in with everything
 * else as no-cache, which does not mean "do not store" but does mean "ask me
 * again every single time" - so roughly six megabytes of artwork made a
 * conditional request to the origin on every page view, and Cloudflare, which
 * honours that header, was forbidden from serving any of it from its edge. A
 * slow or dropped revalidation is an image that does not appear, which is
 * exactly the symptom. These filenames carry no hash, so changing a picture
 * without renaming it needs a Cloudflare purge to show up before the week is
 * out; stale-while-revalidate means the old one is served instantly while the
 * new one is fetched behind it rather than anybody waiting.
 *
 * Everything else stays no-cache: an HTML document that a browser holds for a
 * year is a site you cannot fix. */
const MEDIA = /^(image|font)\//;

function sendAsset(req, res, entry, immutable) {
  const cache = immutable
    ? 'public, max-age=31536000, immutable'
    : MEDIA.test(entry.type)
      ? 'public, max-age=604800, stale-while-revalidate=2592000'
      : 'no-cache';

  const out = {
    'Content-Type': entry.type,
    'Cache-Control': cache,
    ETag: entry.etag,
    Vary: 'Accept-Encoding',
    ...headers(),
  };
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, out);
    return res.end();
  }
  const gz = entry.gzip && acceptsGzip(req);
  const body = gz ? entry.gzip : entry.buf;
  if (gz) out['Content-Encoding'] = 'gzip';
  out['Content-Length'] = body.length;
  res.writeHead(200, out);
  return res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * The body of each page, built from what this process already has.
 *
 * Falls back to an empty slot rather than a 500: a catalogue outage should
 * cost you the shop, not the header, the footer and the rest of the site.
 */
async function renderPage(page, url, req, res) {
  const config = siteConfig();
  try {
    /* The only page that needs to know who is asking: the order it shows is
       the basket THIS browser paid for. Everything else here is public text or
       a public query, which is why the session is opened for this page alone
       rather than for every page. */
    if (page === 'purchase.html') {
      return render.purchase.page(config,
        (url.searchParams.get('status') || '').toLowerCase(),
        await paidOrder(req, res));
    }
    if (page === 'vote.html') {
      /* null when the vote database is unconfigured or down, which falls the
       * board back to content/vote.json. An empty array is different: it means
       * nobody has voted this month, and every place renders as unclaimed. */
      const board = await votes.topVotersOrNone(10);
      return render.vote.page(config, content.vote(), board);
    }
    if (page === 'stats.html') {
      /* The sidebar board is the same on both views, and cached with the
       * boards, so asking for it here costs nothing on a warm cache. */
      const top = await stats.leaderboard('playtime', 'lifetime', '');

      const player = (url.searchParams.get('player') || '').trim().slice(0, 17);
      if (player) {
        return render.stats.profile(config, player, await stats.profile(player), top);
      }

      /* Everything in the view is checked against a list before it is used:
       * the board and period against the two fixed sets, the gamemode against
       * the ones the database actually has. A hand-edited query string gets
       * the default board, never a query built from what it said. */
      const modes = await stats.modes();
      const asked = url.searchParams.get('mode') || '';
      const view = {
        board: stats.pick(stats.BOARDS, url.searchParams.get('board'), 'playtime').id,
        period: stats.pick(stats.PERIODS, url.searchParams.get('period'), 'lifetime').id,
        mode: (modes || []).includes(asked) ? asked : '',
      };
      const board = stats.pick(stats.BOARDS, view.board, 'playtime');
      if (!board.perMode) view.mode = '';
      /* A board that only exists as a lifetime figure is shown as one,
       * whatever period the link it was reached from was carrying. */
      if (!board.periods.includes(view.period)) view.period = 'lifetime';

      return render.stats.home(config, view, {
        totals: await stats.totals(),
        modes,
        rows: await stats.leaderboard(view.board, view.period, view.mode),
        top,
      });
    }
    if (page === 'rules.html') {
      return render.rules.rulesPage(config, content.rules());
    }
    if (page === 'terms.html' || page === 'privacy.html') {
      const which = page === 'privacy.html' ? 'privacy' : 'terms';
      return render.rules.legalPage(config, which, content.legal(which));
    }
    if (page === 'punishments.html') {
      const state = {
        player: (url.searchParams.get('player') || '').slice(0, 16) || null,
        type: (url.searchParams.get('type') || 'ALL').toUpperCase(),
        page: Math.max(1, Number(url.searchParams.get('page')) || 1),
        q: url.searchParams.get('q') || '',
        // Only a player's record has sides; anything but 'given' is what they received.
        side: url.searchParams.get('side') === 'given' ? 'given' : 'received',
      };
      if (!state.player) state.side = 'received';
      /* The list module validates the type and clamps the page, so a
       * hand-edited query string cannot ask for anything it should not. */
      const data = await punishments.list({
        page: state.page, type: state.type, q: state.q, player: state.player, side: state.side,
      });
      return render.punishments.page(config, data, state);
    }
    if (page === 'index.html') {
      const shown = tebex.configured()
        ? { categories: await catalogue() }
        : { categories: demo.CATEGORIES, demo: true };

      const slug = /^\/category\/([\w-]+)$/.exec(url.pathname);
      /* Who bought what lately, from Beacon. Cached like the catalogue: the strip
         is the same for every visitor and need not be asked for per request. */
      const recent = await cache.through('recent-purchases', 60_000,
        () => votes.recentPurchasesOrNone(80));
      return render.store.page(config, shown, slug ? slug[1] : '', recent, content.store());
    }
  } catch (err) {
    log.warn(`Render ${page}: ${err.message}`);
  }
  return '';
}

/**
 * The order this browser has just paid for, or null.
 *
 * <h2>Read from Tebex, cleared from the session</h2>
 * The basket ident comes from the session cookie and the contents come from
 * Tebex, so the page shows what was actually bought rather than anything the
 * browser claimed. `complete` is the flag that says it was paid for - a spent
 * basket still answers 200 and still lists its packages, so that flag is the
 * only honest test, the same one the checkout route learned to make.
 *
 * <p>The basket is detached from the session once it has been shown. It cannot
 * be added to or paid for again, and leaving it attached is what would make the
 * next visit to the store open with a cart that refuses everything.
 *
 * <p>Any failure here returns null rather than throwing: the payment has
 * already happened, and a store that is briefly unreachable must not turn the
 * buyer's receipt into a 500.
 */
async function paidOrder(req, res) {
  if (!req || !res || !tebex.configured()) return null;

  try {
    const session = await sessions.of(req, res);
    if (!session.basket_ident) return null;

    const basket = await tebex.getBasket(session.basket_ident).catch(() => null);

    if (!basket || !tebex.isComplete(basket)) return null;

    await sessions.clearBasket(session.id);
    return shape.basket(await withArt(basket));
  } catch (err) {
    log.warn(`Order page: ${err.message}`);
    return null;
  }
}

/**
 * A document with its body rendered in.
 *
 * Built per request, so no etag and no shared cache entry — these carry live
 * query results, and serving a stale one from memory would show yesterday's
 * list. Small enough (a few kB) that skipping the cache costs nothing worth
 * measuring.
 */
/**
 * A miss, as a page rather than a line of JSON.
 *
 * Anything not on the PAGES list lands here, which since the store moved to its
 * own hostname includes the old /store paths. A visitor following a stale link
 * should get somewhere to go, not {"error":"Not found."}.
 *
 * Falls back to JSON if the document is missing, so a tree that was never built
 * still answers rather than throwing inside the error path itself.
 */
function notFound(req, res) {
  const entry = asset('404.html');
  if (!entry) {
    return json(req, res, 404, { error: 'Not found.' });
  }
  return sendPage(req, res, entry, render.notfound.page(siteConfig()), 'notfound', 404);
}

function sendPage(req, res, entry, html, active, status = 200) {
  const config = siteConfig();

  /* Function replacements, not string ones. String.replace treats $&, $`, $'
     and $$ in a STRING replacement as patterns: a ban reason containing "$'"
     would splice the rest of the document back into the page. esc() does not
     save you either - it turns ' into &#39;, so "$'" becomes "$&#39;", which
     still starts with the $& pattern. A function replacement is substituted
     literally, so none of it is interpreted. */
  /* A page may open with <!--HEAD:{"title","description"}--> to title itself.
     A player's profile does: a link to it should preview as that player, not
     as the leaderboards. Both values are escaped here on the way in, so the
     renderer hands over plain text. */
  let shell = entry.buf.toString('utf8');
  const own = /^<!--HEAD:(\{.*?\})-->/.exec(html);
  if (own) {
    html = html.slice(own[0].length);
    try {
      const head = JSON.parse(own[1]);
      if (head.title) shell = shell.replace(/<title>.*?<\/title>/, () => `<title>${esc(head.title)}</title>`);
      if (head.description) {
        shell = shell.replace(/<meta name="description" content="[^"]*">/,
          () => `<meta name="description" content="${esc(head.description)}">`);
      }
    } catch { /* a malformed header costs the page its custom title, nothing else */ }
  }

  const doc = shell
    .replace('<!--NAV-->', () => render.chrome.nav(config, active))
    .replace('<!--FOOTER-->', () => render.chrome.footer(config))
    .replace('<!--PAGE-->', () => html)
    /* The network's name, once, from configuration. It used to be typed into
       the <title> and description of all six documents, which is how five of
       them were still saying "Solar" long after the name changed. */
    .replaceAll('<!--NAME-->', () => esc(config.name));

  /* The embed last, because it reads the finished document: the title it
     advertises is the one that was actually substituted, not the template. */
  /* The stats page is advertised at the address it actually lives at. */
  const statsHome = active === 'stats' && STATS_URL;
  const pathname = statsHome ? '/' : (req.url || '/').split('?')[0];
  const origin = statsHome ? STATS_URL
    : (isStorePath(pathname) ? PUBLIC_URL : SITE_URL) || PUBLIC_URL;
  const body = Buffer.from(
    doc.replace('<!--META-->',
      () => render.chrome.meta(config, doc, origin, pathname, status === 200)),
    'utf8');
  const out = {
    'Content-Type': entry.type,
    'Cache-Control': 'no-store',
    ...headers(),
  };

  const gz = acceptsGzip(req) ? zlib.gzipSync(body, { level: 6 }) : null;
  if (gz) out['Content-Encoding'] = 'gzip';
  out['Content-Length'] = (gz || body).length;

  res.writeHead(status, out);
  return res.end(req.method === 'HEAD' ? undefined : (gz || body));
}

/* ----------------------------------------------------------- rate limiting */

const BUCKETS = new Map();

function rateLimit(req, kind, max, windowMs) {
  const key = `${kind}:${net.clientIp(req)}`;
  const now = Date.now();
  const b = BUCKETS.get(key);
  if (!b || now >= b.reset) {
    BUCKETS.set(key, { count: 1, reset: now + windowMs });
    return 0;
  }
  b.count += 1;
  return b.count > max ? Math.ceil((b.reset - now) / 1000) : 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of BUCKETS) if (now >= v.reset) BUCKETS.delete(k);
}, 60_000).unref();

/* ------------------------------------------------------------------ bodies */

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Body is not JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Browsers always send Origin on a state-changing request, so a missing one is a
 * non-browser client. The cookie is SameSite=Lax, which already stops it riding
 * a cross-site POST; this closes the rest.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ events */

async function record(event, session, extra = {}) {
  // A demo has no database to write to, and nothing in it is worth auditing.
  if (DEMO) return;
  try {
    await db.open().prepare(
      `INSERT INTO solar_store_events(event, session_id, basket_ident, username,
                                      package_id, quantity, ip_prefix, occurred_at)
       VALUES (?,?,?,?,?,?,?,?)`)
      .run(event, session?.id ?? null, session?.basket_ident ?? null,
        session?.username ?? null, extra.packageId ?? null, extra.quantity ?? null,
        extra.ipPrefix ?? null, Date.now());
  } catch (err) {
    // An audit row is not worth failing a purchase over.
    log.warn(`Could not record ${event}: ${err.message}`);
  }

  /* Mirrored to the dashboard, outside the try: a Beacon that is down must not
   * look like a failure to write our own row, and neither is awaited. The row
   * above is the record; this is a copy for looking at. */
  beacon.event(event, session, extra);
}

/* ------------------------------------------------------------------ routes */

const USERNAME = /^[A-Za-z0-9_]{2,16}$/;
const BEDROCK = /^[A-Za-z0-9 _.-]{2,24}$/;

/**
 * Footer links, configured as `Label|https://url, Label|https://url`.
 *
 * Only http(s) and site-relative URLs survive. These come from the environment
 * rather than a browser, but a `javascript:` URL rendered into an anchor would
 * still run on click, and the cost of refusing one here is a regex.
 */
function parseLinks(raw) {
  if (!raw) return [];
  return String(raw).split(',')
    .map((pair) => {
      const [label, url] = pair.split('|').map((s) => (s || '').trim());
      return { label, url };
    })
    .filter((l) => l.label && /^(https?:\/\/|\/)/i.test(l.url))
    .slice(0, 8);
}

/** The shaped catalogue, cached, in the one place everything reads it from. */
function catalogue() {
  // Already in the shape the page wants, with the bonus and flag lines kept.
  if (DEMO) return Promise.resolve(demo.CATEGORIES);
  return cache.through('catalogue', Number(process.env.STORE_CACHE_MS || 60_000),
    async () => (await tebex.categories() || [])
      .map(shape.category)
      .filter(Boolean)
      .sort((a, b) => a.order - b.order));
}

/**
 * Gives every cart line a picture.
 *
 * <p>Tebex has no image for most packages, so the browser had nothing to draw
 * and fell back to the first letter of the name. The store page never showed
 * that because the server renderer quietly substitutes the category's artwork —
 * so the same product had art on the page and a grey initial in the cart.
 *
 * <p>Resolved on the server, from the cached catalogue, so both surfaces agree
 * and the browser is not made to learn the mapping a second time.
 */
async function withArt(basket) {
  if (!basket || !basket.packages || !basket.packages.length) {
    return basket;
  }

  const art = new Map();
  for (const category of await catalogue()) {
    for (const p of category.packages || []) {
      art.set(Number(p.id), p.image || render.store.artFor(category.slug));
    }
  }

  return {
    ...basket,
    packages: basket.packages.map((line) => ({
      ...line,
      image: line.image || art.get(Number(line.id)) || null,
    })),
  };
}

async function api(req, res, url, session) {
  const route = url.pathname;

  /**
   * Who you are signed in as, and the currency the cart formats in.
   *
   * This replaced /api/store/config, which returned the store name, IP,
   * legal line, social links, promo band and about text as well. Every one of
   * those is now rendered into the page by lib/render/, so serving them as
   * JSON was shipping the same values twice and inviting them to drift.
   *
   * These two are the only things the browser genuinely cannot be told at
   * render time: the account is per-session, and the cart formats prices for
   * a basket it fetches after the page has loaded.
   */
  if (route === '/api/store/session' && req.method === 'GET') {
    return json(req, res, 200, {
      currency: process.env.STORE_CURRENCY || null,
      account: session.username
        ? { username: session.username, edition: session.edition }
        : null,
    });
  }

  if (route === '/api/store/catalogue' && req.method === 'GET') {
    // No token means no storefront to ask. Serve the stand-in so the page is
    // still a page, and say plainly that it is one.
    if (!tebex.configured()) {
      return json(req, res, 200, { categories: demo.CATEGORIES, demo: true });
    }

    return json(req, res, 200, { categories: await catalogue() });
  }

  /* The buyer says who they are playing as. Nothing is trusted about this
   * beyond its shape — Tebex's own basket auth is what proves ownership before
   * money changes hands. */
  if (route === '/api/store/account' && req.method === 'POST') {
    const body = await readBody(req);
    const edition = body.edition === 'bedrock' ? 'bedrock' : 'java';
    const username = String(body.username || '').trim();

    const ok = edition === 'java' ? USERNAME.test(username) : BEDROCK.test(username);
    if (!ok) {
      return json(req, res, 400, {
        error: edition === 'java'
          ? 'That is not a valid Java username.'
          : 'That is not a valid Bedrock gamertag.',
      });
    }

    // Changing account invalidates the basket: Tebex ties a basket to the
    // account it was created for, and silently keeping the old one would
    // deliver the purchase to the previous name.
    if (session.basket_ident && session.username !== username) {
      await sessions.clearBasket(session.id);
      session.basket_ident = null;
    }

    await sessions.setAccount(session.id, { username, edition });
    return json(req, res, 200, { account: { username, edition } });
  }

  /* Signing out.
   *
   * Its own route rather than an empty username on the one above, which is
   * rejected as invalid — and a sign-out that 400s while the page clears its
   * own state would leave the account and its basket sitting on the server
   * looking, to the next visitor on this browser, like somebody else's.
   *
   * The basket goes with the name for the same reason it does on a change of
   * account: Tebex ties a basket to who it was made for.
   */
  if (route === '/api/store/account' && req.method === 'DELETE') {
    if (session.basket_ident) {
      await sessions.clearBasket(session.id);
      session.basket_ident = null;
    }
    await sessions.setAccount(session.id, { username: null, edition: null });
    return json(req, res, 200, { account: null, basket: null });
  }

  if (route === '/api/store/basket' && req.method === 'GET') {
    if (!session.basket_ident) return json(req, res, 200, { basket: null });
    try {
      const held = await tebex.getBasket(session.basket_ident);

      /* A basket that has been paid for still reads back in full — packages,
         totals and all — so without this check the cart shows the last order
         again as though it were unbought goods. */
      if (tebex.isComplete(held)) {
        await sessions.clearBasket(session.id);
        session.basket_ident = null;
        return json(req, res, 200, { basket: null });
      }

      return json(req, res, 200, { basket: await withArt(shape.basket(held)) });
    } catch (err) {
      // A basket Tebex has forgotten (paid, or expired) is not an error to the
      // buyer — they simply have an empty one now.
      if (tebex.isBasketGone(err)) {
        await sessions.clearBasket(session.id);
        session.basket_ident = null;
        return json(req, res, 200, { basket: null });
      }
      throw err;
    }
  }

  if (route === '/api/store/basket/packages' && req.method === 'POST') {
    const body = await readBody(req);
    const packageId = Number(body.package_id);
    const quantity = Math.min(100, Math.max(1, Number(body.quantity) || 1));

    if (!tebex.configured()) {
      return json(req, res, 503, {
        error: 'This is a preview catalogue — set TEBEX_PUBLIC_TOKEN to take orders.',
      });
    }
    if (!Number.isInteger(packageId) || packageId <= 0) {
      return json(req, res, 400, { error: 'Unknown package.' });
    }
    if (!session.username) {
      return json(req, res, 409, { error: 'Choose the account to deliver to first.', need: 'account' });
    }

    const openBasket = async () => {
      const created = await tebex.createBasket({
        username: session.username,
        completeUrl: `${PUBLIC_URL}/purchase?status=complete`,
        cancelUrl: `${PUBLIC_URL}/purchase?status=cancelled`,
        ip: net.clientIp(req),
      });
      if (!created?.ident) return null;

      await sessions.attachBasket(session.id, created.ident);
      session.basket_ident = created.ident;
      await record('basket_created', session, { ipPrefix: net.prefix(net.clientIp(req)) });
      return created.ident;
    };

    let ident = session.basket_ident || await openBasket();
    if (!ident) return json(req, res, 502, { error: 'The store could not open a basket.' });

    /* One retry, on a spent basket only.
     *
     * The session outlives the basket it points at. Paying for one is the
     * ordinary way that happens - Tebex refuses every write to a basket that
     * has been paid for, so the next thing added after a purchase failed with
     * "already been paid for" and the buyer saw a hard error while trying to
     * shop again. Expiry does the same thing more quietly.
     *
     * So a dead ident is not reported, it is replaced: open a new basket and
     * add the package to that instead. Deliberately once - if the second
     * basket is refused too, something is actually wrong and it should
     * surface. */
    const startOver = async () => {
      await sessions.clearBasket(session.id);
      session.basket_ident = null;
      return openBasket();
    };

    let basket;
    try {
      basket = await tebex.addPackage(ident, packageId, quantity);
    } catch (err) {
      if (!tebex.isBasketGone(err)) throw err;
      basket = null;
    }

    /* Paid baskets do not fail, they no-op.
     *
     * Adding to one answers 200 and returns it unchanged, so the buyer is told
     * the item went in when it did not, and checkout then sends them to Tebex
     * to be told the basket was already paid for. The returned basket is
     * checked rather than the error, because there is no error. */
    if (basket === null || tebex.isComplete(basket)) {
      ident = await startOver();
      if (!ident) return json(req, res, 502, { error: 'The store could not open a basket.' });
      basket = await tebex.addPackage(ident, packageId, quantity);
    }

    await record('package_added', session, { packageId, quantity });

    return json(req, res, 200, { basket: await withArt(shape.basket(basket)) });
  }

  const remove = route.match(/^\/api\/store\/basket\/packages\/(\d+)$/);
  if (remove && req.method === 'DELETE') {
    if (!session.basket_ident) return json(req, res, 200, { basket: null });

    try {
      const after = await tebex.removePackage(session.basket_ident, Number(remove[1]));

      if (tebex.isComplete(after)) {
        await sessions.clearBasket(session.id);
        session.basket_ident = null;
        return json(req, res, 200, { basket: null });
      }

      await record('package_removed', session, { packageId: Number(remove[1]) });
      return json(req, res, 200, { basket: await withArt(shape.basket(after)) });
    } catch (err) {
      // Removing something from a basket that is already gone is not a
      // failure: what they asked for is true.
      if (!tebex.isBasketGone(err)) throw err;

      await sessions.clearBasket(session.id);
      session.basket_ident = null;
      return json(req, res, 200, { basket: null });
    }
  }

  /**
   * Hands back the URL to send the buyer to.
   *
   * This is the one place a Tebex address legitimately reaches the browser, and
   * it has to: it is where they pay. It is a one-shot URL for this basket, not
   * a credential that can be used to read or modify it.
   */
  if (route === '/api/store/checkout' && req.method === 'POST') {
    if (!session.basket_ident) return json(req, res, 409, { error: 'Your basket is empty.' });

    let basket;
    try {
      basket = await tebex.getBasket(session.basket_ident);
    } catch (err) {
      // Checking out a basket that has already been paid for, or has expired,
      // is an empty basket rather than a broken store.
      if (!tebex.isBasketGone(err)) throw err;
      await sessions.clearBasket(session.id);
      session.basket_ident = null;
      return json(req, res, 409, { error: 'Your basket is empty.' });
    }

    /* The one that actually bit: a paid basket still carries its packages and
       still offers a checkout link, so this route happily handed the browser a
       pay.tebex.io URL for an order that was already paid, and Tebex's own
       page delivered the bad news. */
    if (tebex.isComplete(basket)) {
      await sessions.clearBasket(session.id);
      session.basket_ident = null;
      return json(req, res, 409, { error: 'Your basket is empty.' });
    }

    if (!basket?.packages?.length) return json(req, res, 409, { error: 'Your basket is empty.' });

    // Minecraft baskets must pass Tebex's own account check before payment;
    // that is what stops a rank being bought onto an account you do not own.
    if (Array.isArray(basket.links?.auth) && basket.links.auth.length) {
      await record('auth', session);
      return json(req, res, 200, { auth: basket.links.auth.map((a) => a.url).filter(Boolean) });
    }

    const url = basket.links?.checkout;
    if (!url) return json(req, res, 502, { error: 'The store did not return a checkout link.' });

    await record('checkout', session, { ipPrefix: net.prefix(net.clientIp(req)) });
    return json(req, res, 200, { checkout: url });
  }

  return json(req, res, 404, { error: 'Not found.' });
}

/* -------------------------------------------------------------------- demo */

/** A small urlencoded form body: the demo checkout's two buttons. */
function readForm(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2048) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(raw)));
    req.on('error', reject);
  });
}

/**
 * Tebex's checkout, played by this site. GET shows the basket; POST is Pay or
 * Cancel, and redirects where Tebex would. Only the basket in this browser's
 * own session can be settled, so a shared link cannot pay for someone else's.
 */
async function demoCheckout(req, res, url) {
  const session = await sessions.of(req, res);

  if (req.method === 'POST') {
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'Cross-origin request refused.' });
    const form = await readForm(req);
    const ident = form.get('basket');
    let next = `${PUBLIC_URL}/purchase?status=cancelled`;
    if (ident && ident === session.basket_ident && tebex.held(ident)) {
      next = tebex.settle(ident, form.get('action') === 'pay');
      if (form.get('action') === 'pay') log.info(`Demo: ${session.username} paid for ${ident}`);
    }
    res.writeHead(303, { Location: next, 'Cache-Control': 'no-store', ...headers() });
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(req, res, 405, { error: 'Method not allowed.' });
  }

  const ident = url.searchParams.get('basket') || '';
  const mine = ident && ident === session.basket_ident ? tebex.held(ident) : null;
  const basket = mine && !mine.complete ? await withArt(shape.basket(mine)) : null;
  const entry = asset('purchase.html');
  if (!entry) return notFound(req, res);
  return sendPage(req, res, entry, render.democheckout.page(siteConfig(), basket, ident), 'purchase');
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return json(req, res, 400, { error: 'Bad URL.' });
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      const write = req.method !== 'GET' && req.method !== 'HEAD';

      if (write && !sameOrigin(req)) {
        return json(req, res, 403, { error: 'Cross-origin request refused.' });
      }

      const wait = rateLimit(req, write ? 'write' : 'read', write ? 60 : 240, 60_000);
      if (wait) {
        return json(req, res, 429, { error: 'Too many requests.', retry_after_s: wait });
      }

      /* Answered before a session exists, and so before the database is
       * touched at all.
       *
       * Rules, voting and the legal pages are public text that belongs to
       * nobody. Creating a session row to serve them would mean the rules go
       * down whenever MariaDB does — and the rules are exactly what somebody
       * is reading when they have been punished and the store is the last
       * thing on their mind. */
      if (url.pathname === '/api/site/content' && req.method === 'GET') {
        return json(req, res, 200, {
          rules: content.rules(),
          vote: content.vote(),
          terms: content.legal('terms'),
          privacy: content.legal('privacy'),
        });
      }

      const session = await sessions.of(req, res);
      return await api(req, res, url, session);
    }

    /* Send the request to the hostname that owns it, before anything renders. */
    const canonical = canonicalRedirect(req, url.pathname);
    if (canonical) {
      res.writeHead(302, {
        Location: canonical + (url.search || ''),
        'Cache-Control': 'no-store',
        ...headers(),
      });
      return res.end();
    }

    if (DEMO && url.pathname === '/demo/checkout') {
      return await demoCheckout(req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(req, res, 405, { error: 'Method not allowed.' });
    }

    /* Short vote links: /1 .. /5 send you to the nth site on the vote page.
     *
     * These exist so vote.<domain>/1 is something a player can be told out loud
     * and type from memory. The destination comes from content/vote.json, so
     * the list on the page and the links behind these can never disagree - and
     * only an exact single digit within range matches, so nothing here is an
     * open redirect: the target is never taken from the request. */
    const voteLink = /^\/([1-9])$/.exec(url.pathname);
    if (voteLink) {
      const sites = (content.vote().sites || []);
      const site = sites[Number(voteLink[1]) - 1];
      if (site && site.url) {
        res.writeHead(302, { Location: site.url, 'Cache-Control': 'no-store', ...headers() });
        return res.end();
      }
      return json(req, res, 404, { error: 'Not found.' });
    }

    // A page URL gets its own document; anything else is a file or a 404.
    /* On the stats hostname the front page is the stats page. */
    const page = onStatsHost(req) && url.pathname === '/' ? 'stats.html' : pageFor(url.pathname);
    const rel = page || url.pathname.replace(/^\/+/, '');

    const entry = asset(rel);
    if (!entry) return notFound(req, res);

    /* Pages are rendered here, not in the browser. The server already holds
     * everything they need — env vars, the content files, the catalogue cache,
     * one page of punishments — so it sends the finished markup rather than
     * the data plus a script to build it. */
    if (page) {
      /* Which tab is lit. */
      const active = {
        'vote.html': 'vote',
        'stats.html': 'stats',
        'rules.html': 'rules',
        'punishments.html': 'punishments',
        'terms.html': 'terms',
        'privacy.html': 'privacy',
        'purchase.html': 'purchase',
      }[page] || 'store';
      return sendPage(req, res, entry, await renderPage(page, url, req, res), active);
    }

    return sendAsset(req, res, entry, rel.startsWith('build/'));
  } catch (err) {
    if (err instanceof tebex.TebexError) {
      // The upstream detail names the account and token prefix; it goes to the
      // log, and the caller gets the status and a flat message.
      log.warn(`Tebex: ${err.upstream || err.message}`);
      return json(req, res, err.status >= 500 ? 502 : err.status, { error: err.message });
    }
    if (err.status) return json(req, res, err.status, { error: err.message });

    const ref = crypto.randomBytes(4).toString('hex');
    log.error(`${req.method} ${url.pathname} → [${ref}] ${err.stack || err.message}`);
    return json(req, res, 500, { error: 'Internal error.', ref });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use.`);
    process.exit(1);
  }
  throw err;
});

/* Loopback unless told otherwise.
 *
 * Listening on every interface is the default in Node and the wrong default
 * here: behind Docker it is masked by a loopback-only port publish, but run
 * directly on a VPS it puts the store on the public internet. A reverse
 * proxy connects over loopback, so the safe value is also the usual one.
 *
 * Set STORE_BIND=0.0.0.0 to expose it deliberately. */
const BIND = process.env.STORE_BIND || '127.0.0.1';

server.listen(PORT, BIND, async () => {
  log.info(`SolarWebsite on http://localhost:${PORT}  (public: ${PUBLIC_URL})`);

  /* Said once, plainly. Without this the site answers every page with a 404
     and nothing explains why — the pages are simply not there yet. */
  if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
    log.warn('dist/ has no index.html — the site is not built. Run `npm run build` '
      + '(or `npm run dev` for the dev server on :5173).');
  }

  /* Primed here so the first visitor gets a count rather than a bare
     address. Not awaited: a server that is down must not hold up the boot. */
  if (status.configured()) {
    status.refresh().then((s) => log.info(s.ok
      ? `Status: ${s.players} online`
      : 'Status: the server did not answer the ping — the header will show the address without a count'));
  } else {
    log.info('Status: STORE_STATUS_HOST and STORE_SERVER_IP are both unset — no player count in the header');
  }

  if (DEMO) {
    log.info('DEMO_MODE: sample catalogue, stats and punishments; no database, '
      + 'no Tebex, and checkout takes no money');
    return;
  }

  log.info(tebex.configured()
    ? 'Tebex: Headless configured'
    : 'Tebex: TEBEX_PUBLIC_TOKEN is not set — no token: serving the preview catalogue');

  if (tebex.configured() && !tebex.hasSecretKey()) {
    log.warn('TEBEX_SECRET_KEY is not set. Baskets are created without the buyer\'s '
      + 'IP, because Tebex refuses one from a server unless the request is '
      + 'authenticated — so Tebex sees this machine\'s address for every '
      + 'customer, and its country detection drives tax and currency.');
  }

  const where = db.settings();
  try {
    const row = await db.open().prepare('SELECT COUNT(*) n FROM solar_store_sessions').get();
    log.info(`Sessions: ${row.n} · ${where.user}@${where.host}/${where.database}`);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') log.error('No schema. Run: npm run init');
    else log.error(`Database unreachable at ${where.host}:${where.port} (${err.code})`);
  }

  if (PUBLIC_URL.startsWith('http://') && !PUBLIC_URL.includes('localhost')) {
    log.warn(`STORE_PUBLIC_URL is not https. Set COOKIE_SECURE=true and serve `
      + 'behind TLS before taking real payments.');
  }
});

async function shutdown(signal) {
  log.info(`${signal} — shutting down`);
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

