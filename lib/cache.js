'use strict';
/**
 * A tiny in-process cache for upstream reads.
 *
 * The catalogue is the same for every visitor and changes when someone edits it
 * in the Tebex panel, not per request. Without this, a busy storefront makes one
 * Tebex call per page load and spends its rate limit on an answer it already
 * had.
 *
 * Single-flight matters as much as the caching: on a cold cache, ten concurrent
 * visitors would otherwise start ten identical upstream calls. They share one.
 */
const entries = new Map();
const inflight = new Map();

async function through(key, ttlMs, produce) {
  const hit = entries.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const running = inflight.get(key);
  if (running) return running;

  const promise = (async () => {
    try {
      const value = await produce();
      entries.set(key, { value, until: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

const drop = (key) => entries.delete(key);
const clear = () => entries.clear();

module.exports = { through, drop, clear };
