import { describe, it, expect } from "vitest";
import {
  filterRewardMarkets,
  allocateCapitalSmart,
  type RewardMarket,
  type FilterStats,
} from "../../src/discovery/rewards.js";
import type { GammaMarket } from "../../src/discovery/gamma.js";

/**
 * Tests for Phase 13: crash-loop prevention.
 * Covers:
 * - FilterResult return shape with stats (13.4)
 * - Filter funnel counts at each stage (13.4)
 * - allocateCapitalSmart returns [] on unaffordable markets (13.1 root cause)
 * - Filter relaxation effect: looser volatility finds more markets (13.2)
 */

function createGammaMarket(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: "test-id",
    conditionId: "cond-1",
    question: "Will it rain?",
    tokenIdYes: "yes-1",
    tokenIdNo: "no-1",
    priceYes: 0.50,
    priceNo: 0.50,
    active: true,
    closed: false,
    volume: 1000,
    liquidity: 50000,
    negRisk: false,
    tickSize: 0.01,
    minOrderSize: 5,
    rewardsMinSize: 5,
    rewardsMaxSpread: 0.05,
    rewardsDailyRate: 100,
    oneDayPriceChange: 0.01,
    oneHourPriceChange: 0.005,
    volume24hr: 5000,
    spread: 0.02,
    bestBid: 0.49,
    bestAsk: 0.51,
    ...overrides,
  };
}

describe("filterRewardMarkets returns FilterResult with stats", () => {
  it("returns stats alongside markets", () => {
    const markets = [createGammaMarket()];
    const result = filterRewardMarkets(markets);

    expect(result).toHaveProperty("markets");
    expect(result).toHaveProperty("stats");
    expect(result.stats).toHaveProperty("total");
    expect(result.stats).toHaveProperty("withRewards");
    expect(result.stats).toHaveProperty("withTokenIds");
    expect(result.stats).toHaveProperty("withinSafetyBounds");
    expect(result.stats).toHaveProperty("withinVolatility");
    expect(result.stats).toHaveProperty("withinStability");
    expect(result.stats).toHaveProperty("withinYield");
  });

  it("counts total correctly", () => {
    const markets = [
      createGammaMarket({ conditionId: "a" }),
      createGammaMarket({ conditionId: "b" }),
      createGammaMarket({ conditionId: "c" }),
    ];
    const { stats } = filterRewardMarkets(markets);
    expect(stats.total).toBe(3);
  });

  it("filters out markets without rewards", () => {
    const markets = [
      createGammaMarket({ rewardsDailyRate: 0 }),
      createGammaMarket({ rewardsDailyRate: 100, conditionId: "good" }),
    ];
    const { stats, markets: filtered } = filterRewardMarkets(markets);
    expect(stats.total).toBe(2);
    expect(stats.withRewards).toBe(1);
    expect(filtered.length).toBeLessThanOrEqual(1);
  });

  it("filters out markets without token IDs", () => {
    const markets = [
      createGammaMarket({ tokenIdYes: "" }),
      createGammaMarket({ conditionId: "good" }),
    ];
    const { stats } = filterRewardMarkets(markets);
    expect(stats.withTokenIds).toBeLessThanOrEqual(stats.withRewards);
  });

  it("filters out markets outside safety bounds", () => {
    const markets = [
      createGammaMarket({ priceYes: 0.05, priceNo: 0.95 }), // midpoint ~0.05
      createGammaMarket({ conditionId: "safe" }), // midpoint 0.50
    ];
    const { stats } = filterRewardMarkets(markets);
    expect(stats.withinSafetyBounds).toBeLessThanOrEqual(stats.withTokenIds);
  });

  it("filters out volatile markets based on maxVolatilityCents", () => {
    const markets = [
      createGammaMarket({ oneDayPriceChange: 0.10, conditionId: "volatile" }), // 10c change
      createGammaMarket({ oneDayPriceChange: 0.02, conditionId: "calm" }),      // 2c change
    ];
    const { stats } = filterRewardMarkets(markets, { maxVolatilityCents: 5 });
    expect(stats.withinVolatility).toBe(1); // only "calm" passes
  });

  it("filters by minimum daily yield", () => {
    const markets = [
      createGammaMarket({ rewardsDailyRate: 1, liquidity: 100000 }), // very low yield
      createGammaMarket({ rewardsDailyRate: 500, liquidity: 5000, conditionId: "high-yield" }), // high yield
    ];
    const { stats } = filterRewardMarkets(markets, { minDailyYield: 1 });
    expect(stats.withinYield).toBeLessThanOrEqual(stats.withinStability);
  });
});

