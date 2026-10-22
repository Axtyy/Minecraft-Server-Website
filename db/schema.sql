-- SolarWebsite · store session and basket mapping
--
-- Timestamps are epoch milliseconds, matching every other Solar table.
-- Idempotent: safe to re-run against a live database.

/* Maps a browser session to a Tebex basket.
 *
 * This table is the whole reason the store is safe to run in public. A Tebex
 * basket ident is a bearer capability: whoever holds it can read the basket,
 * add to it, and take it to checkout. Handing it to the browser — which is what
 * a "just call Tebex from JavaScript" store does — means it lives in devtools,
 * in the browser history, and in any script the page loads.
 *
 * So the browser gets `id`, an opaque random value in an HttpOnly cookie, and
 * the ident stays here. Nothing the client can read maps back to Tebex.
 *
 * Case-sensitive collation on the id: these are base64url, where "A" and "a"
 * are different sessions, and the ci collation used elsewhere would treat them
 * as the same row.
 */
CREATE TABLE IF NOT EXISTS solar_store_sessions (
  id            VARCHAR(64)  NOT NULL COLLATE utf8mb4_bin,
  basket_ident  VARCHAR(191) NULL,
  -- Who the basket is for. Tebex needs this to deliver the package in game.
  username      VARCHAR(191) NULL,
  uuid          VARCHAR(36)  NULL,
  -- Bedrock players are delivered against a different identifier, so which
  -- edition was chosen has to survive the round trip to checkout.
  edition       VARCHAR(16)  NULL,
  created_at    BIGINT       NOT NULL,
  last_seen     BIGINT       NOT NULL,
  expires_at    BIGINT       NOT NULL,
  PRIMARY KEY (id),
  KEY idx_store_sessions_exp (expires_at),
  KEY idx_store_sessions_basket (basket_ident)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* What the store did, for tracing a complaint back to a basket.
 *
 * Deliberately not a copy of Tebex's order history — Tebex owns that, and
 * duplicating money into a second system is how the two end up disagreeing.
 * This only records what *this* service did on someone's behalf.
 */
CREATE TABLE IF NOT EXISTS solar_store_events (
  id           BIGINT       NOT NULL AUTO_INCREMENT,
  -- basket_created | package_added | package_removed | checkout | auth
  event        VARCHAR(32)  NOT NULL,
  session_id   VARCHAR(64)  NULL COLLATE utf8mb4_bin,
  basket_ident VARCHAR(191) NULL,
  username     VARCHAR(191) NULL,
  package_id   INT          NULL,
  quantity     INT          NULL,
  -- Truncated to a /24 (or /48 for v6) before it is written; see lib/net.js.
  ip_prefix    VARCHAR(64)  NULL,
  occurred_at  BIGINT       NOT NULL,
  PRIMARY KEY (id),
  KEY idx_store_events_at (occurred_at DESC),
  KEY idx_store_events_session (session_id, occurred_at DESC),
  KEY idx_store_events_basket (basket_ident)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
