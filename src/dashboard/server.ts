import http from "node:http";
import type { PolyfarmDb } from "../db/database.js";
import { dashboardHtml } from "./html.js";

export interface DashboardOptions {
  port: number;
  host?: string;
  db: PolyfarmDb;
  onPanic?: () => Promise<number>;
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const SSE_INTERVAL_MS = 2000;

function freshPayload(db: PolyfarmDb): string {
  const session = db.getActiveSession() ?? null;
  const liveOrders = db.getLiveOrders();
  const markets = db.getMarkets();
  const recentOrders = db.getRecentOrders(50);
  return JSON.stringify({ session, liveOrders, markets, recentOrders });
}

export function createDashboardServer(opts: DashboardOptions): http.Server {
  const { db, onPanic } = opts;
  const html = dashboardHtml();

  // Shared SSE publisher — one interval with cached snapshot, fan-out to all clients
  const sseClients = new Set<http.ServerResponse>();
  let sseCache = "";
  const sseInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    try {
      sseCache = freshPayload(db);
      for (const client of sseClients) {
        client.write(`data: ${sseCache}\n\n`);
      }
    } catch {
      // DB error, skip this tick
    }
  }, SSE_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    try {
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (url.pathname === "/api/status" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(freshPayload(db));
        return;
      }

      if (url.pathname === "/api/panic" && req.method === "POST") {
        if (onPanic) {
          const cancelled = await onPanic();
          json(res, { ok: true, cancelled });
        } else {
          const cancelled = db.cancelAllOrders();
          const session = db.getActiveSession();
          if (session) db.endSession(session.id, "PANIC");
          json(res, { ok: true, cancelled });
        }
        return;
      }

      // SSE stream — shared publisher, no per-client interval
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      json(res, { error: (err as Error).message }, 500);
    }
  });

  server.on("close", () => clearInterval(sseInterval));

  return server;
}

export function startDashboard(opts: DashboardOptions): Promise<http.Server> {
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    const server = createDashboardServer(opts);
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
