import axios from "axios";

const DEFAULT_BASE_URL = "https://data-api.polymarket.com";
const PAGE_SIZE = 500;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export interface DataApiPosition {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  redeemable: boolean;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  negativeRisk: boolean;
  endDate: string;
  proxyWallet: string;
}

export interface FetchPositionsOptions {
  sizeThreshold?: number;
  redeemable?: boolean;
  mergeable?: boolean;
  market?: string;
  limit?: number;
}

async function fetchWithRetry<T>(url: string, params: Record<string, any>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get<T>(url, { params, timeout: 15_000 });
      return response.data;
    } catch (err: any) {
      const status = err.response?.status;
      const isRetryable = !status || status >= 500 || status === 429;
      if (isRetryable && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error("fetchWithRetry: unreachable");
}

/**
 * Fetch all wallet positions from the Polymarket Data API.
 *
 * Auto-paginates up to PAGE_SIZE per page until exhausted.
 * Retries on transient errors (5xx, 429, network timeouts).
 *
 * @param address - Wallet address to query
 * @param options - Optional filters (sizeThreshold, redeemable, etc.)
 * @param baseUrl - Override Data API base URL (for testing/fallback)
 */
export async function fetchWalletPositions(
  address: string,
  options: FetchPositionsOptions = {},
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<DataApiPosition[]> {
  const allPositions: DataApiPosition[] = [];
  let offset = 0;
  const limit = options.limit ?? PAGE_SIZE;

  while (true) {
    const params: Record<string, any> = {
      user: address,
      limit,
      offset,
    };

    if (options.sizeThreshold !== undefined) params.sizeThreshold = options.sizeThreshold;
    if (options.redeemable !== undefined) params.redeemable = options.redeemable;
    if (options.mergeable !== undefined) params.mergeable = options.mergeable;
    if (options.market !== undefined) params.market = options.market;

    const page = await fetchWithRetry<DataApiPosition[]>(
      `${baseUrl}/positions`,
      params,
    );

    if (!Array.isArray(page) || page.length === 0) break;

    allPositions.push(...page);

    if (page.length < limit) break;
    offset += page.length;
  }

  return allPositions;
}
