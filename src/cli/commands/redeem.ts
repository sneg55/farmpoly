import { Command } from "commander";
import chalk from "chalk";
import { ethers } from "ethers";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { discoverHeldTokens } from "../../positions/fetcher.js";
import { redeemAll } from "../../positions/redeemer.js";

export const redeemCommand = new Command("redeem")
  .description("Redeem resolved market positions for USDC")
  .option("--dry-run", "Show what would be redeemed without sending transactions")
  .option("--market <conditionId>", "Redeem only a specific market")
  .option("--from-block <number>", "Start scanning from this block (default: ~6mo ago)")
  .action(async (opts) => {
    try {
      console.log(chalk.bold("Redeeming resolved positions...\n"));

      // 1. Load env + credentials
      const env = loadEnv();
      const rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);
      const auth = await deriveOrLoadCreds(env, db);

      // 2. Discover tokens held by wallet via on-chain Transfer events
      console.log("Discovering ERC1155 tokens in wallet...");
      const fromBlock = opts.fromBlock ? Number(opts.fromBlock) : undefined;
      const heldTokens = await discoverHeldTokens(auth.wallet, env, fromBlock);

      if (heldTokens.length === 0) {
        console.log(chalk.yellow("No ERC1155 tokens with non-zero balance found."));
        rawDb.close();
        return;
      }

      console.log(`  ${heldTokens.length} token(s) with non-zero balance\n`);

      // 3. Match tokens to markets in DB
      const markets = db.getMarkets();
      const marketByYes = new Map(markets.map((m) => [m.token_id_yes, m]));
      const marketByNo = new Map(markets.map((m) => [m.token_id_no, m]));

      // Group held tokens by conditionId
      const positionMap = new Map<
        string,
        {
          question: string;
          negRisk: boolean;
          balanceYes: ethers.BigNumber;
          balanceNo: ethers.BigNumber;
        }
      >();

      for (const { tokenId, balance } of heldTokens) {
        const mYes = marketByYes.get(tokenId);
        const mNo = marketByNo.get(tokenId);
        const market = mYes ?? mNo;

        if (!market) {
          // Token not in our DB — show raw info
          console.log(
            chalk.dim(
              `  Unknown token ${tokenId.slice(0, 16)}...: ${ethers.utils.formatUnits(balance, 6)} (not in DB)`,
            ),
          );
          continue;
        }

        // Filter by --market if specified
        if (opts.market && market.condition_id !== opts.market) continue;

        const existing = positionMap.get(market.condition_id) ?? {
          question: market.question,
          negRisk: market.neg_risk === 1,
          balanceYes: ethers.BigNumber.from(0),
          balanceNo: ethers.BigNumber.from(0),
        };

        if (mYes) existing.balanceYes = balance;
        else existing.balanceNo = balance;

        positionMap.set(market.condition_id, existing);
      }

      if (positionMap.size === 0) {
        console.log(chalk.yellow("No redeemable positions found matching known markets."));
        rawDb.close();
        return;
      }

      // 4. Build positions array + display table
      const positions = [...positionMap.entries()].map(([conditionId, p]) => ({
        conditionId,
        ...p,
      }));

      console.log(chalk.bold(`Found ${positions.length} redeemable position(s):\n`));
      for (const p of positions) {
        const yesStr = ethers.utils.formatUnits(p.balanceYes, 6);
        const noStr = ethers.utils.formatUnits(p.balanceNo, 6);
        console.log(
          `  ${p.question.slice(0, 60)}${p.question.length > 60 ? "..." : ""}` +
            `\n    YES: ${yesStr} | NO: ${noStr} | NegRisk: ${p.negRisk ? "Yes" : "No"}`,
        );
      }
      console.log();

      // 5. Dry run stops here
      if (opts.dryRun) {
        console.log(chalk.yellow("Dry run — no transactions sent."));
        rawDb.close();
        return;
      }

      // 6. Redeem all
      console.log("Sending redemption transactions...");
      const result = await redeemAll(auth.wallet, env, positions);

      console.log(chalk.green.bold(`\nRedeemed: ${result.redeemed.length}`));
      for (const r of result.redeemed) {
        console.log(chalk.green(`  ${r.conditionId.slice(0, 16)}... tx: ${r.txHash}`));
      }

      if (result.failed.length > 0) {
        console.log(chalk.red(`\nFailed: ${result.failed.length}`));
        for (const f of result.failed) {
          console.log(chalk.red(`  ${f.conditionId.slice(0, 16)}...: ${f.error}`));
        }
      }

      if (result.skipped > 0) {
        console.log(chalk.dim(`Skipped ${result.skipped} zero-balance positions.`));
      }

      rawDb.close();
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      process.exit(1);
    }
  });
