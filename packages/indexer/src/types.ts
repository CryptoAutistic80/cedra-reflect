import type {
  Address,
  CedraTestnetChainId,
  MaterializationTrigger,
  ProtocolLifecycle,
  SwapDirection,
} from "../../protocol-sdk/src/types.js";

export type EventId = string;
export type EventSource = "chain" | "replay" | "fixture";
export type AlertSeverity = "critical" | "warning" | "info";
export type LpEpochStatus = "active" | "claim-only";

export interface EventCursor {
  readonly ledgerVersion: bigint;
  readonly eventIndex: number;
}

export interface EventBase {
  readonly id: EventId;
  readonly txHash: string;
  readonly ledgerVersion: bigint;
  readonly eventIndex: number;
  readonly timestampUnixMilliseconds: bigint;
  readonly source: EventSource;
}

export interface ProtocolInitializedEvent extends EventBase {
  readonly type: "ProtocolInitialized";
  readonly deploymentId: string;
  readonly networkLabel: string;
  readonly tokenMetadata: Address;
  readonly automaticMaterialization: boolean;
  readonly feeBps: bigint;
  readonly initialIndex: bigint;
  readonly packageVersion: string;
  readonly rewardVault: Address;
  readonly distributionVault: Address;
  readonly protocolExclusionSlots: bigint;
}

/** v0.2 creation event. ProtocolInitialized is retained only for v0.1 replay. */
export interface TokenCreatedEvent extends EventBase {
  readonly type: "TokenCreated";
  readonly eventSchema: "v0.2";
  readonly deploymentId: string;
  readonly networkLabel: string;
  readonly tokenMetadata: Address;
  readonly rewardVault: Address;
  readonly distributionVault: Address;
  readonly reflectionFeeBps: bigint;
  readonly totalSupply: bigint;
  readonly decimals: bigint;
  readonly packageVersion: string;
}

export interface LaunchSealedEvent extends EventBase {
  readonly type: "LaunchSealed";
  readonly eventSchema: "v0.2";
  readonly reflectionFeeBps: bigint;
  readonly ammFeeBps: bigint;
  readonly maximumReserveBps: bigint;
  readonly maximumGrossSwap: bigint;
  readonly maximumRflContribution: bigint;
  readonly maximumTusdContribution: bigint;
  readonly maximumNonFinalWithdrawalShareBps: bigint;
  readonly faucetTrflGrant: bigint;
  readonly faucetTusdGrant: bigint;
  readonly faucetCooldownSeconds: bigint;
  readonly bootstrap: Address;
  readonly rflReserve: Address;
  readonly usdReserve: Address;
  readonly lpRewardVault: Address;
  readonly seedRfl: bigint;
  readonly seedUsd: bigint;
  readonly initialLpShares: bigint;
}

export interface PoolClosedEvent extends EventBase {
  readonly type: "PoolClosed";
  readonly eventSchema: "v0.2";
  readonly provider: Address;
  readonly epoch: bigint;
  readonly lpShares: bigint;
  readonly rflOutput: bigint;
  readonly usdOutput: bigint;
  readonly rflReserveAfter: bigint;
  readonly usdReserveAfter: bigint;
}

export interface ProtocolPrimaryStoreExcludedEvent extends EventBase {
  readonly type: "ProtocolPrimaryStoreExcluded";
  readonly account: Address;
  readonly store: Address;
  readonly remainingSlots: bigint;
}

/**
 * Permanent exclusion created when a co-signing operations account is first
 * appointed. Unlike publisher bootstrap exclusions, it consumes no finite
 * protocol-exclusion slot.
 */
export interface OperationalPrimaryStoreExcludedEvent extends EventBase {
  readonly type: "OperationalPrimaryStoreExcluded";
  readonly account: Address;
  readonly store: Address;
}

export interface PositionCreatedEvent extends EventBase {
  readonly type: "PositionCreated";
  readonly account: Address;
}

export interface WalletRegisteredEvent extends EventBase {
  readonly type: "WalletRegistered";
  readonly account: Address;
  readonly primaryStore: Address;
  /** Exact post-registration u64 counter emitted by reflection-core. */
  readonly registeredWalletCount: bigint;
}

