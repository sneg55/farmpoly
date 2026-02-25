import { Contract, Wallet, ethers } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import {
  USDC_ADDRESS,
  CONDITIONAL_TOKENS,
  NEG_RISK_ADAPTER,
  CTF_SPLIT_ABI,
  NEG_RISK_SPLIT_ABI,
} from "../contracts/addresses.js";

/**
 * Build gas overrides suitable for Polygon (which requires higher tip than ethers v5 defaults).
 * Same pattern as merger.ts / redeemer.ts.
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
 * Split USDC into YES + NO conditional tokens via ConditionalTokens.splitPosition.
 *
 * - Standard markets: ConditionalTokens.splitPosition(USDC, 0x0, conditionId, [1,2], amount)
 * - NegRisk markets: NegRiskAdapter.splitPosition(conditionId, amount)
 *
 * USDC amounts use 6 decimals.
 *
 * @param amountUsdc - Amount in USDC (human-readable, e.g. 50 for $50)
 * @returns Transaction hash
 */
export async function splitPosition(
  wallet: Wallet,
  env: EnvConfig,
  conditionId: string,
  negRisk: boolean,
  amountUsdc: number,
): Promise<string> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);
  const gasOverrides = await getGasOverrides(provider);

  const amount = ethers.utils.parseUnits(amountUsdc.toFixed(6), 6);

  if (negRisk) {
    const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_SPLIT_ABI, signer);

    // Preflight check
    await adapter.estimateGas.splitPosition(conditionId, amount, gasOverrides);

    const tx = await adapter.splitPosition(conditionId, amount, gasOverrides);
    await tx.wait();
    return tx.hash;
  }

  // Standard CTF market
  const ctf = new Contract(CONDITIONAL_TOKENS, CTF_SPLIT_ABI, signer);
  const parentCollectionId = ethers.constants.HashZero;
  const indexSets = [1, 2];

  // Preflight check
  await ctf.estimateGas.splitPosition(
    USDC_ADDRESS, parentCollectionId, conditionId, indexSets, amount, gasOverrides,
  );

  const tx = await ctf.splitPosition(
    USDC_ADDRESS, parentCollectionId, conditionId, indexSets, amount, gasOverrides,
  );
  await tx.wait();
  return tx.hash;
}
