import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { PolyfarmDb } from "../../src/db/database.js";
import { placeOrdersForMarkets, type MintOptions } from "../../src/orders/placer.js";
import type { RewardMarket } from "../../src/discovery/rewards.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ethers } from "ethers";

// Mock external modules used by placer in mint mode
vi.mock("../../src/auth/approval.js", () => ({
  checkApproval: vi.fn(),
}));
vi.mock("../../src/positions/fetcher.js", () => ({
  getTokenBalances: vi.fn(),
}));
vi.mock("../../src/positions/splitter.js", () => ({
  splitPosition: vi.fn(),
}));

import { checkApproval } from "../../src/auth/approval.js";
import { getTokenBalances } from "../../src/positions/fetcher.js";
import { splitPosition } from "../../src/positions/splitter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "../../src/db/schema.sql");

function createTestDb(): { raw: Database.Database; db: PolyfarmDb } {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  const schema = readFileSync(schemaPath, "utf-8");
  raw.exec(schema);
  return { raw, db: new PolyfarmDb(raw) };
}

function makeMarket(overrides: Partial<RewardMarket> = {}): RewardMarket {
  return {
    conditionId: "cond_1",
    question: "Test market?",
    slug: "test-market",
    tokenIdYes: "tok_yes_1",
    tokenIdNo: "tok_no_1",
    midpoint: 0.50,
    tvl: 100000,
    rewardRate: 500,
    tickSize: "0.01",
    negRisk: false,
    minSize: 5,
    maxSpread: 10,
    dailyYieldPercent: 1.5,
    profitabilityScore: 10,
    minCapitalRequired: 5,
    ...overrides,
  };
}

function makeMockClobClient() {
  let orderCounter = 0;
  return {
    createOrder: vi.fn().mockImplementation(async () => ({ signed: true })),
    postOrder: vi.fn().mockImplementation(async () => ({
      orderID: `order_${++orderCounter}`,
    })),
    cancelAll: vi.fn(),
    cancelOrder: vi.fn(),
  };
}

