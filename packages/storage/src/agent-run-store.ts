import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { appendJsonl } from './jsonl-append.js';
import {
  decodeAgentRunEvent,
  decodeAgentRunHeader,
  decodeRuntimeEvent,
} from './execution-record-codec.js';
import { classifyJsonRecord } from './json-prefix.js';
import { immutableSteeringMessageId } from './runtime-event-invariants.js';
import { syncDirectory, syncDirectoryChain, syncFile } from './stable-storage.js';
import { chainWrite } from './write-queue.js';
import {
  acquireOperationalStateDatabase,
  completeOperationalStoreCutover,
  type OperationalStateDatabaseLease,
  type OperationalStoreCutoverFailpoint,
} from './operational-state-store.js';
import {
  DurableStoreWriteError,
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
  type AttachmentRef,
  type MessageContent,
  type RootExecutionDescriptor,
  type RuntimeEvent,
  type RuntimeEventStore,
} from '@maka/core';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EXCLUSIVE_TEMP_SUFFIX_PATTERN =
  /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export const ROOT_TURN_ADMISSION_SCHEMA_VERSION = 1 as const;
export const ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES = 64;
export const ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES = 64 * 1024;
export const ROOT_TURN_ADMISSION_MAX_RECORD_BYTES = 1024 * 1024;
const ROOT_TURN_ADMISSION_MAX_AGGREGATED_ATTACHMENTS =
  ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES * MAX_ATTACHMENT_COUNT;

export interface RootTurnSourceMessage {
  messageId: string;
  content: MessageContent;
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
  normalizedInput: MessageContent;
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
  normalizedInput: MessageContent;
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

export interface ConversationCopyRuntimeEventBatch {
  readonly runId: string;
  readonly events: readonly RuntimeEvent[];
}

export interface DurableRuntimeEventStore extends RuntimeEventStore {
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

export function createAgentRunStore(workspaceRoot: string): DurableAgentRunStore {
  return new FileAgentRunStore(workspaceRoot);
}

export interface SqliteAgentRunStoreOptions {
  readonly failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

export function createSqliteAgentRunStore(
  workspaceRoot: string,
  options: SqliteAgentRunStoreOptions = {},
): DurableAgentRunStore {
  return new SqliteAgentRunStore(workspaceRoot, options);
}

export function createRuntimeEventStore(workspaceRoot: string): DurableRuntimeEventStore {
  return new FileRuntimeEventStore(workspaceRoot);
}

class SqliteAgentRunStore implements DurableAgentRunStore {
  readonly #root: string;
  readonly #lease: OperationalStateDatabaseLease;
  readonly #ready: Promise<void>;

  constructor(workspaceRoot: string, options: SqliteAgentRunStoreOptions) {
    this.#root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(this.#root);
    this.#ready = importLegacyAgentRuns(this.#root, this.#lease, options);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async createRun(
    header: AgentRunHeader,
    _options: { durable?: boolean } = {},
  ): Promise<AgentRunHeader> {
    const normalized = normalizeAgentRunHeader(header, header.sessionId, header.runId);
    await this.#ready;
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
    await this.#ready;
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
    await this.#ready;
    return readSqliteAgentRun(this.#lease.database, sessionId, runId);
  }

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    return this.listSessionRunsForRecovery(sessionId);
  }

