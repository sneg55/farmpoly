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
  type FilterStats,
} from "../../discovery/rewards.js";
import { placeOrdersForMarkets, type MintOptions } from "../../orders/placer.js";
import { cancelAllOrders, panicCancelAll, gracefulShutdown } from "../../orders/lifecycle.js";
import { WsConnectionManager } from "../../safety/websocket.js";
import { SafetyMonitor } from "../../safety/monitor.js";
import { detectTrend, type TrendDirection } from "../../intelligence/trend.js";
import { FillDetector, type FillEvent } from "../../hedge/detector.js";
import { executeHedge } from "../../hedge/executor.js";
import { getTokenBalances, discoverHeldTokens, discoverPositions } from "../../positions/fetcher.js";
import { mergePositions } from "../../hedge/merger.js";
import { autoRedeemResolved } from "../../positions/auto-redeemer.js";
import { checkApproval } from "../../auth/approval.js";
import { ethers } from "ethers";
import { Side, OrderType } from "@polymarket/clob-client";
import type { ClobClient } from "@polymarket/clob-client";

export const runCommand = new Command("run")
  .description("Start the liquidity farming daemon")
  .requiredOption("--budget <usdc>", "Total USDC budget to deploy")
  .option("--spread <cents>", "Distance from midpoint in cents", "2")
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
  .option("--exit-on-empty", "Exit immediately if no markets found (default: retry with backoff)", false)
  .option("--no-mint", "Disable token minting (BID-only mode for ASK)")
  .option("--mint-budget-pct <percent>", "Max % of budget for minting (0-100)", "50")
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
    const exitOnEmpty: boolean = opts.exitOnEmpty === true;
    const mintEnabled: boolean = opts.mint !== false;
    const mintBudgetPct = parseFloat(opts.mintBudgetPct);
    if (isNaN(mintBudgetPct) || mintBudgetPct < 0 || mintBudgetPct > 100) {
      console.error(chalk.red("--mint-budget-pct must be a number between 0 and 100"));
      process.exit(1);
    }

    // Mutable filter values — start at user config, relax on sustained failure
    let effectiveMaxVolatility = maxVolatilityCents;
    let effectiveMinDailyYield = minDailyYield;

    if (isNaN(budget) || budget <= 0) {
      console.error(chalk.red("--budget must be a positive number"));
      process.exit(1);
    }

    let rawDb: ReturnType<typeof createDatabase> | null = null;
    let monitor: SafetyMonitor | null = null;
    let fillDetector: FillDetector | null = null;
    let rebalanceInterval: NodeJS.Timeout | null = null;
    let currentMarkets: RewardMarket[] = [];
    let sessionId: number | null = null;

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
      console.log(`  Mint tokens: ${mintEnabled ? chalk.green("ON (two-sided)") : chalk.yellow("OFF (BID-only ASK)")}`);
      if (mintEnabled) {
        console.log(`  Mint budget: ${mintBudgetPct}% of total ($${(budget * mintBudgetPct / 100).toFixed(2)})`);
      }
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

      // Check USDC approvals for minting contracts
      if (mintEnabled) {
        try {
          const approvalStatus = await checkApproval(auth.wallet, env);
          if (approvalStatus.needsConditionalTokensApproval || approvalStatus.needsNegRiskAdapterApproval) {
            console.log(chalk.yellow("WARNING: USDC not approved for minting contracts. Run 'polyfarm init --approve' first."));
            if (approvalStatus.needsConditionalTokensApproval) {
              console.log(chalk.yellow("  Missing: ConditionalTokens USDC allowance"));
            }
            if (approvalStatus.needsNegRiskAdapterApproval) {
              console.log(chalk.yellow("  Missing: NegRiskAdapter USDC allowance"));
            }
            console.log(chalk.yellow("  Minting will fail — falling back to BID-only for all markets.\n"));
          }
        } catch (err) {
          console.log(chalk.yellow(`Warning: could not check minting approvals: ${(err as Error).message}\n`));
        }
      }

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
      wsManager.on("ws_error", (err: Error) => {
        console.log(chalk.dim(`[WS] connection error: ${err.message.slice(0, 80)}`));
      });
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
          await panicCancelAll(auth.clobClient, db, sessionId ?? undefined);
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
       * Log filter funnel stats so users can see where markets get rejected
       */
      function logFilterFunnel(stats: FilterStats, affordable: number): void {
        console.log(chalk.dim("  Filter funnel:"));
        console.log(chalk.dim(`    Gamma API:         ${stats.total} markets`));
        console.log(chalk.dim(`    With rewards:      ${stats.withRewards}`));
        console.log(chalk.dim(`    With token IDs:    ${stats.withTokenIds}`));
        console.log(chalk.dim(`    Safety bounds:     ${stats.withinSafetyBounds}`));
        console.log(chalk.dim(`    Volatility cap:    ${stats.withinVolatility} (≤${effectiveMaxVolatility}c)`));
        console.log(chalk.dim(`    Stability ≥0.2:    ${stats.withinStability}`));
        console.log(chalk.dim(`    Min yield:         ${stats.withinYield} (≥${effectiveMinDailyYield}%)`));
        console.log(chalk.dim(`    Affordable ($${budget}): ${affordable}`));
      }

      /**
       * Discover and select markets based on profitability + stability
       */
      async function discoverAndAllocate(): Promise<{
        markets: RewardMarket[];
        allocations: AllocationResult[];
        gammaMarkets: GammaMarket[];
        stats: FilterStats;
      }> {
        const gammaMarkets = await fetchGammaMarkets(env.gammaApiUrl);
        const { markets: rewardMarkets, stats } = filterRewardMarkets(gammaMarkets, {
          minDailyYield: effectiveMinDailyYield,
          sortByProfitability: true,
          spreadCents,
          maxVolatilityCents: effectiveMaxVolatility,
        });

        if (useSmartAllocation) {
          const allocations = allocateCapitalSmart(rewardMarkets, budget, maxMarkets);
          const markets = allocations.map(a => a.market);
          logFilterFunnel(stats, markets.length);
          return { markets, allocations, gammaMarkets, stats };
        } else {
          const perSideMax = budget / 2;
          const affordable = rewardMarkets.filter((m) => {
            const minShares = minSizeOverride ?? m.minSize;
            const costPerSide = minShares * m.midpoint;
            return costPerSide <= perSideMax;
          });
          const markets = (affordable.length > 0 ? affordable : rewardMarkets).slice(0, maxMarkets);
          logFilterFunnel(stats, markets.length);
          return { markets, allocations: [], gammaMarkets, stats };
        }
      }

      /**
       * Place orders for selected markets with trend-aware one-sided placement
       */
      /**
       * Calculate and log estimated reward score per market
       */
      function logRewardScores(
        markets: RewardMarket[],
        spreadCents: number,
        perSideUsdc: number,
        isTwoSided: boolean,
      ): void {
        const twoSidedMultiplier = isTwoSided ? 2.0 : 1.0;

        for (const market of markets.slice(0, 5)) {
          const maxSpreadCents = market.maxSpread > 0 ? market.maxSpread * 100 : 10;
          const penalty = 1 - Math.pow(spreadCents / maxSpreadCents, 2);
          const score = perSideUsdc * penalty * twoSidedMultiplier;

          console.log(chalk.dim(
            `  ${market.question.slice(0, 45)}... ` +
            `spread: ${spreadCents}c, penalty: ${penalty.toFixed(2)}, ` +
            `two-sided: ${twoSidedMultiplier}x, score: ${score.toFixed(1)}`,
          ));
        }
      }

      async function deployCapital(
        markets: RewardMarket[],
        allocations: AllocationResult[],
        trendByMarket?: Map<string, TrendDirection>,
      ): Promise<number> {
        console.log("Placing orders...");

        const currentMintOptions: MintOptions | undefined = mintEnabled && sessionId !== null
          ? { enabled: true, wallet: auth.wallet, env, sessionId, mintBudgetPercent: mintBudgetPct }
          : undefined;

        const placed = await placeOrdersForMarkets(
          auth.clobClient,
          db,
          markets,
          budget,
          spreadCents,
          minSizeOverride,
          useSmartAllocation ? allocations : undefined,
          trendByMarket,
          currentMintOptions,
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
        const { markets: allRewardMarkets } = filterRewardMarkets(gammaMarkets, {
          minDailyYield: effectiveMinDailyYield,
          sortByProfitability: true,
          spreadCents,
          maxVolatilityCents: effectiveMaxVolatility,
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

        // Session-agnostic sweep before redeploying
        if (mintEnabled) {
          console.log("  Running inventory sweep before rebalance...");
          try {
            const recovered = await performInventorySweep();
            if (recovered > 0) {
              console.log(chalk.green(`  Recovered $${recovered.toFixed(2)} USDC from sweep`));
            }
          } catch (err) {
            console.log(chalk.yellow(`  Sweep error: ${(err as Error).message?.slice(0, 80)}`));
          }
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
      // DISCOVERY + RETRY LOOP (crash-loop prevention)
      // ───────────────────────────────────────────────────
      console.log("Discovering reward markets (with stability filtering)...");
      let discoveryResult = await discoverAndAllocate();
      let discoveryRetries = 0;
      const DISCOVERY_BASE_BACKOFF_MS = 60_000; // 1 minute
      const DISCOVERY_MAX_BACKOFF_MS = 30 * 60_000; // 30 minutes
      const DISCOVERY_RELAX_AFTER = 6; // relax filters after this many retries

      while (discoveryResult.markets.length === 0) {
        if (exitOnEmpty) {
          console.log(chalk.yellow("No reward markets found. Exiting (--exit-on-empty)."));
          monitor.stop();
          rawDb?.close();
          return;
        }

        discoveryRetries++;

        // Relax filters after sustained failure
        if (discoveryRetries > 0 && discoveryRetries % DISCOVERY_RELAX_AFTER === 0) {
          const oldVol = effectiveMaxVolatility;
          const oldYield = effectiveMinDailyYield;
          effectiveMaxVolatility = Math.min(effectiveMaxVolatility + 2, 15);
          effectiveMinDailyYield = Math.max(effectiveMinDailyYield - 0.1, 0);
          console.log(chalk.yellow(
            `Relaxing filters after ${discoveryRetries} attempts: ` +
            `volatility ${oldVol}c→${effectiveMaxVolatility}c, ` +
            `min-yield ${oldYield.toFixed(1)}%→${effectiveMinDailyYield.toFixed(1)}%`,
          ));
        }

        const backoffMs = Math.min(
          DISCOVERY_BASE_BACKOFF_MS * Math.pow(2, Math.min(discoveryRetries - 1, 4)),
          DISCOVERY_MAX_BACKOFF_MS,
        );
        const backoffMin = (backoffMs / 60_000).toFixed(1);

        console.log(chalk.yellow(
          `No reward markets found. Retrying in ${backoffMin}min ` +
          `(attempt ${discoveryRetries}, volatility cap: ${effectiveMaxVolatility}c, ` +
          `min-yield: ${effectiveMinDailyYield.toFixed(1)}%)`,
        ));

        await new Promise(r => setTimeout(r, backoffMs));
        console.log("Retrying market discovery...");
        discoveryResult = await discoverAndAllocate();
      }

      const { markets: targetMarkets, allocations, gammaMarkets } = discoveryResult;
      if (discoveryRetries > 0) {
        console.log(chalk.green(`Markets found after ${discoveryRetries} retries.`));
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
      sessionId = db.startSession(budget, spreadCents);
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

      // Log estimated reward scores
      const perSideBudget = budget / targetMarkets.length / 2;
      const hasBothSides = placedCount > targetMarkets.length; // rough heuristic
      console.log(chalk.dim("Estimated reward scores:"));
      logRewardScores(targetMarkets, spreadCents, perSideBudget, mintEnabled && hasBothSides);
      console.log();

      // Rebuild order index now that orders are placed
      monitor.rebuildOrderIndex();

      // ───────────────────────────────────────────────────
      // FILL DETECTOR (hedge-on-fill)
      // ───────────────────────────────────────────────────
      if (hedgeFills) {
        fillDetector = new FillDetector(auth.clobClient, db);
        const hedgingTrades = new Set<string>(); // single-flight per trade

        fillDetector.on("fill", async (fill: FillEvent) => {
          // Single-flight guard: skip if already processing this trade
          if (hedgingTrades.has(fill.tradeId)) return;
          hedgingTrades.add(fill.tradeId);

          // Validate fill data
          if (!isFinite(fill.filledSize) || fill.filledSize <= 0 ||
              !isFinite(fill.filledPrice) || fill.filledPrice <= 0 || fill.filledPrice >= 1) {
            console.log(chalk.yellow(`  Skipping invalid fill data: size=${fill.filledSize} price=${fill.filledPrice}`));
            hedgingTrades.delete(fill.tradeId);
            return;
          }

          console.log(
            chalk.yellow.bold(
              `\nFILL DETECTED: ${fill.side} ${fill.filledSize.toFixed(2)} @ ${fill.filledPrice.toFixed(2)} ` +
              `[order: ${fill.orderId.slice(0, 8)}...]`
            ),
          );

          try {
          // 1. Update order fill in DB
          db.updateOrderFill(fill.orderId, fill.filledSize);
          if (sessionId !== null) db.incrementFilled(sessionId);

          // 2. Cancel counterpart orders to prevent double exposure
          if (monitor) {
            const cancelled = await monitor.cancelCounterpartOrders(fill.conditionId, fill.side);
            if (cancelled.length > 0) {
              console.log(chalk.dim(`  Cancelled ${cancelled.length} counterpart order(s)`));
              if (sessionId !== null) db.incrementCancelled(sessionId, cancelled.length);
            }
          }

          // 3. Insert pending hedge record (UNIQUE on trade_id — returns 0 for duplicates)
          const hedgeId = db.insertHedge({
            trade_id: fill.tradeId,
            order_id: fill.orderId,
            condition_id: fill.conditionId,
            fill_side: fill.side,
            fill_size: fill.filledSize,
            fill_price: fill.filledPrice,
            status: "PENDING",
          });

          if (hedgeId === 0) {
            console.log(chalk.dim(`  Duplicate fill (trade ${fill.tradeId.slice(0, 8)}), skipping hedge`));
            return;
          }

          // 4. Execute hedge (buy opposite + merge, or merge from inventory)
          const result = await executeHedge(
            auth.clobClient,
            auth.wallet,
            env,
            fill,
            { maxHedgeCostCents, db, sessionId: sessionId ?? undefined },
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

            // Track NO-token timeout (16.5):
            // ASK fill with no merge = holding NO tokens → start timeout
            if (fill.side === "SELL" && result.mergeAmount === 0) {
              noTokenTimestamps.set(fill.conditionId, Date.now());
            }
            // BID fill that merged = NO tokens consumed → clear timeout
            if (fill.side === "BUY" && result.mergeAmount > 0) {
              noTokenTimestamps.delete(fill.conditionId);
            }
          } else {
            console.log(chalk.red(`  Hedge ${result.status}: fill exposure remains`));
          }
          } catch (err) {
            console.error(chalk.red(`  Hedge error: ${(err as Error).message}`));
          } finally {
            hedgingTrades.delete(fill.tradeId);
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
      let heartbeatLoggedFirstSuccess = false;
      let lastHeartbeatLogTime = 0;
      let heartbeatInFlight = false;
      let authRefreshAttempted = false;
      const MAX_HEARTBEAT_FAILURES = 10;
      const HEARTBEAT_INTERVAL_MS = 5000;
      const HEARTBEAT_LOG_INTERVAL_MS = 60_000;
      const heartbeatInterval = setInterval(async () => {
        if (heartbeatInFlight) return; // skip if previous heartbeat still in-flight
        heartbeatInFlight = true;
        try {
          // The SDK's errorHandling returns { ...responseData, status } on HTTP errors,
          // so a 400 "Invalid Heartbeat ID" response comes back as:
          //   { error: "Invalid Heartbeat ID", heartbeat_id: "corrected-uuid", status: 400 }
          // We must check for the corrected heartbeat_id even when error is present.
          const response = await auth.clobClient.postHeartbeat(heartbeatId) as
            { heartbeat_id?: string; error?: string; status?: number };

          // Case 1: Response includes a heartbeat_id (success, or error with correction)
          if (response.heartbeat_id) {
            // Use the (corrected) ID for the next call — this handles both:
            //   - Normal 200 success
            //   - 400 "Invalid Heartbeat ID" with corrected ID in body
            const wasError = !!response.error;
            heartbeatId = response.heartbeat_id;
            heartbeatFailures = 0;
            authRefreshAttempted = false;

            if (wasError) {
              console.log(chalk.dim(`Heartbeat recovered: used corrected ID from server (was: ${response.error})`));
            } else if (!heartbeatLoggedFirstSuccess) {
              heartbeatLoggedFirstSuccess = true;
              console.log(chalk.dim(`Heartbeat OK (id: ${heartbeatId.slice(0, 8)}...)`));
            }

            const now = Date.now();
            if (now - lastHeartbeatLogTime >= HEARTBEAT_LOG_INTERVAL_MS) {
              lastHeartbeatLogTime = now;
              console.log(chalk.dim(`Heartbeat alive (id: ${heartbeatId.slice(0, 8)}...)`));
            }
          }
          // Case 2: Error WITHOUT a corrected heartbeat_id
          else if (response.error) {
            const errMsg = response.error;
            const isInvalidId = errMsg.includes("Invalid Heartbeat ID") || errMsg.includes("invalid heartbeat");

            if (isInvalidId) {
              // No corrected ID returned — reset to empty to start fresh chain
              heartbeatId = "";
              heartbeatFailures++;
              console.log(chalk.yellow(
                `Heartbeat invalid ID, resetting chain (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES})`
              ));

              // After several failures, try re-deriving API creds (they may have expired)
              if (heartbeatFailures >= 3 && !authRefreshAttempted) {
                authRefreshAttempted = true;
                console.log(chalk.yellow("Heartbeat: attempting auth credential refresh..."));
                try {
                  const freshAuth = await deriveOrLoadCreds(env, db);
                  // Swap the clobClient reference used by heartbeat
                  auth.clobClient = freshAuth.clobClient;
                  heartbeatId = "";
                  console.log(chalk.green("Heartbeat: credentials refreshed, retrying..."));
                } catch (refreshErr) {
                  console.log(chalk.red(`Heartbeat: credential refresh failed: ${(refreshErr as Error).message}`));
                }
              }
            } else {
              heartbeatFailures++;
              console.log(chalk.yellow(`Heartbeat error (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${errMsg}`));
            }
          }
          // Case 3: Unexpected response shape (no error, no heartbeat_id)
          else {
            heartbeatFailures++;
            console.log(chalk.yellow(
              `Heartbeat unexpected response (${heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${JSON.stringify(response)}`
            ));
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
        } finally {
          heartbeatInFlight = false;
        }
      }, HEARTBEAT_INTERVAL_MS);

      // ───────────────────────────────────────────────────
      // REBALANCING LOOP
      // ───────────────────────────────────────────────────
      if (rebalanceIntervalMin > 0) {
        const REBALANCE_INTERVAL_MS = rebalanceIntervalMin * 60 * 1000;
        let rebalancing = false;
        console.log(chalk.dim(`Next rebalance check in ${rebalanceIntervalMin} minutes`));

        rebalanceInterval = setInterval(async () => {
          if (rebalancing) return; // skip if previous rebalance still running
          rebalancing = true;
          try {
            await performRebalance();
          } catch (err) {
            console.error(chalk.red("Rebalance error:"), (err as Error).message);
          } finally {
            rebalancing = false;
          }
        }, REBALANCE_INTERVAL_MS);
      }

      // ───────────────────────────────────────────────────
      // NO-TOKEN TIMEOUT TRACKER (16.5)
      // ───────────────────────────────────────────────────
      // Records when ASK fills leave NO tokens as "natural hedge".
      // Inventory sweep sells these after 15 min if no BID fill merges them.
      const noTokenTimestamps = new Map<string, number>(); // conditionId → timestamp
      const NO_TOKEN_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

      // ───────────────────────────────────────────────────
      // INVENTORY SWEEP (16.3 + 16.4 + 16.5 + 16.6)
      // ───────────────────────────────────────────────────
      const INVENTORY_SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
      let sweepInFlight = false;
      let sweepInterval: NodeJS.Timeout | null = null;

      /**
       * Session-agnostic inventory sweep:
       * 1. Discover ALL on-chain token balances (not just current session)
       * 2. Merge paired YES+NO positions → USDC
       * 3. Auto-redeem resolved markets → USDC
       * 4. Sell stale NO tokens held >15 min after ASK fill
       */
      async function performInventorySweep(): Promise<number> {
        console.log(chalk.dim("\n[Sweep] Starting inventory sweep..."));
        let totalRecovered = 0;

        // 1. Discover all positions via Data API (falls back to RPC)
        const discoveredPositions = await discoverPositions(auth.wallet, env);
        if (discoveredPositions.length === 0) {
          console.log(chalk.dim("[Sweep] No tokens held."));
          return 0;
        }
        console.log(chalk.dim(`[Sweep] Found ${discoveredPositions.length} non-zero position(s).`));

        // Build tokenId → balance map
        const balanceMap = new Map<string, ethers.BigNumber>();
        for (const t of discoveredPositions) {
          balanceMap.set(t.tokenId, t.balance);
        }

        // Convert to TokenBalance[] for auto-redeemer compatibility
        const heldTokens = discoveredPositions.map(p => ({ tokenId: p.tokenId, balance: p.balance }));

        // 2. Merge paired YES+NO positions
        const markets = db.getMarkets();
        for (const m of markets) {
          const balYes = balanceMap.get(m.token_id_yes) ?? ethers.BigNumber.from(0);
          const balNo = balanceMap.get(m.token_id_no) ?? ethers.BigNumber.from(0);
          if (balYes.isZero() || balNo.isZero()) continue;

          const mergeAmount = balYes.lt(balNo) ? balYes : balNo;
          try {
            const negRisk = m.neg_risk === 1;
            const txHash = await mergePositions(auth.wallet, env, m.condition_id, negRisk, mergeAmount);
            const recoveredUsdc = Number(ethers.utils.formatUnits(mergeAmount, 6));
            totalRecovered += recoveredUsdc;
            console.log(chalk.green(
              `[Sweep] Merged $${recoveredUsdc.toFixed(2)} from ${m.question.slice(0, 40)}... [tx: ${txHash.slice(0, 10)}...]`,
            ));
          } catch (err) {
            console.log(chalk.dim(`[Sweep] Merge failed for ${m.condition_id.slice(0, 12)}...: ${(err as Error).message?.slice(0, 100)}`));
          }
        }

        // 3. Auto-redeem resolved markets
        try {
          const redeemResult = await autoRedeemResolved(auth.wallet, env, heldTokens, markets);
          for (const r of redeemResult.redeemed) {
            totalRecovered += r.usdcRecovered;
          }
          if (redeemResult.redeemed.length > 0) {
            console.log(chalk.green(`[Sweep] Redeemed ${redeemResult.redeemed.length} resolved market(s).`));
          }
        } catch (err) {
          console.log(chalk.dim(`[Sweep] Auto-redeem error: ${(err as Error).message?.slice(0, 100)}`));
        }

        // 4. Sell stale NO tokens (held >15 min after ASK fill without BID merge)
        const now = Date.now();
        for (const [conditionId, timestamp] of noTokenTimestamps) {
          if (now - timestamp < NO_TOKEN_TIMEOUT_MS) continue;

          const market = markets.find(m => m.condition_id === conditionId);
          if (!market) continue;

          const noBalance = balanceMap.get(market.token_id_no);
          if (!noBalance || noBalance.isZero()) {
            noTokenTimestamps.delete(conditionId);
            continue;
          }

          // Sell NO tokens via market order at complement price
          const mid = market.midpoint ?? 0.5;
          const noPrice = 1 - mid;
          const tickDecimals = market.tick_size === "0.1" ? 1 : market.tick_size === "0.001" ? 3 : market.tick_size === "0.0001" ? 4 : 2;
          // Price slightly below complement to ensure fill
          const sellPrice = Math.floor((noPrice - 0.02) * Math.pow(10, tickDecimals)) / Math.pow(10, tickDecimals);
          const sellSize = Math.floor(Number(ethers.utils.formatUnits(noBalance, 6)));

          if (sellPrice <= 0.01 || sellSize <= 0) {
            noTokenTimestamps.delete(conditionId);
            continue;
          }

          try {
            const order = await auth.clobClient.createOrder({
              tokenID: market.token_id_no,
              price: sellPrice,
              size: sellSize,
              side: Side.SELL,
            }, {
              tickSize: market.tick_size as "0.1" | "0.01" | "0.001" | "0.0001",
              negRisk: market.neg_risk === 1,
            });
            const response = await auth.clobClient.postOrder(order, OrderType.FAK);
            if (response && (response.orderID || response.id)) {
              console.log(chalk.yellow(
                `[Sweep] Sold stale NO: ${sellSize} @ ${sellPrice.toFixed(tickDecimals)} ` +
                `for ${market.question.slice(0, 35)}... (held ${Math.round((now - timestamp) / 60000)}min)`,
              ));
            }
            noTokenTimestamps.delete(conditionId);
          } catch (err) {
            console.log(chalk.dim(`[Sweep] Failed to sell NO for ${conditionId.slice(0, 12)}...: ${(err as Error).message?.slice(0, 100)}`));
          }
        }

        if (totalRecovered > 0) {
          console.log(chalk.green(`[Sweep] Total recovered: $${totalRecovered.toFixed(2)} USDC`));
        } else {
          console.log(chalk.dim("[Sweep] No positions to recover."));
        }

        return totalRecovered;
      }

      // Start sweep interval
      if (mintEnabled) {
        console.log(chalk.dim(`Inventory sweep every ${INVENTORY_SWEEP_INTERVAL_MS / 60_000} minutes`));
        sweepInterval = setInterval(async () => {
          if (sweepInFlight) return;
          sweepInFlight = true;
          try {
            await performInventorySweep();
          } catch (err) {
            console.log(chalk.dim(`[Sweep] Error: ${(err as Error).message?.slice(0, 100)}`));
          } finally {
            sweepInFlight = false;
          }
        }, INVENTORY_SWEEP_INTERVAL_MS);
      }

      // ───────────────────────────────────────────────────
      // GRACEFUL SHUTDOWN (session-agnostic: 16.4)
      // ───────────────────────────────────────────────────

      const shutdown = async (signal: string) => {
        console.log(chalk.bold(`\n${signal} received. Shutting down gracefully...`));
        clearInterval(heartbeatInterval);
        if (rebalanceInterval) clearInterval(rebalanceInterval);
        if (sweepInterval) clearInterval(sweepInterval);
        fillDetector?.stop();
        monitor?.stop();

        console.log("Cancelling all live orders...");
        try {
          if (sessionId !== null) {
            await gracefulShutdown(auth.clobClient, db, sessionId);
          } else {
            await auth.clobClient.cancelAll();
            db.cancelAllOrders();
          }
          console.log(chalk.green("All orders cancelled."));
        } catch (err) {
          console.error(chalk.red("Warning: Failed to cancel some orders"), err);
        }

        // Session-agnostic merge: sweep ALL on-chain positions (not just current session)
        if (mintEnabled) {
          console.log("Running final inventory sweep (session-agnostic)...");
          try {
            const recovered = await performInventorySweep();
            if (recovered > 0) {
              console.log(chalk.green(`Recovered $${recovered.toFixed(2)} USDC from final sweep`));
            }
          } catch (err) {
            console.error(chalk.yellow(`Warning: final sweep error: ${(err as Error).message}`));
          }
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
