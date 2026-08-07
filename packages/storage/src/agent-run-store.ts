import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import {
  decodeAgentRunEvent,
  decodeAgentRunHeader,
  decodeRuntimeEvent,
} from './execution-record-codec.js';
import { immutableSteeringMessageId } from './runtime-event-invariants.js';
import { assertNoReservedWorkspaceAuthorityAppend } from './runtime-event-authority.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import {
  assertEvidenceReadBudget,
  measureEvidenceRows,
  type BoundedEvidenceReadResult,
  type EvidenceReadBudget,
} from './bounded-evidence.js';
import {
  DurableStoreWriteError,
  aggregateMessageContents,
  decodeAgentGraphIntentClaim,
  decodeMessageContent,
  encodeCanonicalRuntimeEvent,
  isCanonicalAttachmentRef,
  isTerminalRuntimeEvent,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  messageContentsEqual,
  scanToolLedger,
  validateGenericToolLedgerAppend,
  validateToolLedgerTransition,
  type AgentRunEvent,
  type AgentRunEventType,
  type AgentRunHeader,
  type AgentRunStore,
  type EmittedAgentRunEvent,
  type AttachmentRef,
  type MessageContent,
  type RootExecutionDescriptor,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';
import {
  isOrchestrationMode,
  isTurnOrchestrationSource,
  type TurnOrchestration,
} from '@maka/core/orchestration';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const ROOT_TURN_ADMISSION_SCHEMA_VERSION = 1 as const;
export const ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES = 64;
export const ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES = 64 * 1024;
export const ROOT_TURN_ADMISSION_MAX_RECORD_BYTES = 1024 * 1024;
const ROOT_TURN_ADMISSION_MAX_AGGREGATED_ATTACHMENTS =
  ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES * MAX_ATTACHMENT_COUNT;

export interface RootTurnSourceMessage {
  messageId: string;
  content: MessageContent;
  submittedContentDigest?: `sha256:${string}`;
  placement: 'current_turn' | 'next_turn';
  disposition: 'steering' | 'followup' | 'turn_started';
}

export interface RootTurnAdmission {
  schemaVersion: typeof ROOT_TURN_ADMISSION_SCHEMA_VERSION;
  sessionId: string;
  turnId: string;
  runId: string;
  userMessageId: string | null;
  execution: RootExecutionDescriptor;
  previousRootTurnId: string | null;
  normalizedInput: MessageContent | null;
  turnOrchestration?: TurnOrchestration;
  sourceMessages: readonly RootTurnSourceMessage[];
  admittedAt: number;
}

export interface AdmitRootTurnInput {
  sessionId: string;
  turnId: string;
  proposedRunId: string;
  proposedUserMessageId: string | null;
  execution: RootExecutionDescriptor;
  previousRootTurnId: string | null;
  normalizedInput: MessageContent | null;
  turnOrchestration?: TurnOrchestration;
  sourceMessages: readonly RootTurnSourceMessage[];
  admittedAt: number;
}

export interface RootTurnSourceMessageReceipt {
  admission: RootTurnAdmission;
  sourceMessage: RootTurnSourceMessage;
}

export interface ImmutableSteeringMessageProof {
  event: RuntimeEvent;
}

export type AdmitRootTurnResult =
  | { kind: 'admitted'; admission: RootTurnAdmission }
  | { kind: 'existing'; admission: RootTurnAdmission }
  | { kind: 'conflict'; admission: RootTurnAdmission };

export interface RootTurnAdmissionStore {
  admitRootTurn(input: AdmitRootTurnInput): Promise<AdmitRootTurnResult>;
  readRootTurnAdmission(sessionId: string, turnId: string): Promise<RootTurnAdmission | undefined>;
  readRootTurnSourceMessageReceipt(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined>;
  listRootTurnAdmissionsForRecovery(sessionId: string): Promise<RootTurnAdmission[]>;
}

export interface DurableAgentRunStore extends AgentRunStore, RootTurnAdmissionStore {
  findRunsById(runId: string, limit: number): Promise<AgentRunIdentitySearchResult>;
  listSessionRunsBounded(sessionId: string, limit: number): Promise<AgentRunIdentitySearchResult>;
  readEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<AgentRunEvent>>;
  listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]>;
  readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  readEventsForEvidence(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined>;
  repairEventProjection(
    sessionId: string,
    type: AgentRunEventType,
    event: AgentRunEvent | null,
    options?: { replaceEventId?: string },
  ): Promise<void>;
  ready?(): Promise<void>;
  close?(): void;
}

export interface AgentRunIdentitySearchResult {
  readonly runs: readonly AgentRunHeader[];
  readonly truncated: boolean;
}

export type { BoundedEvidenceReadResult, EvidenceReadBudget } from './bounded-evidence.js';

export interface ConversationCopyRuntimeEventBatch {
  readonly runId: string;
  readonly events: readonly RuntimeEvent[];
}

export interface DurableRuntimeEventStore extends RuntimeEventStore {
  readRuntimeEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<RuntimeEvent>>;
  importConversationCopyRuntimeEvents(
    sessionId: string,
    batches: readonly ConversationCopyRuntimeEventBatch[],
  ): Promise<void>;
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readImmutableSteeringMessageProof(
    sessionId: string,
    messageId: string,
  ): Promise<ImmutableSteeringMessageProof | undefined>;
  repairImmutableSteeringMessageProofsForRecovery(sessionId: string): Promise<void>;
}

interface RuntimePartialSnapshot {
  version: 1;
  event: RuntimeEvent;
  afterEventId?: string;
}

class RuntimeEventPostEffectError extends Error {
  readonly name = 'RuntimeEventPostEffectError';

  constructor(
    message: string,
    readonly cause: DurableStoreWriteError,
  ) {
    super(message);
  }
}

export function createSqliteAgentRunStore(workspaceRoot: string): DurableAgentRunStore {
  return new SqliteAgentRunStore(workspaceRoot);
}

class SqliteAgentRunStore implements DurableAgentRunStore {
  readonly #lease: OperationalStateDatabaseLease;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  async createRun(
    header: AgentRunHeader,
    _options: { durable?: boolean } = {},
  ): Promise<AgentRunHeader> {
    const normalized = normalizeAgentRunHeader(header, header.sessionId, header.runId);
    this.#lease.transaction('write', () => {
      const inserted = this.#lease.database
        .prepare(`
          INSERT OR IGNORE INTO core_agent_runs(
            session_id, run_id, created_at, record_json
          ) VALUES (?, ?, ?, ?)
        `)
        .run(
          normalized.sessionId,
          normalized.runId,
          normalized.createdAt,
          JSON.stringify(normalized, sanitizeJson),
        );
      if (inserted.changes !== 1) {
        throw new Error(`Agent run already exists: ${normalized.runId}`);
      }
      const count = this.#lease.database
        .prepare('SELECT COUNT(*) AS count FROM core_agent_runs WHERE session_id = ?')
        .get(normalized.sessionId) as { count?: unknown };
      const projection = this.#lease.database
        .prepare(`
          SELECT 1 AS present
          FROM core_agent_run_projections
          WHERE session_id = ? AND event_type = 'history_compact_checkpoint_recorded'
        `)
        .get(normalized.sessionId);
      if (count.count === 1 && !projection) {
        this.#lease.database
          .prepare(`
            INSERT INTO core_agent_run_projections(session_id, event_type, event_json)
            VALUES (?, 'history_compact_checkpoint_recorded', NULL)
          `)
          .run(normalized.sessionId);
      }
    });
    return normalized;
  }

  async updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<AgentRunHeader>,
    _options: { durable?: boolean } = {},
  ): Promise<AgentRunHeader> {
    assertMutableRunHeaderPatch(patch);
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return this.#lease.transaction('write', () => {
      const current = readSqliteAgentRun(this.#lease.database, sessionId, runId);
      const next = normalizeAgentRunHeader(
        { ...current, ...patch, sessionId, runId },
        sessionId,
        runId,
      );
      const result = this.#lease.database
        .prepare(`
          UPDATE core_agent_runs
          SET created_at = ?, record_json = ?
          WHERE session_id = ? AND run_id = ?
        `)
        .run(next.createdAt, JSON.stringify(next, sanitizeJson), sessionId, runId);
      if (result.changes !== 1) throw new Error(`Failed to update run ${runId}`);
      return next;
    });
  }

  async readRun(sessionId: string, runId: string): Promise<AgentRunHeader> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return readSqliteAgentRun(this.#lease.database, sessionId, runId);
  }

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    return this.listSessionRunsForRecovery(sessionId);
  }

  async findRunsById(runId: string, limit: number): Promise<AgentRunIdentitySearchResult> {
    assertSafeId(runId, 'Invalid run id');
    assertIdentitySearchLimit(limit);
    const rows = this.#lease.database
      .prepare(`
        SELECT session_id, record_json
        FROM core_agent_runs
        WHERE run_id = ?
        ORDER BY session_id
        LIMIT ?
      `)
      .all(runId, limit + 1) as Array<{ session_id?: unknown; record_json?: unknown }>;
    const truncated = rows.length > limit;
    const runs = rows.slice(0, limit).map((row) => {
      if (typeof row.session_id !== 'string' || typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite AgentRun identity row');
      }
      return normalizeAgentRunHeader(JSON.parse(row.record_json), row.session_id, runId);
    });
    return { runs, truncated };
  }

  async listSessionRunsBounded(
    sessionId: string,
    limit: number,
  ): Promise<AgentRunIdentitySearchResult> {
    assertSafeId(sessionId, 'Invalid session id');
    assertIdentitySearchLimit(limit);
    const rows = this.#lease.database
      .prepare(`
        SELECT run_id, record_json
        FROM core_agent_runs
        WHERE session_id = ?
        ORDER BY created_at, run_id
        LIMIT ?
      `)
      .all(sessionId, limit + 1) as Array<{ run_id?: unknown; record_json?: unknown }>;
    const truncated = rows.length > limit;
    const runs = rows.slice(0, limit).map((row) => {
      if (typeof row.run_id !== 'string' || typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite AgentRun row');
      }
      return normalizeAgentRunHeader(JSON.parse(row.record_json), sessionId, row.run_id);
    });
    return { runs, truncated };
  }

  async listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const rows = this.#lease.database
      .prepare(`
        SELECT run_id, record_json
        FROM core_agent_runs
        WHERE session_id = ?
        ORDER BY created_at, run_id
      `)
      .all(sessionId) as Array<{ run_id?: unknown; record_json?: unknown }>;
    return rows.map((row) => {
      if (typeof row.run_id !== 'string' || typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite AgentRun row');
      }
      return normalizeAgentRunHeader(JSON.parse(row.record_json), sessionId, row.run_id);
    });
  }

  async appendEvent(
    sessionId: string,
    runId: string,
    event: EmittedAgentRunEvent,
    _options: { durable?: boolean } = {},
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    this.#lease.transaction('write', () => {
      const header = readSqliteAgentRun(this.#lease.database, sessionId, runId);
      const normalized = decodeAgentRunEvent(JSON.parse(JSON.stringify(event, sanitizeJson)), {
        sessionId,
        runId,
        turnId: header.turnId,
      });
      const projection =
        normalized.type === 'history_compact_checkpoint_recorded'
          ? readSqliteAgentRunProjection(this.#lease.database, sessionId, normalized.type)
          : undefined;
      insertAgentRunEvent(this.#lease.database, normalized);
      if (normalized.type === 'history_compact_checkpoint_recorded') {
        const projected = shouldPreserveCheckpointProjectionDuringAppend(projection, normalized)
          ? projection!
          : normalized;
        writeSqliteAgentRunProjection(this.#lease.database, sessionId, normalized.type, projected);
      }
    });
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.readEventsForRecovery(sessionId, runId);
  }

  async readEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<AgentRunEvent>> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    assertEvidenceReadBudget(budget);
    const rows = this.#lease.database
      .prepare(`
        SELECT length(CAST(record_json AS BLOB)) AS stored_bytes
        FROM core_agent_run_events
        WHERE session_id = ? AND run_id = ?
        ORDER BY sequence
        LIMIT ?
      `)
      .all(sessionId, runId, budget.maxRecords + 1) as Array<{ stored_bytes?: unknown }>;
    const measurement = measureEvidenceRows(
      rows,
      budget,
      'Invalid SQLite AgentRun evidence measurement row',
    );
    if (!measurement) return { status: 'limit_exceeded' };
    return {
      status: 'complete',
      records: readSqliteAgentRunEventsForEvidence(this.#lease.database, sessionId, runId),
      ...measurement,
    };
  }

  async readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return readSqliteAgentRunEvents(this.#lease.database, sessionId, runId);
  }

  async readEventsForEvidence(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return readSqliteAgentRunEventsForEvidence(this.#lease.database, sessionId, runId);
  }

  async readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    return readSqliteAgentRunProjection(this.#lease.database, sessionId, type);
  }

  async repairEventProjection(
    sessionId: string,
    type: AgentRunEventType,
    event: AgentRunEvent | null,
    options: { replaceEventId?: string } = {},
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    if (event !== null && !isProjectedAgentRunEvent(event, sessionId, type)) {
      throw new Error(`Invalid AgentRun event projection repair for ${type}`);
    }
    this.#lease.transaction('write', () => {
      const current = readSqliteAgentRunProjection(this.#lease.database, sessionId, type);
      if (
        current?.id !== options.replaceEventId &&
        shouldPreserveProjectionDuringRepair(current, event, type)
      ) {
        return;
      }
      writeSqliteAgentRunProjection(this.#lease.database, sessionId, type, event);
    });
  }

  async admitRootTurn(input: AdmitRootTurnInput): Promise<AdmitRootTurnResult> {
    const admission = normalizeAdmitRootTurnInput(input);
    return this.#lease.transaction('write', () => {
      const existing = readSqliteRootTurnAdmission(
        this.#lease.database,
        admission.sessionId,
        admission.turnId,
      );
      if (existing) {
        return existing.previousRootTurnId === input.previousRootTurnId &&
          rootTurnAdmissionPayloadsEqual(existing, admission)
          ? { kind: 'existing', admission: existing }
          : { kind: 'conflict', admission: existing };
      }
      for (const source of admission.sourceMessages) {
        const proof = this.#lease.database
          .prepare(`
            SELECT turn_id
            FROM core_root_source_message_proofs
            WHERE session_id = ? AND message_id = ?
          `)
          .get(admission.sessionId, source.messageId) as { turn_id?: unknown } | undefined;
        if (proof && proof.turn_id !== admission.turnId) {
          throw new Error(
            `Root source message identity belongs to both ${String(proof.turn_id)} and ${admission.turnId}`,
          );
        }
      }
      this.#lease.database
        .prepare(`
          INSERT INTO core_root_turn_admissions(
            session_id, turn_id, admitted_at, record_json
          ) VALUES (?, ?, ?, ?)
        `)
        .run(
          admission.sessionId,
          admission.turnId,
          admission.admittedAt,
          JSON.stringify(admission),
        );
      for (const source of admission.sourceMessages) {
        this.#lease.database
          .prepare(`
            INSERT INTO core_root_source_message_proofs(session_id, message_id, turn_id)
            VALUES (?, ?, ?)
          `)
          .run(admission.sessionId, source.messageId, admission.turnId);
      }
      return { kind: 'admitted', admission };
    });
  }

  async readRootTurnAdmission(
    sessionId: string,
    turnId: string,
  ): Promise<RootTurnAdmission | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(turnId, 'Invalid turn id');
    return readSqliteRootTurnAdmission(this.#lease.database, sessionId, turnId);
  }

  async readRootTurnSourceMessageReceipt(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(sourceMessageId, 'Invalid source message id');
    const row = this.#lease.database
      .prepare(`
        SELECT turn_id
        FROM core_root_source_message_proofs
        WHERE session_id = ? AND message_id = ?
      `)
      .get(sessionId, sourceMessageId) as { turn_id?: unknown } | undefined;
    if (!row) return undefined;
    if (typeof row.turn_id !== 'string') throw new Error('Invalid root source message proof row');
    const admission = readSqliteRootTurnAdmission(this.#lease.database, sessionId, row.turn_id);
    if (!admission) {
      throw new Error(`Root source message proof references missing Turn ${row.turn_id}`);
    }
    const matches = admission.sourceMessages.filter(
      (source) => source.messageId === sourceMessageId,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Root source message proof does not identify exactly one source: ${sourceMessageId}`,
      );
    }
    return Object.freeze({ admission, sourceMessage: matches[0]! });
  }

  async listRootTurnAdmissionsForRecovery(sessionId: string): Promise<RootTurnAdmission[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const rows = this.#lease.database
      .prepare(`
        SELECT turn_id, record_json
        FROM core_root_turn_admissions
        WHERE session_id = ?
        ORDER BY admitted_at, turn_id
      `)
      .all(sessionId) as Array<{ turn_id?: unknown; record_json?: unknown }>;
    const admissions = rows.map((row) => {
      if (typeof row.turn_id !== 'string' || typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite root turn admission row');
      }
      return normalizeRootTurnAdmission(JSON.parse(row.record_json), sessionId, row.turn_id);
    });
    return orderRootTurnAdmissionChain(sessionId, admissions);
  }

  close(): void {
    this.#lease.close();
  }
}

function normalizeAgentRunHeader(value: unknown, sessionId: string, runId: string): AgentRunHeader {
  assertSafeId(sessionId, 'Invalid session id');
  assertSafeId(runId, 'Invalid run id');
  return decodeAgentRunHeader(JSON.parse(JSON.stringify(value, sanitizeJson)), {
    sessionId,
    runId,
  });
}

function readSqliteAgentRun(db: DatabaseSync, sessionId: string, runId: string): AgentRunHeader {
  const row = db
    .prepare(`
      SELECT record_json
      FROM core_agent_runs
      WHERE session_id = ? AND run_id = ?
    `)
    .get(sessionId, runId) as { record_json?: unknown } | undefined;
  if (!row) {
    const error = new Error(`Agent run does not exist: ${runId}`) as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  }
  if (typeof row.record_json !== 'string') throw new Error('Invalid SQLite AgentRun row');
  return normalizeAgentRunHeader(JSON.parse(row.record_json), sessionId, runId);
}

function readSqliteAgentRunEvents(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
): AgentRunEvent[] {
  const rows = db
    .prepare(`
      SELECT record_json
      FROM core_agent_run_events
      WHERE session_id = ? AND run_id = ?
      ORDER BY sequence
    `)
    .all(sessionId, runId) as Array<{ record_json?: unknown }>;
  if (rows.length === 0) return [];
  const header = readSqliteAgentRun(db, sessionId, runId);
  return rows.map((row) => {
    if (typeof row.record_json !== 'string') {
      throw new Error('Invalid SQLite AgentRun event row');
    }
    return decodeAgentRunEvent(JSON.parse(row.record_json), {
      sessionId,
      runId,
      turnId: header.turnId,
    });
  });
}

function readSqliteAgentRunEventsForEvidence(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
): AgentRunEvent[] {
  const rows = db
    .prepare(`
      SELECT sequence, record_json
      FROM core_agent_run_events
      WHERE session_id = ? AND run_id = ?
      ORDER BY sequence
    `)
    .all(sessionId, runId) as Array<{ sequence?: unknown; record_json?: unknown }>;
  if (rows.length === 0) return [];
  const header = readSqliteAgentRun(db, sessionId, runId);
  return rows.map((row) => {
    const lineNumber =
      typeof row.sequence === 'number' && Number.isSafeInteger(row.sequence) ? row.sequence + 1 : 0;
    try {
      if (typeof row.record_json !== 'string') {
        throw new Error('Invalid SQLite AgentRun event row');
      }
      return decodeAgentRunEvent(JSON.parse(row.record_json), {
        sessionId,
        runId,
        turnId: header.turnId,
      });
    } catch (error) {
      return {
        type: 'event_corrupt',
        id: `run-event-corrupt-${lineNumber}`,
        runId,
        sessionId,
        turnId: header.turnId,
        ts: header.updatedAt,
        message: error instanceof Error ? error.message : 'Invalid SQLite AgentRun event row',
        data: { lineNumber },
      };
    }
  });
}

function insertAgentRunEvent(db: DatabaseSync, event: AgentRunEvent): void {
  const row = db
    .prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM core_agent_run_events
      WHERE session_id = ? AND run_id = ?
    `)
    .get(event.sessionId, event.runId) as { sequence?: unknown };
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)) {
    throw new Error('Invalid next AgentRun event sequence');
  }
  db.prepare(`
    INSERT INTO core_agent_run_events(
      session_id, run_id, sequence, event_id, event_type, event_ts, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.sessionId,
    event.runId,
    row.sequence,
    event.id,
    event.type,
    event.ts,
    JSON.stringify(event, sanitizeJson),
  );
}

function readSqliteAgentRunProjection(
  db: DatabaseSync,
  sessionId: string,
  type: AgentRunEventType,
): AgentRunEvent | null | undefined {
  const row = db
    .prepare(`
      SELECT event_json
      FROM core_agent_run_projections
      WHERE session_id = ? AND event_type = ?
    `)
    .get(sessionId, type) as { event_json?: unknown } | undefined;
  if (!row) return undefined;
  if (row.event_json === null) return null;
  if (typeof row.event_json !== 'string') {
    throw new Error(`Invalid AgentRun event projection for ${type}`);
  }
  const event = JSON.parse(row.event_json);
  if (!isProjectedAgentRunEvent(event, sessionId, type)) {
    throw new Error(`Invalid AgentRun event projection for ${type}`);
  }
  return event;
}

function writeSqliteAgentRunProjection(
  db: DatabaseSync,
  sessionId: string,
  type: AgentRunEventType,
  event: AgentRunEvent | null,
): void {
  db.prepare(`
    INSERT INTO core_agent_run_projections(session_id, event_type, event_json)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, event_type) DO UPDATE SET event_json = excluded.event_json
  `).run(sessionId, type, event === null ? null : JSON.stringify(event, sanitizeJson));
}

function readSqliteRootTurnAdmission(
  db: DatabaseSync,
  sessionId: string,
  turnId: string,
): RootTurnAdmission | undefined {
  const row = db
    .prepare(`
      SELECT record_json
      FROM core_root_turn_admissions
      WHERE session_id = ? AND turn_id = ?
    `)
    .get(sessionId, turnId) as { record_json?: unknown } | undefined;
  if (!row) return undefined;
  if (typeof row.record_json !== 'string') throw new Error('Invalid root turn admission row');
  return normalizeRootTurnAdmission(JSON.parse(row.record_json), sessionId, turnId);
}

function normalizeAdmitRootTurnInput(input: AdmitRootTurnInput): RootTurnAdmission {
  assertSafeId(input.sessionId, 'Invalid session id');
  assertSafeId(input.turnId, 'Invalid turn id');
  assertSafeId(input.proposedRunId, 'Invalid run id');
  if (input.proposedUserMessageId !== null) {
    assertSafeId(input.proposedUserMessageId, 'Invalid user message id');
  }
  if (input.previousRootTurnId !== null) {
    assertSafeId(input.previousRootTurnId, 'Invalid previous root turn id');
    if (input.previousRootTurnId === input.turnId) {
      throw new Error('Root turn admission cannot reference itself');
    }
  }
  if (!Number.isSafeInteger(input.admittedAt) || input.admittedAt < 0) {
    throw new Error('Invalid root turn admission timestamp');
  }
  const { normalizedInput, sourceMessages } = normalizeRootTurnAdmissionPayload(
    input.normalizedInput,
    input.sourceMessages,
  );
  const turnOrchestration = normalizeTurnOrchestration(input.turnOrchestration);
  const admission: RootTurnAdmission = {
    schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.proposedRunId,
    userMessageId: input.proposedUserMessageId,
    execution: normalizeRootExecutionDescriptor(input.execution),
    previousRootTurnId: input.previousRootTurnId,
    normalizedInput,
    ...(turnOrchestration ? { turnOrchestration } : {}),
    sourceMessages,
    admittedAt: input.admittedAt,
  };
  assertRootTurnAdmissionContract(admission);
  assertRootTurnAdmissionRecordSize(admission);
  return deepFreezeRootTurnAdmission(admission);
}

const MUTABLE_AGENT_RUN_HEADER_FIELDS = new Set<keyof AgentRunHeader>([
  'status',
  'updatedAt',
  'completedAt',
  'failureClass',
  'failureMessage',
  'abortSource',
  'traceWriteError',
]);

function assertMutableRunHeaderPatch(patch: Partial<AgentRunHeader>): void {
  const immutable = Object.keys(patch).filter(
    (key) => !MUTABLE_AGENT_RUN_HEADER_FIELDS.has(key as keyof AgentRunHeader),
  );
  if (immutable.length > 0) {
    throw new Error(`AgentRun admission identity is immutable: ${immutable.sort().join(', ')}`);
  }
}

function shouldPreserveCheckpointProjectionDuringAppend(
  current: AgentRunEvent | null | undefined,
  candidate: AgentRunEvent,
): boolean {
  if (!current) return false;
  const currentSourceBound = historyCompactProjectionIsSourceBound(current);
  const candidateSourceBound = historyCompactProjectionIsSourceBound(candidate);
  if (currentSourceBound !== candidateSourceBound) return currentSourceBound;
  const currentCoverage = historyCompactProjectionCoverage(current);
  const candidateCoverage = historyCompactProjectionCoverage(candidate);
  return (
    currentCoverage !== undefined &&
    (candidateCoverage === undefined || currentCoverage > candidateCoverage)
  );
}

function shouldPreserveProjectionDuringRepair(
  current: AgentRunEvent | null | undefined,
  candidate: AgentRunEvent | null,
  type: AgentRunEventType,
): boolean {
  if (!current) return false;
  if (type !== 'history_compact_checkpoint_recorded') return true;
  const currentSourceBound = historyCompactProjectionIsSourceBound(current);
  const candidateSourceBound = candidate ? historyCompactProjectionIsSourceBound(candidate) : false;
  if (currentSourceBound !== candidateSourceBound) return currentSourceBound;
  const currentCoverage = historyCompactProjectionCoverage(current);
  const candidateCoverage = candidate && historyCompactProjectionCoverage(candidate);
  return (
    currentCoverage !== undefined &&
    (candidateCoverage === null ||
      candidateCoverage === undefined ||
      currentCoverage >= candidateCoverage)
  );
}

function historyCompactProjectionIsSourceBound(event: AgentRunEvent): boolean {
  const checkpoint = event.data?.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  const source = (checkpoint as { source?: unknown }).source;
  if (!source || typeof source !== 'object') return false;
  return (source as { kind?: unknown }).kind === 'runtime_event_projection';
}

function assertNoReservedToolLedgerFact(event: RuntimeEvent): void {
  assertNoReservedWorkspaceAuthorityAppend(event);
  if (event.actions?.continuationStart !== undefined) {
    throw new Error('Continuation start facts require SQLite continuation authority');
  }
  const validation = validateGenericToolLedgerAppend(event);
  if (validation.ok) return;
  if (validation.code === 'reserved_recovery_fact') {
    throw new Error('Tool recovery facts require the atomic recovery bundle writer');
  }
  if (validation.code === 'reserved_tool_boundary_fact') {
    throw new Error('Durable tool facts require the atomic tool boundary writer');
  }
  throw new Error(`RuntimeEvent ${event.id} violates its semantic lane`);
}

function canonicalizeRuntimeEventForStorage(event: RuntimeEvent): RuntimeEvent {
  return encodeCanonicalRuntimeEvent(event).event;
}

function isToolLedgerBearingEvent(event: RuntimeEvent): boolean {
  return (
    event.content?.kind === 'function_call' ||
    event.content?.kind === 'function_response' ||
    event.actions?.toolDispatch !== undefined ||
    event.actions?.toolRecovery !== undefined
  );
}

function historyCompactProjectionCoverage(event: AgentRunEvent): number | undefined {
  const checkpoint = event.data?.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return undefined;
  const coverage = (checkpoint as { coverage?: unknown }).coverage;
  if (!coverage || typeof coverage !== 'object') return undefined;
  const eventCount = (coverage as { eventCount?: unknown }).eventCount;
  return typeof eventCount === 'number' && Number.isSafeInteger(eventCount) && eventCount >= 0
    ? eventCount
    : undefined;
}

function isProjectedAgentRunEvent(
  value: unknown,
  sessionId: string,
  type: AgentRunEventType,
): value is AgentRunEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<AgentRunEvent>;
  return (
    event.type === type &&
    event.sessionId === sessionId &&
    typeof event.id === 'string' &&
    typeof event.runId === 'string' &&
    typeof event.turnId === 'string' &&
    Number.isFinite(event.ts)
  );
}

function assertSafeId(value: string, message: string): void {
  if (!isSafeId(value)) throw new Error(message);
}

function assertIdentitySearchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new RangeError('AgentRun identity search limit must be an integer between 1 and 256');
  }
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

function isGraphControlIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function normalizeRootTurnAdmission(
  value: unknown,
  sessionId: string,
  turnId: string,
): RootTurnAdmission {
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid root turn admission for turn ${turnId}: expected an object`);
  }
  const record = value;
  const valid =
    record.schemaVersion === ROOT_TURN_ADMISSION_SCHEMA_VERSION &&
    record.sessionId === sessionId &&
    record.turnId === turnId &&
    typeof record.runId === 'string' &&
    isSafeId(record.runId) &&
    (record.userMessageId === null ||
      (typeof record.userMessageId === 'string' && isSafeId(record.userMessageId))) &&
    (record.previousRootTurnId === null ||
      (typeof record.previousRootTurnId === 'string' &&
        isSafeId(record.previousRootTurnId) &&
        record.previousRootTurnId !== turnId)) &&
    Number.isSafeInteger(record.admittedAt) &&
    (record.admittedAt as number) >= 0 &&
    hasRootTurnAdmissionKeys(record);
  if (!valid) {
    throw new Error(`Invalid root turn admission for turn ${turnId}: malformed fields`);
  }
  const { normalizedInput, sourceMessages } = normalizeRootTurnAdmissionPayload(
    record.normalizedInput,
    record.sourceMessages,
  );
  const turnOrchestration = normalizeTurnOrchestration(record.turnOrchestration);
  const admission: RootTurnAdmission = {
    schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
    sessionId,
    turnId,
    runId: record.runId as string,
    userMessageId: record.userMessageId as string | null,
    execution: normalizeRootExecutionDescriptor(record.execution),
    previousRootTurnId: record.previousRootTurnId as string | null,
    normalizedInput,
    ...(turnOrchestration ? { turnOrchestration } : {}),
    sourceMessages,
    admittedAt: record.admittedAt as number,
  };
  assertRootTurnAdmissionContract(admission);
  assertRootTurnAdmissionRecordSize(admission);
  return deepFreezeRootTurnAdmission(admission);
}

