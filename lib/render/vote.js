'use strict';
/** The vote page body, rendered on the server. No data reaches the browser. */

const { esc, head, num } = require('./html');
const chrome = require('./chrome');

const PLACES = 10;

function host(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return link; }
}

/* Each site is an anchor, not a button. A real link middle-clicks, opens in a
   background tab, shows its target on hover and works with the keyboard - all
   of which somebody voting on five sites in a row wants. */
function sites(list) {
  return list.map((s, i) => '<div class="vsite">'
    + `<span class="num">${i + 1}</span>`
    + `<div><b>${esc(s.name)}</b><small>${esc(s.note || host(s.url))}</small></div>`
    + `<a class="add vbtn" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Vote</a></div>`).join('');
}

/**
 * This month's board.
 *
 * Three different states, and they must not look alike: a list of names, a
 * month nobody has voted in yet, and a database that did not answer. The last
 * one says so instead of showing an empty board that reads as "no votes".
 */
function board(config, voters) {
  let inner;
  if (!Array.isArray(voters)) {
    inner = '<p class="boxnote" style="padding-top:18px">The leaderboard is unavailable right now.</p>';
  } else if (!voters.length) {
    inner = '<p class="boxnote" style="padding-top:18px">Nobody has voted yet this month. First place is open.</p>';
  } else {
    inner = '<ol class="voters">' + voters.slice(0, PLACES).map((v, i) => '<li>'
      + `<a href="${esc(chrome.url(config, 'site', `/stats?player=${encodeURIComponent(v.name)}`))}">`
      + `<span class="rank r${i + 1}">${i + 1}</span>${head(v.name, v.uuid)}`
      + `<b>${esc(v.name)}</b><em>${num(v.votes)}</em></a></li>`).join('') + '</ol>'
      + '<p class="boxnote">This month&#39;s leaderboard. Resets on the 1st.</p>';
  }
  return `<section class="box"><div class="box__h">Top Voters</div>${inner}</section>`;
}

/**
 * @param config  siteConfig()
 * @param vote    content/vote.json, or the built-in default
 * @param voters  live counts from Beacon; null when that is unconfigured or
 *                unreachable — an empty array is a real answer (nobody has
 *                voted yet this month) and is not the same as null.
 */
function page(config, vote, voters) {
  const v = vote || {};
  const list = Array.isArray(v.sites) ? v.sites.filter((s) => s && s.name && s.url) : [];

  /* A board from the content file is honoured when there is no live one, so a
     site without the vote database can still publish one by hand. */
  const shown = Array.isArray(voters)
    ? voters
    : ((Array.isArray(v.leaderboard) && v.leaderboard.length) ? v.leaderboard : null);

  const rewards = v.reward || 'Every vote earns a reward in game.';

  return '<div class="page layout"><div>'
    + '<section class="box offer offer--plain">'
    + `<div><h2>Every vote <span>pays</span></h2><p>${esc(rewards)}`
    + ' Every site counts separately, once every 24 hours.</p></div>'
    + '</section>'
    + '<div class="sec-h"><h2>Vote sites</h2><p>Log in to the server first so your rewards find you</p></div>'
    + (list.length
      ? `<section class="box vlist">${sites(list)}</section>`
      : '<section class="box notice"><h2>No vote sites yet</h2><p>They will be listed here as soon as the server is on one.</p></section>')
    + '</div><aside class="side">'
    + board(config, shown)
    + chrome.support(config)
    + '</aside></div>';
}

module.exports = { page };