export interface FaucetGrantEvent extends EventBase {
  readonly type: "FaucetGrant";
  readonly account: Address;
  readonly asset: "tRFL" | "tUSD";
  readonly amount: bigint;
}

export interface FaucetConfiguredEvent extends EventBase {
  readonly type: "FaucetConfigured";
  readonly trflGrant: bigint;
  readonly tusdGrant: bigint;
  readonly cooldownSeconds: bigint;
}

export interface PoolReserveBoundEvent extends EventBase {
  readonly type: "PoolReserveBound";
  readonly reserveStore: Address;
  readonly custodian: Address;
}

/** Informational router receipt. Native hook endpoints are the accounting authority. */
export interface WalletTransferEvent extends EventBase {
  readonly type: "WalletTransfer";
  readonly from: Address;
  readonly to: Address;
  readonly asset: "tRFL" | "tUSD";
  readonly amount: bigint;
}

export interface EligibleBalanceDebitedEvent extends EventBase {
  readonly type: "EligibleBalanceDebited";
  readonly account: Address;
  readonly amount: bigint;
}

export interface EligibleBalanceCreditedEvent extends EventBase {
  readonly type: "EligibleBalanceCredited";
  readonly account: Address;
  readonly amount: bigint;
}

export interface SwapExecutedEvent extends EventBase {
  readonly type: "SwapExecuted";
  readonly account: Address;
  readonly direction: SwapDirection;
  readonly grossAmount: bigint;
  readonly reflectionFee: bigint;
  readonly ammFee: bigint;
  readonly netReserveInput: bigint;
  readonly grossPoolOutput: bigint;
  readonly netUserReceipt: bigint;
  readonly trflReserveAfter: bigint;
  readonly tusdReserveAfter: bigint;
}

export interface ReflectionFeeCollectedEvent extends EventBase {
  readonly type: "ReflectionFeeCollected";
  readonly swapTxHash: string;
  readonly grossAmount: bigint;
  readonly feeAmount: bigint;
  readonly feeBps: bigint;
}

export interface ReflectionIndexAdvancedEvent extends EventBase {
  readonly type: "ReflectionIndexAdvanced";
  readonly previousIndex: bigint;
  readonly newIndex: bigint;
  readonly indexRemainder: bigint;
  readonly feeAmount: bigint;
  readonly eligibleSupply: bigint;
}

export interface RewardsMaterializedEvent extends EventBase {
  readonly type: "RewardsMaterialized";
  readonly account: Address;
  readonly amount: bigint;
  readonly totalClaimed: bigint;
  /** Always present in v0.2; absent only in legacy v0.1 fixtures. */
  readonly trigger?: MaterializationTrigger;
}

export interface RewardsClaimedEvent extends EventBase {
  readonly type: "RewardsClaimed";
  readonly account: Address;
  readonly amount: bigint;
  readonly totalClaimed: bigint;
}

export interface CustodySharesChangedEvent extends EventBase {
  readonly type: "CustodySharesChanged";
  readonly added: boolean;
  readonly amount: bigint;
  readonly custodyShares: bigint;
  readonly globalShares: bigint;
}

export interface CustodyAdapterRegisteredEvent extends EventBase {
  readonly type: "CustodyAdapterRegistered";
  readonly adapterId: bigint;
  readonly reserveStore: Address;
  readonly firstEpoch: bigint;
  readonly lpRewardVault: Address;
}

export interface CustodyEpochRouteOpenedEvent extends EventBase {
  readonly type: "CustodyEpochRouteOpened";
  readonly adapterId: bigint;
  readonly epoch: bigint;
  readonly reserveStore: Address;
  readonly lpRewardVault: Address;
  readonly retiredResidueMagnified: bigint;
}

export interface CustodyRewardsRoutedEvent extends EventBase {
  readonly type: "CustodyRewardsRouted";
  readonly reserveStore: Address;
  readonly lpRewardVault: Address;
  readonly epoch: bigint;
  readonly amount: bigint;
  readonly totalRouted: bigint;
}

export interface FeeConfigurationChangedEvent extends EventBase {
  readonly type: "FeeConfigurationChanged";
  readonly oldFeeBps: bigint;
  readonly newFeeBps: bigint;
}

