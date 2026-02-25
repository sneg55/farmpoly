import { Command } from "commander";
import chalk from "chalk";
import { ethers } from "ethers";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { discoverHeldTokens } from "../../positions/fetcher.js";
import { killAllPositions } from "../../positions/seller.js";

export const killallCommand = new Command("killall")
  .description("Emergency: cancel all orders AND market-sell all positions")
  .option("--dry-run", "Show positions that would be sold without executing")
  .option("--skip-cancel", "Skip cancelling open limit orders (if already cancelled via panic)")
  .option("--from-block <number>", "Start scanning from this block (default: ~6mo ago)")
  .action(async (opts) => {
    try {
      console.log(chalk.red.bold("KILLALL: This will MARKET SELL all positions at current prices\n"));

      // 1. Load env + credentials
      const env = loadEnv();
      const rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);
      const auth = await deriveOrLoadCreds(env, db);

      // 2. Discover held tokens via on-chain Transfer events
      console.log("Discovering ERC1155 tokens in wallet...");
      const fromBlock = opts.fromBlock ? Number(opts.fromBlock) : undefined;
      const heldTokens = await discoverHeldTokens(auth.wallet, env, fromBlock);

      if (heldTokens.length === 0) {
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

      // 3. Match tokens to markets in DB for display
      const markets = db.getMarkets();
      const marketByYes = new Map(markets.map((m) => [m.token_id_yes, m]));
      const marketByNo = new Map(markets.map((m) => [m.token_id_no, m]));

      console.log(chalk.bold(`\nPositions to sell (${heldTokens.length}):\n`));
      for (const { tokenId, balance } of heldTokens) {
        const mYes = marketByYes.get(tokenId);
        const mNo = marketByNo.get(tokenId);
        const market = mYes ?? mNo;
        const side = mYes ? "YES" : mNo ? "NO" : "?";
        const label = market ? `${market.question.slice(0, 50)}... (${side})` : tokenId;
        const amount = ethers.utils.formatUnits(balance, 6);
        console.log(`  ${label}: ${amount} tokens`);
      }
      console.log();

      // 4. Dry run stops here
      if (opts.dryRun) {
        console.log(chalk.yellow("Dry run — no transactions sent."));
        rawDb.close();
        return;
      }

      // 5. Execute killall
      const startTime = Date.now();
      const result = await killAllPositions(auth.clobClient, auth.wallet, env, db);
      const elapsed = Date.now() - startTime;

      // 6. Display results
      console.log(chalk.bold(`\nResults (${elapsed}ms):`));
      console.log(`  Orders cancelled: ${result.cancelled}`);
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
