'use strict';
/**
 * The storefront: a server-rendered catalogue and its package cards.
 *
 * Rendered here so the shop is on screen with the document. The cart is the
 * one part that stays in the browser — it is per-session and opens on a click,
 * so it has nothing to gain from being in the page for everybody.
 *
 * Every price shown is one the catalogue quoted. Nothing on this page does
 * arithmetic on money: a price the server did not quote is a price nobody
 * will honour at checkout.
 */

const { esc, money, head } = require('./html');
const chrome = require('./chrome');

const IMG = '/assets/img';

/* Presentation only. What is FOR SALE comes from the catalogue, so a category
   with no packages simply does not appear. */
const CAT_STYLE = {
  gems: { img: `${IMG}/bucks-1.webp`, sub: 'Spend them on crate keys, cosmetics and perks with /gemshop' },
  ranks: { img: `${IMG}/rank4.webp`, sub: 'Unlock the full server' },
  rankups: { img: `${IMG}/rank3.webp`, sub: 'Upgrade for less' },
  crates: { img: `${IMG}/bucks-3.webp`, sub: 'Roll for rewards' },
  bundles: { img: `${IMG}/bucks-4.webp`, sub: 'More value, one click' },
};
const FALLBACK = { img: `${IMG}/bucks-1.webp`, sub: '' };

/* Categories the storefront does not sell, whatever the catalogue offers.
   Filtered here rather than in the Tebex panel so the page cannot start
   showing them again the moment somebody re-enables a category upstream.

   Set as STORE_HIDDEN_CATEGORIES, a comma-separated list of category slugs.
   Hiding a category here rather than deleting its packages in Tebex keeps the
   purchase history intact for everybody who already bought one. */
const HIDDEN = new Set(String(process.env.STORE_HIDDEN_CATEGORIES || '').split(',')
  .map((slug) => slug.trim().toLowerCase()).filter(Boolean));

function splitName(name) {
  /* "2,200 Gems" is an amount and a unit; "Knight" has no number and stays
     whole. */
  const m = /^(\d[\d,.]*)\s+(.+)$/.exec(name || '');
  return m ? { amount: m[1], unit: m[2] } : { amount: name || '', unit: '' };
}

/** Catalogue -> the shapes below. Built once per render, nowhere else. */
function build(cats) {
  const categories = [];
  const products = [];

  (cats || []).forEach((c) => {
    if (!c.packages || !c.packages.length) return;
    if (HIDDEN.has(String(c.slug || '').toLowerCase())) return;
    const style = CAT_STYLE[c.slug] || FALLBACK;

    categories.push({
      id: c.slug,
      label: c.name,
      sub: c.description || style.sub,
      img: style.img,
    });

    c.packages.forEach((p) => {
      const parts = splitName(p.name);
      products.push({
        id: String(p.id),
        cat: c.slug,
        name: [parts.amount, parts.unit].filter(Boolean).join(' '),
        summary: p.summary || '',
        amount: parts.amount,
        unit: parts.unit,
        now: Number(p.price),
        base: Number(p.base_price),
        discount: Number(p.discount_percent),
        art: p.image || style.img,
        ownArt: Boolean(p.image),
        includes: (p.features && p.features.length) ? p.features : [],
        description: (p.description && p.description.length) ? p.description : [],
        bonus: p.bonus || null,
        flag: p.flag || null,
      });
    });
  });

  return { categories, products };
}

/**
 * Works out what a bundle gives over the base rate, where the catalogue has
 * not said.
 *
 * Tebex has no field for "this one is 20% extra", so on the live store the
 * figure has to come from the packages themselves: the cheapest bundle sets
 * the rate, and a bigger bundle that hands over more than that rate would is
 * carrying a bonus. This is arithmetic on the AMOUNT of in-game currency, not
 * on money - the price shown is still the one the catalogue quoted.
 *
 * Only for a category whose packages are all "<number> <same unit>". Anything
 * else has no rate to compare.
 */