export interface SwapLimitsChangedEvent extends EventBase {
  readonly type: "SwapLimitsChanged";
  readonly ammFeeBps: bigint;
  readonly maximumGrossSwap: bigint;
  readonly maximumReserveBps: bigint;
}

export interface LiquidityLimitsChangedEvent extends EventBase {
  readonly type: "LiquidityLimitsChanged";
  readonly maximumRflContribution: bigint;
  readonly maximumTusdContribution: bigint;
  readonly maximumNonFinalWithdrawalShareBps: bigint;
}

export interface PauseStateChangedEvent extends EventBase {
  readonly type: "PauseStateChanged";
  readonly swapsPaused: boolean;
  readonly claimsPaused: boolean;
}

export interface FaucetPauseChangedEvent extends EventBase {
  readonly type: "FaucetPauseChanged";
  readonly paused: boolean;
}

export interface PoolPauseChangedEvent extends EventBase {
  readonly type: "PoolPauseChanged";
  readonly poolPaused: boolean;
  readonly liquidityPaused: boolean;
  readonly lpClaimsPaused: boolean;
  readonly shutdownMode: boolean;
}

export type OperationalAdminScope = "reflection-core" | "test-assets" | "test-amm";

export interface OperationalAdminChangedEvent extends EventBase {
  readonly type: "OperationalAdminChanged";
  readonly scope: OperationalAdminScope;
  readonly oldOperationalAdmin: Address;
  readonly newOperationalAdmin: Address;
}

export interface LiquiditySeededEvent extends EventBase {
  readonly type: "LiquiditySeeded";
  readonly epoch: bigint;
  readonly provider: Address;
  readonly trflAmount: bigint;
  readonly tusdAmount: bigint;
  readonly lpShares: bigint;
  readonly trflReserveAfter: bigint;
  readonly tusdReserveAfter: bigint;
}

export interface LiquidityAddedEvent extends EventBase {
  readonly type: "LiquidityAdded";
  readonly epoch: bigint;
  readonly provider: Address;
  readonly trflAmount: bigint;
  readonly tusdAmount: bigint;
  readonly lpShares: bigint;
  readonly trflReserveAfter: bigint;
  readonly tusdReserveAfter: bigint;
}

export interface LiquidityRemovedEvent extends EventBase {
  readonly type: "LiquidityRemoved";
  readonly epoch: bigint;
  readonly provider: Address;
  readonly trflAmount: bigint;
  readonly tusdAmount: bigint;
  readonly lpShares: bigint;
  readonly finalExit: boolean;
  readonly trflReserveAfter: bigint;
  readonly tusdReserveAfter: bigint;
}

export interface LpEpochOpenedEvent extends EventBase {
  readonly type: "LpEpochOpened";
  readonly epoch: bigint;
  readonly stateId: Address;
  readonly rewardVault: Address;
}

export interface LpEpochStatusChangedEvent extends EventBase {
  readonly type: "LpEpochStatusChanged";
  readonly epoch: bigint;
  readonly oldStatus: LpEpochStatus;
  readonly newStatus: LpEpochStatus;
}

export interface LpSharesChangedEvent extends EventBase {
  readonly type: "LpSharesChanged";
  readonly epoch: bigint;
  readonly owner: Address;
  readonly added: boolean;
  readonly amount: bigint;
  readonly ownerShares: bigint;
  readonly totalShares: bigint;
}

export interface LpSharesTransferredEvent extends EventBase {
  readonly type: "LpSharesTransferred";
  readonly epoch: bigint;
  readonly sender: Address;
  readonly recipient: Address;
  readonly amount: bigint;
}

export interface LpRewardIndexAdvancedEvent extends EventBase {
  readonly type: "LpRewardIndexAdvanced";
  readonly epoch: bigint;
  readonly previousIndex: bigint;
  readonly newIndex: bigint;
  readonly indexRemainder: bigint;
  readonly received: bigint;
  readonly totalShares: bigint;
  readonly roundingReserve: bigint;
}

export interface LpRewardsClaimedEvent extends EventBase {
  readonly type: "LpRewardsClaimed";
  readonly epoch: bigint;
  readonly owner: Address;
  readonly amount: bigint;
  readonly totalClaimed: bigint;
}

