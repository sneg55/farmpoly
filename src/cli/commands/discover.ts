import { Command } from "commander";
import chalk from "chalk";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { fetchGammaMarkets } from "../../discovery/gamma.js";
import { filterRewardMarkets } from "../../discovery/rewards.js";

const DEFAULT_GAMMA_URL = "https://gamma-api.polymarket.com";

export const discoverCommand = new Command("discover")
  .description("Discover sponsored markets with liquidity rewards")
  .option("--min-tvl <amount>", "Minimum TVL in USD", "10000")
  .option("--limit <n>", "Max markets to display", "20")
  .action(async (opts) => {
    try {
      const gammaApiUrl = process.env.GAMMA_API_URL || DEFAULT_GAMMA_URL;

      console.log(chalk.bold("Discovering sponsored markets...\n"));

      const gammaMarkets = await fetchGammaMarkets(gammaApiUrl, {
        minTvl: parseFloat(opts.minTvl),
      });

      console.log(`Found ${gammaMarkets.length} markets with TVL > $${opts.minTvl}\n`);

      const rewardMarkets = filterRewardMarkets(gammaMarkets);

      if (rewardMarkets.length === 0) {
        console.log(chalk.yellow("No sponsored reward markets found matching criteria."));
        return;
      }

      const limit = parseInt(opts.limit);
      const display = rewardMarkets.slice(0, limit);

      // Table header
      console.log(
        chalk.bold(
          padRight("Question", 50) +
            padRight("Midpoint", 10) +
            padRight("TVL", 12) +
            padRight("Rate/day", 10) +
            padRight("Spread", 10),
        ),
      );
      console.log("-".repeat(92));

      // Optionally persist to DB if it's available
      let db: PolyfarmDb | null = null;
      let rawDb: ReturnType<typeof createDatabase> | null = null;
      try {
        rawDb = createDatabase();
        db = new PolyfarmDb(rawDb);
      } catch (err) {
        console.log(chalk.yellow(`DB unavailable, results won't be persisted: ${(err as Error).message}`));
      }

      for (const m of display) {
        console.log(
          padRight(truncate(m.question, 48), 50) +
            padRight(m.midpoint.toFixed(2), 10) +
            padRight(`$${formatNumber(m.tvl)}`, 12) +
            padRight(`$${m.rewardRate.toFixed(2)}`, 10) +
            padRight(`${(m.maxSpread * 100).toFixed(0)}c`, 10),
        );
      }

      // Persist ALL reward markets to DB, not just displayed ones
      if (db) {
        for (const m of rewardMarkets) {
          db.upsertMarket({
            condition_id: m.conditionId,
            question: m.question,
            token_id_yes: m.tokenIdYes,
            token_id_no: m.tokenIdNo,
            tick_size: m.tickSize,
            neg_risk: m.negRisk ? 1 : 0,
            midpoint: m.midpoint,
            tvl: m.tvl,
            reward_rate: m.rewardRate,
          });
        }
      }

      console.log(`\n${chalk.green(`${rewardMarkets.length} reward markets found`)}`);
      rawDb?.close();
    } catch (err) {
      console.error(chalk.red(`\nError: ${(err as Error).message}`));
      process.exit(1);
    }
  });

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 2) + ".." : str;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}