function inferBonuses(items) {
  if (items.some((p) => p.bonus)) return;

  const rows = items.map((p) => ({ p, n: Number(String(p.amount).replace(/[,\s]/g, '')) }));
  const unit = items[0] && items[0].unit;
  if (!unit || rows.some((r) => !Number.isFinite(r.n) || r.n <= 0 || r.p.unit !== unit || !(r.p.now > 0))) return;

  const cheapest = rows.reduce((a, b) => (b.p.now < a.p.now ? b : a));
  const rate = cheapest.n / cheapest.p.now;

  rows.forEach((r) => {
    const plain = Math.round(r.p.now * rate);
    const percent = Math.round(((r.n - plain) / plain) * 100);
    if (percent >= 1) r.p.bonus = { base: plain, percent };
  });
}

/**
 * The two ribbons, where the catalogue has not chosen them itself.
 *
 * "Best value" is the bundle with the biggest bonus, which is a fact about the
 * packages. "Most popular" is the one bought most among the recent purchases
 * Beacon recorded - a fact too, and no ribbon is shown until a few people have
 * actually bought it.
 */
function inferFlags(items, recent) {
  if (items.some((p) => p.flag)) return;

  const best = items.filter((p) => p.bonus)
    .reduce((a, b) => (!a || b.bonus.percent > a.bonus.percent ? b : a), null);
  if (best) best.flag = 'best';

  const bought = new Map();
  (recent || []).forEach((r) => {
    const key = String(r.package || '').trim().toLowerCase();
    bought.set(key, (bought.get(key) || 0) + 1);
  });
  const popular = items
    .filter((p) => p !== best)
    .map((p) => ({ p, n: bought.get(p.name.toLowerCase()) || 0 }))
    .reduce((a, b) => (b.n > a.n ? b : a), { p: null, n: 2 });
  if (popular.p) popular.p.flag = 'popular';
}

const FLAGS = {
  popular: { cls: ' pop', tag: 'Most Popular' },
  best: { cls: ' best', tag: 'Best Value' },
};

function pack(p, currency, aligned) {
  const id = esc(p.id);
  const flag = FLAGS[p.flag] || null;
  const bonus = p.bonus && p.bonus.percent > 0 ? p.bonus : null;

  /* The bonus is about the AMOUNT, not the price: the same money buys more.
     Shown against the name rather than the price for that reason - striking
     the price would say it is cheaper, which it is not.

     A card with no bonus still reserves the line when its neighbours have
     one, so four names sit on one baseline. */
  const plain = bonus
    ? `<s>${esc(Number(bonus.base).toLocaleString('en-US'))}</s>`
    : (aligned ? '<s style="visibility:hidden">0</s>' : '');
  const extra = bonus
    ? `<span>${esc(bonus.percent)}% Extra${p.unit ? ` ${esc(p.unit)}` : ''}</span>`
    : (p.discount > 0 ? `<span>Save ${esc(p.discount)}%</span>` : '');

  const was = p.base > p.now ? `<s>${esc(money(p.base))}</s>` : '';

  /* Everything the cart and the details pop-up need is on the card. The cart
     draws a new line from these the instant it is clicked, before Tebex has
     answered - see src/lib/cart.js. */
  return `<article class="pack${flag ? flag.cls : ''}" data-id="${id}"`
    + ` data-package-modal="${id}" data-package-name="${esc(p.name)}" data-package-price="${esc(p.now)}"`
    + ` data-package-art="${esc(p.art || '')}" data-package-summary="${esc(p.summary)}"`
    + ` data-package-includes="${esc(JSON.stringify(p.includes))}"`
    + ` data-package-description="${esc(JSON.stringify(p.description))}"`
    + ` data-package-extra="${esc(bonus ? `${bonus.percent}% Extra${p.unit ? ` ${p.unit}` : ''}` : '')}">`
    + (flag ? `<span class="tag">${flag.tag}</span>` : '')
    + `<div class="art"><img draggable="false" src="${esc(p.art)}" alt="" loading="lazy"></div>`
    + `<div class="extra">${extra}</div>`
    + `<h3>${plain}${esc(p.name)}</h3>`
    + `<div class="price">${was}${esc(money(p.now))} ${esc(currency)}</div>`
    + '<div class="acts">'
    + `<button class="info" data-package-info aria-label="${esc(p.name)} details">i</button>`
    + `<button class="add" data-add="${id}">Add to Cart</button>`
    /* Takes the button's place once the package is in the cart, so the card
       itself says how many are in there and can add or take one away. Hidden
       until src/lib/cart.js knows what the basket holds. */
    + `<div class="qty pqty" data-card-qty="${id}" hidden>`
    + `<button data-dec="${id}" aria-label="One fewer ${esc(p.name)}">−</button>`
    + '<output>0</output>'
    + `<button data-inc="${id}" aria-label="One more ${esc(p.name)}">+</button></div>`
    + '</div></article>';
}

