# PolyFarm

Automated liquidity farming CLI for Polymarket. Earns rewards by placing two-sided maker orders (mint-and-quote) within each market's `rewardsMaxSpread`, protected by three layers: prevention (trend detection, stability filtering), detection (graduated danger zones), and recovery (inventory merge + hedge-on-fill with on-chain merge). Includes a token-gated web dashboard for remote monitoring.

## How It Works

1. **Discover** sponsored markets via Gamma API, ranked by profitability x stability score
2. **Filter** out volatile markets (24h price change, stability score, choppy trends)
3. **Mint** USDC into YES+NO token pairs via `splitPosition` for two-sided quoting
4. **Place** BID (USDC) + ASK (minted YES tokens) for 2x reward multiplier
5. **Monitor** prices via WebSocket with graduated response (yellow warning → red cancel)
6. **Hedge** fills: merge from inventory (pure spread profit) or buy opposite token → merge on-chain
7. **Rebalance** hourly to move capital into better-scoring markets
8. **Dashboard** token-gated web UI with P&L, inventory exposure, hedge history, and reward estimates

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
│  6. Mint tokens (split USDC → YES+NO)   │
│  7. Place two-sided orders (BID+ASK)    │
│  8. Start Fill Detector                  │
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

## Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- A Polygon wallet with USDC (MATIC for gas)

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

Browse all sponsored markets without needing a private key. Markets are sorted by **profitability score** (reward yield x stability x capital efficiency).

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
- **Yield%** - Daily yield percentage: `(reward/TVL) x 100`
- **Score** - Profitability score (yield x stability x capital efficiency)
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
```

| Flag | Default | Description |
|------|---------|-------------|
| `--budget <usdc>` | *required* | Total USDC budget to deploy |
| `--spread <cents>` | `2` | Distance from midpoint in cents (clamped to market's `rewardsMaxSpread`) |
| `--max-markets <n>` | `10` | Maximum number of markets to trade |
| `--no-mint` | off | Disable token minting (BID-only mode, no ASK orders) |
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
7. Mint tokens: `splitPosition(USDC)` → YES + NO token pairs
8. Place two-sided orders: BID (USDC) + ASK (minted YES tokens)
9. Log estimated reward scores per market (spread quality × two-sided bonus)
10. Start fill detector + hedge pipeline (inventory merge → hedge fallback)
11. Heartbeat every 5s (with corrected-ID recovery from server)
12. Rebalance periodically: merge old inventory → rediscover → redeploy

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

Opens a dark-themed web dashboard at `http://localhost:3737` with:
- **Session status** and order statistics with fill rate
- **Realized P&L** — sum of hedge profits/losses in cents
- **Inventory exposure** — USDC locked in minted token positions
- **Estimated daily rewards** — per-market reward score with two-sided multiplier
- **Live orders** table (auto-refreshes every 2s via SSE)
- **Position exposure** — inventory by market (minted, current balance, status)
- **Hedge history** — fill side, fill/hedge prices, merge amount, P&L, status
- **Markets** with spread quality score, competitor book share, two-sided indicator
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

Redeems all resolved conditional token positions back to USDC. Handles both standard CTF and NegRisk markets.

### `killall` - Cancel all open orders

```bash
pnpm dev killall
```

Cancels all open orders via the CLOB API without triggering a panic state.

## Docker

### Build

```bash
docker build -t polyfarm .
```

### Run

```bash
# Farming daemon
docker run -d \
  --name polyfarm \
  --restart on-failure:10 \
  -v ./data:/data \
  --env-file .env \
  polyfarm \
  run --budget 100 --spread 2 --max-markets 5 --placement-mode adaptive --hedge-fills

# Dashboard with remote access
docker run -d \
  --name polyfarm-dashboard \
  -p 3737:3737 \
  -v ./data:/data \
  --env-file .env \
  -e POLYFARM_DASHBOARD_TOKEN=your-secret-token \
  -e POLYFARM_DASHBOARD_HOST=0.0.0.0 \
  polyfarm \
  dashboard
```

## Development

### Run tests

```bash
pnpm test           # single run
pnpm test:watch     # watch mode
```

### Project structure

```
src/
  auth/           Credential derivation and USDC approval
  cli/            Commander.js CLI entry point and commands
  contracts/      On-chain contract addresses and ABIs (CTF, NegRisk, merge)
  dashboard/      HTTP server and HTML for the web dashboard
  db/             SQLite schema and database class (markets, orders, sessions, hedges, inventory)
  discovery/      Gamma API fetcher and reward market filter
  hedge/          Fill detection, hedge execution, and on-chain position merger
  intelligence/   Market stability scoring and trend detection
  orders/         Safe price calculator and order placement
  positions/      Token balance fetcher, position seller, splitter (mint), and redeemer
  safety/         WebSocket connection manager and graduated safety monitor
  utils/          Environment loader and config validation
tests/
  unit/           Unit tests (vitest)
```

### Key design decisions

- **ethers v5** (not v6) because `@polymarket/clob-client` depends on v5 internally
- **SQLite with WAL mode** for concurrent reads from the dashboard while the daemon writes
- **WebSocket-first**: Safety monitor starts before orders are placed, eliminating the vulnerable gap
- **Graduated response**: Yellow warning zone + red cancel zone instead of binary danger check
- **Mint-and-quote**: Split USDC → YES+NO tokens, sell YES as ASK, hold NO as inventory for 2x reward multiplier
- **Inventory merge**: BID fills merge with minted NO tokens for pure spread profit (no hedge buy needed)
- **Hedge-on-fill fallback**: FOK → FAK for hedge buy, then on-chain merge via `ConditionalTokens.mergePositions()`
- **Heartbeat recovery**: SDK returns corrected `heartbeat_id` in 400 error responses; we use it instead of resetting
- **Float-safe comparisons** with epsilon (`1e-10`) for danger zone boundary checks

## License

MIT
