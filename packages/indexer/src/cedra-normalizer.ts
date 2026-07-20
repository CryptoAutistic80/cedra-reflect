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
  readonly packageAddresses: {
    readonly reflectionCore: Address;
    readonly testAssets: Address;
    readonly testAmm: Address;
  };
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
  try {
    return canonicalAddress(requiredString(data, key));
  } catch {
    throw new TypeError(`Cedra event field ${key} must be a hexadecimal address`);
  }
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

function canonicalAddress(address: string): Address {
  if (!/^0x[0-9a-f]+$/i.test(address)) {
    throw new TypeError(`Invalid Cedra package address: ${address}`);
  }
  const digits = address.slice(2).replace(/^0+/, "").toLowerCase() || "0";
  return `0x${digits}` as Address;
}

function isType(typeTag: string, packageAddress: Address, moduleName: string, eventName: string): boolean {
  const parts = typeTag.split("::");
  return parts.length === 3
    && canonicalAddress(parts[0]!) === packageAddress
    && parts[1] === moduleName
    && parts[2] === eventName;
}

/** Strict conversion from concrete Move events to the SDK-neutral witness schema. */
export class CedraEventNormalizer {
  private readonly packageAddresses: CedraEventNormalizerOptions["packageAddresses"];

  public constructor(options: CedraEventNormalizerOptions) {
    this.packageAddresses = {
      reflectionCore: canonicalAddress(options.packageAddresses.reflectionCore),
      testAssets: canonicalAddress(options.packageAddresses.testAssets),
      testAmm: canonicalAddress(options.packageAddresses.testAmm),
    };
  }

