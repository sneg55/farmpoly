# PolyFarm CLI — Plan

> **Stack**: Node 22, TypeScript, pnpm, better-sqlite3, Commander.js, ethers v5 (via SDK)
> **Testing**: TDD (vitest, 165 tests) | **Mode**: Solo | **Created**: 2026-02-23
> **Archive**: Phases 0-12 (all DONE) archived to `.claude/memory/archive/Plans-phases-0-12.md`

## Status: Production (Helsinki VPS)

Phases 0-14 complete. Two-sided liquidity (mint-and-quote) deployed.

---

## Phase 15: Enhanced Monitoring Dashboard + Remote Auth

### Context

The existing dashboard (`src/dashboard/`) is a basic read-only monitor showing session stats, live orders, markets, and recent activity. It uses raw Node.js HTTP server with SSE (2s refresh), bound to `127.0.0.1:3737`.

**What's missing for production monitoring:**
- No P&L tracking — can't see if the bot is profitable
- No reward estimation — can't see expected earnings
- No position/inventory exposure view
- No spread quality or competitor metrics
- Localhost-only — can't check from phone/laptop
- No auth on read endpoints — unsafe to expose publicly

### Feature Priority Matrix

| Priority | Feature |
|----------|---------|
| **Required** | Full auth (token-gated ALL endpoints for remote access) |
| **Required** | Real-time P&L (realized from hedges + unrealized inventory) |
| **Required** | Estimated daily reward earnings |
| **Required** | Position exposure by market (inventory view) |
| **Required** | Expose dashboard outside container (Docker + host binding) |
| **Recommended** | Spread quality score per market |
| **Recommended** | Competitor analysis (your share of book depth) |
| **Recommended** | Hedge history table |

### Tasks

- [x] 15.1 Full auth on all endpoints + cookie-based login page `[feature:security]`
- [x] 15.2 Enhance API payload (hedges, inventory, pnlSummary, rewardScores)
- [x] 15.3 P&L summary cards (realized, unrealized, est. daily rewards)
- [x] 15.4 Position exposure table (inventory by market)
- [x] 15.5 Hedge history table (fill → hedge → merge → P&L)
- [x] 15.6 Spread quality + competitor share columns in Markets table
- [x] 15.7 Docker exposure + env var config (host/port/token)
- [x] 15.8 Unit tests for auth, payload, P&L calculation

### 15.1 Full auth on all endpoints + cookie-based login page `[feature:security]`

Currently auth only protects `/api/panic`. For remote access, ALL endpoints must require auth.

**Files**: `src/dashboard/server.ts`, `src/dashboard/html.ts`, `src/cli/commands/dashboard.ts`

**Server changes** (`server.ts`):
- Move `isAuthorized()` check to top of request handler (before routing)
- Accept auth via `Authorization: Bearer <token>` header OR `polyfarm_token` cookie
- Add `POST /api/login` endpoint: validates token → sets `Set-Cookie: polyfarm_token=<token>; HttpOnly; SameSite=Strict; Path=/`
- Add `POST /api/logout` endpoint: clears cookie
- For unauthenticated `GET /`: serve login page instead of dashboard
- For unauthenticated API calls: return 401 JSON

**HTML changes** (`html.ts`):
- New `loginHtml()` function returning a standalone login page (same dark theme)
- Simple form: token input + submit button
- On submit: POST `/api/login`, on success reload page

**CLI changes** (`dashboard.ts`):
- Add `--auth-token <token>` option
- Fallback: `process.env.POLYFARM_DASHBOARD_TOKEN`
- Pass to `startDashboard({ authToken })`
- Warn if `--host 0.0.0.0` without `--auth-token`

### 15.2 Enhance API payload with P&L, hedges, inventory, reward scores

**File**: `src/dashboard/server.ts`

**Enhanced `freshPayload()` adds**:
```
hedges[]         – db.getRecentHedges(50)
inventory[]      – db.getSessionInventory(sessionId)
pnlSummary {
  realizedCents  – sum of hedges.pnl_cents where status=HEDGED
  totalHedged    – count of HEDGED
  totalFailed    – count of HEDGE_FAILED + MERGE_FAILED
  inventoryCount – number of markets with inventory
  inventoryUsdc  – sum of inventory current_balance
}
rewardScores[] {
  conditionId, question,
  rewardRate, spreadQuality,
  isTwoSided, estimatedDaily,
  bookShare
}
```

