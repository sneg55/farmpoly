import WebSocket from "ws";
import { EventEmitter } from "node:events";

export interface BookEvent {
  event_type: "book";
  asset_id: string;
  market: string;
  timestamp: string;
  hash: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

export interface WsManagerOptions {
  url?: string;
  maxReconnectAttempts?: number;
  heartbeatIntervalMs?: number;
}

const DEFAULT_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_INTERVAL = 30000;

export class WsConnectionManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private subscriptions = new Set<string>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = false;
  private _closed = false;

  readonly url: string;
  readonly maxReconnectAttempts: number;

  constructor(options: WsManagerOptions = {}) {
    super();
    this.url = options.url || DEFAULT_WS_URL;
    this.maxReconnectAttempts = options.maxReconnectAttempts || MAX_RECONNECT_ATTEMPTS;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get closed(): boolean {
    return this._closed;
  }

  connect(): void {
    if (this._closed) return;
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.alive = true;
      this.emit("connected");

      // Resubscribe to all markets
      for (const assetId of this.subscriptions) {
        this.sendSubscribe(assetId);
      }

      this.startHeartbeat();
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      this.alive = true;
      try {
        const parsed = JSON.parse(data.toString());

        if (Array.isArray(parsed)) {
          for (const event of parsed) {
            this.handleEvent(event);
          }
        } else {
          this.handleEvent(parsed);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on("close", () => {
      this.stopHeartbeat();
      if (!this._closed) {
        this.emit("disconnected");
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.ws.on("pong", () => {
      this.alive = true;
    });
  }

  subscribe(assetId: string): void {
    this.subscriptions.add(assetId);
    if (this.connected) {
      this.sendSubscribe(assetId);
    }
  }

  unsubscribe(assetId: string): void {
    this.subscriptions.delete(assetId);
    if (this.connected) {
      this.ws!.send(
        JSON.stringify({
          type: "unsubscribe",
          channel: "book",
          assets_ids: [assetId],
        }),
      );
    }
  }

  close(): void {
    this._closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.removeAllListeners();
  }

  private sendSubscribe(assetId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "subscribe",
        channel: "book",
        assets_ids: [assetId],
      }),
    );
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (event.event_type === "book" && this.isValidBookEvent(event)) {
      this.emit("book", event as unknown as BookEvent);
    }
  }

  private isValidBookEvent(event: Record<string, unknown>): boolean {
    return (
      typeof event.asset_id === "string" &&
      Array.isArray(event.bids) &&
      Array.isArray(event.asks)
    );
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.alive) {
        // Connection is dead, force reconnect
        this.ws?.terminate();
        return;
      }
      this.alive = false;
      this.ws?.ping();
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this._closed) return;

    this.reconnectAttempt++;

    if (this.reconnectAttempt > this.maxReconnectAttempts) {
      this.emit("panic", new Error("Max reconnection attempts exceeded"));
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s...
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 10000);
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delay });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
