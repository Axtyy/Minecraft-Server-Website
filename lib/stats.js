'use strict';
/**
 * Player stats and leaderboards, read from Beacon's database.
 *
 * Beacon records every session (who, which gamemode, how long) and every vote.
 * This reads those through the same read-only account the vote leaderboard
 * uses, and shows only what those tables can actually answer: time played,
 * days played and votes. There are no kills, levels or balances here because
 * nothing reports them to Beacon yet, and a leaderboard of invented numbers is
 * worse than a short one.
 *
 * <h2>What is deliberately not selected</h2>
 *
 *   - `last_ip`, `hwid`, `country` and `client` on players, and `join_ip` and
 *     `join_host` on sessions. A public profile has no business near any of
 *     them, and not selecting them means no bug downstream can leak one.
 *   - Individual sessions and votes. The page shows totals; when exactly
 *     somebody was online is nobody else's business.
 *
 * <h2>Never throws</h2>
 * Every export answers null when the database is unconfigured, unreachable, or
 * the account cannot read a table. The page says the stats are unavailable; it
 * does not 500, and it does not show zeros that read as "nobody plays here".
 */

const votes = require('./votes');
const cache = require('./cache');
const log = require('./log');

const DAY = 86_400_000;

/* The windows a board can be read over. Rolling, not calendar: "weekly" on a
   Monday morning should not be an empty board. */
const PERIODS = [
  { id: 'daily', label: 'Daily', ms: DAY },
  { id: 'weekly', label: 'Weekly', ms: 7 * DAY },
  { id: 'monthly', label: 'Monthly', ms: 30 * DAY },
  { id: 'lifetime', label: 'Lifetime', ms: 0 },
];

const EVERY_PERIOD = PERIODS.map((p) => p.id);

/* The boards, and where each one's numbers come from.
 *
 * Playtime and votes are counted from Beacon's sessions and votes. The rest
 * are the game's own: the Survival server keeps a running total per player in
 * its table (the same columns the in-game /leaderboards read), so the site and
 * the game can never disagree about who is first.
 *
 * periods  the windows the board exists for. The game only keeps a killstreak
 *          as it stands now, so that one is lifetime only.
 * perMode  whether the gamemode filter means anything for the board. */
const BOARDS = [
  { id: 'playtime', label: 'Playtime', perMode: true, periods: EVERY_PERIOD },
  { id: 'kills', label: 'Kills', game: true, periods: EVERY_PERIOD },
  { id: 'kdr', label: 'K/D', game: true, periods: ['lifetime'] },
  { id: 'streak', label: 'Best Killstreak', game: true, periods: ['lifetime'] },
  { id: 'votes', label: 'Votes', periods: EVERY_PERIOD },
];

/* The game's own database, on the same server and read through the same
   account. Checked against a plain name because it is spliced into SQL: it
   comes from the environment, but a table name cannot be a bound parameter. */
const GAME_DB = /^\w+$/.test(process.env.STATS_GAME_DB || '') ? process.env.STATS_GAME_DB : 'solar';
/* Gems are network-wide state, and live in the network database once the game's
   tables are split across databases. Unset, they are still beside the players. */
const NETWORK_DB = /^\w+$/.test(process.env.STATS_NETWORK_DB || '') ? process.env.STATS_NETWORK_DB : GAME_DB;
const GAME_TABLE = /^\w+$/.test(process.env.STATS_GAME_TABLE || '') ? process.env.STATS_GAME_TABLE : 'survival';
const GAME = `${GAME_DB}.${GAME_TABLE}`;

/* A K/D of 3.00 off three kills and no deaths is not a ranking. */
const KDR_MIN_KILLS = 10;

/* LuckPerms weights from here up are staff ranks (media 60 ... owner 100);
   below are the ranks players buy (guardian 20 ... emperor 50). */
const STAFF_WEIGHT = Number(process.env.STATS_STAFF_WEIGHT) || 60;

const kills = (period) => `s.lb_stats_stats_${period}_common_kills`;
const DEATHS = 's.lb_stats_stats_lifetime_common_deaths';
const BEST_STREAK = 's.lb_stats_stats_lifetime_common_highest_killstreak';
const STREAK = 's.lb_stats_stats_lifetime_common_killstreak';

