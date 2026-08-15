import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isCanonicalExtensionId,
  isCanonicalExtensionScopeId,
} from '@maka/runtime/extension-lifecycle-kernel';

const SCHEMA_VERSION = 1 as const;
const MAX_STATE_BYTES = 1024 * 1024;
const STATE_FILE_NAME = 'extension-bindings-v1.json';

export interface PersistedExtensionBinding {
  readonly bindingId: string;
  readonly scopeId: string;
  readonly extensionId: string;
  readonly desiredRevision: string;
  readonly lastGoodRevision: string | null;
  readonly enabled: boolean;
  readonly error: string | null;
}

interface PersistedExtensionState {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly bindings: readonly PersistedExtensionBinding[];
}

export class HostExtensionStateStoreError extends Error {
  readonly name = 'HostExtensionStateStoreError';

  constructor(
    readonly code: 'persistence_failed' | 'commit_outcome_unknown',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Root-private, single-Host durable desired state for trusted Extensions. */
export class HostExtensionStateStore {
  readonly path: string;

  constructor(controlDirectory: string) {
    this.path = join(controlDirectory, STATE_FILE_NAME);
  }

  async read(): Promise<readonly PersistedExtensionBinding[]> {
    let encoded: Buffer;
    try {
      encoded = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw persistenceError('Unable to read Extension state', error);
    }
    if (encoded.byteLength > MAX_STATE_BYTES) {
      throw persistenceError('Extension state exceeds its size limit');
    }
    try {
      return decodeState(JSON.parse(encoded.toString('utf8'))).bindings;
    } catch (error) {
      if (error instanceof HostExtensionStateStoreError) throw error;
      throw persistenceError('Extension state is invalid', error);
    }
  }

  async replace(bindings: readonly PersistedExtensionBinding[]): Promise<void> {
    const document = decodeState({
      schemaVersion: SCHEMA_VERSION,
      bindings: [...bindings].sort((left, right) => compareString(left.bindingId, right.bindingId)),
    });
    const encoded = `${JSON.stringify(document)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) {
      throw persistenceError('Extension state exceeds its size limit');
    }
    const directory = dirname(this.path);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      renamed = true;
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (renamed) {
        throw new HostExtensionStateStoreError(
          'commit_outcome_unknown',
          'Extension state commit outcome is unknown',
          { cause: error },
        );
      }
      throw persistenceError('Unable to persist Extension state', error);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function decodeState(value: unknown): PersistedExtensionState {
  const state = exactRecord(value, ['schemaVersion', 'bindings']);
  if (state.schemaVersion !== SCHEMA_VERSION || !Array.isArray(state.bindings)) {
    throw persistenceError('Extension state schema is invalid');
  }
  const ids = new Set<string>();
  const scopeExtensions = new Set<string>();
  const bindings = state.bindings.map((item): PersistedExtensionBinding => {
    const binding = exactRecord(item, [
      'bindingId',
      'scopeId',
      'extensionId',
      'desiredRevision',
      'lastGoodRevision',
      'enabled',
      'error',
    ]);
    const decoded = Object.freeze({
      bindingId: entityId(binding.bindingId, 'bindingId'),
      scopeId: extensionScopeId(binding.scopeId),
      extensionId: extensionId(binding.extensionId),
      desiredRevision: revision(binding.desiredRevision, 'desiredRevision'),
      lastGoodRevision:
        binding.lastGoodRevision === null
          ? null
          : revision(binding.lastGoodRevision, 'lastGoodRevision'),
      enabled: boolean(binding.enabled, 'enabled'),
      error: nullableError(binding.error),
    });
    if (ids.has(decoded.bindingId)) throw persistenceError('Extension bindingId is duplicated');
    ids.add(decoded.bindingId);
    const scopeExtension = `${decoded.scopeId}\u0000${decoded.extensionId}`;
    if (scopeExtensions.has(scopeExtension)) {
      throw persistenceError('Extension scope and extensionId are duplicated');
    }
    scopeExtensions.add(scopeExtension);
    return decoded;
  });
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, bindings: Object.freeze(bindings) });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw persistenceError('Extension state record is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw persistenceError('Extension state fields are invalid');
  }
  return record;
}

function entityId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw persistenceError(`Extension ${label} is invalid`);
  }
  return value;
}

function extensionScopeId(value: unknown): string {
  if (!isCanonicalExtensionScopeId(value)) {
    throw persistenceError('Extension scopeId is invalid');
  }
  return value;
}

function extensionId(value: unknown): string {
  if (!isCanonicalExtensionId(value)) {
    throw persistenceError('Extension extensionId is invalid');
  }
  return value;
}

function revision(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    /[\r\n]/u.test(value)
  ) {
    throw persistenceError(`Extension ${label} is invalid`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw persistenceError(`Extension ${label} is invalid`);
  return value;
}

function nullableError(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096) {
    throw persistenceError('Extension error is invalid');
  }
  return value;
}

function persistenceError(message: string, cause?: unknown): HostExtensionStateStoreError {
  return new HostExtensionStateStoreError('persistence_failed', message, { cause });
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
