'use strict';
/**
 * The 404 page.
 *
 * Rendered rather than written into the HTML because the store is on a
 * different hostname from the rest of the site: a hard-coded link to the store
 * would be a second 404 when the miss happened on the main domain.
 */
const { esc } = require('./html');
const chrome = require('./chrome');

function page(config) {
  const links = [
    ['Store', chrome.url(config, 'store', '/'), true],
    ['Vote', chrome.url(config, 'site', '/vote')],
    ['Stats', chrome.url(config, 'site', '/stats')],
    ['Rules', chrome.url(config, 'site', '/rules')],
    ['Bans', chrome.url(config, 'site', '/punishments')],
  ];

  return '<div class="page solo"><section class="box status">'
    + '<span class="mark" style="--m:#737d93">?</span>'
    + '<p class="k">ERROR 404</p>'
    + '<h1>This page doesn&#39;t exist</h1>'
    + '<p class="blurb">The link may be out of date, or the address mistyped. Everything below is still where you left it.</p>'
    + '<nav class="pacts">'
    + links.map(([label, href, primary]) => `<a class="${primary ? 'btn-y' : 'btn-g'}" href="${esc(href)}">${label}</a>`).join('')
    + '</nav></section></div>';
}

module.exports = { page };