  public normalize(envelope: CedraChainEventEnvelope): ProtocolEvent | null {
    const data = asRecord(envelope.data);
    const eventBase = base(envelope);
    const type = envelope.typeTag;
    const coreType = (moduleName: string, eventName: string): boolean => isType(
      type, this.packageAddresses.reflectionCore, moduleName, eventName,
    );
    const assetsType = (moduleName: string, eventName: string): boolean => isType(
      type, this.packageAddresses.testAssets, moduleName, eventName,
    );
    const ammType = (moduleName: string, eventName: string): boolean => isType(
      type, this.packageAddresses.testAmm, moduleName, eventName,
    );

    if (coreType("reflection_events", "ProtocolInitialized")) {
      const schemaVersion = requiredBigint(data, "version");
      if (schemaVersion !== 1n) {
        throw new TypeError(`Unsupported reflection event schema version: ${schemaVersion.toString()}`);
      }
      const releaseMajor = requiredBigint(data, "release_major");
      const releaseMinor = requiredBigint(data, "release_minor");
      const releasePatch = requiredBigint(data, "release_patch");
      return {
        ...eventBase,
        type: "ProtocolInitialized",
        automaticMaterialization: requiredBoolean(data, "automatic_materialization"),
        feeBps: requiredBigint(data, "initial_fee_bps"),
        initialIndex: 0n,
        packageVersion: `testnet-v${releaseMajor.toString()}.${releaseMinor.toString()}.${releasePatch.toString()}`,
        rewardVault: requiredAddress(data, "reward_vault"),
        distributionVault: requiredAddress(data, "distribution_vault"),
      };
    }
    if (coreType("reflection_events", "PositionCreated")) {
      return { ...eventBase, type: "PositionCreated", account: requiredAddress(data, "account") };
    }
    if (coreType("reflection_events", "FaucetGrant")) {
      return { ...eventBase, type: "FaucetGrant", account: requiredAddress(data, "recipient"), asset: "tRFL", amount: requiredBigint(data, "amount") };
    }
    if (assetsType("mock_usd", "MockUsdMinted")) {
      return { ...eventBase, type: "FaucetGrant", account: requiredAddress(data, "recipient"), asset: "tUSD", amount: requiredBigint(data, "amount") };
    }
    if (assetsType("test_faucet", "FaucetConfigured")) {
      return {
        ...eventBase,
        type: "FaucetConfigured",
        trflGrant: requiredBigint(data, "trfl_grant"),
        tusdGrant: requiredBigint(data, "tusd_grant"),
        cooldownSeconds: requiredBigint(data, "cooldown_seconds"),
      };
    }
    if (coreType("reflection_events", "WalletTransfer")) {
      return { ...eventBase, type: "WalletTransfer", from: requiredAddress(data, "from"), to: requiredAddress(data, "to"), asset: "tRFL", amount: requiredBigint(data, "amount") };
    }
    if (coreType("reflection_events", "EligibleBalanceDebited")) {
      return { ...eventBase, type: "EligibleBalanceDebited", account: requiredAddress(data, "account"), amount: requiredBigint(data, "amount") };
    }
    if (coreType("reflection_events", "EligibleBalanceCredited")) {
      return { ...eventBase, type: "EligibleBalanceCredited", account: requiredAddress(data, "account"), amount: requiredBigint(data, "amount") };
    }
    if (coreType("reflection_events", "ReflectionFeeCollected")) {
      return {
        ...eventBase,
        type: "ReflectionFeeCollected",
        swapTxHash: envelope.txHash,
        grossAmount: requiredBigint(data, "gross_amount"),
        feeAmount: requiredBigint(data, "fee_amount"),
        feeBps: requiredBigint(data, "fee_bps"),
      };
    }
    if (coreType("reflection_events", "ReflectionIndexAdvanced")) {
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
    if (coreType("reflection_events", "RewardsMaterialized")) {
      return { ...eventBase, type: "RewardsMaterialized", account: requiredAddress(data, "account"), amount: requiredBigint(data, "amount"), totalClaimed: requiredBigint(data, "total_claimed") };
    }
    if (coreType("reflection_events", "RewardsClaimed")) {
      return { ...eventBase, type: "RewardsClaimed", account: requiredAddress(data, "account"), amount: requiredBigint(data, "amount"), totalClaimed: requiredBigint(data, "total_claimed") };
    }
    if (coreType("reflection_events", "CustodyAdapterRegistered")) {
      return {
        ...eventBase,
        type: "CustodyAdapterRegistered",
        adapterId: requiredBigint(data, "adapter_id"),
        reserveStore: requiredAddress(data, "reserve_store"),
        firstEpoch: requiredBigint(data, "first_epoch"),
        lpRewardVault: requiredAddress(data, "lp_reward_vault"),
      };
    }
    if (coreType("reflection_events", "CustodyEpochRouteOpened")) {
      return {
        ...eventBase,
        type: "CustodyEpochRouteOpened",
        adapterId: requiredBigint(data, "adapter_id"),
        epoch: requiredBigint(data, "epoch"),
        reserveStore: requiredAddress(data, "reserve_store"),
        lpRewardVault: requiredAddress(data, "lp_reward_vault"),
      };
    }
    if (coreType("reflection_events", "CustodySharesChanged")) {
      return {
        ...eventBase,
        type: "CustodySharesChanged",
        added: requiredBoolean(data, "added"),
        amount: requiredBigint(data, "amount"),
        custodyShares: requiredBigint(data, "custody_shares"),
        globalShares: requiredBigint(data, "global_shares"),
      };
    }
    if (coreType("reflection_events", "CustodyRewardsRouted")) {
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
    if (coreType("reflection_events", "FeeConfigurationChanged")) {
      const newFeeBps = requiredBigint(data, "new_fee_bps");
      return {
        ...eventBase,
        type: "FeeConfigurationChanged",
        oldFeeBps: requiredBigint(data, "old_fee_bps"),
        newFeeBps,
      };
    }
    if (coreType("reflection_events", "PauseStateChanged")) {
      return { ...eventBase, type: "PauseStateChanged", swapsPaused: requiredBoolean(data, "swaps_paused"), claimsPaused: requiredBoolean(data, "claims_paused") };
    }
    if (assetsType("test_faucet", "FaucetPauseChanged")) {
      return { ...eventBase, type: "FaucetPauseChanged", paused: requiredBoolean(data, "paused") };
    }
    if (
      coreType("reflection_events", "OperationalAdminChanged")
      || assetsType("test_faucet", "OperationalAdminChanged")
      || ammType("pool", "OperationalAdminChanged")
    ) {
      const scope = coreType("reflection_events", "OperationalAdminChanged")
        ? "reflection-core"
        : assetsType("test_faucet", "OperationalAdminChanged")
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
    if (ammType("pool", "LiquiditySeeded") || ammType("pool", "LiquidityAdded")) {
      const eventType = ammType("pool", "LiquiditySeeded") ? "LiquiditySeeded" : "LiquidityAdded";
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
    if (ammType("pool", "LiquidityRemoved")) {
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
    if (ammType("pool", "SwapExecuted")) {
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
    if (ammType("pool", "SwapLimitsChanged")) {
      return {
        ...eventBase,
        type: "SwapLimitsChanged",
        ammFeeBps: requiredBigint(data, "amm_fee_bps"),
        maximumReserveBps: requiredBigint(data, "max_reserve_bps"),
        maximumGrossSwap: requiredBigint(data, "max_gross_swap"),
      };
    }
    if (ammType("pool", "LiquidityLimitsChanged")) {
      return {
        ...eventBase,
        type: "LiquidityLimitsChanged",
        maximumRflContribution: requiredBigint(data, "max_rfl_contribution"),
        maximumTusdContribution: requiredBigint(data, "max_usd_contribution"),
        maximumNonFinalWithdrawalShareBps: requiredBigint(data, "max_withdrawal_share_bps"),
      };
    }
    if (ammType("pool", "PoolPauseChanged")) {
      return {
        ...eventBase,
        type: "PoolPauseChanged",
        poolPaused: requiredBoolean(data, "pool_paused"),
        liquidityPaused: requiredBoolean(data, "liquidity_paused"),
        lpClaimsPaused: requiredBoolean(data, "lp_claims_paused"),
        shutdownMode: requiredBoolean(data, "shutdown_mode"),
      };
    }

    if (ammType("lp_rewards", "LpEpochOpened")) {
      return { ...eventBase, type: "LpEpochOpened", epoch: requiredBigint(data, "epoch"), stateId: requiredAddress(data, "state_id"), rewardVault: requiredAddress(data, "reward_vault") };
    }
    if (ammType("lp_rewards", "LpEpochStatusChanged")) {
      return {
        ...eventBase,
        type: "LpEpochStatusChanged",
        epoch: requiredBigint(data, "epoch"),
        oldStatus: lpStatus(requiredBigint(data, "old_status"), "old_status"),
        newStatus: lpStatus(requiredBigint(data, "new_status"), "new_status"),
      };
    }
    if (ammType("lp_rewards", "LpSharesChanged")) {
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
    if (ammType("lp_rewards", "LpSharesTransferred")) {
      return {
        ...eventBase,
        type: "LpSharesTransferred",
        epoch: requiredBigint(data, "epoch"),
        sender: requiredAddress(data, "sender"),
        recipient: requiredAddress(data, "recipient"),
        amount: requiredBigint(data, "amount"),
      };
    }
    if (ammType("lp_rewards", "LpRewardIndexAdvanced")) {
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
    if (ammType("lp_rewards", "LpRewardsClaimed")) {
      return {
        ...eventBase,
        type: "LpRewardsClaimed",
        epoch: requiredBigint(data, "epoch"),
        owner: requiredAddress(data, "owner"),
        amount: requiredBigint(data, "amount"),
        totalClaimed: requiredBigint(data, "total_claimed"),
      };
    }
    if (ammType("lp_rewards", "LpRewardQuarantined")) {
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
