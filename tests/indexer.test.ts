import type { Address } from "../packages/protocol-sdk/src/types.js";
import {
  applyMoveSignedU256,
  assertProtocolEventMoveDomains,
  CedraEventNormalizer,
  checkedMoveSignedU256Add,
  checkedMoveSignedU256AddUnsigned,
  checkedMoveSignedU256SubtractUnsigned,
  checkedMoveU256Add,
  checkedMoveU256Multiply,
  checkedMoveU256Subtract,
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
  reconcile,
  REFLECTION_MAGNITUDE,
  reduceEventGroup,
  takeSnapshot,
  UnreconciledCheckpointError,
  type EventBase,
  type IndexedLpEpoch,
  type IndexerStore,
  type ObservedAccountingSnapshot,
  type ProtocolEvent,
  type ProtocolProjection,
} from "../packages/indexer/src/index.js";
import {
  CORE_REWARD_VAULT,
  CUSTODY_RESERVE,
  DISTRIBUTION_VAULT,
  LP_REWARD_VAULT,
  TOKEN_METADATA,
  TEST_ACCOUNT,
  TEST_BOB,
  USD_RESERVE,
  baseEvent,
} from "./fixtures.js";
import { equal, ok, rejects, test } from "./harness.js";

const SECOND_LP_VAULT = "0x3002" as Address;
const LP_STATE_1 = "0x4001" as Address;
const LP_STATE_2 = "0x4002" as Address;
const ALICE_PRIMARY_STORE = "0xa1101" as Address;
const BOB_PRIMARY_STORE = "0xb0b01" as Address;
const NORMALIZER_OPTIONS = {
  packageAddresses: {
    reflectionCore: "0xcafe" as Address,
    testAssets: "0xbabe" as Address,
    testAmm: "0xdead" as Address,
  },
} as const;

function eventNormalizer(): CedraEventNormalizer {
  return new CedraEventNormalizer(NORMALIZER_OPTIONS);
}

function thrownBy(execute: () => unknown): unknown {
  try {
    execute();
  } catch (error) {
    return error;
  }
  return null;
}

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
      deploymentId: "reflection-pilot-001",
      networkLabel: "cedra-testnet",
      tokenMetadata: TOKEN_METADATA,
      automaticMaterialization: false,
      feeBps: 100n,
      initialIndex: 0n,
      packageVersion: "testnet-v0.1.0",
      rewardVault: CORE_REWARD_VAULT,
      distributionVault: DISTRIBUTION_VAULT,
      protocolExclusionSlots: 2n,
    },
    {
      ...at("0xinit", 1n, 1, "core-operator-init"),
      type: "OperationalAdminChanged",
      scope: "reflection-core",
      oldOperationalAdmin: "0x0",
      newOperationalAdmin: "0xcafe",
    },
    {
      ...at("0xinit", 1n, 2, "assets-operator-init"),
      type: "OperationalAdminChanged",
      scope: "test-assets",
      oldOperationalAdmin: "0x0",
      newOperationalAdmin: "0xbabe",
    },
    {
      ...at("0xinit", 1n, 3, "amm-operator-init"),
      type: "OperationalAdminChanged",
      scope: "test-amm",
      oldOperationalAdmin: "0x0",
      newOperationalAdmin: "0xdead",
    },
    { ...at("0xamm-init", 2n, 0, "adapter-1"), type: "CustodyAdapterRegistered", adapterId: 1n, reserveStore: CUSTODY_RESERVE, firstEpoch: 1n, lpRewardVault: LP_REWARD_VAULT },
    { ...at("0xamm-init", 2n, 1, "epoch-1"), type: "LpEpochOpened", epoch: 1n, stateId: LP_STATE_1, rewardVault: LP_REWARD_VAULT },
    { ...at("0xamm-init", 2n, 2, "usd-reserve-1"), type: "PoolReserveBound", reserveStore: USD_RESERVE, custodian: "0xdead" },
    {
      ...at("0xfaucet", 3n, 0, "alice-registration"),
      type: "WalletRegistered",
      account: TEST_ACCOUNT,
      primaryStore: ALICE_PRIMARY_STORE,
      registeredWalletCount: 1n,
    },
    { ...at("0xfaucet", 3n, 1, "alice-position"), type: "PositionCreated", account: TEST_ACCOUNT },
    { ...at("0xfaucet", 3n, 2, "alice-grant"), type: "FaucetGrant", account: TEST_ACCOUNT, asset: "tRFL", amount: 2_000_000n },
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
    terminalRoundingBaseUnits: epoch.terminalRoundingBaseUnits ?? 0n,
    retiredResidueMagnified: epoch.retiredResidueMagnified,
    lifetimeReceived: epoch.lifetimeReceived,
    lifetimeClaimed: epoch.lifetimeClaimed,
    quarantined: epoch.quarantined,
    indexedLiability: lpIndexedLiability(epoch),
    positions: [...epoch.positions.values()].map((position) => ({ ...position })),
  }));
  return {
    chainId: projection.chainId,
    ledgerVersion,
    deploymentId: projection.deploymentId,
    networkLabel: projection.networkLabel,
    tokenMetadata: projection.tokenMetadata ?? TOKEN_METADATA,
    protocolExclusionsRemaining: projection.protocolExclusionsRemaining,
    registeredWalletCount: projection.registeredWalletCount,
    registeredWalletAccounts: [...projection.registeredWallets.keys()],
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
    poolRflReserveStore: projection.custody.reserveStore ?? CUSTODY_RESERVE,
    poolUsdReserveStore: projection.mockUsdPoolReserve ?? USD_RESERVE,
    mockUsdPoolReserve: projection.mockUsdPoolReserve ?? USD_RESERVE,
    custodyReserveBalance: projection.custody.shares,
    custodyShares: projection.custody.shares,
    custodyCorrection: projection.custody.correction,
    custodyClaimed: projection.custody.claimed,
    custodyPendingRewards: custodyPending(projection),
    custodyActiveRouteEpoch: projection.custody.activeRouteEpoch ?? 1n,
    custodyActiveLpRewardVault: projection.custody.activeLpRewardVault ?? LP_REWARD_VAULT,
    trflReserve: projection.pool.trflReserve,
    tusdReserve: projection.pool.tusdReserve,
    ammFeeBps: projection.pool.ammFeeBps,
    maximumGrossSwap: projection.pool.maximumGrossSwap,
    maximumReserveBps: projection.pool.maximumReserveBps,
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
    faucetPaused: projection.faucetPaused,
    faucetTrflGrant: projection.faucetTrflGrant,
    faucetTusdGrant: projection.faucetTusdGrant,
    faucetCooldownSeconds: projection.faucetCooldownSeconds,
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

test("direct checkpoint API requires complete authority history and a fresh exact-cursor reconciliation", async () => {
  const empty = new EventIndexer(new InMemoryIndexerStore());
  await rejects(() => empty.snapshot(1n), UnreconciledCheckpointError);

  const incomplete = new EventIndexer(new InMemoryIndexerStore());
  const incompleteResult = await incomplete.process(
    bootstrapEvents().filter((event) => event.id !== "amm-operator-init"),
  );
  equal(incompleteResult.alerts.length, 0, "Missing authority history remains replayable but deployment-unready");
  equal(incomplete.getProjection().deploymentReady, false, "Three-role history is required for deployment readiness");
  await rejects(() => incomplete.snapshot(2n), UnreconciledCheckpointError);

  const readyStore = new InMemoryIndexerStore();
  const ready = new EventIndexer(readyStore);
  await ready.process(bootstrapEvents());
  await rejects(() => ready.snapshot(3n), UnreconciledCheckpointError);
  const cursor = ready.getCursor()!;
  const source = {
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(
      ready.getProjection(),
      cursor.ledgerVersion,
    ),
  };
  equal((await ready.reconcile(source)).reconciled, true, "Exact chain-2 reconciliation succeeds");
  await ready.process([]);
  await rejects(
    () => ready.snapshot(4n),
    UnreconciledCheckpointError,
  );
  equal((await ready.reconcile(source)).reconciled, true, "A fresh same-cursor reconciliation reauthorizes checkpointing");
  const exposedProjection = ready.getProjection();
  (exposedProjection.seenEventIds as Map<string, string>).clear();
  equal(
    ready.getProjection().seenEventIds.size > 0,
    true,
    "Public projection reads cannot mutate the live reconciled state",
  );
  const snapshot = await ready.snapshot(5n);
  equal(snapshot.cursor?.ledgerVersion, cursor.ledgerVersion, "Authorized checkpoint preserves the reconciled cursor");
  (snapshot.projection.seenEventIds as Map<string, string>).clear();
  equal(
    ready.getProjection().seenEventIds.size > 0,
    true,
    "Returned checkpoint objects cannot mutate the live indexer projection",
  );

  const restored = new EventIndexer(readyStore);
  await restored.restoreLatestSnapshot();
  equal(restored.getProjection().seenEventIds.size > 0, true, "Memory store snapshots are detached from caller aliases");
  const restoredCursor = restored.getCursor()!;
  const restoredSource = {
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(
      restored.getProjection(),
      restoredCursor.ledgerVersion,
    ),
  };
  equal((await restored.reconcile(restoredSource)).reconciled, true, "Restored exact state can be reconciled");
  // Simulate unexpected in-process corruption after reconciliation and prove
  // the content identity gate catches it even though the private projection
  // object reference did not change.
  const internalProjection = (restored as unknown as { projection: ProtocolProjection }).projection;
  (internalProjection.seenEventIds as Map<string, string>).clear();
  await rejects(() => restored.snapshot(6n), UnreconciledCheckpointError);
});

test("indexer detaches hostile store, process, poll-source, and return-value aliases", async () => {
  const seedStore = new InMemoryIndexerStore();
  const seed = new EventIndexer(seedStore);
  await seed.process(bootstrapEvents());
  const seedCursor = seed.getCursor()!;
  const seedSource = {
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(seed.getProjection(), seedCursor.ledgerVersion),
  };
  await seed.reconcile(seedSource);
  await seed.snapshot(10n);
  const aliasedSnapshot = (await seedStore.loadLatestSnapshot())!;
  const hostileStore = {
    permitsImplicitWriterLease: true,
    withExclusiveWriter: async (operation: (lease: never) => Promise<unknown>) => operation({} as never),
    loadLatestSnapshot: async () => aliasedSnapshot,
    saveSnapshot: async () => undefined,
    appendAlerts: async () => undefined,
    listAlerts: async () => [],
  } as unknown as IndexerStore;
  const restored = new EventIndexer(hostileStore);
  const returnedSnapshot = (await restored.restoreLatestSnapshot())!;
  (aliasedSnapshot.cursor as { ledgerVersion: bigint }).ledgerVersion = 999n;
  (aliasedSnapshot.projection.seenEventIds as Map<string, string>).clear();
  (returnedSnapshot.projection.seenEventIds as Map<string, string>).clear();
  equal(restored.getCursor()?.ledgerVersion, seedCursor.ledgerVersion, "Store-retained cursor mutation cannot alter restored state");
  equal(restored.getProjection().seenEventIds.size > 0, true, "Store and returned snapshot Maps are detached from internal state");

  const processInput = structuredClone(bootstrapEvents()) as ProtocolEvent[];
  const processedIndexer = new EventIndexer(new InMemoryIndexerStore());
  const processingPromise = processedIndexer.process(processInput);
  (processInput[0] as unknown as { deploymentId: string }).deploymentId = "mutated-after-call";
  const processing = await processingPromise;
  (processing.cursor as { ledgerVersion: bigint }).ledgerVersion = 888n;
  equal(processedIndexer.getProjection().deploymentId, "reflection-pilot-001", "Process clones caller event objects before replay");
  equal(processedIndexer.getCursor()?.ledgerVersion, 4n, "Returned process cursor cannot mutate the internal cursor");

  const polled = await bootstrappedIndexer();
  const routePage = {
    chainId: 2,
    events: structuredClone(routeEvents(polled.getProjection())) as ProtocolEvent[],
    nextCursor: null,
  };
  let sourceCursor: { ledgerVersion: bigint; eventIndex: number } | null = null;
  const pollSource = {
    listEvents: async (after: { ledgerVersion: bigint; eventIndex: number } | null) => {
      sourceCursor = after;
      if (after !== null) after.ledgerVersion = 777n;
      return routePage;
    },
    getAccountingSnapshot: async (ledgerVersion: bigint) => observedFromProjection(polled.getProjection(), ledgerVersion),
  };
  const pollResult = await polled.pollOnce(pollSource);
  (routePage.events[0] as unknown as { amount: bigint }).amount = 999_999n;
  (pollResult.cursor as { ledgerVersion: bigint }).ledgerVersion = 666n;
  equal(
    (sourceCursor as unknown as { ledgerVersion: bigint }).ledgerVersion,
    777n,
    "Hostile source can mutate only its detached cursor argument",
  );
  equal(polled.getCursor()?.ledgerVersion, 6n, "Poll page and returned cursor mutation cannot alter committed cursor state");
  equal(polled.getProjection().custody.lifetimeRouted > 0n, true, "Committed projection remains derived from the detached page copy");
});

test("indexer independently replays wallet, custody, LP route/claim, snapshot, and exact reconciliation", async () => {
  const store = new InMemoryIndexerStore();
  const indexer = new EventIndexer(store);
  const first = await indexer.process([...bootstrapEvents(), ...validSellEvents()]);
  equal(first.processedEvents, 17, "All bootstrap and sell events must commit by transaction group");
  equal(indexer.getProjection().custody.shares, 1_000_990n, "Sell net input becomes canonical custody shares exactly once");
  equal(indexer.getProjection().pool.trflReserve, indexer.getProjection().custody.shares, "Reserve and custody shares stay equal");

  const routed = await indexer.process(routeEvents(indexer.getProjection()));
  equal(routed.alerts.length, 0, "Two-sided core-to-LP route must commit");
  const claimed = await indexer.process([lpClaimEvent(indexer.getProjection())]);
  equal(claimed.alerts.length, 0, "LP claim must attach reward tRFL to the wallet at the current core index");
  equal(expectedLpVaultBalance(indexer.getProjection().lpEpochs.get(1n)!), 0n, "Claim drains exactly the claimant's LP entitlement");

  const checkpointCursor = indexer.getCursor()!;
  const checkpointReport = await indexer.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(
      indexer.getProjection(),
      checkpointCursor.ledgerVersion,
    ),
  });
  equal(checkpointReport.reconciled, true, "A direct checkpoint requires a clean exact-cursor reconciliation");
  const snapshot = await indexer.snapshot(8_000n);
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  equal(decoded.projection.custody.shares, 1_000_990n, "Snapshot retains custody bigint state");
  equal(decoded.projection.lpEpochs.get(1n)?.positions.get(TEST_ACCOUNT)?.shares, 1_000_000n, "Snapshot retains nested LP positions");
  equal(decoded.projection.registeredWallets.get(TEST_ACCOUNT), ALICE_PRIMARY_STORE, "Snapshot retains exact wallet/store registration bindings");
  equal(decoded.projection.registeredWalletCount, 1n, "Snapshot retains the exact on-chain registration count");
  equal(decoded.projection.seenEventIds.get("sell-receipt"), "5:3", "Snapshot retains identifier-reuse witness state");

  const restarted = new EventIndexer(store);
  await restarted.restoreLatestSnapshot();
  const overlap = await restarted.process([...bootstrapEvents(), ...validSellEvents()]);
  equal(overlap.processedEvents, 0, "Cursor restart must not replay snapshotted events");
  equal(overlap.skippedEvents, 17, "Overlapping events must be skipped exactly once");
  const report = await restarted.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(restarted.getProjection(), 7n),
  });
  equal(report.reconciled, true, "Every core, custody, LP vault, position, and reserve field must reconcile exactly");
});

