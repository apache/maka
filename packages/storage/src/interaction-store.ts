import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
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
import { readBoundedMarkerFile } from './marker-file.js';
import {
  InteractionLocatorLane,
  runInteractionStoreOperation,
  type InteractionStoreOperationRunner,
} from './interaction-locator-lane.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REMEMBER_SCOPE_ID = /^[0-9a-f]{64}$/;
const LOCATOR = /^[0-9a-f]{64}$/;
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
  listSessionPending(sessionId: string): Promise<StoredInteractionRequest[]>;
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
  const store = new FileInteractionStore(lease.canonicalPath, false);
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'read', operation);
  const facade = Object.freeze({
    kind: 'interactive' as const,
    access: 'read' as const,
    readInteraction: (requestId: string) => store.readInteraction(requestId, run),
    listSessionPending: (sessionId: string) => run(() => store.listSessionPending(sessionId)),
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
    const store = new FileInteractionStore(lease.canonicalPath, true);
    const run = <T>(operation: () => Promise<T>) =>
      runWithStorageRootLease(lease, 'interactive', 'write', operation);
    await run(() => store.recover());
    return run(async () => {
      const recoveredExisting = writersByLease.get(lease);
      if (recoveredExisting) return recoveredExisting;
      const facade = Object.freeze({
        kind: 'interactive' as const,
        access: 'write' as const,
        readInteraction: (requestId: string) => store.readInteraction(requestId, run),
        listSessionPending: (sessionId: string) => run(() => store.listSessionPending(sessionId)),
        listPending: (filter?: PendingInteractionFilter) => run(() => store.listPending(filter)),
        establishRequest: (input: StoredInteractionRequest) => store.establishRequest(input, run),
        commitOutcome: (requestId: string, outcome: InteractionCanonicalOutcome) =>
          store.commitOutcome(requestId, outcome, run),
      });
      writers.add(facade);
      writersByLease.set(lease, facade);
      return facade;
    });
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
  private readonly sessionPendingRoot: string;
  private readonly locatorLane = new InteractionLocatorLane();

  constructor(
    root: string,
    private readonly useSessionPendingIndex: boolean,
  ) {
    this.root = resolve(root);
    this.interactionsRoot = join(this.root, 'interactions');
    this.sessionPendingRoot = join(this.interactionsRoot, 'pending');
  }

  async recover(): Promise<void> {
    const indexRoot = await this.ensureSessionPendingRoot();
    await syncDirectoryChain(this.sessionPendingRoot, this.root);
    await sessionPendingDirectoryPolicy.assert(indexRoot);
    const expectedPending = new Map<string, Set<string>>();
    for (const locator of await this.locators()) {
      await this.withLocator(locator, runInteractionStoreOperation, async () => {
        const bindings = await this.bindExistingLocator(locator);
        if (!bindings) invalidInteractionLocator();
        await this.stabilizeBoundLocator(bindings);
        const record = await this.readBoundLocatorUnlocked(bindings);
        if (!record) {
          const directory = bindings.at(-1)?.path;
          if (!directory) invalidInteractionLocator();
          await interactionDirectoryPolicy.assert(bindings);
          await rmdir(directory);
          await syncDirectory(this.interactionsRoot);
          return;
        }
        if (!record.outcome) addPendingLocator(expectedPending, record.request.sessionId, locator);
      });
    }
    await sessionPendingDirectoryPolicy.assert(indexRoot);
    await this.reconcileSessionPendingIndex(expectedPending);
  }

  async establishRequest(
    input: StoredInteractionRequest,
    authorize: InteractionStoreOperationRunner = runInteractionStoreOperation,
  ): Promise<EstablishInteractionRequestResult> {
    const candidate = normalizeRequest(input, 'input');
    const locator = interactionLocator(candidate.requestId);
    return this.withLocator(locator, authorize, async () => {
      const attempt = await this.publish(
        locator,
        'request.json',
        encode(candidate, STORED_INTERACTION_REQUEST_MAX_BYTES),
      );
      try {
        const bindings = await this.bindExistingLocator(locator);
        let record: InteractionRecord | undefined;
        if (bindings) {
          await this.stabilizeBoundLocator(bindings);
          record = await this.readBoundLocatorUnlocked(bindings, candidate.requestId);
        }
        if (record) {
          if (record.outcome) {
            await this.removeSessionPendingMarker(record.request.sessionId, locator);
          } else {
            await this.publishSessionPendingMarker(record.request.sessionId, locator);
          }
          return {
            status: 'stable',
            matches: isDeepStrictEqual(record.request, candidate),
            record,
          };
        }
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
    authorize: InteractionStoreOperationRunner = runInteractionStoreOperation,
  ): Promise<CommitInteractionOutcomeResult> {
    assertId(requestId);
    const locator = interactionLocator(requestId);
    return this.withLocator(locator, authorize, async () => {
      let record: InteractionRecord | undefined;
      try {
        const bindings = await this.bindExistingLocator(locator);
        if (bindings) {
          await this.stabilizeBoundLocator(bindings);
          record = await this.readBoundLocatorUnlocked(bindings, requestId);
        }
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
        const bindings = await this.bindExistingLocator(locator);
        let settled: InteractionRecord | undefined;
        if (bindings) {
          await this.stabilizeBoundLocator(bindings);
          settled = await this.readBoundLocatorUnlocked(bindings, requestId);
        }
        if (settled?.outcome) {
          await this.removeSessionPendingMarker(settled.request.sessionId, locator);
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

  async readInteraction(
    requestId: string,
    authorize: InteractionStoreOperationRunner = runInteractionStoreOperation,
  ): Promise<InteractionRecord | undefined> {
    const locator = interactionLocator(requestId);
    return this.withLocator(locator, authorize, async () => {
      const bindings = await this.bindExistingLocator(locator);
      return bindings ? this.readBoundLocatorUnlocked(bindings, requestId) : undefined;
    });
  }

  async listSessionPending(sessionId: string): Promise<StoredInteractionRequest[]> {
    const canonicalSessionId = assertId(sessionId);
    if (!this.useSessionPendingIndex) {
      return this.listCanonicalPending({ sessionId: canonicalSessionId });
    }
    const result: StoredInteractionRequest[] = [];
    for (const locator of await this.sessionPendingLocators(canonicalSessionId)) {
      const record = await this.withLocator(locator, runInteractionStoreOperation, async () => {
        const bindings = await this.bindExistingLocator(locator);
        return bindings ? this.readBoundLocatorUnlocked(bindings) : undefined;
      });
      if (record && !record.outcome && record.request.sessionId === canonicalSessionId) {
        result.push(record.request);
      }
    }
    return sortPending(result);
  }

  async listPending(filter: PendingInteractionFilter = {}): Promise<StoredInteractionRequest[]> {
    normalizeFilter(filter);
    if (this.useSessionPendingIndex && filter.sessionId !== undefined) {
      return (await this.listSessionPending(filter.sessionId)).filter((request) =>
        matches(request, filter),
      );
    }
    return this.listCanonicalPending(filter);
  }

  private async listCanonicalPending(
    filter: PendingInteractionFilter,
  ): Promise<StoredInteractionRequest[]> {
    const result: StoredInteractionRequest[] = [];
    for (const locator of await this.locators()) {
      const record = await this.withLocator(locator, runInteractionStoreOperation, async () => {
        const bindings = await this.bindExistingLocator(locator);
        return bindings ? this.readBoundLocatorUnlocked(bindings) : undefined;
      });
      if (record && !record.outcome && matches(record.request, filter)) result.push(record.request);
    }
    return sortPending(result);
  }

  private async publishSessionPendingMarker(sessionId: string, locator: string): Promise<void> {
    await this.publishSessionPendingMarkerByLocator(interactionLocator(sessionId), locator);
  }

  private async removeSessionPendingMarker(sessionId: string, locator: string): Promise<void> {
    const bindings = await this.bindExistingSessionPendingDirectory(interactionLocator(sessionId));
    if (!bindings) return;
    const directory = bindings.at(-1)?.path;
    if (!directory) throw invalidSessionPendingMarker();
    const marker = join(directory, locator);
    try {
      await readSessionPendingMarker(marker);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
    await sessionPendingDirectoryPolicy.assert(bindings);
    try {
      await unlink(marker);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
    await syncDirectory(directory);
    await sessionPendingDirectoryPolicy.assert(bindings);
  }

  private async reconcileSessionPendingIndex(
    expectedPending: ReadonlyMap<string, ReadonlySet<string>>,
  ): Promise<void> {
    for (const sessionLocator of await this.sessionPendingDirectories()) {
      const directory = join(this.sessionPendingRoot, sessionLocator);
      const bindings = await sessionPendingDirectoryPolicy.bind([
        this.interactionsRoot,
        this.sessionPendingRoot,
        directory,
      ]);
      const expected = expectedPending.get(sessionLocator);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!LOCATOR.test(entry.name)) invalidSessionPendingMarker();
        const marker = join(directory, entry.name);
        await readSessionPendingMarker(marker);
        if (expected?.has(entry.name)) continue;
        await sessionPendingDirectoryPolicy.assert(bindings);
        await unlink(marker);
      }
      await syncDirectory(directory);
      await sessionPendingDirectoryPolicy.assert(bindings);
    }
    for (const [sessionLocator, locators] of expectedPending) {
      for (const locator of locators) {
        await this.publishSessionPendingMarkerByLocator(sessionLocator, locator);
      }
    }
  }

  private async publishSessionPendingMarkerByLocator(
    sessionLocator: string,
    locator: string,
  ): Promise<void> {
    const bindings = await this.ensureSessionPendingDirectory(sessionLocator);
    const directory = bindings.at(-1)?.path;
    if (!directory) throw invalidSessionPendingMarker();
    await syncDirectoryChain(directory, this.root);
    await sessionPendingDirectoryPolicy.assert(bindings);
    const marker = join(directory, locator);
    let handle;
    try {
      handle = await open(marker, canonicalCreateFlags(), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await readSessionPendingMarker(marker);
      await sessionPendingDirectoryPolicy.assert(bindings);
      return;
    }
    try {
      assertSessionPendingMarker(await handle.stat({ bigint: true }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await sessionPendingDirectoryPolicy.assert(bindings);
    await readSessionPendingMarker(marker);
    await syncDirectory(directory);
    await sessionPendingDirectoryPolicy.assert(bindings);
  }

  private async sessionPendingLocators(sessionId: string): Promise<string[]> {
    const bindings = await this.bindExistingSessionPendingDirectory(interactionLocator(sessionId));
    if (!bindings) return [];
    const directory = bindings.at(-1)?.path;
    if (!directory) throw invalidSessionPendingMarker();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const locators: string[] = [];
    for (const entry of entries) {
      if (!LOCATOR.test(entry.name)) invalidSessionPendingMarker();
      try {
        await readSessionPendingMarker(join(directory, entry.name));
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) continue;
        throw error;
      }
      locators.push(entry.name);
    }
    await sessionPendingDirectoryPolicy.assert(bindings);
    return locators.sort();
  }

  private async sessionPendingDirectories(): Promise<string[]> {
    const rootBindings = await sessionPendingDirectoryPolicy.bind([
      this.interactionsRoot,
      this.sessionPendingRoot,
    ]);
    const entries = await readdir(this.sessionPendingRoot, { withFileTypes: true });
    const locators: string[] = [];
    for (const entry of entries) {
      if (!LOCATOR.test(entry.name)) invalidSessionPendingMarker();
      await sessionPendingDirectoryPolicy.bind([
        ...rootBindings.map((binding) => binding.path),
        join(this.sessionPendingRoot, entry.name),
      ]);
      locators.push(entry.name);
    }
    await sessionPendingDirectoryPolicy.assert(rootBindings);
    return locators.sort();
  }

  private async ensureSessionPendingRoot(): Promise<DirectoryBinding[]> {
    await mkdirIfMissing(this.interactionsRoot);
    const interactions = await sessionPendingDirectoryPolicy.bind([this.interactionsRoot]);
    await mkdirIfMissing(this.sessionPendingRoot);
    return sessionPendingDirectoryPolicy.bind([
      ...interactions.map((binding) => binding.path),
      this.sessionPendingRoot,
    ]);
  }

  private async ensureSessionPendingDirectory(sessionLocator: string): Promise<DirectoryBinding[]> {
    const rootBindings = await this.ensureSessionPendingRoot();
    await sessionPendingDirectoryPolicy.assert(rootBindings);
    const directory = join(this.sessionPendingRoot, sessionLocator);
    await mkdirIfMissing(directory);
    return sessionPendingDirectoryPolicy.bind([
      ...rootBindings.map((binding) => binding.path),
      directory,
    ]);
  }

  private async bindExistingSessionPendingDirectory(
    sessionLocator: string,
  ): Promise<DirectoryBinding[] | undefined> {
    try {
      return await sessionPendingDirectoryPolicy.bind([
        this.interactionsRoot,
        this.sessionPendingRoot,
        join(this.sessionPendingRoot, sessionLocator),
      ]);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async publish(
    locator: string,
    name: string,
    bytes: Buffer,
  ): Promise<'published_or_existing' | 'not_attempted'> {
    let bindings: DirectoryBinding[] | undefined;
    let directory: string | undefined;
    let temp: string | undefined;
    let tempIdentity: FileIdentity | undefined;
    let linked = false;
    let linkAttempted = false;
    try {
      bindings = await this.ensureLocator(locator);
      directory = bindings.at(-1)?.path;
      if (!directory) invalidInteractionLocator();
      await syncDirectoryChain(directory, this.root);
      await interactionDirectoryPolicy.assert(bindings);
      temp = join(directory, `${name}.${randomUUID()}.tmp`);
      const handle = await open(temp, canonicalCreateFlags(), 0o600);
      try {
        const metadata = await handle.stat({ bigint: true });
        assertCanonicalFile(metadata);
        tempIdentity = { dev: metadata.dev, ino: metadata.ino };
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await interactionDirectoryPolicy.assert(bindings);
      if (!tempIdentity) invalidInteractionDocument();
      await assertCanonicalPathIdentity(temp, tempIdentity);
      try {
        linkAttempted = true;
        await link(temp, join(directory, name));
        linked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await interactionDirectoryPolicy.assert(bindings);
      await syncDirectory(directory);
      await removeCanonicalTemp(bindings, temp, tempIdentity);
      temp = undefined;
      await syncDirectory(directory);
      await interactionDirectoryPolicy.assert(bindings);
      return 'published_or_existing';
    } catch {
      if (temp && bindings) {
        await removeCanonicalTemp(bindings, temp, tempIdentity).catch(() => undefined);
      }
      return linked || linkAttempted ? 'published_or_existing' : 'not_attempted';
    }
  }

  private async readBoundLocatorUnlocked(
    bindings: readonly DirectoryBinding[],
    expectedId?: string,
  ): Promise<InteractionRecord | undefined> {
    const directory = bindings.at(-1)?.path;
    if (!directory) invalidInteractionLocator();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await interactionDirectoryPolicy.assert(bindings);
        return undefined;
      }
      throw error;
    }
    await interactionDirectoryPolicy.assert(bindings);
    if (entries.some((entry) => TEMP_FILE.test(entry.name)))
      throw new InteractionStoreError(
        'invalid_record',
        'Interaction contains an unresolved temporary artifact',
      );
    const requestRaw = await readOptional(
      join(directory, 'request.json'),
      STORED_INTERACTION_REQUEST_MAX_BYTES,
      bindings,
    );
    if (requestRaw === undefined) {
      if (entries.some((entry) => entry.name === 'outcome.json'))
        throw new InteractionStoreError('invalid_record', 'Outcome exists without request');
      return undefined;
    }
    const request = normalizeRequest(parseJsonRecord(requestRaw, 'request'), 'record');
    if (
      (expectedId && request.requestId !== expectedId) ||
      join(this.interactionsRoot, interactionLocator(request.requestId)) !== directory
    )
      throw new InteractionStoreError('invalid_record', 'Request identity does not match locator');
    const outcomeRaw = await readOptional(
      join(directory, 'outcome.json'),
      STORED_INTERACTION_OUTCOME_MAX_BYTES,
      bindings,
    );
    const outcome =
      outcomeRaw === undefined
        ? undefined
        : normalizeOutcome(parseJsonRecord(outcomeRaw, 'outcome'), request);
    await interactionDirectoryPolicy.assert(bindings);
    return deepFreeze({ request, ...(outcome ? { outcome } : {}) });
  }

  private async stabilizeBoundLocator(bindings: readonly DirectoryBinding[]): Promise<void> {
    const directory = bindings.at(-1)?.path;
    if (!directory) invalidInteractionLocator();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (TEMP_FILE.test(entry.name)) {
        await removeCanonicalTemp(bindings, join(directory, entry.name));
      }
    }
    await syncDirectory(directory);
    await interactionDirectoryPolicy.assert(bindings);
  }

  private async locators(): Promise<string[]> {
    let rootBindings: DirectoryBinding[];
    try {
      rootBindings = await interactionDirectoryPolicy.bind([this.interactionsRoot]);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
    let entries;
    try {
      entries = await readdir(this.interactionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const locators: string[] = [];
    for (const entry of entries) {
      if (!LOCATOR.test(entry.name)) continue;
      await interactionDirectoryPolicy.bind([
        ...rootBindings.map((binding) => binding.path),
        join(this.interactionsRoot, entry.name),
      ]);
      locators.push(entry.name);
    }
    await interactionDirectoryPolicy.assert(rootBindings);
    return locators.sort();
  }

  private async ensureLocator(locator: string): Promise<DirectoryBinding[]> {
    await mkdirIfMissing(this.interactionsRoot);
    const rootBindings = await interactionDirectoryPolicy.bind([this.interactionsRoot]);
    await interactionDirectoryPolicy.assert(rootBindings);
    const directory = join(this.interactionsRoot, locator);
    await mkdirIfMissing(directory);
    return interactionDirectoryPolicy.bind([
      ...rootBindings.map((binding) => binding.path),
      directory,
    ]);
  }

  private async bindExistingLocator(locator: string): Promise<DirectoryBinding[] | undefined> {
    try {
      return await interactionDirectoryPolicy.bind([
        this.interactionsRoot,
        join(this.interactionsRoot, locator),
      ]);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private async withLocator<T>(
    locator: string,
    authorize: InteractionStoreOperationRunner,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.locatorLane.run(locator, authorize, operation);
  }
}

function addPendingLocator(
  pending: Map<string, Set<string>>,
  sessionId: string,
  locator: string,
): void {
  const sessionLocator = interactionLocator(sessionId);
  const locators = pending.get(sessionLocator) ?? new Set<string>();
  locators.add(locator);
  pending.set(sessionLocator, locators);
}

function sortPending(requests: StoredInteractionRequest[]): StoredInteractionRequest[] {
  return requests.sort(
    (a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId),
  );
}

interface DirectoryBinding {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

async function mkdirIfMissing(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
}

function directoryBindingPolicy(invalidDirectory: () => never): {
  bind(paths: readonly string[]): Promise<DirectoryBinding[]>;
  assert(bindings: readonly DirectoryBinding[]): Promise<void>;
} {
  return {
    async bind(paths) {
      const bindings: DirectoryBinding[] = [];
      for (const path of paths) {
        const metadata = await lstat(path, { bigint: true });
        if (!metadata.isDirectory()) invalidDirectory();
        bindings.push({ path, dev: metadata.dev, ino: metadata.ino });
      }
      return bindings;
    },
    async assert(bindings) {
      for (const binding of bindings) {
        const metadata = await lstat(binding.path, { bigint: true });
        if (
          !metadata.isDirectory() ||
          metadata.dev !== binding.dev ||
          metadata.ino !== binding.ino
        ) {
          invalidDirectory();
        }
      }
    },
  };
}

const sessionPendingDirectoryPolicy = directoryBindingPolicy(invalidSessionPendingMarker);
const interactionDirectoryPolicy = directoryBindingPolicy(invalidInteractionLocator);

async function removeCanonicalTemp(
  bindings: readonly DirectoryBinding[],
  path: string,
  expected?: FileIdentity,
): Promise<void> {
  const bound = await lstat(path, { bigint: true });
  assertCanonicalFile(bound);
  if (expected) assertCanonicalFileIdentity(bound, expected);
  await interactionDirectoryPolicy.assert(bindings);
  await assertCanonicalPathIdentity(path, bound);
  await unlink(path);
  await interactionDirectoryPolicy.assert(bindings);
}

async function assertCanonicalPathIdentity(path: string, expected: FileIdentity): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  assertCanonicalFileIdentity(metadata, expected);
}

async function readSessionPendingMarker(path: string): Promise<void> {
  try {
    const contents = await readBoundedMarkerFile({
      path,
      maxBytes: 0,
      invalidFile: sessionPendingMarkerError,
    });
    if (contents !== '') invalidSessionPendingMarker();
  } catch (error) {
    if (error instanceof InteractionStoreError || isNodeError(error, 'ENOENT')) {
      throw error;
    }
    if (
      isNodeError(error, 'ELOOP') ||
      isNodeError(error, 'EISDIR') ||
      isNodeError(error, 'ENXIO') ||
      isNodeError(error, 'ENODEV')
    ) {
      throw sessionPendingMarkerError(error);
    }
    throw error;
  }
}

function assertSessionPendingMarker(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.size !== 0n) invalidSessionPendingMarker();
}

function canonicalCreateFlags(): string | number {
  if (process.platform === 'win32') return 'wx';
  return (
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_NONBLOCK |
    fsConstants.O_NOFOLLOW
  );
}

function canonicalReadFlags(): string | number {
  if (process.platform === 'win32') return fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;
  return fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
}

function sessionPendingMarkerError(cause?: unknown): InteractionStoreError {
  return new InteractionStoreError(
    'invalid_record',
    'Session pending index contains an invalid marker',
    cause === undefined ? undefined : { cause },
  );
}

function invalidSessionPendingMarker(cause?: unknown): never {
  throw sessionPendingMarkerError(cause);
}

function invalidInteractionLocator(cause?: unknown): never {
  throw new InteractionStoreError(
    'invalid_record',
    'Interaction locator is not a stable directory',
    cause === undefined ? undefined : { cause },
  );
}

function invalidInteractionDocument(cause?: unknown): never {
  throw new InteractionStoreError(
    'invalid_record',
    'Interaction document is not a stable regular file',
    cause === undefined ? undefined : { cause },
  );
}

function assertCanonicalFile(metadata: BigIntStats): void {
  if (!metadata.isFile()) invalidInteractionDocument();
}

function assertCanonicalFileIdentity(metadata: BigIntStats, expected: FileIdentity): void {
  if (!metadata.isFile() || metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
    invalidInteractionDocument();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

async function readOptional(
  path: string,
  limit: number,
  bindings: readonly DirectoryBinding[],
): Promise<string | undefined> {
  let pathMetadata: BigIntStats;
  try {
    pathMetadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      await interactionDirectoryPolicy.assert(bindings);
      return undefined;
    }
    throw error;
  }
  assertCanonicalFile(pathMetadata);
  await interactionDirectoryPolicy.assert(bindings);
  let handle;
  try {
    handle = await open(path, canonicalReadFlags());
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      await interactionDirectoryPolicy.assert(bindings);
      return undefined;
    }
    if (isNodeError(error, 'ELOOP') || isNodeError(error, 'EISDIR')) {
      invalidInteractionDocument(error);
    }
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    assertCanonicalFile(stat);
    if (stat.size > BigInt(limit))
      throw new InteractionStoreError('invalid_record', 'Interaction document exceeds size limit');
    assertCanonicalFileIdentity(stat, pathMetadata);
    await assertCanonicalPathIdentity(path, stat);
    await interactionDirectoryPolicy.assert(bindings);
    const bytes = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, bytes.length - total, null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total > limit)
      throw new InteractionStoreError('invalid_record', 'Interaction document exceeds size limit');
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total));
    } catch (error) {
      throw new InteractionStoreError('invalid_record', 'Interaction document is not valid UTF-8', {
        cause: error,
      });
    }
    await assertCanonicalPathIdentity(path, stat);
    await interactionDirectoryPolicy.assert(bindings);
    return value;
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
