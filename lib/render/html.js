'use strict';
/**
 * The shared pieces every server-side renderer needs.
 *
 * These render HTML on the server so a page arrives already drawn. The browser
 * is no longer sent a pile of JSON and a renderer to turn it into a page — it
 * is sent the page.
 */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

/* Formatted, never converted. Tebex bills in the store's own currency, so a
 * page that converted would show one number and charge another. */
let fmt = null;
let fmtFor = null;

function money(value) {
  const code = process.env.STORE_CURRENCY || 'USD';
  if (!fmt || fmtFor !== code) {
    fmtFor = code;
    try {
      fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    } catch {
      fmt = { format: (x) => `${x.toFixed(2)} ${code}` };
    }
  }
  return fmt.format(Number(value) || 0);
}

/* -------------------- minecraft skin render api --------------------
 * Provider choice is deliberate — see docs. minotar.net is primary for flat
 * heads (tiny, resolves plain usernames, CORS: *), nmsr for 3D bodies,
 * mc-heads is fallback only.
 *
 * The server emits the PRIMARY url in `src` so the head loads without any
 * JavaScript at all. The data- attributes are only there so the client can
 * walk to the next provider if that one 404s. */
function skinURL(name, kind, size, uuid, step = 0) {
  const ref = encodeURIComponent(uuid || name);
  const n = encodeURIComponent(name);
  if (kind === 'body') {
    if (step === 0) return `https://nmsr.nickac.dev/fullbodyiso/${ref}`;
    if (step === 1) return `https://minotar.net/body/${ref}/${size}`;
    return `https://mc-heads.net/body/${n}/${size}`;
  }
  if (step === 0) return `https://minotar.net/helm/${ref}/${size}`;
  return `https://mc-heads.net/avatar/${n}/${size}`;
}

function skinTag(name, kind, size, cls, alt, uuid) {
  return `<img draggable="false" class="${esc(cls || '')}" src="${esc(skinURL(name, kind, size, uuid))}"`
    + ` data-mc="${esc(name)}"${uuid ? ` data-uuid="${esc(uuid)}"` : ''}`
    + ` data-kind="${esc(kind)}" data-size="${esc(String(size))}"`
    + ` alt="${esc(alt || '')}" loading="lazy">`;
}

/** A player's face, at the size every list on the site draws it. */
const head = (name, uuid, size = 64) => skinTag(name, 'avatar', size, '', '', uuid);

const num = (n) => (Number(n) || 0).toLocaleString('en-US');

/** "2 hours ago", from an epoch-ms instant. Coarse on purpose. */
function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - Number(at)) / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo === 1 ? 'a month ago' : `${mo} months ago`;
  const y = Math.floor(d / 365);
  return y <= 1 ? 'a year ago' : `${y} years ago`;
}

module.exports = {
  esc, money, skinURL, skinTag, head, num, ago,
};
