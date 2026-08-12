import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  decodeInteractionCanonicalOutcome,
  decodeInteractionRequest,
  interactionCanonicalOutcomesEquivalent,
  isInteractionCanonicalOutcomeValidForRequest,
  projectInteractionQuestionRequest,
  type InteractionCanonicalOutcome,
  type InteractionRequest,
} from '@maka/core/interaction';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REMEMBER_SCOPE_ID = /^[0-9a-f]{64}$/;
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

const readers = new WeakSet<object>();
const writers = new WeakSet<object>();
const sqliteWritersByLease = new WeakMap<object, InteractiveInteractionStoreWriterFacade>();
const sqliteWriterOpeningsByLease = new WeakMap<
  object,
  Promise<InteractiveInteractionStoreWriterFacade>
>();
const sqliteFacadeClosers = new WeakMap<object, () => void>();

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

export async function openSqliteInteractiveInteractionStoreForRead(
  lease: StorageRootLease<'interactive', 'read'>,
): Promise<InteractiveInteractionStoreReaderFacade> {
  await assertStorageRootLease(lease, 'interactive', 'read');
  const store = new SqliteInteractionStore(lease.canonicalPath);
  await store.ready();
  const run = <T>(operation: () => Promise<T>) =>
    runWithStorageRootLease(lease, 'interactive', 'read', operation);
  const facade = Object.freeze({
    kind: 'interactive' as const,
    access: 'read' as const,
    readInteraction: (requestId: string) => run(() => store.readInteraction(requestId)),
    listSessionPending: (sessionId: string) => run(() => store.listSessionPending(sessionId)),
    listPending: (filter?: PendingInteractionFilter) => run(() => store.listPending(filter)),
  });
  readers.add(facade);
  sqliteFacadeClosers.set(facade, () => store.close());
  return facade;
}

export async function openSqliteInteractiveInteractionStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveInteractionStoreWriterFacade> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = sqliteWritersByLease.get(lease);
  if (existing) return existing;
  const opening = sqliteWriterOpeningsByLease.get(lease);
  if (opening) return opening;
  const pending = Promise.resolve().then(async () => {
    const store = new SqliteInteractionStore(lease.canonicalPath);
    await store.ready();
    const run = <T>(operation: () => Promise<T>) =>
      runWithStorageRootLease(lease, 'interactive', 'write', operation);
    const recoveredExisting = sqliteWritersByLease.get(lease);
    if (recoveredExisting) {
      store.close();
      return recoveredExisting;
    }
    const facade = Object.freeze({
      kind: 'interactive' as const,
      access: 'write' as const,
      readInteraction: (requestId: string) => run(() => store.readInteraction(requestId)),
      listSessionPending: (sessionId: string) => run(() => store.listSessionPending(sessionId)),
      listPending: (filter?: PendingInteractionFilter) => run(() => store.listPending(filter)),
      establishRequest: (input: StoredInteractionRequest) =>
        run(() => store.establishRequest(input)),
      commitOutcome: (requestId: string, outcome: InteractionCanonicalOutcome) =>
        run(() => store.commitOutcome(requestId, outcome)),
    });
    writers.add(facade);
    sqliteWritersByLease.set(lease, facade);
    sqliteFacadeClosers.set(facade, () => store.close());
    return facade;
  });
  sqliteWriterOpeningsByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (sqliteWriterOpeningsByLease.get(lease) === pending) {
      sqliteWriterOpeningsByLease.delete(lease);
    }
  }
}

export function closeSqliteInteractionStoreFacade(
  store: InteractiveInteractionStoreReaderFacade | InteractiveInteractionStoreWriterFacade,
): void {
  const close = sqliteFacadeClosers.get(store);
  if (!close) return;
  sqliteFacadeClosers.delete(store);
  close();
}

