import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  MemoryItemStoreConflictError,
  isMemoryItemKind,
  isMemoryItemOrigin,
  isMemoryKeyOrigin,
  isMemoryKeyType,
  isMemoryLifecycleState,
  isMemoryScopeType,
  isMemoryStatementType,
  isMemoryTemporalType,
  normalizeLongTermMemoryContent,
  validateMemoryTemporalBounds,
  type ApplyMemoryMutationsRequest,
  type MemoryItem,
  type MemoryItemKey,
  type MemoryItemKeyInput,
  type MemoryItemMutation,
  type MemoryItemRecord,
  type MemoryItemSource,
  type MemoryItemStore,
  type MemoryItemWrite,
  type MemoryMutationResult,
  type MemoryWriteOperationResult,
  type SearchMemoryItemsByKeyRequest,
} from '@maka/core/long-term-memory';
import {
  assertSupportedSqliteLongTermMemorySchemaVersion,
  configureSqliteLongTermMemoryDatabase,
  migrateSqliteLongTermMemoryDatabase,
  readSqliteLongTermMemorySchemaVersion,
  type SqliteLongTermMemoryMigrationFailpoint,
} from './sqlite-long-term-memory-schema.js';

const MAX_MUTATIONS_PER_OPERATION = 32;
const MAX_KEYS_PER_ITEM = 32;
const MAX_SOURCES_PER_ITEM = 256;
const MAX_SEARCH_TERMS = 32;
const MAX_SEARCH_RESULTS = 100;
const MAX_IDENTIFIER_CODE_POINTS = 512;
const MAX_KEY_CODE_POINTS = 256;
const MAX_OPERATION_RESULT_JSON_CODE_UNITS = 128 * 1_024;

const require = createRequire(import.meta.url);

export type SqliteMemoryItemStoreFailpoint =
  | 'after_item_write'
  | 'after_keys_write'
  | 'after_sources_write'
  | 'before_operation_write'
  | 'after_commit';

export interface SqliteMemoryItemStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly failpoint?: (point: SqliteMemoryItemStoreFailpoint) => void;
  readonly migrationFailpoint?: (point: SqliteLongTermMemoryMigrationFailpoint) => void;
}

interface NormalizedMemoryWrite {
  readonly content: string;
  readonly kind: MemoryItem['kind'];
  readonly statementType: MemoryItem['statementType'];
  readonly temporalType: MemoryItem['temporalType'];
  readonly scopeType: MemoryItem['scopeType'];
  readonly scopeKey: string | null;
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
  readonly observedAt: number;
  readonly origin: MemoryItem['origin'];
  readonly contentHash: string;
  readonly keys: readonly MemoryItemKey[];
  readonly sources: readonly MemoryItemSource[];
}

type NormalizedMutation =
  | { readonly type: 'create'; readonly item: NormalizedMemoryWrite }
  | {
      readonly type: 'update';
      readonly itemId: string;
      readonly expectedVersion: number;
      readonly item: NormalizedMemoryWrite;
    }
  | { readonly type: 'archive'; readonly itemId: string; readonly expectedVersion: number }
  | { readonly type: 'restore'; readonly itemId: string; readonly expectedVersion: number };

interface MemoryItemRow {
  item_id: unknown;
  version: unknown;
  content: unknown;
  kind: unknown;
  statement_type: unknown;
  temporal_type: unknown;
  scope_type: unknown;
  scope_key: unknown;
  event_started_at: unknown;
  event_ended_at: unknown;
  observed_at: unknown;
  lifecycle_state: unknown;
  origin: unknown;
  content_hash: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface MemoryKeyRow {
  key_text: unknown;
  normalized_key: unknown;
  key_type: unknown;
  key_origin: unknown;
}

interface MemorySourceRow {
  session_id: unknown;
  run_id: unknown;
  turn_id: unknown;
  event_id: unknown;
}

interface MemoryOperationRow {
  operation_id: unknown;
  operation_type: unknown;
  request_hash: unknown;
  result_json: unknown;
  committed_at: unknown;
}

interface SqliteMemoryKeySearchQuery {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}

/** Low-level implementation; production callers must use the StorageRoot authority facade. */
export class SqliteMemoryItemStore implements MemoryItemStore {
  readonly #database: DatabaseSync;
  readonly #options: SqliteMemoryItemStoreOptions;
  #closed = false;

