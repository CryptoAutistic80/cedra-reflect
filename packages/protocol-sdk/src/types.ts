/**
 * Stable, SDK-neutral types. Amounts are always base units: bigint in memory,
 * never floating-point numbers.
 */
export type Address = `0x${string}`;

/** Cedra Testnet's consensus chain identifier. */
export const CEDRA_TESTNET_CHAIN_ID = 2 as const;
export type CedraTestnetChainId = typeof CEDRA_TESTNET_CHAIN_ID;

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

/** Exact finalized `pool::lp_epoch_terminal_dust` result with explicit units. */
export interface LpEpochTerminalDustSnapshot {
  readonly epoch: bigint;
  /** Physical tRFL base units returned as Move u128. */
  readonly terminalRoundingBaseUnits: bigint;
  /** Fractional correction units scaled by the protocol magnitude, Move u256. */
  readonly retiredResidueMagnified: bigint;
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
  /** Slippage selected by the caller and bound into the executable minimum. */
  readonly slippageBps: bigint;
  readonly reflectionFee: bigint;
  readonly ammFee: bigint;
  readonly netReserveInput: bigint;
  readonly grossPoolOutput: bigint;
  readonly netUserReceipt: bigint;
  readonly minimumNetUserReceipt: bigint;
  readonly priceImpactBps: bigint;
  readonly deadlineUnixSeconds: bigint;
  /** Exact finalized state used to independently reproduce quote economics. */
  readonly context: SwapQuoteContext;
}

export interface SwapQuoteContext {
  readonly chainId: CedraTestnetChainId;
  readonly ledgerVersion: bigint;
  readonly deploymentId: string;
  readonly packageVersion: string;
  readonly inputReserve: bigint;
  readonly outputReserve: bigint;
  readonly reflectionFeeBps: bigint;
  readonly ammFeeBps: bigint;
  readonly maximumGrossSwap: bigint;
  readonly maximumReserveBps: bigint;
}

declare const verifiedSwapQuoteBrand: unique symbol;

/** Opaque compile-time capability; runtime authority is client-instance-bound. */
export interface VerifiedSwapQuote extends SwapQuote {
  readonly [verifiedSwapQuoteBrand]: true;
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
    | "set_operational_admin"
    | "set_all_operational_admin"
    | "seed_liquidity"
    | "reseed_liquidity";
  readonly functionId: string;
  readonly arguments: readonly EntryArgument[];
  /**
   * Ordered Cedra secondary signers required by the Move ABI. An empty array
   * means the entry is single-signer. These addresses are transaction
   * authenticators, never forged entry-function arguments.
   */
  readonly secondarySignerAddresses: readonly Address[];
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
  getLpEpochTerminalDust(epoch: bigint): Promise<LpEpochTerminalDustSnapshot>;
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