export interface LpRewardQuarantinedEvent extends EventBase {
  readonly type: "LpRewardQuarantined";
  readonly epoch: bigint;
  readonly amount: bigint;
  readonly unallocatedRewards: bigint;
  readonly rewardVault: Address;
}

export interface LpFractionalResidueRetiredEvent extends EventBase {
  readonly type: "LpFractionalResidueRetired";
  readonly epoch: bigint;
  readonly owner: Address;
  /** Fractional correction units scaled by REFLECTION_MAGNITUDE (u256). */
  readonly residueMagnified: bigint;
  readonly cumulativeRetiredResidueMagnified: bigint;
  /** Physical tRFL base units retained in the epoch vault (u128). */
  readonly roundingReserveBaseUnits: bigint;
}

export interface LpEpochTerminalDustClassifiedEvent extends EventBase {
  readonly type: "LpEpochTerminalDustClassified";
  readonly epoch: bigint;
  readonly rewardVault: Address;
  /** Physical tRFL base units remaining at terminal classification (u128). */
  readonly terminalRoundingBaseUnits: bigint;
  /** Cumulative fractional correction units scaled by REFLECTION_MAGNITUDE (u256). */
  readonly retiredResidueMagnified: bigint;
  readonly lifetimeReceivedBaseUnits: bigint;
  readonly lifetimeClaimedBaseUnits: bigint;
}

export type ProtocolEvent =
  | ProtocolInitializedEvent
  | TokenCreatedEvent
  | LaunchSealedEvent
  | PoolClosedEvent
  | ProtocolPrimaryStoreExcludedEvent
  | OperationalPrimaryStoreExcludedEvent
  | PositionCreatedEvent
  | WalletRegisteredEvent
  | FaucetGrantEvent
  | FaucetConfiguredEvent
  | PoolReserveBoundEvent
  | WalletTransferEvent
  | EligibleBalanceDebitedEvent
  | EligibleBalanceCreditedEvent
  | SwapExecutedEvent
  | ReflectionFeeCollectedEvent
  | ReflectionIndexAdvancedEvent
  | RewardsMaterializedEvent
  | RewardsClaimedEvent
  | CustodyAdapterRegisteredEvent
  | CustodyEpochRouteOpenedEvent
  | CustodySharesChangedEvent
  | CustodyRewardsRoutedEvent
  | FeeConfigurationChangedEvent
  | SwapLimitsChangedEvent
  | LiquidityLimitsChangedEvent
  | PauseStateChangedEvent
  | FaucetPauseChangedEvent
  | PoolPauseChangedEvent
  | OperationalAdminChangedEvent
  | LiquiditySeededEvent
  | LiquidityAddedEvent
  | LiquidityRemovedEvent
  | LpEpochOpenedEvent
  | LpEpochStatusChangedEvent
  | LpSharesChangedEvent
  | LpSharesTransferredEvent
  | LpRewardIndexAdvancedEvent
  | LpRewardsClaimedEvent
  | LpRewardQuarantinedEvent
  | LpFractionalResidueRetiredEvent
  | LpEpochTerminalDustClassifiedEvent;

export interface IndexedPosition {
  readonly account: Address;
  readonly rawTrfl: bigint;
  readonly rawTusd: bigint;
  /** Signed magnified-dividend correction represented by a native bigint. */
  readonly correction: bigint;
  /** All wallet reward materialisations, including implicit ones. */
  readonly claimed: bigint;
  readonly lifetimeClaimed: bigint;
  readonly lifetimeMaterialized: bigint;
}

export interface IndexedCustodyPosition {
  readonly adapterId: bigint | null;
  readonly reserveStore: Address | null;
  readonly activeRouteEpoch: bigint | null;
  readonly activeLpRewardVault: Address | null;
  readonly shares: bigint;
  readonly correction: bigint;
  readonly claimed: bigint;
  readonly lifetimeRouted: bigint;
}

export interface IndexedLpPosition {
  readonly owner: Address;
  readonly shares: bigint;
  readonly correction: bigint;
  readonly claimed: bigint;
}

