import type { CriticalAlert, IndexerSnapshot, IndexerStore } from "./types.js";

/** Test/development store. Production must inject a durable, access-controlled store. */
export class InMemoryIndexerStore implements IndexerStore {
  private latest: IndexerSnapshot | null = null;
  private readonly alerts: CriticalAlert[] = [];

  public async loadLatestSnapshot(): Promise<IndexerSnapshot | null> {
    return this.latest;
  }

  public async saveSnapshot(snapshot: IndexerSnapshot): Promise<void> {
    this.latest = snapshot;
  }

  public async appendAlerts(alerts: readonly CriticalAlert[]): Promise<void> {
    this.alerts.push(...alerts);
  }

  public async listAlerts(): Promise<readonly CriticalAlert[]> {
    return [...this.alerts];
  }
}
