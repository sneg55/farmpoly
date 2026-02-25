import { Command } from "commander";
import chalk from "chalk";
import { Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { startDashboard } from "../../dashboard/server.js";

const CHAIN_ID = 137;

export const dashboardCommand = new Command("dashboard")
  .description("Start a web dashboard to monitor the bot")
  .option("--port <number>", "HTTP port", process.env.POLYFARM_DASHBOARD_PORT ?? "3737")
  .option("--host <addr>", "Bind address (use 0.0.0.0 for all interfaces)", process.env.POLYFARM_DASHBOARD_HOST ?? "127.0.0.1")
  .option("--auth-token <token>", "Bearer token required for dashboard access", process.env.POLYFARM_DASHBOARD_TOKEN)
  .action(async (opts) => {
    try {
      const port = parseInt(opts.port);
      const host = opts.host;
      const authToken: string | undefined = opts.authToken;
      const rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);

      // Try to build a CLOB client for panic functionality
      let panicFn: (() => Promise<number>) | undefined;
      try {
        const key = db.getConfig("api_key");
        const secret = db.getConfig("api_secret");
        const passphrase = db.getConfig("api_passphrase");
        const pkHex = process.env.POLYGON_PRIVATE_KEY;

        if (key && secret && passphrase && pkHex) {
          const cleaned = pkHex.startsWith("0x") ? pkHex : `0x${pkHex}`;
          const wallet = new Wallet(cleaned);
          const clobUrl = process.env.CLOB_API_URL || "https://clob.polymarket.com";
          const client = new ClobClient(clobUrl, CHAIN_ID, wallet, { key, secret, passphrase });

          panicFn = async () => {
            await client.cancelAll();
            const cancelled = db.cancelAllOrders();
            const session = db.getActiveSession();
            if (session) db.endSession(session.id, "PANIC");
            return cancelled;
          };
        }
      } catch {
        // No CLOB client available, panic will only update DB
      }

      const server = await startDashboard({ port, host, db, onPanic: panicFn, authToken });

      console.log(chalk.bold(`PolyFarm Dashboard running at:`));
      console.log(chalk.blue.underline(`  http://${host}:${port}`));

      if (host === "0.0.0.0" && !authToken) {
        console.log(chalk.yellow.bold("\nWARNING: Dashboard is bound to all interfaces with no auth token. Set --auth-token or POLYFARM_DASHBOARD_TOKEN to secure access."));
      }

      if (authToken) {
        const masked = authToken.slice(0, 4) + "*".repeat(Math.max(0, authToken.length - 4));
        console.log(chalk.dim(`Auth token: ${masked}`));
      }

      console.log(chalk.dim("\nPress Ctrl+C to stop\n"));

      const shutdown = () => {
        console.log(chalk.dim("\nShutting down dashboard..."));
        server.close();
        rawDb.close();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
  });
