import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  decodeInteractionCanonicalOutcome,
  decodeInteractionRequest,
  interactionCanonicalOutcomesEquivalent,
  isInteractionCanonicalOutcomeValidForRequest,
  projectInteractionQuestionRequest,
  type InteractionCanonicalOutcome,
  type InteractionRequest,
} from '@maka/core';
import { syncDirectory, syncDirectoryChain } from './stable-storage.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REMEMBER_SCOPE_ID = /^[0-9a-f]{64}$/;
const TEMP_FILE = /^(request|outcome)\.json\.[0-9a-f-]+\.tmp$/;
export const STORED_INTERACTION_REQUEST_MAX_BYTES = 20 * 1024;
export const STORED_INTERACTION_OUTCOME_MAX_BYTES = 12 * 1024;

export interface InteractionIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly requestId: string;
}

export interface StoredInteractionRequest extends InteractionIdentity {
  readonly createdAt: number;
  readonly request: InteractionRequest;
  readonly rememberScopeId?: string;
}

export interface StoredInteractionOutcome extends InteractionIdentity {
  readonly outcome: InteractionCanonicalOutcome;
}

export interface InteractionRecord {
  readonly request: StoredInteractionRequest;
  readonly outcome?: StoredInteractionOutcome;
}

export interface PendingInteractionFilter {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly kind?: InteractionRequest['kind'];
}

export type InteractionStoreErrorCode =
  | 'invalid_input'
  | 'invalid_record'
  | 'request_not_found'
  | 'io_failed';

export class InteractionStoreError extends Error {
  constructor(
    readonly code: InteractionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InteractionStoreError';
  }
}

export type InteractionMutationFailureResult =
  | {
      readonly status: 'definitely_not_published';
      readonly failure: InteractionStoreError;
    }
  | { readonly status: 'unresolved'; readonly failure: InteractionStoreError };

export type EstablishInteractionRequestResult =
  | {
      readonly status: 'stable';
      readonly matches: boolean;
      readonly record: InteractionRecord;
    }
  | InteractionMutationFailureResult;

export type CommitInteractionOutcomeResult =
  | {
      readonly status: 'stable';
      readonly matches: boolean;
      readonly record: InteractionRecord & {
        readonly outcome: StoredInteractionOutcome;
      };
    }
  | InteractionMutationFailureResult;

export interface InteractionStoreReader {
  readInteraction(requestId: string): Promise<InteractionRecord | undefined>;
  listPending(filter?: PendingInteractionFilter): Promise<StoredInteractionRequest[]>;
}

export interface InteractionStoreWriter extends InteractionStoreReader {
  establishRequest(input: StoredInteractionRequest): Promise<EstablishInteractionRequestResult>;
  commitOutcome(
    requestId: string,
    outcome: InteractionCanonicalOutcome,
  ): Promise<CommitInteractionOutcomeResult>;
}

export interface InteractiveInteractionStoreReaderFacade extends InteractionStoreReader {
  readonly kind: 'interactive';
  readonly access: 'read';
}

export interface InteractiveInteractionStoreWriterFacade extends InteractionStoreWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
}

const writersByLease = new WeakMap<object, InteractiveInteractionStoreWriterFacade>();
const writerOpeningsByLease = new WeakMap<
  object,
  Promise<InteractiveInteractionStoreWriterFacade>
>();
const readers = new WeakSet<object>();
const writers = new WeakSet<object>();

export function authenticateInteractionStoreReader(
  store: InteractiveInteractionStoreReaderFacade,
): InteractiveInteractionStoreReaderFacade {
  if (!readers.has(store)) throw invalidFacade('read');
  return store;
}

export function authenticateInteractionStoreWriter(
  store: InteractiveInteractionStoreWriterFacade,
): InteractiveInteractionStoreWriterFacade {
  if (!writers.has(store)) throw invalidFacade('write');
  return store;
}

