import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createDatabase, PolyfarmDb } from "../../src/db/database.js";
import Database from "better-sqlite3";

function fetch(url: string, opts?: { method?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts?.method || "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("Dashboard Server", () => {
  let rawDb: Database.Database;
  let db: PolyfarmDb;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    rawDb = createDatabase(":memory:");
    db = new PolyfarmDb(rawDb);
    server = createDashboardServer({ port: 0, db });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rawDb.close();
  });

  it("serves HTML on GET /", async () => {
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("PolyFarm");
    expect(res.body).toContain("<!DOCTYPE html>");
  });

  it("returns JSON status on GET /api/status", async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("session");
    expect(data).toHaveProperty("liveOrders");
    expect(data).toHaveProperty("markets");
    expect(data).toHaveProperty("recentOrders");
  });

  it("returns empty session when none active", async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    const data = JSON.parse(res.body);
    expect(data.session).toBeNull();
    expect(data.liveOrders).toEqual([]);
  });

  it("reflects active session in status", async () => {
    db.startSession(100, 5);
    const res = await fetch(`http://localhost:${port}/api/status`);
    const data = JSON.parse(res.body);
    expect(data.session).toBeDefined();
    expect(data.session.budget_usdc).toBe(100);
    expect(data.session.status).toBe("RUNNING");
  });

  it("reflects live orders in status", async () => {
    db.upsertMarket({
      condition_id: "cond1",
      question: "Test?",
      token_id_yes: "tok_yes",
      token_id_no: "tok_no",
      tick_size: "0.01",
      neg_risk: 0,
      midpoint: 0.5,
      tvl: 100000,
      reward_rate: 10,
    });
    db.insertOrder({
      order_id: "ord1",
      condition_id: "cond1",
      token_id: "tok_yes",
      side: "BUY",
      price: 0.45,
      size: 50,
      order_type: "GTD",
      status: "LIVE",
      expiry: null,
    });

    const res = await fetch(`http://localhost:${port}/api/status`);
    const data = JSON.parse(res.body);
    expect(data.liveOrders).toHaveLength(1);
    expect(data.liveOrders[0].order_id).toBe("ord1");
  });

  it("cancels all orders on POST /api/panic", async () => {
    db.upsertMarket({
      condition_id: "cond1",
      question: "Test?",
      token_id_yes: "tok_yes",
      token_id_no: "tok_no",
      tick_size: "0.01",
      neg_risk: 0,
      midpoint: 0.5,
      tvl: 100000,
      reward_rate: 10,
    });
    db.startSession(100, 5);
    db.insertOrder({
      order_id: "ord1",
      condition_id: "cond1",
      token_id: "tok_yes",
      side: "BUY",
      price: 0.45,
      size: 50,
      order_type: "GTD",
      status: "LIVE",
      expiry: null,
    });
    db.insertOrder({
      order_id: "ord2",
      condition_id: "cond1",
      token_id: "tok_yes",
      side: "SELL",
      price: 0.55,
      size: 50,
      order_type: "GTD",
      status: "LIVE",
      expiry: null,
    });

    const res = await fetch(`http://localhost:${port}/api/panic`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.cancelled).toBe(2);

    // Verify orders are cancelled
    expect(db.getLiveOrders()).toHaveLength(0);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`http://localhost:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
