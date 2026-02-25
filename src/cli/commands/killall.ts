import { Command } from "commander";
import chalk from "chalk";
import { ethers } from "ethers";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { getTokenBalances } from "../../positions/fetcher.js";
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

      // 2. Get all known token IDs from DB
      const markets = db.getMarkets();
      if (markets.length === 0) {
        console.log(chalk.yellow("No markets in database."));
        rawDb.close();
        return;
      }

      const tokenIds: string[] = [];
      const tokenInfoMap = new Map<string, { question: string; side: string }>();

      for (const m of markets) {
        tokenIds.push(m.token_id_yes, m.token_id_no);
        tokenInfoMap.set(m.token_id_yes, { question: m.question, side: "YES" });
        tokenInfoMap.set(m.token_id_no, { question: m.question, side: "NO" });
      }

      // 3. Fetch balances
      const balances = await getTokenBalances(auth.wallet, env, tokenIds);
      const nonZero = balances.filter((b) => !b.balance.isZero());

      // 4. Display table
      if (nonZero.length === 0) {
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

      console.log(chalk.bold(`Positions to sell:\n`));
      for (const b of nonZero) {
        const info = tokenInfoMap.get(b.tokenId);
        const label = info ? `${info.question.slice(0, 50)}... (${info.side})` : b.tokenId;
        const amount = ethers.utils.formatUnits(b.balance, 6);
        console.log(`  ${label}: ${amount} tokens`);
      }
      console.log();

      // 5. Dry run stops here
      if (opts.dryRun) {
        console.log(chalk.yellow("Dry run — no transactions sent."));
        rawDb.close();
        return;
      }

      // 6. Execute killall
      const startTime = Date.now();
      const result = await killAllPositions(auth.clobClient, auth.wallet, env, db);
      const elapsed = Date.now() - startTime;

      // 7. Display results
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
