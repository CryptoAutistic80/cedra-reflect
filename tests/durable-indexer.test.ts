import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CedraChainIdMismatchError,
  ConcurrentDurableWriterError,
  ConcurrentIndexerOperationError,
  createEmptyProjection,
  encodeSnapshot,
  EventIndexer,
  FileCriticalAlertSink,
  FileIndexerStore,
  IndexerWriterLeaseRequiredError,
  InvalidIndexerWriterCycleError,
  InvalidIndexerWriterLeaseError,
  IndexerWorker,
  sha256Text,
  StaleIndexerSnapshotError,
  takeSnapshot,
  type CriticalAlert,
  type IndexerWriterCycle,
  type ProtocolEvent,
  type ProtocolEventSource,
  type IndexerWriterLease,
} from "../packages/indexer/src/index.js";
import {
  CORE_REWARD_VAULT,
  CUSTODY_RESERVE,
  DISTRIBUTION_VAULT,
  LP_REWARD_VAULT,
  TOKEN_METADATA,
  USD_RESERVE,
  baseEvent,
  observationFixture,
} from "./fixtures.js";
import { equal, ok, rejects, test } from "./harness.js";

const MANIFEST_DIGEST = "a".repeat(64);

function alertFixture(id: string): CriticalAlert {
  return {
    id,
    severity: "critical",
    code: "EVENT_DATA",
    message: `deterministic alert ${id}`,
    detectedAtUnixMilliseconds: 1n,
    cursor: { ledgerVersion: 1n, eventIndex: 0 },
  };
}

async function saveAtCurrentBase(
  store: FileIndexerStore,
  snapshot: ReturnType<typeof takeSnapshot>,
): Promise<void> {
  const base = (await store.loadLatestSnapshot())?.id ?? null;
  await store.withExclusiveWriter((lease) => store.saveSnapshot(snapshot, lease, base));
}

async function appendWithLease(
  store: FileIndexerStore,
  alerts: readonly CriticalAlert[],
): Promise<void> {
  await store.withExclusiveWriter((lease) => store.appendAlerts(alerts, lease));
}

function durableBootstrapEvents(): readonly ProtocolEvent[] {
  return [
    {
      ...baseEvent({ id: "durable-init", txHash: "0xdurable-init", ledgerVersion: 1n }),
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
      ...baseEvent({
        id: "durable-core-admin",
        txHash: "0xdurable-init",
        ledgerVersion: 1n,
        eventIndex: 1,
      }),
      type: "OperationalAdminChanged",
      scope: "reflection-core",
      oldOperationalAdmin: "0x0",
      newOperationalAdmin: "0xcafe",
    },
    {
      ...baseEvent({
        id: "durable-assets-admin",
        txHash: "0xdurable-init",
        ledgerVersion: 1n,
        eventIndex: 2,
      }),
      type: "OperationalAdminChanged",
      scope: "test-assets",
      oldOperationalAdmin: "0x0",
      newOperationalAdmin: "0xbabe",
    },
    {
      ...baseEvent({
        id: "durable-amm-admin",
        txHash: "0xdurable-init",
        ledgerVersion: 1n,
        eventIndex: 3,
      }),
      type: "OperationalAdminChanged",
      scope: "test-amm",
      oldOperationalAdmin: "0x0",
      newOperationalAdmin: "0xdead",
    },
    {
      ...baseEvent({ id: "durable-adapter", txHash: "0xdurable-adapter", ledgerVersion: 2n }),
      type: "CustodyAdapterRegistered",
      adapterId: 1n,
      reserveStore: CUSTODY_RESERVE,
      firstEpoch: 1n,
      lpRewardVault: LP_REWARD_VAULT,
    },
    {
      ...baseEvent({
        id: "durable-epoch",
        txHash: "0xdurable-adapter",
        ledgerVersion: 2n,
        eventIndex: 1,
      }),
      type: "LpEpochOpened",
      epoch: 1n,
      stateId: "0x4001",
      rewardVault: LP_REWARD_VAULT,
    },
    {
      ...baseEvent({
        id: "durable-usd-reserve",
        txHash: "0xdurable-adapter",
        ledgerVersion: 2n,
        eventIndex: 2,
      }),
      type: "PoolReserveBound",
      reserveStore: USD_RESERVE,
      custodian: "0xdead",
    },
  ];
}