  constructor(path: string, options: SqliteMemoryItemStoreOptions = {}) {
    if (path.trim() === '') throw new Error('Long-term memory SQLite path cannot be empty');
    this.#options = options;
    if (path !== ':memory:') preparePrivateDatabaseFiles(path);
    const Database = loadDatabaseSync();
    this.#database = new Database(path);
    try {
      assertSupportedSqliteLongTermMemorySchemaVersion(this.#database);
      configureSqliteLongTermMemoryDatabase(this.#database);
      migrateSqliteLongTermMemoryDatabase(this.#database, {
        failpoint: options.migrationFailpoint,
      });
      if (path !== ':memory:') secureExistingDatabaseFiles(path);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  schemaVersion(): number {
    this.#assertOpen();
    return readSqliteLongTermMemorySchemaVersion(this.#database);
  }

  journalMode(): string {
    this.#assertOpen();
    const row = this.#database.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
  }

  foreignKeysEnabled(): boolean {
    this.#assertOpen();
    const row = this.#database.prepare('PRAGMA foreign_keys').get() as
      | { foreign_keys?: unknown }
      | undefined;
    return row?.foreign_keys === 1;
  }

  async applyMutations(request: ApplyMemoryMutationsRequest): Promise<MemoryWriteOperationResult> {
    this.#assertOpen();
    const committedAt = normalizeTimestamp((this.#options.now ?? Date.now)(), 'current time');
    const operationId = normalizeIdentifier(request.operationId, 'operationId');
    const mutations = normalizeMutations(request.mutations);
    const requestHash = hashCanonical(mutations);
    const operationType = mutations.length === 1 ? mutations[0]!.type : 'batch';

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.#readOperationRow(operationId);
      if (existing) {
        if (requiredHash(existing.request_hash, 'request_hash') !== requestHash) {
          throw new MemoryItemStoreConflictError(
            'operation_reused',
            `Memory operation ${operationId} was already used for a different request`,
          );
        }
        this.#database.exec('COMMIT');
        return { ...decodeOperation(existing), replayed: true };
      }

      validateObservedAtForCommit(mutations, committedAt);

      const results: MemoryMutationResult[] = [];
      const transientItemIds = new Set<string>();
      for (let index = 0; index < mutations.length; index += 1) {
        const result = this.#applyMutation(mutations[index]!, index, committedAt, transientItemIds);
        results.push(result);
        if (result.outcome !== 'noop') transientItemIds.add(result.itemId);
      }

      this.#options.failpoint?.('before_operation_write');
      this.#database
        .prepare(
          `INSERT INTO memory_write_operations(
             operation_id, operation_type, request_hash, result_json, committed_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(operationId, operationType, requestHash, JSON.stringify(results), committedAt);
      this.#database.exec('COMMIT');
      this.#options.failpoint?.('after_commit');
      return { operationId, operationType, replayed: false, committedAt, results };
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  async readItem(itemId: string): Promise<MemoryItemRecord | undefined> {
    this.#assertOpen();
    return this.#readSnapshot(() => this.#readItemRecord(normalizeIdentifier(itemId, 'itemId')));
  }

  async searchByKeys(request: SearchMemoryItemsByKeyRequest): Promise<readonly MemoryItemRecord[]> {
    this.#assertOpen();
    if (request.match !== 'exact' && request.match !== 'prefix') {
      throw new Error('Memory key match must be exact or prefix');
    }
    if (!Array.isArray(request.terms) || request.terms.length === 0) {
      throw new Error('Memory key search requires at least one term');
    }
    if (request.terms.length > MAX_SEARCH_TERMS) {
      throw new Error(`Memory key search accepts at most ${MAX_SEARCH_TERMS} terms`);
    }
    if (request.includeArchived !== undefined && typeof request.includeArchived !== 'boolean') {
      throw new Error('Memory key includeArchived must be a boolean');
    }
    const terms = [...new Set(request.terms.map(normalizeSearchTerm))].sort(compareText);
    const workspaceKey =
      request.workspaceKey === undefined
        ? undefined
        : normalizeIdentifier(request.workspaceKey, 'workspaceKey');
    const limit = request.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
      throw new Error(`Memory key search limit must be between 1 and ${MAX_SEARCH_RESULTS}`);
    }

    const query = buildSqliteMemoryKeySearchQuery({
      terms,
      match: request.match,
      workspaceKey,
      includeArchived: request.includeArchived ?? false,
      limit,
    });
    return this.#readSnapshot(() => {
      const rows = this.#database.prepare(query.sql).all(...query.parameters) as Array<{
        item_id?: unknown;
      }>;

      return rows.map((row) => {
        if (typeof row.item_id !== 'string') throw new Error('Invalid Memory Item search result');
        const record = this.#readItemRecord(row.item_id);
        if (!record) throw new Error(`Memory Item ${row.item_id} disappeared during read`);
        return record;
      });
    });
  }

  async readOperation(operationId: string): Promise<MemoryWriteOperationResult | undefined> {
    this.#assertOpen();
    const row = this.#readOperationRow(normalizeIdentifier(operationId, 'operationId'));
    return row ? decodeOperation(row) : undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #applyMutation(
    mutation: NormalizedMutation,
    mutationIndex: number,
    committedAt: number,
    transientItemIds: ReadonlySet<string>,
  ): MemoryMutationResult {
    switch (mutation.type) {
      case 'create':
        return this.#createItem(mutation.item, mutationIndex, committedAt, transientItemIds);
      case 'update':
        return this.#updateItem(mutation, mutationIndex, committedAt, transientItemIds);
      case 'archive':
        return this.#changeLifecycle(
          mutation,
          mutationIndex,
          committedAt,
          'archived',
          transientItemIds,
        );
      case 'restore':
        return this.#changeLifecycle(
          mutation,
          mutationIndex,
          committedAt,
          'active',
          transientItemIds,
        );
    }
  }

  #createItem(
    write: NormalizedMemoryWrite,
    mutationIndex: number,
    committedAt: number,
    transientItemIds: ReadonlySet<string>,
  ): MemoryMutationResult {
    const duplicate = this.#findActiveFactDuplicate(write);
    if (duplicate) {
      this.#throwDuplicateConflict(duplicate, transientItemIds, undefined, 'Creating this Item');
    }

    const itemId = normalizeIdentifier(
      (this.#options.idFactory ?? randomUUID)(),
      'generated itemId',
    );
    this.#database
      .prepare(
        `INSERT INTO memory_items(
           item_id, version, content, kind, statement_type, temporal_type,
           scope_type, scope_key, event_started_at, event_ended_at, observed_at,
           lifecycle_state, origin, content_hash, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        write.content,
        write.kind,
        write.statementType,
        write.temporalType,
        write.scopeType,
        write.scopeKey,
        write.eventStartedAt,
        write.eventEndedAt,
        write.observedAt,
        write.origin,
        write.contentHash,
        committedAt,
        committedAt,
      );
    this.#options.failpoint?.('after_item_write');
    this.#replaceKeys(itemId, write.keys);
    this.#options.failpoint?.('after_keys_write');
    this.#replaceSources(itemId, write.sources);
    this.#options.failpoint?.('after_sources_write');
    return mutationResult(mutationIndex, 'create', this.#requireItemRecord(itemId).item, 'created');
  }

  #updateItem(
    mutation: Extract<NormalizedMutation, { type: 'update' }>,
    mutationIndex: number,
    committedAt: number,
    transientItemIds: ReadonlySet<string>,
  ): MemoryMutationResult {
    const current = this.#requireVersion(mutation.itemId, mutation.expectedVersion);
    const currentRecord = this.#requireItemRecord(mutation.itemId);
    if (recordMatchesWrite(currentRecord, mutation.item)) {
      return mutationResult(mutationIndex, 'update', current, 'noop');
    }
    const duplicate = this.#findActiveFactDuplicate(mutation.item, mutation.itemId);
    if (duplicate) {
      this.#throwDuplicateConflict(
        duplicate,
        transientItemIds,
        mutation.itemId,
        `Updating Memory Item ${mutation.itemId}`,
      );
    }

    const updatedAt = Math.max(committedAt, current.updatedAt);
    const result = this.#database
      .prepare(
        `UPDATE memory_items
         SET version = version + 1,
             content = ?, kind = ?, statement_type = ?, temporal_type = ?,
             scope_type = ?, scope_key = ?, event_started_at = ?, event_ended_at = ?,
             observed_at = ?, origin = ?, content_hash = ?, updated_at = ?
         WHERE item_id = ? AND version = ?`,
      )
      .run(
        mutation.item.content,
        mutation.item.kind,
        mutation.item.statementType,
        mutation.item.temporalType,
        mutation.item.scopeType,
        mutation.item.scopeKey,
        mutation.item.eventStartedAt,
        mutation.item.eventEndedAt,
        mutation.item.observedAt,
        mutation.item.origin,
        mutation.item.contentHash,
        updatedAt,
        mutation.itemId,
        mutation.expectedVersion,
      );
    assertChanged(result.changes, mutation.itemId);
    this.#options.failpoint?.('after_item_write');
    this.#replaceKeys(mutation.itemId, mutation.item.keys);
    this.#options.failpoint?.('after_keys_write');
    this.#replaceSources(mutation.itemId, mutation.item.sources);
    this.#options.failpoint?.('after_sources_write');
    return mutationResult(
      mutationIndex,
      'update',
      this.#requireItemRecord(mutation.itemId).item,
      'updated',
    );
  }

  #changeLifecycle(
    mutation: Extract<NormalizedMutation, { type: 'archive' | 'restore' }>,
    mutationIndex: number,
    committedAt: number,
    target: MemoryItem['lifecycleState'],
    transientItemIds: ReadonlySet<string>,
  ): MemoryMutationResult {
    const current = this.#requireVersion(mutation.itemId, mutation.expectedVersion);
    const expected = target === 'archived' ? 'active' : 'archived';
    if (current.lifecycleState !== expected) {
      throw new MemoryItemStoreConflictError(
        'invalid_lifecycle_transition',
        `Memory Item ${mutation.itemId} is ${current.lifecycleState}, expected ${expected}`,
        mutation.itemId,
      );
    }
    if (target === 'active') {
      const duplicate = this.#findActiveFactDuplicate(
        writeFromRecord(this.#requireItemRecord(mutation.itemId)),
        mutation.itemId,
      );
      if (duplicate) {
        this.#throwDuplicateConflict(
          duplicate,
          transientItemIds,
          mutation.itemId,
          `Restoring Memory Item ${mutation.itemId}`,
        );
      }
    }

    const updatedAt = Math.max(committedAt, current.updatedAt);
    const result = this.#database
      .prepare(
        `UPDATE memory_items
         SET version = version + 1, lifecycle_state = ?, updated_at = ?
         WHERE item_id = ? AND version = ? AND lifecycle_state = ?`,
      )
      .run(target, updatedAt, mutation.itemId, mutation.expectedVersion, expected);
    assertChanged(result.changes, mutation.itemId);
    this.#options.failpoint?.('after_item_write');
    return mutationResult(
      mutationIndex,
      mutation.type,
      this.#requireItemRecord(mutation.itemId).item,
      target === 'active' ? 'restored' : 'archived',
    );
  }

  #requireVersion(itemId: string, expectedVersion: number): MemoryItem {
    const record = this.#readItemRecord(itemId);
    if (!record) {
      throw new MemoryItemStoreConflictError(
        'item_not_found',
        `Memory Item ${itemId} does not exist`,
        itemId,
      );
    }
    if (record.item.version !== expectedVersion) {
      throw new MemoryItemStoreConflictError(
        'version_conflict',
        `Memory Item ${itemId} is version ${record.item.version}, expected ${expectedVersion}`,
        itemId,
      );
    }
    return record.item;
  }

  /**
   * Enforce one active row per exact normalized fact identity.
   * Evidence and retrieval-key merging remain caller policy: this guard only
   * reports the conflicting Item so a trusted extraction layer can CAS-update it.
   */
  #findActiveFactDuplicate(
    write: NormalizedMemoryWrite,
    excludedItemId?: string,
  ): MemoryItem | undefined {
    const scopeClause = write.scopeType === 'global' ? 'scope_key IS NULL' : 'scope_key = ?';
    const parameters: string[] = [write.scopeType];
    if (write.scopeType === 'workspace') parameters.push(write.scopeKey!);
    parameters.push(write.contentHash);
    const rows = this.#database
      .prepare(
        `SELECT item_id FROM memory_items
         WHERE lifecycle_state = 'active'
           AND scope_type = ?
           AND ${scopeClause}
           AND content_hash = ?
         ORDER BY item_id ASC`,
      )
      .all(...parameters) as Array<{ item_id?: unknown }>;
    for (const row of rows) {
      const itemId = requiredIdentifierString(row.item_id, 'item_id');
      const record = this.#readItemRecord(itemId);
      if (!record) throw new Error(`Memory Item ${itemId} disappeared during duplicate check`);
      if (itemId !== excludedItemId && factIdentityMatchesWrite(record.item, write)) {
        return record.item;
      }
    }
    return undefined;
  }

  #throwDuplicateConflict(
    duplicate: MemoryItem,
    transientItemIds: ReadonlySet<string>,
    itemId: string | undefined,
    action: string,
  ): never {
    if (transientItemIds.has(duplicate.itemId)) {
      throw new MemoryItemStoreConflictError(
        'duplicate_within_batch',
        `${action} would duplicate a fact changed earlier in the same batch; split or normalize the batch before retrying`,
        itemId,
      );
    }
    throw new MemoryItemStoreConflictError(
      'duplicate_active',
      `${action} would duplicate active Item ${duplicate.itemId}; merge current keys and sources with the new evidence before updating it`,
      itemId,
      duplicate.itemId,
    );
  }

  #replaceKeys(itemId: string, keys: readonly MemoryItemKey[]): void {
    this.#database.prepare('DELETE FROM memory_item_keys WHERE item_id = ?').run(itemId);
    const insert = this.#database.prepare(
      `INSERT INTO memory_item_keys(item_id, key_text, normalized_key, key_type, key_origin)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const key of keys) {
      insert.run(itemId, key.key, key.normalizedKey, key.keyType, key.keyOrigin);
    }
  }

  #replaceSources(itemId: string, sources: readonly MemoryItemSource[]): void {
    this.#database.prepare('DELETE FROM memory_item_sources WHERE item_id = ?').run(itemId);
    const insert = this.#database.prepare(
      `INSERT INTO memory_item_sources(item_id, session_id, run_id, turn_id, event_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const source of sources) {
      insert.run(itemId, source.sessionId, source.runId, source.turnId, source.eventId);
    }
  }

