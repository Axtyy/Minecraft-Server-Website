/**
 * Every call the page makes, and they all go to this origin.
 *
 * There is no Tebex URL anywhere in public/. If you find yourself adding one,
 * the endpoint belongs in server.js instead — the whole point of this store is
 * that the browser cannot reach Tebex directly and so has nothing worth stealing.
 */

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    // The session cookie is HttpOnly; the browser attaches it, we never read it.
    credentials: 'same-origin',
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const error = new Error(payload?.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.need = payload?.need;
    throw error;
  }
  return payload;
}

export const api = {
  session: () => call('GET', '/api/store/session'),
  setAccount: (username, edition) => call('POST', '/api/store/account', { username, edition }),
  basket: () => call('GET', '/api/store/basket'),
  add: (packageId, quantity = 1) =>
    call('POST', '/api/store/basket/packages', { package_id: packageId, quantity }),
  remove: (packageId) => call('DELETE', `/api/store/basket/packages/${packageId}`),
  logout: () => call('DELETE', '/api/store/account'),
  checkout: () => call('POST', '/api/store/checkout'),
};
