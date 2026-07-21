import { createEmptyProjection, reduceEventGroup } from "./reducer.js";
import { CEDRA_TESTNET_CHAIN_ID } from "../../protocol-sdk/src/types.js";
import {
  IndexerWriterLeaseRequiredError,
  StaleIndexerSnapshotError,
} from "./file-store.js";
import { reconcile } from "./reconciler.js";
import { decodeSnapshot, encodeSnapshot, takeSnapshot } from "./snapshot.js";
import type {
  CriticalAlert,
  EventCursor,
  IndexerSnapshot,
  IndexerStore,
  IndexerWriterLease,
  ProtocolEvent,
  ProtocolEventSource,
  ProtocolProjection,
  ReconciliationReport,
} from "./types.js";

function compareCursor(left: EventCursor, right: EventCursor): number {
  if (left.ledgerVersion !== right.ledgerVersion) {
    return left.ledgerVersion < right.ledgerVersion ? -1 : 1;
  }
  return left.eventIndex - right.eventIndex;
}

function eventCursor(event: ProtocolEvent): EventCursor {
  return { ledgerVersion: event.ledgerVersion, eventIndex: event.eventIndex };
}

function eventOrderAlert(event: ProtocolEvent, previous: EventCursor | null): CriticalAlert {
  return {
    id: `event:${event.id}:EVENT_ORDER`,
    severity: "critical",
    code: "EVENT_ORDER",
    message: "Event cursor is not strictly later than the indexer checkpoint.",
    detectedAtUnixMilliseconds: event.timestampUnixMilliseconds,
    cursor: previous,
    expected: previous === null ? "first event" : `${previous.ledgerVersion}:${previous.eventIndex}`,
    observed: `${event.ledgerVersion}:${event.eventIndex}`,
  };
}

export interface ProcessResult {
  readonly processedEvents: number;
  readonly skippedEvents: number;
  readonly rejectedEvents: number;
  readonly cursor: EventCursor | null;
  readonly alerts: readonly CriticalAlert[];
}

/**
 * Explicit capability for one store-owned writer cycle. The capability closes
 * over the exact store lease; callers must not retain or share it outside the
 * callback passed to `withExclusiveStoreWriter`.
 */
export interface IndexerWriterCycle {
  restoreLatestSnapshot(): Promise<IndexerSnapshot | null>;
  process(events: readonly ProtocolEvent[]): Promise<ProcessResult>;
  pollOnce(source: ProtocolEventSource, limit?: number): Promise<ProcessResult>;
  reconcile(source: ProtocolEventSource): Promise<ReconciliationReport>;
  snapshot(takenAtUnixMilliseconds: bigint): Promise<IndexerSnapshot>;
}

export class CedraChainIdMismatchError extends Error {
  public constructor(observed: number) {
    super(`Event source must be Cedra Testnet chain ${CEDRA_TESTNET_CHAIN_ID.toString()}, observed ${String(observed)}`);
    this.name = "CedraChainIdMismatchError";
  }
}

export class UnreconciledCheckpointError extends Error {
  public constructor(detail: string) {
    super(`Indexer checkpoint refused: ${detail}`);
    this.name = "UnreconciledCheckpointError";
  }
}

export class ConcurrentIndexerOperationError extends Error {
  public constructor() {
    super("An unrelated indexer state operation overlaps the active writer cycle.");
    this.name = "ConcurrentIndexerOperationError";
  }
}

export class InvalidIndexerWriterCycleError extends Error {
  public constructor() {
    super("The indexer writer-cycle capability is inactive or is not the current owner.");
    this.name = "InvalidIndexerWriterCycleError";
  }
}

/**
 * Deterministic, read-only event worker. It can be restarted from every saved
 * snapshot and never owns a signer, wallet, mutation endpoint, or credentials.
 */
export class EventIndexer {
  private projection: ProtocolProjection = createEmptyProjection();
  private cursor: EventCursor | null = null;
  private reconciledProjection: ProtocolProjection | null = null;
  private reconciledCursor: EventCursor | null = null;
  private reconciledStateIdentity: string | null = null;
  private activeStateOwner: object | null = null;
  private durableBaseSnapshotId: string | null | undefined;

  public constructor(private readonly store: IndexerStore) {}

  public getCursor(): EventCursor | null {
    return this.cursor === null ? null : { ...this.cursor };
  }

  public getProjection(): ProtocolProjection {
    // `readonly` is compile-time only. Never expose the live Maps and nested
    // records whose mutation could corrupt replay or inherit a prior clean
    // reconciliation authorization.
    return structuredClone(this.projection);
  }

