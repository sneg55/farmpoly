import type { GammaMarket } from "../discovery/gamma.js";

/**
 * Calculate a stability score for a market (0-1).
 * Higher = safer for liquidity provision.
 *
 * Penalizes:
 * - High 24h price change (volatile)
 * - High 1h price change (short-term volatility)
 * - High 24h volume (more activity = more fill risk)
 * - Wide bid-ask spread (inefficient, less predictable)
 */
export function calculateStabilityScore(market: GammaMarket): number {
  let score = 1.0;

  // 24h price change penalty: 0c = no penalty, 10c+ = full penalty
  const dayChange = Math.abs(market.oneDayPriceChange);
  const dayPenalty = Math.min(dayChange / 0.10, 1.0);
  score *= 1 - dayPenalty * 0.4; // up to 40% penalty

  // 1h price change penalty: 0c = no penalty, 5c+ = full penalty
  const hourChange = Math.abs(market.oneHourPriceChange);
  const hourPenalty = Math.min(hourChange / 0.05, 1.0);
  score *= 1 - hourPenalty * 0.3; // up to 30% penalty

  // Volume penalty: $0 = no penalty, $100k+ = full penalty
  const volumePenalty = Math.min(market.volume24hr / 100_000, 1.0);
  score *= 1 - volumePenalty * 0.2; // up to 20% penalty

  // Spread penalty: 0 = no penalty, 10c+ = full penalty
  const spreadPenalty = Math.min(market.spread / 0.10, 1.0);
  score *= 1 - spreadPenalty * 0.1; // up to 10% penalty

  return Math.max(0, Math.min(1, score));
}

/**
 * Check if a market exceeds the maximum volatility threshold.
 * @param market - Market to check
 * @param maxVolatilityCents - Maximum 24h price change in cents (default 5)
 */
export function isTooVolatile(
  market: GammaMarket,
  maxVolatilityCents: number = 5,
): boolean {
  const maxChange = maxVolatilityCents / 100;
  return Math.abs(market.oneDayPriceChange) > maxChange;
}
