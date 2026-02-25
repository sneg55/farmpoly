import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import { ethers } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import type { FillEvent } from "./detector.js";
import { getTokenBalances } from "../positions/fetcher.js";
import { mergePositions } from "./merger.js";

export interface HedgeOptions {
  maxHedgeCostCents: number; // Max extra cents for hedge buy (default: 5)
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
  // Determine hedge direction
  // BID fill (bought YES) → buy NO token
  // ASK fill (sold YES, holds NO) → buy YES token
  const hedgeTokenId = fill.side === "BUY" ? fill.tokenIdNo : fill.tokenIdYes;
  const hedgeSide = Side.BUY;

  // Theoretical complement price: 1 - fillPrice
  const complementPrice = 1 - fill.filledPrice;
  // Price cap: complement + max hedge cost
  const priceCap = Math.min(complementPrice + options.maxHedgeCostCents / 100, 0.99);

  const hedgeSize = fill.filledSize;

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

  const orderParams = {
    tokenID: hedgeTokenId,
    price: priceCap,
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
      hedgePrice = priceCap;
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
        hedgePrice = priceCap;
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
