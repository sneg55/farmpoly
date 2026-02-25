# PolyFarm CLI — Plan

> **Stack**: Node 22, TypeScript, pnpm, better-sqlite3, Commander.js, ethers v5 (via SDK)
> **Testing**: TDD (vitest, 57 tests) | **Mode**: Solo | **Created**: 2026-02-23

## Status: MVP Complete

All phases implemented. Deployed to Railway (Singapore region).
Blocked by Polymarket geoblock — Singapore is "Close-Only" since Jan 2025.

---

## Phase 0: Scaffolding — DONE

- [x] 0.1 TypeScript project + tooling (pnpm, strict ESM, vitest, eslint, prettier)
- [x] 0.2 Security essentials (.env.example, .gitignore, git-track guard)
- [x] 0.3 SQLite schema (markets, orders, sessions tables + WAL mode + indexes)

## Phase 1: Authentication — DONE

- [x] 1.1 Secure .env key loader (hex validation, git-track check, URL scheme validation)
- [x] 1.2 L2 credential derivation (ClobClient SDK, cached in SQLite)
- [x] 1.3 USDC approval flow (allowance check + approve on Polygon)

## Phase 2: Market Discovery — DONE

- [x] 2.1 Gamma API market fetcher (pagination, TVL filter, JSON-encoded field parsing)
- [x] 2.2 Reward market filter (clobRewards rate, safety bounds 0.10-0.90)
- [x] 2.3 `polyfarm discover` command (--min-tvl, chalk table, DB upsert)

## Phase 3: Order Placement — DONE

- [x] 3.1 Safe distance calculator (midpoint ± spread, tick rounding, bounds clamping)
- [x] 3.2 Order signing + placement (SDK, GTD expiry, diagnostic skip logging)
- [x] 3.3 Budget allocator (equal-weight, smart minSize pre-filter, --min-size override)

## Phase 4: WebSocket Safety Loop — DONE

- [x] 4.1 WebSocket connection manager (ws, exponential backoff, runtime validation)
- [x] 4.2 Midpoint drift detector (in-memory order index, O(1) lookup per tick)
- [x] 4.3 Defensive cancellation (Promise.allSettled, <200ms target, slow-cancel alerts)
- [x] 4.4 Order replacement (500ms cooldown, safe price recalc)

## Phase 5: CLI Commands — DONE

- [x] 5.1 `polyfarm init` (key load → derive → approve → report)
- [x] 5.2 `polyfarm run` daemon (--budget, --spread, --max-markets, --min-size, --danger-zone)
- [x] 5.3 `polyfarm status` + `polyfarm dashboard` (SSE, shared publisher, XSS-safe, pagination)
- [x] 5.4 `polyfarm panic` (cancel all via API + DB)

## Phase 6: Integration & Hardening — DONE

- [x] 6.1 Live test ($30 budget, order signing verified, 403 geoblock confirmed)
- [x] 6.2 Codex review + fixes (security D→B, perf C→B, quality C→B, arch C+→B)
- [x] 6.3 README + Dockerfile + GitHub Actions CI + Railway deployment

---

---

## Phase 7: Production Bug Fixes (GitHub Issue #1) `[bugfix:reproduce-first]`