function sourceFor(
  observedOverrides: Partial<ReturnType<typeof observationFixture>> = {},
  requestedLedgerVersions: bigint[] = [],
  pageChainId = 2,
): ProtocolEventSource {
  return {
    // Deliberately return overlap. A restart must use its durable cursor and
    // skip both records without applying them twice.
    listEvents: async () => ({ chainId: pageChainId, events: durableBootstrapEvents(), nextCursor: null }),
    getAccountingSnapshot: async (ledgerVersion) => {
      requestedLedgerVersions.push(ledgerVersion);
      return {
        ...observationFixture(),
        ledgerVersion,
        activeLpEpoch: 1n,
        lpEpochs: [{
          epoch: 1n,
          stateId: "0x4001",
          status: "active",
          rewardVault: LP_REWARD_VAULT,
          rewardVaultBalance: 0n,
          index: 0n,
          indexRemainder: 0n,
          totalShares: 0n,
          aggregateCorrection: 0n,
          unallocatedRewards: 0n,
          roundingReserve: 0n,
          terminalRoundingBaseUnits: 0n,
          retiredResidueMagnified: 0n,
          lifetimeReceived: 0n,
          lifetimeClaimed: 0n,
          quarantined: false,
          indexedLiability: 0n,
          positions: [],
        }],
        ...observedOverrides,
      };
    },
  };
}