test("liability is calculated from shares, index, corrections, and settlements—not copied from a vault", async () => {
  const indexer = await bootstrappedIndexer();
  const projection = indexer.getProjection();
  const calculated = coreIndexedLiability(projection);
  const report = await indexer.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
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
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
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
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 5n, {
      custodyReserveBalance: projection.custody.shares - 1n,
    }),
  });
  ok(report.alerts.some((entry) => entry.code === "RESERVE_CUSTODY"), "Raw reserve/custody mismatch must be critical");

  const usdBinding = await clean.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 5n, {
      mockUsdPoolReserve: "0x9999",
    }),
  });
  ok(
    usdBinding.alerts.some((entry) => entry.code === "VAULT_BINDING" && entry.id.includes("pool-tusd-reserve")),
    "A tUSD settlement-capability reserve mismatch must be critical",
  );
});

test("mock tUSD reserve binding normalizes as immutable deployment evidence", () => {
  const normalized = eventNormalizer().normalize({
    typeTag: "0xbabe::mock_usd::PoolReserveBound",
    data: { reserve_store: USD_RESERVE, custodian: "0xdead" },
    txHash: "0xpool-reserve",
    ledgerVersion: 2n,
    eventIndex: 2,
    timestampUnixMilliseconds: 2_000n,
  });
  if (normalized === null || normalized.type !== "PoolReserveBound") {
    throw new Error("PoolReserveBound must normalize from the exact asset package");
  }
  equal(normalized.reserveStore, USD_RESERVE, "Normalizer retains the exact tUSD reserve store");
  equal(normalized.custodian, "0xdead", "Normalizer retains the reserve-owning AMM publisher");
  equal(
    thrownBy(() => eventNormalizer().normalize({
      typeTag: "0xbabe::mock_usd::PoolReserveBound",
      data: { reserve_store: USD_RESERVE, custodian: "0xdead" },
      txHash: "0xinvalid-cursor",
      ledgerVersion: -1n,
      eventIndex: 0,
      timestampUnixMilliseconds: 2_000n,
    })) instanceof TypeError,
    true,
    "Negative or oversized chain cursors fail before event replay",
  );
});

test("liquidity-limit events normalize, replay, and reconcile every field exactly", async () => {
  const normalizer = eventNormalizer();
  const normalized = normalizer.normalize({
    typeTag: "0xdead::pool::LiquidityLimitsChanged",
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
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 6n),
  });
  equal(clean.reconciled, true, "Matching finalized liquidity-limit views must reconcile cleanly");

  const mismatch = await indexer.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
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
  const normalizer = eventNormalizer();
  const envelope = {
    typeTag: "0xcafe::reflection_events::ProtocolInitialized",
    data: {
      version: "1",
      release_major: "0",
      release_minor: "1",
      release_patch: "0",
      deployment_id: Array.from(new TextEncoder().encode("reflection-pilot-001")),
      network_label: Array.from(new TextEncoder().encode("cedra-testnet")),
      metadata: TOKEN_METADATA,
      reward_vault: CORE_REWARD_VAULT,
      distribution_vault: DISTRIBUTION_VAULT,
      automatic_materialization: false,
      initial_fee_bps: "100",
      protocol_exclusion_slots: "2",
    },
    txHash: "0xmode-init",
    ledgerVersion: 1n,
    eventIndex: 0,
    timestampUnixMilliseconds: 1_000n,
  } as const;
  const normalized = normalizer.normalize(envelope);
  if (normalized === null || normalized.type !== "ProtocolInitialized") {
    throw new Error("Protocol initialization must normalize");
  }
  equal(normalized.automaticMaterialization, false, "Claim-backed mode must survive normalization");
  equal(normalized.packageVersion, "testnet-v0.1.0", "Semantic release identity is distinct from state schema version");

  equal(
    thrownBy(() => eventNormalizer().normalize({
      ...envelope,
      data: { ...(envelope.data as Record<string, unknown>), version: "2" },
    })) instanceof TypeError,
    true,
    "Unknown event schemas fail closed instead of being replayed as version 1",
  );

  const indexer = await bootstrappedIndexer();
  const projection = indexer.getProjection();
  const report = await indexer.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 5n, {
      automaticMaterialization: true,
    }),
  });
  ok(
    report.alerts.some((alert) => alert.code === "CORE_ACCOUNTING" && alert.id.includes("materialization-mode")),
    "A mutable or mismatched mode view must fail reconciliation",
  );
});