/* Bigger bundles get the bigger picture.
 *
 * Tebex has no image for the gem packages, so all four fell back to the one
 * category picture and the grid was the same small pile four times. The four
 * drawings go to the four cheapest-to-dearest packs; a pack with artwork of
 * its own in Tebex keeps it. */
const TIERED = { gems: [1, 2, 3, 4].map((n) => `${IMG}/bucks-${n}.webp`) };

function tierArt(cat, items) {
  const tiers = TIERED[cat.id];
  if (!tiers) return;
  const byPrice = items.slice().sort((a, b) => a.now - b.now);
  byPrice.forEach((p, i) => {
    if (!p.ownArt) p.art = tiers[Math.min(tiers.length - 1, Math.floor((i * tiers.length) / byPrice.length))];
  });
}

function collection(cat, items, currency, recent) {
  tierArt(cat, items);
  inferBonuses(items);
  inferFlags(items, recent);
  const aligned = items.some((p) => p.bonus);

  return `<div class="sec-h" id="c-${esc(cat.id)}"><h2>${esc(cat.label)}</h2>`
    + (cat.sub ? `<p>${esc(cat.sub)}</p>` : '') + '</div>'
    + `<div class="packs">${items.map((p) => pack(p, currency, aligned)).join('')}</div>`;
}

/**
 * Who the visitor is shopping as, and the cart button.
 *
 * Drawn as a guest. Who is signed in is per-session, so it must never be baked
 * into a document; src/lib/cart.js fills the name and the count in once the
 * session has answered.
 *
 * data-wait keeps the name and the count out of sight until the script has
 * something true to put there - otherwise a signed-in visitor watches the card
 * say "Guest" for a moment on every load. The stylesheet lets go of it by
 * itself after a second and a half, so a page whose script never runs still
 * shows the card.
 */
function belt() {
  return '<section class="box belt" data-wait><div class="guest">'
    + `<div class="hex"><img draggable="false" id="guestHead" src="${IMG}/steve.png" alt=""></div>`
    + '<div><b>Shopping as <span id="guestName">Guest</span></b>'
    + '<div class="row"><button id="login">'
    + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>'
    + '<span id="loginLbl">Login</span></button>'
    + '<button id="logout" hidden>Logout</button></div></div></div>'
    + '<button class="cart" id="cartBtn"><span><b>VIEW CART</b><small id="cartSum">0 items</small></span>'
    + `<img draggable="false" src="${IMG}/bucks-1.webp" alt=""></button>`
    + '</section>';
}

/**
 * The limited-time box, when content/store.json describes one.
 *
 * { "offer": { "title": "Honey Crate", "body": "...", "ends": "2026-11-01T00:00:00Z" } }
 *
 * Nothing is drawn without a title, and the countdown only with a real end
 * that is still in the future: a clock counting down to nothing is a lie the
 * whole page gets judged by.
 */
