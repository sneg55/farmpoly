import type { GammaMarket } from "./gamma.js";

export interface RewardMarket {
  conditionId: string;
  question: string;
  tokenIdYes: string;
  tokenIdNo: string;
  midpoint: number;
  tvl: number;
  rewardRate: number;
  tickSize: string;
  negRisk: boolean;
  minSize: number;
  maxSpread: number;
}

const SAFETY_LOW = 0.10;
const SAFETY_HIGH = 0.90;

export function computeMidpoint(priceYes: number, priceNo: number): number {
  if (priceYes > 0 && priceNo > 0) {
    return (priceYes + (1 - priceNo)) / 2;
  }
  if (priceYes > 0) return priceYes;
  if (priceNo > 0) return 1 - priceNo;
  return 0.5;
}

export function isWithinSafetyBounds(midpoint: number): boolean {
  return midpoint >= SAFETY_LOW && midpoint <= SAFETY_HIGH;
}

export function filterRewardMarkets(
  gammaMarkets: GammaMarket[],
): RewardMarket[] {
  const rewardMarkets: RewardMarket[] = [];

  for (const market of gammaMarkets) {
    // Must have reward data
    if (!market.rewardsDailyRate || market.rewardsDailyRate <= 0) continue;

    // Must have both token IDs
    if (!market.tokenIdYes || !market.tokenIdNo) continue;

    const midpoint = computeMidpoint(market.priceYes, market.priceNo);

    // Safety bounds: skip markets where price is extreme
    if (!isWithinSafetyBounds(midpoint)) continue;

    // tickSize from API is a number (e.g. 0.01), convert to string for SDK
    const tickSizeStr = String(market.tickSize);

    rewardMarkets.push({
      conditionId: market.conditionId,
      question: market.question,
      tokenIdYes: market.tokenIdYes,
      tokenIdNo: market.tokenIdNo,
      midpoint,
      tvl: market.liquidity,
      rewardRate: market.rewardsDailyRate,
      tickSize: tickSizeStr,
      negRisk: market.negRisk,
      minSize: market.rewardsMinSize || market.minOrderSize || 5,
      maxSpread: market.rewardsMaxSpread || 0.05,
    });
  }

  // Sort by reward rate descending
  rewardMarkets.sort((a, b) => b.rewardRate - a.rewardRate);

  return rewardMarkets;
}
