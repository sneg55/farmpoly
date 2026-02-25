import { Contract, Wallet, ethers } from "ethers";
import type { BigNumber } from "ethers";
import type { EnvConfig } from "../utils/config.js";

// Polygon USDC (PoS bridged)
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Polymarket CTF Exchange contract
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

// NegRisk CTF Exchange
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

// NegRisk Adapter
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// ConditionalTokens ERC1155 contract
const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

const ERC1155_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

const MAX_UINT256 = ethers.constants.MaxUint256;

export interface ApprovalStatus {
  balance: BigNumber;
  ctfExchangeAllowance: BigNumber;
  negRiskCtfExchangeAllowance: BigNumber;
  needsApproval: boolean;
  needsNegRiskApproval: boolean;
}

export async function checkApproval(wallet: Wallet, env: EnvConfig): Promise<ApprovalStatus> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, signer);

  const [balance, ctfAllowance, negRiskAllowance] = await Promise.all([
    usdc.balanceOf(wallet.address) as Promise<BigNumber>,
    usdc.allowance(wallet.address, CTF_EXCHANGE) as Promise<BigNumber>,
    usdc.allowance(wallet.address, NEG_RISK_CTF_EXCHANGE) as Promise<BigNumber>,
  ]);

  return {
    balance,
    ctfExchangeAllowance: ctfAllowance,
    negRiskCtfExchangeAllowance: negRiskAllowance,
    needsApproval: ctfAllowance.isZero(),
    needsNegRiskApproval: negRiskAllowance.isZero(),
  };
}

export async function approveUSDC(
  wallet: Wallet,
  env: EnvConfig,
): Promise<{ ctfTxHash?: string; negRiskTxHash?: string }> {
  const provider = new ethers.providers.JsonRpcProvider(env.polygonRpcUrl);
  const signer = wallet.connect(provider);
  const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, signer);

  const status = await checkApproval(wallet, env);
  const result: { ctfTxHash?: string; negRiskTxHash?: string } = {};

  if (status.needsApproval) {
    const tx = await usdc.approve(CTF_EXCHANGE, MAX_UINT256);
    await tx.wait();
    result.ctfTxHash = tx.hash;
  }

  if (status.needsNegRiskApproval) {
    const tx = await usdc.approve(NEG_RISK_CTF_EXCHANGE, MAX_UINT256);
    await tx.wait();
    result.negRiskTxHash = tx.hash;
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
  const result: {
    ctfExchangeTxHash?: string;
    negRiskExchangeTxHash?: string;
    negRiskAdapterTxHash?: string;
  } = {};

  if (status.needsCtfExchangeApproval) {
    const tx = await ct.setApprovalForAll(CTF_EXCHANGE, true);
    await tx.wait();
    result.ctfExchangeTxHash = tx.hash;
  }

  if (status.needsNegRiskExchangeApproval) {
    const tx = await ct.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true);
    await tx.wait();
    result.negRiskExchangeTxHash = tx.hash;
  }

  if (status.needsNegRiskAdapterApproval) {
    const tx = await ct.setApprovalForAll(NEG_RISK_ADAPTER, true);
    await tx.wait();
    result.negRiskAdapterTxHash = tx.hash;
  }

  return result;
}
