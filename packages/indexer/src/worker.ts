import { resolve } from "node:path";

import {
  EventIndexer,
  type IndexerWriterCycle,
  type ProcessResult,
} from "./event-indexer.js";
import {
  decodeCriticalAlert,
  encodeCriticalAlert,
  equivalentCriticalAlert,
  assertSha256Digest,
  readFileSecurely,
  sha256Text,
  withExclusiveFileLock,
  writeFileAtomically,
} from "./file-store.js";
import type {
  CriticalAlert,
  IndexerSnapshot,
  ProtocolEventSource,
  ReconciliationReport,
} from "./types.js";

export interface CriticalAlertSink {
  /** Implementations must use `alert.id` as their idempotency key. */
  deliver(alert: CriticalAlert): Promise<void>;
}

export interface WorkerRunResult {
  readonly processing: ProcessResult;
  readonly reconciliation: ReconciliationReport | null;
  readonly snapshot: IndexerSnapshot | null;
  readonly deliveredAlertIds: readonly string[];
}

interface DeliveredAlertFile {
  readonly schemaVersion: 1;
  readonly manifestSha256: string;
  readonly payloadSha256: string;
  readonly alerts: readonly string[];
}

const MAX_DELIVERED_ALERT_BYTES = 64 * 1024 * 1024;

/**
 * Durable local alert boundary suitable for an operations sidecar to tail.
 * Records are atomically persisted and deduplicated by the stable alert ID.
 */
export class FileCriticalAlertSink implements CriticalAlertSink {
  private readonly path: string;
  private readonly manifestSha256: string;

  public constructor(path: string, manifestSha256: string) {
    this.path = resolve(path);
    this.manifestSha256 = assertSha256Digest(manifestSha256, "release manifest digest");
  }

  public async deliver(alert: CriticalAlert): Promise<void> {
    const next = encodeCriticalAlert(alert);
    await withExclusiveFileLock(`${this.path}.lock`, async () => {
      const existing = await this.load();
      const prior = existing.find((entry) => entry.id === alert.id);
      if (prior !== undefined) {
        if (!equivalentCriticalAlert(prior, alert)) {
          throw new TypeError(`Delivered critical alert ID was reused with different content: ${alert.id}`);
        }
        return;
      }
      const encoded = [...existing.map(encodeCriticalAlert), next];
      const payload = JSON.stringify(encoded);
      const file: DeliveredAlertFile = {
        schemaVersion: 1,
        manifestSha256: this.manifestSha256,
        payloadSha256: sha256Text(payload),
        alerts: encoded,
      };
      const output = `${JSON.stringify(file)}\n`;
      if (Buffer.byteLength(output, "utf8") > MAX_DELIVERED_ALERT_BYTES) {
        throw new RangeError("Delivered critical-alert file exceeds its durable file limit");
      }
      await writeFileAtomically(this.path, output);
    });
  }

  public async listDelivered(): Promise<readonly CriticalAlert[]> {
    return this.load();
  }

  private async load(): Promise<readonly CriticalAlert[]> {
    const encoded = await readFileSecurely(this.path, MAX_DELIVERED_ALERT_BYTES);
    if (encoded === null) return [];
    const value: unknown = JSON.parse(encoded);
    if (
      typeof value !== "object"
      || value === null
      || (value as Partial<DeliveredAlertFile>).schemaVersion !== 1
      || (value as Partial<DeliveredAlertFile>).manifestSha256 !== this.manifestSha256
      || typeof (value as Partial<DeliveredAlertFile>).payloadSha256 !== "string"
      || !Array.isArray((value as Partial<DeliveredAlertFile>).alerts)
      || !(value as Partial<DeliveredAlertFile>).alerts!.every((entry) => typeof entry === "string")
    ) throw new TypeError("Invalid delivered-alert file");
    const file = value as DeliveredAlertFile;
    if (!/^[0-9a-f]{64}$/.test(file.payloadSha256)) {
      throw new TypeError("Invalid delivered-alert payload digest");
    }
    if (sha256Text(JSON.stringify(file.alerts)) !== file.payloadSha256) {
      throw new TypeError("Delivered-alert payload digest mismatch");
    }
    const alerts = file.alerts.map(decodeCriticalAlert);
    if (new Set(alerts.map((alert) => alert.id)).size !== alerts.length) {
      throw new TypeError("Duplicate delivered critical alert ID");
    }
    return alerts;
  }
}

/**
 * One restart-safe, read-only worker cycle. It begins at the durable snapshot,
 * polls one bounded page, reconciles views at exactly the event cursor's ledger
 * version, and checkpoints only a zero-alert result. It never owns a signer.
 */
export class IndexerWorker {
  public constructor(
    private readonly indexer: EventIndexer,
    private readonly source: ProtocolEventSource,
    private readonly alertSink: CriticalAlertSink,
    private readonly nowUnixMilliseconds: () => bigint = () => BigInt(Date.now()),
  ) {}

  public async runOnce(limit = 200): Promise<WorkerRunResult> {
    return this.indexer.withExclusiveStoreWriter((cycle) => this.runOnceUnderLease(cycle, limit));
  }

  private async runOnceUnderLease(cycle: IndexerWriterCycle, limit: number): Promise<WorkerRunResult> {
    await cycle.restoreLatestSnapshot();
    const processing = await cycle.pollOnce(this.source, limit);
    const deliveredAlertIds: string[] = [];
    await this.deliver(processing.alerts, deliveredAlertIds);
    if (processing.alerts.length > 0 || processing.cursor === null) {
      return { processing, reconciliation: null, snapshot: null, deliveredAlertIds };
    }

    const reconciliation = await cycle.reconcile(this.source);
    await this.deliver(reconciliation.alerts, deliveredAlertIds);
    if (!reconciliation.reconciled) {
      return { processing, reconciliation, snapshot: null, deliveredAlertIds };
    }

    const snapshot = await cycle.snapshot(this.nowUnixMilliseconds());
    return { processing, reconciliation, snapshot, deliveredAlertIds };
  }

  private async deliver(
    alerts: readonly CriticalAlert[],
    deliveredAlertIds: string[],
  ): Promise<void> {
    for (const alert of alerts) {
      await this.alertSink.deliver(alert);
      deliveredAlertIds.push(alert.id);
    }
  }
}
