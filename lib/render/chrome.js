'use strict';
/**
 * The nav, the banner and the footer — the parts of every page that are not
 * the page.
 *
 * The markup is the design in preview/store-server.tpl.html, and the classes
 * are styled by src/styles/store.css, which is generated from that same file.
 * What this adds is everything the preview only pretends to have: real links
 * across the two hostnames, the live player count, and the configured Discord.
 */

const fs = require('node:fs');
const path = require('node:path');

const { esc } = require('./html');

const IMG = '/assets/img';
/* STORE_LOGO when set; otherwise the server's own logo.webp, and the neutral
   logo.svg on an install that has not added one yet. */
const LOGO = process.env.STORE_LOGO
  || (fs.existsSync(path.join(__dirname, '..', '..', 'dist', 'assets', 'img', 'logo.webp'))
    ? `${IMG}/logo.webp` : `${IMG}/logo.svg`);

/* Which home each tab belongs to.
 *
 * The store is its own hostname and the rest of the site is another, so a tab
 * cannot just be a path: a relative /vote clicked on the store keeps you on the
 * store's domain, where /vote is not what anyone linked. 'site' and 'store' are
 * resolved against configuration at render time, and fall back to plain
 * relative links when neither is configured - which is what a single-hostname
 * install wants and what local development needs. */
const TABS = [
  { id: 'vote', label: 'Vote', href: '/vote', home: 'site' },
  { id: 'stats', label: 'Stats', href: '/stats', home: 'site' },
  { id: 'rules', label: 'Rules', href: '/rules', home: 'site' },
  { id: 'punishments', label: 'Bans', href: '/punishments', home: 'site' },
];
const STORE = { id: 'store', label: 'Store', href: '/', home: 'store' };

const DISCORD_PATH = 'M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.2.4c1.7.4 2.6 1 3.5 1.7a15.8 15.8 0 0 0-13.4 0c.9-.7 2-1.4 3.6-1.7L8.7 3a19.6 19.6 0 0 0-4.9 1.4C.7 9 0 13.5.3 17.9a19.8 19.8 0 0 0 6 3l.6-.8.9-1.4a12.8 12.8 0 0 1-2-.9l.5-.4a14.1 14.1 0 0 0 11.5 0l.5.4c-.6.4-1.3.7-2 .9.3.5.6 1 .9 1.4l.6.8a19.7 19.7 0 0 0 6-3c.4-5-1-9.5-3.5-13.5ZM8.5 15.3c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm7 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z';

const discordIcon = (size) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor"><path d="${DISCORD_PATH}"/></svg>`;

const SEARCH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

const trim = (url) => String(url || '').replace(/\/+$/, '');

/**
 * A path on one of the two homes, absolute when that home is configured.
 *
 * Every renderer links through this, so a link from the store to /stats and a
 * link from /stats back to the store are both right without either page
 * knowing which hostname it was served on.
 */
function url(config, home, path) {
  /* The stats page may have a hostname of its own, where it is the front
     page: /stats?player=X here is /?player=X there. Decided in this one place
     so nothing that links to the stats has to know which it is. */
  const stats = /^\/stats(?=$|\?)/.test(path);
  if (stats && trim(config.statsUrl)) {
    return `${trim(config.statsUrl)}/${path.slice('/stats'.length)}`;
  }

  const base = trim(home === 'store' ? config.storeUrl : config.siteUrl);
  if (!base) return path;
  return path === '/' ? `${base}/` : base + path;
}

const socialUrl = (links, label) => {
  const hit = (links || []).find((l) => String(l.label || '').trim().toLowerCase() === label);
  return (hit && hit.url) || '';
};

const discordUrl = (config) => socialUrl(config.links && config.links.social, 'discord');

/**
 * The address, with the player count beside it. Click copies.
 *
 * The address is carried in the attribute rather than read out of the button's
 * own text, so the label is free to be presentational.
 *
 * The count is deliberately quiet about what it does not know — see
 * lib/status.js. An address that has never once answered gets no count at all,
 * because "this process cannot reach it" and "it is down" are different facts
 * and only the second is about the server.
 */
