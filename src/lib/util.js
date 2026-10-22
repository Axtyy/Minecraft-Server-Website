/** The small shared helpers. Everything here is pure except toast(). */

export const $ = (sel, root = document) => root.querySelector(sel);

/* Every value interpolated into an innerHTML string goes through this.
   Player names, ban reasons and staff names all come from SolarBans, and
   a punishment list is exactly where somebody would try to put a <script>. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

/* Formatted, never converted.
   An older build multiplied by a hardcoded rate table and appended a
   different currency code. Tebex bills in the store's own currency, so
   that showed one number and charged another - the one bug in a store
   nobody forgives. Prices are whatever the API quoted. */
let fmt = null;
let currency = 'USD';

export function setCurrency(code) {
  if (!code || code === currency) return;
  currency = code;
  fmt = null;
}

export function money(value) {
  const v = Number(value) || 0;
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    } catch {
      fmt = { format: (x) => `${x.toFixed(2)} ${currency}` };
    }
  }
  return fmt.format(v);
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
