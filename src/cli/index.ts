#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { discoverCommand } from "./commands/discover.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { panicCommand } from "./commands/panic.js";
import { dashboardCommand } from "./commands/dashboard.js";

const program = new Command();

program
  .name("polyfarm")
  .description("Automated liquidity provision for Polymarket")
  .version("0.1.0");

program.addCommand(initCommand);
program.addCommand(discoverCommand);
program.addCommand(runCommand);
program.addCommand(statusCommand);
program.addCommand(panicCommand);
program.addCommand(dashboardCommand);

program.parse();
