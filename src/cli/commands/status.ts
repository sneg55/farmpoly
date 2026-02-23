import { Command } from "commander";
import chalk from "chalk";
import { createDatabase, PolyfarmDb } from "../../db/database.js";

export const statusCommand = new Command("status")
  .description("Show current session status and live orders")
  .action(async () => {
    try {
      const rawDb = createDatabase();
      const db = new PolyfarmDb(rawDb);

      const session = db.getActiveSession();
      if (!session) {
        console.log(chalk.yellow("No active session found."));
        rawDb.close();
        return;
      }

      console.log(chalk.bold("PolyFarm Status\n"));
      console.log(`  Session ID:  ${session.id}`);
      console.log(`  Status:      ${colorStatus(session.status)}`);
      console.log(`  Budget:      $${session.budget_usdc.toFixed(2)} USDC`);
      console.log(`  Spread:      ${session.spread_cents}c`);
      console.log(`  Started:     ${new Date(session.started_at * 1000).toISOString()}`);
      console.log(`  Markets:     ${session.markets_count}`);
      console.log();

      // Order stats
      console.log(chalk.bold("Orders"));
      console.log(`  Placed:      ${session.orders_placed}`);
      console.log(`  Cancelled:   ${session.orders_cancelled}`);
      console.log(`  Filled:      ${session.orders_filled}`);

      const fillRate =
        session.orders_placed > 0
          ? ((session.orders_filled / session.orders_placed) * 100).toFixed(1)
          : "0.0";
      console.log(`  Fill rate:   ${fillRate}%`);
      console.log();

      // Live orders
      const liveOrders = db.getLiveOrders();
      if (liveOrders.length > 0) {
        console.log(chalk.bold(`Live Orders (${liveOrders.length})\n`));
        for (const order of liveOrders) {
          const side = order.side === "BUY" ? chalk.green("BID") : chalk.red("ASK");
          console.log(
            `  ${side} ${order.price.toFixed(2)} x ${order.size.toFixed(1)} ` +
              `[${order.order_id.slice(0, 8)}...]`,
          );
        }
      } else {
        console.log(chalk.dim("No live orders."));
      }

      rawDb.close();
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      process.exit(1);
    }
  });

function colorStatus(status: string): string {
  switch (status) {
    case "RUNNING":
      return chalk.green(status);
    case "STOPPED":
      return chalk.yellow(status);
    case "PANIC":
      return chalk.red(status);
    default:
      return status;
  }
}
