# PolyFarm

Automated liquidity farming CLI for Polymarket. Earns rewards by placing two-sided maker orders (mint-and-quote) within each market's `rewardsMaxSpread`, protected by three layers: prevention (trend detection, stability filtering), detection (graduated danger zones), and recovery (inventory merge + hedge-on-fill with on-chain merge). Includes a token-gated web dashboard for remote monitoring.

## How It Works

1. **Discover** sponsored markets via Gamma API, ranked by profitability × stability score
2. **Filter** out volatile markets (24h price change, stability score, choppy trends)
3. **Allocate** capital across markets weighted by profitability score (yield × capital efficiency × TVL stability)
4. **Place BIDs first** (all USDC visible to CLOB for balance checks), then ASKs with conditional minting
5. **Mint** USDC into YES+NO token pairs via `splitPosition` — capped at `--mint-budget-pct` of total budget
6. **Monitor** prices via WebSocket with graduated response (yellow warning → red cancel)
7. **Hedge** fills: merge from inventory (pure spread profit) or buy opposite token → merge on-chain
8. **Rebalance** hourly to move capital into better-scoring markets
9. **Dashboard** token-gated web UI with P&L, inventory exposure, hedge history, and reward estimates

## Architecture

```
┌─────────────────────────────────────────┐
│              STARTUP SEQUENCE            │
│                                          │
│  1. Auth + cleanup stale orders          │
│  2. Start WebSocket + Safety Monitor     │
│  3. Warm up (collect midpoint data)      │
│  4. Discover + stability filter          │
│  5. Trend detection per market           │
│  6. Two-pass order placement:            │
│     Pass 1 → all BIDs (USDC on-chain)   │
│     Pass 2 → ASKs + conditional mint     │
│  7. Start Fill Detector                  │
└──────────┬──────────────────────────────┘
           │
  ┌────────┼────────────┐
  ▼        ▼            ▼
┌────────┐┌──────────┐┌──────────────┐
│ SAFETY ││  FILL    ││ HEARTBEAT +  │
│ MONITOR││ DETECTOR ││ REBALANCE    │
│        ││          ││              │
│ WS book││ Poll     ││ 5s heartbeat │
│ events ││ trades   ││ 60m rebalance│
│ → warn ││ every 5s ││              │
│ → cancel│ → hedge  ││              │
└────────┘└──────────┘└──────────────┘
```

### Order Placement: Two-Pass Architecture

The bot uses a hybrid CLOB-first approach to avoid draining on-chain USDC before the CLOB server validates BID order balances:

```
Pass 1: Market A BID → Market B BID   (all USDC visible to CLOB)
Pass 2: Market A ASK (mint if needed) → Market B ASK (mint if needed)
         ↑ minting only for deficit, capped at --mint-budget-pct
```

Three guards protect each mint operation:
1. **Total budget** — `committedUsdc + askCost ≤ effectiveBudget`
2. **Mint cap** — `mintedUsdc + splitUsdc ≤ budget × mintBudgetPercent / 100`
3. **On-chain USDC** — `localMintableUsdc ≥ splitUsdc` (actual wallet balance)

### Hedging Flow

```
Fill Detected (maker trade matched)
  │
  ├─ Inventory available? ──YES──→ Merge YES+NO → USDC (pure spread profit)
  │
  └─ NO ──→ Market buy opposite token (FOK → FAK fallback)
            → Wait 2s for on-chain settlement
            → Merge min(YES, NO) via ConditionalTokens
            → P&L = (1.00 - fillPrice - hedgePrice) × 100 cents
```

### Safety Monitoring

The WebSocket-first safety monitor starts **before** any orders are placed, eliminating the vulnerable gap:

- **Yellow zone** (`--danger-zone` cents): Warning emitted, order flagged
- **Red zone** (half of danger zone): Immediate cancel, counterpart also cancelled
- **Float-safe** comparisons with epsilon (`1e-10`) for boundary checks
- Midpoints collected during `--warmup-seconds` before placement

## Module Reference

### Discovery & Intelligence

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `src/discovery/gamma.ts` | Paginated market data from Gamma API | `fetchGammaMarkets()`, `GammaMarket` |
| `src/discovery/rewards.ts` | Filter, rank, allocate capital | `filterRewardMarkets()`, `allocateCapitalSmart()`, `shouldRebalance()` |
| `src/intelligence/trend.ts` | Trend direction from 1h/24h changes | `detectTrend()` → UP/DOWN/SIDEWAYS/CHOPPY, `allowedSides()` |
| `src/intelligence/stability.ts` | Stability scoring (0-1) | `calculateStabilityScore()`, `isTooVolatile()` |

