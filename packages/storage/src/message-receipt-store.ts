import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  acquireOperationalStateDatabase,
  completeOperationalStoreCutover,
  type OperationalStateDatabaseLease,
  type OperationalStoreCutoverFailpoint,
} from './operational-state-store.js';
import { syncDirectory, syncDirectoryChain } from './stable-storage.js';
import { chainWrite } from './write-queue.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RECEIPT_SCHEMA_VERSION = 1 as const;
const RECEIPT_MAX_BYTES = 64 * 1024;

export type MessageReceiptOperation = 'submit' | 'retract' | 'interrupt';

export interface MessageOperationReceipt {
  readonly payload: unknown;
  readonly result: unknown;
}

export interface MessageReceiptStore {
  beginHostEpoch(hostEpoch: string): Promise<void>;
  read(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
  ): Promise<MessageOperationReceipt | undefined>;
  commit(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
    receipt: MessageOperationReceipt,
  ): Promise<MessageOperationReceipt>;
}

interface StoredMessageOperationReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly hostEpoch: string;
  readonly operation: MessageReceiptOperation;
  readonly sessionId: string;
  readonly operationId: string;
  readonly payload: unknown;
  readonly result: unknown;
}

export function createMessageReceiptStore(workspaceRoot: string): MessageReceiptStore {
  return new FileMessageReceiptStore(workspaceRoot);
}

export interface SqliteMessageReceiptStoreOptions {
  readonly failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

export interface ClosableMessageReceiptStore extends MessageReceiptStore {
  ready(): Promise<void>;
  close(): void;
}

export function createSqliteMessageReceiptStore(
  workspaceRoot: string,
  options: SqliteMessageReceiptStoreOptions = {},
): ClosableMessageReceiptStore {
  return new SqliteMessageReceiptStore(workspaceRoot, options);
}

class SqliteMessageReceiptStore implements ClosableMessageReceiptStore {
  readonly #root: string;
  readonly #lease: OperationalStateDatabaseLease;
  readonly #ready: Promise<void>;

  constructor(workspaceRoot: string, options: SqliteMessageReceiptStoreOptions) {
    this.#root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(this.#root);
    this.#ready = importLegacyMessageReceipts(this.#root, this.#lease, options);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async beginHostEpoch(hostEpoch: string): Promise<void> {
    validateHostEpoch(hostEpoch);
    await this.#ready;
    this.#lease.transaction('write', () => {
      this.#lease.database
        .prepare('INSERT OR IGNORE INTO core_message_host_epochs(host_epoch) VALUES (?)')
        .run(hostEpoch);
      this.#lease.database
        .prepare('DELETE FROM core_message_host_epochs WHERE host_epoch <> ?')
        .run(hostEpoch);
    });
  }

  async read(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
  ): Promise<MessageOperationReceipt | undefined> {
    validateIdentity(hostEpoch, operation, sessionId, operationId);
    await this.#ready;
    const row = this.#lease.database
      .prepare(`
        SELECT payload_json, result_json
        FROM core_message_receipts
        WHERE host_epoch = ? AND operation = ? AND session_id = ? AND operation_id = ?
      `)
      .get(hostEpoch, operation, sessionId, operationId) as
      | { payload_json?: unknown; result_json?: unknown }
      | undefined;
    if (!row) return undefined;
    if (typeof row.payload_json !== 'string' || typeof row.result_json !== 'string') {
      throw new Error('Invalid SQLite message operation receipt');
    }
    return Object.freeze({
      payload: JSON.parse(row.payload_json),
      result: JSON.parse(row.result_json),
    });
  }

  async commit(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
    receipt: MessageOperationReceipt,
  ): Promise<MessageOperationReceipt> {
    validateIdentity(hostEpoch, operation, sessionId, operationId);
    const stored = normalizeReceipt(hostEpoch, operation, sessionId, operationId, receipt);
    await this.#ready;
    return this.#lease.transaction('write', () => {
      this.#lease.database
        .prepare('INSERT OR IGNORE INTO core_message_host_epochs(host_epoch) VALUES (?)')
        .run(hostEpoch);
      const inserted = this.#lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_message_receipts(
            host_epoch, operation, session_id, operation_id, payload_json, result_json
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          hostEpoch,
          operation,
          sessionId,
          operationId,
          JSON.stringify(stored.payload),
          JSON.stringify(stored.result),
        );
      if (inserted.changes === 0) {
        const existing = readSqliteReceipt(
          this.#lease.database,
          hostEpoch,
          operation,
          sessionId,
          operationId,
        );
        if (!existing || !isDeepStrictEqual(existing, stored)) {
          throw new Error('Message operation receipt identity conflict');
        }
        return existing;
      }
      return stored;
    });
  }

  close(): void {
    this.#lease.close();
  }
}