describe("placeOrdersForMarkets", () => {
  let raw: Database.Database;
  let db: PolyfarmDb;

  beforeEach(() => {
    vi.clearAllMocks();
    const result = createTestDb();
    raw = result.raw;
    db = result.db;
  });

  afterEach(() => {
    raw.close();
  });

  it("upserts market before inserting orders (FK constraint)", async () => {
    const client = makeMockClobClient();
    const market = makeMarket();

    // Verify market does NOT exist in DB before placement
    const marketsBefore = db.getMarkets();
    expect(marketsBefore).toHaveLength(0);

    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      [market],
      100,
      5,
    );

    // Market should now exist in DB
    const marketsAfter = db.getMarkets();
    expect(marketsAfter).toHaveLength(1);
    expect(marketsAfter[0].condition_id).toBe("cond_1");

    // Orders should be placed successfully
    expect(placed.length).toBeGreaterThan(0);

    // Orders should exist in DB with correct FK
    const liveOrders = db.getLiveOrders();
    expect(liveOrders.length).toBe(placed.length);
    for (const order of liveOrders) {
      expect(order.condition_id).toBe("cond_1");
    }
  });

  it("places both BID and ASK when budget allows", async () => {
    const client = makeMockClobClient();
    const market = makeMarket({ minSize: 5 });

    const allocations = [
      {
        market,
        allocatedUsdc: 90,
        expectedDailyReward: 2.0,
        sharePercent: 1.5,
      },
    ];

    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      [market],
      200,
      5,
      undefined,
      allocations,
    );

    const bids = placed.filter((o) => o.side === "BUY");
    const asks = placed.filter((o) => o.side === "SELL");
    expect(bids.length).toBe(1);
    expect(asks.length).toBe(1);

    // BID should be below midpoint, ASK above
    expect(bids[0].price).toBeLessThan(0.50);
    expect(asks[0].price).toBeGreaterThan(0.50);
  });

  it("places both BID and ASK when cost exactly equals budget (no off-by-one)", async () => {
    const client = makeMockClobClient();
    const market = makeMarket({ minSize: 5 });

    // Single market with allocation = full budget → BID+ASK costs should equal budget exactly
    const allocations = [
      {
        market,
        allocatedUsdc: 100,
        expectedDailyReward: 2.0,
        sharePercent: 1.5,
      },
    ];

    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      [market],
      100,
      5,
      undefined,
      allocations,
    );

    const bids = placed.filter((o) => o.side === "BUY");
    const asks = placed.filter((o) => o.side === "SELL");
    expect(bids.length).toBe(1);
    expect(asks.length).toBe(1);

    // Total cost should be close to but not exceed budget
    let totalCost = 0;
    for (const order of placed) {
      if (order.side === "BUY") {
        totalCost += order.price * order.size;
      } else {
        totalCost += (1 - order.price) * order.size;
      }
    }
    expect(totalCost).toBeLessThanOrEqual(100.01);
  });

  it("skips orders below minimum size", async () => {
    const client = makeMockClobClient();
    // Very high minSize that budget can't cover
    const market = makeMarket({ minSize: 10000 });

    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      [market],
      10,
      5,
    );

    expect(placed).toHaveLength(0);
    // Market should still be upserted even with no orders
    expect(db.getMarkets()).toHaveLength(1);
  });

  it("tracks cumulative capital and stops when budget exhausted", async () => {
    const client = makeMockClobClient();
    const markets = [
      makeMarket({ conditionId: "cond_1", tokenIdYes: "tok_1y", tokenIdNo: "tok_1n" }),
      makeMarket({ conditionId: "cond_2", tokenIdYes: "tok_2y", tokenIdNo: "tok_2n" }),
      makeMarket({ conditionId: "cond_3", tokenIdYes: "tok_3y", tokenIdNo: "tok_3n" }),
    ];

    // With $10 budget split across 3 markets: ~$3.33/market, ~$1.67/side
    // At midpoint 0.50, BID@0.45: 1.67/0.45=3.7 shares (< minSize 5) → skipped
    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      markets,
      10,
      5,
    );

    // Total committed should never exceed budget
    let totalCost = 0;
    for (const order of placed) {
      if (order.side === "BUY") {
        totalCost += order.price * order.size;
      } else {
        totalCost += (1 - order.price) * order.size;
      }
    }
    expect(totalCost).toBeLessThanOrEqual(10 + 0.01); // allow rounding
  });

  it("handles API errors gracefully without crashing", async () => {
    const client = makeMockClobClient();
    client.postOrder.mockRejectedValue(new Error("not enough balance / allowance"));

    const market = makeMarket();
    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      [market],
      100,
      5,
    );

    // No orders placed but no crash
    expect(placed).toHaveLength(0);
    // Market still upserted
    expect(db.getMarkets()).toHaveLength(1);
    // No orders in DB
    expect(db.getLiveOrders()).toHaveLength(0);
  });

  it("uses allocations when provided", async () => {
    const client = makeMockClobClient();
    const market = makeMarket();
    const allocations = [
      {
        market,
        allocatedUsdc: 80,
        expectedDailyReward: 2.0,
        sharePercent: 1.5,
      },
    ];

    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      [market],
      100,
      5,
      undefined,
      allocations,
    );

    // Should use $80 allocation (not $100 equal split)
    // perSideUsdc = 80/2 = 40
    // BID: sharesToBuy(40, 0.45) = floor(40/0.45 * 100)/100 = 88.88
    const bid = placed.find((o) => o.side === "BUY");
    expect(bid).toBeDefined();
    expect(bid!.size).toBe(88.88);
  });

  // ── Two-pass ordering tests ───────────────────────────────────────

  function makeMintOptions(overrides: Partial<MintOptions> = {}): MintOptions {
    return {
      enabled: true,
      wallet: {} as any,
      env: { polygonRpcUrl: "http://localhost" } as any,
      sessionId: 1,
      mintBudgetPercent: 50,
      ...overrides,
    };
  }

  it("BIDs-before-ASKs: all BUY calls precede any SELL call with 2+ markets", async () => {
    const client = makeMockClobClient();
    const markets = [
      makeMarket({ conditionId: "cond_1", tokenIdYes: "tok_1y", tokenIdNo: "tok_1n" }),
      makeMarket({ conditionId: "cond_2", tokenIdYes: "tok_2y", tokenIdNo: "tok_2n" }),
    ];

    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      markets,
      200,
      5,
    );

    const buys = placed.filter((o) => o.side === "BUY");
    const sells = placed.filter((o) => o.side === "SELL");
    expect(buys.length).toBe(2);
    expect(sells.length).toBe(2);

    // All BUY indices should be lower than all SELL indices
    const buyIndices = placed.map((o, i) => o.side === "BUY" ? i : -1).filter((i) => i >= 0);
    const sellIndices = placed.map((o, i) => o.side === "SELL" ? i : -1).filter((i) => i >= 0);
    const maxBuyIndex = Math.max(...buyIndices);
    const minSellIndex = Math.min(...sellIndices);
    expect(maxBuyIndex).toBeLessThan(minSellIndex);
  });

  it("mint budget cap: mintBudgetPercent=50 on $100 budget limits minting to $50", async () => {
    const client = makeMockClobClient();
    const mintOpts = makeMintOptions({ mintBudgetPercent: 50 });

    // Mock: high on-chain USDC balance, no existing YES tokens
    vi.mocked(checkApproval).mockResolvedValue({
      balance: ethers.utils.parseUnits("1000", 6),
      ctfExchangeAllowance: ethers.constants.MaxUint256,
      negRiskCtfExchangeAllowance: ethers.constants.MaxUint256,
      conditionalTokensAllowance: ethers.constants.MaxUint256,
      negRiskAdapterAllowance: ethers.constants.MaxUint256,
      needsApproval: false,
      needsNegRiskApproval: false,
      needsConditionalTokensApproval: false,
      needsNegRiskAdapterApproval: false,
    });
    vi.mocked(getTokenBalances).mockResolvedValue([{ tokenId: "tok_1y", balance: ethers.BigNumber.from(0) }]);
    vi.mocked(splitPosition).mockResolvedValue(undefined as any);

    // 3 markets: each wants ~$16.67/side for ASK minting
    // With 50% cap = $50 allowed, and $100 budget across 3 markets = $33.33/market = $16.67/side
    // askCost per market ≈ $16.67, so ~3 × $16.67 ≈ $50 — may hit cap
    const markets = [
      makeMarket({ conditionId: "cond_1", tokenIdYes: "tok_1y", tokenIdNo: "tok_1n" }),
      makeMarket({ conditionId: "cond_2", tokenIdYes: "tok_2y", tokenIdNo: "tok_2n" }),
      makeMarket({ conditionId: "cond_3", tokenIdYes: "tok_3y", tokenIdNo: "tok_3n" }),
    ];

    // Need a session row for inventory FK
    db.startSession(100, 5);

    await placeOrdersForMarkets(
      client as any,
      db,
      markets,
      100,
      5,
      undefined,
      undefined,
      undefined,
      mintOpts,
    );

    // Sum all splitPosition calls to verify total minted ≤ $50
    const splitCalls = vi.mocked(splitPosition).mock.calls;
    let totalMinted = 0;
    for (const call of splitCalls) {
      totalMinted += call[4] as number; // splitUsdc is the 5th arg
    }
    expect(totalMinted).toBeLessThanOrEqual(50 + 0.01);
  });

  it("USDC balance guard: low on-chain balance skips minting", async () => {
    const client = makeMockClobClient();
    const mintOpts = makeMintOptions({ mintBudgetPercent: 100 });

    // Mock: very low on-chain balance ($1)
    vi.mocked(checkApproval).mockResolvedValue({
      balance: ethers.utils.parseUnits("1", 6), // only $1
      ctfExchangeAllowance: ethers.constants.MaxUint256,
      negRiskCtfExchangeAllowance: ethers.constants.MaxUint256,
      conditionalTokensAllowance: ethers.constants.MaxUint256,
      negRiskAdapterAllowance: ethers.constants.MaxUint256,
      needsApproval: false,
      needsNegRiskApproval: false,
      needsConditionalTokensApproval: false,
      needsNegRiskAdapterApproval: false,
    });
    vi.mocked(getTokenBalances).mockResolvedValue([{ tokenId: "tok_yes_1", balance: ethers.BigNumber.from(0) }]);

    const market = makeMarket();
    db.startSession(100, 5);

    await placeOrdersForMarkets(
      client as any,
      db,
      [market],
      100,
      5,
      undefined,
      undefined,
      undefined,
      mintOpts,
    );

    // splitPosition should NOT have been called (USDC too low for the required split)
    expect(vi.mocked(splitPosition)).not.toHaveBeenCalled();
  });

  it("no-mint mode: both BID and ASK placed without minting", async () => {
    const client = makeMockClobClient();

    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      [makeMarket()],
      100,
      5,
      undefined,
      undefined,
      undefined,
      undefined, // no mintOptions
    );

    const buys = placed.filter((o) => o.side === "BUY");
    const sells = placed.filter((o) => o.side === "SELL");
    expect(buys.length).toBe(1);
    expect(sells.length).toBe(1);

    // No minting-related calls
    expect(vi.mocked(checkApproval)).not.toHaveBeenCalled();
    expect(vi.mocked(splitPosition)).not.toHaveBeenCalled();
  });

  it("ASK placed with existing tokens: no minting when YES balance is sufficient", async () => {
    const client = makeMockClobClient();
    const mintOpts = makeMintOptions({ mintBudgetPercent: 50 });

    // Mock: plenty of on-chain USDC and existing YES tokens
    vi.mocked(checkApproval).mockResolvedValue({
      balance: ethers.utils.parseUnits("1000", 6),
      ctfExchangeAllowance: ethers.constants.MaxUint256,
      negRiskCtfExchangeAllowance: ethers.constants.MaxUint256,
      conditionalTokensAllowance: ethers.constants.MaxUint256,
      negRiskAdapterAllowance: ethers.constants.MaxUint256,
      needsApproval: false,
      needsNegRiskApproval: false,
      needsConditionalTokensApproval: false,
      needsNegRiskAdapterApproval: false,
    });
    // Return a large YES balance (10000 tokens = 10000e6 raw) so no deficit
    vi.mocked(getTokenBalances).mockResolvedValue([
      { tokenId: "tok_yes_1", balance: ethers.utils.parseUnits("10000", 6) },
    ]);

    const market = makeMarket();
    db.startSession(100, 5);

    const placed = await placeOrdersForMarkets(
      client as any,
      db,
      [market],
      100,
      5,
      undefined,
      undefined,
      undefined,
      mintOpts,
    );

    // Both BID and ASK should be placed
    expect(placed.filter((o) => o.side === "BUY").length).toBe(1);
    expect(placed.filter((o) => o.side === "SELL").length).toBe(1);

    // splitPosition should NOT be called (existing tokens cover the ASK)
    expect(vi.mocked(splitPosition)).not.toHaveBeenCalled();
  });
});
