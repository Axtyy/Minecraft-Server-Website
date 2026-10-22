'use strict';
/**
 * The stats page: leaderboards, and one player's profile.
 *
 * Both are rendered here from lib/stats.js. Every control - the gamemode, the
 * period, the board, a name on the podium - is a link, so each view has an
 * address that can be shared, reloaded and gone back to, and the page works
 * before any script has loaded.
 *
 * Player names come out of a database of whatever people called themselves and
 * go through esc() like everything else.
 */

const {
  esc, head, num, ago, skinTag,
} = require('./html');
const chrome = require('./chrome');
const { PERIODS, BOARDS, pick } = require('../stats');

const IMG = '/assets/img';

/** Seconds as the length of time a person would say: 35m, 4.5h, 1,280h. */
function hours(seconds) {
  const s = Number(seconds) || 0;
  if (s < 3600) return `${Math.max(0, Math.round(s / 60))}m`;
  const h = s / 3600;
  return h < 10 ? `${h.toFixed(1)}h` : `${num(Math.round(h))}h`;
}

const date = (ms) => (ms ? new Date(Number(ms)).toISOString().slice(0, 10) : 'Unknown');

/* "survival" in the database, "Survival" on the page. */
const title = (mode) => String(mode || '').replace(/[_-]+/g, ' ').replace(/(^|\s)\S/g, (c) => c.toUpperCase());

function format(board, value) {
  if (board === 'playtime') return hours(value);
  if (board === 'kdr') return Number(value).toFixed(2);
  /* A bare number: the column it sits in is headed with what it counts. */
  return num(Math.floor(value));
}

/* Where the links on this page point.
 *
 * The stats page may live on a hostname of its own, and the ban list always
 * lives on the main site, so neither can be a bare path. The configuration is
 * taken once at the top of each render - home() and profile() - rather than
 * threaded through every helper below; rendering is synchronous, so nothing
 * else can run between it being set and being read. */
let site = {};
const statsUrl = (query) => chrome.url(site, 'site', `/stats${query || ''}`);

function href(view) {
  const p = new URLSearchParams();
  if (view.board && view.board !== 'playtime') p.set('board', view.board);
  if (view.period && view.period !== 'lifetime') p.set('period', view.period);
  if (view.mode) p.set('mode', view.mode);
  const qs = p.toString();
  return statsUrl(qs ? `?${qs}` : '');
}

const playerHref = (name) => statsUrl(`?player=${encodeURIComponent(name)}`);

const notice = (heading, text) => `<section class="box notice"><h2>${esc(heading)}</h2><p>${esc(text)}</p></section>`;

/* ------------------------------------------------------------- the boards */

function searchBox(config) {
  return '<section class="box sh-card"><div class="box__h">Search Player</div><div class="sh-in">'
    + `<img draggable="false" src="${IMG}/steve-body.png" alt="" class="sh-art">`
    + `<div><p>Kills, playtime, gems and history for every player on ${esc(config.name)}. Enter a username.</p>`
    + `<form class="sform" method="get" action="${esc(statsUrl())}" role="search">`
    + '<input name="player" placeholder="Enter username" maxlength="16" autocomplete="off" spellcheck="false"'
    + ' aria-label="Username" required pattern="[A-Za-z0-9_.*]{2,16}">'
    + '<button class="add">Search</button></form></div></div></section>';
}

function totalsBox(config, totals) {
  const st = config.status;
  const live = Boolean(st && st.configured && st.ever && st.ok);

  /* A dash, not a zero, for anything that could not be read. Zero players
     joined is a statement about the server; a dash is a statement about the
     page. */
  const cell = (value, label) => `<div><b>${value}</b><small>${label}</small></div>`;
  const hoursPlayed = totals ? Math.round(totals.seconds / 3600) : null;

  return '<section class="box sh-card"><div class="box__h">Server Totals</div><div class="totals">'
    + cell(totals ? num(totals.players) : '–', 'Players joined')
    + cell(live ? num(st.players) : '–', 'Online now')
    + cell(hoursPlayed === null ? '–' : (hoursPlayed >= 10_000 ? `${Math.round(hoursPlayed / 1000)}k` : num(hoursPlayed)), 'Hours played')
    + cell(totals ? num(totals.votes) : '–', 'Votes cast')
    + '</div></section>';
}

