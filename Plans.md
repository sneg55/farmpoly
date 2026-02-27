# PolyFarm CLI — Plan

> **Stack**: Node 22, TypeScript, pnpm, better-sqlite3, Commander.js, ethers v5 (via SDK)
> **Testing**: TDD (vitest, 165 tests) | **Mode**: Solo | **Created**: 2026-02-23
> **Archive**: Phases 0-12 → `.claude/memory/archive/Plans-phases-0-12.md` | Phase 15 → `.claude/memory/archive/Plans-phase-15.md`

## Status: Production (Helsinki VPS)

Phases 0-14 complete. Two-sided liquidity (mint-and-quote) deployed.

---

## Phase 16: Unwind Accumulated Positions + Prevent Future Accumulation

### Context

Portfolio screenshot shows $566.68 in accumulated positions across 11 entries. Three categories:
- **Resolved markets** ($290): Meteora No @$1, Another company No @$1, ZachXBT Yes @$1
- **Paired positions** (~$27 mergeable): US strikes Iran has both YES+NO for same markets
- **One-sided directional** (~$250): Talarico (partial pair), Elon Musk Yes, Lagarde Yes

### Root Causes

1. **ASK fills return "HEDGED" without merging** — `executor.ts:122-142` holds NO tokens, relying on a future BID fill that may never come. Capital locked indefinitely.
2. **No periodic inventory sweep** — Merges only happen on BID fill, rebalance, or graceful shutdown. Docker `--restart on-failure` sends SIGKILL (not SIGTERM), skipping shutdown merge.
3. **Resolved markets never auto-redeemed** — Tokens at $1.00 sit in wallet earning nothing.
4. **`mergeInventory()` is session-scoped** — Only merges current session's inventory. Positions orphaned by restarts are invisible.

### Priority Matrix

| Priority | Task | Impact | Effort |
|----------|------|--------|--------|
| **Required** | 16.1 Redeem resolved markets (ops) | $290 recovery | CLI command |
| **Required** | 16.2 Merge/sell remaining positions (ops) | ~$130 recovery | CLI commands |
| **Required** | 16.3 Periodic inventory sweep | Prevents accumulation | Medium |
| **Required** | 16.4 Session-agnostic shutdown merge | Catches orphaned positions | Small |
| **Recommended** | 16.5 ASK fill NO-token timeout + sell | Reduces capital lockup | Medium |
| **Recommended** | 16.6 Auto-redeem resolved markets | Frees dead capital | Small |
| **Optional** | 16.7 Dashboard stale inventory warning | Better visibility | Small |

### Tasks

- [x] 16.1 Redeem resolved markets `[ops]`
  - Ran on VPS: all previously resolved markets already redeemed. 2 remaining markets unresolved.

- [x] 16.2 Merge/sell remaining one-sided positions `[ops]`
  - Stopped bot gracefully (triggered shutdown merge), ran killall — 0 tokens remaining.
  - Previous positions (Meteora, ZachXBT, etc.) already cleaned up.

- [x] 16.3 Add periodic inventory sweep to run loop `[feature:tdd]`
  **File**: `src/cli/commands/run.ts`
  - New interval every 10 min: `INVENTORY_SWEEP_INTERVAL_MS = 10 * 60 * 1000`
  - Uses `discoverHeldTokens()` for session-agnostic on-chain scanning
  - Merges paired YES+NO, auto-redeems resolved, sells stale NO tokens
  - Logs recovered USDC, clears interval on shutdown

- [x] 16.4 Make shutdown merge session-agnostic `[bugfix:reproduce-first]`
  **File**: `src/cli/commands/run.ts`
  - Replaced `mergeInventory()` with `performInventorySweep()` in shutdown + rebalance
  - Scans ALL on-chain balances, not just current session's DB inventory
  - Ensures crash-orphaned positions from any session get merged

- [x] 16.5 Add NO-token timeout: sell unsold NO after ASK fill `[feature:tdd]`
  **File**: `src/cli/commands/run.ts`
  - On ASK fill with no merge: records timestamp in `noTokenTimestamps` map
  - On BID fill with merge: clears timestamp
  - In inventory sweep: sells NO tokens held >15 min via FAK market order

- [x] 16.6 Auto-redeem resolved markets during sweep `[feature:tdd]`
  **File**: `src/positions/auto-redeemer.ts` (new), called from sweep
  - During periodic sweep, attempts `redeemPosition()` on all held tokens
  - Uses existing `estimateGas` preflight to skip unresolved markets
  - Logs: "Auto-redeemed $X.XX from [market]"

- [x] 16.7 Dashboard stale inventory warning `[optional]`
  **Files**: `src/dashboard/html.ts`, `src/dashboard/server.ts`
  - New "Stale Positions" section (hidden when empty)
  - Columns: Market, Side, Balance, Est. Value, Suggested Action (merge/sell)
  - Server computes stale = inventory not in currently quoted markets

### Files Changed

| File | Change |
|------|--------|
| `src/cli/commands/run.ts` | Periodic sweep interval, session-agnostic shutdown merge |
| `src/hedge/executor.ts` | NO-token timeout tracking |
| `src/positions/auto-redeemer.ts` | New: auto-redeem during sweep |
| `tests/unit/sweep.test.ts` | New: tests for inventory sweep + auto-redeem |

### Verification

1. `npx tsc --noEmit` + `npx vitest run` — clean compile, all tests pass
2. Deploy, verify sweep logs show merge/redeem activity every 10 min
3. After 1 hour: check portfolio — no accumulated stale positions

---

## Deployment

- **GitHub**: https://github.com/sneg55/farmpoly (private)
- **GHCR**: ghcr.io/sneg55/farmpoly:latest
- **CI**: GitHub Actions (test on PR, build+push on merge to main)
