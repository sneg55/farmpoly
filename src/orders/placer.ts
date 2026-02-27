import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import type { PolyfarmDb } from "../db/database.js";
import type { RewardMarket, AllocationResult } from "../discovery/rewards.js";
import type { TrendDirection } from "../intelligence/trend.js";
import { allowedSides } from "../intelligence/trend.js";
import { calculateSafePrices, sharesToBuy, allocateBudget } from "./calculator.js";
import { splitPosition } from "../positions/splitter.js";
import { getTokenBalances } from "../positions/fetcher.js";

export interface MintOptions {
  enabled: boolean;
  wallet: Wallet;
  env: EnvConfig;
  sessionId: number;
}

export interface PlacedOrder {
  orderId: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

/**
 * Get the end-of-day UTC timestamp for order expiry.
 */
function getEndOfDayUtc(): number {
  const now = new Date();
  const eod = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59),
  );
  return Math.floor(eod.getTime() / 1000);
}

/**
 * Place a single limit order via the CLOB API.
 */
async function placeSingleOrder(
  clobClient: ClobClient,
  tokenId: string,
  side: Side,
  price: number,
  size: number,
  tickSize: string,
  negRisk: boolean,
): Promise<string> {
  const expiration = getEndOfDayUtc();

  const order = await clobClient.createOrder({
    tokenID: tokenId,
    price,
    size,
    side,
    expiration,
  }, {
    tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
    negRisk,
  });

  const response = await clobClient.postOrder(order, OrderType.GTD);

  // The response contains the order ID
  if (response && response.orderID) {
    return response.orderID;
  }
  // Some SDK versions return it differently
  if (response && response.id) {
    return response.id;
  }
  throw new Error(`Failed to place order: ${JSON.stringify(response)}`);
}

/**
 * Place BID + ASK orders for a set of markets within budget.
 * If allocations are provided, use them for weighted capital distribution.
 * Otherwise, use equal allocation across all markets.
 */
