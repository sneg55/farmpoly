import { Command } from "commander";
import chalk from "chalk";
import { createDatabase, PolyfarmDb } from "../../db/database.js";
import { fetchGammaMarkets } from "../../discovery/gamma.js";
import { filterRewardMarkets, allocateCapitalSmart, type AllocationResult } from "../../discovery/rewards.js";

const DEFAULT_GAMMA_URL = "https://gamma-api.polymarket.com";

export const discoverCommand = new Command("discover")
  .description("Discover sponsored markets with liquidity rewards")
  .option("--min-tvl <amount>", "Minimum TVL in USD", "10000")
  .option("--limit <n>", "Max markets to display", "20")
  .option("--min-daily-yield <percent>", "Minimum daily yield % to include", "0")
  .option("--sort-by-rate", "Sort by reward rate instead of profitability score")
  .option("--simulate-budget <usdc>", "Simulate capital allocation with this budget")
  .action(async (opts) => {
    try {
      const gammaApiUrl = process.env.GAMMA_API_URL || DEFAULT_GAMMA_URL;

      console.log(chalk.bold("Discovering sponsored markets...\n"));

      const gammaMarkets = await fetchGammaMarkets(gammaApiUrl, {
        minTvl: parseFloat(opts.minTvl),
      });

      console.log(`Found ${gammaMarkets.length} markets with TVL > $${opts.minTvl}\n`);

      const minDailyYield = parseFloat(opts.minDailyYield);
      const sortByProfitability = !opts.sortByRate;
      
      const { markets: rewardMarkets } = filterRewardMarkets(gammaMarkets, {
        minDailyYield,
        sortByProfitability,
      });

      if (rewardMarkets.length === 0) {
        console.log(chalk.yellow("No sponsored reward markets found matching criteria."));
        if (minDailyYield > 0) {
          console.log(chalk.dim(`Try lowering --min-daily-yield (current: ${minDailyYield}%)`));
        }
        return;
      }

      const limit = parseInt(opts.limit);
      const display = rewardMarkets.slice(0, limit);

      // Table header with yield % column
      console.log(
        chalk.bold(
          padRight("Question", 40) +
            padRight("Mid", 6) +
            padRight("TVL", 10) +
            padRight("$/day", 8) +
            padRight("Yield%", 8) +
            padRight("Score", 8) +
            padRight("MinCap", 8),
        ),
      );
      console.log("-".repeat(88));

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
        // Color-code yield: green for high, yellow for medium, white for low
        let yieldStr = m.dailyYieldPercent.toFixed(2) + "%";
        if (m.dailyYieldPercent >= 5) {
          yieldStr = chalk.green(yieldStr);
        } else if (m.dailyYieldPercent >= 1) {
          yieldStr = chalk.yellow(yieldStr);
        }
        
        console.log(
          padRight(truncate(m.question, 38), 40) +
            padRight(m.midpoint.toFixed(2), 6) +
            padRight(`$${formatNumber(m.tvl)}`, 10) +
            padRight(`$${m.rewardRate.toFixed(0)}`, 8) +
            padRight(yieldStr, 8) +
            padRight(m.profitabilityScore.toFixed(2), 8) +
            padRight(`$${formatNumber(m.minCapitalRequired)}`, 8),
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
      
      // Show top 3 summary
      console.log(chalk.dim("\nTop 3 by profitability:"));
      for (const m of display.slice(0, 3)) {
        console.log(chalk.dim(`  • ${truncate(m.question, 50)} - ${m.dailyYieldPercent.toFixed(2)}%/day`));
      }
      
      // Simulate capital allocation if requested
      if (opts.simulateBudget) {
        const budget = parseFloat(opts.simulateBudget);
        console.log(chalk.bold(`\n📊 Simulating $${budget} allocation:\n`));
        
        const allocations = allocateCapitalSmart(rewardMarkets, budget, limit);
        
        if (allocations.length === 0) {
          console.log(chalk.yellow("Cannot allocate budget - no affordable markets"));
        } else {
          let totalExpectedDaily = 0;
          
          console.log(
            chalk.bold(
              padRight("Market", 35) +
                padRight("Alloc", 10) +
                padRight("Share%", 10) +
                padRight("Daily$", 10),
            ),
          );
          console.log("-".repeat(65));
          
          for (const alloc of allocations) {
            totalExpectedDaily += alloc.expectedDailyReward;
            console.log(
              padRight(truncate(alloc.market.question, 33), 35) +
                padRight(`$${alloc.allocatedUsdc.toFixed(2)}`, 10) +
                padRight(`${alloc.sharePercent.toFixed(2)}%`, 10) +
                padRight(`$${alloc.expectedDailyReward.toFixed(2)}`, 10),
            );
          }
          
          console.log("-".repeat(65));
          console.log(
            chalk.green(
              `Total expected: $${totalExpectedDaily.toFixed(2)}/day = ` +
              `$${(totalExpectedDaily * 30).toFixed(0)}/month = ` +
              `${((totalExpectedDaily * 365 / budget) * 100).toFixed(1)}% APY`,
            ),
          );
        }
      }
      
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
