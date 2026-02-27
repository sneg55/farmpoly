import { Command } from "commander";
import chalk from "chalk";
import { ethers } from "ethers";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { discoverPositions } from "../../positions/fetcher.js";
import { killAllPositions } from "../../positions/seller.js";

export const killallCommand = new Command("killall")
  .description("Emergency: cancel all orders AND market-sell all positions")
  .option("--dry-run", "Show positions that would be sold without executing")
  .option("--skip-cancel", "Skip cancelling open limit orders (if already cancelled via panic)")
  .action(async (opts) => {
    try {
      console.log(chalk.red.bold("KILLALL: This will MARKET SELL all positions at current prices\n"));

      // 1. Load env + credentials
      const env = loadEnv();
      const rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);
      const auth = await deriveOrLoadCreds(env, db);

      // 2. Discover held positions via Polymarket Data API (falls back to RPC scan)
      console.log("Discovering positions via Polymarket Data API...");
      const positions = await discoverPositions(auth.wallet, env);

      if (positions.length === 0) {
        console.log(chalk.yellow("No non-zero token balances found."));

        // Still cancel orders if not skipped
        if (!opts.skipCancel && !opts.dryRun) {
          await auth.clobClient.cancelAll();
          const cancelled = db.cancelAllOrders();
          console.log(`Cancelled ${cancelled} open orders.`);
        }

        rawDb.close();
        return;
      }

      // 3. Display enriched position info
      console.log(chalk.bold(`\nPositions to sell (${positions.length}):\n`));
      for (const pos of positions) {
        const amount = ethers.utils.formatUnits(pos.balance, 6);

        let label: string;
        if (pos.title) {
          const truncTitle = pos.title.length > 45 ? `${pos.title.slice(0, 45)}...` : pos.title;
          const outcomePart = pos.outcome ? ` (${pos.outcome})` : "";
          label = `${truncTitle}${outcomePart}`;
        } else {
          // Fall back to DB lookup
          const markets = db.getMarkets();
          const marketByYes = new Map(markets.map((m) => [m.token_id_yes, m]));
          const marketByNo = new Map(markets.map((m) => [m.token_id_no, m]));
          const mYes = marketByYes.get(pos.tokenId);
          const mNo = marketByNo.get(pos.tokenId);
          const market = mYes ?? mNo;
          const side = mYes ? "YES" : mNo ? "NO" : "?";
          label = market ? `${market.question.slice(0, 50)}... (${side})` : pos.tokenId;
        }

        const pricePart = pos.curPrice !== undefined ? ` @ $${pos.curPrice.toFixed(3)}` : "";
        const redeemPart = pos.redeemable ? chalk.cyan(" [REDEEMABLE]") : "";
        console.log(`  ${label}: ${amount} tokens${pricePart}${redeemPart}`);
      }
      console.log();

      // 4. Dry run stops here
      if (opts.dryRun) {
        console.log(chalk.yellow("Dry run — no transactions sent."));
        rawDb.close();
        return;
      }

      // 5. Execute killall (passes API positions for enriched metadata + auto-redeem)
      const startTime = Date.now();
      const result = await killAllPositions(auth.clobClient, auth.wallet, env, db, positions);
      const elapsed = Date.now() - startTime;

      // 6. Display results
      console.log(chalk.bold(`\nResults (${elapsed}ms):`));
      console.log(`  Orders cancelled: ${result.cancelled}`);
      if (result.redeemed > 0) {
        console.log(chalk.cyan(`  Positions redeemed: ${result.redeemed}`));
      }
      console.log(`  Positions sold: ${result.sold.length}`);

      for (const s of result.sold) {
        console.log(chalk.green(`    ${s.tokenId.slice(0, 16)}...: ${s.amount} tokens`));
      }

      if (result.failed.length > 0) {
        console.log(chalk.red(`\n  Failed (${result.failed.length}):`));
        for (const f of result.failed) {
          console.log(chalk.red(`    ${f}`));
        }
      }

      rawDb.close();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\nKILLALL FAILED: ${(err as Error).message}`));
      process.exit(1);
    }
  });
