import type { ClobClient } from "@polymarket/clob-client";
import { Side, OrderType } from "@polymarket/clob-client";
import { Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import type { PolyfarmDb } from "../db/database.js";
import { getTokenBalances } from "./fetcher.js";
import type { DiscoveredPosition } from "./fetcher.js";
import { redeemPosition } from "./redeemer.js";

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
  redeemed: number;
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
    return { tokenId, amount: String(amount), success: false, error: "No orderbook liquidity" };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const detail = msg.includes("orderbook") || msg.includes("no open orders")
      ? `Orderbook not found: ${msg}`
      : msg;
    return {
      tokenId,
      amount: String(amount),
      success: false,
      error: detail,
    };
  }
}

/**
 * Infer tick size from current price precision or default to "0.01".
 */
function inferTickSize(curPrice?: number): string {
  if (curPrice === undefined) return "0.01";
  const s = curPrice.toFixed(4);
  // Count significant decimal places
  const stripped = s.replace(/0+$/, "");
  const decimals = stripped.includes(".") ? stripped.split(".")[1].length : 0;
  if (decimals >= 4) return "0.0001";
  if (decimals === 3) return "0.001";
  if (decimals === 2) return "0.01";
  return "0.1";
}

/**
 * Emergency kill: cancel all orders + market-sell all held tokens.
 *
 * Steps:
 * 1. Cancel all open limit orders via API
 * 2. Fetch token balances (via apiPositions if provided, else DB + on-chain)
 * 3. Auto-redeem positions where redeemable === true
 * 4. Market-sell every remaining non-zero balance
 * 5. Update DB: mark all orders cancelled, end session as PANIC
 */
export async function killAllPositions(
  clobClient: ClobClient,
  wallet: Wallet,
  env: EnvConfig,
  db: PolyfarmDb,
  apiPositions?: DiscoveredPosition[],
): Promise<KillAllResult> {
  // Step 1: Cancel all open orders
  let cancelled = 0;
  try {
    await clobClient.cancelAll();
    cancelled = db.cancelAllOrders();
  } catch (err) {
    console.error(`Cancel error: ${(err as Error).message}`);
  }

  const sold: SellResult[] = [];
  const failed: string[] = [];
  let redeemed = 0;

  if (apiPositions) {
    // API-driven path: use DiscoveredPosition data directly
    const markets = db.getMarkets();
    const marketByYes = new Map(markets.map((m) => [m.token_id_yes, m]));
    const marketByNo = new Map(markets.map((m) => [m.token_id_no, m]));

    for (const pos of apiPositions) {
      if (pos.balance.isZero()) continue;

      const amount = Number(ethers.utils.formatUnits(pos.balance, 6));
      if (amount <= 0) continue;

      // Step 3: Auto-redeem if flagged redeemable
      if (pos.redeemable && pos.conditionId) {
        const negRisk = pos.negRisk ?? false;
        // For redeem we need both yes and no balances; find the opposite asset balance
        const oppositeAsset = pos.oppositeAsset;
        let balanceYes = pos.balance;
        let balanceNo = ethers.BigNumber.from(0);

        if (oppositeAsset) {
          // Find opposite in apiPositions
          const opposite = apiPositions.find((p) => p.tokenId === oppositeAsset);
          if (opposite && !opposite.balance.isZero()) {
            // Determine which is YES and which is NO from DB
            const dbMkt = marketByYes.get(pos.tokenId) ?? marketByNo.get(pos.tokenId);
            if (dbMkt) {
              if (dbMkt.token_id_yes === pos.tokenId) {
                balanceYes = pos.balance;
                balanceNo = opposite.balance;
              } else {
                balanceYes = opposite.balance;
                balanceNo = pos.balance;
              }
            }
          }
        }

        try {
          await redeemPosition(wallet, env, pos.conditionId, negRisk, balanceYes, balanceNo);
          redeemed++;
          continue; // Skip market-sell for this position
        } catch (err) {
          // Redeem failed — fall through to market-sell
          console.error(`  Redeem failed for ${pos.tokenId}: ${(err as Error).message}`);
        }
      }

      // Step 4: Market-sell
      // Prefer API metadata; fall back to DB
      let negRisk = pos.negRisk;
      let tickSize: string | undefined;

      if (negRisk === undefined || tickSize === undefined) {
        const dbMkt = marketByYes.get(pos.tokenId) ?? marketByNo.get(pos.tokenId);
        if (dbMkt) {
          if (negRisk === undefined) negRisk = dbMkt.neg_risk === 1;
          if (tickSize === undefined) tickSize = dbMkt.tick_size;
        }
      }

      const resolvedNegRisk = negRisk ?? false;
      const resolvedTickSize = tickSize ?? inferTickSize(pos.curPrice);

      const result = await marketSellPosition(
        clobClient,
        pos.tokenId,
        amount,
        resolvedNegRisk,
        resolvedTickSize,
      );

      if (result.success) {
        sold.push(result);
      } else {
        failed.push(`${pos.tokenId}: ${result.error}`);
      }
    }
  } else {
    // DB-driven path (backward compatible): get all known token IDs from DB
    const markets = db.getMarkets();
    const tokenInfoMap = new Map<string, { negRisk: boolean; tickSize: string }>();
    const tokenIds: string[] = [];

    for (const m of markets) {
      tokenIds.push(m.token_id_yes, m.token_id_no);
      const info = { negRisk: m.neg_risk === 1, tickSize: m.tick_size };
      tokenInfoMap.set(m.token_id_yes, info);
      tokenInfoMap.set(m.token_id_no, info);
    }

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
  }

  // Step 5: End active session as PANIC
  const session = db.getActiveSession();
  if (session) {
    db.endSession(session.id, "PANIC");
  }

  return { cancelled, sold, failed, redeemed };
}