**Trend Detection Logic:**
- **UP**: |1h| > 3c AND same direction as 24h → ASK only (without mint) or two-sided (with mint)
- **DOWN**: Same thresholds, negative → BID only (without mint) or two-sided (with mint)
- **CHOPPY**: |1h| > 2c but OPPOSITE direction to 24h → skip entirely
- **SIDEWAYS**: Calm/ambiguous → two-sided

**Profitability Score**: `dailyYield × capitalEfficiency × tvlStabilityFactor`
- Daily yield = `(rewardRate / TVL) × 100`
- Stability penalties: 24h change (40%), 1h change (30%), volume (20%), spread (10%)

### Order Management

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `src/orders/calculator.ts` | Price computation, budget splitting | `calculateSafePrices()`, `sharesToBuy()`, `allocateBudget()`, `isInDangerZone()` |
| `src/orders/placer.ts` | Two-pass order placement + minting | `placeOrdersForMarkets()`, `MintOptions`, `PlacedOrder` |
| `src/orders/lifecycle.ts` | Cancel, panic, graceful shutdown | `cancelAllOrders()`, `panicCancelAll()`, `gracefulShutdown()` |

**Safe Prices**: BID = `floor(midpoint - spread, tickSize)`, ASK = `ceil(midpoint + spread, tickSize)`, clamped to [0.10, 0.90]. Spread clamped to market's `rewardsMaxSpread`.

### Position Management

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `src/positions/splitter.ts` | Mint YES+NO from USDC | `splitPosition()` → txHash |
| `src/positions/merger.ts` | Merge YES+NO back to USDC | `mergePositions()` → txHash |
| `src/positions/fetcher.ts` | On-chain balances (ERC1155 batch) | `getTokenBalances()`, `discoverPositions()` |
| `src/positions/auto-redeemer.ts` | Redeem resolved markets | `autoRedeemResolved()` |
| `src/positions/seller.ts` | Sell positions via CLOB | Market/limit sell of held tokens |

Both `splitPosition` and `mergePositions` handle standard CTF and NegRisk markets (different contract paths). Gas overrides use 35 gwei tip for Polygon compatibility.

### Hedging

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `src/hedge/detector.ts` | Poll CLOB trades every 5s | `FillDetector` (EventEmitter), emits `"fill"` events |
| `src/hedge/executor.ts` | Execute hedge + on-chain merge | `executeHedge()` → `HedgeResult` with P&L |

**Inventory merge path** (BID fills): If minted NO tokens available in inventory, merge directly — pure spread profit with zero hedge cost. Falls back to market buy if no inventory.

### Safety & Monitoring

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `src/safety/websocket.ts` | Persistent WebSocket to CLOB feed | `WsConnectionManager` (EventEmitter), emits `"book"` events |
| `src/safety/monitor.ts` | Real-time order danger detection | `SafetyMonitor`, emits `"warning"`, `"danger"`, `"cancelled"` |

### Authentication & Approvals

| Module | Purpose | Key Exports |
|--------|---------|-------------|
| `src/auth/credentials.ts` | Derive/cache CLOB API keys | `deriveOrLoadCreds()` → `AuthContext` |
| `src/auth/approval.ts` | USDC + ERC1155 approvals | `checkApproval()`, `approveUSDC()`, `approveConditionalTokens()` |

Credentials are derived via L1 signature and cached in SQLite. On subsequent runs, cached creds are validated with `getApiKeys()` before reuse.

### Database

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `markets` | Discovered markets | condition_id (PK), question, token_ids, midpoint, tvl, reward_rate |
| `orders` | All placed orders | order_id (PK), condition_id, side, price, size, status (LIVE/CANCELLED/FILLED/EXPIRED) |
| `sessions` | Bot execution sessions | id (PK), budget_usdc, spread_cents, status (RUNNING/STOPPED/PANIC) |
| `hedges` | Hedge execution records | trade_id (UNIQUE), fill_side, fill_price, hedge_price, merge_amount, pnl_cents, status |
| `inventory` | Minted token balances | session_id + condition_id + side (UNIQUE), minted_amount, current_balance |
| `config` | Cached API credentials | key (PK), value |

SQLite with WAL mode enables concurrent reads from the dashboard while the daemon writes.

### Dashboard

| Module | Purpose |
|--------|---------|
| `src/dashboard/server.ts` | Native HTTP server with auth, SSE, panic endpoint |
| `src/dashboard/html.ts` | Terminal-aesthetic UI (JetBrains Mono, mint-green accent) |

