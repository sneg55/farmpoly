import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { PolyfarmDb } from "../../src/db/database.js";
import { placeOrdersForMarkets } from "../../src/orders/placer.js";
import type { RewardMarket } from "../../src/discovery/rewards.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

    // Use allocations to limit per-market spend below the 2% safety margin.
    // Allocation=$90, budget=$200 → effectiveBudget=$196 >> $90 total cost.
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
});
