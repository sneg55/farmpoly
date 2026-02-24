import { describe, it, expect } from "vitest";
import { 
  computeMidpoint, 
  isWithinSafetyBounds,
  calculateDailyYield,
  calculateMinCapitalRequired,
  calculateProfitabilityScore,
  allocateCapitalSmart,
  shouldRebalance,
  type RewardMarket,
} from "../../src/discovery/rewards.js";

describe("computeMidpoint", () => {
  it("computes from yes and no prices", () => {
    // midpoint = (0.60 + (1 - 0.40)) / 2 = (0.60 + 0.60) / 2 = 0.60
    expect(computeMidpoint(0.60, 0.40)).toBe(0.60);
  });

  it("handles only yes price", () => {
    expect(computeMidpoint(0.45, 0)).toBe(0.45);
  });

  it("handles only no price", () => {
    expect(computeMidpoint(0, 0.55)).toBeCloseTo(0.45);
  });

  it("returns 0.5 when both are zero", () => {
    expect(computeMidpoint(0, 0)).toBe(0.5);
  });
});

describe("isWithinSafetyBounds", () => {
  it("accepts midpoints within bounds", () => {
    expect(isWithinSafetyBounds(0.50)).toBe(true);
    expect(isWithinSafetyBounds(0.10)).toBe(true);
    expect(isWithinSafetyBounds(0.90)).toBe(true);
  });

  it("rejects midpoints outside bounds", () => {
    expect(isWithinSafetyBounds(0.05)).toBe(false);
    expect(isWithinSafetyBounds(0.95)).toBe(false);
    expect(isWithinSafetyBounds(0.09)).toBe(false);
    expect(isWithinSafetyBounds(0.91)).toBe(false);
  });
});

describe("calculateDailyYield", () => {
  it("calculates yield percentage correctly", () => {
    // $250/day ÷ $2,200 TVL = 11.36% daily
    expect(calculateDailyYield(250, 2200)).toBeCloseTo(11.36, 1);
  });

  it("handles $1000/day with $10.5K TVL", () => {
    // $1000/day ÷ $10,500 TVL = 9.52% daily
    expect(calculateDailyYield(1000, 10500)).toBeCloseTo(9.52, 1);
  });

  it("returns 0 for zero TVL", () => {
    expect(calculateDailyYield(100, 0)).toBe(0);
  });

  it("handles small TVL markets", () => {
    // $300/day ÷ $4,100 TVL = 7.32% daily
    expect(calculateDailyYield(300, 4100)).toBeCloseTo(7.32, 1);
  });
});

describe("calculateMinCapitalRequired", () => {
  it("calculates capital for 5c spread at midpoint 0.50", () => {
    // BID at 0.45, ASK at 0.55
    // BID cost: 10 shares × 0.45 = $4.50
    // ASK cost: 10 shares × (1 - 0.55) = 10 × 0.45 = $4.50
    // Total: $9.00
    expect(calculateMinCapitalRequired(10, 0.50, 5)).toBeCloseTo(9, 1);
  });

  it("respects safety bounds", () => {
    // Midpoint at 0.12, spread 5c would put BID at 0.07 but clamped to 0.10
    const capital = calculateMinCapitalRequired(10, 0.12, 5);
    expect(capital).toBeGreaterThan(0);
  });
});

describe("calculateProfitabilityScore", () => {
  it("high yield with stable TVL scores high", () => {
    // 10% yield, $50 min capital, $50K TVL
    const score = calculateProfitabilityScore(10, 50, 50000);
    expect(score).toBeGreaterThan(9);
  });

  it("penalizes very low TVL markets", () => {
    // Same yield but $1K TVL vs $50K TVL
    const lowTvlScore = calculateProfitabilityScore(10, 50, 1000);
    const highTvlScore = calculateProfitabilityScore(10, 50, 50000);
    expect(lowTvlScore).toBeLessThan(highTvlScore);
  });

  it("gives bonus for capital efficiency", () => {
    // Same yield/TVL but different min capital requirements
    const efficientScore = calculateProfitabilityScore(5, 20, 20000);
    const inefficientScore = calculateProfitabilityScore(5, 200, 20000);
    expect(efficientScore).toBeGreaterThan(inefficientScore);
  });
});