export interface IndexedLpEpoch {
  readonly epoch: bigint;
  readonly stateId: Address;
  readonly status: LpEpochStatus;
  readonly rewardVault: Address;
  readonly index: bigint;
  readonly indexRemainder: bigint;
  readonly totalShares: bigint;
  readonly aggregateCorrection: bigint;
  readonly unallocatedRewards: bigint;
  readonly roundingReserve: bigint;
  /** Cumulative fractional correction units retired from zero-share owners. */
  readonly retiredResidueMagnified: bigint;
  /** Null until the active-to-claim-only transaction classifies terminal dust. */
  readonly terminalRoundingBaseUnits: bigint | null;
  readonly lifetimeReceived: bigint;
  readonly lifetimeClaimed: bigint;
  readonly quarantined: boolean;
  readonly positions: ReadonlyMap<Address, IndexedLpPosition>;
}

export interface IndexedPool {
  readonly trflReserve: bigint;
  readonly tusdReserve: bigint;
  readonly ammFeeBps: bigint;
  readonly maximumGrossSwap: bigint;
  readonly maximumReserveBps: bigint;
  readonly maximumRflContribution: bigint;
  readonly maximumTusdContribution: bigint;
  readonly maximumNonFinalWithdrawalShareBps: bigint;
  readonly poolPaused: boolean;
  readonly liquidityPaused: boolean;
  readonly lpClaimsPaused: boolean;
  readonly shutdownMode: boolean;
  readonly seeded: boolean;
}

/** Event-replayed values. They are an independent witness, not a chain response. */
export interface ProtocolProjection {
  /** Fixed consensus identity for every event, view, and durable checkpoint. */
  readonly chainId: CedraTestnetChainId;
  readonly deploymentId: string;
  readonly networkLabel: string;
  readonly tokenMetadata: Address | null;
  readonly protocolExclusionSlots: bigint;
  readonly protocolExclusionsRemaining: bigint;
  readonly protocolExcludedStores: ReadonlyMap<Address, Address>;
  /** Exact event-authenticated wallet -> canonical primary-store binding. */
  readonly registeredWallets: ReadonlyMap<Address, Address>;
  readonly registeredWalletCount: bigint;
  readonly automaticMaterialization: boolean;
  readonly feeBps: bigint;
  readonly currentIndex: bigint;
  readonly indexRemainder: bigint;
  readonly eligibleSupply: bigint;
  readonly aggregateCorrection: bigint;
  readonly unallocatedFees: bigint;
  readonly roundingReserve: bigint;
  readonly rewardVault: Address | null;
  readonly distributionVault: Address | null;
  /** Immutable tUSD reserve selected by the one-shot settlement capability. */
  readonly mockUsdPoolReserve: Address | null;
  readonly rewardVaultCredits: bigint;
  readonly rewardVaultPayouts: bigint;
  readonly lifetimeSwapFees: bigint;
  readonly lifetimeMaterialized: bigint;
  readonly lifetimeCustodyRouted: bigint;
  readonly packageVersion: string;
  /** Present after v0.2 TokenCreated replay; absent on legacy v0.1 snapshots. */
  readonly lifecycle?: ProtocolLifecycle;
  readonly swapsPaused: boolean;
  readonly claimsPaused: boolean;
  readonly faucetPaused: boolean;
  readonly faucetTrflGrant: bigint;
  readonly faucetTusdGrant: bigint;
  readonly faucetCooldownSeconds: bigint;
  readonly operationalAdmins: {
    readonly reflectionCore: Address | null;
    readonly testAssets: Address | null;
    readonly testAmm: Address | null;
  };
  /** True only after all three package authority histories have been replayed. */
  readonly deploymentReady: boolean;
  readonly pool: IndexedPool;
  readonly custody: IndexedCustodyPosition;
  readonly activeLpEpoch: bigint | null;
  readonly lpEpochs: ReadonlyMap<bigint, IndexedLpEpoch>;
  readonly rewardVaultToEpoch: ReadonlyMap<Address, bigint>;
  readonly stateIdToEpoch: ReadonlyMap<Address, bigint>;
  readonly positions: ReadonlyMap<Address, IndexedPosition>;
  /** Event id -> immutable ledger cursor; persisted to detect identifier reuse. */
  readonly seenEventIds: ReadonlyMap<EventId, string>;
}

