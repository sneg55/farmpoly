import http from "node:http";
import type { PolyfarmDb } from "../db/database.js";
import { dashboardHtml, loginHtml } from "./html.js";

export interface DashboardOptions {
  port: number;
  host?: string;
  db: PolyfarmDb;
  onPanic?: () => Promise<number>;
  /** Bearer token for API authentication. If set, all endpoints require it. */
  authToken?: string;
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Parse cookies from request header */
function parseCookies(req: http.IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies.set(key, rest.join("="));
  }
  return cookies;
}

/** Read full request body as string */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const SSE_INTERVAL_MS = 2000;

export interface PnlSummary {
  realizedCents: number;
  totalHedged: number;
  totalFailed: number;
  inventoryCount: number;
  inventoryUsdc: number;
}

export interface RewardScore {
  conditionId: string;
  question: string;
  rewardRate: number;
  spreadQuality: number;
  isTwoSided: boolean;
  estimatedDaily: number;
  bookShare: number;
}

function freshPayload(db: PolyfarmDb): string {
  const session = db.getActiveSession() ?? null;
  const liveOrders = db.getLiveOrders();
  const allMarkets = db.getMarkets();
  const recentOrders = db.getRecentOrders(50);

  // Only show markets we're actively quoting (have live orders)
  const quotedConditionIds = new Set(liveOrders.map((o) => o.condition_id));
  const markets = allMarkets.filter((m) => quotedConditionIds.has(m.condition_id));
  const hedges = db.getRecentHedges(50);

  // Inventory — only if active session
  const inventory = session ? db.getSessionInventory(session.id) : [];

  // P&L summary from hedges
  const pnlSummary: PnlSummary = {
    realizedCents: 0,
    totalHedged: 0,
    totalFailed: 0,
    inventoryCount: inventory.length,
    inventoryUsdc: inventory.reduce((sum, inv) => sum + inv.current_balance, 0),
  };
  for (const h of hedges) {
    if (h.status === "HEDGED") {
      pnlSummary.realizedCents += h.pnl_cents;
      pnlSummary.totalHedged++;
    } else if (h.status === "HEDGE_FAILED" || h.status === "MERGE_FAILED") {
      pnlSummary.totalFailed++;
    }
  }

  // Reward scores per market — computed from live orders
  const MAX_SPREAD = 0.10; // 10 cents
  const rewardScores: RewardScore[] = [];
  for (const m of markets) {
    const mktOrders = liveOrders.filter((o) => o.condition_id === m.condition_id);
    if (mktOrders.length === 0) continue;

    const hasBuy = mktOrders.some((o) => o.side === "BUY");
    const hasSell = mktOrders.some((o) => o.side === "SELL");
    const isTwoSided = hasBuy && hasSell;

    // Calculate effective spread from orders
    // Two-sided: use bid-ask spread. One-sided: use distance from midpoint.
    const buyOrders = mktOrders.filter((o) => o.side === "BUY");
    const sellOrders = mktOrders.filter((o) => o.side === "SELL");
    const mid = m.midpoint ?? 0.5;
    let effectiveSpread: number;
    if (buyOrders.length > 0 && sellOrders.length > 0) {
      const bestBid = Math.max(...buyOrders.map((o) => o.price));
      const bestAsk = Math.min(...sellOrders.map((o) => o.price));
      effectiveSpread = bestAsk - bestBid;
    } else if (buyOrders.length > 0) {
      const bestBid = Math.max(...buyOrders.map((o) => o.price));
      effectiveSpread = (mid - bestBid) * 2; // distance from midpoint, doubled for one-sided
    } else {
      const bestAsk = Math.min(...sellOrders.map((o) => o.price));
      effectiveSpread = (bestAsk - mid) * 2;
    }

    const spreadRatio = Math.min(effectiveSpread / MAX_SPREAD, 1);
    const spreadQuality = 1 - spreadRatio * spreadRatio;

    const totalSize = mktOrders.reduce((s, o) => s + o.size, 0);
    const twoSidedMultiplier = isTwoSided ? 2.0 : 1.0;
    const bookShare = m.tvl && m.tvl > 0 ? (totalSize / m.tvl) * 100 : 0;
    // Our estimated daily reward = our share of TVL × market reward pool × quality × two-sided bonus
    const ourShare = m.tvl && m.tvl > 0 ? totalSize / (m.tvl + totalSize) : 0;
    const estimatedDaily = ourShare * (m.reward_rate ?? 0) * spreadQuality * twoSidedMultiplier;

    rewardScores.push({
      conditionId: m.condition_id,
      question: m.question,
      rewardRate: m.reward_rate ?? 0,
      spreadQuality,
      isTwoSided,
      estimatedDaily,
      bookShare,
    });
  }

  return JSON.stringify({
    session,
    liveOrders,
    markets,
    recentOrders,
    hedges,
    inventory,
    pnlSummary,
    rewardScores,
  });
}

export function createDashboardServer(opts: DashboardOptions): http.Server {
  const { db, onPanic, authToken } = opts;
  const html = dashboardHtml();
  const loginPage = loginHtml();

  /** Security headers applied to all responses */
  const SECURITY_HEADERS: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
  };

  function setSecurityHeaders(res: http.ServerResponse): void {
    for (const [key, val] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(key, val);
    }
  }

  /** Check bearer token or cookie auth */
  function isAuthorized(req: http.IncomingMessage): boolean {
    if (!authToken) return true; // No token configured = open (localhost-only use)
    // Check Authorization header
    const header = req.headers.authorization;
    if (header === `Bearer ${authToken}`) return true;
    // Check cookie
    const cookies = parseCookies(req);
    if (cookies.get("polyfarm_token") === authToken) return true;
    return false;
  }

  // Shared SSE publisher — one interval with cached snapshot, fan-out to all clients
  const sseClients = new Set<http.ServerResponse>();
  let sseCache = "";
  let sseErrors = 0;
  const sseInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    try {
      sseCache = freshPayload(db);
      sseErrors = 0;
      for (const client of sseClients) {
        client.write(`data: ${sseCache}\n\n`);
      }
    } catch (err) {
      sseErrors++;
      if (sseErrors <= 3) {
        console.error(`[dashboard] SSE payload error (${sseErrors}):`, (err as Error).message);
      }
    }
  }, SSE_INTERVAL_MS);

  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    try {
      // Login/logout endpoints are always accessible (they handle auth themselves)
      if (url.pathname === "/api/login" && req.method === "POST") {
        const body = await readBody(req);
        let token: string | undefined;
        try {
          token = JSON.parse(body).token;
        } catch {
          json(res, { error: "Invalid JSON" }, 400);
          return;
        }
        if (!authToken || token === authToken) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `polyfarm_token=${authToken}; HttpOnly; SameSite=Strict; Path=/`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          json(res, { error: "Invalid token" }, 401);
        }
        return;
      }

      if (url.pathname === "/api/logout" && req.method === "POST") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "polyfarm_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Auth gate — all other endpoints require auth when token is configured
      if (!isAuthorized(req)) {
        // Unauthenticated GET / → serve login page
        if (url.pathname === "/" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(loginPage);
          return;
        }
        // Unauthenticated API calls → 401
        json(res, { error: "Unauthorized" }, 401);
        return;
      }

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