export function interactionLocator(requestId: string): string {
  return createHash('sha256').update(assertId(requestId)).digest('hex');
}

export async function openInteractiveInteractionStoreForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveInteractionStoreReaderFacade> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const store = new FileInteractionStore(lease.canonicalPath);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'read', operation);
  const facade = Object.freeze({
    kind: 'interactive' as const,
    access: 'read' as const,
    readInteraction: (requestId: string) => run(() => store.readInteraction(requestId)),
    listPending: (filter?: PendingInteractionFilter) => run(() => store.listPending(filter)),
  });
  readers.add(facade);
  return facade;
}

export async function openInteractiveInteractionStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveInteractionStoreWriterFacade> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writersByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningsByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    const store = new FileInteractionStore(lease.canonicalPath);
    const run = <T>(operation: () => Promise<T>) =>
      runWithStorageRootLease(lease, 'interactive', 'write', operation);
    await run(() => store.recover());
    const recoveredExisting = writersByLease.get(lease);
    if (recoveredExisting) return recoveredExisting;
    const facade = Object.freeze({
      kind: 'interactive' as const,
      access: 'write' as const,
      readInteraction: (requestId: string) => run(() => store.readInteraction(requestId)),
      listPending: (filter?: PendingInteractionFilter) => run(() => store.listPending(filter)),
      establishRequest: (input: StoredInteractionRequest) =>
        run(() => store.establishRequest(input)),
      commitOutcome: (requestId: string, outcome: InteractionCanonicalOutcome) =>
        run(() => store.commitOutcome(requestId, outcome)),
    });
    writers.add(facade);
    writersByLease.set(lease, facade);
    return facade;
  });
  writerOpeningsByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningsByLease.get(lease) === pending) writerOpeningsByLease.delete(lease);
  }
}

