import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { decodeSnapshot, encodeSnapshot } from "./snapshot.js";
import type {
  CriticalAlert,
  IndexerSnapshot,
  IndexerStore,
  IndexerWriterLease,
} from "./types.js";

interface SnapshotEnvelope {
  readonly schemaVersion: 1;
  readonly manifestSha256: string;
  readonly payloadSha256: string;
  readonly snapshot: string;
}

interface AlertEnvelope {
  readonly schemaVersion: 1;
  readonly manifestSha256: string;
  readonly payloadSha256: string;
  readonly alerts: readonly string[];
}

const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_ALERT_BYTES = 64 * 1024 * 1024;
const MAX_ALERT_ID_LENGTH = 512;
const MAX_ALERT_MESSAGE_LENGTH = 8_192;
const MAX_ALERT_VALUE_LENGTH = 8_192;
const ALERT_CODES = new Set<CriticalAlert["code"]>([
  "EVENT_ORDER",
  "EVENT_DATA",
  "TRANSACTION_GROUP",
  "IDENTIFIER_REUSE",
  "DOUBLE_COUNTING",
  "FEE_FORMULA",
  "VAULT_BACKING",
  "REFLECTION_LIABILITY",
  "CORE_ACCOUNTING",
  "GLOBAL_INDEX",
  "ELIGIBLE_SUPPLY",
  "LIFETIME_TOTAL",
  "POOL_RESERVES",
  "POOL_LIMITS",
  "FAUCET_CONFIG",
  "RESERVE_CUSTODY",
  "CUSTODY_ACCOUNTING",
  "ROUTE_PAIR",
  "OLD_EPOCH_ROUTE",
  "LP_ACCOUNTING",
  "LP_VAULT_BACKING",
  "VAULT_BINDING",
  "POSITION_ACCOUNTING",
  "WALLET_REGISTRATION",
  "PACKAGE_VERSION",
  "PAUSE_STATE",
  "OPERATIONAL_ADMIN",
  "DEPLOYMENT_IDENTITY",
  "LEDGER_VERSION",
]);

export class ConcurrentDurableWriterError extends Error {
  public constructor(lockPath: string) {
    super(`Another durable indexer writer holds the exclusive lock: ${lockPath}`);
    this.name = "ConcurrentDurableWriterError";
  }
}

export class StaleIndexerSnapshotError extends Error {
  public constructor(detail: string) {
    super(`Refusing a stale or conflicting indexer snapshot: ${detail}`);
    this.name = "StaleIndexerSnapshotError";
  }
}

export class InvalidIndexerWriterLeaseError extends Error {
  public constructor() {
    super("Durable indexer mutation requires the active lease issued by this exact store instance.");
    this.name = "InvalidIndexerWriterLeaseError";
  }
}

export class IndexerWriterLeaseRequiredError extends Error {
  public constructor() {
    super("Durable indexer mutation requires one explicit full-cycle writer lease.");
    this.name = "IndexerWriterLeaseRequiredError";
  }
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertSha256Digest(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

async function validateSecureDirectory(path: string, create: boolean): Promise<boolean> {
  const directory = resolve(path);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`Durable indexer path is not a real directory: ${directory}`);
  }
  if (process.platform !== "win32" && await realpath(directory) !== directory) {
    throw new TypeError(`Durable indexer directory contains a symbolic-link component: ${directory}`);
  }
  // The path is explicitly dedicated to indexer state. Reassert owner-only
  // access on every write instead of relying on the process umask.
  if (process.platform !== "win32") {
    if (create) {
      await chmod(directory, 0o700);
    } else if ((metadata.mode & 0o077) !== 0) {
      throw new TypeError(`Durable indexer directory must be owner-only (0700): ${directory}`);
    }
  }
  return true;
}

/**
 * Cross-instance/process exclusive lock. Contention and crash-stale lock files
 * fail closed; operators may remove a stale lock only after proving no writer
 * is alive. Automatic lock stealing would risk two valid writers.
 */