/* Lifetime playtime, in seconds, as the game itself counts it.
 *
 * This is the column the in-game "Playtime Top" board ranks, so the site reads
 * the same one: two boards built from two different records of the same thing
 * were never going to agree, and they did not. Beacon's sessions are a
 * separate record that started later for some players and kept running
 * through restarts for others, so its totals were higher for one player and
 * lower for the next.
 *
 * Beacon is still what answers "today", "this week" and "this month" - the
 * game keeps one running total and no history - so those boards are a
 * different measurement and are not expected to add up to this one. */
const GAME_PLAYTIME = '(s.lb_playtime_totalplaytime / 1000)';

/* The gamemodes the stats page counts, from STATS_MODES (comma separated).
 *
 * Survival alone for now. Everything on the page - the boards, the totals, a
 * player's playtime and rank - is counted over these and nothing else, so time
 * spent standing in the lobby or at an event is not a leaderboard. Adding a
 * mode here is all it takes to give it a tab. */
const COUNTED = (process.env.STATS_MODES || 'Survival').split(',')
  .map((m) => m.trim()).filter(Boolean);
const counted = (name) => COUNTED.some((m) => m.toLowerCase() === String(name).toLowerCase());

/* "gamemode IN (?, ?)" for the counted modes, and the values to bind to it. */
const IN_COUNTED = `IN (${COUNTED.map(() => '?').join(', ')})`;

const pick = (list, id, fallback) => (list.find((x) => x.id === id) || list.find((x) => x.id === fallback));

async function query(sql, params) {
  const [rows] = await votes.pool().query(sql, params);
  return rows;
}

/** Runs a read, and turns any failure into null and one log line. */
async function soft(what, run) {
  if (!votes.configured()) return null;
  try {
    return await run();
  } catch (err) {
    log.warn(`Stats (${what}) unavailable: ${err.message}`);
    return null;
  }
}

/** The gamemodes people actually play, most played first. */
function modes() {
  return cache.through('stats:modes', 10 * 60_000, () => soft('modes', async () => {
    const rows = await query(
      `SELECT gamemode AS name, COUNT(*) AS sessions
         FROM sessions
        WHERE started_at >= ?
        GROUP BY gamemode
        ORDER BY sessions DESC`,
      [Date.now() - 90 * DAY],
    );
    return rows.map((r) => String(r.name)).filter(counted);
  }));
}

/**
 * One board.
 *
 * Counted in SQL rather than by pulling rows and tallying them here: the
 * session table grows without limit and the page only ever wants ten names.
 * Only finished sessions count towards time played - an open one has no
 * length yet, and guessing it would let a crashed server hand somebody a week.
 *
 * @returns {Promise<Array<{name, uuid, value}>|null>}
 */
function leaderboard(boardId, periodId, mode) {
  const board = pick(BOARDS, boardId, 'playtime');
  const period = pick(PERIODS, periodId, 'lifetime');
  const from = period.ms ? Date.now() - period.ms : 0;
  const scoped = board.perMode && mode ? mode : '';

  return cache.through(`stats:lb:${board.id}:${period.id}:${scoped}`, 5 * 60_000,
    () => soft(`${board.id} board`, async () => {
      let rows;
      if (board.id === 'playtime' && period.id === 'lifetime' && !scoped) {
        rows = await query(
          `SELECT u.realname AS name, u.uuid AS uuid, ${GAME_PLAYTIME} AS value
             FROM ${GAME} s
             JOIN ${GAME_DB}.user u ON u.id = s.user_id
            WHERE s.lb_playtime_totalplaytime > 0
            ORDER BY value DESC
            LIMIT 10`, []);
      } else if (board.game) {
        /* period.id is one of four fixed words by the time it is here - see
           pick() - so building a column name from it is safe. */
        const value = board.id === 'kdr' ? `${kills('lifetime')} / GREATEST(${DEATHS}, 1)`
          : board.id === 'streak' ? BEST_STREAK
            : kills(period.id);
        rows = await query(
          `SELECT u.realname AS name, u.uuid AS uuid, ${value} AS value
             FROM ${GAME} s
             JOIN ${GAME_DB}.user u ON u.id = s.user_id
            WHERE ${board.id === 'kdr' ? `${kills('lifetime')} >= ${KDR_MIN_KILLS}` : `${value} > 0`}
            ORDER BY value DESC
            LIMIT 10`, []);
      } else if (board.id === 'votes') {
        rows = await query(
          `SELECT p.username AS name, p.uuid AS uuid, COUNT(*) AS value
             FROM votes v
             JOIN players p ON p.id = v.player_id
            WHERE v.voted_at >= ?
            GROUP BY v.player_id, p.username, p.uuid
            ORDER BY value DESC, MIN(v.voted_at) ASC
            LIMIT 10`,
          [from],
        );
      } else {
        rows = await query(
          `SELECT p.username AS name, p.uuid AS uuid, COALESCE(SUM(s.duration_s), 0) AS value
             FROM sessions s
             JOIN players p ON p.id = s.player_id
            WHERE s.started_at >= ? AND s.gamemode ${scoped ? '= ?' : IN_COUNTED}
            GROUP BY s.player_id, p.username, p.uuid
           HAVING value > 0
            ORDER BY value DESC
            LIMIT 10`,
          scoped ? [from, scoped] : [from, ...COUNTED],
        );
      }
      return rows.map((r) => ({
        name: String(r.name),
        uuid: r.uuid ? String(r.uuid) : null,
        value: Number(r.value) || 0,
      }));
    }));
}