class FileInteractionStore {
  private readonly root: string;
  private readonly interactionsRoot: string;
  private readonly locatorTails = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = resolve(root);
    this.interactionsRoot = join(this.root, 'interactions');
  }

  async recover(): Promise<void> {
    await mkdir(this.interactionsRoot, { recursive: true, mode: 0o700 });
    await syncDirectoryChain(this.interactionsRoot, this.root);
    for (const locator of await this.locators()) {
      await this.withLocator(locator, async () => {
        const directory = join(this.interactionsRoot, locator);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && TEMP_FILE.test(entry.name))
            await unlink(join(directory, entry.name));
        }
        await syncDirectory(directory);
        const record = await this.readLocatorUnlocked(locator);
        if (!record) {
          await rmdir(directory);
          await syncDirectory(this.interactionsRoot);
        }
      });
    }
  }

  async establishRequest(
    input: StoredInteractionRequest,
  ): Promise<EstablishInteractionRequestResult> {
    const candidate = normalizeRequest(input, 'input');
    const locator = interactionLocator(candidate.requestId);
    return this.withLocator(locator, async () => {
      const attempt = await this.publish(
        locator,
        'request.json',
        encode(candidate, STORED_INTERACTION_REQUEST_MAX_BYTES),
      );
      try {
        await this.stabilizeLocatorUnlocked(locator);
        const record = await this.readLocatorUnlocked(locator, candidate.requestId);
        if (record)
          return {
            status: 'stable',
            matches: isDeepStrictEqual(record.request, candidate),
            record,
          };
      } catch (error) {
        return {
          status: 'unresolved',
          failure: failure(error, 'Request publication could not be stabilized'),
        };
      }
      return attempt === 'not_attempted'
        ? {
            status: 'definitely_not_published',
            failure: new InteractionStoreError(
              'io_failed',
              'Request publication did not reach its exclusive link',
            ),
          }
        : {
            status: 'unresolved',
            failure: new InteractionStoreError(
              'io_failed',
              'Request publication outcome is ambiguous',
            ),
          };
    });
  }

  async commitOutcome(
    requestId: string,
    outcome: InteractionCanonicalOutcome,
  ): Promise<CommitInteractionOutcomeResult> {
    assertId(requestId);
    const locator = interactionLocator(requestId);
    return this.withLocator(locator, async () => {
      let record: InteractionRecord | undefined;
      try {
        await this.stabilizeLocatorUnlocked(locator);
        record = await this.readLocatorUnlocked(locator, requestId);
      } catch (error) {
        return {
          status: 'unresolved',
          failure: failure(error, 'Request could not be read'),
        };
      }
      if (!record)
        throw new InteractionStoreError(
          'request_not_found',
          `Interaction request '${requestId}' does not exist`,
        );
      let canonical: InteractionCanonicalOutcome;
      try {
        canonical = decodeInteractionCanonicalOutcome(outcome);
      } catch (error) {
        decodeFailure('input', 'Invalid Interaction outcome', error);
      }
      if (!isInteractionCanonicalOutcomeValidForRequest(record.request.request, canonical)) {
        throw new InteractionStoreError('invalid_input', 'Outcome is not valid for its request');
      }
      const candidate: StoredInteractionOutcome = {
        ...identity(record.request),
        outcome: canonical,
      };
      const attempt = await this.publish(
        locator,
        'outcome.json',
        encode(candidate, STORED_INTERACTION_OUTCOME_MAX_BYTES),
      );
      try {
        await this.stabilizeLocatorUnlocked(locator);
        const settled = await this.readLocatorUnlocked(locator, requestId);
        if (settled?.outcome) {
          return {
            status: 'stable',
            matches: interactionCanonicalOutcomesEquivalent(settled.outcome.outcome, canonical),
            record: settled as InteractionRecord & {
              outcome: StoredInteractionOutcome;
            },
          };
        }
      } catch (error) {
        return {
          status: 'unresolved',
          failure: failure(error, 'Outcome publication could not be stabilized'),
        };
      }
      return attempt === 'not_attempted'
        ? {
            status: 'definitely_not_published',
            failure: new InteractionStoreError(
              'io_failed',
              'Outcome publication did not reach its exclusive link',
            ),
          }
        : {
            status: 'unresolved',
            failure: new InteractionStoreError(
              'io_failed',
              'Outcome publication outcome is ambiguous',
            ),
          };
    });
  }

  async readInteraction(requestId: string): Promise<InteractionRecord | undefined> {
    const locator = interactionLocator(requestId);
    return this.withLocator(locator, () => this.readLocatorUnlocked(locator, requestId));
  }

  async listPending(filter: PendingInteractionFilter = {}): Promise<StoredInteractionRequest[]> {
    normalizeFilter(filter);
    const result: StoredInteractionRequest[] = [];
    for (const locator of await this.locators()) {
      const record = await this.withLocator(locator, () => this.readLocatorUnlocked(locator));
      if (record && !record.outcome && matches(record.request, filter)) result.push(record.request);
    }
    return result.sort(
      (a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId),
    );
  }

  private async publish(
    locator: string,
    name: string,
    bytes: Buffer,
  ): Promise<'published_or_existing' | 'not_attempted'> {
    const directory = join(this.interactionsRoot, locator);
    let temp: string | undefined;
    let linked = false;
    let linkAttempted = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await syncDirectoryChain(directory, this.root);
      temp = join(directory, `${name}.${randomUUID()}.tmp`);
      const handle = await open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        linkAttempted = true;
        await link(temp, join(directory, name));
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await syncDirectory(directory);
      await unlink(temp);
      temp = undefined;
      await syncDirectory(directory);
      return 'published_or_existing';
    } catch {
      if (temp) await unlink(temp).catch(() => undefined);
      return linked || linkAttempted ? 'published_or_existing' : 'not_attempted';
    }
  }

  private async readLocatorUnlocked(
    locator: string,
    expectedId?: string,
  ): Promise<InteractionRecord | undefined> {
    const directory = join(this.interactionsRoot, locator);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (entries.some((entry) => TEMP_FILE.test(entry.name)))
      throw new InteractionStoreError(
        'invalid_record',
        'Interaction contains an unresolved temporary artifact',
      );
    const requestRaw = await readOptional(
      join(directory, 'request.json'),
      STORED_INTERACTION_REQUEST_MAX_BYTES,
    );
    if (requestRaw === undefined) {
      if (entries.some((entry) => entry.name === 'outcome.json'))
        throw new InteractionStoreError('invalid_record', 'Outcome exists without request');
      return undefined;
    }
    const request = normalizeRequest(parseJsonRecord(requestRaw, 'request'), 'record');
    if (
      (expectedId && request.requestId !== expectedId) ||
      interactionLocator(request.requestId) !== locator
    )
      throw new InteractionStoreError('invalid_record', 'Request identity does not match locator');
    const outcomeRaw = await readOptional(
      join(directory, 'outcome.json'),
      STORED_INTERACTION_OUTCOME_MAX_BYTES,
    );
    const outcome =
      outcomeRaw === undefined
        ? undefined
        : normalizeOutcome(parseJsonRecord(outcomeRaw, 'outcome'), request);
    return deepFreeze({ request, ...(outcome ? { outcome } : {}) });
  }

  private async stabilizeLocatorUnlocked(locator: string): Promise<void> {
    const directory = join(this.interactionsRoot, locator);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && TEMP_FILE.test(entry.name)) {
        await unlink(join(directory, entry.name));
      }
    }
    await syncDirectory(directory);
  }

  private async locators(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.interactionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  private async withLocator<T>(locator: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locatorTails.get(locator) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.locatorTails.set(locator, tail);
    try {
      return await result;
    } finally {
      if (this.locatorTails.get(locator) === tail) this.locatorTails.delete(locator);
    }
  }
}

