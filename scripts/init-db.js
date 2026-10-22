'use strict';
/**
 * Applies db/schema.sql to the Solar database.
 *
 * Idempotent: every statement is CREATE TABLE IF NOT EXISTS, so re-running adds
 * what is missing and drops nothing.
 */
const fs = require('node:fs');
const path = require('node:path');

const db = require('../lib/db');

async function main() {
  const where = db.settings();
  console.log(`Applying schema to ${where.user}@${where.host}:${where.port}/${where.database}`);

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

  // Multi-statement only on this connection; splitting the file on ';' would be
  // wrong because its comments contain them.
  const conn = await db.ddlConnection();
  try {
    await conn.query(schema);
  } finally {
    await conn.end();
  }

  const d = db.open();
  const sess = await d.prepare('SELECT COUNT(*) n FROM solar_store_sessions').get();
  const events = await d.prepare('SELECT COUNT(*) n FROM solar_store_events').get();

  console.log(`  solar_store_sessions  ${sess.n}`);
  console.log(`  solar_store_events    ${events.n}`);
  console.log('\nNext:\n  set TEBEX_PUBLIC_TOKEN and STORE_PUBLIC_URL in .env\n  npm start');

  await db.close();
}

main().catch(async (err) => {
  console.error('\nInitialisation failed:', err.message);
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    console.error('The database is unreachable. Check STORE_DB_* in .env.');
  } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('Credentials rejected. Check STORE_DB_USER / STORE_DB_PASSWORD.');
  } else if (err.code === 'ER_BAD_DB_ERROR') {
    console.error(`That database does not exist. Create it first:`);
    console.error(`  CREATE DATABASE ${db.settings().database} `
      + 'CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
  }
  await db.close().catch(() => {});
  process.exit(1);
});
