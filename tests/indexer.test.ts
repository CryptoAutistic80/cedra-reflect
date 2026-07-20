import type { Address } from "../packages/protocol-sdk/src/types.js";
import {
  CedraEventNormalizer,
  coreIndexedLiability,
  createEmptyProjection,
  custodyPending,
  decodeSnapshot,
  encodeSnapshot,
  EventIndexer,
  expectedCoreVaultBalance,
  expectedLpVaultBalance,
  InMemoryIndexerStore,
  lpIndexedLiability,
  lpPositionPending,
  REFLECTION_MAGNITUDE,
  reduceEventGroup,
  type EventBase,
  type IndexedLpEpoch,
  type ObservedAccountingSnapshot,
  type ProtocolEvent,
  type ProtocolProjection,
} from "../packages/indexer/src/index.js";
import {
  CORE_REWARD_VAULT,
  CUSTODY_RESERVE,
  DISTRIBUTION_VAULT,
  LP_REWARD_VAULT,
  TEST_ACCOUNT,
  TEST_BOB,
  baseEvent,
} from "./fixtures.js";
import { equal, ok, test } from "./harness.js";

const SECOND_LP_VAULT = "0xlpvault2" as Address;
const LP_STATE_1 = "0xlpstate1" as Address;
const LP_STATE_2 = "0xlpstate2" as Address;

function at(txHash: string, ledgerVersion: bigint, eventIndex: number, id?: string): EventBase {
  return baseEvent({
    id: id ?? `${txHash}:${eventIndex.toString()}`,
    txHash,
    ledgerVersion,
    eventIndex,
    timestampUnixMilliseconds: 1_700_000_000_000n + ledgerVersion,
  });
}

function bootstrapEvents(): readonly ProtocolEvent[] {
  return [
    {
      ...at("0xinit", 1n, 0, "init"),
      type: "ProtocolInitialized",
      automaticMaterialization: false,
      feeBps: 100n,
      initialIndex: 0n,
      packageVersion: "testnet-v1",
      rewardVault: CORE_REWARD_VAULT,
      distributionVault: DISTRIBUTION_VAULT,
    },
    { ...at("0xamm-init", 2n, 0, "adapter-1"), type: "CustodyAdapterRegistered", adapterId: 1n, reserveStore: CUSTODY_RESERVE, firstEpoch: 1n, lpRewardVault: LP_REWARD_VAULT },
    { ...at("0xamm-init", 2n, 1, "epoch-1"), type: "LpEpochOpened", epoch: 1n, stateId: LP_STATE_1, rewardVault: LP_REWARD_VAULT },
    { ...at("0xfaucet", 3n, 0, "alice-position"), type: "PositionCreated", account: TEST_ACCOUNT },
    { ...at("0xfaucet", 3n, 1, "alice-grant"), type: "FaucetGrant", account: TEST_ACCOUNT, asset: "tRFL", amount: 2_000_000n },
    { ...at("0xseed", 4n, 0, "seed-custody"), type: "CustodySharesChanged", added: true, amount: 1_000_000n, custodyShares: 1_000_000n, globalShares: 3_000_000n },
    { ...at("0xseed", 4n, 1, "seed-lp"), type: "LpSharesChanged", epoch: 1n, owner: TEST_ACCOUNT, added: true, amount: 1_000_000n, ownerShares: 1_000_000n, totalShares: 1_000_000n },
    {
      ...at("0xseed", 4n, 2, "seed-receipt"),
      type: "LiquiditySeeded",
      epoch: 1n,
      provider: TEST_ACCOUNT,
      trflAmount: 1_000_000n,
      tusdAmount: 1_000_000n,
      lpShares: 1_000_000n,
      trflReserveAfter: 1_000_000n,
      tusdReserveAfter: 1_000_000n,
    },
  ];
}

function validSellEvents(): readonly ProtocolEvent[] {
  const denominator = 2_999_000n;
  const numerator = 10n * REFLECTION_MAGNITUDE;
  const newIndex = numerator / denominator;
  const remainder = numerator % denominator;
  return [
    { ...at("0xsell", 5n, 0, "sell-fee"), type: "ReflectionFeeCollected", swapTxHash: "0xsell", grossAmount: 1_000n, feeAmount: 10n, feeBps: 100n },
    { ...at("0xsell", 5n, 1, "sell-index"), type: "ReflectionIndexAdvanced", previousIndex: 0n, newIndex, indexRemainder: remainder, feeAmount: 10n, eligibleSupply: denominator },
    { ...at("0xsell", 5n, 2, "sell-custody"), type: "CustodySharesChanged", added: true, amount: 990n, custodyShares: 1_000_990n, globalShares: 2_999_990n },
    {
      ...at("0xsell", 5n, 3, "sell-receipt"),
      type: "SwapExecuted",
      account: TEST_ACCOUNT,
      direction: "sell",
      grossAmount: 1_000n,
      reflectionFee: 10n,
      ammFee: 3n,
      netReserveInput: 990n,
      grossPoolOutput: 986n,
      netUserReceipt: 986n,
      trflReserveAfter: 1_000_990n,
      tusdReserveAfter: 999_014n,
    },
  ];
}