export async function withExclusiveFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedLock = resolve(lockPath);
  await validateSecureDirectory(dirname(resolvedLock), true);
  let handle;
  try {
    handle = await open(
      resolvedLock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") {
      throw new ConcurrentDurableWriterError(resolvedLock);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(resolvedLock).catch(() => undefined);
  }
}

/** Read a bounded regular file without following a final-component symlink. */
export async function readFileSecurely(path: string, maximumBytes = MAX_ALERT_BYTES): Promise<string | null> {
  if (!await validateSecureDirectory(dirname(path), false)) return null;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new TypeError(`Refusing to follow a symbolic link for durable state: ${path}`);
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError(`Durable state is not a regular file: ${path}`);
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || metadata.size > maximumBytes) {
      throw new RangeError(`Durable state exceeds its ${maximumBytes.toString()} byte limit: ${path}`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new TypeError(`Durable state must be owner-only (0600): ${path}`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

/** Write one access-controlled file and atomically replace the prior version. */
export async function writeFileAtomically(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await validateSecureDirectory(directory, true);
  const temporary = `${path}.${process.pid.toString()}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    await handle.close();
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  // Persist the rename itself where the platform supports directory fsync.
  try {
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Some filesystems reject directory fsync. The file contents were still
    // synced before the atomic rename, so this is a durability reduction, not
    // permission to accept malformed state.
  }
}

function encodeBigintJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => (
    typeof current === "bigint" ? { $bigint: current.toString() } : current
  ));
}

function decodeBigintJson(value: string): unknown {
  return JSON.parse(value, (_key, current: unknown) => {
    if (
      typeof current === "object"
      && current !== null
      && "$bigint" in current
      && Object.keys(current).length === 1
      && typeof (current as { readonly $bigint?: unknown }).$bigint === "string"
    ) {
      const encoded = (current as { readonly $bigint: string }).$bigint;
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(encoded)) {
        throw new TypeError("Invalid persisted bigint encoding");
      }
      return BigInt(encoded);
    }
    return current;
  });
}

function boundedString(value: unknown, label: string, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return true;
}

function validCursor(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const cursor = value as { readonly ledgerVersion?: unknown; readonly eventIndex?: unknown };
  return typeof cursor.ledgerVersion === "bigint"
    && cursor.ledgerVersion >= 0n
    && Number.isSafeInteger(cursor.eventIndex)
    && (cursor.eventIndex as number) >= 0;
}

export function decodeCriticalAlert(value: string): CriticalAlert {
  const decoded = decodeBigintJson(value);
  if (
    typeof decoded !== "object"
    || decoded === null
    || !boundedString((decoded as Partial<CriticalAlert>).id, "critical alert id", MAX_ALERT_ID_LENGTH)
    || (decoded as Partial<CriticalAlert>).severity !== "critical"
    || !ALERT_CODES.has((decoded as Partial<CriticalAlert>).code as CriticalAlert["code"])
    || !boundedString((decoded as Partial<CriticalAlert>).message, "critical alert message", MAX_ALERT_MESSAGE_LENGTH)
    || typeof (decoded as Partial<CriticalAlert>).detectedAtUnixMilliseconds !== "bigint"
    || (decoded as Partial<CriticalAlert>).detectedAtUnixMilliseconds! < 0n
    || !validCursor((decoded as Partial<CriticalAlert>).cursor)
    || (
      (decoded as Partial<CriticalAlert>).expected !== undefined
      && (
        typeof (decoded as Partial<CriticalAlert>).expected !== "string"
        || (decoded as Partial<CriticalAlert>).expected!.length > MAX_ALERT_VALUE_LENGTH
      )
    )
    || (
      (decoded as Partial<CriticalAlert>).observed !== undefined
      && (
        typeof (decoded as Partial<CriticalAlert>).observed !== "string"
        || (decoded as Partial<CriticalAlert>).observed!.length > MAX_ALERT_VALUE_LENGTH
      )
    )
  ) {
    throw new TypeError("Invalid persisted critical alert");
  }
  return decoded as CriticalAlert;
}

export function encodeCriticalAlert(alert: CriticalAlert): string {
  // Validation also rejects malformed in-memory values supplied through an
  // `as unknown as CriticalAlert` escape before anything reaches disk.
  const encoded = encodeBigintJson(alert);
  decodeCriticalAlert(encoded);
  return encoded;
}

/** Alert retries may have a later detection clock but no other mutation. */
export function equivalentCriticalAlert(left: CriticalAlert, right: CriticalAlert): boolean {
  return left.id === right.id
    && left.severity === right.severity
    && left.code === right.code
    && left.message === right.message
    && left.cursor?.ledgerVersion === right.cursor?.ledgerVersion
    && left.cursor?.eventIndex === right.cursor?.eventIndex
    && left.expected === right.expected
    && left.observed === right.observed;
}

function compareSnapshotCursor(
  left: IndexerSnapshot["cursor"],
  right: IndexerSnapshot["cursor"],
): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  if (left.ledgerVersion !== right.ledgerVersion) {
    return left.ledgerVersion < right.ledgerVersion ? -1 : 1;
  }
  return left.eventIndex - right.eventIndex;
}

function snapshotStateDigest(snapshot: IndexerSnapshot): string {
  const serialised = JSON.parse(encodeSnapshot(snapshot)) as {
    readonly schemaVersion: unknown;
    readonly cursor: unknown;
    readonly projection: unknown;
  };
  return sha256Text(JSON.stringify({
    schemaVersion: serialised.schemaVersion,
    cursor: serialised.cursor,
    projection: serialised.projection,
  }));
}

function assertMonotonicSnapshot(existing: IndexerSnapshot, candidate: IndexerSnapshot): void {
  const order = compareSnapshotCursor(candidate.cursor, existing.cursor);
  if (order < 0) {
    throw new StaleIndexerSnapshotError("candidate cursor precedes the durable cursor");
  }
  if (order === 0 && snapshotStateDigest(candidate) !== snapshotStateDigest(existing)) {
    throw new StaleIndexerSnapshotError("the same cursor was reused with different projection state");
  }
}

/**
 * Durable single-worker store. Snapshot and alert files are content-hashed,
 * bound to one approved release-manifest digest, permission-restricted, and
 * replaced atomically. It never stores a key, signer, RPC credential, or
 * transaction payload.
 */
export class FileIndexerStore implements IndexerStore {
  public readonly permitsImplicitWriterLease = false;
  private readonly snapshotPath: string;
  private readonly alertsPath: string;
  private readonly writerLeasePath: string;
  private readonly manifestSha256: string;
  private activeLease: IndexerWriterLease | null = null;
  private readonly pendingLeaseMutations = new Set<Promise<void>>();
  private leaseMutationFailures: unknown[] = [];

  public constructor(directory: string, manifestSha256: string) {
    const root = resolve(directory);
    this.snapshotPath = resolve(root, "indexer-snapshot.json");
    this.alertsPath = resolve(root, "critical-alerts.json");
    this.writerLeasePath = resolve(root, "indexer-writer.lock");
    this.manifestSha256 = assertSha256Digest(manifestSha256, "release manifest digest");
  }

  public withExclusiveWriter<T>(operation: (lease: IndexerWriterLease) => Promise<T>): Promise<T> {
    return withExclusiveFileLock(this.writerLeasePath, async () => {
      const lease = Object.freeze({}) as IndexerWriterLease;
      this.activeLease = lease;
      this.leaseMutationFailures = [];
      let result: T | undefined;
      let callbackFailure: unknown;
      let callbackFailed = false;
      try {
        result = await operation(lease);
      } catch (error) {
        callbackFailed = true;
        callbackFailure = error;
      } finally {
        while (this.pendingLeaseMutations.size > 0) {
          await Promise.allSettled([...this.pendingLeaseMutations]);
        }
        this.activeLease = null;
      }
      const mutationFailed = this.leaseMutationFailures.length > 0;
      const mutationFailure = this.leaseMutationFailures[0];
      this.leaseMutationFailures = [];
      if (callbackFailed) throw callbackFailure;
      if (mutationFailed) throw mutationFailure;
      return result as T;
    });
  }

  public async loadLatestSnapshot(): Promise<IndexerSnapshot | null> {
    const encoded = await readFileSecurely(this.snapshotPath, MAX_SNAPSHOT_BYTES);
    if (encoded === null) return null;
    const envelope = this.parseSnapshotEnvelope(encoded);
    return decodeSnapshot(envelope.snapshot);
  }

  public saveSnapshot(
    snapshot: IndexerSnapshot,
    lease: IndexerWriterLease,
    expectedBaseSnapshotId: string | null,
  ): Promise<void> {
    this.assertActiveLease(lease);
    const operation = this.saveSnapshotUnderLease(
      structuredClone(snapshot),
      lease,
      expectedBaseSnapshotId,
    );
    return this.trackLeaseMutation(operation);
  }

  private async saveSnapshotUnderLease(
    snapshot: IndexerSnapshot,
    lease: IndexerWriterLease,
    expectedBaseSnapshotId: string | null,
  ): Promise<void> {
    if (
      expectedBaseSnapshotId !== null
      && !/^snapshot-[0-9a-f]{64}$/.test(expectedBaseSnapshotId)
    ) {
      throw new TypeError("Expected base snapshot ID is malformed");
    }
    const payload = encodeSnapshot(snapshot);
    const validatedSnapshot = decodeSnapshot(payload);
    const envelope: SnapshotEnvelope = {
      schemaVersion: 1,
      manifestSha256: this.manifestSha256,
      payloadSha256: sha256Text(payload),
      snapshot: payload,
    };
    const encoded = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("Indexer snapshot envelope exceeds its durable file limit");
    }
    await withExclusiveFileLock(`${this.snapshotPath}.lock`, async () => {
      this.assertActiveLease(lease);
      const existing = await this.loadLatestSnapshot();
      if ((existing?.id ?? null) !== expectedBaseSnapshotId) {
        throw new StaleIndexerSnapshotError("durable base changed after this indexer restored its state");
      }
      if (existing !== null) assertMonotonicSnapshot(existing, validatedSnapshot);
      this.assertActiveLease(lease);
      await writeFileAtomically(this.snapshotPath, encoded);
    });
  }

  public appendAlerts(alerts: readonly CriticalAlert[], lease: IndexerWriterLease): Promise<void> {
    this.assertActiveLease(lease);
    if (alerts.length === 0) return Promise.resolve();
    return this.trackLeaseMutation(this.appendAlertsUnderLease(structuredClone(alerts), lease));
  }

  private async appendAlertsUnderLease(
    alerts: readonly CriticalAlert[],
    lease: IndexerWriterLease,
  ): Promise<void> {
    // Validate the entire incoming batch before acquiring or mutating durable
    // state, then serialize the read-modify-write journal update under a lock.
    const incoming = alerts.map((alert) => [alert, encodeCriticalAlert(alert)] as const);
    await withExclusiveFileLock(`${this.alertsPath}.lock`, async () => {
      this.assertActiveLease(lease);
      const existing = await this.loadAlertStrings();
      const byId = new Map(existing.map((entry) => [decodeCriticalAlert(entry).id, entry]));
      for (const [alert, alertEncoded] of incoming) {
        const prior = byId.get(alert.id);
        if (
          prior !== undefined
          && !equivalentCriticalAlert(decodeCriticalAlert(prior), alert)
        ) {
          throw new TypeError(`Critical alert ID was reused with different content: ${alert.id}`);
        }
        if (prior === undefined) byId.set(alert.id, alertEncoded);
      }
      const payload = JSON.stringify([...byId.values()]);
      const envelope: AlertEnvelope = {
        schemaVersion: 1,
        manifestSha256: this.manifestSha256,
        payloadSha256: sha256Text(payload),
        alerts: [...byId.values()],
      };
      const encoded = `${JSON.stringify(envelope)}\n`;
      if (Buffer.byteLength(encoded, "utf8") > MAX_ALERT_BYTES) {
        throw new RangeError("Critical-alert envelope exceeds its durable file limit");
      }
      this.assertActiveLease(lease);
      await writeFileAtomically(this.alertsPath, encoded);
    });
  }

  public async listAlerts(): Promise<readonly CriticalAlert[]> {
    return (await this.loadAlertStrings()).map(decodeCriticalAlert);
  }

  private parseSnapshotEnvelope(encoded: string): SnapshotEnvelope {
    const value: unknown = JSON.parse(encoded);
    if (
      typeof value !== "object"
      || value === null
      || (value as Partial<SnapshotEnvelope>).schemaVersion !== 1
      || (value as Partial<SnapshotEnvelope>).manifestSha256 !== this.manifestSha256
      || typeof (value as Partial<SnapshotEnvelope>).payloadSha256 !== "string"
      || typeof (value as Partial<SnapshotEnvelope>).snapshot !== "string"
    ) {
      throw new TypeError("Invalid or release-manifest-mismatched indexer snapshot envelope");
    }
    const envelope = value as SnapshotEnvelope;
    assertSha256Digest(envelope.payloadSha256, "snapshot payload digest");
    if (sha256Text(envelope.snapshot) !== envelope.payloadSha256) {
      throw new TypeError("Indexer snapshot payload digest mismatch");
    }
    return envelope;
  }

  private async loadAlertStrings(): Promise<readonly string[]> {
    const encoded = await readFileSecurely(this.alertsPath, MAX_ALERT_BYTES);
    if (encoded === null) return [];
    const value: unknown = JSON.parse(encoded);
    if (
      typeof value !== "object"
      || value === null
      || (value as Partial<AlertEnvelope>).schemaVersion !== 1
      || (value as Partial<AlertEnvelope>).manifestSha256 !== this.manifestSha256
      || typeof (value as Partial<AlertEnvelope>).payloadSha256 !== "string"
      || !Array.isArray((value as Partial<AlertEnvelope>).alerts)
      || !(value as Partial<AlertEnvelope>).alerts!.every((entry) => typeof entry === "string")
    ) {
      throw new TypeError("Invalid or release-manifest-mismatched critical-alert envelope");
    }
    const envelope = value as AlertEnvelope;
    assertSha256Digest(envelope.payloadSha256, "critical-alert payload digest");
    const payload = JSON.stringify(envelope.alerts);
    if (sha256Text(payload) !== envelope.payloadSha256) {
      throw new TypeError("Critical-alert payload digest mismatch");
    }
    // Validate every record before returning any of them.
    const ids = new Set<string>();
    for (const alert of envelope.alerts) {
      const decoded = decodeCriticalAlert(alert);
      if (ids.has(decoded.id)) throw new TypeError(`Duplicate persisted critical alert ID: ${decoded.id}`);
      ids.add(decoded.id);
    }
    return envelope.alerts;
  }

  private assertActiveLease(lease: IndexerWriterLease): void {
    if (this.activeLease === null || this.activeLease !== lease) {
      throw new InvalidIndexerWriterLeaseError();
    }
  }

  private trackLeaseMutation(operation: Promise<void>): Promise<void> {
    this.pendingLeaseMutations.add(operation);
    void operation.then(
      () => { this.pendingLeaseMutations.delete(operation); },
      (error: unknown) => {
        this.leaseMutationFailures.push(error);
        this.pendingLeaseMutations.delete(operation);
      },
    );
    return operation;
  }
}
