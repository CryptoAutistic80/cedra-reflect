import type { Address } from "../../protocol-sdk/src/types.js";
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
  "positions" | "lpEpochs" | "rewardVaultToEpoch" | "stateIdToEpoch" | "seenEventIds"
> {
  readonly positions: readonly IndexedPosition[];
  readonly lpEpochs: readonly SerializableLpEpoch[];
  readonly rewardVaultToEpoch: readonly (readonly [Address, bigint])[];
  readonly stateIdToEpoch: readonly (readonly [Address, bigint])[];
  readonly seenEventIds: readonly (readonly [EventId, string])[];
}

interface SerializableSnapshot extends Omit<IndexerSnapshot, "projection"> {
  readonly projection: SerializableProjection;
}

function snapshotId(input: string): string {
  // FNV-1a is a mix-up checksum, not a signature or authenticity mechanism.
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `snapshot-${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
  };
}

export function takeSnapshot(input: {
  readonly projection: ProtocolProjection;
  readonly cursor: IndexerSnapshot["cursor"];
  readonly takenAtUnixMilliseconds: bigint;
}): IndexerSnapshot {
  const serialisable: SerializableSnapshot = {
    schemaVersion: 1,
    id: "pending",
    takenAtUnixMilliseconds: input.takenAtUnixMilliseconds,
    cursor: input.cursor,
    projection: serialiseProjection(input.projection),
  };
  return { ...input, schemaVersion: 1, id: snapshotId(encodeBigInts(serialisable)) };
}

export function encodeSnapshot(snapshot: IndexerSnapshot): string {
  return encodeBigInts({ ...snapshot, projection: serialiseProjection(snapshot.projection) });
}

export function decodeSnapshot(encoded: string): IndexerSnapshot {
  const parsed: unknown = JSON.parse(encoded, bigintReviver);
  if (!isSerializableSnapshot(parsed)) {
    throw new TypeError("Invalid indexer snapshot");
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
    && typeof (value as { readonly $bigint?: unknown }).$bigint === "string"
  ) {
    return BigInt((value as { readonly $bigint: string }).$bigint);
  }
  return value;
}

function isSerializableSnapshot(value: unknown): value is SerializableSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SerializableSnapshot>;
  if (
    candidate.schemaVersion !== 1
    || typeof candidate.id !== "string"
    || typeof candidate.takenAtUnixMilliseconds !== "bigint"
    || typeof candidate.projection !== "object"
    || candidate.projection === null
  ) return false;
  const projection = candidate.projection as Partial<SerializableProjection>;
  return Array.isArray(projection.positions)
    && Array.isArray(projection.lpEpochs)
    && Array.isArray(projection.rewardVaultToEpoch)
    && Array.isArray(projection.stateIdToEpoch)
    && Array.isArray(projection.seenEventIds);
}