test("faucet emergency pause normalizes, replays, and reconciles", async () => {
  const normalizer = eventNormalizer();
  const configured = normalizer.normalize({
    typeTag: "0xbabe::test_faucet::FaucetConfigured",
    data: { trfl_grant: "200", tusd_grant: "300", cooldown_seconds: "120" },
    txHash: "0xfaucet-controls",
    ledgerVersion: 6n,
    eventIndex: 0,
    timestampUnixMilliseconds: 6_000n,
  });
  const normalized = normalizer.normalize({
    typeTag: "0xbabe::test_faucet::FaucetPauseChanged",
    data: { paused: true },
    txHash: "0xfaucet-controls",
    ledgerVersion: 6n,
    eventIndex: 1,
    timestampUnixMilliseconds: 6_000n,
  });
  if (
    configured === null
    || configured.type !== "FaucetConfigured"
    || normalized === null
    || normalized.type !== "FaucetPauseChanged"
  ) {
    throw new Error("Faucet configuration and pause must normalize from the exact asset package");
  }
  const indexer = await bootstrappedIndexer();
  const replay = await indexer.process([configured, normalized]);
  equal(replay.alerts.length, 0, "Valid faucet configuration and pause events must commit atomically");
  equal(indexer.getProjection().faucetPaused, true, "Replay retains the emergency faucet state");
  equal(indexer.getProjection().faucetTrflGrant, 200n, "Replay retains the evented tRFL grant");

  const projection = indexer.getProjection();
  const mismatch = await indexer.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 6n, {
      faucetPaused: false,
      faucetCooldownSeconds: 121n,
    }),
  });
  ok(mismatch.alerts.some((entry) => entry.code === "PAUSE_STATE"), "A faucet pause/view mismatch must be critical");
  ok(mismatch.alerts.some((entry) => entry.code === "FAUCET_CONFIG"), "A faucet configuration/view mismatch must be critical");
});

