# Minecraft Server Website

A complete website for a Minecraft server: a **Tebex Headless store**, player
**stats and leaderboards**, a **vote** page, **rules**, a public **punishments**
list, and the **terms** and **privacy** pages a store needs. Pages are rendered
on the server, so they load fast and work before any script has run.

## Try it in one minute

You need Node 20 or newer. No database, Tebex account or Minecraft server
is needed for the demo.

```sh
npm install
npm run demo
```

Open <http://localhost:3100>. Everything works on sample data:

- Sign in with any Minecraft username, add items to the cart and change quantities.
- Check out. The demo has its own payment page in place of Tebex. Press **Pay (demo)** and you get the real receipt page. No card is asked for and nothing is charged.
- Browse the stats boards (playtime, kills, K/D, killstreak, votes) by day, week, month and lifetime, and open a player profile.
- Search and filter the punishments list, and open a staff member's "given" tab.

Demo baskets and sessions live in memory and are gone after a restart.

## What it does on a live server

| Page | Reads from |
| --- | --- |
| Store, cart, checkout | Tebex Headless, proxied by this server |
| Stats, leaderboards, profiles | A MariaDB/MySQL database of player sessions and votes, plus your gamemode's stat columns |
| Vote | `content/vote.json`, and a monthly top-voter board when a vote database is set |
| Punishments | A MariaDB/MySQL `punishments` table |
| Rules, terms, privacy | `content/*.json` |
| Player count in the header | A Minecraft status ping to your server |

Each source is optional. A page whose source is not configured says so and
does not fail. The stats and punishments queries were written for one
network's plugins. `lib/stats.js` and `lib/punishments.js` show the tables
they expect. Point those queries at your own plugins' tables, or keep those
pages switched off.

### Security

The browser only talks to this server. The Tebex token and the basket ident
stay server-side. The ident is a bearer capability: whoever holds it can change
the basket and take it to checkout. The session cookie is an opaque random id,
HttpOnly and SameSite=Lax. Pages are served with a strict Content-Security-Policy
(`script-src 'self'`, `connect-src 'self'`). Writes from other origins are refused,
and writes are rate-limited.

## Setting it up for real

1. Copy `.env.example` to `.env` and fill it in. At least set:
   - `TEBEX_PUBLIC_TOKEN`
   - `TEBEX_SECRET_KEY`
   - `STORE_PUBLIC_URL`
   - `STORE_NAME`
   - `STORE_CONTACT_EMAIL`
   - `STORE_SERVER_IP`
   - the `STORE_DB_*` settings
2. Create the sessions table with `npm run init`.
3. Build and start the site with `npm run build`, then `npm start`. You can also use the Dockerfile.
4. Put it behind a reverse proxy with HTTPS, then set `COOKIE_SECURE=true` and `TRUST_PROXY=true`.

Every setting is explained in `.env.example`.

### Your own text and look

- **Text.** Put your own `vote.json`, `rules.json`, `terms.json` and `privacy.json` in `content/`. Any file you leave out comes from `content.example/`, where `{name}` and `{email}` are filled from `STORE_NAME` and `STORE_CONTACT_EMAIL`. The example terms and privacy policy are a starting point only: have them checked for where you and your buyers are.
- **Look.**
  - `STORE_SKIN` sets the background: `graphite` or `sky`.
  - `STORE_ACCENT` sets the accent colour: `blue`, `ember` or `gem`.
  - Visitors choose light or dark mode themselves.
  - Replace the images in `public/assets/img/` with your own logo and package art.
- **Store.** Tebex categories and packages appear automatically. To keep a category off the page, add its slug to `STORE_HIDDEN_CATEGORIES`.

## Development

`npm run dev` rebuilds on change and restarts the server. Add `DEMO_MODE=true`
to your `.env` to develop with no backend.

## License

[MIT](LICENSE). Use it, change it and share it. Keep the copyright notice.
