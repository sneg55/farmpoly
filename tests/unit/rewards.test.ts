import { describe, it, expect } from "vitest";
import { computeMidpoint, isWithinSafetyBounds } from "../../src/discovery/rewards.js";

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
