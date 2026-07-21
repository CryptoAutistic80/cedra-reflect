import { type Address } from "../../protocol-sdk/src/types.js";
import { CEDRA_TESTNET_CHAIN_ID } from "../../protocol-sdk/src/types.js";
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
import {
  checkedMoveSignedU256Add,
  checkedMoveSignedU256AddUnsigned,
  checkedMoveSignedU256SubtractUnsigned,
  checkedMoveU256Add,
  checkedMoveU256Multiply,
  checkedMoveU256Subtract,
  assertProjectionMoveDomains,
  assertProtocolEventMoveDomains,
} from "./move-domains.js";
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
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

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

function checkedVaultRemainder(
  vaultBalance: bigint,
  liability: bigint,
  unallocated: bigint,
  label: string,
): bigint {
  return checkedMoveU256Subtract(
    checkedMoveU256Subtract(vaultBalance, liability, `${label} indexed liability`),
    unallocated,
    `${label} unallocated amount`,
  );
}

export function createEmptyProjection(): ProtocolProjection {
  return {
    chainId: CEDRA_TESTNET_CHAIN_ID,
    deploymentId: "uninitialized",
    networkLabel: "uninitialized",
    tokenMetadata: null,
    protocolExclusionSlots: 0n,
    protocolExclusionsRemaining: 0n,
    protocolExcludedStores: new Map<Address, Address>(),
    registeredWallets: new Map<Address, Address>(),
    registeredWalletCount: 0n,
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
    mockUsdPoolReserve: null,
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
    deploymentReady: false,
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
    protocolExcludedStores: new Map(prior.protocolExcludedStores),
    registeredWallets: new Map(prior.registeredWallets),
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
  const correctionDelta = checkedMoveU256Multiply(
    delta < 0n ? -delta : delta,
    context.next.currentIndex,
    "wallet correction delta",
  );
  const correction = delta < 0n
    ? checkedMoveSignedU256AddUnsigned(current.correction, correctionDelta, "wallet correction")
    : checkedMoveSignedU256SubtractUnsigned(current.correction, correctionDelta, "wallet correction");
  const aggregateCorrection = delta < 0n
    ? checkedMoveSignedU256AddUnsigned(context.next.aggregateCorrection, correctionDelta, "aggregate wallet correction")
    : checkedMoveSignedU256SubtractUnsigned(context.next.aggregateCorrection, correctionDelta, "aggregate wallet correction");
  positions(context).set(account, {
    ...current,
    rawTrfl: balance + delta,
    correction,
  });
  context.next = {
    ...context.next,
    eligibleSupply: context.next.eligibleSupply + delta,
    aggregateCorrection,
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
  const claimed = checkedMoveU256Add(current.claimed, event.amount, "wallet cumulative materialization");
  if (claimed !== event.totalClaimed) {
    context.alerts.push(problem(event, "POSITION_ACCOUNTING", "Wallet cumulative materialization does not match the event.", claimed, event.totalClaimed));
  }
  positions(context).set(event.account, {
    ...current,
    claimed,
    lifetimeMaterialized: checkedMoveU256Add(current.lifetimeMaterialized, event.amount, "wallet lifetime materialization"),
  });
  context.next = {
    ...context.next,
    rewardVaultPayouts: checkedMoveU256Add(context.next.rewardVaultPayouts, event.amount, "core reward-vault payouts"),
    lifetimeMaterialized: checkedMoveU256Add(context.next.lifetimeMaterialized, event.amount, "core lifetime materialization"),
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

function accountStateSubjects(event: ProtocolEvent): readonly Address[] {
  switch (event.type) {
    case "PositionCreated":
    case "EligibleBalanceDebited":
    case "EligibleBalanceCredited":
    case "RewardsMaterialized":
    case "RewardsClaimed":
    case "SwapExecuted":
      return [event.account];
    case "FaucetGrant":
      return [event.account];
    case "WalletTransfer":
      return [event.from, event.to];
    case "LiquiditySeeded":
    case "LiquidityAdded":
    case "LiquidityRemoved":
      return [event.provider];
    case "LpSharesChanged":
    case "LpRewardsClaimed":
    case "LpFractionalResidueRetired":
      return [event.owner];
    case "LpSharesTransferred":
      return [event.sender, event.recipient];
    default:
      return [];
  }
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
  if (!context.next.registeredWallets.has(event.owner)) {
    context.alerts.push(problem(
      event,
      "WALLET_REGISTRATION",
      "LP share weight may be created or mutated only for a wallet registered earlier in replay order.",
      "earlier WalletRegistered",
      event.owner,
    ));
  }
  const delta = event.added ? event.amount : -event.amount;
  const current = lpPositionOrEmpty(event.owner, epoch.positions);
  if (current.shares + delta < 0n || epoch.totalShares + delta < 0n) {
    context.alerts.push(problem(event, "LP_ACCOUNTING", "LP share mutation would underflow a position or epoch."));
    return;
  }
  const correctionDelta = checkedMoveU256Multiply(event.amount, epoch.index, "LP share correction delta");
  const correction = event.added
    ? checkedMoveSignedU256SubtractUnsigned(current.correction, correctionDelta, "LP owner correction")
    : checkedMoveSignedU256AddUnsigned(current.correction, correctionDelta, "LP owner correction");
  const aggregateCorrection = event.added
    ? checkedMoveSignedU256SubtractUnsigned(epoch.aggregateCorrection, correctionDelta, "LP aggregate correction")
    : checkedMoveSignedU256AddUnsigned(epoch.aggregateCorrection, correctionDelta, "LP aggregate correction");
  const nextPosition = {
    ...current,
    shares: current.shares + delta,
    correction,
  };
  const nextPositions = new Map(epoch.positions);
  nextPositions.set(event.owner, nextPosition);
  const nextEpoch = {
    ...epoch,
    totalShares: epoch.totalShares + delta,
    aggregateCorrection,
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
  try {
    assertProjectionMoveDomains(prior);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid prior projection domain";
    context.alerts.push(problem(first, "EVENT_DATA", detail));
    return { projection: prior, alerts: context.alerts };
  }
  for (const event of events) {
    try {
      assertProtocolEventMoveDomains(event);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid event Move domain";
      context.alerts.push(problem(event, "EVENT_DATA", detail));
    }
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
  if (context.alerts.some((entry) => entry.code === "EVENT_DATA")) {
    return { projection: prior, alerts: context.alerts };
  }

  const swaps = events.filter((event): event is SwapExecutedEvent => event.type === "SwapExecuted");
  const liquidity = events.filter((event) => event.type === "LiquiditySeeded" || event.type === "LiquidityAdded" || event.type === "LiquidityRemoved");
  const custodyChanges = events.filter((event) => event.type === "CustodySharesChanged");
  const routes = events.filter((event) => event.type === "CustodyRewardsRouted");
  const lpAdvances = events.filter((event) => event.type === "LpRewardIndexAdvanced");
  const lpQuarantines = events.filter((event) => event.type === "LpRewardQuarantined");
  const lpResidues = events.filter((event) => event.type === "LpFractionalResidueRetired");
  const lpTerminalClassifications = events.filter((event) => event.type === "LpEpochTerminalDustClassified");
  const lpTerminalTransitions = events.filter((event): event is Extract<ProtocolEvent, { readonly type: "LpEpochStatusChanged" }> => (
    event.type === "LpEpochStatusChanged" && event.newStatus === "claim-only"
  ));
  const lpOpenings = events.filter((event) => event.type === "LpEpochOpened");
  const adapterRegistrations = events.filter((event) => event.type === "CustodyAdapterRegistered");
  const routeOpenings = events.filter((event) => event.type === "CustodyEpochRouteOpened");
  const nativeDebits = events.filter((event) => event.type === "EligibleBalanceDebited");
  const nativeCredits = events.filter((event) => event.type === "EligibleBalanceCredited");
  const walletTransfers = events.filter((event) => event.type === "WalletTransfer");
  const materialized = events.filter((event) => event.type === "RewardsMaterialized");
  const explicitClaims = events.filter((event) => event.type === "RewardsClaimed");

  for (const registration of events.filter((event) => event.type === "WalletRegistered")) {
    const precedingAccountMutation = events.find((candidate) => (
      candidate.id !== registration.id
      && accountStateSubjects(candidate).includes(registration.account)
      && candidate.eventIndex <= registration.eventIndex
    ));
    if (precedingAccountMutation !== undefined) {
      context.alerts.push(problem(
        registration,
        "WALLET_REGISTRATION",
        "WalletRegistered must precede every same-transaction position or account-balance event for that account.",
        `registration before ${precedingAccountMutation.type}`,
        `${precedingAccountMutation.type} at ${precedingAccountMutation.eventIndex}`,
      ));
    }
  }

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
    : liquidity.length === 1 && liquidity[0]!.trflAmount > 0n
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
  for (const transition of lpTerminalTransitions) {
    const matches = lpTerminalClassifications.filter((candidate) => (
      candidate.epoch === transition.epoch && candidate.eventIndex > transition.eventIndex
    ));
    if (matches.length !== 1) {
      context.alerts.push(problem(
        transition,
        "LP_ACCOUNTING",
        "Every active-to-claim-only transition requires exactly one later terminal-dust classification in the same transaction.",
        1,
        matches.length,
      ));
    }
  }
  for (const classification of lpTerminalClassifications) {
    const matches = lpTerminalTransitions.filter((candidate) => (
      candidate.epoch === classification.epoch && candidate.eventIndex < classification.eventIndex
    ));
    if (matches.length !== 1) {
      context.alerts.push(problem(
        classification,
        "LP_ACCOUNTING",
        "Terminal dust classification must follow exactly one matching status transition in its transaction.",
        1,
        matches.length,
      ));
    }
  }
  for (const residue of lpResidues) {
    const burns = events.filter((candidate) => (
      candidate.type === "LpSharesChanged"
      && !candidate.added
      && candidate.epoch === residue.epoch
      && candidate.owner === residue.owner
      && candidate.ownerShares === 0n
      && candidate.eventIndex > residue.eventIndex
    ));
    const transfers = events.filter((candidate) => (
      candidate.type === "LpSharesTransferred"
      && candidate.epoch === residue.epoch
      && candidate.sender === residue.owner
      && candidate.eventIndex > residue.eventIndex
    ));
    if (burns.length + transfers.length !== 1) {
      context.alerts.push(problem(
        residue,
        "LP_ACCOUNTING",
        "Fractional residue retirement must precede exactly one complete owner exit in the same transaction.",
        1,
        burns.length + transfers.length,
      ));
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
        const expectedRfl = ceilDiv(
          checkedMoveU256Multiply(receipt.lpShares, prior.pool.trflReserve, "LP mint tRFL numerator"),
          epoch!.totalShares,
        );
        const expectedUsd = ceilDiv(
          checkedMoveU256Multiply(receipt.lpShares, prior.pool.tusdReserve, "LP mint tUSD numerator"),
          epoch!.totalShares,
        );
        if (receipt.trflAmount !== expectedRfl || receipt.tusdAmount !== expectedUsd) {
          context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Liquidity input amounts do not match the shares' proportional ceil arithmetic.", `${expectedRfl}/${expectedUsd}`, `${receipt.trflAmount}/${receipt.tusdAmount}`));
        }
      }
    } else if (epoch!.totalShares <= 0n || receipt.lpShares > epoch!.totalShares) {
      context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Liquidity removal exceeds replayed epoch shares."));
    } else {
      const fullExit = receipt.lpShares === epoch!.totalShares;
      const expectedRfl = receipt.lpShares === epoch!.totalShares
        ? prior.pool.trflReserve
        : checkedMoveU256Multiply(receipt.lpShares, prior.pool.trflReserve, "LP withdrawal tRFL numerator") / epoch!.totalShares;
      const expectedUsd = receipt.lpShares === epoch!.totalShares
        ? prior.pool.tusdReserve
        : checkedMoveU256Multiply(receipt.lpShares, prior.pool.tusdReserve, "LP withdrawal tUSD numerator") / epoch!.totalShares;
      if (
        receipt.trflAmount !== expectedRfl
        || receipt.tusdAmount !== expectedUsd
        || receipt.finalExit !== fullExit
      ) {
        context.alerts.push(problem(receipt, "LP_ACCOUNTING", "Liquidity withdrawal does not match proportional floor/final-exit arithmetic.", `${expectedRfl}/${expectedUsd}/${fullExit}`, `${receipt.trflAmount}/${receipt.tusdAmount}/${receipt.finalExit}`));
      }
      if (
        !fullExit
        && !prior.pool.shutdownMode
        && checkedMoveU256Multiply(receipt.lpShares, BPS_DENOMINATOR, "LP withdrawal limit request")
          > checkedMoveU256Multiply(epoch!.totalShares, prior.pool.maximumNonFinalWithdrawalShareBps, "LP withdrawal limit allowance")
      ) {
        context.alerts.push(problem(
          receipt,
          "POOL_LIMITS",
          "Normal-mode non-final withdrawal exceeds the configured proportional share limit.",
          checkedMoveU256Multiply(epoch!.totalShares, prior.pool.maximumNonFinalWithdrawalShareBps, "LP withdrawal limit allowance"),
          checkedMoveU256Multiply(receipt.lpShares, BPS_DENOMINATOR, "LP withdrawal limit request"),
        ));
      }

      const epochTransitions = lpTerminalTransitions.filter((event) => event.epoch === receipt.epoch);
      const epochClassifications = lpTerminalClassifications.filter((event) => event.epoch === receipt.epoch);
      if (fullExit) {
        const shareExits = events.filter((event) => (
          event.type === "LpSharesChanged"
          && !event.added
          && event.epoch === receipt.epoch
          && event.owner === receipt.provider
          && event.amount === receipt.lpShares
          && event.ownerShares === 0n
          && event.totalShares === 0n
          && event.eventIndex < receipt.eventIndex
        ));
        const transition = epochTransitions.length === 1 ? epochTransitions[0] : undefined;
        const classification = epochClassifications.length === 1 ? epochClassifications[0] : undefined;
        if (
          !prior.pool.shutdownMode
          || !receipt.finalExit
          || shareExits.length !== 1
          || transition === undefined
          || transition.oldStatus !== "active"
          || classification === undefined
          || !(shareExits[0]!.eventIndex < transition.eventIndex
            && transition.eventIndex < classification.eventIndex
            && classification.eventIndex < receipt.eventIndex)
        ) {
          context.alerts.push(problem(
            receipt,
            "LP_ACCOUNTING",
            "Final liquidity removal requires prior shutdown and one ordered same-transaction share exit, active-to-claim-only transition, terminal classification, then receipt.",
          ));
        }
      } else if (epochTransitions.length > 0 || epochClassifications.length > 0) {
        context.alerts.push(problem(
          receipt,
          "LP_ACCOUNTING",
          "A non-final liquidity removal cannot terminate or classify its active LP epoch.",
        ));
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
          if (
            event.deploymentId.length === 0
            || event.networkLabel !== "cedra-testnet"
            || event.protocolExclusionSlots !== 2n
          ) {
            context.alerts.push(problem(event, "EVENT_DATA", "Protocol initialization identity or exclusion-slot policy is invalid."));
          }
          context.next = {
            ...context.next,
            deploymentId: event.deploymentId,
            networkLabel: event.networkLabel,
            tokenMetadata: event.tokenMetadata,
            protocolExclusionSlots: event.protocolExclusionSlots,
            protocolExclusionsRemaining: event.protocolExclusionSlots,
            automaticMaterialization: event.automaticMaterialization,
            feeBps: event.feeBps,
            currentIndex: event.initialIndex,
            packageVersion: event.packageVersion,
            rewardVault: event.rewardVault,
            distributionVault: event.distributionVault,
          };
          break;

        case "TokenCreated":
          if (context.next.packageVersion !== "uninitialized") {
            context.alerts.push(problem(event, "IDENTIFIER_REUSE", "Token creation appeared more than once."));
          }
          if (
            event.eventSchema !== "v0.2"
            || event.packageVersion !== "testnet-v0.2.0"
            || event.networkLabel !== "cedra-testnet"
            || event.reflectionFeeBps > 500n
            || event.totalSupply !== 1_000_000_000_000_000n
            || event.decimals !== 6n
          ) {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 TokenCreated identity or immutable creation parameters are invalid."));
          }
          context.next = {
            ...context.next,
            deploymentId: event.deploymentId,
            networkLabel: event.networkLabel,
            tokenMetadata: event.tokenMetadata,
            protocolExclusionSlots: 0n,
            protocolExclusionsRemaining: 0n,
            automaticMaterialization: true,
            feeBps: event.reflectionFeeBps,
            packageVersion: event.packageVersion,
            lifecycle: "CONFIGURING",
            rewardVault: event.rewardVault,
            distributionVault: event.distributionVault,
          };
          break;

        case "LaunchSealed":
          if (
            context.next.packageVersion !== "testnet-v0.2.0"
            || context.next.lifecycle !== "CONFIGURING"
            || event.reflectionFeeBps !== context.next.feeBps
            || event.reflectionFeeBps > 500n
            || event.ammFeeBps !== 30n
            || event.maximumReserveBps !== 2_000n
            || event.maximumGrossSwap !== 100_000_000_000n
            || event.maximumRflContribution !== 100_000_000_000n
            || event.maximumTusdContribution !== 100_000_000_000n
            || event.maximumNonFinalWithdrawalShareBps !== 10_000n
            || event.faucetTrflGrant !== 1_000_000_000n
            || event.faucetTusdGrant !== 1_000_000_000n
            || event.faucetCooldownSeconds !== 3_600n
            || event.seedRfl !== 500_000_000n
            || event.seedUsd !== 500_000_000n
            || event.initialLpShares <= 0n
          ) {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 LaunchSealed disagrees with the fixed launch envelope."));
          }
          context.next = {
            ...context.next,
            lifecycle: "LIVE",
            deploymentReady: true,
            faucetTrflGrant: event.faucetTrflGrant,
            faucetTusdGrant: event.faucetTusdGrant,
            faucetCooldownSeconds: event.faucetCooldownSeconds,
            pool: {
              ...context.next.pool,
              ammFeeBps: event.ammFeeBps,
              maximumReserveBps: event.maximumReserveBps,
              maximumGrossSwap: event.maximumGrossSwap,
              maximumRflContribution: event.maximumRflContribution,
              maximumTusdContribution: event.maximumTusdContribution,
              maximumNonFinalWithdrawalShareBps: event.maximumNonFinalWithdrawalShareBps,
            },
          };
          break;

        case "PoolClosed":
          if (
            context.next.packageVersion !== "testnet-v0.2.0"
            || context.next.lifecycle !== "LIVE"
            || event.epoch !== 1n
            || event.rflReserveAfter !== context.next.pool.trflReserve
            || event.usdReserveAfter !== context.next.pool.tusdReserve
          ) {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 PoolClosed is out of lifecycle order or disagrees with replayed terminal reserves."));
          }
          context.next = { ...context.next, lifecycle: "CLOSED" };
          break;

        case "ProtocolPrimaryStoreExcluded": {
          const stores = new Map(context.next.protocolExcludedStores);
          if (
            /^0x0+$/.test(event.account)
            || /^0x0+$/.test(event.store)
            || context.next.protocolExclusionsRemaining <= 0n
            || event.remainingSlots !== context.next.protocolExclusionsRemaining - 1n
            || stores.has(event.account)
            || [...stores.values()].includes(event.store)
            || context.next.registeredWallets.has(event.account)
            || [...context.next.registeredWallets.values()].includes(event.store)
          ) {
            context.alerts.push(problem(event, "IDENTIFIER_REUSE", "Protocol publisher exclusion is zero, registered, duplicated, or exceeds the finite bootstrap slots."));
          }
          stores.set(event.account, event.store);
          context.next = {
            ...context.next,
            protocolExclusionsRemaining: event.remainingSlots,
            protocolExcludedStores: stores,
          };
          break;
        }

        case "OperationalPrimaryStoreExcluded": {
          const stores = new Map(context.next.protocolExcludedStores);
          if (
            /^0x0+$/.test(event.account)
            || /^0x0+$/.test(event.store)
            || stores.has(event.account)
            || [...stores.values()].includes(event.store)
            || context.next.registeredWallets.has(event.account)
            || [...context.next.registeredWallets.values()].includes(event.store)
          ) {
            context.alerts.push(problem(
              event,
              "IDENTIFIER_REUSE",
              "Operational primary-store exclusion is zero, duplicated, or reuses an already classified store.",
            ));
          }
          stores.set(event.account, event.store);
          context.next = {
            ...context.next,
            // Operational appointments are outside the two finite publisher
            // bootstrap slots and therefore cannot change the remaining count.
            protocolExcludedStores: stores,
          };
          break;
        }

        case "WalletRegistered": {
          const wallets = new Map(context.next.registeredWallets);
          const expectedCount = context.next.registeredWalletCount + 1n;
          if (
            /^0x0+$/.test(event.account)
            || /^0x0+$/.test(event.primaryStore)
            || event.registeredWalletCount <= 0n
            || event.registeredWalletCount > U64_MAX
            || event.registeredWalletCount !== expectedCount
            || wallets.has(event.account)
            || [...wallets.values()].includes(event.primaryStore)
            || context.next.protocolExcludedStores.has(event.account)
            || [...context.next.protocolExcludedStores.values()].includes(event.primaryStore)
          ) {
            context.alerts.push(problem(
              event,
              "WALLET_REGISTRATION",
              "Wallet registration must bind one fresh non-excluded account/store and advance the exact u64 count once.",
              expectedCount,
              event.registeredWalletCount,
            ));
          }
          wallets.set(event.account, event.primaryStore);
          context.next = {
            ...context.next,
            registeredWallets: wallets,
            registeredWalletCount: event.registeredWalletCount,
          };
          break;
        }

        case "PositionCreated":
          if (context.next.positions.has(event.account)) {
            context.alerts.push(problem(event, "IDENTIFIER_REUSE", "Wallet accounting position was created more than once."));
          }
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

        case "PoolReserveBound":
          if (
            context.next.mockUsdPoolReserve !== null
            || event.reserveStore === "0x0"
            || event.custodian === "0x0"
          ) {
            context.alerts.push(problem(event, "IDENTIFIER_REUSE", "The one-shot tUSD pool reserve binding is invalid or repeated."));
          }
          context.next = { ...context.next, mockUsdPoolReserve: event.reserveStore };
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
            lifetimeClaimed: checkedMoveU256Add(current.lifetimeClaimed, event.amount, "wallet lifetime claimed"),
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
          if (context.next.custody.correction < 0n) {
            throw new RangeError("custody route correction cannot be negative during residue normalization");
          }
          const normalizedCustodyClaim = checkedMoveU256Multiply(
            context.next.custody.claimed,
            REFLECTION_MAGNITUDE,
            "custody normalized claim",
          );
          const expectedResidue = checkedMoveU256Subtract(
            context.next.custody.correction,
            normalizedCustodyClaim,
            "custody route residue",
          );
          if (
            expectedResidue < 0n
            || expectedResidue >= REFLECTION_MAGNITUDE
            || event.retiredResidueMagnified !== expectedResidue
          ) {
            context.alerts.push(problem(
              event,
              "CUSTODY_ACCOUNTING",
              "Custody route did not retire exactly the prior epoch's fractional magnified residue.",
              expectedResidue,
              event.retiredResidueMagnified,
            ));
          }
          context.next = {
            ...context.next,
            aggregateCorrection: checkedMoveSignedU256SubtractUnsigned(
              context.next.aggregateCorrection,
              event.retiredResidueMagnified,
              "aggregate custody residue correction",
            ),
            custody: {
              ...context.next.custody,
              activeRouteEpoch: event.epoch,
              activeLpRewardVault: event.lpRewardVault,
              correction: checkedMoveSignedU256SubtractUnsigned(
                context.next.custody.correction,
                event.retiredResidueMagnified,
                "custody residue correction",
              ),
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
          const maximumFeeBps = context.next.packageVersion === "testnet-v0.2.0" ? 500n : 100n;
          if (
            event.feeBps > maximumFeeBps
            || event.feeBps !== context.next.feeBps
            || event.feeAmount !== expectedFee
            || event.swapTxHash !== event.txHash
          ) {
            context.alerts.push(problem(event, "FEE_FORMULA", "Reflection fee receipt does not match configured floor arithmetic and transaction identity."));
          }
          context.next = {
            ...context.next,
            rewardVaultCredits: checkedMoveU256Add(context.next.rewardVaultCredits, event.feeAmount, "core reward-vault credits"),
            lifetimeSwapFees: checkedMoveU256Add(context.next.lifetimeSwapFees, event.feeAmount, "core lifetime fees"),
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
          const numerator = checkedMoveU256Add(
            checkedMoveU256Multiply(pending.event.feeAmount, REFLECTION_MAGNITUDE, "core index fee numerator"),
            context.next.indexRemainder,
            "core index numerator with remainder",
          );
          const expectedIndex = checkedMoveU256Add(
            context.next.currentIndex,
            numerator / pending.sharesAtCollection,
            "core reflection index",
          );
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
          const correctionDelta = checkedMoveU256Multiply(event.amount, context.next.currentIndex, "custody correction delta");
          const correction = event.added
            ? checkedMoveSignedU256SubtractUnsigned(context.next.custody.correction, correctionDelta, "custody correction")
            : checkedMoveSignedU256AddUnsigned(context.next.custody.correction, correctionDelta, "custody correction");
          const aggregateCorrection = event.added
            ? checkedMoveSignedU256SubtractUnsigned(context.next.aggregateCorrection, correctionDelta, "aggregate custody correction")
            : checkedMoveSignedU256AddUnsigned(context.next.aggregateCorrection, correctionDelta, "aggregate custody correction");
          const custody = {
            ...context.next.custody,
            shares: context.next.custody.shares + delta,
            correction,
          };
          context.next = {
            ...context.next,
            custody,
            eligibleSupply: context.next.eligibleSupply + delta,
            aggregateCorrection,
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
          const claimed = checkedMoveU256Add(context.next.custody.claimed, event.amount, "custody cumulative routed");
          if (claimed !== event.totalRouted) {
            context.alerts.push(problem(event, "CUSTODY_ACCOUNTING", "Custody cumulative routed amount disagrees with replay.", claimed, event.totalRouted));
          }
          context.next = {
            ...context.next,
            custody: {
              ...context.next.custody,
              reserveStore: context.next.custody.reserveStore ?? event.reserveStore,
              claimed,
              lifetimeRouted: checkedMoveU256Add(context.next.custody.lifetimeRouted, event.amount, "custody lifetime routed"),
            },
            lifetimeCustodyRouted: checkedMoveU256Add(context.next.lifetimeCustodyRouted, event.amount, "core lifetime custody routed"),
            rewardVaultPayouts: checkedMoveU256Add(context.next.rewardVaultPayouts, event.amount, "core reward-vault payouts"),
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
            retiredResidueMagnified: 0n,
            terminalRoundingBaseUnits: null,
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

        case "LpFractionalResidueRetired": {
          const epoch = requireEpoch(context, event, event.epoch);
          if (epoch === null) break;
          const current = epoch.positions.get(event.owner);
          const exit = events.find((candidate) => (
            (
              candidate.type === "LpSharesChanged"
              && !candidate.added
              && candidate.epoch === event.epoch
              && candidate.owner === event.owner
              && candidate.ownerShares === 0n
            )
            || (
              candidate.type === "LpSharesTransferred"
              && candidate.epoch === event.epoch
              && candidate.sender === event.owner
            )
          ) && candidate.eventIndex > event.eventIndex);
          const exitAmount = exit?.type === "LpSharesChanged" || exit?.type === "LpSharesTransferred"
            ? exit.amount
            : 0n;
          if (
            event.epoch <= 0n
            || event.epoch > U64_MAX
            || event.residueMagnified <= 0n
            || event.residueMagnified > U256_MAX
            || event.cumulativeRetiredResidueMagnified > U256_MAX
            || event.roundingReserveBaseUnits > U128_MAX
            || current === undefined
            || current.shares <= 0n
            || exitAmount !== current.shares
          ) {
            context.alerts.push(problem(
              event,
              "LP_ACCOUNTING",
              "Fractional residue must use exact u64/u128/u256 units and precede a complete non-zero position exit.",
            ));
            break;
          }
          const correctionAfterExit = checkedMoveSignedU256AddUnsigned(
            current.correction,
            checkedMoveU256Multiply(current.shares, epoch.index, "LP exit correction delta"),
            "LP zero-share correction",
          );
          if (correctionAfterExit < 0n) {
            throw new RangeError("LP zero-share correction cannot remain negative");
          }
          const expectedResidue = checkedMoveU256Subtract(
            correctionAfterExit,
            checkedMoveU256Multiply(current.claimed, REFLECTION_MAGNITUDE, "LP normalized claim"),
            "LP fractional residue",
          );
          const expectedCumulative = checkedMoveU256Add(
            epoch.retiredResidueMagnified,
            expectedResidue,
            "LP cumulative retired residue",
          );
          if (
            expectedResidue <= 0n
            || expectedResidue >= REFLECTION_MAGNITUDE
            || expectedCumulative > U256_MAX
            || event.residueMagnified !== expectedResidue
            || event.cumulativeRetiredResidueMagnified !== expectedCumulative
          ) {
            context.alerts.push(problem(
              event,
              "LP_ACCOUNTING",
              "Fractional residue receipt disagrees with the zero-share correction normalization.",
              `${expectedResidue}/${expectedCumulative}`,
              `${event.residueMagnified}/${event.cumulativeRetiredResidueMagnified}`,
            ));
            break;
          }
          const nextPositions = new Map(epoch.positions);
          nextPositions.set(event.owner, {
            ...current,
            correction: checkedMoveSignedU256SubtractUnsigned(current.correction, expectedResidue, "LP retired owner residue correction"),
          });
          const withoutRounding: IndexedLpEpoch = {
            ...epoch,
            aggregateCorrection: checkedMoveSignedU256SubtractUnsigned(epoch.aggregateCorrection, expectedResidue, "LP retired aggregate residue correction"),
            retiredResidueMagnified: expectedCumulative,
            positions: nextPositions,
          };
          const expectedRounding = checkedVaultRemainder(
            expectedLpVaultBalance(withoutRounding),
            lpIndexedLiability(withoutRounding),
            withoutRounding.unallocatedRewards,
            "LP residue rounding reserve",
          );
          if (
            expectedRounding < 0n
            || expectedRounding > U128_MAX
            || event.roundingReserveBaseUnits !== expectedRounding
          ) {
            context.alerts.push(problem(
              event,
              "LP_VAULT_BACKING",
              "Fractional residue retirement reports the wrong physical rounding reserve.",
              expectedRounding,
              event.roundingReserveBaseUnits,
            ));
          }
          updateEpoch(context, { ...withoutRounding, roundingReserve: expectedRounding });
          break;
        }

        case "LpEpochTerminalDustClassified": {
          const epoch = requireEpoch(context, event, event.epoch);
          if (epoch === null) break;
          const expectedVaultBalance = expectedLpVaultBalance(epoch);
          const calculatedLiability = lpIndexedLiability(epoch);
          if (
            event.epoch <= 0n
            || event.epoch > U64_MAX
            || event.terminalRoundingBaseUnits > U128_MAX
            || event.retiredResidueMagnified > U256_MAX
            || event.lifetimeReceivedBaseUnits > U256_MAX
            || event.lifetimeClaimedBaseUnits > U256_MAX
            || epoch.status !== "claim-only"
            || epoch.terminalRoundingBaseUnits !== null
            || epoch.rewardVault !== event.rewardVault
            || epoch.totalShares !== 0n
            || epoch.quarantined
            || epoch.unallocatedRewards !== 0n
            || calculatedLiability !== 0n
            || expectedVaultBalance !== epoch.roundingReserve
            || event.terminalRoundingBaseUnits !== epoch.roundingReserve
            || event.retiredResidueMagnified !== epoch.retiredResidueMagnified
            || event.lifetimeReceivedBaseUnits !== epoch.lifetimeReceived
            || event.lifetimeClaimedBaseUnits !== epoch.lifetimeClaimed
          ) {
            context.alerts.push(problem(
              event,
              "LP_ACCOUNTING",
              "Terminal dust classification must exactly match the healthy zero-share claim-only epoch and its immutable vault/lifetime evidence.",
            ));
          }
          updateEpoch(context, {
            ...epoch,
            terminalRoundingBaseUnits: epoch.roundingReserve,
          });
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
          if (
            !context.next.registeredWallets.has(event.sender)
            || !context.next.registeredWallets.has(event.recipient)
          ) {
            context.alerts.push(problem(
              event,
              "WALLET_REGISTRATION",
              "LP sender and recipient must both have WalletRegistered evidence earlier in replay order.",
              "registered sender and recipient",
              `${event.sender}/${event.recipient}`,
            ));
          }
          const sender = lpPositionOrEmpty(event.sender, epoch.positions);
          const recipient = lpPositionOrEmpty(event.recipient, epoch.positions);
          if (sender.shares < event.amount || event.sender === event.recipient) {
            context.alerts.push(problem(event, "LP_ACCOUNTING", "LP transfer would underflow or transfer to self."));
            break;
          }
          const delta = checkedMoveU256Multiply(event.amount, epoch.index, "LP transfer correction delta");
          const nextPositions = new Map(epoch.positions);
          nextPositions.set(event.sender, {
            ...sender,
            shares: sender.shares - event.amount,
            correction: checkedMoveSignedU256AddUnsigned(sender.correction, delta, "LP transfer sender correction"),
          });
          nextPositions.set(event.recipient, {
            ...recipient,
            shares: recipient.shares + event.amount,
            correction: checkedMoveSignedU256SubtractUnsigned(recipient.correction, delta, "LP transfer recipient correction"),
          });
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
          const numerator = checkedMoveU256Add(
            checkedMoveU256Multiply(event.received, REFLECTION_MAGNITUDE, "LP reward index numerator"),
            epoch.indexRemainder,
            "LP reward index numerator with remainder",
          );
          const expectedIndex = checkedMoveU256Add(
            epoch.index,
            numerator / epoch.totalShares,
            "LP reward index",
          );
          const expectedRemainder = numerator % epoch.totalShares;
          let nextEpoch: IndexedLpEpoch = {
            ...epoch,
            index: event.newIndex,
            indexRemainder: event.indexRemainder,
            lifetimeReceived: checkedMoveU256Add(epoch.lifetimeReceived, event.received, "LP lifetime received"),
          };
          const calculatedRounding = checkedVaultRemainder(
            expectedLpVaultBalance(nextEpoch),
            lpIndexedLiability(nextEpoch),
            nextEpoch.unallocatedRewards,
            "LP index rounding reserve",
          );
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
            lifetimeReceived: checkedMoveU256Add(epoch.lifetimeReceived, event.amount, "quarantined LP lifetime received"),
            unallocatedRewards,
            quarantined: true,
          };
          updateEpoch(context, {
            ...nextEpoch,
            roundingReserve: checkedVaultRemainder(
              expectedLpVaultBalance(nextEpoch),
              lpIndexedLiability(nextEpoch),
              unallocatedRewards,
              "quarantined LP rounding reserve",
            ),
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
          const claimed = checkedMoveU256Add(current.claimed, event.amount, "LP position cumulative claim");
          if (claimed !== event.totalClaimed) {
            context.alerts.push(problem(event, "POSITION_ACCOUNTING", "LP position cumulative claim disagrees with replay.", claimed, event.totalClaimed));
          }
          const nextPositions = new Map(epoch.positions);
          nextPositions.set(event.owner, { ...current, claimed });
          const nextEpoch = {
            ...epoch,
            positions: nextPositions,
            lifetimeClaimed: checkedMoveU256Add(epoch.lifetimeClaimed, event.amount, "LP lifetime claimed"),
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
          if (
            context.next.packageVersion === "testnet-v0.2.0"
            && event.type === "LiquiditySeeded"
            && (event.epoch !== 1n || context.next.lifecycle !== "LIVE" || context.next.pool.seeded)
          ) {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 permits only the launch transaction's first and only liquidity seed."));
          }
          const oneSidedRemoval = event.type === "LiquidityRemoved"
            && ((event.trflAmount === 0n) !== (event.tusdAmount === 0n));
          const invalidAmounts = event.lpShares <= 0n
            || event.trflAmount < 0n
            || event.tusdAmount < 0n
            || (event.trflAmount === 0n && event.tusdAmount === 0n)
            || (event.type !== "LiquidityRemoved" && (event.trflAmount === 0n || event.tusdAmount === 0n))
            || (oneSidedRemoval && !prior.pool.shutdownMode);
          if (invalidAmounts) {
            context.alerts.push(problem(
              event,
              "EVENT_DATA",
              "Liquidity shares must be positive; both assets are required except a one-sided, non-empty shutdown removal.",
            ));
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
            if (event.trflAmount > 0n) {
              adjustWalletAsset(context, event.provider, "tRFL", event.trflAmount, event);
            }
            if (event.tusdAmount > 0n) {
              adjustWalletAsset(context, event.provider, "tUSD", event.tusdAmount, event);
            }
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
              shutdownMode: event.type === "LiquidityRemoved" && event.finalExit
                ? false
                : context.next.pool.shutdownMode,
            },
          };
          break;
        }

        case "FeeConfigurationChanged":
          if (context.next.packageVersion === "testnet-v0.2.0") {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 does not permit fee changes after creation."));
          } else if (event.oldFeeBps !== context.next.feeBps || event.newFeeBps > 100n) {
            context.alerts.push(problem(event, "EVENT_DATA", "Fee configuration does not continue replayed state or exceeds 100 bps."));
          }
          context.next = { ...context.next, feeBps: event.newFeeBps };
          break;

        case "FaucetPauseChanged":
          if (context.next.packageVersion === "testnet-v0.2.0") {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 has no faucet pause authority."));
          }
          context.next = { ...context.next, faucetPaused: event.paused };
          break;

        case "SwapLimitsChanged":
          if (context.next.packageVersion === "testnet-v0.2.0") {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 swap limits are immutable and have no configuration event."));
          }
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
          if (context.next.packageVersion === "testnet-v0.2.0") {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 liquidity limits are immutable and have no configuration event."));
          }
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
          if (context.next.packageVersion === "testnet-v0.2.0") {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 has no core pause authority."));
          }
          context.next = { ...context.next, swapsPaused: event.swapsPaused, claimsPaused: event.claimsPaused };
          break;

        case "PoolPauseChanged":
          if (context.next.packageVersion === "testnet-v0.2.0") {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 has no pool pause or shutdown authority."));
          }
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
          if (context.next.packageVersion === "testnet-v0.2.0") {
            context.alerts.push(problem(event, "EVENT_DATA", "v0.2 has no operational administrator or authority handoff."));
          }
          const key = event.scope === "reflection-core"
            ? "reflectionCore"
            : event.scope === "test-assets"
              ? "testAssets"
              : event.scope === "test-amm"
                ? "testAmm"
                : null;
          // ProtocolEvent is a TypeScript union, but snapshots, adapters, and
          // external callers still cross a runtime trust boundary. Never map
          // an unknown authority scope onto the AMM role by default.
          if (key === null) {
            context.alerts.push(problem(
              event,
              "OPERATIONAL_ADMIN",
              "Operational-admin event has an unsupported authority scope.",
              "reflection-core|test-assets|test-amm",
              String(event.scope),
            ));
            break;
          }
          const previous = context.next.operationalAdmins[key];
          const initializing = previous === null && /^0x0+$/.test(event.oldOperationalAdmin);
          const continuesAuthorityChain = previous === null
            ? initializing
            : previous === event.oldOperationalAdmin;
          const hasPermanentExclusion = context.next.protocolExcludedStores.has(event.newOperationalAdmin);
          const alignedToCore = event.scope === "reflection-core"
            || event.newOperationalAdmin === context.next.operationalAdmins.reflectionCore;
          if (
            !continuesAuthorityChain
            || /^0x0+$/.test(event.newOperationalAdmin)
            || (!initializing && (!hasPermanentExclusion || !alignedToCore))
          ) {
            context.alerts.push(problem(
              event,
              "OPERATIONAL_ADMIN",
              "Operational-admin handoff breaks authority continuity, lacks permanent primary-store exclusion, is not aligned to core, or targets zero.",
              previous ?? context.next.operationalAdmins.reflectionCore ?? event.oldOperationalAdmin,
              event.newOperationalAdmin,
            ));
          }
          const operationalAdmins = {
            ...context.next.operationalAdmins,
            [key]: event.newOperationalAdmin,
          };
          context.next = {
            ...context.next,
            operationalAdmins,
            deploymentReady: operationalAdmins.reflectionCore !== null
              && operationalAdmins.testAssets !== null
              && operationalAdmins.testAmm !== null,
          };
          break;
        }

        default: {
          // ProtocolEvent is a compile-time discriminated union, but event
          // sources are a runtime trust boundary. An unknown discriminant must
          // never be treated as an ignorable project event because doing so
          // would advance the durable cursor past unaudited state.
          const unknownEvent = event as ProtocolEvent & { readonly type: unknown };
          context.alerts.push(problem(
            unknownEvent,
            "EVENT_DATA",
            "Event has an unsupported runtime type and cannot be checkpointed.",
            "known ProtocolEvent type",
            String(unknownEvent.type),
          ));
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

    if (
      context.next.registeredWalletCount !== BigInt(context.next.registeredWallets.size)
      || context.next.registeredWalletCount < 0n
      || context.next.registeredWalletCount > U64_MAX
      || new Set(context.next.registeredWallets.values()).size !== context.next.registeredWallets.size
      || [...context.next.registeredWallets].some(([account, store]) => (
        /^0x0+$/.test(account)
        || /^0x0+$/.test(store)
        || context.next.protocolExcludedStores.has(account)
        || [...context.next.protocolExcludedStores.values()].includes(store)
      ))
    ) {
      context.alerts.push(problem(
        first,
        "WALLET_REGISTRATION",
        "Registered-wallet count and unique primary-store bindings must exactly match replayed registration events.",
        context.next.registeredWallets.size,
        context.next.registeredWalletCount,
      ));
    }
    for (const account of context.next.positions.keys()) {
      if (!context.next.registeredWallets.has(account)) {
        context.alerts.push(problem(
          first,
          "WALLET_REGISTRATION",
          "Every wallet accounting position must have an exact prior or same-transaction registration event.",
          "registered wallet",
          account,
        ));
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
    for (const position of context.next.positions.values()) {
      positionCorrection = checkedMoveSignedU256Add(
        positionCorrection,
        position.correction,
        "summed core position correction",
      );
    }
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
    const coreRounding = checkedVaultRemainder(
      expectedCoreVault,
      coreLiability,
      context.next.unallocatedFees,
      "core rounding reserve",
    );
    context.next = { ...context.next, roundingReserve: coreRounding };

    for (const epoch of context.next.lpEpochs.values()) {
      const summedShares = sumLpShares(epoch.positions);
      let summedCorrection = 0n;
      let summedClaims = 0n;
      for (const position of epoch.positions.values()) {
        if (position.shares > 0n && !context.next.registeredWallets.has(position.owner)) {
          context.alerts.push(problem(
            first,
            "WALLET_REGISTRATION",
            `Every positive LP position in epoch ${epoch.epoch.toString()} must belong to a previously registered wallet.`,
            "registered wallet",
            position.owner,
          ));
        }
        summedCorrection = checkedMoveSignedU256Add(
          summedCorrection,
          position.correction,
          `summed LP epoch ${epoch.epoch.toString()} correction`,
        );
        summedClaims = checkedMoveU256Add(
          summedClaims,
          position.claimed,
          `summed LP epoch ${epoch.epoch.toString()} claims`,
        );
      }
      if (
        summedShares !== epoch.totalShares
        || summedCorrection !== epoch.aggregateCorrection
        || summedClaims !== epoch.lifetimeClaimed
      ) {
        context.alerts.push(problem(first, "LP_ACCOUNTING", `LP epoch ${epoch.epoch.toString()} aggregate state disagrees with its positions.`));
      }
      if (
        epoch.retiredResidueMagnified < 0n
        || epoch.retiredResidueMagnified > U256_MAX
        || (epoch.status === "active" && epoch.terminalRoundingBaseUnits !== null)
        || (epoch.status === "claim-only" && epoch.terminalRoundingBaseUnits === null)
        || (
          epoch.terminalRoundingBaseUnits !== null
          && (
            epoch.terminalRoundingBaseUnits < 0n
            || epoch.terminalRoundingBaseUnits > U128_MAX
            || epoch.terminalRoundingBaseUnits !== epoch.roundingReserve
          )
        )
      ) {
        context.alerts.push(problem(
          first,
          "LP_ACCOUNTING",
          `LP epoch ${epoch.epoch.toString()} residue units or terminal classification state is invalid.`,
        ));
      }
      const rounding = checkedVaultRemainder(
        expectedLpVaultBalance(epoch),
        lpIndexedLiability(epoch),
        epoch.unallocatedRewards,
        `LP epoch ${epoch.epoch.toString()} rounding reserve`,
      );
      if (rounding !== epoch.roundingReserve) {
        context.alerts.push(problem(first, "LP_VAULT_BACKING", `LP epoch ${epoch.epoch.toString()} bucket identity is not exact.`, epoch.roundingReserve, rounding));
      }
    }
    // Arithmetic is performed with unbounded JavaScript bigint. Refuse any
    // transaction whose resulting state could not exist in the Move structs.
    assertProjectionMoveDomains(context.next);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown event replay error";
    context.alerts.push(problem(first, "EVENT_DATA", detail));
    context.next = cloneProjection(prior);
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