function routeEvents(projection: ProtocolProjection, ledgerVersion = 6n): readonly ProtocolEvent[] {
  const amount = custodyPending(projection);
  const epoch = projection.lpEpochs.get(1n)!;
  const numerator = amount * REFLECTION_MAGNITUDE + epoch.indexRemainder;
  const newIndex = epoch.index + numerator / epoch.totalShares;
  const remainder = numerator % epoch.totalShares;
  const gross = (epoch.totalShares * newIndex + epoch.aggregateCorrection) / REFLECTION_MAGNITUDE;
  const liability = gross - epoch.lifetimeClaimed;
  const rounding = epoch.lifetimeReceived + amount - epoch.lifetimeClaimed - liability;
  const tx = `0xroute-${ledgerVersion.toString()}`;
  return [
    {
      ...at(tx, ledgerVersion, 0, `route-${ledgerVersion.toString()}`),
      type: "CustodyRewardsRouted",
      reserveStore: CUSTODY_RESERVE,
      lpRewardVault: LP_REWARD_VAULT,
      epoch: 1n,
      amount,
      totalRouted: projection.custody.claimed + amount,
    },
    {
      ...at(tx, ledgerVersion, 1, `lp-index-${ledgerVersion.toString()}`),
      type: "LpRewardIndexAdvanced",
      epoch: 1n,
      previousIndex: epoch.index,
      newIndex,
      indexRemainder: remainder,
      received: amount,
      totalShares: epoch.totalShares,
      roundingReserve: rounding,
    },
  ];
}

function lpClaimEvent(projection: ProtocolProjection, ledgerVersion = 7n): ProtocolEvent {
  const epoch = projection.lpEpochs.get(1n)!;
  const position = epoch.positions.get(TEST_ACCOUNT)!;
  const amount = lpPositionPending(position, epoch);
  return {
    ...at(`0xlp-claim-${ledgerVersion.toString()}`, ledgerVersion, 0, `lp-claim-${ledgerVersion.toString()}`),
    type: "LpRewardsClaimed",
    epoch: 1n,
    owner: TEST_ACCOUNT,
    amount,
    totalClaimed: position.claimed + amount,
  };
}

function observedFromProjection(
  projection: ProtocolProjection,
  ledgerVersion: bigint,
  overrides: Partial<ObservedAccountingSnapshot> = {},
): ObservedAccountingSnapshot {
  const lpEpochs = [...projection.lpEpochs.values()].map((epoch) => ({
    epoch: epoch.epoch,
    stateId: epoch.stateId,
    status: epoch.status,
    rewardVault: epoch.rewardVault,
    rewardVaultBalance: expectedLpVaultBalance(epoch),
    index: epoch.index,
    indexRemainder: epoch.indexRemainder,
    totalShares: epoch.totalShares,
    aggregateCorrection: epoch.aggregateCorrection,
    unallocatedRewards: epoch.unallocatedRewards,
    roundingReserve: epoch.roundingReserve,
    lifetimeReceived: epoch.lifetimeReceived,
    lifetimeClaimed: epoch.lifetimeClaimed,
    quarantined: epoch.quarantined,
    indexedLiability: lpIndexedLiability(epoch),
    positions: [...epoch.positions.values()].map((position) => ({ ...position })),
  }));
  return {
    ledgerVersion,
    automaticMaterialization: projection.automaticMaterialization,
    rewardVault: projection.rewardVault ?? CORE_REWARD_VAULT,
    rewardVaultBalance: expectedCoreVaultBalance(projection),
    reflectionLiability: coreIndexedLiability(projection),
    currentIndex: projection.currentIndex,
    indexRemainder: projection.indexRemainder,
    eligibleSupply: projection.eligibleSupply,
    aggregateCorrection: projection.aggregateCorrection,
    unallocatedFees: projection.unallocatedFees,
    roundingReserve: projection.roundingReserve,
    lifetimeSwapFees: projection.lifetimeSwapFees,
    lifetimeMaterialized: projection.lifetimeMaterialized,
    lifetimeCustodyRouted: projection.lifetimeCustodyRouted,
    custodyAdapterId: projection.custody.adapterId ?? 1n,
    custodyReserveStore: projection.custody.reserveStore ?? CUSTODY_RESERVE,
    custodyReserveBalance: projection.custody.shares,
    custodyShares: projection.custody.shares,
    custodyCorrection: projection.custody.correction,
    custodyClaimed: projection.custody.claimed,
    custodyPendingRewards: custodyPending(projection),
    custodyActiveRouteEpoch: projection.custody.activeRouteEpoch ?? 1n,
    custodyActiveLpRewardVault: projection.custody.activeLpRewardVault ?? LP_REWARD_VAULT,
    trflReserve: projection.pool.trflReserve,
    tusdReserve: projection.pool.tusdReserve,
    maximumRflContribution: projection.pool.maximumRflContribution,
    maximumTusdContribution: projection.pool.maximumTusdContribution,
    maximumNonFinalWithdrawalShareBps: projection.pool.maximumNonFinalWithdrawalShareBps,
    activeLpEpoch: projection.activeLpEpoch,
    lpEpochs,
    positions: [...projection.positions.values()].map((position) => ({
      account: position.account,
      rawTrfl: position.rawTrfl,
      correction: position.correction,
      claimed: position.claimed,
    })),
    packageVersion: projection.packageVersion,
    swapsPaused: projection.swapsPaused,
    claimsPaused: projection.claimsPaused,
    poolPaused: projection.pool.poolPaused,
    liquidityPaused: projection.pool.liquidityPaused,
    lpClaimsPaused: projection.pool.lpClaimsPaused,
    shutdownMode: projection.pool.shutdownMode,
    poolSeeded: projection.pool.seeded,
    coreOperationalAdmin: projection.operationalAdmins.reflectionCore ?? "0xcafe",
    faucetOperationalAdmin: projection.operationalAdmins.testAssets ?? "0xbabe",
    ammOperationalAdmin: projection.operationalAdmins.testAmm ?? "0xdead",
    ...overrides,
  };
}