  #readItemRecord(itemId: string): MemoryItemRecord | undefined {
    const row = this.#database
      .prepare('SELECT * FROM memory_items WHERE item_id = ?')
      .get(itemId) as MemoryItemRow | undefined;
    if (!row) return undefined;
    const keys = this.#database
      .prepare(
        `SELECT key_text, normalized_key, key_type, key_origin
         FROM memory_item_keys WHERE item_id = ? ORDER BY normalized_key ASC
         LIMIT ${MAX_KEYS_PER_ITEM + 1}`,
      )
      .all(itemId) as unknown as MemoryKeyRow[];
    const sources = this.#database
      .prepare(
        `SELECT session_id, run_id, turn_id, event_id
         FROM memory_item_sources WHERE item_id = ? ORDER BY event_id ASC
         LIMIT ${MAX_SOURCES_PER_ITEM + 1}`,
      )
      .all(itemId) as unknown as MemorySourceRow[];
    assertChildCardinality('keys', keys.length, MAX_KEYS_PER_ITEM);
    assertChildCardinality('sources', sources.length, MAX_SOURCES_PER_ITEM);
    return {
      item: decodeItem(row),
      keys: keys.map(decodeKey),
      sources: sources.map(decodeSource),
    };
  }

  #requireItemRecord(itemId: string): MemoryItemRecord {
    const record = this.#readItemRecord(itemId);
    if (!record) throw new Error(`Memory Item ${itemId} disappeared during transaction`);
    return record;
  }

  #readOperationRow(operationId: string): MemoryOperationRow | undefined {
    return this.#database
      .prepare(
        `SELECT operation_id, operation_type, request_hash, result_json, committed_at
         FROM memory_write_operations WHERE operation_id = ?`,
      )
      .get(operationId) as MemoryOperationRow | undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('SQLite Memory Item Store is closed');
  }

  #readSnapshot<T>(operation: () => T): T {
    this.#database.exec('BEGIN');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

