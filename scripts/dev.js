'use strict';
/**
 * `npm run dev` — the site, rebuilt on change, served by the real server.
 *
 * Open http://localhost:3100.
 *
 * Why not Vite's dev server any more: the pages are rendered by server.js now
 * (lib/render/ fills the <!--NAV-->, <!--PAGE--> and <!--FOOTER--> markers).
 * Vite would serve those HTML files straight from disk with the markers still
 * in them — a blank page with a working stylesheet. So Vite runs as a watching
 * BUILD here, and the server serves what it writes.
 *
 * The trade is honest: no hot module replacement. Edits to src/ and lib/
 * rebuild and the server picks them up; you refresh the page yourself.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// Run the installed Vite entry point with Node instead of spawning `npx`.
// On Windows, directly spawning the `npx.cmd` shim can throw `spawn EINVAL`
// (notably with newer Node releases).
const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const procs = [
  // Rebuilds dist/ on every change to src/, the HTML shells, or lib/render/.
  spawn(process.execPath, [vite, 'build', '--watch'], { cwd: ROOT, stdio: 'inherit' }),
  // --watch restarts the server when server.js or lib/ changes.
  spawn(process.execPath, ['--watch', 'server.js'], { cwd: ROOT, stdio: 'inherit' }),
];

let closing = false;
function stop(code) {
  if (closing) return;
  closing = true;
  procs.forEach((p) => { if (!p.killed) p.kill(); });
  process.exit(code || 0);
}

// If either half dies the other is useless, so they go down together.
procs.forEach((p) => {
  p.on('exit', (code) => stop(code));
  p.on('error', (err) => {
    console.error(`[dev] could not start: ${err.message}`);
    stop(1);
  });
});

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
