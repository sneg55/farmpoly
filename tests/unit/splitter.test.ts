import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for splitPosition: standard CTF and negRisk paths.
 * All contract calls are mocked via vi.mock on ethers.
 */

// Track calls per contract address
const contractCalls = new Map<string, { method: string; args: any[] }[]>();

function recordCall(address: string, method: string, args: any[]) {
  const calls = contractCalls.get(address) ?? [];
  calls.push({ method, args });
  contractCalls.set(address, calls);
}

const mockTxHash = "0xsplit_tx_hash_1234";
const mockTx = { hash: mockTxHash, wait: vi.fn().mockResolvedValue({}) };

vi.mock("ethers", () => {
  // Simple BigNumber-like mock that supports .gt(), .mul(), .add()
  function mockBN(n: number) {
    return {
      _value: n,
      gt: (other: any) => n > (other?._value ?? 0),
      mul: (m: number) => mockBN(n * m),
      add: (other: any) => mockBN(n + (other?._value ?? 0)),
      toString: () => String(n),
    };
  }

  class MockJsonRpcProvider {
    async getFeeData() {
      return {
        maxPriorityFeePerGas: mockBN(35_000_000_000),
        lastBaseFeePerGas: mockBN(30_000_000_000),
      };
    }
  }

  class MockContract {
    private _address: string;
    [key: string]: unknown;

    constructor(address: string) {
      this._address = address;

      const self = this;
      this.splitPosition = vi.fn().mockImplementation(async (...args: any[]) => {
        recordCall(self._address, "splitPosition", args);
        return mockTx;
      });

      this.estimateGas = {
        splitPosition: vi.fn().mockResolvedValue(mockBN(100000)),
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
      constants: { HashZero: "0x" + "0".repeat(64) },
      providers: { JsonRpcProvider: MockJsonRpcProvider },
      utils: {
        parseUnits: (value: string, _unit: number | string) => {
          // Return a mockBN for gwei/unit values
          const num = parseFloat(value);
          if (isNaN(num)) return mockBN(0);
          if (_unit === "gwei") return mockBN(num * 1e9);
          if (typeof _unit === "number") return mockBN(Math.round(num * Math.pow(10, _unit)));
          return mockBN(num);
        },
      },
    },
  };
});

const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const mockEnv = {
  polygonPrivateKey: "a".repeat(64),
  polygonRpcUrl: "https://polygon-rpc.com",
  clobApiUrl: "https://clob.polymarket.com",
  gammaApiUrl: "https://gamma-api.polymarket.com",
};

const mockWallet = {
  address: "0xTestWallet",
  connect() { return this; },
};

describe("splitPosition", () => {
  beforeEach(() => {
    contractCalls.clear();
  });

  it("calls ConditionalTokens.splitPosition for standard markets", async () => {
    const { splitPosition } = await import("../../src/positions/splitter.js");
    const conditionId = "0x" + "ab".repeat(32);

    const txHash = await splitPosition(
      mockWallet as any,
      mockEnv,
      conditionId,
      false, // not negRisk
      50,    // $50 USDC
    );

    expect(txHash).toBe(mockTxHash);

    // Should have called the CTF contract (CONDITIONAL_TOKENS)
    const ctfCalls = contractCalls.get(CONDITIONAL_TOKENS);
    expect(ctfCalls).toBeDefined();
    expect(ctfCalls!.length).toBe(1);
    expect(ctfCalls![0].method).toBe("splitPosition");

    // Verify args: (USDC, HashZero, conditionId, [1,2], amount, gasOverrides)
    const args = ctfCalls![0].args;
    expect(args[0]).toBe(USDC_ADDRESS);
    expect(args[2]).toBe(conditionId);
    expect(args[3]).toEqual([1, 2]);
  });

  it("calls NegRiskAdapter.splitPosition for negRisk markets", async () => {
    const { splitPosition } = await import("../../src/positions/splitter.js");
    const conditionId = "0x" + "cd".repeat(32);

    const txHash = await splitPosition(
      mockWallet as any,
      mockEnv,
      conditionId,
      true,  // negRisk
      25,    // $25 USDC
    );

    expect(txHash).toBe(mockTxHash);

    // Should have called the NegRiskAdapter
    const adapterCalls = contractCalls.get(NEG_RISK_ADAPTER);
    expect(adapterCalls).toBeDefined();
    expect(adapterCalls!.length).toBe(1);
    expect(adapterCalls![0].method).toBe("splitPosition");

    // Verify args: (conditionId, amount, gasOverrides)
    const args = adapterCalls![0].args;
    expect(args[0]).toBe(conditionId);
  });

  it("returns transaction hash on success", async () => {
    const { splitPosition } = await import("../../src/positions/splitter.js");
    const hash = await splitPosition(mockWallet as any, mockEnv, "0x" + "11".repeat(32), false, 10);
    expect(hash).toBe(mockTxHash);
  });
});
