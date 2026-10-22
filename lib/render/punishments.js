'use strict';
/**
 * The punishment log, rendered on the server, one page at a time.
 *
 * The browser is sent the rows it is looking at and nothing else — no record
 * list in JavaScript, no client-side table builder. Filters, the search and
 * paging are ordinary links and a form, so each view is a request the server
 * answers with the page for it.
 *
 * Everything interpolated here is player-supplied (names, reasons, staff
 * names) and goes through esc().
 */

const {
  esc, head, num, skinTag,
} = require('./html');
const chrome = require('./chrome');

const TYPES = [
  { id: 'ALL', label: 'All', colour: '#ffc23d' },
  { id: 'BAN', label: 'Bans', colour: '#e5484d' },
  { id: 'MUTE', label: 'Mutes', colour: '#f08c2c' },
  { id: 'KICK', label: 'Kicks', colour: '#3b82f6' },
  { id: 'WARN', label: 'Warnings', colour: '#c9a227' },
];

/* The page size belongs to the query, not to the view. Keeping a second
   copy here is how the label came to say 'Showing 1-10 of 37' on a page
   that was serving twenty rows. */
const { PER_PAGE } = require('../punishments');

const colourOf = (type) => (TYPES.find((t) => t.id === type) || {}).colour || '#737d93';

/** Every view of this page is a URL, so every control is a link to one. */
function href({ player, type, page, q, side }) {
  const p = new URLSearchParams();
  if (player) p.set('player', player);
  if (player && side === 'given') p.set('side', 'given');
  if (type && type !== 'ALL') p.set('type', type);
  if (q) p.set('q', q);
  if (page && page > 1) p.set('page', String(page));
  const qs = p.toString();
  return `/punishments${qs ? `?${qs}` : ''}`;
}

/* Counted by the server over the same search but before the type filter, so
   "Bans 12" still says 12 while you are reading the mutes. */
function chips(counts, state) {
  return TYPES.map((t) => {
    const on = t.id === state.type;
    return `<a class="chip${on ? ' on' : ''}" style="--c:${t.colour}"`
      + ` href="${esc(href({ ...state, type: t.id, page: 1 }))}"${on ? ' aria-current="true"' : ''}>`
      + `${t.label}<i>${num(counts[t.id])}</i></a>`;
  }).join('');
}

function rows(list, state) {
  if (!list.length) {
    return `<p class="bempty">${state.player && !state.q
      ? (state.side === 'given' ? 'They have not given any punishments in this category.'
        : 'No punishments found for this category.')
      : 'No punishments match that search.'}</p>`;
  }

  return list.map((p) => {
    /* Faded when it is no longer in force - whether it ran out or somebody
       lifted it. The expires text already names whoever did. */
    const gone = p.expires === 'Expired' || p.lifted;

    /* The name is a link to that player's own record. In a player's view the
       stylesheet drops this column, since every row would say the same name. */
    return `<div class="brow${gone ? ' gone' : ''}">`
      + `<a class="who link" href="${esc(href({ player: p.player }))}" title="View ${esc(p.player)}&#39;s punishments">`
      + `${head(p.player)}<span>${esc(p.player)}</span></a>`
      + `<span class="ptag" style="--c:${colourOf(p.type)}">${esc(p.type)}</span>`
      + `<span class="reason">${esc(p.reason)}</span>`
      + `<span class="who staff">${head(p.staff)}<span>${esc(p.staff)}</span></span>`
      + `<span class="date">${esc(p.date)}</span>`
      + `<span class="exp">${esc(p.expires || 'Never')}</span>`
      + '</div>';
  }).join('');
}

function foot(data, state) {
  const total = data.total || 0;
  if (!total) return '';

  const pages = data.pages || 1;
  const current = data.page || 1;
  const first = (current - 1) * PER_PAGE;

  let pager = '';
  if (pages > 1) {
    let start = Math.max(1, current - 2);
    const end = Math.min(pages, start + 4);
    if (end - start < 4) start = Math.max(1, end - 4);

    const link = (pg, label, aria) => `<a href="${esc(href({ ...state, page: pg }))}"${aria ? ` aria-label="${aria}"` : ''}>${label}</a>`;

    pager = '<nav class="pager" aria-label="Pages">'
      + (current > 1 ? link(current - 1, '‹', 'Previous page') : '<span class="off">‹</span>');
    for (let pg = start; pg <= end; pg++) {
      pager += pg === current ? `<span class="on" aria-current="page">${pg}</span>` : link(pg, pg);
    }
    pager += (current < pages ? link(current + 1, '›', 'Next page') : '<span class="off">›</span>')
      + '</nav>';
  }

  return '<div class="bfoot">'
    + `<span>Showing ${num(first + 1)}–${num(Math.min(first + PER_PAGE, total))} of ${num(total)}</span>`
    + pager + '</div>';
}

/** The "Got banned?" box, and the support box under it. */
function side(config) {
  const discord = chrome.discordUrl(config);
  const appeal = discord
    ? '<section class="box"><div class="box__h">Got banned?</div><div class="appeal">'
      + '<p>If you think a punishment was a mistake, appeal it in our Discord. Include your username and what happened.</p>'
      + `<a class="add" href="${esc(discord)}" target="_blank" rel="noopener noreferrer">`
      + `${chrome.discordIcon(20)}<span>Appeal in Discord</span></a></div></section>`
    : '';
  return `<aside class="side">${appeal}${chrome.support(config)}</aside>`;
}

