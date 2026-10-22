'use strict';
/**
 * The vote leaderboard, read from Beacon's database.
 *
 * Votes are recorded by Beacon (its `votes` table, one row per vote, joined to
 * `players` for the name and UUID). This service only ever reads them, through
 * an account that holds SELECT on those two tables and nothing else — the same
 * arrangement as the punishment list, and for the same reason: the website is
 * the least trusted thing that touches either database and must not be able to
 * alter what it displays.
 *
 * <h2>What is deliberately not selected</h2>
 *
 *   - `last_ip` and `hwid` on players. A public leaderboard has no business
 *     near either, and not selecting them means no bug downstream can leak one.
 *   - Individual vote rows. The page shows a count per player; the times
 *     somebody voted are nobody else's business.
 *
 * Unconfigured is a normal state: without VOTES_DB_* the page falls back to
 * whatever content/vote.json holds, exactly as it did before.
 */

const mysql = require('mysql2/promise');

require('./env');
const log = require('./log');

function settings() {
  const url = process.env.VOTES_DB_URL;
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
    host: process.env.VOTES_DB_HOST || '',
    port: Number(process.env.VOTES_DB_PORT || 3306),
    user: process.env.VOTES_DB_USER || '',
    password: process.env.VOTES_DB_PASSWORD || '',
    database: process.env.VOTES_DB_NAME || 'beacon',
  };
}

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
      connectionLimit: Number(process.env.VOTES_DB_POOL || 2),
      connectTimeout: 5000,
    });
  }
  return pool;
}

/** First instant of the current UTC month, in epoch ms. */
function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * This month's top voters, highest first.
 *
 * Counted in SQL rather than by pulling rows and tallying them here: the vote
 * table grows without limit and the page only ever wants ten names.
 *
 * @param {number} limit how many places the board has
 * @returns {Promise<Array<{name: string, votes: number, uuid: string|null}>>}
 */
async function topVoters(limit = 10) {
  if (!configured()) return [];

  const cap = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const [rows] = await getPool().query(
    `SELECT p.username AS name, p.uuid AS uuid, COUNT(*) AS votes
       FROM votes v
       JOIN players p ON p.id = v.player_id
      WHERE v.voted_at >= ?
      GROUP BY v.player_id, p.username, p.uuid
      ORDER BY votes DESC, MIN(v.voted_at) ASC
      LIMIT ?`,
    [monthStart(), cap],
  );

  return rows.map((r) => ({
    name: String(r.name),
    votes: Number(r.votes) || 0,
    /* Beacon stores UUIDs dashed or not depending on the source; the skin
       providers take either, so it is passed through as stored. */
    uuid: r.uuid ? String(r.uuid) : null,
  }));
}

/** Never throws: an outage costs the board its numbers, not the page. */
async function topVotersOrNone(limit = 10) {
  if (!configured()) return null;
  try {
    return await topVoters(limit);
  } catch (err) {
    log.warn(`Vote leaderboard unavailable: ${err.message}`);
    return null;
  }
}

/**
 * The latest completed store purchases, newest first, for the store page's
 * "recent purchases" strip.
 *
 * Read from Beacon, which records every payment from Tebex. Only what the
 * strip shows is selected: who, what and when. The amount, the payment method
 * and the transaction id stay in the database - a visitor has no business
 * knowing what somebody else paid - and free or zero-value entries are left
 * out, since those are tests and staff grants rather than purchases.
 *
 * @returns {Promise<Array<{name: string, uuid: string|null, package: string, at: number}>>}
 */
async function recentPurchases(limit = 8) {
  if (!configured()) return [];

  const cap = Math.min(Math.max(Number(limit) || 8, 1), 100);
  const [rows] = await getPool().query(
    `SELECT p.username AS name, p.uuid AS uuid, pu.package AS package, pu.purchased_at AS at
       FROM purchases pu
       JOIN players p ON p.id = pu.player_id
      WHERE pu.status = 'Completed' AND pu.amount_cents > 0
      ORDER BY pu.purchased_at DESC
      LIMIT ?`,
    [cap],
  );

  return rows.map((r) => ({
    name: String(r.name),
    uuid: r.uuid ? String(r.uuid) : null,
    package: String(r.package),
    at: Number(r.at) || 0,
  }));
}

/** Never throws: an outage costs the store its strip, not the page. */
async function recentPurchasesOrNone(limit = 8) {
  if (!configured()) return [];
  try {
    return await recentPurchases(limit);
  } catch (err) {
    log.warn(`Recent purchases unavailable: ${err.message}`);
    return [];
  }
}

async function close() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}

module.exports = {
  /* The pool itself, for lib/stats.js: the same database through the same
     read-only account, so there is one set of credentials and one pool. */
  pool: getPool,
  configured, topVoters, topVotersOrNone, recentPurchases, recentPurchasesOrNone, monthStart, close,
};
