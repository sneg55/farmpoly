import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SafetyMonitor } from "../../src/safety/monitor.js";
import { WsConnectionManager } from "../../src/safety/websocket.js";
import { createDatabase, PolyfarmDb } from "../../src/db/database.js";
import Database from "better-sqlite3";

// Mock CLOB client
function mockClobClient() {
  return {
    cancelOrder: vi.fn().mockResolvedValue({ success: true }),
    cancelAll: vi.fn().mockResolvedValue({ success: true }),
  } as any;
}

function insertTestMarket(db: PolyfarmDb, conditionId: string = "cond1") {
  db.upsertMarket({
    condition_id: conditionId,
    question: "Test?",
    slug: "test",
    token_id_yes: "tok1",
    token_id_no: "tok2",
    tick_size: "0.01",
    neg_risk: 0,
    midpoint: 0.5,
    tvl: 100000,
    reward_rate: 10,
  });
}

describe("SafetyMonitor", () => {
  let rawDb: Database.Database;
  let db: PolyfarmDb;

  beforeEach(() => {
    rawDb = createDatabase(":memory:");
    db = new PolyfarmDb(rawDb);
  });

  afterEach(() => {
    rawDb.close();
  });

  it("detects danger zone and emits events", async () => {
    const clobClient = mockClobClient();
    const wsManager = new WsConnectionManager();
    // Prevent actual WebSocket connection
    vi.spyOn(wsManager, "connect").mockImplementation(() => {});
    const monitor = new SafetyMonitor(clobClient, db, wsManager, {
      dangerZoneCents: 2,
    });

    insertTestMarket(db);
    // Place order at 0.505 — only 0.5c from midpoint 0.51
    // With dangerZoneCents=2, redThreshold = 1c (0.01)
    // Distance 0.005 < 0.01 → RED zone → danger + cancel
    db.insertOrder({
      order_id: "ord1",
      condition_id: "cond1",
      token_id: "tok1",
      side: "BUY",
      price: 0.505,
      size: 100,
      order_type: "GTD",
      status: "LIVE",
      expiry: null,
    });

    const dangerEvents: any[] = [];
    const cancelEvents: any[] = [];

    // Register listeners before start so we don't miss events
    monitor.on("danger", (e) => dangerEvents.push(e));
    monitor.on("cancelled", (e) => cancelEvents.push(e));

    monitor.start();

    // Simulate a book event by emitting directly on the wsManager
    // midpoint = (0.50 + 0.52) / 2 = 0.51
    wsManager.emit("book", {
      event_type: "book",
      asset_id: "tok1",
      market: "market1",
      timestamp: "12345",
      hash: "0x",
      bids: [{ price: "0.50", size: "100" }],
      asks: [{ price: "0.52", size: "100" }],
    });

    // Wait for async cancel to complete
    await new Promise((r) => setTimeout(r, 100));

    // The monitor should detect that ord1 @ 0.505 is within red zone (< 1c) of midpoint 0.51
    expect(dangerEvents.length).toBe(1);
    expect(dangerEvents[0].orderId).toBe("ord1");
    expect(clobClient.cancelOrder).toHaveBeenCalledWith({ orderID: "ord1" });

    monitor.stop();
  });

  it("does not cancel orders outside danger zone", async () => {
    const clobClient = mockClobClient();
    const wsManager = new WsConnectionManager();
    vi.spyOn(wsManager, "connect").mockImplementation(() => {});
    const monitor = new SafetyMonitor(clobClient, db, wsManager, {
      dangerZoneCents: 2,
    });

    monitor.start();

    insertTestMarket(db);
    db.insertOrder({
      order_id: "ord1",
      condition_id: "cond1",
      token_id: "tok1",
      side: "BUY",
      price: 0.40,
      size: 100,
      order_type: "GTD",
      status: "LIVE",
      expiry: null,
    });

    const dangerEvents: any[] = [];
    monitor.on("danger", (e) => dangerEvents.push(e));

    wsManager.emit("book", {
      event_type: "book",
      asset_id: "tok1",
      market: "market1",
      timestamp: "12345",
      hash: "0x",
      bids: [{ price: "0.50", size: "100" }],
      asks: [{ price: "0.52", size: "100" }],
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(dangerEvents.length).toBe(0);
    expect(clobClient.cancelOrder).not.toHaveBeenCalled();

    monitor.stop();
  });

  it("tracks midpoints", () => {
    const clobClient = mockClobClient();
    const wsManager = new WsConnectionManager();
    vi.spyOn(wsManager, "connect").mockImplementation(() => {});
    const monitor = new SafetyMonitor(clobClient, db, wsManager);

    monitor.start();

    wsManager.emit("book", {
      event_type: "book",
      asset_id: "tok1",
      market: "market1",
      timestamp: "12345",
      hash: "0x",
      bids: [{ price: "0.48", size: "100" }],
      asks: [{ price: "0.52", size: "100" }],
    });

    expect(monitor.getMidpoint("tok1")).toBe(0.50);

    monitor.stop();
  });
});
