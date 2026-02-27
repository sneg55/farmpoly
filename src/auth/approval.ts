import { Contract, Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { EnvConfig } from "../utils/config.js";
import {
  USDC_ADDRESS,
  CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
  CONDITIONAL_TOKENS,
  ERC20_ABI,
  ERC1155_ABI,
} from "../contracts/addresses.js";

const MAX_UINT256 = ethers.constants.MaxUint256;

/**
 * Build gas overrides suitable for Polygon (requires higher tip than ethers v5 defaults).
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

export interface ApprovalStatus {
  balance: BigNumber;
  ctfExchangeAllowance: BigNumber;
  negRiskCtfExchangeAllowance: BigNumber;
  conditionalTokensAllowance: BigNumber;
  negRiskAdapterAllowance: BigNumber;
  needsApproval: boolean;
  needsNegRiskApproval: boolean;
  needsConditionalTokensApproval: boolean;
  needsNegRiskAdapterApproval: boolean;
}

export async function checkApproval(wallet: Wallet, env: EnvConfig): Promise<ApprovalStatus> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, signer);

  const [balance, ctfAllowance, negRiskAllowance, ctAllowance, adapterAllowance] = await Promise.all([
    usdc.balanceOf(wallet.address) as Promise<BigNumber>,
    usdc.allowance(wallet.address, CTF_EXCHANGE) as Promise<BigNumber>,
    usdc.allowance(wallet.address, NEG_RISK_CTF_EXCHANGE) as Promise<BigNumber>,
    usdc.allowance(wallet.address, CONDITIONAL_TOKENS) as Promise<BigNumber>,
    usdc.allowance(wallet.address, NEG_RISK_ADAPTER) as Promise<BigNumber>,
  ]);

  return {
    balance,
    ctfExchangeAllowance: ctfAllowance,
    negRiskCtfExchangeAllowance: negRiskAllowance,
    conditionalTokensAllowance: ctAllowance,
    negRiskAdapterAllowance: adapterAllowance,
    needsApproval: ctfAllowance.isZero(),
    needsNegRiskApproval: negRiskAllowance.isZero(),
    needsConditionalTokensApproval: ctAllowance.isZero(),
    needsNegRiskAdapterApproval: adapterAllowance.isZero(),
  };
}

export async function approveUSDC(
  wallet: Wallet,
  env: EnvConfig,
): Promise<{
  ctfTxHash?: string;
  negRiskTxHash?: string;
  conditionalTokensTxHash?: string;
  negRiskAdapterTxHash?: string;
}> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, signer);

  const status = await checkApproval(wallet, env);
  const gasOverrides = await getGasOverrides(provider);
  const result: {
    ctfTxHash?: string;
    negRiskTxHash?: string;
    conditionalTokensTxHash?: string;
    negRiskAdapterTxHash?: string;
  } = {};

  if (status.needsApproval) {
    const tx = await usdc.approve(CTF_EXCHANGE, MAX_UINT256, gasOverrides);
    await tx.wait();
    result.ctfTxHash = tx.hash;
  }

  if (status.needsNegRiskApproval) {
    const tx = await usdc.approve(NEG_RISK_CTF_EXCHANGE, MAX_UINT256, gasOverrides);
    await tx.wait();
    result.negRiskTxHash = tx.hash;
  }

  if (status.needsConditionalTokensApproval) {
    const tx = await usdc.approve(CONDITIONAL_TOKENS, MAX_UINT256, gasOverrides);
    await tx.wait();
    result.conditionalTokensTxHash = tx.hash;
  }

  if (status.needsNegRiskAdapterApproval) {
    const tx = await usdc.approve(NEG_RISK_ADAPTER, MAX_UINT256, gasOverrides);
    await tx.wait();
    result.negRiskAdapterTxHash = tx.hash;
  }

  return result;
}

// --- ConditionalTokens ERC1155 approvals (required for SELL orders) ---

export interface ConditionalTokenApprovalStatus {
  needsCtfExchangeApproval: boolean;
  needsNegRiskExchangeApproval: boolean;
  needsNegRiskAdapterApproval: boolean;
  needsAnyApproval: boolean;
}

export async function checkConditionalTokenApproval(
  wallet: Wallet,
  env: EnvConfig,
): Promise<ConditionalTokenApprovalStatus> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);
  const ct = new Contract(CONDITIONAL_TOKENS, ERC1155_ABI, signer);

  const [ctfApproved, negRiskApproved, adapterApproved] = await Promise.all([
    ct.isApprovedForAll(wallet.address, CTF_EXCHANGE) as Promise<boolean>,
    ct.isApprovedForAll(wallet.address, NEG_RISK_CTF_EXCHANGE) as Promise<boolean>,
    ct.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER) as Promise<boolean>,
  ]);

  return {
    needsCtfExchangeApproval: !ctfApproved,
    needsNegRiskExchangeApproval: !negRiskApproved,
    needsNegRiskAdapterApproval: !adapterApproved,
    needsAnyApproval: !ctfApproved || !negRiskApproved || !adapterApproved,
  };
}

export async function approveConditionalTokens(
  wallet: Wallet,
  env: EnvConfig,
): Promise<{
  ctfExchangeTxHash?: string;
  negRiskExchangeTxHash?: string;
  negRiskAdapterTxHash?: string;
}> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);
  const ct = new Contract(CONDITIONAL_TOKENS, ERC1155_ABI, signer);

  const status = await checkConditionalTokenApproval(wallet, env);
  const gasOverrides = await getGasOverrides(provider);
  const result: {
    ctfExchangeTxHash?: string;
    negRiskExchangeTxHash?: string;
    negRiskAdapterTxHash?: string;
  } = {};

  if (status.needsCtfExchangeApproval) {
    const tx = await ct.setApprovalForAll(CTF_EXCHANGE, true, gasOverrides);
    await tx.wait();
    result.ctfExchangeTxHash = tx.hash;
  }

  if (status.needsNegRiskExchangeApproval) {
    const tx = await ct.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true, gasOverrides);
    await tx.wait();
    result.negRiskExchangeTxHash = tx.hash;
  }

  if (status.needsNegRiskAdapterApproval) {
    const tx = await ct.setApprovalForAll(NEG_RISK_ADAPTER, true, gasOverrides);
    await tx.wait();
    result.negRiskAdapterTxHash = tx.hash;
  }

  return result;
}
