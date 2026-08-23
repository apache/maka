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

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION,
  AgentGraphClientProjectionConflictError,
  AgentGraphClientTerminalCursorError,
  type AgentGraphClientClaimAdmission,
  type AgentGraphClientProjectionRecord,
  type AgentGraphClientProjectionWithOperator,
  type AgentGraphClientOperatorProjectionRecord,
  type AgentGraphClientTerminalActivityPage,
  type CommitAgentGraphClientProjectionRequest,
} from '@maka/core/agent-graph-client-projection';
import {
  assessSandboxBoundaryExpansion,
  assertExecutionBoundaryCapacity,
  decodeExecutionBoundary,
  createGenesisExecutionBoundary,
  SANDBOX_BOUNDARY_CLOSURE_REASONS,
  SANDBOX_BOUNDARY_HOST_RESTART_CLOSURE_REASON,
  validateSandboxBoundaryExpansion,
  type CreateSandboxBoundaryRequest,
  type ExecutionBoundary,
  type SandboxBoundaryRequest,
  type SandboxBoundarySettlement,
  type SettleSandboxBoundaryRequest,
} from '@maka/core/sandbox-boundary';
import {
  AGENT_GRAPH_EPOCH_SCHEMA_VERSION,
  AgentGraphEpochConflictError,
  assertAdvanceAgentGraphEpochRequest,
  assertResolveAgentGraphEpochRequest,
  decodeAgentGraphEpochBinding,
  type AdvanceAgentGraphEpochRequest,
  type AgentGraphEpochBinding,
  type ResolveAgentGraphEpochRequest,
} from '@maka/core/agent-graph-epoch';
import {
  assertAgentGraphScheduleUpdateRequest,
  AgentGraphScheduleClosedError,
  AgentGraphScheduleRevisionConflictError,
  decodeAgentGraphScheduleUpdate,
  type AgentGraphScheduleUpdate,
  type AgentGraphScheduleUpdateRequest,
  type AgentGraphScheduleUpdateResult,
  type AgentGraphIntentAdmissionState,
  type AgentGraphIntentAdmissionTransition,
} from '@maka/core/agent-graph-schedule';
import {
  assertAgentGraphOperatorProvisionRequest,
  decodeAgentGraphOperatorProvision,
  type AgentGraphOperatorProvision,
  type AgentGraphOperatorProvisionRequest,
  type AgentGraphOperatorProvisionResult,
} from '@maka/core/agent-graph-topology';
import {
  assertAgentGraphIntentClaimRequest,
  decodeAgentGraphIntentClaim,
  type AgentGraphIntentClaim,
  type AgentGraphIntentClaimRequest,
  type AgentGraphIntentClaimResult,
} from '@maka/core/agent-graph-control';
import {
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  type SessionHeader,
  type SessionHeaderPatch,
  type StoredMessage,
  type SubagentSessionParent,
  decodeStoredMessage,
} from '@maka/core/session';
import {
  type AgentGraphIntentAdmissionSnapshot,
  type AgentGraphTimelineMetadataSnapshot,
} from '@maka/core/agent-graph-timeline';
import {
  AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
  type AgentGraphSupervisorWakeAttemptRecord,
  type AgentGraphSupervisorWakeRecord,
  type BeginAgentGraphSupervisorWakeAttemptRequest,
  type ClaimAgentGraphSupervisorWakeRequest,
  type CompleteAgentGraphSupervisorWakeAttemptRequest,
  type SupersedeAgentGraphSupervisorWakesRequest,
} from '@maka/core/agent-graph-supervisor-wake';
import { type SessionListFilter } from '@maka/core/runtime-inputs';
import {
  assertSafeSessionId,
  normalizeSessionHeader,
  SessionNotFoundError,
  type ExternalSessionImportLookupResult,
  type SessionTranscriptMessageLookupRequest,
  type SessionTranscriptPageRequest,
  type SessionTranscriptStoragePage,
  type SessionTurnContribution,
  type SessionTurnContributionPage,
  type SessionTurnLandmarkSnapshot,
} from './session-store.js';
import {
  isDiscardableConversationCopy,
  isValidConversationCopyTransition,
} from './session-conversation-copy.js';
import {
  configureSqliteSessionMetadataDatabase,
  migrateSqliteSessionMetadataDatabase,
  readSqliteSessionMetadataSchemaVersion,
  SQLITE_AGENT_GRAPH_CONTROL_TABLES,
  SQLITE_SESSION_MESSAGE_CHUNK_BYTES,
  SQLITE_SESSION_MESSAGE_CHUNK_MARKER,
} from './sqlite-session-metadata-schema.js';
import type { OperationalStateDatabaseLease } from './operational-state-store.js';
import {
  buildSqliteSessionCatalogPageQuery,
  type SqliteSessionCatalogCursor,
} from './sqlite-session-catalog-query.js';

export { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from './sqlite-session-metadata-schema.js';

const SQLITE_TRANSCRIPT_MESSAGE_LOOKUP_BATCH_SIZE = 256;
const SQLITE_TURN_CONTRIBUTION_MAX_SOURCE_MESSAGES = 1_024;
const SQLITE_TURN_CONTRIBUTION_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const SQLITE_TURN_LANDMARK_LEGACY_NEIGHBOR_MESSAGES = 32;

const require = createRequire(import.meta.url);
const AGENT_GRAPH_CONTROL_DELETE_TABLES = SQLITE_AGENT_GRAPH_CONTROL_TABLES.filter(
  (table) => table !== 'agent_graph_epochs',
).reverse();

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
  | 'after_agent_graph_intent_claim_write'
  | 'after_agent_graph_schedule_update_write'
  | 'after_agent_graph_operator_provision_write'
  | 'after_sandbox_boundary_write';

export interface SqliteSessionMetadataStoreOptions {
  now?: () => number;
  failpoint?: (point: SqliteSessionMetadataStoreFailpoint) => void;
  /** @internal Repository connection supplied by the operational DB owner. */
  databaseLease?: OperationalStateDatabaseLease;
}

export interface SessionMetadataRecord {
  header: SessionHeader;
  metadataVersion: number;
  committedAt: number;
}

export interface SessionMetadataCatalogRecord extends SessionMetadataRecord {
  readonly lastMessagePreview?: string;
}

export interface SessionCatalogRevisionState {
  readonly epoch: string;
  readonly generation: number;
}

export type SessionMetadataCatalogCursor = SqliteSessionCatalogCursor;

export interface SessionMetadataCatalogPage {
  readonly revision: SessionCatalogRevisionState;
  readonly records: readonly SessionMetadataCatalogRecord[];
  readonly hasMore: boolean;
}

export interface SessionCatalogMessageProjection {
  readonly lastMessageAt?: number;
  readonly lastMessagePreview?: string;
}

export interface SessionAuthoritySnapshot {
  record: SessionMetadataRecord;
  boundary: ExecutionBoundary;
}

export interface VersionedSessionIdentity {
  readonly sessionId: string;
  readonly expectedVersion: number;
}

export type SessionRemovalProbe =
  | { readonly kind: 'present'; readonly record: SessionMetadataRecord }
  | { readonly kind: 'removed' }
  | { readonly kind: 'absent' };

function uniqueVersionedSessionIdentities(
  sessions: readonly VersionedSessionIdentity[],
): VersionedSessionIdentity[] {
  if (sessions.length === 0) throw new Error('Session lifecycle requires at least one Session');
  const unique = new Map<string, VersionedSessionIdentity>();
  for (const identity of sessions) {
    assertSafeSessionId(identity.sessionId);
    if (!Number.isSafeInteger(identity.expectedVersion) || identity.expectedVersion < 1) {
      throw new Error(`Invalid Session metadata version: ${identity.expectedVersion}`);
    }
    const existing = unique.get(identity.sessionId);
    if (existing && existing.expectedVersion !== identity.expectedVersion) {
      throw new Error(`Conflicting Session metadata versions for ${identity.sessionId}`);
    }
    unique.set(identity.sessionId, identity);
  }
  return [...unique.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

export interface IdempotentSubagentSessionMetadataResult {
  record: SessionMetadataRecord;
  created: boolean;
}

export type StableSessionCreateProbe =
  | { readonly kind: 'absent' }
  | { readonly kind: 'existing'; readonly record: SessionMetadataRecord }
  | {
      readonly kind: 'conflict';
      readonly reason: 'identity_mismatch' | 'removed';
    };

export type StableSessionMetadataCreateResult =
  | { readonly kind: 'created'; readonly record: SessionMetadataRecord }
  | { readonly kind: 'existing'; readonly record: SessionMetadataRecord }
  | {
      readonly kind: 'conflict';
      readonly reason: 'identity_mismatch' | 'removed';
    };

export interface SessionConfigurationMetadataUpdate {
  readonly expectedVersion: number;
  readonly configuration: {
    readonly backend: SessionHeader['backend'];
    readonly llmConnectionSlug: string;
    readonly connectionLocked: boolean;
    readonly model: string;
    readonly thinkingLevel: SessionHeader['thinkingLevel'];
    readonly permissionMode: SessionHeader['permissionMode'];
    readonly collaborationMode: NonNullable<SessionHeader['collaborationMode']>;
    readonly orchestrationMode: NonNullable<SessionHeader['orchestrationMode']>;
    readonly labels: readonly string[];
  };
  readonly lifecycle:
    | { readonly kind: 'preserve' }
    | {
        readonly kind: 'clear_connection_block';
        readonly statusUpdatedAt: number;
      };
}

export interface IdempotentAgentGraphOperatorMetadataResult
  extends AgentGraphOperatorProvisionResult {
  record: SessionMetadataRecord;
}

export class SessionMetadataConflictError extends Error {
  readonly name: string = 'SessionMetadataConflictError';
}

export class StoredSessionMessageIncompatibleError extends Error {
  readonly name = 'StoredSessionMessageIncompatibleError';
  readonly code = 'stored_session_message_incompatible';

  constructor(
    readonly sessionId: string,
    readonly sequence: number,
    options?: ErrorOptions,
  ) {
    super(`Stored Session message ${sequence} for ${sessionId} is incompatible`, options);
  }
}

export class SessionMetadataVersionConflictError extends SessionMetadataConflictError {
  readonly name = 'SessionMetadataVersionConflictError';

  constructor(
    readonly sessionId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Session metadata version conflict for ${sessionId}: expected ${expectedVersion}, found ${actualVersion}`,
    );
  }
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
  private readonly databaseLease?: OperationalStateDatabaseLease;
  private readonly now: () => number;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly options: SqliteSessionMetadataStoreOptions = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    if (options.databaseLease) {
      this.databaseLease = options.databaseLease;
      this.db = options.databaseLease.database;
      this.now = options.now ?? Date.now;
      return;
    }
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
    if (this.databaseLease) this.databaseLease.close();
    else this.db.close();
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
        .prepare(
          `
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
        `,
        )
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

  async readSandboxBoundaryRequest(
    sessionId: string,
    requestId: string,
  ): Promise<SandboxBoundaryRequest | undefined> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertSafeBoundaryRequestId(requestId);
    return this.transaction(() => {
      if (!this.readRecordSync(sessionId)) throw new SessionNotFoundError(sessionId);
      return this.readSandboxBoundaryRequestSync(sessionId, requestId);
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
        .prepare(
          `
          SELECT ${SANDBOX_BOUNDARY_REQUEST_COLUMNS}
          FROM sandbox_boundary_log
          WHERE session_id = ? AND status = 'pending'
          ORDER BY created_at, entry_id
        `,
        )
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
        .prepare(
          `
          SELECT ${SANDBOX_BOUNDARY_REQUEST_COLUMNS}
          FROM sandbox_boundary_log
          WHERE session_id = ?
            AND entry_kind = 'expansion_request'
            AND status = 'denied'
            AND outcome_reason = ?
          ORDER BY created_at, entry_id
        `,
        )
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
    if (
      input.closureReason !== undefined &&
      !SANDBOX_BOUNDARY_CLOSURE_REASONS.includes(input.closureReason)
    ) {
      throw new Error('Invalid sandbox boundary closure reason');
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
    return this.transaction(
      () => this.setExecutionBoundaryKindSync(sessionId, kind, projection).boundary,
    );
  }

  async updateSessionConfiguration(
    sessionId: string,
    input: SessionConfigurationMetadataUpdate,
  ): Promise<SessionMetadataRecord> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertMetadataVersion(input.expectedVersion, 'Session configuration expected version');
    const kind = input.configuration.permissionMode === 'bypass' ? 'bypass' : 'managed';
    return this.transaction(() => {
      const current = this.readRecordSync(sessionId);
      if (!current) throw new SessionNotFoundError(sessionId);
      if (current.metadataVersion !== input.expectedVersion) {
        throw new SessionMetadataVersionConflictError(
          sessionId,
          input.expectedVersion,
          current.metadataVersion,
        );
      }
      const lifecyclePatch =
        input.lifecycle.kind === 'preserve'
          ? {}
          : clearConnectionBlock(current, input.lifecycle.statusUpdatedAt);
      return this.setExecutionBoundaryKindSync(
        sessionId,
        kind,
        {
          permissionMode: input.configuration.permissionMode,
          labels: input.configuration.labels,
        },
        {
          expectedVersion: input.expectedVersion,
          headerPatch: {
            ...input.configuration,
            labels: [...input.configuration.labels],
            ...lifecyclePatch,
          },
        },
      ).record;
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

  async probeStableSessionCreate(
    sessionId: string,
    requestFingerprint: string,
  ): Promise<StableSessionCreateProbe> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertSessionCreateFingerprint(requestFingerprint);
    return this.readTransaction(() =>
      this.probeStableSessionCreateSync(sessionId, requestFingerprint),
    );
  }

  async claimStableSessionCreate(
    sessionId: string,
    requestFingerprint: string,
  ): Promise<StableSessionCreateProbe> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertSessionCreateFingerprint(requestFingerprint);
    return this.transaction(() => {
      const probe = this.probeStableSessionCreateSync(sessionId, requestFingerprint);
      if (probe.kind !== 'absent') return probe;
      this.db
        .prepare(
          `
          INSERT OR IGNORE INTO session_create_claims(
            session_id,
            request_fingerprint,
            claimed_at
          ) VALUES (?, ?, ?)
        `,
        )
        .run(sessionId, requestFingerprint, this.now());
      return this.probeStableSessionCreateSync(sessionId, requestFingerprint);
    });
  }

  async hasStableSessionCreateClaim(
    sessionId: string,
    requestFingerprint: string,
  ): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertSessionCreateFingerprint(requestFingerprint);
    const row = this.db
      .prepare(
        'SELECT request_fingerprint AS requestFingerprint FROM session_create_claims WHERE session_id = ?',
      )
      .get(sessionId) as { requestFingerprint?: unknown } | undefined;
    return row?.requestFingerprint === requestFingerprint;
  }

  async createStableSession(
    header: SessionHeader,
    requestFingerprint: string,
    initialBoundary?: ExecutionBoundary,
  ): Promise<StableSessionMetadataCreateResult> {
    this.assertOpen();
    const normalized = normalizeSessionHeader(header);
    assertSafeSessionId(normalized.id);
    assertSessionCreateFingerprint(requestFingerprint);
    if (normalized.subagentSpawn) {
      throw new Error('Subagent spawn metadata requires idempotent child-session creation');
    }
    return this.transaction(() => {
      const probe = this.probeStableSessionCreateSync(normalized.id, requestFingerprint);
      if (probe.kind !== 'absent') return probe;
      const committedAt = this.now();
      this.db
        .prepare(
          `
          INSERT INTO session_create_claims(session_id, request_fingerprint, claimed_at)
          VALUES (?, ?, ?)
          ON CONFLICT(session_id) DO NOTHING
        `,
        )
        .run(normalized.id, requestFingerprint, committedAt);
      return {
        kind: 'created' as const,
        record: this.insertHeader(normalized, 1, committedAt, initialBoundary),
      };
    });
  }

  async discardStableSessionCreate(
    sessionId: string,
    requestFingerprint: string,
  ): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertSessionCreateFingerprint(requestFingerprint);
    return this.transaction(() => {
      const probe = this.probeStableSessionCreateSync(sessionId, requestFingerprint);
      if (probe.kind === 'conflict') {
        throw new SessionMetadataConflictError(
          'Stable Session identity belongs to a different request',
        );
      }
      if (probe.kind === 'existing') {
        const copy = probe.record.header.conversationCopy;
        if (
          copy?.requestFingerprint !== requestFingerprint ||
          !isDiscardableConversationCopy(probe.record.header)
        ) {
          throw new SessionMetadataConflictError(
            'Only a matching incomplete conversation copy can be discarded',
          );
        }
      }
      const deleted =
        this.db.prepare('DELETE FROM session_metadata WHERE session_id = ?').run(sessionId)
          .changes === 1;
      this.db
        .prepare(
          'DELETE FROM session_create_claims WHERE session_id = ? AND request_fingerprint = ?',
        )
        .run(sessionId, requestFingerprint);
      return deleted;
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
        .prepare(
          `
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
        `,
        )
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

  async readCatalogRecord(sessionId: string): Promise<SessionMetadataCatalogRecord> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    const row = this.db
      .prepare(
        `
        SELECT
          metadata.session_id,
          metadata.payload_json,
          metadata.metadata_version,
          metadata.committed_at,
          projection.last_message_preview
        FROM session_catalog_projection projection
        JOIN session_metadata metadata
          ON metadata.session_id = projection.session_id
        WHERE projection.session_id = ?
          AND COALESCE(
            json_extract(metadata.payload_json, '$.conversationCopy.state'),
            ''
          ) <> 'preparing'
          AND COALESCE(
            json_extract(metadata.payload_json, '$.transcriptLedgerVersion'),
            1
          ) <> 0
      `,
      )
      .get(sessionId) as SessionMetadataCatalogRow | undefined;
    if (!row) throw new SessionNotFoundError(sessionId);
    return decodeCatalogRecord(row);
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

  async probeRemoval(sessionId: string): Promise<SessionRemovalProbe> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.readTransaction(() => {
      const record = this.readRecordSync(sessionId);
      if (record) return { kind: 'present', record };
      return this.hasTombstone(sessionId) ? { kind: 'removed' } : { kind: 'absent' };
    });
  }

  async listPendingSessionRetirementCleanupIds(sessionId?: string): Promise<string[]> {
    this.assertOpen();
    if (sessionId !== undefined) assertSafeSessionId(sessionId);
    const rows =
      sessionId === undefined
        ? this.db
            .prepare(
              `
              SELECT session_id AS sessionId
              FROM session_metadata_tombstones
              WHERE cleanup_pending = 1
              ORDER BY session_id
            `,
            )
            .all()
        : this.db
            .prepare(
              `
              SELECT pending.session_id AS sessionId
              FROM session_metadata_tombstones target
              JOIN session_metadata_tombstones pending
                ON pending.retirement_unit_id = target.retirement_unit_id
              WHERE target.session_id = ?
                AND pending.cleanup_pending = 1
              ORDER BY pending.session_id
            `,
            )
            .all(sessionId);
    return (rows as unknown as Array<{ readonly sessionId: string }>).map((row) => row.sessionId);
  }

  async reconcileOrphanedAgentGraphRetirements(): Promise<string[]> {
    this.assertOpen();
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `
          SELECT
            child.session_id,
            child.payload_json,
            child.metadata_version,
            child.committed_at,
            child.subagent_parent_session_id AS parent_session_id,
            provision.graph_id,
            provision.work_id,
            provision.operator_id,
            parent_tombstone.retirement_unit_id
          FROM agent_graph_operator_provisions provision
          JOIN session_metadata child
            ON child.session_id = provision.target_session_id
          JOIN session_metadata_tombstones parent_tombstone
            ON parent_tombstone.session_id = child.subagent_parent_session_id
          LEFT JOIN session_metadata live_parent
            ON live_parent.session_id = child.subagent_parent_session_id
          WHERE live_parent.session_id IS NULL
          ORDER BY child.session_id
        `,
        )
        .all() as unknown as OrphanedAgentGraphOperatorRow[];
      const deletedAt = this.now();
      const reconciled: string[] = [];
      for (const row of rows) {
        const record = decodeRecord(row);
        const parent = record.header.subagentParent;
        if (
          !parent?.graph ||
          parent.parentSessionId !== row.parent_session_id ||
          parent.graph.graphId !== row.graph_id ||
          parent.graph.workId !== row.work_id ||
          parent.graph.operatorId !== row.operator_id ||
          !row.retirement_unit_id
        ) {
          throw new SessionMetadataConflictError(
            `Cannot reconcile invalid graph operator Session ${row.session_id}`,
          );
        }
        const deleted = this.db
          .prepare('DELETE FROM session_metadata WHERE session_id = ?')
          .run(row.session_id);
        if (deleted.changes !== 1) {
          throw new SessionMetadataConflictError(
            `Agent Graph retirement reconciliation lost Session ${row.session_id}`,
          );
        }
        this.db
          .prepare(
            `
            INSERT INTO session_metadata_tombstones(
              session_id,
              deleted_at,
              retirement_unit_id,
              cleanup_pending
            )
            VALUES (?, ?, ?, 1)
          `,
          )
          .run(row.session_id, deletedAt, row.retirement_unit_id);
        this.db
          .prepare(
            `
            UPDATE session_metadata_tombstones
            SET cleanup_pending = 1
            WHERE session_id = ?
          `,
          )
          .run(row.parent_session_id);
        reconciled.push(row.session_id);
      }
      this.db
        .prepare(
          `
          WITH graph_roots(root_session_id) AS (
            SELECT root_session_id
            FROM agent_graph_client_projections
            UNION
            SELECT source_session_id
            FROM agent_graph_schedule_updates
            UNION
            SELECT root_session_id
            FROM agent_graph_supervisor_wakes
          )
          UPDATE session_metadata_tombstones
          SET cleanup_pending = 1
          WHERE cleanup_pending = 0
            AND session_id IN (SELECT root_session_id FROM graph_roots)
            AND session_id NOT IN (SELECT session_id FROM session_metadata)
        `,
        )
        .run();
      return reconciled;
    });
  }

  async listTombstonedSessionIdsAmong(sessionIds: readonly string[]): Promise<string[]> {
    this.assertOpen();
    const unique = [...new Set(sessionIds)].sort();
    for (const sessionId of unique) assertSafeSessionId(sessionId);
    const tombstoned: string[] = [];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch = unique.slice(offset, offset + 100);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `
          SELECT session_id AS sessionId
          FROM session_metadata_tombstones
          WHERE session_id IN (${placeholders})
          ORDER BY session_id
        `,
        )
        .all(...batch) as unknown as Array<{ readonly sessionId: string }>;
      tombstoned.push(...rows.map((row) => row.sessionId));
    }
    return tombstoned.sort();
  }

  async completeSessionRetirementCleanup(sessionId: string): Promise<void> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    this.transaction(() => {
      this.db
        .prepare(
          `
          UPDATE session_metadata_tombstones
          SET cleanup_pending = 0
          WHERE session_id = ?
        `,
        )
        .run(sessionId);
    });
  }

  async list(filter: SessionListFilter = {}): Promise<SessionMetadataRecord[]> {
    this.assertOpen();
    const { where, parameters } = buildSessionListPredicate(filter);
    const rows = this.db
      .prepare(
        `
        SELECT session_id, payload_json, metadata_version, committed_at
        FROM session_metadata metadata
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY
          COALESCE(last_message_at, last_used_at, created_at) DESC,
          session_id ASC
      `,
      )
      .all(...parameters) as unknown as SessionMetadataRow[];
    return rows.map(decodeRecord);
  }

  async listCatalogPage(
    filter: SessionListFilter,
    cursor: SessionMetadataCatalogCursor | undefined,
    limit: number,
  ): Promise<SessionMetadataCatalogPage> {
    this.assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
      throw new Error('Session catalog page limit must be between 1 and 128');
    }
    if (cursor) {
      assertSafeSessionId(cursor.sessionId);
      if (!Number.isSafeInteger(cursor.activityAt) || cursor.activityAt < 0) {
        throw new Error('Session catalog cursor activity is invalid');
      }
    }
    if (filter.subagentParentSessionId !== undefined) {
      assertSafeSessionId(filter.subagentParentSessionId);
    }
    return this.readTransaction(() => {
      const query = buildSqliteSessionCatalogPageQuery(filter, cursor);
      const rows = this.db
        .prepare(query.sql)
        .all(...query.parameters, limit + 1) as unknown as SessionMetadataCatalogRow[];
      return {
        revision: this.readCatalogRevisionSync(),
        records: rows.slice(0, limit).map(decodeCatalogRecord),
        hasMore: rows.length > limit,
      };
    });
  }

  async readCatalogRevision(): Promise<SessionCatalogRevisionState> {
    this.assertOpen();
    return this.readCatalogRevisionSync();
  }

  /**
   * Import a session with its historical facts in a single SQLite
   * transaction: the header row is written with the given (historical)
   * timestamps and flags, and every message is appended in order.
   *
   * Idempotent by primary key: if the session id already exists — imported
   * by an earlier run, created by the user, or written by a concurrent
   * first-launch process — nothing is written and `'existing'` is returned.
   * Tombstoned ids are never resurrected. Concurrent first launches converge
   * on one winner for free: SQLite serializes the transaction and the loser
   * observes the winner's row, so no create claims or fingerprints are
   * needed. A failure anywhere inside the transaction (e.g. a failpoint)
   * rolls back the whole import, so a partial session can never persist.
   */
  async importSession(
    header: SessionHeader,
    messages: readonly StoredMessage[],
    projection: SessionCatalogMessageProjection,
  ): Promise<'imported' | 'existing'> {
    this.assertOpen();
    const normalized = normalizeSessionHeader(header);
    assertSafeSessionId(normalized.id);
    assertCatalogMessageProjection(projection);
    // Canonicalize every record exactly like appendMessages: round-trip
    // through JSON so the stored form matches what the recovery path reads.
    const encoded = messages.map((message) => {
      const json = JSON.stringify(message);
      const canonical = decodeStoredMessage(JSON.parse(json) as unknown);
      return { message: canonical, json };
    });
    return this.transaction(() => {
      if (this.hasTombstone(normalized.id)) return 'existing';
      const inserted = this.tryInsertHeader(normalized, 1, normalized.createdAt, true);
      if (!inserted) return 'existing';
      if (encoded.length > 0) {
        this.insertSessionMessagesSync(normalized.id, 0, encoded);
        // Align with appendMessages' connection-lock semantics: a session
        // with any user message is treated as connection-locked, even when
        // the legacy header did not record it.
        const lockConnection =
          !normalized.connectionLocked && encoded.some(({ message }) => message.type === 'user');
        this.updateCatalogProjectionSync(normalized.id, projection, false, lockConnection);
      }
      return 'imported';
    });
  }

  async lookupExternalSessionImports(
    adapterId: string,
    sourceSessionIds: readonly string[],
    recentSessionIdLimit: number,
  ): Promise<readonly ExternalSessionImportLookupResult[]> {
    this.assertOpen();
    if (sourceSessionIds.length === 0) return [];
    const placeholders = sourceSessionIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `
        SELECT external_source_session_id, session_id, import_count
        FROM (
          SELECT
            external_source_session_id,
            session_id,
            COUNT(*) OVER (
              PARTITION BY external_source_session_id
            ) AS import_count,
            ROW_NUMBER() OVER (
              PARTITION BY external_source_session_id
              ORDER BY created_at DESC, session_id
            ) AS recent_rank
          FROM session_metadata
          WHERE external_adapter_id = ?
            AND external_source_session_id IN (${placeholders})
            AND COALESCE(
              json_extract(payload_json, '$.transcriptLedgerVersion'),
              1
            ) <> 0
        )
        WHERE recent_rank <= ?
        ORDER BY external_source_session_id, recent_rank
      `,
      )
      .all(adapterId, ...sourceSessionIds, recentSessionIdLimit) as unknown as Array<{
      readonly external_source_session_id: string;
      readonly session_id: string;
      readonly import_count: number;
    }>;
    const bySource = new Map<
      string,
      { readonly livePublishedImportCount: number; readonly recentSessionIds: string[] }
    >();
    for (const row of rows) {
      const existing = bySource.get(row.external_source_session_id);
      if (existing) {
        existing.recentSessionIds.push(row.session_id);
      } else {
        bySource.set(row.external_source_session_id, {
          livePublishedImportCount: row.import_count,
          recentSessionIds: [row.session_id],
        });
      }
    }
    return sourceSessionIds.flatMap((sourceSessionId) => {
      const result = bySource.get(sourceSessionId);
      return result ? [{ sourceSessionId, ...result }] : [];
    });
  }

  /**
   * Cheap existence probe used by the legacy importer before reading a
   * transcript: an id already present in SQLite (live or tombstoned) is
   * skipped without opening or parsing its file. Read-only; safe on every
   * launch.
   */
  async hasSession(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.readTransaction(
      () => this.readRecordSync(sessionId) !== undefined || this.hasTombstone(sessionId),
    );
  }

  async appendMessages(
    sessionId: string,
    messages: readonly StoredMessage[],
    projection: SessionCatalogMessageProjection,
  ): Promise<void> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertCatalogMessageProjection(projection);
    if (messages.length === 0) return;
    const encoded = messages.map((message) => {
      const json = JSON.stringify(message);
      const canonical = decodeStoredMessage(JSON.parse(json) as unknown);
      return { message: canonical, json };
    });
    this.transaction(() => {
      const record = this.readRecordSync(sessionId);
      if (!record) throw new SessionNotFoundError(sessionId);
      const lockConnection =
        !record.header.connectionLocked && encoded.some(({ message }) => message.type === 'user');
      const row = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), -1) AS last_sequence FROM session_messages WHERE session_id = ?',
        )
        .get(sessionId) as { last_sequence?: unknown };
      if (
        typeof row.last_sequence !== 'number' ||
        !Number.isSafeInteger(row.last_sequence) ||
        row.last_sequence < -1
      ) {
        throw new Error(`Invalid Session message sequence for ${sessionId}`);
      }
      const sequence = row.last_sequence + 1;
      this.insertSessionMessagesSync(sessionId, sequence, encoded);
      this.updateCatalogProjectionSync(sessionId, projection, false, lockConnection);
    });
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.readMessagesWith(sessionId, decodeStoredMessage);
  }

  async readTranscriptPage(
    sessionId: string,
    request: SessionTranscriptPageRequest,
  ): Promise<SessionTranscriptStoragePage> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertTranscriptPageRequest(request);
    return this.readTransaction(() => {
      if (!this.readRecordSync(sessionId)) throw new SessionNotFoundError(sessionId);
      const highWaterRow = this.db
        .prepare('SELECT MAX(sequence) AS high_water FROM session_messages WHERE session_id = ?')
        .get(sessionId) as { high_water?: unknown };
      const actualHighWater = nullableStoredMessageSequence(highWaterRow.high_water, sessionId);
      const throughSequence =
        request.throughSequence === undefined ? actualHighWater : request.throughSequence;
      if (throughSequence === null) {
        return {
          throughSequence: null,
          fragments: [],
          rawBytes: 0,
          next: null,
        };
      }
      if (actualHighWater === null || throughSequence > actualHighWater) {
        throw new Error(`Session transcript watermark is ahead of durable storage: ${sessionId}`);
      }
      const position = request.position ?? (request.direction === 'older' ? throughSequence : 0);
      const comparison = request.direction === 'older' ? '<=' : '>=';
      const order = request.direction === 'older' ? 'DESC' : 'ASC';
      const rows = this.db
        .prepare(
          `
          SELECT message.sequence,
            coalesce(payload.record_bytes, length(CAST(message.record_json AS BLOB))) AS total_bytes,
            payload.record_bytes IS NOT NULL AS chunked,
            payload.sha256 AS payload_sha256
          FROM session_messages AS message
          LEFT JOIN session_message_payloads AS payload
            ON payload.session_id = message.session_id AND payload.sequence = message.sequence
          WHERE message.session_id = ?
            AND message.sequence <= ?
            AND message.sequence ${comparison} ?
          ORDER BY message.sequence ${order}
          LIMIT ?
        `,
        )
        .all(sessionId, throughSequence, position, request.maxMessages + 1) as Array<{
        sequence?: unknown;
        total_bytes?: unknown;
        chunked?: unknown;
        payload_sha256?: unknown;
      }>;
      const slices: TranscriptRecordSlice[] = [];
      let rawBytes = 0;
      let next: { position: number; byteOffset: number | null } | null = null;
      for (const row of rows) {
        if (slices.length >= request.maxMessages || rawBytes >= request.maxBytes) break;
        const sequence = requireStoredMessageSequence(row.sequence, sessionId);
        const totalBytes = requireTranscriptRecordByteLength(row.total_bytes, sessionId, sequence);
        const chunked = row.chunked === 1;
        const payloadDigest = chunked
          ? requireTranscriptPayloadDigest(row.payload_sha256, sessionId, sequence)
          : null;
        const continued = sequence === position && request.byteOffset !== undefined;
        const edge = continued
          ? request.byteOffset!
          : request.direction === 'older'
            ? totalBytes
            : 0;
        if (
          (request.direction === 'older' && (edge < 1 || edge > totalBytes)) ||
          (request.direction === 'newer' && (edge < 0 || edge >= totalBytes))
        ) {
          throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
        }
        const available = request.maxBytes - rawBytes;
        const byteOffset = request.direction === 'older' ? Math.max(0, edge - available) : edge;
        const byteLength =
          request.direction === 'older'
            ? edge - byteOffset
            : Math.min(totalBytes - edge, available);
        const complete =
          request.direction === 'older' ? byteOffset === 0 : byteOffset + byteLength === totalBytes;
        slices.push({
          sequence,
          byteOffset,
          totalBytes,
          byteLength,
          chunked,
          payloadDigest,
        });
        rawBytes += byteLength;
        if (!complete) {
          next = {
            position: sequence,
            byteOffset: request.direction === 'older' ? byteOffset : byteOffset + byteLength,
          };
          break;
        }
      }
      if (next === null && slices.length > 0 && slices.length < rows.length) {
        const sequence = slices.at(-1)!.sequence;
        next = {
          position: sequence + (request.direction === 'older' ? -1 : 1),
          byteOffset: null,
        };
      }
      const dataBySequence = readTranscriptSlices(this.db, sessionId, slices);
      const fragments = slices.map(
        ({ sequence, byteOffset, totalBytes, byteLength, payloadDigest }) => {
          const data = dataBySequence.get(sequence);
          if (!data || data.byteLength !== byteLength) {
            throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
          }
          if (byteOffset === 0 && byteLength === totalBytes) {
            validateTranscriptRecord(data, sessionId, sequence);
          }
          return { sequence, byteOffset, totalBytes, payloadDigest, data };
        },
      );
      return { throughSequence, fragments, rawBytes, next };
    });
  }

  async readTranscriptMessages(
    sessionId: string,
    request: SessionTranscriptMessageLookupRequest,
  ): Promise<StoredMessage[]> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    if (request.messageIds.some((messageId) => typeof messageId !== 'string')) {
      throw new Error('Invalid Session transcript message identity set');
    }
    if (
      request.throughSequence !== null &&
      (!Number.isSafeInteger(request.throughSequence) || request.throughSequence < 0)
    ) {
      throw new Error('Invalid Session transcript watermark');
    }
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
      throw new Error('Invalid Session transcript message byte limit');
    }
    if (!Number.isSafeInteger(request.maxMessages) || request.maxMessages < 1) {
      throw new Error('Invalid Session transcript message count limit');
    }
    const messageIds = [...new Set(request.messageIds)];
    return this.readTransaction(() => {
      if (!this.readRecordSync(sessionId)) throw new SessionNotFoundError(sessionId);
      if (messageIds.length === 0 || request.throughSequence === null) return [];

      const selected: number[] = [];
      let selectedBytes = 0;
      for (
        let offset = 0;
        offset < messageIds.length;
        offset += SQLITE_TRANSCRIPT_MESSAGE_LOOKUP_BATCH_SIZE
      ) {
        const batch = messageIds.slice(
          offset,
          offset + SQLITE_TRANSCRIPT_MESSAGE_LOOKUP_BATCH_SIZE,
        );
        const placeholders = batch.map(() => '?').join(', ');
        const remainingMessages = request.maxMessages - selected.length;
        const rows = this.db
          .prepare(
            `
              SELECT message.sequence,
                coalesce(payload.record_bytes, length(CAST(message.record_json AS BLOB)))
                  AS stored_bytes
              FROM session_messages AS message
              LEFT JOIN session_message_payloads AS payload
                ON payload.session_id = message.session_id AND payload.sequence = message.sequence
              WHERE message.session_id = ? AND message.sequence <= ?
                AND message.message_id IN (${placeholders})
              ORDER BY message.sequence ASC
              LIMIT ?
            `,
          )
          .all(sessionId, request.throughSequence, ...batch, remainingMessages + 1) as Array<{
          sequence?: unknown;
          stored_bytes?: unknown;
        }>;
        if (rows.length > remainingMessages) {
          throw new Error('Session transcript message lookup exceeds its message limit');
        }
        for (const row of rows) {
          if (
            typeof row.sequence !== 'number' ||
            !Number.isSafeInteger(row.sequence) ||
            row.sequence < 0 ||
            typeof row.stored_bytes !== 'number' ||
            !Number.isSafeInteger(row.stored_bytes) ||
            row.stored_bytes < 1
          ) {
            throw new StoredSessionMessageIncompatibleError(sessionId, -1);
          }
          selectedBytes += row.stored_bytes;
          if (selectedBytes > request.maxBytes) {
            throw new Error('Session transcript message lookup exceeds its byte limit');
          }
          selected.push(row.sequence);
        }
      }

      selected.sort((left, right) => left - right);
      const messages: StoredMessage[] = [];
      for (
        let offset = 0;
        offset < selected.length;
        offset += SQLITE_TRANSCRIPT_MESSAGE_LOOKUP_BATCH_SIZE
      ) {
        const batch = selected.slice(offset, offset + SQLITE_TRANSCRIPT_MESSAGE_LOOKUP_BATCH_SIZE);
        const placeholders = batch.map(() => '?').join(', ');
        const rows = readStoredMessageRows(this.db, sessionId, batch, placeholders);
        if (rows.length !== batch.length) {
          throw new StoredSessionMessageIncompatibleError(sessionId, -1);
        }
        for (const row of rows) {
          try {
            messages.push(decodeStoredMessage(JSON.parse(row.recordJson) as unknown));
          } catch (error) {
            throw new StoredSessionMessageIncompatibleError(sessionId, row.sequence, {
              cause: error,
            });
          }
        }
      }
      return messages;
    });
  }

  async readTranscriptHighWater(sessionId: string): Promise<number | null> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    if (!this.readRecordSync(sessionId)) throw new SessionNotFoundError(sessionId);
    const row = this.db
      .prepare('SELECT MAX(sequence) AS high_water FROM session_messages WHERE session_id = ?')
      .get(sessionId) as { high_water?: unknown };
    return nullableStoredMessageSequence(row.high_water, sessionId);
  }

  async readTurnContributions(
    sessionId: string,
    throughSequence: number | null,
    position: number,
    maxContributions: number,
  ): Promise<SessionTurnContributionPage> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    if (
      (throughSequence !== null &&
        (!Number.isSafeInteger(throughSequence) || throughSequence < 0)) ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      !Number.isSafeInteger(maxContributions) ||
      maxContributions < 1 ||
      maxContributions > 128
    ) {
      throw new Error('Invalid Session turn contribution request');
    }
    return this.readTransaction(() => {
      if (!this.readRecordSync(sessionId)) throw new SessionNotFoundError(sessionId);
      const highWaterRow = this.db
        .prepare('SELECT MAX(sequence) AS high_water FROM session_messages WHERE session_id = ?')
        .get(sessionId) as { high_water?: unknown };
      const actualHighWater = nullableStoredMessageSequence(highWaterRow.high_water, sessionId);
      const fixedThrough = throughSequence ?? actualHighWater;
      if (fixedThrough === null) {
        return { throughSequence: null, contributions: [], nextPosition: null };
      }
      if (actualHighWater === null || fixedThrough > actualHighWater) {
        throw new Error(`Session turn watermark is ahead of durable storage: ${sessionId}`);
      }
      const contributions = new Map<string, SessionTurnContribution>();
      let nextPosition: number | null = position;
      let sourceMessages = 0;
      let sourceBytes = 0;
      while (nextPosition <= fixedThrough) {
        const rows = this.db
          .prepare(
            `
            SELECT message.sequence, message.record_json, payload.record_bytes, payload.sha256
            FROM session_messages AS message
            LEFT JOIN session_message_payloads AS payload
              ON payload.session_id = message.session_id AND payload.sequence = message.sequence
            WHERE message.session_id = ?
              AND message.sequence >= ?
              AND message.sequence <= ?
            ORDER BY message.sequence ASC
            LIMIT 128
          `,
          )
          .all(sessionId, nextPosition, fixedThrough) as StoredSessionMessagePayloadRow[];
        if (rows.length === 0) {
          throw new StoredSessionMessageIncompatibleError(sessionId, nextPosition);
        }
        for (const row of rows) {
          const sequence = requireStoredMessageSequence(row.sequence, sessionId);
          const recordBytes = storedMessageRecordBytes(row, sessionId, sequence);
          if (
            sourceMessages > 0 &&
            (sourceMessages >= SQLITE_TURN_CONTRIBUTION_MAX_SOURCE_MESSAGES ||
              sourceBytes + recordBytes > SQLITE_TURN_CONTRIBUTION_MAX_SOURCE_BYTES)
          ) {
            return {
              throughSequence: fixedThrough,
              contributions: [...contributions.values()],
              nextPosition: sequence,
            };
          }
          const message = decodeStoredMessageRecordRow(this.db, sessionId, row);
          sourceMessages += 1;
          sourceBytes += recordBytes;
          if (!('turnId' in message) || typeof message.turnId !== 'string') {
            nextPosition = sequence + 1;
            continue;
          }
          const turnId = message.turnId;
          if (turnId && !contributions.has(turnId) && contributions.size >= maxContributions) {
            nextPosition = sequence;
            return {
              throughSequence: fixedThrough,
              contributions: [...contributions.values()],
              nextPosition,
            };
          }
          contributions.set(
            turnId,
            foldTurnContribution(contributions.get(turnId), turnId, sequence, message),
          );
          nextPosition = sequence + 1;
        }
      }
      return {
        throughSequence: fixedThrough,
        contributions: [...contributions.values()],
        nextPosition: null,
      };
    });
  }

  async readTurnLandmarks(
    sessionId: string,
    maxLandmarks: number,
  ): Promise<SessionTurnLandmarkSnapshot> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    if (!Number.isSafeInteger(maxLandmarks) || maxLandmarks < 1 || maxLandmarks > 64) {
      throw new Error('Invalid Session turn landmark limit');
    }
    return this.readTransaction(() => {
      if (!this.readRecordSync(sessionId)) throw new SessionNotFoundError(sessionId);
      const throughRow = this.db
        .prepare(
          `
          SELECT sequence AS through_sequence
          FROM session_messages
          WHERE session_id = ?
          ORDER BY sequence DESC
          LIMIT 1
        `,
        )
        .get(sessionId) as { through_sequence?: unknown } | undefined;
      const throughSequence = nullableStoredMessageSequence(
        throughRow?.through_sequence,
        sessionId,
      );
      if (throughSequence === null) {
        return { throughSequence: null, landmarks: [] };
      }

      const promptRows = this.db
        .prepare(
          `
          SELECT admission.admitted_at, message.sequence
          FROM core_root_turn_admissions AS admission
          JOIN session_messages AS message
            ON message.session_id = admission.session_id
            AND message.message_id = json_extract(admission.record_json, '$.userMessageId')
          LEFT JOIN session_message_payloads AS payload
            ON payload.session_id = message.session_id AND payload.sequence = message.sequence
          WHERE admission.session_id = ? AND payload.sequence IS NULL
          ORDER BY admission.admitted_at ASC, admission.turn_id ASC
          LIMIT ?
        `,
        )
        .all(sessionId, maxLandmarks + 1) as TurnLandmarkCandidateRow[];
      const selected = new Set<number>();
      if (promptRows.length <= maxLandmarks) {
        for (const row of promptRows) {
          selected.add(requireStoredMessageSequence(row.sequence, sessionId));
        }
      }

      const forward = this.db.prepare(`
        SELECT admission.admitted_at, message.sequence
        FROM core_root_turn_admissions AS admission
        JOIN session_messages AS message
          ON message.session_id = admission.session_id
          AND message.message_id = json_extract(admission.record_json, '$.userMessageId')
        LEFT JOIN session_message_payloads AS payload
          ON payload.session_id = message.session_id AND payload.sequence = message.sequence
        WHERE admission.session_id = ? AND admission.admitted_at >= ? AND payload.sequence IS NULL
        ORDER BY admission.admitted_at ASC, admission.turn_id ASC
        LIMIT 1
      `);
      const backward = this.db.prepare(`
        SELECT admission.admitted_at, message.sequence
        FROM core_root_turn_admissions AS admission
        JOIN session_messages AS message
          ON message.session_id = admission.session_id
          AND message.message_id = json_extract(admission.record_json, '$.userMessageId')
        LEFT JOIN session_message_payloads AS payload
          ON payload.session_id = message.session_id AND payload.sequence = message.sequence
        WHERE admission.session_id = ? AND admission.admitted_at < ? AND payload.sequence IS NULL
        ORDER BY admission.admitted_at DESC, admission.turn_id DESC
        LIMIT 1
      `);
      if (promptRows.length > maxLandmarks) {
        const firstAdmittedAt = requireTurnLandmarkAdmittedAt(promptRows[0]?.admitted_at);
        const lastRow = this.db
          .prepare(
            `
            SELECT admitted_at
            FROM core_root_turn_admissions
            WHERE session_id = ?
            ORDER BY admitted_at DESC, turn_id DESC
            LIMIT 1
          `,
          )
          .get(sessionId) as TurnLandmarkCandidateRow | undefined;
        const lastAdmittedAt = requireTurnLandmarkAdmittedAt(lastRow?.admitted_at);
        for (let index = 0; index < maxLandmarks; index += 1) {
          const target =
            maxLandmarks === 1
              ? lastAdmittedAt
              : firstAdmittedAt +
                Math.floor(((lastAdmittedAt - firstAdmittedAt) * index) / (maxLandmarks - 1));
          const candidates = [
            ...(forward.all(sessionId, target) as TurnLandmarkCandidateRow[]),
            ...(backward.all(sessionId, target) as TurnLandmarkCandidateRow[]),
          ];
          let nearest: TurnLandmarkCandidateRow | undefined;
          for (const candidate of candidates) {
            const admittedAt = requireTurnLandmarkAdmittedAt(candidate.admitted_at);
            if (
              nearest === undefined ||
              Math.abs(admittedAt - target) <
                Math.abs(requireTurnLandmarkAdmittedAt(nearest.admitted_at) - target)
            ) {
              nearest = candidate;
            }
          }
          if (nearest) selected.add(requireStoredMessageSequence(nearest.sequence, sessionId));
        }
      }
      const firstIndexedSequence =
        promptRows.length > 0
          ? requireStoredMessageSequence(promptRows[0]?.sequence, sessionId)
          : null;
      const legacyThrough =
        firstIndexedSequence === null ? throughSequence : firstIndexedSequence - 1;
      if (legacyThrough >= 0) {
        const firstRow = this.db
          .prepare(
            `
            SELECT sequence AS first_sequence
            FROM session_messages
            WHERE session_id = ?
            ORDER BY sequence ASC
            LIMIT 1
          `,
          )
          .get(sessionId) as { first_sequence?: unknown } | undefined;
        const firstSequence = nullableStoredMessageSequence(firstRow?.first_sequence, sessionId);
        if (firstSequence === null || firstSequence > legacyThrough) {
          throw new StoredSessionMessageIncompatibleError(sessionId, legacyThrough);
        }
        const forwardLegacy = this.db.prepare(`
          SELECT message.sequence, message.message_type, payload.sequence AS payload_sequence
          FROM session_messages AS message
          LEFT JOIN session_message_payloads AS payload
            ON payload.session_id = message.session_id AND payload.sequence = message.sequence
          WHERE message.session_id = ? AND message.sequence >= ? AND message.sequence <= ?
          ORDER BY message.sequence ASC
          LIMIT ${SQLITE_TURN_LANDMARK_LEGACY_NEIGHBOR_MESSAGES}
        `);
        const backwardLegacy = this.db.prepare(`
          SELECT message.sequence, message.message_type, payload.sequence AS payload_sequence
          FROM session_messages AS message
          LEFT JOIN session_message_payloads AS payload
            ON payload.session_id = message.session_id AND payload.sequence = message.sequence
          WHERE message.session_id = ? AND message.sequence < ? AND message.sequence >= ?
          ORDER BY message.sequence DESC
          LIMIT ${SQLITE_TURN_LANDMARK_LEGACY_NEIGHBOR_MESSAGES}
        `);
        const targetCount = Math.min(maxLandmarks, legacyThrough - firstSequence + 1);
        for (let index = 0; index < targetCount; index += 1) {
          const target =
            targetCount === 1
              ? legacyThrough
              : firstSequence +
                Math.floor(((legacyThrough - firstSequence) * index) / (targetCount - 1));
          const candidates = [
            ...(forwardLegacy.all(sessionId, target, legacyThrough) as LegacyTurnLandmarkRow[]),
            ...(backwardLegacy.all(sessionId, target, firstSequence) as LegacyTurnLandmarkRow[]),
          ];
          let nearest: number | undefined;
          for (const candidate of candidates) {
            const sequence = requireStoredMessageSequence(candidate.sequence, sessionId);
            if (candidate.message_type !== 'user' || candidate.payload_sequence !== null) continue;
            if (nearest === undefined || Math.abs(sequence - target) < Math.abs(nearest - target)) {
              nearest = sequence;
            }
          }
          if (nearest !== undefined) selected.add(nearest);
        }
      }

      const selectedSequences = [...selected].sort((left, right) => left - right);
      const sampledSequences =
        selectedSequences.length <= maxLandmarks
          ? selectedSequences
          : Array.from(
              { length: maxLandmarks },
              (_, index) =>
                selectedSequences[
                  maxLandmarks === 1
                    ? selectedSequences.length - 1
                    : Math.floor(((selectedSequences.length - 1) * index) / (maxLandmarks - 1))
                ]!,
            );
      const landmarks = readStoredMessageRows(this.db, sessionId, sampledSequences).flatMap(
        ({ sequence, recordJson }) => {
          let message: StoredMessage;
          try {
            message = decodeStoredMessage(JSON.parse(recordJson) as unknown);
          } catch (error) {
            throw new StoredSessionMessageIncompatibleError(sessionId, sequence, { cause: error });
          }
          if (message.type !== 'user') {
            throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
          }
          const label = (message.displayText ?? message.text).trim();
          return label ? [{ turnId: message.turnId, sequence, label }] : [];
        },
      );
      return { throughSequence, landmarks };
    });
  }

  async readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]> {
    return this.readMessagesWith(sessionId, decodeStoredMessage);
  }

  async readPreviewMessages(sessionId: string, limit = 10): Promise<StoredMessage[]> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
      throw new Error('Session message preview limit must be between 1 and 128');
    }
    if (!this.readRecordSync(sessionId)) throw new SessionNotFoundError(sessionId);
    const sequences = (
      this.db
        .prepare(
          `
          SELECT sequence FROM session_messages
          WHERE session_id = ? ORDER BY sequence DESC LIMIT ?
        `,
        )
        .all(sessionId, limit) as Array<{ sequence?: unknown }>
    )
      .map((row) => requireStoredMessageSequence(row.sequence, sessionId))
      .reverse();
    return readStoredMessageRows(
      this.db,
      sessionId,
      sequences,
      sequences.map(() => '?').join(', '),
    ).map((row) =>
      decodeStoredMessageRow({ sequence: row.sequence, record_json: row.recordJson }, sessionId),
    );
  }

  async beginCatalogProjectionWrite(): Promise<void> {
    this.assertOpen();
    this.transaction(() => {
      const result = this.db
        .prepare(
          `
          UPDATE session_catalog_state
          SET pending_writes = pending_writes + 1
          WHERE scope = 'catalog'
        `,
        )
        .run();
      if (result.changes !== 1) throw new Error('Session catalog revision state is unavailable');
    });
  }

  async commitCatalogProjectionWrite(
    sessionId: string,
    projection: SessionCatalogMessageProjection,
  ): Promise<void> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    assertCatalogMessageProjection(projection);
    this.transaction(() => {
      this.updateCatalogProjectionSync(sessionId, projection, false);
      this.finishCatalogProjectionWriteSync();
    });
  }

  async requireCatalogProjectionRecovery(): Promise<void> {
    await this.beginCatalogProjectionWrite();
  }

  async hasPendingCatalogProjectionWrites(): Promise<boolean> {
    this.assertOpen();
    return this.readCatalogStateSync().pendingWrites > 0;
  }

  async recoverCatalogProjections(
    projections: ReadonlyMap<string, SessionCatalogMessageProjection>,
  ): Promise<void> {
    this.assertOpen();
    for (const [sessionId, projection] of projections) {
      assertSafeSessionId(sessionId);
      assertCatalogMessageProjection(projection);
    }
    this.transaction(() => {
      for (const [sessionId, projection] of projections) {
        this.updateCatalogProjectionSync(sessionId, projection, true);
      }
      const result = this.db
        .prepare(
          `
          UPDATE session_catalog_state
          SET pending_writes = 0
          WHERE scope = 'catalog'
        `,
        )
        .run();
      if (result.changes !== 1) throw new Error('Session catalog revision state is unavailable');
    });
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
        .prepare(
          `
          UPDATE agent_graph_intent_claims
          SET admission_status = 'executing',
              admission_updated_at = ?
          WHERE graph_id = ?
            AND intent_id = ?
            AND admission_status = 'claimed'
        `,
        )
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
        .prepare(
          `
          UPDATE agent_graph_intent_claims
          SET admission_status = 'cancelled',
              admission_updated_at = ?,
              cancellation_reason = ?
          WHERE graph_id = ?
            AND intent_id = ?
            AND admission_status = ?
        `,
        )
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
      .prepare(
        `
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
      `,
      )
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
          ...(work.selectedResultInputs
            ? { selectedResultInputs: work.selectedResultInputs.map((input) => ({ ...input })) }
            : {}),
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
        .prepare(
          `
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
        `,
        )
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
      .prepare(
        `
        SELECT payload_json AS payloadJson
        FROM agent_graph_schedule_updates
        WHERE graph_id = ?
        ORDER BY revision ASC
      `,
      )
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
        .prepare(
          `
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
        `,
        )
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
        .prepare(
          `
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
        `,
        )
        .run(request.attemptId, request.turnId, now, request.graphId, request.wakeId);
      if (updated.changes !== 1) {
        return {
          wake: this.requireAgentGraphSupervisorWakeSync(request.graphId, request.wakeId),
          acquired: false,
        };
      }
      this.db
        .prepare(
          `
          INSERT INTO agent_graph_supervisor_wake_attempts(
            graph_id,
            wake_id,
            attempt_id,
            turn_id,
            status,
            started_at
          ) VALUES (?, ?, ?, ?, 'running', ?)
        `,
        )
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
        request.status === 'retryable_failed' || request.status === 'superseded'
          ? request.failureReason
          : undefined;
      const completedAt = request.status === 'waiting_permission' ? null : now;
      this.db
        .prepare(
          `
          UPDATE agent_graph_supervisor_wake_attempts
          SET status = ?, failure_reason = ?, completed_at = ?
          WHERE graph_id = ? AND wake_id = ? AND attempt_id = ? AND status = ?
        `,
        )
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
        .prepare(
          `
          UPDATE agent_graph_supervisor_wakes
          SET status = ?, failure_reason = ?, updated_at = ?
          WHERE graph_id = ? AND wake_id = ? AND current_attempt_id = ? AND status = ?
        `,
        )
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

  async supersedeAgentGraphSupervisorWakes(
    request: SupersedeAgentGraphSupervisorWakesRequest,
  ): Promise<number> {
    this.assertOpen();
    const sessionIds = [...new Set(request.rootSessionIds)];
    const graphIds = request.graphIds ? [...new Set(request.graphIds)] : undefined;
    sessionIds.forEach(assertSafeSessionId);
    graphIds?.forEach((graphId) => assertGraphLookupIdentity(graphId, 'graph id'));
    if (!request.reason.trim() || request.reason.length > 4_000) {
      throw new Error(
        'Agent graph supervisor wake supersession reason must be non-empty and bounded',
      );
    }
    if (sessionIds.length === 0 || graphIds?.length === 0) return 0;
    return this.transaction(() => {
      const now = this.now();
      const placeholders = sessionIds.map(() => '?').join(', ');
      const graphFilter = graphIds
        ? `AND wakes.graph_id IN (${graphIds.map(() => '?').join(', ')})`
        : '';
      const wakeGraphFilter = graphIds
        ? `AND graph_id IN (${graphIds.map(() => '?').join(', ')})`
        : '';
      this.db
        .prepare(
          `
          UPDATE agent_graph_supervisor_wake_attempts
          SET status = 'superseded', failure_reason = ?, completed_at = ?
          WHERE status IN ('running', 'waiting_permission')
            AND EXISTS (
              SELECT 1
              FROM agent_graph_supervisor_wakes wakes
              WHERE wakes.graph_id = agent_graph_supervisor_wake_attempts.graph_id
                AND wakes.wake_id = agent_graph_supervisor_wake_attempts.wake_id
                AND wakes.root_session_id IN (${placeholders})
                ${graphFilter}
            )
        `,
        )
        .run(request.reason, now, ...sessionIds, ...(graphIds ?? []));
      const updated = this.db
        .prepare(
          `
          UPDATE agent_graph_supervisor_wakes
          SET status = 'superseded', failure_reason = ?, updated_at = ?
          WHERE root_session_id IN (${placeholders})
            ${wakeGraphFilter}
            AND status IN ('pending', 'running', 'waiting_permission', 'retryable_failed')
        `,
        )
        .run(request.reason, now, ...sessionIds, ...(graphIds ?? []));
      return Number(updated.changes);
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
      .prepare(
        `
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
      `,
      )
      .all(graphId, wakeId) as unknown as AgentGraphSupervisorWakeAttemptRow[];
    return rows.map(decodeAgentGraphSupervisorWakeAttemptRow);
  }

  async listRetryableAgentGraphSupervisorWakes(): Promise<AgentGraphSupervisorWakeRecord[]> {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `
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
      `,
      )
      .all() as unknown as AgentGraphSupervisorWakeRow[];
    return rows.map(decodeAgentGraphSupervisorWakeRow);
  }

  async listUnsettledAgentGraphSupervisorWakes(): Promise<AgentGraphSupervisorWakeRecord[]> {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `
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
      `,
      )
      .all() as unknown as AgentGraphSupervisorWakeRow[];
    return rows.map(decodeAgentGraphSupervisorWakeRow);
  }

  async recoverAgentGraphSupervisorWakes(): Promise<number> {
    this.assertOpen();
    return this.transaction(() => {
      const now = this.now();
      const recovered = this.db
        .prepare(
          `
          UPDATE agent_graph_supervisor_wakes
          SET status = 'retryable_failed',
              failure_reason = 'host_restart',
              updated_at = ?
          WHERE status = 'pending'
        `,
        )
        .run(now).changes;
      return Number(recovered);
    });
  }

  async resolveCurrentAgentGraphEpoch(
    request: ResolveAgentGraphEpochRequest,
  ): Promise<AgentGraphEpochBinding> {
    this.assertOpen();
    assertResolveAgentGraphEpochRequest(request);
    return this.readTransaction(() => {
      const current = this.readCurrentAgentGraphEpochSync(request.rootSessionId);
      if (current) {
        const first = this.readAgentGraphEpochSync(request.rootSessionId, 1);
        if (first?.graphId !== request.legacyGraphId) {
          throw new AgentGraphEpochConflictError(
            `Agent Graph epoch 1 identity does not match for root Session ${request.rootSessionId}`,
          );
        }
        return current;
      }

      if (this.readAgentGraphEpochByGraphIdSync(request.legacyGraphId)) {
        throw new AgentGraphEpochConflictError(
          `Agent Graph epoch 1 could not be resolved for root Session ${request.rootSessionId}`,
        );
      }

      return {
        schemaVersion: AGENT_GRAPH_EPOCH_SCHEMA_VERSION,
        rootSessionId: request.rootSessionId,
        epoch: 1,
        graphId: request.legacyGraphId,
        createdAt: 0,
      };
    });
  }

  async advanceAgentGraphEpoch(
    request: AdvanceAgentGraphEpochRequest,
  ): Promise<AgentGraphEpochBinding> {
    this.assertOpen();
    assertAdvanceAgentGraphEpochRequest(request);
    return this.transaction(() => {
      const current = this.readCurrentAgentGraphEpochSync(request.rootSessionId);
      if (current?.epoch === request.expectedEpoch + 1 && current.graphId === request.nextGraphId) {
        return current;
      }
      if (!current && request.expectedEpoch === 1) {
        if (
          this.readAgentGraphEpochByGraphIdSync(request.expectedGraphId) ||
          this.readAgentGraphEpochByGraphIdSync(request.nextGraphId)
        ) {
          throw new AgentGraphEpochConflictError(
            `Agent Graph epoch could not advance for root Session ${request.rootSessionId}`,
          );
        }
        this.insertAgentGraphEpochSync({
          schemaVersion: AGENT_GRAPH_EPOCH_SCHEMA_VERSION,
          rootSessionId: request.rootSessionId,
          epoch: 1,
          graphId: request.expectedGraphId,
          createdAt: 0,
        });
        const binding: AgentGraphEpochBinding = {
          schemaVersion: AGENT_GRAPH_EPOCH_SCHEMA_VERSION,
          rootSessionId: request.rootSessionId,
          epoch: 2,
          graphId: request.nextGraphId,
          createdAt: this.now(),
        };
        this.insertAgentGraphEpochSync(binding);
        return binding;
      }
      if (
        !current ||
        current.epoch !== request.expectedEpoch ||
        current.graphId !== request.expectedGraphId
      ) {
        throw new AgentGraphEpochConflictError(
          `Agent Graph epoch changed for root Session ${request.rootSessionId}`,
        );
      }

      const binding: AgentGraphEpochBinding = {
        schemaVersion: AGENT_GRAPH_EPOCH_SCHEMA_VERSION,
        rootSessionId: request.rootSessionId,
        epoch: request.expectedEpoch + 1,
        graphId: request.nextGraphId,
        createdAt: this.now(),
      };
      if (this.readAgentGraphEpochByGraphIdSync(binding.graphId)) {
        throw new AgentGraphEpochConflictError(
          `Agent Graph epoch could not advance for root Session ${request.rootSessionId}`,
        );
      }
      this.insertAgentGraphEpochSync(binding);
      return binding;
    });
  }

  async listAgentGraphEpochs(rootSessionId: string): Promise<AgentGraphEpochBinding[]> {
    this.assertOpen();
    assertSafeSessionId(rootSessionId);
    const rows = this.db
      .prepare(
        `
        SELECT
          schema_version AS schemaVersion,
          root_session_id AS rootSessionId,
          epoch,
          graph_id AS graphId,
          created_at AS createdAt
        FROM agent_graph_epochs
        WHERE root_session_id = ?
        ORDER BY epoch ASC
      `,
      )
      .all(rootSessionId) as unknown as AgentGraphEpochRow[];
    return rows.map(decodeAgentGraphEpochBinding);
  }

  async readAgentGraphEpochByGraphId(graphId: string): Promise<AgentGraphEpochBinding | undefined> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    return this.readAgentGraphEpochByGraphIdSync(graphId);
  }

  async listAgentGraphEpochPage(request: {
    rootSessionId: string;
    beforeEpoch?: number;
    limit: number;
  }): Promise<{
    epochs: AgentGraphEpochBinding[];
    nextBeforeEpoch: number | null;
    currentEpoch: number | null;
  }> {
    this.assertOpen();
    assertSafeSessionId(request.rootSessionId);
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 128 ||
      (request.beforeEpoch !== undefined &&
        (!Number.isSafeInteger(request.beforeEpoch) || request.beforeEpoch < 1))
    ) {
      throw new Error('Invalid Agent Graph epoch page request');
    }
    return this.readTransaction(() => {
      const current = this.readCurrentAgentGraphEpochSync(request.rootSessionId);
      const rows = this.db
        .prepare(
          `
          SELECT
            schema_version AS schemaVersion,
            root_session_id AS rootSessionId,
            epoch,
            graph_id AS graphId,
            created_at AS createdAt
          FROM agent_graph_epochs
          WHERE root_session_id = ? AND epoch < ?
          ORDER BY epoch DESC
          LIMIT ?
        `,
        )
        .all(
          request.rootSessionId,
          request.beforeEpoch ?? Number.MAX_SAFE_INTEGER,
          request.limit + 1,
        ) as unknown as AgentGraphEpochRow[];
      const hasMore = rows.length > request.limit;
      const epochs = rows.slice(0, request.limit).map(decodeAgentGraphEpochBinding);
      return {
        epochs,
        nextBeforeEpoch: hasMore ? (epochs.at(-1)?.epoch ?? null) : null,
        currentEpoch: current?.epoch ?? null,
      };
    });
  }

  async purgeAgentGraphEpochs(rootSessionId: string): Promise<number> {
    this.assertOpen();
    assertSafeSessionId(rootSessionId);
    return this.transaction(() =>
      Number(
        this.db
          .prepare('DELETE FROM agent_graph_epochs WHERE root_session_id = ?')
          .run(rootSessionId).changes,
      ),
    );
  }

  async listAgentGraphOperatorProvisions(graphId: string): Promise<AgentGraphOperatorProvision[]> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    const rows = this.db
      .prepare(
        `
        SELECT payload_json AS payloadJson
        FROM agent_graph_operator_provisions
        WHERE graph_id = ?
        ORDER BY provisioned_at ASC, operator_id ASC
      `,
      )
      .all(graphId) as unknown as AgentGraphOperatorProvisionRow[];
    return rows.map((row) =>
      decodeAgentGraphOperatorProvision(JSON.parse(row.payloadJson) as unknown),
    );
  }

  async purgeAgentGraphControlState(graphId: string): Promise<number> {
    this.assertOpen();
    assertGraphLookupIdentity(graphId, 'graph id');
    return this.transaction(() =>
      AGENT_GRAPH_CONTROL_DELETE_TABLES.reduce(
        (removed, table) =>
          removed +
          Number(this.db.prepare(`DELETE FROM ${table} WHERE graph_id = ?`).run(graphId).changes),
        0,
      ),
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
          .prepare(
            `
            SELECT payload_json AS payloadJson
            FROM agent_graph_schedule_updates
            WHERE graph_id = ?
            ORDER BY revision ASC
          `,
          )
          .all(graphId) as unknown as AgentGraphScheduleUpdateRow[]
      ).map(decodeAgentGraphScheduleUpdateRow);
      const operatorProvisions = (
        this.db
          .prepare(
            `
            SELECT payload_json AS payloadJson
            FROM agent_graph_operator_provisions
            WHERE graph_id = ?
            ORDER BY provisioned_at ASC, operator_id ASC
          `,
          )
          .all(graphId) as unknown as AgentGraphOperatorProvisionRow[]
      ).map((row) => decodeAgentGraphOperatorProvision(JSON.parse(row.payloadJson) as unknown));
      const intentClaims = (
        this.db
          .prepare(
            `
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
          `,
          )
          .all(graphId) as unknown as AgentGraphIntentClaim[]
      ).map(decodeAgentGraphIntentClaim);
      const intentAdmissions = (
        this.db
          .prepare(
            `
            SELECT
              graph_id AS graphId,
              intent_id AS intentId,
              admission_status AS state,
              admission_updated_at AS updatedAt,
              cancellation_reason AS cancellationReason
            FROM agent_graph_intent_claims
            WHERE graph_id = ?
            ORDER BY claimed_at ASC, intent_id ASC
          `,
          )
          .all(graphId) as unknown as AgentGraphIntentAdmissionSnapshotRow[]
      ).map(decodeAgentGraphIntentAdmissionSnapshotRow);
      const wakeRows = this.db
        .prepare(
          `
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
        `,
        )
        .all(graphId) as unknown as AgentGraphSupervisorWakeRow[];
      const attemptRows = this.db
        .prepare(
          `
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
        `,
        )
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
      if (!this.readRecordSync(request.rootSessionId)) {
        throw new SessionNotFoundError(request.rootSessionId);
      }
      const current = this.db
        .prepare(
          `
          SELECT
            schema_version AS schemaVersion,
            graph_id AS graphId,
            root_session_id AS rootSessionId,
            snapshot_version AS snapshotVersion,
            payload_json AS payloadJson,
            materialized_at AS materializedAt
          FROM agent_graph_client_projections
          WHERE graph_id = ?
        `,
        )
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
        .prepare(
          `
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
        `,
        )
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
      .prepare(
        `
        SELECT
          schema_version AS schemaVersion,
          graph_id AS graphId,
          root_session_id AS rootSessionId,
          snapshot_version AS snapshotVersion,
          payload_json AS payloadJson,
          materialized_at AS materializedAt
        FROM agent_graph_client_projections
        WHERE graph_id = ?
      `,
      )
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
      .prepare(
        `
        SELECT
          graph_id AS graphId,
          operator_id AS operatorId,
          snapshot_version AS snapshotVersion,
          payload_json AS payloadJson,
          materialized_at AS materializedAt
        FROM agent_graph_client_operator_projections
        WHERE graph_id = ? AND operator_id = ?
      `,
      )
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
      .prepare(
        `
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
      `,
      )
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
        .prepare(
          `
          SELECT event_time AS eventTime
          FROM agent_graph_client_terminal_activity
          WHERE graph_id = ? AND record_id = ?
        `,
        )
        .get(graphId, input.before.recordId) as { eventTime?: unknown } | undefined;
      if (cursor?.eventTime !== input.before.eventTime) {
        throw new AgentGraphClientTerminalCursorError(
          'Agent graph terminal activity cursor is stale or invalid',
        );
      }
    }
    const rows = this.db
      .prepare(
        `
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
      `,
      )
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
      .prepare(
        `
        SELECT
          intent_id AS intentId,
          admission_status AS state
        FROM agent_graph_intent_claims
        WHERE graph_id = ?
        ORDER BY claimed_at ASC, intent_id ASC
      `,
      )
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
    patch: SessionHeaderPatch,
    options: { expectedVersion?: number; skipNoop?: boolean } = {},
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
    if (Object.prototype.hasOwnProperty.call(patch, 'externalOrigin')) {
      throw new Error('External Session origin is immutable');
    }
    return this.transaction(() =>
      this.updateHeaderSync(sessionId, patch, {
        ...(options.expectedVersion === undefined
          ? {}
          : { expectedVersion: options.expectedVersion }),
        ...(options.skipNoop === undefined ? {} : { skipNoop: options.skipNoop }),
      }),
    );
  }

  async setArchivedVersioned(
    sessions: readonly VersionedSessionIdentity[],
    isArchived: boolean,
  ): Promise<SessionMetadataRecord[]> {
    this.assertOpen();
    const identities = uniqueVersionedSessionIdentities(sessions);
    return this.transaction(() => {
      const records = identities.map(({ sessionId, expectedVersion }) =>
        this.setArchivedSync(sessionId, expectedVersion, isArchived),
      );
      if (isArchived) this.deleteGoalAuthorities(identities);
      return records;
    });
  }

  async removeVersioned(
    sessions: readonly VersionedSessionIdentity[],
    archiveSessions: readonly VersionedSessionIdentity[] = [],
  ): Promise<string[]> {
    this.assertOpen();
    const identities = uniqueVersionedSessionIdentities(sessions);
    const archiveIdentities =
      archiveSessions.length === 0 ? [] : uniqueVersionedSessionIdentities(archiveSessions);
    const retirementSessionIds = new Set(identities.map(({ sessionId }) => sessionId));
    for (const { sessionId } of archiveIdentities) {
      if (retirementSessionIds.has(sessionId)) {
        throw new SessionMetadataConflictError(
          `Session cannot be archived and removed in one retirement: ${sessionId}`,
        );
      }
    }
    const retirementUnitId = identities[0]!.sessionId;
    return this.transaction(() => {
      const present: VersionedSessionIdentity[] = [];
      for (const identity of identities) {
        const record = this.readRecordSync(identity.sessionId);
        if (!record) {
          if (this.hasTombstone(identity.sessionId)) continue;
          throw new SessionNotFoundError(identity.sessionId);
        }
        if (record.metadataVersion !== identity.expectedVersion) {
          throw new SessionMetadataVersionConflictError(
            identity.sessionId,
            identity.expectedVersion,
            record.metadataVersion,
          );
        }
        this.assertSessionCanBeRemoved(identity.sessionId, retirementSessionIds);
        present.push(identity);
      }
      for (const identity of archiveIdentities) {
        const record = this.readRecordSync(identity.sessionId);
        if (!record) throw new SessionNotFoundError(identity.sessionId);
        if (record.metadataVersion !== identity.expectedVersion) {
          throw new SessionMetadataVersionConflictError(
            identity.sessionId,
            identity.expectedVersion,
            record.metadataVersion,
          );
        }
      }
      const deletedAt = this.now();
      for (const { sessionId, expectedVersion } of archiveIdentities) {
        this.setArchivedSync(sessionId, expectedVersion, true);
      }
      for (const { sessionId } of present) {
        const deleted = this.db
          .prepare('DELETE FROM session_metadata WHERE session_id = ?')
          .run(sessionId);
        if (deleted.changes !== 1) {
          throw new SessionMetadataConflictError(
            `Session metadata remove lost its admitted row: ${sessionId}`,
          );
        }
        this.db
          .prepare(
            `
            INSERT INTO session_metadata_tombstones(
              session_id,
              deleted_at,
              retirement_unit_id,
              cleanup_pending
            )
            VALUES (?, ?, ?, 1)
            ON CONFLICT(session_id) DO NOTHING
          `,
          )
          .run(sessionId, deletedAt, retirementUnitId);
      }
      this.deleteGoalAuthorities([...identities, ...archiveIdentities]);
      return identities.map((identity) => identity.sessionId);
    });
  }

  private deleteGoalAuthorities(sessions: readonly VersionedSessionIdentity[]): void {
    // Standalone metadata stores have no workflow schema. An operational lease
    // guarantees that Goal authority shares this exact transaction boundary.
    if (!this.databaseLease) return;
    const remove = this.db.prepare('DELETE FROM workflow_goal_authority WHERE session_id = ?');
    for (const { sessionId } of sessions) remove.run(sessionId);
  }

  async remove(sessionId: string): Promise<boolean> {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    return this.transaction(() => {
      this.assertSessionCanBeRemoved(sessionId);
      const deleted =
        this.db.prepare('DELETE FROM session_metadata WHERE session_id = ?').run(sessionId)
          .changes === 1;
      this.db
        .prepare(
          `
          INSERT INTO session_metadata_tombstones(
            session_id,
            deleted_at,
            retirement_unit_id,
            cleanup_pending
          )
          VALUES (?, ?, ?, 1)
          ON CONFLICT(session_id) DO NOTHING
        `,
        )
        .run(sessionId, this.now(), sessionId);
      return deleted;
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
      .prepare(
        `
        INSERT ${ignoreConflicts ? 'OR IGNORE' : ''} INTO session_metadata(
          session_id,
          payload_json,
          created_at,
          last_used_at,
          last_message_at,
          name,
          is_flagged,
          is_archived,
          parent_session_id,
          subagent_parent_session_id,
          subagent_parent_run_id,
          subagent_tool_call_id,
          subagent_swarm_id,
          subagent_item_id,
          subagent_request_fingerprint,
          subagent_initial_turn_id,
          subagent_initial_run_id,
          external_adapter_id,
          external_source_session_id,
          revision_root_session_id,
          revision_index,
          has_unread,
          backend,
          llm_connection_slug,
          model,
          metadata_version,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        header.id,
        JSON.stringify(header),
        header.createdAt,
        header.lastUsedAt,
        header.lastMessageAt ?? null,
        header.name,
        booleanInteger(header.isFlagged),
        booleanInteger(header.isArchived),
        header.parentSessionId ?? null,
        header.subagentParent?.parentSessionId ?? null,
        header.subagentParent?.spawnedBy.parentRunId ?? null,
        header.subagentParent?.spawnedBy.toolCallId ?? null,
        header.subagentParent?.swarm?.swarmId ?? null,
        header.subagentParent?.swarm?.itemId ?? null,
        header.subagentSpawn?.requestFingerprint ?? null,
        header.subagentSpawn?.initialTurnId ?? null,
        header.subagentSpawn?.initialRunId ?? null,
        header.externalOrigin?.adapterId ?? null,
        header.externalOrigin?.sourceSessionId ?? null,
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
      .prepare(
        `
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
      `,
      )
      .run(header.id, JSON.stringify(boundary), header.createdAt, header.createdAt);
    this.options.failpoint?.('after_sandbox_boundary_write');
  }

  private readCurrentExecutionBoundarySync(sessionId: string): ExecutionBoundary {
    const row = this.db
      .prepare(
        `
        SELECT boundary_json AS boundaryJson
        FROM sandbox_boundary_log
        WHERE session_id = ? AND applied_revision IS NOT NULL
        ORDER BY applied_revision DESC
        LIMIT 1
      `,
      )
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
      .prepare(
        `
        SELECT boundary_json AS boundaryJson
        FROM sandbox_boundary_log
        WHERE
          session_id = ?
          AND applied_revision IS NOT NULL
          AND json_extract(boundary_json, '$.kind') = 'managed'
        ORDER BY applied_revision DESC
      `,
      )
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
      .prepare(
        `
        SELECT ${SANDBOX_BOUNDARY_REQUEST_COLUMNS}
        FROM sandbox_boundary_log
        WHERE session_id = ? AND request_id = ?
      `,
      )
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
      .prepare(
        `
        UPDATE sandbox_boundary_log
        SET
          status = ?,
          applied_revision = ?,
          boundary_json = ?,
          outcome_reason = ?,
          settled_at = ?
        WHERE session_id = ? AND request_id = ? AND status = 'pending'
      `,
      )
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
    patch: SessionHeaderPatch,
    options: {
      expectedVersion?: number;
      skipNoop?: boolean;
      catalogPreview?: { readonly kind: 'replace'; readonly value?: string };
    } = {},
  ): SessionMetadataRecord {
    if (Object.prototype.hasOwnProperty.call(patch, 'isArchived')) {
      throw new Error('Session archive state requires the dedicated lifecycle writer');
    }
    const current = this.readRecordSync(sessionId);
    if (!current) throw new SessionNotFoundError(sessionId);
    if (
      options.expectedVersion !== undefined &&
      options.expectedVersion !== current.metadataVersion
    ) {
      throw new SessionMetadataVersionConflictError(
        sessionId,
        options.expectedVersion,
        current.metadataVersion,
      );
    }
    assertConversationCopyTransition(current.header, patch);
    const next = normalizeSessionHeader(
      {
        ...current.header,
        ...patch,
      },
      sessionId,
    );
    return this.persistHeaderSync(sessionId, current, next, options);
  }

  private setArchivedSync(
    sessionId: string,
    expectedVersion: number,
    isArchived: boolean,
  ): SessionMetadataRecord {
    const current = this.readRecordSync(sessionId);
    if (!current) throw new SessionNotFoundError(sessionId);
    if (expectedVersion !== current.metadataVersion) {
      throw new SessionMetadataVersionConflictError(
        sessionId,
        expectedVersion,
        current.metadataVersion,
      );
    }
    const next = normalizeSessionHeader({ ...current.header, isArchived }, sessionId);
    return this.persistHeaderSync(sessionId, current, next, { skipNoop: true });
  }

  private persistHeaderSync(
    sessionId: string,
    current: SessionMetadataRecord,
    next: SessionHeader,
    options: {
      skipNoop?: boolean;
      catalogPreview?: { readonly kind: 'replace'; readonly value?: string };
    } = {},
  ): SessionMetadataRecord {
    if (next.id !== sessionId) {
      throw new SessionMetadataConflictError('Session metadata identity cannot be changed');
    }
    const currentPreview =
      options.catalogPreview === undefined ? undefined : this.readCatalogPreviewSync(sessionId);
    const previewChanged =
      options.catalogPreview !== undefined && options.catalogPreview.value !== currentPreview;
    if (options.skipNoop && isDeepStrictEqual(next, current.header) && !previewChanged) {
      return current;
    }
    const metadataVersion = current.metadataVersion + 1;
    const committedAt = this.now();
    const updated = this.db
      .prepare(
        `
        UPDATE session_metadata
        SET
          payload_json = ?,
          created_at = ?,
          last_used_at = ?,
          last_message_at = ?,
          name = ?,
          is_flagged = ?,
          is_archived = ?,
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
      `,
      )
      .run(
        JSON.stringify(next),
        next.createdAt,
        next.lastUsedAt,
        next.lastMessageAt ?? null,
        next.name,
        booleanInteger(next.isFlagged),
        booleanInteger(next.isArchived),
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
    if (options.catalogPreview) {
      const preview = this.db
        .prepare(
          `
          UPDATE session_catalog_projection
          SET last_message_preview = ?
          WHERE session_id = ?
        `,
        )
        .run(options.catalogPreview.value ?? null, sessionId);
      if (preview.changes !== 1) {
        throw new SessionMetadataConflictError(
          `Session catalog projection is missing: ${sessionId}`,
        );
      }
    }
    return { header: next, metadataVersion, committedAt };
  }

  private setExecutionBoundaryKindSync(
    sessionId: string,
    kind: 'managed' | 'bypass',
    projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
    options: {
      expectedVersion?: number;
      headerPatch?: SessionHeaderPatch;
    } = {},
  ): { boundary: ExecutionBoundary; record: SessionMetadataRecord } {
    const record = this.readRecordSync(sessionId);
    if (!record) throw new SessionNotFoundError(sessionId);
    if (
      options.expectedVersion !== undefined &&
      options.expectedVersion !== record.metadataVersion
    ) {
      throw new SessionMetadataVersionConflictError(
        sessionId,
        options.expectedVersion,
        record.metadataVersion,
      );
    }
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
      throw new Error('Execution boundary kind and projected permission mode disagree');
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
        .prepare(
          `
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
        `,
        )
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
    const patch = {
      ...options.headerPatch,
      permissionMode: projectedMode,
      labels: projectedLabels,
    };
    const updated = this.updateHeaderSync(sessionId, patch, {
      ...(options.expectedVersion === undefined
        ? {}
        : { expectedVersion: options.expectedVersion }),
      skipNoop: true,
    });
    return { boundary, record: updated };
  }

  private readRecordSync(sessionId: string): SessionMetadataRecord | undefined {
    const row = this.db
      .prepare(
        `
        SELECT session_id, payload_json, metadata_version, committed_at
        FROM session_metadata
        WHERE session_id = ?
      `,
      )
      .get(sessionId) as SessionMetadataRow | undefined;
    return row ? decodeRecord(row) : undefined;
  }

  private insertSessionMessagesSync(
    sessionId: string,
    firstSequence: number,
    entries: readonly {
      readonly message: StoredMessage;
      readonly json: string;
    }[],
  ): void {
    const insertMessage = this.db.prepare(`
      INSERT INTO session_messages(
        session_id, sequence, message_id, message_type, message_ts, record_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertPayload = this.db.prepare(`
      INSERT INTO session_message_payloads(session_id, sequence, record_bytes, sha256)
      VALUES (?, ?, ?, ?)
    `);
    const insertChunk = this.db.prepare(`
      INSERT INTO session_message_chunks(session_id, sequence, chunk_index, data, sha256)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const sequence = firstSequence + index;
      const encoded = Buffer.from(entry.json, 'utf8');
      const chunked = encoded.byteLength > SQLITE_SESSION_MESSAGE_CHUNK_BYTES;
      insertMessage.run(
        sessionId,
        sequence,
        entry.message.id,
        entry.message.type,
        entry.message.ts,
        chunked ? SQLITE_SESSION_MESSAGE_CHUNK_MARKER : entry.json,
      );
      if (!chunked) continue;
      insertPayload.run(
        sessionId,
        sequence,
        encoded.byteLength,
        createHash('sha256').update(encoded).digest('hex'),
      );
      for (
        let offset = 0;
        offset < encoded.byteLength;
        offset += SQLITE_SESSION_MESSAGE_CHUNK_BYTES
      ) {
        const chunk = encoded.subarray(offset, offset + SQLITE_SESSION_MESSAGE_CHUNK_BYTES);
        insertChunk.run(
          sessionId,
          sequence,
          offset / SQLITE_SESSION_MESSAGE_CHUNK_BYTES,
          chunk,
          createHash('sha256').update(chunk).digest('hex'),
        );
      }
    }
  }

  private readMessagesWith(
    sessionId: string,
    decode: (value: unknown) => StoredMessage,
  ): StoredMessage[] {
    this.assertOpen();
    assertSafeSessionId(sessionId);
    if (!this.readRecordSync(sessionId)) throw new SessionNotFoundError(sessionId);
    const sequences = (
      this.db
        .prepare('SELECT sequence FROM session_messages WHERE session_id = ? ORDER BY sequence')
        .all(sessionId) as Array<{ sequence?: unknown }>
    ).map((row) => requireStoredMessageSequence(row.sequence, sessionId));
    const rows: Array<{ sequence: number; recordJson: string }> = [];
    for (
      let offset = 0;
      offset < sequences.length;
      offset += SQLITE_TRANSCRIPT_MESSAGE_LOOKUP_BATCH_SIZE
    ) {
      rows.push(
        ...readStoredMessageRows(
          this.db,
          sessionId,
          sequences.slice(offset, offset + SQLITE_TRANSCRIPT_MESSAGE_LOOKUP_BATCH_SIZE),
        ),
      );
    }
    return rows.map((row) => {
      try {
        return decode(JSON.parse(row.recordJson) as unknown);
      } catch (error) {
        throw new StoredSessionMessageIncompatibleError(sessionId, row.sequence, { cause: error });
      }
    });
  }

  private readCatalogPreviewSync(sessionId: string): string | undefined {
    const row = this.db
      .prepare(
        `
        SELECT last_message_preview
        FROM session_catalog_projection
        WHERE session_id = ?
      `,
      )
      .get(sessionId) as { last_message_preview?: unknown } | undefined;
    if (!row) {
      throw new SessionMetadataConflictError(`Session catalog projection is missing: ${sessionId}`);
    }
    return decodeCatalogPreview(row.last_message_preview, sessionId);
  }

  private updateCatalogProjectionSync(
    sessionId: string,
    projection: SessionCatalogMessageProjection,
    replacePreview: boolean,
    lockConnection = false,
  ): void {
    const current = this.readRecordSync(sessionId);
    if (!current) throw new SessionNotFoundError(sessionId);
    const lastMessageAt = maxTimestamp(current.header.lastMessageAt, projection.lastMessageAt);
    this.updateHeaderSync(
      sessionId,
      {
        ...(lockConnection ? { connectionLocked: true } : {}),
        ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
      },
      {
        skipNoop: true,
        ...(replacePreview || projection.lastMessagePreview !== undefined
          ? {
              catalogPreview: {
                kind: 'replace',
                ...(projection.lastMessagePreview === undefined
                  ? {}
                  : { value: projection.lastMessagePreview }),
              } as const,
            }
          : {}),
      },
    );
  }

  private finishCatalogProjectionWriteSync(): void {
    const result = this.db
      .prepare(
        `
        UPDATE session_catalog_state
        SET pending_writes = pending_writes - 1
        WHERE scope = 'catalog' AND pending_writes > 0
      `,
      )
      .run();
    if (result.changes !== 1) {
      throw new Error('Session catalog projection write was not pending');
    }
  }

  private readCatalogRevisionSync(): SessionCatalogRevisionState {
    const state = this.readCatalogStateSync();
    return { epoch: state.epoch, generation: state.generation };
  }

  private readCatalogStateSync(): SessionCatalogRevisionState & {
    readonly pendingWrites: number;
  } {
    const row = this.db
      .prepare(
        `
        SELECT epoch, generation, pending_writes
        FROM session_catalog_state
        WHERE scope = 'catalog'
      `,
      )
      .get() as { epoch?: unknown; generation?: unknown; pending_writes?: unknown } | undefined;
    if (
      !row ||
      typeof row.epoch !== 'string' ||
      !/^[0-9a-f]{32}$/.test(row.epoch) ||
      !Number.isSafeInteger(row.generation) ||
      (row.generation as number) < 0 ||
      !Number.isSafeInteger(row.pending_writes) ||
      (row.pending_writes as number) < 0
    ) {
      throw new Error('Invalid Session catalog revision state');
    }
    return {
      epoch: row.epoch,
      generation: row.generation as number,
      pendingWrites: row.pending_writes as number,
    };
  }

  private probeStableSessionCreateSync(
    sessionId: string,
    requestFingerprint: string,
  ): StableSessionCreateProbe {
    const claim = this.db
      .prepare(
        `
        SELECT request_fingerprint AS requestFingerprint
        FROM session_create_claims
        WHERE session_id = ?
      `,
      )
      .get(sessionId) as { requestFingerprint?: unknown } | undefined;
    const record = this.readRecordSync(sessionId);
    if (!claim) {
      if (record || this.hasTombstone(sessionId)) {
        return {
          kind: 'conflict',
          reason: record ? 'identity_mismatch' : 'removed',
        };
      }
      return { kind: 'absent' };
    }
    if (this.hasTombstone(sessionId)) {
      return { kind: 'conflict', reason: 'removed' };
    }
    if (
      typeof claim.requestFingerprint !== 'string' ||
      claim.requestFingerprint !== requestFingerprint
    ) {
      return { kind: 'conflict', reason: 'identity_mismatch' };
    }
    return record ? { kind: 'existing', record } : { kind: 'absent' };
  }

  private tryClaimSubagentSpawn(
    header: SessionHeader,
    claimedAt: number,
  ): SubagentSpawnClaim & { created: boolean } {
    const identity = requireSubagentSpawnIdentity(header);
    const result = this.db
      .prepare(
        `
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
      `,
      )
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
      .prepare(
        `
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
      `,
      )
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
      .prepare(
        `
        SELECT payload_json AS payloadJson
        FROM agent_graph_operator_provisions
        WHERE graph_id = ? AND work_id = ?
      `,
      )
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
      .prepare(
        `
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
      `,
      )
      .get(graphId, intentId) as AgentGraphIntentClaim | undefined;
    return row ? decodeAgentGraphIntentClaim(row) : undefined;
  }

  private readAgentGraphIntentAdmissionStateSync(
    graphId: string,
    intentId: string,
  ): AgentGraphIntentAdmissionState {
    const row = this.db
      .prepare(
        `
        SELECT admission_status AS admissionState
        FROM agent_graph_intent_claims
        WHERE graph_id = ? AND intent_id = ?
      `,
      )
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
      .prepare(
        `
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
      `,
      )
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
      .prepare(
        `
        SELECT payload_json AS payloadJson
        FROM agent_graph_schedule_updates
        WHERE update_id = ?
      `,
      )
      .get(updateId) as AgentGraphScheduleUpdateRow | undefined;
    return row ? decodeAgentGraphScheduleUpdateRow(row) : undefined;
  }

  private readAgentGraphScheduleUpdateBySourceSync(
    source: AgentGraphScheduleUpdateRequest['source'],
  ): AgentGraphScheduleUpdate | undefined {
    const row = this.db
      .prepare(
        `
        SELECT payload_json AS payloadJson
        FROM agent_graph_schedule_updates
        WHERE source_session_id = ?
          AND source_run_id = ?
          AND source_tool_call_id = ?
      `,
      )
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
        .prepare(
          `
          SELECT 1 AS found
          FROM agent_graph_schedule_updates
          WHERE graph_id = ? AND closes_graph = 1
          LIMIT 1
        `,
        )
        .get(graphId) !== undefined
    );
  }

  private nextAgentGraphScheduleRevision(graphId: string): number {
    return this.currentAgentGraphScheduleRevision(graphId) + 1;
  }

  private currentAgentGraphScheduleRevision(graphId: string): number {
    const row = this.db
      .prepare(
        `
        SELECT COALESCE(MAX(revision), 0) AS revision
        FROM agent_graph_schedule_updates
        WHERE graph_id = ?
      `,
      )
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
      .prepare(
        `
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
      `,
      )
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
      .prepare(
        `
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
      `,
      )
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

  private assertSessionCanBeRemoved(
    sessionId: string,
    retirementSessionIds?: ReadonlySet<string>,
  ): void {
    const graphOwner = this.db
      .prepare(
        `
        SELECT graph_id AS graphId, work_id AS workId, operator_id AS operatorId
        FROM agent_graph_operator_provisions
        WHERE target_session_id = ?
      `,
      )
      .get(sessionId) as { graphId: string; workId: string; operatorId: string } | undefined;
    if (graphOwner) {
      const parent = this.readRecordSync(sessionId)?.header.subagentParent;
      if (
        !retirementSessionIds?.has(parent?.parentSessionId ?? '') ||
        parent?.graph?.graphId !== graphOwner.graphId ||
        parent.graph.workId !== graphOwner.workId ||
        parent.graph.operatorId !== graphOwner.operatorId
      ) {
        throw new SessionMetadataConflictError(
          `Cannot remove graph operator Session ${sessionId}; owned by ${graphOwner.graphId}/${graphOwner.workId}`,
        );
      }
    }
    const ownedOperators = this.db
      .prepare(
        `
        SELECT
          child.session_id,
          child.payload_json,
          child.metadata_version,
          child.committed_at,
          provision.graph_id,
          provision.work_id,
          provision.operator_id
        FROM agent_graph_operator_provisions provision
        JOIN session_metadata child
          ON child.session_id = provision.target_session_id
        WHERE child.subagent_parent_session_id = ?
        ORDER BY child.session_id
      `,
      )
      .all(sessionId) as unknown as OwnedAgentGraphOperatorRow[];
    for (const row of ownedOperators) {
      const parent = decodeRecord(row).header.subagentParent;
      if (
        !parent?.graph ||
        parent.parentSessionId !== sessionId ||
        parent.graph.graphId !== row.graph_id ||
        parent.graph.workId !== row.work_id ||
        parent.graph.operatorId !== row.operator_id
      ) {
        throw new SessionMetadataConflictError(
          `Cannot remove Session ${sessionId}; graph operator ${row.session_id} has invalid ownership`,
        );
      }
      if (!retirementSessionIds?.has(row.session_id)) {
        throw new SessionMetadataConflictError(
          `Cannot remove Session ${sessionId}; graph operator ${row.session_id} is outside the retirement unit`,
        );
      }
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.databaseLease) return this.databaseLease.transaction('write', operation);
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
    if (this.databaseLease) return this.databaseLease.transaction('read', operation);
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

  private readCurrentAgentGraphEpochSync(
    rootSessionId: string,
  ): AgentGraphEpochBinding | undefined {
    const row = this.db
      .prepare(
        `
        SELECT
          schema_version AS schemaVersion,
          root_session_id AS rootSessionId,
          epoch,
          graph_id AS graphId,
          created_at AS createdAt
        FROM agent_graph_epochs
        WHERE root_session_id = ?
        ORDER BY epoch DESC
        LIMIT 1
      `,
      )
      .get(rootSessionId) as AgentGraphEpochRow | undefined;
    return row ? decodeAgentGraphEpochBinding(row) : undefined;
  }

  private readAgentGraphEpochSync(
    rootSessionId: string,
    epoch: number,
  ): AgentGraphEpochBinding | undefined {
    const row = this.db
      .prepare(
        `
        SELECT
          schema_version AS schemaVersion,
          root_session_id AS rootSessionId,
          epoch,
          graph_id AS graphId,
          created_at AS createdAt
        FROM agent_graph_epochs
        WHERE root_session_id = ? AND epoch = ?
      `,
      )
      .get(rootSessionId, epoch) as AgentGraphEpochRow | undefined;
    return row ? decodeAgentGraphEpochBinding(row) : undefined;
  }

  private insertAgentGraphEpochSync(binding: AgentGraphEpochBinding): void {
    this.db
      .prepare(
        `
        INSERT INTO agent_graph_epochs(
          root_session_id,
          epoch,
          graph_id,
          schema_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(
        binding.rootSessionId,
        binding.epoch,
        binding.graphId,
        binding.schemaVersion,
        binding.createdAt,
      );
  }

  private readAgentGraphEpochByGraphIdSync(graphId: string): AgentGraphEpochBinding | undefined {
    const row = this.db
      .prepare(
        `
        SELECT
          schema_version AS schemaVersion,
          root_session_id AS rootSessionId,
          epoch,
          graph_id AS graphId,
          created_at AS createdAt
        FROM agent_graph_epochs
        WHERE graph_id = ?
      `,
      )
      .get(graphId) as AgentGraphEpochRow | undefined;
    return row ? decodeAgentGraphEpochBinding(row) : undefined;
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

interface OwnedAgentGraphOperatorRow extends SessionMetadataRow {
  graph_id: string;
  work_id: string;
  operator_id: string;
}

interface OrphanedAgentGraphOperatorRow extends OwnedAgentGraphOperatorRow {
  parent_session_id: string;
  retirement_unit_id: string | null;
}

interface SessionMetadataCatalogRow extends SessionMetadataRow {
  last_message_preview: string | null;
}

function buildSessionListPredicate(filter: SessionListFilter): {
  where: string[];
  parameters: Array<string | number>;
} {
  const where: string[] = [];
  const parameters: Array<string | number> = [];
  if (filter.subagentParentSessionId !== undefined) {
    assertSafeSessionId(filter.subagentParentSessionId);
    where.push('metadata.subagent_parent_session_id = ?');
    parameters.push(filter.subagentParentSessionId);
  }
  return { where, parameters };
}

function clearConnectionBlock(
  current: SessionMetadataRecord,
  statusUpdatedAt: number,
): Pick<SessionHeader, 'status' | 'blockedReason' | 'statusUpdatedAt'> {
  if (current.header.blockedReason !== 'NO_REAL_CONNECTION') {
    throw new SessionMetadataConflictError('Session no longer has a connection block to clear');
  }
  if (!Number.isSafeInteger(statusUpdatedAt) || statusUpdatedAt < 0) {
    throw new Error('Session connection unblock timestamp is invalid');
  }
  return {
    status: 'active',
    blockedReason: undefined,
    statusUpdatedAt,
  };
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

interface AgentGraphEpochRow {
  schemaVersion: number;
  rootSessionId: string;
  epoch: number;
  graphId: string;
  createdAt: number;
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
    ![
      'pending',
      'running',
      'waiting_permission',
      'delivered',
      'superseded',
      'retryable_failed',
    ].includes(row.status) ||
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
    !['running', 'waiting_permission', 'delivered', 'superseded', 'retryable_failed'].includes(
      row.status,
    ) ||
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

function decodeCatalogRecord(row: SessionMetadataCatalogRow): SessionMetadataCatalogRecord {
  const lastMessagePreview = decodeCatalogPreview(row.last_message_preview, row.session_id);
  return {
    ...decodeRecord(row),
    ...(lastMessagePreview === undefined ? {} : { lastMessagePreview }),
  };
}

function decodeCatalogPreview(value: unknown, sessionId: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || Array.from(value).length > 96) {
    throw new Error(`Invalid SQLite Session catalog preview for ${sessionId}`);
  }
  return value;
}

function assertCatalogMessageProjection(projection: SessionCatalogMessageProjection): void {
  if (
    projection.lastMessageAt !== undefined &&
    (!Number.isSafeInteger(projection.lastMessageAt) || projection.lastMessageAt < 0)
  ) {
    throw new Error('Session catalog message timestamp is invalid');
  }
  if (
    projection.lastMessagePreview !== undefined &&
    Array.from(projection.lastMessagePreview).length > 96
  ) {
    throw new Error('Session catalog message preview is too long');
  }
}

function maxTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
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

function assertMetadataVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertSessionCreateFingerprint(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error('Session create request fingerprint is invalid');
  }
}

function assertConversationCopyTransition(current: SessionHeader, patch: SessionHeaderPatch): void {
  if (!Object.prototype.hasOwnProperty.call(patch, 'conversationCopy')) return;
  if (!isValidConversationCopyTransition(current, patch.conversationCopy)) {
    throw new SessionMetadataConflictError('Session conversation-copy identity is immutable');
  }
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
    request.status !== 'superseded' &&
    request.status !== 'retryable_failed'
  ) {
    throw new Error('Invalid agent graph supervisor wake completion status');
  }
  if (
    (request.status === 'retryable_failed' || request.status === 'superseded') &&
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

function decodeStoredMessageRow(
  row: { sequence?: unknown; record_json?: unknown },
  sessionId: string,
): StoredMessage {
  const sequence = requireStoredMessageSequence(row.sequence, sessionId);
  if (typeof row.record_json !== 'string') {
    throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
  }
  try {
    const parsed = JSON.parse(row.record_json) as unknown;
    return decodeStoredMessage(parsed);
  } catch (error) {
    throw new StoredSessionMessageIncompatibleError(sessionId, sequence, {
      cause: error,
    });
  }
}

interface StoredSessionMessagePayloadRow {
  readonly sequence?: unknown;
  readonly record_json?: unknown;
  readonly record_bytes?: unknown;
  readonly sha256?: unknown;
}

interface TurnLandmarkCandidateRow {
  readonly sequence?: unknown;
  readonly admitted_at?: unknown;
}

interface LegacyTurnLandmarkRow {
  readonly sequence?: unknown;
  readonly message_type?: unknown;
  readonly payload_sequence?: unknown;
}

function requireTurnLandmarkAdmittedAt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid root Turn admission timestamp');
  }
  return value;
}

function storedMessageRecordBytes(
  row: StoredSessionMessagePayloadRow,
  sessionId: string,
  sequence: number,
): number {
  if (row.record_bytes !== null) {
    return requireTranscriptRecordByteLength(row.record_bytes, sessionId, sequence);
  }
  if (
    typeof row.record_json !== 'string' ||
    row.record_json === SQLITE_SESSION_MESSAGE_CHUNK_MARKER
  ) {
    throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
  }
  return Buffer.byteLength(row.record_json, 'utf8');
}

function decodeStoredMessageRecordRow(
  db: DatabaseSync,
  sessionId: string,
  row: StoredSessionMessagePayloadRow,
): StoredMessage {
  const sequence = requireStoredMessageSequence(row.sequence, sessionId);
  return decodeStoredMessageRow(
    {
      sequence,
      record_json: readStoredMessageRecordJson(db, sessionId, sequence, row),
    },
    sessionId,
  );
}

function readStoredMessageRecordJson(
  db: DatabaseSync,
  sessionId: string,
  sequence: number,
  row: StoredSessionMessagePayloadRow,
): string {
  let recordJson: string;
  if (row.record_bytes === null) {
    if (
      typeof row.record_json !== 'string' ||
      row.record_json === SQLITE_SESSION_MESSAGE_CHUNK_MARKER
    ) {
      throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
    }
    recordJson = row.record_json;
  } else {
    const recordBytes = requireTranscriptRecordByteLength(row.record_bytes, sessionId, sequence);
    if (
      row.record_json !== SQLITE_SESSION_MESSAGE_CHUNK_MARKER ||
      recordBytes <= SQLITE_SESSION_MESSAGE_CHUNK_BYTES ||
      typeof row.sha256 !== 'string'
    ) {
      throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
    }
    const data = readChunkedTranscriptRecord(db, sessionId, sequence, recordBytes);
    if (createHash('sha256').update(data).digest('hex') !== row.sha256) {
      throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
    }
    recordJson = data.toString('utf8');
  }
  return recordJson;
}

function foldTurnContribution(
  current: SessionTurnContribution | undefined,
  turnId: string,
  sequence: number,
  message: StoredMessage,
): SessionTurnContribution {
  const contribution = current ?? {
    turnId,
    firstSequence: sequence,
    latestState: null,
    userPromptPreview: null,
    hasAssistantMessage: false,
    hasAssistantOutput: false,
    hasToolResult: false,
    hasFailedToolResult: false,
    hasAbortNote: false,
  };
  const userPrompt = message.type === 'user' ? (message.displayText ?? message.text).trim() : '';
  return {
    ...contribution,
    latestState: message.type === 'turn_state' ? { sequence, message } : contribution.latestState,
    userPromptPreview: contribution.userPromptPreview ?? (userPrompt || null),
    hasAssistantMessage: contribution.hasAssistantMessage || message.type === 'assistant',
    hasAssistantOutput:
      contribution.hasAssistantOutput ||
      (message.type === 'assistant' && message.text.trim().length > 0),
    hasToolResult: contribution.hasToolResult || message.type === 'tool_result',
    hasFailedToolResult:
      contribution.hasFailedToolResult || (message.type === 'tool_result' && message.isError),
    hasAbortNote:
      contribution.hasAbortNote || (message.type === 'system_note' && message.kind === 'abort'),
  };
}

function readStoredMessageRows(
  db: DatabaseSync,
  sessionId: string,
  sequences: readonly number[],
  placeholders = sequences.map(() => '?').join(', '),
): Array<{ sequence: number; recordJson: string }> {
  if (sequences.length === 0) return [];
  const rows = db
    .prepare(
      `
        SELECT message.sequence, message.record_json, payload.record_bytes, payload.sha256
        FROM session_messages AS message
        LEFT JOIN session_message_payloads AS payload
          ON payload.session_id = message.session_id AND payload.sequence = message.sequence
        WHERE message.session_id = ? AND message.sequence IN (${placeholders})
        ORDER BY message.sequence
      `,
    )
    .all(sessionId, ...sequences) as StoredSessionMessagePayloadRow[];
  if (rows.length !== sequences.length) {
    throw new StoredSessionMessageIncompatibleError(sessionId, -1);
  }
  return rows.map((row) => {
    const sequence = requireStoredMessageSequence(row.sequence, sessionId);
    return {
      sequence,
      recordJson: readStoredMessageRecordJson(db, sessionId, sequence, row),
    };
  });
}

function readChunkedTranscriptRecord(
  db: DatabaseSync,
  sessionId: string,
  sequence: number,
  recordBytes: number,
): Buffer {
  const rows = db
    .prepare(
      `
      SELECT chunk_index, data, sha256
      FROM session_message_chunks
      WHERE session_id = ? AND sequence = ?
      ORDER BY chunk_index
    `,
    )
    .all(sessionId, sequence) as Array<{
    chunk_index?: unknown;
    data?: unknown;
    sha256?: unknown;
  }>;
  const expectedChunks = Math.ceil(recordBytes / SQLITE_SESSION_MESSAGE_CHUNK_BYTES);
  if (rows.length !== expectedChunks) {
    throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
  }
  const chunks = rows.map((row, index) => {
    if (
      row.chunk_index !== index ||
      !(row.data instanceof Uint8Array) ||
      typeof row.sha256 !== 'string'
    ) {
      throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
    }
    const chunk = Buffer.from(row.data);
    if (createHash('sha256').update(chunk).digest('hex') !== row.sha256) {
      throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
    }
    return chunk;
  });
  const data = Buffer.concat(chunks, recordBytes);
  if (data.byteLength !== recordBytes) {
    throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
  }
  return data;
}

function requireStoredMessageSequence(value: unknown, sessionId: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new StoredSessionMessageIncompatibleError(sessionId, -1);
  }
  return value as number;
}

function nullableStoredMessageSequence(value: unknown, sessionId: string): number | null {
  if (value === null || value === undefined) return null;
  return requireStoredMessageSequence(value, sessionId);
}

interface TranscriptRecordSlice {
  readonly sequence: number;
  readonly byteOffset: number;
  readonly totalBytes: number;
  readonly byteLength: number;
  readonly chunked: boolean;
  readonly payloadDigest: `sha256:${string}` | null;
}

function requireTranscriptPayloadDigest(
  value: unknown,
  sessionId: string,
  sequence: number,
): `sha256:${string}` {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
  }
  return `sha256:${value}`;
}

function requireTranscriptRecordByteLength(
  value: unknown,
  sessionId: string,
  sequence: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
  }
  return value as number;
}

function readTranscriptSlices(
  db: DatabaseSync,
  sessionId: string,
  slices: readonly TranscriptRecordSlice[],
): Map<number, Buffer> {
  if (slices.length === 0) return new Map();
  const chunkedSlices = slices.filter((slice) => slice.chunked);
  const values = chunkedSlices.map(() => '(?, ?, ?)').join(', ');
  const parameters = chunkedSlices.flatMap((slice) => [
    slice.sequence,
    Math.floor(slice.byteOffset / SQLITE_SESSION_MESSAGE_CHUNK_BYTES),
    Math.floor((slice.byteOffset + slice.byteLength - 1) / SQLITE_SESSION_MESSAGE_CHUNK_BYTES),
  ]);
  const rows =
    chunkedSlices.length === 0
      ? []
      : (db
          .prepare(
            `
        WITH requested(sequence, first_chunk, last_chunk) AS (VALUES ${values})
        SELECT requested.sequence, chunk.chunk_index, chunk.data, chunk.sha256
        FROM requested
        INNER JOIN session_message_chunks AS chunk
          ON chunk.session_id = ?
          AND chunk.sequence = requested.sequence
          AND chunk.chunk_index BETWEEN requested.first_chunk AND requested.last_chunk
        ORDER BY requested.sequence, chunk.chunk_index
      `,
          )
          .all(...parameters, sessionId) as Array<{
          sequence?: unknown;
          chunk_index?: unknown;
          data?: unknown;
          sha256?: unknown;
        }>);
  const rowsBySequence = new Map<number, typeof rows>();
  for (const row of rows) {
    const sequence = requireStoredMessageSequence(row.sequence, sessionId);
    const grouped = rowsBySequence.get(sequence);
    if (grouped) grouped.push(row);
    else rowsBySequence.set(sequence, [row]);
  }
  const result = new Map<number, Buffer>();
  for (const slice of slices) {
    if (!slice.chunked) continue;
    const selected = rowsBySequence.get(slice.sequence) ?? [];
    const firstChunk = Math.floor(slice.byteOffset / SQLITE_SESSION_MESSAGE_CHUNK_BYTES);
    const lastChunk = Math.floor(
      (slice.byteOffset + slice.byteLength - 1) / SQLITE_SESSION_MESSAGE_CHUNK_BYTES,
    );
    if (selected.length !== lastChunk - firstChunk + 1) {
      throw new StoredSessionMessageIncompatibleError(sessionId, slice.sequence);
    }
    const chunks: Buffer[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const row = selected[index]!;
      if (
        row.chunk_index !== firstChunk + index ||
        !(row.data instanceof Uint8Array) ||
        typeof row.sha256 !== 'string'
      ) {
        throw new StoredSessionMessageIncompatibleError(sessionId, slice.sequence);
      }
      const chunk = Buffer.from(row.data);
      if (createHash('sha256').update(chunk).digest('hex') !== row.sha256) {
        throw new StoredSessionMessageIncompatibleError(sessionId, slice.sequence);
      }
      chunks.push(chunk);
    }
    const joined = Buffer.concat(chunks);
    const start = slice.byteOffset - firstChunk * SQLITE_SESSION_MESSAGE_CHUNK_BYTES;
    const data = joined.subarray(start, start + slice.byteLength);
    if (data.byteLength !== slice.byteLength) {
      throw new StoredSessionMessageIncompatibleError(sessionId, slice.sequence);
    }
    result.set(slice.sequence, data);
  }
  const inlineSlices = slices.filter((slice) => !slice.chunked);
  if (inlineSlices.length > 0) {
    const inlineValues = inlineSlices.map(() => '(?, ?, ?)').join(', ');
    const inlineParameters = inlineSlices.flatMap((slice) => [
      slice.sequence,
      slice.byteOffset + 1,
      slice.byteLength,
    ]);
    const inlineRows = db
      .prepare(
        `
          WITH requested(sequence, byte_start, byte_length) AS (VALUES ${inlineValues})
          SELECT requested.sequence,
            substr(CAST(message.record_json AS BLOB), requested.byte_start, requested.byte_length)
              AS data
          FROM requested
          INNER JOIN session_messages AS message
            ON message.session_id = ? AND message.sequence = requested.sequence
        `,
      )
      .all(...inlineParameters, sessionId) as Array<{
      sequence?: unknown;
      data?: unknown;
    }>;
    for (const row of inlineRows) {
      const sequence = requireStoredMessageSequence(row.sequence, sessionId);
      if (!(row.data instanceof Uint8Array)) {
        throw new StoredSessionMessageIncompatibleError(sessionId, sequence);
      }
      result.set(sequence, Buffer.from(row.data));
    }
  }
  return result;
}

function validateTranscriptRecord(
  data: string | Buffer,
  sessionId: string,
  sequence: number,
): void {
  try {
    decodeStoredMessage(
      JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as unknown,
    );
  } catch (error) {
    throw new StoredSessionMessageIncompatibleError(sessionId, sequence, {
      cause: error,
    });
  }
}

function assertTranscriptPageRequest(request: SessionTranscriptPageRequest): void {
  if (request.direction !== 'older' && request.direction !== 'newer') {
    throw new Error('Invalid Session transcript page direction');
  }
  if (
    request.throughSequence !== undefined &&
    request.throughSequence !== null &&
    (!Number.isSafeInteger(request.throughSequence) || request.throughSequence < 0)
  ) {
    throw new Error('Invalid Session transcript watermark');
  }
  if (
    request.position !== undefined &&
    (!Number.isSafeInteger(request.position) || request.position < 0)
  ) {
    throw new Error('Invalid Session transcript position');
  }
  if (
    request.byteOffset !== undefined &&
    (request.position === undefined ||
      !Number.isSafeInteger(request.byteOffset) ||
      request.byteOffset < 0)
  ) {
    throw new Error('Invalid Session transcript byte offset');
  }
  if (
    !Number.isSafeInteger(request.maxBytes) ||
    request.maxBytes < 1 ||
    request.maxBytes > 1024 * 1024
  ) {
    throw new Error('Session transcript page byte limit must be between 1 and 1048576');
  }
  if (
    !Number.isSafeInteger(request.maxMessages) ||
    request.maxMessages < 1 ||
    request.maxMessages > 256
  ) {
    throw new Error('Session transcript page message limit must be between 1 and 256');
  }
}
