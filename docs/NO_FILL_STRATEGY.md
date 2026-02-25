# Defensive Liquidity Strategy (v2)

> **Note:** This replaces the old "no-fill" strategy (wide spreads to avoid fills).
> v2 earns rewards by placing orders WITHIN `rewardsMaxSpread` while using smart
> protection to minimize and recover from fills.

## Goal
Earn Polymarket liquidity rewards by qualifying for the reward program while
minimizing fill exposure through prevention, detection, and recovery layers.

## How It Works

### Prevention Layer
- **`rewardsMaxSpread` enforcement:** Orders are clamped to the market's max spread
  (typically 3.5c), regardless of `--spread` flag. This ensures reward qualification.
- **Stability scoring:** Markets ranked by volatility, volume, and spread safety.
  Markets with stability score < 0.2 are skipped.
- **Trend detection:** One-sided placement based on 1h/24h price trends.
  UP trend → ASK only, DOWN → BID only, CHOPPY → skip market.
- **WebSocket-first:** Safety monitor starts BEFORE orders are placed.

### Detection Layer
- **Graduated response:** Green (safe) → Yellow (warning at `dangerZoneCents`) →
  Red (cancel at `dangerZoneCents / 2`).
- **Counterpart cancellation:** When a fill occurs, opposite-side orders are
  cancelled immediately to prevent double exposure.

### Recovery Layer (Hedge-on-Fill)
- **Fill detection:** Polls `getTrades()` every 5s, matches fills to our orders.
- **Hedge execution:** Buys opposite token (YES/NO) via FOK → FAK fallback.
- **On-chain merge:** Merges matched positions → returns ~$1.00 USDC per pair.
- **P&L:** Net cost = fillPrice + hedgePrice - 1.00. Typically 1-3c per fill.

## Recommended Configuration

```bash
polyfarm run \
  --budget 100 \
  --spread 3 \
  --danger-zone 3 \
  --max-markets 5 \
  --max-volatility 5 \
  --placement-mode adaptive \
  --hedge-fills \
  --warmup-seconds 5 \
  --rebalance-interval 60 \
  --min-daily-yield 0.5
```

### Flag Explanation

| Flag | Value | Why |
|------|-------|-----|
| `--spread 3` | 3c | Close to midpoint for rewards; clamped to market's maxSpread |
| `--danger-zone 3` | 3c | Yellow warning at 3c, red cancel at 1.5c from midpoint |
| `--max-markets 5` | 5 | Focus capital on top-scoring markets |
| `--max-volatility 5` | 5c | Skip markets with >5c 24h price movement |
| `--placement-mode adaptive` | adaptive | One-sided orders based on trend detection |
| `--hedge-fills` | enabled | Auto-hedge fills (buy opposite + merge) |
| `--warmup-seconds 5` | 5s | Collect WS midpoints before placing orders |
| `--rebalance-interval 60` | 60min | Re-score markets hourly |
| `--min-daily-yield 0.5` | 0.5% | Only deploy to markets with meaningful rewards |

## Why Not Wide Spreads?

The old strategy used `--spread 20` to avoid fills entirely. Problems:
1. **No reward qualification** — orders 20c from midpoint are outside `rewardsMaxSpread` (~3.5c)
2. **Wasted capital** — orders sit on book earning nothing
3. **Still vulnerable** — big moves can still fill wide orders

v2 places orders WITHIN reward range and uses protection layers to handle the
occasional fill safely. Expected: ~90%+ reward qualification, ~5-10 fills/session
at 1-3c cost each.
