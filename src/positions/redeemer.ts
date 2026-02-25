import { Contract, Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import {
  USDC_ADDRESS,
  CONDITIONAL_TOKENS,
  NEG_RISK_ADAPTER,
  CTF_REDEEM_ABI,
  NEG_RISK_REDEEM_ABI,
  ERC1155_BALANCE_ABI,
} from "../contracts/addresses.js";

export interface RedeemResult {
  conditionId: string;
  txHash: string;
  negRisk: boolean;
}

/**
 * Redeem a resolved conditional token position for USDC.
 *
 * For standard markets: calls ConditionalTokens.redeemPositions directly.
 * For negRisk markets: calls NegRiskAdapter.redeemPositions which unwraps to USDC.
 *
 * Safe to call on losing positions (just burns tokens for $0).
 */
export async function redeemPosition(
  wallet: Wallet,
  env: EnvConfig,
  conditionId: string,
  negRisk: boolean,
  balanceYes: BigNumber,
  balanceNo: BigNumber,
): Promise<RedeemResult> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);

  if (negRisk) {
    const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_REDEEM_ABI, signer);
    // NegRiskAdapter.redeemPositions(conditionId, amounts)
    // amounts = [balanceYes, balanceNo] for both outcomes
    const amounts = [balanceYes, balanceNo];
    const tx = await adapter.redeemPositions(conditionId, amounts);
    await tx.wait();
    return { conditionId, txHash: tx.hash, negRisk: true };
  }

  // Standard CTF market
  const ctf = new Contract(CONDITIONAL_TOKENS, CTF_REDEEM_ABI, signer);
  const parentCollectionId = ethers.constants.HashZero;
  // indexSets [1, 2] = both YES (index 0 -> 2^0=1) and NO (index 1 -> 2^1=2) outcomes
  const indexSets = [1, 2];

  const tx = await ctf.redeemPositions(
    USDC_ADDRESS,
    parentCollectionId,
    conditionId,
    indexSets,
  );
  await tx.wait();
  return { conditionId, txHash: tx.hash, negRisk: false };
}

export interface RedeemAllResult {
  redeemed: RedeemResult[];
  failed: { conditionId: string; error: string }[];
  skipped: number;
}

/**
 * Redeem all positions with non-zero balance.
 * Uses Promise.allSettled to handle individual failures without aborting.
 */
export async function redeemAll(
  wallet: Wallet,
  env: EnvConfig,
  positions: {
    conditionId: string;
    negRisk: boolean;
    balanceYes: BigNumber;
    balanceNo: BigNumber;
  }[],
): Promise<RedeemAllResult> {
  const redeemable = positions.filter(
    (p) => !p.balanceYes.isZero() || !p.balanceNo.isZero(),
  );
  const skipped = positions.length - redeemable.length;

  const results = await Promise.allSettled(
    redeemable.map((p) =>
      redeemPosition(wallet, env, p.conditionId, p.negRisk, p.balanceYes, p.balanceNo),
    ),
  );

  const redeemed: RedeemResult[] = [];
  const failed: { conditionId: string; error: string }[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      redeemed.push(result.value);
    } else {
      failed.push({
        conditionId: redeemable[i].conditionId,
        error: result.reason?.message ?? String(result.reason),
      });
    }
  }

  return { redeemed, failed, skipped };
}
