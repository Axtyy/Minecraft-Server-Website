'use strict';
/**
 * MariaDB pool for the store's session and basket tables.
 *
 * Same shape as SolarBeacon's and SolarDiscord's — same env names with a
 * different prefix, same façade — so anyone who has read one already knows this
 * one. A separate pool rather than a shared module because these are separate
 * processes that may well point at different databases.
 */
const mysql = require('mysql2/promise');

require('./env');

function settings() {
  const url = process.env.STORE_DB_URL;
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
    host: process.env.STORE_DB_HOST || '127.0.0.1',
    port: Number(process.env.STORE_DB_PORT || 3306),
    user: process.env.STORE_DB_USER || 'solar',
    password: process.env.STORE_DB_PASSWORD || '',
    database: process.env.STORE_DB_NAME || 'solar',
  };
}

function baseOptions() {
  return {
    ...settings(),
    charset: 'utf8mb4_unicode_ci',
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    timezone: 'Z',
  };
}

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      ...baseOptions(),
      waitForConnections: true,
      connectionLimit: Number(process.env.STORE_DB_POOL || 4),
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return pool;
}

/** A connection with multi-statement enabled, for applying schema.sql. */
async function ddlConnection() {
  return mysql.createConnection({ ...baseOptions(), multipleStatements: true });
}

const normalise = (params) => params.map((p) => (p === undefined ? null : p));

function statement(target, sql) {
  return {
    async get(...p) { const [rows] = await target.execute(sql, normalise(p)); return rows[0]; },
    async all(...p) { const [rows] = await target.execute(sql, normalise(p)); return rows; },
    async run(...p) {
      const [r] = await target.execute(sql, normalise(p));
      return { lastInsertRowid: r.insertId, changes: r.affectedRows };
    },
  };
}

const wrap = (target) => ({
  prepare: (sql) => statement(target, sql),
  exec: (sql) => target.query(sql),
  raw: target,
});

let handle = null;
const open = () => (handle ??= wrap(getPool()));

/**
 * Runs `fn` inside a transaction on one pinned connection.
 *
 * BEGIN against a pool only promises that *this* statement runs somewhere; the
 * writes that follow would land on other connections and commit outside it.
 */
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    try {
      const result = await fn(wrap(conn));
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    conn.release();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
    handle = null;
  }
}

module.exports = { open, transaction, ddlConnection, close, settings, getPool };