> **Ref**: [GitHub Issue #1 — Production deployment failures](https://github.com/sneg55/farmpoly/issues/1)
> **Environment**: Helsinki (ARM64), $103.76 USDC, `--budget 100 --spread 5 --max-markets 10`

### 7.1 Fix SQLite FK constraint on order insert — [x] DONE

**Bug**: `placer.ts:insertOrder()` fails with `FOREIGN KEY constraint failed` because markets are never upserted into the `markets` table during `run` command. Only `discover` command calls `db.upsertMarket()`.

**Root cause**: `run.ts` calls `discoverAndAllocate()` → `filterRewardMarkets()` which returns `RewardMarket[]` objects, then passes them to `placeOrdersForMarkets()` which calls `db.insertOrder()` with `condition_id` referencing `markets(condition_id)` FK — but the market row doesn't exist yet.

**Fix**:
1. In `placeOrdersForMarkets()` (or `run.ts` before calling it), upsert each `RewardMarket` into the `markets` table before inserting orders
2. Add a helper `db.upsertFromRewardMarket(market: RewardMarket)` to avoid duplicating the field mapping
3. Add test: placing an order for a market not in DB should not crash (upsert first)

**Files**: `src/orders/placer.ts`, `src/db/database.ts`, `src/cli/commands/run.ts`

### 7.2 Fix heartbeat chaining — [x] DONE

**Bug**: `postHeartbeat(null)` starts a new heartbeat chain, server returns `heartbeat_id`. Subsequent calls with that ID fail with `"Invalid Heartbeat ID"`. Logs show the returned ID is immediately rejected on the next call.

**Root cause**: The SDK's `postHeartbeat()` may return the response inside a wrapper (e.g., `response.data.heartbeat_id` vs `response.heartbeat_id`), or the server rejects stale IDs when >10s have elapsed between heartbeats (our 8s interval may be too close to the 10s server timeout, causing race conditions under network latency).

**Fix**:
1. Log the full heartbeat response object to diagnose the actual shape
2. On `"Invalid Heartbeat ID"` error, reset `heartbeatId = null` and start a fresh chain (don't count as failure)
3. Reduce heartbeat interval from 8s to 5s for more margin against the 10s server timeout
4. Add retry with fresh chain on 400 errors before counting as failure

**Files**: `src/cli/commands/run.ts`

### 7.3 Fix "not enough balance / allowance" errors — [x] DONE

**Bug**: Orders fail with balance/allowance error despite $103 USDC and verified approvals.

**Root cause (likely)**: The `createOrder` SDK call computes order signing based on `price × size` but Polymarket may require balance for the full notional. With smart allocation splitting $100 across 10 markets, some order sizes may exceed what the remaining unallocated balance can cover (previous orders already lock up balance). Also, ASK (SELL YES) orders may require holding YES tokens or posting collateral that we don't have.

**Fix**:
1. Add error handling around individual order placement that logs the exact `price`, `size`, `side`, and `tokenId` when balance errors occur
2. For ASK/SELL orders: verify we understand the collateral model — selling YES tokens we don't own requires posting USDC collateral equal to `(1 - price) × size`
3. Fix budget calculation: BID costs `price × size` USDC, ASK costs `(1 - price) × size` USDC. Current `sharesToBuy(perSideUsdc, 1 - askPrice)` may be wrong — it computes how many shares you can buy at `1 - askPrice`, but for a SELL the cost model is different
4. Track cumulative committed capital across all markets to avoid over-committing

**Files**: `src/orders/placer.ts`, `src/orders/calculator.ts`

### 7.4 Add integration test for order placement flow — [x] DONE

**Test**: Unit test that verifies the full flow: `discoverAndAllocate()` → `upsertMarket()` → `placeOrdersForMarkets()` → orders exist in DB with correct FK relationships.

**Files**: `tests/unit/placer.test.ts`

---

## Priority Matrix

| Priority | Task | Impact |
|----------|------|--------|
| **Required** | 7.1 FK constraint fix | 0 orders placed — total blocker |
| **Required** | 7.3 Balance/allowance fix | Orders rejected even with sufficient USDC |
| **Required** | 7.2 Heartbeat fix | Cascading failures → panic shutdown |
| **Recommended** | 7.4 Integration test | Prevent regression |

---

## Known Issues

| Issue | Status | Detail |
|-------|--------|--------|
| Polymarket geoblock (SG) | Resolved | Moved to Helsinki VPS (Finland, non-restricted) |
| SQLite FK constraint | Phase 7.1 | Markets not upserted before order insert |
| Balance/allowance error | Phase 7.3 | Budget/collateral calculation needs fix |
| Heartbeat chaining | Phase 7.2 | Invalid heartbeat ID on subsequent calls |

## Deployment

- **GitHub**: https://github.com/sneg55/farmpoly (private)
- **GHCR**: ghcr.io/sneg55/farmpoly:latest
- **Railway**: https://railway.com/project/b52d7201-7a76-4fd2-9955-b8137b9a2d16
- **CI**: GitHub Actions (test on PR, build+push on merge to main)