function offer(store) {
  const o = store && store.offer;
  if (!o || !o.title) return '';

  const ends = o.ends ? Date.parse(o.ends) : NaN;
  const left = Number.isFinite(ends) ? Math.floor((ends - Date.now()) / 1000) : 0;
  if (Number.isFinite(ends) && left <= 0) return '';

  const cell = (id, value, label) => `<div><b data-cd="${id}">${value}</b><small>${label}</small></div>`;
  const count = left > 0
    ? `<div class="count" aria-label="Time left" data-ends="${ends}">`
      + cell('d', Math.floor(left / 86400), 'Days') + '<i>:</i>'
      + cell('h', Math.floor((left % 86400) / 3600), 'Hours') + '<i>:</i>'
      + cell('m', Math.floor((left % 3600) / 60), 'Minutes') + '</div>'
    : '';

  return '<section class="box offer">'
    + `<div class="offer__art"><img src="${IMG}/sky/prop-block.webp" alt=""></div>`
    + `<div><h2>${esc(o.title)}</h2>${o.body ? `<p>${esc(o.body)}</p>` : ''}</div>`
    + count
    + '</section>';
}

/**
 * Recent supporters, newest first.
 *
 * Only who. Not when, not what they bought and not what they paid; this is a
 * thank-you, not a receipt. Somebody who bought twice appears once. Nothing at
 * all is drawn when there is nobody to show, so a store with no sales yet (or
 * with the dashboard's database unreachable) simply has no box.
 */
function recentBox(recent) {
  if (!Array.isArray(recent) || !recent.length) return '';

  const seen = new Set();
  const people = recent.filter((r) => {
    const key = String(r.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);

  return '<section class="box"><div class="box__h">Recent Purchases</div><ul class="recent">'
    + people.map((r) => `<li>${head(r.name, r.uuid)}`
      + `<span><b>${esc(r.name)}</b></span></li>`).join('')
    + '</ul></section>';
}

/**
 * @param config     siteConfig()
 * @param catalogue  { categories, demo }
 * @param slug       the category in the URL, or '' for the whole store
 * @param recent     recent purchases from Beacon, or []
 * @param store      content/store.json, or null
 */
function page(config, catalogue, slug, recent, store) {
  const { categories, products } = build(catalogue.categories);
  const currency = process.env.STORE_CURRENCY || 'USD';

  /* The bare store URL shows everything on sale, one collection under the
     next; /category/<slug> shows that one alone. Each is a real URL, so the
     browser can bookmark it and go back to it. */
  const shown = categories.some((c) => c.id === slug)
    ? categories.filter((c) => c.id === slug)
    : categories;

  const tabs = categories.length > 1
    ? '<nav class="cats" aria-label="Store categories">'
      + `<a href="${esc(chrome.url(config, 'store', '/'))}"${shown.length > 1 ? ' class="on" aria-current="page"' : ''}>Everything</a>`
      + categories.map((c) => {
        const on = shown.length === 1 && shown[0].id === c.id;
        return `<a href="${esc(chrome.url(config, 'store', `/category/${c.id}`))}"${on ? ' class="on" aria-current="page"' : ''}>${esc(c.label)}</a>`;
      }).join('')
      + '</nav>'
    : '';

  const body = shown.length
    ? shown.map((c) => collection(c, products.filter((p) => p.cat === c.id), currency, recent)).join('')
    : '<div class="sec-h"><h2>Store</h2></div>'
      + '<div class="packs packs--empty"><p class="box">Nothing is on sale right now. Check back soon.</p></div>';

  return '<div class="page layout"><div>'
    + belt()
    + offer(store)
    + tabs
    + body
    + '</div><aside class="side">'
    + chrome.support(config)
    + recentBox(recent)
    + '</aside></div>';
}

/**
 * The artwork a package falls back to when Tebex has no image of its own.
 *
 * Exported because the cart needs the same answer. Tebex returns image: null
 * for most packages, and the store page only looks right because this file
 * substitutes the category's art while rendering — a substitution the browser
 * never saw, so the cart fell back to the first letter of the name instead.
 */
const artFor = (slug) => (CAT_STYLE[slug] || FALLBACK).img;

module.exports = { page, artFor };
