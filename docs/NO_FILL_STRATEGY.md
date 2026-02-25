# No-Fill Liquidity Strategy

## Goal
Earn liquidity rewards from Polymarket **without getting filled**. Orders should sit in the book, earn rewards, but never execute.

## Current Problem
- Default spread: 5c from midpoint
- This is **way too close** - orders frequently fill
- Result: ~50+ unwanted fills, capital locked in positions

## Required Changes

### 1. Wider Spreads (Primary Fix)
```
Current:  --spread 5  (5c from midpoint)
Required: --spread 15 to --spread 25 (15-25c from midpoint)
```

For markets priced at 50%, this means:
- BID at 25-35c (instead of 45c)
- ASK at 65-75c (instead of 55c)

### 2. One-Sided or Skewed Liquidity
Instead of placing equal BID + ASK, prefer the "bleeding" side:
- If price trending DOWN → only place BID (price moving away from it)
- If price trending UP → only place ASK (price moving away from it)
- If stable → place both but heavily skewed (80/20)

### 3. Low-Volatility Market Preference
Filter for markets where:
- Price hasn't moved >5c in last 24h
- Long-tail events (far expiry dates)
- Low trading volume (less likely to move)

### 4. Price Trend Detection
Track midpoint over time:
- If midpoint increased 3c in last hour → don't place BID
- If midpoint decreased 3c in last hour → don't place ASK

### 5. Aggressive Danger Zone
Increase danger zone to cancel earlier:
```
Current:  --danger-zone 2  (cancel if within 2c)
Required: --danger-zone 5  (cancel if within 5c)
```

## Implementation Priority

1. **Quick fix**: Just increase `--spread` to 20 in the run command
2. **Medium fix**: Add `--one-sided` flag to only place on safer side
3. **Full fix**: Add volatility filtering and trend detection

## Market Selection Criteria

Ideal "no-fill" markets:
- Priced near extremes (1-10c or 90-99c) - less likely to cross
- Long expiry (months away)
- Low volume (< $1000/day)
- Part of multi-outcome markets (e.g., "Who will win X?" with 10+ options)

## Reward Qualification

Still need to qualify for rewards:
- Orders must be within max spread (varies by market)
- Orders must be above min size (typically 5-10 shares)
- Orders must be on book (not cancelled too fast)

## Example: Safe Configuration

```bash
polyfarm run \
  --budget 100 \
  --spread 20 \
  --danger-zone 5 \
  --max-markets 5 \
  --min-daily-yield 0.5 \
  --rebalance-interval 120
```

This places orders 20c from midpoint (safe), cancels if within 5c (early warning), and rebalances every 2 hours to find calmer markets.
