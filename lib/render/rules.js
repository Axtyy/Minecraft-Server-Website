'use strict';
/** The rules, terms and privacy bodies. All three are static text. */

const { esc } = require('./html');
const chrome = require('./chrome');

/* Sections render by type: 'text' paragraphs, 'numbered' rule blocks,
   'list' bullets, 'cards' disclaimers. */
const DEFAULT_RULES = [
  { type: 'text', heading: 'Introduction', body: [
    'These rules apply everywhere we operate - in game, in the Discord, and on this store. Playing here means you accept them.',
    'They exist so everyone gets a fair and welcoming server, not to catch people out. Staff judge situations case by case, and context matters. If you believe a punishment was wrong, appeal it in the Discord rather than arguing about it in chat.',
  ] },
  { type: 'numbered', heading: 'Expected Behaviour', rules: [
    { title: 'Behave Appropriately',
      body: 'Treat other players and staff with basic respect. Harassment, slurs, hate speech, threats, sexual content and targeted abuse are not tolerated in any form - that includes chat, signs, books, item names, skins and usernames. Disagreements happen; keep them civil or take them somewhere private.' },
    { title: 'No Unfair Advantages',
      body: 'Play the game as it is meant to be played. Client modifications, resource packs and exploits that give you an advantage others do not have are banned - x-ray, kill aura, reach, flight, and item or economy duplication included. Automation is the one grey area, and where it stands is covered in the disclaimers below. If you find a bug that benefits you, report it instead of using it.' },
    { title: 'English Preferred',
      body: 'Public chat works best in English, since that is what staff moderate in and what most players can follow. Speaking another language is not punishable on its own - use it freely in direct messages, party chat and the language channels in our Discord. Staff may ask you to switch to English in main chat if something needs moderating.' },
  ] },
  { type: 'text', heading: 'Chat Filter', body: [
    'Trying to get around the chat filter counts as breaking whichever rule you were trying to break. Creative spelling, spacing or symbol substitution does not make something acceptable, and it is treated as a deliberate attempt rather than an accident.',
  ] },
  { type: 'list', heading: 'Disallowed Behaviour', items: [
    'Advertising other servers, Discords or unrelated content',
    'Sharing personal information about yourself or anyone else',
    'Impersonating staff, other players, or the server itself',
    'Scamming, including fake trades and deliberately misleading deals',
    'Spamming, flooding chat, or excessive use of caps',
    'Trading in-game items or ranks for real money outside this store',
    'Evading a punishment using alternate accounts',
    'Griefing or stealing outside the game modes where it is allowed',
    'Abusing bugs, dupes, or clearly unintended mechanics',
    'Charging back or disputing a store purchase instead of contacting support',
  ] },
  { type: 'cards', heading: 'Disclaimers', cards: [
    { title: 'Account Sharing',
      body: 'Your account is your responsibility. Anything done on it is treated as done by you, whether or not you were the one at the keyboard. Punishments are not lifted because someone else was playing.' },
    { title: 'Automated Gameplay',
      body: 'Auto-clickers and simple macros are fine for farming, fishing and other repetitive tasks where no other player is affected. They are not allowed in PvP, or anywhere they give you an edge over someone else. Bots that play the game for you are never allowed. If you are unsure whether your setup crosses the line, ask a staff member before using it.' },
    { title: 'Non-PC Gameplay',
      body: 'Playing on a controller, phone or tablet is allowed, and you are held to the same rules as everyone else. Input method is never an excuse for behaviour that would otherwise be punished, and no allowances are made for it in PvP.' },
    { title: 'VPN Usage',
      body: 'VPNs are generally fine. A VPN used to evade a punishment, or coming from a range associated with abuse, may be blocked. If you are blocked unfairly, contact staff in the Discord.' },
  ] },
];

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const paragraphs = (list) => list.filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');

/**
 * The stack of boxes, and the ids the "On this page" list jumps to.
 *
 * Rule numbers run on across sections: "rule 5" has to mean one rule, whichever
 * heading it happens to sit under.
 */
