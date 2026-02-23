import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, PolyfarmDb } from "../../src/db/database.js";
import Database from "better-sqlite3";

describe("PolyfarmDb", () => {
  let rawDb: Database.Database;
  let db: PolyfarmDb;

  beforeEach(() => {
    rawDb = createDatabase(":memory:");
    db = new PolyfarmDb(rawDb);
  });

  afterEach(() => {
    rawDb.close();
  });

  describe("markets", () => {
    it("upserts and retrieves markets", () => {
      db.upsertMarket({
        condition_id: "cond1",
        question: "Will X happen?",
        token_id_yes: "tok_yes",
        token_id_no: "tok_no",
        tick_size: "0.01",
        neg_risk: 0,
        midpoint: 0.5,
        tvl: 100000,
        reward_rate: 10,
      });

      const markets = db.getMarkets();
      expect(markets).toHaveLength(1);
      expect(markets[0].question).toBe("Will X happen?");
      expect(markets[0].midpoint).toBe(0.5);
    });

    it("updates existing market on upsert", () => {
      db.upsertMarket({
        condition_id: "cond1",
        question: "Will X happen?",
        token_id_yes: "tok_yes",
        token_id_no: "tok_no",
        tick_size: "0.01",
        neg_risk: 0,
        midpoint: 0.5,
        tvl: 100000,
        reward_rate: 10,
      });

      db.upsertMarket({
        condition_id: "cond1",
        question: "Will X happen?",
        token_id_yes: "tok_yes",
        token_id_no: "tok_no",
        tick_size: "0.01",
        neg_risk: 0,
        midpoint: 0.6,
        tvl: 200000,
        reward_rate: 15,
      });

      const markets = db.getMarkets();
      expect(markets).toHaveLength(1);
      expect(markets[0].midpoint).toBe(0.6);
      expect(markets[0].tvl).toBe(200000);
    });
  });

  describe("orders", () => {
    function insertTestMarket(conditionId: string = "cond1") {
      db.upsertMarket({
        condition_id: conditionId,
        question: "Test?",
        token_id_yes: "tok1",
        token_id_no: "tok2",
        tick_size: "0.01",
        neg_risk: 0,
        midpoint: 0.5,
        tvl: 100000,
        reward_rate: 10,
      });
    }

    it("inserts and retrieves live orders", () => {
      insertTestMarket();
      db.insertOrder({
        order_id: "ord1",
        condition_id: "cond1",
        token_id: "tok1",
        side: "BUY",
        price: 0.45,
        size: 100,
        order_type: "GTD",
        status: "LIVE",
        expiry: 1234567890,
      });

      const live = db.getLiveOrders();
      expect(live).toHaveLength(1);
      expect(live[0].order_id).toBe("ord1");
      expect(live[0].price).toBe(0.45);
    });

    it("cancels an order", () => {
      insertTestMarket();
      db.insertOrder({
        order_id: "ord1",
        condition_id: "cond1",
        token_id: "tok1",
        side: "BUY",
        price: 0.45,
        size: 100,
        order_type: "GTD",
        status: "LIVE",
        expiry: null,
      });

      db.cancelOrder("ord1");
      expect(db.getLiveOrders()).toHaveLength(0);
    });

    it("cancels all live orders", () => {
      insertTestMarket();
      db.insertOrder({
        order_id: "ord1",
        condition_id: "cond1",
        token_id: "tok1",
        side: "BUY",
        price: 0.45,
        size: 100,
        order_type: "GTD",
        status: "LIVE",
        expiry: null,
      });
      db.insertOrder({
        order_id: "ord2",
        condition_id: "cond1",
        token_id: "tok1",
        side: "SELL",
        price: 0.55,
        size: 100,
        order_type: "GTD",
        status: "LIVE",
        expiry: null,
      });

      const count = db.cancelAllOrders();
      expect(count).toBe(2);
      expect(db.getLiveOrders()).toHaveLength(0);
    });

    it("retrieves live orders by condition", () => {
      insertTestMarket("cond1");
      insertTestMarket("cond2");
      db.insertOrder({
        order_id: "ord1",
        condition_id: "cond1",
        token_id: "tok1",
        side: "BUY",
        price: 0.45,
        size: 100,
        order_type: "GTD",
        status: "LIVE",
        expiry: null,
      });
      db.insertOrder({
        order_id: "ord2",
        condition_id: "cond2",
        token_id: "tok2",
        side: "SELL",
        price: 0.55,
        size: 100,
        order_type: "GTD",
        status: "LIVE",
        expiry: null,
      });

      const orders = db.getLiveOrdersByCondition("cond1");
      expect(orders).toHaveLength(1);
      expect(orders[0].order_id).toBe("ord1");
    });
  });

  describe("sessions", () => {
    it("starts and retrieves active session", () => {
      const id = db.startSession(100, 5);
      expect(id).toBeGreaterThan(0);

      const session = db.getActiveSession();
      expect(session).toBeDefined();
      expect(session!.budget_usdc).toBe(100);
      expect(session!.spread_cents).toBe(5);
      expect(session!.status).toBe("RUNNING");
    });

    it("ends a session", () => {
      const id = db.startSession(100, 5);
      db.endSession(id, "STOPPED");

      const session = db.getActiveSession();
      expect(session).toBeUndefined();
    });

    it("updates session stats", () => {
      const id = db.startSession(100, 5);
      db.updateSessionStats(id, { orders_placed: 10, markets_count: 3 });

      const session = db.getActiveSession();
      expect(session!.orders_placed).toBe(10);
      expect(session!.markets_count).toBe(3);
    });
  });

  describe("config", () => {
    it("sets and gets config values", () => {
      db.setConfig("api_key", "test_key");
      expect(db.getConfig("api_key")).toBe("test_key");
    });

    it("returns undefined for missing keys", () => {
      expect(db.getConfig("nonexistent")).toBeUndefined();
    });

    it("overwrites existing values", () => {
      db.setConfig("api_key", "old_key");
      db.setConfig("api_key", "new_key");
      expect(db.getConfig("api_key")).toBe("new_key");
    });
  });
});
