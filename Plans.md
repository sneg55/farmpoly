# PolyFarm CLI — Plan

> **Stack**: Node 22, TypeScript, pnpm, better-sqlite3, Commander.js, ethers v5 (via SDK)
> **Testing**: TDD (vitest, 90 tests) | **Mode**: Solo | **Created**: 2026-02-23

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

## Phase 7: Production Bug Fixes (GitHub Issue #1) — DONE

> **Ref**: [GitHub Issue #1](https://github.com/sneg55/farmpoly/issues/1)

- [x] 7.1 Fix SQLite FK constraint (upsert markets before order insert)
- [x] 7.2 Fix heartbeat chaining (reset on invalid ID, 8s→5s interval)
- [x] 7.3 Fix balance errors (cumulative capital tracking, detailed error logging)
- [x] 7.4 Add order placement tests (6 tests in placer.test.ts)

## Phase 8: Production Bug Fixes Round 2 (GitHub Issue #2) — DONE

> **Ref**: [GitHub Issue #2](https://github.com/sneg55/farmpoly/issues/2)

- [x] 8.1 Fix heartbeat: SDK returns errors as values, not exceptions — check `response.error` first
- [x] 8.2 Fix min-size: `calculateMinCapitalRequired` → `2 × max(bidCost, askCost)` for 50/50 split
- [x] 8.3 Fix balance: cancel stale orders at startup + 2% safety margin on budget
- [x] 8.4 Add heartbeat tests (11 tests in heartbeat.test.ts)

## Phase 9: Production Bug Fixes Round 3 (GitHub Issue #3) — DONE

> **Ref**: [GitHub Issue #3](https://github.com/sneg55/farmpoly/issues/3)
> **Note**: Issue filed on commit 21b4a8e (pre-Phase 8). Phase 8 fix (432209b) not yet deployed.

### 9.1 Add ERC1155 Conditional Token approvals for SELL orders — cc:DONE

**Bug**: All ASK (SELL) orders fail with "not enough balance / allowance" while BID (BUY) succeed.

**Root cause** (confirmed via [py-clob-client#265](https://github.com/Polymarket/py-clob-client/issues/265) + SDK source): SELL orders require `setApprovalForAll()` on the ConditionalTokens ERC1155 contract to both exchanges + NegRiskAdapter. Our `approval.ts` only approves USDC (ERC20).

**Fix**: Add `isApprovedForAll` check + `setApprovalForAll` for ConditionalTokens (`0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`) to 3 spenders: CTF Exchange (`0x4bFb...82E`), NegRisk Exchange (`0xC5d...80a`), NegRiskAdapter (`0xd91...296`). Update `checkApproval` + `polyfarm init`.

**Files**: `src/auth/approval.ts`, `src/cli/commands/init.ts`

### 9.2 Heartbeat resilience — debug logging + null-only fallback — cc:DONE

**Bug**: Heartbeat loops null→ID→"Invalid"→null every 5s. Issue was filed pre-Phase 8 — the old code read `heartbeat_id` from error responses (SDK returns errors as values). Phase 8 fix (432209b) properly checks `response.error` first, which likely resolves the root cause.

**Remaining risk**: If chaining still fails after Phase 8 deploy, orders stay alive (null resets the 10s timeout each call) but logs are noisy.

**Fix** (defensive):
1. Add debug logging: log response JSON on first success + on errors (dimmed)
2. After 3 consecutive chain failures, stop chaining — always send null (silent)
3. Log heartbeat status once per minute instead of every 5s

**Files**: `src/cli/commands/run.ts`

### 9.3 Add approval tests — cc:DONE

**Test**: Unit tests for ERC1155 approval flow with mocked contracts.

**Files**: `tests/unit/approval.test.ts`

## Phase 10: Production Bug Fixes Round 4 (GitHub Issue #4) — DONE

> **Ref**: [GitHub Issue #4](https://github.com/sneg55/farmpoly/issues/4)

### 10.1 Fix budget off-by-one: ASK order incorrectly blocked — cc:DONE

**Bug**: With $100 budget and 1 market, BID ($50) placed OK but ASK skipped with "would exceed budget ($50.00 + $50.00 > $100)". The math `$50 + $50 = $100` should pass, but the 2% safety margin (`effectiveBudget = totalBudgetUsdc * 0.98 = $98`) causes `$50 + $50 = $100 > $98` to reject the ASK.

**Root cause**: `placer.ts:93` applies `effectiveBudget = totalBudgetUsdc * 0.98` as a hard ceiling. When smart allocation gives a market exactly the full budget (e.g. single-market case), the 2% margin steals $2 from a perfectly valid $100 plan. The safety margin was added in Phase 8.3 for multi-market rounding edge cases but is too aggressive for single-market deployments.

**Fix**: Change the budget guard from a 2% blanket reduction to a small absolute epsilon (e.g. `$0.01`). The cumulative tracker already prevents over-commitment — the margin only needs to absorb floating-point rounding, not reserve 2% of capital.

**Files**: `src/orders/placer.ts`
**Test**: Update `tests/unit/placer.test.ts` — add test that BID+ASK both place when they exactly equal the budget.

### 10.2 Fix heartbeat null→empty string + fallback escalation — cc:DONE

**Bug**: After 3 chain failures, code sends `null` as heartbeat ID. But `postHeartbeat(null)` also returns `{ error: "Invalid Heartbeat ID" }`, which re-enters the chain-failure branch and logs the SDK's own `[CLOB Client] request error` on every 5s tick forever.

**Root cause**: When `consecutiveChainFailures >= MAX_CHAIN_FAILURES`, the code sends `null` but still processes the response through the same error-checking path. The SDK's internal logging (`[CLOB Client] request error`) cannot be suppressed from our side.

**Fix**:
1. When in null-fallback mode, treat "Invalid Heartbeat ID" responses as expected (don't increment `consecutiveChainFailures` further, don't log)
2. The real fix: `postHeartbeat(null)` should start a **new** chain — if even that fails, it means the API key or auth is invalid. Count those as real failures toward panic threshold.
3. Alternative: if null heartbeat consistently fails, stop the heartbeat interval entirely and log a single warning.

**Files**: `src/cli/commands/run.ts`
**Test**: Add test cases to `tests/unit/heartbeat.test.ts` for null-fallback mode behavior.

### 10.3 Improve budget skip log message accuracy — cc:DONE

**Bug**: Log says "would exceed budget ($50.00 + $50.00 > $100)" — the comparison is against `effectiveBudget` ($98) but the log message shows `totalBudgetUsdc` ($100), which is misleading. Users see `$50 + $50 > $100` and think it's wrong math.

**Fix**: Log the actual effective budget being compared against, or remove the distinction since 10.1 eliminates the 2% margin.

**Files**: `src/orders/placer.ts`

## Phase 11: Deploy + ASK Order Fix (GitHub Issues #4, #5) `[bugfix:reproduce-first]`

> **Ref**: [GitHub Issue #4](https://github.com/sneg55/farmpoly/issues/4), [GitHub Issue #5](https://github.com/sneg55/farmpoly/issues/5)
> **Context**: Phases 9+10 fixes are committed but NOT deployed. Server is running pre-Phase 9 image.
> Issue #5 confirms: heartbeat self-recovered after ~9h, but ASK orders still fail with "not enough balance / allowance" — this is the ERC1155 approval issue from 9.1.

### 11.1 Fix GHCR auth + redeploy latest image — cc:TODO

**Problem**: `docker pull ghcr.io/sneg55/farmpoly:latest` fails with "denied" on Helsinki server. The PAT stored in `/root/.docker/config.json` may have expired.

**Fix**:
1. Generate a new GHCR PAT (or reuse existing) with `read:packages` scope
2. `docker login ghcr.io` on the server
3. Pull latest image and restart container
4. Verify new logs show Phase 10 code (heartbeat `""`, budget epsilon)

**Files**: Server-side only (SSH)

### 11.2 Run `polyfarm init --approve` to grant ERC1155 approvals — cc:TODO

**Problem**: Phase 9.1 added `checkConditionalTokenApproval` + `approveConditionalTokens` to the code, and `polyfarm init --approve` now calls them. But the on-chain `setApprovalForAll` transactions were never sent because the new code hasn't been deployed+run yet.

**Fix**:
1. After 11.1 deploys the new image, exec into the container
2. Run `polyfarm init --approve`
3. Verify 3 `setApprovalForAll` transactions are sent to ConditionalTokens contract for: CTF Exchange, NegRisk Exchange, NegRisk Adapter
4. Verify output shows "ConditionalTokens approved for all spenders"

**Files**: Server-side only (SSH + docker exec)

### 11.3 Restart daemon and verify BID+ASK both place — cc:TODO

**Problem**: After approvals are granted, restart the daemon and verify both BID and ASK orders succeed.

**Verification**:
1. Restart container with `polyfarm run --budget 100 --spread 5`
2. Check logs: both BID and ASK orders should appear (no "Skip ASK" or "Failed ASK")
3. Verify heartbeat shows `Heartbeat OK: {...}` on first attempt (not errors)
4. Confirm expected earnings doubled (~$10-12/day from both sides)

**Files**: Server-side only (SSH)

### 11.4 Close GitHub issues #4 and #5 with resolution notes — cc:TODO

**Fix**: After 11.3 is verified, close both issues with a comment summarizing the root causes and fixes.

**Files**: GitHub CLI

---

## Known Issues

| Issue | Status | Detail |
|-------|--------|--------|
| Polymarket geoblock (SG) | Resolved | Moved to Helsinki VPS |
| SQLite FK constraint | Fixed (7.1) | Markets upserted before order insert |
| Heartbeat SDK quirk | Fixed (8.1) | SDK returns `{ error }` instead of throwing |
| Min size constraints | Fixed (8.2) | `2 × max(bidCost, askCost)` formula |
| Balance/allowance | Fixed (8.3) | Stale order cleanup + 2% margin |
| ASK orders fail (ERC1155) | Fixed (9.1) | ERC1155 ConditionalToken approvals added |
| Heartbeat loop | Fixed (9.2) | Debug logging + null-only fallback after 3 chain failures |
| ASK blocked by budget | Fixed (10.1) | Replaced 2% margin with +$0.01 epsilon |
| Heartbeat null spam | Fixed (10.2) | Use "" not null; fallback escalates to real failures |

## Deployment

- **GitHub**: https://github.com/sneg55/farmpoly (private)
- **GHCR**: ghcr.io/sneg55/farmpoly:latest
- **Railway**: https://railway.com/project/b52d7201-7a76-4fd2-9955-b8137b9a2d16
- **CI**: GitHub Actions (test on PR, build+push on merge to main)
