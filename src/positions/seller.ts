import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import { Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import type { PolyfarmDb } from "../db/database.js";
import { getTokenBalances } from "./fetcher.js";

export interface SellResult {
  tokenId: string;
  amount: string;
  success: boolean;
  error?: string;
}

export interface KillAllResult {
  cancelled: number;
  sold: SellResult[];
  failed: string[];
}

/**
 * Market-sell a single token position via the CLOB API.
 * Tries FOK (Fill or Kill) first, falls back to FAK (Fill and Kill) on failure.
 */
export async function marketSellPosition(
  clobClient: ClobClient,
  tokenId: string,
  amount: number,
  negRisk: boolean,
  tickSize: string,
): Promise<SellResult> {
  const orderParams = {
    tokenID: tokenId,
    price: 0.01, // Market sell — lowest possible price
    size: amount,
    side: Side.SELL,
  };
  const orderOptions = {
    tickSize: tickSize as "0.1" | "0.01" | "0.001" | "0.0001",
    negRisk,
  };

  // Try FOK first
  try {
    const order = await clobClient.createOrder(orderParams, orderOptions);
    const response = await clobClient.postOrder(order, OrderType.FOK);
    if (response && (response.orderID || response.id)) {
      return { tokenId, amount: String(amount), success: true };
    }
  } catch {
    // FOK failed (no liquidity for full fill), try FAK
  }

  // Fallback to FAK (partial fill OK)
  try {
    const order = await clobClient.createOrder(orderParams, orderOptions);
    const response = await clobClient.postOrder(order, OrderType.FAK);
    if (response && (response.orderID || response.id)) {
      return { tokenId, amount: String(amount), success: true };
    }
    return { tokenId, amount: String(amount), success: false, error: "No order ID returned" };
  } catch (err) {
    return {
      tokenId,
      amount: String(amount),
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Emergency kill: cancel all orders + market-sell all held tokens.
 *
 * Steps:
 * 1. Cancel all open limit orders via API
 * 2. Fetch on-chain token balances
 * 3. Market-sell every non-zero balance
 * 4. Update DB: mark all orders cancelled, end session as PANIC
 */
export async function killAllPositions(
  clobClient: ClobClient,
  wallet: Wallet,
  env: EnvConfig,
  db: PolyfarmDb,
): Promise<KillAllResult> {
  // Step 1: Cancel all open orders
  let cancelled = 0;
  try {
    await clobClient.cancelAll();
    cancelled = db.cancelAllOrders();
  } catch (err) {
    console.error(`Cancel error: ${(err as Error).message}`);
  }

  // Step 2: Get all known token IDs from DB
  const markets = db.getMarkets();
  const tokenInfoMap = new Map<string, { negRisk: boolean; tickSize: string }>();
  const tokenIds: string[] = [];

  for (const m of markets) {
    tokenIds.push(m.token_id_yes, m.token_id_no);
    const info = { negRisk: m.neg_risk === 1, tickSize: m.tick_size };
    tokenInfoMap.set(m.token_id_yes, info);
    tokenInfoMap.set(m.token_id_no, info);
  }

  // Step 3: Fetch balances and sell non-zero positions
  const sold: SellResult[] = [];
  const failed: string[] = [];

  if (tokenIds.length > 0) {
    const balances = await getTokenBalances(wallet, env, tokenIds);

    for (const { tokenId, balance } of balances) {
      if (balance.isZero()) continue;

      const info = tokenInfoMap.get(tokenId);
      if (!info) continue;

      // Convert BigNumber balance to human-readable (ERC1155 tokens are whole units in CLOB)
      const amount = Number(ethers.utils.formatUnits(balance, 6));
      if (amount <= 0) continue;

      const result = await marketSellPosition(
        clobClient,
        tokenId,
        amount,
        info.negRisk,
        info.tickSize,
      );

      if (result.success) {
        sold.push(result);
      } else {
        failed.push(`${tokenId}: ${result.error}`);
      }
    }
  }

  // Step 4: End active session as PANIC
  const session = db.getActiveSession();
  if (session) {
    db.endSession(session.id, "PANIC");
  }

  return { cancelled, sold, failed };
}