class SqliteInteractionStore implements InteractionStoreWriter {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(root: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(root));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async establishRequest(
    input: StoredInteractionRequest,
  ): Promise<EstablishInteractionRequestResult> {
    const candidate = normalizeRequest(input, 'input');
    const encoded = encode(candidate, STORED_INTERACTION_REQUEST_MAX_BYTES).toString('utf8').trim();
    try {
      return this.#lease.transaction('write', () => {
        const existing = readSqliteInteraction(this.#lease, candidate.requestId);
        if (existing) {
          return {
            status: 'stable',
            matches: isDeepStrictEqual(existing.request, candidate),
            record: existing,
          };
        }
        this.#lease.database
          .prepare(`
            INSERT INTO core_interaction_requests(
              request_id, session_id, turn_id, run_id, request_kind, created_at, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            candidate.requestId,
            candidate.sessionId,
            candidate.turnId,
            candidate.runId,
            candidate.request.kind,
            candidate.createdAt,
            encoded,
          );
        return {
          status: 'stable',
          matches: true,
          record: deepFreeze({ request: candidate }),
        };
      });
    } catch (error) {
      return {
        status: 'unresolved',
        failure: failure(error, 'Request publication could not be stabilized'),
      };
    }
  }

  async commitOutcome(
    requestId: string,
    outcome: InteractionCanonicalOutcome,
  ): Promise<CommitInteractionOutcomeResult> {
    assertId(requestId);
    return this.#lease.transaction('write', () => {
      const record = readSqliteInteraction(this.#lease, requestId);
      if (!record) {
        throw new InteractionStoreError(
          'request_not_found',
          `Interaction request '${requestId}' does not exist`,
        );
      }
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
      const encoded = encode(candidate, STORED_INTERACTION_OUTCOME_MAX_BYTES)
        .toString('utf8')
        .trim();
      this.#lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_interaction_outcomes(request_id, record_json)
          VALUES (?, ?)
        `)
        .run(requestId, encoded);
      const settled = readSqliteInteraction(this.#lease, requestId);
      if (!settled?.outcome) {
        throw new InteractionStoreError('io_failed', 'Outcome publication produced no record');
      }
      return {
        status: 'stable',
        matches: interactionCanonicalOutcomesEquivalent(settled.outcome.outcome, canonical),
        record: settled as InteractionRecord & { readonly outcome: StoredInteractionOutcome },
      };
    });
  }

  async readInteraction(requestId: string): Promise<InteractionRecord | undefined> {
    assertId(requestId);
    return readSqliteInteraction(this.#lease, requestId);
  }

  async listSessionPending(sessionId: string): Promise<StoredInteractionRequest[]> {
    return this.listPending({ sessionId });
  }

  async listPending(filter: PendingInteractionFilter = {}): Promise<StoredInteractionRequest[]> {
    normalizeFilter(filter);
    const rows = this.#lease.database
      .prepare(`
        SELECT request_id
        FROM core_interaction_requests AS request
        WHERE NOT EXISTS (
          SELECT 1 FROM core_interaction_outcomes AS outcome
          WHERE outcome.request_id = request.request_id
        )
        ORDER BY request.created_at, request.request_id
      `)
      .all() as Array<{ request_id?: unknown }>;
    const requests: StoredInteractionRequest[] = [];
    for (const row of rows) {
      if (typeof row.request_id !== 'string') {
        throw new InteractionStoreError('invalid_record', 'Invalid SQLite Interaction identity');
      }
      const record = readSqliteInteraction(this.#lease, row.request_id);
      if (record && !record.outcome && matches(record.request, filter)) {
        requests.push(record.request);
      }
    }
    return sortPending(requests);
  }

  close(): void {
    this.#lease.close();
  }
}

function readSqliteInteraction(
  lease: Pick<OperationalStateDatabaseLease, 'database'>,
  requestId: string,
): InteractionRecord | undefined {
  const row = lease.database
    .prepare(`
      SELECT request.record_json AS request_json, outcome.record_json AS outcome_json
      FROM core_interaction_requests AS request
      LEFT JOIN core_interaction_outcomes AS outcome ON outcome.request_id = request.request_id
      WHERE request.request_id = ?
    `)
    .get(requestId) as { request_json?: unknown; outcome_json?: unknown } | undefined;
  if (!row) return undefined;
  if (typeof row.request_json !== 'string') {
    throw new InteractionStoreError('invalid_record', 'Invalid SQLite Interaction request');
  }
  const request = normalizeRequest(JSON.parse(row.request_json), 'record');
  if (request.requestId !== requestId) {
    throw new InteractionStoreError('invalid_record', 'Request identity does not match row');
  }
  const outcome =
    row.outcome_json === null || row.outcome_json === undefined
      ? undefined
      : typeof row.outcome_json === 'string'
        ? normalizeOutcome(JSON.parse(row.outcome_json), request)
        : decodeFailure('record', 'Invalid SQLite Interaction outcome');
  return deepFreeze({ request, ...(outcome ? { outcome } : {}) });
}

function sortPending(requests: StoredInteractionRequest[]): StoredInteractionRequest[] {
  return requests.sort(
    (a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId),
  );
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
