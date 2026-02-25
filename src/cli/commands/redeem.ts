import { Command } from "commander";
import chalk from "chalk";
import { ethers } from "ethers";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { getTokenBalances } from "../../positions/fetcher.js";
import { redeemAll } from "../../positions/redeemer.js";

export const redeemCommand = new Command("redeem")
  .description("Redeem resolved market positions for USDC")
  .option("--dry-run", "Show what would be redeemed without sending transactions")
  .option("--market <conditionId>", "Redeem only a specific market")
  .action(async (opts) => {
    try {
      console.log(chalk.bold("Redeeming resolved positions...\n"));

      // 1. Load env + credentials
      const env = loadEnv();
      const rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);
      const auth = await deriveOrLoadCreds(env, db);

      // 2. Get markets from DB
      let markets = db.getMarkets();
      if (opts.market) {
        markets = markets.filter((m) => m.condition_id === opts.market);
        if (markets.length === 0) {
          console.log(chalk.yellow(`Market ${opts.market} not found in database.`));
          rawDb.close();
          return;
        }
      }

      if (markets.length === 0) {
        console.log(chalk.yellow("No markets in database. Run 'polyfarm discover' first."));
        rawDb.close();
        return;
      }

      // 3. Fetch balances for all markets
      const tokenIds: string[] = [];
      const marketByToken = new Map<string, { question: string; conditionId: string; negRisk: boolean; side: string }>();

      for (const m of markets) {
        tokenIds.push(m.token_id_yes, m.token_id_no);
        marketByToken.set(m.token_id_yes, { question: m.question, conditionId: m.condition_id, negRisk: m.neg_risk === 1, side: "YES" });
        marketByToken.set(m.token_id_no, { question: m.question, conditionId: m.condition_id, negRisk: m.neg_risk === 1, side: "NO" });
      }

      const balances = await getTokenBalances(auth.wallet, env, tokenIds);

      // 4. Filter to non-zero balances and build position list
      const positions: {
        conditionId: string;
        question: string;
        negRisk: boolean;
        balanceYes: ethers.BigNumber;
        balanceNo: ethers.BigNumber;
      }[] = [];

      // Group by conditionId
      const balanceByCondition = new Map<string, { yes: ethers.BigNumber; no: ethers.BigNumber }>();
      for (const b of balances) {
        const info = marketByToken.get(b.tokenId);
        if (!info) continue;

        const existing = balanceByCondition.get(info.conditionId) ?? {
          yes: ethers.BigNumber.from(0),
          no: ethers.BigNumber.from(0),
        };
        if (info.side === "YES") existing.yes = b.balance;
        else existing.no = b.balance;
        balanceByCondition.set(info.conditionId, existing);
      }

      for (const m of markets) {
        const bal = balanceByCondition.get(m.condition_id);
        if (!bal || (bal.yes.isZero() && bal.no.isZero())) continue;

        positions.push({
          conditionId: m.condition_id,
          question: m.question,
          negRisk: m.neg_risk === 1,
          balanceYes: bal.yes,
          balanceNo: bal.no,
        });
      }

      if (positions.length === 0) {
        console.log(chalk.yellow("No positions with non-zero balance found."));
        rawDb.close();
        return;
      }

      // 5. Display table
      console.log(chalk.bold(`Found ${positions.length} position(s):\n`));
      for (const p of positions) {
        const yesStr = ethers.utils.formatUnits(p.balanceYes, 6);
        const noStr = ethers.utils.formatUnits(p.balanceNo, 6);
        console.log(
          `  ${p.question.slice(0, 60)}${p.question.length > 60 ? "..." : ""}` +
          `\n    YES: ${yesStr} | NO: ${noStr} | NegRisk: ${p.negRisk ? "Yes" : "No"}`,
        );
      }
      console.log();

      // 6. Dry run stops here
      if (opts.dryRun) {
        console.log(chalk.yellow("Dry run — no transactions sent."));
        rawDb.close();
        return;
      }

      // 7. Redeem all
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
