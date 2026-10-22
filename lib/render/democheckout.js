'use strict';
/**
 * The demo's stand-in for Tebex's checkout page.
 *
 * Only reachable with DEMO_MODE=true. It shows the basket the way the real
 * checkout would, and its two buttons do what paying and backing out do on
 * Tebex: mark the basket paid and send the buyer to /purchase?status=complete,
 * or leave it alone and send them to /purchase?status=cancelled.
 *
 * Plain forms, no script: the page works under the same CSP as everything else.
 */
const { esc, money } = require('./html');
const chrome = require('./chrome');

function line(item) {
  const quantity = Number(item.quantity) > 1 ? `<em>×${Number(item.quantity)}</em>` : '';
  return '<li>'
    + (item.image ? `<img src="${esc(item.image)}" alt="" width="40" height="40" loading="lazy">` : '')
    + `<span>${esc(item.name || 'Package')}${quantity}</span>`
    + `<b>${esc(money(item.price))}</b></li>`;
}

/**
 * @param basket the shaped basket, or null when the link is stale
 * @param ident  its ident, carried back by the two buttons
 */
function page(config, basket, ident) {
  const home = chrome.url(config, 'store', '/');

  if (!basket || !basket.packages.length) {
    return '<div class="page solo"><section class="box status">'
      + '<span class="mark" style="--m:#737d93">?</span>'
      + '<p class="k">DEMO CHECKOUT</p>'
      + '<h1>This basket is gone</h1>'
      + '<p class="blurb">It was paid for, emptied, or the demo restarted. Add something to the cart and check out again.</p>'
      + `<nav class="pacts"><a class="btn-y" href="${esc(home)}">Back to the store</a></nav>`
      + '</section></div>';
  }

  const form = (action, label, primary) => '<form method="post" action="/demo/checkout">'
    + `<input type="hidden" name="basket" value="${esc(ident)}">`
    + `<input type="hidden" name="action" value="${action}">`
    + `<button type="submit" class="${primary ? 'btn-y' : 'btn-g'}">${esc(label)}</button></form>`;

  return '<!--HEAD:{"title":"Demo checkout"}-->'
    + '<div class="page solo"><section class="box status">'
    + '<span class="mark" style="--m:#48b8f5">$</span>'
    + '<p class="k">DEMO CHECKOUT</p>'
    + `<h1>Pay for ${esc(basket.username || 'this order')}</h1>`
    + '<p class="blurb">On a live store this is Tebex&#39;s payment page. This is a demo, so no card is asked for and nothing is charged.</p>'
    + '<section class="receipt"><h3>Order summary</h3>'
    + `<ul>${basket.packages.map(line).join('')}</ul>`
    + `<div class="tot"><span>Total</span><span>${esc(money(basket.total))}</span></div></section>`
    + `<nav class="pacts">${form('pay', 'Pay (demo)', true)}${form('cancel', 'Cancel', false)}</nav>`
    + '</section></div>';
}

module.exports = { page };