async function bootstrappedIndexer(includeSell = true): Promise<EventIndexer> {
  const indexer = new EventIndexer(new InMemoryIndexerStore());
  const events = includeSell ? [...bootstrapEvents(), ...validSellEvents()] : bootstrapEvents();
  const result = await indexer.process(events);
  equal(result.alerts.length, 0, "Test bootstrap must be internally valid");
  return indexer;
}

test("indexer independently replays wallet, custody, LP route/claim, snapshot, and exact reconciliation", async () => {
  const store = new InMemoryIndexerStore();
  const indexer = new EventIndexer(store);
  const first = await indexer.process([...bootstrapEvents(), ...validSellEvents()]);
  equal(first.processedEvents, 12, "All bootstrap and sell events must commit by transaction group");
  equal(indexer.getProjection().custody.shares, 1_000_990n, "Sell net input becomes canonical custody shares exactly once");
  equal(indexer.getProjection().pool.trflReserve, indexer.getProjection().custody.shares, "Reserve and custody shares stay equal");

  const routed = await indexer.process(routeEvents(indexer.getProjection()));
  equal(routed.alerts.length, 0, "Two-sided core-to-LP route must commit");
  const claimed = await indexer.process([lpClaimEvent(indexer.getProjection())]);
  equal(claimed.alerts.length, 0, "LP claim must attach reward tRFL to the wallet at the current core index");
  equal(expectedLpVaultBalance(indexer.getProjection().lpEpochs.get(1n)!), 0n, "Claim drains exactly the claimant's LP entitlement");

  const snapshot = await indexer.snapshot(8_000n);
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  equal(decoded.projection.custody.shares, 1_000_990n, "Snapshot retains custody bigint state");
  equal(decoded.projection.lpEpochs.get(1n)?.positions.get(TEST_ACCOUNT)?.shares, 1_000_000n, "Snapshot retains nested LP positions");
  equal(decoded.projection.seenEventIds.get("sell-receipt"), "5:3", "Snapshot retains identifier-reuse witness state");

  const restarted = new EventIndexer(store);
  await restarted.restoreLatestSnapshot();
  const overlap = await restarted.process([...bootstrapEvents(), ...validSellEvents()]);
  equal(overlap.processedEvents, 0, "Cursor restart must not replay snapshotted events");
  equal(overlap.skippedEvents, 12, "Overlapping events must be skipped exactly once");
  const report = await restarted.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(restarted.getProjection(), 7n),
  });
  equal(report.reconciled, true, "Every core, custody, LP vault, position, and reserve field must reconcile exactly");
});

test("liability is calculated from shares, index, corrections, and settlements—not copied from a vault", async () => {
  const indexer = await bootstrappedIndexer();
  const projection = indexer.getProjection();
  const calculated = coreIndexedLiability(projection);
  const report = await indexer.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 5n, {
      rewardVaultBalance: 999n,
      reflectionLiability: 999n,
    }),
  });
  equal(report.calculatedReflectionLiability, calculated, "Calculated liability must remain independent of both observed values");
  ok(calculated !== 999n, "Mutant must differ from the independent calculation");
  ok(report.alerts.some((entry) => entry.code === "REFLECTION_LIABILITY"), "Wrong observed liability needs a critical alert");
  ok(report.alerts.some((entry) => entry.code === "VAULT_BACKING"), "Wrong observed core vault needs a critical alert");
});

