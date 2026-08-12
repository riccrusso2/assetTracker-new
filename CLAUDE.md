# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Portfolio Tracker: a single-page React dashboard for tracking ETFs, stocks, startups, private equity, gold and cash, backed by a small Express API. UI copy, comments and docs are in **Italian** — keep new user-facing strings and comments in Italian to match.

## Commands

```bash
# Frontend dev (CRA, hot reload on :3000, proxies /api to :10000)
npm install && npm start

# Backend (separate deps in server/)
cd server && npm install && node server.js   # or npm run dev (nodemon)

# Tests (Jest via react-scripts, watch mode by default)
npm test
npm test -- --watchAll=false                 # single run (CI)
npm test -- -t "budget"                      # single test by name

# Production build + serve (server serves ../build if present)
npm run build && npm start                   # npm start = node server/server.js

# Docker (everything, :3000 → container :10000)
docker compose up --build --remove-orphans

# One-off migration of data/*.json into Supabase
MIGRATE_USER_ID=<uuid> node scripts/migrate.js
```

The pure, unit-tested core is four modules — [rebalance.js](src/rebalance.js), [transactions.js](src/transactions.js), [metrics.js](src/metrics.js), [tax.js](src/tax.js) — each with a sibling `*.test.js`. **Put new financial logic in one of them, never inside `App.js`**: `App.js` is untestable in practice, and a wrong number there looks exactly like a right one.

## Architecture

### Dual-mode backend (the central design constraint)

