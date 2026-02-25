import { Contract, Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import {
  USDC_ADDRESS,
  CONDITIONAL_TOKENS,
  NEG_RISK_ADAPTER,
  CTF_MERGE_ABI,
  NEG_RISK_MERGE_ABI,
} from "../contracts/addresses.js";

/**
 * Build gas overrides suitable for Polygon (which requires higher tip than ethers v5 defaults).
 * Shared with redeemer.ts pattern.
 */
async function getGasOverrides(provider: ethers.providers.JsonRpcProvider) {
  const feeData = await provider.getFeeData();
  const minTip = ethers.utils.parseUnits("35", "gwei");
  const maxPriorityFeePerGas =
    feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minTip)
      ? feeData.maxPriorityFeePerGas
      : minTip;
  const baseFee = feeData.lastBaseFeePerGas ?? ethers.utils.parseUnits("30", "gwei");
  const maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas);
  return { maxPriorityFeePerGas, maxFeePerGas };
}

/**
 * Merge YES + NO tokens back into USDC via ConditionalTokens.mergePositions.
 *
 * - Standard markets: ConditionalTokens.mergePositions(USDC, 0x0, conditionId, [1,2], amount)
 * - NegRisk markets: NegRiskAdapter.mergePositions(conditionId, amount)
 *
 * @returns Transaction hash
 */
export async function mergePositions(
  wallet: Wallet,
  env: EnvConfig,
  conditionId: string,
  negRisk: boolean,
  amount: BigNumber,
): Promise<string> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);
  const gasOverrides = await getGasOverrides(provider);

  if (negRisk) {
    const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_MERGE_ABI, signer);

    // Preflight check
    await adapter.estimateGas.mergePositions(conditionId, amount, gasOverrides);

    const tx = await adapter.mergePositions(conditionId, amount, gasOverrides);
    await tx.wait();
    return tx.hash;
  }

  // Standard CTF market
  const ctf = new Contract(CONDITIONAL_TOKENS, CTF_MERGE_ABI, signer);
  const parentCollectionId = ethers.constants.HashZero;
  const indexSets = [1, 2];

  // Preflight check
  await ctf.estimateGas.mergePositions(
    USDC_ADDRESS, parentCollectionId, conditionId, indexSets, amount, gasOverrides,
  );

  const tx = await ctf.mergePositions(
    USDC_ADDRESS, parentCollectionId, conditionId, indexSets, amount, gasOverrides,
  );
  await tx.wait();
  return tx.hash;
}
