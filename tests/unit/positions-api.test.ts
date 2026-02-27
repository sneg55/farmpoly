import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock axios
const mockAxiosGet = vi.fn();
vi.mock("axios", () => ({
  default: { get: (...args: any[]) => mockAxiosGet(...args) },
}));

const { fetchWalletPositions } = await import("../../src/api/positions-api.js");

beforeEach(() => {
  vi.clearAllMocks();
});

function makePosition(overrides: Partial<any> = {}): any {
  return {
    asset: "token_abc",
    conditionId: "cond_123",
    size: 50,
    avgPrice: 0.45,
    initialValue: 22.5,
    currentValue: 25,
    cashPnl: 2.5,
    percentPnl: 11.1,
    curPrice: 0.5,
    redeemable: false,
    title: "Will it rain?",
    slug: "will-it-rain",
    outcome: "Yes",
    outcomeIndex: 0,
    oppositeOutcome: "No",
    oppositeAsset: "token_xyz",
    negativeRisk: false,
    endDate: "2026-03-01",
    proxyWallet: "0xABC",
    ...overrides,
  };
}

describe("fetchWalletPositions", () => {
  it("returns positions for a wallet address", async () => {
    const positions = [makePosition(), makePosition({ asset: "token_def", outcome: "No" })];
    mockAxiosGet.mockResolvedValueOnce({ data: positions });

    const result = await fetchWalletPositions("0xABC", {}, "https://mock-api");

    expect(result).toHaveLength(2);
    expect(result[0].asset).toBe("token_abc");
    expect(result[1].outcome).toBe("No");
    expect(mockAxiosGet).toHaveBeenCalledWith("https://mock-api/positions", {
      params: expect.objectContaining({ user: "0xABC", limit: 500, offset: 0 }),
      timeout: 15_000,
    });
  });

  it("auto-paginates until page is empty", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) =>
      makePosition({ asset: `token_${i}` }),
    );
    const page2 = [makePosition({ asset: "token_last" })];

    mockAxiosGet
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });

    const result = await fetchWalletPositions("0xABC", {}, "https://mock-api");

    expect(result).toHaveLength(501);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    // Second call should have offset=500
    expect(mockAxiosGet.mock.calls[1][1].params.offset).toBe(500);
  });

  it("stops pagination when page is smaller than limit", async () => {
    const page = [makePosition()];
    mockAxiosGet.mockResolvedValueOnce({ data: page });

    const result = await fetchWalletPositions("0xABC", {}, "https://mock-api");

    expect(result).toHaveLength(1);
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it("returns empty array when no positions", async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: [] });

    const result = await fetchWalletPositions("0xABC", {}, "https://mock-api");

    expect(result).toHaveLength(0);
  });

  it("passes optional filters as query params", async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: [] });

    await fetchWalletPositions(
      "0xABC",
      { sizeThreshold: 0, redeemable: true, market: "cond_1" },
      "https://mock-api",
    );

    expect(mockAxiosGet.mock.calls[0][1].params).toMatchObject({
      sizeThreshold: 0,
      redeemable: true,
      market: "cond_1",
    });
  });

  it("retries on 5xx errors", async () => {
    const error = { response: { status: 500 }, message: "Server error" };
    mockAxiosGet
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ data: [makePosition()] });

    const result = await fetchWalletPositions("0xABC", {}, "https://mock-api");

    expect(result).toHaveLength(1);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 rate limit", async () => {
    const error = { response: { status: 429 }, message: "Rate limited" };
    mockAxiosGet
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ data: [makePosition()] });

    const result = await fetchWalletPositions("0xABC", {}, "https://mock-api");

    expect(result).toHaveLength(1);
  });

  it("throws on 4xx errors (not 429)", async () => {
    const error = { response: { status: 400 }, message: "Bad request" };
    mockAxiosGet.mockRejectedValueOnce(error);

    await expect(fetchWalletPositions("0xABC", {}, "https://mock-api")).rejects.toThrow();
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it("throws after max retries exhausted", async () => {
    const error = { response: { status: 500 }, message: "Server error" };
    mockAxiosGet
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error);

    await expect(fetchWalletPositions("0xABC", {}, "https://mock-api")).rejects.toThrow();
    expect(mockAxiosGet).toHaveBeenCalledTimes(3);
  });

  it("uses default base URL when none provided", async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: [] });

    await fetchWalletPositions("0xABC");

    expect(mockAxiosGet.mock.calls[0][0]).toBe(
      "https://data-api.polymarket.com/positions",
    );
  });
});
