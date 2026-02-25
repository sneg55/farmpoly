import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createDatabase(dbPath: string = process.env.POLYFARM_DB_PATH || "polyfarm.db"): Database.Database {
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

export interface HedgeRow {
  id: number;
  trade_id: string;
  order_id: string;
  condition_id: string;
  fill_side: "BUY" | "SELL";
  fill_size: number;
  fill_price: number;
  hedge_order_id: string | null;
  hedge_price: number | null;
  hedge_size: number;
  merge_amount: number;
  merge_tx_hash: string | null;
  pnl_cents: number;
  status: "PENDING" | "HEDGED" | "HEDGE_FAILED" | "MERGE_FAILED" | "SKIPPED";
  created_at: number;
  completed_at: number | null;
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
  // Cached prepared statements (prepared once, reused on every call)
  private readonly stmts;

  constructor(public db: Database.Database) {
    this.stmts = {
      upsertMarket: db.prepare(
        `INSERT INTO markets (condition_id, question, token_id_yes, token_id_no, tick_size, neg_risk, midpoint, tvl, reward_rate)
         VALUES (@condition_id, @question, @token_id_yes, @token_id_no, @tick_size, @neg_risk, @midpoint, @tvl, @reward_rate)
         ON CONFLICT(condition_id) DO UPDATE SET
           question=excluded.question, midpoint=excluded.midpoint, tvl=excluded.tvl,
           reward_rate=excluded.reward_rate, last_updated=unixepoch()`,
      ),
      getMarkets: db.prepare("SELECT * FROM markets ORDER BY reward_rate DESC"),
      insertOrder: db.prepare(
        `INSERT INTO orders (order_id, condition_id, token_id, side, price, size, order_type, status, expiry)
         VALUES (@order_id, @condition_id, @token_id, @side, @price, @size, @order_type, @status, @expiry)`,
      ),
      cancelOrder: db.prepare(
        "UPDATE orders SET status='CANCELLED', cancelled_at=unixepoch() WHERE order_id=?",
      ),
      cancelAllOrders: db.prepare(
        "UPDATE orders SET status='CANCELLED', cancelled_at=unixepoch() WHERE status='LIVE'",
      ),
      getLiveOrders: db.prepare("SELECT * FROM orders WHERE status='LIVE'"),
      getLiveOrdersByCondition: db.prepare(
        "SELECT * FROM orders WHERE status='LIVE' AND condition_id=?",
      ),
      getRecentOrders: db.prepare(
        "SELECT * FROM orders WHERE status IN ('CANCELLED','FILLED','EXPIRED') ORDER BY cancelled_at DESC, placed_at DESC LIMIT ?",
      ),
      startSession: db.prepare("INSERT INTO sessions (budget_usdc, spread_cents) VALUES (?, ?)"),
      endSession: db.prepare("UPDATE sessions SET ended_at=unixepoch(), status=? WHERE id=?"),
      getActiveSession: db.prepare(
        "SELECT * FROM sessions WHERE status='RUNNING' ORDER BY id DESC LIMIT 1",
      ),
      setConfig: db.prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()`,
      ),
      getConfig: db.prepare("SELECT value FROM config WHERE key=?"),
      // Dedicated session stat update statements (avoids N+1 in cancel handler)
      incrCancelled: db.prepare(
        "UPDATE sessions SET orders_cancelled = orders_cancelled + ? WHERE id=?",
      ),
      incrFilled: db.prepare(
        "UPDATE sessions SET orders_filled = orders_filled + ? WHERE id=?",
      ),
      updateOrderFill: db.prepare(
        "UPDATE orders SET filled_size = filled_size + ?, status = CASE WHEN filled_size + ? >= size THEN 'FILLED' ELSE status END WHERE order_id = ?",
      ),
      insertHedge: db.prepare(
        `INSERT OR IGNORE INTO hedges (trade_id, order_id, condition_id, fill_side, fill_size, fill_price, status)
         VALUES (@trade_id, @order_id, @condition_id, @fill_side, @fill_size, @fill_price, @status)`,
      ),
      updateHedge: db.prepare(
        `UPDATE hedges SET
           hedge_order_id = @hedge_order_id,
           hedge_price = @hedge_price,
           hedge_size = @hedge_size,
           merge_amount = @merge_amount,
           merge_tx_hash = @merge_tx_hash,
           pnl_cents = @pnl_cents,
           status = @status,
           completed_at = unixepoch()
         WHERE id = @id`,
      ),
      getRecentHedges: db.prepare(
        "SELECT * FROM hedges ORDER BY created_at DESC LIMIT ?",
      ),
    };
  }

  // Markets
  upsertMarket(market: Omit<MarketRow, "last_updated">): void {
    this.stmts.upsertMarket.run(market);
  }

  getMarkets(): MarketRow[] {
    return this.stmts.getMarkets.all() as MarketRow[];
  }

  // Orders
  insertOrder(order: Omit<OrderRow, "placed_at" | "cancelled_at" | "filled_size">): void {
    this.stmts.insertOrder.run(order);
  }

  cancelOrder(orderId: string): void {
    this.stmts.cancelOrder.run(orderId);
  }

  cancelAllOrders(): number {
    const result = this.stmts.cancelAllOrders.run();
    return result.changes;
  }

  getLiveOrders(): OrderRow[] {
    return this.stmts.getLiveOrders.all() as OrderRow[];
  }

  getLiveOrdersByCondition(conditionId: string): OrderRow[] {
    return this.stmts.getLiveOrdersByCondition.all(conditionId) as OrderRow[];
  }

  getRecentOrders(limit: number = 50): OrderRow[] {
    return this.stmts.getRecentOrders.all(limit) as OrderRow[];
  }

  // Sessions
  startSession(budgetUsdc: number, spreadCents: number): number {
    const result = this.stmts.startSession.run(budgetUsdc, spreadCents);
    return Number(result.lastInsertRowid);
  }

  endSession(id: number, status: "STOPPED" | "PANIC"): void {
    this.stmts.endSession.run(status, id);
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

  /** Increment cancelled counter directly (avoids getActiveSession + updateSessionStats N+1) */
  incrementCancelled(sessionId: number, count: number = 1): void {
    this.stmts.incrCancelled.run(count, sessionId);
  }

  /** Increment filled counter directly */
  incrementFilled(sessionId: number, count: number = 1): void {
    this.stmts.incrFilled.run(count, sessionId);
  }

  /** Update filled_size on an order and flip status to FILLED when fully filled */
  updateOrderFill(orderId: string, filledSize: number): void {
    this.stmts.updateOrderFill.run(filledSize, filledSize, orderId);
  }

  // Hedges
  insertHedge(hedge: {
    trade_id: string;
    order_id: string;
    condition_id: string;
    fill_side: "BUY" | "SELL";
    fill_size: number;
    fill_price: number;
    status: HedgeRow["status"];
  }): number {
    const result = this.stmts.insertHedge.run(hedge);
    return Number(result.lastInsertRowid);
  }

  updateHedge(hedge: {
    id: number;
    hedge_order_id: string | null;
    hedge_price: number | null;
    hedge_size: number;
    merge_amount: number;
    merge_tx_hash: string | null;
    pnl_cents: number;
    status: HedgeRow["status"];
  }): void {
    this.stmts.updateHedge.run(hedge);
  }

  getRecentHedges(limit: number = 50): HedgeRow[] {
    return this.stmts.getRecentHedges.all(limit) as HedgeRow[];
  }

  getActiveSession(): SessionRow | undefined {
    return this.stmts.getActiveSession.get() as SessionRow | undefined;
  }

  // Config
  setConfig(key: string, value: string): void {
    this.stmts.setConfig.run(key, value);
  }

  getConfig(key: string): string | undefined {
    const row = this.stmts.getConfig.get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }
}
