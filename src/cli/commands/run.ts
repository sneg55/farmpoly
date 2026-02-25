import { Command } from "commander";
import chalk from "chalk";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { fetchGammaMarkets, type GammaMarket } from "../../discovery/gamma.js";
import {
  filterRewardMarkets,
  allocateCapitalSmart,
  shouldRebalance,
  type RewardMarket,
  type AllocationResult,
} from "../../discovery/rewards.js";
import { placeOrdersForMarkets } from "../../orders/placer.js";
import { cancelAllOrders, panicCancelAll, gracefulShutdown } from "../../orders/lifecycle.js";
import { WsConnectionManager } from "../../safety/websocket.js";
import { SafetyMonitor } from "../../safety/monitor.js";
import { detectTrend, type TrendDirection } from "../../intelligence/trend.js";
import { FillDetector, type FillEvent } from "../../hedge/detector.js";
import { executeHedge } from "../../hedge/executor.js";
import type { ClobClient } from "@polymarket/clob-client";

export const runCommand = new Command("run")
  .description("Start the liquidity farming daemon")
  .requiredOption("--budget <usdc>", "Total USDC budget to deploy")
  .option("--spread <cents>", "Distance from midpoint in cents", "5")
  .option("--max-markets <n>", "Maximum number of markets", "10")
  .option("--danger-zone <cents>", "Danger zone distance in cents", "3")
  .option("--min-size <shares>", "Override minimum order size (default: from API)")
  .option("--rebalance-interval <minutes>", "Check for better markets every N minutes (0 to disable)", "60")
  .option("--min-daily-yield <percent>", "Minimum daily yield % to consider", "0")
  .option("--min-rebalance-improvement <percent>", "Minimum profitability improvement to trigger rebalance", "20")
  .option("--no-smart-allocation", "Use equal allocation instead of profitability-weighted")
  .option("--hedge-fills", "Enable hedge-on-fill (default: enabled)", true)
  .option("--no-hedge-fills", "Disable hedge-on-fill")
  .option("--max-hedge-cost <cents>", "Max extra cents for hedge buy", "5")
  .option("--max-volatility <cents>", "Skip markets with >N cents 24h change", "5")
  .option("--placement-mode <mode>", "adaptive | bid-only | ask-only | both", "adaptive")
  .option("--warmup-seconds <s>", "Collect WS data before placing orders", "5")
  .action(async (opts) => {
    const budget = parseFloat(opts.budget);
    const spreadCents = parseFloat(opts.spread);
    const maxMarkets = parseInt(opts.maxMarkets);
    const dangerZoneCents = parseFloat(opts.dangerZone);
    const minSizeOverride = opts.minSize ? parseFloat(opts.minSize) : undefined;
    const rebalanceIntervalMin = parseInt(opts.rebalanceInterval);
    const minDailyYield = parseFloat(opts.minDailyYield);
    const minRebalanceImprovement = parseFloat(opts.minRebalanceImprovement);
    const useSmartAllocation = opts.smartAllocation !== false;
    const hedgeFills = opts.hedgeFills !== false;
    const maxHedgeCostCents = parseFloat(opts.maxHedgeCost);
    const maxVolatilityCents = parseFloat(opts.maxVolatility);
    const placementMode: string = opts.placementMode;
    const warmupSeconds = parseInt(opts.warmupSeconds);

    if (isNaN(budget) || budget <= 0) {
      console.error(chalk.red("--budget must be a positive number"));
      process.exit(1);
    }

    let rawDb: ReturnType<typeof createDatabase> | null = null;
    let monitor: SafetyMonitor | null = null;
    let fillDetector: FillDetector | null = null;
    let rebalanceInterval: NodeJS.Timeout | null = null;
    let currentMarkets: RewardMarket[] = [];

    try {
      const env = loadEnv();
      rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);

      console.log(chalk.bold("Starting PolyFarm daemon...\n"));
      console.log(`  Budget: $${budget} USDC`);
      console.log(`  Spread: ${spreadCents}c from midpoint`);
      console.log(`  Danger zone: ${dangerZoneCents}c`);
      console.log(`  Smart allocation: ${useSmartAllocation ? chalk.green("ON") : chalk.yellow("OFF")}`);
      console.log(`  Hedge fills: ${hedgeFills ? chalk.green("ON") : chalk.yellow("OFF")}`);
      console.log(`  Placement mode: ${placementMode}`);
      console.log(`  Max volatility: ${maxVolatilityCents}c`);
      console.log(`  WS warmup: ${warmupSeconds}s`);
      if (minDailyYield > 0) {
        console.log(`  Min daily yield: ${minDailyYield}%`);
      }
      if (rebalanceIntervalMin > 0) {
        console.log(`  Rebalance check: every ${rebalanceIntervalMin} minutes`);
      }
      if (minSizeOverride !== undefined) {
        console.log(`  Min size override: ${minSizeOverride} shares`);
      }
      console.log();

      // Auth
      const auth = await deriveOrLoadCreds(env, db);
      console.log(chalk.green(`Authenticated as ${auth.wallet.address}\n`));

      // Clean up stale orders from previous sessions to free locked collateral
      const staleOrders = db.getLiveOrders();
      if (staleOrders.length > 0) {
        console.log(chalk.dim(`Cleaning up ${staleOrders.length} stale orders from previous session...`));
        try {
          await auth.clobClient.cancelAll();
          db.cancelAllOrders();
          console.log(chalk.dim("Stale orders cancelled."));
        } catch (err) {
          console.log(chalk.yellow(`Warning: failed to cancel stale orders: ${(err as Error).message}`));
          db.cancelAllOrders();
        }
      }

      // ───────────────────────────────────────────────────
      // WS-FIRST: Start WebSocket + SafetyMonitor BEFORE placing orders
      // ───────────────────────────────────────────────────
      console.log(chalk.bold("Starting safety monitor (WS-first)..."));
      const wsManager = new WsConnectionManager();
      monitor = new SafetyMonitor(auth.clobClient, db, wsManager, {
        dangerZoneCents,
      });

      // Monitor events
      monitor.on("midpoint", () => {
        // Quiet update — midpoints collected during warmup
      });

      monitor.on("warning", ({ orderId, orderPrice, midpoint, distance }: { orderId: string; orderPrice: number; midpoint: number; distance: number }) => {
        console.log(
          chalk.yellow(
            `WARNING: Order ${orderId.slice(0, 8)}... @ ${orderPrice.toFixed(2)} ` +
              `within ${(distance * 100).toFixed(1)}c of midpoint ${midpoint.toFixed(2)} (yellow zone)`,
          ),
        );
      });

      monitor.on("danger", ({ orderId, orderPrice, midpoint, distance }: { orderId: string; orderPrice: number; midpoint: number; distance: number }) => {
        console.log(
          chalk.red(
            `DANGER: Order ${orderId.slice(0, 8)}... @ ${orderPrice.toFixed(2)} ` +
              `within ${(distance * 100).toFixed(1)}c of midpoint ${midpoint.toFixed(2)} (red zone)`,
          ),
        );
      });

      monitor.on("cancelled", ({ orderId, latencyMs }: { orderId: string; latencyMs: number }) => {
        console.log(
          chalk.red(`CANCELLED: ${orderId.slice(0, 8)}... (${latencyMs}ms)`),
        );
      });

      monitor.on("slow_cancel", ({ orderId, latencyMs }: { orderId: string; latencyMs: number }) => {
        console.log(
          chalk.red.bold(`SLOW CANCEL: ${orderId.slice(0, 8)}... took ${latencyMs}ms (>200ms)`),
        );
      });

      monitor.on("panic", async (err: Error) => {
        console.log(chalk.red.bold(`\nPANIC: ${err.message}`));
        console.log("Cancelling all orders...");
        try {
          await panicCancelAll(auth.clobClient, db, sessionId);
          console.log(chalk.green("All orders cancelled via API"));
        } catch (cancelErr) {
          console.error(chalk.red("Failed to cancel orders!"), cancelErr);
        }
        process.exit(1);
      });

      monitor.start();
      console.log(chalk.green("Safety monitor active.\n"));

      // Warm up: wait for WS midpoints to populate
      console.log(chalk.dim(`Warming up WebSocket for ${warmupSeconds}s...`));
      await new Promise((r) => setTimeout(r, warmupSeconds * 1000));

      /**
       * Compute trends for markets based on Gamma API volatility fields
       */
      function computeTrends(
        gammaMarkets: GammaMarket[],
        markets: RewardMarket[],
      ): Map<string, TrendDirection> {
        const trendMap = new Map<string, TrendDirection>();
        const gammaMap = new Map<string, GammaMarket>();
        for (const g of gammaMarkets) {
          gammaMap.set(g.conditionId, g);
        }

        for (const market of markets) {
          if (placementMode === "bid-only") {
            trendMap.set(market.conditionId, "DOWN");
          } else if (placementMode === "ask-only") {
            trendMap.set(market.conditionId, "UP");
          } else if (placementMode === "both") {
            trendMap.set(market.conditionId, "SIDEWAYS");
          } else {
            // adaptive: use trend detection
            const gamma = gammaMap.get(market.conditionId);
            if (gamma) {
              const trend = detectTrend(gamma.oneHourPriceChange, gamma.oneDayPriceChange);
              trendMap.set(market.conditionId, trend);
            } else {
              trendMap.set(market.conditionId, "SIDEWAYS");
            }
          }
        }
        return trendMap;
      }

      /**
       * Discover and select markets based on profitability + stability
       */
      async function discoverAndAllocate(): Promise<{
        markets: RewardMarket[];
        allocations: AllocationResult[];
        gammaMarkets: GammaMarket[];
      }> {
        const gammaMarkets = await fetchGammaMarkets(env.gammaApiUrl);
        const rewardMarkets = filterRewardMarkets(gammaMarkets, {
          minDailyYield,
          sortByProfitability: true,
          spreadCents,
          maxVolatilityCents,
        });

        if (rewardMarkets.length === 0 && gammaMarkets.length > 0) {
          console.log(chalk.yellow("All markets filtered out by stability/volatility checks."));
        }

        if (useSmartAllocation) {
          const allocations = allocateCapitalSmart(rewardMarkets, budget, maxMarkets);
          const markets = allocations.map(a => a.market);
          return { markets, allocations, gammaMarkets };
        } else {
          const perSideMax = budget / 2;
          const affordable = rewardMarkets.filter((m) => {
            const minShares = minSizeOverride ?? m.minSize;
            const costPerSide = minShares * m.midpoint;
            return costPerSide <= perSideMax;
          });
          const markets = (affordable.length > 0 ? affordable : rewardMarkets).slice(0, maxMarkets);
          return { markets, allocations: [], gammaMarkets };
        }
      }

      /**
       * Place orders for selected markets with trend-aware one-sided placement
       */
      async function deployCapital(
        markets: RewardMarket[],
        allocations: AllocationResult[],
        trendByMarket?: Map<string, TrendDirection>,
      ): Promise<number> {
        console.log("Placing orders...");

        const placed = await placeOrdersForMarkets(
          auth.clobClient,
          db,
          markets,
          budget,
          spreadCents,
          minSizeOverride,
          useSmartAllocation ? allocations : undefined,
          trendByMarket,
        );

        for (const order of placed) {
          console.log(
            `  ${order.side === "BUY" ? chalk.green("BID") : chalk.red("ASK")} ` +
              `${order.price.toFixed(2)} x ${order.size.toFixed(1)} ` +
              `[${order.orderId.slice(0, 8)}...]`,
          );
        }

        return placed.length;
      }

      /**
       * Cancel all current orders and redeploy to new markets
       */
      async function performRebalance(): Promise<void> {
        console.log(chalk.bold("\nChecking for rebalancing opportunities..."));

        const gammaMarkets = await fetchGammaMarkets(env.gammaApiUrl);
        const allRewardMarkets = filterRewardMarkets(gammaMarkets, {
          minDailyYield,
          sortByProfitability: true,
          spreadCents,
          maxVolatilityCents,
        });

        const decision = shouldRebalance(
          currentMarkets,
          allRewardMarkets,
          maxMarkets,
          minRebalanceImprovement,
        );

        console.log(chalk.dim(`  Decision: ${decision.reason}`));

        if (!decision.shouldRebalance) {
          console.log(chalk.dim("  No rebalancing needed.\n"));
          return;
        }

        console.log(chalk.yellow(`  Rebalancing for ${decision.profitabilityGain.toFixed(1)}% improvement!`));
        console.log(chalk.dim(`  Adding ${decision.addMarkets.length} markets, removing ${decision.removeMarkets.length}`));

        // Cancel all existing orders
        console.log("  Cancelling existing orders...");
        try {
          await cancelAllOrders(auth.clobClient, db);
          console.log(chalk.green("  Orders cancelled."));
        } catch (err) {
          console.error(chalk.red("  Failed to cancel orders:"), err);
          return;
        }

        // Rediscover and allocate with fresh data
        const { markets, allocations, gammaMarkets: freshGamma } = await discoverAndAllocate();

        if (markets.length === 0) {
          console.log(chalk.yellow("  No markets available after rebalance. Keeping position flat."));
          currentMarkets = [];
          return;
        }

        // Compute trends for new markets
        const trendByMarket = computeTrends(freshGamma, markets);

        // Deploy to new markets
        const orderCount = await deployCapital(markets, allocations, trendByMarket);
        currentMarkets = markets;

        // Update monitor subscriptions and rebuild order index
        if (monitor) {
          monitor.rebuildOrderIndex();
          const subscribedTokens = new Set<string>();
          for (const market of markets) {
            if (!subscribedTokens.has(market.tokenIdYes)) {
              monitor.subscribeToMarket(market.tokenIdYes);
              subscribedTokens.add(market.tokenIdYes);
            }
          }
        }

        console.log(chalk.green(`  Rebalanced: ${orderCount} orders across ${markets.length} markets\n`));

        if (allocations.length > 0) {
          const totalDaily = allocations.reduce((sum, a) => sum + a.expectedDailyReward, 0);
          console.log(chalk.dim(`  Expected: $${totalDaily.toFixed(2)}/day`));
        }
      }

      // ───────────────────────────────────────────────────
      // DISCOVERY + TREND DETECTION
      // ───────────────────────────────────────────────────
      console.log("Discovering reward markets (with stability filtering)...");
      const { markets: targetMarkets, allocations, gammaMarkets } = await discoverAndAllocate();

      if (targetMarkets.length === 0) {
        console.log(chalk.yellow("No reward markets found. Exiting."));
        monitor.stop();
        rawDb?.close();
        return;
      }

      console.log(chalk.green(`Found ${targetMarkets.length} reward markets\n`));

      // Log profitability summary
      if (allocations.length > 0) {
        console.log(chalk.dim("Capital allocation:"));
        for (const alloc of allocations.slice(0, 5)) {
          console.log(chalk.dim(
            `  ${alloc.market.question.slice(0, 40)}... ` +
            `$${alloc.allocatedUsdc.toFixed(0)} -> $${alloc.expectedDailyReward.toFixed(2)}/day ` +
            `(stability: ${(alloc.market.stabilityScore * 100).toFixed(0)}%)`
          ));
        }
        if (allocations.length > 5) {
          console.log(chalk.dim(`  ... and ${allocations.length - 5} more`));
        }
        const totalDaily = allocations.reduce((sum, a) => sum + a.expectedDailyReward, 0);
        console.log(chalk.green(
          `\nExpected earnings: $${totalDaily.toFixed(2)}/day = ` +
          `$${(totalDaily * 30).toFixed(0)}/month = ` +
          `${((totalDaily * 365 / budget) * 100).toFixed(1)}% APY\n`
        ));
      }

      // Compute trends
      const trendByMarket = computeTrends(gammaMarkets, targetMarkets);
      for (const [conditionId, trend] of trendByMarket) {
        if (trend !== "SIDEWAYS") {
          const market = targetMarkets.find(m => m.conditionId === conditionId);
          if (market) {
            console.log(chalk.dim(`  Trend: ${market.question.slice(0, 40)}... → ${trend}`));
          }
        }
      }

      currentMarkets = targetMarkets;

      // Start session
      const sessionId = db.startSession(budget, spreadCents);
      db.updateSessionStats(sessionId, { markets_count: targetMarkets.length });

      // Subscribe monitor to all market tokens
      const subscribedTokens = new Set<string>();
      for (const market of targetMarkets) {
        if (!subscribedTokens.has(market.tokenIdYes)) {
          monitor.subscribeToMarket(market.tokenIdYes);
          subscribedTokens.add(market.tokenIdYes);
        }
      }

      // ───────────────────────────────────────────────────
      // DEPLOY CAPITAL (one-sided based on trend)
      // ───────────────────────────────────────────────────
      const placedCount = await deployCapital(targetMarkets, allocations, trendByMarket);

      console.log(chalk.green(`Placed ${placedCount} orders across ${targetMarkets.length} markets\n`));
      db.updateSessionStats(sessionId, { orders_placed: placedCount });

      // Rebuild order index now that orders are placed
      monitor.rebuildOrderIndex();

      // ───────────────────────────────────────────────────
      // FILL DETECTOR (hedge-on-fill)
      // ───────────────────────────────────────────────────
      if (hedgeFills) {
        fillDetector = new FillDetector(auth.clobClient, db);

        fillDetector.on("fill", async (fill: FillEvent) => {
          console.log(
            chalk.yellow.bold(
              `\nFILL DETECTED: ${fill.side} ${fill.filledSize.toFixed(2)} @ ${fill.filledPrice.toFixed(2)} ` +
              `[order: ${fill.orderId.slice(0, 8)}...]`
            ),
          );

          // 1. Update order fill in DB
          db.updateOrderFill(fill.orderId, fill.filledSize);
          db.incrementFilled(sessionId);

          // 2. Cancel counterpart orders to prevent double exposure
          if (monitor) {
            const cancelled = await monitor.cancelCounterpartOrders(fill.conditionId, fill.side);
            if (cancelled.length > 0) {
              console.log(chalk.dim(`  Cancelled ${cancelled.length} counterpart order(s)`));
              db.incrementCancelled(sessionId, cancelled.length);
            }
          }

          // 3. Insert pending hedge record
          const hedgeId = db.insertHedge({
            trade_id: fill.tradeId,
            order_id: fill.orderId,
            condition_id: fill.conditionId,
            fill_side: fill.side,
            fill_size: fill.filledSize,
            fill_price: fill.filledPrice,
            status: "PENDING",
          });

          // 4. Execute hedge (buy opposite + merge)
          try {
            const result = await executeHedge(
              auth.clobClient,
              auth.wallet,
              env,
              db,
              fill,
              { maxHedgeCostCents: maxHedgeCostCents },
            );

            // 5. Update hedge record
            db.updateHedge({
              id: hedgeId,
              hedge_order_id: result.hedgeOrderId,
              hedge_price: result.hedgePrice,
              hedge_size: result.hedgeSize,
              merge_amount: result.mergeAmount,
              merge_tx_hash: result.mergeTxHash,
              pnl_cents: result.pnlCents,
              status: result.status,
            });

            // 6. Log result with color coding
            if (result.status === "HEDGED") {
              const pnlColor = result.pnlCents >= 0 ? chalk.green : chalk.red;
              console.log(
                chalk.green(`  HEDGED: `) +
                `bought opposite @ ${result.hedgePrice?.toFixed(2) ?? "?"} ` +
                `merged: ${result.mergeAmount.toFixed(2)} ` +
                pnlColor(`P&L: ${result.pnlCents >= 0 ? "+" : ""}${result.pnlCents.toFixed(1)}c`) +
                (result.mergeTxHash ? chalk.dim(` [tx: ${result.mergeTxHash.slice(0, 10)}...]`) : ""),
              );
            } else {
              console.log(chalk.red(`  Hedge ${result.status}: fill exposure remains`));
            }
          } catch (err) {
            console.error(chalk.red(`  Hedge error: ${(err as Error).message}`));
            db.updateHedge({
              id: hedgeId,
              hedge_order_id: null,
              hedge_price: null,
              hedge_size: 0,
              merge_amount: 0,
              merge_tx_hash: null,
              pnl_cents: 0,
              status: "HEDGE_FAILED",
            });
          }
        });

        fillDetector.on("poll_error", (err: Error) => {
          console.log(chalk.dim(`Fill poll error: ${err.message}`));
        });

        fillDetector.start();
        console.log(chalk.green("Fill detector active (polling every 5s).\n"));
      } else {
        console.log(chalk.dim("Hedge-on-fill disabled.\n"));
      }

      console.log(chalk.green("Press Ctrl+C to stop.\n"));

      // ───────────────────────────────────────────────────
      // HEARTBEAT LOOP
      // ───────────────────────────────────────────────────
      let heartbeatFailures = 0;
      let heartbeatId: string = "";
      let consecutiveChainFailures = 0;
      let heartbeatLoggedFirstSuccess = false;
      let lastHeartbeatLogTime = 0;
      const MAX_HEARTBEAT_FAILURES = 5;
      const MAX_CHAIN_FAILURES = 3;
      const HEARTBEAT_INTERVAL_MS = 5000;
      const HEARTBEAT_LOG_INTERVAL_MS = 60_000;
      const heartbeatInterval = setInterval(async () => {
        try {
          const sendId = consecutiveChainFailures >= MAX_CHAIN_FAILURES ? "" : heartbeatId;
          const response = await auth.clobClient.postHeartbeat(sendId) as
            { heartbeat_id?: string; error?: string };

          if (response.error) {
            const errMsg = response.error;
            if (errMsg.includes("Invalid Heartbeat ID") || errMsg.includes("invalid heartbeat")) {
              if (consecutiveChainFailures >= MAX_CHAIN_FAILURES) {
                heartbeatFailures++;
                if (heartbeatFailures === 1) {
                  console.log(chalk.yellow("Heartbeat: fresh start also rejected — API may require auth refresh"));
                }
              } else {
                consecutiveChainFailures++;
                heartbeatId = "";
                if (consecutiveChainFailures === MAX_CHAIN_FAILURES) {
                  console.log(chalk.dim("Heartbeat chaining disabled after repeated failures (restarting each time)"));
                }
              }
              return;
            }
            heartbeatFailures++;
            console.log(chalk.yellow(`Heartbeat error (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${errMsg}`));
            console.log(chalk.dim(`  Response: ${JSON.stringify(response)}`));
          } else if (response.heartbeat_id) {
            heartbeatId = response.heartbeat_id;
            heartbeatFailures = 0;
            consecutiveChainFailures = 0;

            if (!heartbeatLoggedFirstSuccess) {
              heartbeatLoggedFirstSuccess = true;
              console.log(chalk.dim(`Heartbeat OK: ${JSON.stringify(response)}`));
            }

            const now = Date.now();
            if (now - lastHeartbeatLogTime >= HEARTBEAT_LOG_INTERVAL_MS) {
              lastHeartbeatLogTime = now;
              console.log(chalk.dim(`Heartbeat alive (id: ${heartbeatId.slice(0, 8)}...)`));
            }
          } else {
            heartbeatFailures++;
            console.log(chalk.yellow(`Heartbeat unexpected response (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${JSON.stringify(response)}`));
          }

          if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
            console.log(chalk.red.bold("Too many heartbeat failures, triggering panic..."));
            monitor?.emit("panic", new Error("Heartbeat failed repeatedly"));
          }
        } catch (err) {
          heartbeatFailures++;
          const errMsg = (err as Error).message || String(err);
          console.log(chalk.yellow(`Heartbeat exception (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${errMsg}`));
          if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
            console.log(chalk.red.bold("Too many heartbeat failures, triggering panic..."));
            monitor?.emit("panic", new Error("Heartbeat failed repeatedly"));
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

      // ───────────────────────────────────────────────────
      // REBALANCING LOOP
      // ───────────────────────────────────────────────────
      if (rebalanceIntervalMin > 0) {
        const REBALANCE_INTERVAL_MS = rebalanceIntervalMin * 60 * 1000;
        console.log(chalk.dim(`Next rebalance check in ${rebalanceIntervalMin} minutes`));

        rebalanceInterval = setInterval(async () => {
          try {
            await performRebalance();
          } catch (err) {
            console.error(chalk.red("Rebalance error:"), (err as Error).message);
          }
        }, REBALANCE_INTERVAL_MS);
      }

      // ───────────────────────────────────────────────────
      // GRACEFUL SHUTDOWN
      // ───────────────────────────────────────────────────
      const shutdown = async (signal: string) => {
        console.log(chalk.bold(`\n${signal} received. Shutting down gracefully...`));
        clearInterval(heartbeatInterval);
        if (rebalanceInterval) clearInterval(rebalanceInterval);
        fillDetector?.stop();
        monitor?.stop();

        console.log("Cancelling all live orders...");
        try {
          await gracefulShutdown(auth.clobClient, db, sessionId);
          console.log(chalk.green("All orders cancelled."));
        } catch (err) {
          console.error(chalk.red("Warning: Failed to cancel some orders"), err);
        }

        rawDb?.close();
        console.log(chalk.bold.green("PolyFarm stopped."));
        process.exit(0);
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));

      // Keep process alive
      await new Promise(() => {});
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      fillDetector?.stop();
      monitor?.stop();
      rawDb?.close();
      process.exit(1);
    }
  });