test("atomic processing rejects double-counted composite wallet evidence without advancing state", async () => {
  const indexer = await bootstrappedIndexer(false);
  const before = indexer.getProjection();
  const mutant: ProtocolEvent = {
    ...at("0xsell", 5n, 4, "mutant-native-debit"),
    type: "EligibleBalanceDebited",
    account: TEST_ACCOUNT,
    amount: 1_000n,
  };
  const result = await indexer.process([...validSellEvents(), mutant]);
  ok(result.alerts.some((entry) => entry.code === "DOUBLE_COUNTING"), "Duplicate high-level and hook evidence must be detected");
  equal(result.rejectedEvents, 5, "The whole divergent transaction must be rejected");
  equal(indexer.getProjection().currentIndex, before.currentIndex, "No part of a rejected transaction may mutate projection state");
  equal(indexer.getCursor()?.ledgerVersion, 4n, "Cursor must remain before the rejected transaction");
});

test("one-sided custody route is rejected atomically", async () => {
  const indexer = await bootstrappedIndexer();
  const before = indexer.getProjection();
  const oneSided = routeEvents(before)[0]!;
  const result = await indexer.process([oneSided]);
  ok(result.alerts.some((entry) => entry.code === "ROUTE_PAIR"), "Missing downstream LP receipt must alert");
  equal(indexer.getProjection().lifetimeCustodyRouted, before.lifetimeCustodyRouted, "Rejected route cannot settle the core liability");
  equal(indexer.getCursor()?.ledgerVersion, 5n, "One-sided route cannot advance the checkpoint");
});

test("wrong individual LP vault binding and balance alert even when aggregate backing is unchanged", async () => {
  const indexer = await bootstrappedIndexer();
  await indexer.process(routeEvents(indexer.getProjection()));
  const projection = indexer.getProjection();
  const correct = observedFromProjection(projection, 6n);
  const firstEpoch = correct.lpEpochs[0]!;
  const report = await indexer.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => ({
      ...correct,
      rewardVaultBalance: correct.rewardVaultBalance + 1n,
      lpEpochs: [{ ...firstEpoch, rewardVault: SECOND_LP_VAULT, rewardVaultBalance: firstEpoch.rewardVaultBalance - 1n }],
    }),
  });
  ok(report.alerts.some((entry) => entry.code === "VAULT_BINDING"), "Wrong epoch vault identifier must alert");
  ok(report.alerts.some((entry) => entry.code === "LP_VAULT_BACKING"), "Wrong individual epoch balance must alert independently of aggregate backing");
  ok(report.alerts.some((entry) => entry.code === "VAULT_BACKING"), "Compensating mutation in the core vault must also alert");
});

test("reserve receipt mutation and observed reserve-custody mismatch both fail closed", async () => {
  const indexer = await bootstrappedIndexer(false);
  const mutant = validSellEvents().map((event) => event.type === "SwapExecuted"
    ? { ...event, trflReserveAfter: event.trflReserveAfter + 1n }
    : event);
  const rejected = await indexer.process(mutant);
  ok(rejected.alerts.some((entry) => entry.code === "POOL_RESERVES"), "Mutated reserve receipt must alert");
  ok(rejected.alerts.some((entry) => entry.code === "RESERVE_CUSTODY"), "Mutated reserve must disagree with custody shares");

  const clean = await bootstrappedIndexer();
  const projection = clean.getProjection();
  const report = await clean.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 5n, {
      custodyReserveBalance: projection.custody.shares - 1n,
    }),
  });
  ok(report.alerts.some((entry) => entry.code === "RESERVE_CUSTODY"), "Raw reserve/custody mismatch must be critical");
});

