import type {
  CriticalAlert,
  IndexerSnapshot,
  IndexerStore,
  IndexerWriterLease,
} from "./types.js";
import {
  ConcurrentDurableWriterError,
  InvalidIndexerWriterLeaseError,
  StaleIndexerSnapshotError,
} from "./file-store.js";

/** Test/development store. Production must inject a durable, access-controlled store. */
export class InMemoryIndexerStore implements IndexerStore {
  public readonly permitsImplicitWriterLease = true;
  private latest: IndexerSnapshot | null = null;
  private readonly alerts: CriticalAlert[] = [];
  private writerActive = false;
  private activeLease: IndexerWriterLease | null = null;

  public async withExclusiveWriter<T>(operation: (lease: IndexerWriterLease) => Promise<T>): Promise<T> {
    if (this.writerActive) throw new ConcurrentDurableWriterError("in-memory-indexer-writer");
    this.writerActive = true;
    const lease = Object.freeze({}) as IndexerWriterLease;
    this.activeLease = lease;
    try {
      return await operation(lease);
    } finally {
      this.activeLease = null;
      this.writerActive = false;
    }
  }

  public async loadLatestSnapshot(): Promise<IndexerSnapshot | null> {
    return this.latest === null ? null : structuredClone(this.latest);
  }

  public async saveSnapshot(
    snapshot: IndexerSnapshot,
    lease: IndexerWriterLease,
    expectedBaseSnapshotId: string | null,
  ): Promise<void> {
    this.assertActiveLease(lease);
    if ((this.latest?.id ?? null) !== expectedBaseSnapshotId) {
      throw new StaleIndexerSnapshotError("in-memory durable base changed after restore");
    }
    this.latest = structuredClone(snapshot);
  }

  public async appendAlerts(alerts: readonly CriticalAlert[], lease: IndexerWriterLease): Promise<void> {
    this.assertActiveLease(lease);
    this.alerts.push(...structuredClone(alerts));
  }

  public async listAlerts(): Promise<readonly CriticalAlert[]> {
    return structuredClone(this.alerts);
  }

  private assertActiveLease(lease: IndexerWriterLease): void {
    if (this.activeLease === null || this.activeLease !== lease) {
      throw new InvalidIndexerWriterLeaseError();
    }
  }
}
