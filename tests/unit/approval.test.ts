import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for approval flows:
 * 1. USDC ERC20 approvals (checkApproval, approveUSDC) — existing
 * 2. ConditionalTokens ERC1155 approvals (checkConditionalTokenApproval, approveConditionalTokens) — new for 9.1
 *
 * All contract calls are mocked via vi.mock on ethers.
 */

// --- Shared mock state ---

// Mock fn registry keyed by contract address — survives across new Contract() calls
const mockFnRegistry = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();

function getOrCreateMockFns(address: string): Record<string, ReturnType<typeof vi.fn>> {
  const existing = mockFnRegistry.get(address);
  if (existing) return existing;

  const fns: Record<string, ReturnType<typeof vi.fn>> = {
    balanceOf: vi.fn().mockResolvedValue({ isZero: () => false, toString: () => "1000000" }),
    allowance: vi.fn().mockResolvedValue({ isZero: () => false }),
    approve: vi.fn().mockResolvedValue({ hash: "0xapprove_tx", wait: vi.fn().mockResolvedValue({}) }),
    isApprovedForAll: vi.fn().mockResolvedValue(true),
    setApprovalForAll: vi.fn().mockResolvedValue({ hash: "0xapproval_tx", wait: vi.fn().mockResolvedValue({}) }),
  };
  mockFnRegistry.set(address, fns);
  return fns;
}

vi.mock("ethers", () => {
  const MaxUint256 = { type: "BigNumber", hex: "0xff" };

  class MockJsonRpcProvider {
    constructor() {}
  }

  class MockContract {
    [key: string]: unknown;
    constructor(address: string) {
      const fns = getOrCreateMockFns(address);
      Object.assign(this, fns);
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
      constants: { MaxUint256 },
      providers: {
        JsonRpcProvider: MockJsonRpcProvider,
      },
    },
  };
});

const mockEnv = {
  polygonPrivateKey: "a".repeat(64),
  polygonRpcUrl: "https://polygon-rpc.com",
  clobApiUrl: "https://clob.polymarket.com",
  gammaApiUrl: "https://gamma-api.polymarket.com",
};

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

describe("USDC ERC20 approvals", () => {
  let mockWallet: { address: string; connect: () => unknown };

  beforeEach(() => {
    // Clear mock fn registry so each test starts fresh
    mockFnRegistry.clear();
    mockWallet = {
      address: "0xTestWallet",
      connect() { return this; },
    };
  });

  it("checkApproval returns correct status when fully approved", async () => {
    const { checkApproval } = await import("../../src/auth/approval.js");
    const status = await checkApproval(mockWallet as any, mockEnv);

    expect(status.needsApproval).toBe(false);
    expect(status.needsNegRiskApproval).toBe(false);
  });

  it("checkApproval detects when CTF exchange needs approval", async () => {
    // Pre-populate the USDC mock fns with custom behavior BEFORE calling checkApproval
    const fns = getOrCreateMockFns(USDC_ADDRESS);
    fns.allowance
      .mockResolvedValueOnce({ isZero: () => true })  // CTF exchange → needs approval
      .mockResolvedValueOnce({ isZero: () => false }); // NegRisk → OK

    const { checkApproval } = await import("../../src/auth/approval.js");
    const status = await checkApproval(mockWallet as any, mockEnv);

    expect(status.needsApproval).toBe(true);
    expect(status.needsNegRiskApproval).toBe(false);
  });

  it("checkApproval detects when NegRisk exchange needs approval", async () => {
    const fns = getOrCreateMockFns(USDC_ADDRESS);
    fns.allowance
      .mockResolvedValueOnce({ isZero: () => false }) // CTF → OK
      .mockResolvedValueOnce({ isZero: () => true }); // NegRisk → needs approval

    const { checkApproval } = await import("../../src/auth/approval.js");
    const status = await checkApproval(mockWallet as any, mockEnv);

    expect(status.needsApproval).toBe(false);
    expect(status.needsNegRiskApproval).toBe(true);
  });

  it("approveUSDC sends transactions only for unapproved exchanges", async () => {
    // checkApproval (inside approveUSDC) calls allowance twice
    const fns = getOrCreateMockFns(USDC_ADDRESS);
    fns.allowance
      .mockResolvedValueOnce({ isZero: () => false }) // CTF → already approved
      .mockResolvedValueOnce({ isZero: () => true }); // NegRisk → needs approval

    const { approveUSDC } = await import("../../src/auth/approval.js");
    const result = await approveUSDC(mockWallet as any, mockEnv);

    expect(result.ctfTxHash).toBeUndefined();
    expect(result.negRiskTxHash).toBe("0xapprove_tx");
  });
});