export interface ObservedPosition {
  readonly account: Address;
  readonly rawTrfl: bigint;
  readonly correction: bigint;
  readonly claimed: bigint;
}

export interface ObservedLpPosition {
  readonly owner: Address;
  readonly shares: bigint;
  readonly correction: bigint;
  readonly claimed: bigint;
}

export interface ObservedLpEpoch {
  readonly epoch: bigint;
  readonly stateId: Address;
  readonly status: LpEpochStatus;
  readonly rewardVault: Address;
  readonly rewardVaultBalance: bigint;
  readonly index: bigint;
  readonly indexRemainder: bigint;
  readonly totalShares: bigint;
  readonly aggregateCorrection: bigint;
  readonly unallocatedRewards: bigint;
  readonly roundingReserve: bigint;
  /** `pool::lp_epoch_terminal_dust` first return: physical u128 base units. */
  readonly terminalRoundingBaseUnits: bigint;
  /** `pool::lp_epoch_terminal_dust` second return: magnified u256 units. */
  readonly retiredResidueMagnified: bigint;
  readonly lifetimeReceived: bigint;
  readonly lifetimeClaimed: bigint;
  readonly quarantined: boolean;
  readonly indexedLiability: bigint;
  readonly positions: readonly ObservedLpPosition[];
}

/** Values fetched from on-chain views at one finalized ledger version. */
export interface ObservedAccountingSnapshot {
  readonly chainId: number;
  readonly ledgerVersion: bigint;
  readonly deploymentId: string;
  readonly networkLabel: string;
  readonly tokenMetadata: Address;
  readonly protocolExclusionsRemaining: bigint;
  /** Finalized `registered_wallet_count()` view. */
  readonly registeredWalletCount: bigint;
  /** Accounts independently confirmed through `wallet_is_registered(account)`. */
  readonly registeredWalletAccounts: readonly Address[];
  readonly automaticMaterialization: boolean;
  /** Present on v0.2 views; absent only for legacy v0.1 reconciliation fixtures. */
  readonly lifecycle?: ProtocolLifecycle;
  readonly reflectionFeeBps?: bigint;
  readonly rewardVault: Address;
  readonly rewardVaultBalance: bigint;
  readonly reflectionLiability: bigint;
  readonly currentIndex: bigint;
  readonly indexRemainder: bigint;
  readonly eligibleSupply: bigint;
  readonly aggregateCorrection: bigint;
  readonly unallocatedFees: bigint;
  readonly roundingReserve: bigint;
  readonly lifetimeSwapFees: bigint;
  readonly lifetimeMaterialized: bigint;
  readonly lifetimeCustodyRouted: bigint;
  readonly custodyAdapterId: bigint;
  readonly custodyReserveStore: Address;
  readonly poolRflReserveStore: Address;
  readonly poolUsdReserveStore: Address;
  readonly mockUsdPoolReserve: Address;
  readonly custodyReserveBalance: bigint;
  readonly custodyShares: bigint;
  readonly custodyCorrection: bigint;
  readonly custodyClaimed: bigint;
  readonly custodyPendingRewards: bigint;
  readonly custodyActiveRouteEpoch: bigint;
  readonly custodyActiveLpRewardVault: Address;
  readonly trflReserve: bigint;
  readonly tusdReserve: bigint;
  readonly ammFeeBps: bigint;
  readonly maximumGrossSwap: bigint;
  readonly maximumReserveBps: bigint;
  readonly maximumRflContribution: bigint;
  readonly maximumTusdContribution: bigint;
  readonly maximumNonFinalWithdrawalShareBps: bigint;
  readonly activeLpEpoch: bigint | null;
  readonly lpEpochs: readonly ObservedLpEpoch[];
  readonly positions: readonly ObservedPosition[];
  readonly packageVersion: string;
  readonly swapsPaused: boolean;
  readonly claimsPaused: boolean;
  readonly faucetPaused: boolean;
  readonly faucetTrflGrant: bigint;
  readonly faucetTusdGrant: bigint;
  readonly faucetCooldownSeconds: bigint;
  readonly poolPaused: boolean;
  readonly liquidityPaused: boolean;
  readonly lpClaimsPaused: boolean;
  readonly shutdownMode: boolean;
  readonly poolSeeded: boolean;
  /** Legacy v0.1-only views; absent in ownerless v0.2. */
  readonly coreOperationalAdmin?: Address;
  readonly faucetOperationalAdmin?: Address;
  readonly ammOperationalAdmin?: Address;
}

