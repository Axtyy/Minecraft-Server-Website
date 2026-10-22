'use strict';
/**
 * Minimal KEY=value reader for .env, so there is no dotenv dependency.
 *
 * Runs once on first require. Real environment variables always win, so a value
 * set by systemd or passed on the command line overrides the file.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

let loaded = false;

function load(file = path.join(ROOT, '.env')) {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(file)) return;

  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

load();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

module.exports = { load, required, ROOT };