const notice = (title, text) => '<section class="box notice">'
  + `<h2>${esc(title)}</h2><p>${esc(text)}</p></section>`;

/**
 * @param config  siteConfig()
 * @param data    one page from lib/punishments.list()
 * @param state   { player, type, page, q } — the view this URL asked for
 */
function page(config, data, state) {
  /* Unconfigured is a deployment state, not a failure. Saying so beats an
     empty table that reads as "nobody has ever been punished". */
  if (!data) {
    return `<div class="page layout"><div>${notice('Could not load punishments',
      'The punishment database did not answer. Try again shortly.')}</div>${side(config)}</div>`;
  }
  if (data.configured === false) {
    return `<div class="page layout"><div>${notice('Punishments are not connected',
      'Set PUNISHMENTS_DB_* to point this site at the SolarBans database.')}</div>${side(config)}</div>`;
  }

  const isPlayer = !!state.player;
  const counts = data.counts || {};
  const list = data.punishments || [];

  let top;
  if (isPlayer) {
    /* The account, not the string that was typed.
       Searching a name somebody has since abandoned resolves to whoever holds
       the record, so the card has to say whose history this is — otherwise it
       reads as the wrong player's. */
    const shown = (data.player && data.player.name) || state.player;
    const previous = (data.player && data.player.previous_names) || [];

    /* No badge for a clean account. A green CLEAN RECORD on a page listing
       what somebody was punished for reads as a verdict; the absence of a
       badge says the same thing more quietly. */
    let badge = '';
    if (data.player && data.player.banned) badge = '<span class="pbadge ban">BANNED</span>';
    else if (data.player && data.player.muted) badge = '<span class="pbadge mute">MUTED</span>';

    const received = data.player ? data.player.received : (counts.ALL || 0);
    const given = data.player ? data.player.given : 0;

    top = '<section class="box pcard">'
      + skinTag(shown, 'avatar', 128, 'face', '')
      + `<div><h2>${esc(shown)}</h2>`
      + `<div class="meta"><span>${num(received)} received</span>`
      + (given ? `<span>${num(given)} given</span>` : '')
      + `${badge}</div>`
      + (previous.length ? `<div class="aka">also known as ${previous.map(esc).join(', ')}</div>` : '')
      + '</div>'
      + `<a class="pback" href="${esc(chrome.url(config, 'site', `/stats?player=${encodeURIComponent(shown)}`))}">Stats</a>`
      + '<a class="pback" style="margin-left:0" href="/punishments">← All punishments</a>'
      + '</section>';
  } else {
    /* Counted across the whole record by the server, not over the page in
       front of you - "active bans" has to mean active bans on the network. */
    const s = data.stats || { activeBans: 0, activeMutes: 0, records: 0 };
    const stat = (n, label, colour) => `<div class="stat" style="--c:${colour}"><b>${num(n)}</b><span>${label}</span></div>`;
    top = '<div class="stats">'
      + stat(s.activeBans, 'Active bans', '#e5484d')
      + stat(s.activeMutes, 'Active mutes', '#f08c2c')
      + stat(s.records, 'Records', '#ffc23d')
      + '</div>';
  }

  /* A real <form>: searching is a navigation to a URL you can share and
     reload, not a keystroke handler rebuilding a table. Inside a player's
     record it searches that record. */
  /* A staff member's record in two: what they were punished for, and who
     they punished. Only shown to somebody who has given any. */
  const givenView = isPlayer && state.side === 'given';
  const givenCount = (data.player && data.player.given) || 0;
  const sides = isPlayer && (givenCount || givenView)
    ? '<div class="chips sides" role="group" aria-label="Whose punishments">'
      + [['received', 'Received', data.player ? data.player.received : 0, '#e5484d'],
        ['given', 'Given', givenCount, '#3b82f6']].map(([id, label, n, colour]) => {
        const on = (state.side || 'received') === id;
        return `<a class="chip${on ? ' on' : ''}" style="--c:${colour}"`
          + ` href="${esc(href({ player: state.player, side: id }))}"${on ? ' aria-current="true"' : ''}>`
          + `${label}<i>${num(n)}</i></a>`;
      }).join('')
      + '</div>'
    : '';

  const search = '<form class="bsearch" method="get" action="/punishments" role="search">'
    + (isPlayer ? `<input type="hidden" name="player" value="${esc(state.player)}">` : '')
    + (givenView ? '<input type="hidden" name="side" value="given">' : '')
    + (state.type && state.type !== 'ALL' ? `<input type="hidden" name="type" value="${esc(state.type)}">` : '')
    + '<button aria-label="Search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></button>'
    + `<input name="q" type="search" value="${esc(state.q || '')}" maxlength="32" autocomplete="off" spellcheck="false"`
    + ` placeholder="${isPlayer ? 'Search staff or reason' : 'Search player, staff or reason'}" aria-label="Search punishments">`
    + '</form>';

  return '<div class="page layout"><div>'
    + top
    + sides
    /* The player column comes back for what they gave: every row is somebody else. */
    + `<section class="box banbox${isPlayer && !givenView ? ' byplayer' : ''}">`
    + `<div class="btools"><div class="chips">${chips(counts, state)}</div>${search}</div>`
    + '<div class="bhead" aria-hidden="true"><span class="pcol">Player</span><span>Type</span><span>Reason</span><span>Staff</span><span>Date</span><span>Expires</span></div>'
    + `<div>${rows(list, state)}</div>`
    + foot(data, state)
    + '</section></div>'
    + side(config)
    + '</div>';
}

module.exports = { page, PER_PAGE };
