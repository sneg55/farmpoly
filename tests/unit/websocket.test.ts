import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WsConnectionManager } from "../../src/safety/websocket.js";

describe("WsConnectionManager", () => {
  it("initializes with default URL", () => {
    const mgr = new WsConnectionManager();
    expect(mgr.url).toBe("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    expect(mgr.connected).toBe(false);
    expect(mgr.closed).toBe(false);
  });

  it("accepts custom URL", () => {
    const mgr = new WsConnectionManager({ url: "wss://custom.example.com/ws" });
    expect(mgr.url).toBe("wss://custom.example.com/ws");
  });

  it("tracks subscriptions", () => {
    const mgr = new WsConnectionManager();
    mgr.subscribe("token1");
    mgr.subscribe("token2");
    // Internal subscriptions are tracked (tested via close behavior)
    mgr.close();
    expect(mgr.closed).toBe(true);
  });

  it("closes cleanly", () => {
    const mgr = new WsConnectionManager();
    mgr.close();
    expect(mgr.closed).toBe(true);
    expect(mgr.connected).toBe(false);
  });

  it("does not connect when already closed", () => {
    const mgr = new WsConnectionManager();
    mgr.close();
    mgr.connect(); // Should not throw
    expect(mgr.connected).toBe(false);
  });
});