/* A table in three columns - rank, player, amount - first place at the top.
   The top three get a medal-coloured badge; nobody is lifted out of the order
   onto a pedestal. Each row is a link to that player. */
function table(rows, board) {
  return '<div class="ltab" role="table">'
    + '<div class="lhead" role="row"><span role="columnheader">Rank</span><span role="columnheader">Player</span>'
    + `<span role="columnheader">${esc(board.label)}</span></div>`
    + rows.map((r, i) => `<a class="lrow" role="row" href="${esc(playerHref(r.name))}">`
      + `<span class="lrank${i < 3 ? ` r${i + 1}` : ''}" role="cell">${i + 1}</span>`
      + `<span class="who" role="cell">${head(r.name, r.uuid)}<span>${esc(r.name)}</span></span>`
      + `<b class="lamt" role="cell">${esc(format(board.id, r.value))}</b></a>`).join('')
    + '</div>';
}

function boards(view, modes, rows) {
  const board = pick(BOARDS, view.board, 'playtime');
  const period = pick(PERIODS, view.period, 'lifetime');

  const seg = (list, key, current, small) => `<div class="seg${small ? ' seg--sm' : ''}" role="group">`
    + list.map(([id, label]) => `<a href="${esc(href({ ...view, [key]: id }))}"`
      + `${id === current ? ' class="on" aria-current="true"' : ''}>${esc(label)}</a>`).join('')
    + '</div>';

  /* The gamemode switch only where it means something: a vote is cast for the
     network, so the votes board has no modes to pick from. */
  const modeSeg = board.perMode && modes && modes.length > 1
    ? seg([['', 'All'], ...modes.map((m) => [m, title(m)])], 'mode', view.mode || '', false)
    : '';

  let body;
  if (rows === null) {
    body = '<p class="bempty">This leaderboard is unavailable right now. Try again shortly.</p>';
  } else if (!rows.length) {
    body = '<p class="bempty">Nobody is on this board yet.</p>';
  } else {
    body = table(rows, board);
  }

  /* One row: which board on the left, which period on the right. The gamemode
     switch gets a row of its own above it, and only when there is more than
     one gamemode to switch between. */
  return '<section class="box lbox2">'
    + (modeSeg ? `<div class="lb-tools lb-modes">${modeSeg}</div>` : '')
    + '<div class="lb-tools">'
    + '<div class="lb-boards" role="group" aria-label="Leaderboard">'
    + BOARDS.map((b) => `<a href="${esc(href({ ...view, board: b.id, mode: b.perMode ? view.mode : '' }))}"`
      + `${b.id === board.id ? ' class="on" aria-current="true"' : ''}>${esc(b.label)}</a>`).join('')
    + '</div>'
    /* Only the windows this board exists for. A killstreak is what it is
       today, so that board offers Lifetime and nothing else. */
    + seg(PERIODS.filter((p) => board.periods.includes(p.id)).map((p) => [p.id, p.label]), 'period', period.id, true)
    + '</div>'
    + body
    + '</section>';
}

function topPlayers(top) {
  if (!top || !top.length) return '';
  return '<section class="box"><div class="box__h">Top Playtime</div><ol class="voters">'
    + top.slice(0, 5).map((p, i) => `<li><a href="${esc(playerHref(p.name))}">`
      + `<span class="rank r${i + 1}">${i + 1}</span>${head(p.name, p.uuid)}`
      + `<b>${esc(p.name)}</b><em class="lvl">${esc(hours(p.value))}</em></a></li>`).join('')
    + '</ol></section>';
}