function ipLine(config) {
  /* An empty cell rather than nothing: the banner is a three-column grid with
     the logo in the middle, and dropping a column would slide it sideways. */
  if (!config.ip) return '<span></span>';

  const st = config.status;
  const live = Boolean(st && st.configured && st.ever && st.ok);
  const count = live
    ? `<small><strong>${Number(st.players || 0).toLocaleString('en-US')}</strong> online</small>`
    : '';

  return `<button class="ipline" data-copy-ip="${esc(config.ip)}" aria-label="Copy the server address">`
    + `<span class="ipt"><b>${esc(config.ip.toUpperCase())}</b>${count}</span>`
    + '<span class="copy"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></span>'
    + '</button>';
}

/**
 * The header. One shape, every page.
 *
 * @param active  the page being shown: a tab id, or terms / privacy /
 *                purchase / notfound for the pages that have no tab
 */
function nav(config, active) {
  const tab = (t) => `<a href="${esc(url(config, t.home, t.href))}"`
    + `${t.id === active ? ' class="on" aria-current="page"' : ''}>${t.label}</a>`;

  return '<div class="topnav"><div class="wrap">'
    + TABS.map(tab).join('')
    /* Store sits in the row with the rest and lights up the same way. It keeps
       its class because a phone puts it first in the row - see store.css. */
    + `<a class="store${active === 'store' ? ' on' : ''}" href="${esc(url(config, 'store', '/'))}"`
    + `${active === 'store' ? ' aria-current="page"' : ''}>${STORE.label}</a>`
    + '<span class="sp"></span>'
    + '<button class="looksw" id="lookBtn" aria-label="Switch between night and day" title="Switch between night and day">'
    + '<svg class="i-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>'
    + '<svg class="i-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/></svg>'
    + '</button>'
    + '</div></div>'

    + '<header class="banner"><div class="stars" aria-hidden="true"></div>'
    + '<div class="wrap banner__in">'
    + ipLine(config)
    + `<a class="logo" href="${esc(url(config, 'store', '/'))}" aria-label="${esc(config.name)} store home">`
    + `<img draggable="false" src="${esc(LOGO)}" alt="${esc(config.name)}"></a>`
    /* A real form: looking somebody up is a navigation to a URL that can be
       shared and reloaded, and it works before any script has loaded. */
    + `<form class="search" method="get" action="${esc(url(config, 'site', '/stats'))}" role="search">`
    + SEARCH_ICON
    + '<input name="player" placeholder="Look up a player" aria-label="Look up a player&#39;s stats"'
    + ' maxlength="16" autocomplete="off" spellcheck="false" required pattern="[A-Za-z0-9_.*]{2,16}">'
    + '<button class="sgo" aria-label="Look up">→</button></form>'
    + '</div></header>';
}

function footer(config) {
  /* The second and third clauses are required of anyone selling for a
     Minecraft server: the first by Mojang's commercial guidelines, the other
     by Tebex. */
  return '<footer><div class="wrap foot">'
    + `<span>© ${esc(config.name)}${config.legal ? ` · ${esc(config.legal)}` : ''}`
    + ' · Not affiliated with Mojang or Microsoft · Payments processed by Tebex</span>'
    + '<nav>'
    + `<a href="${esc(url(config, 'site', '/terms'))}">Terms</a>`
    + `<a href="${esc(url(config, 'site', '/privacy'))}">Privacy</a>`
    + `<a href="${esc(url(config, 'site', '/rules'))}">Rules</a>`
    + '</nav></div></footer>'
    + '<div class="toast" id="toast" role="status"></div>';
}

/**
 * The "Support / Questions" box in every sidebar.
 *
 * Both rows go to the Discord, because that is where tickets are opened. With
 * no Discord configured there is nowhere for either to go, so the box is left
 * out rather than drawn with two buttons that do nothing.
 */
