# PolyFarm CLI — Plan

> **Stack**: Node 22, TypeScript, pnpm, better-sqlite3, Commander.js, ethers v5 (via SDK)
> **Testing**: TDD (vitest, 165 tests) | **Mode**: Solo | **Created**: 2026-02-23
> **Archive**: Phases 0-12 → `.claude/memory/archive/Plans-phases-0-12.md` | Phases 15-16 → `.claude/memory/archive/Plans-phase-{15,16}.md`

## Status: Production (Helsinki VPS)

Phases 0-16 complete. Periodic inventory sweep deployed (merge/redeem/sell stale).

---

## Phase 17: Replace RPC Event Scanning with Polymarket Data API

### Context

Token discovery currently uses `discoverHeldTokens()` which scans TransferSingle/TransferBatch events on-chain in 3,000-block chunks. For a 2-week window (~604K blocks), this fires ~200 sequential RPC queries taking 2-5 minutes per call. The `killall` and `redeem` commands both depend on this slow scan. Additionally, tokens not in our DB (from delisted markets) can't be matched or sold.

The Polymarket Data API (`GET https://data-api.polymarket.com/positions`) returns all wallet positions in a single HTTP call with rich metadata: `conditionId`, `asset` (tokenId), `size`, `redeemable`, `negativeRisk`, `title`, `curPrice`, and more — no RPC event scanning needed.

### Root Causes of Current Issues

1. **Slow token discovery** — 200+ sequential `eth_getLogs` queries (2-5 min), fragile on free RPCs (rate limits, pruned history)
2. **DB-only market mapping** — `killall` and `redeem` can't handle tokens not in our DB (delisted/old markets), causing "orderbook does not exist" failures silently
3. **`killall` uses DB-only tokens** — `seller.ts:98-107` only checks `db.getMarkets()` token IDs, missing orphaned tokens from older sessions
4. **No `redeemable` signal** — `redeem` and auto-redeemer must attempt `estimateGas` preflight on every position to detect resolved markets (wasteful RPC calls)
5. **Inventory sweep = full event scan every 10 min** — Heavy RPC load for what should be a lightweight check

### Priority Matrix

| Priority | Task | Impact | Effort |
|----------|------|--------|--------|
| **Required** | 17.1 Add Polymarket Data API client | Foundation for all other tasks | Small |
| **Required** | 17.2 Replace `discoverHeldTokens` with Data API in sweep | Eliminates 200+ RPC queries every 10 min | Medium |
| **Required** | 17.3 Upgrade `killall` to use Data API positions | Finds ALL positions including unlisted markets | Medium |
| **Required** | 17.4 Upgrade `redeem` to use Data API `redeemable` flag | Skips estimateGas preflight for unresolved markets | Medium |
| **Recommended** | 17.5 Keep RPC `getTokenBalances` as verification fallback | Safety net for API downtime | Small |
| **Optional** | 17.6 Show enriched position data in dashboard | Better visibility with curPrice, pnl from API | Small |

### Tasks

- [x] 17.1 Add Polymarket Data API positions client `[feature:tdd]`
  **File**: `src/api/positions-api.ts` (new)
  - `fetchWalletPositions(address, options?)` → typed array of positions
  - Parameters: `user` (required), `sizeThreshold`, `redeemable`, `mergeable`, `limit`, `offset`
  - Response type: `DataApiPosition` with fields: `asset`, `conditionId`, `size`, `avgPrice`, `currentValue`, `curPrice`, `redeemable`, `negativeRisk`, `title`, `outcome`, `outcomeIndex`, `oppositeAsset`
  - Uses axios (already a dependency for gamma.ts)
  - Pagination: auto-paginate up to 500 per page until exhausted
  - Error handling: timeout + retry with backoff (same pattern as gamma.ts)
  - Tests: mock responses, pagination, error handling

- [x] 17.2 Replace `discoverHeldTokens` with Data API in inventory sweep `[feature:tdd]`
  **Files**: `src/positions/fetcher.ts`, `src/cli/commands/run.ts`
  - New function `discoverHeldTokensViaApi(address)` in fetcher.ts
    - Calls `fetchWalletPositions(address, { sizeThreshold: 0.01 })`
    - Maps API response to existing `TokenBalance[]` format for backward compat
    - Also returns enriched metadata (conditionId, negRisk, redeemable) for callers that want it
  - `performInventorySweep()` in run.ts: swap `discoverHeldTokens(wallet, env)` → `discoverHeldTokensViaApi(wallet.address)`
  - Fallback: if API call fails, log warning and fall back to RPC `discoverHeldTokens()`
  - Keep original `discoverHeldTokens()` intact (used as fallback)

