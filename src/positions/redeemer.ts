import { Contract, Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import {
  USDC_ADDRESS,
  CONDITIONAL_TOKENS,
  NEG_RISK_ADAPTER,
  CTF_REDEEM_ABI,
  NEG_RISK_REDEEM_ABI,
} from "../contracts/addresses.js";

export interface RedeemResult {
  conditionId: string;
  txHash: string;
  negRisk: boolean;
}

/**
 * Build gas overrides suitable for Polygon (which requires higher tip than ethers v5 defaults).
 */
async function getGasOverrides(provider: ethers.providers.JsonRpcProvider) {
  const feeData = await provider.getFeeData();
  // Polygon minimum tip is ~25 gwei; use 35 gwei for safety
  const minTip = ethers.utils.parseUnits("35", "gwei");
  const maxPriorityFeePerGas =
    feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minTip)
      ? feeData.maxPriorityFeePerGas
      : minTip;
  // maxFeePerGas = 2 * baseFee + tip (generous ceiling)
  const baseFee = feeData.lastBaseFeePerGas ?? ethers.utils.parseUnits("30", "gwei");
  const maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas);

  return { maxPriorityFeePerGas, maxFeePerGas };
}

/**
 * Dry-run a redeem call via estimateGas to check if the market is resolved.
 * Returns null if OK, or an error message if it would revert.
 */
async function preflight(
  contract: Contract,
  method: string,
  args: any[],
  gasOverrides: Record<string, any>,
): Promise<string | null> {
  try {
    await contract.estimateGas[method](...args, gasOverrides);
    return null;
  } catch (err: any) {
    const msg = err.reason ?? err.message ?? String(err);
    if (msg.includes("not received yet")) {
      return "market not resolved yet";
    }
    return msg;
  }
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
  const gasOverrides = await getGasOverrides(provider);

  if (negRisk) {
    const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_REDEEM_ABI, signer);
    const amounts = [balanceYes, balanceNo];

    // Preflight check — skip if market not resolved
    const err = await preflight(adapter, "redeemPositions", [conditionId, amounts], gasOverrides);
    if (err) throw new Error(err);

    const tx = await adapter.redeemPositions(conditionId, amounts, gasOverrides);
    await tx.wait();
    return { conditionId, txHash: tx.hash, negRisk: true };
  }

  // Standard CTF market
  const ctf = new Contract(CONDITIONAL_TOKENS, CTF_REDEEM_ABI, signer);
  const parentCollectionId = ethers.constants.HashZero;
  const indexSets = [1, 2];
  const args = [USDC_ADDRESS, parentCollectionId, conditionId, indexSets];

  // Preflight check
  const err = await preflight(ctf, "redeemPositions", args, gasOverrides);
  if (err) throw new Error(err);

  const tx = await ctf.redeemPositions(...args, gasOverrides);
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
 * Runs sequentially to handle nonce ordering correctly.
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

  const redeemed: RedeemResult[] = [];
  const failed: { conditionId: string; error: string }[] = [];

  for (const p of redeemable) {
    try {
      const result = await redeemPosition(
        wallet, env, p.conditionId, p.negRisk, p.balanceYes, p.balanceNo,
      );
      redeemed.push(result);
    } catch (err: any) {
      const msg = err.message ?? String(err);
      failed.push({ conditionId: p.conditionId, error: msg });
    }
  }

  return { redeemed, failed, skipped };
}
