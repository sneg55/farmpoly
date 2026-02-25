import type { ClobClient } from "@polymarket/clob-client";
import type { PolyfarmDb, OrderRow } from "../db/database.js";
import type { BookEvent, WsConnectionManager } from "./websocket.js";
import { isInDangerZone } from "../orders/calculator.js";
import { EventEmitter } from "node:events";

export interface MonitorOptions {
  dangerZoneCents?: number;
  replacementCooldownMs?: number;
}

export interface MidpointState {
  assetId: string;
  midpoint: number;
  lastUpdated: number;
}

const DEFAULT_DANGER_ZONE_CENTS = 3;
const DEFAULT_REPLACEMENT_COOLDOWN_MS = 500;
const SLOW_CANCEL_THRESHOLD_MS = 200;

export class SafetyMonitor extends EventEmitter {
  private midpoints = new Map<string, MidpointState>();
  private lastCancelTime = new Map<string, number>();
  /** In-memory order index: tokenId -> Map<orderId, OrderRow> (O(1) lookup/delete) */
  private ordersByToken = new Map<string, Map<string, OrderRow>>();
  /** Per-asset single-flight lock to prevent overlapping checkOrders calls */
  private checkingAsset = new Set<string>();
  private running = false;

  private readonly dangerZoneCents: number;
  private readonly replacementCooldownMs: number;

  constructor(
    private clobClient: ClobClient,
    private db: PolyfarmDb,
    private wsManager: WsConnectionManager,
    options: MonitorOptions = {},
  ) {
    super();
    this.dangerZoneCents = options.dangerZoneCents ?? DEFAULT_DANGER_ZONE_CENTS;
    this.replacementCooldownMs = options.replacementCooldownMs ?? DEFAULT_REPLACEMENT_COOLDOWN_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Bootstrap in-memory index from DB
    this.rebuildOrderIndex();

    this.wsManager.on("book", (event: BookEvent) => {
      this.onBookUpdate(event);
    });

    this.wsManager.on("panic", (err: Error) => {
      this.emit("panic", err);
    });

    this.wsManager.connect();
  }

  stop(): void {
    this.running = false;
    this.wsManager.close();
  }

  subscribeToMarket(assetId: string): void {
    this.wsManager.subscribe(assetId);
  }

  getMidpoint(assetId: string): number | undefined {
    return this.midpoints.get(assetId)?.midpoint;
  }

  /** Rebuild in-memory order index from DB (call after placing new orders or rebalance) */
  rebuildOrderIndex(): void {
    this.ordersByToken.clear();
    for (const order of this.db.getLiveOrders()) {
      this.addOrderToIndex(order);
    }
  }

  /** Add a single order to the in-memory index */
  addOrderToIndex(order: OrderRow): void {
    let orders = this.ordersByToken.get(order.token_id);
    if (!orders) {
      orders = new Map();
      this.ordersByToken.set(order.token_id, orders);
    }
    orders.set(order.order_id, order);
  }

  /** Remove an order from the in-memory index (O(1)) */
  private removeOrderFromIndex(orderId: string, tokenId: string): void {
    const orders = this.ordersByToken.get(tokenId);
    if (!orders) return;
    orders.delete(orderId);
    if (orders.size === 0) this.ordersByToken.delete(tokenId);
  }

  private onBookUpdate(event: BookEvent): void {
    const startTime = Date.now();

    const bestBid = event.bids.length > 0 ? parseFloat(event.bids[0].price) : 0;
    const bestAsk = event.asks.length > 0 ? parseFloat(event.asks[0].price) : 1;
    const midpoint = (bestBid + bestAsk) / 2;

    this.midpoints.set(event.asset_id, {
      assetId: event.asset_id,
      midpoint,
      lastUpdated: startTime,
    });

    this.emit("midpoint", { assetId: event.asset_id, midpoint });

    // Single-flight: drop event if we're already processing this asset
    if (this.checkingAsset.has(event.asset_id)) return;

    this.checkingAsset.add(event.asset_id);
    this.checkOrders(event.asset_id, midpoint, startTime).finally(() => {
      this.checkingAsset.delete(event.asset_id);
    });
  }