async function readOptional(path: string, limit: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new InteractionStoreError('invalid_record', 'Interaction document is not a file');
    if (stat.size > limit)
      throw new InteractionStoreError('invalid_record', 'Interaction document exceeds size limit');
    const bytes = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total > limit)
      throw new InteractionStoreError('invalid_record', 'Interaction document exceeds size limit');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
    } catch (error) {
      throw new InteractionStoreError('invalid_record', 'Interaction document is not valid UTF-8', {
        cause: error,
      });
    }
  } finally {
    await handle.close();
  }
}

type DecodeSource = 'input' | 'record';

function normalizeRequest(value: unknown, source: DecodeSource): StoredInteractionRequest {
  const record = closedRecord(
    value,
    ['sessionId', 'turnId', 'runId', 'requestId', 'createdAt', 'request'],
    ['rememberScopeId'],
    source,
  );
  const createdAt = record.createdAt;
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0)
    decodeFailure(source, 'createdAt must be a non-negative safe integer');
  let request: InteractionRequest;
  try {
    request = decodeInteractionRequest(record.request);
    if (request.kind === 'question') {
      const canonical = projectInteractionQuestionRequest({
        toolUseId: request.toolUseId,
        questions: request.questions,
      });
      if (!isDeepStrictEqual(request, canonical))
        decodeFailure(source, 'Interaction question request is not canonical safe text');
      request = canonical;
    }
  } catch (error) {
    if (error instanceof InteractionStoreError) throw error;
    decodeFailure(source, 'Invalid Interaction request', error);
  }
  const rememberScopeId =
    record.rememberScopeId === undefined
      ? undefined
      : assertRememberScopeId(record.rememberScopeId, source);
  if (rememberScopeId !== undefined && !isRememberScopeEligible(request))
    decodeFailure(source, 'rememberScopeId requires a rememberable tool permission request');
  return {
    sessionId: assertId(record.sessionId, source),
    turnId: assertId(record.turnId, source),
    runId: assertId(record.runId, source),
    requestId: assertId(record.requestId, source),
    createdAt: createdAt as number,
    request,
    ...(rememberScopeId === undefined ? {} : { rememberScopeId }),
  };
}

