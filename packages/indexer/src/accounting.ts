import type {
  IndexedLpEpoch,
  IndexedLpPosition,
  IndexedPosition,
  ProtocolProjection,
} from "./types.js";

export const REFLECTION_MAGNITUDE = 1_000_000_000_000_000_000_000_000n;

export function requireNonNegative(value: bigint, label: string): bigint {
  if (value < 0n) {
    throw new RangeError(`${label} cannot be negative`);
  }
  return value;
}

export function magnifiedEntitlement(
  shares: bigint,
  index: bigint,
  signedCorrection: bigint,
): bigint {
  requireNonNegative(shares, "shares");
  requireNonNegative(index, "index");
  const magnified = shares * index + signedCorrection;
  requireNonNegative(magnified, "corrected magnified entitlement");
  return magnified / REFLECTION_MAGNITUDE;
}

export function walletPending(position: IndexedPosition, index: bigint): bigint {
  const gross = magnifiedEntitlement(position.rawTrfl, index, position.correction);
  return requireNonNegative(gross - position.claimed, "wallet pending reward");
}

export function custodyPending(projection: ProtocolProjection): bigint {
  const gross = magnifiedEntitlement(
    projection.custody.shares,
    projection.currentIndex,
    projection.custody.correction,
  );
  return requireNonNegative(gross - projection.custody.claimed, "custody pending reward");
}

export function coreIndexedLiability(projection: ProtocolProjection): bigint {
  const gross = magnifiedEntitlement(
    projection.eligibleSupply,
    projection.currentIndex,
    projection.aggregateCorrection,
  );
  return requireNonNegative(
    gross - projection.lifetimeMaterialized - projection.lifetimeCustodyRouted,
    "core indexed liability",
  );
}

export function expectedCoreVaultBalance(projection: ProtocolProjection): bigint {
  return requireNonNegative(
    projection.lifetimeSwapFees
      - projection.lifetimeMaterialized
      - projection.lifetimeCustodyRouted,
    "expected core reward-vault balance",
  );
}

export function lpPositionPending(position: IndexedLpPosition, epoch: IndexedLpEpoch): bigint {
  const gross = magnifiedEntitlement(position.shares, epoch.index, position.correction);
  return requireNonNegative(gross - position.claimed, "LP position pending reward");
}

export function lpIndexedLiability(epoch: IndexedLpEpoch): bigint {
  const gross = magnifiedEntitlement(epoch.totalShares, epoch.index, epoch.aggregateCorrection);
  return requireNonNegative(gross - epoch.lifetimeClaimed, "LP indexed liability");
}

export function expectedLpVaultBalance(epoch: IndexedLpEpoch): bigint {
  return requireNonNegative(
    epoch.lifetimeReceived - epoch.lifetimeClaimed,
    `expected LP vault balance for epoch ${epoch.epoch.toString()}`,
  );
}

export function sumWalletShares(positions: ReadonlyMap<string, IndexedPosition>): bigint {
  let total = 0n;
  for (const position of positions.values()) {
    total += position.rawTrfl;
  }
  return total;
}

export function sumLpShares(positions: ReadonlyMap<string, IndexedLpPosition>): bigint {
  let total = 0n;
  for (const position of positions.values()) {
    total += position.shares;
  }
  return total;
}