  async listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]> {
    assertSafeId(sessionId, 'Invalid session id');
    await this.#ready;
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
    event: AgentRunEvent,
    _options: { durable?: boolean } = {},
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    await this.#ready;
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

  async readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    await this.#ready;
    return readSqliteAgentRunEvents(this.#lease.database, sessionId, runId);
  }

  async readEventsForEvidence(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    await this.#ready;
    return readSqliteAgentRunEventsForEvidence(this.#lease.database, sessionId, runId);
  }

  async readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    await this.#ready;
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
    await this.#ready;
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
    await this.#ready;
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
    await this.#ready;
    return readSqliteRootTurnAdmission(this.#lease.database, sessionId, turnId);
  }

  async readRootTurnSourceMessageReceipt(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(sourceMessageId, 'Invalid source message id');
    await this.#ready;
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
    await this.#ready;
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

class FileAgentRunStore implements DurableAgentRunStore {
  private readonly durabilityRoot: string;
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly rootTurnAdmissionWriteQueues = new Map<string, Promise<void>>();
  private readonly projectionWriteQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.durabilityRoot = resolve(workspaceRoot);
    this.sessionsRoot = join(this.durabilityRoot, 'sessions');
  }

  async createRun(
    header: AgentRunHeader,
    options: { durable?: boolean } = {},
  ): Promise<AgentRunHeader> {
    assertSafeId(header.sessionId, 'Invalid session id');
    assertSafeId(header.runId, 'Invalid run id');
    await this.withQueue(header.sessionId, header.runId, async () => {
      const created = await writeExclusiveAtomic(
        this.runPath(header.sessionId, header.runId),
        JSON.stringify(header, sanitizeJson) + '\n',
        options,
        this.durabilityRoot,
      );
      if (!created) throw new Error(`Agent run already exists: ${header.runId}`);
    });
    await this.withProjectionQueue(
      header.sessionId,
      'history_compact_checkpoint_recorded',
      async () => {
        await this.initializeEventProjectionUnlocked(
          header.sessionId,
          header.runId,
          'history_compact_checkpoint_recorded',
        );
      },
    ).catch(() => {
      // Projection initialization is derived state; recovery can rebuild it from the run ledger.
    });
    return header;
  }

  async admitRootTurn(input: AdmitRootTurnInput): Promise<AdmitRootTurnResult> {
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
    const { normalizedInput, sourceMessages } = normalizeRootTurnAdmissionPayload(
      input.normalizedInput,
      input.sourceMessages,
    );
    if (!Number.isSafeInteger(input.admittedAt) || input.admittedAt < 0) {
      throw new Error('Invalid root turn admission timestamp');
    }
    const admission: RootTurnAdmission = {
      schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.proposedRunId,
      userMessageId: input.proposedUserMessageId,
      execution: normalizeRootExecutionDescriptor(input.execution),
      previousRootTurnId: input.previousRootTurnId,
      normalizedInput,
      sourceMessages,
      admittedAt: input.admittedAt,
    };
    assertRootTurnAdmissionContract(admission);
    assertRootTurnAdmissionRecordSize(admission);
    deepFreezeRootTurnAdmission(admission);
    let result: AdmitRootTurnResult | undefined;
    await chainWrite(this.rootTurnAdmissionWriteQueues, input.sessionId, async () => {
      const path = this.rootTurnAdmissionPath(input.sessionId, input.turnId);
      let existing = await this.readRootTurnAdmission(input.sessionId, input.turnId);
      if (!existing) {
        await this.assertRootSourceMessageProofOwners(admission);
        const created = await writeExclusiveAtomic(
          path,
          JSON.stringify(admission) + '\n',
          { durable: true },
          this.durabilityRoot,
        );
        if (created) {
          await this.ensureRootSourceMessageProofs(admission);
          result = { kind: 'admitted', admission };
          return;
        }
        existing = await this.readRootTurnAdmission(input.sessionId, input.turnId);
        if (!existing) throw new Error(`Root turn admission disappeared: ${input.turnId}`);
      }
      await this.ensureRootSourceMessageProofs(existing);
      result =
        existing.previousRootTurnId === input.previousRootTurnId &&
        rootTurnAdmissionPayloadsEqual(existing, admission)
          ? { kind: 'existing', admission: existing }
          : { kind: 'conflict', admission: existing };
    });
    if (!result) throw new Error(`Root turn admission did not complete: ${input.turnId}`);
    return result;
  }

  async readRootTurnAdmission(
    sessionId: string,
    turnId: string,
  ): Promise<RootTurnAdmission | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(turnId, 'Invalid turn id');
    let raw: string;
    try {
      raw = await readFile(this.rootTurnAdmissionPath(sessionId, turnId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    assertRootTurnAdmissionSerializedSize(raw);
    return normalizeRootTurnAdmission(JSON.parse(raw), sessionId, turnId);
  }

  async readRootTurnSourceMessageReceipt(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(sourceMessageId, 'Invalid source message id');
    let raw: string;
    try {
      raw = await readFile(this.rootSourceMessageProofPath(sessionId, sourceMessageId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const pointer = decodeRootSourceMessageProofPointer(
      JSON.parse(raw),
      sessionId,
      sourceMessageId,
    );
    const admission = await this.readRootTurnAdmission(sessionId, pointer.turnId);
    if (!admission) {
      throw new Error(`Root source message proof references missing Turn ${pointer.turnId}`);
    }
    const matching = admission.sourceMessages.filter(
      (source) => source.messageId === sourceMessageId,
    );
    if (matching.length !== 1) {
      throw new Error(
        `Root source message proof does not identify exactly one source: ${sourceMessageId}`,
      );
    }
    return Object.freeze({ admission, sourceMessage: matching[0]! });
  }

  async listRootTurnAdmissionsForRecovery(sessionId: string): Promise<RootTurnAdmission[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const admissionsRoot = this.rootTurnAdmissionsRoot(sessionId);
    let entries;
    try {
      entries = await readdir(admissionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const admissions: RootTurnAdmission[] = [];
    let removedStagingFile = false;
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new Error(`Invalid root turn admission entry: ${entry.name}`);
      }
      const turnId = turnIdFromAdmissionFile(entry.name);
      if (turnId) {
        admissions.push((await this.readRootTurnAdmission(sessionId, turnId)) as RootTurnAdmission);
        continue;
      }
      if (isRootTurnAdmissionTemp(entry.name)) {
        await rm(join(admissionsRoot, entry.name), { force: true });
        removedStagingFile = true;
        continue;
      }
      throw new Error(`Invalid root turn admission entry: ${entry.name}`);
    }
    if (removedStagingFile) await syncDirectory(admissionsRoot);
    const ordered = orderRootTurnAdmissionChain(sessionId, admissions);
    for (const admission of ordered) await this.ensureRootSourceMessageProofs(admission);
    return ordered;
  }

  async updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<AgentRunHeader>,
    options: { durable?: boolean } = {},
  ): Promise<AgentRunHeader> {
    assertMutableRunHeaderPatch(patch);
    let next: AgentRunHeader | undefined;
    await this.withQueue(sessionId, runId, async () => {
      const current = await this.readRunUnlocked(sessionId, runId);
      next = decodeAgentRunHeader({ ...current, ...patch, sessionId, runId }, { sessionId, runId });
      await writeAtomic(this.runPath(sessionId, runId), JSON.stringify(next, sanitizeJson) + '\n', {
        ...options,
        durabilityRoot: this.durabilityRoot,
      });
    });
    if (!next) throw new Error(`Failed to update run ${runId}`);
    return next;
  }

  async readRun(sessionId: string, runId: string): Promise<AgentRunHeader> {
    return this.readRunUnlocked(sessionId, runId);
  }

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const runsRoot = this.runsRoot(sessionId);
    let entries;
    try {
      entries = await readdir(runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const headers: AgentRunHeader[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      try {
        headers.push(await this.readRunUnlocked(sessionId, entry.name));
      } catch {
        // Malformed run folders should not hide the rest of the session.
      }
    }
    return headers.sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  async listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const runsRoot = this.runsRoot(sessionId);
    let entries;
    try {
      entries = await readdir(runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const headers: AgentRunHeader[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) {
        throw new Error(`Invalid AgentRun entry for session ${sessionId}: ${entry.name}`);
      }
      try {
        headers.push(await this.readRunUnlocked(sessionId, entry.name));
      } catch (error) {
        if (
          isMissingFile(error) &&
          (await this.removeUncommittedRunDirectory(sessionId, entry.name))
        ) {
          continue;
        }
        throw error;
      }
    }
    return headers.sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  }

  async appendEvent(
    sessionId: string,
    runId: string,
    event: AgentRunEvent,
    options: { durable?: boolean } = {},
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    if (event.type === 'history_compact_checkpoint_recorded') {
      await this.withProjectionQueue(sessionId, event.type, async () => {
        let current: AgentRunEvent | null | undefined;
        try {
          current = await this.readEventProjectionUnlocked(sessionId, event.type);
        } catch {
          current = undefined;
        }
        await rm(this.eventProjectionPath(sessionId, event.type), {
          force: true,
        });
        await this.appendRunEvent(sessionId, runId, event, options);
        const projected = shouldPreserveCheckpointProjectionDuringAppend(current, event)
          ? current!
          : event;
        await this.writeEventProjectionUnlocked(sessionId, event.type, projected).catch(() => {
          // The canonical event is durable; a missing derived projection safely replays raw history.
        });
      });
      return;
    }
    await this.appendRunEvent(sessionId, runId, event, options);
  }

  private async appendRunEvent(
    sessionId: string,
    runId: string,
    event: AgentRunEvent,
    options: { durable?: boolean },
  ): Promise<void> {
    await this.withQueue(sessionId, runId, async () => {
      await mkdir(this.runDir(sessionId, runId), { recursive: true });
      await appendJsonl(
        this.eventsPath(sessionId, runId),
        JSON.stringify(event, sanitizeJson) + '\n',
        { ...options, durabilityRoot: this.durabilityRoot },
      );
    });
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.readEventsWithPolicy(sessionId, runId, false);
  }

  async readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.readEventsWithPolicy(sessionId, runId, true);
  }

  async readEventsForEvidence(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.readEventsWithPolicy(sessionId, runId, false, true);
  }

  private async readEventsWithPolicy(
    sessionId: string,
    runId: string,
    strict: boolean,
    preserveIncompleteTail = false,
  ): Promise<AgentRunEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    let text: string;
    try {
      text = await readFile(this.eventsPath(sessionId, runId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const header = await this.readRunUnlocked(sessionId, runId);
    const rawLines = text.split('\n');
    const endsWithNewline = text.endsWith('\n');
    const lines = rawLines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter((entry) => entry.line.trim().length > 0);
    const lastLineNumber = lines.at(-1)?.lineNumber;
    const events: AgentRunEvent[] = [];
    for (const entry of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.line);
      } catch (error) {
        const incompleteTail =
          !endsWithNewline &&
          entry.lineNumber === lastLineNumber &&
          classifyJsonRecord(entry.line) === 'incomplete-prefix';
        if (incompleteTail && !preserveIncompleteTail) continue;
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `AgentRun ${runId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
        events.push({
          type: 'event_corrupt',
          id: `run-event-corrupt-${entry.lineNumber}`,
          runId,
          sessionId,
          turnId: header.turnId,
          ts: header.updatedAt,
          message: incompleteTail
            ? 'Incomplete AgentRun event JSONL tail'
            : error instanceof Error
              ? error.message
              : 'Invalid AgentRun event JSONL line',
          data: { lineNumber: entry.lineNumber },
        });
        continue;
      }
      try {
        events.push(
          decodeAgentRunEvent(parsed, {
            sessionId,
            runId,
            turnId: header.turnId,
          }),
        );
      } catch (error) {
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `AgentRun ${runId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
        events.push({
          type: 'event_corrupt',
          id: `run-event-corrupt-${entry.lineNumber}`,
          runId,
          sessionId,
          turnId: header.turnId,
          ts: header.updatedAt,
          message: error instanceof Error ? error.message : 'Invalid AgentRun event JSONL line',
          data: { lineNumber: entry.lineNumber },
        });
      }
    }
    return events;
  }

  async readEventProjection(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    return this.readEventProjectionUnlocked(sessionId, type);
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
    await this.withProjectionQueue(sessionId, type, async () => {
      let current: AgentRunEvent | null | undefined;
      try {
        current = await this.readEventProjectionUnlocked(sessionId, type);
      } catch {
        current = undefined;
      }
      if (
        current?.id !== options.replaceEventId &&
        shouldPreserveProjectionDuringRepair(current, event, type)
      )
        return;
      await this.writeEventProjectionUnlocked(sessionId, type, event);
    });
  }

  private async readRunUnlocked(sessionId: string, runId: string): Promise<AgentRunHeader> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return decodeAgentRunHeader(
      JSON.parse(await readFile(this.runPath(sessionId, runId), 'utf8')),
      { sessionId, runId },
    );
  }

  private runsRoot(sessionId: string): string {
    assertSafeId(sessionId, 'Invalid session id');
    return join(this.sessionsRoot, sessionId, 'runs');
  }

  private runDir(sessionId: string, runId: string): string {
    assertSafeId(runId, 'Invalid run id');
    return join(this.runsRoot(sessionId), runId);
  }

  private runPath(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'run.json');
  }

  private eventsPath(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'events.jsonl');
  }

  private eventProjectionPath(sessionId: string, type: AgentRunEventType): string {
    return join(this.sessionsRoot, sessionId, 'projections', `${type}.json`);
  }

  private rootTurnAdmissionPath(sessionId: string, turnId: string): string {
    return join(this.rootTurnAdmissionsRoot(sessionId), `${turnId}.json`);
  }

  private rootTurnAdmissionsRoot(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'turn-admissions');
  }

  private rootSourceMessageProofPath(sessionId: string, messageId: string): string {
    return join(this.sessionsRoot, sessionId, 'message-proofs', 'root', `${messageId}.json`);
  }

  private async assertRootSourceMessageProofOwners(admission: RootTurnAdmission): Promise<void> {
    for (const source of admission.sourceMessages) {
      const path = this.rootSourceMessageProofPath(admission.sessionId, source.messageId);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const existing = decodeRootSourceMessageProofPointer(
        JSON.parse(raw),
        admission.sessionId,
        source.messageId,
      );
      if (existing.turnId !== admission.turnId) {
        throw new Error(
          `Root source message identity belongs to both ${existing.turnId} and ${admission.turnId}`,
        );
      }
    }
  }

  private async ensureRootSourceMessageProofs(admission: RootTurnAdmission): Promise<void> {
    for (const source of admission.sourceMessages) {
      const pointer = {
        schemaVersion: 1,
        sessionId: admission.sessionId,
        messageId: source.messageId,
        turnId: admission.turnId,
      };
      const path = this.rootSourceMessageProofPath(admission.sessionId, source.messageId);
      const created = await writeExclusiveAtomic(
        path,
        `${JSON.stringify(pointer)}\n`,
        { durable: true },
        this.durabilityRoot,
      );
      if (created) continue;
      const existing = decodeRootSourceMessageProofPointer(
        JSON.parse(await readFile(path, 'utf8')),
        admission.sessionId,
        source.messageId,
      );
      if (existing.turnId !== admission.turnId) {
        throw new Error(
          `Root source message identity belongs to both ${existing.turnId} and ${admission.turnId}`,
        );
      }
    }
  }

  private async removeUncommittedRunDirectory(sessionId: string, runId: string): Promise<boolean> {
    const directory = this.runDir(sessionId, runId);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || !isExclusiveWriteTemp(entry.name, 'run.json'))) {
      return false;
    }
    await rm(directory, { recursive: true });
    await syncDirectory(this.runsRoot(sessionId));
    return true;
  }

  private withQueue(
    sessionId: string,
    runId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return chainWrite(this.writeQueues, `${sessionId}:${runId}`, operation);
  }

  private withProjectionQueue(
    sessionId: string,
    type: AgentRunEventType,
    operation: () => Promise<void>,
  ): Promise<void> {
    return chainWrite(this.projectionWriteQueues, `${sessionId}:${type}`, operation);
  }

  private async readEventProjectionUnlocked(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.eventProjectionPath(sessionId, type), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const parsed = JSON.parse(raw) as { version?: unknown; event?: unknown };
    if (parsed.version !== 1 || !Object.hasOwn(parsed, 'event')) {
      throw new Error(`Invalid AgentRun event projection for ${type}`);
    }
    if (parsed.event === null) return null;
    if (!isProjectedAgentRunEvent(parsed.event, sessionId, type)) {
      throw new Error(`Invalid AgentRun event projection for ${type}`);
    }
    return parsed.event;
  }

  private async writeEventProjectionUnlocked(
    sessionId: string,
    type: AgentRunEventType,
    event: AgentRunEvent | null,
  ): Promise<void> {
    await writeAtomic(
      this.eventProjectionPath(sessionId, type),
      JSON.stringify({ version: 1, event }, sanitizeJson) + '\n',
    );
  }

  private async initializeEventProjectionUnlocked(
    sessionId: string,
    currentRunId: string,
    type: AgentRunEventType,
  ): Promise<void> {
    try {
      await readFile(this.eventProjectionPath(sessionId, type), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const runs = await readdir(this.runsRoot(sessionId), {
        withFileTypes: true,
      });
      if (
        runs.some(
          (entry) => entry.isDirectory() && isSafeId(entry.name) && entry.name !== currentRunId,
        )
      ) {
        return;
      }
      await this.writeEventProjectionUnlocked(sessionId, type, null);
    }
  }
}

interface LegacyAgentRunProjection {
  readonly sessionId: string;
  readonly type: AgentRunEventType;
  readonly event: AgentRunEvent | null;
}

interface LegacyAgentRunSnapshot {
  readonly runs: readonly AgentRunHeader[];
  readonly events: readonly {
    readonly sessionId: string;
    readonly runId: string;
    readonly records: readonly AgentRunEvent[];
  }[];
  readonly projections: readonly LegacyAgentRunProjection[];
  readonly admissions: readonly RootTurnAdmission[];
}

async function importLegacyAgentRuns(
  root: string,
  lease: OperationalStateDatabaseLease,
  options: SqliteAgentRunStoreOptions,
): Promise<void> {
  const snapshot = await readLegacyAgentRunSnapshot(root);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(snapshot, sanitizeJson))
    .digest('hex');
  completeOperationalStoreCutover(lease, {
    storeName: 'agent_runs',
    sourcePath: join(root, 'sessions'),
    sourceFingerprint: `sha256:${fingerprint}`,
    failpoint: options.failpoint,
    importAndValidate: (db) => {
      for (const run of snapshot.runs) insertOrValidateAgentRun(db, run);
      for (const stream of snapshot.events) {
        stream.records.forEach((event, sequence) => {
          insertOrValidateAgentRunEvent(db, event, sequence);
        });
      }
      for (const projection of snapshot.projections) {
        insertOrValidateAgentRunProjection(db, projection);
      }
      for (const admission of snapshot.admissions) {
        insertOrValidateRootTurnAdmission(db, admission);
      }
      return {
        agent_runs: snapshot.runs.length,
        agent_run_events: snapshot.events.reduce(
          (count, stream) => count + stream.records.length,
          0,
        ),
        agent_run_projections: snapshot.projections.length,
        root_turn_admissions: snapshot.admissions.length,
        root_source_message_proofs: snapshot.admissions.reduce(
          (count, admission) => count + admission.sourceMessages.length,
          0,
        ),
      };
    },
  });
}

async function readLegacyAgentRunSnapshot(root: string): Promise<LegacyAgentRunSnapshot> {
  const sessionsRoot = join(root, 'sessions');
  let sessions;
  try {
    sessions = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { runs: [], events: [], projections: [], admissions: [] };
    }
    throw error;
  }
  const legacy = new FileAgentRunStore(root);
  const runs: AgentRunHeader[] = [];
  const events: Array<{
    sessionId: string;
    runId: string;
    records: AgentRunEvent[];
  }> = [];
  const projections: LegacyAgentRunProjection[] = [];
  const admissions: RootTurnAdmission[] = [];
  for (const session of sessions.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!session.isDirectory() || !isSafeId(session.name)) continue;
    const sessionRuns = await readLegacyAgentRunsForSession(root, legacy, session.name);
    runs.push(...sessionRuns.runs);
    events.push(...sessionRuns.events);
    const sessionAdmissions = await legacy.listRootTurnAdmissionsForRecovery(session.name);
    admissions.push(...sessionAdmissions);
    await assertLegacyRootProofClosure(root, session.name, sessionAdmissions);
    projections.push(...(await readLegacyAgentRunProjections(root, session.name)));
  }
  return { runs, events, projections, admissions };
}

async function readLegacyAgentRunsForSession(
  root: string,
  legacy: FileAgentRunStore,
  sessionId: string,
): Promise<{
  runs: AgentRunHeader[];
  events: Array<{ sessionId: string; runId: string; records: AgentRunEvent[] }>;
}> {
  const runsRoot = join(root, 'sessions', sessionId, 'runs');
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], events: [] };
    throw error;
  }
  const runs: AgentRunHeader[] = [];
  const events: Array<{ sessionId: string; runId: string; records: AgentRunEvent[] }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !isSafeId(entry.name)) {
      throw new Error(`Invalid AgentRun entry for session ${sessionId}: ${entry.name}`);
    }
    const runRoot = join(runsRoot, entry.name);
    const runEntries = await readdir(runRoot, { withFileTypes: true });
    const hasHeader = runEntries.some(
      (candidate) => candidate.isFile() && candidate.name === 'run.json',
    );
    if (!hasHeader) {
      const runtimeOnly = runEntries.every(
        (candidate) =>
          (candidate.isFile() && candidate.name === 'runtime-events.jsonl') ||
          (candidate.isDirectory() && candidate.name === 'runtime-partials') ||
          (candidate.isFile() && isExclusiveWriteTemp(candidate.name, 'run.json')),
      );
      if (runtimeOnly) continue;
      throw Object.assign(new Error(`AgentRun ${entry.name} has no durable header`), {
        code: 'ENOENT',
      });
    }
    const run = await legacy.readRun(sessionId, entry.name);
    runs.push(run);
    events.push({
      sessionId,
      runId: run.runId,
      records: await legacy.readEventsForRecovery(sessionId, run.runId),
    });
  }
  return { runs, events };
}

