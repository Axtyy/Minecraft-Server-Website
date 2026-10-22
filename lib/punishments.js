'use strict';
/**
 * The public punishment list, read from SolarBans.
 *
 * Its own pool onto SolarBans' own database, because that is a different
 * schema owned by a different application. Sharing the store's pool would mean
 * one connection limit covering two unrelated workloads, and a slow ban lookup
 * starving a checkout.
 *
 * <h2>Read only, and narrower than the table</h2>
 * This service never writes here, and the credentials it is given should be
 * `SELECT` on this one table. The website is the least trusted thing that
 * touches the punishment record; it must not be able to alter one.
 *
 * <h2>What is deliberately never returned</h2>
 *
 *   - `target_ip`. It is not selected at all, so no bug downstream can leak
 *     it. A public ban list that publishes addresses is a public ban list that
 *     doxes people, and IP bans routinely catch shared connections.
 *   - `silent` punishments. Staff mark those precisely so they are not
 *     announced; putting them on the website undoes the one thing the flag is
 *     for.
 *   - rows with no `target_name`. An IP-only record has nobody to name, and
 *     showing it would either be blank or tempt somebody to fill the gap with
 *     the address.
 *   - `operator_uuid`, `removed_reason` and the notes: staff-facing detail
 *     that is not the public's business.
 */

const mysql = require('mysql2/promise');

require('./env');
const log = require('./log');

/* The four kinds the site filters by. SolarBans stores the specific type
 * (TEMPBAN, IPMUTE, …); the public list only cares which of the four it is,
 * and mapping here keeps that vocabulary out of the browser. */
const KIND = {
  BAN: 'BAN', TEMPBAN: 'BAN', IPBAN: 'BAN', TEMPIPBAN: 'BAN',
  MUTE: 'MUTE', TEMPMUTE: 'MUTE', IPMUTE: 'MUTE', TEMPIPMUTE: 'MUTE',
  WARN: 'WARN', KICK: 'KICK',
};

const TYPES = { BAN: 1, MUTE: 1, WARN: 1, KICK: 1 };

const PER_PAGE = 20;
const MAX_PAGES = 500;

/**
 * A page marker: the created_at and id of the last row you were shown.
 *
 * <p>Base64 of {@code created_at:id}, which is exactly what Pika's ban list
 * does and for the same two reasons.
 *
 * <p><b>It does not skip rows.</b> {@code OFFSET 200} makes the database walk
 * and discard two hundred rows before it returns anything, and that cost grows
 * with every page. A cursor is an index seek: page five hundred costs what page
 * one costs.
 *
 * <p><b>It does not shift under you.</b> With OFFSET, a ban issued while you
 * are reading page one pushes everything down, so page two repeats a row you
 * have already seen. The cursor names a position in the data rather than a
 * count from the top, so new rows appear at the front and the page you asked
 * for is the page you get.
 *
 * <p>Not a secret and not a capability: it encodes a timestamp and a row id
 * from a list anyone can already read. Base64 keeps it out of the way in a URL,
 * nothing more — it is decoded defensively and a malformed one is simply
 * ignored rather than trusted.
 */
