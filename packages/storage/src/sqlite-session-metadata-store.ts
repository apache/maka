import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertAgentGraphScheduleUpdateRequest,
  assertAgentGraphIntentClaimRequest,
  decodeAgentGraphScheduleUpdate,
  decodeAgentGraphIntentClaim,
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  type AgentGraphScheduleUpdate,
  type AgentGraphScheduleUpdateRequest,
  type AgentGraphScheduleUpdateResult,
  type AgentGraphIntentClaim,
  type AgentGraphIntentClaimRequest,
  type AgentGraphIntentClaimResult,
  type SessionHeader,
  type SessionListFilter,
  type SubagentSessionParent,
} from '@maka/core';
import {
  assertSafeSessionId,
  normalizeSessionHeader,
  SessionNotFoundError,
} from './session-store.js';
import {
  configureSqliteSessionMetadataDatabase,
  migrateSqliteSessionMetadataDatabase,
  readSqliteSessionMetadataSchemaVersion,
} from './sqlite-session-metadata-schema.js';

export { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from './sqlite-session-metadata-schema.js';

const require = createRequire(import.meta.url);

function loadSqliteModule(): typeof import('node:sqlite') {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningType = typeof args[0] === 'string' ? args[0] : undefined;
    if (
      warningType === 'ExperimentalWarning' &&
      String(warning).startsWith('SQLite is an experimental feature')
    ) {
      return;
    }
    Reflect.apply(emitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

export type SqliteSessionMetadataStoreFailpoint =
  | 'after_session_row_write'
  | 'after_session_labels_write'
  | 'after_session_import_marker_write'
  | 'after_agent_graph_intent_claim_write'
  | 'after_agent_graph_schedule_update_write';

export interface SqliteSessionMetadataStoreOptions {
  now?: () => number;
  failpoint?: (point: SqliteSessionMetadataStoreFailpoint) => void;
}

export interface SessionMetadataRecord {
  header: SessionHeader;
  metadataVersion: number;
  committedAt: number;
}

export interface IdempotentSubagentSessionMetadataResult {
  record: SessionMetadataRecord;
  created: boolean;
}

export interface SessionMetadataImportEntry {
  header: SessionHeader;
  source: {
    path: string;
    fingerprint: string;
  };
}

export interface SessionMetadataImportResult {
  created: boolean[];
  sourcesAlreadyImported: number;
  sourcesTombstoned: number;
}

export class SessionMetadataConflictError extends Error {
  readonly name: string = 'SessionMetadataConflictError';
}

export class AgentGraphIntentClaimConflictError extends SessionMetadataConflictError {
  readonly name = 'AgentGraphIntentClaimConflictError';
}

export class AgentGraphScheduleUpdateConflictError extends SessionMetadataConflictError {
  readonly name = 'AgentGraphScheduleUpdateConflictError';
}

export function createSqliteSessionMetadataStore(
  path: string,
  options: SqliteSessionMetadataStoreOptions = {},
): SqliteSessionMetadataStore {
  return new SqliteSessionMetadataStore(path, options);
}

export class SqliteSessionMetadataStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly options: SqliteSessionMetadataStoreOptions = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const { DatabaseSync } = loadSqliteModule();
    this.db = new DatabaseSync(path);
    configureSqliteSessionMetadataDatabase(this.db);
    migrateSqliteSessionMetadataDatabase(this.db);
    this.now = options.now ?? Date.now;
  }

  schemaVersion(): number {
    this.assertOpen();
    return readSqliteSessionMetadataSchemaVersion(this.db);
  }

  journalMode(): string {
    this.assertOpen();
    const row = this.db.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async backup(destinationPath: string): Promise<number> {
    this.assertOpen();
    if (!destinationPath) throw new Error('Session metadata backup destination is required');
    if (this.path !== ':memory:' && resolve(destinationPath) === resolve(this.path)) {
      throw new Error('Session metadata backup destination must differ from the source database');
    }
    if (existsSync(destinationPath)) {
      throw new Error(`Session metadata backup destination already exists: ${destinationPath}`);
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    return loadSqliteModule().backup(this.db, destinationPath);
  }

  async create(header: SessionHeader): Promise<SessionMetadataRecord> {
    this.assertOpen();
    const normalized = normalizeSessionHeader(header);
    assertSafeSessionId(normalized.id);
    if (normalized.subagentSpawn) {
      throw new Error('Subagent spawn metadata requires idempotent child-session creation');
    }
    return this.transaction(() => {
      if (this.hasTombstone(normalized.id)) {
        throw new SessionMetadataConflictError(
          `Session metadata id is tombstoned: ${normalized.id}`,
        );
      }
      if (this.readRecordSync(normalized.id)) {
        throw new SessionMetadataConflictError(`Session metadata already exists: ${normalized.id}`);
      }
      return this.insertHeader(normalized, 1, this.now());
    });
  }

  async createSubagent(header: SessionHeader): Promise<IdempotentSubagentSessionMetadataResult> {
    this.assertOpen();
    const normalized = normalizeSessionHeader(header);
    assertSafeSessionId(normalized.id);
    const identity = requireSubagentSpawnIdentity(normalized);
    return this.transaction(() => {
      if (this.hasTombstone(normalized.id)) {
        throw new SessionMetadataConflictError(
          `Session metadata id is tombstoned: ${normalized.id}`,
        );
      }
      if (this.readRecordSync(normalized.id)) {
        throw new SessionMetadataConflictError(`Session metadata already exists: ${normalized.id}`);
      }
      const committedAt = this.now();
      const claim = this.tryClaimSubagentSpawn(normalized, committedAt);
      if (claim.created) {
        return { record: this.insertHeader(normalized, 1, committedAt), created: true };
      }
      const existing = this.readRecordSync(claim.childSessionId);
      if (claim.requestFingerprint !== identity.spawn.requestFingerprint) {
        throw new SessionMetadataConflictError(
          'Child-session spawn identity was reused for different work',
        );
      }
      if (!existing) {
        throw new SessionMetadataConflictError(
          `Child-session spawn identity belongs to deleted session: ${claim.childSessionId}`,
        );
      }
      if (!isDeepStrictEqual(existing.header.subagentParent, identity.parent)) {
        throw new SessionMetadataConflictError(
          'Child-session spawn claim disagrees with live session metadata',
        );
      }
      this.assertMatchingSubagentSpawnClaim(existing.header);
      return { record: existing, created: false };
    });
  }

  async read(sessionId: string): Promise<SessionMetadataRecord> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    const record = this.readRecordSync(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    return record;
  }

  async has(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.readRecordSync(sessionId) !== undefined;
  }

  async isTombstoned(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.hasTombstone(sessionId);
  }

  async list(filter: SessionListFilter = {}): Promise<SessionMetadataRecord[]> {
    this.assertOpen();
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter.isArchived !== undefined) {
      where.push('metadata.is_archived = ?');
      parameters.push(filter.isArchived ? 1 : 0);
    }
    if (filter.isFlagged !== undefined) {
      where.push('metadata.is_flagged = ?');
      parameters.push(filter.isFlagged ? 1 : 0);
    }
    if (filter.labelSlug !== undefined) {
      where.push(`
        EXISTS (
          SELECT 1
          FROM session_metadata_labels labels
          WHERE labels.session_id = metadata.session_id
            AND labels.label = ?
        )
      `);
      parameters.push(filter.labelSlug);
    }
    if (filter.subagentParentSessionId !== undefined) {
      assertSafeSessionId(filter.subagentParentSessionId);
      where.push('metadata.subagent_parent_session_id = ?');
      parameters.push(filter.subagentParentSessionId);
    }
    const rows = this.db
      .prepare(`
        SELECT session_id, payload_json, metadata_version, committed_at
        FROM session_metadata metadata
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY
          COALESCE(last_message_at, last_used_at, created_at) DESC,
          session_id ASC
      `)
      .all(...parameters) as unknown as SessionMetadataRow[];
    return rows.map(decodeRecord);
  }

  async claimAgentGraphIntent(
    request: AgentGraphIntentClaimRequest,
  ): Promise<AgentGraphIntentClaimResult> {
    this.assertOpen();
    assertAgentGraphIntentClaimRequest(request);
    return this.transaction(() => {
      const claimedAt = this.now();
      const inserted = this.db
        .prepare(`
          INSERT OR IGNORE INTO agent_graph_intent_claims(
            claim_id,
            schema_version,
            graph_id,
            intent_id,
            intent_fingerprint,
            readiness_context_fingerprint,
            target_operator_id,
            target_session_id,
            target_turn_id,
            target_run_id,
            claimed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          request.claimId,
          request.schemaVersion,
          request.graphId,
          request.intentId,
          request.intentFingerprint,
          request.readinessContextFingerprint,
          request.targetOperatorId,
          request.targetSessionId,
          request.targetTurnId,
          request.targetRunId,
          claimedAt,
        );
      if (inserted.changes === 1) {
        this.options.failpoint?.('after_agent_graph_intent_claim_write');
      }
      const claim = this.readAgentGraphIntentClaimSync(request.graphId, request.intentId);
      if (!claim) {
        throw new AgentGraphIntentClaimConflictError(
          'Agent graph intent claim identity collides with another claim',
        );
      }
      if (
        claim.claimId !== request.claimId ||
        claim.intentFingerprint !== request.intentFingerprint ||
        claim.readinessContextFingerprint !== request.readinessContextFingerprint ||
        claim.targetOperatorId !== request.targetOperatorId ||
        claim.targetSessionId !== request.targetSessionId
      ) {
        throw new AgentGraphIntentClaimConflictError(
          'Agent graph intent identity was reused for different work',
        );
      }
      return { claim, created: inserted.changes === 1 };
    });
  }

  async readAgentGraphIntentClaim(
    graphId: string,
    intentId: string,
  ): Promise<AgentGraphIntentClaim | undefined> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    assertGraphIntentId(intentId);
    return this.readAgentGraphIntentClaimSync(graphId, intentId);
  }

  async listAgentGraphIntentClaims(graphId?: string): Promise<AgentGraphIntentClaim[]> {
    this.assertOpen();
    if (graphId !== undefined) assertGraphLookupIdentity(graphId, 'graph id');
    const rows = this.db
      .prepare(`
        SELECT
          schema_version AS schemaVersion,
          claim_id AS claimId,
          graph_id AS graphId,
          intent_id AS intentId,
          intent_fingerprint AS intentFingerprint,
          readiness_context_fingerprint AS readinessContextFingerprint,
          target_operator_id AS targetOperatorId,
          target_session_id AS targetSessionId,
          target_turn_id AS targetTurnId,
          target_run_id AS targetRunId,
          claimed_at AS claimedAt
        FROM agent_graph_intent_claims
        ${graphId === undefined ? '' : 'WHERE graph_id = ?'}
        ORDER BY graph_id ASC, claimed_at ASC, intent_id ASC
      `)
      .all(...(graphId === undefined ? [] : [graphId])) as unknown as AgentGraphIntentClaim[];
    return rows.map(decodeAgentGraphIntentClaim);
  }

  async commitAgentGraphScheduleUpdate(
    request: AgentGraphScheduleUpdateRequest,
  ): Promise<AgentGraphScheduleUpdateResult> {
    this.assertOpen();
    assertAgentGraphScheduleUpdateRequest(request);
    return this.transaction(() => {
      const existingById = this.readAgentGraphScheduleUpdateByIdSync(request.updateId);
      if (existingById) return this.matchAgentGraphScheduleUpdate(existingById, request);
      const existingBySource = this.readAgentGraphScheduleUpdateBySourceSync(request.source);
      if (existingBySource) return this.matchAgentGraphScheduleUpdate(existingBySource, request);
      if (this.hasClosedAgentGraphSchedule(request.graphId)) {
        throw new AgentGraphScheduleUpdateConflictError('Agent graph schedule is already finished');
      }
      const revision = this.nextAgentGraphScheduleRevision(request.graphId);
      const update: AgentGraphScheduleUpdate = {
        ...request,
        source: { ...request.source },
        addWork: request.addWork.map((work) => ({
          ...work,
          target: { ...work.target },
          inputIds: [...work.inputIds],
        })),
        stop: request.stop.map((stopped) => ({ ...stopped })),
        ...(request.finish
          ? {
              finish: {
                resultIds: [...request.finish.resultIds],
                reason: request.finish.reason,
              },
            }
          : {}),
        revision,
        committedAt: this.now(),
      };
      this.db
        .prepare(`
          INSERT INTO agent_graph_schedule_updates(
            graph_id,
            revision,
            update_id,
            schema_version,
            update_fingerprint,
            source_session_id,
            source_run_id,
            source_turn_id,
            source_tool_call_id,
            closes_graph,
            payload_json,
            committed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          update.graphId,
          update.revision,
          update.updateId,
          update.schemaVersion,
          update.updateFingerprint,
          update.source.sessionId,
          update.source.runId,
          update.source.turnId,
          update.source.toolCallId,
          booleanInteger(update.finish !== undefined),
          JSON.stringify(update),
          update.committedAt,
        );
      this.options.failpoint?.('after_agent_graph_schedule_update_write');
      return { update: decodeAgentGraphScheduleUpdate(update), created: true };
    });
  }

  async listAgentGraphScheduleUpdates(graphId: string): Promise<AgentGraphScheduleUpdate[]> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'id');
    const rows = this.db
      .prepare(`
        SELECT payload_json AS payloadJson
        FROM agent_graph_schedule_updates
        WHERE graph_id = ?
        ORDER BY revision ASC
      `)
      .all(graphId) as unknown as AgentGraphScheduleUpdateRow[];
    return rows.map(decodeAgentGraphScheduleUpdateRow);
  }

  async update(
    sessionId: string,
    patch: Partial<SessionHeader>,
    options: { expectedVersion?: number } = {},
  ): Promise<SessionMetadataRecord> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    if (Object.prototype.hasOwnProperty.call(patch, 'subagentParent')) {
      throw new Error('Subagent session parent relation is immutable');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'subagentRuntime')) {
      throw new Error('Subagent session runtime snapshot is immutable');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'subagentSpawn')) {
      throw new Error('Subagent session spawn identity is immutable');
    }
    return this.transaction(() => {
      const current = this.readRecordSync(sessionId);
      if (!current) throw new SessionNotFoundError(sessionId);
      if (
        options.expectedVersion !== undefined &&
        options.expectedVersion !== current.metadataVersion
      ) {
        throw new SessionMetadataConflictError(
          `Session metadata version conflict for ${sessionId}: expected ${options.expectedVersion}, found ${current.metadataVersion}`,
        );
      }
      const next = normalizeSessionHeader({ ...current.header, ...patch }, sessionId);
      if (next.id !== sessionId) {
        throw new SessionMetadataConflictError('Session metadata identity cannot be changed');
      }
      const metadataVersion = current.metadataVersion + 1;
      const committedAt = this.now();
      const updated = this.db
        .prepare(`
          UPDATE session_metadata
          SET
            payload_json = ?,
            created_at = ?,
            last_used_at = ?,
            last_message_at = ?,
            name = ?,
            is_flagged = ?,
            is_archived = ?,
            status = ?,
            status_updated_at = ?,
            parent_session_id = ?,
            subagent_parent_session_id = ?,
            revision_root_session_id = ?,
            revision_index = ?,
            has_unread = ?,
            backend = ?,
            llm_connection_slug = ?,
            model = ?,
            metadata_version = ?,
            committed_at = ?
          WHERE session_id = ? AND metadata_version = ?
        `)
        .run(
          JSON.stringify(next),
          next.createdAt,
          next.lastUsedAt,
          next.lastMessageAt ?? null,
          next.name,
          booleanInteger(next.isFlagged),
          booleanInteger(next.isArchived),
          next.status,
          next.statusUpdatedAt ?? null,
          next.parentSessionId ?? null,
          next.subagentParent?.parentSessionId ?? null,
          next.revisionRootSessionId ?? null,
          next.revisionIndex ?? null,
          booleanInteger(next.hasUnread),
          next.backend,
          next.llmConnectionSlug,
          next.model,
          metadataVersion,
          committedAt,
          sessionId,
          current.metadataVersion,
        );
      if (updated.changes !== 1) {
        throw new SessionMetadataConflictError(
          `Session metadata compare-and-set failed: ${sessionId}`,
        );
      }
      this.options.failpoint?.('after_session_row_write');
      this.replaceLabels(next);
      this.options.failpoint?.('after_session_labels_write');
      return { header: next, metadataVersion, committedAt };
    });
  }

  async remove(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const deleted =
        this.db.prepare('DELETE FROM session_metadata WHERE session_id = ?').run(sessionId)
          .changes === 1;
      this.db
        .prepare(`
          INSERT INTO session_metadata_tombstones(session_id, deleted_at)
          VALUES (?, ?)
          ON CONFLICT(session_id) DO NOTHING
        `)
        .run(sessionId, this.now());
      return deleted;
    });
  }

  async importEntries(
    entries: readonly SessionMetadataImportEntry[],
  ): Promise<SessionMetadataImportResult> {
    this.assertOpen();
    const sourcePaths = new Set<string>();
    const normalized = entries.map((entry) => {
      const header = normalizeSessionHeader(entry.header);
      assertSafeSessionId(header.id);
      if (!entry.source.path || !entry.source.fingerprint) {
        throw new Error(`Invalid session metadata import source for ${header.id}`);
      }
      if (sourcePaths.has(entry.source.path)) {
        throw new Error(`Duplicate session metadata import source: ${entry.source.path}`);
      }
      sourcePaths.add(entry.source.path);
      return { header, source: entry.source };
    });
    return this.transaction(() => {
      const created: boolean[] = [];
      let sourcesAlreadyImported = 0;
      let sourcesTombstoned = 0;
      for (const entry of normalized) {
        if (this.hasTombstone(entry.header.id)) {
          sourcesTombstoned += 1;
          continue;
        }
        const source = this.db
          .prepare(`
            SELECT fingerprint
            FROM session_metadata_import_sources
            WHERE source_path = ?
          `)
          .get(entry.source.path) as { fingerprint: string } | undefined;
        if (source?.fingerprint === entry.source.fingerprint) {
          const existing = this.readRecordSync(entry.header.id);
          if (!existing) {
            throw new SessionMetadataConflictError(
              `Imported session metadata is missing: ${entry.header.id}`,
            );
          }
          sourcesAlreadyImported += 1;
          continue;
        }
        const existing = this.readRecordSync(entry.header.id);
        if (existing) {
          if (!isDeepStrictEqual(existing.header, entry.header)) {
            throw new SessionMetadataConflictError(
              `Session metadata import conflict for ${entry.header.id}`,
            );
          }
          if (entry.header.subagentSpawn) {
            this.assertMatchingSubagentSpawnClaim(entry.header);
          }
          created.push(false);
        } else {
          if (entry.header.subagentSpawn) {
            const claim = this.tryClaimSubagentSpawn(entry.header, this.now());
            if (!claim.created && claim.childSessionId !== entry.header.id) {
              throw new SessionMetadataConflictError(
                `Child-session spawn identity already belongs to ${claim.childSessionId}`,
              );
            }
            this.assertMatchingSubagentSpawnClaim(entry.header);
          }
          this.insertHeader(entry.header, 1, this.now());
          created.push(true);
        }
        this.db
          .prepare(`
            INSERT INTO session_metadata_import_sources(
              source_path, fingerprint, session_id, imported_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(source_path) DO UPDATE SET
              fingerprint = excluded.fingerprint,
              session_id = excluded.session_id,
              imported_at = excluded.imported_at
          `)
          .run(entry.source.path, entry.source.fingerprint, entry.header.id, this.now());
        this.options.failpoint?.('after_session_import_marker_write');
      }
      return { created, sourcesAlreadyImported, sourcesTombstoned };
    });
  }

  private insertHeader(
    header: SessionHeader,
    metadataVersion: number,
    committedAt: number,
  ): SessionMetadataRecord {
    const inserted = this.tryInsertHeader(header, metadataVersion, committedAt, false);
    if (!inserted) {
      throw new SessionMetadataConflictError(`Session metadata already exists: ${header.id}`);
    }
    return inserted;
  }

  private tryInsertHeader(
    header: SessionHeader,
    metadataVersion: number,
    committedAt: number,
    ignoreConflicts: boolean,
  ): SessionMetadataRecord | undefined {
    const result = this.db
      .prepare(`
        INSERT ${ignoreConflicts ? 'OR IGNORE' : ''} INTO session_metadata(
          session_id,
          payload_json,
          created_at,
          last_used_at,
          last_message_at,
          name,
          is_flagged,
          is_archived,
          status,
          status_updated_at,
          parent_session_id,
          subagent_parent_session_id,
          subagent_parent_run_id,
          subagent_tool_call_id,
          subagent_swarm_id,
          subagent_item_id,
          subagent_request_fingerprint,
          subagent_initial_turn_id,
          subagent_initial_run_id,
          revision_root_session_id,
          revision_index,
          has_unread,
          backend,
          llm_connection_slug,
          model,
          metadata_version,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        header.id,
        JSON.stringify(header),
        header.createdAt,
        header.lastUsedAt,
        header.lastMessageAt ?? null,
        header.name,
        booleanInteger(header.isFlagged),
        booleanInteger(header.isArchived),
        header.status,
        header.statusUpdatedAt ?? null,
        header.parentSessionId ?? null,
        header.subagentParent?.parentSessionId ?? null,
        header.subagentParent?.spawnedBy.parentRunId ?? null,
        header.subagentParent?.spawnedBy.toolCallId ?? null,
        header.subagentParent?.swarm?.swarmId ?? null,
        header.subagentParent?.swarm?.itemId ?? null,
        header.subagentSpawn?.requestFingerprint ?? null,
        header.subagentSpawn?.initialTurnId ?? null,
        header.subagentSpawn?.initialRunId ?? null,
        header.revisionRootSessionId ?? null,
        header.revisionIndex ?? null,
        booleanInteger(header.hasUnread),
        header.backend,
        header.llmConnectionSlug,
        header.model,
        metadataVersion,
        committedAt,
      );
    if (result.changes !== 1) return undefined;
    this.options.failpoint?.('after_session_row_write');
    this.replaceLabels(header);
    this.options.failpoint?.('after_session_labels_write');
    return { header, metadataVersion, committedAt };
  }

  private replaceLabels(header: SessionHeader): void {
    this.db.prepare('DELETE FROM session_metadata_labels WHERE session_id = ?').run(header.id);
    const insert = this.db.prepare(`
      INSERT INTO session_metadata_labels(session_id, label_index, label)
      VALUES (?, ?, ?)
    `);
    for (let index = 0; index < header.labels.length; index += 1) {
      insert.run(header.id, index, header.labels[index]!);
    }
  }

  private readRecordSync(sessionId: string): SessionMetadataRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT session_id, payload_json, metadata_version, committed_at
        FROM session_metadata
        WHERE session_id = ?
      `)
      .get(sessionId) as SessionMetadataRow | undefined;
    return row ? decodeRecord(row) : undefined;
  }

  private tryClaimSubagentSpawn(
    header: SessionHeader,
    claimedAt: number,
  ): SubagentSpawnClaim & { created: boolean } {
    const identity = requireSubagentSpawnIdentity(header);
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO subagent_spawns(
          parent_session_id,
          parent_run_id,
          tool_call_id,
          swarm_id,
          item_id,
          request_fingerprint,
          child_session_id,
          initial_turn_id,
          initial_run_id,
          claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        identity.parent.parentSessionId,
        identity.parent.spawnedBy.parentRunId,
        identity.parent.spawnedBy.toolCallId,
        identity.parent.swarm?.swarmId ?? '',
        identity.parent.swarm?.itemId ?? '',
        identity.spawn.requestFingerprint,
        header.id,
        identity.spawn.initialTurnId,
        identity.spawn.initialRunId,
        claimedAt,
      );
    const claim = this.readSubagentSpawnClaim(identity.parent);
    if (!claim) throw new Error('Subagent spawn claim was not persisted');
    return { ...claim, created: result.changes === 1 };
  }

  private assertMatchingSubagentSpawnClaim(header: SessionHeader): void {
    const identity = requireSubagentSpawnIdentity(header);
    const claim = this.readSubagentSpawnClaim(identity.parent);
    if (
      !claim ||
      claim.childSessionId !== header.id ||
      claim.requestFingerprint !== identity.spawn.requestFingerprint ||
      claim.initialTurnId !== identity.spawn.initialTurnId ||
      claim.initialRunId !== identity.spawn.initialRunId
    ) {
      throw new SessionMetadataConflictError(
        'Child-session spawn claim disagrees with session metadata',
      );
    }
  }

  private readSubagentSpawnClaim(parent: SubagentSessionParent): SubagentSpawnClaim | undefined {
    return this.db
      .prepare(`
        SELECT
          request_fingerprint AS requestFingerprint,
          child_session_id AS childSessionId,
          initial_turn_id AS initialTurnId,
          initial_run_id AS initialRunId
        FROM subagent_spawns
        WHERE parent_session_id = ?
          AND parent_run_id = ?
          AND tool_call_id = ?
          AND swarm_id = ?
          AND item_id = ?
      `)
      .get(
        parent.parentSessionId,
        parent.spawnedBy.parentRunId,
        parent.spawnedBy.toolCallId,
        parent.swarm?.swarmId ?? '',
        parent.swarm?.itemId ?? '',
      ) as SubagentSpawnClaim | undefined;
  }

  private readAgentGraphIntentClaimSync(
    graphId: string,
    intentId: string,
  ): AgentGraphIntentClaim | undefined {
    const row = this.db
      .prepare(`
        SELECT
          schema_version AS schemaVersion,
          claim_id AS claimId,
          graph_id AS graphId,
          intent_id AS intentId,
          intent_fingerprint AS intentFingerprint,
          readiness_context_fingerprint AS readinessContextFingerprint,
          target_operator_id AS targetOperatorId,
          target_session_id AS targetSessionId,
          target_turn_id AS targetTurnId,
          target_run_id AS targetRunId,
          claimed_at AS claimedAt
        FROM agent_graph_intent_claims
        WHERE graph_id = ? AND intent_id = ?
      `)
      .get(graphId, intentId) as AgentGraphIntentClaim | undefined;
    return row ? decodeAgentGraphIntentClaim(row) : undefined;
  }

  private readAgentGraphScheduleUpdateByIdSync(
    updateId: string,
  ): AgentGraphScheduleUpdate | undefined {
    const row = this.db
      .prepare(`
        SELECT payload_json AS payloadJson
        FROM agent_graph_schedule_updates
        WHERE update_id = ?
      `)
      .get(updateId) as AgentGraphScheduleUpdateRow | undefined;
    return row ? decodeAgentGraphScheduleUpdateRow(row) : undefined;
  }

  private readAgentGraphScheduleUpdateBySourceSync(
    source: AgentGraphScheduleUpdateRequest['source'],
  ): AgentGraphScheduleUpdate | undefined {
    const row = this.db
      .prepare(`
        SELECT payload_json AS payloadJson
        FROM agent_graph_schedule_updates
        WHERE source_session_id = ?
          AND source_run_id = ?
          AND source_tool_call_id = ?
      `)
      .get(source.sessionId, source.runId, source.toolCallId) as
      | AgentGraphScheduleUpdateRow
      | undefined;
    return row ? decodeAgentGraphScheduleUpdateRow(row) : undefined;
  }

  private matchAgentGraphScheduleUpdate(
    existing: AgentGraphScheduleUpdate,
    request: AgentGraphScheduleUpdateRequest,
  ): AgentGraphScheduleUpdateResult {
    if (!isDeepStrictEqual(agentGraphScheduleUpdateRequest(existing), request)) {
      throw new AgentGraphScheduleUpdateConflictError(
        'Agent graph schedule update identity was reused for different work',
      );
    }
    return { update: existing, created: false };
  }

  private hasClosedAgentGraphSchedule(graphId: string): boolean {
    return (
      this.db
        .prepare(`
          SELECT 1 AS found
          FROM agent_graph_schedule_updates
          WHERE graph_id = ? AND closes_graph = 1
          LIMIT 1
        `)
        .get(graphId) !== undefined
    );
  }

  private nextAgentGraphScheduleRevision(graphId: string): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM agent_graph_schedule_updates
        WHERE graph_id = ?
      `)
      .get(graphId) as { revision?: unknown } | undefined;
    const revision = row?.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(`Invalid agent graph schedule revision for ${graphId}`);
    }
    return revision + 1;
  }

  private hasTombstone(sessionId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS found FROM session_metadata_tombstones WHERE session_id = ?')
        .get(sessionId) !== undefined
    );
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original storage or protocol failure.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite session metadata store is closed');
  }
}

function requireSubagentSpawnIdentity(header: SessionHeader): {
  parent: SubagentSessionParent;
  spawn: NonNullable<SessionHeader['subagentSpawn']>;
} {
  if (
    !isSubagentSessionParent(header.subagentParent) ||
    !isSubagentSessionRuntime(header.subagentRuntime) ||
    !isSubagentSessionSpawn(header.subagentSpawn)
  ) {
    throw new Error(
      'Idempotent child-session creation requires parent, runtime, and spawn metadata',
    );
  }
  return { parent: header.subagentParent, spawn: header.subagentSpawn };
}

interface SessionMetadataRow {
  session_id: string;
  payload_json: string;
  metadata_version: number;
  committed_at: number;
}

interface SubagentSpawnClaim {
  requestFingerprint: string;
  childSessionId: string;
  initialTurnId: string;
  initialRunId: string;
}

interface AgentGraphScheduleUpdateRow {
  payloadJson: string;
}

function decodeAgentGraphScheduleUpdateRow(
  row: AgentGraphScheduleUpdateRow,
): AgentGraphScheduleUpdate {
  return decodeAgentGraphScheduleUpdate(JSON.parse(row.payloadJson) as unknown);
}

function agentGraphScheduleUpdateRequest(
  update: AgentGraphScheduleUpdate,
): AgentGraphScheduleUpdateRequest {
  const { revision: _revision, committedAt: _committedAt, ...request } = update;
  return request;
}

function decodeRecord(row: SessionMetadataRow): SessionMetadataRecord {
  const parsed = JSON.parse(row.payload_json) as SessionHeader;
  if (
    !Number.isSafeInteger(row.metadata_version) ||
    row.metadata_version < 1 ||
    !Number.isFinite(row.committed_at)
  ) {
    throw new Error(`Invalid SQLite session metadata record for ${row.session_id}`);
  }
  return {
    header: normalizeSessionHeader(parsed, row.session_id),
    metadataVersion: row.metadata_version,
    committedAt: row.committed_at,
  };
}

function booleanInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function assertGraphLookupIdentity(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid agent graph ${name}`);
  }
}

function assertGraphIntentId(value: string): void {
  if (!/^graph_intent_[a-f0-9]{32}$/.test(value)) {
    throw new Error('Invalid agent graph intent id');
  }
}