test("routes to an old claim-only LP epoch are rejected", async () => {
  const indexer = await bootstrappedIndexer();
  await indexer.process(routeEvents(indexer.getProjection()));
  await indexer.process([lpClaimEvent(indexer.getProjection())]);
  const preShutdown = indexer.getProjection();
  const shutdown = await indexer.process([{
    ...at("0xshutdown", 8n, 0, "shutdown-before-final-exit"),
    type: "PoolPauseChanged",
    poolPaused: true,
    liquidityPaused: false,
    lpClaimsPaused: false,
    shutdownMode: true,
  }]);
  equal(shutdown.alerts.length, 0, "Shutdown must be committed before the final exit transaction");
  const beforeExit = indexer.getProjection();
  const epoch = beforeExit.lpEpochs.get(1n)!;
  const owner = epoch.positions.get(TEST_ACCOUNT)!;
  const reserveRfl = beforeExit.pool.trflReserve;
  const reserveUsd = beforeExit.pool.tusdReserve;
  const walletOnlyShares = beforeExit.eligibleSupply - beforeExit.custody.shares;
  const exit: readonly ProtocolEvent[] = [
    { ...at("0xexit", 9n, 0, "exit-lp"), type: "LpSharesChanged", epoch: 1n, owner: TEST_ACCOUNT, added: false, amount: owner.shares, ownerShares: 0n, totalShares: 0n },
    { ...at("0xexit", 9n, 1, "exit-custody"), type: "CustodySharesChanged", added: false, amount: reserveRfl, custodyShares: 0n, globalShares: walletOnlyShares },
    { ...at("0xexit", 9n, 2, "exit-status"), type: "LpEpochStatusChanged", epoch: 1n, oldStatus: "active", newStatus: "claim-only" },
    {
      ...at("0xexit", 9n, 3, "exit-terminal-dust"),
      type: "LpEpochTerminalDustClassified",
      epoch: 1n,
      rewardVault: epoch.rewardVault,
      terminalRoundingBaseUnits: epoch.roundingReserve,
      retiredResidueMagnified: epoch.retiredResidueMagnified,
      lifetimeReceivedBaseUnits: epoch.lifetimeReceived,
      lifetimeClaimedBaseUnits: epoch.lifetimeClaimed,
    },
    {
      ...at("0xexit", 9n, 4, "exit-receipt"),
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
  ok(
    reduceEventGroup(preShutdown, exit).alerts.some((entry) => entry.code === "LP_ACCOUNTING"),
    "A final receipt without shutdown committed in a prior transaction is rejected",
  );
  const receiptBeforeClassification = exit.map((event) => event.type === "LiquidityRemoved"
    ? { ...event, eventIndex: 3 }
    : event.type === "LpEpochTerminalDustClassified"
      ? { ...event, eventIndex: 4 }
      : event);
  ok(
    reduceEventGroup(beforeExit, receiptBeforeClassification).alerts.some((entry) => entry.code === "LP_ACCOUNTING"),
    "A final receipt cannot precede its terminal-dust classification",
  );
  ok(
    reduceEventGroup(beforeExit, exit.filter((event) => event.type !== "LpEpochStatusChanged")).alerts.some((entry) => entry.code === "LP_ACCOUNTING"),
    "A final receipt without its active-to-claim-only transition is rejected",
  );
  const exited = await indexer.process(exit);
  equal(exited.alerts.length, 0, "Valid final exit must preserve old claim history");
  const afterExit = indexer.getProjection();
  equal(afterExit.pool.shutdownMode, false, "The terminal receipt clears replayed shutdown mode exactly as the contract does");
  const retiredResidueMagnified = afterExit.custody.correction
    - afterExit.custody.claimed * REFLECTION_MAGNITUDE;
  const opened = await indexer.process([
    { ...at("0xepoch2", 10n, 0, "epoch-2"), type: "LpEpochOpened", epoch: 2n, stateId: LP_STATE_2, rewardVault: SECOND_LP_VAULT },
    {
      ...at("0xepoch2", 10n, 1, "route-open-2"),
      type: "CustodyEpochRouteOpened",
      adapterId: 1n,
      epoch: 2n,
      reserveStore: CUSTODY_RESERVE,
      lpRewardVault: SECOND_LP_VAULT,
      retiredResidueMagnified,
    },
  ]);
  equal(opened.alerts.length, 0, "Fresh epoch may open after old epoch becomes claim-only");
  equal(
    indexer.getProjection().custody.correction,
    afterExit.custody.correction - retiredResidueMagnified,
    "Fresh route retires the exact prior-epoch custody correction residue",
  );
  const oldRoute: readonly ProtocolEvent[] = [
    { ...at("0xold-route", 11n, 0, "old-route"), type: "CustodyRewardsRouted", reserveStore: CUSTODY_RESERVE, lpRewardVault: LP_REWARD_VAULT, epoch: 1n, amount: 1n, totalRouted: beforeExit.custody.claimed + 1n },
    { ...at("0xold-route", 11n, 1, "old-lp-index"), type: "LpRewardIndexAdvanced", epoch: 1n, previousIndex: epoch.index, newIndex: epoch.index, indexRemainder: epoch.indexRemainder, received: 1n, totalShares: 0n, roundingReserve: 0n },
  ];
  const rejected = await indexer.process(oldRoute);
  ok(rejected.alerts.some((entry) => entry.code === "OLD_EPOCH_ROUTE"), "A route to a claim-only historical epoch must be critical");
  equal(indexer.getCursor()?.ledgerVersion, 10n, "Old-epoch route cannot advance the checkpoint");
});

test("wallet registrations are exact-once, store-unique, replay-idempotent, and independently reconciled", async () => {
  const indexer = await bootstrappedIndexer(false);
  const reversed = reduceEventGroup(indexer.getProjection(), [
    { ...at("0xreversed-registration", 5n, 0, "reversed-position"), type: "PositionCreated", account: TEST_BOB },
    { ...at("0xreversed-registration", 5n, 1, "reversed-balance"), type: "FaucetGrant", account: TEST_BOB, asset: "tRFL", amount: 1n },
    {
      ...at("0xreversed-registration", 5n, 2, "reversed-registration"),
      type: "WalletRegistered",
      account: TEST_BOB,
      primaryStore: BOB_PRIMARY_STORE,
      registeredWalletCount: 2n,
    },
  ]);
  ok(
    reversed.alerts.some((entry) => entry.code === "WALLET_REGISTRATION"),
    "WalletRegistered must precede every same-transaction position and tRFL balance mutation",
  );
  const duplicateAccount = await indexer.process([{
    ...at("0xduplicate-registration", 5n, 0, "duplicate-registration"),
    type: "WalletRegistered",
    account: TEST_ACCOUNT,
    primaryStore: BOB_PRIMARY_STORE,
    registeredWalletCount: 2n,
  }]);
  ok(duplicateAccount.alerts.some((entry) => entry.code === "WALLET_REGISTRATION"), "An account cannot register twice");
  equal(indexer.getCursor()?.ledgerVersion, 4n, "Rejected registration cannot advance replay");

  const duplicateStore = await indexer.process([{
    ...at("0xduplicate-store", 5n, 0, "duplicate-store"),
    type: "WalletRegistered",
    account: TEST_BOB,
    primaryStore: ALICE_PRIMARY_STORE,
    registeredWalletCount: 2n,
  }]);
  ok(duplicateStore.alerts.some((entry) => entry.code === "WALLET_REGISTRATION"), "A primary store cannot bind to two accounts");

  const skippedCount = await indexer.process([{
    ...at("0xskipped-count", 5n, 0, "skipped-count"),
    type: "WalletRegistered",
    account: TEST_BOB,
    primaryStore: BOB_PRIMARY_STORE,
    registeredWalletCount: 3n,
  }]);
  ok(skippedCount.alerts.some((entry) => entry.code === "WALLET_REGISTRATION"), "Registration count cannot skip a value");

  const registration: readonly ProtocolEvent[] = [
    {
      ...at("0xbob-registration", 6n, 0, "bob-registration-exact"),
      type: "WalletRegistered",
      account: TEST_BOB,
      primaryStore: BOB_PRIMARY_STORE,
      registeredWalletCount: 2n,
    },
    { ...at("0xbob-registration", 6n, 1, "bob-position-exact"), type: "PositionCreated", account: TEST_BOB },
  ];
  const accepted = await indexer.process(registration);
  equal(accepted.alerts.length, 0, "Fresh account/store registration and position creation commit atomically");
  equal(indexer.getProjection().registeredWallets.get(TEST_BOB), BOB_PRIMARY_STORE, "Replay retains the exact primary-store binding");
  equal(indexer.getProjection().registeredWalletCount, 2n, "Replay retains the exact cumulative registration count");
  const replay = await indexer.process(registration);
  equal(replay.processedEvents, 0, "Overlapping registration evidence is skipped at its committed cursor");
  equal(replay.skippedEvents, registration.length, "Every overlapping registration event is skipped exactly once");

  const registeredExclusion = await indexer.process([{
    ...at("0xregistered-exclusion", 7n, 0, "registered-exclusion"),
    type: "OperationalPrimaryStoreExcluded",
    account: TEST_BOB,
    store: BOB_PRIMARY_STORE,
  }]);
  ok(registeredExclusion.alerts.some((entry) => entry.code === "IDENTIFIER_REUSE"), "A registered wallet/store cannot later be reclassified as excluded");

  const projection = indexer.getProjection();
  const mismatch = reconcile(
    projection,
    observedFromProjection(projection, 6n, {
      registeredWalletCount: 1n,
      registeredWalletAccounts: [TEST_ACCOUNT],
    }),
    indexer.getCursor(),
  );
  ok(mismatch.alerts.some((entry) => entry.code === "WALLET_REGISTRATION"), "Finalized registration count/set divergence is critical");

  const poisonedProjection: ProtocolProjection = {
    ...projection,
    protocolExcludedStores: new Map([[TEST_BOB, BOB_PRIMARY_STORE]]),
  };
  equal(
    thrownBy(() => decodeSnapshot(encodeSnapshot(takeSnapshot({
      projection: poisonedProjection,
      cursor: indexer.getCursor(),
      takenAtUnixMilliseconds: 1n,
    })))) instanceof TypeError,
    true,
    "Snapshot decoder rejects a registered account/store that overlaps the exclusion registry",
  );
});

test("LP ownership requires deterministic earlier wallet registration for initial mint and transfer recipients", async () => {
  const indexer = await bootstrappedIndexer(false);
  const prior = indexer.getProjection();
  const transferWithoutRegistration: ProtocolEvent = {
    ...at("0xlp-unregistered-recipient", 5n, 0, "lp-unregistered-recipient"),
    type: "LpSharesTransferred",
    epoch: 1n,
    sender: TEST_ACCOUNT,
    recipient: TEST_BOB,
    amount: 10n,
  };
  ok(
    reduceEventGroup(prior, [transferWithoutRegistration]).alerts.some((entry) => entry.code === "WALLET_REGISTRATION"),
    "An LP transfer cannot create positive recipient weight without prior registration",
  );

  const registrationAfterTransfer: readonly ProtocolEvent[] = [
    transferWithoutRegistration,
    {
      ...at("0xlp-unregistered-recipient", 5n, 1, "late-lp-registration"),
      type: "WalletRegistered",
      account: TEST_BOB,
      primaryStore: BOB_PRIMARY_STORE,
      registeredWalletCount: 2n,
    },
  ];
  ok(
    reduceEventGroup(prior, registrationAfterTransfer).alerts.some((entry) => entry.code === "WALLET_REGISTRATION"),
    "A later same-transaction registration cannot retroactively authorize earlier LP weight",
  );

  const registrationBeforeTransfer: readonly ProtocolEvent[] = [
    {
      ...at("0xlp-registered-recipient", 5n, 0, "early-lp-registration"),
      type: "WalletRegistered",
      account: TEST_BOB,
      primaryStore: BOB_PRIMARY_STORE,
      registeredWalletCount: 2n,
    },
    {
      ...at("0xlp-registered-recipient", 5n, 1, "lp-registered-recipient"),
      type: "LpSharesTransferred",
      epoch: 1n,
      sender: TEST_ACCOUNT,
      recipient: TEST_BOB,
      amount: 10n,
    },
  ];
  const accepted = await indexer.process(registrationBeforeTransfer);
  equal(accepted.alerts.length, 0, "Earlier same-transaction registration deterministically authorizes the LP recipient");
  equal(indexer.getProjection().lpEpochs.get(1n)?.positions.get(TEST_BOB)?.shares, 10n, "Registered recipient receives exact LP weight");

  const acceptedProjection = indexer.getProjection();
  const poisonedRegistrations = new Map(acceptedProjection.registeredWallets);
  poisonedRegistrations.delete(TEST_BOB);
  const poisonedProjection: ProtocolProjection = {
    ...acceptedProjection,
    registeredWallets: poisonedRegistrations,
    registeredWalletCount: 1n,
  };
  equal(
    thrownBy(() => decodeSnapshot(encodeSnapshot(takeSnapshot({
      projection: poisonedProjection,
      cursor: indexer.getCursor(),
      takenAtUnixMilliseconds: 1n,
    })))) instanceof TypeError,
    true,
    "Snapshot state cannot retain a positive LP position after its wallet registration is removed",
  );

  const empty = createEmptyProjection();
  const emptyEpoch: IndexedLpEpoch = {
    epoch: 1n,
    stateId: LP_STATE_1,
    status: "active",
    rewardVault: LP_REWARD_VAULT,
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
    positions: new Map(),
  };
  const emptyActiveEpoch: ProtocolProjection = {
    ...empty,
    activeLpEpoch: 1n,
    lpEpochs: new Map([[1n, emptyEpoch]]),
    rewardVaultToEpoch: new Map([[LP_REWARD_VAULT, 1n]]),
    stateIdToEpoch: new Map([[LP_STATE_1, 1n]]),
  };
  const initialMint = reduceEventGroup(emptyActiveEpoch, [{
    ...at("0xunregistered-initial-lp", 1n, 0, "unregistered-initial-lp"),
    type: "LpSharesChanged",
    epoch: 1n,
    owner: TEST_BOB,
    added: true,
    amount: 1n,
    ownerShares: 1n,
    totalShares: 1n,
  }]);
  ok(
    initialMint.alerts.some((entry) => entry.code === "WALLET_REGISTRATION"),
    "The first LP owner cannot receive initial shares before WalletRegistered evidence",
  );
});

test("LP reconciliation independently requires registered replay and observed owners", async () => {
  const indexer = await bootstrappedIndexer(false);
  const projection = indexer.getProjection();
  const cursor = indexer.getCursor();
  const control = reconcile(
    projection,
    observedFromProjection(projection, cursor!.ledgerVersion),
    cursor,
  );
  equal(control.alerts.length, 0, "Matching registered LP ownership reconciles cleanly");

  const unregisteredProjection: ProtocolProjection = {
    ...projection,
    registeredWallets: new Map(),
    registeredWalletCount: 0n,
  };
  const unregistered = reconcile(
    unregisteredProjection,
    observedFromProjection(unregisteredProjection, cursor!.ledgerVersion),
    cursor,
  );
  ok(
    unregistered.alerts.some((entry) => (
      entry.code === "WALLET_REGISTRATION"
      && entry.message.includes("Replayed positive LP ownership")
    )),
    "Matching replay state still rejects a positive LP owner absent from replayed registrations",
  );
  ok(
    unregistered.alerts.some((entry) => (
      entry.code === "WALLET_REGISTRATION"
      && entry.message.includes("Observed positive LP ownership")
    )),
    "Matching observed state still rejects a positive LP owner absent from finalized registrations",
  );
  equal(unregistered.reconciled, false, "Unregistered matching LP ownership cannot reconcile");
});

test("Move u256 arithmetic accepts the maximum result and rejects the first out-of-range intermediate", () => {
  const maximumU256 = (1n << 256n) - 1n;
  equal(checkedMoveU256Multiply(maximumU256, 1n, "maximum multiplication"), maximumU256, "Largest valid u256 multiplication result is accepted");
  equal(checkedMoveU256Add(maximumU256, 0n, "maximum addition"), maximumU256, "Largest valid u256 addition result is accepted");
  equal(checkedMoveU256Subtract(maximumU256, 0n, "maximum subtraction"), maximumU256, "Largest valid u256 subtraction result is accepted");
  equal(applyMoveSignedU256(maximumU256, 0n, "maximum correction application"), maximumU256, "Largest valid corrected u256 is accepted");
  equal(checkedMoveSignedU256AddUnsigned(maximumU256 - 1n, 1n, "maximum signed correction"), maximumU256, "Largest valid positive correction magnitude is accepted");
  equal(checkedMoveSignedU256SubtractUnsigned(-(maximumU256 - 1n), 1n, "minimum signed correction"), -maximumU256, "Largest valid negative correction magnitude is accepted");
  const accumulateCorrections = (values: readonly bigint[]): bigint => values.reduce(
    (sum, value) => checkedMoveSignedU256Add(sum, value, "ordered correction accumulation"),
    0n,
  );
  equal(accumulateCorrections([maximumU256]), maximumU256, "Ordered correction accumulation accepts the maximum valid magnitude");
  equal(accumulateCorrections([maximumU256, -maximumU256]), 0n, "Ordered maximum correction cancellation remains valid");
  equal(
    thrownBy(() => accumulateCorrections([maximumU256, 1n, -1n])) instanceof RangeError,
    true,
    "Ordered [MAX,+1,-1] corrections reject the first overflowing intermediate",
  );
  const correctionAccounts = ["0xc001", "0xc002", "0xc003"] as const satisfies readonly Address[];
  const correctionStores = ["0xd001", "0xd002", "0xd003"] as const satisfies readonly Address[];
  const correctionProjection = (corrections: readonly bigint[], aggregateCorrection: bigint): ProtocolProjection => {
    const gross = aggregateCorrection < 0n ? 0n : aggregateCorrection / REFLECTION_MAGNITUDE;
    return {
      ...createEmptyProjection(),
      registeredWallets: new Map(corrections.map((_, index) => [correctionAccounts[index]!, correctionStores[index]!])),
      registeredWalletCount: BigInt(corrections.length),
      positions: new Map(corrections.map((correction, index) => [correctionAccounts[index]!, {
        account: correctionAccounts[index]!,
        rawTrfl: 0n,
        rawTusd: 0n,
        correction,
        claimed: 0n,
        lifetimeClaimed: 0n,
        lifetimeMaterialized: 0n,
      }])),
      aggregateCorrection,
      rewardVaultCredits: gross,
      lifetimeSwapFees: gross,
    };
  };
  const inertConfigurationEvent: ProtocolEvent = {
    ...at("0xcorrection-accumulation", 1n, 0, "correction-accumulation"),
    type: "FaucetConfigured",
    trflGrant: 1n,
    tusdGrant: 1n,
    cooldownSeconds: 1n,
  };
  equal(
    reduceEventGroup(correctionProjection([maximumU256], maximumU256), [inertConfigurationEvent]).alerts.length,
    0,
    "Reducer transaction-end core accumulation accepts an exact maximum correction",
  );
  equal(
    reduceEventGroup(correctionProjection([maximumU256, -maximumU256], 0n), [inertConfigurationEvent]).alerts.length,
    0,
    "Reducer transaction-end core accumulation accepts in-domain cancellation",
  );
  const orderedOverflow = reduceEventGroup(
    correctionProjection([maximumU256, 1n, -1n], maximumU256),
    [inertConfigurationEvent],
  );
  ok(
    orderedOverflow.alerts.some((entry) => (
      entry.code === "EVENT_DATA" && entry.message.includes("summed core position correction")
    )),
    "Reducer rejects [MAX,+1,-1] at the first overflowing aggregate-correction intermediate",
  );

  const rejected = [
    () => checkedMoveU256Multiply(maximumU256, 2n, "multiplication overflow"),
    () => checkedMoveU256Add(maximumU256, 1n, "addition overflow"),
    () => checkedMoveU256Subtract(0n, 1n, "subtraction underflow"),
    () => applyMoveSignedU256(maximumU256, 1n, "correction overflow"),
    () => checkedMoveSignedU256AddUnsigned(maximumU256, 1n, "positive correction overflow"),
    () => checkedMoveSignedU256SubtractUnsigned(-maximumU256, 1n, "negative correction overflow"),
  ];
  for (const calculate of rejected) {
    equal(thrownBy(calculate) instanceof RangeError, true, "The first result outside Move u256 is rejected");
  }

  const base = createEmptyProjection();
  const registered: ProtocolProjection = {
    ...base,
    currentIndex: maximumU256,
    registeredWallets: new Map([[TEST_ACCOUNT, ALICE_PRIMARY_STORE]]),
    registeredWalletCount: 1n,
  };
  const accepted = reduceEventGroup(registered, [{
    ...at("0xmaximum-correction", 1n, 0, "maximum-correction"),
    type: "FaucetGrant",
    account: TEST_ACCOUNT,
    asset: "tRFL",
    amount: 1n,
  }]);
  equal(accepted.alerts.length, 0, "Reducer accepts a correction delta exactly equal to Move u256::MAX");
  equal(accepted.projection.positions.get(TEST_ACCOUNT)?.correction, -maximumU256, "Maximum valid correction is retained exactly");

  const overflow = reduceEventGroup(registered, [{
    ...at("0xoverflow-correction", 1n, 0, "overflow-correction"),
    type: "FaucetGrant",
    account: TEST_ACCOUNT,
    asset: "tRFL",
    amount: 2n,
  }]);
  ok(overflow.alerts.some((entry) => entry.code === "EVENT_DATA"), "Reducer rejects an overflowing correction multiplication before state mutation commits");
  equal(overflow.projection.positions.size, 0, "Rejected intermediate overflow restores the prior position state");
});

test("fractional LP residue and terminal dust form one ordered, exact-unit lifecycle", () => {
  const empty = createEmptyProjection();
  const active: IndexedLpEpoch = {
    epoch: 1n,
    stateId: LP_STATE_1,
    status: "active",
    rewardVault: LP_REWARD_VAULT,
    index: 1n,
    indexRemainder: 0n,
    totalShares: 3n,
    aggregateCorrection: 0n,
    unallocatedRewards: 0n,
    roundingReserve: 0n,
    retiredResidueMagnified: 0n,
    terminalRoundingBaseUnits: null,
    lifetimeReceived: 0n,
    lifetimeClaimed: 0n,
    quarantined: false,
    positions: new Map([[TEST_ACCOUNT, { owner: TEST_ACCOUNT, shares: 3n, correction: 0n, claimed: 0n }]]),
  };
  const prior: ProtocolProjection = {
    ...empty,
    registeredWallets: new Map([[TEST_ACCOUNT, ALICE_PRIMARY_STORE]]),
    registeredWalletCount: 1n,
    activeLpEpoch: 1n,
    lpEpochs: new Map([[1n, active]]),
    rewardVaultToEpoch: new Map([[LP_REWARD_VAULT, 1n]]),
    stateIdToEpoch: new Map([[LP_STATE_1, 1n]]),
  };
  const lifecycle: readonly ProtocolEvent[] = [
    {
      ...at("0xfractional-exit", 1n, 0, "fractional-residue"),
      type: "LpFractionalResidueRetired",
      epoch: 1n,
      owner: TEST_ACCOUNT,
      residueMagnified: 3n,
      cumulativeRetiredResidueMagnified: 3n,
      roundingReserveBaseUnits: 0n,
    },
    { ...at("0xfractional-exit", 1n, 1, "fractional-burn"), type: "LpSharesChanged", epoch: 1n, owner: TEST_ACCOUNT, added: false, amount: 3n, ownerShares: 0n, totalShares: 0n },
    { ...at("0xfractional-exit", 1n, 2, "fractional-status"), type: "LpEpochStatusChanged", epoch: 1n, oldStatus: "active", newStatus: "claim-only" },
    {
      ...at("0xfractional-exit", 1n, 3, "fractional-terminal"),
      type: "LpEpochTerminalDustClassified",
      epoch: 1n,
      rewardVault: LP_REWARD_VAULT,
      terminalRoundingBaseUnits: 0n,
      retiredResidueMagnified: 3n,
      lifetimeReceivedBaseUnits: 0n,
      lifetimeClaimedBaseUnits: 0n,
    },
  ];
  const accepted = reduceEventGroup(prior, lifecycle);
  equal(accepted.alerts.length, 0, "Exact residue retirement and terminal classification must replay atomically");
  const terminal = accepted.projection.lpEpochs.get(1n)!;
  equal(terminal.retiredResidueMagnified, 3n, "Fractional magnified units are retained separately from physical base units");
  equal(terminal.terminalRoundingBaseUnits, 0n, "Terminal physical rounding is retained in base units");
  equal(terminal.aggregateCorrection, 0n, "Residue retirement normalizes aggregate correction after the complete exit");

  const missingTerminal = reduceEventGroup(prior, lifecycle.slice(0, 3));
  ok(missingTerminal.alerts.some((entry) => entry.code === "LP_ACCOUNTING"), "Status transition without terminal classification is rejected");
  const wrongResidue = reduceEventGroup(prior, lifecycle.map((event) => event.type === "LpFractionalResidueRetired"
    ? { ...event, residueMagnified: 4n, cumulativeRetiredResidueMagnified: 4n }
    : event));
  ok(wrongResidue.alerts.some((entry) => entry.code === "LP_ACCOUNTING"), "A one-magnified-unit residue mutation is rejected");
  const reorderedTerminal = lifecycle.map((event) => event.type === "LpEpochTerminalDustClassified"
    ? { ...event, eventIndex: 1 }
    : event.type === "LpSharesChanged"
      ? { ...event, eventIndex: 2 }
      : event.type === "LpEpochStatusChanged"
        ? { ...event, eventIndex: 3 }
        : event);
  ok(reduceEventGroup(prior, reorderedTerminal).alerts.some((entry) => entry.code === "LP_ACCOUNTING"), "Terminal classification cannot precede its status transition");

  const snapshot = takeSnapshot({
    projection: accepted.projection,
    cursor: { ledgerVersion: 1n, eventIndex: 3 },
    takenAtUnixMilliseconds: 1n,
  });
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  equal(decoded.projection.lpEpochs.get(1n)?.retiredResidueMagnified, 3n, "Snapshot round-trip preserves magnified retired residue");
  equal(decoded.projection.lpEpochs.get(1n)?.terminalRoundingBaseUnits, 0n, "Snapshot round-trip preserves terminal base units");
  const overflow = {
    ...accepted.projection,
    lpEpochs: new Map([[1n, { ...terminal, terminalRoundingBaseUnits: 1n << 128n }]]),
  };
  equal(
    thrownBy(() => decodeSnapshot(encodeSnapshot(takeSnapshot({
      projection: overflow,
      cursor: { ledgerVersion: 1n, eventIndex: 3 },
      takenAtUnixMilliseconds: 1n,
    })))) instanceof TypeError,
    true,
    "Snapshot decoder rejects terminal base units outside Move u128",
  );

  const rejectsProjection = (projection: ProtocolProjection): boolean => (
    thrownBy(() => takeSnapshot({
      projection,
      cursor: { ledgerVersion: 1n, eventIndex: 3 },
      takenAtUnixMilliseconds: 1n,
    })) instanceof TypeError
  );
  equal(
    rejectsProjection({ ...accepted.projection, rewardVaultToEpoch: new Map() }),
    true,
    "Snapshot rejects an incomplete reward-vault-to-epoch index",
  );
  equal(
    rejectsProjection({ ...accepted.projection, stateIdToEpoch: new Map([[LP_STATE_1, 2n]]) }),
    true,
    "Snapshot rejects a state-id index that does not map to its exact LP epoch",
  );
  equal(
    rejectsProjection({ ...accepted.projection, activeLpEpoch: 1n }),
    true,
    "Snapshot rejects an active epoch pointer whose epoch is already claim-only",
  );
  equal(
    rejectsProjection({ ...accepted.projection, eligibleSupply: 1n << 128n }),
    true,
    "Snapshot rejects a projection value exactly equal to 2^128",
  );
  equal(
    rejectsProjection({ ...accepted.projection, currentIndex: 1n << 256n }),
    true,
    "Snapshot rejects a projection value exactly equal to 2^256",
  );
  equal(
    rejectsProjection({
      ...accepted.projection,
      pool: { ...accepted.projection.pool, trflReserve: 1n << 64n },
    }),
    true,
    "Snapshot rejects a projection value exactly equal to 2^64",
  );
  equal(
    rejectsProjection({ ...accepted.projection, aggregateCorrection: 1n << 256n }),
    true,
    "Snapshot rejects a signed correction whose magnitude exceeds Move u256",
  );
  equal(
    rejectsProjection({
      ...accepted.projection,
      seenEventIds: new Map([["overflow-cursor", `${(1n << 64n).toString()}:0`]]),
    }),
    true,
    "Snapshot rejects a persisted event cursor whose ledger equals 2^64",
  );
  equal(
    thrownBy(() => takeSnapshot({
      projection: accepted.projection,
      cursor: { ledgerVersion: 1n << 64n, eventIndex: 0 },
      takenAtUnixMilliseconds: 1n,
    })) instanceof RangeError,
    true,
    "Snapshot cursor ledger rejects exactly 2^64",
  );
  equal(
    thrownBy(() => takeSnapshot({
      projection: accepted.projection,
      cursor: { ledgerVersion: 1n, eventIndex: 0 },
      takenAtUnixMilliseconds: 1n << 64n,
    })) instanceof RangeError,
    true,
    "Snapshot timestamp rejects exactly 2^64",
  );
});

test("one-sided non-final liquidity removal is accepted only during shutdown and reconciles exactly", async () => {
  const indexer = await bootstrappedIndexer(false);
  const base = indexer.getProjection();
  const shutdown: ProtocolProjection = {
    ...base,
    pool: { ...base.pool, tusdReserve: 1n, shutdownMode: true },
  };
  const epoch = shutdown.lpEpochs.get(1n)!;
  const owner = epoch.positions.get(TEST_ACCOUNT)!;
  const events: readonly ProtocolEvent[] = [
    {
      ...at("0xone-sided-shutdown", 6n, 0, "one-sided-lp-burn"),
      type: "LpSharesChanged",
      epoch: 1n,
      owner: TEST_ACCOUNT,
      added: false,
      amount: 1n,
      ownerShares: owner.shares - 1n,
      totalShares: epoch.totalShares - 1n,
    },
    {
      ...at("0xone-sided-shutdown", 6n, 1, "one-sided-custody"),
      type: "CustodySharesChanged",
      added: false,
      amount: 1n,
      custodyShares: shutdown.custody.shares - 1n,
      globalShares: shutdown.eligibleSupply - 1n,
    },
    {
      ...at("0xone-sided-shutdown", 6n, 2, "one-sided-receipt"),
      type: "LiquidityRemoved",
      epoch: 1n,
      provider: TEST_ACCOUNT,
      trflAmount: 1n,
      tusdAmount: 0n,
      lpShares: 1n,
      finalExit: false,
      trflReserveAfter: shutdown.pool.trflReserve - 1n,
      tusdReserveAfter: 1n,
    },
  ];
  const accepted = reduceEventGroup(shutdown, events);
  equal(accepted.alerts.length, 0, "A proportional one-sided shutdown withdrawal must replay without a false positive");
  const reconciled = reconcile(
    accepted.projection,
    observedFromProjection(accepted.projection, 6n),
    { ledgerVersion: 6n, eventIndex: 2 },
  );
  equal(reconciled.reconciled, true, "One-sided shutdown settlement must reconcile every resulting balance and share exactly");

  const liveMode = reduceEventGroup({ ...shutdown, pool: { ...shutdown.pool, shutdownMode: false } }, events);
  ok(liveMode.alerts.some((entry) => entry.code === "EVENT_DATA"), "One-sided liquidity output is forbidden outside shutdown");
  const bothZero = reduceEventGroup(shutdown, events.map((event) => event.type === "LiquidityRemoved"
    ? { ...event, trflAmount: 0n, trflReserveAfter: shutdown.pool.trflReserve }
    : event.type === "CustodySharesChanged"
      ? { ...event, amount: 0n, custodyShares: shutdown.custody.shares, globalShares: shutdown.eligibleSupply }
      : event));
  ok(bothZero.alerts.some((entry) => entry.code === "EVENT_DATA"), "Both-zero liquidity output cannot burn LP shares even during shutdown");
});

test("non-final withdrawal share limit accepts the exact boundary, rejects plus one, and is bypassed only by prior shutdown", async () => {
  const indexer = await bootstrappedIndexer(false);
  const base = indexer.getProjection();
  const normal: ProtocolProjection = {
    ...base,
    pool: { ...base.pool, maximumNonFinalWithdrawalShareBps: 1_000n },
  };
  const withdrawal = (prior: ProtocolProjection, shares: bigint, suffix: string): readonly ProtocolEvent[] => {
    const epoch = prior.lpEpochs.get(1n)!;
    const owner = epoch.positions.get(TEST_ACCOUNT)!;
    const trflAmount = shares * prior.pool.trflReserve / epoch.totalShares;
    const tusdAmount = shares * prior.pool.tusdReserve / epoch.totalShares;
    return [
      {
        ...at(`0xwithdraw-${suffix}`, 5n, 0, `withdraw-${suffix}-shares`),
        type: "LpSharesChanged",
        epoch: 1n,
        owner: TEST_ACCOUNT,
        added: false,
        amount: shares,
        ownerShares: owner.shares - shares,
        totalShares: epoch.totalShares - shares,
      },
      {
        ...at(`0xwithdraw-${suffix}`, 5n, 1, `withdraw-${suffix}-custody`),
        type: "CustodySharesChanged",
        added: false,
        amount: trflAmount,
        custodyShares: prior.custody.shares - trflAmount,
        globalShares: prior.eligibleSupply - trflAmount,
      },
      {
        ...at(`0xwithdraw-${suffix}`, 5n, 2, `withdraw-${suffix}-receipt`),
        type: "LiquidityRemoved",
        epoch: 1n,
        provider: TEST_ACCOUNT,
        trflAmount,
        tusdAmount,
        lpShares: shares,
        finalExit: false,
        trflReserveAfter: prior.pool.trflReserve - trflAmount,
        tusdReserveAfter: prior.pool.tusdReserve - tusdAmount,
      },
    ];
  };

  const exact = reduceEventGroup(normal, withdrawal(normal, 100_000n, "exact"));
  equal(exact.alerts.length, 0, "Exactly 10% of active shares is permitted by a 1,000 bps cap");

  const plusOne = reduceEventGroup(normal, withdrawal(normal, 100_001n, "plus-one"));
  ok(plusOne.alerts.some((entry) => entry.code === "POOL_LIMITS"), "One share above the configured ratio is rejected");

  const shutdown = { ...normal, pool: { ...normal.pool, shutdownMode: true } };
  const bypass = reduceEventGroup(shutdown, withdrawal(shutdown, 100_001n, "shutdown"));
  equal(bypass.alerts.length, 0, "A committed shutdown bypasses the non-final withdrawal ratio so holders can unwind");
});

test("LP share transfer preserves accrued history and gives the recipient no retroactive reward", async () => {
  const indexer = await bootstrappedIndexer();
  await indexer.process(routeEvents(indexer.getProjection()));
  const before = indexer.getProjection().lpEpochs.get(1n)!;
  const aliceBefore = lpPositionPending(before.positions.get(TEST_ACCOUNT)!, before);
  ok(aliceBefore > 0n, "Fixture must contain accrued LP rewards before transfer");
  const result = await indexer.process([
    {
      ...at("0xlp-transfer", 7n, 0, "lp-transfer-recipient-registration"),
      type: "WalletRegistered",
      account: TEST_BOB,
      primaryStore: BOB_PRIMARY_STORE,
      registeredWalletCount: 2n,
    },
    {
      ...at("0xlp-transfer", 7n, 1, "lp-transfer"),
      type: "LpSharesTransferred",
      epoch: 1n,
      sender: TEST_ACCOUNT,
      recipient: TEST_BOB,
      amount: 500_000n,
    },
  ]);
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
  await indexer.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(
      indexer.getProjection(),
      indexer.getCursor()!.ledgerVersion,
    ),
  });
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
    retiredResidueMagnified: 0n,
    terminalRoundingBaseUnits: 0n,
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
    { ...at("0xtransfer", 5n, 1, "bob-registration"), type: "WalletRegistered", account: TEST_BOB, primaryStore: BOB_PRIMARY_STORE, registeredWalletCount: 2n },
    { ...at("0xtransfer", 5n, 2, "bob-position"), type: "PositionCreated", account: TEST_BOB },
    { ...at("0xtransfer", 5n, 3, "native-credit"), type: "EligibleBalanceCredited", account: TEST_BOB, amount: 40n },
    { ...at("0xtransfer", 5n, 4, "redundant-router"), type: "WalletTransfer", from: TEST_ACCOUNT, to: TEST_BOB, asset: "tRFL", amount: 40n },
  ]);
  equal(result.alerts.length, 0, "A complete redundant historical receipt must not double-count native hooks");
  equal(indexer.getProjection().positions.get(TEST_ACCOUNT)?.rawTrfl, 1_999_960n, "Native debit applies once");
  equal(indexer.getProjection().positions.get(TEST_BOB)?.rawTrfl, 40n, "Native credit applies once");
});

