import { type Address } from "../../protocol-sdk/src/types.js";
import {
  REFLECTION_MAGNITUDE,
  coreIndexedLiability,
  custodyPending,
  expectedCoreVaultBalance,
  expectedLpVaultBalance,
  lpIndexedLiability,
  lpPositionPending,
  sumLpShares,
  sumWalletShares,
  walletPending,
} from "./accounting.js";
import type {
  CriticalAlert,
  IndexedLpEpoch,
  IndexedLpPosition,
  IndexedPosition,
  ProtocolEvent,
  ProtocolProjection,
  ReflectionFeeCollectedEvent,
  SwapExecutedEvent,
} from "./types.js";

const BPS_DENOMINATOR = 10_000n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("division denominator must be positive");
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new RangeError("square-root input cannot be negative");
  if (value < 2n) return value;
  let current = value / 2n + 1n;
  let next = (current + value / current) / 2n;
  while (next < current) {
    current = next;
    next = (current + value / current) / 2n;
  }
  return current;
}

export function createEmptyProjection(): ProtocolProjection {
  return {
    automaticMaterialization: false,
    feeBps: 100n,
    currentIndex: 0n,
    indexRemainder: 0n,
    eligibleSupply: 0n,
    aggregateCorrection: 0n,
    unallocatedFees: 0n,
    roundingReserve: 0n,
    rewardVault: null,
    distributionVault: null,
    rewardVaultCredits: 0n,
    rewardVaultPayouts: 0n,
    lifetimeSwapFees: 0n,
    lifetimeMaterialized: 0n,
    lifetimeCustodyRouted: 0n,
    packageVersion: "uninitialized",
    swapsPaused: false,
    claimsPaused: false,
    faucetPaused: false,
    faucetTrflGrant: 1_000_000_000n,
    faucetTusdGrant: 1_000_000_000n,
    faucetCooldownSeconds: 3_600n,
    operationalAdmins: {
      reflectionCore: null,
      testAssets: null,
      testAmm: null,
    },
    pool: {
      trflReserve: 0n,
      tusdReserve: 0n,
      ammFeeBps: 30n,
      maximumGrossSwap: 0n,
      maximumReserveBps: 0n,
      maximumRflContribution: 100_000_000_000n,
      maximumTusdContribution: 100_000_000_000n,
      maximumNonFinalWithdrawalShareBps: BPS_DENOMINATOR,
      poolPaused: false,
      liquidityPaused: false,
      lpClaimsPaused: false,
      shutdownMode: false,
      seeded: false,
    },
    custody: {
      adapterId: null,
      reserveStore: null,
      activeRouteEpoch: null,
      activeLpRewardVault: null,
      shares: 0n,
      correction: 0n,
      claimed: 0n,
      lifetimeRouted: 0n,
    },
    activeLpEpoch: null,
    lpEpochs: new Map<bigint, IndexedLpEpoch>(),
    rewardVaultToEpoch: new Map<Address, bigint>(),
    stateIdToEpoch: new Map<Address, bigint>(),
    positions: new Map<Address, IndexedPosition>(),
    seenEventIds: new Map<string, string>(),
  };
}

function cloneProjection(prior: ProtocolProjection): ProtocolProjection {
  const lpEpochs = new Map<bigint, IndexedLpEpoch>();
  for (const [id, epoch] of prior.lpEpochs) {
    lpEpochs.set(id, { ...epoch, positions: new Map(epoch.positions) });
  }
  return {
    ...prior,
    pool: { ...prior.pool },
    custody: { ...prior.custody },
    positions: new Map(prior.positions),
    lpEpochs,
    rewardVaultToEpoch: new Map(prior.rewardVaultToEpoch),
    stateIdToEpoch: new Map(prior.stateIdToEpoch),
    seenEventIds: new Map(prior.seenEventIds),
  };
}

function positionOrEmpty(account: Address, positions: ReadonlyMap<Address, IndexedPosition>): IndexedPosition {
  return positions.get(account) ?? {
    account,
    rawTrfl: 0n,
    rawTusd: 0n,
    correction: 0n,
    claimed: 0n,
    lifetimeClaimed: 0n,
    lifetimeMaterialized: 0n,
  };
}

function lpPositionOrEmpty(owner: Address, positions: ReadonlyMap<Address, IndexedLpPosition>): IndexedLpPosition {
  return positions.get(owner) ?? { owner, shares: 0n, correction: 0n, claimed: 0n };
}

function problem(
  event: ProtocolEvent,
  code: CriticalAlert["code"],
  message: string,
  expected?: bigint | number | string | boolean,
  observed?: bigint | number | string | boolean,
): CriticalAlert {
  const core: CriticalAlert = {
    id: `event:${event.id}:${code}`,
    severity: "critical",
    code,
    message,
    detectedAtUnixMilliseconds: event.timestampUnixMilliseconds,
    cursor: { ledgerVersion: event.ledgerVersion, eventIndex: event.eventIndex },
  };
  return {
    ...core,
    ...(expected === undefined ? {} : { expected: String(expected) }),
    ...(observed === undefined ? {} : { observed: String(observed) }),
  };
}

interface MutableContext {
  next: ProtocolProjection;
  readonly alerts: CriticalAlert[];
  readonly first: ProtocolEvent;
}

function positions(context: MutableContext): Map<Address, IndexedPosition> {
  return context.next.positions as Map<Address, IndexedPosition>;
}

function lpEpochs(context: MutableContext): Map<bigint, IndexedLpEpoch> {
  return context.next.lpEpochs as Map<bigint, IndexedLpEpoch>;
}

function adjustWalletAsset(
  context: MutableContext,
  account: Address,
  asset: "tRFL" | "tUSD",
  delta: bigint,
  event: ProtocolEvent,
): void {
  const current = positionOrEmpty(account, context.next.positions);
  const balance = asset === "tRFL" ? current.rawTrfl : current.rawTusd;
  if (balance + delta < 0n) {
    throw new RangeError(`event group would create a negative ${asset} balance for ${account}`);
  }
  if (asset === "tUSD") {
    positions(context).set(account, { ...current, rawTusd: balance + delta });
    return;
  }
  const correctionDelta = delta * context.next.currentIndex;
  positions(context).set(account, {
    ...current,
    rawTrfl: balance + delta,
    correction: current.correction - correctionDelta,
  });
  context.next = {
    ...context.next,
    eligibleSupply: context.next.eligibleSupply + delta,
    aggregateCorrection: context.next.aggregateCorrection - correctionDelta,
  };
  if (context.next.eligibleSupply < 0n) {
    throw new RangeError(`event group would create negative global shares at ${event.id}`);
  }
}