export async function placeOrdersForMarkets(
  clobClient: ClobClient,
  db: PolyfarmDb,
  markets: RewardMarket[],
  totalBudgetUsdc: number,
  spreadCents: number,
  minSizeOverride?: number,
  allocations?: AllocationResult[],
  trendByMarket?: Map<string, TrendDirection>,
  mintOptions?: MintOptions,
): Promise<PlacedOrder[]> {
  // Build a map of conditionId -> allocated USDC if allocations provided
  const allocationMap = new Map<string, number>();
  if (allocations && allocations.length > 0) {
    for (const alloc of allocations) {
      allocationMap.set(alloc.market.conditionId, alloc.allocatedUsdc);
    }
  }

  // Fallback: equal allocation
  const { perSideUsdc: defaultPerSide } = allocateBudget(totalBudgetUsdc, markets.length);

  const placedOrders: PlacedOrder[] = [];
  // Track cumulative committed capital to avoid over-committing beyond total budget.
  // Use a small absolute epsilon to absorb floating-point rounding only.
  // Previous 2% margin was too aggressive — blocked valid ASK orders in single-market case.
  const effectiveBudget = totalBudgetUsdc + 0.01;
  let committedUsdc = 0;
  const expiration = getEndOfDayUtc();

  for (const market of markets) {
    // Determine which sides are allowed based on trend
    // When minting is enabled, keep both sides active for UP/DOWN trends (only CHOPPY skips)
    const trend = trendByMarket?.get(market.conditionId);
    const sides = trend ? allowedSides(trend, !!mintOptions?.enabled) : { bid: true, ask: true };

    if (!sides.bid && !sides.ask) {
      console.log(`  Skipping ${market.question.slice(0, 50)}... (CHOPPY trend, too dangerous)`);
      continue;
    }

    // Ensure market exists in DB (FK constraint: orders.condition_id → markets.condition_id)
    db.upsertMarket({
      condition_id: market.conditionId,
      question: market.question,
      slug: market.slug || "",
      token_id_yes: market.tokenIdYes,
      token_id_no: market.tokenIdNo,
      tick_size: market.tickSize,
      neg_risk: market.negRisk ? 1 : 0,
      midpoint: market.midpoint,
      tvl: market.tvl,
      reward_rate: market.rewardRate,
    });

    // Get per-market budget (from allocation or equal split)
    const marketBudget = allocationMap.get(market.conditionId) ?? (defaultPerSide * 2);
    // When one-sided, allocate full market budget to the single side
    const oneSided = !sides.bid || !sides.ask;
    const perSideUsdc = oneSided ? marketBudget : marketBudget / 2;

    if (oneSided) {
      const skippedSide = !sides.bid ? "BID" : "ASK";
      console.log(`  One-sided: skipping ${skippedSide} for ${market.question.slice(0, 40)}... (trend: ${trend})`);
    }

    // Enforce rewardsMaxSpread: pass maxSpread to calculator
    const maxSpreadCents = market.maxSpread > 0 ? market.maxSpread * 100 : undefined;

    const prices = calculateSafePrices(
      market.midpoint,
      spreadCents,
      market.tickSize,
      market.tokenIdYes,
      market.tokenIdNo,
      maxSpreadCents,
    );

    if (!prices) {
      console.log(`  Skipping ${market.question.slice(0, 50)}... (no valid price spread)`);
      continue;
    }

    const effectiveMinSize = minSizeOverride ?? market.minSize;

    // BID side: BUY YES below midpoint — costs price × size USDC
    const bidSize = sharesToBuy(perSideUsdc, prices.bidPrice);
    const bidCost = prices.bidPrice * bidSize;

    if (!sides.bid) {
      // Trend says skip BID
    } else if (bidSize < effectiveMinSize) {
      console.log(
        `  Skip BID: ${bidSize.toFixed(2)} shares < min ${effectiveMinSize} ` +
        `($${perSideUsdc.toFixed(2)} @ ${prices.bidPrice.toFixed(2)})`,
      );
    } else if (committedUsdc + bidCost > effectiveBudget) {
      console.log(
        `  Skip BID: would exceed budget ($${committedUsdc.toFixed(2)} + $${bidCost.toFixed(2)} = $${(committedUsdc + bidCost).toFixed(2)} > $${totalBudgetUsdc})`,
      );
    } else {
      try {
        const orderId = await placeSingleOrder(
          clobClient,
          prices.bidTokenId,
          Side.BUY,
          prices.bidPrice,
          bidSize,
          market.tickSize,
          market.negRisk,
        );

        committedUsdc += bidCost;

        db.insertOrder({
          order_id: orderId,
          condition_id: market.conditionId,
          token_id: prices.bidTokenId,
          side: "BUY",
          price: prices.bidPrice,
          size: bidSize,
          order_type: "GTD",
          status: "LIVE",
          expiry: expiration,
        });

        placedOrders.push({
          orderId,
          conditionId: market.conditionId,
          tokenId: prices.bidTokenId,
          side: "BUY",
          price: prices.bidPrice,
          size: bidSize,
        });
      } catch (err) {
        const msg = (err as Error).message || String(err);
        console.error(
          `  Failed BID ${market.question.slice(0, 40)}: ` +
          `${bidSize.toFixed(1)} shares @ ${prices.bidPrice.toFixed(2)} ` +
          `(cost $${bidCost.toFixed(2)}, committed $${committedUsdc.toFixed(2)}): ${msg}`,
        );
      }
    }

    // ASK side: SELL YES above midpoint
    // When minting: cost is the full split amount (locked as collateral)
    // Without minting: cost is (1 - price) × size USDC (theoretical collateral)
    const askSize = sharesToBuy(perSideUsdc, 1 - prices.askPrice);
    // With minting, the actual USDC cost of the split is askSize * price_per_token = askSize in USDC units
    // because splitPosition locks $1 per YES+NO pair. But we only split askCost USDC worth.
    const askCost = (1 - prices.askPrice) * askSize;

    if (!sides.ask) {
      // Trend says skip ASK
    } else if (askSize < effectiveMinSize) {
      console.log(
        `  Skip ASK: ${askSize.toFixed(2)} shares < min ${effectiveMinSize} ` +
        `($${perSideUsdc.toFixed(2)} @ ${prices.askPrice.toFixed(2)})`,
      );
    } else if (committedUsdc + askCost > effectiveBudget) {
      console.log(
        `  Skip ASK: would exceed budget ($${committedUsdc.toFixed(2)} + $${askCost.toFixed(2)} = $${(committedUsdc + askCost).toFixed(2)} > $${totalBudgetUsdc})`,
      );
    } else {
      try {
        // Mint-before-ASK: split USDC into YES+NO tokens if minting is enabled
        if (mintOptions?.enabled) {
          try {
            // Check on-chain YES balance first
            const balances = await getTokenBalances(mintOptions.wallet, mintOptions.env, [market.tokenIdYes]);
            const onChainYes = balances.length > 0 ? Number(balances[0].balance) / 1e6 : 0;
            const deficitShares = askSize - onChainYes;

            // Cap split at budget-allowed askCost to avoid over-minting beyond what the wallet can afford.
            // Each YES+NO pair costs $1 USDC, but we only need askCost worth of exposure.
            const splitUsdc = Math.min(deficitShares, askCost);

            if (splitUsdc > 0) {
              console.log(`  Minting [${market.negRisk ? 'NegRisk' : 'CTF'}]: splitting $${splitUsdc.toFixed(2)} USDC → YES+NO tokens`);
              await splitPosition(
                mintOptions.wallet,
                mintOptions.env,
                market.conditionId,
                market.negRisk,
                splitUsdc,
              );

              // Record NO tokens in inventory
              db.upsertInventory({
                session_id: mintOptions.sessionId,
                condition_id: market.conditionId,
                token_id: market.tokenIdNo,
                side: "NO",
                minted_amount: splitUsdc,
                current_balance: splitUsdc,
              });
              // Record YES tokens too (they'll be consumed by ASK)
              db.upsertInventory({
                session_id: mintOptions.sessionId,
                condition_id: market.conditionId,
                token_id: market.tokenIdYes,
                side: "YES",
                minted_amount: splitUsdc,
                current_balance: splitUsdc,
              });
            }
          } catch (splitErr) {
            const msg = (splitErr as Error).message || String(splitErr);
            console.log(`  Mint failed [${market.negRisk ? 'NegRisk' : 'CTF'}] (falling back to BID-only): ${msg.slice(0, 200)}`);
            continue; // skip ASK for this market
          }
        }

        const orderId = await placeSingleOrder(
          clobClient,
          prices.askTokenId,
          Side.SELL,
          prices.askPrice,
          askSize,
          market.tickSize,
          market.negRisk,
        );

        committedUsdc += askCost;

        db.insertOrder({
          order_id: orderId,
          condition_id: market.conditionId,
          token_id: prices.askTokenId,
          side: "SELL",
          price: prices.askPrice,
          size: askSize,
          order_type: "GTD",
          status: "LIVE",
          expiry: expiration,
        });

        placedOrders.push({
          orderId,
          conditionId: market.conditionId,
          tokenId: prices.askTokenId,
          side: "SELL",
          price: prices.askPrice,
          size: askSize,
        });

        // Update YES inventory balance (tokens are now in the ASK order)
        if (mintOptions?.enabled) {
          const yesInv = db.getInventory(mintOptions.sessionId, market.conditionId, "YES");
          if (yesInv) {
            db.updateInventoryBalance(yesInv.id, Math.max(0, yesInv.current_balance - askSize));
          }
        }
      } catch (err) {
        const msg = (err as Error).message || String(err);
        console.error(
          `  Failed ASK ${market.question.slice(0, 40)}: ` +
          `${askSize.toFixed(1)} shares @ ${prices.askPrice.toFixed(2)} ` +
          `(cost $${askCost.toFixed(2)}, committed $${committedUsdc.toFixed(2)}): ${msg}`,
        );
      }
    }
  }

  if (placedOrders.length > 0) {
    console.log(`  Total committed: $${committedUsdc.toFixed(2)} / $${totalBudgetUsdc} USDC`);
  }

  return placedOrders;
}