test("liquidity-limit events normalize, replay, and reconcile every field exactly", async () => {
  const normalizer = new CedraEventNormalizer();
  const normalized = normalizer.normalize({
    typeTag: "0xcafe::pool::LiquidityLimitsChanged",
    data: {
      max_rfl_contribution: "5000000",
      max_usd_contribution: "7000000",
      max_withdrawal_share_bps: "2500",
    },
    txHash: "0xliquidity-limits",
    ledgerVersion: 6n,
    eventIndex: 0,
    timestampUnixMilliseconds: 6_000n,
  });
  if (normalized === null || normalized.type !== "LiquidityLimitsChanged") {
    throw new Error("LiquidityLimitsChanged must normalize to its exact witness event");
  }
  equal(normalized.maximumRflContribution, 5_000_000n, "tRFL contribution limit must normalize exactly");
  equal(normalized.maximumTusdContribution, 7_000_000n, "tUSD contribution limit must normalize exactly");
  equal(normalized.maximumNonFinalWithdrawalShareBps, 2_500n, "Non-final withdrawal limit must normalize exactly");

  const indexer = await bootstrappedIndexer();
  const replay = await indexer.process([normalized]);
  equal(replay.alerts.length, 0, "A valid liquidity-limit event must commit");
  const projection = indexer.getProjection();
  equal(projection.pool.maximumRflContribution, 5_000_000n, "Replay must retain the exact tRFL limit");
  equal(projection.pool.maximumTusdContribution, 7_000_000n, "Replay must retain the exact tUSD limit");
  equal(projection.pool.maximumNonFinalWithdrawalShareBps, 2_500n, "Replay must retain the exact non-final withdrawal limit");

  const clean = await indexer.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 6n),
  });
  equal(clean.reconciled, true, "Matching finalized liquidity-limit views must reconcile cleanly");

  const mismatch = await indexer.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 6n, {
      maximumNonFinalWithdrawalShareBps: 2_501n,
    }),
  });
  ok(mismatch.alerts.some((entry) => entry.code === "POOL_LIMITS"), "Any observed liquidity-limit mismatch must be critical");

  const rejected = await indexer.process([{
    ...normalized,
    id: "invalid-liquidity-limits",
    txHash: "0xinvalid-liquidity-limits",
    ledgerVersion: 7n,
    maximumRflContribution: 0n,
  }]);
  ok(rejected.alerts.some((entry) => entry.code === "EVENT_DATA"), "Invalid liquidity limits must be rejected by replay");
  equal(indexer.getCursor()?.ledgerVersion, 6n, "Rejected limit evidence cannot advance the checkpoint");
});

test("immutable materialization mode normalizes and reconciles against the on-chain view", async () => {
  const normalizer = new CedraEventNormalizer();
  const normalized = normalizer.normalize({
    typeTag: "0xcafe::reflection_events::ProtocolInitialized",
    data: {
      version: "1",
      reward_vault: CORE_REWARD_VAULT,
      distribution_vault: DISTRIBUTION_VAULT,
      automatic_materialization: false,
    },
    txHash: "0xmode-init",
    ledgerVersion: 1n,
    eventIndex: 0,
    timestampUnixMilliseconds: 1_000n,
  });
  if (normalized === null || normalized.type !== "ProtocolInitialized") {
    throw new Error("Protocol initialization must normalize");
  }
  equal(normalized.automaticMaterialization, false, "Claim-backed mode must survive normalization");

  const indexer = await bootstrappedIndexer();
  const projection = indexer.getProjection();
  const report = await indexer.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 6n, {
      automaticMaterialization: true,
    }),
  });
  ok(
    report.alerts.some((alert) => alert.code === "CORE_ACCOUNTING" && alert.id.includes("materialization-mode")),
    "A mutable or mismatched mode view must fail reconciliation",
  );
});

test("routes to an old claim-only LP epoch are rejected", async () => {
  const indexer = await bootstrappedIndexer();
  await indexer.process(routeEvents(indexer.getProjection()));
  await indexer.process([lpClaimEvent(indexer.getProjection())]);
  const beforeExit = indexer.getProjection();
  const epoch = beforeExit.lpEpochs.get(1n)!;
  const owner = epoch.positions.get(TEST_ACCOUNT)!;
  const reserveRfl = beforeExit.pool.trflReserve;
  const reserveUsd = beforeExit.pool.tusdReserve;
  const walletOnlyShares = beforeExit.eligibleSupply - beforeExit.custody.shares;
  const exit: readonly ProtocolEvent[] = [
    { ...at("0xexit", 8n, 0, "exit-lp"), type: "LpSharesChanged", epoch: 1n, owner: TEST_ACCOUNT, added: false, amount: owner.shares, ownerShares: 0n, totalShares: 0n },
    { ...at("0xexit", 8n, 1, "exit-custody"), type: "CustodySharesChanged", added: false, amount: reserveRfl, custodyShares: 0n, globalShares: walletOnlyShares },
    { ...at("0xexit", 8n, 2, "exit-status"), type: "LpEpochStatusChanged", epoch: 1n, oldStatus: "active", newStatus: "claim-only" },
    {
      ...at("0xexit", 8n, 3, "exit-receipt"),
      type: "LiquidityRemoved",
      epoch: 1n,
      provider: TEST_ACCOUNT,
      trflAmount: reserveRfl,
      tusdAmount: reserveUsd,
      lpShares: owner.shares,
      finalExit: true,
      trflReserveAfter: 0n,
      tusdReserveAfter: 0n,
    },
  ];
  const exited = await indexer.process(exit);
  equal(exited.alerts.length, 0, "Valid final exit must preserve old claim history");
  const opened = await indexer.process([
    { ...at("0xepoch2", 9n, 0, "epoch-2"), type: "LpEpochOpened", epoch: 2n, stateId: LP_STATE_2, rewardVault: SECOND_LP_VAULT },
    { ...at("0xepoch2", 9n, 1, "route-open-2"), type: "CustodyEpochRouteOpened", adapterId: 1n, epoch: 2n, reserveStore: CUSTODY_RESERVE, lpRewardVault: SECOND_LP_VAULT },
  ]);
  equal(opened.alerts.length, 0, "Fresh epoch may open after old epoch becomes claim-only");
  const oldRoute: readonly ProtocolEvent[] = [
    { ...at("0xold-route", 10n, 0, "old-route"), type: "CustodyRewardsRouted", reserveStore: CUSTODY_RESERVE, lpRewardVault: LP_REWARD_VAULT, epoch: 1n, amount: 1n, totalRouted: beforeExit.custody.claimed + 1n },
    { ...at("0xold-route", 10n, 1, "old-lp-index"), type: "LpRewardIndexAdvanced", epoch: 1n, previousIndex: epoch.index, newIndex: epoch.index, indexRemainder: epoch.indexRemainder, received: 1n, totalShares: 0n, roundingReserve: 0n },
  ];
  const rejected = await indexer.process(oldRoute);
  ok(rejected.alerts.some((entry) => entry.code === "OLD_EPOCH_ROUTE"), "A route to a claim-only historical epoch must be critical");
  equal(indexer.getCursor()?.ledgerVersion, 9n, "Old-epoch route cannot advance the checkpoint");
});