/** The four numbers in the "Server Totals" box. */
function totals() {
  return cache.through('stats:totals', 10 * 60_000, () => soft('totals', async () => {
    const [players] = await query('SELECT COUNT(*) AS n FROM players', []);
    // The game's own total, so this adds up to the board beneath it.
    const [played] = await query(
      `SELECT COALESCE(SUM(${GAME_PLAYTIME}), 0) AS s FROM ${GAME} s`, []);
    const [voted] = await query('SELECT COUNT(*) AS n FROM votes', []);
    return {
      players: Number(players.n) || 0,
      seconds: Number(played.s) || 0,
      votes: Number(voted.n) || 0,
    };
  }));
}

/* Profiles are keyed by whatever name was asked for, which is not a bounded
   set, so they get their own small cache with a ceiling instead of the shared
   one that never forgets a key. */
const profiles = new Map();
const PROFILE_MS = 2 * 60_000;
const PROFILE_MAX = 400;

/**
 * One player's page.
 *
 * @returns {Promise<object|false|null>} the profile, false when nobody by that
 *          name has ever joined, null when the database could not be asked
 */
async function profile(name) {
  const key = String(name || '').toLowerCase();
  if (!/^[a-z0-9_.*]{2,17}$/.test(key)) return false;

  const hit = profiles.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const value = await soft('profile', async () => {
    const [player] = await query(
      `SELECT id, username, uuid, first_join, last_seen
         FROM players WHERE username = ? LIMIT 1`,
      [key],
    );
    if (!player) return false;

    const id = player.id;
    const perMode = await query(
      `SELECT gamemode AS name, COALESCE(SUM(duration_s), 0) AS seconds,
              COUNT(DISTINCT started_at DIV 86400000) AS days, MAX(started_at) AS last
         FROM sessions WHERE player_id = ? AND gamemode ${IN_COUNTED}
        GROUP BY gamemode
        ORDER BY seconds DESC`,
      [id, ...COUNTED],
    );
    const [span] = await query(
      `SELECT COUNT(DISTINCT started_at DIV 86400000) AS days,
              COALESCE(SUM(duration_s), 0) AS seconds
         FROM sessions WHERE player_id = ? AND gamemode ${IN_COUNTED}`,
      [id, ...COUNTED],
    );
    /* An open session that began in the last half day. Older than that with no
       end is a session that was never closed, not a player who is online. */
    const [open] = await query(
      `SELECT gamemode FROM sessions
        WHERE player_id = ? AND ended_at IS NULL AND started_at >= ?
        ORDER BY started_at DESC LIMIT 1`,
      [id, Date.now() - DAY / 2],
    );
    const [voted] = await query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(voted_at >= ?), 0) AS month
         FROM votes WHERE player_id = ?`,
      [votes.monthStart(), id],
    );

    /* The game's own record. Asked separately and allowed to fail on its own:
       somebody who joined the network but never the Survival server has no
       row, and that is not a reason to lose the rest of the profile. */
    let game = null;
    try {
      const [row] = await query(
        `SELECT u.uuid AS uuid, u.realname AS realname, ${GAME_PLAYTIME} AS seconds,
                (SELECT COUNT(*) FROM ${GAME} o WHERE o.lb_playtime_totalplaytime > s.lb_playtime_totalplaytime) AS ahead,
                ${kills('lifetime')} AS kills, ${DEATHS} AS deaths, ${STREAK} AS streak, ${BEST_STREAK} AS best,
                (SELECT CAST(c.balance AS DECIMAL(30,2)) FROM ${NETWORK_DB}.currency c WHERE c.user_id = u.id) AS gems
           FROM ${GAME_DB}.user u
           JOIN ${GAME} s ON s.user_id = u.id
          WHERE u.username = ? LIMIT 1`,
        [key],
      );
      if (row) {
        game = {
          seconds: Number(row.seconds) || 0,
          ahead: Number(row.ahead) || 0,
          uuid: row.uuid ? String(row.uuid) : null,
          name: row.realname ? String(row.realname) : null,
          kills: Number(row.kills) || 0,
          deaths: Number(row.deaths) || 0,
          streak: Number(row.streak) || 0,
          best: Number(row.best) || 0,
          gems: row.gems == null ? null : Number(row.gems) || 0,
        };
      }
    } catch (err) {
      log.warn(`Stats (game record) unavailable: ${err.message}`);
    }

    /* The rank shown beside the name: the heaviest LuckPerms group the account
       holds, which is the one the game shows too. Asked by the UUID the game
       itself knows the player by, and allowed to fail on its own. */
    let group = null;
    /* A staff member's bought rank, shown beside the staff one: an admin in
       Emperor colours is somebody who bought Emperor, not somebody who gave
       it to themselves. Null for everyone whose top rank is already bought. */
    let donor = null;
    const uuid = (game && game.uuid) || (player.uuid ? String(player.uuid) : null);
    if (uuid) {
      try {
        const held = await query(
          `SELECT SUBSTRING(up.permission, 7) AS name,
                  CAST(SUBSTRING(gp.permission, 8) AS UNSIGNED) AS weight
             FROM luckperms.luckperms_user_permissions up
             LEFT JOIN luckperms.luckperms_group_permissions gp
               ON gp.name = SUBSTRING(up.permission, 7) AND gp.permission LIKE 'weight.%'
            WHERE up.uuid = ? AND up.permission LIKE 'group.%' AND up.value = 1
              AND (up.expiry = 0 OR up.expiry > UNIX_TIMESTAMP())
            ORDER BY weight DESC`,
          [uuid.length === 32 ? uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : uuid],
        );
        const ranks = held.filter((g) => !/^(default|bots)$/i.test(String(g.name)));
        if (ranks.length) {
          group = String(ranks[0].name);
          if (Number(ranks[0].weight) >= STAFF_WEIGHT) {
            const bought = ranks.find((g) => Number(g.weight) < STAFF_WEIGHT);
            if (bought) donor = String(bought.name);
          }
        }
      } catch (err) {
        log.warn(`Stats (rank) unavailable: ${err.message}`);
      }
    }

    /* Playtime and its rank are the game's, the same figures its own board
       shows. Beacon's count stands in only for somebody the game has no row
       for, and then without a rank: it is not on the same scale. */
    const seconds = game ? game.seconds : Number(span.seconds) || 0;
    const rank = game && game.seconds > 0 ? game.ahead + 1 : null;

    return {
      game,
      group,
      donor,
      name: String(player.username),
      uuid: player.uuid ? String(player.uuid) : null,
      firstJoin: Number(player.first_join) || 0,
      lastSeen: Number(player.last_seen) || 0,
      online: open ? String(open.gamemode) : null,
      seconds,
      days: Number(span.days) || 0,
      rank,
      votes: Number(voted.total) || 0,
      votesMonth: Number(voted.month) || 0,
      modes: perMode
        .map((m) => ({
          name: String(m.name), seconds: Number(m.seconds) || 0, days: Number(m.days) || 0,
        }))
        .filter((m) => m.seconds > 0),
    };
  });

  /* A failure is not remembered: the next request should try again rather
     than repeat an outage for two minutes. */
  if (value !== null) {
    if (profiles.size >= PROFILE_MAX) profiles.delete(profiles.keys().next().value);
    profiles.set(key, { value, until: Date.now() + PROFILE_MS });
  }
  return value;
}

module.exports = {
  PERIODS, BOARDS, pick, modes, leaderboard, totals, profile,
};
