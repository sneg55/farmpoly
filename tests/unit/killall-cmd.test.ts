import { describe, it, expect } from "vitest";
import { killallCommand } from "../../src/cli/commands/killall.js";

describe("killall command", () => {
  it("is a Commander command with correct name", () => {
    expect(killallCommand.name()).toBe("killall");
  });

  it("has description mentioning market-sell", () => {
    expect(killallCommand.description()).toContain("market-sell");
  });

  it("has --dry-run option", () => {
    const dryRunOpt = killallCommand.options.find((o) => o.long === "--dry-run");
    expect(dryRunOpt).toBeDefined();
  });

  it("has --skip-cancel option", () => {
    const skipOpt = killallCommand.options.find((o) => o.long === "--skip-cancel");
    expect(skipOpt).toBeDefined();
  });
});