export function buildSqliteMemoryKeySearchQuery(input: {
  readonly terms: readonly string[];
  readonly match: 'exact' | 'prefix';
  readonly workspaceKey?: string;
  readonly includeArchived: boolean;
  readonly limit: number;
}): SqliteMemoryKeySearchQuery {
  const parameters: Array<string | number> = [];
  let matchingKeysSql: string;
  if (input.match === 'exact') {
    matchingKeysSql = `
      SELECT item_id, normalized_key AS matched_term
      FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
      WHERE normalized_key IN (${placeholders(input.terms.length)})`;
    parameters.push(...input.terms);
  } else {
    matchingKeysSql = input.terms
      .map((term, index) => {
        const upperBound = prefixUpperBound(term);
        parameters.push(term);
        if (upperBound) {
          parameters.push(upperBound);
          return `
            SELECT item_id, ${index} AS matched_term
            FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
            WHERE normalized_key >= ? AND normalized_key < ?`;
        }
        return `
          SELECT item_id, ${index} AS matched_term
          FROM memory_item_keys INDEXED BY memory_item_keys_by_normalized_key
          WHERE normalized_key >= ?`;
      })
      .join('\nUNION ALL\n');
  }
  const scopeClause = input.workspaceKey
    ? `(i.scope_type = 'global' OR (i.scope_type = 'workspace' AND i.scope_key = ?))`
    : `i.scope_type = 'global'`;
  if (input.workspaceKey) parameters.push(input.workspaceKey);
  parameters.push(input.limit);
  return {
    sql: `
      WITH matching_keys AS MATERIALIZED (
        ${matchingKeysSql}
      )
      SELECT i.item_id
      FROM matching_keys m
      JOIN memory_items i ON i.item_id = m.item_id
      WHERE ${scopeClause}
        AND ${input.includeArchived ? '1 = 1' : `i.lifecycle_state = 'active'`}
      GROUP BY i.item_id
      ORDER BY COUNT(DISTINCT m.matched_term) DESC, i.updated_at DESC, i.item_id ASC
      LIMIT ?`,
    parameters,
  };
}