function decodeRootSourceMessageProofPointer(
  value: unknown,
  sessionId: string,
  messageId: string,
): { readonly turnId: string } {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'sessionId', 'messageId', 'turnId']) ||
    value.schemaVersion !== 1 ||
    value.sessionId !== sessionId ||
    value.messageId !== messageId ||
    typeof value.turnId !== 'string' ||
    !isSafeId(value.turnId)
  ) {
    throw new Error(`Invalid root source message proof: ${messageId}`);
  }
  return Object.freeze({ turnId: value.turnId });
}

function orderRootTurnAdmissionChain(
  sessionId: string,
  admissions: readonly RootTurnAdmission[],
): RootTurnAdmission[] {
  if (admissions.length === 0) return [];
  const byTurnId = new Map(admissions.map((admission) => [admission.turnId, admission]));
  if (byTurnId.size !== admissions.length) {
    throw new Error(`Session ${sessionId} has duplicate root turn admissions`);
  }
  for (const admission of admissions) {
    const predecessor = admission.previousRootTurnId;
    if (predecessor !== null && !byTurnId.has(predecessor)) {
      throw new Error(
        `Root turn admission ${admission.turnId} has missing predecessor ${predecessor}`,
      );
    }
  }
  const roots = admissions.filter((admission) => admission.previousRootTurnId === null);
  if (roots.length !== 1) {
    throw new Error(`Session ${sessionId} must have exactly one root turn admission root`);
  }
  const childByTurnId = new Map<string, RootTurnAdmission>();
  for (const admission of admissions) {
    const predecessor = admission.previousRootTurnId;
    if (predecessor === null) continue;
    const existing = childByTurnId.get(predecessor);
    if (existing) {
      throw new Error(
        `Root turn admission ${predecessor} branches to ${existing.turnId} and ${admission.turnId}`,
      );
    }
    childByTurnId.set(predecessor, admission);
  }

  const ordered: RootTurnAdmission[] = [];
  let current: RootTurnAdmission | undefined = roots[0];
  while (current) {
    ordered.push(current);
    current = childByTurnId.get(current.turnId);
  }
  if (ordered.length !== admissions.length) {
    throw new Error(`Session ${sessionId} root turn admissions do not form one linear chain`);
  }
  return ordered;
}