test("LP share transfer preserves accrued history and gives the recipient no retroactive reward", async () => {
  const indexer = await bootstrappedIndexer();
  await indexer.process(routeEvents(indexer.getProjection()));
  const before = indexer.getProjection().lpEpochs.get(1n)!;
  const aliceBefore = lpPositionPending(before.positions.get(TEST_ACCOUNT)!, before);
  ok(aliceBefore > 0n, "Fixture must contain accrued LP rewards before transfer");
  const result = await indexer.process([{
    ...at("0xlp-transfer", 7n, 0, "lp-transfer"),
    type: "LpSharesTransferred",
    epoch: 1n,
    sender: TEST_ACCOUNT,
    recipient: TEST_BOB,
    amount: 500_000n,
  }]);
  equal(result.alerts.length, 0, "Checkpointed LP transfer must replay cleanly");
  const after = indexer.getProjection().lpEpochs.get(1n)!;
  equal(lpPositionPending(after.positions.get(TEST_ACCOUNT)!, after), aliceBefore, "Sender keeps all reward history accrued before transfer");
  equal(lpPositionPending(after.positions.get(TEST_BOB)!, after), 0n, "Recipient receives no retroactive reward");
  equal(after.totalShares, before.totalShares, "LP transfer cannot change epoch total shares");
});

test("event identifier reuse at a later cursor is rejected and persisted across snapshots", async () => {
  const store = new InMemoryIndexerStore();
  const indexer = new EventIndexer(store);
  await indexer.process(bootstrapEvents());
  await indexer.snapshot(5_000n);
  const restarted = new EventIndexer(store);
  await restarted.restoreLatestSnapshot();
  const result = await restarted.process([{ ...at("0xnew", 11n, 0, "init"), type: "PositionCreated", account: TEST_BOB }]);
  ok(result.alerts.some((entry) => entry.code === "IDENTIFIER_REUSE"), "Reused identifier must be detected after restart");
  equal(restarted.getCursor()?.ledgerVersion, 4n, "Identifier reuse cannot advance the checkpoint");
});

test("LP state-object and vault identifiers cannot be reused by a later epoch", () => {
  const empty = createEmptyProjection();
  const historical: IndexedLpEpoch = {
    epoch: 1n,
    stateId: LP_STATE_1,
    status: "claim-only",
    rewardVault: LP_REWARD_VAULT,
    index: 0n,
    indexRemainder: 0n,
    totalShares: 0n,
    aggregateCorrection: 0n,
    unallocatedRewards: 0n,
    roundingReserve: 0n,
    lifetimeReceived: 0n,
    lifetimeClaimed: 0n,
    quarantined: false,
    positions: new Map(),
  };
  const prior: ProtocolProjection = {
    ...empty,
    lpEpochs: new Map([[1n, historical]]),
    rewardVaultToEpoch: new Map([[LP_REWARD_VAULT, 1n]]),
    stateIdToEpoch: new Map([[LP_STATE_1, 1n]]),
  };
  const stateReuse = reduceEventGroup(prior, [{
    ...at("0xstate-reuse", 20n, 0, "state-reuse"),
    type: "LpEpochOpened",
    epoch: 2n,
    stateId: LP_STATE_1,
    rewardVault: SECOND_LP_VAULT,
  }]);
  ok(stateReuse.alerts.some((entry) => entry.code === "IDENTIFIER_REUSE"), "Fresh epoch must have a fresh state object");
  const vaultReuse = reduceEventGroup(prior, [{
    ...at("0xvault-reuse", 21n, 0, "vault-reuse"),
    type: "LpEpochOpened",
    epoch: 2n,
    stateId: LP_STATE_2,
    rewardVault: LP_REWARD_VAULT,
  }]);
  ok(vaultReuse.alerts.some((entry) => entry.code === "IDENTIFIER_REUSE"), "Fresh epoch must have a fresh reward vault");
});

