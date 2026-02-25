import { Contract, Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { ClobClient } from "@polymarket/clob-client";
import type { EnvConfig } from "../utils/config.js";
import type { PolyfarmDb, MarketRow } from "../db/database.js";
import { CONDITIONAL_TOKENS, ERC1155_BALANCE_ABI } from "../contracts/addresses.js";

export interface OpenOrder {
  id: string;
  market: string; // condition_id
  asset_id: string; // token_id
  side: "BUY" | "SELL";
  price: string;
  original_size: string;
  size_matched: string;
}

export interface TokenBalance {
  tokenId: string;
  balance: BigNumber;
}

export interface PositionSummary {
  conditionId: string;
  question: string;
  tokenIdYes: string;
  tokenIdNo: string;
  balanceYes: BigNumber;
  balanceNo: BigNumber;
  openOrders: OpenOrder[];
  negRisk: boolean;
}

/**
 * Fetch all open orders from CLOB API with pagination.
 */
export async function getOpenPositions(clobClient: ClobClient): Promise<OpenOrder[]> {
  const allOrders: OpenOrder[] = [];
  let nextCursor: string | undefined;

  do {
    const response = await clobClient.getOpenOrders({ next_cursor: nextCursor } as any);

    // SDK may return different shapes — normalize
    const orders: any[] = Array.isArray(response) ? response : (response as any)?.data ?? [];
    for (const o of orders) {
      allOrders.push({
        id: o.id ?? o.order_id ?? o.orderID,
        market: o.market ?? o.condition_id ?? o.conditionId,
        asset_id: o.asset_id ?? o.token_id ?? o.tokenID,
        side: (o.side ?? "BUY").toUpperCase() as "BUY" | "SELL",
        price: String(o.price),
        original_size: String(o.original_size ?? o.size ?? "0"),
        size_matched: String(o.size_matched ?? o.filledSize ?? "0"),
      });
    }

    nextCursor = (response as any)?.next_cursor;
  } while (nextCursor && nextCursor !== "" && nextCursor !== "LTE=");

  return allOrders;
}

/**
 * Fetch on-chain ERC1155 token balances using balanceOfBatch for efficiency.
 */
export async function getTokenBalances(
  wallet: Wallet,
  env: EnvConfig,
  tokenIds: string[],
): Promise<TokenBalance[]> {
  if (tokenIds.length === 0) return [];

  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const ct = new Contract(CONDITIONAL_TOKENS, ERC1155_BALANCE_ABI, provider);

  // balanceOfBatch expects parallel arrays of addresses and IDs
  const addresses = tokenIds.map(() => wallet.address);
  const balances: BigNumber[] = await ct.balanceOfBatch(addresses, tokenIds);

  return tokenIds.map((tokenId, i) => ({
    tokenId,
    balance: balances[i],
  }));
}

/**
 * Build a full position summary combining on-chain balances + open CLOB orders.
 */
export async function getPositionSummary(
  clobClient: ClobClient,
  wallet: Wallet,
  env: EnvConfig,
  db: PolyfarmDb,
): Promise<PositionSummary[]> {
  const markets = db.getMarkets();
  if (markets.length === 0) return [];

  // Collect all token IDs
  const tokenIds: string[] = [];
  for (const m of markets) {
    tokenIds.push(m.token_id_yes, m.token_id_no);
  }

  // Fetch balances and open orders in parallel
  const [balances, openOrders] = await Promise.all([
    getTokenBalances(wallet, env, tokenIds),
    getOpenPositions(clobClient),
  ]);

  // Index balances by tokenId
  const balanceMap = new Map<string, BigNumber>();
  for (const b of balances) {
    balanceMap.set(b.tokenId, b.balance);
  }

  // Group orders by condition_id
  const ordersByMarket = new Map<string, OpenOrder[]>();
  for (const o of openOrders) {
    const existing = ordersByMarket.get(o.market) ?? [];
    existing.push(o);
    ordersByMarket.set(o.market, existing);
  }

  const summaries: PositionSummary[] = [];
  for (const m of markets) {
    const balYes = balanceMap.get(m.token_id_yes) ?? ethers.BigNumber.from(0);
    const balNo = balanceMap.get(m.token_id_no) ?? ethers.BigNumber.from(0);
    const orders = ordersByMarket.get(m.condition_id) ?? [];

    // Only include markets where we have a position or open orders
    if (balYes.isZero() && balNo.isZero() && orders.length === 0) continue;

    summaries.push({
      conditionId: m.condition_id,
      question: m.question,
      tokenIdYes: m.token_id_yes,
      tokenIdNo: m.token_id_no,
      balanceYes: balYes,
      balanceNo: balNo,
      openOrders: orders,
      negRisk: m.neg_risk === 1,
    });
  }

  return summaries;
}
