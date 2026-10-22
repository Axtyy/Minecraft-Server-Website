'use strict';
/**
 * The pages that are not the store: rules, voting, terms, privacy.
 *
 * These are content, not code, so they live in `content/*.json` and are read
 * from disk. A server owner changing a rule should not be editing JavaScript,
 * and a typo in a rule should not stop the site booting.
 *
 * Every loader falls back to a built-in default. A missing or malformed file is
 * logged once and the default is served — a rules page that 500s because
 * somebody left a trailing comma is worse than one that is briefly out of date.
 *
 * Nothing here is user input and nothing here is secret. It is all served to
 * anybody who asks, which is why it is read once at boot and cached: there is
 * no per-request disk hit and no way to make one happen.
 */

const fs = require('fs');
const path = require('path');
const log = require('./log');

/* The server's own text first; the shipped templates when it has none. A fresh
   install therefore has a vote page, terms and a privacy policy on first run,
   written for {name} until somebody writes their own. */
const DIRS = [
  path.join(__dirname, '..', process.env.CONTENT_DIR || 'content'),
  path.join(__dirname, '..', 'content.example'),
];

/* {name} and {email} anywhere in a string, filled from the environment, so the
   templates read as this server's and not as a blank form. */
const FILL = {
  name: () => process.env.STORE_NAME || 'Minecraft Store',
  email: () => process.env.STORE_CONTACT_EMAIL || 'support@example.net',
  site: () => process.env.SITE_PUBLIC_URL || process.env.STORE_PUBLIC_URL || 'this website',
};

function fill(value) {
  if (typeof value === 'string') {
    return value.replace(/{(name|email|site)}/g, (_, key) => FILL[key]());
  }
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  }
  return value;
}

/** Read once at boot. `reload()` exists for the dev watcher. */
const cache = new Map();

function read(name, fallback) {
  if (cache.has(name)) return cache.get(name);

  let value = fallback;
  const file = DIRS.map((dir) => path.join(dir, `${name}.json`)).find((f) => fs.existsSync(f));

  try {
    if (file) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Only replace the default with something of the right shape.
      if (parsed && typeof parsed === 'object') value = parsed;
    }
  } catch (err) {
    log.warn(`content/${name}.json could not be read (${err.message}); using the built-in default.`);
  }

  value = fill(value);
  cache.set(name, value);
  return value;
}

function reload() {
  cache.clear();
}

/* ------------------------------------------------------------------ rules */

const RULES = {
  updated: null,
  intro: 'These apply everywhere on the network — every gamemode, the Discord, '
    + 'and anything else with our name on it. Staff decisions are final, and '
    + '"it did not say I could not" is not a defence.',
  sections: [
    {
      title: 'Playing fair',
      rules: [
        { name: 'No cheating', body: 'Any client modification that gives an advantage: x-ray, reach, aim assist, auto-clickers, flight, macros that play for you. Minimaps without cave or entity radar are fine.' },
        { name: 'No exploiting', body: 'If something is clearly not working as intended, report it. Using it — and especially selling or teaching it — is treated as cheating.' },
        { name: 'No alt abuse', body: 'Alts are allowed. Using them to farm rewards, evade a punishment, or stack votes is not.' },
      ],
    },
    {
      title: 'Behaving',
      rules: [
        { name: 'No harassment', body: 'Slurs, hate speech, sexual content, and going after somebody after being told to stop. This includes DMs that start on our server.' },
        { name: 'No spam', body: 'Chat flooding, advertising other servers, and unsolicited links.' },
        { name: 'No impersonation', body: 'Do not pretend to be staff or another player, in name, skin, or claim.' },
      ],
    },
    {
      title: 'Accounts and payments',
      rules: [
        { name: 'Your account is yours', body: 'You are responsible for what happens on it. "My brother did it" does not lift a ban.' },
        { name: 'No chargebacks', body: 'If something went wrong with a purchase, open a ticket and we will sort it. A chargeback removes what was bought and bans the account.' },
        { name: 'No selling accounts or items for real money', body: 'Outside the store, nothing on this server is for sale.' },
      ],
    },
  ],
};

/* ------------------------------------------------------------------- vote */

const VOTE = {
  intro: 'Voting is the single best thing you can do for the server that costs '
    + 'nothing. Every site is once every 24 hours, and each one pays out '
    + 'whether or not the others do.',
  reward: 'Each vote: 1 vote key, 250 coins, and a day of vote party progress.',
  sites: [],
};

/* ----------------------------------------------------------------- public */

module.exports = {
  reload,
  rules: () => read('rules', RULES),
  vote: () => read('vote', VOTE),
  /* Optional. { "offer": { "title", "body", "ends" } } puts the limited-time
     box at the top of the store; no file means no box. */
  store: () => read('store', null),
  legal: (which) => read(which === 'privacy' ? 'privacy' : 'terms', null),
};
