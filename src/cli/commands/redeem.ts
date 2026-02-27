import { Command } from "commander";
import chalk from "chalk";
import { ethers } from "ethers";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import { fetchWalletPositions, type DataApiPosition } from "../../api/positions-api.js";
import { discoverHeldTokens } from "../../positions/fetcher.js";
import { redeemAll } from "../../positions/redeemer.js";

export const redeemCommand = new Command("redeem")
  .description("Redeem resolved market positions for USDC")
  .option("--dry-run", "Show what would be redeemed without sending transactions")
  .option("--market <conditionId>", "Redeem only a specific market")
  .option("--force", "Attempt redeem even if API says position is not redeemable")
  .action(async (opts) => {
    try {
      console.log(chalk.bold("Redeeming resolved positions...\n"));

      // 1. Load env + credentials
      const env = loadEnv();
      const rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);
      const auth = await deriveOrLoadCreds(env, db);

      // 2. Discover positions via Data API
      let apiPositions: DataApiPosition[] | null = null;

      console.log("Fetching positions from Polymarket Data API...");
      try {
        apiPositions = await fetchWalletPositions(
          auth.wallet.address,
          { sizeThreshold: 0 },
          env.dataApiUrl,
        );
        console.log(`  ${apiPositions.length} position(s) found via API\n`);
      } catch (err) {
        const msg = (err as Error).message?.slice(0, 120) ?? String(err);
        console.log(chalk.yellow(`  Data API unavailable, falling back to RPC scan: ${msg}`));
      }

      // 3. Build grouped positions for redeemAll
      //    Group by conditionId: combine YES + NO balances per market
      const positionMap = new Map<
        string,
        {
          title: string;
          negRisk: boolean;
          redeemable: boolean;
          curPrice: number | undefined;
          balanceYes: ethers.BigNumber;
          balanceNo: ethers.BigNumber;
        }
      >();

      if (apiPositions !== null) {
        // --- API path ---
        for (const p of apiPositions) {
          if (p.size <= 0) continue;

          // Filter by --market if specified
          if (opts.market && p.conditionId !== opts.market) continue;

          const existing = positionMap.get(p.conditionId) ?? {
            title: p.title,
            negRisk: p.negativeRisk,
            redeemable: false,
            curPrice: p.curPrice,
            balanceYes: ethers.BigNumber.from(0),
            balanceNo: ethers.BigNumber.from(0),
          };

          // Mark the whole market redeemable if any leg is redeemable
          if (p.redeemable) existing.redeemable = true;

          // Determine YES vs NO by outcome field first, fall back to outcomeIndex
          const isYes =
            p.outcome?.toLowerCase() === "yes" || p.outcomeIndex === 0;

          const balance = ethers.utils.parseUnits(p.size.toFixed(6), 6);
          if (isYes) {
            existing.balanceYes = existing.balanceYes.add(balance);
          } else {
            existing.balanceNo = existing.balanceNo.add(balance);
          }

          positionMap.set(p.conditionId, existing);
        }
      } else {
        // --- RPC fallback path ---
        console.log("Discovering ERC1155 tokens in wallet via RPC...");
        const heldTokens = await discoverHeldTokens(auth.wallet, env);

        if (heldTokens.length === 0) {
          console.log(chalk.yellow("No ERC1155 tokens with non-zero balance found."));
          rawDb.close();
          return;
        }

        console.log(`  ${heldTokens.length} token(s) with non-zero balance\n`);

        // Match tokens to markets in DB
        const markets = db.getMarkets();
        const marketByYes = new Map(markets.map((m) => [m.token_id_yes, m]));
        const marketByNo = new Map(markets.map((m) => [m.token_id_no, m]));

        for (const { tokenId, balance } of heldTokens) {
          const mYes = marketByYes.get(tokenId);
          const mNo = marketByNo.get(tokenId);
          const market = mYes ?? mNo;

          if (!market) {
            console.log(
              chalk.dim(
                `  Unknown token ${tokenId.slice(0, 16)}...: ${ethers.utils.formatUnits(balance, 6)} (not in DB)`,
              ),
            );
            continue;
          }

          if (opts.market && market.condition_id !== opts.market) continue;

          const existing = positionMap.get(market.condition_id) ?? {
            title: market.question,
            negRisk: market.neg_risk === 1,
            redeemable: true, // unknown in RPC path, assume redeemable
            curPrice: undefined,
            balanceYes: ethers.BigNumber.from(0),
            balanceNo: ethers.BigNumber.from(0),
          };

          if (mYes) existing.balanceYes = balance;
          else existing.balanceNo = balance;

          positionMap.set(market.condition_id, existing);
        }
      }

      if (positionMap.size === 0) {
        console.log(chalk.yellow("No positions found matching criteria."));
        rawDb.close();
        return;
      }

      // 4. Split into redeemable and non-redeemable for display
      const redeemableEntries: [string, typeof positionMap extends Map<string, infer V> ? V : never][] = [];
      const notResolvedEntries: [string, typeof positionMap extends Map<string, infer V> ? V : never][] = [];

      for (const entry of positionMap.entries()) {
        const [, p] = entry;
        if (opts.force || p.redeemable) {
          redeemableEntries.push(entry);
        } else {
          notResolvedEntries.push(entry);
        }
      }

      // Display redeemable positions
      if (redeemableEntries.length > 0) {
        console.log(chalk.bold(`Found ${redeemableEntries.length} redeemable position(s):\n`));
        for (const [conditionId, p] of redeemableEntries) {
          const yesStr = ethers.utils.formatUnits(p.balanceYes, 6);
          const noStr = ethers.utils.formatUnits(p.balanceNo, 6);
          const priceStr = p.curPrice !== undefined ? ` | Price: $${p.curPrice.toFixed(4)}` : "";
          const badge = chalk.green("[REDEEMABLE]");
          const titleTrunc = p.title.slice(0, 60) + (p.title.length > 60 ? "..." : "");
          console.log(
            `  ${badge} ${titleTrunc}` +
              `\n    YES: ${yesStr} | NO: ${noStr} | NegRisk: ${p.negRisk ? "Yes" : "No"}${priceStr}` +
              `\n    conditionId: ${conditionId.slice(0, 16)}...`,
          );
        }
        console.log();
      } else {
        console.log(chalk.yellow("No redeemable positions found."));
      }

      // Display non-redeemable / not-resolved positions
      if (notResolvedEntries.length > 0 && apiPositions !== null) {
        console.log(chalk.dim(`Not resolved (${notResolvedEntries.length}):`));
        for (const [conditionId, p] of notResolvedEntries) {
          const yesStr = ethers.utils.formatUnits(p.balanceYes, 6);
          const noStr = ethers.utils.formatUnits(p.balanceNo, 6);
          const priceStr = p.curPrice !== undefined ? ` | Price: $${p.curPrice.toFixed(4)}` : "";
          const titleTrunc = p.title.slice(0, 60) + (p.title.length > 60 ? "..." : "");
          console.log(
            chalk.dim(
              `  [NOT RESOLVED] ${titleTrunc}` +
                `\n    YES: ${yesStr} | NO: ${noStr}${priceStr}` +
                `\n    conditionId: ${conditionId.slice(0, 16)}...`,
            ),
          );
        }
        console.log();
      }

      if (redeemableEntries.length === 0) {
        rawDb.close();
        return;
      }

      // 5. Dry run stops here
      if (opts.dryRun) {
        console.log(chalk.yellow("Dry run — no transactions sent."));
        rawDb.close();
        return;
      }

      // 6. Build positions array for redeemAll
      const positions = redeemableEntries.map(([conditionId, p]) => ({
        conditionId,
        negRisk: p.negRisk,
        balanceYes: p.balanceYes,
        balanceNo: p.balanceNo,
      }));

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