- [x] 17.3 Upgrade `killall` command to use Data API `[feature:tdd]`
  **Files**: `src/cli/commands/killall.ts`, `src/positions/seller.ts`
  - `killall.ts`: Replace `discoverHeldTokens()` call with `fetchWalletPositions()`
  - Display enriched info: market title, current price, redeemable status, PnL
  - `seller.ts` `killAllPositions()`: Accept positions from API (not just DB markets)
    - Currently uses `db.getMarkets()` → misses orphaned tokens
    - New: accept `DataApiPosition[]` to sell ALL positions including unlisted
    - For each position: use `asset` as tokenId, `negativeRisk` for negRisk, infer tick_size from price precision
  - Auto-redeem positions where `redeemable: true` before trying market-sell
  - Better error reporting: distinguish "orderbook not found" (delisted) vs "no liquidity" vs "balance mismatch"

- [x] 17.4 Upgrade `redeem` command to use Data API `redeemable` flag `[feature:tdd]`
  **Files**: `src/cli/commands/redeem.ts`, `src/positions/auto-redeemer.ts`
  - `redeem.ts`: Replace `discoverHeldTokens()` with `fetchWalletPositions()`
    - Filter `redeemable: true` positions from API response
    - No need for DB market matching — API provides title, conditionId, negRisk
    - Skip `estimateGas` preflight since API confirms redeemability
  - `auto-redeemer.ts`: Accept `DataApiPosition[]` instead of `TokenBalance[]`
    - Only attempt redeem on positions where `redeemable: true`
    - Eliminates wasteful estimateGas calls on unresolved markets
  - `--force` flag: attempt redeem even if API says not redeemable (edge case override)

- [x] 17.5 RPC fallback for API downtime `[feature:tdd]`
  **File**: `src/positions/fetcher.ts`
  - New `discoverPositions(wallet, env, options?)` unified function
    - Primary: Polymarket Data API (`fetchWalletPositions`)
    - Fallback: RPC event scanning (`discoverHeldTokens`) if API fails
    - Returns unified `DiscoveredPosition[]` type with both TokenBalance data + optional API metadata
  - Callers migrate from `discoverHeldTokens()` → `discoverPositions()`
  - `env.ts`: Add optional `POLYMARKET_DATA_API_URL` config (default: `https://data-api.polymarket.com`)

- [ ] 17.6 Enriched position data in dashboard `[optional]`
  **Files**: `src/dashboard/server.ts`, `src/dashboard/html.ts`
  - Stale positions section: show current price, PnL, redeemable badge from API data
  - Add total portfolio value from Data API `/value` endpoint
  - Cache API response (30s TTL) to avoid hammering on SSE refreshes

### Files Changed

| File | Change |
|------|--------|
| `src/api/positions-api.ts` | New: Polymarket Data API client |
| `src/positions/fetcher.ts` | New `discoverHeldTokensViaApi()`, unified `discoverPositions()` |
| `src/cli/commands/killall.ts` | Use Data API, enriched display, auto-redeem redeemable |
| `src/cli/commands/redeem.ts` | Use Data API `redeemable` flag, skip preflight |
| `src/positions/seller.ts` | Accept API positions, handle unlisted markets |
| `src/positions/auto-redeemer.ts` | Accept API positions, skip unresolved via flag |
| `src/cli/commands/run.ts` | Sweep uses API instead of event scanning |
| `src/dashboard/server.ts` | Enriched stale positions, portfolio value |
| `src/dashboard/html.ts` | Richer position display |
| `src/utils/config.ts` | `POLYMARKET_DATA_API_URL` env var |
| `tests/unit/positions-api.test.ts` | New: API client tests |
| `tests/unit/sweep.test.ts` | Updated: API-based sweep tests |

### Verification

1. `npx tsc --noEmit` + `npx vitest run` — clean compile, all tests pass
2. Manual test: `polyfarm redeem --dry-run` completes in <2s (vs 2-5 min before)
3. Manual test: `polyfarm killall --dry-run` shows ALL positions including unlisted
4. Deploy and verify sweep logs — should complete in <5s per cycle (vs 2-5 min)
5. API downtime test: set `POLYMARKET_DATA_API_URL=http://localhost:1` → verify RPC fallback kicks in

---

## Deployment

- **GitHub**: https://github.com/sneg55/farmpoly (private)
- **GHCR**: ghcr.io/sneg55/farmpoly:latest
- **CI**: GitHub Actions (test on PR, build+push on merge to main)