function encodeCursor(row) {
  return Buffer.from(row.created_at + ':' + row.id, 'utf8').toString('base64url');
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const parts = Buffer.from(String(raw), 'base64url').toString('utf8').split(':');
    if (parts.length !== 2) return null;
    const at = Number(parts[0]);
    const id = Number(parts[1]);
    if (!Number.isFinite(at) || !Number.isFinite(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

function settings() {
  const url = process.env.PUNISHMENTS_DB_URL;
  if (url) {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
    };
  }
  return {
    host: process.env.PUNISHMENTS_DB_HOST || '',
    port: Number(process.env.PUNISHMENTS_DB_PORT || 3306),
    user: process.env.PUNISHMENTS_DB_USER || '',
    password: process.env.PUNISHMENTS_DB_PASSWORD || '',
    database: process.env.PUNISHMENTS_DB_NAME || 'solarbans',
  };
}

/** Unconfigured is a normal state, not an error: the page says so and moves on. */
function configured() {
  const s = settings();
  return Boolean(s.host && s.user);
}

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...settings(),
      charset: 'utf8mb4_unicode_ci',
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: true,
      timezone: 'Z',
      waitForConnections: true,
      connectionLimit: Number(process.env.PUNISHMENTS_DB_POOL || 2),
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return pool;
}

/* ----------------------------------------------------------- formatting */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stamp(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
    + ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * The expiry column, as the page reads it.
 *
 * <p>Three outcomes, kept apart on purpose:
 *
 *   - lifted by a person → "Unbanned by Steve". Somebody made a decision and
 *     the record should say so; "Expired" made an appeal look like the clock
 *     simply running out, which reads as though nothing was ever reviewed.
 *   - ran out on its own → "Expired".
 *   - still running → the date it ends, or "Never".
 *
 * The verb follows the punishment, so a mute reads "Unmuted by" and a warning
 * "Removed by" — "Unbanned by" on a warning is just wrong.
 */
const UNDONE = { BAN: 'Unbanned', MUTE: 'Unmuted', WARN: 'Removed', KICK: 'Removed' };

function expiry(row, now, kind) {
  if (!row.active) {
    return row.removed_by
      ? `${UNDONE[kind] || 'Removed'} by ${row.removed_by}`
      : 'Expired';
  }
  if (Number(row.expires_at) === -1) return 'Never';
  if (Number(row.expires_at) <= now) return 'Expired';
  return stamp(row.expires_at);
}

/**
 * Turns a name into the account that holds it, following renames.
 *
 * <p>SolarBans keeps every name an account has been known by in
 * {@code player_names}, so a name that has been abandoned still resolves to
 * the player who used it — which is the point: somebody searching the name
 * they remember should find the record, not a blank page.
 *
 * <p>The current name is checked first. A name that has been released and
 * re-registered belongs to whoever holds it now, and that is the answer a
 * search for it should give; only when nobody currently holds it does the
 * history decide.
 *
 * <p>Returns null when the name is unknown, which the caller treats as "search
 * the literal name" rather than "no results".
 */
async function resolveAccount(name) {
  const db = getPool();

  try {
    const [[current]] = await db.execute(
      'SELECT uuid, name FROM players WHERE name = ? LIMIT 1', [name]);
    if (current) {
      return { uuid: current.uuid, name: current.name };
    }

    /* Only a former name now. Newest holder first: the same name can appear in
       two accounts' histories if it was released and taken up again. */
    const [[past]] = await db.execute(
      `SELECT n.uuid, p.name
         FROM player_names n
         LEFT JOIN players p ON p.uuid = n.uuid
        WHERE n.name = ?
        ORDER BY n.last_seen DESC
        LIMIT 1`, [name]);

    return past ? { uuid: past.uuid, name: past.name || name } : null;
  } catch (err) {
    /* Missing grant, or a SolarBans schema older than player_names. Falling
       back to the literal name keeps the page working with the old behaviour
       instead of failing the request. */
    log.warn(`Could not resolve '${name}' to an account: ${err.message}`);
    return null;
  }
}

/** Every name this account has been known by, most recent first. */
async function namesFor(uuid) {
  try {
    const [rows] = await getPool().execute(
      `SELECT name FROM player_names WHERE uuid = ? ORDER BY last_seen DESC`, [uuid]);
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------- query */

/**
 * One page of punishments, newest first.
 *
 * Filtering and paging are done in SQL rather than by fetching everything and
 * slicing in Node: the table grows without limit, and "read it all, show ten"
 * is a query that works perfectly until the day it takes the site down.
 */
/* `q` as well as `query`: server.js calls this with `q`, which silently bound
 * nothing and left every free-text search running as though the box were
 * empty — so the page answered with the whole list and looked like it had
 * simply found a lot. Accepting both names is the fix that cannot regress. */
async function list({
  page = 1, type = 'ALL', query = '', q = '', player = '', after = '', side = 'received',
} = {}) {
  query = query || q;
  /* A player's record has two sides: what was done to them, and - for staff -
     what they did. Kept apart, so a moderator's page does not read as though
     they had been punished for every ban they handed out. */
  const given = side === 'given';

  if (!configured()) {
    return {
      configured: false, punishments: [], page: 1, pages: 0, total: 0, next: null,
      counts: { ALL: 0, BAN: 0, MUTE: 0, WARN: 0, KICK: 0 },
      stats: { records: 0, activeBans: 0, activeMutes: 0 }, player: null,
    };
  }

  /* The scope: what this request is looking at before the type chips narrow
     it further. Kept separate from the type clause so the chip counts can be
     taken over the same scope without the chips filtering themselves. */
  const scope = ['p.silent = 0', 'p.target_name IS NOT NULL'];
  const scopeParams = [];

  const name = String(player || '').trim().slice(0, 16);
  let account = null;

  if (name) {
    account = await resolveAccount(name);

    if (account) {
      /* Matched on the ACCOUNT, not the name.
       *
       * Every punishment stores a target_uuid, so this returns their whole
       * record no matter what they were called at the time. Matching
       * target_name instead split a renamed player's history in half: the rows
       * from before the rename sat under a name nobody would think to search,
       * and the rows after looked like a clean-ish record. */
      scope.push(given ? 'p.operator_uuid = ?' : 'p.target_uuid = ?');
      scopeParams.push(account.uuid);
    } else {
      // No account on record under that name. Fall back to the literal match
      // so a search still answers rather than silently returning nothing.
      scope.push(given ? 'p.operator_name = ?' : 'p.target_name = ?');
      scopeParams.push(name);
    }
  } else {
    const q = String(query || '').trim();
    if (q) {
      // Bounded so a pathological search cannot become a full-table scan.
      const like = `%${q.slice(0, 32).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      scope.push('(p.target_name LIKE ? OR p.operator_name LIKE ? OR p.reason LIKE ?)');
      scopeParams.push(like, like, like);
    }
  }

  const where = scope.slice();
  const params = scopeParams.slice();

  if (TYPES[type]) {
    /* Expanded to the stored types rather than matched with LIKE: 'BAN'
     * would otherwise also match IPBAN and TEMPIPBAN by accident, and
     * 'MUTE' would match nothing at all. */
    const stored = Object.keys(KIND).filter((k) => KIND[k] === type);
    where.push(`p.type IN (${stored.map(() => '?').join(',')})`);
    params.push(...stored);
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const scopeClause = `WHERE ${scope.join(' AND ')}`;
  const db = getPool();

  const [[count]] = await db.execute(
    `SELECT COUNT(*) AS n FROM punishments p ${clause}`, params);

  const total = Number(count.n) || 0;
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PER_PAGE)));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);

  /* A cursor wins when both are supplied: it is the more precise of the two,
     and mixing them would mean seeking to a row and then counting past it. */
  const cursor = decodeCursor(after);

  const rowWhere = where.slice();
  const rowParams = params.slice();

  if (cursor) {
    /* Strictly after the marker in (created_at DESC, id DESC) order. The id
       breaks the tie: two punishments issued in the same millisecond are
       common when a script bans a list of names, and ordering on the
       timestamp alone would let one of them repeat or vanish between pages. */
    rowWhere.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
    rowParams.push(cursor.at, cursor.at, cursor.id);
  }

  const rowClause = `WHERE ${rowWhere.join(' AND ')}`;
  const offset = cursor ? 0 : (current - 1) * PER_PAGE;

  /* Note the column list. target_ip is absent by construction.
     One row more than a page, so "is there a next page" is answered by the
     query rather than by a second COUNT. */
  const [fetched] = await db.execute(
    `SELECT p.id, p.type, p.target_name, p.operator_name, p.reason,
            p.created_at, p.expires_at, p.active, p.removed_by
       FROM punishments p
       ${rowClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${PER_PAGE + 1} OFFSET ${offset}`, rowParams);

  const hasMore = fetched.length > PER_PAGE;
  const rows = hasMore ? fetched.slice(0, PER_PAGE) : fetched;

  /* Chip counts, taken over the scope WITHOUT the type filter, so "Bans 12"
     keeps saying 12 while you are looking at the mutes. One grouped query
     rather than five counts. */
  const [tallies] = await db.execute(
    `SELECT p.type, COUNT(*) AS n FROM punishments p ${scopeClause} GROUP BY p.type`,
    scopeParams);

  const counts = { ALL: 0, BAN: 0, MUTE: 0, WARN: 0, KICK: 0 };
  tallies.forEach((t) => {
    const kind = KIND[t.type];
    if (!kind) return;
    counts[kind] += Number(t.n) || 0;
    counts.ALL += Number(t.n) || 0;
  });

  const now = Date.now();

  /* The three headline numbers, over the WHOLE record rather than the search.
     "Active bans" means active bans on the network; narrowing it to whatever
     is typed in the search box would make it a different, useless statistic. */
  const [[totals]] = await db.execute(
    `SELECT
       COUNT(*) AS records,
       SUM(p.active = 1
           AND (p.expires_at = -1 OR p.expires_at > ?)
           AND p.type IN ('BAN','TEMPBAN','IPBAN','TEMPIPBAN')) AS bans,
       SUM(p.active = 1
           AND (p.expires_at = -1 OR p.expires_at > ?)
           AND p.type IN ('MUTE','TEMPMUTE','IPMUTE','TEMPIPMUTE')) AS mutes
     FROM punishments p
     WHERE p.silent = 0 AND p.target_name IS NOT NULL`, [now, now]);

  const stats = {
    records: Number(totals && totals.records) || 0,
    activeBans: Number(totals && totals.bans) || 0,
    activeMutes: Number(totals && totals.mutes) || 0,
  };

  /* Whether this player is banned or muted right now. Asked of the whole
     record, not of the page being shown - somebody with three pages of
     history is still banned on page one. */
  let status = null;
  if (name) {
    const [[live]] = await db.execute(
      `SELECT
         SUM(p.type IN ('BAN','TEMPBAN','IPBAN','TEMPIPBAN')) AS bans,
         SUM(p.type IN ('MUTE','TEMPMUTE','IPMUTE','TEMPIPMUTE')) AS mutes
       FROM punishments p
       WHERE p.silent = 0 AND p.active = 1
         AND ${account ? 'p.target_uuid = ?' : 'p.target_name = ?'}
         AND (p.expires_at = -1 OR p.expires_at > ?)`,
    [account ? account.uuid : name, now]);

    const known = account ? await namesFor(account.uuid) : [];

    /* Both sides counted whichever one is open, so the tabs can say "12
       received, 340 given" - and so the Given tab only appears for somebody
       who has actually punished anyone. */
    const [[sides]] = await db.execute(
      `SELECT
         SUM(${account ? 'p.target_uuid = ?' : 'p.target_name = ?'}) AS received,
         SUM(${account ? 'p.operator_uuid = ?' : 'p.operator_name = ?'}) AS given
       FROM punishments p
       WHERE p.silent = 0 AND p.target_name IS NOT NULL`,
    [account ? account.uuid : name, account ? account.uuid : name]);

    status = {
      received: Number(sides && sides.received) || 0,
      given: Number(sides && sides.given) || 0,
      // The account's current name, which may not be the one searched for.
      name: account ? account.name : name,
      searched: name,
      previous_names: known.filter((entry) => entry !== (account ? account.name : name)),
      banned: Number(live && live.bans) > 0,
      muted: Number(live && live.mutes) > 0,
    };
  }

  return {
    configured: true,
    total,
    page: current,
    pages,
    /* The marker for the row after this page, or null at the end. */
    next: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : null,
    counts,
    stats,
    player: status,
    punishments: rows.map((r) => ({
      id: Number(r.id),
      type: KIND[r.type] || 'BAN',
      player: r.target_name,
      staff: r.operator_name || 'CONSOLE',
      reason: r.reason || 'No reason given',
      date: stamp(r.created_at),
      expires: expiry(r, now, KIND[r.type] || 'BAN'),
      lifted: Boolean(!r.active && r.removed_by),
    })),
  };
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  /* Exported so the renderer cannot disagree with it — it used to keep its
     own copy, and the two drifted to 10 against 20. */
  PER_PAGE, list, configured, close, settings };
