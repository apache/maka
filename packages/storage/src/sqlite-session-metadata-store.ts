import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION,
  AgentGraphClientProjectionConflictError,
  assessSandboxBoundaryExpansion,
  assertExecutionBoundaryCapacity,
  assertAgentGraphScheduleUpdateRequest,
  AgentGraphScheduleClosedError,
  AgentGraphScheduleRevisionConflictError,
  assertAgentGraphOperatorProvisionRequest,
  assertAgentGraphIntentClaimRequest,
  decodeAgentGraphOperatorProvision,
  decodeAgentGraphScheduleUpdate,
  decodeAgentGraphIntentClaim,
  decodeExecutionBoundary,
  createGenesisExecutionBoundary,
  SANDBOX_BOUNDARY_HOST_RESTART_CLOSURE_REASON,
  validateSandboxBoundaryExpansion,
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  type AgentGraphScheduleUpdate,
  type AgentGraphScheduleUpdateRequest,
  type AgentGraphScheduleUpdateResult,
  type AgentGraphIntentAdmissionState,
  type AgentGraphIntentAdmissionTransition,
  type AgentGraphIntentAdmissionSnapshot,
  type AgentGraphIntentClaim,
  type AgentGraphIntentClaimRequest,
  type AgentGraphIntentClaimResult,
  type AgentGraphOperatorProvision,
  type AgentGraphOperatorProvisionRequest,
  type AgentGraphOperatorProvisionResult,
  type AgentGraphClientClaimAdmission,
  type AgentGraphClientProjectionRecord,
  type AgentGraphClientProjectionWithOperator,
  type AgentGraphClientOperatorProjectionRecord,
  type AgentGraphClientTerminalActivityPage,
  AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
  type AgentGraphSupervisorWakeAttemptRecord,
  type AgentGraphSupervisorWakeRecord,
  type AgentGraphTimelineMetadataSnapshot,
  type BeginAgentGraphSupervisorWakeAttemptRequest,
  type ClaimAgentGraphSupervisorWakeRequest,
  type CompleteAgentGraphSupervisorWakeAttemptRequest,
  type CommitAgentGraphClientProjectionRequest,
  type CreateSandboxBoundaryRequest,
  type ExecutionBoundary,
  type SandboxBoundaryRequest,
  type SandboxBoundarySettlement,
  type SettleSandboxBoundaryRequest,
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
  | 'after_agent_graph_schedule_update_write'
  | 'after_agent_graph_operator_provision_write'
  | 'after_sandbox_boundary_write';

export interface SqliteSessionMetadataStoreOptions {
  now?: () => number;
  failpoint?: (point: SqliteSessionMetadataStoreFailpoint) => void;
}

export interface SessionMetadataRecord {
  header: SessionHeader;
  metadataVersion: number;
  committedAt: number;
}

export interface SessionAuthoritySnapshot {
  record: SessionMetadataRecord;
  boundary: ExecutionBoundary;
}

export interface IdempotentSubagentSessionMetadataResult {
  record: SessionMetadataRecord;
  created: boolean;
}

export interface IdempotentAgentGraphOperatorMetadataResult
  extends AgentGraphOperatorProvisionResult {
  record: SessionMetadataRecord;
}

export interface SessionMetadataImportEntry {
  header: SessionHeader;
  initialBoundary?: ExecutionBoundary;
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

