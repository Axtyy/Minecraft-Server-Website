'use strict';
/**
 * Made-up players, used when DEMO_MODE=true.
 *
 * Stand-ins for lib/stats.js, lib/votes.js, lib/punishments.js and
 * lib/status.js with the same exports and the same shapes, so the stats,
 * vote and punishment pages render as they would on a live network, with no
 * database and no Minecraft server behind them.
 *
 * Everything is generated from one fixed seed, so the numbers are the same on
 * every load and a screenshot taken today matches one taken next week. Times
 * are relative to now, so "last seen" never drifts into last year.
 */
const realStats = require('../stats');
const { PER_PAGE } = require('../punishments');

const DAY = 86_400_000;
const HOUR = 3_600_000;

/* Invented names. Skin services draw the default skin for any they do not know. */
const NAMES = [
  'PixelPioneer', 'Craftsmith', 'RedstoneRae', 'NetherNomad', 'BlockBaron',
  'EmberFox', 'Glowstoner', 'QuartzQueen', 'CobbleKid', 'EnderEcho',
  'MossyMiner', 'TidalTom', 'LanternLou', 'Frostbyte_', 'AmberArcher',
  'CopperCass', 'SporeSam', 'DuskDrake', 'BirchBea', 'GravelGus',
];

const RANKS = ['emperor', 'king', 'royal', 'guardian', null];
const MODES = ['Survival', 'Skyblock'];

/* A small seeded generator: the same sequence on every start. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seeded(20261022);
const between = (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1));

/* Every player once, with their whole record. Sorted by playtime so the
   playtime board and the "rank" on a profile agree. */
const PLAYERS = NAMES.map((name, i) => {
  const kills = between(15, 2400);
  const deaths = between(10, 900);
  const best = between(3, 60);
  const survival = between(40, 900) * HOUR;
  const skyblock = between(5, 300) * HOUR;
  return {
    name,
    group: RANKS[i % RANKS.length],
    kills,
    deaths,
    best,
    streak: between(0, best),
    gems: between(0, 40_000),
    votes: between(2, 320),
    votesMonth: between(0, 31),
    seconds: Math.round((survival + skyblock) / 1000),
    modes: [
      { name: 'Survival', seconds: Math.round(survival / 1000), days: between(10, 200) },
      { name: 'Skyblock', seconds: Math.round(skyblock / 1000), days: between(2, 80) },
    ],
    firstJoin: Date.now() - between(20, 400) * DAY,
    lastSeen: Date.now() - between(1, 96) * HOUR,
    online: i % 7 === 0 ? MODES[i % 2] : null,
  };
}).sort((a, b) => b.seconds - a.seconds);

/* ------------------------------------------------------------------ stats */

const top = (value, filter = () => true) => PLAYERS.filter(filter)
  .map((p) => ({ name: p.name, uuid: null, value: value(p) }))
  .filter((r) => r.value > 0)
  .sort((a, b) => b.value - a.value)
  .slice(0, 10);

/* Shorter windows show a share of the lifetime figure, so the daily board is
   smaller than the weekly one rather than identical to it. */
const SHARE = { daily: 0.02, weekly: 0.1, monthly: 0.35, lifetime: 1 };

const stats = {
  PERIODS: realStats.PERIODS,
  BOARDS: realStats.BOARDS,
  pick: realStats.pick,

  async modes() {
    return MODES;
  },

  async leaderboard(boardId, periodId, mode) {
    const board = realStats.pick(realStats.BOARDS, boardId, 'playtime');
    const share = SHARE[realStats.pick(realStats.PERIODS, periodId, 'lifetime').id];
    const scale = (n) => Math.round(n * share);

    if (board.id === 'kills') return top((p) => scale(p.kills));
    if (board.id === 'kdr') return top((p) => Math.round((p.kills / Math.max(p.deaths, 1)) * 100) / 100);
    if (board.id === 'streak') return top((p) => p.best);
    if (board.id === 'votes') return top((p) => scale(p.votes));

    const scoped = board.perMode && mode ? mode : '';
    return top((p) => scale(scoped
      ? (p.modes.find((m) => m.name === scoped) || { seconds: 0 }).seconds
      : p.seconds));
  },

  async totals() {
    return {
      players: 1_284,
      seconds: PLAYERS.reduce((t, p) => t + p.seconds, 0) * 9,
      votes: PLAYERS.reduce((t, p) => t + p.votes, 0) * 7,
    };
  },

  async profile(name) {
    const at = PLAYERS.findIndex((p) => p.name.toLowerCase() === String(name).toLowerCase());
    if (at < 0) return false;
    const p = PLAYERS[at];
    return {
      game: {
        seconds: p.seconds,
        ahead: at,
        uuid: null,
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        streak: p.streak,
        best: p.best,
        gems: p.gems,
      },
      group: p.group,
      donor: null,
      name: p.name,
      uuid: null,
      firstJoin: p.firstJoin,
      lastSeen: p.lastSeen,
      online: p.online,
      seconds: p.seconds,
      days: p.modes.reduce((t, m) => t + m.days, 0),
      rank: at + 1,
      votes: p.votes,
      votesMonth: p.votesMonth,
      modes: p.modes,
    };
  },
};

/* ------------------------------------------------------------------ votes */

