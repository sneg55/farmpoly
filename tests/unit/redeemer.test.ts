import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Shared mock state ---
const mockRedeemPositions = vi.fn();
const mockWait = vi.fn().mockResolvedValue({});

vi.mock("ethers", () => {
  const BigNumber = {
    from: (val: string | number) => {
      const n = BigInt(val);
      return {
        _isBigNumber: true,
        isZero: () => n === 0n,
        toString: () => n.toString(),
        _hex: "0x" + n.toString(16),
        toHexString: () => "0x" + n.toString(16),
        eq: (other: any) => n === BigInt(other.toString()),
      };
    },
  };

  class MockJsonRpcProvider {
    constructor() {}
  }

  class MockContract {
    redeemPositions: any;
    constructor() {
      this.redeemPositions = (...args: any[]) => {
        mockRedeemPositions(...args);
        return Promise.resolve({ hash: "0xmocktxhash", wait: mockWait });
      };
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
      constants: { HashZero: "0x" + "0".repeat(64) },
      providers: { JsonRpcProvider: MockJsonRpcProvider },
    },
  };
});

// Import after mock setup
const { ethers } = await import("ethers");
const BN = (ethers as any).BigNumber.from;

const { redeemPosition, redeemAll } = await import("../../src/positions/redeemer.js");

const mockWallet = { address: "0xTestWallet", connect() { return this; } } as any;
const env = { polygonRpcUrl: "https://polygon-rpc.com" } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("redeemPosition", () => {
  it("calls CTF redeemPositions for standard market", async () => {
    const result = await redeemPosition(
      mockWallet,
      env,
      "0xcondition123",
      false,
      BN("1000"),
      BN("500"),
    );

    expect(result.txHash).toBe("0xmocktxhash");
    expect(result.negRisk).toBe(false);
    expect(result.conditionId).toBe("0xcondition123");

    // Verify called with: collateralToken, parentCollectionId, conditionId, indexSets
    expect(mockRedeemPositions).toHaveBeenCalledWith(
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
      "0x" + "0".repeat(64), // HashZero
      "0xcondition123",
      [1, 2],
    );
    expect(mockWait).toHaveBeenCalled();
  });

  it("calls NegRiskAdapter redeemPositions for negRisk market", async () => {
    const result = await redeemPosition(
      mockWallet,
      env,
      "0xnegriskcondition",
      true,
      BN("2000"),
      BN("0"),
    );

    expect(result.txHash).toBe("0xmocktxhash");
    expect(result.negRisk).toBe(true);

    // Verify called with: conditionId, amounts array
    expect(mockRedeemPositions).toHaveBeenCalledTimes(1);
    const callArgs = mockRedeemPositions.mock.calls[0];
    expect(callArgs[0]).toBe("0xnegriskcondition");
    expect(callArgs[1]).toHaveLength(2);
  });
});

describe("redeemAll", () => {
  it("redeems all positions with non-zero balance", async () => {
    const positions = [
      { conditionId: "cond1", negRisk: false, balanceYes: BN("100"), balanceNo: BN("0") },
      { conditionId: "cond2", negRisk: true, balanceYes: BN("200"), balanceNo: BN("50") },
    ];

    const result = await redeemAll(mockWallet, env, positions);
    expect(result.redeemed).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it("skips zero-balance positions", async () => {
    const positions = [
      { conditionId: "cond1", negRisk: false, balanceYes: BN("0"), balanceNo: BN("0") },
      { conditionId: "cond2", negRisk: false, balanceYes: BN("100"), balanceNo: BN("0") },
    ];

    const result = await redeemAll(mockWallet, env, positions);
    expect(result.redeemed).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it("handles failures via Promise.allSettled", async () => {
    let callCount = 0;
    mockRedeemPositions.mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        throw new Error("execution reverted");
      }
    });

    const positions = [
      { conditionId: "cond1", negRisk: false, balanceYes: BN("100"), balanceNo: BN("0") },
      { conditionId: "cond2", negRisk: false, balanceYes: BN("200"), balanceNo: BN("0") },
    ];

    const result = await redeemAll(mockWallet, env, positions);
    expect(result.redeemed).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].conditionId).toBe("cond2");
    expect(result.failed[0].error).toContain("execution reverted");
  });

  it("returns empty results for empty input", async () => {
    const result = await redeemAll(mockWallet, env, []);
    expect(result.redeemed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });
});
