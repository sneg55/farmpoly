import axios from "axios";

export interface ClobReward {
  id: string;
  conditionId: string;
  assetAddress: string;
  rewardsAmount: number;
  rewardsDailyRate: number;
  startDate: string;
  endDate: string;
}

/** Raw shape returned by GET gamma-api.polymarket.com/markets.
 *  outcomes, outcomePrices, and clobTokenIds arrive as JSON-encoded strings. */
export interface GammaMarketRaw {
  id: string;
  conditionId: string;
  question: string;
  outcomes: string | string[];          // JSON string e.g. '["Yes","No"]'
  outcomePrices: string | string[];     // JSON string e.g. '["0.55","0.45"]'
  clobTokenIds: string | string[];      // JSON string e.g. '["123...","456..."]'
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: string;           // string on the wire
  liquidityNum: number;        // numeric convenience field
  negRisk: boolean;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  rewardsMinSize: number;
  rewardsMaxSpread: number;
  clobRewards?: ClobReward[];
  oneDayPriceChange?: number;
  oneHourPriceChange?: number;
  volume24hr?: number;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
}

/** Normalized market shape for our internal use */
export interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  tokenIdYes: string;
  tokenIdNo: string;
  priceYes: number;
  priceNo: number;
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: number;
  negRisk: boolean;
  tickSize: number;
  minOrderSize: number;
  rewardsMinSize: number;
  rewardsMaxSpread: number;
  rewardsDailyRate: number;
  oneDayPriceChange: number;
  oneHourPriceChange: number;
  volume24hr: number;
  spread: number;
  bestBid: number;
  bestAsk: number;
}

function parseJsonField<T>(val: string | T[]): T[] | null {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return null; }
  }
  return null;
}

function normalizeMarket(raw: GammaMarketRaw): GammaMarket | null {
  // Parse JSON-encoded string fields from the API
  const outcomes = parseJsonField<string>(raw.outcomes);
  const outcomePrices = parseJsonField<string>(raw.outcomePrices);
  const clobTokenIds = parseJsonField<string>(raw.clobTokenIds);

  // Must have exactly 2 outcomes
  if (!outcomes || outcomes.length < 2) return null;
  if (!clobTokenIds || clobTokenIds.length < 2) return null;
  if (!outcomePrices || outcomePrices.length < 2) return null;

  // Find Yes/No indices
  const yesIdx = outcomes.indexOf("Yes");
  const noIdx = outcomes.indexOf("No");
  if (yesIdx === -1 || noIdx === -1) return null;

  // Extract daily reward rate from clobRewards array (pick the max if multiple)
  let rewardsDailyRate = 0;
  if (raw.clobRewards && raw.clobRewards.length > 0) {
    for (const r of raw.clobRewards) {
      if (r.rewardsDailyRate > rewardsDailyRate) {
        rewardsDailyRate = r.rewardsDailyRate;
      }
    }
  }

  return {
    id: raw.id,
    conditionId: raw.conditionId,
    question: raw.question,
    tokenIdYes: clobTokenIds[yesIdx],
    tokenIdNo: clobTokenIds[noIdx],
    priceYes: parseFloat(outcomePrices[yesIdx]) || 0,
    priceNo: parseFloat(outcomePrices[noIdx]) || 0,
    active: raw.active,
    closed: raw.closed,
    volume: raw.volume || 0,
    liquidity: raw.liquidityNum || parseFloat(raw.liquidity) || 0,
    negRisk: raw.negRisk ?? false,
    tickSize: raw.orderPriceMinTickSize || 0.01,
    minOrderSize: raw.orderMinSize || 5,
    rewardsMinSize: raw.rewardsMinSize || 5,
    rewardsMaxSpread: raw.rewardsMaxSpread || 0,
    rewardsDailyRate,
    oneDayPriceChange: raw.oneDayPriceChange ?? 0,
    oneHourPriceChange: raw.oneHourPriceChange ?? 0,
    volume24hr: raw.volume24hr ?? 0,
    spread: raw.spread ?? 0,
    bestBid: raw.bestBid ?? 0,
    bestAsk: raw.bestAsk ?? 0,
  };
}

export async function fetchGammaMarkets(
  baseUrl: string,
  options: {
    minTvl?: number;
    limit?: number;
    active?: boolean;
    closed?: boolean;
  } = {},
): Promise<GammaMarket[]> {
  const { minTvl = 10000, limit = 100, active = true, closed = false } = options;

  const allMarkets: GammaMarket[] = [];
  let offset = 0;

  while (true) {
    const params: Record<string, string | number | boolean> = {
      limit,
      active,
      closed,
      offset,
    };

    const response = await axios.get<GammaMarketRaw[]>(`${baseUrl}/markets`, { params });
    const rawMarkets = response.data;

    if (!Array.isArray(rawMarkets) || rawMarkets.length === 0) break;

    for (const raw of rawMarkets) {
      const market = normalizeMarket(raw);
      if (market && market.liquidity >= minTvl) {
        allMarkets.push(market);
      }
    }

    if (rawMarkets.length < limit) break;
    offset += rawMarkets.length;
  }

  return allMarkets;
}
