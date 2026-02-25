// Polygon USDC (PoS bridged)
export const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

// Polymarket CTF Exchange contract
export const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

// NegRisk CTF Exchange
export const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

// NegRisk Adapter
export const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// ConditionalTokens ERC1155 contract
export const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

// --- ABI Fragments ---

export const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

export const ERC1155_ABI = [
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
];

export const ERC1155_BALANCE_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
];

export const CTF_REDEEM_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

export const NEG_RISK_REDEEM_ABI = [
  "function redeemPositions(bytes32 conditionId, uint256[] amounts)",
];

export const CTF_MERGE_ABI = [
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount)",
];

export const NEG_RISK_MERGE_ABI = [
  "function mergePositions(bytes32 conditionId, uint256 amount)",
];