function normalizeMutations(
  mutations: readonly MemoryItemMutation[],
): readonly NormalizedMutation[] {
  if (!Array.isArray(mutations) || mutations.length === 0) {
    throw new Error('Memory operation requires at least one mutation');
  }
  if (mutations.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(`Memory operation accepts at most ${MAX_MUTATIONS_PER_OPERATION} mutations`);
  }
  return mutations.map((mutation): NormalizedMutation => {
    if (!mutation || typeof mutation !== 'object') throw new Error('Invalid Memory mutation');
    switch (mutation.type) {
      case 'create':
        return { type: 'create', item: normalizeWrite(mutation.item) };
      case 'update':
        return {
          type: 'update',
          itemId: normalizeIdentifier(mutation.itemId, 'itemId'),
          expectedVersion: normalizeVersion(mutation.expectedVersion),
          item: normalizeWrite(mutation.item),
        };
      case 'archive':
      case 'restore':
        return {
          type: mutation.type,
          itemId: normalizeIdentifier(mutation.itemId, 'itemId'),
          expectedVersion: normalizeVersion(mutation.expectedVersion),
        };
      default:
        throw new Error('Unknown Memory mutation type');
    }
  });
}

function assertChildCardinality(child: 'keys' | 'sources', count: number, maximum: number): void {
  if (count < 1 || count > maximum) {
    throw new Error(
      `Invalid Memory Item ${child} cardinality: expected 1..${maximum}, got ${count}`,
    );
  }
}

function validateObservedAtForCommit(
  mutations: readonly NormalizedMutation[],
  committedAt: number,
): void {
  for (const mutation of mutations) {
    if (
      (mutation.type === 'create' || mutation.type === 'update') &&
      mutation.item.observedAt > committedAt
    ) {
      throw new Error('observedAt cannot be later than commit time');
    }
  }
}

function normalizeWrite(input: MemoryItemWrite): NormalizedMemoryWrite {
  if (!input || typeof input !== 'object') throw new Error('Memory Item write must be an object');
  const content = normalizeLongTermMemoryContent(input.content);
  if (!content.ok) throw new Error(content.message);
  if (!isMemoryItemKind(input.kind)) throw new Error('Invalid Memory Item kind');
  if (!isMemoryStatementType(input.statementType)) throw new Error('Invalid Memory statement type');
  if (!isMemoryTemporalType(input.temporalType)) throw new Error('Invalid Memory temporal type');
  if (!isMemoryScopeType(input.scopeType)) throw new Error('Invalid Memory scope type');
  if (!isMemoryItemOrigin(input.origin)) throw new Error('Invalid Memory Item origin');

  const scopeKey = normalizeScopeKey(input.scopeType, input.scopeKey);
  const eventStartedAt = normalizeOptionalTimestamp(input.eventStartedAt, 'eventStartedAt');
  const eventEndedAt = normalizeOptionalTimestamp(input.eventEndedAt, 'eventEndedAt');
  validateMemoryTemporalBounds({
    temporalType: input.temporalType,
    eventStartedAt,
    eventEndedAt,
  });
  const observedAt = normalizeTimestamp(input.observedAt, 'observedAt');
  return {
    content: content.value,
    kind: input.kind,
    statementType: input.statementType,
    temporalType: input.temporalType,
    scopeType: input.scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    observedAt,
    origin: input.origin,
    contentHash: hashText(content.value),
    keys: normalizeKeys(input.keys),
    sources: normalizeSources(input.sources),
  };
}

function normalizeScopeKey(
  scopeType: MemoryItem['scopeType'],
  input: string | null | undefined,
): string | null {
  if (scopeType === 'global') {
    if (input !== undefined && input !== null) {
      throw new Error('Global Memory Item cannot have a scopeKey');
    }
    return null;
  }
  return normalizeIdentifier(input, 'workspace scopeKey');
}

