/**
 * Account, basket and checkout. Store page only — the other tabs have no
 * cart, so they never load this module.
 *
 * The basket and the signed-in name are the SERVER's, reached through an
 * HttpOnly cookie this script cannot read. `state` is a render-only mirror
 * of the last response: never a source of truth, and never written to by
 * anything but a reply.
 */
import { api } from './api.js';
import {
  $, esc, money, toast, setCurrency,
} from './util.js';
import { skinSrc } from './skins.js';

const IMG = '/assets/img';
const STEVE = `${IMG}/steve.png`;
const STEVE_BODY = `${IMG}/steve-body.png`;
const EMPTY_ART = `${IMG}/bucks-1.webp`;

const VALID_NAME = /^[A-Za-z0-9_]{3,16}$/;

/* The store name is already on the page - the server rendered it into the
   title. Reading it back beats fetching it again just to label a modal. */
const storeName = () => (document.title.split('|')[0] || 'the store').trim();

export const state = {
  user: null,
  basket: null,
  edition: 'java',
};

/* A package somebody tried to add before signing in. Signing in is the only
   thing standing between them and it, so it goes in the cart the moment they
   have - asking them to find the card and click again would be the store
   forgetting what it was just told. */
let pendingAdd = null;

/* What the card showed last time, kept in this browser so the next load can
 * draw it at once instead of waiting on the session.
 *
 * It is a picture, not a login: the server still decides who is signed in, and
 * its answer replaces this a moment later. If the two disagree - the session
 * ran out overnight - the card corrects itself then. Nothing is written here
 * until the server has answered once, so a guess can never be saved as fact. */
const SEEN_KEY = 'bb-store-seen';
let settled = false;

function reveal() {
  const belt = document.querySelector('.belt[data-wait]');
  if (belt) belt.removeAttribute('data-wait');
}

/** Draws the remembered name and cart line, if there is one. */
export function paintRemembered() {
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); } catch { seen = null; }
  if (!seen || typeof seen.user !== 'string' || !VALID_NAME.test(seen.user)) return;

  state.user = seen.user;
  renderIdentity();
  renderCart();
  if (typeof seen.sum === 'string') $('#cartSum').textContent = seen.sum.slice(0, 60);
  reveal();
}

/** The session has answered: what is drawn from here on is the truth. */
export function settle() {
  settled = true;
  reveal();
}

function rememberSeen() {
  if (!settled) return;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ user: state.user, sum: $('#cartSum').textContent }));
  } catch { /* nothing to remember it in */ }
}

function cartCount() {
  if (!state.basket || !state.basket.packages) return 0;
  return state.basket.packages.reduce((t, p) => t + (p.quantity || 1), 0);
}

const items = (n) => `${n} item${n === 1 ? '' : 's'}`;

/**
 * Runs a basket change and takes whatever Tebex says as the truth.
 *
 * `opts.rollback` is the basket as it was before an optimistic change, and is
 * put back if the call fails — so a cart that showed an item optimistically
 * does not keep showing it once the server has said no. Passed inside an object
 * because `null` is a real basket state (an empty one) and could not otherwise
 * be told apart from "no rollback wanted".
 */
function basketCall(run, okMsg, opts) {
  return run().then((res) => {
    state.basket = res && res.basket ? res.basket : null;
    renderCart();
    if (okMsg) toast(okMsg);
  }).catch((err) => {
    if (opts && 'rollback' in opts) {
      state.basket = opts.rollback;
      renderCart();
    }
    if (err && err.need === 'account') { openLogin(); return; }
    toast(err && err.message ? err.message : 'That did not work.');
  });
}

/** The card for a package, by id. */
function cardOf(id) {
  const key = (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id);
  return document.querySelector(`[data-package-modal="${key}"]`);
}

/**
 * What the cart can show for a package before Tebex has answered.
 *
 * Read off the card that was clicked rather than fetched, because the page was
 * rendered with the name, price and artwork already on it.
 */