test("router receipts reconcile one-sided eligible transfers to and from excluded stores", async () => {
  const outgoing = await bootstrappedIndexer(false);
  const sentToExcluded = await outgoing.process([
    { ...at("0xexcluded-in", 5n, 0, "eligible-debit"), type: "EligibleBalanceDebited", account: TEST_ACCOUNT, amount: 40n },
    { ...at("0xexcluded-in", 5n, 1, "router-to-excluded"), type: "WalletTransfer", from: TEST_ACCOUNT, to: "0xcafe", asset: "tRFL", amount: 40n },
  ]);
  equal(sentToExcluded.alerts.length, 0, "An excluded recipient correctly has no eligible credit event");
  equal(outgoing.getProjection().positions.get(TEST_ACCOUNT)?.rawTrfl, 1_999_960n, "Only the eligible sender loses shares");

  const incoming = await bootstrappedIndexer(false);
  const receivedFromExcluded = await incoming.process([
    { ...at("0xexcluded-out", 5n, 0, "bob-registration-excluded"), type: "WalletRegistered", account: TEST_BOB, primaryStore: BOB_PRIMARY_STORE, registeredWalletCount: 2n },
    { ...at("0xexcluded-out", 5n, 1, "bob-position-excluded"), type: "PositionCreated", account: TEST_BOB },
    { ...at("0xexcluded-out", 5n, 2, "eligible-credit"), type: "EligibleBalanceCredited", account: TEST_BOB, amount: 40n },
    { ...at("0xexcluded-out", 5n, 3, "router-from-excluded"), type: "WalletTransfer", from: "0xcafe", to: TEST_BOB, asset: "tRFL", amount: 40n },
  ]);
  equal(receivedFromExcluded.alerts.length, 0, "An excluded sender correctly has no eligible debit event");
  equal(incoming.getProjection().positions.get(TEST_BOB)?.rawTrfl, 40n, "Only the eligible recipient gains shares");
});

