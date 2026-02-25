import type { GammaMarket } from "./gamma.js";
import { calculateStabilityScore, isTooVolatile } from "../intelligence/stability.js";

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
  /** Daily yield % = (rewardRate / tvl) × 100 */
  dailyYieldPercent: number;
  /** Profitability score accounting for capital requirements and stability */
  profitabilityScore: number;
  /** Market stability score (0-1, higher = safer) */
  stabilityScore: number;
  /** Minimum capital needed to meet minSize requirements */
  minCapitalRequired: number;
}

export interface AllocationResult {
  market: RewardMarket;
  allocatedUsdc: number;
  expectedDailyReward: number;
  /** Your share of the market TVL after deployment */
  sharePercent: number;
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

/**
 * Calculate daily yield percentage: (rewardRate / tvl) × 100
 * This is the % of TVL distributed as rewards daily.
 */
export function calculateDailyYield(rewardRate: number, tvl: number): number {
  if (tvl <= 0) return 0;
  return (rewardRate / tvl) * 100;
}

/**
 * Calculate minimum capital required to meet minSize requirements.
 * Since budget is split 50/50 between BID and ASK, each side needs enough
 * independently. We use 2 × max(bidCost, askCost) so the costlier side
 * is guaranteed enough after the split.
 */
export function calculateMinCapitalRequired(
  minSize: number,
  midpoint: number,
  spreadCents: number = 5,
): number {
  const spread = spreadCents / 100;
  const bidPrice = Math.max(midpoint - spread, SAFETY_LOW);
  const askPrice = Math.min(midpoint + spread, SAFETY_HIGH);

  // BID: buying YES at bidPrice costs (minSize × bidPrice)
  // ASK: selling YES at askPrice costs (minSize × (1 - askPrice)) as collateral
  const bidCostPerSide = minSize * bidPrice;
  const askCostPerSide = minSize * (1 - askPrice);

  // Each side gets half the allocation, so total must be 2 × max side cost
  return 2 * Math.max(bidCostPerSide, askCostPerSide);
}

/**
 * Calculate profitability score that accounts for:
 * - Daily yield % (primary factor)
 * - Capital efficiency (lower min capital requirement = better)
 * - TVL stability (some penalty for very low TVL)
 */
export function calculateProfitabilityScore(
  dailyYieldPercent: number,
  minCapitalRequired: number,
  tvl: number,
): number {
  // Base score is the daily yield
  let score = dailyYieldPercent;
  
  // Penalty for very low TVL (unstable, might not last)
  // Markets below $1K get a 50% penalty, scales up to 0% penalty at $10K
  if (tvl < 10000) {
    const tvlPenalty = Math.max(0, 1 - (tvl / 10000)) * 0.5;
    score *= (1 - tvlPenalty);
  }
  
  // Slight bonus for capital efficiency (lower minCapital = better)
  // Markets requiring less capital get a small boost
  const capitalEfficiency = Math.min(1, 50 / Math.max(minCapitalRequired, 1));
  score *= (0.9 + 0.1 * capitalEfficiency);
  
  return score;
}

export interface FilterStats {
  total: number;
  withRewards: number;
  withTokenIds: number;
  withinSafetyBounds: number;
  withinVolatility: number;
  withinStability: number;
  withinYield: number;
}

export interface FilterOptions {
  /** Minimum daily yield % to include */
  minDailyYield?: number;
  /** Sort by profitability score instead of reward rate */
  sortByProfitability?: boolean;
  /** Spread in cents for capital calculations */
  spreadCents?: number;
  /** Maximum 24h price change in cents before excluding market (default: 5) */
  maxVolatilityCents?: number;
}

export interface FilterResult {
  markets: RewardMarket[];
  stats: FilterStats;
}

export function filterRewardMarkets(
  gammaMarkets: GammaMarket[],
  options: FilterOptions = {},
): FilterResult {
  const {
    minDailyYield = 0,
    sortByProfitability = true,
    spreadCents = 5,
    maxVolatilityCents = 5,
  } = options;

  const stats: FilterStats = {
    total: gammaMarkets.length,
    withRewards: 0,
    withTokenIds: 0,
    withinSafetyBounds: 0,
    withinVolatility: 0,
    withinStability: 0,
    withinYield: 0,
  };

  const rewardMarkets: RewardMarket[] = [];

  for (const market of gammaMarkets) {
    // Must have reward data
    if (!market.rewardsDailyRate || market.rewardsDailyRate <= 0) continue;
    stats.withRewards++;

    // Must have both token IDs
    if (!market.tokenIdYes || !market.tokenIdNo) continue;
    stats.withTokenIds++;

    const midpoint = computeMidpoint(market.priceYes, market.priceNo);

    // Safety bounds: skip markets where price is extreme
    if (!isWithinSafetyBounds(midpoint)) continue;
    stats.withinSafetyBounds++;

    // Volatility filter: skip markets with excessive 24h price change
    if (isTooVolatile(market, maxVolatilityCents)) continue;
    stats.withinVolatility++;

    // Calculate stability score
    const stabilityScore = calculateStabilityScore(market);

    // Filter out markets that are too risky (stability < 0.2)
    if (stabilityScore < 0.2) continue;
    stats.withinStability++;

    // tickSize from API is a number (e.g. 0.01), convert to string for SDK
    const tickSizeStr = String(market.tickSize);
    const minSize = market.rewardsMinSize || market.minOrderSize || 5;
    const tvl = market.liquidity;

    // Calculate profitability metrics
    const dailyYieldPercent = calculateDailyYield(market.rewardsDailyRate, tvl);
    const minCapitalRequired = calculateMinCapitalRequired(minSize, midpoint, spreadCents);
    const baseProfitability = calculateProfitabilityScore(dailyYieldPercent, minCapitalRequired, tvl);

    // Incorporate stability: score = baseProfitability × stabilityScore
    const profitabilityScore = baseProfitability * stabilityScore;

    // Filter by minimum daily yield
    if (dailyYieldPercent < minDailyYield) continue;
    stats.withinYield++;

    rewardMarkets.push({
      conditionId: market.conditionId,
      question: market.question,
      tokenIdYes: market.tokenIdYes,
      tokenIdNo: market.tokenIdNo,
      midpoint,
      tvl,
      rewardRate: market.rewardsDailyRate,
      tickSize: tickSizeStr,
      negRisk: market.negRisk,
      minSize,
      maxSpread: market.rewardsMaxSpread || 0.05,
      dailyYieldPercent,
      profitabilityScore,
      stabilityScore,
      minCapitalRequired,
    });
  }

  // Sort by profitability score (or reward rate for backward compatibility)
  if (sortByProfitability) {
    rewardMarkets.sort((a, b) => b.profitabilityScore - a.profitabilityScore);
  } else {
    rewardMarkets.sort((a, b) => b.rewardRate - a.rewardRate);
  }

  return { markets: rewardMarkets, stats };
}

/**
 * Smart capital allocation based on profitability and minimum requirements.
 * Ensures each market gets at least enough to meet minSize requirements.
 */
export function allocateCapitalSmart(
  markets: RewardMarket[],
  totalBudgetUsdc: number,
  maxMarkets: number = 10,
): AllocationResult[] {
  if (markets.length === 0 || totalBudgetUsdc <= 0) return [];

  // Filter to markets we can afford (need at least minCapitalRequired)
  const affordable = markets.filter(m => m.minCapitalRequired <= totalBudgetUsdc);
  
  if (affordable.length === 0) {
    console.log("No markets affordable with current budget");
    return [];
  }

  // Greedily allocate to top markets by profitability
  const allocations: AllocationResult[] = [];
  let remainingBudget = totalBudgetUsdc;
  
  // First pass: give each top market its minimum required capital
  const candidateMarkets = affordable.slice(0, maxMarkets);
  const minAllocations: { market: RewardMarket; minAlloc: number }[] = [];
  
  for (const market of candidateMarkets) {
    if (market.minCapitalRequired <= remainingBudget) {
      minAllocations.push({ market, minAlloc: market.minCapitalRequired });
      remainingBudget -= market.minCapitalRequired;
    }
  }

  // Calculate total profitability score for weighted distribution of surplus
  const totalScore = minAllocations.reduce((sum, { market }) => sum + market.profitabilityScore, 0);
  
  // Second pass: distribute remaining budget proportionally to profitability
  for (const { market, minAlloc } of minAllocations) {
    let finalAlloc = minAlloc;
    
    if (remainingBudget > 0 && totalScore > 0) {
      // Give more to higher-scoring markets
      const bonusShare = (market.profitabilityScore / totalScore) * remainingBudget;
      finalAlloc += bonusShare;
    }
    
    // Calculate expected daily reward from this allocation
    // Your share = (yourCapital / (currentTVL + yourCapital)) × dailyRewardPool
    const yourShare = finalAlloc / (market.tvl + finalAlloc);
    const expectedDailyReward = yourShare * market.rewardRate;
    
    allocations.push({
      market,
      allocatedUsdc: Math.floor(finalAlloc * 100) / 100,
      expectedDailyReward: Math.floor(expectedDailyReward * 100) / 100,
      sharePercent: yourShare * 100,
    });
  }

  // Reset remaining budget (it was used in loop calculations)
  // All budget should be allocated
  
  return allocations;
}

/**
 * Determine if rebalancing is worthwhile.
 * Returns markets that should be added/removed based on profitability changes.
 */
export interface RebalanceDecision {
  shouldRebalance: boolean;
  reason: string;
  addMarkets: RewardMarket[];
  removeMarkets: RewardMarket[];
  profitabilityGain: number;
}

export function shouldRebalance(
  currentMarkets: RewardMarket[],
  allAvailableMarkets: RewardMarket[],
  maxMarkets: number,
  /** Minimum improvement in profitability score to trigger rebalance */
  minImprovementPercent: number = 20,
): RebalanceDecision {
  const currentIds = new Set(currentMarkets.map(m => m.conditionId));
  const currentAvgScore = currentMarkets.length > 0
    ? currentMarkets.reduce((sum, m) => sum + m.profitabilityScore, 0) / currentMarkets.length
    : 0;
  
  // Get top N markets from all available
  const topMarkets = allAvailableMarkets.slice(0, maxMarkets);
  const topAvgScore = topMarkets.length > 0
    ? topMarkets.reduce((sum, m) => sum + m.profitabilityScore, 0) / topMarkets.length
    : 0;
  
  // Find markets to add (in top N but not currently deployed)
  const addMarkets = topMarkets.filter(m => !currentIds.has(m.conditionId));
  
  // Find markets to remove (currently deployed but not in top N)
  const topIds = new Set(topMarkets.map(m => m.conditionId));
  const removeMarkets = currentMarkets.filter(m => !topIds.has(m.conditionId));
  
  // Calculate improvement percentage
  const improvement = currentAvgScore > 0 
    ? ((topAvgScore - currentAvgScore) / currentAvgScore) * 100
    : (topAvgScore > 0 ? 100 : 0);
  
  const shouldRebalance = improvement >= minImprovementPercent && addMarkets.length > 0;
  
  let reason: string;
  if (!shouldRebalance) {
    if (addMarkets.length === 0) {
      reason = "Current markets are already optimal";
    } else {
      reason = `Improvement (${improvement.toFixed(1)}%) below threshold (${minImprovementPercent}%)`;
    }
  } else {
    reason = `${improvement.toFixed(1)}% profitability improvement available`;
  }
  
  return {
    shouldRebalance,
    reason,
    addMarkets,
    removeMarkets,
    profitabilityGain: improvement,
  };
}