describe("ConditionalTokens ERC1155 approvals", () => {
  let mockWallet: { address: string; connect: () => unknown };

  beforeEach(() => {
    mockFnRegistry.clear();
    mockWallet = {
      address: "0xTestWallet",
      connect() { return this; },
    };
  });

  it("checkConditionalTokenApproval returns all-approved when all 3 spenders approved", async () => {
    const { checkConditionalTokenApproval } = await import("../../src/auth/approval.js");
    const status = await checkConditionalTokenApproval(mockWallet as any, mockEnv);

    expect(status.needsCtfExchangeApproval).toBe(false);
    expect(status.needsNegRiskExchangeApproval).toBe(false);
    expect(status.needsNegRiskAdapterApproval).toBe(false);
    expect(status.needsAnyApproval).toBe(false);
  });

  it("checkConditionalTokenApproval detects missing CTF Exchange approval", async () => {
    const fns = getOrCreateMockFns(CONDITIONAL_TOKENS);
    fns.isApprovedForAll
      .mockResolvedValueOnce(false)  // CTF Exchange → not approved
      .mockResolvedValueOnce(true)   // NegRisk Exchange → approved
      .mockResolvedValueOnce(true);  // NegRisk Adapter → approved

    const { checkConditionalTokenApproval } = await import("../../src/auth/approval.js");
    const status = await checkConditionalTokenApproval(mockWallet as any, mockEnv);

    expect(status.needsCtfExchangeApproval).toBe(true);
    expect(status.needsNegRiskExchangeApproval).toBe(false);
    expect(status.needsNegRiskAdapterApproval).toBe(false);
    expect(status.needsAnyApproval).toBe(true);
  });

  it("checkConditionalTokenApproval detects missing NegRisk adapter approval", async () => {
    const fns = getOrCreateMockFns(CONDITIONAL_TOKENS);
    fns.isApprovedForAll
      .mockResolvedValueOnce(true)   // CTF Exchange → approved
      .mockResolvedValueOnce(true)   // NegRisk Exchange → approved
      .mockResolvedValueOnce(false); // NegRisk Adapter → NOT approved

    const { checkConditionalTokenApproval } = await import("../../src/auth/approval.js");
    const status = await checkConditionalTokenApproval(mockWallet as any, mockEnv);

    expect(status.needsCtfExchangeApproval).toBe(false);
    expect(status.needsNegRiskExchangeApproval).toBe(false);
    expect(status.needsNegRiskAdapterApproval).toBe(true);
    expect(status.needsAnyApproval).toBe(true);
  });

  it("checkConditionalTokenApproval detects all 3 missing", async () => {
    const fns = getOrCreateMockFns(CONDITIONAL_TOKENS);
    fns.isApprovedForAll
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    const { checkConditionalTokenApproval } = await import("../../src/auth/approval.js");
    const status = await checkConditionalTokenApproval(mockWallet as any, mockEnv);

    expect(status.needsCtfExchangeApproval).toBe(true);
    expect(status.needsNegRiskExchangeApproval).toBe(true);
    expect(status.needsNegRiskAdapterApproval).toBe(true);
    expect(status.needsAnyApproval).toBe(true);
  });

  it("approveConditionalTokens sends setApprovalForAll only for unapproved spenders", async () => {
    // checkConditionalTokenApproval (inside approveConditionalTokens) calls isApprovedForAll 3x
    const fns = getOrCreateMockFns(CONDITIONAL_TOKENS);
    fns.isApprovedForAll
      .mockResolvedValueOnce(true)   // CTF Exchange → already approved
      .mockResolvedValueOnce(true)   // NegRisk Exchange → already approved
      .mockResolvedValueOnce(false); // NegRisk Adapter → needs approval

    const { approveConditionalTokens } = await import("../../src/auth/approval.js");
    const result = await approveConditionalTokens(mockWallet as any, mockEnv);

    expect(result.ctfExchangeTxHash).toBeUndefined();
    expect(result.negRiskExchangeTxHash).toBeUndefined();
    expect(result.negRiskAdapterTxHash).toBe("0xapproval_tx");
  });

  it("approveConditionalTokens sends all 3 txs when nothing is approved", async () => {
    const fns = getOrCreateMockFns(CONDITIONAL_TOKENS);
    fns.isApprovedForAll
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    const { approveConditionalTokens } = await import("../../src/auth/approval.js");
    const result = await approveConditionalTokens(mockWallet as any, mockEnv);

    expect(result.ctfExchangeTxHash).toBe("0xapproval_tx");
    expect(result.negRiskExchangeTxHash).toBe("0xapproval_tx");
    expect(result.negRiskAdapterTxHash).toBe("0xapproval_tx");
  });

  it("approveConditionalTokens returns empty when all already approved", async () => {
    // Default mock returns true for isApprovedForAll
    const { approveConditionalTokens } = await import("../../src/auth/approval.js");
    const result = await approveConditionalTokens(mockWallet as any, mockEnv);

    expect(result.ctfExchangeTxHash).toBeUndefined();
    expect(result.negRiskExchangeTxHash).toBeUndefined();
    expect(result.negRiskAdapterTxHash).toBeUndefined();
  });
});
