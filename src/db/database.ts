import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDatabase(dbPath: string = "polyfarm.db"): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  db.exec(schema);

  return db;
}

export interface MarketRow {
  condition_id: string;
  question: string;
  token_id_yes: string;
  token_id_no: string;
  tick_size: string;
  neg_risk: number;
  midpoint: number | null;
  tvl: number | null;
  reward_rate: number | null;
  last_updated: number;
}

export interface OrderRow {
  order_id: string;
  condition_id: string;
  token_id: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  order_type: string;
  status: "LIVE" | "CANCELLED" | "FILLED" | "EXPIRED";
  placed_at: number;
  cancelled_at: number | null;
  filled_size: number;
  expiry: number | null;
}

export interface SessionRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  budget_usdc: number;
  spread_cents: number;
  markets_count: number;
  orders_placed: number;
  orders_cancelled: number;
  orders_filled: number;
  status: "RUNNING" | "STOPPED" | "PANIC";
}

export class PolyfarmDb {
  constructor(public db: Database.Database) {}

  // Markets
  upsertMarket(market: Omit<MarketRow, "last_updated">): void {
    this.db
      .prepare(
        `INSERT INTO markets (condition_id, question, token_id_yes, token_id_no, tick_size, neg_risk, midpoint, tvl, reward_rate)
         VALUES (@condition_id, @question, @token_id_yes, @token_id_no, @tick_size, @neg_risk, @midpoint, @tvl, @reward_rate)
         ON CONFLICT(condition_id) DO UPDATE SET
           question=excluded.question, midpoint=excluded.midpoint, tvl=excluded.tvl,
           reward_rate=excluded.reward_rate, last_updated=unixepoch()`,
      )
      .run(market);
  }

  getMarkets(): MarketRow[] {
    return this.db.prepare("SELECT * FROM markets ORDER BY reward_rate DESC").all() as MarketRow[];
  }

  // Orders
  insertOrder(order: Omit<OrderRow, "placed_at" | "cancelled_at" | "filled_size">): void {
    this.db
      .prepare(
        `INSERT INTO orders (order_id, condition_id, token_id, side, price, size, order_type, status, expiry)
         VALUES (@order_id, @condition_id, @token_id, @side, @price, @size, @order_type, @status, @expiry)`,
      )
      .run(order);
  }

  cancelOrder(orderId: string): void {
    this.db
      .prepare("UPDATE orders SET status='CANCELLED', cancelled_at=unixepoch() WHERE order_id=?")
      .run(orderId);
  }

  cancelAllOrders(): number {
    const result = this.db
      .prepare("UPDATE orders SET status='CANCELLED', cancelled_at=unixepoch() WHERE status='LIVE'")
      .run();
    return result.changes;
  }

  getLiveOrders(): OrderRow[] {
    return this.db.prepare("SELECT * FROM orders WHERE status='LIVE'").all() as OrderRow[];
  }

  getLiveOrdersByCondition(conditionId: string): OrderRow[] {
    return this.db
      .prepare("SELECT * FROM orders WHERE status='LIVE' AND condition_id=?")
      .all(conditionId) as OrderRow[];
  }

  getRecentOrders(limit: number = 50): OrderRow[] {
    return this.db
      .prepare(
        "SELECT * FROM orders WHERE status != 'LIVE' ORDER BY cancelled_at DESC, placed_at DESC LIMIT ?",
      )
      .all(limit) as OrderRow[];
  }

  // Sessions
  startSession(budgetUsdc: number, spreadCents: number): number {
    const result = this.db
      .prepare("INSERT INTO sessions (budget_usdc, spread_cents) VALUES (?, ?)")
      .run(budgetUsdc, spreadCents);
    return Number(result.lastInsertRowid);
  }

  endSession(id: number, status: "STOPPED" | "PANIC"): void {
    this.db
      .prepare("UPDATE sessions SET ended_at=unixepoch(), status=? WHERE id=?")
      .run(status, id);
  }

  updateSessionStats(
    id: number,
    stats: { markets_count?: number; orders_placed?: number; orders_cancelled?: number; orders_filled?: number },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, val] of Object.entries(stats)) {
      if (val !== undefined) {
        sets.push(`${key}=?`);
        values.push(val);
      }
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id=?`).run(...values);
  }

  getActiveSession(): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status='RUNNING' ORDER BY id DESC LIMIT 1")
      .get() as SessionRow | undefined;
  }

  // Config
  setConfig(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`,
      )
      .run(key, value);
  }

  getConfig(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM config WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
}