function normalizeKeys(input: readonly MemoryItemKeyInput[]): readonly MemoryItemKey[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Memory Item requires at least one search key');
  }
  if (input.length > MAX_KEYS_PER_ITEM) {
    throw new Error(`Memory Item accepts at most ${MAX_KEYS_PER_ITEM} search keys`);
  }
  const winners = new Map<string, MemoryItemKey>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid Memory search key');
    if (!isMemoryKeyType(candidate.keyType)) throw new Error('Invalid Memory key type');
    if (!isMemoryKeyOrigin(candidate.keyOrigin)) throw new Error('Invalid Memory key origin');
    const key = normalizeVisibleText(candidate.key, 'Memory search key', MAX_KEY_CODE_POINTS);
    const normalized: MemoryItemKey = {
      key,
      normalizedKey: normalizeSearchTerm(key),
      keyType: candidate.keyType,
      keyOrigin: candidate.keyOrigin,
    };
    const existing = winners.get(normalized.normalizedKey);
    if (!existing || keyPriority(normalized) > keyPriority(existing)) {
      winners.set(normalized.normalizedKey, normalized);
    } else if (
      existing &&
      keyPriority(normalized) === keyPriority(existing) &&
      compareText(normalized.key, existing.key) < 0
    ) {
      winners.set(normalized.normalizedKey, normalized);
    }
  }
  return [...winners.values()].sort((left, right) =>
    compareText(left.normalizedKey, right.normalizedKey),
  );
}

function normalizeSources(input: readonly MemoryItemSource[]): readonly MemoryItemSource[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Memory Item requires at least one source Event');
  }
  if (input.length > MAX_SOURCES_PER_ITEM) {
    throw new Error(`Memory Item accepts at most ${MAX_SOURCES_PER_ITEM} sources`);
  }
  const sources = new Map<string, MemoryItemSource>();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') throw new Error('Invalid Memory Item source');
    const source: MemoryItemSource = {
      sessionId: normalizeIdentifier(candidate.sessionId, 'source sessionId'),
      runId: normalizeIdentifier(candidate.runId, 'source runId'),
      turnId: normalizeIdentifier(candidate.turnId, 'source turnId'),
      eventId: normalizeIdentifier(candidate.eventId, 'source eventId'),
    };
    const existing = sources.get(source.eventId);
    if (existing && !sameSource(existing, source)) {
      throw new Error(`Source eventId ${source.eventId} has conflicting provenance`);
    }
    sources.set(source.eventId, source);
  }
  return [...sources.values()].sort((left, right) => compareText(left.eventId, right.eventId));
}

function sameSource(left: MemoryItemSource, right: MemoryItemSource): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.eventId === right.eventId
  );
}

function normalizeIdentifier(input: unknown, name: string): string {
  if (typeof input !== 'string') throw new Error(`${name} must be a string`);
  if (input.normalize('NFC') !== input || input.trim() !== input) {
    throw new Error(`${name} must already be NFC-normalized without surrounding whitespace`);
  }
  return normalizeVisibleText(input, name, MAX_IDENTIFIER_CODE_POINTS);
}

function normalizeVisibleText(input: unknown, name: string, maxCodePoints: number): string {
  if (typeof input !== 'string') throw new Error(`${name} must be a string`);
  const value = input.normalize('NFC').trim();
  if (value === '') throw new Error(`${name} cannot be empty`);
  if (/[\p{Cc}\p{Cs}\u200B\u200C\u200D\uFEFF]/u.test(value)) {
    throw new Error(`${name} cannot contain control or zero-width characters`);
  }
  if (Array.from(value).length > maxCodePoints) {
    throw new Error(`${name} must be ${maxCodePoints} code points or fewer`);
  }
  return value;
}

function normalizeSearchTerm(input: unknown): string {
  return normalizeVisibleText(input, 'Memory search term', MAX_KEY_CODE_POINTS)
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

function normalizeVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('expectedVersion must be a positive safe integer');
  }
  return value as number;
}

