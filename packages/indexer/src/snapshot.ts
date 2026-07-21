import { createHash } from "node:crypto";

import type { Address } from "../../protocol-sdk/src/types.js";
import { isMoveSignedU256, isMoveUnsigned } from "./move-domains.js";
import { createEmptyProjection } from "./reducer.js";
import type {
  EventId,
  IndexedLpEpoch,
  IndexedLpPosition,
  IndexedPosition,
  IndexerSnapshot,
  ProtocolProjection,
} from "./types.js";

interface SerializableLpEpoch extends Omit<IndexedLpEpoch, "positions"> {
  readonly positions: readonly IndexedLpPosition[];
}

interface SerializableProjection extends Omit<
  ProtocolProjection,
  "positions" | "lpEpochs" | "rewardVaultToEpoch" | "stateIdToEpoch" | "seenEventIds" | "protocolExcludedStores" | "registeredWallets"
> {
  readonly positions: readonly IndexedPosition[];
  readonly lpEpochs: readonly SerializableLpEpoch[];
  readonly rewardVaultToEpoch: readonly (readonly [Address, bigint])[];
  readonly stateIdToEpoch: readonly (readonly [Address, bigint])[];
  readonly seenEventIds: readonly (readonly [EventId, string])[];
  readonly protocolExcludedStores: readonly (readonly [Address, Address])[];
  readonly registeredWallets: readonly (readonly [Address, Address])[];
}

interface SerializableSnapshot extends Omit<IndexerSnapshot, "projection"> {
  readonly projection: SerializableProjection;
}

