'use strict';
/**
 * The page a buyer lands on when Tebex sends them back.
 *
 * <h2>Why this is not the front page with a query string</h2>
 * Completion used to redirect to `/?purchase=complete`, where a script showed a
 * toast over the store. A toast is gone in four seconds, carries no record of
 * what was bought, and arrives on a page whose job is to sell more things —
 * which is the wrong thing to be looking at in the one moment somebody has
 * just given you money and wants to know it worked.
 *
 * <h2>What it has to answer</h2>
 * Three questions, in this order, because that is the order they are asked in:
 * did the payment go through, what did I buy, and when do I get it. Everything
 * else on the page is secondary to those.
 *
 * <p>The order lines come from Tebex's own record of the paid basket, not from
 * anything the browser sent, so the page cannot be made to claim a purchase
 * that did not happen by editing a URL.
 */

const { esc, money } = require('./html');
const chrome = require('./chrome');

/* The three states this page is reachable in. Anything else - somebody typing
   /purchase directly, a stale bookmark - is "unknown", which says so plainly
   rather than congratulating them on a purchase that never happened. */
const COMPLETE = 'complete';
const CANCELLED = 'cancelled';

/** A product line, with its picture where the catalogue had one. */
function line(item) {
  const quantity = Number(item.quantity) > 1 ? `<em>×${Number(item.quantity)}</em>` : '';
  return '<li>'
    + (item.image ? `<img src="${esc(item.image)}" alt="" width="40" height="40" loading="lazy">` : '')
    + `<span>${esc(item.name || 'Package')}${quantity}</span>`
    + `<b>${esc(money(item.price))}</b></li>`;
}

/**
 * The receipt.
 *
 * <p>Absent when the order cannot be read back - a buyer who cleared cookies
 * between paying and landing here, or a store that is briefly unreachable. The
 * payment still happened, so the page says the delivery part and leaves the
 * list out rather than claiming the order was empty.
 */
function receipt(order) {
  if (!order || !order.packages || !order.packages.length) return '';

  const total = order.total !== undefined && order.total !== null
    ? `<div class="tot"><span>Total paid</span><span>${esc(money(order.total))}</span></div>`
    : '';

  return '<section class="receipt"><h3>Your order</h3>'
    + `<ul>${order.packages.map(line).join('')}</ul>${total}</section>`;
}

/**
 * What happens next, numbered.
 *
 * <p>The delivery question is the one support gets asked, every time, within a
 * minute of a purchase. Answering it on this page - including the part about
 * rejoining, which is the fix in most cases - is cheaper than answering it in
 * a ticket.
 */
function nextSteps() {
  const steps = [
    ['Your items are on the way',
      'Most packages are delivered within a minute of payment clearing.'],
    ['Already online? Rejoin the server',
      'Anything that changes your rank or inventory lands on your next login.'],
    ['Nothing after 15 minutes?',
      'Open a ticket in our Discord with your username and we will sort it.'],
  ];

  return '<section class="next"><h3>What happens next</h3><ol>'
    + steps.map((s, i) => `<li><span class="num">${i + 1}</span>`
      + `<div><b>${esc(s[0])}</b><small>${esc(s[1])}</small></div></li>`).join('')
    + '</ol></section>';
}

const button = (label, href, primary) => `<a class="${primary ? 'btn-y' : 'btn-g'}" href="${esc(href)}">${esc(label)}</a>`;

/**
 * @param config  siteConfig(), for the Discord link and the two hostnames
 * @param status  'complete', 'cancelled', or anything else for the unknown case
 * @param order   the paid basket, shaped, or null when it could not be read
 */
function page(config, status, order) {
  const home = chrome.url(config, 'store', '/');
  const cancelled = status === CANCELLED;
  const complete = status === COMPLETE;

  const mark = complete ? '✓' : cancelled ? '✕' : '?';
  const colour = complete ? '#35b85a' : cancelled ? '#f08c2c' : '#737d93';

  const eyebrow = complete ? 'PAYMENT COMPLETE'
    : cancelled ? 'CHECKOUT CANCELLED'
      : 'NO RECENT ORDER';

  /* Named where the name is known. The username comes off the paid basket -
     Tebex's record of who it was bought for - which is also the account the
     items are going to, so seeing it here is a last chance to spot that it is
     the wrong one. */
  const who = complete && order && order.username ? `, ${order.username}` : '';

  const heading = complete ? `Thank you${who}!`
    : cancelled ? 'Checkout cancelled'
      : 'Nothing to show here';

  const blurb = complete
    ? 'Your payment went through and your order is being delivered in game.'
    : cancelled
      ? 'No payment was taken. Your basket is exactly where you left it, so you can pick up where you stopped.'
      : 'This page shows an order once one has been paid for. There is no recent purchase on this browser.';

  const discord = chrome.discordUrl(config);

  const actions = cancelled
    ? button('Back to my basket', `${home}?cart=open`, true) + button('Keep browsing', home, false)
    : button('Back to the store', home, true)
      + button('Vote for rewards', chrome.url(config, 'site', '/vote'), false)
      + (complete && discord
        ? `<a class="btn-g" href="${esc(discord)}" target="_blank" rel="noopener noreferrer">Join our Discord</a>`
        : '');

  return '<div class="page solo"><section class="box status">'
    + `<span class="mark" style="--m:${colour}">${mark}</span>`
    + `<p class="k">${eyebrow}</p>`
    + `<h1>${esc(heading)}</h1>`
    + `<p class="blurb">${esc(blurb)}</p>`
    + (complete ? receipt(order) + nextSteps() : '')
    + `<nav class="pacts">${actions}</nav>`
    + '</section></div>';
}

module.exports = { page };
