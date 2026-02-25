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
 * Batches into chunks of BATCH_SIZE to avoid RPC calldata limits.
 */
const BATCH_SIZE = 100;

export async function getTokenBalances(
  wallet: Wallet,
  env: EnvConfig,
  tokenIds: string[],
): Promise<TokenBalance[]> {
  if (tokenIds.length === 0) return [];

  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const ct = new Contract(CONDITIONAL_TOKENS, ERC1155_BALANCE_ABI, provider);

  const results: TokenBalance[] = [];

  for (let i = 0; i < tokenIds.length; i += BATCH_SIZE) {
    const chunk = tokenIds.slice(i, i + BATCH_SIZE);
    const addresses = chunk.map(() => wallet.address);
    const balances: BigNumber[] = await ct.balanceOfBatch(addresses, chunk);

    for (let j = 0; j < chunk.length; j++) {
      results.push({ tokenId: chunk[j], balance: balances[j] });
    }
  }

  return results;
}

/**
 * Discover ERC1155 token IDs held by wallet by scanning TransferSingle/TransferBatch
 * events on the ConditionalTokens contract, then checking current balances.
 * Returns only tokens with non-zero balance.
 *
 * @param fromBlock - Block to start scanning from (default: last ~6 months on Polygon)
 */
const BLOCK_RANGE = 5000; // Max range per eth_getLogs query on most RPCs

export async function discoverHeldTokens(
  wallet: Wallet,
  env: EnvConfig,
  fromBlock?: number,
): Promise<TokenBalance[]> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const ct = new Contract(CONDITIONAL_TOKENS, ERC1155_BALANCE_ABI, provider);

  const currentBlock = await provider.getBlockNumber();
  // Default: ~6 months back (Polygon ~2s blocks → ~7.8M blocks in 6mo)
  const startBlock = fromBlock ?? Math.max(0, currentBlock - 7_800_000);

  const tokenIdSet = new Set<string>();

  // Scan in chunks to stay within RPC log query limits
  for (let from = startBlock; from <= currentBlock; from += BLOCK_RANGE) {
    const to = Math.min(from + BLOCK_RANGE - 1, currentBlock);

    // TransferSingle: indexed(operator, from, to), id, value
    const singleFilter = ct.filters.TransferSingle(null, null, wallet.address);
    const singleLogs = await ct.queryFilter(singleFilter, from, to);
    for (const log of singleLogs) {
      if (log.args) {
        tokenIdSet.add(log.args.id.toString());
      }
    }

    // TransferBatch: indexed(operator, from, to), ids[], values[]
    const batchFilter = ct.filters.TransferBatch(null, null, wallet.address);
    const batchLogs = await ct.queryFilter(batchFilter, from, to);
    for (const log of batchLogs) {
      if (log.args) {
        for (const id of log.args.ids) {
          tokenIdSet.add(id.toString());
        }
      }
    }

    // Progress log every 50k blocks
    if ((from - startBlock) % 50_000 < BLOCK_RANGE) {
      const pct = Math.round(((from - startBlock) / (currentBlock - startBlock)) * 100);
      if (pct > 0 && pct < 100) {
        process.stdout.write(`\r  Scanning events... ${pct}%`);
      }
    }
  }

  if (tokenIdSet.size > 0) {
    process.stdout.write(`\r  Found ${tokenIdSet.size} unique token IDs from events\n`);
  }

  if (tokenIdSet.size === 0) return [];

  // Check current balances for discovered tokens
  const tokenIds = [...tokenIdSet];
  const balances = await getTokenBalances(wallet, env, tokenIds);
  return balances.filter((b) => !b.balance.isZero());
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