  public restoreLatestSnapshot(): Promise<IndexerSnapshot | null> {
    return this.withDirectStateOperation((owner) => this.restoreLatestSnapshotOwned(owner));
  }

  private async restoreLatestSnapshotOwned(owner: object): Promise<IndexerSnapshot | null> {
    this.assertStateOwner(owner);
    this.invalidateReconciliation();
    const loaded = await this.store.loadLatestSnapshot();
    this.assertStateOwner(owner);
    if (loaded === null) {
      this.projection = createEmptyProjection();
      this.cursor = null;
      this.durableBaseSnapshotId = null;
      return null;
    }
    // Stores are an I/O boundary, including injected stores in tests and
    // applications. Validate and detach before retaining any nested Map,
    // cursor, or projection reference.
    const snapshot = decodeSnapshot(encodeSnapshot(structuredClone(loaded)));
    this.projection = structuredClone(snapshot.projection);
    this.cursor = snapshot.cursor === null ? null : { ...snapshot.cursor };
    this.durableBaseSnapshotId = snapshot.id;
    return structuredClone(snapshot);
  }

  public process(events: readonly ProtocolEvent[]): Promise<ProcessResult> {
    return this.withDirectStateOperation((owner) => this.processOwned(events, owner));
  }

  private async processOwned(
    events: readonly ProtocolEvent[],
    owner: object,
    writerLease?: IndexerWriterLease,
  ): Promise<ProcessResult> {
    this.assertStateOwner(owner);
    // Even an overlap-only or empty page crosses the event-source boundary.
    // Require a fresh exact-cursor view reconciliation before another durable
    // checkpoint can be written.
    this.invalidateReconciliation();
    const detachedEvents = structuredClone(events);
    const sorted = [...detachedEvents].sort((left, right) => compareCursor(eventCursor(left), eventCursor(right)));
    const alerts: CriticalAlert[] = [];
    let processedEvents = 0;
    let skippedEvents = 0;
    let rejectedEvents = 0;

    const fresh: ProtocolEvent[] = [];
    for (const event of sorted) {
      if (this.cursor !== null && compareCursor(eventCursor(event), this.cursor) <= 0) {
        skippedEvents += 1;
        continue;
      }
      fresh.push(event);
    }

    const groups: ProtocolEvent[][] = [];
    for (const event of fresh) {
      const current = groups[groups.length - 1];
      if (current === undefined || current[0]!.ledgerVersion !== event.ledgerVersion) {
        groups.push([event]);
      } else {
        current.push(event);
      }
    }

    for (const group of groups) {
      const first = group[0]!;
      const last = group[group.length - 1]!;
      if (this.cursor !== null && compareCursor(eventCursor(first), this.cursor) <= 0) {
        alerts.push(eventOrderAlert(first, this.cursor));
        rejectedEvents += group.length;
        break;
      }
      const result = reduceEventGroup(this.projection, group);
      if (result.alerts.length > 0) {
        alerts.push(...result.alerts);
        rejectedEvents += group.length;
        // Fail closed at the first divergent transaction. No partial state or
        // cursor checkpoint is committed, so a corrected complete page can be replayed.
        break;
      }
      this.projection = result.projection;
      this.cursor = eventCursor(last);
      processedEvents += group.length;
    }

    if (alerts.length > 0) {
      await this.persistAlerts(alerts, writerLease);
      this.assertStateOwner(owner);
    }
    return {
      processedEvents,
      skippedEvents,
      rejectedEvents,
      cursor: this.getCursor(),
      alerts: structuredClone(alerts),
    };
  }

  public snapshot(takenAtUnixMilliseconds: bigint): Promise<IndexerSnapshot> {
    return this.withDirectStateOperation((owner) => this.snapshotOwned(takenAtUnixMilliseconds, owner));
  }