function normalizeRootTurnMessageContent(
  value: unknown,
  description: string,
  maxAttachments: number,
): MessageContent {
  let normalized: MessageContent;
  try {
    normalized = decodeMessageContent(value);
  } catch {
    if (isPlainRecord(value) && Array.isArray(value.attachments)) {
      const invalidAttachmentIndex = value.attachments.findIndex(
        (attachment) => !isCanonicalAttachmentRef(attachment),
      );
      if (invalidAttachmentIndex >= 0) {
        throw new Error(`Invalid ${description} attachment at index ${invalidAttachmentIndex}`);
      }
    }
    throw new Error(`Invalid ${description}`);
  }
  if (normalized.text.length === 0 || (normalized.attachments?.length ?? 0) > maxAttachments) {
    throw new Error(`Invalid ${description}`);
  }
  for (const [index, attachment] of (normalized.attachments ?? []).entries()) {
    if (!isValidRootTurnAttachment(attachment)) {
      throw new Error(`Invalid ${description} attachment at index ${index}`);
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') > ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES
  ) {
    throw new Error(`Invalid ${description}: content exceeds size limit`);
  }
  deepFreezeRootTurnMessageContent(normalized);
  return normalized;
}

function isValidRootTurnAttachment(attachment: AttachmentRef): boolean {
  return isCanonicalAttachmentRef(attachment) && attachment.bytes <= MAX_ATTACHMENT_BYTES;
}

export function normalizeRootTurnAdmissionPayload(
  normalizedInputValue: MessageContent,
  sourceMessagesValue: unknown,
): {
  normalizedInput: MessageContent;
  sourceMessages: readonly RootTurnSourceMessage[];
};
export function normalizeRootTurnAdmissionPayload(
  normalizedInputValue: null,
  sourceMessagesValue: unknown,
): {
  normalizedInput: null;
  sourceMessages: readonly RootTurnSourceMessage[];
};
export function normalizeRootTurnAdmissionPayload(
  normalizedInputValue: unknown,
  sourceMessagesValue: unknown,
): {
  normalizedInput: MessageContent | null;
  sourceMessages: readonly RootTurnSourceMessage[];
};
export function normalizeRootTurnAdmissionPayload(
  normalizedInputValue: unknown,
  sourceMessagesValue: unknown,
): {
  normalizedInput: MessageContent | null;
  sourceMessages: readonly RootTurnSourceMessage[];
} {
  const sourceMessages = normalizeRootTurnSourceMessages(sourceMessagesValue);
  if (normalizedInputValue === null) {
    if (sourceMessages.length > 0) {
      throw new Error('Root turn admission without input cannot have source messages');
    }
    return { normalizedInput: null, sourceMessages };
  }
  const normalizedInputMaxAttachments =
    sourceMessages.length > 1
      ? ROOT_TURN_ADMISSION_MAX_AGGREGATED_ATTACHMENTS
      : MAX_ATTACHMENT_COUNT;
  const normalizedInput = normalizeRootTurnMessageContent(
    normalizedInputValue,
    'root turn normalized input',
    normalizedInputMaxAttachments,
  );
  if (sourceMessages.length > 0) {
    const expectedInput = normalizeRootTurnMessageContent(
      aggregateMessageContents(sourceMessages.map((source) => source.content)),
      'root turn aggregated source content',
      normalizedInputMaxAttachments,
    );
    if (!messageContentsEqual(normalizedInput, expectedInput)) {
      throw new Error('Root turn admission input content does not match source messages');
    }
  }
  const turnStartedCount = sourceMessages.filter(
    (source) => source.disposition === 'turn_started',
  ).length;
  if (turnStartedCount > 0 && (turnStartedCount !== 1 || sourceMessages.length !== 1)) {
    throw new Error('Root turn admission turn_started source must be the only source message');
  }
  return { normalizedInput, sourceMessages };
}

function normalizeRootTurnSourceMessages(value: unknown): readonly RootTurnSourceMessage[] {
  if (!Array.isArray(value) || value.length > ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES) {
    throw new Error('Invalid root turn source messages: expected a bounded array');
  }
  const messageIds = new Set<string>();
  const normalized = value.map((item, index): RootTurnSourceMessage => {
    if (
      !isPlainRecord(item) ||
      !hasExactKeys(item, [
        'messageId',
        'content',
        'placement',
        'disposition',
        ...(Object.hasOwn(item, 'submittedContentDigest') ? ['submittedContentDigest'] : []),
      ])
    ) {
      throw new Error(`Invalid root turn source message at index ${index}`);
    }
    const { messageId, content, submittedContentDigest, placement, disposition } = item;
    if (
      typeof messageId !== 'string' ||
      !isSafeId(messageId) ||
      (placement !== 'current_turn' && placement !== 'next_turn') ||
      (disposition !== 'steering' &&
        disposition !== 'followup' &&
        disposition !== 'turn_started') ||
      (disposition === 'steering' && placement !== 'current_turn') ||
      (disposition === 'followup' && placement !== 'next_turn') ||
      (submittedContentDigest !== undefined && !isSha256Digest(submittedContentDigest))
    ) {
      throw new Error(`Invalid root turn source message at index ${index}`);
    }
    if (messageIds.has(messageId)) {
      throw new Error(`Duplicate root turn source message id: ${messageId}`);
    }
    messageIds.add(messageId);
    return Object.freeze({
      messageId,
      content: normalizeRootTurnMessageContent(
        content,
        `root turn source message content at index ${index}`,
        MAX_ATTACHMENT_COUNT,
      ),
      ...(submittedContentDigest !== undefined ? { submittedContentDigest } : {}),
      placement,
      disposition,
    });
  });
  return Object.freeze(normalized);
}

function rootTurnAdmissionPayloadsEqual(
  left: RootTurnAdmission,
  right: RootTurnAdmission,
): boolean {
  return (
    isDeepStrictEqual(left.execution, right.execution) &&
    isDeepStrictEqual(left.turnOrchestration, right.turnOrchestration) &&
    (left.normalizedInput === null || right.normalizedInput === null
      ? left.normalizedInput === right.normalizedInput
      : messageContentsEqual(left.normalizedInput, right.normalizedInput)) &&
    left.sourceMessages.length === right.sourceMessages.length &&
    left.sourceMessages.every((source, index) => {
      const other = right.sourceMessages[index];
      return (
        other !== undefined &&
        source.messageId === other.messageId &&
        source.placement === other.placement &&
        source.disposition === other.disposition &&
        source.submittedContentDigest === other.submittedContentDigest &&
        messageContentsEqual(source.content, other.content)
      );
    })
  );
}

function assertRootTurnAdmissionRecordSize(admission: RootTurnAdmission): void {
  assertRootTurnAdmissionSerializedSize(`${JSON.stringify(admission)}\n`);
}

function assertRootTurnAdmissionSerializedSize(serialized: string): void {
  if (Buffer.byteLength(serialized, 'utf8') > ROOT_TURN_ADMISSION_MAX_RECORD_BYTES) {
    throw new Error('Invalid root turn admission: record exceeds size limit');
  }
}

function assertRootTurnAdmissionContract(admission: RootTurnAdmission): void {
  const execution = admission.execution;
  const providerRetry = execution.kind === 'linked_child_provider_retry';
  const inputlessExecution =
    execution.kind === 'safe_boundary_continuation' || execution.kind === 'context_compact';
  const messageLessExecution = inputlessExecution || providerRetry;
  if (execution.kind === 'agent_graph_supervisor_wake') {
    if (
      admission.turnOrchestration?.mode !== 'graph' ||
      admission.turnOrchestration.source !== 'host_api'
    ) {
      throw new Error(
        'Invalid root turn admission contract: Agent Graph supervisor wake requires Host Graph orchestration',
      );
    }
  } else if (admission.turnOrchestration && execution.kind !== 'external_message') {
    throw new Error(
      'Invalid root turn admission contract: orchestration override is not authorized for this execution',
    );
  }
  if ((admission.userMessageId === null) !== messageLessExecution) {
    throw new Error(
      'Invalid root turn admission contract: execution has an invalid UserMessage requirement',
    );
  }
  if ((admission.normalizedInput === null) !== inputlessExecution) {
    throw new Error(
      'Invalid root turn admission contract: execution has an invalid input requirement',
    );
  }
  if (execution.kind !== 'external_message' && admission.sourceMessages.length !== 0) {
    throw new Error(
      'Invalid root turn admission contract: host-authored execution cannot have source messages',
    );
  }
  if (execution.kind === 'claimed_agent_graph_intent') {
    if (
      execution.claim.targetSessionId !== admission.sessionId ||
      execution.claim.targetTurnId !== admission.turnId ||
      execution.claim.targetRunId !== admission.runId
    ) {
      throw new Error(
        'Invalid root turn admission contract: agent graph claim target does not match admission identity',
      );
    }
    if (admission.userMessageId === null) {
      throw new Error(
        'Invalid root turn admission contract: agent graph execution requires a UserMessage',
      );
    }
  }
  if (
    (execution.kind === 'linked_child_resume' ||
      execution.kind === 'linked_child_provider_retry') &&
    execution.sourceRunId === admission.runId
  ) {
    throw new Error(
      'Invalid root turn admission contract: linked child source Run cannot be the admitted Run',
    );
  }
  if (
    execution.kind === 'safe_boundary_continuation' &&
    (execution.sourceRunId === admission.runId ||
      execution.sourceTurnId === admission.turnId ||
      execution.sourceInvocationId === execution.targetInvocationId ||
      admission.normalizedInput !== null)
  ) {
    throw new Error(
      'Invalid root turn admission contract: safe-boundary continuation identity is invalid',
    );
  }
  if (execution.kind === 'regenerate' && execution.sourceTurnId === admission.turnId) {
    throw new Error(
      'Invalid root turn admission contract: regenerate source Turn cannot be the admitted Turn',
    );
  }
  if (
    execution.kind === 'external_message' &&
    admission.sourceMessages.some(
      (source) =>
        source.disposition === 'turn_started' && source.messageId !== admission.userMessageId,
    )
  ) {
    throw new Error(
      'Invalid root turn admission contract: turn-started source must own the UserMessage',
    );
  }
}

function deepFreezeRootTurnAdmission(admission: RootTurnAdmission): RootTurnAdmission {
  if (admission.execution.kind === 'claimed_agent_graph_intent') {
    Object.freeze(admission.execution.claim);
  }
  Object.freeze(admission.execution);
  if (admission.turnOrchestration) Object.freeze(admission.turnOrchestration);
  if (admission.normalizedInput) deepFreezeRootTurnMessageContent(admission.normalizedInput);
  for (const sourceMessage of admission.sourceMessages) {
    deepFreezeRootTurnMessageContent(sourceMessage.content);
    Object.freeze(sourceMessage);
  }
  Object.freeze(admission.sourceMessages);
  return Object.freeze(admission);
}

function normalizeTurnOrchestration(value: unknown): TurnOrchestration | undefined {
  if (value === undefined) return undefined;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['mode', 'source']) ||
    !isOrchestrationMode(value.mode) ||
    !isTurnOrchestrationSource(value.source)
  ) {
    throw new Error('Invalid root turn orchestration');
  }
  return Object.freeze({ mode: value.mode, source: value.source });
}