**Endpoints**: `GET /` (HTML), `GET /api/status` (JSON), `POST /api/panic`, `GET /api/events` (SSE), `POST /api/login`, `POST /api/logout`

**Payload** (`freshPayload`): session, liveOrders, markets, recentOrders, hedges, inventory, pnlSummary, rewardScores, stalePositions.

## Prerequisites

- Node.js 22+
- pnpm 10+ (`corepack enable && corepack prepare pnpm@10.28.2 --activate`)
- A Polygon wallet with USDC (POL/MATIC for gas)

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and add your Polygon private key:

```
POLYGON_PRIVATE_KEY=your_64_char_hex_key_without_0x_prefix
```

Optional settings (defaults are fine for most users):

```
POLYGON_RPC_URL=https://polygon-rpc.com
CLOB_API_URL=https://clob.polymarket.com
GAMMA_API_URL=https://gamma-api.polymarket.com
POLYMARKET_DATA_API_URL=https://data-api.polymarket.com
POLYFARM_DB_PATH=polyfarm.db
```

### 3. Initialize credentials

```bash
pnpm dev init --approve
```

This will:
- Validate your private key
- Derive L2 API credentials via the Polymarket CLOB SDK
- Check and approve USDC spending on both CTF and NegRisk exchanges

## Commands

All commands are run via `pnpm dev <command>` (or `npx tsx src/cli/index.ts <command>`).

### `discover` - Find reward markets

Browse all sponsored markets without needing a private key. Markets are sorted by **profitability score** (reward yield × stability × capital efficiency).

```bash
pnpm dev discover --min-tvl 5000
pnpm dev discover --min-daily-yield 1 --simulate-budget 100
```

| Flag | Default | Description |
|------|---------|-------------|
| `--min-tvl <amount>` | `10000` | Minimum TVL in USD |
| `--limit <n>` | `20` | Max markets to display in terminal |
| `--min-daily-yield <percent>` | `0` | Minimum daily yield % to include |
| `--sort-by-rate` | off | Sort by reward rate instead of profitability score |
| `--simulate-budget <usdc>` | - | Simulate capital allocation with this budget |

**Output columns:**
- **Yield%** - Daily yield percentage: `(reward/TVL) × 100`
- **Score** - Profitability score (yield × stability × capital efficiency)
- **Stability** - Market stability score (0-1, penalizes volatility/volume/spread)
- **MinCap** - Minimum capital required to meet `minSize` requirements

### `run` - Start the farming daemon

```bash
# Recommended production config (two-sided, 2c spread for 10x reward boost)
pnpm dev run --budget 100 --spread 2 --max-markets 5 --placement-mode adaptive --hedge-fills

# Minimal
pnpm dev run --budget 50 --spread 2

# BID-only mode (no token minting)
pnpm dev run --budget 50 --spread 3 --no-mint

# Conservative minting (25% of budget)
pnpm dev run --budget 200 --spread 2 --mint-budget-pct 25
```