function cardFacts(id) {
  const el = cardOf(id);
  if (!el) return null;

  const price = Number(el.dataset.packagePrice);
  return {
    name: el.dataset.packageName || '',
    image: el.dataset.packageArt || null,
    price: Number.isFinite(price) ? price : 0,
  };
}

/**
 * Draws the change now, before the network has agreed to it.
 *
 * Every cart action is a round trip from the browser to our origin to Tebex and
 * back — about 300ms, and roughly double that on the first one because the
 * basket has to be created before anything can go in it. Waiting for all of
 * that before drawing anything is what makes a cart feel slow.
 *
 * Only the quantity and the line itself are invented. Totals are not: the price
 * of a NEW line at quantity one is the card's own price and is therefore real,
 * but anything beyond that would be this page computing money, which is exactly
 * what it must not do. The total is dimmed instead until the real one lands.
 */
function optimistic(id, delta) {
  const facts = cardFacts(id);
  if (!facts) return false;

  if (!state.basket) {
    state.basket = {
      username: state.user, packages: [], total: null, currency: null,
    };
  }

  const line = state.basket.packages.find((p) => String(p.id) === String(id));
  if (line) {
    const next = (line.quantity || 1) + delta;
    if (next <= 0) {
      state.basket.packages = state.basket.packages.filter(
        (p) => String(p.id) !== String(id));
    } else {
      line.quantity = next;
    }
  } else if (delta > 0) {
    state.basket.packages.push({
      id, name: facts.name, image: facts.image, quantity: 1, price: facts.price,
    });
  }

  state.basket.pending = true;
  renderCart();
  return true;
}

/* ------------------------------ drawing ----------------------------- */

/* The package cards are the server's, but what is in the cart is per session.
   Each card carries a hidden stepper beside its button; this shows whichever
   of the two matches the basket, from the same mirror the drawer is drawn
   from, so the card and the cart can never disagree. */
function syncCards() {
  const lines = (state.basket && state.basket.packages) || [];
  document.querySelectorAll('[data-card-qty]').forEach((box) => {
    const id = box.getAttribute('data-card-qty');
    const line = lines.find((l) => String(l.id) === String(id));
    const add = box.parentElement.querySelector('[data-add]');
    box.hidden = !line;
    if (add) add.hidden = Boolean(line);
    if (line) box.querySelector('output').textContent = String(line.quantity || 1);
  });
}

/* A face that falls back to the next skin provider if one 404s - see
   watchSkins(). The local Steve is the guest, and needs no fallback. */
function face(name) {
  return name
    ? `<img draggable="false" src="${esc(skinSrc(name, 'avatar', 64))}" data-mc="${esc(name)}" data-kind="avatar" data-size="64" alt="">`
    : `<img draggable="false" src="${STEVE}" alt="">`;
}

export function renderIdentity() {
  $('#guestName').textContent = state.user || 'Guest';
  $('#loginLbl').innerHTML = state.user ? 'Change<span class="lg"> account</span>' : 'Login';
  $('#logout').hidden = !state.user;

  /* Replaced, not re-pointed: an <img> that already walked to a fallback
     provider would otherwise carry that step over to the next account. */
  const fresh = document.createElement('div');
  fresh.innerHTML = face(state.user);
  fresh.firstChild.id = 'guestHead';
  $('#guestHead').replaceWith(fresh.firstChild);

  /* The same two facts on the phone's bottom bar. */
  $('#dockName').textContent = state.user || 'Guest';
  fresh.innerHTML = face(state.user);
  fresh.firstChild.id = 'dockHead';
  $('#dockHead').replaceWith(fresh.firstChild);
}

