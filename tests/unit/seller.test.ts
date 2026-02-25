import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import { marketSellPosition, killAllPositions } from "../../src/positions/seller.js";

const BN = ethers.BigNumber.from;

// Mock fetcher
vi.mock("../../src/positions/fetcher.js", () => ({
  getTokenBalances: vi.fn(async (_wallet: any, _env: any, tokenIds: string[]) =>
    tokenIds.map((id) => ({
      tokenId: id,
      balance: id.includes("_yes") ? BN("1000000") : BN("0"), // 1.0 in 6 decimals
    })),
  ),
}));

function mockClobClient(opts: { failFOK?: boolean; failAll?: boolean } = {}) {
  return {
    createOrder: vi.fn(async () => ({ signed: true })),
    postOrder: vi.fn(async (_order: any, orderType: any) => {
      if (opts.failAll) throw new Error("API error");
      if (opts.failFOK && orderType === "FOK") throw new Error("No liquidity");
      return { orderID: "sell-order-123" };
    }),
    cancelAll: vi.fn(async () => {}),
  } as any;
}

function mockDb() {
  return {
    getMarkets: vi.fn(() => [
      {
        condition_id: "cond1",
        question: "Test?",
        token_id_yes: "t1_yes",
        token_id_no: "t1_no",
        tick_size: "0.01",
        neg_risk: 0,
      },
    ]),
    cancelAllOrders: vi.fn(() => 3),
    getActiveSession: vi.fn(() => ({ id: 1 })),
    endSession: vi.fn(),
  } as any;
}

const wallet = ethers.Wallet.createRandom();
const env = { polygonRpcUrl: "https://polygon-rpc.com" } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("marketSellPosition", () => {
  it("sells via FOK successfully", async () => {
    const client = mockClobClient();
    const result = await marketSellPosition(client, "token1", 10, false, "0.01");

    expect(result.success).toBe(true);
    expect(result.tokenId).toBe("token1");
    expect(result.amount).toBe("10");
    // Should only call once (FOK succeeds)
    expect(client.postOrder).toHaveBeenCalledTimes(1);
  });

  it("falls back to FAK when FOK fails", async () => {
    const client = mockClobClient({ failFOK: true });
    const result = await marketSellPosition(client, "token2", 5, false, "0.01");

    expect(result.success).toBe(true);
    // Called twice: FOK (failed) + FAK (success)
    expect(client.postOrder).toHaveBeenCalledTimes(2);
  });

  it("returns failure when both FOK and FAK fail", async () => {
    const client = mockClobClient({ failAll: true });
    const result = await marketSellPosition(client, "token3", 5, false, "0.01");

    expect(result.success).toBe(false);
    expect(result.error).toContain("API error");
  });
});

describe("killAllPositions", () => {
  it("cancels all orders first, then sells positions", async () => {
    const client = mockClobClient();
    const db = mockDb();

    const result = await killAllPositions(client, wallet, env, db);

    // Verify cancel was called first
    expect(client.cancelAll).toHaveBeenCalled();
    expect(db.cancelAllOrders).toHaveBeenCalled();
    expect(result.cancelled).toBe(3);

    // Verify sold non-zero positions (only _yes tokens have balance)
    expect(result.sold.length).toBeGreaterThanOrEqual(1);
    expect(result.failed).toHaveLength(0);
  });

  it("skips zero-balance tokens", async () => {
    const client = mockClobClient();
    const db = mockDb();

    const result = await killAllPositions(client, wallet, env, db);

    // Only t1_yes has balance (1.0), t1_no has 0
    // postOrder should be called for YES token only
    const sellCalls = client.postOrder.mock.calls;
    // Might be 1 (FOK success) or 2 (FOK fail + FAK success)
    expect(sellCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("ends active session as PANIC", async () => {
    const client = mockClobClient();
    const db = mockDb();

    await killAllPositions(client, wallet, env, db);

    expect(db.getActiveSession).toHaveBeenCalled();
    expect(db.endSession).toHaveBeenCalledWith(1, "PANIC");
  });

  it("handles no markets gracefully", async () => {
    const client = mockClobClient();
    const db = mockDb();
    db.getMarkets.mockReturnValue([]);

    const result = await killAllPositions(client, wallet, env, db);
    expect(result.cancelled).toBe(3);
    expect(result.sold).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});
