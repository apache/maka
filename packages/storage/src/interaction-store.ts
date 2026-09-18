/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  clientCapabilityScopeIdentity,
  type ClientCapabilitySessionGrant,
  type ClientCapabilitySessionGrantKey,
} from '@maka/core/client-capability-grant';
import {
  decodeInteractionCanonicalOutcome,
  interactionCanonicalOutcomesEquivalent,
  isInteractionCanonicalOutcomeValidForRequest,
  type InteractionCanonicalOutcome,
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

import {
  STORED_INTERACTION_REQUEST_MAX_BYTES,
  STORED_INTERACTION_OUTCOME_MAX_BYTES,
  STORED_CLIENT_CAPABILITY_SESSION_GRANT_MAX_BYTES,
  type StoredInteractionRequest,
  type StoredInteractionOutcome,
  type InteractionRecord,
  type PendingInteractionFilter,
  InteractionStoreError,
  type EstablishInteractionRequestResult,
  type CommitInteractionOutcomeResult,
  type InteractionStoreReader,
  type InteractionStoreWriter,
  sameGrantAuthority,
  sortPending,
  normalizeRequest,
  normalizeOutcome,
  decodeGrant,
  decodeGrantKey,
  decodeClientCapabilityOutcome,
  identity,
  assertId,
  parseJsonRecord,
  decodeFailure,
  encode,
  failure,
  normalizeFilter,
  matches,
  deepFreeze,
} from './interaction-store-contract.js';
export * from './interaction-store-contract.js';

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
const successfullyClosedWriters = new WeakSet<object>();
const sqliteWritersByLease = new WeakMap<object, InteractiveInteractionStoreWriterFacade>();
const backendByLease = new WeakMap<object, object>();
const retainedByExecution = new WeakSet<object>();
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
    readClientCapabilitySessionGrant: (key: ClientCapabilitySessionGrantKey) =>
      run(() => store.readClientCapabilitySessionGrant(key)),
  });
  readers.add(facade);
  sqliteFacadeClosers.set(facade, () => store.close());
  return facade;
}

export async function openSqliteInteractiveInteractionStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
  storeFactory?: (
    root: string,
  ) => InteractionStoreWriter & { ready?(): Promise<void>; close(): void },
  backendIdentity: object = storeFactory ?? createSqliteInteractionStore,
  retainUntilGroupClose?: (release: () => void) => void,
): Promise<InteractiveInteractionStoreWriterFacade> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  // Child close revokes access; the group retains the authority until every
  // backend handle has closed successfully, including on a failed close.
  if (retainUntilGroupClose && !retainedByExecution.has(lease)) {
    retainedByExecution.add(lease);
    retainUntilGroupClose(() => {
      retainedByExecution.delete(lease);
      const cached = sqliteWritersByLease.get(lease);
      if (!cached || successfullyClosedWriters.has(cached)) {
        sqliteWritersByLease.delete(lease);
        backendByLease.delete(lease);
      }
    });
  }
  const existing = sqliteWritersByLease.get(lease);
  if (
    (existing && !writers.has(existing)) ||
    (!existing && retainedByExecution.has(lease) && !retainUntilGroupClose)
  ) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Interaction authority is owned by its execution group',
    );
  }
  if (storeFactory && backendByLease.has(lease) && backendByLease.get(lease) !== backendIdentity) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Interaction authority is already composed for this lease',
    );
  }
  if (existing) return existing;
  const opening = sqliteWriterOpeningsByLease.get(lease);
  if (opening) return opening;
  backendByLease.set(lease, backendIdentity);
  const pending = Promise.resolve().then(async () => {
    const store = (storeFactory ?? createSqliteInteractionStore)(lease.canonicalPath);
    try {
      await store.ready?.();
      await assertStorageRootLease(lease, 'interactive', 'write');
    } catch (error) {
      store.close();
      backendByLease.delete(lease);
      throw error;
    }
    let closed = false;
    const run = <T>(operation: () => Promise<T>) => {
      if (closed) return Promise.reject(invalidFacade('write'));
      return runWithStorageRootLease(lease, 'interactive', 'write', () => {
        if (closed) throw invalidFacade('write');
        return operation();
      });
    };
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
      readClientCapabilitySessionGrant: (key: ClientCapabilitySessionGrantKey) =>
        run(() => store.readClientCapabilitySessionGrant(key)),
      establishRequest: (input: StoredInteractionRequest) =>
        run(() => store.establishRequest(input)),
      commitOutcome: (requestId: string, outcome: InteractionCanonicalOutcome) =>
        run(() => store.commitOutcome(requestId, outcome)),
      commitClientCapabilitySessionGrant: (grant: ClientCapabilitySessionGrant) =>
        run(() => store.commitClientCapabilitySessionGrant(grant)),
      commitClientCapabilityOutcome: (
        requestId: string,
        outcome: Extract<
          InteractionCanonicalOutcome,
          { kind: 'client_capability_decision' | 'closure' }
        >,
        grant?: ClientCapabilitySessionGrant,
      ) => run(() => store.commitClientCapabilityOutcome(requestId, outcome, grant)),
    });
    writers.add(facade);
    sqliteWritersByLease.set(lease, facade);
    sqliteFacadeClosers.set(facade, () => {
      closed = true;
      writers.delete(facade);
      store.close();
      successfullyClosedWriters.add(facade);
      if (sqliteWritersByLease.get(lease) === facade && !retainedByExecution.has(lease)) {
        sqliteWritersByLease.delete(lease);
        backendByLease.delete(lease);
      }
    });
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