describe("allocateCapitalSmart", () => {
  const createMarket = (
    id: string, 
    dailyYield: number, 
    minCap: number, 
    score: number
  ): RewardMarket => ({
    conditionId: id,
    question: `Market ${id}`,
    tokenIdYes: `yes-${id}`,
    tokenIdNo: `no-${id}`,
    midpoint: 0.5,
    tvl: 10000,
    rewardRate: dailyYield * 100, // Reverse engineer from yield
    tickSize: "0.01",
    negRisk: false,
    minSize: 5,
    maxSpread: 0.05,
    dailyYieldPercent: dailyYield,
    profitabilityScore: score,
    minCapitalRequired: minCap,
  });

  it("allocates to affordable markets only", () => {
    const markets = [
      createMarket("A", 5, 100, 5),   // Needs $100
      createMarket("B", 3, 500, 3),   // Needs $500 - too expensive
    ];
    
    const allocations = allocateCapitalSmart(markets, 200, 10);
    
    expect(allocations).toHaveLength(1);
    expect(allocations[0].market.conditionId).toBe("A");
  });

  it("allocates more to higher-scoring markets", () => {
    const markets = [
      createMarket("A", 10, 50, 10),  // High score
      createMarket("B", 2, 50, 2),    // Low score
    ];
    
    const allocations = allocateCapitalSmart(markets, 500, 10);
    
    expect(allocations).toHaveLength(2);
    // Market A should get more capital
    const allocA = allocations.find(a => a.market.conditionId === "A")!;
    const allocB = allocations.find(a => a.market.conditionId === "B")!;
    expect(allocA.allocatedUsdc).toBeGreaterThan(allocB.allocatedUsdc);
  });

  it("respects max markets limit", () => {
    const markets = [
      createMarket("A", 10, 30, 10),
      createMarket("B", 8, 30, 8),
      createMarket("C", 6, 30, 6),
      createMarket("D", 4, 30, 4),
    ];
    
    const allocations = allocateCapitalSmart(markets, 500, 2);
    expect(allocations).toHaveLength(2);
  });

  it("returns empty for insufficient budget", () => {
    const markets = [
      createMarket("A", 10, 200, 10),
    ];
    
    const allocations = allocateCapitalSmart(markets, 50, 10);
    expect(allocations).toHaveLength(0);
  });
});

describe("shouldRebalance", () => {
  const createMarket = (id: string, score: number): RewardMarket => ({
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
    dailyYieldPercent: score,
    profitabilityScore: score,
    minCapitalRequired: 50,
  });

  it("recommends rebalance when better markets available", () => {
    const current = [createMarket("A", 2), createMarket("B", 3)];
    const available = [
      createMarket("X", 10),  // Much better
      createMarket("Y", 8),   // Much better
      createMarket("A", 2),
      createMarket("B", 3),
    ];
    
    const decision = shouldRebalance(current, available, 2, 20);
    
    expect(decision.shouldRebalance).toBe(true);
    expect(decision.addMarkets).toHaveLength(2);
    expect(decision.removeMarkets).toHaveLength(2);
    expect(decision.profitabilityGain).toBeGreaterThan(20);
  });

  it("skips rebalance when improvement below threshold", () => {
    const current = [createMarket("A", 10)];
    const available = [
      createMarket("X", 11),  // Only 10% better
      createMarket("A", 10),
    ];
    
    const decision = shouldRebalance(current, available, 1, 20);
    
    expect(decision.shouldRebalance).toBe(false);
  });

  it("skips rebalance when already optimal", () => {
    const current = [createMarket("A", 10), createMarket("B", 9)];
    const available = [
      createMarket("A", 10),
      createMarket("B", 9),
      createMarket("C", 5),
    ];
    
    const decision = shouldRebalance(current, available, 2, 20);
    
    expect(decision.shouldRebalance).toBe(false);
    expect(decision.addMarkets).toHaveLength(0);
  });
});
