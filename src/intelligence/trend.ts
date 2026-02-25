export type TrendDirection = "UP" | "DOWN" | "SIDEWAYS" | "CHOPPY";

/**
 * Detect market trend direction from price change data.
 *
 * - |1h| > 3c AND same direction as 24h → TRENDING (UP or DOWN)
 * - |1h| < 1c AND |24h| < 3c → SIDEWAYS
 * - |1h| > 2c but opposite direction to 24h → CHOPPY (skip)
 * - Otherwise → SIDEWAYS (default safe)
 *
 * @param oneHourPriceChange - 1h price change (positive = up)
 * @param oneDayPriceChange - 24h price change (positive = up)
 */
export function detectTrend(
  oneHourPriceChange: number,
  oneDayPriceChange: number,
): TrendDirection {
  const absHour = Math.abs(oneHourPriceChange);
  const absDay = Math.abs(oneDayPriceChange);
  const sameDirection =
    (oneHourPriceChange >= 0 && oneDayPriceChange >= 0) ||
    (oneHourPriceChange < 0 && oneDayPriceChange < 0);

  // Strong short-term move aligned with daily trend → trending
  if (absHour > 0.03 && sameDirection) {
    return oneHourPriceChange > 0 ? "UP" : "DOWN";
  }

  // Short-term move opposite to daily trend → choppy
  if (absHour > 0.02 && !sameDirection) {
    return "CHOPPY";
  }

  // Calm market
  if (absHour < 0.01 && absDay < 0.03) {
    return "SIDEWAYS";
  }

  // Default to SIDEWAYS for moderate/ambiguous moves
  return "SIDEWAYS";
}

/**
 * Determine which order sides are allowed for a given trend.
 */
export function allowedSides(trend: TrendDirection): { bid: boolean; ask: boolean } {
  switch (trend) {
    case "UP":
      return { bid: false, ask: true }; // Price moving up → safe to sell (ASK)
    case "DOWN":
      return { bid: true, ask: false }; // Price moving down → safe to buy (BID)
    case "SIDEWAYS":
      return { bid: true, ask: true };  // Safe in both directions
    case "CHOPPY":
      return { bid: false, ask: false }; // Skip market entirely
  }
}
