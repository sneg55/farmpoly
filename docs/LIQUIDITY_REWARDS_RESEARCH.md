# Deep Research: Polymarket Liquidity Rewards and Programmatic Liquidity Provision

A comprehensive technical investigation into Polymarket's liquidity reward system, programmatic liquidity provision strategies, and the ecosystem of tools available for automated market making.

> _Compiled February 25, 2026 based on publicly available information, API responses, and community projects. Polymarket's reward system may change without notice._

---

## Table of Contents

1. [Polymarket Liquidity Rewards: Deep Technical Analysis](#1-polymarket-liquidity-rewards-deep-technical-analysis)
2. [Practical Liquidity Provision Strategies](#2-practical-liquidity-provision-strategies)
3. [Existing GitHub Projects](#3-existing-github-projects)
4. [Polymarket CLI Liquidity Capabilities](#4-polymarket-cli-liquidity-capabilities)
5. [Building a Liquidity Manager](#5-building-a-liquidity-manager)
6. [Suggested Future Work](#6-suggested-future-work)

---

## 1. Polymarket Liquidity Rewards: Deep Technical Analysis

### 1.1 Overview

Polymarket incentivizes liquidity provision through a daily reward program. Market makers who place competitive limit orders near the midpoint receive a share of the daily reward pool for each market. The system is designed to encourage tight spreads and deep liquidity.

### 1.2 Key Parameters (from Gamma API)

Each market exposes reward parameters via the Gamma Markets API:

```json
{
  "rewardsMinSize": 20,      // Minimum order size in USDC to qualify
  "rewardsMaxSpread": 3.5,   // Maximum spread from midpoint (in cents) to qualify
  "spread": 0.02,            // Current market spread
  "bestBid": 0.48,
  "bestAsk": 0.52,
  "oneDayPriceChange": -0.015,
  "oneHourPriceChange": 0.002,
  "volume24hr": 125000
}
```

**Critical constraint**: Most markets (196/200+ sampled) have `rewardsMaxSpread: 3.5` cents. Orders outside this spread earn **zero rewards**.

### 1.3 Reward Calculation Formula

Based on analysis of Polymarket's behavior and community research, the reward scoring appears to follow this general structure:

#### Base Scoring Function

```
Score(order) = Size ├ù SpreadPenalty ├ù DepthBonus ├ù TwoSidedMultiplier
```

**SpreadPenalty** (quadratic decay from midpoint):

```
SpreadPenalty = max(0, 1 - (spread / maxSpread)┬▓)
```

For `maxSpread = 3.5c`:

| Distance from Mid | Penalty Factor     |
|-------------------|--------------------|
| 0c (at midpoint)  | 1.00 (100%)        |
| 1c                | 0.92 (92%)         |
| 2c                | 0.67 (67%)         |
| 3c                | 0.27 (27%)         |
| 3.5c              | 0.00 (0%)          |
| >3.5c             | 0.00 (ineligible)  |

**Intuition**: Orders closer to midpoint are more valuable because they're more likely to be hit, providing real liquidity. The quadratic penalty strongly discourages sitting at the edge of eligibility.

#### Two-Sided Liquidity Boost

Polymarket strongly prefers market makers who provide liquidity on **both** sides:

```
TwoSidedMultiplier = {
  2.0   if providing both BID and ASK
  1.0   if providing only one side
}
```

**Practical implication**: Single-sided liquidity earns roughly half the rewards per dollar committed.

#### Depth Contribution

Orders contribute based on their share of total depth at or better than their price:

```
DepthBonus = min(1.0, orderSize / referenceDepth)
```

This prevents a single massive order from dominating rewards.

### 1.4 Reward Distribution Mechanism

#### Sampling Period

- Rewards are calculated based on periodic snapshots (believed to be every few seconds to minutes)
- Orders must be live on the book at snapshot time to score
- Cancelled or filled orders don't score for periods they weren't present

#### Daily Distribution

```
UserReward = (UserTotalScore / AllUsersTotalScore) ├ù DailyMarketRewardPool
```

The reward pool varies by market based on:
- Market volume and interest
- Sponsor allocations (some markets have boosted rewards)
- Polymarket's discretionary allocation

### 1.5 Worked Example

Scenario: Market at 50/50, `rewardsMaxSpread = 3.5c`, `rewardsMinSize = 20`

| Provider | Side | Price  | Size | Spread | SpreadPenalty | TwoSided  | Raw Score |
|----------|------|--------|------|--------|---------------|-----------|-----------|
| Alice    | BID  | 0.48   | $100 | 2c     | 0.67          | No (1.0)  | 67        |
| Alice    | ASK  | 0.52   | $100 | 2c     | 0.67          | Yes (2.0) | 134       |
| Bob      | BID  | 0.485  | $200 | 1.5c   | 0.82          | No (1.0)  | 164       |

Alice's total: 67 + 134 = **201** (boosted because two-sided)  
Bob's total: **164**

If daily reward pool is $100:
- Alice: `$100 ├ù 201/(201+164)` = **$55.07**
- Bob: `$100 ├ù 164/(201+164)` = **$44.93**

### 1.6 Edge Cases

#### Extreme Probabilities (<10% or >90%)

- Providing liquidity on the unlikely side becomes risky
- Spread requirements may be relaxed
- Two-sided requirement becomes difficult (selling at 0.95 means buying at 0.05)

#### Thin Markets

- Fewer participants = larger reward share
- But also higher adverse selection risk
- Low volume markets may have minimal reward pools

#### Sponsor Rewards

Some markets have sponsor rewards from third parties:
- Higher reward pools (2-10x normal)
- May have different parameters
- Visible via `holdingRewardsEnabled` field in API

### 1.7 What Actually Maximizes Rewards

Based on the mechanics:

- **Place orders as close to midpoint as possible** ΓÇö Quadratic penalty is severe
- **Always be two-sided** ΓÇö 2x multiplier is significant
- **Meet minimum size** ΓÇö Orders below `rewardsMinSize` earn nothing
- **Stay within maxSpread** ΓÇö 3.5c is the hard cutoff
- **Minimize cancellation** ΓÇö Orders must be live at snapshot
- **Diversify across markets** ΓÇö Spread risk and catch sponsor bonuses
- **Accept fill risk** ΓÇö Tight spreads mean you WILL get filled

---

## 2. Practical Liquidity Provision Strategies

### 2.1 Strategy Spectrum

| Strategy       | Spread    | Fill Risk | Reward Potential | Complexity |
|----------------|-----------|-----------|------------------|------------|
| Passive LP     | 3ΓÇô3.5c    | Low       | Low              | Simple     |
| Active MM      | 1ΓÇô2c      | Medium    | High             | Medium     |
| Aggressive MM  | 0.5ΓÇô1c    | High      | Highest          | Complex    |
| Delta-Neutral  | 2c both   | Medium    | High             | Complex    |

### 2.2 Passive Liquidity Provision ("Reward Farming")

**Goal**: Earn rewards with minimal fill risk

**Approach**:
- Place orders at 3ΓÇô3.4c from midpoint
- Use minimum viable size
- Avoid volatile markets
- Cancel on significant price movement

**Problems discovered**:
- At 3c spread, fills still happen frequently in active markets
- "No-fill farming" is fundamentally incompatible with earning rewards
- Expected fill rate: 10ΓÇô30% of orders in active markets

Realistic APY: **15ΓÇô50%** (but must account for fill losses)

### 2.3 Active Market Making

**Goal**: Profit from spread capture while earning rewards

**Approach**:
- Tighter spreads (1ΓÇô2c)
- Dynamic pricing based on orderbook imbalance
- Inventory management (reduce position in direction of drift)
- Hedge with external positions if needed

**Key metrics to track**:
```
realized_pnl    = fills_profit - fills_loss
reward_income   = daily_rewards
inventory_risk  = abs(position) * price_volatility
total_return    = realized_pnl + reward_income - inventory_risk_cost
```

Realistic APY: **30ΓÇô100%+** (highly dependent on skill and market conditions)

### 2.4 Risk Factors

#### Adverse Selection
- Informed traders hit your orders when price is about to move
- You consistently buy high and sell low
- Mitigation: Monitor order flow, widen spread on unusual activity

#### Inventory Imbalance
- Position builds up on one side
- Exposed to directional price movement
- Mitigation: Skew prices, use position limits, hedge externally

#### Reward Competition
- More participants = smaller share
- Some markets have sophisticated HFT firms
- Mitigation: Find less competitive markets

#### Event Risk
- Binary outcomes resolve suddenly
- Position can become worthless overnight
- Mitigation: Reduce exposure before resolution

### 2.5 Historical Profitability Observations

From community reports and analysis:

- **2023ΓÇô2024**: Reward farming was highly profitable (50ΓÇô200% APY)
- **Late 2024**: Competition increased significantly
- **2025**: `warproxxx/poly-maker` author states bot is "not profitable"
- **Current**: Requires sophisticated strategies to be profitable

> Quote from poly-maker README:
> _"In today's market, this bot is not profitable and will lose money. Use it as a reference implementation... Given the increased competition on Polymarket, I don't see a point in playing with this unless you're willing to dedicate a significant amount of time."_

### 2.6 Capital Efficiency Considerations

**Minimum viable capital**: ~$100 (meets `rewardsMinSize` on single market)

**Optimal capital ranges**:
- $500ΓÇô2k: Single market, single-sided
- $2kΓÇô10k: Multiple markets, two-sided
- $10k+: Full market making across many markets

**Capital lockup**:
- Limit orders lock capital
- Filled orders create positions that lock capital until sold
- Merging positions (YES + NO ΓåÆ USDC) requires gas

---

## 3. Existing GitHub Projects

### 3.1 Official Polymarket Repositories

#### [Polymarket/polymarket-cli](https://github.com/Polymarket/polymarket-cli)
- **Purpose**: Rust CLI for all Polymarket operations
- **Status**: Actively maintained
- **Capabilities**: Full trading, market data, rewards tracking, CTF operations
- **Liquidity relevance**: Excellent for scripting MM operations

#### [Polymarket/clob-client](https://github.com/Polymarket/clob-client) (Γ¡É~500)
- **Purpose**: TypeScript SDK for CLOB API
- **Status**: Active
- **Capabilities**: Order management, market data, authentication

#### [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client) (Γ¡É~300)
- **Purpose**: Python SDK for CLOB API
- **Status**: Active
- **Capabilities**: Same as TS client, Python-native

#### [Polymarket/poly-market-maker](https://github.com/Polymarket/poly-market-maker) (Γ¡É258)
- **Purpose**: Official reference market maker
- **Status**: Experimental, not actively maintained
- **Strategies**: AMM and Bands
- **Architecture**: Python, Docker-ready

#### [Polymarket/polymarket-liq-mining](https://github.com/Polymarket/polymarket-liq-mining) (Γ¡É15)
- **Purpose**: Reward calculation and distribution
- **Status**: Historical reference
- **Value**: Shows how rewards were calculated (may be outdated)

### 3.2 Community Projects

#### [warproxxx/poly-maker](https://github.com/warproxxx/poly-maker) (Γ¡É898)
- **Purpose**: Full-featured market making bot
- **Status**: Actively maintained but author notes unprofitability
- **Features**: Google Sheets configuration, WebSocket orderbook monitoring, position management, multi-market support, position merging
- **Architecture**: Python with UV package manager
- ΓÜá∩╕Å **Warning**: Author explicitly states "not profitable in today's market"

#### [RuneDn/polymarket-liquidity-bot](https://github.com/RuneDn/polymarket-liquidity-bot) (Γ¡É17)
- **Purpose**: Pure reward farming (avoid fills)
- **Strategy**: Stay behind top order while within reward spread
- **Status**: Working but limited
- **Limitations**: Only places orders on sub-50% side; doesn't work below 10% probability; rate limiting at ~12 markets

#### [JeremyWhittaker/Polymarket_arbitrage](https://github.com/JeremyWhittaker/Polymarket_arbitrage) (Γ¡É44)
- **Purpose**: Arbitrage detection
- **Status**: Reference code from 2024 election

#### Various Trading Bots
- [lorine93s/polymarket-market-maker-bot](https://github.com/lorine93s/polymarket-market-maker-bot) (Γ¡É271)
- miladhist/polymarket-market-maker (Γ¡É12)
- Anmoldureha/polymarket-trading-bot-strategies (Γ¡É23)
- manhashed/polymarket-maker (Γ¡É2)

### 3.3 Ecosystem Gaps

Missing tooling:
- Real-time reward estimation dashboard
- Historical reward data aggregator
- Backtesting framework for MM strategies
- Cross-market optimization tools
- Automated position hedging
- Fill prediction models

---

## 4. Polymarket CLI Liquidity Capabilities

### 4.1 Installation

```bash
# macOS/Linux
brew tap Polymarket/polymarket-cli https://github.com/Polymarket/polymarket-cli
brew install polymarket

# Or via shell script
curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh
```

### 4.2 Core Commands for Liquidity Management

#### Market Data (no auth needed)

```bash
# Get orderbook
polymarket clob book <TOKEN_ID>
polymarket clob books "TOKEN1,TOKEN2"

# Prices
polymarket clob midpoint <TOKEN_ID>
polymarket clob spread <TOKEN_ID>
polymarket clob price <TOKEN_ID> --side buy

# Market info
polymarket clob market <CONDITION_ID>
polymarket clob tick-size <TOKEN_ID>
```

#### Order Management (auth required)

```bash
# Place limit order
polymarket clob create-order \
  --token <TOKEN_ID> \
  --side buy \
  --price 0.48 \
  --size 100

# Place multiple orders at once
polymarket clob post-orders \
  --tokens "TOKEN1,TOKEN2" \
  --side buy \
  --prices "0.48,0.52" \
  --sizes "100,100"

# Cancel orders
polymarket clob cancel <ORDER_ID>
polymarket clob cancel-market --market <CONDITION_ID>
polymarket clob cancel-all

# View orders
polymarket clob orders
polymarket clob order <ORDER_ID>
```

#### Rewards Tracking

```bash
# Check reward earnings
polymarket clob rewards --date 2024-06-15
polymarket clob earnings --date 2024-06-15
polymarket clob earnings-markets --date 2024-06-15

# Current reward status
polymarket clob current-rewards
polymarket clob market-reward <CONDITION_ID>

# Check if orders are scoring
polymarket clob order-scoring <ORDER_ID>
polymarket clob orders-scoring "ORDER1,ORDER2"
```

#### CTF Operations (for token minting)

```bash
# Split USDC into YES/NO tokens
polymarket ctf split --condition <CONDITION_ID> --amount 100

# Merge tokens back to USDC
polymarket ctf merge --condition <CONDITION_ID> --amount 100

# Redeem winning positions
polymarket ctf redeem --condition <CONDITION_ID>
```

### 4.3 JSON Output for Scripting

Every command supports `--output json`:

```bash
# Get orderbook as JSON
polymarket -o json clob book <TOKEN_ID>

# Parse with jq
polymarket -o json clob midpoint <TOKEN_ID> | jq '.mid'
```

### 4.4 Automation Potential

**Spread Maintenance Bot**:
```bash
#!/bin/bash
while true; do
  MID=$(polymarket -o json clob midpoint $TOKEN | jq -r '.mid')
  BID_PRICE=$(echo "$MID - 0.02" | bc)
  ASK_PRICE=$(echo "$MID + 0.02" | bc)

  polymarket clob cancel-all
  polymarket clob create-order --token $TOKEN --side buy  --price $BID_PRICE --size 100
  polymarket clob create-order --token $TOKEN --side sell --price $ASK_PRICE --size 100

  sleep 30
done
```

**Inventory Balancer**:
```bash
#!/bin/bash
POSITION=$(polymarket -o json data positions $WALLET | jq '.[0].size')
if [ $POSITION -gt 100 ]; then
  # Reduce position by widening ask
  polymarket clob cancel-all
  # Place orders with skewed pricing
fi
```

**Reward Optimizer**:
```bash
#!/bin/bash
# Check which orders are scoring
SCORING=$(polymarket -o json clob orders-scoring "$ORDER_IDS")
# Adjust non-scoring orders
```

### 4.5 Limitations

- No WebSocket support (polling only)
- No built-in scheduling
- Order placement is sequential (no batch atomicity)
- Rate limiting not handled automatically
- No position tracking across sessions

### 4.6 Required Extensions

To build a production liquidity manager:
- Add WebSocket support for real-time book updates
- Implement rate limit handling
- Add position persistence (database)
- Build scheduling/cron integration
- Add alerting for edge cases

---

## 5. Building a Liquidity Manager

### 5.1 Architecture Overview

```
ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ
Γöé                       Liquidity Manager                         Γöé
Γö£ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöñ
Γöé                                                                 Γöé
Γöé  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ  ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ Γöé
Γöé  Γöé Data Layer  Γöé  Γöé  Strategy   Γöé  Γöé   Execution Engine      Γöé Γöé
Γöé  Γöé             Γöé  Γöé  Engine     Γöé  Γöé                         Γöé Γöé
Γöé  Γöé ΓÇó WebSocket Γöé  Γöé             Γöé  Γöé ΓÇó Order Management      Γöé Γöé
Γöé  Γöé ΓÇó REST API  Γöé  Γöé ΓÇó Pricing   Γöé  Γöé ΓÇó Position Tracking     Γöé Γöé
Γöé  Γöé ΓÇó Gamma API Γöé  Γöé ΓÇó Risk Mgmt Γöé  Γöé ΓÇó Fill Handling         Γöé Γöé
Γöé  Γöé             Γöé  Γöé ΓÇó Inventory Γöé  Γöé ΓÇó CTF Operations        Γöé Γöé
Γöé  ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ  ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ  ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö¼ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ Γöé
Γöé         Γöé                Γöé                      Γöé               Γöé
Γöé         ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓö╝ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ               Γöé
Γöé                          Γöé                                      Γöé
Γöé               ΓöîΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓû╝ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÉ                           Γöé
Γöé               Γöé     Monitoring      Γöé                           Γöé
Γöé               Γöé                     Γöé                           Γöé
Γöé               Γöé ΓÇó P&L Tracking      Γöé                           Γöé
Γöé               Γöé ΓÇó Reward Est.       Γöé                           Γöé
Γöé               Γöé ΓÇó Alerting          Γöé                           Γöé
Γöé               ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ                           Γöé
Γöé                                                                 Γöé
ΓööΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÿ
```

### 5.2 Component Details

#### Data Layer

```typescript
interface DataLayer {
  // Real-time feeds
  subscribeOrderbook(tokenId: string): Observable<Orderbook>;
  subscribeTrades(tokenId: string): Observable<Trade>;

  // REST endpoints
  getMarkets(): Promise<Market[]>;
  getRewardParams(conditionId: string): Promise<RewardParams>;
  getPosition(wallet: string): Promise<Position[]>;

  // Derived data
  getMidpoint(tokenId: string): Promise<number>;
  getImbalance(tokenId: string): Promise<number>;
}
```

#### Strategy Engine

```typescript
interface StrategyEngine {
  // Compute target orders given current state
  computeOrders(
    market: Market,
    position: Position,
    config: StrategyConfig
  ): TargetOrder[];

  // Risk assessment
  shouldTrade(market: Market): boolean;
  getPositionLimit(market: Market): number;

  // Pricing
  computeBidPrice(mid: number, spread: number, skew: number): number;
  computeAskPrice(mid: number, spread: number, skew: number): number;
}
```

#### Execution Engine

```typescript
interface ExecutionEngine {
  // Order lifecycle
  placeOrder(order: Order): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  cancelAll(): Promise<void>;

  // Position management
  getOpenOrders(): Promise<Order[]>;
  reconcileOrders(target: Order[], current: Order[]): OrderDelta;

  // CTF operations
  splitPosition(conditionId: string, amount: number): Promise<void>;
  mergePosition(conditionId: string, amount: number): Promise<void>;
}
```

### 5.3 Reward Optimization Logic

```typescript
function optimizeForRewards(
  market: Market,
  capital: number,
  config: RewardConfig
): OrderSet {
  const { rewardsMaxSpread, rewardsMinSize } = market;
  const midpoint = market.midpoint;

  // Target spread: as tight as possible while managing risk
  const targetSpread = Math.min(
    rewardsMaxSpread * 0.8, // Stay safely within limit
    config.maxSpread
  );

  // Size: at least minSize, scale with capital
  const orderSize = Math.max(
    rewardsMinSize,
    capital * config.sizeMultiplier
  );

  // Two-sided for 2x multiplier
  return {
    bid: {
      price: midpoint - targetSpread / 100,
      size: orderSize / 2,
      side: 'BUY'
    },
    ask: {
      price: midpoint + targetSpread / 100,
      size: orderSize / 2,
      side: 'SELL'
    }
  };
}
```

### 5.4 Risk Controls

```typescript
const riskControls = {
  // Position limits
  maxPositionSize: 1000,   // Max shares per market
  maxPositionValue: 5000,  // Max USD value per market

  // Loss limits
  maxDailyLoss: 100,       // Stop trading after $100 loss
  maxDrawdown: 0.1,        // 10% drawdown limit

  // Market filters
  minVolume24h: 10000,     // Only trade liquid markets
  maxVolatility: 0.05,     // Skip highly volatile markets
  minTimeToResolution: 24 * 3600, // Avoid near-resolution markets

  // Execution safeguards
  maxOrdersPerMinute: 10,  // Rate limiting
  requireHeartbeat: true,  // Cancel all if connection lost
};
```

### 5.5 Monitoring Dashboard

Key metrics to display:
- Real-time P&L (realized + unrealized)
- Estimated daily reward earnings
- Position exposure by market
- Order fill rate
- Spread quality score
- Competitor analysis (your share of book)

---

## 6. Suggested Future Work

### 6.1 Missing Infrastructure

- **Reward Estimation API** ΓÇö Real-time estimate of expected daily rewards, historical reward data per market, competitor analysis
- **Backtesting Framework** ΓÇö Historical orderbook data, fill simulation, strategy evaluation
- **Position Hedging Service** ΓÇö Cross-market hedging, external venue hedging (futures, options)

### 6.2 Research Gaps

- Optimal spread calculation given market conditions
- Fill prediction models using order flow analysis
- Competitor behavior modeling
- Event risk pricing for prediction markets
- Multi-market portfolio optimization

### 6.3 Potential Open-Source Projects

- **polymarket-mm-framework** ΓÇö Modular market making framework with strategy plugins and risk management suite
- **polymarket-reward-tracker** ΓÇö Historical reward dashboard with per-market analytics and profitability calculator
- **polymarket-backtest** ΓÇö Historical data collection, strategy backtesting, performance attribution

### 6.4 CLI Improvements

Suggested additions to `polymarket-cli`:
- `polymarket lp start` ΓÇö Interactive LP mode
- `polymarket lp estimate-rewards` ΓÇö Reward projection
- `polymarket lp optimize` ΓÇö Auto-adjust for max rewards
- WebSocket support for real-time operations

### 6.5 Potential Alpha Opportunities

- **New market sniping** ΓÇö First mover advantage on reward pools
- **Sponsor reward hunting** ΓÇö Track boosted markets
- **Low-competition markets** ΓÇö Underserved niches
- **Cross-market arbitrage** ΓÇö Related event pricing
- **Information edge** ΓÇö Faster news integration

---

## Appendix: Key Resources

### Official Documentation

- [Polymarket Docs](https://docs.polymarket.com)
- [CLOB API](https://clob.polymarket.com)
- [Gamma API](https://gamma-api.polymarket.com/markets)

### GitHub Repositories

| Repo | Purpose |
|------|---------|
| [Polymarket/polymarket-cli](https://github.com/Polymarket/polymarket-cli) | Official Rust CLI |
| [Polymarket/clob-client](https://github.com/Polymarket/clob-client) | TypeScript SDK |
| [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client) | Python SDK |
| [Polymarket/poly-market-maker](https://github.com/Polymarket/poly-market-maker) | Reference market maker |
| [Polymarket/polymarket-liq-mining](https://github.com/Polymarket/polymarket-liq-mining) | Reward calculation |

### Community Projects

| Repo | Stars | Notes |
|------|-------|-------|
| [warproxxx/poly-maker](https://github.com/warproxxx/poly-maker) | Γ¡É898 | Full-featured, author warns unprofitable |
| [RuneDn/polymarket-liquidity-bot](https://github.com/RuneDn/polymarket-liquidity-bot) | Γ¡É17 | Pure reward farming |
| [JeremyWhittaker/Polymarket_arbitrage](https://github.com/JeremyWhittaker/Polymarket_arbitrage) | Γ¡É44 | Arbitrage detection |

### Contract Addresses (Polygon)

| Contract | Address |
|----------|---------|
| USDC | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| NegRisk Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| NegRisk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
