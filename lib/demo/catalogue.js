'use strict';
/**
 * The catalogue, served whenever TEBEX_PUBLIC_TOKEN is unset.
 *
 * Every product the previous storefront sold, in the same six categories and
 * at the same prices, so the shop looks like the shop before a Tebex project
 * exists. Create these as packages in the Tebex panel under categories with
 * these names and the switch-over is a token in the environment — nothing here
 * or in the page changes.
 *
 * Ids are numbered at the bottom of this file. Tebex issues its own once a
 * token is set, and those are what the basket carries then. Without a token
 * adding to a basket is refused, because there is no basket to add to - unless
 * DEMO_MODE=true, where lib/demo/tebex.js keeps baskets of these in memory.
 *
 * Every response carrying this sets `demo: true` and the page says so on
 * screen — the one thing worse than no catalogue is a fake one the viewer
 * believes.
 */

const IMG = {
  one: '/assets/img/bucks-1.webp',
  two: '/assets/img/bucks-2.webp',
  three: '/assets/img/bucks-3.webp',
  four: '/assets/img/bucks-4.webp',
  rank1: '/assets/img/rank1.webp',
  rank2: '/assets/img/rank2.webp',
  rank3: '/assets/img/rank3.webp',
  rank4: '/assets/img/rank4.webp',
};

/** `base_price` above `price` is what draws the struck-through "was". */
const p = (id, name, price, base, opts = {}) => ({
  id,
  name,
  summary: opts.summary || '',
  features: opts.features || [],
  description: opts.description || [],
  bonus: opts.bonus || null,
  flag: opts.flag || null,
  image: opts.image || null,
  price,

  /* Nothing in this catalogue is on sale.
   *
   * The higher 'base' figures every package was written with are what draw a
   * struck-through was-price and a SAVE % badge, so the whole storefront
   * advertised discounts that do not exist. The parameter is kept so the shape
   * still matches what Tebex returns, and a real sale set up in the panel comes
   * through lib/shape.js untouched - but the demo catalogue invents none. */
  base_price: price,
  discount_percent: 0,
  type: opts.type || 'single',
  ...(opts.expiry_length ? {
    expiry_length: opts.expiry_length,
    expiry_period: opts.expiry_period,
  } : {}),
});

/* The same two lines under every gem package.
   Written once here rather than repeated per package: they describe the
   currency, not the size of the bundle. */
const GEMS_ABOUT = [
  'Gems are the virtual currency of ' + (process.env.STORE_NAME || 'the server') + '! Use Gems to purchase crate keys,'
    + ' cosmetics, perks, and other exclusive items in-game.',
  'Type /gemshop in-game to view items you can buy with gems!',
];

/**
 * One gem bundle.
 *
 * @param plain what the price buys at the base rate. Bigger bundles hand over
 *              more than that, and the difference is the whole reason to buy
 *              one - so it is shown as a struck-through original beside the
 *              real figure rather than left for the buyer to work out.
 */
const gem = (id, amount, tier, price, image, plain, flag) => p(id, amount.toLocaleString('en-US') + ' Gems', price, price, {
  image,
  summary: amount.toLocaleString('en-US') + ' Gems | ' + tier,
  features: ['You will receive ' + amount.toLocaleString('en-US') + 'x gems'],
  description: GEMS_ABOUT,
  flag,
  ...(plain && plain < amount ? {
    bonus: {
      base: plain,
      percent: Math.round(((amount - plain) / plain) * 100),
    },
  } : {}),
});

