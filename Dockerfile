# SolarWebsite — the site, and the Tebex reverse proxy behind its store.

# --- build: the pages, bundled ------------------------------------------
# Vite and Tailwind are devDependencies and have no business in the image
# that runs in production, so they stay in this stage.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY vite.config.js ./
COPY src ./src
COPY public ./public
COPY *.html ./
# The page bodies are rendered by lib/render/, so Tailwind has to scan those
# files too (see the @source in src/styles/app.css). Without them the build
# still succeeds and still emits a stylesheet — one that is quietly missing
# every grid and column the server-rendered markup uses.
COPY lib ./lib
RUN npm run build

# --- run: node, the server, and the built site --------------------------
FROM node:22-alpine
WORKDIR /app

# Dependencies first, so a code change does not re-resolve the tree.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY content ./content
COPY content.example ./content.example
# scripts/init-db.js applies db/schema.sql, and the compose stack blocks the
# website on that job completing. Copying it is not optional.
COPY db ./db
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3100

# Node handles SIGTERM itself (server.js installs a handler), so there is no
# init shim here — a wrapper would swallow the signal and force a 10s kill.
CMD ["node", "server.js"]
