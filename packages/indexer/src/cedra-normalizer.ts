import type { Address } from "../../protocol-sdk/src/types.js";
import type {
  EventBase,
  LpEpochStatus,
  ProtocolEvent,
} from "./types.js";

export interface CedraChainEventEnvelope {
  readonly typeTag: string;
  readonly data: unknown;
  readonly txHash: string;
  readonly ledgerVersion: bigint;
  readonly eventIndex: number;
  readonly timestampUnixMilliseconds: bigint;
}

export interface CedraEventNormalizerOptions {
  readonly initialFeeBps?: bigint;
}

type DataRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Cedra event data must be an object");
  }
  return value as DataRecord;
}

function requiredString(data: DataRecord, key: string): string {
  const value = data[key];
  if (typeof value !== "string") throw new TypeError(`Cedra event field ${key} must be a string`);
  return value;
}

function requiredAddress(data: DataRecord, key: string): Address {
  const value = requiredString(data, key);
  if (!value.startsWith("0x")) throw new TypeError(`Cedra event field ${key} must be an address`);
  return value as Address;
}

function requiredBigint(data: DataRecord, key: string): bigint {
  const value = data[key];
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError(`Cedra event field ${key} must be a non-negative integer`);
}

function requiredBoolean(data: DataRecord, key: string): boolean {
  const value = data[key];
  if (typeof value !== "boolean") throw new TypeError(`Cedra event field ${key} must be a boolean`);
  return value;
}

function lpStatus(value: bigint, key: string): LpEpochStatus {
  if (value === 1n) return "active";
  if (value === 2n) return "claim-only";
  throw new TypeError(`Cedra event field ${key} must be LP status 1 or 2`);
}

function base(envelope: CedraChainEventEnvelope): EventBase {
  return {
    id: `${envelope.txHash}:${envelope.eventIndex}`,
    txHash: envelope.txHash,
    ledgerVersion: envelope.ledgerVersion,
    eventIndex: envelope.eventIndex,
    timestampUnixMilliseconds: envelope.timestampUnixMilliseconds,
    source: "chain",
  };
}

function isType(typeTag: string, moduleName: string, eventName: string): boolean {
  return typeTag.endsWith(`::${moduleName}::${eventName}`);
}

/** Strict conversion from concrete Move events to the SDK-neutral witness schema. */
export class CedraEventNormalizer {
  private currentFeeBps: bigint;

  public constructor(options: CedraEventNormalizerOptions = {}) {
    this.currentFeeBps = options.initialFeeBps ?? 100n;
  }