[server/server.js](server/server.js) runs in one of two modes, decided at boot by whether `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set:

- **Supabase mode** — multi-user. `requireAuth` ([server/auth.js](server/auth.js)) validates the Bearer JWT via `supabase.auth.getUser()` and sets `req.userId`; every query filters on it. The server client uses the **service-role key and bypasses RLS**, so the `req.userId` filter is the only tenant isolation on that path — never drop it. RLS policies in [supabase/schema.sql](supabase/schema.sql) protect the anon-key path as defence in depth.
- **Legacy mode** — single-user, no auth, JSON files in `data/` (`config.json`, `snapshots.json`) written with `writeJsonAtomic`.

The same fallback exists on the frontend: [src/supabaseClient.js](src/supabaseClient.js) exports `null` when the `REACT_APP_SUPABASE_*` env vars are missing, and [src/AuthGate.jsx](src/AuthGate.jsx) then mounts `App` directly with no login. **Any new endpoint or data path must work in both modes** — that invariant is what keeps the migration incrementally shippable (see [MIGRATION_SAAS.md](MIGRATION_SAAS.md)).

`App` is keyed by `session.user.id` in `AuthGate` so switching users forces a remount and clears localStorage-cached state.

### Data flow

Server is the source of truth; localStorage is a fallback cache only (`useLS` namespaces keys per user id).

- On mount `App` GETs `/api/config` and `/api/snapshots`. If config is absent it **resets local state to defaults** rather than keeping the cached previous user's data.
- All writes go through a **1.5s debounced auto-save** effect to `POST /api/config` (see around [App.js:1233](src/App.js#L1233)); there is no manual save button. `configLoaded` gates it so the initial load doesn't immediately echo back.
- All client→server calls go through `apiFetch` ([src/api.js](src/api.js)), which prefixes `REACT_APP_API_URL` and attaches the Supabase access token.

Config is stored as **one JSONB blob per user** (`portfolios.data`: `{ version, totalCash, assets[], startups[], assetClasses[], goldEtf, physGold, settings, transactions[] }`, `version: 4`), snapshots as one row per month with `unique (user_id, year, month)` driving the upsert. `toClientSnap` maps snake_case rows back to the client's camelCase shape — the wire contract has been kept identical to the pre-Supabase file format.

### Read-only sharing

`portfolios.share_token` (random 24-byte base64url) + `share_enabled` back a public link at `/p/<token>`. `GET /api/public/:token` is the **only** unauthenticated data route: it validates the token against `TOKEN_RE` *before* querying (an empty/malformed token must never match rows whose `share_token` is null), requires `share_enabled`, and returns `{ config, snapshots }` with `user_id` never leaving the server and **`transactions` stripped by `publicConfig`** (the movement log says when and at what price you bought — far more than sharing a portfolio implies; strip it server-side, never only in the UI). Owner-side `GET/POST/DELETE /api/share` stay behind `requireAuth`; `DELETE` flips `share_enabled` without dropping the token, so revoke/re-enable reuses the same link.

On the client, `AuthGate` matches the `/p/<token>` pathname *before* the session logic and mounts `App` with `shareToken`, which sets `readOnly`: config+snapshots come from the public endpoint, the debounced auto-save and the price-refresh interval bail out, the Impostazioni tab is filtered out and every mutating control is hidden. Frontend gating is cosmetic — the API is the actual boundary. Run both checks with `npm run test:share` (real server, both modes) and `npm test` (`src/App.share.test.js` covers the DOM).

### Financial logic

#### [src/rebalance.js](src/rebalance.js)

- `snapKey(asset)` — identity of an asset **across snapshots**, derived from the slugified name, deliberately *not* `id` (ids are random and regenerate on delete/re-add, which would split the history and count a repurchase as a contribution). Use it for any cross-snapshot lookup and as Recharts `dataKey`.
- `isTotalTargetAsset` — assets whose target % is measured against the **whole net worth** (gold, crypto) rather than the ETF sub-portfolio.
- `calcRebalancingTwoLevel` — level 1 funds the total-target items, level 2 sends the leftover budget to `calcRebalancing`, which distributes proportionally to normalized targets, **buy-only, never sells**, with a rounding-remainder fixup so the buys sum exactly to the budget.
- `calcRebalancing(assets, totalVal, budget, band)` — `band` is the tolerance in percentage points below target under which an asset is left alone. With `band > 0` the leftover budget goes only to out-of-band assets; with `band = 0` (default) behaviour is unchanged. Deltas are measured against the *current* total, not total+budget — see the `ponytail:` note there before changing it.
- Startups have a lifecycle (`active` / `exit` / `failed`); configs written before the field existed count as active.

#### [src/transactions.js](src/transactions.js) — the movement register

Optional and per-asset: `holdingFor(asset, txs)` returns the position derived from the movements when the asset has any, otherwise the hand-entered `quantity`/`costBasis`. `App.js` projects that onto the asset objects in **one** memo, so every downstream calculation keeps reading the same fields and knows nothing about the register. Consequences: `assets`/`goldEtf` in `App.js` are *derived*; the state setters and everything persisted use `storedAssets`/`storedGoldEtf`. Never save a derived position back to the config.

`costBasis` is deliberately **not** rounded: with fractional share counts a 2-decimal average price stops reconstructing the cost (~1 € on 30 k) and the displayed performance drifts. Rounding is the UI's job.

#### [src/metrics.js](src/metrics.js) — return and risk

Volatility, Sharpe and Sortino return `null` below 12 monthly observations and are flagged as indicative below 24 (`riskQuality`): a ratio built on five months describes which months landed in the sample, not the portfolio. `buildHistory` keys positions on `snapKey`, so deleting and re-adding an asset does not read as an external cash flow. `benchmarkSeries` compares the portfolio's return index against an asset already tracked in the snapshots — there is no historical price feed, and an asset held at quantity 0 works as a pure price tracker.

#### [src/tax.js](src/tax.js) — Italian tax

Uses **LIFO** lots (the regime amministrato criterion), deliberately different from the average cost used elsewhere to display performance. The rule that makes the module necessary: ETF gains are *redditi di capitale* and ETF losses are *redditi diversi*, so **they do not offset each other** — a year can close with +1000 and −1000 and still owe 260 €. Losses enter a four-year carry-forward pool, oldest spent first.

### Price sources

`/api/quote?isin=` proxies JustETF (European ETFs, 12-char ISIN). `/api/gold-price` proxies gold-api.com XAU/EUR and derives €/g and 18kt (÷31.1035 × 0.75). Both responses go through `cachedPrice` (in-memory Map, 5-minute TTL): the proxies are public and every client refresh would otherwise be an upstream call. `GET /health` is public and is what the Docker healthcheck probes — `/api/snapshots` answers 401 in Supabase mode. That endpoint uses a custom `https.Agent` pinned to 1.1.1.1/8.8.8.8 because Railway's musl resolver intermittently throws ENOTFOUND for that host — don't remove it. Both endpoints are public (no `requireAuth`) since they carry no user data.

## Env

`REACT_APP_*` vars are baked into the CRA bundle at build time (hence the `ARG`/`ENV` pairs in the [Dockerfile](Dockerfile)) — public keys only. Server secrets (`SUPABASE_SERVICE_ROLE_KEY`) live in `server/.env` and must never reach the browser.