  private async snapshotOwned(
    takenAtUnixMilliseconds: bigint,
    owner: object,
    writerLease?: IndexerWriterLease,
  ): Promise<IndexerSnapshot> {
    this.assertStateOwner(owner);
    if (typeof takenAtUnixMilliseconds !== "bigint" || takenAtUnixMilliseconds < 0n) {
      throw new RangeError("checkpoint time must be a non-negative bigint");
    }
    if (this.cursor === null) {
      throw new UnreconciledCheckpointError("at least one complete event transaction is required");
    }
    const authoritiesComplete = this.projection.operationalAdmins.reflectionCore !== null
      && this.projection.operationalAdmins.testAssets !== null
      && this.projection.operationalAdmins.testAmm !== null;
    if (
      this.projection.chainId !== CEDRA_TESTNET_CHAIN_ID
      || !this.projection.deploymentReady
      || !authoritiesComplete
    ) {
      throw new UnreconciledCheckpointError(
        "Cedra Testnet identity and complete core, faucet, and AMM authority histories are required",
      );
    }
    if (
      this.reconciledProjection !== this.projection
      || this.reconciledCursor === null
      || compareCursor(this.reconciledCursor, this.cursor) !== 0
      || this.reconciledStateIdentity !== this.checkpointStateIdentity(this.projection, this.cursor)
    ) {
      throw new UnreconciledCheckpointError(
        "a successful chain-2 reconciliation of this exact projection and cursor is required",
      );
    }
    const snapshot = takeSnapshot({
      projection: this.projection,
      cursor: this.cursor,
      takenAtUnixMilliseconds,
    });
    return this.withStoreWriter(writerLease, async (lease) => {
      this.assertStateOwner(owner);
      if (this.durableBaseSnapshotId === undefined) {
        const existing = await this.store.loadLatestSnapshot();
        this.assertStateOwner(owner);
        if (existing !== null) {
          throw new StaleIndexerSnapshotError(
            "indexer attempted to checkpoint without restoring the existing durable base",
          );
        }
        this.durableBaseSnapshotId = null;
      }
      await this.store.saveSnapshot(
        structuredClone(snapshot),
        lease,
        this.durableBaseSnapshotId,
      );
      this.assertStateOwner(owner);
      this.durableBaseSnapshotId = snapshot.id;
      return structuredClone(snapshot);
    });
  }

  public reconcile(source: ProtocolEventSource): Promise<ReconciliationReport> {
    return this.withDirectStateOperation((owner) => this.reconcileOwned(source, owner));
  }

  private async reconcileOwned(
    source: ProtocolEventSource,
    owner: object,
    writerLease?: IndexerWriterLease,
  ): Promise<ReconciliationReport> {
    this.assertStateOwner(owner);
    if (this.cursor === null) {
      throw new Error("Cannot reconcile before at least one complete event transaction is indexed.");
    }
    this.invalidateReconciliation();
    const projection = this.projection;
    const cursor = { ...this.cursor };
    const stateIdentity = this.checkpointStateIdentity(projection, cursor);
    const observed = structuredClone(await source.getAccountingSnapshot(cursor.ledgerVersion));
    this.assertStateOwner(owner);
    const report = reconcile(projection, observed, cursor);
    if (report.alerts.length > 0) {
      await this.persistAlerts(report.alerts, writerLease);
      this.assertStateOwner(owner);
    }
    const authoritiesComplete = projection.operationalAdmins.reflectionCore !== null
      && projection.operationalAdmins.testAssets !== null
      && projection.operationalAdmins.testAmm !== null;
    if (
      report.reconciled
      && projection.chainId === CEDRA_TESTNET_CHAIN_ID
      && observed.chainId === CEDRA_TESTNET_CHAIN_ID
      && projection.deploymentReady
      && authoritiesComplete
      && this.projection === projection
      && this.cursor !== null
      && compareCursor(this.cursor, cursor) === 0
      && this.checkpointStateIdentity(this.projection, this.cursor) === stateIdentity
    ) {
      this.reconciledProjection = projection;
      this.reconciledCursor = cursor;
      this.reconciledStateIdentity = stateIdentity;
    }
    return structuredClone(report);
  }

  /** One bounded read-only poll; callers schedule this with their own worker. */
  public pollOnce(source: ProtocolEventSource, limit = 200): Promise<ProcessResult> {
    return this.withDirectStateOperation((owner) => this.pollOnceOwned(source, limit, owner));
  }

