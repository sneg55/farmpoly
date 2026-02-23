import { describe, it, expect } from "vitest";
import {
  calculateSafePrices,
  sharesToBuy,
  isInDangerZone,
  allocateBudget,
} from "../../src/orders/calculator.js";

describe("calculateSafePrices", () => {
  it("places bid below and ask above midpoint", () => {
    const result = calculateSafePrices(0.5, 5, "0.01", "tok_yes", "tok_no");
    expect(result).not.toBeNull();
    expect(result!.bidPrice).toBe(0.45);
    expect(result!.askPrice).toBe(0.55);
  });

  it("respects tick size rounding", () => {
    const result = calculateSafePrices(0.537, 3, "0.01", "tok_yes", "tok_no");
    expect(result).not.toBeNull();
    // bid: 0.537 - 0.03 = 0.507, floor to 0.50
    expect(result!.bidPrice).toBe(0.50);
    // ask: 0.537 + 0.03 = 0.567, ceil to 0.57
    expect(result!.askPrice).toBe(0.57);
  });

  it("clamps to safety bounds", () => {
    const result = calculateSafePrices(0.08, 5, "0.01", "tok_yes", "tok_no");
    // bid would be 0.03, clamped to 0.10
    // ask would be 0.13
    expect(result).not.toBeNull();
    expect(result!.bidPrice).toBe(0.10);
    expect(result!.askPrice).toBe(0.13);
  });

  it("returns null when bid >= ask after clamping", () => {
    // Midpoint 0.10 with spread 1c: bid=0.09→0.10, ask=0.11
    // This should work
    const result = calculateSafePrices(0.10, 1, "0.01", "tok_yes", "tok_no");
    expect(result).not.toBeNull();
  });

  it("returns null when spread too wide for bounds", () => {
    // Midpoint 0.5 with spread 45c: bid=0.05→0.10, ask=0.95→0.90
    // bid (0.10) < ask (0.90) so this should work
    const result = calculateSafePrices(0.5, 45, "0.01", "tok_yes", "tok_no");
    expect(result).not.toBeNull();
    expect(result!.bidPrice).toBe(0.10);
    expect(result!.askPrice).toBe(0.90);
  });

  it("works with 0.1 tick size", () => {
    const result = calculateSafePrices(0.5, 10, "0.1", "tok_yes", "tok_no");
    expect(result).not.toBeNull();
    expect(result!.bidPrice).toBe(0.4);
    expect(result!.askPrice).toBe(0.6);
  });

  it("works with 0.001 tick size", () => {
    const result = calculateSafePrices(0.500, 5, "0.001", "tok_yes", "tok_no");
    expect(result).not.toBeNull();
    expect(result!.bidPrice).toBe(0.450);
    expect(result!.askPrice).toBe(0.550);
  });

  it("throws on invalid tick size", () => {
    expect(() => calculateSafePrices(0.5, 5, "0.05", "tok_yes", "tok_no")).toThrow(
      "Invalid tick size",
    );
  });
});

describe("sharesToBuy", () => {
  it("calculates shares correctly", () => {
    // $10 at $0.50/share = 20 shares
    expect(sharesToBuy(10, 0.5)).toBe(20);
  });

  it("floors to 2 decimal places", () => {
    // $10 at $0.33/share = 30.303030... → 30.30
    expect(sharesToBuy(10, 0.33)).toBe(30.30);
  });

  it("returns 0 for invalid prices", () => {
    expect(sharesToBuy(10, 0)).toBe(0);
    expect(sharesToBuy(10, 1)).toBe(0);
    expect(sharesToBuy(10, -0.5)).toBe(0);
  });
});

describe("isInDangerZone", () => {
  it("detects orders within danger zone", () => {
    expect(isInDangerZone(0.49, 0.50, 2)).toBe(true);
    expect(isInDangerZone(0.51, 0.50, 2)).toBe(true);
  });

  it("allows orders outside danger zone", () => {
    expect(isInDangerZone(0.45, 0.50, 2)).toBe(false);
    expect(isInDangerZone(0.55, 0.50, 2)).toBe(false);
  });

  it("exact boundary is in danger zone (inclusive)", () => {
    expect(isInDangerZone(0.48, 0.50, 2)).toBe(true);
  });
});

describe("allocateBudget", () => {
  it("splits budget equally", () => {
    const result = allocateBudget(100, 5);
    expect(result.perMarketUsdc).toBe(20);
    expect(result.perSideUsdc).toBe(10);
  });

  it("floors to 2 decimals", () => {
    const result = allocateBudget(100, 3);
    expect(result.perMarketUsdc).toBe(33.33);
    expect(result.perSideUsdc).toBe(16.66);
  });

  it("handles zero markets", () => {
    const result = allocateBudget(100, 0);
    expect(result.perMarketUsdc).toBe(0);
    expect(result.perSideUsdc).toBe(0);
  });
});
