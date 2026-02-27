import { Contract, Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { ClobClient } from "@polymarket/clob-client";
import type { EnvConfig } from "../utils/config.js";
import type { PolyfarmDb, MarketRow } from "../db/database.js";
import { CONDITIONAL_TOKENS, ERC1155_BALANCE_ABI } from "../contracts/addresses.js";
import { fetchWalletPositions, type DataApiPosition } from "../api/positions-api.js";

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
 * @param fromBlock - Block to start scanning from (default: ~2 weeks back on Polygon)
 */
const LOG_CHUNK = 3_000; // blocks per eth_getLogs query (conservative for free RPCs)
const MAX_RETRIES = 3;

async function queryWithRetry(
  ct: Contract,
  filter: any,
  from: number,
  to: number,
): Promise<ethers.Event[]> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ct.queryFilter(filter, from, to);
    } catch (err: any) {
      const msg = err.message ?? "";
      const isRetryable = msg.includes("timed out") || msg.includes("-32002") || msg.includes("rate");
      if (isRetryable && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw err;
    }
  }
  return [];
}

export async function discoverHeldTokens(
  wallet: Wallet,
  env: EnvConfig,
  fromBlock?: number,
): Promise<TokenBalance[]> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const ct = new Contract(CONDITIONAL_TOKENS, ERC1155_BALANCE_ABI, provider);

  const currentBlock = await provider.getBlockNumber();
  // Default: ~2 weeks back (Polygon ~2s blocks → ~604,800 blocks)
  const startBlock = fromBlock ?? Math.max(0, currentBlock - 604_800);
  const totalBlocks = currentBlock - startBlock;

  console.log(`  Scanning blocks ${startBlock}..${currentBlock} (${totalBlocks.toLocaleString()} blocks)`);

  const tokenIdSet = new Set<string>();
  const singleFilter = ct.filters.TransferSingle(null, null, wallet.address);
  const batchFilter = ct.filters.TransferBatch(null, null, wallet.address);

  for (let from = startBlock; from <= currentBlock; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, currentBlock);

    try {
      // Run sequentially to avoid overwhelming free RPCs
      const singleLogs = await queryWithRetry(ct, singleFilter, from, to);
      const batchLogs = await queryWithRetry(ct, batchFilter, from, to);

      for (const log of singleLogs) {
        if (log.args) tokenIdSet.add(log.args.id.toString());
      }
      for (const log of batchLogs) {
        if (log.args) {
          for (const id of log.args.ids) tokenIdSet.add(id.toString());
        }
      }
    } catch (err: any) {
      // Pruned history — skip forward
      const msg = err.message ?? "";
      if (msg.includes("pruned") || msg.includes("-32701")) {
        const skip = Math.min(100_000, currentBlock - from);
        from += skip - LOG_CHUNK;
        continue;
      }
      throw err;
    }

    // Progress every ~100k blocks
    const scanned = from - startBlock + LOG_CHUNK;
    if (totalBlocks > 0 && scanned % 100_000 < LOG_CHUNK) {
      const pct = Math.min(99, Math.round((scanned / totalBlocks) * 100));
      process.stdout.write(`\r  Scanning events... ${pct}%`);
    }
  }

  process.stdout.write(`\r  Scan complete — ${tokenIdSet.size} unique token ID(s) found\n`);

  if (tokenIdSet.size === 0) return [];

  // Check current balances for discovered tokens
  const tokenIds = [...tokenIdSet];
  const balances = await getTokenBalances(wallet, env, tokenIds);
  const nonZero = balances.filter((b) => !b.balance.isZero());
  return nonZero;
}

/**
 * Discover held tokens via the Polymarket Data API (single HTTP call).
 * Returns the same TokenBalance[] shape as discoverHeldTokens() for backward compat,
 * plus enriched DataApiPosition data for callers that need it.
 */
export async function discoverHeldTokensViaApi(
  address: string,
  baseUrl?: string,
): Promise<{ balances: TokenBalance[]; positions: DataApiPosition[] }> {
  const positions = await fetchWalletPositions(
    address,
    { sizeThreshold: 0 },
    baseUrl,
  );

  const balances: TokenBalance[] = positions
    .filter((p) => p.size > 0)
    .map((p) => ({
      tokenId: p.asset,
      balance: ethers.utils.parseUnits(p.size.toFixed(6), 6),
    }));

  return { balances, positions };
}

export interface DiscoveredPosition {
  tokenId: string;
  balance: BigNumber;
  conditionId?: string;
  negRisk?: boolean;
  redeemable?: boolean;
  title?: string;
  curPrice?: number;
  outcome?: string;
  oppositeAsset?: string;
}

/**
 * Unified position discovery: tries Polymarket Data API first, falls back to RPC event scanning.
 */
export async function discoverPositions(
  wallet: Wallet,
  env: EnvConfig,
): Promise<DiscoveredPosition[]> {
  // Primary: Data API
  try {
    const { positions } = await discoverHeldTokensViaApi(wallet.address, env.dataApiUrl);
    return positions
      .filter((p) => p.size > 0)
      .map((p) => ({
        tokenId: p.asset,
        balance: ethers.utils.parseUnits(p.size.toFixed(6), 6),
        conditionId: p.conditionId,
        negRisk: p.negativeRisk,
        redeemable: p.redeemable,
        title: p.title,
        curPrice: p.curPrice,
        outcome: p.outcome,
        oppositeAsset: p.oppositeAsset,
      }));
  } catch (err) {
    console.log(`  Data API unavailable, falling back to RPC scan: ${(err as Error).message?.slice(0, 100)}`);
  }

  // Fallback: RPC event scanning
  const rpcBalances = await discoverHeldTokens(wallet, env);
  return rpcBalances.map((b) => ({
    tokenId: b.tokenId,
    balance: b.balance,
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
