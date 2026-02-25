import { Command } from "commander";
import chalk from "chalk";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { deriveOrLoadCreds } from "../../auth/credentials.js";
import {
  checkApproval,
  approveUSDC,
  checkConditionalTokenApproval,
  approveConditionalTokens,
} from "../../auth/approval.js";

export const initCommand = new Command("init")
  .description("Initialize: derive API keys, check USDC approval")
  .option("--approve", "Auto-approve USDC spending if needed")
  .action(async (opts) => {
    try {
      console.log(chalk.bold("Initializing PolyFarm...\n"));

      // 1. Load and validate env
      console.log("Loading environment...");
      const env = loadEnv();
      console.log(chalk.green("  Private key loaded and validated"));

      // 2. Initialize database
      const rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);
      console.log(chalk.green("  Database initialized"));

      // 3. Derive or load API credentials
      console.log("\nDeriving API credentials...");
      const auth = await deriveOrLoadCreds(env, db);
      console.log(chalk.green(`  API key: ${auth.creds.key.slice(0, 8)}...`));
      console.log(chalk.green(`  Wallet: ${auth.wallet.address}`));

      // 4. Check USDC approval
      console.log("\nChecking USDC approval...");
      const status = await checkApproval(auth.wallet, env);
      const balanceUsdc = Number(status.balance) / 1e6;
      console.log(`  Balance: ${chalk.bold(`$${balanceUsdc.toFixed(2)} USDC`)}`);

      if (status.needsApproval || status.needsNegRiskApproval) {
        if (opts.approve) {
          console.log("  Approving USDC spending...");
          const txs = await approveUSDC(auth.wallet, env);
          if (txs.ctfTxHash) console.log(chalk.green(`  CTF Exchange approved: ${txs.ctfTxHash}`));
          if (txs.negRiskTxHash)
            console.log(chalk.green(`  NegRisk Exchange approved: ${txs.negRiskTxHash}`));
        } else {
          console.log(
            chalk.yellow("  USDC approval needed. Run with --approve to auto-approve."),
          );
        }
      } else {
        console.log(chalk.green("  USDC already approved for both exchanges"));
      }

      // 5. Check ConditionalTokens ERC1155 approval (required for SELL orders)
      console.log("\nChecking ConditionalTokens (ERC1155) approval...");
      const ctStatus = await checkConditionalTokenApproval(auth.wallet, env);

      if (ctStatus.needsAnyApproval) {
        const missing: string[] = [];
        if (ctStatus.needsCtfExchangeApproval) missing.push("CTF Exchange");
        if (ctStatus.needsNegRiskExchangeApproval) missing.push("NegRisk Exchange");
        if (ctStatus.needsNegRiskAdapterApproval) missing.push("NegRisk Adapter");

        if (opts.approve) {
          console.log(`  Approving ConditionalTokens for: ${missing.join(", ")}...`);
          const ctTxs = await approveConditionalTokens(auth.wallet, env);
          if (ctTxs.ctfExchangeTxHash)
            console.log(chalk.green(`  CTF Exchange (ERC1155): ${ctTxs.ctfExchangeTxHash}`));
          if (ctTxs.negRiskExchangeTxHash)
            console.log(chalk.green(`  NegRisk Exchange (ERC1155): ${ctTxs.negRiskExchangeTxHash}`));
          if (ctTxs.negRiskAdapterTxHash)
            console.log(chalk.green(`  NegRisk Adapter (ERC1155): ${ctTxs.negRiskAdapterTxHash}`));
        } else {
          console.log(
            chalk.yellow(`  ConditionalTokens approval needed for: ${missing.join(", ")}`),
          );
          console.log(
            chalk.yellow("  Run with --approve to auto-approve. Required for SELL orders."),
          );
        }
      } else {
        console.log(chalk.green("  ConditionalTokens approved for all spenders"));
      }

      console.log(chalk.bold.green("\nInitialization complete!"));
      rawDb.close();
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      process.exit(1);
    }
  });
