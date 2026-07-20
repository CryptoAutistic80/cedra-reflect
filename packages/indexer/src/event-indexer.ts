import { createEmptyProjection, reduceEventGroup } from "./reducer.js";
import { reconcile } from "./reconciler.js";
import { projectionFromSnapshot, takeSnapshot } from "./snapshot.js";
import type {
  CriticalAlert,
  EventCursor,
  IndexerSnapshot,
  IndexerStore,
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
 * Deterministic, read-only event worker. It can be restarted from every saved
 * snapshot and never owns a signer, wallet, mutation endpoint, or credentials.
 */
export class EventIndexer {
  private projection: ProtocolProjection = createEmptyProjection();
  private cursor: EventCursor | null = null;

  public constructor(private readonly store: IndexerStore) {}

  public getCursor(): EventCursor | null {
    return this.cursor;
  }

  public getProjection(): ProtocolProjection {
    return this.projection;
  }

  public async restoreLatestSnapshot(): Promise<IndexerSnapshot | null> {
    const snapshot = await this.store.loadLatestSnapshot();
    if (snapshot !== null) {
      this.projection = projectionFromSnapshot(snapshot);
      this.cursor = snapshot.cursor;
    }
    return snapshot;
  }

  public async process(events: readonly ProtocolEvent[]): Promise<ProcessResult> {
    const sorted = [...events].sort((left, right) => compareCursor(eventCursor(left), eventCursor(right)));
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
      await this.store.appendAlerts(alerts);
    }
    return { processedEvents, skippedEvents, rejectedEvents, cursor: this.cursor, alerts };
  }

  public async snapshot(takenAtUnixMilliseconds: bigint): Promise<IndexerSnapshot> {
    const snapshot = takeSnapshot({
      projection: this.projection,
      cursor: this.cursor,
      takenAtUnixMilliseconds,
    });
    await this.store.saveSnapshot(snapshot);
    return snapshot;
  }

  public async reconcile(source: ProtocolEventSource): Promise<ReconciliationReport> {
    const observed = await source.getAccountingSnapshot();
    const report = reconcile(this.projection, observed, this.cursor);
    if (report.alerts.length > 0) {
      await this.store.appendAlerts(report.alerts);
    }
    return report;
  }

  /** One bounded read-only poll; callers schedule this with their own worker. */
  public async pollOnce(source: ProtocolEventSource, limit = 200): Promise<ProcessResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("event page limit must be an integer between 1 and 10,000");
    }
    const page = await source.listEvents(this.cursor, limit);
    return this.process(page.events);
  }
}