test("materialization and explicit claim action are paired without a second wallet or vault movement", async () => {
  const indexer = await bootstrappedIndexer();
  const before = indexer.getProjection();
  const pending = (before.positions.get(TEST_ACCOUNT)!.rawTrfl * before.currentIndex
    + before.positions.get(TEST_ACCOUNT)!.correction) / REFLECTION_MAGNITUDE
    - before.positions.get(TEST_ACCOUNT)!.claimed;
  ok(pending > 0n, "Sale must create wallet pending rewards for the fixture");
  const amount = 1n;
  const result = await indexer.process([
    { ...at("0xclaim", 6n, 0, "materialized"), type: "RewardsMaterialized", account: TEST_ACCOUNT, amount, totalClaimed: amount },
    { ...at("0xclaim", 6n, 1, "explicit-claim"), type: "RewardsClaimed", account: TEST_ACCOUNT, amount, totalClaimed: amount },
  ]);
  equal(result.alerts.length, 0, "Exact materialization/claim pair must commit");
  const after = indexer.getProjection();
  equal(after.positions.get(TEST_ACCOUNT)!.rawTrfl, before.positions.get(TEST_ACCOUNT)!.rawTrfl + amount, "Materialization is the single physical wallet credit");
  equal(after.rewardVaultPayouts, before.rewardVaultPayouts + amount, "Explicit action event must not create a second vault payout");
  equal(after.positions.get(TEST_ACCOUNT)!.lifetimeClaimed, amount, "Explicit claim action remains observable");
});

test("native transfer endpoints take precedence over a redundant historical router receipt", async () => {
  const indexer = await bootstrappedIndexer(false);
  const result = await indexer.process([
    { ...at("0xtransfer", 5n, 0, "native-debit"), type: "EligibleBalanceDebited", account: TEST_ACCOUNT, amount: 40n },
    { ...at("0xtransfer", 5n, 1, "bob-position"), type: "PositionCreated", account: TEST_BOB },
    { ...at("0xtransfer", 5n, 2, "native-credit"), type: "EligibleBalanceCredited", account: TEST_BOB, amount: 40n },
    { ...at("0xtransfer", 5n, 3, "redundant-router"), type: "WalletTransfer", from: TEST_ACCOUNT, to: TEST_BOB, asset: "tRFL", amount: 40n },
  ]);
  equal(result.alerts.length, 0, "A complete redundant historical receipt must not double-count native hooks");
  equal(indexer.getProjection().positions.get(TEST_ACCOUNT)?.rawTrfl, 1_999_960n, "Native debit applies once");
  equal(indexer.getProjection().positions.get(TEST_BOB)?.rawTrfl, 40n, "Native credit applies once");
});

