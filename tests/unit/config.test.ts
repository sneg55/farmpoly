import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We test the validation logic by manipulating process.env
describe("config / loadEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects missing POLYGON_PRIVATE_KEY", async () => {
    delete process.env.POLYGON_PRIVATE_KEY;
    const { loadEnv } = await import("../../src/utils/config.js");
    // dotenv.config() may re-populate from .env during import, so delete after
    delete process.env.POLYGON_PRIVATE_KEY;
    expect(() => loadEnv()).toThrow("POLYGON_PRIVATE_KEY is required");
  });

  it("rejects invalid hex key", async () => {
    process.env.POLYGON_PRIVATE_KEY = "not-a-hex-key";
    const { loadEnv } = await import("../../src/utils/config.js");
    expect(() => loadEnv()).toThrow("64-character hex string");
  });

  it("rejects key with wrong length", async () => {
    process.env.POLYGON_PRIVATE_KEY = "abcdef1234";
    const { loadEnv } = await import("../../src/utils/config.js");
    expect(() => loadEnv()).toThrow("64-character hex string");
  });

  it("accepts valid 64-char hex key", async () => {
    process.env.POLYGON_PRIVATE_KEY = "a".repeat(64);
    const { loadEnv } = await import("../../src/utils/config.js");
    const env = loadEnv();
    expect(env.polygonPrivateKey).toBe("a".repeat(64));
  });

  it("strips 0x prefix from key", async () => {
    process.env.POLYGON_PRIVATE_KEY = "0x" + "b".repeat(64);
    const { loadEnv } = await import("../../src/utils/config.js");
    const env = loadEnv();
    expect(env.polygonPrivateKey).toBe("b".repeat(64));
  });

  it("provides default URLs when not set", async () => {
    process.env.POLYGON_PRIVATE_KEY = "c".repeat(64);
    const { loadEnv } = await import("../../src/utils/config.js");
    // dotenv.config() may re-populate from .env during import, so delete after
    delete process.env.POLYGON_RPC_URL;
    delete process.env.CLOB_API_URL;
    delete process.env.GAMMA_API_URL;
    const env = loadEnv();
    expect(env.polygonRpcUrl).toBe("https://polygon-rpc.com");
    expect(env.clobApiUrl).toBe("https://clob.polymarket.com");
    expect(env.gammaApiUrl).toBe("https://gamma-api.polymarket.com");
  });

  it("uses custom URLs when set", async () => {
    process.env.POLYGON_PRIVATE_KEY = "d".repeat(64);
    process.env.POLYGON_RPC_URL = "https://custom-rpc.example.com";
    process.env.CLOB_API_URL = "https://custom-clob.example.com";
    const { loadEnv } = await import("../../src/utils/config.js");
    const env = loadEnv();
    expect(env.polygonRpcUrl).toBe("https://custom-rpc.example.com");
    expect(env.clobApiUrl).toBe("https://custom-clob.example.com");
  });
});