function snapshotId(input: string): string {
  return `snapshot-${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function snapshotIdentityEncoding(snapshot: SerializableSnapshot): string {
  return encodeBigInts({
    schemaVersion: snapshot.schemaVersion,
    id: "pending",
    takenAtUnixMilliseconds: snapshot.takenAtUnixMilliseconds,
    cursor: snapshot.cursor,
    projection: snapshot.projection,
  });
}

function serialiseProjection(projection: ProtocolProjection): SerializableProjection {
  return {
    ...projection,
    positions: [...projection.positions.values()],
    lpEpochs: [...projection.lpEpochs.values()].map((epoch) => ({
      ...epoch,
      positions: [...epoch.positions.values()],
    })),
    rewardVaultToEpoch: [...projection.rewardVaultToEpoch.entries()],
    stateIdToEpoch: [...projection.stateIdToEpoch.entries()],
    seenEventIds: [...projection.seenEventIds.entries()],
    protocolExcludedStores: [...projection.protocolExcludedStores.entries()],
    registeredWallets: [...projection.registeredWallets.entries()],
  };
}

export function takeSnapshot(input: {
  readonly projection: ProtocolProjection;
  readonly cursor: IndexerSnapshot["cursor"];
  readonly takenAtUnixMilliseconds: bigint;
}): IndexerSnapshot {
  if (!isMoveUnsigned(input.takenAtUnixMilliseconds, 64)) {
    throw new RangeError("snapshot timestamp must fit Move u64");
  }
  if (!isCursor(input.cursor)) {
    throw new RangeError("snapshot cursor must fit the finalized Move u64 cursor domain");
  }
  const cursor = input.cursor === null ? null : { ...input.cursor };
  const projection = structuredClone(input.projection);
  const serialisable: SerializableSnapshot = {
    schemaVersion: 1,
    id: "pending",
    takenAtUnixMilliseconds: input.takenAtUnixMilliseconds,
    cursor,
    projection: serialiseProjection(projection),
  };
  if (!isProjection(serialisable.projection)) {
    throw new TypeError("snapshot projection is not a complete, exact-width protocol state");
  }
  return {
    schemaVersion: 1,
    id: snapshotId(snapshotIdentityEncoding(serialisable)),
    takenAtUnixMilliseconds: input.takenAtUnixMilliseconds,
    cursor,
    projection,
  };
}

export function encodeSnapshot(snapshot: IndexerSnapshot): string {
  return encodeBigInts({ ...snapshot, projection: serialiseProjection(snapshot.projection) });
}

export function decodeSnapshot(encoded: string): IndexerSnapshot {
  const parsed: unknown = JSON.parse(encoded, bigintReviver);
  if (!isSerializableSnapshot(parsed)) {
    throw new TypeError("Invalid indexer snapshot");
  }
  const expectedId = snapshotId(snapshotIdentityEncoding(parsed));
  if (parsed.id !== expectedId) {
    throw new TypeError("Indexer snapshot identifier does not match its content");
  }
  const positions = new Map<Address, IndexedPosition>();
  for (const position of parsed.projection.positions) positions.set(position.account, position);
  const lpEpochs = new Map<bigint, IndexedLpEpoch>();
  for (const epoch of parsed.projection.lpEpochs) {
    const lpPositions = new Map<Address, IndexedLpPosition>();
    for (const position of epoch.positions) lpPositions.set(position.owner, position);
    lpEpochs.set(epoch.epoch, { ...epoch, positions: lpPositions });
  }
  return {
    ...parsed,
    projection: {
      ...parsed.projection,
      positions,
      lpEpochs,
      rewardVaultToEpoch: new Map(parsed.projection.rewardVaultToEpoch),
      stateIdToEpoch: new Map(parsed.projection.stateIdToEpoch),
      seenEventIds: new Map(parsed.projection.seenEventIds),
      protocolExcludedStores: new Map(parsed.projection.protocolExcludedStores),
      registeredWallets: new Map(parsed.projection.registeredWallets),
    },
  };
}

export function projectionFromSnapshot(snapshot: IndexerSnapshot): ProtocolProjection {
  return snapshot.projection ?? createEmptyProjection();
}

function encodeBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    typeof current === "bigint" ? { $bigint: current.toString() } : current,
  );
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (
    typeof value === "object"
    && value !== null
    && "$bigint" in value
    && Object.keys(value).length === 1
    && typeof (value as { readonly $bigint?: unknown }).$bigint === "string"
  ) {
    const encoded = (value as { readonly $bigint: string }).$bigint;
    if (!/^-?(?:0|[1-9][0-9]{0,77})$/.test(encoded)) {
      throw new TypeError("Invalid indexer snapshot bigint encoding");
    }
    return BigInt(encoded);
  }
  return value;
}

function isSerializableSnapshot(value: unknown): value is SerializableSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SerializableSnapshot>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.id !== "string"
    || !isMoveUnsigned(candidate.takenAtUnixMilliseconds, 64)
    || !/^snapshot-[0-9a-f]{64}$/.test(candidate.id)
    || !isCursor(candidate.cursor)
    || typeof candidate.projection !== "object"
    || candidate.projection === null
  ) return false;
  return isProjection(candidate.projection);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value);
}

function isOptionalAddress(value: unknown): value is Address | null {
  return value === null || isAddress(value);
}

function isOptionalMoveUnsigned(value: unknown, bits: 64 | 128 | 256): value is bigint | null {
  return value === null || isMoveUnsigned(value, bits);
}

function isCursor(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return isMoveUnsigned(value.ledgerVersion, 64)
    && typeof value.eventIndex === "number"
    && Number.isSafeInteger(value.eventIndex)
    && value.eventIndex >= 0
    && isMoveUnsigned(BigInt(value.eventIndex), 64);
}

function hasUnique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function isWalletPosition(value: unknown): value is IndexedPosition {
  if (!isRecord(value)) return false;
  return isAddress(value.account)
    && isMoveUnsigned(value.rawTrfl, 64)
    && isMoveUnsigned(value.rawTusd, 64)
    && isMoveSignedU256(value.correction)
    && isMoveUnsigned(value.claimed, 256)
    && isMoveUnsigned(value.lifetimeClaimed, 256)
    && isMoveUnsigned(value.lifetimeMaterialized, 256);
}

function isLpPosition(value: unknown): value is IndexedLpPosition {
  if (!isRecord(value)) return false;
  return isAddress(value.owner)
    && isMoveUnsigned(value.shares, 128)
    && isMoveSignedU256(value.correction)
    && isMoveUnsigned(value.claimed, 256);
}

function isLpEpoch(value: unknown): value is SerializableLpEpoch {
  if (!isRecord(value) || !Array.isArray(value.positions)) return false;
  const positions = value.positions;
  return isMoveUnsigned(value.epoch, 64)
    && value.epoch > 0n
    && isAddress(value.stateId)
    && (value.status === "active" || value.status === "claim-only")
    && isAddress(value.rewardVault)
    && isMoveUnsigned(value.index, 256)
    && isMoveUnsigned(value.indexRemainder, 256)
    && isMoveUnsigned(value.totalShares, 128)
    && isMoveSignedU256(value.aggregateCorrection)
    && isMoveUnsigned(value.unallocatedRewards, 128)
    && isMoveUnsigned(value.roundingReserve, 128)
    && isMoveUnsigned(value.retiredResidueMagnified, 256)
    && (
      value.terminalRoundingBaseUnits === null
        ? value.status === "active"
        : value.status === "claim-only" && isMoveUnsigned(value.terminalRoundingBaseUnits, 128)
    )
    && isMoveUnsigned(value.lifetimeReceived, 256)
    && isMoveUnsigned(value.lifetimeClaimed, 256)
    && typeof value.quarantined === "boolean"
    && positions.every(isLpPosition)
    && hasUnique(positions.map((position) => position.owner));
}

function isAddressEpochEntries(value: unknown): value is readonly (readonly [Address, bigint])[] {
  if (!Array.isArray(value)) return false;
  const keys: Address[] = [];
  const epochs: bigint[] = [];
  for (const entry of value) {
    if (
      !Array.isArray(entry)
      || entry.length !== 2
      || !isAddress(entry[0])
      || !isMoveUnsigned(entry[1], 64)
      || entry[1] === 0n
    ) {
      return false;
    }
    keys.push(entry[0]);
    epochs.push(entry[1]);
  }
  return hasUnique(keys) && hasUnique(epochs);
}

function isAddressEntries(value: unknown): value is readonly (readonly [Address, Address])[] {
  if (!Array.isArray(value)) return false;
  const keys: Address[] = [];
  const stores: Address[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isAddress(entry[0]) || !isAddress(entry[1])) {
      return false;
    }
    keys.push(entry[0]);
    stores.push(entry[1]);
  }
  return hasUnique(keys) && hasUnique(stores);
}

function isSeenEventEntries(value: unknown): value is readonly (readonly [EventId, string])[] {
  if (!Array.isArray(value)) return false;
  const keys: string[] = [];
  for (const entry of value) {
    if (
      !Array.isArray(entry)
      || entry.length !== 2
      || typeof entry[0] !== "string"
      || entry[0].length === 0
      || entry[0].length > 512
      || typeof entry[1] !== "string"
      || !/^(?:0|[1-9][0-9]{0,19}):(?:0|[1-9][0-9]{0,19})$/.test(entry[1])
    ) return false;
    const [ledgerVersion, eventIndex] = entry[1].split(":");
    if (
      !isMoveUnsigned(BigInt(ledgerVersion!), 64)
      || !isMoveUnsigned(BigInt(eventIndex!), 64)
      || BigInt(eventIndex!) > BigInt(Number.MAX_SAFE_INTEGER)
    ) return false;
    keys.push(entry[0]);
  }
  return hasUnique(keys);
}

function isProjection(value: unknown): value is SerializableProjection {
  if (!isRecord(value)) return false;
  const positions = value.positions;
  const lpEpochs = value.lpEpochs;
  const admins = value.operationalAdmins;
  const pool = value.pool;
  const custody = value.custody;
  const protocolExcludedStores = value.protocolExcludedStores;
  const registeredWallets = value.registeredWallets;
  const rewardVaultToEpoch = value.rewardVaultToEpoch;
  const stateIdToEpoch = value.stateIdToEpoch;
  if (
    !Array.isArray(positions)
    || !positions.every(isWalletPosition)
    || !hasUnique(positions.map((position) => position.account))
    || !Array.isArray(lpEpochs)
    || !lpEpochs.every(isLpEpoch)
    || !hasUnique(lpEpochs.map((epoch) => epoch.epoch))
    || !hasUnique(lpEpochs.map((epoch) => epoch.rewardVault))
    || !hasUnique(lpEpochs.map((epoch) => epoch.stateId))
    || !isAddressEpochEntries(rewardVaultToEpoch)
    || !isAddressEpochEntries(stateIdToEpoch)
    || !isSeenEventEntries(value.seenEventIds)
    || !isAddressEntries(protocolExcludedStores)
    || !isAddressEntries(registeredWallets)
    || !isRecord(admins)
    || !isRecord(pool)
    || !isRecord(custody)
  ) return false;

  const excludedAccounts = new Set(protocolExcludedStores.map(([account]) => account));
  const excludedStores = new Set(protocolExcludedStores.map(([, store]) => store));
  const registeredAccounts = new Set(registeredWallets.map(([account]) => account));
  const validRegistrationBindings = registeredWallets.every(([account, store]) => (
    account !== "0x0"
    && store !== "0x0"
    && !excludedAccounts.has(account)
    && !excludedStores.has(store)
  ));
  if (
    !protocolExcludedStores.every(([account, store]) => account !== "0x0" && store !== "0x0")
    || !validRegistrationBindings
  ) return false;

  const rewardEpochByVault = new Map(rewardVaultToEpoch);
  const stateEpochById = new Map(stateIdToEpoch);
  if (
    rewardVaultToEpoch.length !== lpEpochs.length
    || stateIdToEpoch.length !== lpEpochs.length
    || !lpEpochs.every((epoch) => (
      rewardEpochByVault.get(epoch.rewardVault) === epoch.epoch
      && stateEpochById.get(epoch.stateId) === epoch.epoch
    ))
  ) return false;

  if (!isOptionalMoveUnsigned(value.activeLpEpoch, 64)) return false;
  const activeEpochs = lpEpochs.filter((epoch) => epoch.status === "active");
  if (
    value.activeLpEpoch === null
      ? activeEpochs.length !== 0
      : value.activeLpEpoch === 0n
        || activeEpochs.length !== 1
        || activeEpochs[0]!.epoch !== value.activeLpEpoch
  ) return false;

  return typeof value.deploymentId === "string"
    && value.deploymentId.length > 0
    && value.deploymentId.length <= 512
    && (value.networkLabel === "uninitialized" || value.networkLabel === "cedra-testnet")
    && value.chainId === 2
    && isOptionalAddress(value.tokenMetadata)
    && isMoveUnsigned(value.protocolExclusionSlots, 64)
    && isMoveUnsigned(value.protocolExclusionsRemaining, 64)
    && isMoveUnsigned(value.registeredWalletCount, 64)
    && value.registeredWalletCount === BigInt(registeredWallets.length)
    && positions.every((position) => registeredWallets.some(([account]) => account === position.account))
    && lpEpochs.every((epoch) => epoch.positions.every((position) => (
      position.shares === 0n || registeredAccounts.has(position.owner)
    )))
    && typeof value.automaticMaterialization === "boolean"
    && isMoveUnsigned(value.feeBps, 64)
    && value.feeBps <= 100n
    && isMoveUnsigned(value.currentIndex, 256)
    && isMoveUnsigned(value.indexRemainder, 256)
    && isMoveUnsigned(value.eligibleSupply, 128)
    && isMoveSignedU256(value.aggregateCorrection)
    && isMoveUnsigned(value.unallocatedFees, 128)
    && isMoveUnsigned(value.roundingReserve, 128)
    && isOptionalAddress(value.rewardVault)
    && isOptionalAddress(value.distributionVault)
    && isOptionalAddress(value.mockUsdPoolReserve)
    && isMoveUnsigned(value.rewardVaultCredits, 256)
    && isMoveUnsigned(value.rewardVaultPayouts, 256)
    && isMoveUnsigned(value.lifetimeSwapFees, 256)
    && isMoveUnsigned(value.lifetimeMaterialized, 256)
    && isMoveUnsigned(value.lifetimeCustodyRouted, 256)
    && typeof value.packageVersion === "string"
    && value.packageVersion.length > 0
    && value.packageVersion.length <= 128
    && typeof value.swapsPaused === "boolean"
    && typeof value.claimsPaused === "boolean"
    && typeof value.faucetPaused === "boolean"
    && isMoveUnsigned(value.faucetTrflGrant, 64)
    && isMoveUnsigned(value.faucetTusdGrant, 64)
    && isMoveUnsigned(value.faucetCooldownSeconds, 64)
    && isOptionalAddress(admins.reflectionCore)
    && isOptionalAddress(admins.testAssets)
    && isOptionalAddress(admins.testAmm)
    && typeof value.deploymentReady === "boolean"
    && value.deploymentReady === (
      admins.reflectionCore !== null
      && admins.testAssets !== null
      && admins.testAmm !== null
    )
    && isMoveUnsigned(pool.trflReserve, 64)
    && isMoveUnsigned(pool.tusdReserve, 64)
    && isMoveUnsigned(pool.ammFeeBps, 64)
    && isMoveUnsigned(pool.maximumGrossSwap, 64)
    && isMoveUnsigned(pool.maximumReserveBps, 64)
    && isMoveUnsigned(pool.maximumRflContribution, 64)
    && isMoveUnsigned(pool.maximumTusdContribution, 64)
    && isMoveUnsigned(pool.maximumNonFinalWithdrawalShareBps, 64)
    && typeof pool.poolPaused === "boolean"
    && typeof pool.liquidityPaused === "boolean"
    && typeof pool.lpClaimsPaused === "boolean"
    && typeof pool.shutdownMode === "boolean"
    && typeof pool.seeded === "boolean"
    && isOptionalMoveUnsigned(custody.adapterId, 64)
    && isOptionalAddress(custody.reserveStore)
    && isOptionalMoveUnsigned(custody.activeRouteEpoch, 64)
    && isOptionalAddress(custody.activeLpRewardVault)
    && isMoveUnsigned(custody.shares, 128)
    && isMoveSignedU256(custody.correction)
    && isMoveUnsigned(custody.claimed, 256)
    && isMoveUnsigned(custody.lifetimeRouted, 256);
}