Compute P&L summary and reward scores server-side. All from DB reads (prepared stmts, sub-ms).

### 15.3 P&L summary cards

**File**: `src/dashboard/html.ts`

Add 3 new metric cards after existing 6:
- **Realized P&L**: Sum of hedge P&L → `$X.XX` with green/red color
- **Inventory Exposure**: USDC locked in minted tokens → `$X.XX`
- **Est. Daily Rewards**: Sum across active markets → `$X.XX/day`

### 15.4 Position exposure table

**File**: `src/dashboard/html.ts`

New section "Position Exposure" below Live Orders:
- Columns: Market, Side (YES/NO), Minted, Current, Status
- Color: green = hedgeable, yellow = directional, dim = consumed

### 15.5 Hedge history table

**File**: `src/dashboard/html.ts`

New section "Hedge History":
- Columns: Time, Fill Side, Fill Price, Hedge Price, Merge Amt, P&L, Status
- Color: green = HEDGED+profit, red = failed, dim = skipped

### 15.6 Spread quality + competitor share

**Files**: `src/dashboard/server.ts`, `src/dashboard/html.ts`

**Spread quality** (new column in Markets table):
- `quality = 1 - (effectiveSpread / maxSpread)^2`
- Visual: percentage with bar

**Competitor share** (new column in Markets table):
- `share = totalOrderSize / marketTVL × 100`
- Shows `X.X%` — higher = more rewards but more fill risk

Computed server-side by joining live orders with markets in `freshPayload()`.

### 15.7 Docker exposure + env var config

**Files**: `Dockerfile`, `src/cli/commands/dashboard.ts`

**Dockerfile**: Add `EXPOSE 3737`

**CLI env fallbacks**:
- `POLYFARM_DASHBOARD_HOST` → `--host` (default: 127.0.0.1)
- `POLYFARM_DASHBOARD_PORT` → `--port` (default: 3737)
- `POLYFARM_DASHBOARD_TOKEN` → `--auth-token`

**Docker usage**:
```bash
docker run -p 3737:3737 \
  -e POLYFARM_DASHBOARD_TOKEN=mysecrettoken \
  -e POLYFARM_DASHBOARD_HOST=0.0.0.0 \
  polyfarm dashboard
```

### 15.8 Unit tests

**File**: `tests/unit/dashboard.test.ts`

New test cases:
- Auth: 401 on GET `/` without token when configured
- Auth: 401 on GET `/api/status` without token
- Auth: 200 with valid Bearer header
- Auth: 200 with valid cookie
- Auth: POST `/api/login` returns cookie on valid token
- Auth: POST `/api/login` returns 401 on invalid token
- Payload: `/api/status` includes `hedges`, `inventory`, `pnlSummary`, `rewardScores`
- P&L: `pnlSummary.realizedCents` sums hedge P&L correctly with test data
- Reward scores: calculated from markets + live orders

### Files Changed

| File | Change |
|------|--------|
| `src/dashboard/server.ts` | Full auth middleware, login/logout, enhanced payload |
| `src/dashboard/html.ts` | Login page, P&L cards, exposure table, hedge table, quality columns |
| `src/cli/commands/dashboard.ts` | `--auth-token`, env var fallbacks, security warning |
| `Dockerfile` | `EXPOSE 3737` |
| `tests/unit/dashboard.test.ts` | Auth + payload + P&L tests |

### Verification

1. `npx tsc --noEmit` + `npx vitest run` — clean compile, all tests pass
2. Local: `POLYFARM_DASHBOARD_TOKEN=test123 polyfarm dashboard --host 0.0.0.0` → login page → full dashboard
3. Docker: `docker run -p 3737:3737 -e POLYFARM_DASHBOARD_TOKEN=secret polyfarm dashboard` → remote access with auth

---

## Deployment

- **GitHub**: https://github.com/sneg55/farmpoly (private)
- **GHCR**: ghcr.io/sneg55/farmpoly:latest
- **CI**: GitHub Actions (test on PR, build+push on merge to main)
