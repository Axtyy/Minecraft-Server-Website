/**
 * The storefront's interactivity, and only that.
 *
 * The catalogue and its package cards are rendered by the server
 * (lib/render/store.js) and arrive with the document. What is left is the part
 * that genuinely belongs in the browser: the cart drawer, which is
 * per-session and opens on a click.
 *
 * Nothing here does arithmetic on money. Every price shown was quoted by the
 * catalogue; a price the server did not quote is a price nobody will honour
 * at checkout.
 */
import '../styles/site.css';
import { api } from '../lib/api.js';
import { toast, setCurrency } from '../lib/util.js';
import { watchSkins } from '../lib/skins.js';
import { initChrome } from '../lib/chrome.js';
import {
  state, initCart, renderCart, renderIdentity, openCart, paintRemembered, settle,
} from '../lib/cart.js';

watchSkins();
initChrome();
initCart();
/* Whoever was here last time, straight away; the session corrects it below. */
renderCart();
paintRemembered();

/* The countdown on a limited-time offer. The server drew it correct for the
   moment the page was built; this keeps it honest while the tab stays open. */
const clock = document.querySelector('[data-ends]');
if (clock) {
  const ends = Number(clock.dataset.ends);
  const set = (id, value) => {
    const cell = clock.querySelector(`[data-cd="${id}"]`);
    if (cell) cell.textContent = String(value);
  };
  const tick = () => {
    const left = Math.max(0, Math.floor((ends - Date.now()) / 1000));
    set('d', Math.floor(left / 86400));
    set('h', Math.floor((left % 86400) / 3600));
    set('m', Math.floor((left % 3600) / 60));
  };
  tick();
  setInterval(tick, 30_000);
}

/* The two things the page cannot be told at render time: who is signed in
   (per-session, so it must never be baked into a cached document) and the
   currency the cart formats a fetched basket in. */
Promise.all([
  api.session().catch(() => ({})),
  api.basket().catch(() => ({ basket: null })),
]).then(([session, basket]) => {
  if (session.currency) setCurrency(session.currency);
  state.user = session.account ? session.account.username : null;
  state.edition = (session.account && session.account.edition) || 'java';
  state.basket = basket.basket || null;

  settle();
  renderIdentity();
  renderCart();

  /* Completion and cancellation land on /purchase now, which shows the order
     itself rather than a toast over the shop. The two old parameters are still
     understood so a link somebody kept open still says something sensible. */
  const done = new URLSearchParams(location.search).get('purchase');
  if (done === 'complete') {
    toast('Thank you! Your purchase is on its way in game.');
    state.basket = null;
    renderCart();
    history.replaceState({}, '', location.pathname);
  } else if (done === 'cancelled') {
    toast('Checkout cancelled - your basket is still here.');
    history.replaceState({}, '', location.pathname);
  } else if (location.search.includes('cart=open')) {
    openCart();
  }
});
