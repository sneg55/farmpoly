import { Command } from "commander";
import chalk from "chalk";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { fetchGammaMarkets } from "../../discovery/gamma.js";
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
import type { ClobClient } from "@polymarket/clob-client";

export const runCommand = new Command("run")
  .description("Start the liquidity farming daemon")
  .requiredOption("--budget <usdc>", "Total USDC budget to deploy")
  .option("--spread <cents>", "Distance from midpoint in cents", "5")
  .option("--max-markets <n>", "Maximum number of markets", "10")
  .option("--danger-zone <cents>", "Danger zone distance in cents", "2")
  .option("--min-size <shares>", "Override minimum order size (default: from API)")
  .option("--rebalance-interval <minutes>", "Check for better markets every N minutes (0 to disable)", "60")
  .option("--min-daily-yield <percent>", "Minimum daily yield % to consider", "0")
  .option("--min-rebalance-improvement <percent>", "Minimum profitability improvement to trigger rebalance", "20")
  .option("--no-smart-allocation", "Use equal allocation instead of profitability-weighted")
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

    if (isNaN(budget) || budget <= 0) {
      console.error(chalk.red("--budget must be a positive number"));
      process.exit(1);
    }

    let rawDb: ReturnType<typeof createDatabase> | null = null;
    let monitor: SafetyMonitor | null = null;
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
          // Mark them cancelled in DB anyway so they don't confuse us
          db.cancelAllOrders();
        }
      }

      /**
       * Discover and select markets based on profitability
       */
      async function discoverAndAllocate(): Promise<{ 
        markets: RewardMarket[]; 
        allocations: AllocationResult[];
      }> {
        const gammaMarkets = await fetchGammaMarkets(env.gammaApiUrl);
        const rewardMarkets = filterRewardMarkets(gammaMarkets, {
          minDailyYield,
          sortByProfitability: true,
          spreadCents,
        });

        if (useSmartAllocation) {
          // Smart allocation based on profitability
          const allocations = allocateCapitalSmart(rewardMarkets, budget, maxMarkets);
          const markets = allocations.map(a => a.market);
          return { markets, allocations };
        } else {
          // Equal allocation (legacy behavior)
          const perSideMax = budget / 2;
          const affordable = rewardMarkets.filter((m) => {
            const minShares = minSizeOverride ?? m.minSize;
            const costPerSide = minShares * m.midpoint;
            return costPerSide <= perSideMax;
          });
          const markets = (affordable.length > 0 ? affordable : rewardMarkets).slice(0, maxMarkets);
          return { markets, allocations: [] };
        }
      }

      /**
       * Place orders for selected markets
       */
      async function deployCapital(
        markets: RewardMarket[],
        allocations: AllocationResult[],
      ): Promise<number> {
        console.log("Placing orders...");
        
        // If we have allocations, use them for capital distribution
        // Otherwise fall back to equal distribution
        const placed = await placeOrdersForMarkets(
          auth.clobClient,
          db,
          markets,
          budget,
          spreadCents,
          minSizeOverride,
          useSmartAllocation ? allocations : undefined,
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
        console.log(chalk.bold("\n🔄 Checking for rebalancing opportunities..."));
        
        const gammaMarkets = await fetchGammaMarkets(env.gammaApiUrl);
        const allRewardMarkets = filterRewardMarkets(gammaMarkets, {
          minDailyYield,
          sortByProfitability: true,
          spreadCents,
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
        const { markets, allocations } = await discoverAndAllocate();
        
        if (markets.length === 0) {
          console.log(chalk.yellow("  No markets available after rebalance. Keeping position flat."));
          currentMarkets = [];
          return;
        }

        // Deploy to new markets
        const orderCount = await deployCapital(markets, allocations);
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
        
        // Log expected daily earnings
        if (allocations.length > 0) {
          const totalDaily = allocations.reduce((sum, a) => sum + a.expectedDailyReward, 0);
          console.log(chalk.dim(`  Expected: $${totalDaily.toFixed(2)}/day`));
        }
      }

      // Initial discovery
      console.log("Discovering reward markets...");
      const { markets: targetMarkets, allocations } = await discoverAndAllocate();

      if (targetMarkets.length === 0) {
        console.log(chalk.yellow("No reward markets found. Exiting."));
        return;
      }

      console.log(chalk.green(`Found ${targetMarkets.length} reward markets\n`));

      // Log profitability summary
      if (allocations.length > 0) {
        console.log(chalk.dim("Capital allocation:"));
        for (const alloc of allocations.slice(0, 5)) {
          console.log(chalk.dim(
            `  ${alloc.market.question.slice(0, 40)}... ` +
            `$${alloc.allocatedUsdc.toFixed(0)} → $${alloc.expectedDailyReward.toFixed(2)}/day`
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

      currentMarkets = targetMarkets;

      // Start session
      const sessionId = db.startSession(budget, spreadCents);
      db.updateSessionStats(sessionId, { markets_count: targetMarkets.length });

      // Deploy capital
      const placedCount = await deployCapital(targetMarkets, allocations);

      console.log(chalk.green(`Placed ${placedCount} orders across ${targetMarkets.length} markets\n`));
      db.updateSessionStats(sessionId, { orders_placed: placedCount });

      // Start safety monitor (rebuildOrderIndex is called automatically in start())
      console.log(chalk.bold("\nStarting safety monitor..."));
      const wsManager = new WsConnectionManager();
      monitor = new SafetyMonitor(auth.clobClient, db, wsManager, {
        dangerZoneCents,
      });

      // Subscribe to all market tokens
      const subscribedTokens = new Set<string>();
      for (const market of targetMarkets) {
        if (!subscribedTokens.has(market.tokenIdYes)) {
          monitor.subscribeToMarket(market.tokenIdYes);
          subscribedTokens.add(market.tokenIdYes);
        }
      }

      // Monitor events
      monitor.on("midpoint", ({ assetId, midpoint }) => {
        // Quiet update, only log on changes
      });

      monitor.on("danger", ({ orderId, orderPrice, midpoint, distance }) => {
        console.log(
          chalk.yellow(
            `DANGER: Order ${orderId.slice(0, 8)}... @ ${orderPrice.toFixed(2)} ` +
              `within ${(distance * 100).toFixed(1)}c of midpoint ${midpoint.toFixed(2)}`,
          ),
        );
      });

      monitor.on("cancelled", ({ orderId, latencyMs }) => {
        console.log(
          chalk.red(`CANCELLED: ${orderId.slice(0, 8)}... (${latencyMs}ms)`),
        );
        db.incrementCancelled(sessionId);
      });

      monitor.on("slow_cancel", ({ orderId, latencyMs }) => {
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
      console.log(chalk.green("Safety monitor active. Press Ctrl+C to stop.\n"));

      // Heartbeat loop (keep orders alive — server timeout is 10s)
      // NOTE: The SDK's HTTP helpers return errors as { error: "..." } instead of throwing.
      // We must check response.error BEFORE using response.heartbeat_id.
      let heartbeatFailures = 0;
      // API expects "" (empty string) for first heartbeat, NOT null.
      // SDK does `heartbeatId ?? null` — empty string passes through correctly.
      let heartbeatId: string = "";
      let consecutiveChainFailures = 0;
      let heartbeatLoggedFirstSuccess = false;
      let lastHeartbeatLogTime = 0;
      const MAX_HEARTBEAT_FAILURES = 5;
      const MAX_CHAIN_FAILURES = 3; // After 3 chain failures, restart with empty string
      const HEARTBEAT_INTERVAL_MS = 5000; // 5s for safety margin against 10s server timeout
      const HEARTBEAT_LOG_INTERVAL_MS = 60_000; // Log status once per minute
      const heartbeatInterval = setInterval(async () => {
        try {
          // If chaining has failed repeatedly, fall back to always starting fresh
          const sendId = consecutiveChainFailures >= MAX_CHAIN_FAILURES ? "" : heartbeatId;
          const response = await auth.clobClient.postHeartbeat(sendId) as
            { heartbeat_id?: string; error?: string };

          // SDK returns errors as values, not exceptions
          if (response.error) {
            const errMsg = response.error;
            if (errMsg.includes("Invalid Heartbeat ID") || errMsg.includes("invalid heartbeat")) {
              if (consecutiveChainFailures >= MAX_CHAIN_FAILURES) {
                // Already in fallback mode and even "" is rejected — this is a real failure
                heartbeatFailures++;
                if (heartbeatFailures === 1) {
                  console.log(chalk.yellow("Heartbeat: fresh start also rejected — API may require auth refresh"));
                }
              } else {
                // Chain expired or invalid — start fresh with empty string
                consecutiveChainFailures++;
                heartbeatId = "";
                if (consecutiveChainFailures === MAX_CHAIN_FAILURES) {
                  console.log(chalk.dim("Heartbeat chaining disabled after repeated failures (restarting each time)"));
                }
              }
              return;
            }
            // Other API errors
            heartbeatFailures++;
            console.log(chalk.yellow(`Heartbeat error (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${errMsg}`));
            console.log(chalk.dim(`  Response: ${JSON.stringify(response)}`));
          } else if (response.heartbeat_id) {
            // Success — store the chained ID
            heartbeatId = response.heartbeat_id;
            heartbeatFailures = 0;
            consecutiveChainFailures = 0;

            // Debug: log first success response
            if (!heartbeatLoggedFirstSuccess) {
              heartbeatLoggedFirstSuccess = true;
              console.log(chalk.dim(`Heartbeat OK: ${JSON.stringify(response)}`));
            }

            // Periodic status log (once per minute)
            const now = Date.now();
            if (now - lastHeartbeatLogTime >= HEARTBEAT_LOG_INTERVAL_MS) {
              lastHeartbeatLogTime = now;
              console.log(chalk.dim(`Heartbeat alive (id: ${heartbeatId.slice(0, 8)}...)`));
            }
          } else {
            // Unexpected response shape
            heartbeatFailures++;
            console.log(chalk.yellow(`Heartbeat unexpected response (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${JSON.stringify(response)}`));
          }

          if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
            console.log(chalk.red.bold("Too many heartbeat failures, triggering panic..."));
            monitor?.emit("panic", new Error("Heartbeat failed repeatedly"));
          }
        } catch (err) {
          // Genuine exceptions (network timeout, etc.)
          heartbeatFailures++;
          const errMsg = (err as Error).message || String(err);
          console.log(chalk.yellow(`Heartbeat exception (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${errMsg}`));
          if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
            console.log(chalk.red.bold("Too many heartbeat failures, triggering panic..."));
            monitor?.emit("panic", new Error("Heartbeat failed repeatedly"));
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Rebalancing loop (check for better markets periodically)
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

      // Graceful shutdown
      const shutdown = async (signal: string) => {
        console.log(chalk.bold(`\n${signal} received. Shutting down gracefully...`));
        clearInterval(heartbeatInterval);
        if (rebalanceInterval) clearInterval(rebalanceInterval);
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
      monitor?.stop();
      rawDb?.close();
      process.exit(1);
    }
  });