export function renderCart() {
  const n = cartCount();
  const basket = state.basket;

  /* The currency Tebex is actually going to bill in.
   *
   * It is not necessarily the one the catalogue was priced in: Tebex decides a
   * basket's currency from the buyer's country, and the catalogue is quoted in
   * the store's own. Read from the basket, or the cart would format every
   * amount with the wrong symbol in front of it - the one thing a store must
   * never do. */
  if (basket && basket.currency) setCurrency(basket.currency);

  /* Dimmed, not recomputed, while a change is in flight. The line went in
     optimistically; the money has to come from Tebex, so it says "working on
     it" rather than a number this page made up. */
  const known = basket && basket.total != null;
  const total = !n ? '' : (known ? esc(money(basket.total)) : '&hellip;');
  const totalHtml = basket && basket.pending ? `<span class="pending">${total}</span>` : total;

  $('#cartSum').innerHTML = n ? `${items(n)} · ${totalHtml}` : items(0);
  /* An empty cart is the resting state, so the half stays grey; the gold is
     what should catch the eye the moment something lands in it. */
  $('#dockCount').textContent = String(n);
  $('#dockCart').classList.toggle('filled', n > 0);
  $('#dCount').textContent = items(n);
  rememberSeen();
  syncCards();

  const who = $('#dWho');
  who.hidden = !state.user;
  who.innerHTML = state.user
    ? `${face(state.user)}<span>Delivering to <b>${esc(state.user)}</b></span><button data-act="login">Change</button>`
    : '';

  const body = $('#dBody');
  const foot = $('#dFoot');

  /* Cleared on every path that is not a populated cart: the footer lives
     outside the list and would otherwise keep showing the total of a cart that
     has since been emptied or signed out of. */
  foot.innerHTML = '';

  if (!state.user) {
    body.innerHTML = '<div class="empty">'
      + `<img draggable="false" src="${STEVE_BODY}" alt="">`
      + '<h3>Looks like you&#39;re not signed in yet!</h3>'
      + '<p>You&#39;ll need to sign in to add items to your cart.</p>'
      + '<button class="btn-y" data-act="login">Enter your username</button></div>';
    return;
  }

  if (n === 0) {
    body.innerHTML = '<div class="empty">'
      + `<img draggable="false" src="${EMPTY_ART}" alt="">`
      + '<h3>Looks like your cart is empty!</h3>'
      + '<p>Add some items to get started.</p>'
      + '<button class="btn-y" data-act="shop">Browse the store</button></div>';
    return;
  }

  /* The line's own price is the one Tebex quoted for that quantity.
     Multiplying a unit price here would be this page inventing a total. */
  body.innerHTML = basket.packages.map((line) => '<div class="cline">'
    + `<img draggable="false" src="${esc(line.image || EMPTY_ART)}" alt="">`
    + `<div><b>${esc(line.name)}</b><small>${esc(money(line.price))}</small></div>`
    + '<div class="qty">'
    /* At one, taking one away removes the line - so the button says so, with
       a bin instead of a minus. */
    + ((line.quantity || 1) <= 1
      ? `<button class="bin" data-dec="${esc(line.id)}" aria-label="Remove ${esc(line.name)} from the cart" title="Remove">${BIN}</button>`
      : `<button data-dec="${esc(line.id)}" aria-label="One fewer">−</button>`)
    + `<output>${line.quantity || 1}</output>`
    + `<button data-inc="${esc(line.id)}" aria-label="One more">+</button>`
    + '</div></div>').join('');

  foot.innerHTML = `<div class="dtot"><span>Total</span><b>${totalHtml}</b></div>`
    + '<button class="checkout" data-act="checkout">CHECKOUT</button>'
    + '<p class="fine">Payments are processed securely by Tebex.</p>';
}

/* ----------------------------- overlays ---------------------------- */

export function openCart() {
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
}

export function closeCart() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('open');
}

function closeModal() {
  $('#modal').classList.remove('open');
  $('#modal').setAttribute('aria-hidden', 'true');
}

function openModal(html) {
  const box = $('#modalBox');
  box.innerHTML = html;
  $('#modal').classList.add('open');
  $('#modal').setAttribute('aria-hidden', 'false');
  const input = box.querySelector('input');
  if (input) input.focus();
}

const CLOSE = '<button class="x" data-act="close" aria-label="Close">✕</button>';

const BIN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

/* A list that arrives as an attribute. Parsed defensively: a malformed one
   must not take the whole pop-up down with it. */