  private async checkOrders(assetId: string, midpoint: number, startTime: number): Promise<void> {
    // O(1) lookup from in-memory index instead of full DB scan
    const orderMap = this.ordersByToken.get(assetId);
    if (!orderMap || orderMap.size === 0) return;
    const liveOrders = Array.from(orderMap.values());

    const dangerZone = this.dangerZoneCents / 100;
    const yellowThreshold = dangerZone;          // full danger zone distance
    const redThreshold = dangerZone / 2;         // half danger zone = immediate cancel

    const redOrders: OrderRow[] = [];
    for (const order of liveOrders) {
      const distance = Math.abs(order.price - midpoint);

      if (distance < redThreshold + 1e-10) {
        // RED: immediate cancel
        this.emit("danger", {
          orderId: order.order_id,
          orderPrice: order.price,
          midpoint,
          distance,
        });
        redOrders.push(order);
      } else if (distance < yellowThreshold + 1e-10) {
        // YELLOW: warning, no cancel yet
        this.emit("warning", {
          orderId: order.order_id,
          orderPrice: order.price,
          midpoint,
          distance,
        });
      }
      // GREEN: distance > yellowThreshold, do nothing
    }

    if (redOrders.length === 0) return;

    // Cancel all red-zone orders concurrently
    const results = await Promise.allSettled(
      redOrders.map((order) => this.cancelOrderDefensively(order, startTime)),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        this.emit("panic", new Error(`Cancel failed: ${result.reason}`));
      }
    }
  }

  /**
   * Cancel all orders on the counterpart side for a given condition.
   * Used after a fill to prevent double exposure (e.g., if BID fills, cancel all ASKs).
   */
  async cancelCounterpartOrders(conditionId: string, filledSide: "BUY" | "SELL"): Promise<string[]> {
    const cancelledIds: string[] = [];
    const oppositeSide = filledSide === "BUY" ? "SELL" : "BUY";

    // Scan in-memory index for orders matching this condition and opposite side
    for (const [tokenId, orderMap] of this.ordersByToken) {
      for (const [orderId, order] of orderMap) {
        if (order.condition_id === conditionId && order.side === oppositeSide) {
          try {
            await this.clobClient.cancelOrder({ orderID: orderId });
            this.db.cancelOrder(orderId);
            this.removeOrderFromIndex(orderId, tokenId);
            cancelledIds.push(orderId);
            this.emit("cancelled", { orderId, latencyMs: 0, reason: "counterpart_cancel" });
          } catch {
            this.emit("cancel_failed", { orderId, error: "counterpart cancel failed" });
          }
        }
      }
    }

    return cancelledIds;
  }

  private async cancelOrderDefensively(order: OrderRow, startTime: number): Promise<void> {
    // Cooldown check
    const lastCancel = this.lastCancelTime.get(order.order_id);
    if (lastCancel && Date.now() - lastCancel < this.replacementCooldownMs) {
      return;
    }

    try {
      await this.clobClient.cancelOrder({ orderID: order.order_id });
    } catch {
      // Retry once
      try {
        await this.clobClient.cancelOrder({ orderID: order.order_id });
      } catch (retryErr) {
        this.emit("cancel_failed", { orderId: order.order_id, error: retryErr });
        throw retryErr;
      }
    }

    // Update DB and in-memory index
    this.db.cancelOrder(order.order_id);
    this.removeOrderFromIndex(order.order_id, order.token_id);
    this.lastCancelTime.set(order.order_id, Date.now());

    const latencyMs = Date.now() - startTime;
    this.emit("cancelled", { orderId: order.order_id, latencyMs, reason: "danger_zone" });

    if (latencyMs > SLOW_CANCEL_THRESHOLD_MS) {
      this.emit("slow_cancel", { orderId: order.order_id, latencyMs });
    }
  }
}