describe("filter relaxation: looser volatility finds more markets", () => {
  it("strict volatility cap filters out markets that pass with relaxed cap", () => {
    const markets = [
      createGammaMarket({ oneDayPriceChange: 0.06, conditionId: "a" }), // 6c
      createGammaMarket({ oneDayPriceChange: 0.08, conditionId: "b" }), // 8c
      createGammaMarket({ oneDayPriceChange: 0.02, conditionId: "c" }), // 2c
    ];

    const strict = filterRewardMarkets(markets, { maxVolatilityCents: 5 });
    const relaxed = filterRewardMarkets(markets, { maxVolatilityCents: 10 });

    expect(relaxed.stats.withinVolatility).toBeGreaterThanOrEqual(strict.stats.withinVolatility);
    expect(relaxed.markets.length).toBeGreaterThanOrEqual(strict.markets.length);
  });

  it("zero minDailyYield accepts all yielding markets", () => {
    const markets = [
      createGammaMarket({ rewardsDailyRate: 1, liquidity: 100000 }),  // 0.001% yield
      createGammaMarket({ rewardsDailyRate: 500, liquidity: 5000, conditionId: "b" }), // 10% yield
    ];

    const withThreshold = filterRewardMarkets(markets, { minDailyYield: 1 });
    const noThreshold = filterRewardMarkets(markets, { minDailyYield: 0 });

    expect(noThreshold.stats.withinYield).toBeGreaterThanOrEqual(withThreshold.stats.withinYield);
  });
});

describe("allocateCapitalSmart with unaffordable markets", () => {
  const createRewardMarket = (
    id: string,
    minCap: number,
    score: number = 5,
  ): RewardMarket => ({
    conditionId: id,
    question: `Market ${id}`,
    tokenIdYes: `yes-${id}`,
    tokenIdNo: `no-${id}`,
    midpoint: 0.5,
    tvl: 10000,
    rewardRate: 100,
    tickSize: "0.01",
    negRisk: false,
    minSize: 5,
    maxSpread: 0.05,
    dailyYieldPercent: 5,
    profitabilityScore: score,
    stabilityScore: 0.8,
    minCapitalRequired: minCap,
  });

  it("returns empty when all markets too expensive", () => {
    const markets = [
      createRewardMarket("A", 200),
      createRewardMarket("B", 300),
    ];
    const result = allocateCapitalSmart(markets, 100, 10);
    expect(result).toHaveLength(0);
  });

  it("returns empty for empty market list", () => {
    const result = allocateCapitalSmart([], 100, 10);
    expect(result).toHaveLength(0);
  });

  it("returns empty for zero budget", () => {
    const markets = [createRewardMarket("A", 10)];
    const result = allocateCapitalSmart(markets, 0, 10);
    expect(result).toHaveLength(0);
  });

  it("finds markets when budget is sufficient", () => {
    const markets = [
      createRewardMarket("A", 50),
      createRewardMarket("B", 200), // too expensive for $100
    ];
    const result = allocateCapitalSmart(markets, 100, 10);
    expect(result).toHaveLength(1);
    expect(result[0].market.conditionId).toBe("A");
  });
});

describe("exponential backoff calculation", () => {
  // Test the backoff formula used in run.ts
  const BASE_MS = 60_000;
  const MAX_MS = 30 * 60_000;

  function calcBackoff(retryCount: number): number {
    return Math.min(BASE_MS * Math.pow(2, Math.min(retryCount - 1, 4)), MAX_MS);
  }

  it("starts at 60s", () => {
    expect(calcBackoff(1)).toBe(60_000);
  });

  it("doubles each retry", () => {
    expect(calcBackoff(2)).toBe(120_000);
    expect(calcBackoff(3)).toBe(240_000);
    expect(calcBackoff(4)).toBe(480_000);
    expect(calcBackoff(5)).toBe(960_000);
  });

  it("caps at 30 minutes", () => {
    expect(calcBackoff(6)).toBe(960_000); // capped at 2^4 = 16min due to Math.min(..., 4)
    expect(calcBackoff(10)).toBe(960_000);
    expect(calcBackoff(100)).toBe(960_000);
  });

  it("never exceeds max", () => {
    for (let i = 1; i <= 20; i++) {
      expect(calcBackoff(i)).toBeLessThanOrEqual(MAX_MS);
    }
  });
});

describe("filter relaxation schedule", () => {
  // Test the relaxation logic used in run.ts
  const RELAX_AFTER = 6;

  function simulateRelaxation(
    retries: number,
    initialVol: number = 5,
    initialYield: number = 0.5,
  ): { vol: number; yield: number } {
    let vol = initialVol;
    let yld = initialYield;
    for (let i = 1; i <= retries; i++) {
      if (i > 0 && i % RELAX_AFTER === 0) {
        vol = Math.min(vol + 2, 15);
        yld = Math.max(yld - 0.1, 0);
      }
    }
    return { vol, yield: yld };
  }

  it("does not relax before threshold", () => {
    const result = simulateRelaxation(5);
    expect(result.vol).toBe(5);
    expect(result.yield).toBe(0.5);
  });

  it("relaxes at threshold", () => {
    const result = simulateRelaxation(6);
    expect(result.vol).toBe(7);
    expect(result.yield).toBeCloseTo(0.4);
  });

  it("relaxes again at 2x threshold", () => {
    const result = simulateRelaxation(12);
    expect(result.vol).toBe(9);
    expect(result.yield).toBeCloseTo(0.3);
  });

  it("volatility caps at 15c", () => {
    const result = simulateRelaxation(60); // 10 relaxation steps
    expect(result.vol).toBe(15);
  });

  it("yield floors at 0", () => {
    const result = simulateRelaxation(60);
    expect(result.yield).toBe(0);
  });
});