function listFrom(el, attr) {
  try {
    const value = JSON.parse(el.getAttribute(attr) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function openInfo(card) {
  const d = card.dataset;
  const includes = listFrom(card, 'data-package-includes');
  const about = listFrom(card, 'data-package-description');

  openModal(
    `<div class="mh"><h2>${esc(d.packageName || 'Package')}</h2>${CLOSE}</div>`
    + `<div class="pinfo"><img draggable="false" src="${esc(d.packageArt || EMPTY_ART)}" alt=""><div>`
    + (d.packageExtra ? `<div class="extra"><span>${esc(d.packageExtra)}</span></div>` : '')
    + (d.packageSummary ? `<div style="color:var(--ink-3);margin-top:6px">${esc(d.packageSummary)}</div>` : '')
    + (includes.length ? `<ul>${includes.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>` : '')
    + `<div class="price2">${esc(money(Number(d.packagePrice)))}</div></div></div>`
    + (about.length ? `<div class="pdesc">${about.map((line) => `<p>${esc(line)}</p>`).join('')}</div>` : '')
    + `<div class="mbuy"><button class="add" style="flex:1" data-add="${esc(d.packageModal)}">Add to Cart</button></div>`,
  );
}

let previewTimer;

export function openLogin() {
  closeCart();
  openModal(
    `<div class="mh"><h2>Login to ${esc(storeName())}</h2>${CLOSE}</div>`
    + '<form class="lbox" id="loginForm" novalidate>'
    + `<img draggable="false" id="loginBody" src="${STEVE_BODY}" alt="">`
    + '<div><label for="userInput">Enter your username</label>'
    + `<input id="userInput" maxlength="16" autocomplete="off" spellcheck="false" value="${esc(state.user || '')}" placeholder="e.g. Herobrine">`
    + '<button class="go">CONTINUE TO STORE</button><div class="err" id="loginErr" role="alert"></div></div></form>'
    + '<div class="mnote"><h3>What is my Minecraft username?</h3>'
    + '<p>Your username is the name you appear as on a Minecraft server. If you don&#39;t know what your username is, then please refer to the Minecraft launcher. Towards the top corner it will say your Minecraft name. Remember, usernames cannot contain spaces or special characters, except for underscores.</p></div>',
  );

  /* Live-preview the skin as they type, so a mistyped name shows as somebody
     else's face before it becomes somebody else's purchase. */
  $('#userInput').addEventListener('input', function onType() {
    const v = this.value.trim();
    $('#loginErr').textContent = '';
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const img = $('#loginBody');
      if (!img) return;
      if (VALID_NAME.test(v)) {
        img.dataset.mc = v;
        img.dataset.kind = 'body';
        img.dataset.size = '260';
        img.dataset.step = '0';
        img.src = skinSrc(v, 'body', 260);
      } else {
        delete img.dataset.mc;
        img.src = STEVE_BODY;
      }
    }, 450);
  });

  $('#loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#userInput').value.trim();
    if (!VALID_NAME.test(v)) {
      $('#loginErr').textContent = 'Enter a valid username (3-16 letters, numbers or underscores).';
      return;
    }
    signIn(v);
  });
}

/* ------------------------------ actions ---------------------------- */

/* A copy, not the live object, so rolling back cannot hand back something an
   optimistic edit has already mutated. */
function snapshot() {
  return state.basket ? JSON.parse(JSON.stringify(state.basket)) : null;
}

function addToCart(id) {
  if (!state.user) { pendingAdd = id; openLogin(); return; }

  const facts = cardFacts(id);
  const rollback = snapshot();
  optimistic(id, 1);
  basketCall(() => api.add(id, 1),
    facts && facts.name ? `${facts.name} added to cart` : 'Added to cart', { rollback });
}

/* Tebex has no decrement, only add and remove-the-line. Going down by one
   is therefore remove-then-re-add at the lower quantity, and going to zero
   is just the remove. */