class FileMessageReceiptStore implements MessageReceiptStore {
  readonly #durabilityRoot: string;
  readonly #epochsRoot: string;
  readonly #writeQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.#durabilityRoot = resolve(workspaceRoot);
    this.#epochsRoot = join(this.#durabilityRoot, 'message-receipts');
  }

  async beginHostEpoch(hostEpoch: string): Promise<void> {
    assertSafeId(hostEpoch, 'Invalid Host Epoch');
    await mkdir(join(this.#epochsRoot, hostEpoch), { recursive: true });
    const entries = await readdir(this.#epochsRoot, { withFileTypes: true });
    let removed = false;
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID_PATTERN.test(entry.name)) {
        throw new Error(`Invalid message receipt Epoch entry: ${entry.name}`);
      }
      if (entry.name === hostEpoch) continue;
      await rm(join(this.#epochsRoot, entry.name), { recursive: true });
      removed = true;
    }
    if (removed) await syncDirectory(this.#epochsRoot);
  }

  async read(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
  ): Promise<MessageOperationReceipt | undefined> {
    validateIdentity(hostEpoch, operation, sessionId, operationId);
    let raw: string;
    try {
      raw = await readFile(this.#receiptPath(hostEpoch, operation, sessionId, operationId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > RECEIPT_MAX_BYTES) {
      throw new Error('Message operation receipt exceeds size limit');
    }
    const stored = decodeStoredReceipt(JSON.parse(raw), {
      hostEpoch,
      operation,
      sessionId,
      operationId,
    });
    return Object.freeze({ payload: stored.payload, result: stored.result });
  }

  async commit(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
    receipt: MessageOperationReceipt,
  ): Promise<MessageOperationReceipt> {
    validateIdentity(hostEpoch, operation, sessionId, operationId);
    const stored: StoredMessageOperationReceipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      hostEpoch,
      operation,
      sessionId,
      operationId,
      payload: receipt.payload,
      result: receipt.result,
    };
    const encoded = JSON.stringify(stored);
    const snapshot = decodeStoredReceipt(JSON.parse(encoded), {
      hostEpoch,
      operation,
      sessionId,
      operationId,
    });
    if (!isDeepStrictEqual(snapshot, stored)) {
      throw new Error('Message operation receipt is not exactly JSON representable');
    }
    const serialized = `${encoded}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > RECEIPT_MAX_BYTES) {
      throw new Error('Message operation receipt exceeds size limit');
    }
    const key = `${hostEpoch}:${operation}:${sessionId}:${operationId}`;
    let committed: MessageOperationReceipt | undefined;
    await chainWrite(this.#writeQueues, key, async () => {
      const path = this.#receiptPath(hostEpoch, operation, sessionId, operationId);
      const created = await writeExclusiveDurable(path, serialized, this.#durabilityRoot);
      if (!created) {
        const existing = await this.read(hostEpoch, operation, sessionId, operationId);
        if (!existing) throw new Error('Message operation receipt disappeared');
        if (
          !isDeepStrictEqual(existing, {
            payload: snapshot.payload,
            result: snapshot.result,
          })
        ) {
          throw new Error('Message operation receipt identity conflict');
        }
        committed = existing;
        return;
      }
      committed = Object.freeze({ payload: snapshot.payload, result: snapshot.result });
    });
    if (!committed) throw new Error('Message operation receipt commit produced no result');
    return committed;
  }

  #receiptPath(
    hostEpoch: string,
    operation: MessageReceiptOperation,
    sessionId: string,
    operationId: string,
  ): string {
    return join(this.#epochsRoot, hostEpoch, operation, sessionId, `${operationId}.json`);
  }
}

interface LegacyMessageReceiptSnapshot {
  readonly epochs: readonly string[];
  readonly records: readonly StoredMessageOperationReceipt[];
}

async function importLegacyMessageReceipts(
  root: string,
  lease: OperationalStateDatabaseLease,
  options: SqliteMessageReceiptStoreOptions,
): Promise<void> {
  const snapshot = await readLegacyMessageReceiptSnapshot(root);
  const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  completeOperationalStoreCutover(lease, {
    storeName: 'message_receipts',
    sourcePath: join(root, 'message-receipts'),
    sourceFingerprint: `sha256:${fingerprint}`,
    failpoint: options.failpoint,
    importAndValidate: (db) => {
      for (const epoch of snapshot.epochs) {
        db.prepare('INSERT OR IGNORE INTO core_message_host_epochs(host_epoch) VALUES (?)').run(
          epoch,
        );
      }
      for (const record of snapshot.records) {
        insertOrValidateReceipt(db, record);
      }
      return {
        host_epochs: snapshot.epochs.length,
        message_receipts: snapshot.records.length,
      };
    },
  });
}

async function readLegacyMessageReceiptSnapshot(
  root: string,
): Promise<LegacyMessageReceiptSnapshot> {
  const epochsRoot = join(root, 'message-receipts');
  let epochEntries;
  try {
    epochEntries = await readdir(epochsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { epochs: [], records: [] };
    }
    throw error;
  }
  const legacy = new FileMessageReceiptStore(root);
  const epochs: string[] = [];
  const records: StoredMessageOperationReceipt[] = [];
  for (const epochEntry of epochEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    validateHostEpochEntry(epochEntry.name, epochEntry.isDirectory());
    epochs.push(epochEntry.name);
    const epochRoot = join(epochsRoot, epochEntry.name);
    for (const operation of ['interrupt', 'retract', 'submit'] as const) {
      const operationRoot = join(epochRoot, operation);
      let sessionEntries;
      try {
        sessionEntries = await readdir(operationRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const sessionEntry of sessionEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!sessionEntry.isDirectory() || !SAFE_ID_PATTERN.test(sessionEntry.name)) {
          throw new Error(`Invalid message receipt Session entry: ${sessionEntry.name}`);
        }
        const sessionRoot = join(operationRoot, sessionEntry.name);
        const receiptEntries = await readdir(sessionRoot, { withFileTypes: true });
        for (const receiptEntry of receiptEntries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!receiptEntry.isFile() || !receiptEntry.name.endsWith('.json')) {
            throw new Error(`Invalid message receipt entry: ${receiptEntry.name}`);
          }
          const operationId = receiptEntry.name.slice(0, -'.json'.length);
          validateIdentity(epochEntry.name, operation, sessionEntry.name, operationId);
          const receipt = await legacy.read(
            epochEntry.name,
            operation,
            sessionEntry.name,
            operationId,
          );
          if (!receipt) throw new Error('Legacy message operation receipt disappeared');
          records.push({
            schemaVersion: RECEIPT_SCHEMA_VERSION,
            hostEpoch: epochEntry.name,
            operation,
            sessionId: sessionEntry.name,
            operationId,
            payload: receipt.payload,
            result: receipt.result,
          });
        }
      }
    }
    const unexpected = (await readdir(epochRoot, { withFileTypes: true })).filter(
      (entry) =>
        !entry.isDirectory() ||
        (entry.name !== 'submit' && entry.name !== 'retract' && entry.name !== 'interrupt'),
    );
    if (unexpected.length > 0) {
      throw new Error(`Invalid message receipt Operation entry: ${unexpected[0]!.name}`);
    }
  }
  return { epochs, records };
}

function insertOrValidateReceipt(db: DatabaseSync, record: StoredMessageOperationReceipt): void {
  db.prepare('INSERT OR IGNORE INTO core_message_host_epochs(host_epoch) VALUES (?)').run(
    record.hostEpoch,
  );
  const inserted = db
    .prepare(`
      INSERT OR IGNORE INTO core_message_receipts(
        host_epoch, operation, session_id, operation_id, payload_json, result_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      record.hostEpoch,
      record.operation,
      record.sessionId,
      record.operationId,
      JSON.stringify(record.payload),
      JSON.stringify(record.result),
    );
  if (inserted.changes !== 0) return;
  const existing = readSqliteReceipt(
    db,
    record.hostEpoch,
    record.operation,
    record.sessionId,
    record.operationId,
  );
  if (
    !existing ||
    !isDeepStrictEqual(existing, { payload: record.payload, result: record.result })
  ) {
    throw new Error('Message receipt cutover conflict');
  }
}

function readSqliteReceipt(
  db: DatabaseSync,
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
): MessageOperationReceipt | undefined {
  const row = db
    .prepare(`
      SELECT payload_json, result_json
      FROM core_message_receipts
      WHERE host_epoch = ? AND operation = ? AND session_id = ? AND operation_id = ?
    `)
    .get(hostEpoch, operation, sessionId, operationId) as
    | { payload_json?: unknown; result_json?: unknown }
    | undefined;
  if (!row) return undefined;
  if (typeof row.payload_json !== 'string' || typeof row.result_json !== 'string') {
    throw new Error('Invalid SQLite message operation receipt');
  }
  return Object.freeze({
    payload: JSON.parse(row.payload_json),
    result: JSON.parse(row.result_json),
  });
}

function normalizeReceipt(
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
  receipt: MessageOperationReceipt,
): MessageOperationReceipt {
  const encoded = JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    hostEpoch,
    operation,
    sessionId,
    operationId,
    payload: receipt.payload,
    result: receipt.result,
  });
  if (Buffer.byteLength(`${encoded}\n`, 'utf8') > RECEIPT_MAX_BYTES) {
    throw new Error('Message operation receipt exceeds size limit');
  }
  const decoded = decodeStoredReceipt(JSON.parse(encoded), {
    hostEpoch,
    operation,
    sessionId,
    operationId,
  });
  return Object.freeze({ payload: decoded.payload, result: decoded.result });
}

function validateHostEpoch(hostEpoch: string): void {
  assertSafeId(hostEpoch, 'Invalid Host Epoch');
}

function validateHostEpochEntry(name: string, directory: boolean): void {
  if (!directory || !SAFE_ID_PATTERN.test(name)) {
    throw new Error(`Invalid message receipt Epoch entry: ${name}`);
  }
}

function validateIdentity(
  hostEpoch: string,
  operation: MessageReceiptOperation,
  sessionId: string,
  operationId: string,
): void {
  assertSafeId(hostEpoch, 'Invalid Host Epoch');
  if (operation !== 'submit' && operation !== 'retract' && operation !== 'interrupt') {
    throw new Error('Invalid message receipt operation');
  }
  assertSafeId(sessionId, 'Invalid Session identity');
  assertSafeId(operationId, 'Invalid message operation identity');
}

function decodeStoredReceipt(
  value: unknown,
  expected: {
    hostEpoch: string;
    operation: MessageReceiptOperation;
    sessionId: string;
    operationId: string;
  },
): StoredMessageOperationReceipt {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 7
  ) {
    throw new Error('Invalid message operation receipt');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    record.hostEpoch !== expected.hostEpoch ||
    record.operation !== expected.operation ||
    record.sessionId !== expected.sessionId ||
    record.operationId !== expected.operationId ||
    !Object.hasOwn(record, 'payload') ||
    !Object.hasOwn(record, 'result')
  ) {
    throw new Error('Invalid message operation receipt');
  }
  return record as unknown as StoredMessageOperationReceipt;
}

async function writeExclusiveDurable(
  path: string,
  content: string,
  durabilityRoot: string,
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
  await syncDirectoryChain(dirname(path), durabilityRoot);
  return true;
}

function assertSafeId(value: string, message: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error(message);
}
