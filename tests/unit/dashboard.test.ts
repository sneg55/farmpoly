import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createDatabase, PolyfarmDb } from "../../src/db/database.js";
import Database from "better-sqlite3";

interface FetchResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function fetch(url: string, opts?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: opts?.method || "GET",
        headers: opts?.headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    if (opts?.body) req.write(opts.body);
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

    const res = await fetch(`http://localhost:${port}/api/panic`, {
      method: "POST",
    });
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

  // Enhanced payload tests
  it("includes hedges, inventory, pnlSummary, rewardScores in /api/status", async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("hedges");
    expect(data).toHaveProperty("inventory");
    expect(data).toHaveProperty("pnlSummary");
    expect(data).toHaveProperty("rewardScores");
    expect(Array.isArray(data.hedges)).toBe(true);
    expect(Array.isArray(data.inventory)).toBe(true);
    expect(Array.isArray(data.rewardScores)).toBe(true);
  });

  it("pnlSummary sums realized P&L from hedges correctly", async () => {
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

    // Insert hedges with different statuses
    db.insertHedge({
      trade_id: "t1",
      order_id: "o1",
      condition_id: "cond1",
      fill_side: "BUY",
      fill_size: 50,
      fill_price: 0.48,
      status: "PENDING",
    });
    const id1 = db.insertHedge({
      trade_id: "t2",
      order_id: "o2",
      condition_id: "cond1",
      fill_side: "BUY",
      fill_size: 50,
      fill_price: 0.48,
      status: "PENDING",
    });
    db.updateHedge({
      id: id1,
      hedge_order_id: "h1",
      hedge_price: 0.50,
      hedge_size: 50,
      merge_amount: 50,
      merge_tx_hash: "0xabc",
      pnl_cents: 200,
      status: "HEDGED",
    });
    const id2 = db.insertHedge({
      trade_id: "t3",
      order_id: "o3",
      condition_id: "cond1",
      fill_side: "BUY",
      fill_size: 30,
      fill_price: 0.45,
      status: "PENDING",
    });
    db.updateHedge({
      id: id2,
      hedge_order_id: "h2",
      hedge_price: 0.53,
      hedge_size: 30,
      merge_amount: 30,
      merge_tx_hash: "0xdef",
      pnl_cents: 150,
      status: "HEDGED",
    });
    const id3 = db.insertHedge({
      trade_id: "t4",
      order_id: "o4",
      condition_id: "cond1",
      fill_side: "SELL",
      fill_size: 20,
      fill_price: 0.55,
      status: "PENDING",
    });
    db.updateHedge({
      id: id3,
      hedge_order_id: null,
      hedge_price: null,
      hedge_size: 0,
      merge_amount: 0,
      merge_tx_hash: null,
      pnl_cents: 0,
      status: "HEDGE_FAILED",
    });

    const res = await fetch(`http://localhost:${port}/api/status`);
    const data = JSON.parse(res.body);
    expect(data.pnlSummary.realizedCents).toBe(350); // 200 + 150
    expect(data.pnlSummary.totalHedged).toBe(2);
    expect(data.pnlSummary.totalFailed).toBe(1);
  });

  it("reward scores calculated from markets + live orders", async () => {
    db.upsertMarket({
      condition_id: "cond1",
      question: "Test market?",
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
      price: 0.48,
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
      price: 0.52,
      size: 50,
      order_type: "GTD",
      status: "LIVE",
      expiry: null,
    });

    const res = await fetch(`http://localhost:${port}/api/status`);
    const data = JSON.parse(res.body);
    expect(data.rewardScores).toHaveLength(1);
    const rs = data.rewardScores[0];
    expect(rs.conditionId).toBe("cond1");
    expect(rs.isTwoSided).toBe(true);
    expect(rs.spreadQuality).toBeGreaterThan(0);
    expect(rs.estimatedDaily).toBeGreaterThan(0);
    expect(rs.bookShare).toBeGreaterThan(0);
  });
});

describe("Dashboard Auth", () => {
  let rawDb: Database.Database;
  let db: PolyfarmDb;
  let server: http.Server;
  let port: number;
  const AUTH_TOKEN = "test-secret-token-123";

  beforeEach(async () => {
    rawDb = createDatabase(":memory:");
    db = new PolyfarmDb(rawDb);
    server = createDashboardServer({
      port: 0,
      db,
      authToken: AUTH_TOKEN,
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rawDb.close();
  });

  it("returns login page on GET / without token", async () => {
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("Enter your dashboard token");
    expect(res.body).toContain("Sign In");
    // Should NOT contain the main dashboard
    expect(res.body).not.toContain("PANIC CANCEL ALL");
  });

  it("returns 401 on GET /api/status without token", async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(401);
    const data = JSON.parse(res.body);
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 200 with valid Bearer header", async () => {
    const res = await fetch(`http://localhost:${port}/api/status`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("session");
  });

  it("returns 200 with valid cookie", async () => {
    const res = await fetch(`http://localhost:${port}/api/status`, {
      headers: { Cookie: `polyfarm_token=${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("session");
  });

  it("serves dashboard HTML on GET / with valid Bearer", async () => {
    const res = await fetch(`http://localhost:${port}/`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("PANIC CANCEL ALL");
    expect(res.body).toContain("PolyFarm");
  });

  it("POST /api/login returns cookie on valid token", async () => {
    const res = await fetch(`http://localhost:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: AUTH_TOKEN }),
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    // Check Set-Cookie header
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toContain("polyfarm_token=");
    expect(cookieStr).toContain("HttpOnly");
  });

  it("POST /api/login returns 401 on invalid token", async () => {
    const res = await fetch(`http://localhost:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    expect(res.status).toBe(401);
    const data = JSON.parse(res.body);
    expect(data.error).toBe("Invalid token");
  });

  it("POST /api/logout clears cookie", async () => {
    const res = await fetch(`http://localhost:${port}/api/logout`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toContain("Max-Age=0");
  });

  it("returns 401 on POST /api/panic without token", async () => {
    const res = await fetch(`http://localhost:${port}/api/panic`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