function materializeWallet(
  context: MutableContext,
  event: Extract<ProtocolEvent, { readonly type: "RewardsMaterialized" }>,
): void {
  if (event.amount <= 0n) {
    throw new RangeError("materialized reward amount must be positive");
  }
  const before = positionOrEmpty(event.account, context.next.positions);
  const pending = walletPending(before, context.next.currentIndex);
  if (event.amount > pending) {
    context.alerts.push(problem(event, "POSITION_ACCOUNTING", "Wallet materialization exceeds independently calculated pending rewards.", pending, event.amount));
  }
  adjustWalletAsset(context, event.account, "tRFL", event.amount, event);
  const current = positionOrEmpty(event.account, context.next.positions);
  const claimed = current.claimed + event.amount;
  if (claimed !== event.totalClaimed) {
    context.alerts.push(problem(event, "POSITION_ACCOUNTING", "Wallet cumulative materialization does not match the event.", claimed, event.totalClaimed));
  }
  positions(context).set(event.account, {
    ...current,
    claimed,
    lifetimeMaterialized: current.lifetimeMaterialized + event.amount,
  });
  context.next = {
    ...context.next,
    rewardVaultPayouts: context.next.rewardVaultPayouts + event.amount,
    lifetimeMaterialized: context.next.lifetimeMaterialized + event.amount,
  };
}

function requireEpoch(context: MutableContext, event: ProtocolEvent, epochId: bigint): IndexedLpEpoch | null {
  const epoch = context.next.lpEpochs.get(epochId);
  if (epoch === undefined) {
    context.alerts.push(problem(event, "LP_ACCOUNTING", `LP event references unknown epoch ${epochId.toString()}.`));
    return null;
  }
  return epoch;
}

function updateEpoch(context: MutableContext, epoch: IndexedLpEpoch): void {
  lpEpochs(context).set(epoch.epoch, epoch);
}

function adjustLpShares(
  context: MutableContext,
  event: Extract<ProtocolEvent, { readonly type: "LpSharesChanged" }>,
): void {
  const epoch = requireEpoch(context, event, event.epoch);
  if (epoch === null) return;
  if (epoch.status !== "active" || epoch.quarantined || event.amount <= 0n) {
    context.alerts.push(problem(event, "LP_ACCOUNTING", "LP share mutation must be positive and target the active epoch."));
    return;
  }
  const delta = event.added ? event.amount : -event.amount;
  const current = lpPositionOrEmpty(event.owner, epoch.positions);
  if (current.shares + delta < 0n || epoch.totalShares + delta < 0n) {
    context.alerts.push(problem(event, "LP_ACCOUNTING", "LP share mutation would underflow a position or epoch."));
    return;
  }
  const correctionDelta = delta * epoch.index;
  const nextPosition = {
    ...current,
    shares: current.shares + delta,
    correction: current.correction - correctionDelta,
  };
  const nextPositions = new Map(epoch.positions);
  nextPositions.set(event.owner, nextPosition);
  const nextEpoch = {
    ...epoch,
    totalShares: epoch.totalShares + delta,
    aggregateCorrection: epoch.aggregateCorrection - correctionDelta,
    positions: nextPositions,
  };
  if (nextPosition.shares !== event.ownerShares || nextEpoch.totalShares !== event.totalShares) {
    context.alerts.push(problem(
      event,
      "LP_ACCOUNTING",
      "LP post-mutation shares disagree with independently replayed shares.",
      `${nextPosition.shares}/${nextEpoch.totalShares}`,
      `${event.ownerShares}/${event.totalShares}`,
    ));
  }
  updateEpoch(context, nextEpoch);
}

interface PendingCoreFee {
  readonly event: ReflectionFeeCollectedEvent;
  readonly sharesAtCollection: bigint;
}

export interface ReduceResult {
  readonly projection: ProtocolProjection;
  readonly alerts: readonly CriticalAlert[];
}

/**
 * Replays one complete Cedra ledger-version transaction. Composite pool calls
 * move wallet, custody, and LP state through separate modules; committing only
 * after all cross-module receipts agree prevents one-sided replay.
 */
