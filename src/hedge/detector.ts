import { EventEmitter } from "node:events";
import type { ClobClient } from "@polymarket/clob-client";
import type { PolyfarmDb, OrderRow, MarketRow } from "../db/database.js";

export interface FillEvent {
  tradeId: string;
  orderId: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  filledSize: number;
  filledPrice: number;
  matchTime: string;
  negRisk: boolean;
  tickSize: string;
  tokenIdYes: string;
  tokenIdNo: string;
}

const POLL_INTERVAL_MS = 5_000;
const MAX_PROCESSED_IDS = 5_000;

/**
 * Detects fills on our maker orders by polling CLOB getTrades().
 * Emits "fill" events for each detected maker fill.
 */
export class FillDetector extends EventEmitter {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private processedTradeIds = new Set<string>();
  private lastPollTime: number;
  private running = false;

  constructor(
    private clobClient: ClobClient,
    private db: PolyfarmDb,
  ) {
    super();
    // Initialize to "now" to skip historical trades
    this.lastPollTime = Math.floor(Date.now() / 1000);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        this.emit("poll_error", err);
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const response = await this.clobClient.getTrades({
        after: this.lastPollTime,
      } as any);

      // Normalize response — SDK may return different shapes
      const trades: any[] = Array.isArray(response) ? response : (response as any)?.data ?? [];

      if (trades.length === 0) return;

      // Build lookup maps for live orders and markets
      const liveOrders = this.db.getLiveOrders();
      const liveOrderIds = new Set(liveOrders.map((o: OrderRow) => o.order_id));
      const orderMap = new Map<string, OrderRow>();
      for (const o of liveOrders) {
        orderMap.set(o.order_id, o);
      }

      const markets = this.db.getMarkets();
      const marketMap = new Map<string, MarketRow>();
      for (const m of markets) {
        marketMap.set(m.condition_id, m);
      }

      for (const trade of trades) {
        const tradeId = trade.id ?? trade.trade_id ?? String(trade.match_time);

        // Deduplicate
        if (this.processedTradeIds.has(tradeId)) continue;
        this.processedTradeIds.add(tradeId);

        // Cap dedup set size
        if (this.processedTradeIds.size > MAX_PROCESSED_IDS) {
          const iterator = this.processedTradeIds.values();
          for (let i = 0; i < 1000; i++) {
            const val = iterator.next().value;
            if (val !== undefined) this.processedTradeIds.delete(val);
          }
        }

        // Only process trades where we were the maker
        const traderSide = trade.trader_side ?? trade.side ?? "";
        if (traderSide.toUpperCase() !== "MAKER") continue;

        // Cross-reference against our live orders
        const makerOrders = trade.maker_orders ?? [];
        for (const makerOrder of makerOrders) {
          const orderId = makerOrder.order_id ?? makerOrder.id ?? "";
          if (!liveOrderIds.has(orderId)) continue;

          const order = orderMap.get(orderId);
          if (!order) continue;

          const market = marketMap.get(order.condition_id);
          if (!market) continue;

          const fillEvent: FillEvent = {
            tradeId,
            orderId,
            conditionId: order.condition_id,
            tokenId: order.token_id,
            side: order.side,
            filledSize: parseFloat(makerOrder.matched_amount ?? trade.size ?? "0"),
            filledPrice: parseFloat(makerOrder.price ?? trade.price ?? "0"),
            matchTime: trade.match_time ?? String(Date.now()),
            negRisk: market.neg_risk === 1,
            tickSize: market.tick_size,
            tokenIdYes: market.token_id_yes,
            tokenIdNo: market.token_id_no,
          };

          this.emit("fill", fillEvent);
        }

        // Also check if the trade's asset_id matches any of our orders directly
        // (some SDK versions don't have maker_orders)
        if (makerOrders.length === 0 && trade.asset_id) {
          const matchingOrders = liveOrders.filter(
            (o: OrderRow) => o.token_id === trade.asset_id,
          );
          for (const order of matchingOrders) {
            const market = marketMap.get(order.condition_id);
            if (!market) continue;

            const fillEvent: FillEvent = {
              tradeId,
              orderId: order.order_id,
              conditionId: order.condition_id,
              tokenId: order.token_id,
              side: order.side,
              filledSize: parseFloat(trade.size ?? "0"),
              filledPrice: parseFloat(trade.price ?? "0"),
              matchTime: trade.match_time ?? String(Date.now()),
              negRisk: market.neg_risk === 1,
              tickSize: market.tick_size,
              tokenIdYes: market.token_id_yes,
              tokenIdNo: market.token_id_no,
            };

            this.emit("fill", fillEvent);
          }
        }

        // Update lastPollTime
        const tradeTime = trade.match_time ? Math.floor(new Date(trade.match_time).getTime() / 1000) : 0;
        if (tradeTime > this.lastPollTime) {
          this.lastPollTime = tradeTime;
        }
      }
    } catch (err) {
      this.emit("poll_error", err);
    }
  }
}
