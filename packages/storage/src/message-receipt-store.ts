import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