const PACKAGES = ['Emperor', 'King', '6,000 Gems', 'Royal', '5x Godly Crate Key',
  'Guardian', '2,200 Gems', 'Plus Tier - 1 Month', 'Champion Bundle'];

const votes = {
  configured: () => true,

  async topVotersOrNone(limit = 10) {
    return [...PLAYERS]
      .sort((a, b) => b.votesMonth - a.votesMonth)
      .slice(0, limit)
      .map((p) => ({ name: p.name, votes: p.votesMonth, uuid: null }));
  },

  async recentPurchasesOrNone(limit = 8) {
    return PLAYERS.slice(0, Math.min(limit, PLAYERS.length)).map((p, i) => ({
      name: p.name,
      uuid: null,
      package: PACKAGES[i % PACKAGES.length],
      at: Date.now() - (i + 1) * 47 * 60_000,
    }));
  },

  monthStart() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  },

  async close() {},
};

/* ------------------------------------------------------------ punishments */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
    + ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const STAFF = ['Moderator_Mia', 'HelperHal', 'AdminAda'];
const REASONS = {
  BAN: ['Cheating (kill aura)', 'X-ray', 'Ban evasion', 'Duping exploit'],
  MUTE: ['Spam', 'Advertising', 'Harassment', 'Inappropriate language'],
  WARN: ['Spawn trapping', 'Caps in chat', 'Begging for items'],
  KICK: ['AFK at spawn', 'Lag machine'],
};
const UNDONE = { BAN: 'Unbanned', MUTE: 'Unmuted', WARN: 'Removed', KICK: 'Removed' };

/* Newest first, as the live list is. */
const RECORDS = Array.from({ length: 64 }, (_, i) => {
  const type = ['BAN', 'MUTE', 'WARN', 'MUTE', 'BAN', 'KICK', 'WARN'][i % 7];
  const created = Date.now() - (i * 9 + between(1, 8)) * HOUR;
  const length = type === 'BAN' && i % 3 === 0 ? -1 : between(1, 30) * DAY;
  const lifted = i % 9 === 4;
  const ends = length === -1 ? -1 : created + length;
  const active = !lifted && type !== 'KICK' && type !== 'WARN' && (ends === -1 || ends > Date.now());
  const staff = STAFF[i % STAFF.length];
  return {
    id: 1000 - i,
    type,
    player: NAMES[(i * 7) % NAMES.length],
    staff,
    reason: REASONS[type][i % REASONS[type].length],
    date: stamp(created),
    expires: lifted ? `${UNDONE[type]} by ${staff}`
      : type === 'KICK' || type === 'WARN' ? 'Expired'
        : ends === -1 ? 'Never' : ends <= Date.now() ? 'Expired' : stamp(ends),
    lifted,
    active,
  };
});

const punishments = {
  PER_PAGE,
  configured: () => true,

  async list({
    page = 1, type = 'ALL', query = '', q = '', player = '', side = 'received',
  } = {}) {
    const search = String(query || q).trim().toLowerCase();
    const name = String(player || '').trim().toLowerCase();
    const given = side === 'given';

    const scope = RECORDS.filter((r) => {
      if (name) return (given ? r.staff : r.player).toLowerCase() === name;
      return !search || [r.player, r.staff, r.reason].some((s) => s.toLowerCase().includes(search));
    });

    const counts = { ALL: scope.length, BAN: 0, MUTE: 0, WARN: 0, KICK: 0 };
    scope.forEach((r) => { counts[r.type] += 1; });

    const typed = counts[type] !== undefined && type !== 'ALL'
      ? scope.filter((r) => r.type === type) : scope;
    const pages = Math.max(1, Math.ceil(typed.length / PER_PAGE));
    const current = Math.min(Math.max(1, Number(page) || 1), pages);

    let status = null;
    if (name) {
      const mine = RECORDS.filter((r) => r.player.toLowerCase() === name);
      const shown = NAMES.find((n) => n.toLowerCase() === name) || STAFF.find((n) => n.toLowerCase() === name) || player;
      status = {
        received: mine.length,
        given: RECORDS.filter((r) => r.staff.toLowerCase() === name).length,
        name: shown,
        searched: player,
        previous_names: [],
        banned: mine.some((r) => r.active && r.type === 'BAN'),
        muted: mine.some((r) => r.active && r.type === 'MUTE'),
      };
    }

    return {
      configured: true,
      total: typed.length,
      page: current,
      pages,
      next: null,
      counts,
      stats: {
        records: RECORDS.length,
        activeBans: RECORDS.filter((r) => r.active && r.type === 'BAN').length,
        activeMutes: RECORDS.filter((r) => r.active && r.type === 'MUTE').length,
      },
      player: status,
      punishments: typed.slice((current - 1) * PER_PAGE, current * PER_PAGE)
        .map(({ active, ...row }) => row),
    };
  },

  async close() {},
  settings: () => ({}),
};

/* ----------------------------------------------------------------- status */

/* A count that moves a little through the day, so the header looks alive. */
const status = {
  configured: () => true,
  current() {
    const hour = new Date().getUTCHours();
    const players = 120 + Math.round(60 * Math.sin((hour / 24) * Math.PI * 2)) + (Date.now() / 600_000 % 7 | 0);
    return { configured: true, ok: true, ever: true, players, max: 500 };
  },
  async refresh() {
    return status.current();
  },
};

module.exports = { stats, votes, punishments, status };