function support(config) {
  const discord = discordUrl(config);
  if (!discord) return '';

  const row = (colour, tint, icon, title, note, label) => '<div class="srow">'
    + `<span class="ic" style="background:${tint};color:${colour}">${icon}</span>`
    + `<div><b style="color:${colour}">${title}</b><small>${note}</small></div>`
    + `<a class="pillbtn" style="background:${tint};color:${colour}" href="${esc(discord)}"`
    + ` target="_blank" rel="noopener noreferrer">${label}</a></div>`;

  return '<section class="box"><div class="box__h">Support / Questions</div>'
    + row('#35b85a', 'rgba(53,184,90,.15)',
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z"/></svg>',
      'Support Ticket', 'Missing a purchase? We&#39;ll fix it', 'Create')
    + row('#8b95ff', 'rgba(88,101,242,.18)', discordIcon(22),
      'Discord Server', 'Chat with the community', 'Join')
    + '</section>';
}

/* The card. 1200x630 is what every scraper crops to, so it is what is stored:
   anything else gets cut somewhere nobody chose. Kept as a PNG rather than the
   WebP everything else uses - several scrapers still refuse WebP, and an embed
   that silently loses its picture is the whole thing this exists to fix. */
/* The ?v= is there because the picture is cached by its address - by
   Cloudflare and by every chat app that has ever shown it. Bump it when the
   picture changes, or the old one keeps turning up. */
const OG_IMAGE = '/assets/img/og.png?v=2';

/**
 * What a link to this page turns into when somebody pastes it.
 *
 * Discord, Twitter, Slack and iMessage all read these tags and nothing else —
 * no tags at all is why a pasted example.net came out as a bare URL with
 * whatever text the scraper happened to scrape. The title and description are
 * lifted from the document rather than written twice, so a page that changes
 * its own <title> changes its embed with it.
 *
 * Nothing taken out of the document is escaped again on the way through. It
 * came from HTML that has already been through esc() — <!--NAME--> is
 * substituted escaped — so a second pass would put &amp;amp; in the embed.
 * Values that come from config have not been escaped yet and are, at the point
 * they are used.
 */
function meta(config, doc, origin, pathname, canonical) {
  const pick = (re, fallback) => {
    const hit = doc.match(re);
    return hit ? hit[1].trim() : fallback;
  };

  const title = pick(/<title>([^<]*)<\/title>/i, esc(config.name));
  const described = pick(/<meta name="description" content="([^"]*)"/i, '');

  /* What the page is first, then the address. A preview shows about two
     lines, and "Play at ..." at the front spent the first of them saying the
     same thing on every page. The address still goes in the text as well as in
     the picture: the text is what a screen reader reads out and what shows
     when a client declines to load images at all. */
  const description = config.ip
    ? `${described ? `${described} ` : ''}Join at ${esc(config.ip)}`
    : described;

  const link = origin ? origin + pathname : '';
  const image = origin ? origin + OG_IMAGE : OG_IMAGE;

  const tag = (property, content) => (content
    ? `<meta property="${property}" content="${content}">` : '');
  const named = (key, content) => (content
    ? `<meta name="${key}" content="${content}">` : '');

  return [
    tag('og:site_name', esc(config.name)),
    tag('og:type', 'website'),
    tag('og:title', title),
    tag('og:description', description),
    tag('og:url', esc(link)),
    tag('og:image', esc(image)),
    /* Given explicitly so the card renders at full width on first paint.
       Without them a scraper has to fetch the image before it knows the shape,
       and several fall back to the small square layout rather than wait. */
    tag('og:image:width', '1200'),
    tag('og:image:height', '630'),
    tag('og:image:alt', esc(config.ip ? `${config.name} - ${config.ip}` : config.name)),
    named('twitter:card', 'summary_large_image'),
    named('twitter:title', title),
    named('twitter:description', description),
    named('twitter:image', esc(image)),
    // Not on a 404: pointing a missing page at itself as canonical invites
    // the index to keep it.
    canonical && link ? `<link rel="canonical" href="${esc(link)}">` : '',
  ].join('');
}

module.exports = {
  nav, footer, meta, support, url, discordUrl, discordIcon, SEARCH_ICON,
};
