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
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const MAX_IDENTITY_BYTES = 512;

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
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,77})$/.test(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`Cedra event field ${key} must be a non-negative integer`);
  }
  if (parsed < 0n || parsed > U256_MAX) {
    throw new TypeError(`Cedra event field ${key} exceeds the Move u256 domain`);
  }
  return parsed;
}

function requiredUnsigned(data: DataRecord, key: string, bits: 8 | 64 | 128 | 256): bigint {
  const parsed = requiredBigint(data, key);
  const maximum = bits === 8 ? 255n : bits === 64 ? U64_MAX : bits === 128 ? U128_MAX : U256_MAX;
  if (parsed > maximum) {
    throw new TypeError(`Cedra event field ${key} exceeds the Move u${bits} domain`);
  }
  return parsed;
}

function requiredBoolean(data: DataRecord, key: string): boolean {
  const value = data[key];
  if (typeof value !== "boolean") throw new TypeError(`Cedra event field ${key} must be a boolean`);
  return value;
}

function requiredUtf8Vector(data: DataRecord, key: string): string {
  const value = data[key];
  let bytes: readonly number[];
  if (typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value)) {
    const digits = value.slice(2);
    bytes = Array.from({ length: digits.length / 2 }, (_unused, index) => (
      Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16)
    ));
  } else if (
    Array.isArray(value)
    && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
  ) {
    bytes = value as number[];
  } else {
    throw new TypeError(`Cedra event field ${key} must be a hexadecimal byte vector`);
  }
  if (bytes.length === 0 || bytes.length > MAX_IDENTITY_BYTES) {
    throw new TypeError(`Cedra event field ${key} must contain 1 to ${MAX_IDENTITY_BYTES.toString()} bytes`);
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    if (decoded.length === 0) throw new TypeError("empty byte vector");
    return decoded;
  } catch {
    throw new TypeError(`Cedra event field ${key} must contain valid non-empty UTF-8`);
  }
}

function lpStatus(value: bigint, key: string): LpEpochStatus {
  if (value === 1n) return "active";
  if (value === 2n) return "claim-only";
  throw new TypeError(`Cedra event field ${key} must be LP status 1 or 2`);
}

