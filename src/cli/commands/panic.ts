import { Command } from "commander";
import chalk from "chalk";
import { Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import { loadEnv } from "../../utils/config.js";
import { createDatabase, PolyfarmDb } from "../../db/database.js";

const CHAIN_ID = 137;

export const panicCommand = new Command("panic")
  .description("Emergency: cancel ALL orders immediately")
  .option("--skip-db", "Bypass SQLite, cancel via API only")
  .action(async (opts) => {
    const startTime = Date.now();

    try {
      console.log(chalk.red.bold("PANIC MODE: Cancelling all orders...\n"));

      const env = loadEnv();
      const wallet = new Wallet(`0x${env.polygonPrivateKey}`);

      // Try to load cached creds from DB first (faster)
      let creds: { key: string; secret: string; passphrase: string } | undefined;

      if (!opts.skipDb) {
        try {
          const rawDb = createDatabase();
          const db = new PolyfarmDb(rawDb);

          const key = db.getConfig("api_key");
          const secret = db.getConfig("api_secret");
          const passphrase = db.getConfig("api_passphrase");

          if (key && secret && passphrase) {
            creds = { key, secret, passphrase };
          }

          // Also cancel in DB
          const cancelled = db.cancelAllOrders();
          console.log(`  DB: ${cancelled} orders marked cancelled`);

          // End active session
          const session = db.getActiveSession();
          if (session) {
            db.endSession(session.id, "PANIC");
            console.log(`  Session ${session.id} ended with PANIC status`);
          }

          rawDb.close();
        } catch (dbErr) {
          console.log(chalk.yellow(`  DB unavailable, skipping DB cleanup: ${(dbErr as Error).message}`));
        }
      }

      // Cancel via CLOB API
      if (creds) {
        const client = new ClobClient(env.clobApiUrl, CHAIN_ID, wallet, creds);
        await client.cancelAll();
      } else {
        // Fall back to L1 derivation if no cached creds
        console.log("  No cached creds, deriving via L1...");
        const tempClient = new ClobClient(env.clobApiUrl, CHAIN_ID, wallet);
        const derived = await tempClient.deriveApiKey();
        const client = new ClobClient(env.clobApiUrl, CHAIN_ID, wallet, {
          key: derived.key,
          secret: derived.secret,
          passphrase: derived.passphrase,
        });
        await client.cancelAll();
      }

      const elapsed = Date.now() - startTime;
      console.log(chalk.green.bold(`\nAll orders cancelled in ${elapsed}ms`));
      process.exit(0);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      console.error(chalk.red(`\nPANIC FAILED after ${elapsed}ms: ${(err as Error).message}`));
      process.exit(1);
    }
  });
