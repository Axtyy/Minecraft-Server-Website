/**
 * Minecraft skin renders.
 *
 * Anything the SERVER renders already has its primary URL in `src`, so heads
 * are on screen without JavaScript; `watchSkins()` is only the fallback that
 * walks to the next provider when one 404s.
 *
 * The builders below are for the parts still drawn in the browser — the cart
 * drawer and the login preview — which are per-session and open on a click.
 *
 * Provider order is deliberate and was tested against this store's own
 * accounts: minotar.net primary for flat heads (tiny, resolves plain
 * usernames, CORS: *), nmsr.nickac.dev for 3D bodies, mc-heads.net last
 * because it serves the DEFAULT skin for some real accounts.
 */

export function skinSrc(name, kind, size, uuid, step = 0) {
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

const attr = (s) => String(s).replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

export function skinImg(name, kind, size, cls, alt, uuid) {
  return `<img draggable="false" class="${attr(cls || '')}" src="${attr(skinSrc(name, kind, size, uuid))}"`
    + ` data-mc="${attr(name)}"${uuid ? ` data-uuid="${attr(uuid)}"` : ''}`
    + ` data-kind="${attr(kind)}" data-size="${attr(size)}" alt="${attr(alt || '')}" loading="lazy">`;
}

/** Point an existing <img> at a skin, replacing it so no stale src lingers. */
export function setSkin(id, name, kind, size, cls, uuid) {
  const old = document.getElementById(id);
  if (!old) return;
  const fresh = document.createElement('img');
  fresh.id = id;
  if (cls) fresh.className = cls;
  fresh.alt = name;
  fresh.draggable = false;
  fresh.dataset.mc = name;
  if (uuid) fresh.dataset.uuid = uuid;
  fresh.dataset.kind = kind;
  fresh.dataset.size = String(size);
  fresh.src = skinSrc(name, kind, size, uuid);
  old.replaceWith(fresh);
}

/** Swap a live <img> to a different skin without rebuilding the node id. */
export function swapSkin(img, name) {
  if (!img) return;
  img.dataset.mc = name;
  img.dataset.step = '0';
  img.removeAttribute('data-uuid');
  img.src = skinSrc(name, img.dataset.kind || 'avatar', img.dataset.size || '64');
}

/**
 * One delegated listener for every skin image on the page, server-rendered or
 * not. `error` does not bubble, so this listens in the capture phase.
 */
export function watchSkins() {
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.dataset.mc) return;

    const step = Number(img.dataset.step || 0) + 1;
    if (step > 2) return;
    img.dataset.step = String(step);
    img.src = skinSrc(img.dataset.mc, img.dataset.kind || 'avatar',
      img.dataset.size || '64', img.dataset.uuid, step);
  }, true);
}