async function readLegacyAgentRunProjections(
  root: string,
  sessionId: string,
): Promise<LegacyAgentRunProjection[]> {
  const projectionRoot = join(root, 'sessions', sessionId, 'projections');
  let entries;
  try {
    entries = await readdir(projectionRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: LegacyAgentRunProjection[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Invalid AgentRun projection entry: ${entry.name}`);
    }
    const type = entry.name.slice(0, -'.json'.length) as AgentRunEventType;
    const parsed = JSON.parse(await readFile(join(projectionRoot, entry.name), 'utf8')) as {
      version?: unknown;
      event?: unknown;
    };
    if (parsed.version !== 1 || !Object.hasOwn(parsed, 'event')) {
      throw new Error(`Invalid AgentRun event projection for ${type}`);
    }
    if (parsed.event !== null && !isProjectedAgentRunEvent(parsed.event, sessionId, type)) {
      throw new Error(`Invalid AgentRun event projection for ${type}`);
    }
    result.push({
      sessionId,
      type,
      event: parsed.event as AgentRunEvent | null,
    });
  }
  return result;
}

async function assertLegacyRootProofClosure(
  root: string,
  sessionId: string,
  admissions: readonly RootTurnAdmission[],
): Promise<void> {
  const expected = new Map<string, string>();
  for (const admission of admissions) {
    for (const source of admission.sourceMessages) {
      expected.set(source.messageId, admission.turnId);
    }
  }
  const proofRoot = join(root, 'sessions', sessionId, 'message-proofs', 'root');
  let entries;
  try {
    entries = await readdir(proofRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (expected.size === 0) return;
      throw new Error(`Missing root source message proofs for session ${sessionId}`);
    }
    throw error;
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Invalid root source message proof entry: ${entry.name}`);
    }
    const messageId = entry.name.slice(0, -'.json'.length);
    assertSafeId(messageId, 'Invalid root source message proof identity');
    const pointer = decodeRootSourceMessageProofPointer(
      JSON.parse(await readFile(join(proofRoot, entry.name), 'utf8')),
      sessionId,
      messageId,
    );
    if (expected.get(messageId) !== pointer.turnId) {
      throw new Error(`Orphan root source message proof: ${messageId}`);
    }
    seen.add(messageId);
  }
  if (seen.size !== expected.size) {
    throw new Error(`Missing root source message proofs for session ${sessionId}`);
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
  const admission: RootTurnAdmission = {
    schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.proposedRunId,
    userMessageId: input.proposedUserMessageId,
    execution: normalizeRootExecutionDescriptor(input.execution),
    previousRootTurnId: input.previousRootTurnId,
    normalizedInput,
    sourceMessages,
    admittedAt: input.admittedAt,
  };
  assertRootTurnAdmissionContract(admission);
  assertRootTurnAdmissionRecordSize(admission);
  return deepFreezeRootTurnAdmission(admission);
}

function insertOrValidateAgentRun(db: DatabaseSync, run: AgentRunHeader): void {
  const encoded = JSON.stringify(run, sanitizeJson);
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO core_agent_runs(session_id, run_id, created_at, record_json)
      VALUES (?, ?, ?, ?)
    `)
    .run(run.sessionId, run.runId, run.createdAt, encoded);
  if (result.changes !== 0) return;
  if (!isDeepStrictEqual(readSqliteAgentRun(db, run.sessionId, run.runId), run)) {
    throw new Error(`AgentRun cutover conflict: ${run.runId}`);
  }
}

function insertOrValidateAgentRunEvent(
  db: DatabaseSync,
  event: AgentRunEvent,
  sequence: number,
): void {
  const encoded = JSON.stringify(event, sanitizeJson);
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO core_agent_run_events(
        session_id, run_id, sequence, event_id, event_type, event_ts, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(event.sessionId, event.runId, sequence, event.id, event.type, event.ts, encoded);
  if (result.changes !== 0) return;
  const row = db
    .prepare(`
      SELECT record_json
      FROM core_agent_run_events
      WHERE session_id = ? AND run_id = ? AND sequence = ?
    `)
    .get(event.sessionId, event.runId, sequence) as { record_json?: unknown } | undefined;
  if (typeof row?.record_json !== 'string' || row.record_json !== encoded) {
    throw new Error(`AgentRun event cutover conflict: ${event.runId}:${sequence}`);
  }
}

function insertOrValidateAgentRunProjection(
  db: DatabaseSync,
  projection: LegacyAgentRunProjection,
): void {
  const encoded = projection.event === null ? null : JSON.stringify(projection.event, sanitizeJson);
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO core_agent_run_projections(session_id, event_type, event_json)
      VALUES (?, ?, ?)
    `)
    .run(projection.sessionId, projection.type, encoded);
  if (result.changes !== 0) return;
  const existing = readSqliteAgentRunProjection(db, projection.sessionId, projection.type);
  if (!isDeepStrictEqual(existing, projection.event)) {
    throw new Error(`AgentRun projection cutover conflict: ${projection.type}`);
  }
}