export function createSqliteInteractionStore(root: string): SqliteInteractionStore {
  return new SqliteInteractionStore(root);
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

  async commitClientCapabilityOutcome(
    requestId: string,
    outcome: Extract<
      InteractionCanonicalOutcome,
      { kind: 'client_capability_decision' | 'closure' }
    >,
    grant?: ClientCapabilitySessionGrant,
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
      if (record.request.request.kind !== 'client_capability') {
        throw new InteractionStoreError(
          'invalid_input',
          'Client Capability outcome requires a Client Capability request',
        );
      }
      const canonical = decodeClientCapabilityOutcome(outcome);
      if (!isInteractionCanonicalOutcomeValidForRequest(record.request.request, canonical)) {
        throw new InteractionStoreError('invalid_input', 'Outcome is not valid for its request');
      }
      const candidateGrant = grant === undefined ? undefined : decodeGrant(grant, 'input');
      const shouldGrant =
        canonical.kind === 'client_capability_decision' && canonical.decision === 'allow';
      if (shouldGrant !== (candidateGrant !== undefined)) {
        throw new InteractionStoreError(
          'invalid_input',
          'Allowed Client Capability outcome requires exactly one Session Grant',
        );
      }
      if (
        candidateGrant &&
        (!isDeepStrictEqual(decodeGrantKey(candidateGrant, 'input'), {
          sessionId: record.request.sessionId,
          ...record.request.request.target,
        }) ||
          candidateGrant.grantedAt !== canonical.committedAt)
      ) {
        throw new InteractionStoreError(
          'invalid_input',
          'Client Capability Session Grant does not match its Interaction request',
        );
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
      const matches = interactionCanonicalOutcomesEquivalent(settled.outcome.outcome, canonical);
      if (matches && candidateGrant) this.#commitClientCapabilitySessionGrant(candidateGrant);
      return {
        status: 'stable',
        matches,
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

  async readClientCapabilitySessionGrant(
    key: ClientCapabilitySessionGrantKey,
  ): Promise<ClientCapabilitySessionGrant | undefined> {
    const candidate = decodeGrantKey(key, 'input');
    const scope = clientCapabilityScopeIdentity(candidate.scope);
    const row = this.#lease.database
      .prepare(`
        SELECT record_json
        FROM core_client_capability_session_grants
        WHERE session_id = ?
          AND provider_id = ?
          AND contract_id = ?
          AND capability = ?
          AND scope_kind = ?
          AND scope_value = ?
      `)
      .get(
        candidate.sessionId,
        candidate.providerId,
        candidate.contractId,
        candidate.capability,
        candidate.scope.kind,
        scope,
      ) as { record_json?: unknown } | undefined;
    if (!row) return undefined;
    if (typeof row.record_json !== 'string') {
      throw new InteractionStoreError('invalid_record', 'Invalid Client Capability Session Grant');
    }
    const grant = decodeGrant(
      parseJsonRecord(row.record_json, 'Client Capability Session Grant'),
      'record',
    );
    if (!sameGrantAuthority(decodeGrantKey(grant, 'record'), candidate)) {
      throw new InteractionStoreError(
        'invalid_record',
        'Client Capability Session Grant identity does not match row',
      );
    }
    return deepFreeze(grant);
  }

  async commitClientCapabilitySessionGrant(
    grant: ClientCapabilitySessionGrant,
  ): Promise<ClientCapabilitySessionGrant> {
    const candidate = decodeGrant(grant, 'input');
    const scope = clientCapabilityScopeIdentity(candidate.scope);
    const encoded = encode(candidate, STORED_CLIENT_CAPABILITY_SESSION_GRANT_MAX_BYTES)
      .toString('utf8')
      .trim();
    return this.#lease.transaction('write', () => {
      this.#insertClientCapabilitySessionGrant(candidate, scope, encoded);
      const stored = this.#readClientCapabilitySessionGrant(candidate);
      if (!stored) {
        throw new InteractionStoreError(
          'io_failed',
          'Client Capability Session Grant publication produced no record',
        );
      }
      return stored;
    });
  }

  #commitClientCapabilitySessionGrant(grant: ClientCapabilitySessionGrant): void {
    const scope = clientCapabilityScopeIdentity(grant.scope);
    const encoded = encode(grant, STORED_CLIENT_CAPABILITY_SESSION_GRANT_MAX_BYTES)
      .toString('utf8')
      .trim();
    this.#insertClientCapabilitySessionGrant(grant, scope, encoded);
  }

  #insertClientCapabilitySessionGrant(
    grant: ClientCapabilitySessionGrant,
    scope: string,
    encoded: string,
  ): void {
    this.#lease.database
      .prepare(`
        INSERT OR IGNORE INTO core_client_capability_session_grants(
          session_id, provider_id, contract_id, server_id, tool_name,
          capability, scope_kind, scope_value, granted_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        grant.sessionId,
        grant.providerId,
        grant.contractId,
        grant.serverId,
        grant.toolName,
        grant.capability,
        grant.scope.kind,
        scope,
        grant.grantedAt,
        encoded,
      );
  }

  #readClientCapabilitySessionGrant(
    key: ClientCapabilitySessionGrantKey,
  ): ClientCapabilitySessionGrant | undefined {
    const scope = clientCapabilityScopeIdentity(key.scope);
    const row = this.#lease.database
      .prepare(`
        SELECT record_json
        FROM core_client_capability_session_grants
        WHERE session_id = ? AND provider_id = ? AND contract_id = ?
          AND capability = ?
          AND scope_kind = ? AND scope_value = ?
      `)
      .get(key.sessionId, key.providerId, key.contractId, key.capability, key.scope.kind, scope) as
      | { record_json?: unknown }
      | undefined;
    if (!row) return undefined;
    if (typeof row.record_json !== 'string') {
      throw new InteractionStoreError('invalid_record', 'Invalid Client Capability Session Grant');
    }
    return deepFreeze(
      decodeGrant(parseJsonRecord(row.record_json, 'Client Capability Session Grant'), 'record'),
    );
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

function invalidFacade(access: 'read' | 'write'): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected authentic interactive ${access} Interaction Store`,
  );
}
