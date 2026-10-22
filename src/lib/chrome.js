/**
 * What is left of the page chrome once the server renders it.
 *
 * The nav, the banner and the footer are HTML by the time they reach the
 * browser (lib/render/chrome.js), so there is no config to fetch and no moment
 * where the header is blank. This is only the behaviour that needs a browser:
 * copying the address, and the night / day switch.
 */
import { toast } from './util.js';

/* The domain every hostname of the site shares: store.example.com and
   stats.example.com both give example.com. Nothing for localhost or a bare
   address, where there is no parent to share with. */
function sharedDomain() {
  const host = location.hostname;
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return '';
  return host.split('.').slice(-2).join('.');
}

/* Remembered in a cookie on the shared domain, so the look chosen on the store
   is the look on the stats and the main site too - browser storage is per
   hostname and each one used to keep its own answer. Also written to storage,
   which /assets/look.js falls back to when cookies are off.

   Either can throw - private windows, blocked site data. The switch still
   works for the page in front of you; it just is not remembered. */
function remember(key, value) {
  try {
    const domain = sharedDomain();
    document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`
      + (domain ? `; Domain=.${domain}` : '')
      + (location.protocol === 'https:' ? '; Secure' : '');
  } catch { /* no cookies */ }
  try { localStorage.setItem(key, value); } catch { /* this page only */ }
}

/* The browser's own chrome follows the look, so the bar above the page on a
   phone is the colour of the page under it. */
function paintMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0d1029';
}

/* Night / day. Already applied by /assets/look.js before first paint; this is
   the button. */
function initLook() {
  const root = document.documentElement;
  paintMeta();

  const look = document.getElementById('lookBtn');
  if (look) {
    look.addEventListener('click', () => {
      const sky = root.dataset.look !== 'sky';
      if (sky) root.dataset.look = 'sky'; else delete root.dataset.look;
      remember('bb-look', sky ? 'sky' : 'night');
      paintMeta();
    });
  }

}

function copy(text) {
  /* clipboard is unavailable over plain http on anything but localhost, so
     the fallback has to actually work rather than just apologise. */
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  }

  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.style.cssText = 'position:fixed;top:-100px;opacity:0';
  document.body.appendChild(scratch);
  scratch.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  scratch.remove();
  return Promise.resolve(ok);
}

export function initChrome() {
  initLook();

  /* Blocks the drag-to-save gesture on every image, including any added to
     the DOM after load. Text selection dragging is left alone. */
  document.addEventListener('dragstart', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'IMG' || (t.querySelector && t.querySelector('img')))) {
      e.preventDefault();
    }
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy-ip]');
    if (!btn) return;

    const ip = btn.getAttribute('data-copy-ip');
    if (!ip) return;

    /* The label does not change: swapping the address for COPIED would resize
       the button under the cursor that just clicked it. The toast carries the
       wording, and says the address either way so it can be typed by hand. */
    copy(ip).then((ok) => toast(ok ? `Copied ${ip}` : `Server IP: ${ip}`));
  });
}