function insertOrValidateRootTurnAdmission(db: DatabaseSync, admission: RootTurnAdmission): void {
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO core_root_turn_admissions(
        session_id, turn_id, admitted_at, record_json
      ) VALUES (?, ?, ?, ?)
    `)
    .run(admission.sessionId, admission.turnId, admission.admittedAt, JSON.stringify(admission));
  if (
    result.changes === 0 &&
    !isDeepStrictEqual(
      readSqliteRootTurnAdmission(db, admission.sessionId, admission.turnId),
      admission,
    )
  ) {
    throw new Error(`Root turn admission cutover conflict: ${admission.turnId}`);
  }
  for (const source of admission.sourceMessages) {
    const proof = db
      .prepare(`
        SELECT turn_id
        FROM core_root_source_message_proofs
        WHERE session_id = ? AND message_id = ?
      `)
      .get(admission.sessionId, source.messageId) as { turn_id?: unknown } | undefined;
    if (proof && proof.turn_id !== admission.turnId) {
      throw new Error(`Root source message proof cutover conflict: ${source.messageId}`);
    }
    if (!proof) {
      db.prepare(`
        INSERT INTO core_root_source_message_proofs(session_id, message_id, turn_id)
        VALUES (?, ?, ?)
      `).run(admission.sessionId, source.messageId, admission.turnId);
    }
  }
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

class FileRuntimeEventStore implements DurableRuntimeEventStore {
  private readonly durabilityRoot: string;
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly immutableSteeringWriteQueues = new Map<string, Promise<void>>();

  constructor(workspaceRoot: string) {
    this.durabilityRoot = resolve(workspaceRoot);
    this.sessionsRoot = join(this.durabilityRoot, 'sessions');
  }

  async appendRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
    options: { durable?: boolean } = {},
  ): Promise<void> {
    const canonicalEvent = canonicalizeRuntimeEventForStorage(event);
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    assertNoReservedToolLedgerFact(canonicalEvent);
    const steeringMessageId = immutableSteeringMessageId(canonicalEvent);
    if (steeringMessageId) {
      await this.withImmutableSteeringQueue(sessionId, async () => {
        if (await this.preflightImmutableSteeringMessage(canonicalEvent, steeringMessageId)) return;
        await this.appendRuntimeEventForRun(sessionId, runId, canonicalEvent, options);
      });
      return;
    }
    await this.appendRuntimeEventForRun(sessionId, runId, canonicalEvent, options);
  }

  async importConversationCopyRuntimeEvents(
    sessionId: string,
    batches: readonly ConversationCopyRuntimeEventBatch[],
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    const canonicalBatches = batches.map(({ runId, events }) => {
      assertSafeId(runId, 'Invalid run id');
      return {
        runId,
        events: events.map(canonicalizeRuntimeEventForStorage),
      };
    });
    const canonicalEvents = canonicalBatches.flatMap(({ events }) => events);
    if (canonicalEvents.some((event) => event.partial)) {
      throw new Error('Conversation copy cannot import partial RuntimeEvents');
    }
    const scan = scanToolLedger(canonicalEvents);
    if (scan.hasCorruption) {
      throw new Error(
        `Conversation copy RuntimeEvent ledger is corrupt: ${scan.issues[0]?.code ?? 'unknown'}`,
      );
    }

    for (const { runId, events } of canonicalBatches) {
      await this.withQueue(sessionId, runId, async () => {
        const header = await this.readRunHeader(sessionId, runId);
        for (const event of events) decodeRuntimeEvent(event, header);
        const path = this.runtimeEventsPath(sessionId, runId);
        const existing = await readRuntimeEventJsonl(path, header);
        if (existing.length > 0) {
          if (!isDeepStrictEqual(existing, events)) {
            throw new Error(`Conversation copy RuntimeEvent identity conflict for run ${runId}`);
          }
        } else if (events.length > 0) {
          await appendJsonl(
            path,
            `${events.map((event) => encodeCanonicalRuntimeEvent(event).json).join('\n')}\n`,
            { durable: true, durabilityRoot: this.durabilityRoot },
          );
        }
        for (const event of events) {
          await this.settleImmutableRuntimeEventPostEffects({
            sessionId,
            runId,
            event,
            path,
            ensureDurability: false,
          });
        }
      });
    }
  }

  private async appendRuntimeEventForRun(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
    options: { durable?: boolean },
  ): Promise<void> {
    await this.withQueue(sessionId, runId, async () => {
      const header = await this.readRunHeader(sessionId, runId);
      decodeRuntimeEvent(event, header);
      const partial = partialRuntimeStream(event);
      if (partial) {
        const partialPath = this.runtimePartialPath(sessionId, runId, partial.key);
        try {
          await readFile(partialPath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const immutableEvents = await readRuntimeEventJsonl(
            this.runtimeEventsPath(sessionId, runId),
            header,
          );
          if (
            immutableEvents.some((item) => completedPartialRuntimeStreamKey(item) === partial.key)
          ) {
            return;
          }
          const metadata: RuntimePartialSnapshot = {
            version: 1,
            event: partial.snapshot,
            ...(immutableEvents.at(-1)?.id ? { afterEventId: immutableEvents.at(-1)!.id } : {}),
          };
          await writeAtomic(partialPath, JSON.stringify(metadata, sanitizeJson) + '\n', {
            ...options,
            durabilityRoot: this.durabilityRoot,
          });
        }
        if (partial.text) {
          if (options.durable) {
            await appendFileDurably(partialPath, partial.text, this.durabilityRoot);
          } else {
            await appendFile(partialPath, partial.text, 'utf8');
          }
        }
        return;
      }
      const existingEvents = await readRuntimeEventJsonl(
        this.runtimeEventsPath(sessionId, runId),
        header,
      );
      const matching = existingEvents.filter((item) => item.id === event.id);
      if (matching.length > 1) {
        throw new Error(`RuntimeEvent ${event.id} appears more than once in run ${runId}`);
      }
      if (matching.length === 1) {
        if (!isDeepStrictEqual(matching[0], event)) {
          throw new Error(`RuntimeEvent identity conflict for ${event.id}`);
        }
        await this.settleImmutableRuntimeEventPostEffects({
          sessionId,
          runId,
          event,
          path: this.runtimeEventsPath(sessionId, runId),
          ensureDurability:
            options.durable === true || immutableSteeringMessageId(event) !== undefined,
        });
        return;
      }
      if (isToolLedgerBearingEvent(event)) {
        const validation = validateToolLedgerTransition({
          existingEvents,
          candidateEvents: [event],
          expectedTransition: 'generic_append',
        });
        if (!validation.ok) {
          throw new Error(
            `Tool ledger transition rejected: ${validation.code} at ${validation.eventId}`,
          );
        }
      }
      const steeringMessageId = immutableSteeringMessageId(event);
      await appendJsonl(
        this.runtimeEventsPath(sessionId, runId),
        encodeCanonicalRuntimeEvent(event).json + '\n',
        {
          ...options,
          ...(steeringMessageId ? { durable: true } : {}),
          durabilityRoot: this.durabilityRoot,
        },
      );
      await this.settleImmutableRuntimeEventPostEffects({
        sessionId,
        runId,
        event,
        path: this.runtimeEventsPath(sessionId, runId),
        ensureDurability: false,
      });
    });
  }

  private async settleImmutableRuntimeEventPostEffects(input: {
    sessionId: string;
    runId: string;
    event: RuntimeEvent;
    path: string;
    ensureDurability: boolean;
  }): Promise<void> {
    if (input.ensureDurability) {
      try {
        await syncFile(input.path);
        await syncDirectoryChain(dirname(input.path), this.durabilityRoot);
      } catch (error) {
        throw new DurableStoreWriteError(
          `RuntimeEvent did not reach stable storage: ${input.path}`,
          error,
        );
      }
    }
    const steeringMessageId = immutableSteeringMessageId(input.event);
    if (steeringMessageId) {
      try {
        await this.ensureImmutableSteeringMessageProof(input.event, steeringMessageId);
      } catch (error) {
        if (!(error instanceof DurableStoreWriteError)) throw error;
        throw new RuntimeEventPostEffectError(
          `RuntimeEvent ${input.event.id} is durable but its steering proof was not published`,
          error,
        );
      }
    }
    const completedPartialKey = completedPartialRuntimeStreamKey(input.event);
    if (completedPartialKey) {
      await rm(this.runtimePartialPath(input.sessionId, input.runId, completedPartialKey), {
        force: true,
      }).catch(() => {
        // The immutable final is already durable. Reads suppress any stale snapshot.
      });
    }
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const canonicalEvent = canonicalizeRuntimeEventForStorage(event);
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    assertNoReservedToolLedgerFact(canonicalEvent);
    if (canonicalEvent.partial || !isTerminalRuntimeEvent(canonicalEvent)) {
      throw new Error(
        'Only a final terminal RuntimeEvent can cross the terminal durability barrier',
      );
    }
    await this.withQueue(sessionId, runId, async () => {
      const path = this.runtimeEventsPath(sessionId, runId);
      const header = await this.readRunHeader(sessionId, runId);
      decodeRuntimeEvent(canonicalEvent, header);
      const existing = await readRuntimeEventJsonl(path, header);
      const matching = existing.filter((candidate) => candidate.id === canonicalEvent.id);
      if (matching.length > 1) {
        throw new Error(`RuntimeEvent ${canonicalEvent.id} appears more than once in run ${runId}`);
      }
      if (matching.length === 1) {
        if (!isDeepStrictEqual(matching[0], canonicalEvent)) {
          throw new Error(
            `RuntimeEvent ${canonicalEvent.id} does not match the durable ledger record`,
          );
        }
        try {
          await syncFile(path);
          await syncDirectoryChain(dirname(path), this.durabilityRoot);
        } catch (error) {
          throw new DurableStoreWriteError(
            `Terminal RuntimeEvent did not reach stable storage: ${path}`,
            error,
          );
        }
        return;
      }
      const existingTerminal = existing.find(isTerminalRuntimeEvent);
      if (existingTerminal) {
        throw new Error(`Run ${runId} already has terminal RuntimeEvent ${existingTerminal.id}`);
      }
      await appendJsonl(path, encodeCanonicalRuntimeEvent(canonicalEvent).json + '\n', {
        durable: true,
        durabilityRoot: this.durabilityRoot,
      });
    });
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    const events = await readRuntimeEventJsonl(
      this.runtimeEventsPath(sessionId, runId),
      await this.readRunHeader(sessionId, runId),
    );
    const partials = await this.readRuntimePartials(sessionId, runId);
    const completedPartialKeys = new Set(
      events
        .map(completedPartialRuntimeStreamKey)
        .filter((key): key is string => key !== undefined),
    );
    const visiblePartials = partials.filter(({ event }) => {
      const key = partialRuntimeStream(event)?.key;
      return !key || !completedPartialKeys.has(key);
    });
    return mergeRuntimePartialSnapshots(events, visiblePartials);
  }

  async readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return readRuntimeEventJsonl(
      this.runtimeEventsPath(sessionId, runId),
      await this.readRunHeader(sessionId, runId),
    );
  }

  async readImmutableSteeringMessageProof(
    sessionId: string,
    messageId: string,
  ): Promise<ImmutableSteeringMessageProof | undefined> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(messageId, 'Invalid message id');
    let raw: string;
    try {
      raw = await readFile(this.immutableSteeringMessageProofPath(sessionId, messageId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      !isPlainRecord(parsed) ||
      !hasExactKeys(parsed, ['schemaVersion', 'messageId', 'event']) ||
      parsed.schemaVersion !== 1 ||
      parsed.messageId !== messageId ||
      !isPlainRecord(parsed.event) ||
      typeof parsed.event.runId !== 'string' ||
      !isSafeId(parsed.event.runId)
    ) {
      throw new Error(`Invalid immutable steering message proof: ${messageId}`);
    }
    const event = decodeRuntimeEvent(
      parsed.event,
      await this.readRunHeader(sessionId, parsed.event.runId),
    );
    if (immutableSteeringMessageId(event) !== messageId) {
      throw new Error(`Invalid immutable steering message proof: ${messageId}`);
    }
    return Object.freeze({ event });
  }

  async repairImmutableSteeringMessageProofsForRecovery(sessionId: string): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    await this.withImmutableSteeringQueue(sessionId, async () => {
      const events = await this.readSessionRuntimeEvents(sessionId);
      for (const event of events) {
        const messageId = immutableSteeringMessageId(event);
        if (messageId) await this.ensureImmutableSteeringMessageProof(event, messageId);
      }
    });
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    assertSafeId(sessionId, 'Invalid session id');
    const runsRoot = this.runsRoot(sessionId);
    let entries;
    try {
      entries = await readdir(runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ordered: Array<{
      event: RuntimeEvent;
      runId: string;
      eventIndex: number;
    }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
      const events = await this.readRuntimeEvents(sessionId, entry.name);
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        ordered.push({
          event: events[eventIndex]!,
          runId: entry.name,
          eventIndex,
        });
      }
    }
    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runId.localeCompare(b.runId) ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
    );
    return ordered.map((item) => item.event);
  }

  private runsRoot(sessionId: string): string {
    assertSafeId(sessionId, 'Invalid session id');
    return join(this.sessionsRoot, sessionId, 'runs');
  }

  private runDir(sessionId: string, runId: string): string {
    assertSafeId(runId, 'Invalid run id');
    return join(this.runsRoot(sessionId), runId);
  }

  private runtimeEventsPath(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'runtime-events.jsonl');
  }

  private async readRunHeader(sessionId: string, runId: string): Promise<AgentRunHeader> {
    return decodeAgentRunHeader(
      JSON.parse(await readFile(join(this.runDir(sessionId, runId), 'run.json'), 'utf8')),
      {
        sessionId,
        runId,
      },
    );
  }

  private runtimePartialsDir(sessionId: string, runId: string): string {
    return join(this.runDir(sessionId, runId), 'runtime-partials');
  }

  private runtimePartialPath(sessionId: string, runId: string, key: string): string {
    return join(this.runtimePartialsDir(sessionId, runId), `${key}.partial`);
  }

  private immutableSteeringMessageProofPath(sessionId: string, messageId: string): string {
    return join(this.sessionsRoot, sessionId, 'message-proofs', 'steering', `${messageId}.json`);
  }

  private async ensureImmutableSteeringMessageProof(
    event: RuntimeEvent,
    messageId: string,
  ): Promise<void> {
    const path = this.immutableSteeringMessageProofPath(event.sessionId, messageId);
    const stored = { schemaVersion: 1, messageId, event };
    const created = await writeExclusiveAtomic(
      path,
      `${JSON.stringify(stored, sanitizeJson)}\n`,
      { durable: true },
      this.durabilityRoot,
    );
    if (created) return;
    const existing = await this.readImmutableSteeringMessageProof(event.sessionId, messageId);
    if (
      !existing ||
      !isDeepStrictEqual(existing.event, JSON.parse(JSON.stringify(event, sanitizeJson)))
    ) {
      throw new Error(`Immutable steering message identity conflict: ${messageId}`);
    }
  }

  private async preflightImmutableSteeringMessage(
    event: RuntimeEvent,
    messageId: string,
  ): Promise<boolean> {
    const canonicalEvent = JSON.parse(JSON.stringify(event, sanitizeJson)) as RuntimeEvent;
    const proof = await this.readImmutableSteeringMessageProof(event.sessionId, messageId);
    if (!proof) return false;
    if (!isDeepStrictEqual(proof.event, canonicalEvent)) {
      throw new Error(`Immutable steering message identity conflict: ${messageId}`);
    }
    return true;
  }

  private async readRuntimePartials(
    sessionId: string,
    runId: string,
  ): Promise<RuntimePartialSnapshot[]> {
    let entries;
    try {
      entries = await readdir(this.runtimePartialsDir(sessionId, runId), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const partials: RuntimePartialSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.partial')) continue;
      const key = entry.name.slice(0, -'.partial'.length);
      try {
        const stored = await readFile(this.runtimePartialPath(sessionId, runId, key), 'utf8');
        const headerEnd = stored.indexOf('\n');
        if (headerEnd < 0) continue;
        const snapshot = JSON.parse(stored.slice(0, headerEnd)) as RuntimePartialSnapshot;
        if (snapshot.version !== 1 || !snapshot.event?.partial) continue;
        const event = snapshot.event;
        if (event.content?.kind === 'text' || event.content?.kind === 'thinking') {
          event.content = {
            ...event.content,
            text: stored.slice(headerEnd + 1),
          };
        }
        partials.push({ ...snapshot, event });
      } catch {
        // A replaceable partial snapshot must never make the immutable ledger unreadable.
      }
    }
    return partials;
  }

  private withQueue(
    sessionId: string,
    runId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    assertSafeId(runId, 'Invalid run id');
    return chainWrite(this.writeQueues, `${sessionId}:${runId}`, operation);
  }

  private withImmutableSteeringQueue(
    sessionId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    assertSafeId(sessionId, 'Invalid session id');
    return chainWrite(this.immutableSteeringWriteQueues, sessionId, operation);
  }
}

function mergeRuntimePartialSnapshots(
  immutableEvents: readonly RuntimeEvent[],
  snapshots: readonly RuntimePartialSnapshot[],
): RuntimeEvent[] {
  const leading: RuntimePartialSnapshot[] = [];
  const afterEvent = new Map<string, RuntimePartialSnapshot[]>();
  for (const snapshot of snapshots) {
    if (!snapshot.afterEventId) {
      leading.push(snapshot);
      continue;
    }
    const grouped = afterEvent.get(snapshot.afterEventId) ?? [];
    grouped.push(snapshot);
    afterEvent.set(snapshot.afterEventId, grouped);
  }
  const order = (a: RuntimePartialSnapshot, b: RuntimePartialSnapshot) =>
    a.event.ts - b.event.ts || a.event.id.localeCompare(b.event.id);
  const merged = leading.sort(order).map(({ event }) => event);
  for (const event of immutableEvents) {
    merged.push(event);
    const anchored = afterEvent.get(event.id);
    if (!anchored) continue;
    merged.push(...anchored.sort(order).map((snapshot) => snapshot.event));
    afterEvent.delete(event.id);
  }
  for (const orphaned of afterEvent.values()) {
    merged.push(...orphaned.sort(order).map((snapshot) => snapshot.event));
  }
  return merged;
}

function partialRuntimeStream(event: RuntimeEvent):
  | {
      key: string;
      snapshot: RuntimeEvent;
      text: string;
    }
  | undefined {
  if (!event.partial || event.status !== undefined || event.actions) return undefined;
  const content = event.content;
  let identity: string | undefined;
  let text = '';
  if (
    content?.kind === 'text' &&
    content.attachments === undefined &&
    event.refs?.providerEventId &&
    hasOnlyKeys(event.refs, ['providerEventId'])
  ) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
    text = content.text;
  } else if (
    content?.kind === 'thinking' &&
    content.signature === undefined &&
    event.refs?.providerEventId &&
    hasOnlyKeys(event.refs, ['providerEventId'])
  ) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
    text = content.text;
  } else if (!content && event.refs?.toolCallId && hasOnlyKeys(event.refs, ['toolCallId'])) {
    identity = `tool:call:${event.refs.toolCallId}`;
  }
  if (!identity) return undefined;
  const key = runtimePartialStreamKey(identity, event);
  const snapshot =
    content?.kind === 'text' || content?.kind === 'thinking'
      ? { ...event, content: { ...content, text: '' } }
      : event;
  return { key, snapshot, text };
}

function completedPartialRuntimeStreamKey(event: RuntimeEvent): string | undefined {
  if (event.partial) return undefined;
  const content = event.content;
  let identity: string | undefined;
  if ((content?.kind === 'text' || content?.kind === 'thinking') && event.refs?.providerEventId) {
    identity = `${content.kind}:provider:${event.refs.providerEventId}`;
  } else if (content?.kind === 'function_response' && event.refs?.toolCallId) {
    identity = `tool:call:${event.refs.toolCallId}`;
  }
  return identity ? runtimePartialStreamKey(identity, event) : undefined;
}

function runtimePartialStreamKey(identity: string, event: RuntimeEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        event.branch ?? null,
        event.role,
        event.author,
      ]),
    )
    .digest('hex');
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

async function readRuntimeEventJsonl(
  path: string,
  expected: AgentRunHeader,
): Promise<RuntimeEvent[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rawLines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const lines = rawLines
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((entry) => entry.line.trim().length > 0);
  const lastLineNumber = lines.at(-1)?.lineNumber;
  const events: RuntimeEvent[] = [];
  for (const entry of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.line);
    } catch (error) {
      if (
        !endsWithNewline &&
        entry.lineNumber === lastLineNumber &&
        classifyJsonRecord(entry.line) === 'incomplete-prefix'
      )
        continue;
      const message = error instanceof Error ? error.message : 'Invalid JSON';
      throw new Error(
        `Invalid RuntimeEvent JSONL line ${entry.lineNumber} for run ${expected.runId}: ${message}`,
      );
    }
    try {
      events.push(decodeRuntimeEvent(parsed, expected));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid RuntimeEvent';
      throw new Error(
        `Invalid RuntimeEvent JSONL line ${entry.lineNumber} for run ${expected.runId}: ${message}`,
      );
    }
  }
  return events;
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

interface AtomicWriteOptions {
  durable?: boolean;
  durabilityRoot?: string;
}

async function writeAtomic(
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  try {
    await writeAtomicUnchecked(path, content, options);
  } catch (error) {
    if (!options.durable || error instanceof DurableStoreWriteError) throw error;
    throw new DurableStoreWriteError(
      `Durable atomic write did not reach stable storage: ${path}`,
      error,
    );
  }
}

async function appendFileDurably(
  path: string,
  content: string,
  durabilityRoot: string,
): Promise<void> {
  try {
    const handle = await open(path, 'a');
    try {
      await handle.appendFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectoryChain(dirname(path), durabilityRoot);
  } catch (error) {
    if (error instanceof DurableStoreWriteError) throw error;
    throw new DurableStoreWriteError(`Durable append did not reach stable storage: ${path}`, error);
  }
}

async function writeAtomicUnchecked(
  path: string,
  content: string,
  options: AtomicWriteOptions,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  if (options.durable) {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } else {
    await writeFile(tempPath, content, 'utf8');
  }
  await rename(tempPath, path);
  if (options.durable) {
    if (!options.durabilityRoot) {
      throw new Error('Durable atomic write requires a durability root');
    }
    await syncDirectoryChain(dirname(path), options.durabilityRoot);
  }
}

async function writeExclusiveAtomic(
  path: string,
  content: string,
  options: { durable?: boolean },
  durabilityRoot: string,
): Promise<boolean> {
  try {
    return await writeExclusiveAtomicUnchecked(path, content, options, durabilityRoot);
  } catch (error) {
    if (!options.durable || error instanceof DurableStoreWriteError) throw error;
    throw new DurableStoreWriteError(
      `Durable exclusive write did not reach stable storage: ${path}`,
      error,
    );
  }
}

async function writeExclusiveAtomicUnchecked(
  path: string,
  content: string,
  options: { durable?: boolean },
  durabilityRoot: string,
): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    if (options.durable) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, path);
    await unlink(tempPath);
    if (options.durable) await syncDirectoryChain(directory, durabilityRoot);
    return true;
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      if (options.durable) {
        await syncFile(path);
        await syncDirectoryChain(directory, durabilityRoot);
      }
      return false;
    }
    throw error;
  }
}

function assertSafeId(value: string, message: string): void {
  if (!isSafeId(value)) throw new Error(message);
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
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
    hasExactKeys(record, [
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
    ]);
  if (!valid) {
    throw new Error(`Invalid root turn admission for turn ${turnId}: malformed fields`);
  }
  const { normalizedInput, sourceMessages } = normalizeRootTurnAdmissionPayload(
    record.normalizedInput,
    record.sourceMessages,
  );
  const admission: RootTurnAdmission = {
    schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
    sessionId,
    turnId,
    runId: record.runId as string,
    userMessageId: record.userMessageId as string | null,
    execution: normalizeRootExecutionDescriptor(record.execution),
    previousRootTurnId: record.previousRootTurnId as string | null,
    normalizedInput,
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
  normalizedInputValue: unknown,
  sourceMessagesValue: unknown,
): {
  normalizedInput: MessageContent;
  sourceMessages: readonly RootTurnSourceMessage[];
} {
  const sourceMessages = normalizeRootTurnSourceMessages(sourceMessagesValue);
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
    const sourceText = sourceMessages.map((source) => source.content.text).join('\n\n');
    const sourceDisplayText = sourceMessages
      .map((source) => source.content.displayText ?? source.content.text)
      .join('\n\n');
    const sourceAttachments = sourceMessages.flatMap((source) => source.content.attachments ?? []);
    const sourceQuotes = sourceMessages.flatMap((source) => source.content.quotes ?? []);
    const expectedInput = normalizeRootTurnMessageContent(
      {
        text: sourceText,
        ...(sourceDisplayText !== sourceText ? { displayText: sourceDisplayText } : {}),
        ...(sourceAttachments.length > 0 ? { attachments: sourceAttachments } : {}),
        ...(sourceQuotes.length > 0 ? { quotes: sourceQuotes } : {}),
      },
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
      !hasExactKeys(item, ['messageId', 'content', 'placement', 'disposition'])
    ) {
      throw new Error(`Invalid root turn source message at index ${index}`);
    }
    const { messageId, content, placement, disposition } = item;
    if (
      typeof messageId !== 'string' ||
      !isSafeId(messageId) ||
      (placement !== 'current_turn' && placement !== 'next_turn') ||
      (disposition !== 'steering' &&
        disposition !== 'followup' &&
        disposition !== 'turn_started') ||
      (disposition === 'steering' && placement !== 'current_turn') ||
      (disposition === 'followup' && placement !== 'next_turn')
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
    messageContentsEqual(left.normalizedInput, right.normalizedInput) &&
    left.sourceMessages.length === right.sourceMessages.length &&
    left.sourceMessages.every((source, index) => {
      const other = right.sourceMessages[index];
      return (
        other !== undefined &&
        source.messageId === other.messageId &&
        source.placement === other.placement &&
        source.disposition === other.disposition &&
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
  if ((admission.userMessageId === null) !== providerRetry) {
    throw new Error(
      'Invalid root turn admission contract: only linked child provider retry omits UserMessage',
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
  deepFreezeRootTurnMessageContent(admission.normalizedInput);
  for (const sourceMessage of admission.sourceMessages) {
    deepFreezeRootTurnMessageContent(sourceMessage.content);
    Object.freeze(sourceMessage);
  }
  Object.freeze(admission.sourceMessages);
  return Object.freeze(admission);
}

function normalizeRootExecutionDescriptor(value: unknown): RootExecutionDescriptor {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Invalid root execution descriptor');
  }
  if (value.kind === 'external_message') {
    if (!hasExactKeys(value, ['kind'])) throw new Error('Invalid root execution descriptor');
    return Object.freeze({ kind: 'external_message' });
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

function turnIdFromAdmissionFile(name: string): string | undefined {
  if (!name.endsWith('.json')) return undefined;
  const turnId = name.slice(0, -'.json'.length);
  return isSafeId(turnId) ? turnId : undefined;
}

function isRootTurnAdmissionTemp(name: string): boolean {
  const marker = '.json.';
  const markerIndex = name.indexOf(marker);
  if (markerIndex < 1) return false;
  return (
    isSafeId(name.slice(0, markerIndex)) &&
    EXCLUSIVE_TEMP_SUFFIX_PATTERN.test(name.slice(markerIndex + marker.length))
  );
}

function isExclusiveWriteTemp(name: string, targetName: string): boolean {
  const prefix = `${targetName}.`;
  return name.startsWith(prefix) && EXCLUSIVE_TEMP_SUFFIX_PATTERN.test(name.slice(prefix.length));
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

async function syncDirectoryIfPresent(path: string): Promise<void> {
  try {
    await syncDirectory(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