  async readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const record = this.readRecordSync(sessionId);
      if (!record) throw new SessionNotFoundError(sessionId);
      this.ensureGenesisExecutionBoundary(record.header);
      return this.readCurrentExecutionBoundarySync(sessionId);
    });
  }

  async readSessionAuthoritySnapshot(sessionId: string): Promise<SessionAuthoritySnapshot> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const record = this.readRecordSync(sessionId);
      if (!record) throw new SessionNotFoundError(sessionId);
      this.ensureGenesisExecutionBoundary(record.header);
      return {
        record,
        boundary: this.readCurrentExecutionBoundarySync(sessionId),
      };
    });
  }

  async createSandboxBoundaryRequest(
    input: CreateSandboxBoundaryRequest,
  ): Promise<SandboxBoundaryRequest> {
    this.assertOpen();
    assertSafeSessionId(input.sessionId);
    assertSafeBoundaryRequestId(input.requestId);
    assertSandboxBoundaryProvenanceId(input.turnId, 'turn id');
    if (input.runId !== undefined) assertSandboxBoundaryProvenanceId(input.runId, 'run id');
    const validated = validateSandboxBoundaryExpansion(input.expansion);
    if (!validated.ok) throw new Error(validated.message);
    const justification = input.justification.trim();
    if (!justification || justification.length > 2_000) {
      throw new Error('Sandbox boundary request justification must contain 1 to 2000 characters');
    }

    return this.transaction(() => {
      const record = this.readRecordSync(input.sessionId);
      if (!record) throw new SessionNotFoundError(input.sessionId);
      this.ensureGenesisExecutionBoundary(record.header);

      const existing = this.readSandboxBoundaryRequestSync(input.sessionId, input.requestId);
      if (existing) {
        if (
          !isDeepStrictEqual(existing.expansion, validated.expansion) ||
          existing.justification !== justification ||
          existing.turnId !== input.turnId ||
          existing.runId !== input.runId
        ) {
          throw new SessionMetadataConflictError(
            `Sandbox boundary request identity was reused with different content: ${input.requestId}`,
          );
        }
        return existing;
      }

      const boundary = this.readCurrentExecutionBoundarySync(input.sessionId);
      const createdAt = this.now();
      this.db
        .prepare(`
          INSERT INTO sandbox_boundary_log(
            session_id,
            entry_id,
            entry_kind,
            request_id,
            status,
            base_revision,
            expansion_json,
            justification,
            created_at,
            turn_id,
            run_id
          ) VALUES (?, ?, 'expansion_request', ?, 'pending', ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.sessionId,
          `request:${input.requestId}`,
          input.requestId,
          boundary.revision,
          JSON.stringify(validated.expansion),
          justification,
          createdAt,
          input.turnId,
          input.runId ?? null,
        );
      this.options.failpoint?.('after_sandbox_boundary_write');
      return this.requireSandboxBoundaryRequestSync(input.sessionId, input.requestId);
    });
  }

  async listPendingSandboxBoundaryRequests(sessionId: string): Promise<SandboxBoundaryRequest[]> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const record = this.readRecordSync(sessionId);
      if (!record) throw new SessionNotFoundError(sessionId);
      this.ensureGenesisExecutionBoundary(record.header);
      const rows = this.db
        .prepare(`
          SELECT ${SANDBOX_BOUNDARY_REQUEST_COLUMNS}
          FROM sandbox_boundary_log
          WHERE session_id = ? AND status = 'pending'
          ORDER BY created_at, entry_id
        `)
        .all(sessionId) as unknown as SandboxBoundaryRequestRow[];
      return rows.map(decodeSandboxBoundaryRequestRow);
    });
  }

  /**
   * Every request this session closed because the host restarted, settled or
   * not consumed. Recovery re-reads this instead of remembering what it just
   * denied: a recovery pass interrupted between the settlement and the run's
   * terminal commit must still find the closure on its next attempt, and the
   * pending query cannot serve that because the row is no longer pending.
   */
  async listSandboxBoundaryRestartClosures(sessionId: string): Promise<SandboxBoundaryRequest[]> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const record = this.readRecordSync(sessionId);
      if (!record) throw new SessionNotFoundError(sessionId);
      const rows = this.db
        .prepare(`
          SELECT ${SANDBOX_BOUNDARY_REQUEST_COLUMNS}
          FROM sandbox_boundary_log
          WHERE session_id = ?
            AND entry_kind = 'expansion_request'
            AND status = 'denied'
            AND outcome_reason = ?
          ORDER BY created_at, entry_id
        `)
        .all(
          sessionId,
          SANDBOX_BOUNDARY_HOST_RESTART_CLOSURE_REASON,
        ) as unknown as SandboxBoundaryRequestRow[];
      return rows.map(decodeSandboxBoundaryRequestRow);
    });
  }

  async settleSandboxBoundaryRequest(
    input: SettleSandboxBoundaryRequest,
  ): Promise<SandboxBoundarySettlement> {
    this.assertOpen();
    assertSafeSessionId(input.sessionId);
    assertSafeBoundaryRequestId(input.requestId);
    if (input.decision !== 'allow' && input.decision !== 'deny') {
      throw new Error('Invalid sandbox boundary decision');
    }

    return this.transaction(() => {
      const record = this.readRecordSync(input.sessionId);
      if (!record) throw new SessionNotFoundError(input.sessionId);
      this.ensureGenesisExecutionBoundary(record.header);
      const request = this.requireSandboxBoundaryRequestSync(input.sessionId, input.requestId);
      const current = this.readCurrentExecutionBoundarySync(input.sessionId);
      if (request.status !== 'pending') {
        return { request, boundary: current, changed: false };
      }

      const settledAt = this.now();
      if (input.decision === 'deny') {
        this.settleSandboxBoundaryRequestRow({
          sessionId: input.sessionId,
          requestId: input.requestId,
          status: 'denied',
          ...(input.closureReason ? { outcomeReason: input.closureReason } : {}),
          settledAt,
        });
        return {
          request: this.requireSandboxBoundaryRequestSync(input.sessionId, input.requestId),
          boundary: current,
          changed: false,
        };
      }

      if (current.kind !== 'managed') {
        this.settleSandboxBoundaryRequestRow({
          sessionId: input.sessionId,
          requestId: input.requestId,
          status: 'conflict',
          outcomeReason: 'boundary_kind_changed',
          settledAt,
        });
        return {
          request: this.requireSandboxBoundaryRequestSync(input.sessionId, input.requestId),
          boundary: current,
          changed: false,
        };
      }

      const assessment = assessSandboxBoundaryExpansion(current.profile, request.expansion, {
        root: record.header.cwd,
        workspaceRoots: [record.header.cwd],
        tmpdir: tmpdir(),
        slashTmp: '/tmp',
      });
      if (assessment.outcome === 'conflict') {
        this.settleSandboxBoundaryRequestRow({
          sessionId: input.sessionId,
          requestId: input.requestId,
          status: 'conflict',
          outcomeReason: assessment.reason,
          settledAt,
        });
        return {
          request: this.requireSandboxBoundaryRequestSync(input.sessionId, input.requestId),
          boundary: current,
          changed: false,
        };
      }
      if (assessment.outcome === 'noop') {
        this.settleSandboxBoundaryRequestRow({
          sessionId: input.sessionId,
          requestId: input.requestId,
          status: 'approved',
          outcomeReason: 'already_applied',
          settledAt,
        });
        return {
          request: this.requireSandboxBoundaryRequestSync(input.sessionId, input.requestId),
          boundary: current,
          changed: false,
        };
      }

      const boundary: ExecutionBoundary = {
        kind: 'managed',
        profile: assessment.profile,
        revision: current.revision + 1,
      };
      assertExecutionBoundaryCapacity(boundary);
      this.settleSandboxBoundaryRequestRow({
        sessionId: input.sessionId,
        requestId: input.requestId,
        status: 'approved',
        appliedRevision: boundary.revision,
        boundary,
        settledAt,
      });
      return {
        request: this.requireSandboxBoundaryRequestSync(input.sessionId, input.requestId),
        boundary,
        changed: true,
      };
    });
  }

  async setExecutionBoundaryKind(
    sessionId: string,
    kind: 'managed' | 'bypass',
    projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
  ): Promise<ExecutionBoundary> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const record = this.readRecordSync(sessionId);
      if (!record) throw new SessionNotFoundError(sessionId);
      this.ensureGenesisExecutionBoundary(record.header);
      const current = this.readCurrentExecutionBoundarySync(sessionId);
      if (current.kind === 'external') {
        throw new SessionMetadataConflictError(
          'An externally isolated session cannot enter Auto or Bypass',
        );
      }
      const projectedMode =
        projection?.permissionMode ??
        (kind === 'bypass'
          ? 'bypass'
          : record.header.permissionMode === 'bypass'
            ? 'ask'
            : record.header.permissionMode);
      if ((projectedMode === 'bypass') !== (kind === 'bypass')) {
        throw new Error('Execution boundary kind and legacy permission mode disagree');
      }

      let boundary: ExecutionBoundary = current;
      const nextManagedProfile =
        kind === 'managed'
          ? projectedMode === 'explore'
            ? requireManagedProfile(createGenesisExecutionBoundary('explore'))
            : current.kind === 'managed' && !isCanonicalReadOnlySandboxProfile(current.profile)
              ? current.profile
              : this.readLatestAutoSandboxProfileSync(sessionId)
          : undefined;
      const boundaryChanged =
        current.kind !== kind ||
        (kind === 'managed' &&
          current.kind === 'managed' &&
          !isDeepStrictEqual(current.profile, nextManagedProfile));
      if (boundaryChanged) {
        const revision = current.revision + 1;
        boundary =
          kind === 'bypass'
            ? { kind: 'bypass', revision }
            : {
                kind: 'managed',
                profile: nextManagedProfile!,
                revision,
              };
        const committedAt = this.now();
        this.db
          .prepare(`
            INSERT INTO sandbox_boundary_log(
              session_id,
              entry_id,
              entry_kind,
              status,
              applied_revision,
              boundary_json,
              created_at,
              settled_at
            ) VALUES (?, ?, 'user_change', 'applied', ?, ?, ?, ?)
          `)
          .run(
            sessionId,
            `change:${revision}`,
            revision,
            JSON.stringify(boundary),
            committedAt,
            committedAt,
          );
        this.options.failpoint?.('after_sandbox_boundary_write');
      }

      const projectedLabels = projection?.labels ? [...projection.labels] : record.header.labels;
      if (
        record.header.permissionMode !== projectedMode ||
        !isDeepStrictEqual(record.header.labels, projectedLabels)
      ) {
        this.updateHeaderSync(sessionId, {
          permissionMode: projectedMode,
          labels: projectedLabels,
        });
      }
      return boundary;
    });
  }

  async create(
    header: SessionHeader,
    initialBoundary?: ExecutionBoundary,
  ): Promise<SessionMetadataRecord> {
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
      return this.insertHeader(normalized, 1, this.now(), initialBoundary);
    });
  }

  async createSubagent(
    header: SessionHeader,
    initialBoundary?: ExecutionBoundary,
  ): Promise<IdempotentSubagentSessionMetadataResult> {
    this.assertOpen();
    const normalized = normalizeSessionHeader(header);
    assertSafeSessionId(normalized.id);
    if (normalized.subagentParent?.graph) {
      throw new Error('Graph operator metadata requires atomic topology provisioning');
    }
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
        return {
          record: this.insertHeader(normalized, 1, committedAt, initialBoundary),
          created: true,
        };
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

  async createAgentGraphOperator(
    header: SessionHeader,
    request: AgentGraphOperatorProvisionRequest,
    expectedRevision: number,
    initialBoundary?: ExecutionBoundary,
  ): Promise<IdempotentAgentGraphOperatorMetadataResult> {
    this.assertOpen();
    const normalized = normalizeSessionHeader(header);
    assertSafeSessionId(normalized.id);
    assertAgentGraphOperatorProvisionRequest(request);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Agent graph schedule expected revision must be a non-negative safe integer');
    }
    const identity = requireSubagentSpawnIdentity(normalized);
    if (
      !identity.parent.graph ||
      identity.parent.graph.graphId !== request.graphId ||
      identity.parent.graph.workId !== request.workId ||
      identity.parent.graph.operatorId !== request.operatorId ||
      normalized.subagentRuntime?.agentId !== request.agentId ||
      identity.spawn.initialTurnId !== request.initialTurnId ||
      identity.spawn.initialRunId !== request.initialRunId
    ) {
      throw new Error('Graph operator Session metadata does not match its provision request');
    }
    return this.transaction(() => {
      const existing = this.readAgentGraphOperatorProvisionSync(request.graphId, request.workId);
      if (existing) return this.matchAgentGraphOperatorProvision(existing, request);
      const currentRevision = this.currentAgentGraphScheduleRevision(request.graphId);
      if (currentRevision !== expectedRevision) {
        throw new AgentGraphScheduleRevisionConflictError(
          request.graphId,
          expectedRevision,
          currentRevision,
        );
      }
      if (this.hasClosedAgentGraphSchedule(request.graphId)) {
        throw new AgentGraphScheduleClosedError(request.graphId);
      }
      if (this.hasTombstone(normalized.id)) {
        throw new SessionMetadataConflictError(
          `Session metadata id is tombstoned: ${normalized.id}`,
        );
      }
      if (this.readRecordSync(normalized.id)) {
        throw new SessionMetadataConflictError(`Session metadata already exists: ${normalized.id}`);
      }
      const provisionedAt = this.now();
      const claim = this.tryClaimSubagentSpawn(normalized, provisionedAt);
      if (!claim.created) {
        throw new SessionMetadataConflictError(
          'Graph operator spawn identity exists without its topology provision',
        );
      }
      const record = this.insertHeader(normalized, 1, provisionedAt, initialBoundary);
      const provision: AgentGraphOperatorProvision = {
        ...request,
        edges: request.edges.map((edge) => ({ ...edge })),
        targetSessionId: normalized.id,
        provisionedAt,
      };
      this.db
        .prepare(`
          INSERT INTO agent_graph_operator_provisions(
            graph_id,
            work_id,
            provision_id,
            schema_version,
            provision_fingerprint,
            agent_id,
            operator_id,
            target_session_id,
            payload_json,
            provisioned_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          provision.graphId,
          provision.workId,
          provision.provisionId,
          provision.schemaVersion,
          provision.provisionFingerprint,
          provision.agentId,
          provision.operatorId,
          provision.targetSessionId,
          JSON.stringify(provision),
          provision.provisionedAt,
        );
      this.options.failpoint?.('after_agent_graph_operator_provision_write');
      return {
        record,
        provision: decodeAgentGraphOperatorProvision(provision),
        created: true,
      };
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
    return this.transaction(() => this.claimAgentGraphIntentSync(request));
  }

  async claimAgentGraphIntentAtScheduleRevision(
    request: AgentGraphIntentClaimRequest,
    expectedRevision: number,
  ): Promise<AgentGraphIntentClaimResult> {
    this.assertOpen();
    assertAgentGraphIntentClaimRequest(request);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Agent graph schedule expected revision must be a non-negative safe integer');
    }
    return this.transaction(() => {
      const currentRevision = this.currentAgentGraphScheduleRevision(request.graphId);
      if (currentRevision !== expectedRevision) {
        throw new AgentGraphScheduleRevisionConflictError(
          request.graphId,
          expectedRevision,
          currentRevision,
        );
      }
      const existing = this.readAgentGraphIntentClaimSync(request.graphId, request.intentId);
      if (!existing && this.hasClosedAgentGraphSchedule(request.graphId)) {
        throw new AgentGraphScheduleClosedError(request.graphId);
      }
      return this.claimAgentGraphIntentSync(request);
    });
  }

  async beginAgentGraphIntentExecutionAtScheduleRevision(
    graphId: string,
    intentId: string,
    expectedRevision: number,
  ): Promise<AgentGraphIntentAdmissionTransition> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    assertGraphIntentId(intentId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Agent graph schedule expected revision must be a non-negative safe integer');
    }
    return this.transaction(() => {
      const currentRevision = this.currentAgentGraphScheduleRevision(graphId);
      if (currentRevision !== expectedRevision) {
        throw new AgentGraphScheduleRevisionConflictError(
          graphId,
          expectedRevision,
          currentRevision,
        );
      }
      const previousState = this.readAgentGraphIntentAdmissionStateSync(graphId, intentId);
      if (previousState !== 'claimed') {
        return { state: previousState, previousState, changed: false };
      }
      const changed = this.db
        .prepare(`
          UPDATE agent_graph_intent_claims
          SET admission_status = 'executing',
              admission_updated_at = ?
          WHERE graph_id = ?
            AND intent_id = ?
            AND admission_status = 'claimed'
        `)
        .run(this.now(), graphId, intentId).changes;
      if (changed !== 1) {
        throw new AgentGraphIntentClaimConflictError(
          'Agent graph intent execution admission changed concurrently',
        );
      }
      return { state: 'executing', previousState, changed: true };
    });
  }

  async cancelAgentGraphIntentExecution(
    graphId: string,
    intentId: string,
    reason: string,
  ): Promise<AgentGraphIntentAdmissionTransition> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    assertGraphIntentId(intentId);
    if (!reason.trim() || reason.length > 4_000) {
      throw new Error('Agent graph intent cancellation reason must be non-empty and bounded');
    }
    return this.transaction(() => {
      const previousState = this.readAgentGraphIntentAdmissionStateSync(graphId, intentId);
      if (previousState === 'cancelled') {
        return { state: 'cancelled', previousState, changed: false };
      }
      const changed = this.db
        .prepare(`
          UPDATE agent_graph_intent_claims
          SET admission_status = 'cancelled',
              admission_updated_at = ?,
              cancellation_reason = ?
          WHERE graph_id = ?
            AND intent_id = ?
            AND admission_status = ?
        `)
        .run(this.now(), reason, graphId, intentId, previousState).changes;
      if (changed !== 1) {
        throw new AgentGraphIntentClaimConflictError(
          'Agent graph intent cancellation admission changed concurrently',
        );
      }
      return { state: 'cancelled', previousState, changed: true };
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

  async claimAgentGraphSupervisorWake(
    request: ClaimAgentGraphSupervisorWakeRequest,
  ): Promise<{ wake: AgentGraphSupervisorWakeRecord; created: boolean }> {
    this.assertOpen();
    assertAgentGraphSupervisorWakeClaim(request);
    return this.transaction(() => {
      const existing = this.readAgentGraphSupervisorWakeSync(request.graphId, request.wakeId);
      if (existing) {
        if (
          existing.snapshotVersion !== request.snapshotVersion ||
          existing.rootSessionId !== request.rootSessionId
        ) {
          throw new SessionMetadataConflictError(
            'Agent graph supervisor wake identity was reused for another snapshot',
          );
        }
        return { wake: existing, created: false };
      }
      const now = this.now();
      this.db
        .prepare(`
          INSERT INTO agent_graph_supervisor_wakes(
            graph_id,
            wake_id,
            schema_version,
            snapshot_version,
            root_session_id,
            status,
            attempt_count,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
        `)
        .run(
          request.graphId,
          request.wakeId,
          request.schemaVersion,
          request.snapshotVersion,
          request.rootSessionId,
          now,
          now,
        );
      return {
        wake: this.requireAgentGraphSupervisorWakeSync(request.graphId, request.wakeId),
        created: true,
      };
    });
  }

  async beginAgentGraphSupervisorWakeAttempt(
    request: BeginAgentGraphSupervisorWakeAttemptRequest,
  ): Promise<{
    wake: AgentGraphSupervisorWakeRecord;
    attempt?: AgentGraphSupervisorWakeAttemptRecord;
    acquired: boolean;
  }> {
    this.assertOpen();
    assertAgentGraphSupervisorWakeAttempt(request);
    return this.transaction(() => {
      const wake = this.requireAgentGraphSupervisorWakeSync(request.graphId, request.wakeId);
      if (
        wake.status === 'delivered' ||
        wake.status === 'running' ||
        wake.status === 'waiting_permission'
      ) {
        return { wake, acquired: false };
      }
      const now = this.now();
      const updated = this.db
        .prepare(`
          UPDATE agent_graph_supervisor_wakes
          SET status = 'running',
              attempt_count = attempt_count + 1,
              current_attempt_id = ?,
              current_turn_id = ?,
              failure_reason = NULL,
              updated_at = ?
          WHERE graph_id = ?
            AND wake_id = ?
            AND status IN ('pending', 'retryable_failed')
        `)
        .run(request.attemptId, request.turnId, now, request.graphId, request.wakeId);
      if (updated.changes !== 1) {
        return {
          wake: this.requireAgentGraphSupervisorWakeSync(request.graphId, request.wakeId),
          acquired: false,
        };
      }
      this.db
        .prepare(`
          INSERT INTO agent_graph_supervisor_wake_attempts(
            graph_id,
            wake_id,
            attempt_id,
            turn_id,
            status,
            started_at
          ) VALUES (?, ?, ?, ?, 'running', ?)
        `)
        .run(request.graphId, request.wakeId, request.attemptId, request.turnId, now);
      return {
        wake: this.requireAgentGraphSupervisorWakeSync(request.graphId, request.wakeId),
        attempt: this.requireAgentGraphSupervisorWakeAttemptSync(
          request.graphId,
          request.wakeId,
          request.attemptId,
        ),
        acquired: true,
      };
    });
  }

  async completeAgentGraphSupervisorWakeAttempt(
    request: CompleteAgentGraphSupervisorWakeAttemptRequest,
  ): Promise<AgentGraphSupervisorWakeRecord> {
    this.assertOpen();
    assertAgentGraphSupervisorWakeCompletion(request);
    return this.transaction(() => {
      const wake = this.requireAgentGraphSupervisorWakeSync(request.graphId, request.wakeId);
      const attempt = this.requireAgentGraphSupervisorWakeAttemptSync(
        request.graphId,
        request.wakeId,
        request.attemptId,
      );
      if (wake.currentAttemptId !== request.attemptId || attempt.status !== wake.status) {
        if (wake.status === request.status && attempt.status === request.status) return wake;
        throw new SessionMetadataConflictError(
          'Agent graph supervisor wake attempt is no longer current',
        );
      }
      if (attempt.status !== 'running' && attempt.status !== 'waiting_permission') {
        if (wake.status === request.status && attempt.status === request.status) return wake;
        throw new SessionMetadataConflictError(
          'Agent graph supervisor wake attempt is already terminal',
        );
      }
      if (attempt.status === 'waiting_permission' && request.status === 'waiting_permission') {
        return wake;
      }
      const now = this.now();
      const failureReason =
        request.status === 'retryable_failed' ? request.failureReason : undefined;
      const completedAt = request.status === 'waiting_permission' ? null : now;
      this.db
        .prepare(`
          UPDATE agent_graph_supervisor_wake_attempts
          SET status = ?, failure_reason = ?, completed_at = ?
          WHERE graph_id = ? AND wake_id = ? AND attempt_id = ? AND status = ?
        `)
        .run(
          request.status,
          failureReason ?? null,
          completedAt,
          request.graphId,
          request.wakeId,
          request.attemptId,
          attempt.status,
        );
      this.db
        .prepare(`
          UPDATE agent_graph_supervisor_wakes
          SET status = ?, failure_reason = ?, updated_at = ?
          WHERE graph_id = ? AND wake_id = ? AND current_attempt_id = ? AND status = ?
        `)
        .run(
          request.status,
          failureReason ?? null,
          now,
          request.graphId,
          request.wakeId,
          request.attemptId,
          wake.status,
        );
      return this.requireAgentGraphSupervisorWakeSync(request.graphId, request.wakeId);
    });
  }

  async readAgentGraphSupervisorWake(
    graphId: string,
    wakeId: string,
  ): Promise<AgentGraphSupervisorWakeRecord | undefined> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    assertGraphLookupIdentity(wakeId, 'supervisor wake id');
    return this.readAgentGraphSupervisorWakeSync(graphId, wakeId);
  }

  async listAgentGraphSupervisorWakeAttempts(
    graphId: string,
    wakeId: string,
  ): Promise<AgentGraphSupervisorWakeAttemptRecord[]> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    assertGraphLookupIdentity(wakeId, 'supervisor wake id');
    const rows = this.db
      .prepare(`
        SELECT
          graph_id AS graphId,
          wake_id AS wakeId,
          attempt_id AS attemptId,
          turn_id AS turnId,
          status,
          failure_reason AS failureReason,
          started_at AS startedAt,
          completed_at AS completedAt
        FROM agent_graph_supervisor_wake_attempts
        WHERE graph_id = ? AND wake_id = ?
        ORDER BY started_at ASC, attempt_id ASC
      `)
      .all(graphId, wakeId) as unknown as AgentGraphSupervisorWakeAttemptRow[];
    return rows.map(decodeAgentGraphSupervisorWakeAttemptRow);
  }

  async listRetryableAgentGraphSupervisorWakes(): Promise<AgentGraphSupervisorWakeRecord[]> {
    this.assertOpen();
    const rows = this.db
      .prepare(`
        SELECT
          schema_version AS schemaVersion,
          graph_id AS graphId,
          wake_id AS wakeId,
          snapshot_version AS snapshotVersion,
          root_session_id AS rootSessionId,
          status,
          attempt_count AS attemptCount,
          current_attempt_id AS currentAttemptId,
          current_turn_id AS currentTurnId,
          failure_reason AS failureReason,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM agent_graph_supervisor_wakes
        WHERE status = 'retryable_failed'
        ORDER BY updated_at ASC, graph_id ASC, wake_id ASC
      `)
      .all() as unknown as AgentGraphSupervisorWakeRow[];
    return rows.map(decodeAgentGraphSupervisorWakeRow);
  }

  async listUnsettledAgentGraphSupervisorWakes(): Promise<AgentGraphSupervisorWakeRecord[]> {
    this.assertOpen();
    const rows = this.db
      .prepare(`
        SELECT
          schema_version AS schemaVersion,
          graph_id AS graphId,
          wake_id AS wakeId,
          snapshot_version AS snapshotVersion,
          root_session_id AS rootSessionId,
          status,
          attempt_count AS attemptCount,
          current_attempt_id AS currentAttemptId,
          current_turn_id AS currentTurnId,
          failure_reason AS failureReason,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM agent_graph_supervisor_wakes
        WHERE status IN ('running', 'waiting_permission')
        ORDER BY updated_at ASC, graph_id ASC, wake_id ASC
      `)
      .all() as unknown as AgentGraphSupervisorWakeRow[];
    return rows.map(decodeAgentGraphSupervisorWakeRow);
  }

  async recoverAgentGraphSupervisorWakes(): Promise<number> {
    this.assertOpen();
    return this.transaction(() => {
      const now = this.now();
      const recovered = this.db
        .prepare(`
          UPDATE agent_graph_supervisor_wakes
          SET status = 'retryable_failed',
              failure_reason = 'host_restart',
              updated_at = ?
          WHERE status = 'pending'
        `)
        .run(now).changes;
      return Number(recovered);
    });
  }

  async listAgentGraphOperatorProvisions(graphId: string): Promise<AgentGraphOperatorProvision[]> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    const rows = this.db
      .prepare(`
        SELECT payload_json AS payloadJson
        FROM agent_graph_operator_provisions
        WHERE graph_id = ?
        ORDER BY provisioned_at ASC, operator_id ASC
      `)
      .all(graphId) as unknown as AgentGraphOperatorProvisionRow[];
    return rows.map((row) =>
      decodeAgentGraphOperatorProvision(JSON.parse(row.payloadJson) as unknown),
    );
  }

  async readAgentGraphTimelineMetadata(
    graphId: string,
  ): Promise<AgentGraphTimelineMetadataSnapshot> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    return this.readTransaction(() => {
      const scheduleUpdates = (
        this.db
          .prepare(`
            SELECT payload_json AS payloadJson
            FROM agent_graph_schedule_updates
            WHERE graph_id = ?
            ORDER BY revision ASC
          `)
          .all(graphId) as unknown as AgentGraphScheduleUpdateRow[]
      ).map(decodeAgentGraphScheduleUpdateRow);
      const operatorProvisions = (
        this.db
          .prepare(`
            SELECT payload_json AS payloadJson
            FROM agent_graph_operator_provisions
            WHERE graph_id = ?
            ORDER BY provisioned_at ASC, operator_id ASC
          `)
          .all(graphId) as unknown as AgentGraphOperatorProvisionRow[]
      ).map((row) => decodeAgentGraphOperatorProvision(JSON.parse(row.payloadJson) as unknown));
      const intentClaims = (
        this.db
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
            WHERE graph_id = ?
            ORDER BY claimed_at ASC, intent_id ASC
          `)
          .all(graphId) as unknown as AgentGraphIntentClaim[]
      ).map(decodeAgentGraphIntentClaim);
      const intentAdmissions = (
        this.db
          .prepare(`
            SELECT
              graph_id AS graphId,
              intent_id AS intentId,
              admission_status AS state,
              admission_updated_at AS updatedAt,
              cancellation_reason AS cancellationReason
            FROM agent_graph_intent_claims
            WHERE graph_id = ?
            ORDER BY claimed_at ASC, intent_id ASC
          `)
          .all(graphId) as unknown as AgentGraphIntentAdmissionSnapshotRow[]
      ).map(decodeAgentGraphIntentAdmissionSnapshotRow);
      const wakeRows = this.db
        .prepare(`
          SELECT
            schema_version AS schemaVersion,
            graph_id AS graphId,
            wake_id AS wakeId,
            snapshot_version AS snapshotVersion,
            root_session_id AS rootSessionId,
            status,
            attempt_count AS attemptCount,
            current_attempt_id AS currentAttemptId,
            current_turn_id AS currentTurnId,
            failure_reason AS failureReason,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM agent_graph_supervisor_wakes
          WHERE graph_id = ?
          ORDER BY created_at ASC, wake_id ASC
        `)
        .all(graphId) as unknown as AgentGraphSupervisorWakeRow[];
      const attemptRows = this.db
        .prepare(`
          SELECT
            graph_id AS graphId,
            wake_id AS wakeId,
            attempt_id AS attemptId,
            turn_id AS turnId,
            status,
            failure_reason AS failureReason,
            started_at AS startedAt,
            completed_at AS completedAt
          FROM agent_graph_supervisor_wake_attempts
          WHERE graph_id = ?
          ORDER BY started_at ASC, attempt_id ASC
        `)
        .all(graphId) as unknown as AgentGraphSupervisorWakeAttemptRow[];
      const attemptsByWake = new Map<string, AgentGraphSupervisorWakeAttemptRecord[]>();
      for (const row of attemptRows) {
        const attempt = decodeAgentGraphSupervisorWakeAttemptRow(row);
        const attempts = attemptsByWake.get(attempt.wakeId) ?? [];
        attempts.push(attempt);
        attemptsByWake.set(attempt.wakeId, attempts);
      }
      const supervisorWakes = wakeRows.map((row) => {
        const wake = decodeAgentGraphSupervisorWakeRow(row);
        const attempts = attemptsByWake.get(wake.wakeId) ?? [];
        attemptsByWake.delete(wake.wakeId);
        return {
          wake,
          attempts,
        };
      });
      if (attemptsByWake.size > 0) {
        throw new Error(`Agent graph ${graphId} has orphan supervisor wake attempts`);
      }
      return {
        graphId,
        scheduleUpdates,
        operatorProvisions,
        intentClaims,
        intentAdmissions,
        supervisorWakes,
      };
    });
  }

  async commitAgentGraphClientProjection(
    request: CommitAgentGraphClientProjectionRequest,
  ): Promise<AgentGraphClientProjectionRecord> {
    this.assertOpen();
    assertAgentGraphClientProjectionRequest(request);
    return this.transaction(() => {
      const current = this.db
        .prepare(`
          SELECT
            schema_version AS schemaVersion,
            graph_id AS graphId,
            root_session_id AS rootSessionId,
            snapshot_version AS snapshotVersion,
            payload_json AS payloadJson,
            materialized_at AS materializedAt
          FROM agent_graph_client_projections
          WHERE graph_id = ?
        `)
        .get(request.graphId) as AgentGraphClientProjectionRow | undefined;
      if (
        request.expectedSnapshotVersion === null
          ? current !== undefined
          : current?.snapshotVersion !== request.expectedSnapshotVersion
      ) {
        throw new AgentGraphClientProjectionConflictError(
          `Agent graph client projection ${request.graphId} version conflict: expected ${
            request.expectedSnapshotVersion ?? 'no existing projection'
          }, found ${current?.snapshotVersion ?? 'none'}`,
        );
      }

      const readAppliedRecord = this.db.prepare(`
        SELECT event_time AS eventTime
        FROM agent_graph_client_applied_records
        WHERE graph_id = ? AND record_id = ?
      `);
      if (request.incrementalRecordId) {
        const existing = readAppliedRecord.get(request.graphId, request.incrementalRecordId) as
          | AgentGraphClientAppliedRecordRow
          | undefined;
        if (existing) {
          const requested = request.activityRecords.find(
            (record) => record.recordId === request.incrementalRecordId,
          )!;
          if (existing.eventTime !== requested.eventTime) {
            throw new SessionMetadataConflictError(
              `Agent graph activity ${requested.recordId} changed after materialization`,
            );
          }
          if (!current) {
            throw new Error('Incremental agent graph projection has no current snapshot');
          }
          return decodeAgentGraphClientProjectionRow(current);
        }
      }

      const materializedAt = this.now();
      const snapshotPayloadJson = encodeProjectionPayload(request.snapshot, 'snapshot');
      this.db
        .prepare(`
          INSERT INTO agent_graph_client_projections(
            graph_id,
            root_session_id,
            schema_version,
            snapshot_version,
            payload_json,
            materialized_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(graph_id) DO UPDATE SET
            root_session_id = excluded.root_session_id,
            schema_version = excluded.schema_version,
            snapshot_version = excluded.snapshot_version,
            payload_json = excluded.payload_json,
            materialized_at = excluded.materialized_at
        `)
        .run(
          request.graphId,
          request.rootSessionId,
          request.schemaVersion,
          request.snapshotVersion,
          snapshotPayloadJson,
          materializedAt,
        );

      const insertAppliedRecord = this.db.prepare(`
        INSERT INTO agent_graph_client_applied_records(
          graph_id,
          record_id,
          event_time
        ) VALUES (?, ?, ?)
      `);
      for (const record of request.activityRecords) {
        const existing = readAppliedRecord.get(request.graphId, record.recordId) as
          | AgentGraphClientAppliedRecordRow
          | undefined;
        if (existing) {
          if (existing.eventTime !== record.eventTime) {
            throw new SessionMetadataConflictError(
              `Agent graph activity ${record.recordId} changed after materialization`,
            );
          }
          continue;
        }
        insertAppliedRecord.run(request.graphId, record.recordId, record.eventTime);
      }

      if (request.replaceOperators) {
        this.db
          .prepare('DELETE FROM agent_graph_client_operator_projections WHERE graph_id = ?')
          .run(request.graphId);
      }
      const insertOperator = this.db.prepare(`
        INSERT INTO agent_graph_client_operator_projections(
          graph_id,
          operator_id,
          snapshot_version,
          payload_json,
          materialized_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(graph_id, operator_id) DO UPDATE SET
          snapshot_version = excluded.snapshot_version,
          payload_json = excluded.payload_json,
          materialized_at = excluded.materialized_at
      `);
      for (const operator of request.operators) {
        insertOperator.run(
          request.graphId,
          operator.operatorId,
          request.snapshotVersion,
          encodeProjectionPayload(operator.payload, 'operator'),
          materializedAt,
        );
      }

      const readTerminal = this.db.prepare(`
        SELECT event_time AS eventTime, payload_json AS payloadJson
        FROM agent_graph_client_terminal_activity
        WHERE graph_id = ? AND record_id = ?
      `);
      const insertTerminal = this.db.prepare(`
        INSERT INTO agent_graph_client_terminal_activity(
          graph_id,
          record_id,
          event_time,
          payload_json
        ) VALUES (?, ?, ?, ?)
      `);
      for (const terminal of request.terminalActivities) {
        const payloadJson = encodeProjectionPayload(terminal.payload, 'terminal activity');
        const existing = readTerminal.get(request.graphId, terminal.recordId) as
          | AgentGraphClientTerminalActivityRow
          | undefined;
        if (existing) {
          if (existing.eventTime !== terminal.eventTime || existing.payloadJson !== payloadJson) {
            throw new SessionMetadataConflictError(
              `Agent graph terminal activity ${terminal.recordId} changed after materialization`,
            );
          }
          continue;
        }
        insertTerminal.run(request.graphId, terminal.recordId, terminal.eventTime, payloadJson);
      }

      return {
        schemaVersion: request.schemaVersion,
        graphId: request.graphId,
        rootSessionId: request.rootSessionId,
        snapshotVersion: request.snapshotVersion,
        payload: structuredClone(request.snapshot),
        materializedAt,
      };
    });
  }

  async readAgentGraphClientProjection(
    graphId: string,
  ): Promise<AgentGraphClientProjectionRecord | undefined> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    const row = this.db
      .prepare(`
        SELECT
          schema_version AS schemaVersion,
          graph_id AS graphId,
          root_session_id AS rootSessionId,
          snapshot_version AS snapshotVersion,
          payload_json AS payloadJson,
          materialized_at AS materializedAt
        FROM agent_graph_client_projections
        WHERE graph_id = ?
      `)
      .get(graphId) as AgentGraphClientProjectionRow | undefined;
    return row ? decodeAgentGraphClientProjectionRow(row) : undefined;
  }

  async readAgentGraphClientOperatorProjection(
    graphId: string,
    operatorId: string,
  ): Promise<AgentGraphClientOperatorProjectionRecord | undefined> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    assertGraphLookupIdentity(operatorId, 'operator id');
    const row = this.db
      .prepare(`
        SELECT
          graph_id AS graphId,
          operator_id AS operatorId,
          snapshot_version AS snapshotVersion,
          payload_json AS payloadJson,
          materialized_at AS materializedAt
        FROM agent_graph_client_operator_projections
        WHERE graph_id = ? AND operator_id = ?
      `)
      .get(graphId, operatorId) as AgentGraphClientOperatorProjectionRow | undefined;
    return row ? decodeAgentGraphClientOperatorProjectionRow(row) : undefined;
  }

  async readAgentGraphClientProjectionWithOperator(
    graphId: string,
    operatorId: string,
  ): Promise<AgentGraphClientProjectionWithOperator | undefined> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    assertGraphLookupIdentity(operatorId, 'operator id');
    const row = this.db
      .prepare(`
        SELECT
          graph.schema_version AS projectionSchemaVersion,
          graph.graph_id AS projectionGraphId,
          graph.root_session_id AS projectionRootSessionId,
          graph.snapshot_version AS projectionSnapshotVersion,
          graph.payload_json AS projectionPayloadJson,
          graph.materialized_at AS projectionMaterializedAt,
          operator.graph_id AS operatorGraphId,
          operator.operator_id AS operatorId,
          operator.snapshot_version AS operatorSnapshotVersion,
          operator.payload_json AS operatorPayloadJson,
          operator.materialized_at AS operatorMaterializedAt
        FROM agent_graph_client_projections AS graph
        LEFT JOIN agent_graph_client_operator_projections AS operator
          ON operator.graph_id = graph.graph_id
          AND operator.operator_id = ?
        WHERE graph.graph_id = ?
      `)
      .get(operatorId, graphId) as AgentGraphClientProjectionWithOperatorRow | undefined;
    if (!row) return undefined;
    const projection = decodeAgentGraphClientProjectionRow({
      schemaVersion: row.projectionSchemaVersion,
      graphId: row.projectionGraphId,
      rootSessionId: row.projectionRootSessionId,
      snapshotVersion: row.projectionSnapshotVersion,
      payloadJson: row.projectionPayloadJson,
      materializedAt: row.projectionMaterializedAt,
    });
    if (row.operatorGraphId === null) return { projection };
    return {
      projection,
      operator: decodeAgentGraphClientOperatorProjectionRow({
        graphId: row.operatorGraphId,
        operatorId: row.operatorId!,
        snapshotVersion: row.operatorSnapshotVersion!,
        payloadJson: row.operatorPayloadJson!,
        materializedAt: row.operatorMaterializedAt!,
      }),
    };
  }

  async listAgentGraphClientTerminalActivities(
    graphId: string,
    input: {
      limit: number;
      before?: { eventTime: number; recordId: string };
    },
  ): Promise<AgentGraphClientTerminalActivityPage> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
      throw new Error('Agent graph terminal activity limit must be between 1 and 256');
    }
    if (input.before) {
      assertGraphEventTime(input.before.eventTime);
      assertGraphLookupIdentity(input.before.recordId, 'terminal record id');
      const cursor = this.db
        .prepare(`
          SELECT event_time AS eventTime
          FROM agent_graph_client_terminal_activity
          WHERE graph_id = ? AND record_id = ?
        `)
        .get(graphId, input.before.recordId) as { eventTime?: unknown } | undefined;
      if (cursor?.eventTime !== input.before.eventTime) {
        throw new Error('Agent graph terminal activity cursor is stale or invalid');
      }
    }
    const rows = this.db
      .prepare(`
        SELECT
          graph_id AS graphId,
          record_id AS recordId,
          event_time AS eventTime,
          payload_json AS payloadJson
        FROM agent_graph_client_terminal_activity
        WHERE graph_id = ?
          ${
            input.before
              ? `AND (
                  event_time < ?
                  OR (event_time = ? AND record_id < ?)
                )`
              : ''
          }
        ORDER BY event_time DESC, record_id DESC
        LIMIT ?
      `)
      .all(
        graphId,
        ...(input.before
          ? [input.before.eventTime, input.before.eventTime, input.before.recordId]
          : []),
        input.limit + 1,
      ) as unknown as AgentGraphClientTerminalActivityRowWithIdentity[];
    return {
      records: rows.slice(0, input.limit).map((row) => ({
        graphId: row.graphId,
        recordId: row.recordId,
        eventTime: row.eventTime,
        payload: JSON.parse(row.payloadJson) as unknown,
      })),
      hasMore: rows.length > input.limit,
    };
  }

  async listAgentGraphClientClaimAdmissions(
    graphId: string,
  ): Promise<AgentGraphClientClaimAdmission[]> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    const rows = this.db
      .prepare(`
        SELECT
          intent_id AS intentId,
          admission_status AS state
        FROM agent_graph_intent_claims
        WHERE graph_id = ?
        ORDER BY claimed_at ASC, intent_id ASC
      `)
      .all(graphId) as unknown as AgentGraphClientClaimAdmission[];
    return rows.map((row) => {
      if (row.state !== 'claimed' && row.state !== 'executing' && row.state !== 'cancelled') {
        throw new Error(`Invalid agent graph admission state for ${row.intentId}`);
      }
      return { intentId: row.intentId, state: row.state };
    });
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
    if (Object.prototype.hasOwnProperty.call(patch, 'subagentWorkspace')) {
      throw new Error('Subagent session workspace binding is immutable');
    }
    return this.transaction(() => this.updateHeaderSync(sessionId, patch, options));
  }

  async remove(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      const graphOwner = this.db
        .prepare(`
          SELECT graph_id AS graphId, work_id AS workId
          FROM agent_graph_operator_provisions
          WHERE target_session_id = ?
        `)
        .get(sessionId) as { graphId: string; workId: string } | undefined;
      if (graphOwner) {
        throw new SessionMetadataConflictError(
          `Cannot remove graph operator Session ${sessionId}; owned by ${graphOwner.graphId}/${graphOwner.workId}`,
        );
      }
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
      return {
        header,
        ...(entry.initialBoundary
          ? {
              initialBoundary: {
                ...decodeExecutionBoundary(entry.initialBoundary),
                revision: 0,
              },
            }
          : {}),
        source: entry.source,
      };
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
          if (
            entry.initialBoundary &&
            !isDeepStrictEqual(
              this.readCurrentExecutionBoundarySync(entry.header.id),
              entry.initialBoundary,
            )
          ) {
            throw new SessionMetadataConflictError(
              `Session execution boundary import conflict for ${entry.header.id}`,
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
          this.insertHeader(entry.header, 1, this.now(), entry.initialBoundary);
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
    initialBoundary?: ExecutionBoundary,
  ): SessionMetadataRecord {
    const inserted = this.tryInsertHeader(
      header,
      metadataVersion,
      committedAt,
      false,
      initialBoundary,
    );
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
    initialBoundary?: ExecutionBoundary,
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
    this.ensureGenesisExecutionBoundary(header, initialBoundary);
    return { header, metadataVersion, committedAt };
  }

  private ensureGenesisExecutionBoundary(
    header: SessionHeader,
    initialBoundary?: ExecutionBoundary,
  ): void {
    const existing = this.db
      .prepare(
        `SELECT 1 AS found FROM sandbox_boundary_log WHERE session_id = ? AND applied_revision = 0`,
      )
      .get(header.id);
    if (existing) return;

    const boundary = initialBoundary
      ? { ...decodeExecutionBoundary(initialBoundary), revision: 0 }
      : createGenesisExecutionBoundary(header.permissionMode);
    this.db
      .prepare(`
        INSERT INTO sandbox_boundary_log(
          session_id,
          entry_id,
          entry_kind,
          status,
          applied_revision,
          boundary_json,
          created_at,
          settled_at
        ) VALUES (?, 'genesis', 'genesis', 'applied', 0, ?, ?, ?)
      `)
      .run(header.id, JSON.stringify(boundary), header.createdAt, header.createdAt);
    this.options.failpoint?.('after_sandbox_boundary_write');
  }

  private readCurrentExecutionBoundarySync(sessionId: string): ExecutionBoundary {
    const row = this.db
      .prepare(`
        SELECT boundary_json AS boundaryJson
        FROM sandbox_boundary_log
        WHERE session_id = ? AND applied_revision IS NOT NULL
        ORDER BY applied_revision DESC
        LIMIT 1
      `)
      .get(sessionId) as { boundaryJson?: unknown } | undefined;
    if (!row || typeof row.boundaryJson !== 'string') {
      throw new SessionMetadataConflictError(`Session execution boundary is missing: ${sessionId}`);
    }
    return decodeExecutionBoundary(JSON.parse(row.boundaryJson) as unknown);
  }

  private readLatestAutoSandboxProfileSync(
    sessionId: string,
  ): Extract<ExecutionBoundary, { kind: 'managed' }>['profile'] {
    const rows = this.db
      .prepare(`
        SELECT boundary_json AS boundaryJson
        FROM sandbox_boundary_log
        WHERE
          session_id = ?
          AND applied_revision IS NOT NULL
          AND json_extract(boundary_json, '$.kind') = 'managed'
        ORDER BY applied_revision DESC
      `)
      .all(sessionId) as unknown as Array<{ boundaryJson?: unknown }>;
    for (const row of rows) {
      if (typeof row.boundaryJson !== 'string') {
        throw new SessionMetadataConflictError(
          `Managed sandbox boundary history is invalid: ${sessionId}`,
        );
      }
      const boundary = decodeExecutionBoundary(JSON.parse(row.boundaryJson) as unknown);
      if (boundary.kind !== 'managed') {
        throw new SessionMetadataConflictError(
          `Managed sandbox boundary history is invalid: ${sessionId}`,
        );
      }
      if (!isCanonicalReadOnlySandboxProfile(boundary.profile)) return boundary.profile;
    }
    return requireManagedProfile(createGenesisExecutionBoundary('ask'));
  }

  private readSandboxBoundaryRequestSync(
    sessionId: string,
    requestId: string,
  ): SandboxBoundaryRequest | undefined {
    const row = this.db
      .prepare(`
        SELECT ${SANDBOX_BOUNDARY_REQUEST_COLUMNS}
        FROM sandbox_boundary_log
        WHERE session_id = ? AND request_id = ?
      `)
      .get(sessionId, requestId) as SandboxBoundaryRequestRow | undefined;
    return row ? decodeSandboxBoundaryRequestRow(row) : undefined;
  }

  private requireSandboxBoundaryRequestSync(
    sessionId: string,
    requestId: string,
  ): SandboxBoundaryRequest {
    const request = this.readSandboxBoundaryRequestSync(sessionId, requestId);
    if (!request) {
      throw new SessionMetadataConflictError(
        `Sandbox boundary request was not found: ${requestId}`,
      );
    }
    return request;
  }

  private settleSandboxBoundaryRequestRow(input: {
    sessionId: string;
    requestId: string;
    status: 'approved' | 'denied' | 'conflict';
    settledAt: number;
    appliedRevision?: number;
    boundary?: ExecutionBoundary;
    outcomeReason?: string;
  }): void {
    const result = this.db
      .prepare(`
        UPDATE sandbox_boundary_log
        SET
          status = ?,
          applied_revision = ?,
          boundary_json = ?,
          outcome_reason = ?,
          settled_at = ?
        WHERE session_id = ? AND request_id = ? AND status = 'pending'
      `)
      .run(
        input.status,
        input.appliedRevision ?? null,
        input.boundary ? JSON.stringify(input.boundary) : null,
        input.outcomeReason ?? null,
        input.settledAt,
        input.sessionId,
        input.requestId,
      );
    if (result.changes !== 1) {
      throw new SessionMetadataConflictError(
        `Sandbox boundary request was already settled: ${input.requestId}`,
      );
    }
    this.options.failpoint?.('after_sandbox_boundary_write');
  }

  private updateHeaderSync(
    sessionId: string,
    patch: Partial<SessionHeader>,
    options: { expectedVersion?: number } = {},
  ): SessionMetadataRecord {
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
        subagentSpawnScope(identity.parent).scopeId,
        subagentSpawnScope(identity.parent).itemId,
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
        subagentSpawnScope(parent).scopeId,
        subagentSpawnScope(parent).itemId,
      ) as SubagentSpawnClaim | undefined;
  }

  private readAgentGraphOperatorProvisionSync(
    graphId: string,
    workId: string,
  ): AgentGraphOperatorProvision | undefined {
    const row = this.db
      .prepare(`
        SELECT payload_json AS payloadJson
        FROM agent_graph_operator_provisions
        WHERE graph_id = ? AND work_id = ?
      `)
      .get(graphId, workId) as AgentGraphOperatorProvisionRow | undefined;
    return row
      ? decodeAgentGraphOperatorProvision(JSON.parse(row.payloadJson) as unknown)
      : undefined;
  }

  private matchAgentGraphOperatorProvision(
    existing: AgentGraphOperatorProvision,
    request: AgentGraphOperatorProvisionRequest,
  ): IdempotentAgentGraphOperatorMetadataResult {
    if (existing.provisionFingerprint !== request.provisionFingerprint) {
      throw new SessionMetadataConflictError(
        'Graph operator provision identity was reused for different work',
      );
    }
    const record = this.readRecordSync(existing.targetSessionId);
    if (!record) {
      throw new SessionMetadataConflictError(
        `Graph operator provision belongs to deleted session: ${existing.targetSessionId}`,
      );
    }
    if (
      record.header.subagentParent?.graph?.graphId !== existing.graphId ||
      record.header.subagentParent.graph.workId !== existing.workId ||
      record.header.subagentParent.graph.operatorId !== existing.operatorId
    ) {
      throw new SessionMetadataConflictError(
        'Graph operator provision disagrees with live session metadata',
      );
    }
    this.assertMatchingSubagentSpawnClaim(record.header);
    return {
      record,
      provision: decodeAgentGraphOperatorProvision(existing),
      created: false,
    };
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

  private readAgentGraphIntentAdmissionStateSync(
    graphId: string,
    intentId: string,
  ): AgentGraphIntentAdmissionState {
    const row = this.db
      .prepare(`
        SELECT admission_status AS admissionState
        FROM agent_graph_intent_claims
        WHERE graph_id = ? AND intent_id = ?
      `)
      .get(graphId, intentId) as { admissionState?: unknown } | undefined;
    if (
      row?.admissionState !== 'claimed' &&
      row?.admissionState !== 'executing' &&
      row?.admissionState !== 'cancelled'
    ) {
      throw new AgentGraphIntentClaimConflictError(
        `Agent graph intent ${graphId}/${intentId} has no durable admission`,
      );
    }
    return row.admissionState;
  }

  private claimAgentGraphIntentSync(
    request: AgentGraphIntentClaimRequest,
  ): AgentGraphIntentClaimResult {
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
          claimed_at,
          admission_status,
          admission_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)
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
    return this.currentAgentGraphScheduleRevision(graphId) + 1;
  }

  private currentAgentGraphScheduleRevision(graphId: string): number {
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
    return revision;
  }

  private readAgentGraphSupervisorWakeSync(
    graphId: string,
    wakeId: string,
  ): AgentGraphSupervisorWakeRecord | undefined {
    const row = this.db
      .prepare(`
        SELECT
          schema_version AS schemaVersion,
          graph_id AS graphId,
          wake_id AS wakeId,
          snapshot_version AS snapshotVersion,
          root_session_id AS rootSessionId,
          status,
          attempt_count AS attemptCount,
          current_attempt_id AS currentAttemptId,
          current_turn_id AS currentTurnId,
          failure_reason AS failureReason,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM agent_graph_supervisor_wakes
        WHERE graph_id = ? AND wake_id = ?
      `)
      .get(graphId, wakeId) as AgentGraphSupervisorWakeRow | undefined;
    return row ? decodeAgentGraphSupervisorWakeRow(row) : undefined;
  }

  private requireAgentGraphSupervisorWakeSync(
    graphId: string,
    wakeId: string,
  ): AgentGraphSupervisorWakeRecord {
    const wake = this.readAgentGraphSupervisorWakeSync(graphId, wakeId);
    if (!wake) {
      throw new SessionMetadataConflictError(
        `Agent graph supervisor wake ${graphId}/${wakeId} was not claimed`,
      );
    }
    return wake;
  }

  private requireAgentGraphSupervisorWakeAttemptSync(
    graphId: string,
    wakeId: string,
    attemptId: string,
  ): AgentGraphSupervisorWakeAttemptRecord {
    const row = this.db
      .prepare(`
        SELECT
          graph_id AS graphId,
          wake_id AS wakeId,
          attempt_id AS attemptId,
          turn_id AS turnId,
          status,
          failure_reason AS failureReason,
          started_at AS startedAt,
          completed_at AS completedAt
        FROM agent_graph_supervisor_wake_attempts
        WHERE graph_id = ? AND wake_id = ? AND attempt_id = ?
      `)
      .get(graphId, wakeId, attemptId) as AgentGraphSupervisorWakeAttemptRow | undefined;
    if (!row) {
      throw new SessionMetadataConflictError(
        `Agent graph supervisor wake attempt ${attemptId} was not found`,
      );
    }
    return decodeAgentGraphSupervisorWakeAttemptRow(row);
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

  private readTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN');
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

const SANDBOX_BOUNDARY_REQUEST_COLUMNS = `
  session_id AS sessionId,
  request_id AS requestId,
  status,
  base_revision AS baseRevision,
  applied_revision AS appliedRevision,
  expansion_json AS expansionJson,
  justification,
  outcome_reason AS outcomeReason,
  created_at AS createdAt,
  settled_at AS settledAt,
  turn_id AS turnId,
  run_id AS runId
`;

interface SandboxBoundaryRequestRow {
  sessionId: string;
  requestId: string;
  status: string;
  baseRevision: number;
  appliedRevision: number | null;
  expansionJson: string;
  justification: string;
  outcomeReason: string | null;
  createdAt: number;
  settledAt: number | null;
  turnId: string | null;
  runId: string | null;
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

interface AgentGraphOperatorProvisionRow {
  payloadJson: string;
}

interface AgentGraphIntentAdmissionSnapshotRow {
  graphId: string;
  intentId: string;
  state: string;
  updatedAt: number;
  cancellationReason: string | null;
}

interface AgentGraphClientProjectionRow {
  schemaVersion: number;
  graphId: string;
  rootSessionId: string;
  snapshotVersion: string;
  payloadJson: string;
  materializedAt: number;
}

interface AgentGraphClientOperatorProjectionRow {
  graphId: string;
  operatorId: string;
  snapshotVersion: string;
  payloadJson: string;
  materializedAt: number;
}

interface AgentGraphClientProjectionWithOperatorRow {
  projectionSchemaVersion: number;
  projectionGraphId: string;
  projectionRootSessionId: string;
  projectionSnapshotVersion: string;
  projectionPayloadJson: string;
  projectionMaterializedAt: number;
  operatorGraphId: string | null;
  operatorId: string | null;
  operatorSnapshotVersion: string | null;
  operatorPayloadJson: string | null;
  operatorMaterializedAt: number | null;
}

interface AgentGraphClientTerminalActivityRow {
  eventTime: number;
  payloadJson: string;
}

interface AgentGraphClientAppliedRecordRow {
  eventTime: number;
}

interface AgentGraphSupervisorWakeRow {
  schemaVersion: number;
  graphId: string;
  wakeId: string;
  snapshotVersion: string;
  rootSessionId: string;
  status: string;
  attemptCount: number;
  currentAttemptId: string | null;
  currentTurnId: string | null;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

interface AgentGraphSupervisorWakeAttemptRow {
  graphId: string;
  wakeId: string;
  attemptId: string;
  turnId: string;
  status: string;
  failureReason: string | null;
  startedAt: number;
  completedAt: number | null;
}

interface AgentGraphClientTerminalActivityRowWithIdentity
  extends AgentGraphClientTerminalActivityRow {
  graphId: string;
  recordId: string;
}

function decodeAgentGraphIntentAdmissionSnapshotRow(
  row: AgentGraphIntentAdmissionSnapshotRow,
): AgentGraphIntentAdmissionSnapshot {
  assertGraphLookupIdentity(row.graphId, 'graph id');
  assertGraphIntentId(row.intentId);
  if (row.state !== 'claimed' && row.state !== 'executing' && row.state !== 'cancelled') {
    throw new Error(`Invalid agent graph admission state for ${row.intentId}`);
  }
  if (!Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0) {
    throw new Error(`Invalid agent graph admission timestamp for ${row.intentId}`);
  }
  return {
    graphId: row.graphId,
    intentId: row.intentId,
    state: row.state,
    updatedAt: row.updatedAt,
    ...(row.cancellationReason ? { cancellationReason: row.cancellationReason } : {}),
  };
}

function decodeAgentGraphScheduleUpdateRow(
  row: AgentGraphScheduleUpdateRow,
): AgentGraphScheduleUpdate {
  return decodeAgentGraphScheduleUpdate(JSON.parse(row.payloadJson) as unknown);
}

function decodeAgentGraphSupervisorWakeRow(
  row: AgentGraphSupervisorWakeRow,
): AgentGraphSupervisorWakeRecord {
  if (
    row.schemaVersion !== AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION ||
    !['pending', 'running', 'waiting_permission', 'delivered', 'retryable_failed'].includes(
      row.status,
    ) ||
    !Number.isSafeInteger(row.attemptCount) ||
    row.attemptCount < 0 ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0 ||
    !Number.isSafeInteger(row.updatedAt) ||
    row.updatedAt < 0
  ) {
    throw new Error(`Invalid agent graph supervisor wake ${row.graphId}/${row.wakeId}`);
  }
  assertGraphLookupIdentity(row.graphId, 'graph id');
  assertGraphLookupIdentity(row.wakeId, 'supervisor wake id');
  assertGraphLookupIdentity(row.snapshotVersion, 'snapshot version');
  assertSafeSessionId(row.rootSessionId);
  return {
    schemaVersion: row.schemaVersion,
    graphId: row.graphId,
    wakeId: row.wakeId,
    snapshotVersion: row.snapshotVersion,
    rootSessionId: row.rootSessionId,
    status: row.status as AgentGraphSupervisorWakeRecord['status'],
    attemptCount: row.attemptCount,
    ...(row.currentAttemptId ? { currentAttemptId: row.currentAttemptId } : {}),
    ...(row.currentTurnId ? { currentTurnId: row.currentTurnId } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function decodeAgentGraphSupervisorWakeAttemptRow(
  row: AgentGraphSupervisorWakeAttemptRow,
): AgentGraphSupervisorWakeAttemptRecord {
  if (
    !['running', 'waiting_permission', 'delivered', 'retryable_failed'].includes(row.status) ||
    !Number.isSafeInteger(row.startedAt) ||
    row.startedAt < 0 ||
    (row.completedAt !== null && (!Number.isSafeInteger(row.completedAt) || row.completedAt < 0))
  ) {
    throw new Error(`Invalid agent graph supervisor wake attempt ${row.attemptId}`);
  }
  assertGraphLookupIdentity(row.graphId, 'graph id');
  assertGraphLookupIdentity(row.wakeId, 'supervisor wake id');
  assertGraphLookupIdentity(row.attemptId, 'supervisor wake attempt id');
  assertGraphLookupIdentity(row.turnId, 'supervisor wake turn id');
  return {
    graphId: row.graphId,
    wakeId: row.wakeId,
    attemptId: row.attemptId,
    turnId: row.turnId,
    status: row.status as AgentGraphSupervisorWakeAttemptRecord['status'],
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    startedAt: row.startedAt,
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
  };
}

function subagentSpawnScope(parent: SubagentSessionParent): {
  scopeId: string;
  itemId: string;
} {
  if (parent.graph) {
    return {
      scopeId: `graph:${parent.graph.graphId}`,
      itemId: parent.graph.workId,
    };
  }
  return {
    scopeId: parent.swarm?.swarmId ?? '',
    itemId: parent.swarm?.itemId ?? '',
  };
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

function decodeSandboxBoundaryRequestRow(row: SandboxBoundaryRequestRow): SandboxBoundaryRequest {
  const validated = validateSandboxBoundaryExpansion(JSON.parse(row.expansionJson) as unknown);
  if (
    !validated.ok ||
    !['pending', 'approved', 'denied', 'conflict'].includes(row.status) ||
    !Number.isSafeInteger(row.baseRevision) ||
    row.baseRevision < 0 ||
    (row.appliedRevision !== null &&
      (!Number.isSafeInteger(row.appliedRevision) || row.appliedRevision < 0)) ||
    !row.justification ||
    row.justification.length > 2_000 ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0 ||
    (row.settledAt !== null && (!Number.isSafeInteger(row.settledAt) || row.settledAt < 0))
  ) {
    throw new Error(`Invalid sandbox boundary request ${row.requestId}`);
  }
  assertSafeSessionId(row.sessionId);
  assertSafeBoundaryRequestId(row.requestId);
  // Rows written before provenance existed read back as null. They are long
  // settled, so an absent turn simply means "not attributable" rather than a
  // corrupt row worth rejecting.
  if (row.turnId !== null) assertSandboxBoundaryProvenanceId(row.turnId, 'turn id');
  if (row.runId !== null) assertSandboxBoundaryProvenanceId(row.runId, 'run id');
  return {
    sessionId: row.sessionId,
    requestId: row.requestId,
    status: row.status as SandboxBoundaryRequest['status'],
    baseRevision: row.baseRevision,
    expansion: validated.expansion,
    justification: row.justification,
    createdAt: row.createdAt,
    ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
    ...(row.appliedRevision === null ? {} : { appliedRevision: row.appliedRevision }),
    ...(row.outcomeReason === null ? {} : { outcomeReason: row.outcomeReason }),
    ...(row.turnId === null ? {} : { turnId: row.turnId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
  };
}

function booleanInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function requireManagedProfile(
  boundary: ExecutionBoundary,
): Extract<ExecutionBoundary, { kind: 'managed' }>['profile'] {
  if (boundary.kind !== 'managed') throw new Error('Expected a managed execution boundary');
  return boundary.profile;
}

function isCanonicalReadOnlySandboxProfile(
  profile: Extract<ExecutionBoundary, { kind: 'managed' }>['profile'],
): boolean {
  const { name: _profileName, ...profilePolicy } = profile;
  const { name: _canonicalName, ...canonicalPolicy } = requireManagedProfile(
    createGenesisExecutionBoundary('explore'),
  );
  return isDeepStrictEqual(profilePolicy, canonicalPolicy);
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

function assertSafeBoundaryRequestId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Invalid sandbox boundary request id');
  }
}

function assertSandboxBoundaryProvenanceId(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid sandbox boundary ${name}`);
  }
}

function assertAgentGraphSupervisorWakeClaim(request: ClaimAgentGraphSupervisorWakeRequest): void {
  if (request.schemaVersion !== AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION) {
    throw new Error('Invalid agent graph supervisor wake schema');
  }
  assertGraphLookupIdentity(request.graphId, 'graph id');
  assertGraphLookupIdentity(request.wakeId, 'supervisor wake id');
  assertGraphLookupIdentity(request.snapshotVersion, 'snapshot version');
  assertSafeSessionId(request.rootSessionId);
}

function assertAgentGraphSupervisorWakeAttempt(
  request: BeginAgentGraphSupervisorWakeAttemptRequest,
): void {
  assertGraphLookupIdentity(request.graphId, 'graph id');
  assertGraphLookupIdentity(request.wakeId, 'supervisor wake id');
  assertGraphLookupIdentity(request.attemptId, 'supervisor wake attempt id');
  assertGraphLookupIdentity(request.turnId, 'supervisor wake turn id');
}

function assertAgentGraphSupervisorWakeCompletion(
  request: CompleteAgentGraphSupervisorWakeAttemptRequest,
): void {
  assertGraphLookupIdentity(request.graphId, 'graph id');
  assertGraphLookupIdentity(request.wakeId, 'supervisor wake id');
  assertGraphLookupIdentity(request.attemptId, 'supervisor wake attempt id');
  if (
    request.status !== 'waiting_permission' &&
    request.status !== 'delivered' &&
    request.status !== 'retryable_failed'
  ) {
    throw new Error('Invalid agent graph supervisor wake completion status');
  }
  if (
    request.status === 'retryable_failed' &&
    (!request.failureReason?.trim() || request.failureReason.length > 4_000)
  ) {
    throw new Error('Agent graph supervisor wake failure reason must be non-empty and bounded');
  }
}

function assertAgentGraphClientProjectionRequest(
  request: CommitAgentGraphClientProjectionRequest,
): void {
  if (
    request.schemaVersion !== AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION ||
    (request.expectedSnapshotVersion !== null &&
      typeof request.expectedSnapshotVersion !== 'string') ||
    typeof request.replaceOperators !== 'boolean' ||
    !Array.isArray(request.operators) ||
    !Array.isArray(request.terminalActivities) ||
    !Array.isArray(request.activityRecords)
  ) {
    throw new Error('Invalid agent graph client projection request');
  }
  assertGraphLookupIdentity(request.graphId, 'graph id');
  assertSafeSessionId(request.rootSessionId);
  if (request.expectedSnapshotVersion !== null) {
    assertGraphLookupIdentity(request.expectedSnapshotVersion, 'expected snapshot version');
  }
  assertGraphLookupIdentity(request.snapshotVersion, 'snapshot version');
  const operatorIds = new Set<string>();
  for (const operator of request.operators) {
    assertGraphLookupIdentity(operator.operatorId, 'operator id');
    if (operatorIds.has(operator.operatorId)) {
      throw new Error(`Duplicate agent graph client operator ${operator.operatorId}`);
    }
    operatorIds.add(operator.operatorId);
  }
  const terminalIds = new Set<string>();
  for (const terminal of request.terminalActivities) {
    assertGraphLookupIdentity(terminal.recordId, 'terminal record id');
    assertGraphEventTime(terminal.eventTime);
    if (terminalIds.has(terminal.recordId)) {
      throw new Error(`Duplicate agent graph terminal activity ${terminal.recordId}`);
    }
    terminalIds.add(terminal.recordId);
  }
  const activityIds = new Set<string>();
  for (const record of request.activityRecords) {
    assertGraphLookupIdentity(record.recordId, 'activity record id');
    assertGraphEventTime(record.eventTime);
    if (activityIds.has(record.recordId)) {
      throw new Error(`Duplicate agent graph activity ${record.recordId}`);
    }
    activityIds.add(record.recordId);
  }
  if (request.incrementalRecordId !== undefined) {
    assertGraphLookupIdentity(request.incrementalRecordId, 'incremental record id');
    if (request.expectedSnapshotVersion === null || !activityIds.has(request.incrementalRecordId)) {
      throw new Error('Invalid incremental agent graph projection record');
    }
  }
}

function encodeProjectionPayload(payload: unknown, name: string): string {
  const encoded = JSON.stringify(payload);
  if (encoded === undefined) {
    throw new Error(`Invalid agent graph ${name} payload`);
  }
  return encoded;
}

function decodeAgentGraphClientProjectionRow(
  row: AgentGraphClientProjectionRow,
): AgentGraphClientProjectionRecord {
  if (
    row.schemaVersion !== AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION ||
    !Number.isSafeInteger(row.materializedAt) ||
    row.materializedAt < 0
  ) {
    throw new Error(`Invalid agent graph client projection for ${row.graphId}`);
  }
  assertGraphLookupIdentity(row.graphId, 'graph id');
  assertSafeSessionId(row.rootSessionId);
  assertGraphLookupIdentity(row.snapshotVersion, 'snapshot version');
  return {
    schemaVersion: row.schemaVersion,
    graphId: row.graphId,
    rootSessionId: row.rootSessionId,
    snapshotVersion: row.snapshotVersion,
    payload: JSON.parse(row.payloadJson) as unknown,
    materializedAt: row.materializedAt,
  };
}

function decodeAgentGraphClientOperatorProjectionRow(
  row: AgentGraphClientOperatorProjectionRow,
): AgentGraphClientOperatorProjectionRecord {
  if (!Number.isSafeInteger(row.materializedAt) || row.materializedAt < 0) {
    throw new Error(`Invalid agent graph operator projection for ${row.operatorId}`);
  }
  assertGraphLookupIdentity(row.graphId, 'graph id');
  assertGraphLookupIdentity(row.operatorId, 'operator id');
  assertGraphLookupIdentity(row.snapshotVersion, 'snapshot version');
  return {
    graphId: row.graphId,
    operatorId: row.operatorId,
    snapshotVersion: row.snapshotVersion,
    payload: JSON.parse(row.payloadJson) as unknown,
    materializedAt: row.materializedAt,
  };
}

function assertGraphEventTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid agent graph terminal activity event time');
  }
}

function assertGraphIntentId(value: string): void {
  if (!/^graph_intent_[a-f0-9]{32}$/.test(value)) {
    throw new Error('Invalid agent graph intent id');
  }
}
