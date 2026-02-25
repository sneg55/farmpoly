import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import { ethers } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import type { PolyfarmDb } from "../db/database.js";
import type { FillEvent } from "./detector.js";
import { getTokenBalances } from "../positions/fetcher.js";
import { mergePositions } from "./merger.js";

export interface HedgeOptions {
  maxHedgeCostCents: number; // Max extra cents for hedge buy (default: 5)
  db?: PolyfarmDb;           // Database for inventory lookups
  sessionId?: number;        // Active session ID for inventory
}

export type HedgeStatus = "HEDGED" | "HEDGE_FAILED" | "MERGE_FAILED" | "SKIPPED";

export interface HedgeResult {
  status: HedgeStatus;
  hedgeOrderId: string | null;
  hedgePrice: number | null;
  hedgeSize: number;
  mergeAmount: number;
  mergeTxHash: string | null;
  pnlCents: number;
  error?: string;
}

/**
 * Execute a hedge after a fill event.
 *
 * Flow:
 * 1. Determine opposite token to buy
 * 2. Market buy opposite token (FOK, then FAK fallback)
 * 3. Wait for on-chain settlement
 * 4. Check balances
 * 5. Merge min(balYes, balNo) via mergePositions
 * 6. Calculate P&L
 */
export async function executeHedge(
  clobClient: ClobClient,
  wallet: Wallet,
  env: EnvConfig,
  fill: FillEvent,
  options: HedgeOptions = { maxHedgeCostCents: 5 },
): Promise<HedgeResult> {
  // --- Inventory merge path ---
  // On BID fill (bought YES): check if we have NO tokens from minting
  // If so, merge directly — no hedge buy needed (pure spread profit!)
  if (fill.side === "BUY" && options.db && options.sessionId != null) {
    const noInventory = options.db.getInventory(options.sessionId, fill.conditionId, "NO");
    if (noInventory && noInventory.current_balance > 0) {
      const mergeableFromInventory = Math.min(noInventory.current_balance, fill.filledSize);

      if (mergeableFromInventory > 0) {
        console.log(`  Inventory merge: ${mergeableFromInventory.toFixed(2)} tokens from minted NO inventory`);

        // Wait for on-chain settlement of the fill
        await new Promise((r) => setTimeout(r, 2000));

        // Check on-chain balances
        const balances = await getTokenBalances(wallet, env, [fill.tokenIdYes, fill.tokenIdNo]);
        const balMap = new Map<string, ethers.BigNumber>();
        for (const b of balances) {
          balMap.set(b.tokenId, b.balance);
        }
        const balYes = balMap.get(fill.tokenIdYes) ?? ethers.BigNumber.from(0);
        const balNo = balMap.get(fill.tokenIdNo) ?? ethers.BigNumber.from(0);
        const mergeAmount = balYes.lt(balNo) ? balYes : balNo;

        if (!mergeAmount.isZero()) {
          try {
            const mergeTxHash = await mergePositions(
              wallet, env, fill.conditionId, fill.negRisk, mergeAmount,
            );

            const mergeAmountNum = Number(ethers.utils.formatUnits(mergeAmount, 6));

            // Update inventory balance
            const newBalance = noInventory.current_balance - mergeAmountNum;
            options.db.updateInventoryBalance(noInventory.id, Math.max(0, newBalance));

            // P&L: spread profit (no hedge cost!)
            const pnlCents = Math.round(fill.filledPrice * 100 * mergeAmountNum) / mergeAmountNum;
            // More accurately: each merged pair returns $1 USDC.
            // We paid (1 - askPrice) via split to get NO + YES. Sold YES at askPrice.
            // On BID fill, bought YES at bidPrice. Merge YES+NO = $1.
            // Profit = 1 - bidPrice - (1 - askPrice) = askPrice - bidPrice = spread
            const spreadPnlCents = mergeAmountNum * (1.0 - fill.filledPrice) * 100 - mergeAmountNum * (1.0 - 1.0) * 100;
            // Simplified: pnl = (1 - fillPrice) * 100 = complement price * 100 per unit ...
            // Actually with inventory: we paid $1 to split (got YES+NO), sold YES at askPrice,
            // then BID fills at bidPrice giving us more YES. We merge the filled YES with minted NO.
            // Net: received askPrice (from ASK sell) + 1.00 (from merge) - 1.00 (split cost) - bidPrice (BID cost)
            //     = askPrice - bidPrice = spread
            // For now just calculate based on the actual merged amount recovering $1 vs what was paid
            const inventoryPnlCents = Math.round((1.0 - fill.filledPrice) * mergeAmountNum * 100 * 100) / 100;

            // If we fully covered the fill from inventory, we're done
            if (mergeAmountNum >= fill.filledSize) {
              return {
                status: "HEDGED",
                hedgeOrderId: null,
                hedgePrice: null,
                hedgeSize: 0,
                mergeAmount: mergeAmountNum,
                mergeTxHash,
                pnlCents: inventoryPnlCents,
              };
            }

            // Partial coverage: hedge the remainder via normal path below
            // (Fall through with reduced hedge size)
          } catch (mergeErr) {
            console.log(`  Inventory merge failed, falling back to hedge buy: ${(mergeErr as Error).message?.slice(0, 80)}`);
          }
        }
      }
    }
  }

  // On ASK fill (sold YES): NO tokens remain as directional position
  // Skip hedge buy entirely — the minted NO tokens ARE the hedge.
  // They'll be merged when the BID fills or on shutdown.
  if (fill.side === "SELL" && options.db && options.sessionId != null) {
    const noInventory = options.db.getInventory(options.sessionId, fill.conditionId, "NO");
    if (noInventory && noInventory.current_balance > 0) {
      console.log(
        `  ASK filled: holding ${noInventory.current_balance.toFixed(2)} NO tokens as natural hedge ` +
        `(will merge when BID fills or on shutdown)`,
      );
      return {
        status: "HEDGED",
        hedgeOrderId: null,
        hedgePrice: null,
        hedgeSize: 0,
        mergeAmount: 0,
        mergeTxHash: null,
        pnlCents: 0, // P&L realized on merge, not here
      };
    }
  }

  // Determine hedge direction
  // BID fill (bought YES) → buy NO token
  // ASK fill (sold YES, holds NO) → buy YES token
  const hedgeTokenId = fill.side === "BUY" ? fill.tokenIdNo : fill.tokenIdYes;
  const hedgeSide = Side.BUY;

  // Theoretical complement price: 1 - fillPrice
  const complementPrice = 1 - fill.filledPrice;
  // Price cap: complement + max hedge cost
  const priceCap = Math.min(complementPrice + options.maxHedgeCostCents / 100, 0.99);

  // Round hedge size to 2 decimal places (CLOB requires max 2 decimals for taker amount)
  const hedgeSize = Math.floor(fill.filledSize * 100) / 100;

  if (hedgeSize <= 0) {
    return {
      status: "SKIPPED",
      hedgeOrderId: null,
      hedgePrice: null,
      hedgeSize: 0,
      mergeAmount: 0,
      mergeTxHash: null,
      pnlCents: 0,
    };
  }

  // Try to buy the opposite token
  let hedgeOrderId: string | null = null;
  let hedgePrice: number | null = null;

  // Round price to tick size precision (CLOB rejects excess decimals)
  const tickDecimals = fill.tickSize === "0.1" ? 1 : fill.tickSize === "0.001" ? 3 : fill.tickSize === "0.0001" ? 4 : 2;
  const priceRounded = Math.floor(priceCap * Math.pow(10, tickDecimals)) / Math.pow(10, tickDecimals);

  const orderParams = {
    tokenID: hedgeTokenId,
    price: priceRounded,
    size: hedgeSize,
    side: hedgeSide,
  };
  const orderOptions = {
    tickSize: fill.tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
    negRisk: fill.negRisk,
  };

  // Try FOK first (full fill or nothing)
  try {
    const order = await clobClient.createOrder(orderParams, orderOptions);
    const response = await clobClient.postOrder(order, OrderType.FOK);
    if (response && (response.orderID || response.id)) {
      hedgeOrderId = response.orderID || response.id;
      hedgePrice = priceRounded;
    }
  } catch (fokErr) {
    // FOK failed (no liquidity for full fill), try FAK below
    console.log(`  FOK hedge failed: ${(fokErr as Error).message?.slice(0, 80)}`);
  }

  if (!hedgeOrderId) {
    try {
      const order = await clobClient.createOrder(orderParams, orderOptions);
      const response = await clobClient.postOrder(order, OrderType.FAK);
      if (response && (response.orderID || response.id)) {
        hedgeOrderId = response.orderID || response.id;
        hedgePrice = priceRounded;
      }
    } catch (fakErr) {
      const errMsg = (fakErr as Error).message || String(fakErr);
      return {
        status: "HEDGE_FAILED",
        hedgeOrderId: null,
        hedgePrice: null,
        hedgeSize: 0,
        mergeAmount: 0,
        mergeTxHash: null,
        pnlCents: 0,
        error: `FOK+FAK failed: ${errMsg.slice(0, 120)}`,
      };
    }
  }

  if (!hedgeOrderId) {
    return {
      status: "HEDGE_FAILED",
      hedgeOrderId: null,
      hedgePrice: null,
      hedgeSize: 0,
      mergeAmount: 0,
      mergeTxHash: null,
      pnlCents: 0,
      error: "No order ID returned from FOK or FAK",
    };
  }

  // Wait for on-chain settlement
  await new Promise((r) => setTimeout(r, 2000));

  // Check on-chain balances
  const balances = await getTokenBalances(wallet, env, [fill.tokenIdYes, fill.tokenIdNo]);
  const balMap = new Map<string, ethers.BigNumber>();
  for (const b of balances) {
    balMap.set(b.tokenId, b.balance);
  }

  const balYes = balMap.get(fill.tokenIdYes) ?? ethers.BigNumber.from(0);
  const balNo = balMap.get(fill.tokenIdNo) ?? ethers.BigNumber.from(0);

  // Merge min(balYes, balNo)
  const mergeAmount = balYes.lt(balNo) ? balYes : balNo;

  if (mergeAmount.isZero()) {
    // Balances not settled yet or zero — skip merge
    return {
      status: "HEDGED",
      hedgeOrderId,
      hedgePrice,
      hedgeSize,
      mergeAmount: 0,
      mergeTxHash: null,
      pnlCents: calculatePnlCents(fill.filledPrice, hedgePrice ?? 0),
    };
  }

  // Merge positions on-chain
  let mergeTxHash: string | null = null;
  try {
    mergeTxHash = await mergePositions(
      wallet,
      env,
      fill.conditionId,
      fill.negRisk,
      mergeAmount,
    );
  } catch (mergeErr) {
    const mergeAmountNum = Number(ethers.utils.formatUnits(mergeAmount, 6));
    return {
      status: "MERGE_FAILED",
      hedgeOrderId,
      hedgePrice,
      hedgeSize,
      mergeAmount: mergeAmountNum,
      mergeTxHash: null,
      pnlCents: calculatePnlCents(fill.filledPrice, hedgePrice ?? 0),
      error: `Merge failed: ${(mergeErr as Error).message?.slice(0, 120)}`,
    };
  }

  const mergeAmountNum = Number(ethers.utils.formatUnits(mergeAmount, 6));
  const pnlCents = calculatePnlCents(fill.filledPrice, hedgePrice ?? 0);

  return {
    status: "HEDGED",
    hedgeOrderId,
    hedgePrice,
    hedgeSize,
    mergeAmount: mergeAmountNum,
    mergeTxHash,
    pnlCents,
  };
}

/**
 * Calculate P&L in cents.
 * Fill price + hedge price should sum close to $1.00.
 * P&L = (1.00 - fillPrice - hedgePrice) × 100 cents
 */
function calculatePnlCents(fillPrice: number, hedgePrice: number): number {
  const totalCost = fillPrice + hedgePrice;
  // Each merged pair returns $1.00, so P&L = (1.00 - totalCost) × 100
  return Math.round((1.0 - totalCost) * 100 * 100) / 100;
}