/**
 * @param config  siteConfig()
 * @param view    { board, period, mode } as the URL asked for them
 * @param data    { totals, modes, rows, top } from lib/stats.js; any of them
 *                null when the database could not be asked
 */
function home(config, view, data) {
  site = config;
  return '<div class="page layout"><div>'
    + `<div class="shome">${searchBox(config)}${totalsBox(config, data.totals)}</div>`
    + '<div class="sec-h"><h2>Leaderboards</h2><p>Updated every few minutes</p></div>'
    + boards(view, data.modes, data.rows)
    + '</div><aside class="side">'
    + topPlayers(data.top)
    + chrome.support(config)
    + '</aside></div>';
}

/* ------------------------------------------------------------ one player */

/* The colour a rank's badge wears. Staff in the reds and greens the game
   uses for them, the bought ranks in gold and its neighbours. Anything not
   listed still gets a badge, in a plain colour. */
const RANK_COLOURS = {
  owner: '#e5484d', admin: '#e5484d', moderator: '#f08c2c', helper: '#35b85a', media: '#a78bfa',
  emperor: '#ffc23d', king: '#48b8f5', royal: '#c084fc', guardian: '#4ade80',
};

/**
 * One player: who they are down the left, what they have done on the right.
 *
 * The left card is the answer to "is this the person I think it is" - face,
 * name, rank, when they were last on. Everything countable is on the right,
 * under the gamemode it was counted on.
 */
function profileBody(config, p) {
  const g = p.game;
  const name = (g && g.name) || p.name;
  const mode = p.modes[0];

  const status = p.online
    ? `<span class="online"><i class="ldot"></i>Online now · ${esc(title(p.online))}</span>`
    : `<span class="pseen">Last online: ${esc(p.lastSeen ? ago(p.lastSeen) : 'unknown')}</span>`;

  const row = (label, value) => `<div class="prow"><span>${label}</span><b>${value}</b></div>`;
  const rankBadge = (rank) => `<b class="rbadge" style="--c:${RANK_COLOURS[rank.toLowerCase()] || '#737d93'}">`
    + `${esc(title(rank))}</b>`;
  /* Staff with a bought rank wear both, so the bought one is plainly theirs. */
  const badge = p.group
    ? (p.donor ? `<span class="rbadges">${rankBadge(p.group)}${rankBadge(p.donor)}</span>` : rankBadge(p.group))
    : '<b>Player</b>';

  const side = '<aside class="pside"><section class="box pinfo2">'
    + '<div class="phead">'
    + skinTag(name, 'avatar', 128, 'pface', '', p.uuid)
    + `<div><small class="pk">Profile</small><h2>${esc(name)}</h2>${status}</div></div>`
    + '<div class="prows">'
    + `<div class="prow"><span>Rank</span>${badge}</div>`
    + row('Joined', esc(date(p.firstJoin)))
    + row('Playtime rank', p.rank ? `#${num(p.rank)}` : '–')
    + row('Votes', num(p.votes))
    + '</div>'
    + '<div class="prof-acts">'
    + `<a class="btn-g" href="${esc(chrome.url(site, 'site', `/punishments?player=${encodeURIComponent(name)}`))}">Punishments</a>`
    + `<a class="btn-g" href="${esc(statsUrl())}">← Leaderboards</a></div>`
    + '</section>'
    + '<section class="box"><div class="box__h">Look up another</div>'
    + `<form class="sform psearch" method="get" action="${esc(statsUrl())}" role="search">`
    + '<input name="player" placeholder="Enter username" maxlength="16" autocomplete="off" spellcheck="false"'
    + ' aria-label="Username" required pattern="[A-Za-z0-9_.*]{2,16}">'
    + '<button class="add">Search</button></form></section>'
    + chrome.support(config)
    + '</aside>';

  const stat = (label, value) => `<div class="kpi"><small>${label}</small><b>${value}</b></div>`;
  const dash = '–';

  /* The gamemode's own tile, then its numbers. A player who has joined the
     network but never this gamemode gets the tile and a line saying so, not a
     grid of zeros. */
  const main = '<div class="pmain">'
    + '<section class="mtile">'
    + `<img draggable="false" src="${IMG}/sky/prop-block.webp" alt="">`
    + `<div><b>${esc(mode ? title(mode.name) : 'Survival')}</b>`
    + `<small>${p.seconds > 0 ? `${esc(hours(p.seconds))} played${p.days ? ` over ${num(p.days)} ${p.days === 1 ? 'day' : 'days'}` : ''}` : 'No time played yet'}</small></div>`
    + skinTag(name, 'body', 260, 'mbody', '', p.uuid)
    + '</section>'
    + (mode || g
      ? '<div class="kpis">'
        + stat('Playtime', esc(hours(p.seconds)))
        + stat('Kills', g ? num(g.kills) : dash)
        + stat('Deaths', g ? num(g.deaths) : dash)
        + stat('K/D', g ? (g.kills / Math.max(1, g.deaths)).toFixed(2) : dash)
        + stat('Best killstreak', g ? num(g.best) : dash)
        + stat('Current killstreak', g ? num(g.streak) : dash)
        + stat('Gems', g && g.gems !== null ? num(Math.floor(g.gems)) : dash)
        + stat('Days played', num(p.days))
        + '</div>'
      : '')
    + '<section class="box"><div class="box__h">Activity</div><div class="mstats">'
    + `<div><small>First joined</small><b>${esc(date(p.firstJoin))}</b></div>`
    + `<div><small>Last seen</small><b>${p.online ? 'Online now' : esc(p.lastSeen ? ago(p.lastSeen) : 'Unknown')}</b></div>`
    + `<div><small>Votes this month</small><b>${num(p.votesMonth)}</b></div>`
    + `<div><small>Votes all time</small><b>${num(p.votes)}</b></div>`
    + '</div></section>'
    + '</div>';

  return side + main;
}

