import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Shared mock state ---
const mockBalanceOfBatch = vi.fn();

vi.mock("ethers", () => {
  const BigNumber = {
    from: (val: string | number) => {
      const n = BigInt(val);
      return {
        _isBigNumber: true,
        isZero: () => n === 0n,
        toString: () => n.toString(),
      };
    },
  };

  class MockJsonRpcProvider {
    constructor() {}
  }

  class MockContract {
    balanceOfBatch: any;
    constructor() {
      this.balanceOfBatch = mockBalanceOfBatch;
    }
  }

  class MockWallet {
    address = "0xTestWallet";
    connect() { return this; }
  }

  return {
    Contract: MockContract,
    Wallet: MockWallet,
    ethers: {
      BigNumber,
      providers: { JsonRpcProvider: MockJsonRpcProvider },
    },
  };
});

// Import after mock
const { ethers } = await import("ethers");
const BN = (ethers as any).BigNumber.from;

const { getOpenPositions, getTokenBalances, getPositionSummary } = await import(
  "../../src/positions/fetcher.js"
);

// --- Mock ClobClient ---
function mockClobClient(orders: any[], nextCursor?: string) {
  let callCount = 0;
  return {
    getOpenOrders: vi.fn(async () => {
      callCount++;
      if (callCount === 1 && nextCursor) {
        return { data: orders.slice(0, 1), next_cursor: nextCursor };
      }
      if (callCount === 2 && nextCursor) {
        return { data: orders.slice(1), next_cursor: "LTE=" };
      }
      return orders;
    }),
  } as any;
}

const mockWallet = { address: "0xTestWallet", connect() { return this; } } as any;
const env = { polygonRpcUrl: "https://polygon-rpc.com" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: token IDs containing "yes" get balance 100, others get 0
  mockBalanceOfBatch.mockImplementation(async (_addrs: string[], ids: string[]) =>
    ids.map((id: string) => (id.includes("yes") ? BN("100") : BN("0"))),
  );
});

describe("getOpenPositions", () => {
  it("returns all orders from a flat array response", async () => {
    const client = mockClobClient([
      { id: "order1", market: "cond1", asset_id: "token_yes", side: "BUY", price: "0.45", original_size: "10", size_matched: "0" },
      { id: "order2", market: "cond1", asset_id: "token_yes", side: "SELL", price: "0.55", original_size: "10", size_matched: "0" },
    ]);

    const orders = await getOpenPositions(client);
    expect(orders).toHaveLength(2);
    expect(orders[0].id).toBe("order1");
    expect(orders[0].side).toBe("BUY");
    expect(orders[1].id).toBe("order2");
    expect(orders[1].side).toBe("SELL");
  });

  it("paginates via next_cursor", async () => {
    const client = mockClobClient(
      [
        { id: "order1", market: "cond1", asset_id: "t1", side: "BUY", price: "0.4", original_size: "5", size_matched: "0" },
        { id: "order2", market: "cond2", asset_id: "t2", side: "SELL", price: "0.6", original_size: "5", size_matched: "0" },
      ],
      "cursor123",
    );

    const orders = await getOpenPositions(client);
    expect(orders).toHaveLength(2);
    expect(client.getOpenOrders).toHaveBeenCalledTimes(2);
  });

  it("groups orders by market correctly", async () => {
    const client = mockClobClient([
      { id: "o1", market: "cond1", asset_id: "t1", side: "BUY", price: "0.4", original_size: "5", size_matched: "0" },
      { id: "o2", market: "cond2", asset_id: "t2", side: "BUY", price: "0.3", original_size: "5", size_matched: "0" },
      { id: "o3", market: "cond1", asset_id: "t1", side: "SELL", price: "0.6", original_size: "5", size_matched: "0" },
    ]);

    const orders = await getOpenPositions(client);
    const byCond1 = orders.filter((o: any) => o.market === "cond1");
    const byCond2 = orders.filter((o: any) => o.market === "cond2");
    expect(byCond1).toHaveLength(2);
    expect(byCond2).toHaveLength(1);
  });
});

describe("getTokenBalances", () => {
  it("returns balances for all token IDs", async () => {
    const balances = await getTokenBalances(mockWallet, env, ["token_yes", "token_no"]);
    expect(balances).toHaveLength(2);
    expect(balances[0].tokenId).toBe("token_yes");
    expect(balances[0].balance.toString()).toBe("100");
    expect(balances[1].tokenId).toBe("token_no");
    expect(balances[1].balance.toString()).toBe("0");
  });

  it("returns empty array for no token IDs", async () => {
    const balances = await getTokenBalances(mockWallet, env, []);
    expect(balances).toHaveLength(0);
  });
});

describe("getPositionSummary", () => {
  it("merges balances and orders for known markets", async () => {
    const client = mockClobClient([
      { id: "o1", market: "cond1", asset_id: "token_yes", side: "BUY", price: "0.45", original_size: "10", size_matched: "0" },
    ]);

    const db = {
      getMarkets: () => [
        {
          condition_id: "cond1",
          question: "Will X happen?",
          token_id_yes: "token_yes",
          token_id_no: "token_no",
          tick_size: "0.01",
          neg_risk: 0,
        },
      ],
    } as any;

    const summaries = await getPositionSummary(client, mockWallet, env, db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].conditionId).toBe("cond1");
    expect(summaries[0].balanceYes.toString()).toBe("100");
    expect(summaries[0].balanceNo.toString()).toBe("0");
    expect(summaries[0].openOrders).toHaveLength(1);
  });

  it("excludes markets with no balances and no orders", async () => {
    const client = mockClobClient([]);

    // Return zero for all balances
    mockBalanceOfBatch.mockImplementation(async (_addrs: string[], ids: string[]) =>
      ids.map(() => BN("0")),
    );

    const db = {
      getMarkets: () => [
        {
          condition_id: "cond_empty",
          question: "Empty market?",
          token_id_yes: "empty_yes",
          token_id_no: "empty_no",
          tick_size: "0.01",
          neg_risk: 0,
        },
      ],
    } as any;

    const summaries = await getPositionSummary(client, mockWallet, env, db);
    expect(summaries).toHaveLength(0);
  });

  it("returns empty for no markets in DB", async () => {
    const client = mockClobClient([]);
    const db = { getMarkets: () => [] } as any;

    const summaries = await getPositionSummary(client, mockWallet, env, db);
    expect(summaries).toHaveLength(0);
  });
});
