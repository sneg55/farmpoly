import type { Wallet } from "ethers";
import { ethers } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import type { TokenBalance } from "./fetcher.js";
import type { PolyfarmDb, MarketRow } from "../db/database.js";
import { redeemPosition } from "./redeemer.js";

export interface AutoRedeemResult {
  redeemed: { conditionId: string; txHash: string; usdcRecovered: number }[];
  skipped: number;
}

/**
 * Attempt to redeem resolved markets from a list of held token balances.
 *
 * Uses the existing `redeemPosition()` which has an `estimateGas` preflight —
 * unresolved markets will throw "market not resolved yet" and get skipped.
 *
 * @param heldTokens - Non-zero token balances from discoverHeldTokens()
 * @param markets - Known markets from DB (provides conditionId → tokenId mapping)
 */
export async function autoRedeemResolved(
  wallet: Wallet,
  env: EnvConfig,
  heldTokens: TokenBalance[],
  markets: MarketRow[],
): Promise<AutoRedeemResult> {
  // Build tokenId → balance map
  const balanceMap = new Map<string, ethers.BigNumber>();
  for (const t of heldTokens) {
    balanceMap.set(t.tokenId, t.balance);
  }

  // Group by conditionId using market data
  const candidates: {
    conditionId: string;
    negRisk: boolean;
    balanceYes: ethers.BigNumber;
    balanceNo: ethers.BigNumber;
    question: string;
  }[] = [];

  for (const m of markets) {
    const balYes = balanceMap.get(m.token_id_yes) ?? ethers.BigNumber.from(0);
    const balNo = balanceMap.get(m.token_id_no) ?? ethers.BigNumber.from(0);
    if (balYes.isZero() && balNo.isZero()) continue;

    candidates.push({
      conditionId: m.condition_id,
      negRisk: m.neg_risk === 1,
      balanceYes: balYes,
      balanceNo: balNo,
      question: m.question,
    });
  }

  const result: AutoRedeemResult = { redeemed: [], skipped: 0 };

  for (const c of candidates) {
    try {
      const { txHash } = await redeemPosition(
        wallet, env, c.conditionId, c.negRisk, c.balanceYes, c.balanceNo,
      );

      const recovered = Number(ethers.utils.formatUnits(
        c.balanceYes.gt(c.balanceNo) ? c.balanceYes : c.balanceNo, 6,
      ));
      result.redeemed.push({
        conditionId: c.conditionId,
        txHash,
        usdcRecovered: recovered,
      });
      console.log(`  Auto-redeemed $${recovered.toFixed(2)} from ${c.question.slice(0, 40)}... [tx: ${txHash.slice(0, 10)}...]`);
    } catch {
      // Expected for unresolved markets — estimateGas preflight rejects them
      result.skipped++;
    }
  }

  return result;
}