function hasRootTurnAdmissionKeys(record: Record<string, unknown>): boolean {
  const keys = [
    'schemaVersion',
    'sessionId',
    'turnId',
    'runId',
    'userMessageId',
    'execution',
    'previousRootTurnId',
    'normalizedInput',
    'sourceMessages',
    'admittedAt',
  ];
  return hasExactKeys(record, keys) || hasExactKeys(record, [...keys, 'turnOrchestration']);
}

function normalizeRootExecutionDescriptor(value: unknown): RootExecutionDescriptor {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Invalid root execution descriptor');
  }
  if (value.kind === 'external_message') {
    const allowedKeys = ['kind', 'inputDigest'];
    if (!Object.keys(value).every((key) => allowedKeys.includes(key))) {
      throw new Error('Invalid root execution descriptor');
    }
    if (value.inputDigest !== undefined && !isSha256Digest(value.inputDigest)) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({
      kind: 'external_message',
      ...(value.inputDigest !== undefined ? { inputDigest: value.inputDigest } : {}),
    });
  }
  if (value.kind === 'regenerate') {
    if (
      !hasExactKeys(value, ['kind', 'sourceTurnId']) ||
      typeof value.sourceTurnId !== 'string' ||
      !isSafeId(value.sourceTurnId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({ kind: 'regenerate', sourceTurnId: value.sourceTurnId });
  }
  if (value.kind === 'context_compact') {
    if (!hasExactKeys(value, ['kind'])) throw new Error('Invalid root execution descriptor');
    return Object.freeze({ kind: 'context_compact' });
  }
  if (value.kind === 'automation') {
    if (
      !hasExactKeys(value, ['kind', 'automationId']) ||
      typeof value.automationId !== 'string' ||
      !isSafeId(value.automationId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({ kind: 'automation', automationId: value.automationId });
  }
  if (value.kind === 'goal') {
    if (
      !hasExactKeys(value, ['kind', 'goalId']) ||
      typeof value.goalId !== 'string' ||
      !isSafeId(value.goalId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({ kind: 'goal', goalId: value.goalId });
  }
  if (value.kind === 'agent_graph_supervisor_wake') {
    if (
      !hasExactKeys(value, ['kind', 'graphId', 'wakeId', 'attemptId']) ||
      typeof value.graphId !== 'string' ||
      !isGraphControlIdentity(value.graphId) ||
      typeof value.wakeId !== 'string' ||
      !isGraphControlIdentity(value.wakeId) ||
      !value.wakeId.startsWith(`${value.graphId}:`) ||
      typeof value.attemptId !== 'string' ||
      !isGraphControlIdentity(value.attemptId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({
      kind: value.kind,
      graphId: value.graphId,
      wakeId: value.wakeId,
      attemptId: value.attemptId,
    });
  }
  if (value.kind === 'safe_boundary_continuation') {
    const keys = [
      'kind',
      'sourceInvocationId',
      'sourceRunId',
      'sourceTurnId',
      'sourceRuntimeEventHighWater',
      'claimId',
      'boundaryDigest',
      'providerReplayDigest',
      'safetyDigest',
      'targetInvocationId',
    ];
    if (
      !hasExactKeys(value, keys) ||
      typeof value.sourceInvocationId !== 'string' ||
      !isSafeId(value.sourceInvocationId) ||
      typeof value.sourceRunId !== 'string' ||
      !isSafeId(value.sourceRunId) ||
      typeof value.sourceTurnId !== 'string' ||
      !isSafeId(value.sourceTurnId) ||
      !Number.isSafeInteger(value.sourceRuntimeEventHighWater) ||
      (value.sourceRuntimeEventHighWater as number) < 1 ||
      typeof value.claimId !== 'string' ||
      !isSafeId(value.claimId) ||
      !isSha256Digest(value.boundaryDigest) ||
      !isSha256Digest(value.providerReplayDigest) ||
      !isSha256Digest(value.safetyDigest) ||
      typeof value.targetInvocationId !== 'string' ||
      !isSafeId(value.targetInvocationId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({
      kind: value.kind,
      sourceInvocationId: value.sourceInvocationId,
      sourceRunId: value.sourceRunId,
      sourceTurnId: value.sourceTurnId,
      sourceRuntimeEventHighWater: value.sourceRuntimeEventHighWater as number,
      claimId: value.claimId,
      boundaryDigest: value.boundaryDigest,
      providerReplayDigest: value.providerReplayDigest,
      safetyDigest: value.safetyDigest,
      targetInvocationId: value.targetInvocationId,
    });
  }
  if (value.kind === 'claimed_agent_graph_intent') {
    if (
      !hasExactKeys(value, ['kind', 'claim', 'agentId', 'agentName']) ||
      typeof value.agentId !== 'string' ||
      !isSafeId(value.agentId) ||
      typeof value.agentName !== 'string' ||
      value.agentName.length === 0 ||
      Buffer.byteLength(value.agentName, 'utf8') > 256
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    let claim;
    try {
      claim = decodeAgentGraphIntentClaim(value.claim);
    } catch {
      throw new Error('Invalid root execution descriptor');
    }
    Object.freeze(claim);
    return Object.freeze({
      kind: value.kind,
      claim,
      agentId: value.agentId,
      agentName: value.agentName,
    });
  }
  if (
    value.kind !== 'linked_child_initial' &&
    value.kind !== 'linked_child_resume' &&
    value.kind !== 'linked_child_provider_retry'
  ) {
    throw new Error('Invalid root execution descriptor');
  }
  const hasSource = value.kind !== 'linked_child_initial';
  if (
    !hasExactKeys(
      value,
      hasSource
        ? ['kind', 'agentId', 'agentName', 'sourceRunId']
        : ['kind', 'agentId', 'agentName'],
    ) ||
    typeof value.agentId !== 'string' ||
    !isSafeId(value.agentId) ||
    typeof value.agentName !== 'string' ||
    value.agentName.length === 0 ||
    Buffer.byteLength(value.agentName, 'utf8') > 256 ||
    (hasSource && (typeof value.sourceRunId !== 'string' || !isSafeId(value.sourceRunId)))
  ) {
    throw new Error('Invalid root execution descriptor');
  }
  if (value.kind === 'linked_child_initial') {
    return Object.freeze({
      kind: value.kind,
      agentId: value.agentId,
      agentName: value.agentName,
    });
  }
  return Object.freeze({
    kind: value.kind,
    agentId: value.agentId,
    agentName: value.agentName,
    sourceRunId: value.sourceRunId as string,
  });
}

function deepFreezeRootTurnMessageContent(content: MessageContent): void {
  for (const attachment of content.attachments ?? []) {
    Object.freeze(attachment.ref);
    Object.freeze(attachment);
  }
  if (content.attachments) Object.freeze(content.attachments);
  for (const quote of content.quotes ?? []) Object.freeze(quote);
  if (content.quotes) Object.freeze(content.quotes);
  Object.freeze(content);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