test("operational-admin handoffs normalize, replay, reconcile, and reject broken authority chains", async () => {
  const normalizer = eventNormalizer();
  const envelopes = [
    {
      typeTag: "0xcafe::reflection_events::OperationalAdminChanged",
      data: { old_operational_admin: "0x0", new_operational_admin: "0xcafe" },
      txHash: "0xcore-operator-init",
      ledgerVersion: 6n,
      eventIndex: 0,
      timestampUnixMilliseconds: 6_000n,
    },
    {
      typeTag: "0xbabe::test_faucet::OperationalAdminChanged",
      data: { old_operational_admin: "0x0", new_operational_admin: "0xbabe" },
      txHash: "0xfaucet-operator-init",
      ledgerVersion: 7n,
      eventIndex: 0,
      timestampUnixMilliseconds: 7_000n,
    },
    {
      typeTag: "0xdead::pool::OperationalAdminChanged",
      data: { old_operational_admin: "0x0", new_operational_admin: "0xdead" },
      txHash: "0xamm-operator-init",
      ledgerVersion: 8n,
      eventIndex: 0,
      timestampUnixMilliseconds: 8_000n,
    },
    {
      typeTag: "0xcafe::reflection_events::OperationalPrimaryStoreExcluded",
      data: { account: "0x0bed", store: "0x0feed" },
      txHash: "0xall-operator",
      ledgerVersion: 9n,
      eventIndex: 0,
      timestampUnixMilliseconds: 9_000n,
    },
    {
      typeTag: "0xcafe::reflection_events::OperationalAdminChanged",
      data: { old_operational_admin: "0xcafe", new_operational_admin: "0x0bed" },
      txHash: "0xall-operator",
      ledgerVersion: 9n,
      eventIndex: 1,
      timestampUnixMilliseconds: 9_000n,
    },
    {
      typeTag: "0xbabe::test_faucet::OperationalAdminChanged",
      data: { old_operational_admin: "0xbabe", new_operational_admin: "0x0bed" },
      txHash: "0xall-operator",
      ledgerVersion: 9n,
      eventIndex: 2,
      timestampUnixMilliseconds: 9_000n,
    },
    {
      typeTag: "0xdead::pool::OperationalAdminChanged",
      data: { old_operational_admin: "0xdead", new_operational_admin: "0x0bed" },
      txHash: "0xall-operator",
      ledgerVersion: 9n,
      eventIndex: 3,
      timestampUnixMilliseconds: 9_000n,
    },
  ] as const;
  const normalized = envelopes.map((envelope) => normalizer.normalize(envelope));
  if (normalized.some((event) => event === null)) {
    throw new Error("Every operational-admin or exclusion event must normalize");
  }
  const events = normalized as readonly ProtocolEvent[];
  const exclusion = events[3];
  if (exclusion?.type !== "OperationalPrimaryStoreExcluded") {
    throw new Error("Operational exclusion must retain its distinct event type");
  }
  const handoffs = events.filter((event): event is Extract<ProtocolEvent, { readonly type: "OperationalAdminChanged" }> => (
    event.type === "OperationalAdminChanged"
  ));
  equal(handoffs[0]?.oldOperationalAdmin, "0x0", "Initialization starts the explicit authority chain at zero");
  equal(handoffs[3]?.scope, "reflection-core", "Core handoff retains its authority scope");
  equal(handoffs[4]?.scope, "test-assets", "Faucet handoff retains its authority scope");
  equal(handoffs[5]?.scope, "test-amm", "AMM handoff retains its authority scope");

  const indexer = await bootstrappedIndexer();
  const exclusionsBefore = indexer.getProjection().protocolExclusionsRemaining;
  const atomicHandoff = await indexer.process([exclusion, ...handoffs.slice(3)]);
  equal(atomicHandoff.alerts.length, 0, "Preferred handoff must atomically classify and align all three operational authorities");
  equal(indexer.getProjection().protocolExclusionsRemaining, exclusionsBefore, "Operational exclusion must not consume a publisher bootstrap slot");
  equal(indexer.getProjection().protocolExcludedStores.get("0xbed"), "0xfeed", "Indexer retains the permanent operations primary-store exclusion");
  const projection = indexer.getProjection();
  equal(projection.operationalAdmins.reflectionCore, "0xbed", "Core operational authority is replayed");
  equal(projection.operationalAdmins.testAssets, "0xbed", "Faucet operational authority is replayed");
  equal(projection.operationalAdmins.testAmm, "0xbed", "AMM operational authority is replayed");

  const clean = await indexer.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 9n),
  });
  equal(clean.reconciled, true, "Matching operational-admin views must reconcile");
  const mismatch = await indexer.reconcile({
    listEvents: async () => ({ chainId: 2, events: [], nextCursor: null }),
    getAccountingSnapshot: async () => observedFromProjection(projection, 9n, {
      ammOperationalAdmin: "0xbad",
    }),
  });
  ok(mismatch.alerts.some((entry) => entry.code === "OPERATIONAL_ADMIN"), "Authority-view mismatch must be critical");

  const broken: ProtocolEvent = {
    ...at("0xbroken-core-operator", 10n, 0),
    type: "OperationalAdminChanged",
    scope: "reflection-core",
    oldOperationalAdmin: "0xcafe",
    newOperationalAdmin: "0xbeef",
  };
  const rejected = await indexer.process([broken]);
  ok(rejected.alerts.some((entry) => entry.code === "OPERATIONAL_ADMIN"), "Broken authority continuity must reject the transaction");
  equal(indexer.getProjection().operationalAdmins.reflectionCore, "0xbed", "Rejected authority mutation cannot commit");
});