export function reduceEventGroup(
  prior: ProtocolProjection,
  unsortedEvents: readonly ProtocolEvent[],
): ReduceResult {
  if (unsortedEvents.length === 0) return { projection: prior, alerts: [] };
  const events = [...unsortedEvents].sort((left, right) => left.eventIndex - right.eventIndex);
  const context: MutableContext = { next: cloneProjection(prior), alerts: [], first: events[0]! };
  const first = events[0]!;

  const groupIds = new Set<string>();
  let previousEventIndex = -1;
  for (const event of events) {
    if (event.ledgerVersion !== first.ledgerVersion || event.txHash !== first.txHash) {
      context.alerts.push(problem(event, "TRANSACTION_GROUP", "One atomic event group contains more than one transaction identity."));
    }
    if (event.eventIndex <= previousEventIndex) {
      context.alerts.push(problem(event, "EVENT_ORDER", "Event indices inside a transaction must be strictly increasing."));
    }
    previousEventIndex = event.eventIndex;
    const priorCursor = prior.seenEventIds.get(event.id);
    if (priorCursor !== undefined || groupIds.has(event.id)) {
      context.alerts.push(problem(
        event,
        "IDENTIFIER_REUSE",
        "An event identifier was reused for a different replay position.",
        priorCursor ?? "unique in transaction",
        `${event.ledgerVersion.toString()}:${event.eventIndex.toString()}`,
      ));
    }
    groupIds.add(event.id);
  }

  const swaps = events.filter((event): event is SwapExecutedEvent => event.type === "SwapExecuted");
  const liquidity = events.filter((event) => event.type === "LiquiditySeeded" || event.type === "LiquidityAdded" || event.type === "LiquidityRemoved");
  const custodyChanges = events.filter((event) => event.type === "CustodySharesChanged");
  const routes = events.filter((event) => event.type === "CustodyRewardsRouted");
  const lpAdvances = events.filter((event) => event.type === "LpRewardIndexAdvanced");
  const lpQuarantines = events.filter((event) => event.type === "LpRewardQuarantined");
  const lpOpenings = events.filter((event) => event.type === "LpEpochOpened");
  const adapterRegistrations = events.filter((event) => event.type === "CustodyAdapterRegistered");
  const routeOpenings = events.filter((event) => event.type === "CustodyEpochRouteOpened");
  const nativeDebits = events.filter((event) => event.type === "EligibleBalanceDebited");
  const nativeCredits = events.filter((event) => event.type === "EligibleBalanceCredited");
  const walletTransfers = events.filter((event) => event.type === "WalletTransfer");
  const materialized = events.filter((event) => event.type === "RewardsMaterialized");
  const explicitClaims = events.filter((event) => event.type === "RewardsClaimed");

  if (swaps.length > 1 || liquidity.length > 1) {
    context.alerts.push(problem(first, "TRANSACTION_GROUP", "A transaction contains multiple terminal pool receipts."));
  }
  if ((swaps.length + liquidity.length) > 0 && (nativeDebits.length > 0 || nativeCredits.length > 0 || walletTransfers.length > 0)) {
    context.alerts.push(problem(first, "DOUBLE_COUNTING", "Composite pool settlement must not also be replayed as a wallet-hook transfer."));
  }

  const expectedCustody = swaps.length === 1
    ? {
      added: swaps[0]!.direction === "sell",
      amount: swaps[0]!.direction === "sell" ? swaps[0]!.netReserveInput : swaps[0]!.grossPoolOutput,
    }
    : liquidity.length === 1
      ? {
        added: liquidity[0]!.type !== "LiquidityRemoved",
        amount: liquidity[0]!.trflAmount,
      }
      : null;
  if (expectedCustody !== null) {
    if (
      custodyChanges.length !== 1
      || custodyChanges[0]!.added !== expectedCustody.added
      || custodyChanges[0]!.amount !== expectedCustody.amount
    ) {
      context.alerts.push(problem(
        first,
        custodyChanges.length > 1 ? "DOUBLE_COUNTING" : "RESERVE_CUSTODY",
        "Pool reserve movement must have exactly one equal custody-share receipt.",
        `${expectedCustody.added}/${expectedCustody.amount}`,
        custodyChanges.map((event) => `${event.added}/${event.amount}`).join(",") || "missing",
      ));
    }
  } else if (custodyChanges.length > 0) {
    context.alerts.push(problem(first, "TRANSACTION_GROUP", "Custody shares changed without a swap or liquidity receipt."));
  }

  if (routes.length !== lpAdvances.length + lpQuarantines.length) {
    context.alerts.push(problem(
      first,
      "ROUTE_PAIR",
      "Each core custody route must have exactly one downstream LP-index receipt in the same transaction.",
      routes.length,
      lpAdvances.length + lpQuarantines.length,
    ));
  }
  for (const opening of lpOpenings) {
    const initialPair = adapterRegistrations.filter((candidate) =>
      candidate.firstEpoch === opening.epoch && candidate.lpRewardVault === opening.rewardVault
    );
    const laterPair = routeOpenings.filter((candidate) =>
      candidate.epoch === opening.epoch && candidate.lpRewardVault === opening.rewardVault
    );
    const expectedInitial = prior.lpEpochs.size === 0;
    if ((expectedInitial ? initialPair.length : laterPair.length) !== 1) {
      context.alerts.push(problem(opening, "ROUTE_PAIR", "Every LP epoch opening must pair with exactly one matching initial adapter or fresh custody route."));
    }
  }
  for (const routeOpening of routeOpenings) {
    if (!lpOpenings.some((opening) =>
      opening.epoch === routeOpening.epoch && opening.rewardVault === routeOpening.lpRewardVault
    )) {
      context.alerts.push(problem(routeOpening, "ROUTE_PAIR", "Fresh custody epoch route lacks a same-transaction LP epoch opening."));
    }
  }

  if (liquidity.length === 1) {
    const receipt = liquidity[0]!;
    const epoch = prior.lpEpochs.get(receipt.epoch);
    const openedInGroup = events.some((candidate) =>
      candidate.type === "LpEpochOpened" && candidate.epoch === receipt.epoch
    );
    const isFreshReseed = receipt.type === "LiquiditySeeded"
      && epoch === undefined
      && prior.activeLpEpoch === null
      && openedInGroup;
    if (!isFreshReseed && (epoch === undefined || prior.activeLpEpoch !== receipt.epoch)) {
      context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Liquidity receipt does not target the replayed active LP epoch."));
    } else if (receipt.type === "LiquiditySeeded") {
      const expectedShares = integerSqrt(receipt.trflAmount * receipt.tusdAmount);
      if (
        prior.pool.trflReserve !== 0n
        || prior.pool.tusdReserve !== 0n
        || (epoch?.totalShares ?? 0n) !== 0n
        || receipt.lpShares !== expectedShares
      ) {
        context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Initial liquidity shares must equal floor(sqrt(tRFL * tUSD)) on empty reserves.", expectedShares, receipt.lpShares));
      }
    } else if (receipt.type === "LiquidityAdded") {
      if (epoch!.totalShares <= 0n || prior.pool.trflReserve <= 0n || prior.pool.tusdReserve <= 0n) {
        context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Liquidity addition requires nonzero reserves and existing LP shares."));
      } else {
        const expectedRfl = ceilDiv(receipt.lpShares * prior.pool.trflReserve, epoch!.totalShares);
        const expectedUsd = ceilDiv(receipt.lpShares * prior.pool.tusdReserve, epoch!.totalShares);
        if (receipt.trflAmount !== expectedRfl || receipt.tusdAmount !== expectedUsd) {
          context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Liquidity input amounts do not match the shares' proportional ceil arithmetic.", `${expectedRfl}/${expectedUsd}`, `${receipt.trflAmount}/${receipt.tusdAmount}`));
        }
      }
    } else if (epoch!.totalShares <= 0n || receipt.lpShares > epoch!.totalShares) {
      context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Liquidity removal exceeds replayed epoch shares."));
    } else {
      const expectedRfl = receipt.lpShares === epoch!.totalShares
        ? prior.pool.trflReserve
        : receipt.lpShares * prior.pool.trflReserve / epoch!.totalShares;
      const expectedUsd = receipt.lpShares === epoch!.totalShares
        ? prior.pool.tusdReserve
        : receipt.lpShares * prior.pool.tusdReserve / epoch!.totalShares;
      if (
        receipt.trflAmount !== expectedRfl
        || receipt.tusdAmount !== expectedUsd
        || receipt.finalExit !== (receipt.lpShares === epoch!.totalShares)
      ) {
        context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Liquidity withdrawal does not match proportional floor/final-exit arithmetic.", `${expectedRfl}/${expectedUsd}/${receipt.lpShares === epoch!.totalShares}`, `${receipt.trflAmount}/${receipt.tusdAmount}/${receipt.finalExit}`));
      }
    }
  }

  for (const claim of explicitClaims) {
    const matches = materialized.filter((entry) => entry.account === claim.account && entry.amount === claim.amount);
    if (matches.length !== 1 || claim.totalClaimed !== matches[0]!.totalClaimed) {
      context.alerts.push(problem(claim, "DOUBLE_COUNTING", "Explicit claim action must pair with exactly one materialization receipt."));
    }
  }

  const pendingCoreFees: PendingCoreFee[] = [];
  const consumedRoutes = new Set<string>();
  let sellWalletDebited = false;

  try {
    for (const event of events) {
      switch (event.type) {
        case "ProtocolInitialized":
          if (context.next.packageVersion !== "uninitialized") {
            context.alerts.push(problem(event, "IDENTIFIER_REUSE", "Protocol initialization appeared more than once."));
          }
          if (event.feeBps > 100n) {
            context.alerts.push(problem(event, "EVENT_DATA", "Protocol initialized with a reflection fee above 100 bps."));
          }
          context.next = {
            ...context.next,
            automaticMaterialization: event.automaticMaterialization,
            feeBps: event.feeBps,
            currentIndex: event.initialIndex,
            packageVersion: event.packageVersion,
            rewardVault: event.rewardVault,
            distributionVault: event.distributionVault,
          };
          break;

        case "PositionCreated":
          positions(context).set(event.account, positionOrEmpty(event.account, context.next.positions));
          break;

        case "FaucetGrant":
          if (event.amount <= 0n) throw new RangeError("faucet grant must be positive");
          adjustWalletAsset(context, event.account, event.asset, event.amount, event);
          break;

        case "FaucetConfigured":
          if (event.trflGrant <= 0n || event.tusdGrant <= 0n) {
            context.alerts.push(problem(event, "EVENT_DATA", "Faucet grants must both be positive."));
          }
          context.next = {
            ...context.next,
            faucetTrflGrant: event.trflGrant,
            faucetTusdGrant: event.tusdGrant,
            faucetCooldownSeconds: event.cooldownSeconds,
          };
          break;

        case "WalletTransfer": {
          if (event.amount <= 0n) throw new RangeError("wallet transfer must be positive");
          const matchingDebit = nativeDebits.filter((entry) => entry.account === event.from && entry.amount === event.amount);
          const matchingCredit = nativeCredits.filter((entry) => entry.account === event.to && entry.amount === event.amount);
          if (nativeDebits.length > 0 && matchingDebit.length !== 1) {
            context.alerts.push(problem(event, "DOUBLE_COUNTING", "Router sender receipt disagrees with the native eligible-store debit."));
          }
          if (nativeCredits.length > 0 && matchingCredit.length !== 1) {
            context.alerts.push(problem(event, "DOUBLE_COUNTING", "Router recipient receipt disagrees with the native eligible-store credit."));
          }
          // Excluded endpoints intentionally emit no eligible-balance hook
          // event. The receipt is therefore informational and never mutates
          // the replayed eligible ledger by itself.
          break;
        }

        case "EligibleBalanceDebited":
          if (event.amount <= 0n) throw new RangeError("eligible-balance debit must be positive");
          adjustWalletAsset(context, event.account, "tRFL", -event.amount, event);
          break;

        case "EligibleBalanceCredited":
          if (event.amount <= 0n) throw new RangeError("eligible-balance credit must be positive");
          adjustWalletAsset(context, event.account, "tRFL", event.amount, event);
          break;

        case "RewardsMaterialized":
          materializeWallet(context, event);
          break;

        case "RewardsClaimed": {
          if (event.amount <= 0n) throw new RangeError("claimed reward amount must be positive");
          const current = positionOrEmpty(event.account, context.next.positions);
          positions(context).set(event.account, {
            ...current,
            lifetimeClaimed: current.lifetimeClaimed + event.amount,
          });
          break;
        }

        case "CustodyAdapterRegistered": {
          if (
            event.adapterId <= 0n
            || event.firstEpoch !== 1n
            || context.next.custody.adapterId !== null
            || context.next.custody.reserveStore !== null
            || context.next.rewardVaultToEpoch.has(event.lpRewardVault)
          ) {
            context.alerts.push(problem(event, "IDENTIFIER_REUSE", "Canonical custody adapter, reserve, or first LP vault was registered more than once."));
          }
          context.next = {
            ...context.next,
            custody: {
              ...context.next.custody,
              adapterId: event.adapterId,
              reserveStore: event.reserveStore,
              activeRouteEpoch: event.firstEpoch,
              activeLpRewardVault: event.lpRewardVault,
            },
          };
          break;
        }

        case "CustodyEpochRouteOpened": {
          const epoch = context.next.lpEpochs.get(event.epoch);
          if (
            context.next.custody.adapterId !== event.adapterId
            || context.next.custody.reserveStore !== event.reserveStore
            || epoch === undefined
            || epoch.rewardVault !== event.lpRewardVault
            || epoch.status !== "active"
            || context.next.activeLpEpoch !== event.epoch
            || context.next.custody.shares !== 0n
            || custodyPending(context.next) !== 0n
          ) {
            context.alerts.push(problem(event, "VAULT_BINDING", "Fresh custody route does not continue the immutable adapter/reserve/epoch binding."));
          }
          if (
            context.next.custody.activeRouteEpoch !== null
            && event.epoch !== context.next.custody.activeRouteEpoch + 1n
          ) {
            context.alerts.push(problem(event, "OLD_EPOCH_ROUTE", "Custody route epochs must advance exactly once."));
          }
          context.next = {
            ...context.next,
            custody: {
              ...context.next.custody,
              activeRouteEpoch: event.epoch,
              activeLpRewardVault: event.lpRewardVault,
            },
          };
          break;
        }

        case "ReflectionFeeCollected": {
          const swap = swaps[0];
          if (swap?.direction === "sell" && !sellWalletDebited) {
            adjustWalletAsset(context, swap.account, "tRFL", -swap.grossAmount, event);
            sellWalletDebited = true;
          }
          const expectedFee = (event.grossAmount * event.feeBps) / BPS_DENOMINATOR;
          if (
            event.feeBps > 100n
            || event.feeBps !== context.next.feeBps
            || event.feeAmount !== expectedFee
            || event.swapTxHash !== event.txHash
          ) {
            context.alerts.push(problem(event, "FEE_FORMULA", "Reflection fee receipt does not match configured floor arithmetic and transaction identity."));
          }
          context.next = {
            ...context.next,
            rewardVaultCredits: context.next.rewardVaultCredits + event.feeAmount,
            lifetimeSwapFees: context.next.lifetimeSwapFees + event.feeAmount,
          };
          pendingCoreFees.push({ event, sharesAtCollection: context.next.eligibleSupply });
          break;
        }

        case "ReflectionIndexAdvanced": {
          const pending = pendingCoreFees.shift();
          if (pending === undefined) {
            context.alerts.push(problem(event, "TRANSACTION_GROUP", "Global index advanced without a preceding fee receipt."));
            break;
          }
          if (pending.sharesAtCollection <= 0n) {
            context.alerts.push(problem(event, "GLOBAL_INDEX", "Global index advanced with a zero denominator."));
            break;
          }
          const numerator = pending.event.feeAmount * REFLECTION_MAGNITUDE + context.next.indexRemainder;
          const expectedIndex = context.next.currentIndex + numerator / pending.sharesAtCollection;
          const expectedRemainder = numerator % pending.sharesAtCollection;
          if (
            event.feeAmount !== pending.event.feeAmount
            || event.previousIndex !== context.next.currentIndex
            || event.newIndex !== expectedIndex
            || event.indexRemainder !== expectedRemainder
            || event.eligibleSupply !== pending.sharesAtCollection
            || event.eligibleSupply !== context.next.eligibleSupply
          ) {
            context.alerts.push(problem(
              event,
              "GLOBAL_INDEX",
              "Global index event disagrees with the independent fee/share calculation.",
              `${context.next.currentIndex}/${expectedIndex}/${expectedRemainder}/${pending.sharesAtCollection}`,
              `${event.previousIndex}/${event.newIndex}/${event.indexRemainder}/${event.eligibleSupply}`,
            ));
          }
          context.next = { ...context.next, currentIndex: event.newIndex, indexRemainder: event.indexRemainder };
          break;
        }

        case "CustodySharesChanged": {
          if (event.amount <= 0n) throw new RangeError("custody share mutation must be positive");
          const delta = event.added ? event.amount : -event.amount;
          if (context.next.custody.shares + delta < 0n) throw new RangeError("custody shares cannot underflow");
          const correctionDelta = delta * context.next.currentIndex;
          const custody = {
            ...context.next.custody,
            shares: context.next.custody.shares + delta,
            correction: context.next.custody.correction - correctionDelta,
          };
          context.next = {
            ...context.next,
            custody,
            eligibleSupply: context.next.eligibleSupply + delta,
            aggregateCorrection: context.next.aggregateCorrection - correctionDelta,
          };
          if (custody.shares !== event.custodyShares || context.next.eligibleSupply !== event.globalShares) {
            context.alerts.push(problem(
              event,
              "CUSTODY_ACCOUNTING",
              "Custody/global post-mutation shares disagree with replay.",
              `${custody.shares}/${context.next.eligibleSupply}`,
              `${event.custodyShares}/${event.globalShares}`,
            ));
          }
          break;
        }

        case "CustodyRewardsRouted": {
          const epoch = requireEpoch(context, event, event.epoch);
          if (
            context.next.activeLpEpoch !== event.epoch
            || context.next.custody.activeRouteEpoch !== event.epoch
          ) {
            context.alerts.push(problem(event, "OLD_EPOCH_ROUTE", "Custody rewards were routed to a non-active LP/custody epoch.", `${context.next.activeLpEpoch?.toString() ?? "none"}/${context.next.custody.activeRouteEpoch?.toString() ?? "none"}`, event.epoch));
          }
          if (epoch !== null && epoch.rewardVault !== event.lpRewardVault) {
            context.alerts.push(problem(event, "VAULT_BINDING", "Custody route vault disagrees with the epoch's immutable vault binding.", epoch.rewardVault, event.lpRewardVault));
          }
          if (context.next.custody.activeLpRewardVault !== event.lpRewardVault) {
            context.alerts.push(problem(event, "VAULT_BINDING", "Custody route does not target the adapter's active LP vault.", context.next.custody.activeLpRewardVault ?? "none", event.lpRewardVault));
          }
          if (context.next.custody.reserveStore !== null && context.next.custody.reserveStore !== event.reserveStore) {
            context.alerts.push(problem(event, "VAULT_BINDING", "Canonical custody reserve identifier changed after registration.", context.next.custody.reserveStore, event.reserveStore));
          }
          const pending = custodyPending(context.next);
          if (event.amount !== pending || event.amount <= 0n) {
            context.alerts.push(problem(event, "CUSTODY_ACCOUNTING", "Custody route must settle the exact whole pending amount.", pending, event.amount));
          }
          const claimed = context.next.custody.claimed + event.amount;
          if (claimed !== event.totalRouted) {
            context.alerts.push(problem(event, "CUSTODY_ACCOUNTING", "Custody cumulative routed amount disagrees with replay.", claimed, event.totalRouted));
          }
          context.next = {
            ...context.next,
            custody: {
              ...context.next.custody,
              reserveStore: context.next.custody.reserveStore ?? event.reserveStore,
              claimed,
              lifetimeRouted: context.next.custody.lifetimeRouted + event.amount,
            },
            lifetimeCustodyRouted: context.next.lifetimeCustodyRouted + event.amount,
            rewardVaultPayouts: context.next.rewardVaultPayouts + event.amount,
          };
          break;
        }

        case "LpEpochOpened": {
          const vaultEpoch = context.next.rewardVaultToEpoch.get(event.rewardVault);
          const stateEpoch = context.next.stateIdToEpoch.get(event.stateId);
          if (
            context.next.lpEpochs.has(event.epoch)
            || vaultEpoch !== undefined
            || stateEpoch !== undefined
            || context.next.activeLpEpoch !== null
          ) {
            context.alerts.push(problem(event, "IDENTIFIER_REUSE", "LP epoch or reward-vault identifier was reused while another epoch is active."));
            break;
          }
          const epoch: IndexedLpEpoch = {
            epoch: event.epoch,
            stateId: event.stateId,
            status: "active",
            rewardVault: event.rewardVault,
            index: 0n,
            indexRemainder: 0n,
            totalShares: 0n,
            aggregateCorrection: 0n,
            unallocatedRewards: 0n,
            roundingReserve: 0n,
            lifetimeReceived: 0n,
            lifetimeClaimed: 0n,
            quarantined: false,
            positions: new Map<Address, IndexedLpPosition>(),
          };
          updateEpoch(context, epoch);
          (context.next.rewardVaultToEpoch as Map<Address, bigint>).set(event.rewardVault, event.epoch);
          (context.next.stateIdToEpoch as Map<Address, bigint>).set(event.stateId, event.epoch);
          context.next = { ...context.next, activeLpEpoch: event.epoch };
          break;
        }

        case "LpEpochStatusChanged": {
          const epoch = requireEpoch(context, event, event.epoch);
          if (epoch === null) break;
          const allowed = event.oldStatus === "active" && event.newStatus === "claim-only";
          if (!allowed || epoch.status !== event.oldStatus) {
            context.alerts.push(problem(event, "LP_ACCOUNTING", "LP epoch status transition is invalid or does not continue replayed state."));
          }
          updateEpoch(context, { ...epoch, status: event.newStatus });
          if (event.newStatus === "claim-only") {
            if (context.next.activeLpEpoch !== event.epoch || epoch.totalShares !== 0n) {
              context.alerts.push(problem(event, "LP_ACCOUNTING", "Only an empty active epoch can become claim-only."));
            }
            context.next = { ...context.next, activeLpEpoch: null };
          }
          break;
        }

        case "LpSharesChanged":
          adjustLpShares(context, event);
          break;

        case "LpSharesTransferred": {
          const epoch = requireEpoch(context, event, event.epoch);
          if (epoch === null) break;
          if (epoch.status !== "active" || epoch.quarantined || event.amount <= 0n) {
            context.alerts.push(problem(event, "LP_ACCOUNTING", "LP transfer must be positive and target the active epoch."));
            break;
          }
          const sender = lpPositionOrEmpty(event.sender, epoch.positions);
          const recipient = lpPositionOrEmpty(event.recipient, epoch.positions);
          if (sender.shares < event.amount || event.sender === event.recipient) {
            context.alerts.push(problem(event, "LP_ACCOUNTING", "LP transfer would underflow or transfer to self."));
            break;
          }
          const delta = event.amount * epoch.index;
          const nextPositions = new Map(epoch.positions);
          nextPositions.set(event.sender, { ...sender, shares: sender.shares - event.amount, correction: sender.correction + delta });
          nextPositions.set(event.recipient, { ...recipient, shares: recipient.shares + event.amount, correction: recipient.correction - delta });
          updateEpoch(context, { ...epoch, positions: nextPositions });
          break;
        }

        case "LpRewardIndexAdvanced": {
          const epoch = requireEpoch(context, event, event.epoch);
          if (epoch === null) break;
          const route = routes.find((candidate) =>
            !consumedRoutes.has(candidate.id)
            && candidate.epoch === event.epoch
            && candidate.amount === event.received
            && candidate.lpRewardVault === epoch.rewardVault
            && candidate.eventIndex < event.eventIndex
          );
          if (route === undefined) {
            context.alerts.push(problem(event, "ROUTE_PAIR", "LP index receipt has no preceding equal core custody route."));
          } else {
            consumedRoutes.add(route.id);
          }
          if (context.next.activeLpEpoch !== event.epoch) {
            context.alerts.push(problem(event, "OLD_EPOCH_ROUTE", "LP index advanced outside the active epoch."));
          }
          if (epoch.totalShares <= 0n) {
            context.alerts.push(problem(event, "LP_ACCOUNTING", "LP index cannot advance with zero shares."));
            break;
          }
          const numerator = event.received * REFLECTION_MAGNITUDE + epoch.indexRemainder;
          const expectedIndex = epoch.index + numerator / epoch.totalShares;
          const expectedRemainder = numerator % epoch.totalShares;
          let nextEpoch: IndexedLpEpoch = {
            ...epoch,
            index: event.newIndex,
            indexRemainder: event.indexRemainder,
            lifetimeReceived: epoch.lifetimeReceived + event.received,
          };
          const calculatedRounding = expectedLpVaultBalance(nextEpoch)
            - lpIndexedLiability(nextEpoch)
            - nextEpoch.unallocatedRewards;
          if (
            event.previousIndex !== epoch.index
            || event.newIndex !== expectedIndex
            || event.indexRemainder !== expectedRemainder
            || event.totalShares !== epoch.totalShares
            || event.roundingReserve !== calculatedRounding
          ) {
            context.alerts.push(problem(
              event,
              "LP_ACCOUNTING",
              "LP reward index or rounding receipt disagrees with independent arithmetic.",
              `${epoch.index}/${expectedIndex}/${expectedRemainder}/${epoch.totalShares}/${calculatedRounding}`,
              `${event.previousIndex}/${event.newIndex}/${event.indexRemainder}/${event.totalShares}/${event.roundingReserve}`,
            ));
          }
          nextEpoch = { ...nextEpoch, roundingReserve: calculatedRounding };
          updateEpoch(context, nextEpoch);
          break;
        }

        case "LpRewardQuarantined": {
          const epoch = requireEpoch(context, event, event.epoch);
          if (epoch === null) break;
          const route = routes.find((candidate) =>
            !consumedRoutes.has(candidate.id)
            && candidate.epoch === event.epoch
            && candidate.amount === event.amount
            && candidate.lpRewardVault === event.rewardVault
            && candidate.eventIndex < event.eventIndex
          );
          if (route === undefined) {
            context.alerts.push(problem(event, "ROUTE_PAIR", "LP quarantine receipt has no preceding equal custody route."));
          } else {
            consumedRoutes.add(route.id);
          }
          if (
            context.next.activeLpEpoch !== event.epoch
            || epoch.status !== "active"
            || epoch.totalShares !== 0n
            || epoch.rewardVault !== event.rewardVault
          ) {
            context.alerts.push(problem(event, "LP_ACCOUNTING", "LP reward quarantine is valid only for the empty active epoch and its bound vault."));
          }
          const unallocatedRewards = epoch.unallocatedRewards + event.amount;
          if (unallocatedRewards !== event.unallocatedRewards) {
            context.alerts.push(problem(event, "LP_ACCOUNTING", "LP quarantine cumulative unallocated amount disagrees with replay.", unallocatedRewards, event.unallocatedRewards));
          }
          const nextEpoch: IndexedLpEpoch = {
            ...epoch,
            lifetimeReceived: epoch.lifetimeReceived + event.amount,
            unallocatedRewards,
            quarantined: true,
          };
          updateEpoch(context, {
            ...nextEpoch,
            roundingReserve: expectedLpVaultBalance(nextEpoch) - lpIndexedLiability(nextEpoch) - unallocatedRewards,
          });
          break;
        }

        case "LpRewardsClaimed": {
          const epoch = requireEpoch(context, event, event.epoch);
          if (epoch === null) break;
          const current = lpPositionOrEmpty(event.owner, epoch.positions);
          const pending = lpPositionPending(current, epoch);
          if (event.amount <= 0n || event.amount > pending) {
            context.alerts.push(problem(event, "LP_ACCOUNTING", "LP claim exceeds independently calculated pending rewards.", pending, event.amount));
          }
          const claimed = current.claimed + event.amount;
          if (claimed !== event.totalClaimed) {
            context.alerts.push(problem(event, "POSITION_ACCOUNTING", "LP position cumulative claim disagrees with replay.", claimed, event.totalClaimed));
          }
          const nextPositions = new Map(epoch.positions);
          nextPositions.set(event.owner, { ...current, claimed });
          const nextEpoch = {
            ...epoch,
            positions: nextPositions,
            lifetimeClaimed: epoch.lifetimeClaimed + event.amount,
          };
          updateEpoch(context, nextEpoch);
          // Core payout attaches LP tRFL to the wallet at the current global index.
          adjustWalletAsset(context, event.owner, "tRFL", event.amount, event);
          break;
        }

        case "SwapExecuted": {
          if (event.direction === "sell" && !sellWalletDebited) {
            adjustWalletAsset(context, event.account, "tRFL", -event.grossAmount, event);
            sellWalletDebited = true;
          }
          if (event.direction === "sell") {
            adjustWalletAsset(context, event.account, "tUSD", event.netUserReceipt, event);
          } else {
            adjustWalletAsset(context, event.account, "tUSD", -event.grossAmount, event);
            adjustWalletAsset(context, event.account, "tRFL", event.netUserReceipt, event);
          }
          const expectedReflectionFee = event.direction === "sell"
            ? (event.grossAmount * context.next.feeBps) / BPS_DENOMINATOR
            : (event.grossPoolOutput * context.next.feeBps) / BPS_DENOMINATOR;
          const expectedReserveInput = event.direction === "sell"
            ? event.grossAmount - event.reflectionFee
            : event.grossAmount;
          const expectedTrflReserve = event.direction === "sell"
            ? context.next.pool.trflReserve + event.netReserveInput
            : context.next.pool.trflReserve - event.grossPoolOutput;
          const expectedTusdReserve = event.direction === "sell"
            ? context.next.pool.tusdReserve - event.grossPoolOutput
            : context.next.pool.tusdReserve + event.netReserveInput;
          const ammGrossInput = event.direction === "sell" ? event.netReserveInput : event.grossAmount;
          const invariantInput = ammGrossInput
            * (BPS_DENOMINATOR - context.next.pool.ammFeeBps)
            / BPS_DENOMINATOR;
          const expectedAmmFee = ammGrossInput - invariantInput;
          const reserveIn = event.direction === "sell" ? context.next.pool.trflReserve : context.next.pool.tusdReserve;
          const reserveOut = event.direction === "sell" ? context.next.pool.tusdReserve : context.next.pool.trflReserve;
          const expectedGrossOutput = reserveOut * invariantInput / (reserveIn + invariantInput);
          const expectedNetReceipt = event.direction === "sell"
            ? expectedGrossOutput
            : expectedGrossOutput - expectedReflectionFee;
          if (
            event.reflectionFee !== expectedReflectionFee
            || event.netReserveInput !== expectedReserveInput
            || event.ammFee !== expectedAmmFee
            || event.grossPoolOutput !== expectedGrossOutput
            || event.netUserReceipt !== expectedNetReceipt
          ) {
            context.alerts.push(problem(event, "FEE_FORMULA", "Swap receipt disagrees with reflection/AMM fee and constant-product arithmetic."));
          }
          if (event.trflReserveAfter !== expectedTrflReserve || event.tusdReserveAfter !== expectedTusdReserve) {
            context.alerts.push(problem(
              event,
              "POOL_RESERVES",
              "Swap reserve movement does not match its direction and amounts.",
              `${expectedTrflReserve}/${expectedTusdReserve}`,
              `${event.trflReserveAfter}/${event.tusdReserveAfter}`,
            ));
          }
          context.next = {
            ...context.next,
            pool: { ...context.next.pool, trflReserve: event.trflReserveAfter, tusdReserve: event.tusdReserveAfter },
          };
          break;
        }

        case "LiquiditySeeded":
        case "LiquidityAdded":
        case "LiquidityRemoved": {
          if (event.trflAmount <= 0n || event.tusdAmount <= 0n || event.lpShares <= 0n) {
            context.alerts.push(problem(event, "EVENT_DATA", "Liquidity amounts and shares must be positive."));
          }
          const sign = event.type === "LiquidityRemoved" ? -1n : 1n;
          const expectedTrfl = context.next.pool.trflReserve + sign * event.trflAmount;
          const expectedTusd = context.next.pool.tusdReserve + sign * event.tusdAmount;
          if (event.trflReserveAfter !== expectedTrfl || event.tusdReserveAfter !== expectedTusd) {
            context.alerts.push(problem(event, "POOL_RESERVES", "Liquidity receipt reserve totals disagree with replay.", `${expectedTrfl}/${expectedTusd}`, `${event.trflReserveAfter}/${event.tusdReserveAfter}`));
          }
          if (event.type === "LiquidityAdded") {
            adjustWalletAsset(context, event.provider, "tRFL", -event.trflAmount, event);
            adjustWalletAsset(context, event.provider, "tUSD", -event.tusdAmount, event);
          } else if (event.type === "LiquidityRemoved") {
            adjustWalletAsset(context, event.provider, "tRFL", event.trflAmount, event);
            adjustWalletAsset(context, event.provider, "tUSD", event.tusdAmount, event);
          }
          context.next = {
            ...context.next,
            pool: {
              ...context.next.pool,
              trflReserve: event.trflReserveAfter,
              tusdReserve: event.tusdReserveAfter,
              seeded: event.type === "LiquiditySeeded"
                ? true
                : event.type === "LiquidityRemoved" && event.finalExit
                  ? false
                  : context.next.pool.seeded,
            },
          };
          break;
        }

        case "FeeConfigurationChanged":
          if (event.oldFeeBps !== context.next.feeBps || event.newFeeBps > 100n) {
            context.alerts.push(problem(event, "EVENT_DATA", "Fee configuration does not continue replayed state or exceeds 100 bps."));
          }
          context.next = { ...context.next, feeBps: event.newFeeBps };
          break;

        case "FaucetPauseChanged":
          context.next = { ...context.next, faucetPaused: event.paused };
          break;

        case "SwapLimitsChanged":
          context.next = {
            ...context.next,
            pool: {
              ...context.next.pool,
              ammFeeBps: event.ammFeeBps,
              maximumGrossSwap: event.maximumGrossSwap,
              maximumReserveBps: event.maximumReserveBps,
            },
          };
          break;

        case "LiquidityLimitsChanged":
          if (
            event.maximumRflContribution <= 0n
            || event.maximumTusdContribution <= 0n
            || event.maximumNonFinalWithdrawalShareBps <= 0n
            || event.maximumNonFinalWithdrawalShareBps > BPS_DENOMINATOR
          ) {
            context.alerts.push(problem(
              event,
              "EVENT_DATA",
              "Liquidity contribution limits must be positive and the non-final withdrawal share limit must be between 1 and 10,000 bps.",
            ));
          }
          context.next = {
            ...context.next,
            pool: {
              ...context.next.pool,
              maximumRflContribution: event.maximumRflContribution,
              maximumTusdContribution: event.maximumTusdContribution,
              maximumNonFinalWithdrawalShareBps: event.maximumNonFinalWithdrawalShareBps,
            },
          };
          break;

        case "PauseStateChanged":
          context.next = { ...context.next, swapsPaused: event.swapsPaused, claimsPaused: event.claimsPaused };
          break;

        case "PoolPauseChanged":
          context.next = {
            ...context.next,
            pool: {
              ...context.next.pool,
              poolPaused: event.poolPaused,
              liquidityPaused: event.liquidityPaused,
              lpClaimsPaused: event.lpClaimsPaused,
              shutdownMode: event.shutdownMode,
            },
          };
          break;

        case "OperationalAdminChanged": {
          const key = event.scope === "reflection-core"
            ? "reflectionCore"
            : event.scope === "test-assets"
              ? "testAssets"
              : "testAmm";
          const previous = context.next.operationalAdmins[key];
          if (
            (previous !== null && previous !== event.oldOperationalAdmin)
            || /^0x0+$/.test(event.newOperationalAdmin)
          ) {
            context.alerts.push(problem(
              event,
              "OPERATIONAL_ADMIN",
              "Operational-admin handoff does not continue the evented authority chain or targets the zero address.",
              previous ?? event.oldOperationalAdmin,
              event.newOperationalAdmin,
            ));
          }
          context.next = {
            ...context.next,
            operationalAdmins: {
              ...context.next.operationalAdmins,
              [key]: event.newOperationalAdmin,
            },
          };
          break;
        }

      }
    }

    for (const pending of pendingCoreFees) {
      if (pending.sharesAtCollection === 0n) {
        context.next = {
          ...context.next,
          unallocatedFees: context.next.unallocatedFees + pending.event.feeAmount,
        };
      } else {
        context.alerts.push(problem(pending.event, "TRANSACTION_GROUP", "Positive-denominator fee has no global-index receipt."));
      }
    }

    for (const route of routes) {
      if (!consumedRoutes.has(route.id)) {
        context.alerts.push(problem(route, "ROUTE_PAIR", "Core custody route lacks an equal downstream LP-index receipt."));
      }
    }

    if (liquidity.length === 1) {
      const receipt = liquidity[0]!;
      const shares = events.filter((candidate) =>
        candidate.type === "LpSharesChanged"
        && candidate.epoch === receipt.epoch
        && candidate.owner === receipt.provider
        && candidate.amount === receipt.lpShares
        && candidate.added === (receipt.type !== "LiquidityRemoved")
      );
      if (shares.length !== 1) {
        context.alerts.push(problem(receipt, shares.length > 1 ? "DOUBLE_COUNTING" : "LP_ACCOUNTING", "Liquidity receipt must pair with exactly one equal LP-share mutation."));
      }
    }

    const walletShares = sumWalletShares(context.next.positions);
    if (walletShares + context.next.custody.shares !== context.next.eligibleSupply) {
      context.alerts.push(problem(
        first,
        "ELIGIBLE_SUPPLY",
        "Global shares do not equal replayed wallet shares plus canonical custody shares.",
        walletShares + context.next.custody.shares,
        context.next.eligibleSupply,
      ));
    }
    let positionCorrection = context.next.custody.correction;
    for (const position of context.next.positions.values()) positionCorrection += position.correction;
    if (positionCorrection !== context.next.aggregateCorrection) {
      context.alerts.push(problem(first, "CORE_ACCOUNTING", "Aggregate correction does not equal wallet plus custody corrections.", positionCorrection, context.next.aggregateCorrection));
    }
    if (context.next.pool.trflReserve !== context.next.custody.shares) {
      context.alerts.push(problem(first, "RESERVE_CUSTODY", "Canonical tRFL reserve must equal custody shares exactly.", context.next.pool.trflReserve, context.next.custody.shares));
    }
    if (context.next.custody.adapterId !== null) {
      const routeEpoch = context.next.custody.activeRouteEpoch === null
        ? undefined
        : context.next.lpEpochs.get(context.next.custody.activeRouteEpoch);
      if (
        routeEpoch === undefined
        || routeEpoch.rewardVault !== context.next.custody.activeLpRewardVault
      ) {
        context.alerts.push(problem(first, "VAULT_BINDING", "Active custody route is not bound to the matching immutable LP epoch vault."));
      }
    }

    const expectedCoreVault = expectedCoreVaultBalance(context.next);
    const coreLiability = coreIndexedLiability(context.next);
    const coreRounding = expectedCoreVault - coreLiability - context.next.unallocatedFees;
    if (coreRounding < 0n) {
      context.alerts.push(problem(first, "VAULT_BACKING", "Core vault buckets exceed independently replayed vault credits less payouts."));
    } else {
      context.next = { ...context.next, roundingReserve: coreRounding };
    }

    for (const epoch of context.next.lpEpochs.values()) {
      const summedShares = sumLpShares(epoch.positions);
      let summedCorrection = 0n;
      let summedClaims = 0n;
      for (const position of epoch.positions.values()) {
        summedCorrection += position.correction;
        summedClaims += position.claimed;
      }
      if (
        summedShares !== epoch.totalShares
        || summedCorrection !== epoch.aggregateCorrection
        || summedClaims !== epoch.lifetimeClaimed
      ) {
        context.alerts.push(problem(first, "LP_ACCOUNTING", `LP epoch ${epoch.epoch.toString()} aggregate state disagrees with its positions.`));
      }
      const rounding = expectedLpVaultBalance(epoch) - lpIndexedLiability(epoch) - epoch.unallocatedRewards;
      if (rounding < 0n || rounding !== epoch.roundingReserve) {
        context.alerts.push(problem(first, "LP_VAULT_BACKING", `LP epoch ${epoch.epoch.toString()} bucket identity is not exact.`, epoch.roundingReserve, rounding));
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown event replay error";
    context.alerts.push(problem(first, "EVENT_DATA", detail));
  }

  for (const event of events) {
    (context.next.seenEventIds as Map<string, string>).set(
      event.id,
      `${event.ledgerVersion.toString()}:${event.eventIndex.toString()}`,
    );
  }
  return { projection: context.next, alerts: context.alerts };
}

/** Compatibility helper. Cross-module completeness is enforced by EventIndexer groups. */
export function reduceEvent(prior: ProtocolProjection, event: ProtocolEvent): ReduceResult {
  return reduceEventGroup(prior, [event]);
}