function base(envelope: CedraChainEventEnvelope): EventBase {
  if (
    typeof envelope.txHash !== "string"
    || envelope.txHash.length === 0
    || envelope.txHash.length > 512
    || typeof envelope.ledgerVersion !== "bigint"
    || envelope.ledgerVersion < 0n
    || envelope.ledgerVersion > U64_MAX
    || !Number.isSafeInteger(envelope.eventIndex)
    || envelope.eventIndex < 0
    || typeof envelope.timestampUnixMilliseconds !== "bigint"
    || envelope.timestampUnixMilliseconds < 0n
    || envelope.timestampUnixMilliseconds > U64_MAX
  ) {
    throw new TypeError("Cedra event envelope has an invalid transaction identity, cursor, or timestamp");
  }
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
  if (!/^0x[0-9a-f]{1,64}$/i.test(address)) {
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
    const packageAddresses = {
      reflectionCore: canonicalAddress(options.packageAddresses.reflectionCore),
      testAssets: canonicalAddress(options.packageAddresses.testAssets),
      testAmm: canonicalAddress(options.packageAddresses.testAmm),
    };
    const addresses = [
      packageAddresses.reflectionCore,
      packageAddresses.testAssets,
      packageAddresses.testAmm,
    ];
    if (addresses.includes("0x0")) {
      throw new TypeError("Cedra event package addresses must be non-zero");
    }
    if (new Set(addresses).size !== addresses.length) {
      throw new TypeError("Cedra event package addresses must be canonically distinct");
    }
    this.packageAddresses = packageAddresses;
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
      const schemaVersion = requiredUnsigned(data, "version", 64);
      if (schemaVersion !== 1n) {
        throw new TypeError(`Unsupported reflection event schema version: ${schemaVersion.toString()}`);
      }
      const releaseMajor = requiredUnsigned(data, "release_major", 64);
      const releaseMinor = requiredUnsigned(data, "release_minor", 64);
      const releasePatch = requiredUnsigned(data, "release_patch", 64);
      return {
        ...eventBase,
        type: "ProtocolInitialized",
        deploymentId: requiredUtf8Vector(data, "deployment_id"),
        networkLabel: requiredUtf8Vector(data, "network_label"),
        tokenMetadata: requiredAddress(data, "metadata"),
        automaticMaterialization: requiredBoolean(data, "automatic_materialization"),
        feeBps: requiredUnsigned(data, "initial_fee_bps", 64),
        initialIndex: 0n,
        packageVersion: `testnet-v${releaseMajor.toString()}.${releaseMinor.toString()}.${releasePatch.toString()}`,
        rewardVault: requiredAddress(data, "reward_vault"),
        distributionVault: requiredAddress(data, "distribution_vault"),
        protocolExclusionSlots: requiredUnsigned(data, "protocol_exclusion_slots", 64),
      };
    }
    if (coreType("reflection_events", "ProtocolPrimaryStoreExcluded")) {
      return {
        ...eventBase,
        type: "ProtocolPrimaryStoreExcluded",
        account: requiredAddress(data, "account"),
        store: requiredAddress(data, "store"),
        remainingSlots: requiredUnsigned(data, "remaining_slots", 64),
      };
    }
    if (coreType("reflection_events", "OperationalPrimaryStoreExcluded")) {
      return {
        ...eventBase,
        type: "OperationalPrimaryStoreExcluded",
        account: requiredAddress(data, "account"),
        store: requiredAddress(data, "store"),
      };
    }
    if (coreType("reflection_events", "PositionCreated")) {
      return { ...eventBase, type: "PositionCreated", account: requiredAddress(data, "account") };
    }
    if (coreType("reflection_events", "WalletRegistered")) {
      return {
        ...eventBase,
        type: "WalletRegistered",
        account: requiredAddress(data, "account"),
        primaryStore: requiredAddress(data, "primary_store"),
        registeredWalletCount: requiredUnsigned(data, "registered_wallet_count", 64),
      };
    }
    if (coreType("reflection_events", "FaucetGrant")) {
      return { ...eventBase, type: "FaucetGrant", account: requiredAddress(data, "recipient"), asset: "tRFL", amount: requiredUnsigned(data, "amount", 64) };
    }
    if (assetsType("mock_usd", "MockUsdMinted")) {
      return { ...eventBase, type: "FaucetGrant", account: requiredAddress(data, "recipient"), asset: "tUSD", amount: requiredUnsigned(data, "amount", 64) };
    }
    if (assetsType("test_faucet", "FaucetConfigured")) {
      return {
        ...eventBase,
        type: "FaucetConfigured",
        trflGrant: requiredUnsigned(data, "trfl_grant", 64),
        tusdGrant: requiredUnsigned(data, "tusd_grant", 64),
        cooldownSeconds: requiredUnsigned(data, "cooldown_seconds", 64),
      };
    }
    if (assetsType("mock_usd", "PoolReserveBound")) {
      return {
        ...eventBase,
        type: "PoolReserveBound",
        reserveStore: requiredAddress(data, "reserve_store"),
        custodian: requiredAddress(data, "custodian"),
      };
    }
    if (coreType("reflection_events", "WalletTransfer")) {
      return { ...eventBase, type: "WalletTransfer", from: requiredAddress(data, "from"), to: requiredAddress(data, "to"), asset: "tRFL", amount: requiredUnsigned(data, "amount", 64) };
    }
    if (coreType("reflection_events", "EligibleBalanceDebited")) {
      return { ...eventBase, type: "EligibleBalanceDebited", account: requiredAddress(data, "account"), amount: requiredUnsigned(data, "amount", 64) };
    }
    if (coreType("reflection_events", "EligibleBalanceCredited")) {
      return { ...eventBase, type: "EligibleBalanceCredited", account: requiredAddress(data, "account"), amount: requiredUnsigned(data, "amount", 64) };
    }
    if (coreType("reflection_events", "ReflectionFeeCollected")) {
      return {
        ...eventBase,
        type: "ReflectionFeeCollected",
        swapTxHash: envelope.txHash,
        grossAmount: requiredUnsigned(data, "gross_amount", 64),
        feeAmount: requiredUnsigned(data, "fee_amount", 64),
        feeBps: requiredUnsigned(data, "fee_bps", 64),
      };
    }
    if (coreType("reflection_events", "ReflectionIndexAdvanced")) {
      return {
        ...eventBase,
        type: "ReflectionIndexAdvanced",
        previousIndex: requiredUnsigned(data, "old_index", 256),
        newIndex: requiredUnsigned(data, "new_index", 256),
        indexRemainder: requiredUnsigned(data, "remainder", 256),
        feeAmount: requiredUnsigned(data, "fee_amount", 64),
        eligibleSupply: requiredUnsigned(data, "eligible_supply", 128),
      };
    }
    if (coreType("reflection_events", "RewardsMaterialized")) {
      return { ...eventBase, type: "RewardsMaterialized", account: requiredAddress(data, "account"), amount: requiredUnsigned(data, "amount", 64), totalClaimed: requiredUnsigned(data, "total_claimed", 256) };
    }
    if (coreType("reflection_events", "RewardsClaimed")) {
      return { ...eventBase, type: "RewardsClaimed", account: requiredAddress(data, "account"), amount: requiredUnsigned(data, "amount", 64), totalClaimed: requiredUnsigned(data, "total_claimed", 256) };
    }
    if (coreType("reflection_events", "CustodyAdapterRegistered")) {
      return {
        ...eventBase,
        type: "CustodyAdapterRegistered",
        adapterId: requiredUnsigned(data, "adapter_id", 64),
        reserveStore: requiredAddress(data, "reserve_store"),
        firstEpoch: requiredUnsigned(data, "first_epoch", 64),
        lpRewardVault: requiredAddress(data, "lp_reward_vault"),
      };
    }
    if (coreType("reflection_events", "CustodyEpochRouteOpened")) {
      return {
        ...eventBase,
        type: "CustodyEpochRouteOpened",
        adapterId: requiredUnsigned(data, "adapter_id", 64),
        epoch: requiredUnsigned(data, "epoch", 64),
        reserveStore: requiredAddress(data, "reserve_store"),
        lpRewardVault: requiredAddress(data, "lp_reward_vault"),
        retiredResidueMagnified: requiredUnsigned(data, "retired_residue_magnified", 256),
      };
    }
    if (coreType("reflection_events", "CustodySharesChanged")) {
      return {
        ...eventBase,
        type: "CustodySharesChanged",
        added: requiredBoolean(data, "added"),
        amount: requiredUnsigned(data, "amount", 64),
        custodyShares: requiredUnsigned(data, "custody_shares", 128),
        globalShares: requiredUnsigned(data, "global_shares", 128),
      };
    }
    if (coreType("reflection_events", "CustodyRewardsRouted")) {
      return {
        ...eventBase,
        type: "CustodyRewardsRouted",
        reserveStore: requiredAddress(data, "reserve_store"),
        lpRewardVault: requiredAddress(data, "lp_reward_vault"),
        epoch: requiredUnsigned(data, "epoch", 64),
        amount: requiredUnsigned(data, "amount", 64),
        totalRouted: requiredUnsigned(data, "total_routed", 256),
      };
    }
    if (coreType("reflection_events", "FeeConfigurationChanged")) {
      const newFeeBps = requiredUnsigned(data, "new_fee_bps", 64);
      return {
        ...eventBase,
        type: "FeeConfigurationChanged",
        oldFeeBps: requiredUnsigned(data, "old_fee_bps", 64),
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
        epoch: requiredUnsigned(data, "epoch", 64),
        provider: requiredAddress(data, "provider"),
        trflAmount: requiredUnsigned(data, "rfl_amount", 64),
        tusdAmount: requiredUnsigned(data, "usd_amount", 64),
        lpShares: requiredUnsigned(data, "lp_shares", 128),
        trflReserveAfter: requiredUnsigned(data, "reserve_rfl", 64),
        tusdReserveAfter: requiredUnsigned(data, "reserve_usd", 64),
      };
    }
    if (ammType("pool", "LiquidityRemoved")) {
      return {
        ...eventBase,
        type: "LiquidityRemoved",
        epoch: requiredUnsigned(data, "epoch", 64),
        provider: requiredAddress(data, "provider"),
        trflAmount: requiredUnsigned(data, "rfl_amount", 64),
        tusdAmount: requiredUnsigned(data, "usd_amount", 64),
        lpShares: requiredUnsigned(data, "lp_shares", 128),
        finalExit: requiredBoolean(data, "final_exit"),
        trflReserveAfter: requiredUnsigned(data, "reserve_rfl", 64),
        tusdReserveAfter: requiredUnsigned(data, "reserve_usd", 64),
      };
    }
    if (ammType("pool", "SwapExecuted")) {
      const grossAmount = requiredUnsigned(data, "gross_input", 64);
      const reflectionFee = requiredUnsigned(data, "reflection_fee", 64);
      const direction = requiredBoolean(data, "is_sell") ? "sell" : "buy";
      const grossPoolOutput = requiredUnsigned(data, "gross_output", 64);
      return {
        ...eventBase,
        type: "SwapExecuted",
        account: requiredAddress(data, "trader"),
        direction,
        grossAmount,
        reflectionFee,
        ammFee: requiredUnsigned(data, "amm_fee", 64),
        netReserveInput: direction === "sell" ? grossAmount - reflectionFee : grossAmount,
        grossPoolOutput,
        netUserReceipt: requiredUnsigned(data, "net_output", 64),
        trflReserveAfter: requiredUnsigned(data, "reserve_rfl", 64),
        tusdReserveAfter: requiredUnsigned(data, "reserve_usd", 64),
      };
    }
    if (ammType("pool", "SwapLimitsChanged")) {
      return {
        ...eventBase,
        type: "SwapLimitsChanged",
        ammFeeBps: requiredUnsigned(data, "amm_fee_bps", 64),
        maximumReserveBps: requiredUnsigned(data, "max_reserve_bps", 64),
        maximumGrossSwap: requiredUnsigned(data, "max_gross_swap", 64),
      };
    }
    if (ammType("pool", "LiquidityLimitsChanged")) {
      return {
        ...eventBase,
        type: "LiquidityLimitsChanged",
        maximumRflContribution: requiredUnsigned(data, "max_rfl_contribution", 64),
        maximumTusdContribution: requiredUnsigned(data, "max_usd_contribution", 64),
        maximumNonFinalWithdrawalShareBps: requiredUnsigned(data, "max_withdrawal_share_bps", 64),
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
      return { ...eventBase, type: "LpEpochOpened", epoch: requiredUnsigned(data, "epoch", 64), stateId: requiredAddress(data, "state_id"), rewardVault: requiredAddress(data, "reward_vault") };
    }
    if (ammType("lp_rewards", "LpEpochStatusChanged")) {
      return {
        ...eventBase,
        type: "LpEpochStatusChanged",
        epoch: requiredUnsigned(data, "epoch", 64),
        oldStatus: lpStatus(requiredUnsigned(data, "old_status", 8), "old_status"),
        newStatus: lpStatus(requiredUnsigned(data, "new_status", 8), "new_status"),
      };
    }
    if (ammType("lp_rewards", "LpSharesChanged")) {
      return {
        ...eventBase,
        type: "LpSharesChanged",
        epoch: requiredUnsigned(data, "epoch", 64),
        owner: requiredAddress(data, "owner"),
        added: requiredBoolean(data, "added"),
        amount: requiredUnsigned(data, "amount", 128),
        ownerShares: requiredUnsigned(data, "owner_shares", 128),
        totalShares: requiredUnsigned(data, "total_shares", 128),
      };
    }
    if (ammType("lp_rewards", "LpSharesTransferred")) {
      return {
        ...eventBase,
        type: "LpSharesTransferred",
        epoch: requiredUnsigned(data, "epoch", 64),
        sender: requiredAddress(data, "sender"),
        recipient: requiredAddress(data, "recipient"),
        amount: requiredUnsigned(data, "amount", 128),
      };
    }
    if (ammType("lp_rewards", "LpRewardIndexAdvanced")) {
      return {
        ...eventBase,
        type: "LpRewardIndexAdvanced",
        epoch: requiredUnsigned(data, "epoch", 64),
        previousIndex: requiredUnsigned(data, "old_index", 256),
        newIndex: requiredUnsigned(data, "new_index", 256),
        indexRemainder: requiredUnsigned(data, "remainder", 256),
        received: requiredUnsigned(data, "received", 64),
        totalShares: requiredUnsigned(data, "total_shares", 128),
        roundingReserve: requiredUnsigned(data, "rounding_reserve", 128),
      };
    }
    if (ammType("lp_rewards", "LpRewardsClaimed")) {
      return {
        ...eventBase,
        type: "LpRewardsClaimed",
        epoch: requiredUnsigned(data, "epoch", 64),
        owner: requiredAddress(data, "owner"),
        amount: requiredUnsigned(data, "amount", 64),
        totalClaimed: requiredUnsigned(data, "total_claimed", 256),
      };
    }
    if (ammType("lp_rewards", "LpRewardQuarantined")) {
      return {
        ...eventBase,
        type: "LpRewardQuarantined",
        epoch: requiredUnsigned(data, "epoch", 64),
        amount: requiredUnsigned(data, "amount", 64),
        unallocatedRewards: requiredUnsigned(data, "unallocated_rewards", 128),
        rewardVault: requiredAddress(data, "reward_vault"),
      };
    }
    if (ammType("lp_rewards", "LpFractionalResidueRetired")) {
      return {
        ...eventBase,
        type: "LpFractionalResidueRetired",
        epoch: requiredUnsigned(data, "epoch", 64),
        owner: requiredAddress(data, "owner"),
        residueMagnified: requiredUnsigned(data, "residue_magnified", 256),
        cumulativeRetiredResidueMagnified: requiredUnsigned(
          data,
          "cumulative_retired_residue_magnified",
          256,
        ),
        roundingReserveBaseUnits: requiredUnsigned(data, "rounding_reserve_base_units", 128),
      };
    }
    if (ammType("lp_rewards", "LpEpochTerminalDustClassified")) {
      return {
        ...eventBase,
        type: "LpEpochTerminalDustClassified",
        epoch: requiredUnsigned(data, "epoch", 64),
        rewardVault: requiredAddress(data, "reward_vault"),
        terminalRoundingBaseUnits: requiredUnsigned(data, "terminal_rounding_base_units", 128),
        retiredResidueMagnified: requiredUnsigned(data, "retired_residue_magnified", 256),
        lifetimeReceivedBaseUnits: requiredUnsigned(data, "lifetime_received_base_units", 256),
        lifetimeClaimedBaseUnits: requiredUnsigned(data, "lifetime_claimed_base_units", 256),
      };
    }

    return null;
  }
}