  public normalize(envelope: CedraChainEventEnvelope): ProtocolEvent | null {
    const data = asRecord(envelope.data);
    const eventBase = base(envelope);
    const type = envelope.typeTag;

    if (isType(type, "reflection_events", "ProtocolInitialized")) {
      const version = requiredBigint(data, "version");
      return {
        ...eventBase,
        type: "ProtocolInitialized",
        feeBps: this.currentFeeBps,
        initialIndex: 0n,
        packageVersion: `testnet-v${version.toString()}`,
        rewardVault: requiredAddress(data, "reward_vault"),
        distributionVault: requiredAddress(data, "distribution_vault"),
      };
    }
    if (isType(type, "reflection_events", "PositionCreated")) {
      return { ...eventBase, type: "PositionCreated", account: requiredAddress(data, "account") };
    }
    if (isType(type, "reflection_events", "FaucetGrant")) {
      return { ...eventBase, type: "FaucetGrant", account: requiredAddress(data, "recipient"), asset: "tRFL", amount: requiredBigint(data, "amount") };
    }
    if (isType(type, "mock_usd", "MockUsdMinted")) {
      return { ...eventBase, type: "FaucetGrant", account: requiredAddress(data, "recipient"), asset: "tUSD", amount: requiredBigint(data, "amount") };
    }
    if (isType(type, "reflection_events", "WalletTransfer")) {
      return { ...eventBase, type: "WalletTransfer", from: requiredAddress(data, "from"), to: requiredAddress(data, "to"), asset: "tRFL", amount: requiredBigint(data, "amount") };
    }
    if (isType(type, "reflection_events", "EligibleBalanceDebited")) {
      return { ...eventBase, type: "EligibleBalanceDebited", account: requiredAddress(data, "account"), amount: requiredBigint(data, "amount") };
    }
    if (isType(type, "reflection_events", "EligibleBalanceCredited")) {
      return { ...eventBase, type: "EligibleBalanceCredited", account: requiredAddress(data, "account"), amount: requiredBigint(data, "amount") };
    }
    if (isType(type, "reflection_events", "ReflectionFeeCollected")) {
      return {
        ...eventBase,
        type: "ReflectionFeeCollected",
        swapTxHash: envelope.txHash,
        grossAmount: requiredBigint(data, "gross_amount"),
        feeAmount: requiredBigint(data, "fee_amount"),
        feeBps: this.currentFeeBps,
      };
    }
    if (isType(type, "reflection_events", "ReflectionIndexAdvanced")) {
      return {
        ...eventBase,
        type: "ReflectionIndexAdvanced",
        previousIndex: requiredBigint(data, "old_index"),
        newIndex: requiredBigint(data, "new_index"),
        indexRemainder: requiredBigint(data, "remainder"),
        feeAmount: requiredBigint(data, "fee_amount"),
        eligibleSupply: requiredBigint(data, "eligible_supply"),
      };
    }
    if (isType(type, "reflection_events", "RewardsMaterialized")) {
      return { ...eventBase, type: "RewardsMaterialized", account: requiredAddress(data, "account"), amount: requiredBigint(data, "amount"), totalClaimed: requiredBigint(data, "total_claimed") };
    }
    if (isType(type, "reflection_events", "RewardsClaimed")) {
      return { ...eventBase, type: "RewardsClaimed", account: requiredAddress(data, "account"), amount: requiredBigint(data, "amount"), totalClaimed: requiredBigint(data, "total_claimed") };
    }
    if (isType(type, "reflection_events", "CustodyAdapterRegistered")) {
      return {
        ...eventBase,
        type: "CustodyAdapterRegistered",
        adapterId: requiredBigint(data, "adapter_id"),
        reserveStore: requiredAddress(data, "reserve_store"),
        firstEpoch: requiredBigint(data, "first_epoch"),
        lpRewardVault: requiredAddress(data, "lp_reward_vault"),
      };
    }
    if (isType(type, "reflection_events", "CustodyEpochRouteOpened")) {
      return {
        ...eventBase,
        type: "CustodyEpochRouteOpened",
        adapterId: requiredBigint(data, "adapter_id"),
        epoch: requiredBigint(data, "epoch"),
        reserveStore: requiredAddress(data, "reserve_store"),
        lpRewardVault: requiredAddress(data, "lp_reward_vault"),
      };
    }
    if (isType(type, "reflection_events", "CustodySharesChanged")) {
      return {
        ...eventBase,
        type: "CustodySharesChanged",
        added: requiredBoolean(data, "added"),
        amount: requiredBigint(data, "amount"),
        custodyShares: requiredBigint(data, "custody_shares"),
        globalShares: requiredBigint(data, "global_shares"),
      };
    }
    if (isType(type, "reflection_events", "CustodyRewardsRouted")) {
      return {
        ...eventBase,
        type: "CustodyRewardsRouted",
        reserveStore: requiredAddress(data, "reserve_store"),
        lpRewardVault: requiredAddress(data, "lp_reward_vault"),
        epoch: requiredBigint(data, "epoch"),
        amount: requiredBigint(data, "amount"),
        totalRouted: requiredBigint(data, "total_routed"),
      };
    }
    if (isType(type, "reflection_events", "FeeConfigurationChanged")) {
      const newFeeBps = requiredBigint(data, "new_fee_bps");
      const normalized: ProtocolEvent = {
        ...eventBase,
        type: "FeeConfigurationChanged",
        oldFeeBps: requiredBigint(data, "old_fee_bps"),
        newFeeBps,
      };
      this.currentFeeBps = newFeeBps;
      return normalized;
    }
    if (isType(type, "reflection_events", "PauseStateChanged")) {
      return { ...eventBase, type: "PauseStateChanged", swapsPaused: requiredBoolean(data, "swaps_paused"), claimsPaused: requiredBoolean(data, "claims_paused") };
    }
    if (
      isType(type, "reflection_events", "OperationalAdminChanged")
      || isType(type, "test_faucet", "OperationalAdminChanged")
      || isType(type, "pool", "OperationalAdminChanged")
    ) {
      const scope = isType(type, "reflection_events", "OperationalAdminChanged")
        ? "reflection-core"
        : isType(type, "test_faucet", "OperationalAdminChanged")
          ? "test-assets"
          : "test-amm";
      return {
        ...eventBase,
        type: "OperationalAdminChanged",
        scope,
        oldOperationalAdmin: requiredAddress(data, "old_operational_admin"),
        newOperationalAdmin: requiredAddress(data, "new_operational_admin"),
      };
    }
    if (isType(type, "pool", "LiquiditySeeded") || isType(type, "pool", "LiquidityAdded")) {
      const eventType = isType(type, "pool", "LiquiditySeeded") ? "LiquiditySeeded" : "LiquidityAdded";
      return {
        ...eventBase,
        type: eventType,
        epoch: requiredBigint(data, "epoch"),
        provider: requiredAddress(data, "provider"),
        trflAmount: requiredBigint(data, "rfl_amount"),
        tusdAmount: requiredBigint(data, "usd_amount"),
        lpShares: requiredBigint(data, "lp_shares"),
        trflReserveAfter: requiredBigint(data, "reserve_rfl"),
        tusdReserveAfter: requiredBigint(data, "reserve_usd"),
      };
    }
    if (isType(type, "pool", "LiquidityRemoved")) {
      return {
        ...eventBase,
        type: "LiquidityRemoved",
        epoch: requiredBigint(data, "epoch"),
        provider: requiredAddress(data, "provider"),
        trflAmount: requiredBigint(data, "rfl_amount"),
        tusdAmount: requiredBigint(data, "usd_amount"),
        lpShares: requiredBigint(data, "lp_shares"),
        finalExit: requiredBoolean(data, "final_exit"),
        trflReserveAfter: requiredBigint(data, "reserve_rfl"),
        tusdReserveAfter: requiredBigint(data, "reserve_usd"),
      };
    }
    if (isType(type, "pool", "SwapExecuted")) {
      const grossAmount = requiredBigint(data, "gross_input");
      const reflectionFee = requiredBigint(data, "reflection_fee");
      const direction = requiredBoolean(data, "is_sell") ? "sell" : "buy";
      const grossPoolOutput = requiredBigint(data, "gross_output");
      return {
        ...eventBase,
        type: "SwapExecuted",
        account: requiredAddress(data, "trader"),
        direction,
        grossAmount,
        reflectionFee,
        ammFee: requiredBigint(data, "amm_fee"),
        netReserveInput: direction === "sell" ? grossAmount - reflectionFee : grossAmount,
        grossPoolOutput,
        netUserReceipt: requiredBigint(data, "net_output"),
        trflReserveAfter: requiredBigint(data, "reserve_rfl"),
        tusdReserveAfter: requiredBigint(data, "reserve_usd"),
      };
    }
    if (isType(type, "pool", "SwapLimitsChanged")) {
      return {
        ...eventBase,
        type: "SwapLimitsChanged",
        ammFeeBps: requiredBigint(data, "amm_fee_bps"),
        maximumReserveBps: requiredBigint(data, "max_reserve_bps"),
        maximumGrossSwap: requiredBigint(data, "max_gross_swap"),
      };
    }
    if (isType(type, "pool", "LiquidityLimitsChanged")) {
      return {
        ...eventBase,
        type: "LiquidityLimitsChanged",
        maximumRflContribution: requiredBigint(data, "max_rfl_contribution"),
        maximumTusdContribution: requiredBigint(data, "max_usd_contribution"),
        maximumNonFinalWithdrawalShareBps: requiredBigint(data, "max_withdrawal_share_bps"),
      };
    }
    if (isType(type, "pool", "PoolPauseChanged")) {
      return {
        ...eventBase,
        type: "PoolPauseChanged",
        poolPaused: requiredBoolean(data, "pool_paused"),
        liquidityPaused: requiredBoolean(data, "liquidity_paused"),
        lpClaimsPaused: requiredBoolean(data, "lp_claims_paused"),
        shutdownMode: requiredBoolean(data, "shutdown_mode"),
      };
    }

    if (isType(type, "lp_rewards", "LpEpochOpened")) {
      return { ...eventBase, type: "LpEpochOpened", epoch: requiredBigint(data, "epoch"), stateId: requiredAddress(data, "state_id"), rewardVault: requiredAddress(data, "reward_vault") };
    }
    if (isType(type, "lp_rewards", "LpEpochStatusChanged")) {
      return {
        ...eventBase,
        type: "LpEpochStatusChanged",
        epoch: requiredBigint(data, "epoch"),
        oldStatus: lpStatus(requiredBigint(data, "old_status"), "old_status"),
        newStatus: lpStatus(requiredBigint(data, "new_status"), "new_status"),
      };
    }
    if (isType(type, "lp_rewards", "LpSharesChanged")) {
      return {
        ...eventBase,
        type: "LpSharesChanged",
        epoch: requiredBigint(data, "epoch"),
        owner: requiredAddress(data, "owner"),
        added: requiredBoolean(data, "added"),
        amount: requiredBigint(data, "amount"),
        ownerShares: requiredBigint(data, "owner_shares"),
        totalShares: requiredBigint(data, "total_shares"),
      };
    }
    if (isType(type, "lp_rewards", "LpSharesTransferred")) {
      return {
        ...eventBase,
        type: "LpSharesTransferred",
        epoch: requiredBigint(data, "epoch"),
        sender: requiredAddress(data, "sender"),
        recipient: requiredAddress(data, "recipient"),
        amount: requiredBigint(data, "amount"),
      };
    }
    if (isType(type, "lp_rewards", "LpRewardIndexAdvanced")) {
      return {
        ...eventBase,
        type: "LpRewardIndexAdvanced",
        epoch: requiredBigint(data, "epoch"),
        previousIndex: requiredBigint(data, "old_index"),
        newIndex: requiredBigint(data, "new_index"),
        indexRemainder: requiredBigint(data, "remainder"),
        received: requiredBigint(data, "received"),
        totalShares: requiredBigint(data, "total_shares"),
        roundingReserve: requiredBigint(data, "rounding_reserve"),
      };
    }
    if (isType(type, "lp_rewards", "LpRewardsClaimed")) {
      return {
        ...eventBase,
        type: "LpRewardsClaimed",
        epoch: requiredBigint(data, "epoch"),
        owner: requiredAddress(data, "owner"),
        amount: requiredBigint(data, "amount"),
        totalClaimed: requiredBigint(data, "total_claimed"),
      };
    }
    if (isType(type, "lp_rewards", "LpRewardQuarantined")) {
      return {
        ...eventBase,
        type: "LpRewardQuarantined",
        epoch: requiredBigint(data, "epoch"),
        amount: requiredBigint(data, "amount"),
        unallocatedRewards: requiredBigint(data, "unallocated_rewards"),
        rewardVault: requiredAddress(data, "reward_vault"),
      };
    }

    return null;
  }
}
