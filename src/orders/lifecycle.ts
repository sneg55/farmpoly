import type { ClobClient } from "@polymarket/clob-client";
import type { PolyfarmDb } from "../db/database.js";

/**
 * Cancel all live orders via CLOB API + mark them cancelled in DB.
 * Shared across panic, rebalance, and shutdown flows.
 *
 * @returns Number of orders cancelled in DB
 */
export async function cancelAllOrders(
  clobClient: ClobClient,
  db: PolyfarmDb,
): Promise<number> {
  await clobClient.cancelAll();
  return db.cancelAllOrders();
}

/**
 * Full panic sequence: cancel all orders, end session.
 *
 * @returns Number of orders cancelled
 */
export async function panicCancelAll(
  clobClient: ClobClient,
  db: PolyfarmDb,
  sessionId?: number,
): Promise<number> {
  const cancelled = await cancelAllOrders(clobClient, db);
  if (sessionId !== undefined) {
    db.endSession(sessionId, "PANIC");
  } else {
    const session = db.getActiveSession();
    if (session) db.endSession(session.id, "PANIC");
  }
  return cancelled;
}

/**
 * Graceful shutdown: cancel all orders, end session as STOPPED.
 *
 * @returns Number of orders cancelled
 */
export async function gracefulShutdown(
  clobClient: ClobClient,
  db: PolyfarmDb,
  sessionId: number,
): Promise<number> {
  const cancelled = await cancelAllOrders(clobClient, db);
  db.endSession(sessionId, "STOPPED");
  return cancelled;
}