export interface CriticalAlert {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly code:
    | "EVENT_ORDER"
    | "EVENT_DATA"
    | "TRANSACTION_GROUP"
    | "IDENTIFIER_REUSE"
    | "DOUBLE_COUNTING"
    | "FEE_FORMULA"
    | "VAULT_BACKING"
    | "REFLECTION_LIABILITY"
    | "CORE_ACCOUNTING"
    | "GLOBAL_INDEX"
    | "ELIGIBLE_SUPPLY"
    | "LIFETIME_TOTAL"
    | "POOL_RESERVES"
    | "POOL_LIMITS"
    | "FAUCET_CONFIG"
    | "RESERVE_CUSTODY"
    | "CUSTODY_ACCOUNTING"
    | "ROUTE_PAIR"
    | "OLD_EPOCH_ROUTE"
    | "LP_ACCOUNTING"
    | "LP_VAULT_BACKING"
    | "VAULT_BINDING"
    | "POSITION_ACCOUNTING"
    | "WALLET_REGISTRATION"
    | "PACKAGE_VERSION"
    | "PAUSE_STATE"
    | "OPERATIONAL_ADMIN"
    | "DEPLOYMENT_IDENTITY"
    | "LEDGER_VERSION";
  readonly message: string;
  readonly detectedAtUnixMilliseconds: bigint;
  readonly cursor: EventCursor | null;
  readonly expected?: string;
  readonly observed?: string;
}

export interface LpReconciliationResult {
  readonly epoch: bigint;
  readonly expectedVaultBalance: bigint;
  readonly calculatedLiability: bigint;
  readonly backingSurplus: bigint;
}

export interface ReconciliationReport {
  readonly ledgerVersion: bigint;
  readonly expectedRewardVaultBalance: bigint;
  readonly calculatedReflectionLiability: bigint;
  readonly backingSurplus: bigint;
  readonly lpEpochs: readonly LpReconciliationResult[];
  readonly alerts: readonly CriticalAlert[];
  readonly reconciled: boolean;
}

export interface IndexerSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly takenAtUnixMilliseconds: bigint;
  readonly cursor: EventCursor | null;
  readonly projection: ProtocolProjection;
}

export interface EventPage {
  /** Consensus chain identity observed by the finalized event source. */
  readonly chainId: number;
  /** Sources must not split one ledger-version transaction across pages. */
  readonly events: readonly ProtocolEvent[];
  readonly nextCursor: EventCursor | null;
}

export interface ProtocolEventSource {
  listEvents(after: EventCursor | null, limit: number): Promise<EventPage>;
  getAccountingSnapshot(ledgerVersion: bigint): Promise<ObservedAccountingSnapshot>;
}

declare const indexerWriterLeaseBrand: unique symbol;

/** Store-issued, runtime identity-checked authority for one writer cycle. */
export interface IndexerWriterLease {
  readonly [indexerWriterLeaseBrand]: true;
}

export interface IndexerStore {
  /** In-memory stores may acquire a short implicit lease for test ergonomics. */
  readonly permitsImplicitWriterLease: boolean;
  /**
   * Execute one complete restore/poll/reconcile/checkpoint cycle while holding
   * the store's exclusive writer lease. Implementations must fail fast rather
   * than permit two concurrent writers.
   */
  withExclusiveWriter<T>(operation: (lease: IndexerWriterLease) => Promise<T>): Promise<T>;
  loadLatestSnapshot(): Promise<IndexerSnapshot | null>;
  saveSnapshot(
    snapshot: IndexerSnapshot,
    lease: IndexerWriterLease,
    expectedBaseSnapshotId: string | null,
  ): Promise<void>;
  appendAlerts(alerts: readonly CriticalAlert[], lease: IndexerWriterLease): Promise<void>;
  listAlerts(): Promise<readonly CriticalAlert[]>;
}
