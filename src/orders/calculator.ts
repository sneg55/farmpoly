export interface SafePrices {
  bidPrice: number;
  askPrice: number;
  bidTokenId: string;
  askTokenId: string;
}

const TICK_SIZES: Record<string, number> = {
  "0.1": 0.1,
  "0.01": 0.01,
  "0.001": 0.001,
  "0.0001": 0.0001,
};

const SAFETY_LOW = 0.10;
const SAFETY_HIGH = 0.90;

/**
 * Round price to the nearest tick size (floor for bids, ceil for asks).
 */
function roundToTick(price: number, tickSize: number, direction: "floor" | "ceil"): number {
  const ticks = price / tickSize;
  const rounded = direction === "floor" ? Math.floor(ticks) : Math.ceil(ticks);
  // Avoid floating-point issues
  const decimals = tickSize.toString().split(".")[1]?.length || 0;
  return Number((rounded * tickSize).toFixed(decimals));
}

/**
 * Calculate safe bid and ask prices at a given spread from midpoint.
 * For a "zero-fill" strategy, we want orders far enough from midpoint
 * to be unlikely to fill, but close enough to earn liquidity rewards.
 *
 * Both sides operate on the YES token:
 *   BID = BUY YES below midpoint
 *   ASK = SELL YES above midpoint
 *
 * @param midpoint - Current market midpoint (0-1)
 * @param spreadCents - Distance from midpoint in cents (e.g., 5 = $0.05)
 * @param tickSize - Market tick size string (e.g., "0.01")
 * @param tokenIdYes - Yes token ID (used for both BID and ASK sides)
 * @param tokenIdNo - No token ID (currently unused — kept for future two-token strategies)
 * @param maxSpreadCents - Maximum spread in cents from market's rewardsMaxSpread (for reward qualification)
 */
export function calculateSafePrices(
  midpoint: number,
  spreadCents: number,
  tickSize: string,
  tokenIdYes: string,
  _tokenIdNo: string,
  maxSpreadCents?: number,
): SafePrices | null {
  const tick = TICK_SIZES[tickSize];
  if (!tick) throw new Error(`Invalid tick size: ${tickSize}`);

  // Enforce reward qualification: never exceed market's maxSpread
  const effectiveSpreadCents = maxSpreadCents
    ? Math.min(spreadCents, maxSpreadCents)
    : spreadCents;

  const spread = effectiveSpreadCents / 100;

  // BID: buy YES token below midpoint
  let bidPrice = roundToTick(midpoint - spread, tick, "floor");

  // ASK: sell YES token above midpoint (or equivalently buy NO token)
  let askPrice = roundToTick(midpoint + spread, tick, "ceil");

  // Clamp to safety bounds
  if (bidPrice < SAFETY_LOW) bidPrice = SAFETY_LOW;
  if (askPrice > SAFETY_HIGH) askPrice = SAFETY_HIGH;

  // Validate: bid must be below ask, both within bounds
  if (bidPrice >= askPrice) return null;
  if (bidPrice < tick || askPrice > 1 - tick) return null;

  return {
    bidPrice,
    askPrice,
    bidTokenId: tokenIdYes,
    askTokenId: tokenIdYes, // SELL YES above midpoint (equivalent to BUY NO)
  };
}

/**
 * Determine how many shares to buy for a given USDC budget at a given price.
 */
export function sharesToBuy(budgetUsdc: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return Math.floor((budgetUsdc / price) * 100) / 100; // Floor to 2 decimals
}

/**
 * Check if an order is within the danger zone (too close to midpoint).
 */
export function isInDangerZone(orderPrice: number, midpoint: number, dangerCents: number = 2): boolean {
  const danger = dangerCents / 100;
  return Math.abs(orderPrice - midpoint) < danger + 1e-10;
}

/**
 * Allocate budget equally across markets, splitting BID+ASK per market.
 */
export function allocateBudget(
  totalBudgetUsdc: number,
  marketCount: number,
): { perMarketUsdc: number; perSideUsdc: number } {
  if (marketCount <= 0) return { perMarketUsdc: 0, perSideUsdc: 0 };
  const perMarketUsdc = Math.floor((totalBudgetUsdc / marketCount) * 100) / 100;
  const perSideUsdc = Math.floor((perMarketUsdc / 2) * 100) / 100;
  return { perMarketUsdc, perSideUsdc };
}
