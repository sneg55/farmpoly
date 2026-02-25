# PolyFarm CLI — Plan

> **Stack**: Node 22, TypeScript, pnpm, better-sqlite3, Commander.js, ethers v5 (via SDK)
> **Testing**: TDD (vitest, 157 tests) | **Mode**: Solo | **Created**: 2026-02-23
> **Archive**: Phases 0-12 (all DONE) archived to `.claude/memory/archive/Plans-phases-0-12.md`

## Status: Production (Helsinki VPS)

MVP complete + 12 phases of bug fixes and features shipped.
Currently fixing crash-loop on empty market discovery (Phase 13).

---

## Phase 13: Fix Crash-Loop — No Markets Affordable `[bugfix:reproduce-first]` — DONE

> **Problem**: Bot crash-loops when no markets pass filtering. Process exits with code 0 → Docker `--restart unless-stopped` restarts it → same result → infinite loop. Observed with `--budget 100 --spread 3`.

### Root Cause

Two bugs combine: (1) `run.ts` does `return` on empty discovery → exit code 0 → Docker restarts instantly. (2) Filters too aggressive — `--max-volatility 5c` + `stabilityScore < 0.2` + `--min-daily-yield 0.5` filter out ALL markets in thin conditions.

### Fix: Don't exit — wait and retry.

- [x] 13.1 Discovery retry loop with exponential backoff (60s → 16min cap)
- [x] 13.2 Mutable filter relaxation after 6 failures (volatility +2c cap 15, yield -0.1% floor 0)
- [x] 13.3 `--exit-on-empty` flag for backward compat
- [x] 13.4 Filter funnel diagnostic logging (FilterStats at each stage)
- [x] 13.5 Docker restart policy `on-failure:10` (was `unless-stopped`)
- [x] 13.6 Regression tests (22 tests in `discovery-retry.test.ts`)

**Files changed**: `src/discovery/rewards.ts`, `src/cli/commands/run.ts`, `src/cli/commands/discover.ts`, `.github/workflows/docker.yml`, `README.md`, `tests/unit/discovery-retry.test.ts`

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
| Crash-loop on empty discovery | Fixed (13) | Retry loop + filter relaxation + `on-failure:10` |

## Deployment

- **GitHub**: https://github.com/sneg55/farmpoly (private)
- **GHCR**: ghcr.io/sneg55/farmpoly:latest
- **Railway**: https://railway.com/project/b52d7201-7a76-4fd2-9955-b8137b9a2d16
- **CI**: GitHub Actions (test on PR, build+push on merge to main)
