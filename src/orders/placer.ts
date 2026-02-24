import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import type { PolyfarmDb } from "../db/database.js";
import type { RewardMarket, AllocationResult } from "../discovery/rewards.js";
import { calculateSafePrices, sharesToBuy, allocateBudget } from "./calculator.js";

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

  for (const market of markets) {
    // Get per-market budget (from allocation or equal split)
    const marketBudget = allocationMap.get(market.conditionId) ?? (defaultPerSide * 2);
    const perSideUsdc = marketBudget / 2;

    const prices = calculateSafePrices(
      market.midpoint,
      spreadCents,
      market.tickSize,
      market.tokenIdYes,
      market.tokenIdNo,
    );

    if (!prices) {
      console.log(`  Skipping ${market.question.slice(0, 50)}... (no valid price spread)`);
      continue;
    }

    const effectiveMinSize = minSizeOverride ?? market.minSize;

    // BID side: buy YES token below midpoint
    const bidSize = sharesToBuy(perSideUsdc, prices.bidPrice);
    if (bidSize < effectiveMinSize) {
      console.log(
        `  Skip BID: ${bidSize.toFixed(2)} shares < min ${effectiveMinSize} ` +
        `($${perSideUsdc.toFixed(2)} @ ${prices.bidPrice.toFixed(2)})`,
      );
    }
    if (bidSize >= effectiveMinSize) {
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

        const order: PlacedOrder = {
          orderId,
          conditionId: market.conditionId,
          tokenId: prices.bidTokenId,
          side: "BUY",
          price: prices.bidPrice,
          size: bidSize,
        };

        db.insertOrder({
          order_id: orderId,
          condition_id: market.conditionId,
          token_id: prices.bidTokenId,
          side: "BUY",
          price: prices.bidPrice,
          size: bidSize,
          order_type: "GTD",
          status: "LIVE",
          expiry: getEndOfDayUtc(),
        });

        placedOrders.push(order);
      } catch (err) {
        console.error(`Failed to place BID for ${market.question}:`, err);
      }
    }

    // ASK side: sell YES token above midpoint
    const askSize = sharesToBuy(perSideUsdc, 1 - prices.askPrice);
    if (askSize < effectiveMinSize) {
      console.log(
        `  Skip ASK: ${askSize.toFixed(2)} shares < min ${effectiveMinSize} ` +
        `($${perSideUsdc.toFixed(2)} @ ${prices.askPrice.toFixed(2)})`,
      );
    }
    if (askSize >= effectiveMinSize) {
      try {
        const orderId = await placeSingleOrder(
          clobClient,
          prices.askTokenId,
          Side.SELL,
          prices.askPrice,
          askSize,
          market.tickSize,
          market.negRisk,
        );

        const order: PlacedOrder = {
          orderId,
          conditionId: market.conditionId,
          tokenId: prices.askTokenId,
          side: "SELL",
          price: prices.askPrice,
          size: askSize,
        };

        db.insertOrder({
          order_id: orderId,
          condition_id: market.conditionId,
          token_id: prices.askTokenId,
          side: "SELL",
          price: prices.askPrice,
          size: askSize,
          order_type: "GTD",
          status: "LIVE",
          expiry: getEndOfDayUtc(),
        });

        placedOrders.push(order);
      } catch (err) {
        console.error(`Failed to place ASK for ${market.question}:`, err);
      }
    }
  }

  return placedOrders;
}
