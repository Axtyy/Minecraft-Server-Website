'use strict';
/**
 * Client address handling.
 *
 * Two jobs, and they pull in opposite directions: Tebex wants the buyer's IP for
 * its own fraud checks, and our own audit log has no business keeping one. So
 * the full address goes upstream and only a truncated prefix is ever written to
 * a table we own.
 */

/** The caller's address, honouring X-Forwarded-For only when told to. */
function clientIp(req) {
  if (process.env.TRUST_PROXY === 'true') {
    /* Cloudflare's header first, and not only because it is tidier.
     *
     * Cloudflare OVERWRITES cf-connecting-ip on every request it forwards, so a
     * visitor cannot set it. It APPENDS to x-forwarded-for, so a visitor who
     * sends one of their own leaves it sitting in front of their real address —
     * and the first entry, which is the one everybody reads, is then whatever
     * they chose. That address decides the tax and currency Tebex quotes and
     * the key this process rate-limits on, so it has to be the real one.
     *
     * Both are only consulted when TRUST_PROXY says something in front is
     * setting them. Neither is worth anything if the origin can be reached
     * without going through Cloudflare — see docs/deploy for the firewall that
     * closes that off. */
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;

    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  const raw = req.socket.remoteAddress || '';
  // Node reports IPv4 over a dual-stack socket as ::ffff:1.2.3.4.
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * Truncates to a /24 (IPv4) or /48 (IPv6).
 *
 * Enough to spot one network hammering the store; not enough to identify a
 * household. This is what goes in solar_store_events.
 */
function prefix(ip) {
  if (!ip) return null;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : null;
  }
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean);
    return groups.length >= 3 ? `${groups.slice(0, 3).join(':')}::/48` : null;
  }
  return null;
}

module.exports = { clientIp, prefix };