test("operational-admin handoffs normalize, replay, reconcile, and reject broken authority chains", async () => {
  const normalizer = new CedraEventNormalizer();
  const envelopes = [
    {
      typeTag: "0xcafe::reflection_events::OperationalAdminChanged",
      data: { old_operational_admin: "0xcafe", new_operational_admin: "0x0bed" },
      txHash: "0xcore-operator",
      ledgerVersion: 6n,
      eventIndex: 0,
      timestampUnixMilliseconds: 6_000n,
    },
    {
      typeTag: "0xbabe::test_faucet::OperationalAdminChanged",
      data: { old_operational_admin: "0xbabe", new_operational_admin: "0x0bed" },
      txHash: "0xfaucet-operator",
      ledgerVersion: 7n,
      eventIndex: 0,
      timestampUnixMilliseconds: 7_000n,
    },
    {
      typeTag: "0xdead::pool::OperationalAdminChanged",
      data: { old_operational_admin: "0xdead", new_operational_admin: "0x0bed" },
      txHash: "0xamm-operator",
      ledgerVersion: 8n,
      eventIndex: 0,
      timestampUnixMilliseconds: 8_000n,
    },
  ] as const;
  const normalized = envelopes.map((envelope) => normalizer.normalize(envelope));
  if (normalized.some((event) => event === null || event.type !== "OperationalAdminChanged")) {
    throw new Error("Every operational-admin event must normalize");
  }
  const handoffs = normalized as readonly Extract<ProtocolEvent, { readonly type: "OperationalAdminChanged" }>[];
  equal(handoffs[0]?.scope, "reflection-core", "Core handoff retains its authority scope");
  equal(handoffs[1]?.scope, "test-assets", "Faucet handoff retains its authority scope");
  equal(handoffs[2]?.scope, "test-amm", "AMM handoff retains its authority scope");

  const indexer = await bootstrappedIndexer();
  for (const handoff of handoffs) {
    const result = await indexer.process([handoff]);
    equal(result.alerts.length, 0, "A valid publisher handoff must commit");
  }
  const projection = indexer.getProjection();
  equal(projection.operationalAdmins.reflectionCore, "0x0bed", "Core operational authority is replayed");
  equal(projection.operationalAdmins.testAssets, "0x0bed", "Faucet operational authority is replayed");
  equal(projection.operationalAdmins.testAmm, "0x0bed", "AMM operational authority is replayed");

  const clean = await indexer.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 8n),
  });
  equal(clean.reconciled, true, "Matching operational-admin views must reconcile");
  const mismatch = await indexer.reconcile({
    listEvents: async () => ({ events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 8n, {
      ammOperationalAdmin: "0xbad",
    }),
  });
  ok(mismatch.alerts.some((entry) => entry.code === "OPERATIONAL_ADMIN"), "Authority-view mismatch must be critical");

  const broken: ProtocolEvent = {
    ...at("0xbroken-core-operator", 9n, 0),
    type: "OperationalAdminChanged",
    scope: "reflection-core",
    oldOperationalAdmin: "0xcafe",
    newOperationalAdmin: "0xbeef",
  };
  const rejected = await indexer.process([broken]);
  ok(rejected.alerts.some((entry) => entry.code === "OPERATIONAL_ADMIN"), "Broken authority continuity must reject the transaction");
  equal(indexer.getProjection().operationalAdmins.reflectionCore, "0x0bed", "Rejected authority mutation cannot commit");
});

test("Cedra normalizer maps custody and LP payloads and fails closed on missing arithmetic fields", () => {
  const normalizer = new CedraEventNormalizer();
  const normalized = normalizer.normalize({
    typeTag: "0xcafe::reflection_events::ReflectionIndexAdvanced",
    data: { old_index: "0", new_index: "10", remainder: "0", eligible_supply: "1000", fee_amount: "10" },
    txHash: "0xnormalizer",
    ledgerVersion: 5n,
    eventIndex: 2,
    timestampUnixMilliseconds: 5_000n,
  });
  equal(normalized?.type, "ReflectionIndexAdvanced", "Address-qualified Move event must normalize");
  if (normalized?.type === "ReflectionIndexAdvanced") equal(normalized.feeAmount, 10n, "Fee amount remains replay evidence");

  const routed = normalizer.normalize({
    typeTag: "0xcafe::reflection_events::CustodyRewardsRouted",
    data: { reserve_store: CUSTODY_RESERVE, lp_reward_vault: LP_REWARD_VAULT, epoch: "1", amount: "7", total_routed: "7" },
    txHash: "0xroute",
    ledgerVersion: 6n,
    eventIndex: 0,
    timestampUnixMilliseconds: 6_000n,
  });
  equal(routed?.type, "CustodyRewardsRouted", "Core custody route must normalize");

  const lpIndex = normalizer.normalize({
    typeTag: "0xdead::lp_rewards::LpRewardIndexAdvanced",
    data: { epoch: "1", old_index: "0", new_index: "7", remainder: "0", received: "7", total_shares: "1000", rounding_reserve: "0" },
    txHash: "0xroute",
    ledgerVersion: 6n,
    eventIndex: 1,
    timestampUnixMilliseconds: 6_000n,
  });
  equal(lpIndex?.type, "LpRewardIndexAdvanced", "Downstream LP receipt must normalize");

  let threw = false;
  try {
    normalizer.normalize({
      typeTag: "reflection_core::reflection_events::ReflectionIndexAdvanced",
      data: { old_index: "0", new_index: "10", remainder: "0", fee_amount: "10" },
      txHash: "0xbroken",
      ledgerVersion: 7n,
      eventIndex: 0,
      timestampUnixMilliseconds: 7_000n,
    });
  } catch (error) {
    threw = error instanceof TypeError;
  }
  equal(threw, true, "Missing denominator evidence must fail closed");

  let unsupportedStatusThrew = false;
  try {
    normalizer.normalize({
      typeTag: "0xdead::lp_rewards::LpEpochStatusChanged",
      data: { epoch: "1", old_status: "1", new_status: "3" },
      txHash: "0xunsupported-status",
      ledgerVersion: 8n,
      eventIndex: 0,
      timestampUnixMilliseconds: 8_000n,
    });
  } catch (error) {
    unsupportedStatusThrew = error instanceof TypeError;
  }
  equal(unsupportedStatusThrew, true, "Only active and terminal claim-only status values may normalize");
});
