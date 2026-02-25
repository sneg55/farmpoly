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

## Known Issues

| Issue | Status | Detail |
|-------|--------|--------|
| Polymarket geoblock (SG) | Resolved | Moved to Helsinki VPS |
| SQLite FK constraint | Fixed (7.1) | Markets upserted before order insert |
| Heartbeat SDK quirk | Fixed (8.1) | SDK returns `{ error }` instead of throwing |
| Min size constraints | Fixed (8.2) | `2 × max(bidCost, askCost)` formula |
| Balance/allowance | Fixed (8.3) | Stale order cleanup + 2% margin |

## Deployment

- **GitHub**: https://github.com/sneg55/farmpoly (private)
- **GHCR**: ghcr.io/sneg55/farmpoly:latest
- **Railway**: https://railway.com/project/b52d7201-7a76-4fd2-9955-b8137b9a2d16
- **CI**: GitHub Actions (test on PR, build+push on merge to main)