test("reducer fails closed on a runtime-invalid operational authority scope", () => {
  const prior = createEmptyProjection();
  const invalid = {
    ...at("0xinvalid-operator-scope", 1n, 0),
    type: "OperationalAdminChanged",
    scope: "bogus",
    oldOperationalAdmin: "0x0",
    newOperationalAdmin: "0xbeef",
  } as unknown as ProtocolEvent;

  const result = reduceEventGroup(prior, [invalid]);
  ok(
    result.alerts.some((entry) => entry.code === "OPERATIONAL_ADMIN"),
    "Unknown runtime scope must raise a critical authority alert",
  );
  equal(
    result.projection.operationalAdmins.testAmm,
    null,
    "Unknown runtime scope must not mutate the AMM authority projection",
  );
});

test("indexer rejects an unknown runtime event discriminant without advancing its cursor", async () => {
  const store = new InMemoryIndexerStore();
  const indexer = new EventIndexer(store);
  const unknown = {
    ...at("0xunknown-event", 1n, 0),
    type: "BogusProtocolEvent",
  } as unknown as ProtocolEvent;
  const result = await indexer.process([unknown]);
  equal(result.processedEvents, 0, "Unknown event types cannot count as processed");
  equal(result.rejectedEvents, 1, "The complete containing transaction is rejected");
  ok(result.alerts.some((alert) => alert.code === "EVENT_DATA"), "Unknown event type raises a critical data alert");
  (result.alerts[0] as { message: string }).message = "caller mutation";
  equal(
    (await store.listAlerts())[0]?.message === "caller mutation",
    false,
    "Returned alert objects cannot mutate the persisted alert journal",
  );
  equal(indexer.getCursor(), null, "Unknown event cannot advance the event cursor");
  equal(indexer.getProjection().seenEventIds.size, 0, "Rejected unknown event cannot enter durable replay state");
});

test("runtime event boundary enforces exact Move u64, u128, and u256 domains", () => {
  const maximumU64 = (1n << 64n) - 1n;
  const maximumU128 = (1n << 128n) - 1n;
  const maximumU256 = (1n << 256n) - 1n;
  const u64: ProtocolEvent = {
    ...at("0xwidth-u64", maximumU64, 0),
    timestampUnixMilliseconds: maximumU64,
    type: "FaucetGrant",
    account: TEST_ACCOUNT,
    asset: "tRFL",
    amount: maximumU64,
  };
  const u128: ProtocolEvent = {
    ...at("0xwidth-u128", 1n, 0),
    type: "CustodySharesChanged",
    added: true,
    amount: 1n,
    custodyShares: maximumU128,
    globalShares: maximumU128,
  };
  const u256: ProtocolEvent = {
    ...at("0xwidth-u256", 1n, 0),
    type: "ReflectionIndexAdvanced",
    previousIndex: maximumU256,
    newIndex: maximumU256,
    indexRemainder: maximumU256,
    feeAmount: 1n,
    eligibleSupply: 1n,
  };
  equal(thrownBy(() => assertProtocolEventMoveDomains(u64)), null, "The complete Move u64 domain is accepted");
  equal(thrownBy(() => assertProtocolEventMoveDomains(u128)), null, "The complete Move u128 domain is accepted");
  equal(thrownBy(() => assertProtocolEventMoveDomains(u256)), null, "The complete Move u256 domain is accepted");

  const overflowCases: readonly ProtocolEvent[] = [
    { ...u64, amount: 1n << 64n },
    { ...u64, ledgerVersion: 1n << 64n },
    { ...u64, timestampUnixMilliseconds: 1n << 64n },
    { ...u128, custodyShares: 1n << 128n },
    { ...u256, newIndex: 1n << 256n },
  ];
  for (const event of overflowCases) {
    equal(
      thrownBy(() => assertProtocolEventMoveDomains(event)) instanceof RangeError,
      true,
      `${event.type} rejects a value exactly equal to its Move modulus`,
    );
  }
  const prior = createEmptyProjection();
  const rejected = reduceEventGroup(prior, [{ ...u64, amount: 1n << 64n }]);
  ok(rejected.alerts.some((entry) => entry.code === "EVENT_DATA"), "Reducer preflight rejects an out-of-domain event");
  equal(rejected.projection, prior, "Out-of-domain event rejection preserves the exact prior projection object");

  const nearU256: ProtocolProjection = {
    ...prior,
    rewardVaultCredits: maximumU256,
    lifetimeSwapFees: maximumU256,
  };
  const arithmeticOverflow = reduceEventGroup(nearU256, [{
    ...at("0xprojection-overflow", 1n, 0),
    type: "ReflectionFeeCollected",
    swapTxHash: "0xprojection-overflow",
    grossAmount: 100n,
    feeAmount: 1n,
    feeBps: 100n,
  }]);
  ok(
    arithmeticOverflow.alerts.some((entry) => entry.code === "EVENT_DATA"),
    "Unbounded bigint arithmetic cannot create a projection outside its Move field widths",
  );
  equal(arithmeticOverflow.projection.rewardVaultCredits, maximumU256, "Projection overflow rejection restores prior state");
});