/**
 * @param config  siteConfig()
 * @param name    the name that was asked for
 * @param p       the profile, false for a name nobody has joined with, null
 *                when the database could not be asked
 * @param top     the sidebar board, or null
 */
function profile(config, name, p, top) {
  site = config;
  let body;
  if (p === null) {
    body = notice('Stats are unavailable right now', 'The stats database did not answer. Try again shortly.');
  } else if (!p) {
    body = `<section class="box nf"><h2>No player called ${esc(name)}</h2>`
      + `<p>Nobody with that name has joined ${esc(config.name)} yet. Check the spelling, or try a name from the leaderboards.</p>`
      + `<a class="btn-y" href="${esc(statsUrl())}">Back to leaderboards</a></section>`;
  } else {
    /* A profile is laid out on its own: the player down the left, their
       numbers across the rest, and no leaderboard beside it competing. */
    /* What a link to this profile previews as - see sendPage in server.js. */
    const g = p.game;
    const shown = (g && g.name) || p.name;
    const facts = [
      `${hours(p.seconds)} played`,
      g && g.kills ? `${num(g.kills)} kills` : '',
      g && g.kills ? `${(g.kills / Math.max(1, g.deaths)).toFixed(2)} K/D` : '',
      g && g.best ? `best killstreak ${num(g.best)}` : '',
      p.votes ? `${num(p.votes)} votes` : '',
    ].filter(Boolean).join(' · ');
    const head = JSON.stringify({
      title: `${shown} | ${config.name} Stats`,
      description: `${shown}${p.group ? `, ${title(p.group)}` : ''} on ${config.name}: ${facts}.`,
    }).replace(/-->/g, '');
    return `<!--HEAD:${head}--><div class="page pwrap">${profileBody(config, p)}</div>`;
  }

  return `<div class="page layout"><div>${body}</div><aside class="side">`
    + topPlayers(top)
    + chrome.support(config)
    + '</aside></div>';
}

module.exports = { home, profile };
