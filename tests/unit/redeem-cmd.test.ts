import { describe, it, expect } from "vitest";
import { redeemCommand } from "../../src/cli/commands/redeem.js";

describe("redeem command", () => {
  it("is a Commander command with correct name", () => {
    expect(redeemCommand.name()).toBe("redeem");
  });

  it("has description", () => {
    expect(redeemCommand.description()).toContain("Redeem");
  });

  it("has --dry-run option", () => {
    const dryRunOpt = redeemCommand.options.find((o) => o.long === "--dry-run");
    expect(dryRunOpt).toBeDefined();
  });

  it("has --market option", () => {
    const marketOpt = redeemCommand.options.find((o) => o.long === "--market");
    expect(marketOpt).toBeDefined();
  });
});