| Flag | Default | Description |
|------|---------|-------------|
| `--budget <usdc>` | *required* | Total USDC budget to deploy |
| `--spread <cents>` | `2` | Distance from midpoint in cents (clamped to market's `rewardsMaxSpread`) |
| `--max-markets <n>` | `10` | Maximum number of markets to trade |
| `--no-mint` | off | Disable token minting (BID-only mode, no ASK orders) |
| `--mint-budget-pct <percent>` | `50` | Max % of total budget that may be spent on minting (0-100) |
| `--danger-zone <cents>` | `3` | Graduated danger zone: yellow warning at N cents, red cancel at N/2 cents |
| `--max-volatility <cents>` | `5` | Skip markets with >N cents 24h price change |
| `--placement-mode <mode>` | `adaptive` | `adaptive` (trend-based), `bid-only`, `ask-only`, or `both` |
| `--hedge-fills` / `--no-hedge-fills` | enabled | Auto-hedge fills (buy opposite token + on-chain merge) |
| `--max-hedge-cost <cents>` | `5` | Max extra cents above complement price for hedge buy |
| `--warmup-seconds <s>` | `5` | Collect WebSocket midpoint data before placing orders |
| `--rebalance-interval <min>` | `60` | Check for better markets every N minutes (0 to disable) |
| `--min-daily-yield <percent>` | `0` | Minimum daily yield % to consider |
| `--min-rebalance-improvement <percent>` | `20` | Minimum profitability gain to trigger rebalance |
| `--no-smart-allocation` | off | Use equal allocation instead of profitability-weighted |
| `--exit-on-empty` | off | Exit if no markets found (default: retry with backoff) |

#### Protection Layers

**Prevention:**
- `--spread` is clamped to each market's `rewardsMaxSpread` (typically 3.5c) to ensure reward qualification
- `--placement-mode adaptive` detects trends and places one-sided orders (UP → ASK only, DOWN → BID only, CHOPPY → skip)
- `--max-volatility` filters out markets with excessive 24h price changes
- Markets with stability score < 0.2 are automatically excluded
- WebSocket safety monitor starts BEFORE orders are placed (`--warmup-seconds`)

**Detection:**
- `--danger-zone 3` creates two zones: yellow (3c, warning emitted) and red (1.5c, immediate cancel)
- Counterpart orders are cancelled when a fill is detected (prevents double exposure)

**Recovery (inventory merge + hedge-on-fill):**
- Fill detector polls trades every 5s and matches against live orders
- **Inventory merge path** (BID fills): merge filled YES with minted NO tokens → pure spread profit, no hedge buy needed
- **Hedge fallback**: buy opposite token (FOK then FAK) at complement price + max hedge cost
- On-chain merge: `ConditionalTokens.mergePositions()` converts YES+NO back to ~$1.00 USDC
- Shutdown/rebalance: automatically merges remaining inventory to recover USDC

#### Daemon Flow

1. Authenticate and derive API keys
2. Start WebSocket + Safety Monitor (before any orders)
3. Warm up: collect midpoint data for `--warmup-seconds`
4. Discover markets, filter by stability and volatility
5. Detect trend per market (UP/DOWN/SIDEWAYS/CHOPPY)
6. Smart allocation: deploy more capital to higher-scoring markets
7. Two-pass order placement:
   - Pass 1: all BIDs (USDC stays on-chain, visible to CLOB for balance checks)
   - Pass 2: ASKs with conditional minting (capped at `--mint-budget-pct`)
8. Log estimated reward scores per market (spread quality × two-sided bonus)
9. Start fill detector + hedge pipeline (inventory merge → hedge fallback)
10. Heartbeat every 5s (with corrected-ID recovery from server)
11. Rebalance periodically: merge old inventory → rediscover → redeploy

Press `Ctrl+C` for graceful shutdown (cancels orders, merges inventory, recovers USDC, closes DB).

### `status` - Check current session

```bash
pnpm dev status
```

Shows session info, order stats, fill rate, and all live orders.

### `dashboard` - Web UI

```bash
# Local (no auth needed)
pnpm dev dashboard

# Remote access with auth
pnpm dev dashboard --host 0.0.0.0 --auth-token mysecrettoken

# Via environment variables
POLYFARM_DASHBOARD_TOKEN=mysecrettoken POLYFARM_DASHBOARD_HOST=0.0.0.0 pnpm dev dashboard
```

Opens a terminal-aesthetic web dashboard at `http://localhost:3737` with:
- **Session status** — running/stopped/panic badge with live indicator
- **Stat cards** — budget, orders placed, fill rate, cancelled, markets count
- **Realized P&L** — sum of hedge profits/losses in cents
- **Inventory exposure** — USDC locked in minted token positions
- **Estimated daily rewards** — per-market reward score with two-sided multiplier
- **Live orders** table (auto-refreshes every 2s)
- **Position exposure** — inventory by market (minted, current balance, status)
- **Stale positions** — orphaned inventory not in active markets, with merge/sell suggestions
- **Hedge history** — fill side, fill/hedge prices, merge amount, P&L, status
- **Markets** with spread quality score, competitor book share, two-sided indicator, clickable Polymarket links
- **Recent activity** log (cancelled/filled orders)
- **Panic button** to cancel all orders
- **Token-gated auth** — cookie-based login page for remote access

| Flag | Default | Description |
|------|---------|-------------|
| `--port <number>` | `3737` | HTTP port |
| `--host <addr>` | `127.0.0.1` | Bind address (`0.0.0.0` for remote access) |
| `--auth-token <token>` | - | Bearer token required for all endpoints |

Environment variable fallbacks: `POLYFARM_DASHBOARD_PORT`, `POLYFARM_DASHBOARD_HOST`, `POLYFARM_DASHBOARD_TOKEN`.

### `panic` - Emergency kill switch

```bash
pnpm dev panic
```

Immediately cancels all orders via the CLOB API and marks the session as PANIC.

| Flag | Description |
|------|-------------|
| `--skip-db` | Bypass SQLite, cancel via API only |

### `redeem` - Redeem resolved positions

```bash
pnpm dev redeem
```

Redeems all resolved conditional token positions back to USDC. Handles both standard CTF and NegRisk markets. Uses `estimateGas` preflight to skip unresolved positions.

### `killall` - Cancel all open orders

```bash
pnpm dev killall
```

Cancels all open orders via the CLOB API without triggering a panic state. Also sells any held token positions.

## Docker

### Build

```bash
docker build -t polyfarm .
```

The default CMD is `run --budget 30 --spread 3 --max-markets 3 --hedge-fills --placement-mode adaptive`.

### Run

```bash
# Farming daemon (production)
docker run -d \
  --name polyfarm \
  --restart on-failure:10 \
  -v ./data:/data \
  --env-file .env \
  polyfarm \
  run --budget 500 --spread 2 --max-markets 5 --placement-mode adaptive --hedge-fills

# Dashboard with remote access (shares the same DB volume)
docker run -d \
  --name polyfarm-dashboard \
  --restart on-failure:10 \
  -p 3737:3737 \
  -v ./data:/data \
  --env-file .env \
  -e POLYFARM_DASHBOARD_TOKEN=your-secret-token \
  -e POLYFARM_DASHBOARD_HOST=0.0.0.0 \
  polyfarm \
  dashboard
```

**Graceful shutdown tip:** Use `docker stop -t 120 polyfarm` to give the bot enough time to merge all positions back to USDC. The default 10s timeout may not be enough for multiple on-chain transactions.

### CI/CD

The GitHub Actions workflow (`.github/workflows/docker.yml`) handles the full pipeline:

1. **Test** — runs `vitest` on every push/PR
2. **Build** — multi-platform Docker image (`linux/amd64` + `linux/arm64`), pushed to GHCR
3. **Deploy** — SSH to production server, graceful stop (30s timeout), restart both bot + dashboard containers

Both containers share a `/data` volume for the SQLite database. The dashboard reads from the same DB the bot writes to (WAL mode enables concurrent access).

## Development

### Run tests

```bash
pnpm test           # single run
pnpm test:watch     # watch mode
```

### Project structure

```
src/
  api/            Data API client for position discovery
  auth/           Credential derivation and USDC approval
  cli/            Commander.js CLI entry point and commands
  contracts/      On-chain contract addresses and ABIs (CTF, NegRisk, merge)
  dashboard/      HTTP server and HTML for the web dashboard
  db/             SQLite schema and database class (markets, orders, sessions, hedges, inventory)
  discovery/      Gamma API fetcher and reward market filter
  hedge/          Fill detection, hedge execution, and on-chain position merger
  intelligence/   Market stability scoring and trend detection
  orders/         Safe price calculator, two-pass order placement, lifecycle management
  positions/      Token balance fetcher, position seller, splitter (mint), merger, redeemer
  safety/         WebSocket connection manager and graduated safety monitor
  utils/          Environment loader and config validation
tests/
  unit/           Unit tests (vitest, 192 tests across 18 files)
```

### Key design decisions

- **ethers v5** (not v6) because `@polymarket/clob-client` depends on v5 internally
- **SQLite with WAL mode** for concurrent reads from the dashboard while the daemon writes
- **WebSocket-first**: Safety monitor starts before orders are placed, eliminating the vulnerable gap
- **Two-pass order placement**: All BIDs placed first (USDC visible to CLOB), then ASKs with conditional minting — prevents CLOB balance validation failures
- **Mint budget cap**: Configurable % of total budget allocated to minting, with three guards (total budget, mint cap, on-chain USDC balance)
- **Graduated response**: Yellow warning zone + red cancel zone instead of binary danger check
- **Mint-and-quote**: Split USDC → YES+NO tokens, sell YES as ASK, hold NO as inventory for 2x reward multiplier
- **Inventory merge**: BID fills merge with minted NO tokens for pure spread profit (no hedge buy needed)
- **Hedge-on-fill fallback**: FOK → FAK for hedge buy, then on-chain merge via `ConditionalTokens.mergePositions()`
- **Heartbeat recovery**: SDK returns corrected `heartbeat_id` in 400 error responses; we use it instead of resetting
- **WebSocket resilience**: DNS failures (`EAI_AGAIN`) emit `ws_error` (not `error`) to avoid Node.js uncaught exception crash; reconnect handles recovery
- **Discovery retry**: If no markets found on startup, retries with exponential backoff instead of exiting
- **Float-safe comparisons** with epsilon (`1e-10`) for danger zone boundary checks
- **Position discovery via Data API**: Single HTTP call (`discoverHeldTokensViaApi`) with RPC fallback for token discovery

## License

MIT
