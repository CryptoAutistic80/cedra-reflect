import type { Address, SwapDirection } from "../../protocol-sdk/src/types.js";

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
  readonly automaticMaterialization: boolean;
  readonly feeBps: bigint;
  readonly initialIndex: bigint;
  readonly packageVersion: string;
  readonly rewardVault: Address;
  readonly distributionVault: Address;
}

export interface PositionCreatedEvent extends EventBase {
  readonly type: "PositionCreated";
  readonly account: Address;
}

export interface FaucetGrantEvent extends EventBase {
  readonly type: "FaucetGrant";
  readonly account: Address;
  readonly asset: "tRFL" | "tUSD";
  readonly amount: bigint;
}

/** Historical router evidence. Native hook endpoints take precedence if both exist. */
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

export type ProtocolEvent =
  | ProtocolInitializedEvent
  | PositionCreatedEvent
  | FaucetGrantEvent
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
  | LpRewardQuarantinedEvent;

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
  readonly rewardVaultCredits: bigint;
  readonly rewardVaultPayouts: bigint;
  readonly lifetimeSwapFees: bigint;
  readonly lifetimeMaterialized: bigint;
  readonly lifetimeCustodyRouted: bigint;
  readonly packageVersion: string;
  readonly swapsPaused: boolean;
  readonly claimsPaused: boolean;
  readonly operationalAdmins: {
    readonly reflectionCore: Address | null;
    readonly testAssets: Address | null;
    readonly testAmm: Address | null;
  };
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
  readonly lifetimeReceived: bigint;
  readonly lifetimeClaimed: bigint;
  readonly quarantined: boolean;
  readonly indexedLiability: bigint;
  readonly positions: readonly ObservedLpPosition[];
}

/** Values fetched from on-chain views at one finalized ledger version. */
export interface ObservedAccountingSnapshot {
  readonly ledgerVersion: bigint;
  readonly automaticMaterialization: boolean;
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
  readonly custodyReserveBalance: bigint;
  readonly custodyShares: bigint;
  readonly custodyCorrection: bigint;
  readonly custodyClaimed: bigint;
  readonly custodyPendingRewards: bigint;
  readonly custodyActiveRouteEpoch: bigint;
  readonly custodyActiveLpRewardVault: Address;
  readonly trflReserve: bigint;
  readonly tusdReserve: bigint;
  readonly maximumRflContribution: bigint;
  readonly maximumTusdContribution: bigint;
  readonly maximumNonFinalWithdrawalShareBps: bigint;
  readonly activeLpEpoch: bigint | null;
  readonly lpEpochs: readonly ObservedLpEpoch[];
  readonly positions: readonly ObservedPosition[];
  readonly packageVersion: string;
  readonly swapsPaused: boolean;
  readonly claimsPaused: boolean;
  readonly poolPaused: boolean;
  readonly liquidityPaused: boolean;
  readonly lpClaimsPaused: boolean;
  readonly shutdownMode: boolean;
  readonly poolSeeded: boolean;
  readonly coreOperationalAdmin: Address;
  readonly faucetOperationalAdmin: Address;
  readonly ammOperationalAdmin: Address;
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
    | "RESERVE_CUSTODY"
    | "CUSTODY_ACCOUNTING"
    | "ROUTE_PAIR"
    | "OLD_EPOCH_ROUTE"
    | "LP_ACCOUNTING"
    | "LP_VAULT_BACKING"
    | "VAULT_BINDING"
    | "POSITION_ACCOUNTING"
    | "PACKAGE_VERSION"
    | "PAUSE_STATE"
    | "OPERATIONAL_ADMIN";
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
  /** Sources must not split one ledger-version transaction across pages. */
  readonly events: readonly ProtocolEvent[];
  readonly nextCursor: EventCursor | null;
}

export interface ProtocolEventSource {
  listEvents(after: EventCursor | null, limit: number): Promise<EventPage>;
  getAccountingSnapshot(): Promise<ObservedAccountingSnapshot>;
}

export interface IndexerStore {
  loadLatestSnapshot(): Promise<IndexerSnapshot | null>;
  saveSnapshot(snapshot: IndexerSnapshot): Promise<void>;
  appendAlerts(alerts: readonly CriticalAlert[]): Promise<void>;
  listAlerts(): Promise<readonly CriticalAlert[]>;
}