function normalizeOutcome(
  value: unknown,
  request: StoredInteractionRequest,
): StoredInteractionOutcome {
  const record = closedRecord(
    value,
    ['sessionId', 'turnId', 'runId', 'requestId', 'outcome'],
    [],
    'record',
  );
  const storedIdentity: InteractionIdentity = {
    sessionId: assertId(record.sessionId, 'record'),
    turnId: assertId(record.turnId, 'record'),
    runId: assertId(record.runId, 'record'),
    requestId: assertId(record.requestId, 'record'),
  };
  if (!isDeepStrictEqual(storedIdentity, identity(request)))
    throw new InteractionStoreError('invalid_record', 'Outcome identity does not match request');
  let outcome: InteractionCanonicalOutcome;
  try {
    outcome = decodeInteractionCanonicalOutcome(record.outcome);
  } catch (error) {
    decodeFailure('record', 'Invalid stored Interaction outcome', error);
  }
  if (!isInteractionCanonicalOutcomeValidForRequest(request.request, outcome))
    throw new InteractionStoreError('invalid_record', 'Stored outcome is invalid for request');
  return { ...identity(request), outcome };
}

function identity(value: InteractionIdentity): InteractionIdentity {
  return {
    sessionId: value.sessionId,
    turnId: value.turnId,
    runId: value.runId,
    requestId: value.requestId,
  };
}
function assertId(
  value: unknown,
  source: DecodeSource = 'input',
  message = 'Invalid Interaction identity',
): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) decodeFailure(source, message);
  return value;
}

function assertRememberScopeId(value: unknown, source: DecodeSource): string {
  if (typeof value !== 'string' || !REMEMBER_SCOPE_ID.test(value))
    decodeFailure(source, 'rememberScopeId must be a lowercase 64-character SHA-256 digest');
  return value;
}

function isRememberScopeEligible(request: InteractionRequest): boolean {
  return (
    request.kind === 'permission' &&
    request.prompt.kind === 'tool_permission' &&
    request.prompt.rememberForTurnAllowed
  );
}

function closedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  source: DecodeSource,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    decodeFailure(source, 'Stored Interaction request must be a plain object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    decodeFailure(source, 'Stored Interaction request must be a plain object');
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    Reflect.ownKeys(record).some((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor === undefined || !('value' in descriptor);
    }) ||
    required.some((key) => !Object.hasOwn(record, key))
  )
    decodeFailure(source, 'Stored Interaction request has invalid fields');
  return record;
}

function parseJsonRecord(serialized: string, context: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new InteractionStoreError('invalid_record', `Invalid stored Interaction ${context}`, {
      cause: error,
    });
  }
}

function decodeFailure(source: DecodeSource, message: string, cause?: unknown): never {
  throw new InteractionStoreError(
    source === 'input' ? 'invalid_input' : 'invalid_record',
    message,
    {
      cause,
    },
  );
}
function encode(value: unknown, limit: number): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > limit)
    throw new InteractionStoreError('invalid_input', 'Interaction document exceeds size limit');
  return bytes;
}
function failure(error: unknown, message: string): InteractionStoreError {
  return error instanceof InteractionStoreError
    ? error
    : new InteractionStoreError('io_failed', message, { cause: error });
}
function normalizeFilter(filter: PendingInteractionFilter): void {
  for (const value of [filter.sessionId, filter.turnId, filter.runId])
    if (value !== undefined) assertId(value);
}
function matches(request: StoredInteractionRequest, filter: PendingInteractionFilter): boolean {
  return (
    (filter.sessionId === undefined || filter.sessionId === request.sessionId) &&
    (filter.turnId === undefined || filter.turnId === request.turnId) &&
    (filter.runId === undefined || filter.runId === request.runId) &&
    (filter.kind === undefined || filter.kind === request.request.kind)
  );
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function invalidFacade(access: 'read' | 'write'): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic interactive ${access} Interaction Store`,
  );
}
