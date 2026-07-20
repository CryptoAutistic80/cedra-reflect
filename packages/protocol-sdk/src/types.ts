/**
 * Stable, SDK-neutral types. Amounts are always base units: bigint in memory,
 * never floating-point numbers.
 */
export type Address = `0x${string}`;

export type AssetSymbol = "tRFL" | "tUSD" | "CED";

export type SwapDirection = "buy" | "sell";

export type OperationalAdminScope = "reflection-core" | "test-assets" | "test-amm";

export interface ProtocolAddresses {
  readonly tokenMetadata: Address;
  readonly mockUsdMetadata: Address;
  readonly rewardVault: Address;
  readonly distributionVault: Address;
  readonly pool: Address;
}

export interface ProtocolConfiguration {
  readonly networkLabel: "cedra-testnet" | "local";
  readonly deploymentId: string;
  readonly addresses: ProtocolAddresses;
  readonly feeBps: bigint;
  readonly ammFeeBps: bigint;
  readonly version: string;
}

export interface PortfolioSnapshot {
  readonly account: Address;
  readonly effectiveTrfl: bigint;
  readonly rawTrfl: bigint;
  readonly pendingReflections: bigint;
  readonly lifetimeClaimed: bigint;
  readonly eligibleSupply: bigint;
  readonly holderShares: bigint;
  readonly ledgerVersion: bigint;
}

export interface PoolSnapshot {
  readonly trflReserve: bigint;
  readonly tusdReserve: bigint;
  readonly swapsPaused: boolean;
  readonly maximumGrossSwap: bigint;
  readonly maximumReserveBps: bigint;
  readonly maximumRflContribution: bigint;
  readonly maximumTusdContribution: bigint;
  readonly maximumNonFinalWithdrawalShareBps: bigint;
  readonly ledgerVersion: bigint;
}

export interface ProtocolSnapshot {
  readonly automaticMaterialization: boolean;
  readonly eligibleHolders: bigint;
  readonly eligibleSupply: bigint;
  readonly rewardVaultBalance: bigint;
  readonly reflectionLiability: bigint;
  readonly lifetimeSwapFees: bigint;
  readonly lifetimeMaterialized: bigint;
  readonly currentIndex: bigint;
  readonly indexRemainder: bigint;
  readonly pool: PoolSnapshot;
  readonly claimsPaused: boolean;
  readonly faucetPaused: boolean;
  readonly packageVersion: string;
  readonly ledgerVersion: bigint;
}

export interface SwapQuote {
  readonly direction: SwapDirection;
  readonly grossAmount: bigint;
  readonly reflectionFee: bigint;
  readonly ammFee: bigint;
  readonly netReserveInput: bigint;
  readonly grossPoolOutput: bigint;
  readonly netUserReceipt: bigint;
  readonly minimumNetUserReceipt: bigint;
  readonly priceImpactBps: bigint;
  readonly deadlineUnixSeconds: bigint;
}

export interface FaucetStatus {
  readonly asset: "tRFL" | "tUSD";
  readonly account: Address;
  readonly grantAmount: bigint;
  readonly cooldownEndsAtUnixSeconds: bigint;
  readonly canClaim: boolean;
}

export type EntryArgument = string | bigint | boolean | Address;

/** A serialisable transaction description; creating one never signs or submits it. */
export interface TransactionDraft {
  readonly kind:
    | "faucet_claim"
    | "swap"
    | "claim_rewards"
    | "add_liquidity"
    | "remove_liquidity"
    | "transfer_lp_shares"
    | "claim_lp_rewards"
    | "checkpoint_lp_rewards"
    | "configure_liquidity_limits"
    | "set_faucet_paused"
    | "set_operational_admin";
  readonly functionId: string;
  readonly arguments: readonly EntryArgument[];
  readonly expirationUnixSeconds: bigint;
  readonly warning: string;
}

export interface SubmittedTransaction {
  readonly hash: string;
  readonly submittedAtUnixMilliseconds: bigint;
}

/**
 * Minimal adapter shape for the official Cedra SDK. This package deliberately
 * does not import a network SDK, wallet, key, or RPC endpoint.
 */
export interface CedraReadAdapter {
  getPortfolio(account: Address): Promise<PortfolioSnapshot>;
  getProtocol(): Promise<ProtocolSnapshot>;
  getPool(): Promise<PoolSnapshot>;
  getFaucetStatus(account: Address, asset: "tRFL" | "tUSD"): Promise<FaucetStatus>;
  quoteSwap(input: {
    readonly direction: SwapDirection;
    readonly grossAmount: bigint;
    readonly slippageBps: bigint;
    readonly deadlineUnixSeconds: bigint;
  }): Promise<SwapQuote>;
}

/** Explicitly opt-in adapter. It must only be supplied by the release app. */
export interface CedraWriteAdapter {
  submit(draft: TransactionDraft): Promise<SubmittedTransaction>;
}

export interface ProtocolClientOptions {
  readonly writer?: CedraWriteAdapter;
  readonly nowUnixSeconds?: () => bigint;
}
