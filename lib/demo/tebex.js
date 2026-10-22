'use strict';
/**
 * A stand-in for Tebex Headless, used when DEMO_MODE=true.
 *
 * Exactly the exports of lib/tebex.js, so server.js runs the same routes over
 * it: the basket is created, added to, removed from and checked out the same
 * way. The differences are where the data lives (this process's memory) and
 * where checkout goes (/demo/checkout on this site, which takes no money).
 *
 * Baskets are lost on restart, which is right for a demo: nothing in one was
 * ever bought.
 */
const crypto = require('node:crypto');

const real = require('../tebex');
const { CATEGORIES } = require('./catalogue');

const { TebexError, isBasketGone, isComplete } = real;

/* Every package by id, so a basket can be priced from the catalogue alone. */
const PACKAGES = new Map();
for (const category of CATEGORIES) {
  for (const p of category.packages) PACKAGES.set(Number(p.id), p);
}

/* A few hundred visitors' worth, then the oldest go. A public demo must not be
   something anyone can grow without limit by opening baskets in a loop. */
const MAX_BASKETS = 2000;
const baskets = new Map();

const round = (n) => Math.round(n * 100) / 100;

function gone() {
  return new TebexError('That basket no longer exists.', 404, null, { upstreamStatus: 404 });
}

/** The basket as Tebex returns it: totals recomputed from its lines. */
function view(b) {
  const total = round(b.lines.reduce((t, l) => t + l.price * l.quantity, 0));
  return {
    ident: b.ident,
    username: b.username,
    complete: b.complete,
    base_price: total,
    sales_tax: 0,
    total_price: total,
    currency: process.env.STORE_CURRENCY || 'USD',
    packages: b.lines.map((l) => ({
      id: l.id,
      name: l.name,
      image: l.image,
      in_basket: { quantity: l.quantity, price: round(l.price * l.quantity) },
    })),
    links: { checkout: `/demo/checkout?basket=${encodeURIComponent(b.ident)}` },
  };
}

function held(ident) {
  const b = baskets.get(String(ident));
  if (!b) throw gone();
  return b;
}

async function createBasket({ username, completeUrl, cancelUrl }) {
  if (baskets.size >= MAX_BASKETS) baskets.delete(baskets.keys().next().value);
  const ident = `demo-${crypto.randomBytes(12).toString('hex')}`;
  baskets.set(ident, {
    ident, username, completeUrl, cancelUrl, complete: false, lines: [],
  });
  return view(baskets.get(ident));
}

async function getBasket(ident) {
  return view(held(ident));
}

async function addPackage(ident, packageId, quantity = 1) {
  const b = held(ident);
  // Tebex answers a paid basket with the basket, unchanged, and so does this.
  if (b.complete) return view(b);

  const p = PACKAGES.get(Number(packageId));
  if (!p) throw new TebexError('That package does not exist.', 404);

  const line = b.lines.find((l) => l.id === p.id);
  if (line) {
    line.quantity = Math.min(100, line.quantity + quantity);
  } else {
    b.lines.push({ id: p.id, name: p.name, image: p.image, price: p.price, quantity });
  }
  return view(b);
}

async function removePackage(ident, packageId) {
  const b = held(ident);
  if (!b.complete) b.lines = b.lines.filter((l) => l.id !== Number(packageId));
  return view(b);
}

/**
 * The demo checkout's two buttons.
 *
 * @return where to send the browser next: the basket's own complete or cancel
 *         URL, exactly as Tebex would.
 */
function settle(ident, pay) {
  const b = held(ident);
  if (pay && b.lines.length) b.complete = true;
  return pay ? b.completeUrl : b.cancelUrl;
}

module.exports = {
  TebexError,
  isBasketGone,
  isComplete,
  redact: real.redact,
  configured: () => true,
  hasSecretKey: () => true,
  categories: async () => CATEGORIES,
  packages: async () => [...PACKAGES.values()],
  createBasket,
  getBasket,
  addPackage,
  removePackage,
  basketAuth: async () => null,
  settle,
  held: (ident) => baskets.has(String(ident)) ? view(baskets.get(String(ident))) : null,
};
