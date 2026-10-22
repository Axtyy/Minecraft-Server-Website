/**
 * Multi-page build: one HTML entry per tab, not one shell that swaps divs.
 *
 * The head and the cart drawer are the same wherever they appear, so they
 * live once in src/partials/ and are stitched in at build time by the plugin
 * below. The nav, the banner and the footer are not here at all: the server
 * renders those (lib/render/chrome.js).
 */
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PARTIALS = path.join(ROOT, 'src', 'partials');

/** `<!-- @include name -->` pulls in src/partials/name.html, recursively. */
function htmlPartials() {
  const read = (name, seen) => {
    if (seen.has(name)) throw new Error(`partial cycle at "${name}"`);
    const file = path.join(PARTIALS, `${name}.html`);
    if (!fs.existsSync(file)) throw new Error(`missing partial: src/partials/${name}.html`);
    return expand(fs.readFileSync(file, 'utf8'), new Set([...seen, name]));
  };
  const expand = (html, seen = new Set()) =>
    html.replace(/<!--\s*@include\s+([\w-]+)\s*-->/g, (_, name) => read(name, seen));

  return {
    name: 'solar-html-partials',
    // `pre` so Vite still sees (and hashes) any asset the partial references.
    transformIndexHtml: { order: 'pre', handler: (html) => expand(html) },
    configureServer(server) {
      // Editing a partial should reload the page that included it.
      server.watcher.add(PARTIALS);
      server.watcher.on('change', (file) => {
        if (file.startsWith(PARTIALS)) server.ws.send({ type: 'full-reload' });
      });
    },
  };
}

const page = (name) => path.join(ROOT, name);

export default defineConfig({
  plugins: [htmlPartials()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Not "assets" — public/assets/img already owns that path, and two
    // different meanings of one directory is how a build starts eating art.
    assetsDir: 'build',
    rollupOptions: {
      input: {
        store: page('index.html'),
        vote: page('vote.html'),
        stats: page('stats.html'),
        rules: page('rules.html'),
        punishments: page('punishments.html'),
        purchase: page('purchase.html'),
        terms: page('terms.html'),
        privacy: page('privacy.html'),
        notfound: page('404.html'),
      },
    },
  },
});