function setQty(id, delta) {
  const line = ((state.basket && state.basket.packages) || [])
    .find((p) => String(p.id) === String(id));
  if (!line) return undefined;

  const next = (line.quantity || 1) + delta;

  const rollback = snapshot();
  optimistic(id, delta);

  if (delta > 0) return basketCall(() => api.add(id, 1), undefined, { rollback });
  if (next <= 0) return basketCall(() => api.remove(id), undefined, { rollback });
  return basketCall(
    () => api.remove(id).then(() => api.add(id, next)), undefined, { rollback });
}

function signIn(name) {
  const go = $('#loginForm .go');
  if (go) go.disabled = true;

  api.setAccount(name, state.edition || 'java').then(() => {
    state.user = name;
    closeModal();
    renderIdentity();
    toast(`Signed in as ${name}`);
    return basketCall(() => api.basket());
  }).then(() => {
    if (!pendingAdd) return;
    const id = pendingAdd;
    pendingAdd = null;
    addToCart(id);
  }).catch((err) => {
    if (go) go.disabled = false;
    const message = err && err.message ? err.message : 'That username was not accepted.';
    const slot = $('#loginErr');
    if (slot) slot.textContent = message; else toast(message);
  });
}

function signOut() {
  /* The server drops the name AND the basket, because a basket belongs to the
     account it was made for. Only clear the page once that has actually
     happened - clearing first would show "signed out" over a session still
     holding somebody's name and their items. */
  api.logout().then(() => {
    state.user = null;
    state.basket = null;
    pendingAdd = null;
    renderIdentity();
    renderCart();
    toast('Signed out');
  }).catch((err) => {
    toast(err && err.message ? err.message : 'Could not sign out.');
  });
}

/* The one URL the browser is allowed to leave for. It is a one-shot address
   for this basket, not a credential - see the server's README. */
function checkout(button) {
  if (button) button.disabled = true;
  const failed = (message) => {
    if (button) button.disabled = false;
    toast(message || 'Checkout is unavailable right now.');
  };

  api.checkout().then((res) => {
    if (!res) { failed(); return; }

    /* Minecraft baskets must pass Tebex's own account check before payment -
       that is what stops a rank being bought onto an account you do not own.
       When Tebex asks for it the server sends the links back under `auth`,
       and the buyer has to complete that before there is a checkout page. */
    if (Array.isArray(res.auth) && res.auth.length) {
      window.location.href = res.auth[0];
      return;
    }

    if (res.checkout) { window.location.href = res.checkout; return; }
    failed();
  }).catch((err) => {
    if (err && err.need === 'account') {
      if (button) button.disabled = false;
      openLogin();
      return;
    }
    failed(err && err.message);
  });
}

/** One delegated listener for everything the cart owns. */
export function initCart() {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t === $('#modal')) { closeModal(); return; }

    const add = t.closest('[data-add]');
    if (add) {
      if (t.closest('#modalBox')) closeModal();
      addToCart(add.getAttribute('data-add'));
      return;
    }

    const info = t.closest('[data-package-info]');
    if (info) { openInfo(info.closest('[data-package-modal]')); return; }

    const inc = t.closest('[data-inc]');
    if (inc) { setQty(inc.getAttribute('data-inc'), 1); return; }

    const dec = t.closest('[data-dec]');
    if (dec) { setQty(dec.getAttribute('data-dec'), -1); return; }

    if (t.closest('#cartBtn') || t.closest('#dockCart')) { openCart(); return; }
    if (t.closest('#dockWho')) { openLogin(); return; }
    if (t.closest('#dClose') || t.closest('#scrim')) { closeCart(); return; }
    if (t.closest('#login')) { openLogin(); return; }
    if (t.closest('#logout')) { signOut(); return; }

    const act = t.closest('[data-act]');
    if (!act) return;

    switch (act.dataset.act) {
      case 'login': openLogin(); break;
      case 'close': closeModal(); pendingAdd = null; break;
      case 'checkout': checkout(act); break;
      case 'shop': {
        closeCart();
        const packs = document.querySelector('.packs');
        if (packs) packs.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
      default:
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closeCart(); }
  });
}