test("durable worker pins views, checkpoints atomically, and resumes overlap exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-worker-"));
  try {
    const requestedLedgerVersions: bigint[] = [];
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const sink = new FileCriticalAlertSink(join(directory, "delivered-alerts.json"), MANIFEST_DIGEST);
    const firstIndexer = new EventIndexer(store);
    const firstWorker = new IndexerWorker(
      firstIndexer,
      sourceFor({}, requestedLedgerVersions),
      sink,
      () => 10_000n,
    );
    const first = await firstWorker.runOnce();
    equal(first.processing.processedEvents, 7, "First worker run commits both complete bootstrap transactions");
    equal(first.reconciliation?.reconciled, true, "First worker run reconciles at its exact cursor");
    ok(first.snapshot !== null, "A clean reconciliation produces a durable snapshot");
    equal(requestedLedgerVersions[0], 2n, "View source is explicitly pinned to the event cursor ledger");

    const secondIndexer = new EventIndexer(store);
    const secondWorker = new IndexerWorker(
      secondIndexer,
      sourceFor({}, requestedLedgerVersions),
      sink,
      () => 10_001n,
    );
    const second = await secondWorker.runOnce();
    equal(second.processing.processedEvents, 0, "Restart does not reapply overlapping transactions");
    equal(second.processing.skippedEvents, 7, "Restart records all overlapping events as skipped");
    equal(second.processing.cursor?.ledgerVersion, 2n, "Restart retains the durable event cursor");
    equal(second.reconciliation?.reconciled, true, "Restart reaches the same reconciled head");
    equal(second.snapshot?.projection.chainId, 2, "Durable checkpoint retains the consensus Testnet chain identity");
    equal(second.snapshot?.projection.deploymentReady, true, "Durable checkpoint records complete authority histories");
    equal(requestedLedgerVersions[1], 2n, "Restarted views remain pinned to the same head");
    equal((await sink.listDelivered()).length, 0, "Clean runs deliver no critical alert");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two durable instances fail fast on concurrent writers and cannot regress snapshots or lose alerts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-concurrency-"));
  try {
    const first = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const second = new FileIndexerStore(directory, MANIFEST_DIGEST);
    let releaseLease: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const held = first.withExclusiveWriter(async () => {
      markEntered!();
      await new Promise<void>((resolve) => { releaseLease = resolve; });
    });
    await entered;
    await rejects(
      () => second.withExclusiveWriter(async () => undefined),
      ConcurrentDurableWriterError,
    );
    releaseLease!();
    await held;

    const newer = takeSnapshot({
      projection: createEmptyProjection(),
      cursor: { ledgerVersion: 2n, eventIndex: 0 },
      takenAtUnixMilliseconds: 20n,
    });
    const stale = takeSnapshot({
      projection: createEmptyProjection(),
      cursor: { ledgerVersion: 1n, eventIndex: 0 },
      takenAtUnixMilliseconds: 10n,
    });
    await saveAtCurrentBase(first, newer);
    await rejects(() => saveAtCurrentBase(second, stale), StaleIndexerSnapshotError);
    equal(
      (await first.loadLatestSnapshot())?.cursor?.ledgerVersion,
      2n,
      "A stale second instance cannot overwrite the newer durable cursor",
    );

    const attempts = [
      { store: first, alert: alertFixture("concurrent-alert-a") },
      { store: second, alert: alertFixture("concurrent-alert-b") },
    ] as const;
    const outcomes = await Promise.allSettled(
      attempts.map(({ store, alert }) => appendWithLease(store, [alert])),
    );
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index]!;
      if (outcome.status === "rejected") {
        ok(
          outcome.reason instanceof ConcurrentDurableWriterError,
          "Concurrent journal contention must fail with the dedicated lock error",
        );
        await appendWithLease(attempts[index]!.store, [attempts[index]!.alert]);
      }
    }
    const alertIds = new Set((await first.listAlerts()).map((alert) => alert.id));
    equal(alertIds.has("concurrent-alert-a"), true, "First concurrent alert remains durable");
    equal(alertIds.has("concurrent-alert-b"), true, "Rejected writer retry cannot lose the second alert");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable mutations require the exact owner lease and reject a stale forward base", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-lease-owner-"));
  try {
    const ownerA = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const ownerB = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const directIndexer = new EventIndexer(ownerA);
    await directIndexer.process(durableBootstrapEvents());
    await directIndexer.reconcile(sourceFor());
    await rejects(() => directIndexer.snapshot(1n), IndexerWriterLeaseRequiredError);
    equal(await ownerA.loadLatestSnapshot(), null, "Direct EventIndexer checkpoint cannot bypass the durable full-cycle lease");
    const base = takeSnapshot({
      projection: createEmptyProjection(),
      cursor: { ledgerVersion: 1n, eventIndex: 0 },
      takenAtUnixMilliseconds: 1n,
    });
    let expiredLease: IndexerWriterLease | undefined;
    await rejects(
      () => ownerA.saveSnapshot(base, undefined as never, null),
      InvalidIndexerWriterLeaseError,
    );
    await rejects(
      () => ownerA.appendAlerts([alertFixture("outside-lease")], undefined as never),
      InvalidIndexerWriterLeaseError,
    );
    await ownerA.withExclusiveWriter(async (lease) => {
      expiredLease = lease;
      await rejects(
        () => ownerB.saveSnapshot(base, lease, null),
        InvalidIndexerWriterLeaseError,
      );
      await rejects(
        () => ownerB.appendAlerts([alertFixture("wrong-owner-b")], lease),
        InvalidIndexerWriterLeaseError,
      );
      await ownerA.saveSnapshot(base, lease, null);
      await ownerA.appendAlerts([alertFixture("inside-owner-a")], lease);
      void ownerA.appendAlerts([alertFixture("inside-owner-a-unawaited")], lease);
    });
    equal((await ownerA.loadLatestSnapshot())?.id, base.id, "Owner A can persist under its active lease");
    equal((await ownerA.listAlerts()).length, 2, "Lease lifetime drains even an unawaited owner mutation before release");
    await rejects(
      () => ownerA.appendAlerts([alertFixture("expired-owner-a")], expiredLease!),
      InvalidIndexerWriterLeaseError,
    );

    const staleBaseId = base.id;
    const forwardA = takeSnapshot({
      projection: createEmptyProjection(),
      cursor: { ledgerVersion: 2n, eventIndex: 0 },
      takenAtUnixMilliseconds: 2n,
    });
    const staleForwardB = takeSnapshot({
      projection: createEmptyProjection(),
      cursor: { ledgerVersion: 3n, eventIndex: 0 },
      takenAtUnixMilliseconds: 3n,
    });
    await ownerA.withExclusiveWriter((lease) => ownerA.saveSnapshot(forwardA, lease, staleBaseId));
    await rejects(
      () => ownerB.withExclusiveWriter((lease) => ownerB.saveSnapshot(staleForwardB, lease, staleBaseId)),
      StaleIndexerSnapshotError,
    );
    equal(
      (await ownerA.loadLatestSnapshot())?.id,
      forwardA.id,
      "A higher cursor cannot overwrite state derived from a stale durable base",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable workers hold one full-cycle lease before any source call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-worker-lease-"));
  try {
    const firstStore = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const secondStore = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const delegate = sourceFor();
    let firstSourceCalls = 0;
    let secondSourceCalls = 0;
    let releaseSource: (() => void) | undefined;
    let markSourceEntered: (() => void) | undefined;
    const sourceEntered = new Promise<void>((resolve) => { markSourceEntered = resolve; });
    const firstSource: ProtocolEventSource = {
      listEvents: async (after, limit) => {
        firstSourceCalls += 1;
        markSourceEntered!();
        await new Promise<void>((resolve) => { releaseSource = resolve; });
        return delegate.listEvents(after, limit);
      },
      getAccountingSnapshot: (ledgerVersion) => delegate.getAccountingSnapshot(ledgerVersion),
    };
    const secondSource: ProtocolEventSource = {
      listEvents: async (after, limit) => {
        secondSourceCalls += 1;
        return delegate.listEvents(after, limit);
      },
      getAccountingSnapshot: (ledgerVersion) => delegate.getAccountingSnapshot(ledgerVersion),
    };
    const sinkPath = join(directory, "delivered-alerts.json");
    const firstRun = new IndexerWorker(
      new EventIndexer(firstStore),
      firstSource,
      new FileCriticalAlertSink(sinkPath, MANIFEST_DIGEST),
    ).runOnce();
    await sourceEntered;
    await rejects(
      () => new IndexerWorker(
        new EventIndexer(secondStore),
        secondSource,
        new FileCriticalAlertSink(sinkPath, MANIFEST_DIGEST),
      ).runOnce(),
      ConcurrentDurableWriterError,
    );
    equal(secondSourceCalls, 0, "Contending worker cannot poll before owning the writer lease");
    releaseSource!();
    await firstRun;
    equal(firstSourceCalls, 1, "Lease owner polls exactly once inside its complete worker cycle");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one EventIndexer rejects an overlapping runOnce before the second source call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-same-instance-cycle-"));
  let releaseSource: (() => void) | undefined;
  let firstRun: Promise<unknown> | undefined;
  try {
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const indexer = new EventIndexer(store);
    const delegate = sourceFor();
    let sourceCalls = 0;
    let markSourceEntered: (() => void) | undefined;
    const sourceEntered = new Promise<void>((resolve) => { markSourceEntered = resolve; });
    const source: ProtocolEventSource = {
      listEvents: async (after, limit) => {
        sourceCalls += 1;
        markSourceEntered!();
        await new Promise<void>((resolve) => { releaseSource = resolve; });
        return delegate.listEvents(after, limit);
      },
      getAccountingSnapshot: (ledgerVersion) => delegate.getAccountingSnapshot(ledgerVersion),
    };
    const worker = new IndexerWorker(
      indexer,
      source,
      new FileCriticalAlertSink(join(directory, "delivered-alerts.json"), MANIFEST_DIGEST),
    );
    firstRun = worker.runOnce();
    await sourceEntered;
    await rejects(() => worker.runOnce(), ConcurrentDurableWriterError);
    equal(sourceCalls, 1, "A same-instance contender is rejected before it can poll the source");
    releaseSource!();
    releaseSource = undefined;
    await firstRun;
  } finally {
    releaseSource?.();
    if (firstRun !== undefined) await firstRun.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("unrelated snapshot and alert mutations cannot borrow an active writer-cycle lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-unrelated-mutation-"));
  let releaseCycle: (() => void) | undefined;
  let heldCycle: Promise<unknown> | undefined;
  try {
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const indexer = new EventIndexer(store);
    await indexer.process(durableBootstrapEvents());
    await indexer.reconcile(sourceFor());

    let markCycleEntered: (() => void) | undefined;
    const cycleEntered = new Promise<void>((resolve) => { markCycleEntered = resolve; });
    heldCycle = indexer.withExclusiveStoreWriter(async () => {
      markCycleEntered!();
      await new Promise<void>((resolve) => { releaseCycle = resolve; });
    });
    await cycleEntered;

    await rejects(() => indexer.snapshot(50n), ConcurrentIndexerOperationError);
    const unknown = {
      ...baseEvent({ id: "unrelated-alert", txHash: "0xunrelated-alert", ledgerVersion: 3n }),
      type: "FutureUnknownEvent",
    } as unknown as ProtocolEvent;
    await rejects(() => indexer.process([unknown]), ConcurrentIndexerOperationError);
    equal(await store.loadLatestSnapshot(), null, "An unrelated snapshot cannot use the held cycle's lease");
    equal((await store.listAlerts()).length, 0, "An unrelated alert cannot use the held cycle's lease");

    releaseCycle!();
    releaseCycle = undefined;
    await heldCycle;
  } finally {
    releaseCycle?.();
    if (heldCycle !== undefined) await heldCycle.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an accepted unawaited cycle-method failure rejects its cycle without an unhandled rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-unawaited-failure-"));
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", captureUnhandled);
  try {
    const indexer = new EventIndexer(new FileIndexerStore(directory, MANIFEST_DIGEST));
    await rejects(
      () => indexer.withExclusiveStoreWriter(async (cycle) => {
        void cycle.pollOnce(sourceFor({}, [], 4));
      }),
      CedraChainIdMismatchError,
    );
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    equal(unhandled.length, 0, "The exact tracked promise handles an unawaited accepted-method rejection");
  } finally {
    process.off("unhandledRejection", captureUnhandled);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unawaited overlapping cycle method rejects the outer cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-unawaited-overlap-"));
  const unhandled: unknown[] = [];
  const captureUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", captureUnhandled);
  let releaseSource: (() => void) | undefined;
  let outerCycle: Promise<unknown> | undefined;
  try {
    const indexer = new EventIndexer(new FileIndexerStore(directory, MANIFEST_DIGEST));
    let markSourceEntered: (() => void) | undefined;
    const sourceEntered = new Promise<void>((resolve) => { markSourceEntered = resolve; });
    const source: ProtocolEventSource = {
      listEvents: async () => {
        markSourceEntered!();
        await new Promise<void>((resolve) => { releaseSource = resolve; });
        return { chainId: 2, events: [], nextCursor: null };
      },
      getAccountingSnapshot: async () => observationFixture(),
    };
    outerCycle = indexer.withExclusiveStoreWriter(async (cycle) => {
      void cycle.pollOnce(source);
      await sourceEntered;
      void cycle.restoreLatestSnapshot();
      releaseSource!();
      releaseSource = undefined;
    });
    await rejects(() => outerCycle!, ConcurrentIndexerOperationError);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    equal(unhandled.length, 0, "The rejected overlapping invocation is tracked rather than orphaned");
  } finally {
    releaseSource?.();
    if (outerCycle !== undefined) await outerCycle.catch(() => undefined);
    process.off("unhandledRejection", captureUnhandled);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the writer lease remains held until every tracked cycle method settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-cycle-drain-"));
  let releaseSource: (() => void) | undefined;
  let outerCycle: Promise<unknown> | undefined;
  try {
    const owner = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const contender = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const indexer = new EventIndexer(owner);
    let expiredCycle: IndexerWriterCycle | undefined;
    let markSourceEntered: (() => void) | undefined;
    const sourceEntered = new Promise<void>((resolve) => { markSourceEntered = resolve; });
    const source: ProtocolEventSource = {
      listEvents: async () => {
        markSourceEntered!();
        await new Promise<void>((resolve) => { releaseSource = resolve; });
        return { chainId: 2, events: [], nextCursor: null };
      },
      getAccountingSnapshot: async () => observationFixture(),
    };
    outerCycle = indexer.withExclusiveStoreWriter(async (cycle) => {
      expiredCycle = cycle;
      void cycle.pollOnce(source);
    });
    await sourceEntered;

    let outerSettled = false;
    void outerCycle.then(
      () => { outerSettled = true; },
      () => { outerSettled = true; },
    );
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    equal(outerSettled, false, "The outer cycle cannot settle while an accepted method remains pending");
    await rejects(
      () => contender.withExclusiveWriter(async () => undefined),
      ConcurrentDurableWriterError,
    );

    releaseSource!();
    releaseSource = undefined;
    await outerCycle;
    await rejects(() => expiredCycle!.restoreLatestSnapshot(), InvalidIndexerWriterCycleError);
    await contender.withExclusiveWriter(async () => undefined);
  } finally {
    releaseSource?.();
    if (outerCycle !== undefined) await outerCycle.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable worker rejects a non-Testnet event page before replay or checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-wrong-event-chain-"));
  try {
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const worker = new IndexerWorker(
      new EventIndexer(store),
      sourceFor({}, [], 4),
      new FileCriticalAlertSink(join(directory, "delivered-alerts.json"), MANIFEST_DIGEST),
    );
    await rejects(() => worker.runOnce(), CedraChainIdMismatchError);
    equal(await store.loadLatestSnapshot(), null, "Wrong-chain event data cannot create a durable checkpoint");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable worker blocks clean checkpoints on wrong-chain views or incomplete authority history", async () => {
  for (const [name, source] of [
    ["wrong-chain views", sourceFor({ chainId: 4 })],
    [
      "missing AMM authority history",
      {
        ...sourceFor(),
        listEvents: async () => ({
          chainId: 2,
          events: durableBootstrapEvents().filter((event) => event.id !== "durable-amm-admin"),
          nextCursor: null,
        }),
      } satisfies ProtocolEventSource,
    ],
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-unready-"));
    try {
      const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
      const sink = new FileCriticalAlertSink(join(directory, "delivered-alerts.json"), MANIFEST_DIGEST);
      const result = await new IndexerWorker(new EventIndexer(store), source, sink).runOnce();
      equal(result.reconciliation?.reconciled, false, `${name} must fail reconciliation`);
      equal(result.snapshot, null, `${name} must block the clean checkpoint`);
      equal(await store.loadLatestSnapshot(), null, `${name} cannot become durable state`);
      ok(
        result.reconciliation?.alerts.some((alert) => (
          name === "wrong-chain views"
            ? alert.code === "DEPLOYMENT_IDENTITY"
            : alert.code === "OPERATIONAL_ADMIN"
        )),
        `${name} must emit its critical identity or readiness alert`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("durable snapshot rejects release-manifest mismatch and content corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-integrity-"));
  try {
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    await saveAtCurrentBase(store, takeSnapshot({
      projection: createEmptyProjection(),
      cursor: { ledgerVersion: 1n, eventIndex: 0 },
      takenAtUnixMilliseconds: 1_000n,
    }));
    const wrongRelease = new FileIndexerStore(directory, "b".repeat(64));
    await rejects(() => wrongRelease.loadLatestSnapshot(), TypeError);

    const path = join(directory, "indexer-snapshot.json");
    const envelope = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    envelope.payloadSha256 = "0".repeat(64);
    await writeFile(path, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    await rejects(() => store.loadLatestSnapshot(), TypeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable snapshot rejects malformed and wrong-chain content despite recomputed digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-schema-"));
  try {
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const snapshot = takeSnapshot({
      projection: createEmptyProjection(),
      cursor: { ledgerVersion: 1n, eventIndex: 0 },
      takenAtUnixMilliseconds: 1_000n,
    });
    await saveAtCurrentBase(store, snapshot);
    const path = join(directory, "indexer-snapshot.json");
    const validEnvelope = JSON.parse(await readFile(path, "utf8")) as {
      payloadSha256: string;
      snapshot: string;
    };
    for (const mutate of [
      (projection: { chainId: unknown; pool: { poolPaused: unknown } }) => {
        projection.pool.poolPaused = "false";
      },
      (projection: { chainId: unknown; pool: { poolPaused: unknown } }) => {
        projection.chainId = 4;
      },
    ]) {
      const envelope = { ...validEnvelope };
      const payload = JSON.parse(envelope.snapshot) as {
        schemaVersion: number;
        id: string;
        takenAtUnixMilliseconds: unknown;
        cursor: unknown;
        projection: { chainId: unknown; pool: { poolPaused: unknown } };
      };
      mutate(payload.projection);
      const identity = {
        schemaVersion: payload.schemaVersion,
        id: "pending",
        takenAtUnixMilliseconds: payload.takenAtUnixMilliseconds,
        cursor: payload.cursor,
        projection: payload.projection,
      };
      payload.id = `snapshot-${createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex")}`;
      envelope.snapshot = JSON.stringify(payload);
      envelope.payloadSha256 = sha256Text(envelope.snapshot);
      await writeFile(path, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
      await rejects(() => store.loadLatestSnapshot(), TypeError);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable state reads refuse final-component symbolic links", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-symlink-"));
  try {
    const target = join(directory, "outside-state.json");
    await writeFile(target, encodeSnapshot(takeSnapshot({
      projection: createEmptyProjection(),
      cursor: null,
      takenAtUnixMilliseconds: 1n,
    })), { encoding: "utf8", mode: 0o600 });
    await symlink(target, join(directory, "indexer-snapshot.json"));
    await rejects(
      () => new FileIndexerStore(directory, MANIFEST_DIGEST).loadLatestSnapshot(),
      TypeError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable state rejects a symbolic-link data directory", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-real-directory-"));
  const alias = `${directory}-alias`;
  try {
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    await saveAtCurrentBase(store, takeSnapshot({
      projection: createEmptyProjection(),
      cursor: null,
      takenAtUnixMilliseconds: 1n,
    }));
    await symlink(directory, alias, "dir");
    await rejects(
      () => new FileIndexerStore(alias, MANIFEST_DIGEST).loadLatestSnapshot(),
      TypeError,
    );
  } finally {
    await rm(alias, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("critical worker alerts fail closed and deliver once across retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-alerts-"));
  try {
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const sink = new FileCriticalAlertSink(join(directory, "delivered-alerts.json"), MANIFEST_DIGEST);
    const source = sourceFor({ networkLabel: "wrong-network" });
    const worker = new IndexerWorker(new EventIndexer(store), source, sink, () => 20_000n);
    const first = await worker.runOnce();
    equal(first.snapshot, null, "Identity mismatch cannot advance the durable checkpoint");
    ok(
      first.reconciliation?.alerts.some((alert) => alert.code === "DEPLOYMENT_IDENTITY"),
      "Deployment identity mismatch is critical",
    );
    const deliveredOnce = await sink.listDelivered();
    ok(deliveredOnce.length > 0, "Critical mismatch crosses the alert boundary");
    await rejects(
      () => new FileCriticalAlertSink(
        join(directory, "delivered-alerts.json"),
        "b".repeat(64),
      ).listDelivered(),
      TypeError,
    );

    const retry = await worker.runOnce();
    equal(retry.snapshot, null, "Retry remains fail closed while identity is wrong");
    equal(
      (await sink.listDelivered()).length,
      deliveredOnce.length,
      "Stable alert IDs suppress duplicate durable delivery across retries",
    );
    equal(
      (await store.listAlerts()).length,
      deliveredOnce.length,
      "Indexer alert journal also deduplicates the retried mismatch",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable alert journals reject malformed severity and stable-ID content reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cedra-indexer-alert-validation-"));
  try {
    const store = new FileIndexerStore(directory, MANIFEST_DIGEST);
    const baseAlert = {
      id: "reconcile:LEDGER_VERSION:global:1:0",
      severity: "critical",
      code: "LEDGER_VERSION",
      message: "Pinned ledger differs.",
      detectedAtUnixMilliseconds: 1n,
      cursor: { ledgerVersion: 1n, eventIndex: 0 },
      expected: "1",
      observed: "2",
    } as const;
    await appendWithLease(store, [baseAlert]);
    await appendWithLease(store, [{ ...baseAlert, detectedAtUnixMilliseconds: 2n }]);
    equal((await store.listAlerts()).length, 1, "Detection-clock changes are idempotent retries");
    await rejects(
      () => appendWithLease(store, [{ ...baseAlert, observed: "3" }]),
      TypeError,
    );
    await rejects(
      () => appendWithLease(store, [{ ...baseAlert, id: "warning", severity: "warning" }]),
      TypeError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
