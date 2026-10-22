'use strict';
/**
 * How many people are on the server, asked of the server itself.
 *
 * This is the Server List Ping every Minecraft client makes before it shows
 * you a row in its server list: a TCP handshake, a status request, and a JSON
 * blob back. No third-party status API sits in the middle, so nothing about
 * the count depends on a service we do not run, and the answer is the same one
 * the game client would print.
 *
 * <h2>Nothing here is ever awaited by a page</h2>
 * current() is synchronous and returns the last answer we got. A ping older
 * than the refresh window starts a new one in the background and the caller
 * still gets the previous value immediately. A server that is down, firewalled
 * or simply slow therefore costs a visitor nothing — the worst case is a count
 * half a minute stale, and the worst case after that is no count at all.
 *
 * <h2>Never having answered is not the same as answering "offline"</h2>
 * If this process cannot reach the server, that is very often a fact about
 * this process — a container without a route, a firewall, a wrong port — and
 * not a fact about the server, which players may be perfectly happy on. So an
 * address that has never once answered renders as no count and no dot rather
 * than as OFFLINE, which would be a confident lie. Only an address that has
 * answered before earns a dot that is allowed to go dark.
 */
const net = require('node:net');
const dns = require('node:dns').promises;

require('./env');
const log = require('./log');

const DEFAULT_PORT = 25565;

/* Long enough that a slow server still answers, short enough that a black hole
   does not hold a socket open across several page loads. The ping is off the
   request path either way, so this only bounds the wasted socket. */
const TIMEOUT_MS = 3000;

/* One ping per this window, however many people are reading the site. */
const REFRESH_MS = Number(process.env.STORE_STATUS_MS || 30_000);

/* -------------------------------------------------------------- the address
 *
 * STORE_SERVER_IP is what we print, and usually what we ping. The two are
 * allowed to differ: the printed address is a domain with an SRV record, or a
 * proxy hostname that only resolves publicly, and the site may need to reach
 * the same server on an internal name instead. STORE_STATUS_HOST is that
 * override, and blank means "ping what we print".
 */
function target() {
  const raw = (process.env.STORE_STATUS_HOST || process.env.STORE_SERVER_IP || '').trim();
  if (!raw) return null;

  /* host:port, host, or a bracketed IPv6. A port written into the address is
     explicit, so it wins over both the env var and any SRV record. */
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(raw);
  let host = raw;
  let port = null;

  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] ? Number(bracketed[2]) : null;
  } else if (raw.split(':').length === 2) {
    const [h, p] = raw.split(':');
    if (/^\d+$/.test(p)) { host = h; port = Number(p); }
  }

  const envPort = Number(process.env.STORE_STATUS_PORT || 0);
  return { host, port: port || envPort || null };
}

/**
 * The SRV record a domain may point at, looked up the way a real client does.
 *
 * Only consulted when no port was given anywhere: a port somebody wrote down
 * is a decision, and an SRV record is only a default.
 */
async function locate(host, port) {
  if (port) return { host, port };
  try {
    const rows = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (rows && rows.length) return { host: rows[0].name, port: rows[0].port };
  } catch {
    /* No SRV record is the normal case for a plain A record or a bare IP. */
  }
  return { host, port: DEFAULT_PORT };
}

/* ---------------------------------------------------------------- protocol */

function varInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

/** Reads a VarInt. undefined means "not all of it has arrived yet". */
function readVarInt(buf, offset) {
  let num = 0;
  let shift = 0;
  let pos = offset;

  while (pos < buf.length) {
    const b = buf[pos];
    pos += 1;
    num |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: num >>> 0, size: pos - offset };
    shift += 7;
    if (shift >= 35) return null;
  }
  return undefined;
}

/** A framed packet: [length][id][payload]. */
const packet = (id, payload) => {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
};

const mcString = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(b.length), b]);
};

const uShort = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};

/**
 * One ping.
 *
 * Protocol version -1 is the documented "I am not telling you" value. A server
 * answers a status request whatever version asks, which is what makes this
 * safe to leave alone across game updates.
 */
function ping(host, port) {
  return new Promise((ok, fail) => {
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) fail(err); else ok(value);
    };

    sock.setTimeout(TIMEOUT_MS);
    sock.on('timeout', () => finish(new Error('timed out')));
    sock.on('error', (err) => finish(err));
    sock.on('close', () => finish(new Error('closed before answering')));

    sock.on('connect', () => {
      const handshake = packet(0x00, Buffer.concat([
        varInt(-1), mcString(host), uShort(port), varInt(1),
      ]));
      /* Both packets in one write: the status request is legal to send
         immediately and this saves a round trip. */
      sock.write(Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))]));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      /* The reply is bigger than one TCP segment on any real server — the MOTD
         and a base64 favicon see to that — so this runs several times and
         returns until the whole frame has arrived. */
      const len = readVarInt(buf, 0);
      if (len === undefined) return;
      if (len === null) { finish(new Error('malformed reply')); return; }
      if (buf.length < len.size + len.value) return;

      const id = readVarInt(buf, len.size);
      if (!id || id.value !== 0x00) { finish(new Error('unexpected reply')); return; }

      const at = len.size + id.size;
      const strLen = readVarInt(buf, at);
      if (!strLen) { finish(new Error('malformed reply')); return; }

      const from = at + strLen.size;
      const json = buf.subarray(from, from + strLen.value).toString('utf8');
      try {
        finish(null, JSON.parse(json));
      } catch {
        finish(new Error('reply was not JSON'));
      }
    });
  });
}

/* ------------------------------------------------------------------- state */

/* `ever` is what separates "we have never reached it" from "it is down", and
   the nav renders those two differently. See the note at the top. */
let last = { ok: false, ever: false, players: 0, max: 0 };
let at = 0;
let running = null;

/** One ping in flight at a time, shared by everyone who asks for it. */
function refresh() {
  if (running) return running;

  const t = target();
  if (!t) return Promise.resolve(last);

  at = Date.now();
  running = locate(t.host, t.port)
    .then(({ host, port }) => ping(host, port))
    .then((data) => {
      const players = Number(data && data.players && data.players.online);
      last = {
        ok: true,
        ever: true,
        players: Number.isFinite(players) ? players : 0,
        max: Number(data && data.players && data.players.max) || 0,
      };
      return last;
    })
    .catch((err) => {
      /* Logged on the way down, not on every ping after it: a server that is
         off for an hour would otherwise write two lines a minute. */
      if (last.ok || !last.ever) log.warn(`Status ping failed: ${err.message}`);
      last = { ...last, ok: false };
      return last;
    })
    .finally(() => { running = null; });

  return running;
}

/**
 * The last answer, now.
 *
 * Synchronous on purpose — this is read while a page is being written out, and
 * a header must never wait on a game server. A stale value starts the next
 * ping and is returned anyway.
 */
function current() {
  if (!target()) return { configured: false, ok: false, ever: false, players: 0, max: 0 };
  if (Date.now() - at >= REFRESH_MS) refresh();
  return { configured: true, ...last };
}

const configured = () => Boolean(target());

module.exports = { current, refresh, configured };