function normalizeTimestamp(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer UTC millisecond timestamp`);
  }
  return value as number;
}

function normalizeOptionalTimestamp(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return normalizeTimestamp(value, name);
}

function keyPriority(key: MemoryItemKey): number {
  const origin = { user: 3, deterministic: 2, llm: 1 } as const;
  const type = { code: 5, exact: 4, entity: 3, concept: 2, alias: 1 } as const;
  return origin[key.keyOrigin] * 10 + type[key.keyType];
}

function recordMatchesWrite(record: MemoryItemRecord, write: NormalizedMemoryWrite): boolean {
  return hashCanonical(writeFromRecord(record)) === hashCanonical(write);
}

function writeFromRecord(record: MemoryItemRecord): NormalizedMemoryWrite {
  return {
    content: record.item.content,
    kind: record.item.kind,
    statementType: record.item.statementType,
    temporalType: record.item.temporalType,
    scopeType: record.item.scopeType,
    scopeKey: record.item.scopeKey,
    eventStartedAt: record.item.eventStartedAt,
    eventEndedAt: record.item.eventEndedAt,
    observedAt: record.item.observedAt,
    origin: record.item.origin,
    contentHash: record.item.contentHash,
    keys: record.keys,
    sources: record.sources,
  };
}

function factIdentityMatchesWrite(item: MemoryItem, write: NormalizedMemoryWrite): boolean {
  return (
    item.content === write.content &&
    item.kind === write.kind &&
    item.statementType === write.statementType &&
    item.temporalType === write.temporalType &&
    item.scopeType === write.scopeType &&
    item.scopeKey === write.scopeKey &&
    item.eventStartedAt === write.eventStartedAt &&
    item.eventEndedAt === write.eventEndedAt
  );
}

function mutationResult(
  mutationIndex: number,
  mutationType: MemoryMutationResult['mutationType'],
  item: MemoryItem,
  outcome: MemoryMutationResult['outcome'],
): MemoryMutationResult {
  return {
    mutationIndex,
    mutationType,
    itemId: item.itemId,
    version: item.version,
    lifecycleState: item.lifecycleState,
    outcome,
  };
}

function decodeItem(row: MemoryItemRow): MemoryItem {
  const kind = requiredString(row.kind, 'kind');
  const statementType = requiredString(row.statement_type, 'statement_type');
  const temporalType = requiredString(row.temporal_type, 'temporal_type');
  const scopeType = requiredString(row.scope_type, 'scope_type');
  const lifecycleState = requiredString(row.lifecycle_state, 'lifecycle_state');
  const origin = requiredString(row.origin, 'origin');
  if (!isMemoryItemKind(kind)) throw invalidColumn('kind');
  if (!isMemoryStatementType(statementType)) throw invalidColumn('statement_type');
  if (!isMemoryTemporalType(temporalType)) throw invalidColumn('temporal_type');
  if (!isMemoryScopeType(scopeType)) throw invalidColumn('scope_type');
  if (!isMemoryLifecycleState(lifecycleState)) throw invalidColumn('lifecycle_state');
  if (!isMemoryItemOrigin(origin)) throw invalidColumn('origin');
  const itemId = requiredIdentifierString(row.item_id, 'item_id');
  const version = requiredPositiveInteger(row.version, 'version');
  const content = requiredNonEmptyString(row.content, 'content');
  const normalizedContent = normalizeLongTermMemoryContent(content);
  if (!normalizedContent.ok || normalizedContent.value !== content) throw invalidColumn('content');
  const scopeKey = nullableIdentifierString(row.scope_key, 'scope_key');
  const eventStartedAt = nullableNonNegativeInteger(row.event_started_at, 'event_started_at');
  const eventEndedAt = nullableNonNegativeInteger(row.event_ended_at, 'event_ended_at');
  const observedAt = requiredNonNegativeInteger(row.observed_at, 'observed_at');
  const contentHash = requiredHash(row.content_hash, 'content_hash');
  const createdAt = requiredNonNegativeInteger(row.created_at, 'created_at');
  const updatedAt = requiredNonNegativeInteger(row.updated_at, 'updated_at');
  if (
    (scopeType === 'global' && scopeKey !== null) ||
    (scopeType === 'workspace' && (scopeKey === null || scopeKey.length === 0))
  ) {
    throw invalidColumn('scope_key');
  }
  validateMemoryTemporalBounds({ temporalType, eventStartedAt, eventEndedAt });
  if (createdAt > updatedAt || observedAt > updatedAt) throw invalidColumn('timestamps');
  if (hashText(content) !== contentHash) throw invalidColumn('content_hash');
  return {
    itemId,
    version,
    content,
    kind,
    statementType,
    temporalType,
    scopeType,
    scopeKey,
    eventStartedAt,
    eventEndedAt,
    observedAt,
    lifecycleState,
    origin,
    contentHash,
    createdAt,
    updatedAt,
  };
}

function decodeKey(row: MemoryKeyRow): MemoryItemKey {
  const keyType = requiredString(row.key_type, 'key_type');
  const keyOrigin = requiredString(row.key_origin, 'key_origin');
  if (!isMemoryKeyType(keyType)) throw invalidColumn('key_type');
  if (!isMemoryKeyOrigin(keyOrigin)) throw invalidColumn('key_origin');
  const key = requiredNonEmptyString(row.key_text, 'key_text');
  const normalizedKey = requiredNonEmptyString(row.normalized_key, 'normalized_key');
  if (normalizeSearchTerm(key) !== normalizedKey) throw invalidColumn('normalized_key');
  return {
    key,
    normalizedKey,
    keyType,
    keyOrigin,
  };
}

function decodeSource(row: MemorySourceRow): MemoryItemSource {
  return {
    sessionId: requiredIdentifierString(row.session_id, 'session_id'),
    runId: requiredIdentifierString(row.run_id, 'run_id'),
    turnId: requiredIdentifierString(row.turn_id, 'turn_id'),
    eventId: requiredIdentifierString(row.event_id, 'event_id'),
  };
}

function decodeOperation(row: MemoryOperationRow): MemoryWriteOperationResult {
  const operationId = requiredIdentifierString(row.operation_id, 'operation_id');
  const operationType = requiredString(row.operation_type, 'operation_type');
  if (!['create', 'update', 'archive', 'restore', 'batch'].includes(operationType)) {
    throw invalidColumn('operation_type');
  }
  requiredHash(row.request_hash, 'request_hash');
  const resultJson = requiredString(row.result_json, 'result_json');
  if (resultJson.length > MAX_OPERATION_RESULT_JSON_CODE_UNITS) {
    throw new Error(`Memory operation ${operationId} result JSON is too large`);
  }
  let results: unknown;
  try {
    results = JSON.parse(resultJson);
  } catch (error) {
    throw new Error(`Invalid result JSON for Memory operation ${operationId}`, { cause: error });
  }
  if (!Array.isArray(results))
    throw new Error(`Invalid results for Memory operation ${operationId}`);
  if (results.length > MAX_MUTATIONS_PER_OPERATION) {
    throw new Error(
      `Memory operation results accept at most ${MAX_MUTATIONS_PER_OPERATION} mutations`,
    );
  }
  const decodedResults = results.map((result, index) => decodeMutationResult(result, index));
  if (
    (operationType === 'batch' && decodedResults.length < 2) ||
    (operationType !== 'batch' &&
      (decodedResults.length !== 1 || decodedResults[0]?.mutationType !== operationType))
  ) {
    throw new Error(`Invalid results for Memory operation ${operationId}`);
  }
  for (const result of decodedResults) validateMutationResultOutcome(result);
  return {
    operationId,
    operationType: operationType as MemoryWriteOperationResult['operationType'],
    replayed: false,
    committedAt: requiredNonNegativeInteger(row.committed_at, 'committed_at'),
    results: decodedResults,
  };
}

function decodeMutationResult(value: unknown, expectedIndex: number): MemoryMutationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Memory mutation result');
  }
  const result = value as Record<string, unknown>;
  const mutationIndex = requiredNonNegativeInteger(result.mutationIndex, 'mutationIndex');
  const mutationType = requiredString(result.mutationType, 'mutationType');
  const lifecycleState = requiredString(result.lifecycleState, 'lifecycleState');
  const outcome = requiredString(result.outcome, 'outcome');
  if (mutationIndex !== expectedIndex) throw invalidColumn('mutationIndex');
  if (!['create', 'update', 'archive', 'restore'].includes(mutationType)) {
    throw invalidColumn('mutationType');
  }
  if (!isMemoryLifecycleState(lifecycleState)) throw invalidColumn('lifecycleState');
  if (!['created', 'updated', 'archived', 'restored', 'noop'].includes(outcome)) {
    throw invalidColumn('outcome');
  }
  return {
    mutationIndex,
    mutationType: mutationType as MemoryMutationResult['mutationType'],
    itemId: requiredIdentifierString(result.itemId, 'itemId'),
    version: requiredPositiveInteger(result.version, 'version'),
    lifecycleState,
    outcome: outcome as MemoryMutationResult['outcome'],
  };
}

function validateMutationResultOutcome(result: MemoryMutationResult): void {
  const valid =
    (result.mutationType === 'create' &&
      result.outcome === 'created' &&
      result.lifecycleState === 'active') ||
    (result.mutationType === 'update' &&
      (result.outcome === 'updated' || result.outcome === 'noop')) ||
    (result.mutationType === 'archive' &&
      result.outcome === 'archived' &&
      result.lifecycleState === 'archived') ||
    (result.mutationType === 'restore' &&
      result.outcome === 'restored' &&
      result.lifecycleState === 'active');
  if (!valid) throw new Error('Invalid Memory mutation result outcome');
}

function requiredString(value: unknown, column: string): string {
  if (typeof value !== 'string') throw invalidColumn(column);
  return value;
}

function requiredNonEmptyString(value: unknown, column: string): string {
  const result = requiredString(value, column);
  if (result.length === 0) throw invalidColumn(column);
  return result;
}

function requiredIdentifierString(value: unknown, column: string): string {
  const result = requiredNonEmptyString(value, column);
  try {
    return normalizeIdentifier(result, column);
  } catch {
    throw invalidColumn(column);
  }
}

function nullableIdentifierString(value: unknown, column: string): string | null {
  return value === null ? null : requiredIdentifierString(value, column);
}

function requiredInteger(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalidColumn(column);
  return value;
}

function requiredNonNegativeInteger(value: unknown, column: string): number {
  const result = requiredInteger(value, column);
  if (result < 0) throw invalidColumn(column);
  return result;
}

function requiredPositiveInteger(value: unknown, column: string): number {
  const result = requiredInteger(value, column);
  if (result < 1) throw invalidColumn(column);
  return result;
}

function nullableNonNegativeInteger(value: unknown, column: string): number | null {
  return value === null ? null : requiredNonNegativeInteger(value, column);
}

function requiredHash(value: unknown, column: string): string {
  const result = requiredString(value, column);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw invalidColumn(column);
  return result;
}

function invalidColumn(column: string): Error {
  return new Error(`Invalid long-term memory SQLite column ${column}`);
}

function assertChanged(changes: number | bigint, itemId: string): void {
  if (Number(changes) !== 1) {
    throw new MemoryItemStoreConflictError(
      'version_conflict',
      `Memory Item ${itemId} changed concurrently`,
      itemId,
    );
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashCanonical(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Smallest Unicode string strictly greater than every string with this prefix. */
function prefixUpperBound(prefix: string): string | undefined {
  const points = Array.from(prefix, (character) => character.codePointAt(0)!);
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point < 0x10ffff) {
      const successor = point === 0xd7ff ? 0xe000 : point + 1;
      return String.fromCodePoint(...points.slice(0, index), successor);
    }
  }
  return undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function preparePrivateDatabaseFiles(path: string): void {
  secureFile(path, true, false);
  for (const sidecar of databaseSidecars(path)) secureFile(sidecar, false, true);
}

function secureExistingDatabaseFiles(path: string): void {
  secureFile(path, false, false);
  for (const sidecar of databaseSidecars(path)) secureFile(sidecar, false, true);
}

function secureFile(path: string, create: boolean, allowUnlinked: boolean): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Long-term memory SQLite path must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error;
  }
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR | noFollow | (create ? fsConstants.O_CREAT : 0),
      0o600,
    );
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      throw new Error(`Long-term memory SQLite path is not a regular file: ${path}`);
    }
    if (status.nlink === 0 && allowUnlinked) return;
    if (status.nlink !== 1) {
      throw new Error(`Long-term memory SQLite path must not be hard-linked: ${path}`);
    }
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o600);
  } catch (error) {
    if (!create && isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function databaseSidecars(path: string): readonly string[] {
  return [`${path}-wal`, `${path}-shm`, `${path}-journal`];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // Preserve the write failure that triggered rollback.
  }
}