test("Cedra normalizer maps custody and LP payloads and fails closed on missing arithmetic fields", () => {
  const normalizer = eventNormalizer();
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
      typeTag: "0xcafe::reflection_events::ReflectionIndexAdvanced",
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

test("Cedra normalizer preserves wallet registration, fractional residue, and terminal dust unit domains", () => {
  const normalizer = eventNormalizer();
  const maximumU64 = (1n << 64n) - 1n;
  const maximumU128 = (1n << 128n) - 1n;
  const maximumU256 = (1n << 256n) - 1n;
  const registration = normalizer.normalize({
    typeTag: "0xcafe::reflection_events::WalletRegistered",
    data: { account: "0x000a11ce", primary_store: "0x000a1101", registered_wallet_count: maximumU64.toString() },
    txHash: "0xregistration-normalizer",
    ledgerVersion: 10n,
    eventIndex: 0,
    timestampUnixMilliseconds: 10_000n,
  });
  if (registration === null || registration.type !== "WalletRegistered") {
    throw new Error("WalletRegistered must normalize from the exact core package");
  }
  equal(registration.account, "0xa11ce", "Wallet account is canonicalized before exact-once replay");
  equal(registration.primaryStore, "0xa1101", "Primary-store binding is canonicalized before uniqueness checks");
  equal(registration.registeredWalletCount, maximumU64, "Registration count retains the complete Move u64 domain");

  const residue = normalizer.normalize({
    typeTag: "0xdead::lp_rewards::LpFractionalResidueRetired",
    data: {
      epoch: maximumU64.toString(),
      owner: TEST_ACCOUNT,
      residue_magnified: maximumU256.toString(),
      cumulative_retired_residue_magnified: maximumU256.toString(),
      rounding_reserve_base_units: maximumU128.toString(),
    },
    txHash: "0xresidue-normalizer",
    ledgerVersion: 11n,
    eventIndex: 0,
    timestampUnixMilliseconds: 11_000n,
  });
  if (residue === null || residue.type !== "LpFractionalResidueRetired") {
    throw new Error("LpFractionalResidueRetired must normalize from the exact AMM package");
  }
  equal(residue.residueMagnified, maximumU256, "Fractional residue is explicitly preserved in u256 magnified units");
  equal(residue.roundingReserveBaseUnits, maximumU128, "Physical rounding reserve is explicitly preserved in u128 base units");

  const terminal = normalizer.normalize({
    typeTag: "0xdead::lp_rewards::LpEpochTerminalDustClassified",
    data: {
      epoch: "1",
      reward_vault: LP_REWARD_VAULT,
      terminal_rounding_base_units: maximumU128.toString(),
      retired_residue_magnified: maximumU256.toString(),
      lifetime_received_base_units: maximumU256.toString(),
      lifetime_claimed_base_units: maximumU256.toString(),
    },
    txHash: "0xterminal-normalizer",
    ledgerVersion: 12n,
    eventIndex: 0,
    timestampUnixMilliseconds: 12_000n,
  });
  if (terminal === null || terminal.type !== "LpEpochTerminalDustClassified") {
    throw new Error("LpEpochTerminalDustClassified must normalize from the exact AMM package");
  }
  equal(terminal.terminalRoundingBaseUnits, maximumU128, "Terminal physical dust retains its u128 base-unit domain");
  equal(terminal.retiredResidueMagnified, maximumU256, "Terminal fractional evidence retains its u256 magnified domain");

  equal(
    thrownBy(() => normalizer.normalize({
      typeTag: "0xdead::lp_rewards::LpEpochTerminalDustClassified",
      data: {
        epoch: "1",
        reward_vault: LP_REWARD_VAULT,
        terminal_rounding_base_units: (1n << 128n).toString(),
        retired_residue_magnified: "0",
        lifetime_received_base_units: "0",
        lifetime_claimed_base_units: "0",
      },
      txHash: "0xterminal-overflow",
      ledgerVersion: 13n,
      eventIndex: 0,
      timestampUnixMilliseconds: 13_000n,
    })) instanceof TypeError,
    true,
    "Terminal base units outside Move u128 fail before replay",
  );
  equal(
    thrownBy(() => normalizer.normalize({
      typeTag: "0xcafe::reflection_events::WalletRegistered",
      data: { account: TEST_ACCOUNT, primary_store: ALICE_PRIMARY_STORE, registered_wallet_count: (1n << 64n).toString() },
      txHash: "0xregistration-overflow",
      ledgerVersion: 14n,
      eventIndex: 0,
      timestampUnixMilliseconds: 14_000n,
    })) instanceof TypeError,
    true,
    "Registration count outside Move u64 fails before replay",
  );
  equal(
    thrownBy(() => normalizer.normalize({
      typeTag: "0xcafe::reflection_events::ReflectionIndexAdvanced",
      data: {
        old_index: "0",
        new_index: (1n << 256n).toString(),
        remainder: "0",
        fee_amount: "1",
        eligible_supply: "1",
      },
      txHash: "0xindex-overflow",
      ledgerVersion: 15n,
      eventIndex: 0,
      timestampUnixMilliseconds: 15_000n,
    })) instanceof TypeError,
    true,
    "Reflection index equal to 2^256 fails before replay",
  );
  equal(
    thrownBy(() => normalizer.normalize({
      typeTag: "0xdead::lp_rewards::LpEpochStatusChanged",
      data: { epoch: "1", old_status: "1", new_status: "256" },
      txHash: "0xstatus-overflow",
      ledgerVersion: 16n,
      eventIndex: 0,
      timestampUnixMilliseconds: 16_000n,
    })) instanceof TypeError,
    true,
    "LP status equal to 2^8 fails at the Move u8 boundary",
  );
});

test("Cedra normalizer rejects authentic-looking events from unapproved package addresses", () => {
  const normalizer = eventNormalizer();
  const counterfeit = normalizer.normalize({
    typeTag: "0xbeef::reflection_events::ReflectionFeeCollected",
    data: { account: TEST_ACCOUNT, gross_amount: "100", fee_amount: "1", fee_bps: "100", kind: "1" },
    txHash: "0xcounterfeit",
    ledgerVersion: 9n,
    eventIndex: 0,
    timestampUnixMilliseconds: 9_000n,
  });
  equal(counterfeit, null, "A matching module/event suffix at another address is not protocol evidence");

  const canonical = normalizer.normalize({
    typeTag: "0x0000CAFE::reflection_events::ReflectionFeeCollected",
    data: { account: TEST_ACCOUNT, gross_amount: "100", fee_amount: "1", fee_bps: "100", kind: "1" },
    txHash: "0xcanonical",
    ledgerVersion: 10n,
    eventIndex: 0,
    timestampUnixMilliseconds: 10_000n,
  });
  equal(canonical?.type, "ReflectionFeeCollected", "Equivalent zero-padded package addresses normalize canonically");
});

test("Cedra normalizer rejects zero and canonically duplicate package identities", () => {
  equal(
    thrownBy(() => new CedraEventNormalizer({
      packageAddresses: {
        reflectionCore: "0x0",
        testAssets: "0xbabe",
        testAmm: "0xdead",
      },
    })) instanceof TypeError,
    true,
    "A zero module address cannot become trusted event provenance",
  );
  equal(
    thrownBy(() => new CedraEventNormalizer({
      packageAddresses: {
        reflectionCore: "0xcafe",
        testAssets: "0x0000CAFE",
        testAmm: "0xdead",
      },
    })) instanceof TypeError,
    true,
    "Package identities must remain distinct after address canonicalization",
  );
});

test("v0.2 creation, launch, closure, and trigger-coded materialization normalize separately from legacy v0.1", () => {
  const normalizer = eventNormalizer();
  const envelope = (typeTag: string, data: Record<string, unknown>, eventIndex: number) => ({
    typeTag,
    data,
    txHash: "0xv02",
    ledgerVersion: 20n,
    eventIndex,
    timestampUnixMilliseconds: 20_000n,
  });
  const created = normalizer.normalize(envelope("0xcafe::reflection_events::TokenCreated", {
    version: "2",
    release_major: "0",
    release_minor: "2",
    release_patch: "0",
    deployment_id: [...new TextEncoder().encode("v02-test")],
    network_label: [...new TextEncoder().encode("cedra-testnet")],
    metadata: TOKEN_METADATA,
    reward_vault: CORE_REWARD_VAULT,
    distribution_vault: DISTRIBUTION_VAULT,
    reflection_fee_bps: "500",
    total_supply: "1000000000000000",
    decimals: "6",
  }, 0));
  equal(created?.type, "TokenCreated", "v0.2 uses TokenCreated rather than the legacy ProtocolInitialized event");
  if (created?.type !== "TokenCreated") throw new Error("TokenCreated did not normalize");
  equal(created.eventSchema, "v0.2", "Creation event carries an explicit v0.2 schema marker");
  equal(created.reflectionFeeBps, 500n, "Creation accepts the full immutable v0.2 fee range");
  equal(created.packageVersion, "testnet-v0.2.0", "Creation binds the semantic package release");

  const launch = normalizer.normalize(envelope("0xdead::pool::LaunchSealed", {
    reflection_fee_bps: "500",
    amm_fee_bps: "30",
    max_reserve_bps: "2000",
    max_gross_swap: "100000000000",
    max_liquidity_rfl: "100000000000",
    max_liquidity_usd: "100000000000",
    max_withdrawal_share_bps: "10000",
    faucet_trfl_grant: "1000000000",
    faucet_tusd_grant: "1000000000",
    faucet_cooldown_seconds: "3600",
    bootstrap: TEST_ACCOUNT,
    rfl_reserve: CUSTODY_RESERVE,
    usd_reserve: USD_RESERVE,
    lp_reward_vault: LP_REWARD_VAULT,
    seed_rfl: "500000000",
    seed_usd: "500000000",
    initial_lp_shares: "500000000",
  }, 1));
  equal(launch?.type, "LaunchSealed", "The fixed four-signer launch envelope normalizes");

  const closed = normalizer.normalize(envelope("0xdead::pool::PoolClosed", {
    provider: TEST_ACCOUNT,
    epoch: "1",
    lp_shares: "500000000",
    rfl_output: "500000000",
    usd_output: "500000000",
    reserve_rfl: "0",
    reserve_usd: "0",
  }, 2));
  equal(closed?.type, "PoolClosed", "Permissionless final closure normalizes as terminal evidence");

  const materialized = normalizer.normalize(envelope("0xcafe::reflection_events::RewardsMaterialized", {
    account: TEST_ACCOUNT,
    amount: "42",
    total_claimed: "84",
    trigger: "9",
  }, 3));
  equal(materialized?.type, "RewardsMaterialized", "Automatic materialization receipt normalizes");
  if (materialized?.type !== "RewardsMaterialized") throw new Error("RewardsMaterialized did not normalize");
  equal(materialized.trigger, 9, "LP payout trigger remains explicit in indexed evidence");
  equal(
    thrownBy(() => normalizer.normalize(envelope("0xcafe::reflection_events::RewardsMaterialized", {
      account: TEST_ACCOUNT,
      amount: "1",
      total_claimed: "1",
      trigger: "11",
    }, 4))) instanceof TypeError,
    true,
    "Unknown v0.2 trigger codes fail closed",
  );
});
