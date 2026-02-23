import { Command } from "commander";
import chalk from "chalk";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { fetchGammaMarkets } from "../../discovery/gamma.js";
import { filterRewardMarkets } from "../../discovery/rewards.js";
import { placeOrdersForMarkets } from "../../orders/placer.js";
import { WsConnectionManager } from "../../safety/websocket.js";
import { SafetyMonitor } from "../../safety/monitor.js";

export const runCommand = new Command("run")
  .description("Start the liquidity farming daemon")
  .requiredOption("--budget <usdc>", "Total USDC budget to deploy")
  .option("--spread <cents>", "Distance from midpoint in cents", "5")
  .option("--max-markets <n>", "Maximum number of markets", "10")
  .option("--danger-zone <cents>", "Danger zone distance in cents", "2")
  .option("--min-size <shares>", "Override minimum order size (default: from API)")
  .action(async (opts) => {
    const budget = parseFloat(opts.budget);
    const spreadCents = parseFloat(opts.spread);
    const maxMarkets = parseInt(opts.maxMarkets);
    const dangerZoneCents = parseFloat(opts.dangerZone);
    const minSizeOverride = opts.minSize ? parseFloat(opts.minSize) : undefined;

    if (isNaN(budget) || budget <= 0) {
      console.error(chalk.red("--budget must be a positive number"));
      process.exit(1);
    }

    let rawDb: ReturnType<typeof createDatabase> | null = null;
    let monitor: SafetyMonitor | null = null;

    try {
      const env = loadEnv();
      rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);

      console.log(chalk.bold("Starting PolyFarm daemon...\n"));
      console.log(`  Budget: $${budget} USDC`);
      console.log(`  Spread: ${spreadCents}c from midpoint`);
      console.log(`  Danger zone: ${dangerZoneCents}c`);
      if (minSizeOverride !== undefined) {
        console.log(`  Min size override: ${minSizeOverride} shares`);
      }
      console.log();

      // Auth
      const auth = await deriveOrLoadCreds(env, db);
      console.log(chalk.green(`Authenticated as ${auth.wallet.address}\n`));

      // Discover markets
      console.log("Discovering reward markets...");
      const gammaMarkets = await fetchGammaMarkets(env.gammaApiUrl);
      const rewardMarkets = filterRewardMarkets(gammaMarkets);
      const targetMarkets = rewardMarkets.slice(0, maxMarkets);

      if (targetMarkets.length === 0) {
        console.log(chalk.yellow("No reward markets found. Exiting."));
        return;
      }

      console.log(chalk.green(`Found ${targetMarkets.length} reward markets\n`));

      // Start session
      const sessionId = db.startSession(budget, spreadCents);
      db.updateSessionStats(sessionId, { markets_count: targetMarkets.length });

      // Place orders
      console.log("Placing orders...");
      const placed = await placeOrdersForMarkets(
        auth.clobClient,
        db,
        targetMarkets,
        budget,
        spreadCents,
        minSizeOverride,
      );

      console.log(chalk.green(`Placed ${placed.length} orders across ${targetMarkets.length} markets\n`));
      db.updateSessionStats(sessionId, { orders_placed: placed.length });

      for (const order of placed) {
        console.log(
          `  ${order.side === "BUY" ? chalk.green("BID") : chalk.red("ASK")} ` +
            `${order.price.toFixed(2)} x ${order.size.toFixed(1)} ` +
            `[${order.orderId.slice(0, 8)}...]`,
        );
      }

      // Start safety monitor
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
        const session = db.getActiveSession();
        if (session) {
          db.updateSessionStats(session.id, {
            orders_cancelled: (session.orders_cancelled || 0) + 1,
          });
        }
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
          await auth.clobClient.cancelAll();
          db.cancelAllOrders();
          console.log(chalk.green("All orders cancelled via API"));
        } catch (cancelErr) {
          console.error(chalk.red("Failed to cancel orders!"), cancelErr);
        }
        db.endSession(sessionId, "PANIC");
        process.exit(1);
      });

      monitor.start();
      console.log(chalk.green("Safety monitor active. Press Ctrl+C to stop.\n"));

      // Heartbeat loop (keep orders alive)
      let heartbeatFailures = 0;
      let heartbeatId: string | null = null;
      const MAX_HEARTBEAT_FAILURES = 5;
      const HEARTBEAT_INTERVAL_MS = 8000;
      const heartbeatInterval = setInterval(async () => {
        try {
          const response = await auth.clobClient.postHeartbeat(heartbeatId);
          heartbeatId = response.heartbeat_id;
          heartbeatFailures = 0;
        } catch (err) {
          heartbeatFailures++;
          console.log(chalk.yellow(`Heartbeat failed (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${(err as Error).message}`));
          if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
            console.log(chalk.red.bold("Too many heartbeat failures, triggering panic..."));
            monitor?.emit("panic", new Error("Heartbeat failed repeatedly"));
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Graceful shutdown
      const shutdown = async (signal: string) => {
        console.log(chalk.bold(`\n${signal} received. Shutting down gracefully...`));
        clearInterval(heartbeatInterval);
        monitor?.stop();

        console.log("Cancelling all live orders...");
        try {
          await auth.clobClient.cancelAll();
          db.cancelAllOrders();
          console.log(chalk.green("All orders cancelled."));
        } catch (err) {
          console.error(chalk.red("Warning: Failed to cancel some orders"), err);
        }

        db.endSession(sessionId, "STOPPED");
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