const CATEGORIES = [
  {
    id: 1,
    name: 'Gems',
    slug: 'gems',
    description: 'The in-game currency. Spend it at the shop, on cosmetics, or on the auction house.',
    order: 1,
    packages: [
      gem('g1000', 1000, 'Bit of Gems', 10, IMG.one),
      gem('g2200', 2200, 'Pouch of Gems', 20, IMG.two, 2000),
      gem('g6000', 6000, 'Sack of Gems', 50, IMG.three, 5000, 'popular'),
      gem('g14000', 14000, 'Hoard of Gems', 100, IMG.four, 10000, 'best'),
    ],
  },
  {
    id: 2,
    name: 'Ranks',
    slug: 'ranks',
    description: 'Permanent ranks. Bought once, kept for good, and they carry across every gamemode.',
    order: 2,
    packages: [
      p('r-leaf', 'Guardian', 9.99, 12.99, {
        image: IMG.rank1,
        summary: 'The first step up.',
        features: ['Coloured chat name', 'Basic kit', '3 homes', '1 player vault',
          '250 monthly Gems'],
      }),
      p('r-royal', 'Royal', 29.99, 39.99, {
        image: IMG.rank2,
        summary: 'More of everything, and the cosmetics start here.',
        features: ['Everything in Guardian', 'Plus kit', '6 homes', '3 player vaults',
          '600 monthly Gems', 'Cosmetic particles'],
      }),
      p('r-king', 'King', 49.99, 66.99, {
        image: IMG.rank3,
        summary: 'The rank most people settle on.',
        features: ['Everything in Royal', 'Elite kit', '10 homes', '5 player vaults',
          '1,500 monthly Gems', 'Custom nickname', 'Pets and hats',
          'Join the server when full'],
      }),
      p('r-maple', 'Emperor', 74.99, 99.99, {
        image: IMG.rank4,
        summary: 'The flagship rank. Everything below it, and the things nothing else grants.',
        features: ['Everything in King', 'Ultimate kit', '20 homes', '10 player vaults',
          '3,500 monthly Gems', '2.0x sell multiplier', 'Priority support'],
      }),
    ],
  },
  {
    id: 3,
    name: 'Rank Upgrades',
    slug: 'rankups',
    description: 'Already have a rank? Pay the difference rather than buying the next one outright.',
    order: 3,
    packages: [
      p('u-lr', 'Guardian → Royal', 19.99, 19.99, {
        image: IMG.rank2,
        summary: 'Upgrade an existing Guardian.',
        features: ['Keeps everything you already have', 'Applies instantly'],
      }),
      p('u-rk', 'Royal → King', 19.99, 19.99, {
        image: IMG.rank3,
        summary: 'Upgrade an existing Royal.',
        features: ['Keeps everything you already have', 'Applies instantly'],
      }),
      p('u-km', 'King → Emperor', 24.99, 24.99, {
        image: IMG.rank4,
        summary: 'Upgrade an existing King.',
        features: ['Keeps everything you already have', 'Applies instantly'],
      }),
    ],
  },
  {
    id: 4,
    name: 'Crates',
    slug: 'crates',
    description: 'Keys for the crates at spawn. Buy in bulk for a better rate per key.',
    order: 4,
    packages: [
      p('ck-seasonal-1', '1x Seasonal Crate Key', 2.49, 2.49, { image: IMG.one }),
      p('ck-seasonal-3', '3x Seasonal Crate Key', 6.72, 7.47, { image: IMG.one }),
      p('ck-seasonal-5', '5x Seasonal Crate Key', 9.96, 12.45, { image: IMG.one }),
      p('ck-seasonal-12', '12x Seasonal Crate Key', 20.02, 29.88, { image: IMG.one }),

      p('ck-godly-1', '1x Godly Crate Key', 4.99, 4.99, { image: IMG.two }),
      p('ck-godly-3', '3x Godly Crate Key', 13.47, 14.97, { image: IMG.two }),
      p('ck-godly-5', '5x Godly Crate Key', 19.96, 24.95, { image: IMG.two }),
      p('ck-godly-12', '12x Godly Crate Key', 40.12, 59.88, { image: IMG.two }),

      p('ck-ultra-1', '1x Ultra Crate Key', 8.99, 8.99, { image: IMG.three }),
      p('ck-ultra-3', '3x Ultra Crate Key', 24.27, 26.97, { image: IMG.three }),
      p('ck-ultra-5', '5x Ultra Crate Key', 35.96, 44.95, { image: IMG.three }),
      p('ck-ultra-12', '12x Ultra Crate Key', 72.28, 107.88, { image: IMG.three }),
    ],
  },
  {
    id: 5,
    name: 'Bundles',
    slug: 'bundles',
    description: 'A rank, the gems and the keys to go with it, priced under the sum of its parts.',
    order: 5,
    packages: [
      p('b-str', 'Starter Bundle', 14.99, 21.99, {
        image: IMG.one,
        features: ['Guardian rank', '1,000 Gems', '3x Crate Keys'],
      }),
      p('b-adv', 'Adventurer Bundle', 29.99, 46.99, {
        image: IMG.two,
        features: ['Royal rank', '2,200 Gems', '5x Crate Keys'],
      }),
      p('b-cha', 'Champion Bundle', 59.99, 99.99, {
        image: IMG.three,
        features: ['King rank', '6,000 Gems', '12x Crate Keys'],
      }),
    ],
  },
  {
    id: 6,
    name: 'Plus Tier',
    slug: 'plus',
    description: 'A monthly subscription. Cancel any time.',
    order: 6,
    packages: [
      p('plus-1m', 'Plus Tier - 1 Month', 6.99, 6.99, {
        features: ['Monthly Gems drop', 'Plus tag in chat', 'Discord member role',
          'Early access to updates', 'Cancel anytime'],
        type: 'subscription', expiry_length: 1, expiry_period: 'month',
      }),
      p('plus-3m', 'Plus Tier - 3 Months', 18.99, 20.97, {
        features: ['Monthly Gems drop', 'Plus tag in chat', 'Discord member role',
          'Early access to updates', 'Cancel anytime'],
        type: 'subscription', expiry_length: 3, expiry_period: 'month',
      }),
      p('plus-6m', 'Plus Tier - 6 Months', 35.99, 41.94, {
        features: ['Monthly Gems drop', 'Plus tag in chat', 'Discord member role',
          'Early access to updates', 'Cancel anytime'],
        type: 'subscription', expiry_length: 6, expiry_period: 'month',
      }),
      p('plus-1y', 'Plus Tier - 1 Year', 62.99, 83.88, {
        features: ['Monthly Gems drop', 'Plus tag in chat', 'Discord member role',
          'Early access to updates', 'Cancel anytime', 'Best value'],
        type: 'subscription', expiry_length: 12, expiry_period: 'month',
      }),
    ],
  },
];

/* Numeric ids, as Tebex issues them, so a demo basket can carry them. The
   category's id times a hundred plus the position keeps them stable. */
for (const category of CATEGORIES) {
  category.packages.forEach((p, i) => { p.id = category.id * 100 + i + 1; });
}

module.exports = { CATEGORIES };