  private async pollOnceOwned(
    source: ProtocolEventSource,
    limit: number,
    owner: object,
    writerLease?: IndexerWriterLease,
  ): Promise<ProcessResult> {
    this.assertStateOwner(owner);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("event page limit must be an integer between 1 and 10,000");
    }
    const page = structuredClone(await source.listEvents(this.getCursor(), limit));
    this.assertStateOwner(owner);
    if (page.chainId !== CEDRA_TESTNET_CHAIN_ID) {
      throw new CedraChainIdMismatchError(page.chainId);
    }
    return this.processOwned(page.events, owner, writerLease);
  }

  /** Hold one exact store lease and state-owner capability for a complete cycle. */
  public withExclusiveStoreWriter<T>(operation: (cycle: IndexerWriterCycle) => Promise<T>): Promise<T> {
    return this.store.withExclusiveWriter(async (lease) => {
      const owner = Object.freeze({});
      return this.withStateOwner(owner, async () => {
        let cycleMethodActive = false;
        const pendingCycleMethods = new Set<Promise<unknown>>();
        const cycleMethodFailures: unknown[] = [];
        const invoke = <R>(action: () => Promise<R>): Promise<R> => {
          // The exact promise returned to the capability caller is also the
          // promise retained by the cycle. Keep ownership/concurrency checks
          // inside it so even an immediately rejected, unawaited invocation is
          // drained and failure-propagated before the lease can be released.
          const tracked = (async () => {
            this.assertStateOwner(owner);
            if (cycleMethodActive) throw new ConcurrentIndexerOperationError();
            cycleMethodActive = true;
            try {
              return await action();
            } finally {
              cycleMethodActive = false;
            }
          })();
          pendingCycleMethods.add(tracked);
          void tracked.then(
            () => { pendingCycleMethods.delete(tracked); },
            (error: unknown) => {
              cycleMethodFailures.push(error);
              pendingCycleMethods.delete(tracked);
            },
          );
          return tracked;
        };
        const cycle: IndexerWriterCycle = Object.freeze({
          restoreLatestSnapshot: () => invoke(() => this.restoreLatestSnapshotOwned(owner)),
          process: (events: readonly ProtocolEvent[]) => invoke(() => this.processOwned(events, owner, lease)),
          pollOnce: (source: ProtocolEventSource, limit = 200) => (
            invoke(() => this.pollOnceOwned(source, limit, owner, lease))
          ),
          reconcile: (source: ProtocolEventSource) => invoke(() => this.reconcileOwned(source, owner, lease)),
          snapshot: (takenAt: bigint) => invoke(() => this.snapshotOwned(takenAt, owner, lease)),
        });
        let result: T | undefined;
        let callbackFailure: unknown;
        let callbackFailed = false;
        try {
          result = await operation(cycle);
        } catch (error) {
          callbackFailed = true;
          callbackFailure = error;
        }
        while (pendingCycleMethods.size > 0) {
          await Promise.allSettled([...pendingCycleMethods]);
        }
        if (callbackFailed) throw callbackFailure;
        if (cycleMethodFailures.length > 0) throw cycleMethodFailures[0];
        return result as T;
      });
    });
  }

  private withStoreWriter<T>(
    writerLease: IndexerWriterLease | undefined,
    operation: (lease: IndexerWriterLease) => Promise<T>,
  ): Promise<T> {
    if (writerLease !== undefined) return operation(writerLease);
    if (!this.store.permitsImplicitWriterLease) {
      throw new IndexerWriterLeaseRequiredError();
    }
    return this.store.withExclusiveWriter(operation);
  }

  private persistAlerts(
    alerts: readonly CriticalAlert[],
    writerLease?: IndexerWriterLease,
  ): Promise<void> {
    if (alerts.length === 0) return Promise.resolve();
    return this.withStoreWriter(
      writerLease,
      (lease) => this.store.appendAlerts(structuredClone(alerts), lease),
    );
  }

  private withDirectStateOperation<T>(operation: (owner: object) => Promise<T>): Promise<T> {
    const owner = Object.freeze({});
    return this.withStateOwner(owner, () => operation(owner));
  }

  private async withStateOwner<T>(owner: object, operation: () => Promise<T>): Promise<T> {
    if (this.activeStateOwner !== null) throw new ConcurrentIndexerOperationError();
    this.activeStateOwner = owner;
    try {
      return await operation();
    } finally {
      if (this.activeStateOwner === owner) this.activeStateOwner = null;
    }
  }

  private assertStateOwner(owner: object): void {
    if (this.activeStateOwner !== owner) throw new InvalidIndexerWriterCycleError();
  }

  private invalidateReconciliation(): void {
    this.reconciledProjection = null;
    this.reconciledCursor = null;
    this.reconciledStateIdentity = null;
  }

  private checkpointStateIdentity(projection: ProtocolProjection, cursor: EventCursor): string {
    // Snapshot IDs are SHA-256 identities over cursor plus the fully
    // serialised projection. A fixed time makes the identity independent of
    // when the comparison is performed.
    return takeSnapshot({
      projection,
      cursor,
      takenAtUnixMilliseconds: 0n,
    }).id;
  }
}
