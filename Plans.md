# PolyFarm CLI — MVP Plan

> **Stack**: Node 20 LTS, TypeScript, pnpm, better-sqlite3, Commander.js, ethers.js v6
> **Testing**: Full TDD (vitest) | **Mode**: Solo | **Created**: 2026-02-23

## Architecture Decision

Use `@polymarket/clob-client` SDK (v5.2.1) for auth + order signing. Build custom: market discovery (Gamma API), WebSocket safety loop (`ws`), SQLite state, CLI.

---

## Phase 0: Scaffolding (2-3 days)

### 0.1 Init TypeScript project + tooling `cc:TODO`
- pnpm + tsconfig (strict, ESM, ES2022) + vitest + eslint + prettier
- Dirs: `src/{auth,discovery,orders,safety,db,cli,utils}`, `tests/{unit,integration}`

### 0.2 Security essentials `cc:TODO`
- `.env.example`, `.gitignore` (.env, *.db, node_modules, dist), git-track guard

### 0.3 SQLite schema (TDD) `cc:TODO`
- Tables: `markets`, `orders`, `sessions`, `config` — see `src/db/schema.sql`

---

## Phase 1: Authentication [feature:security] (3-4 days)

### 1.1 Secure .env key loader (TDD) `cc:TODO`
- Read POLYGON_PRIVATE_KEY, validate hex/64-char, refuse if git-tracked

### 1.2 L2 credential derivation (TDD) `cc:TODO`
- `ClobClient.deriveApiKey()` → store in SQLite config → cache on re-runs

### 1.3 USDC approval flow (TDD) `cc:TODO`
- Check `allowance()` on Polygon USDC (`0x2791Bca1...`), `approve()` Exchange contract if needed

---

## Phase 2: Market Discovery (3-4 days)

### 2.1 Gamma API market fetcher (TDD) `cc:TODO`
- `GET gamma-api.polymarket.com/markets` — paginate, filter active + TVL > $10k

### 2.2 Reward market filter (TDD) `cc:TODO`
- Cross-ref CLOB reward data with Gamma markets, safety bounds (midpoint 0.10–0.90)

### 2.3 `polyfarm discover` command (TDD) `cc:TODO`
- `--min-tvl <amount>`, chalk table: Question | Midpoint | TVL | Rewards | Spread

---

## Phase 3: Order Placement [feature:security] (4-5 days)

### 3.1 Safe distance calculator (TDD) `cc:TODO`
- Midpoint ± spread → bid/ask prices, tick size validation, clamp to safety bounds

### 3.2 Order signing + placement (TDD) `cc:TODO`
- SDK order creation, expiry 23:59:59 UTC, record in SQLite orders table

### 3.3 Budget allocator (TDD) `cc:TODO`
- Split USDC across top markets (equal-weight by reward rate), BID+ASK per market

---

## Phase 4: WebSocket Safety Loop [feature:security] (5-6 days) — CRITICAL

### 4.1 WebSocket connection manager (TDD) `cc:TODO`
- `ws` lib → `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Reconnect: 1s→2s→4s→8s→panic@10s, heartbeat detection

### 4.2 Midpoint drift detector (TDD) `cc:TODO`
- Parse `book` events → compute midpoint → flag orders within danger zone (<2¢)

### 4.3 Defensive cancellation (TDD) `cc:TODO`
- `DELETE /order` within 200ms, update SQLite, retry once then panic on failure

### 4.4 Order replacement (TDD) `cc:TODO`
- 500ms cooldown → recalc safe prices → place new order, skip if outside bounds

---

## Phase 5: CLI Commands (3-4 days)

### 5.1 `polyfarm init` (TDD) `cc:TODO`
- Orchestrate: key load → L2 derive → USDC check → approve → report, idempotent

### 5.2 `polyfarm run` daemon (TDD) `cc:TODO`
- `--budget <USDC> --spread <cents>` → discover → allocate → place → safety loop
- SIGINT/SIGTERM graceful shutdown

### 5.3 `polyfarm status` (TDD) `cc:TODO`
- SQLite + live CLOB data → dashboard: orders, midpoints, fill rate, est. APY

### 5.4 `polyfarm panic` (TDD) `cc:TODO` [feature:security]
- Bypass SQLite → CLOB API cancel ALL orders in parallel, exit code 0/1

---

## Phase 6: Integration & Hardening (3-4 days)

### 6.1 E2E test: init → discover → run `cc:TODO`
- Live APIs, $5 budget, verify orders + WebSocket + cancellation

### 6.2 Resilience testing `cc:TODO`
- WS reconnection, concurrent cancellations, rate limit handling, market close mid-session

### 6.3 README + .env.example `cc:TODO`

---

## Priority Matrix

| Priority | Scope | Rationale |
|----------|-------|-----------|
| **Required** | P0-P4, P5.4 (panic) | Core loop + capital preservation |
| **Recommended** | P5.1-5.3, P6.1-6.2 | Full CLI + confidence testing |
| **Optional** | P6.3 | Documentation |

## Key References

- [CLOB API](https://docs.polymarket.com/developers/CLOB/introduction) | [Auth](https://docs.polymarket.com/developers/CLOB/authentication) | [WebSocket](https://docs.polymarket.com/developers/CLOB/websocket/wss-overview)
- [Gamma API](https://docs.polymarket.com/developers/gamma-markets-api/overview) | [Rewards](https://docs.polymarket.com/developers/market-makers/liquidity-rewards)
- [clob-client SDK](https://github.com/Polymarket/clob-client) | [Reference MM](https://github.com/Polymarket/poly-market-maker)

## Notes

- Rewards epochs = 7 days, daily distribution at midnight UTC
- Two-sided liquidity gets ~3x rewards vs single-sided → always place BID+ASK
- Realistic APY: 10-40% depending on capital, market selection, spread
