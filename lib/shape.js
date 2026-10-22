'use strict';
/**
 * Reshapes Tebex payloads into what the page is allowed to see.
 *
 * Allow-list, never deny-list. A field Tebex adds in a future version arrives
 * here and is dropped because nothing asked for it — whereas a deny-list would
 * pass it straight through to the browser, which is exactly how an identifier
 * nobody meant to publish ends up in devtools.
 *
 * The one that matters most is `ident`. A basket ident is a bearer capability:
 * anyone holding it can read the basket, add to it and take it to checkout. It
 * is never in any object built here.
 */

const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Strips tags and decodes the handful of entities Tebex actually emits. */
function text(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pulls the selling points out of a package description.
 *
 * Descriptions are authored as HTML in the Tebex panel, and almost always as a
 * list. Turning `<li>` into a real array here means the card can render bullets
 * as markup it controls, rather than the page injecting panel-authored HTML —
 * which would be an XSS hole opened by whoever has panel access.
 */
function features(html) {
  const items = [...String(html || '').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => text(m[1]))
    .filter((s) => s.length > 1 && s.length < 120);
  return items.slice(0, 4);
}

/** The first sentence, for the one-line description under the title. */
function summary(html) {
  const withoutList = String(html || '').replace(/<ul[\s\S]*?<\/ul>/gi, ' ');
  const flat = text(withoutList) || text(html);
  if (!flat) return '';
  const sentence = flat.split(/(?<=[.!?])\s/)[0];
  return (sentence.length > 130 ? `${sentence.slice(0, 127)}…` : sentence);
}

/**
 * The prose of a package description, as paragraphs.
 *
 * The list is taken out first because {@link features} already renders it as
 * bullets, and repeating it under them reads as a mistake. Returned as plain
 * text rather than the panel's own HTML for the same reason features is:
 * anything with panel access could otherwise put markup straight into the page.
 */
function body(html) {
  const withoutList = String(html || '').replace(/<ul[\s\S]*?<\/ul>/gi, '\n');

  return withoutList
    .split(/<\/p>|<br\s*\/?>|\n/i)
    .map((part) => text(part))
    .filter((part) => part.length > 1)
    .slice(0, 4);
}

function pkg(p) {
  if (!p) return null;

  /* The price before tax, deliberately — NOT total_price.
   *
   * Tebex works out sales tax from the caller's location, and the catalogue is
   * fetched by this server with no buyer attached to it, so total_price carries
   * whatever tax applies where the SERVER is. On a French host that made every
   * card read 12.00 for a package priced at 10.00, for buyers who owe no French
   * VAT and would never be charged it — the cart, which does know the buyer,
   * quite rightly said 10.00.
   *
   * One cached catalogue is shared by every visitor, so it cannot carry a tax
   * figure that is right for any of them. The honest number here is the price
   * the package is actually sold at; tax lands at checkout, where Tebex knows
   * who is paying. */
  const price = money(p.base_price ?? p.price);

  /* What it cost before any discount, so the card can strike it through.
   *
   * Taken from Tebex's own discount amount rather than the gap between base and
   * total, which used to stand in for it — that gap is tax, not a saving, and
   * reading it as one is what would print "SAVE 17%" on a full-price package. */
  const off0 = Number(p.discount) || 0;
  const base = money((Number(p.base_price ?? p.price) || 0) + off0);
  const off = base > price ? Math.round(((base - price) / base) * 100) : 0;

  return {
    id: p.id,
    name: p.name,
    summary: summary(p.description),
    features: features(p.description),
    description: body(p.description),
    image: p.image || null,
    price,
    base_price: base,
    discount_percent: off,
    // Tebex exposes both; the page shows whichever the category is set up for.
    type: p.type ?? null,
    expiry_length: p.expiry_length ?? null,
    expiry_period: p.expiry_period ?? null,
  };
}

function category(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    slug: String(c.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    description: c.description ?? '',
    order: c.order ?? 0,
    packages: Array.isArray(c.packages) ? c.packages.map(pkg).filter(Boolean) : [],
  };
}

/**
 * The basket as the page needs it: contents and totals, no ident, no links.
 *
 * Checkout is reached by POSTing to our own /api/store/checkout, which looks the
 * ident up server-side. The browser never needs it and so never gets it.
 */
function basket(b) {
  if (!b) return null;
  return {
    username: b.username ?? null,
    base_price: money(b.base_price),
    sales_tax: money(b.sales_tax),
    total: money(b.total_price),
    currency: b.currency ?? null,
    packages: Array.isArray(b.packages)
      ? b.packages.map((p) => ({
        id: p.id,
        name: p.name,
        image: p.image || null,
        quantity: Number(p.in_basket?.quantity ?? p.quantity ?? 1),
        price: money(p.in_basket?.price ?? p.total_price ?? p.price),
      }))
      : [],
  };
}

module.exports = { pkg, category, basket };
