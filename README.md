# PolyFarm

Automated liquidity provision CLI for Polymarket. Earns rewards by placing maker orders at safe distances from midpoints, with a WebSocket safety loop that cancels orders before they fill.

## How It Works

1. **Discover** sponsored markets with active liquidity rewards via the Gamma API
2. **Place** BID and ASK orders at a configurable spread from the midpoint
3. **Monitor** price changes in real-time via WebSocket
4. **Cancel** orders defensively when prices drift into a danger zone (<200ms target)
5. **Earn** 10-40% APY from Polymarket's Liquidity Rewards Program with near-zero fill rate

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

Browse all sponsored markets without needing a private key. Markets are sorted by **profitability score** by default, which accounts for reward/TVL ratio, capital efficiency, and TVL stability.

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
- **Score** - Profitability score accounting for capital requirements and TVL stability
- **MinCap** - Minimum capital required to meet `minSize` requirements

All discovered reward markets are saved to the local SQLite database regardless of `--limit`.

### `run` - Start the farming daemon

```bash
pnpm dev run --budget 50 --spread 5
pnpm dev run --budget 100 --rebalance-interval 30 --min-daily-yield 0.5
```

| Flag | Default | Description |
|------|---------|-------------|
| `--budget <usdc>` | *required* | Total USDC budget to deploy |
| `--spread <cents>` | `5` | Distance from midpoint in cents |
| `--max-markets <n>` | `10` | Maximum number of markets to trade |
| `--danger-zone <cents>` | `2` | Cancel orders when price drifts within this distance |
| `--rebalance-interval <min>` | `60` | Check for better markets every N minutes (0 to disable) |
| `--min-daily-yield <percent>` | `0` | Minimum daily yield % to consider |
| `--min-rebalance-improvement <percent>` | `20` | Minimum profitability gain to trigger rebalance |
| `--no-smart-allocation` | off | Use equal allocation instead of profitability-weighted |

The daemon will:
1. Authenticate and derive API keys
2. Discover the top reward markets **sorted by profitability score**
3. **Smart allocation**: Deploy more capital to higher-yield markets
4. Place BID + ASK orders spread evenly across markets
5. Start the WebSocket safety monitor
6. Send heartbeats every 8 seconds to keep orders alive
7. Cancel and replace orders when prices drift into the danger zone
8. **Periodically rebalance** to better markets if profitability improves

**Smart Capital Allocation:**
- Markets with higher yield% get proportionally more capital
- Ensures each market meets minimum size requirements
- Shows expected daily/monthly earnings and APY on startup

Press `Ctrl+C` for graceful shutdown (cancels all orders first).

### `status` - Check current session

```bash
pnpm dev status
```

Shows session info, order stats, fill rate, and all live orders.

### `dashboard` - Web UI

```bash
pnpm dev dashboard --port 3737
```

Opens a dark-themed web dashboard at `http://localhost:3737` with:
- Session status and order statistics
- Live orders table (auto-refreshes every 2s)
- All discovered markets with reward rates
- Recent activity log
- Panic button to cancel all orders

| Flag | Default | Description |
|------|---------|-------------|
| `--port <number>` | `3737` | HTTP port |

### `panic` - Emergency kill switch

```bash
pnpm dev panic
```

Immediately cancels all orders via the CLOB API and marks the session as PANIC. Uses cached API credentials for speed. Falls back to re-deriving credentials if cache is unavailable.

| Flag | Description |
|------|-------------|
| `--skip-db` | Bypass SQLite, cancel via API only |

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
  dashboard/      HTTP server and HTML for the web dashboard
  db/             SQLite schema and database class
  discovery/      Gamma API fetcher and reward market filter
  orders/         Safe price calculator and order placement
  safety/         WebSocket connection manager and safety monitor
  utils/          Environment loader and config validation
tests/
  unit/           Unit tests (vitest)
```

### Key design decisions

- **ethers v5** (not v6) because `@polymarket/clob-client` depends on v5 internally
- **SQLite with WAL mode** for concurrent reads from the dashboard while the daemon writes
- **JSON-parsed API fields**: Gamma API returns `outcomes`, `outcomePrices`, and `clobTokenIds` as JSON-encoded strings, not arrays
- **Float-safe comparisons** with epsilon (`1e-10`) for danger zone boundary checks

## License

MIT