function rulesBody(sections) {
  let n = 0;
  const jump = [];

  const html = sections.map((sec, i) => {
    const id = `r-${slug(sec.heading) || i}`;
    jump.push({ id, label: sec.heading });
    let inner = '';

    if (sec.type === 'text') {
      inner = `<div class="rtext">${paragraphs(sec.body || [])}</div>`;
    } else if (sec.type === 'numbered') {
      inner = (sec.rules || []).map((r) => {
        n++;
        return `<div class="rnum"><span class="num">${n}</span>`
          + `<div><h3>${esc(r.title)}</h3><p>${esc(r.body)}</p></div></div>`;
      }).join('');
    } else if (sec.type === 'list') {
      inner = `<ul class="rlist">${(sec.items || []).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
    } else if (sec.type === 'cards') {
      inner = '<div class="rcards">'
        + (sec.cards || []).map((c) => `<article><h3>${esc(c.title)}</h3><p>${esc(c.body)}</p></article>`).join('')
        + '</div>';
    }

    return `<section class="box rsec" id="${esc(id)}"><div class="box__h">${esc(sec.heading)}</div>${inner}</section>`;
  }).join('');

  return { html, jump };
}

/** content/rules.json shape -> the section shape above. */
function fromContent(rules) {
  if (!rules || !rules.sections || !rules.sections.length) return DEFAULT_RULES;

  const out = [];
  if (rules.intro) out.push({ type: 'text', heading: 'Introduction', body: [rules.intro] });
  rules.sections.forEach((group) => {
    out.push({
      type: 'numbered',
      heading: group.title,
      rules: (group.rules || []).map((r) => ({ title: r.name, body: r.body })),
    });
  });
  return out;
}

/* Plain fragment links. The page scrolls to the box with CSS alone, the
   address bar keeps the section, and it works with scripts off. */
const jumpBox = (title, jump) => (jump.length
  ? `<section class="box"><div class="box__h">${esc(title)}</div><ol class="jump">`
    + jump.map((j) => `<li><a href="#${esc(j.id)}">${esc(j.label)}</a></li>`).join('')
    + '</ol></section>'
  : '');

function rulesPage(config, rules) {
  const { html, jump } = rulesBody(fromContent(rules));

  return `<div class="page layout"><div class="rstack">${html}</div>`
    + '<aside class="side sticky">'
    + jumpBox('On this page', jump)
    + chrome.support(config)
    + '</aside></div>';
}

const TITLES = { terms: 'Terms of sale', privacy: 'Privacy policy' };

/** Terms and privacy: same shell, whatever content/<which>.json holds. */
function legalPage(config, which, doc) {
  if (!doc || !doc.sections || !doc.sections.length) {
    return '<div class="page solo"><section class="box notice">'
      + '<h2>This document has not been written yet</h2>'
      + `<p>Add <code>content/${esc(which)}.json</code> to publish it.</p></section></div>`;
  }

  const jump = [];
  const sections = doc.sections.map((sec, i) => {
    const id = `${which}-${i}`;
    jump.push({ id, label: sec.title || `Section ${i + 1}` });
    const body = Array.isArray(sec.body) ? sec.body : [sec.body];
    return `<section class="box rsec" id="${id}"><div class="box__h">${esc(sec.title || '')}</div>`
      + `<div class="rtext">${paragraphs(body)}</div></section>`;
  }).join('');

  /* The contact address is whatever the document itself gives, so the box
     beside it can never disagree with the text it sits next to. */
  const email = (JSON.stringify(doc).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [])[0];
  const discord = chrome.discordUrl(config);
  const ways = [
    email ? `email <b class="hl">${esc(email)}</b>` : '',
    discord ? `ask in our <a class="hl" href="${esc(discord)}" target="_blank" rel="noopener noreferrer">Discord</a>` : '',
  ].filter(Boolean).join(' or ');
  const questions = ways
    ? '<section class="box"><div class="box__h">Questions?</div>'
      + `<div class="appeal"><p style="margin:0">${ways.charAt(0).toUpperCase()}${ways.slice(1)}.</p></div></section>`
    : '';

  return '<div class="page layout"><div class="rstack">'
    + (doc.intro ? `<section class="box"><div class="rtext lead"><p>${esc(doc.intro)}</p></div></section>` : '')
    + sections
    + '</div><aside class="side sticky">'
    + jumpBox(TITLES[which] || 'On this page', jump)
    + questions
    + '</aside></div>';
}

module.exports = { rulesPage, legalPage };
