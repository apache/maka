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

import type {
  CommitToolPreparedInput,
  CommitToolOutcomeInput,
  ToolCommitResult,
  SessionRuntimeEventEntry,
  ToolOperationRecord,
  UnsettledToolOperationRecord,
  ImmutableRuntimePrefixProofReadBudget,
} from './runtime-event-store-contract.js';
export type {
  CommitToolPreparedInput,
  CommitToolOutcomeInput,
  ToolCommitResult,
  SessionRuntimeEventEntry,
  ToolOperationRecord,
  UnsettledToolOperationRecord,
  ImmutableRuntimePrefixProofReadBudget,
} from './runtime-event-store-contract.js';

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { assertHandoffClaimSource } from '@maka/core/runtime-handoff';
import {
  buildWorkspaceBaselineAuthorityEvents,
  buildWorkspaceSuccessorAuthorityEvent,
  scanWorkspaceBaselineAuthority,
  WORKSPACE_AUTHORITY_SESSION_ID,
  WORKSPACE_VERSION_AUTHORITY_CAPABILITY_V1,
  type ScannedWorkspaceBaselineAuthority,
  type ScannedWorkspaceSuccessorAuthority,
  type WorkspaceAuthorityLedgerRow,
  type WorkspaceBaselineAuthorityInput,
  type WorkspaceBaselineCommitResult,
  type WorkspaceEpochRecordV1,
  type WorkspaceHeadRecordV1,
  type WorkspaceProjectionRebuildResult,
  type WorkspaceSuccessorAuthorityInput,
  type WorkspaceVersionAcceptedV1,
  type WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import {
  decodeRuntimeEvent,
  decodeRuntimeInvocationOpened,
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
  runtimeEventInvocationOpening,
  type RuntimeEvent,
  type RuntimeEventManagedWorkspaceMutationV2,
  type ToolRecoveryMode,
} from '@maka/core/runtime-event';
import {
  RunSealedError,
  RUNTIME_CONTINUATION_AUTHORITY_V1,
  TOOL_RECOVERY_BUNDLE_CAPABILITY_V1,
  type ContinuationClaimResult,
  type ContinuationClaimStateV1,
  type RuntimeContinuationAuthorityStore,
  type RuntimeInvocationRecoveryInventoryEntry,
  type RuntimeRecoveryBundleCommit,
  type RuntimeRecoveryBundleStore,
  type RuntimeWorkspaceVersionAuthorityStore,
} from '@maka/core/runtime-event-store';
import {
  mayBeTranscriptLedgerInvocationId,
  type RuntimeInvocationPageCursor,
  type RuntimeInvocationPageInput,
  type RuntimeInvocationPageResult,
  type RuntimeInvocationRecord,
  type RuntimeInvocationSearchResult,
} from '@maka/core/runtime-invocation';
import type { ToolRecoveryDecisionFact } from '@maka/core/tool-recovery-fact';
import { stableJsonStringify } from '@maka/core/tool-args-identity';
import {
  type RuntimePartialSnapshot,
  mergeRuntimePartialSnapshots,
  groupRuntimePartialSnapshots,
  compareRuntimePartialSnapshots,
  partialRuntimeStream,
  completedPartialRuntimeStreamKey,
} from './runtime-partial-values.js';
import {
  assertPreparedInput,
  assertOutcomeInput,
  assertPreparedIdentity,
  assertOutcomeIdentity,
} from './tool-commit-validation.js';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import {
  scanToolLedger,
  referencedToolOperationIds,
  ToolLedgerReducer,
  ToolLedgerCorruptionError,
  ToolLedgerRejectionError,
  validateGenericToolLedgerAppend,
  validateIncrementalToolLedgerTransition,
  type ToolLedgerTransitionKind,
} from '@maka/core/tool-ledger-scanner';
import {
  buildImmutableRuntimePrefix,
  buildImmutableRuntimePrefixProof,
  continuationStartEventMatchesClaim,
  decodeContinuationClaim,
  type ContinuationClaimV1,
  type ImmutableRuntimePrefixV1,
  type ImmutableRuntimePrefixProofV1,
  type RuntimeBoundaryDigest,
} from '@maka/core/runtime-boundary';
import {
  assertToolRecoveryEventBundle,
  interpretScannedToolRecovery,
} from '@maka/core/tool-recovery-bundle';
import {
  configureSqliteRuntimeDatabase,
  migrateSqliteRuntimeDatabase,
  readUserVersion,
  RUNTIME_RECOVERY_AUTHORITY_CAPABILITY,
  RUNTIME_RECOVERY_AUTHORITY_CAPABILITY_VERSION,
  RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY,
  RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY_VERSION,
  RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY,
  RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY_VERSION,
  runtimeEventKind,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from './sqlite-runtime-schema.js';
import {
  registerWorkspaceBaselineAuthorityWriterInternal,
  type ManagedMutationNoEffectClaimV1,
  type ManagedMutationTerminalCommitInput,
  type ManagedMutationTerminalCommitResult,
  type WorkspaceSuccessorCommitInput,
  type WorkspaceSuccessorCommitResult,
} from './workspace-version-authority-internal.js';
import type {
  ConversationCopyRuntimeEventBatch,
  ImmutableSteeringMessageProof,
  RecoveryMessageEventQuery,
  RuntimeEventScanBudget,
  RuntimeEventScanResult,
} from './agent-run-store.js';
import {
  assertEvidenceReadBudget,
  measureEvidenceRows,
  type BoundedEvidenceReadResult,
  type EvidenceReadBudget,
} from './bounded-evidence.js';
import type { OperationalStateDatabaseLease } from './operational-state-store.js';
import {
  assertFoldedSearchTerm,
  recallFoldedMatchClause,
  registerRecallFoldFunction,
} from './recall-fold.js';
import { immutableSteeringMessageId, isRuntimeStorageSafeId } from './runtime-event-invariants.js';
import { assertNoReservedWorkspaceAuthorityAppend } from './runtime-event-authority.js';
import {
  rebuildTranscriptTurnExtents,
  recordTranscriptTurnExtent,
  RuntimeTranscriptQuery,
  TERMINAL_RUNTIME_EVENT_SQL,
  type RuntimeTranscriptRun,
  type RuntimeTranscriptRunRequest,
  type RuntimeTranscriptTurn,
  type RuntimeTranscriptTurnsRequest,
} from './runtime-transcript-query.js';

export { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';

export type { ToolRecoveryMode } from '@maka/core/runtime-event';

const RUNTIME_EVENT_SCAN_BATCH_SIZE = 128;
const RUNTIME_PARTIAL_SEGMENT_TARGET_BYTES = 64 * 1024;
const RECOVERY_MESSAGE_QUERY_BATCH_SIZE = 400;
const TOOL_LEDGER_CACHE_EVENT_OVERHEAD_BYTES = 1024;
const DEFAULT_TOOL_LEDGER_CACHE_BUDGET: ToolLedgerCacheBudget = {
  maxEntries: 32,
  maxEstimatedBytes: 16 * 1024 * 1024,
  maxSingleEntryEstimatedBytes: 8 * 1024 * 1024,
};
const IMMUTABLE_STEERING_SQL_PREDICATE = `
  event_kind = 'text'
  AND CASE
    WHEN json_valid(payload_json)
    THEN json_extract(payload_json, '$.partial')
  END = 0
  AND CASE
    WHEN json_valid(payload_json)
    THEN json_extract(payload_json, '$.content.steering')
  END = 1
`;

function assertRuntimeEventScanBudget(budget: RuntimeEventScanBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid RuntimeEvent scan ${name}`);
    }
  }
}

function assertImmutableRuntimePrefixProofReadBudget(
  budget: ImmutableRuntimePrefixProofReadBudget,
): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid immutable RuntimeEvent prefix proof ${name}`);
    }
  }
}

function requireRuntimeEventScanCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid RuntimeEvent scan measurement');
  }
  return value as number;
}

function normalizeToolLedgerCacheBudget(
  override: Partial<ToolLedgerCacheBudget> | undefined,
): ToolLedgerCacheBudget {
  const budget = { ...DEFAULT_TOOL_LEDGER_CACHE_BUDGET, ...override };
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid tool ledger cache ${name}`);
    }
  }
  return budget;
}

function estimateToolLedgerCacheBytes(storedPayloadBytes: number, eventCount: number): number {
  const estimate = storedPayloadBytes * 2 + eventCount * TOOL_LEDGER_CACHE_EVENT_OVERHEAD_BYTES;
  return Number.isSafeInteger(estimate) ? estimate : Number.MAX_SAFE_INTEGER;
}

const require = createRequire(import.meta.url);

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

function configureSqliteRuntimeReadOnlyDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA query_only = ON');
}

export type ToolJournalState =
  | 'prepared'
  | 'reconcile_observed'
  | 'outcome_committed'
  | 'recovery_completed'
  | 'recovery_parked'
  | 'abandoned'
  | 'interrupted_unknown';

export type SqliteRuntimeStoreFailpoint =
  | 'after_runtime_event_insert'
  | 'after_journal_event_insert'
  | 'after_recovery_reconcile'
  | 'after_recovery_outcome'
  | 'after_recovery_decision'
  | 'after_continuation_claim_insert'
  | 'after_continuation_start_insert'
  | 'after_workspace_epoch_event_insert'
  | 'after_workspace_version_event_insert'
  | 'after_workspace_epoch_projection_insert'
  | 'after_workspace_version_projection_insert'
  | 'after_workspace_head_projection_insert'
  | 'after_workspace_successor_event_insert'
  | 'after_workspace_successor_projection_insert'
  | 'after_workspace_successor_head_update'
  | 'after_workspace_canonical_scan';

export interface SqliteRuntimeStoreOptions {
  failpoint?: (point: SqliteRuntimeStoreFailpoint) => void;
  readOnly?: boolean;
  /** @internal Repository connection supplied by the operational DB owner. */
  databaseLease?: OperationalStateDatabaseLease;
  /** @internal Test and benchmark override; production uses the fixed default budget. */
  toolLedgerCacheBudget?: Partial<ToolLedgerCacheBudget>;
}

export interface RuntimeEventBatchImportResult {
  created: boolean[];
}

export interface ToolProjectionRebuildResult {
  operations: number;
  journalEvents: number;
}

export interface ToolJournalEventRecord {
  journalEventId: string;
  operationId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  state: ToolJournalState;
  runtimeEventId?: string;
  canonicalArgsHash?: string;
  recoveryMode?: ToolRecoveryMode;
  externalHandle?: string;
  metadata?: unknown;
  committedAt: number;
}

export function createSqliteRuntimeStore(
  path: string,
  options: SqliteRuntimeStoreOptions = {},
): SqliteRuntimeStore {
  return new SqliteRuntimeStore(path, options);
}

export class SqliteRuntimeStore
  implements
    RuntimeRecoveryBundleStore,
    RuntimeContinuationAuthorityStore,
    RuntimeWorkspaceVersionAuthorityStore
{
  readonly durability = 'canonical' as const;
  readonly toolBoundaryProtocol = 't1_after_preflight_v1' as const;
  readonly recoveryBundleCapability = TOOL_RECOVERY_BUNDLE_CAPABILITY_V1;
  readonly continuationAuthorityCapability = RUNTIME_CONTINUATION_AUTHORITY_V1;
  readonly workspaceVersionAuthorityCapability = WORKSPACE_VERSION_AUTHORITY_CAPABILITY_V1;
  private readonly db: DatabaseSync;
  private readonly databaseLease?: OperationalStateDatabaseLease;
  private readonly toolLedgerCacheBudget: ToolLedgerCacheBudget;
  private readonly toolLedgerCache = new Map<string, ToolLedgerCacheEntry>();
  private toolLedgerCacheEstimatedBytes = 0;
  private toolLedgerCacheEventCount = 0;
  private readonly toolLedgerCacheMetrics: ToolLedgerCacheMetrics = {
    hits: 0,
    misses: 0,
    budgetEvictions: 0,
    terminalEvictions: 0,
    transientEntries: 0,
  };
  private readonly uncommittedToolLedgerStates = new Map<
    ToolLedgerReducer,
    UncommittedToolLedgerState
  >();
  private toolLedgerCacheVersion: string | undefined;
  private localCommittedWriteRevision = 0;
  private closed = false;
  private readonly uncommittedEventSessions = new Set<string>();
  private readonly eventCommitListeners = new Set<(sessionId: string) => void>();

  constructor(
    path: string,
    private readonly options: SqliteRuntimeStoreOptions = {},
  ) {
    this.toolLedgerCacheBudget = normalizeToolLedgerCacheBudget(options.toolLedgerCacheBudget);
    if (options.readOnly && options.databaseLease) {
      throw new Error('Operational state database leases cannot be opened read-only');
    }
    if (path !== ':memory:' && !options.readOnly) mkdirSync(dirname(path), { recursive: true });
    if (options.databaseLease) {
      this.databaseLease = options.databaseLease;
      this.db = options.databaseLease.database;
      assertRecoveryAuthorityCapability(this.db);
      assertContinuationAuthorityCapability(this.db);
      assertWorkspaceVersionAuthorityCapability(this.db);
      registerRecallFoldFunction(this.db);
      if (!options.readOnly) {
        this.registerWorkspaceBaselineAuthorityWriter();
      }
      return;
    }
    const DatabaseSync = loadDatabaseSync();
    this.db = options.readOnly
      ? new DatabaseSync(path, { readOnly: true })
      : new DatabaseSync(path);
    try {
      if (options.readOnly) {
        configureSqliteRuntimeReadOnlyDatabase(this.db);
        const version = readUserVersion(this.db);
        if (version !== SQLITE_RUNTIME_SCHEMA_VERSION) {
          throw new Error(
            `SQLite runtime schema ${version} cannot be read without upgrading to ${SQLITE_RUNTIME_SCHEMA_VERSION}`,
          );
        }
      } else {
        configureSqliteRuntimeDatabase(this.db);
        migrateSqliteRuntimeDatabase(this.db);
      }
      assertRecoveryAuthorityCapability(this.db);
      assertContinuationAuthorityCapability(this.db);
      assertWorkspaceVersionAuthorityCapability(this.db);
      registerRecallFoldFunction(this.db);
      if (!options.readOnly) {
        this.registerWorkspaceBaselineAuthorityWriter();
      }
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  schemaVersion(): number {
    return readUserVersion(this.db);
  }

  journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as
      | { journal_mode?: unknown }
      | undefined;
    return typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : '';
  }

  foreignKeysEnabled(): boolean {
    const row = this.db.prepare('PRAGMA foreign_keys').get() as
      | { foreign_keys?: unknown }
      | undefined;
    return row?.foreign_keys === 1;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearToolLedgerCache();
    this.uncommittedToolLedgerStates.clear();
    if (this.databaseLease) this.databaseLease.close();
    else this.db.close();
  }

  async appendRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
    _options: { durable?: boolean } = {},
  ): Promise<void> {
    const canonicalEvent = canonicalizeRuntimeEventForStorage(event);
    assertNoReservedToolLedgerFact(canonicalEvent);
    await this.importRuntimeEvent(sessionId, runId, canonicalEvent);
  }

  async appendRuntimePartialBatch(
    sessionId: string,
    runId: string,
    events: readonly RuntimeEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    const canonicalEvents = events.map(canonicalizeRuntimeEventForStorage);
    for (const event of canonicalEvents) {
      assertNoReservedToolLedgerFact(event);
      if (sessionId !== event.sessionId || runId !== event.runId) {
        throw new Error(`RuntimeEvent store identity does not match event ${event.id}`);
      }
    }
    this.transaction(() => this.importRuntimePartialBatchSync(canonicalEvents));
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const canonicalEvent = canonicalizeRuntimeEventForStorage(event);
    assertNoReservedToolLedgerFact(canonicalEvent);
    if (isPartialRuntimeEvent(canonicalEvent) || !isTerminalRuntimeEvent(canonicalEvent)) {
      throw new Error(
        'Only a final terminal RuntimeEvent can cross the terminal durability barrier',
      );
    }
    const existing = await this.readImmutableRuntimeEvents(sessionId, runId);
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
      const terminalEvents = existing.filter(isTerminalRuntimeEvent);
      if (
        terminalEvents.length !== 1 ||
        terminalEvents[0]?.id !== canonicalEvent.id ||
        existing.at(-1)?.id !== canonicalEvent.id
      ) {
        throw new Error('Terminal RuntimeEvent must be the immutable ledger tail');
      }
      this.invalidateToolLedgerCacheForInvocation(canonicalEvent.invocationId);
      return;
    }
    const existingTerminal = existing.find(isTerminalRuntimeEvent);
    if (existingTerminal) {
      throw new Error(`Run ${runId} already has terminal RuntimeEvent ${existingTerminal.id}`);
    }
    await this.importRuntimeEvent(sessionId, runId, canonicalEvent);
  }

  async importRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<boolean> {
    const canonicalEvent = canonicalizeRuntimeEventForStorage(event);
    assertNoReservedToolLedgerFact(canonicalEvent);
    if (sessionId !== canonicalEvent.sessionId || runId !== canonicalEvent.runId) {
      throw new Error(`RuntimeEvent store identity does not match event ${canonicalEvent.id}`);
    }
    return this.transaction(() => this.importRuntimeEventSync(canonicalEvent));
  }

  async importRuntimeEventsBatch(input: {
    sessionId: string;
    runId: string;
    events: readonly RuntimeEvent[];
  }): Promise<RuntimeEventBatchImportResult> {
    const events = input.events.map(canonicalizeRuntimeEventForStorage);
    for (const event of events) {
      assertNoReservedToolLedgerFact(event);
      if (event.sessionId !== input.sessionId || event.runId !== input.runId) {
        throw new Error(`RuntimeEvent store identity does not match event ${event.id}`);
      }
    }
    return this.transaction(() => {
      if (events.some(isToolLedgerBearingEvent)) {
        this.assertToolLedgerTransition(events, 'generic_append');
      }
      // Batch imports preserve already-persisted history, including legacy
      // terminal/tool gaps that recovery will classify when projections are
      // rebuilt. New terminal writes through appendRuntimeEvent must obey the
      // unsettled-operation invariant below.
      const created = events.map((event) => this.importRuntimeEventSync(event, true));
      return { created };
    });
  }

  async importConversationCopyRuntimeEvents(
    sessionId: string,
    batches: readonly ConversationCopyRuntimeEventBatch[],
  ): Promise<void> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    const canonicalBatches = batches.map(({ runId, events }) => {
      assertRuntimeStorageSafeId(runId, 'Invalid run id');
      return {
        runId,
        events: events.map(canonicalizeRuntimeEventForStorage),
      };
    });
    const canonicalEvents = canonicalBatches.flatMap(({ events }) => events);
    if (new Set(canonicalEvents.map(({ id }) => id)).size !== canonicalEvents.length) {
      throw new Error('Conversation copy contains duplicate RuntimeEvents');
    }
    for (const { runId, events } of canonicalBatches) {
      for (const event of events) {
        assertNoReservedWorkspaceAuthorityAppend(event);
        if (isPartialRuntimeEvent(event)) {
          throw new Error('Conversation copy cannot import partial RuntimeEvents');
        }
        if (event.sessionId !== sessionId || event.runId !== runId) {
          throw new Error(`RuntimeEvent store identity does not match event ${event.id}`);
        }
      }
    }
    const scan = scanToolLedger(canonicalEvents);
    if (scan.hasCorruption) {
      throw new Error(
        `Conversation copy RuntimeEvent ledger is corrupt: ${scan.issues[0]?.code ?? 'unknown'}`,
      );
    }
    this.transaction(() => {
      const eventsByRun = new Map<string, RuntimeEvent[]>();
      for (const { runId, events } of canonicalBatches) {
        eventsByRun.set(runId, [...(eventsByRun.get(runId) ?? []), ...events]);
      }
      const newRunIds = new Set<string>();
      for (const [runId, events] of eventsByRun) {
        const existing = (
          this.db
            .prepare(`
              SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
              FROM runtime_events
              WHERE session_id = ? AND run_id = ?
              ORDER BY event_seq ASC, event_id ASC
            `)
            .all(sessionId, runId) as unknown as RuntimeEventStorageRow[]
        ).map(decodeRuntimeEventStorageRow);
        if (existing.length > 0 && !isDeepStrictEqual(existing, events)) {
          throw new Error(`Conversation copy RuntimeEvent identity conflict for run ${runId}`);
        }
        if (existing.length === 0) newRunIds.add(runId);
      }
      for (const { runId, events } of canonicalBatches) {
        if (!newRunIds.has(runId)) continue;
        for (const event of events) this.insertRuntimeEvent(event, event.ts, true);
      }
      if (canonicalEvents.some(isToolLedgerBearingEvent)) {
        this.rebuildToolProjectionsFromRuntimeEventsSync(sessionId);
      }
    });
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return this.readRuntimeEventsSync(sessionId, runId);
  }

  private transcriptQuery(): RuntimeTranscriptQuery {
    return new RuntimeTranscriptQuery(this.db, (sessionId, invocationId) => {
      // By invocation rather than by run: both shelves key their opening on it,
      // so a page's records cost the page instead of the Session's Turns.
      const opening = this.readInvocationOpeningsSync(sessionId, {
        direction: 'asc',
        invocationId,
      }).at(0);
      if (!opening) throw new Error(`Transcript invocation ${invocationId} is missing`);
      return this.completeInvocationRecordSync(opening);
    });
  }

  async readTranscriptHighWater(sessionId: string): Promise<number | null> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    return this.readTransaction(() => this.transcriptQuery().highWater(sessionId));
  }

  async readTranscriptRun<T>(
    sessionId: string,
    request: RuntimeTranscriptRunRequest,
    project: (
      run: RuntimeTranscriptRun,
      events: Iterable<{ readonly ordinal: number; readonly event: RuntimeEvent }>,
    ) => T,
  ): Promise<T | undefined> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    return this.readTransaction(() => this.transcriptQuery().run(sessionId, request, project));
  }

  async readTranscriptTurns(
    sessionId: string,
    request: RuntimeTranscriptTurnsRequest,
  ): Promise<RuntimeTranscriptTurn[]> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    return this.readTransaction(() => this.transcriptQuery().turns(sessionId, request));
  }

  async readTranscriptTurnCrossing(sessionId: string, ordinal: number): Promise<boolean> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    return this.readTransaction(() => this.transcriptQuery().crossing(sessionId, ordinal));
  }

  /**
   * Enumerate a Session's invocations: the opening fact names each one, and its
   * highest-sequence event says whether it ended.
   *
   * Invocations that predate the opening fact could not be given one without
   * rewriting an immutable sequence, so the migration parked their openings in
   * `runtime_legacy_invocation_openings`. Both shelves are merged here and the
   * result says nothing about which one a record came from: an opening is an
   * opening, and a consumer that branched on its storage would be encoding the
   * migration window into its own logic.
   */
  async listSessionInvocations(sessionId: string): Promise<RuntimeInvocationRecord[]> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    return this.readTransaction(() =>
      this.readInvocationOpeningsSync(sessionId, { direction: 'asc' }).map((row) =>
        this.completeInvocationRecordSync(row),
      ),
    );
  }

  async listInvocationRecoveryInventory(
    sessionIds: readonly string[],
  ): Promise<RuntimeInvocationRecoveryInventoryEntry[]> {
    const selectedSessionIds = [...new Set(sessionIds)];
    for (const sessionId of selectedSessionIds) {
      assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    }
    if (selectedSessionIds.length === 0) return [];
    const selectedJson = JSON.stringify(selectedSessionIds);
    return this.readTransaction(() => {
      const eventRows = this.db
        .prepare(`
          WITH selected(session_id) AS (SELECT value FROM json_each(?))
          SELECT
            opening.rowid AS opening_rowid,
            opening.session_id AS session_id,
            opening.invocation_id AS invocation_id,
            1 AS from_events,
            NULL AS run_id,
            NULL AS turn_id,
            NULL AS opened_at,
            (
              SELECT terminal.rowid
              FROM runtime_events AS terminal INDEXED BY runtime_events_terminal
              WHERE terminal.invocation_id = opening.invocation_id
                AND ${TERMINAL_RUNTIME_EVENT_SQL.replaceAll('payload_json', 'terminal.payload_json')}
              ORDER BY terminal.event_seq
              LIMIT 1
            ) AS terminal_rowid
          FROM selected
          JOIN runtime_events AS opening INDEXED BY runtime_events_by_session_kind
            ON opening.session_id = selected.session_id
            AND opening.event_kind = 'invocation_opened'
        `)
        .all(selectedJson) as unknown as RuntimeInvocationRecoveryInventoryRow[];
      const legacyRows = this.db
        .prepare(`
          WITH selected(session_id) AS (SELECT value FROM json_each(?))
          SELECT
            NULL AS opening_rowid,
            legacy.session_id AS session_id,
            legacy.invocation_id AS invocation_id,
            legacy.run_id AS run_id,
            legacy.turn_id AS turn_id,
            legacy.opened_at AS opened_at,
            0 AS from_events,
            (
              SELECT terminal.rowid
              FROM runtime_events AS terminal INDEXED BY runtime_events_terminal
              WHERE terminal.invocation_id = legacy.invocation_id
                AND ${TERMINAL_RUNTIME_EVENT_SQL.replaceAll('payload_json', 'terminal.payload_json')}
              ORDER BY terminal.event_seq
              LIMIT 1
            ) AS terminal_rowid
          FROM selected
          JOIN runtime_legacy_invocation_openings AS legacy
            ON legacy.session_id = selected.session_id
          WHERE NOT EXISTS (
              SELECT 1 FROM runtime_events AS opening
              WHERE opening.invocation_id = legacy.invocation_id
                AND opening.event_kind = 'invocation_opened'
            )
        `)
        .all(selectedJson) as unknown as RuntimeInvocationRecoveryInventoryRow[];
      const handoffRows = this.db
        .prepare(`
          WITH selected(session_id) AS (SELECT value FROM json_each(?))
          SELECT
            terminal.rowid AS terminal_rowid,
            terminal.event_id AS event_id,
            terminal.session_id AS session_id,
            terminal.invocation_id AS invocation_id,
            terminal.run_id AS run_id,
            terminal.turn_id AS turn_id,
            terminal.payload_json AS payload_json
          FROM selected
          JOIN runtime_events AS terminal INDEXED BY runtime_events_by_session_kind
            ON terminal.session_id = selected.session_id
            AND terminal.event_kind = 'invocation_end'
          WHERE CASE
            WHEN json_valid(terminal.payload_json)
            THEN json_type(terminal.payload_json, '$.actions.handoffPause')
          END IS NOT NULL
        `)
        .all(selectedJson) as unknown as RuntimeHandoffTerminalStorageRow[];
      const handoffByRowId = new Map(handoffRows.map((row) => [row.terminal_rowid, row]));
      const eventIdentity = this.db.prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, committed_at
        FROM runtime_events
        WHERE rowid = ?
      `);
      const eventCandidate = this.db.prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, committed_at, payload_json
        FROM runtime_events
        WHERE rowid = ?
      `);
      const legacyCandidate = this.db.prepare(`
        SELECT opening_json
        FROM runtime_legacy_invocation_openings
        WHERE invocation_id = ?
      `);
      return [...eventRows, ...legacyRows]
        .sort(
          (a, b) =>
            a.session_id.localeCompare(b.session_id) ||
            a.invocation_id.localeCompare(b.invocation_id),
        )
        .map((row): RuntimeInvocationRecoveryInventoryEntry => {
          const base = { sessionId: row.session_id, invocationId: row.invocation_id };
          const handoff =
            row.terminal_rowid === null ? undefined : handoffByRowId.get(row.terminal_rowid);
          const needsCandidate = row.terminal_rowid === null || handoff !== undefined;
          const needsIdentity =
            needsCandidate || mayBeTranscriptLedgerInvocationId(row.invocation_id);
          if (!needsIdentity) return base;

          let identity: NonNullable<RuntimeInvocationRecoveryInventoryEntry['identity']>;
          let openingJson: string | undefined;
          let openingEventId: string | undefined;
          if (row.from_events === 1) {
            if (row.opening_rowid === null) {
              throw new Error(`Runtime invocation opening row is missing: ${row.invocation_id}`);
            }
            const detail = (needsCandidate ? eventCandidate : eventIdentity).get(
              row.opening_rowid,
            ) as unknown as RuntimeInvocationRecoveryOpeningRow | undefined;
            if (
              !detail ||
              detail.session_id !== row.session_id ||
              detail.invocation_id !== row.invocation_id
            ) {
              throw new Error(`Runtime invocation opening identity changed: ${row.invocation_id}`);
            }
            identity = {
              sessionId: detail.session_id,
              invocationId: detail.invocation_id,
              runId: detail.run_id,
              turnId: detail.turn_id,
              openedAt: detail.committed_at,
            };
            openingEventId = detail.event_id;
            openingJson = detail.payload_json;
          } else {
            if (row.run_id === null || row.turn_id === null || row.opened_at === null) {
              throw new Error(
                `Legacy invocation opening identity is incomplete: ${row.invocation_id}`,
              );
            }
            identity = {
              sessionId: row.session_id,
              invocationId: row.invocation_id,
              runId: row.run_id,
              turnId: row.turn_id,
              openedAt: row.opened_at,
            };
            if (needsCandidate) {
              openingJson = (
                legacyCandidate.get(row.invocation_id) as { opening_json?: unknown } | undefined
              )?.opening_json as string | undefined;
            }
          }
          if (!needsCandidate) return { ...base, identity };
          if (typeof openingJson !== 'string') {
            throw new Error(`Runtime invocation opening payload is missing: ${row.invocation_id}`);
          }

          let opening: RuntimeInvocationRecord['opening'];
          if (row.from_events === 1) {
            const event = decodeRuntimeEventStorageRow({
              event_id: openingEventId ?? '',
              session_id: identity.sessionId,
              invocation_id: identity.invocationId,
              run_id: identity.runId,
              turn_id: identity.turnId,
              payload_json: openingJson,
            });
            const decoded = runtimeEventInvocationOpening(event);
            if (!decoded) {
              throw new Error(
                `RuntimeEvent ${event.id} is indexed as an opening fact but is not one`,
              );
            }
            opening = decoded;
          } else {
            opening = decodeRuntimeInvocationOpened(JSON.parse(openingJson));
          }

          let terminalEvent: RuntimeEvent | undefined;
          if (handoff) {
            if (
              handoff.session_id !== identity.sessionId ||
              handoff.invocation_id !== identity.invocationId ||
              handoff.run_id !== identity.runId ||
              handoff.turn_id !== identity.turnId
            ) {
              throw new Error(`Runtime handoff terminal identity changed: ${row.invocation_id}`);
            }
            terminalEvent = decodeRuntimeEventStorageRow(handoff);
            if (!isTerminalRuntimeEvent(terminalEvent)) {
              throw new Error(`Runtime handoff fact is not terminal: ${terminalEvent.id}`);
            }
          }
          return {
            ...base,
            candidate: {
              ...identity,
              opening,
              ...(terminalEvent ? { terminalEvent } : {}),
            },
          };
        });
    });
  }

  async readRunInvocation(
    sessionId: string,
    runId: string,
  ): Promise<RuntimeInvocationRecord | undefined> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    assertRuntimeStorageSafeId(runId, 'Invalid run id');
    return this.readTransaction(() => {
      const row = this.readInvocationOpeningsSync(sessionId, { direction: 'asc', runId }).at(0);
      return row ? this.completeInvocationRecordSync(row) : undefined;
    });
  }

  /**
   * The first page of a Session's invocations, plus whether more exist.
   *
   * The extra row this reads past the limit is the whole truncation signal, so a
   * caller never has to count a Session it declined to load.
   */
  async listSessionInvocationsBounded(
    sessionId: string,
    limit: number,
  ): Promise<RuntimeInvocationSearchResult> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    assertInvocationSearchLimit(limit);
    return this.readTransaction(() => {
      const rows = this.readInvocationOpeningsSync(sessionId, {
        direction: 'asc',
        limit: limit + 1,
      });
      return {
        invocations: rows.slice(0, limit).map((row) => this.completeInvocationRecordSync(row)),
        truncated: rows.length > limit,
      };
    });
  }

  /** One newest-first page of a Session's invocations. */
  async listSessionInvocationsPage(
    sessionId: string,
    input: RuntimeInvocationPageInput,
  ): Promise<RuntimeInvocationPageResult> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    assertInvocationSearchLimit(input.limit);
    if (input.before) {
      assertRuntimeStorageSafeId(input.before.invocationId, 'Invalid invocation page cursor');
      if (!Number.isFinite(input.before.openedAt)) {
        throw new Error('Invalid invocation page cursor');
      }
    }
    return this.readTransaction(() => {
      const rows = this.readInvocationOpeningsSync(sessionId, {
        direction: 'desc',
        limit: input.limit + 1,
        ...(input.before ? { before: input.before } : {}),
      });
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        invocations: page.map((row) => this.completeInvocationRecordSync(row)),
        nextCursor:
          rows.length > input.limit && last
            ? { openedAt: last.openedAt, invocationId: last.invocationId }
            : null,
      };
    });
  }

  /**
   * One invocation named by its own identity.
   *
   * Absence throws rather than returning `undefined`: every caller here holds an
   * invocation id that some durable fact already handed it, so a missing opening
   * is corruption and not a branch a reader should be asked to handle.
   */
  async readInvocation(sessionId: string, invocationId: string): Promise<RuntimeInvocationRecord> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    assertRuntimeStorageSafeId(invocationId, 'Invalid invocation id');
    return this.readTransaction(() => {
      const row = this.readInvocationOpeningsSync(sessionId, {
        direction: 'asc',
        invocationId,
      }).at(0);
      if (!row) throw new Error(`Runtime invocation not found: ${invocationId}`);
      return this.completeInvocationRecordSync(row);
    });
  }

  /**
   * Read invocation openings off both shelves as one ordered sequence.
   *
   * Every writer of an opening event stamps `committed_at` with the event's own
   * timestamp, so that column orders the event shelf by the same value the
   * record reports as `openedAt` and the legacy shelf keeps under `opened_at`.
   * Ordering and paging therefore happen in SQL, and a bounded caller decodes
   * only the openings it asked for.
   */
  private readInvocationOpeningsSync(
    sessionId: string,
    options: {
      direction: 'asc' | 'desc';
      limit?: number;
      before?: RuntimeInvocationPageCursor;
      invocationId?: string;
      runId?: string;
    },
  ): Omit<RuntimeInvocationRecord, 'terminalEvent'>[] {
    const order = options.direction === 'desc' ? 'DESC' : 'ASC';
    const rows = this.db
      .prepare(`
        SELECT * FROM (
          SELECT
            event_id AS event_id,
            invocation_id AS invocation_id,
            run_id AS run_id,
            turn_id AS turn_id,
            committed_at AS opened_at,
            payload_json AS opening_json,
            1 AS from_events
          FROM runtime_events
          WHERE session_id = :sessionId AND event_kind = 'invocation_opened'
            ${options.runId === undefined ? '' : 'AND run_id = :runId'}
            ${options.invocationId === undefined ? '' : 'AND invocation_id = :invocationId'}
          UNION ALL
          SELECT
            NULL,
            legacy.invocation_id,
            legacy.run_id,
            legacy.turn_id,
            legacy.opened_at,
            legacy.opening_json,
            0
          FROM runtime_legacy_invocation_openings AS legacy
          WHERE legacy.session_id = :sessionId
            ${options.runId === undefined ? '' : 'AND legacy.run_id = :runId'}
            ${options.invocationId === undefined ? '' : 'AND legacy.invocation_id = :invocationId'}
            AND NOT EXISTS (
              SELECT 1 FROM runtime_events
              WHERE runtime_events.invocation_id = legacy.invocation_id
                AND runtime_events.event_kind = 'invocation_opened'
            )
        )
        WHERE (
            :beforeOpenedAt IS NULL
            OR opened_at < :beforeOpenedAt
            OR (opened_at = :beforeOpenedAt AND invocation_id < :beforeInvocationId)
          )
        ORDER BY opened_at ${order}, invocation_id ${order}
        LIMIT :limit
      `)
      .all({
        sessionId,
        ...(options.invocationId === undefined ? {} : { invocationId: options.invocationId }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        beforeOpenedAt: options.before?.openedAt ?? null,
        beforeInvocationId: options.before?.invocationId ?? null,
        limit: options.limit ?? -1,
      }) as unknown as Array<{
      event_id: string | null;
      invocation_id: string;
      run_id: string;
      turn_id: string;
      opened_at: number;
      opening_json: string;
      from_events: number;
    }>;
    return rows.map((row) => {
      if (row.from_events !== 1) {
        return {
          sessionId,
          invocationId: row.invocation_id,
          runId: row.run_id,
          turnId: row.turn_id,
          openedAt: row.opened_at,
          opening: decodeRuntimeInvocationOpened(JSON.parse(row.opening_json)),
        };
      }
      const event = decodeRuntimeEventStorageRow({
        event_id: row.event_id ?? '',
        session_id: sessionId,
        invocation_id: row.invocation_id,
        run_id: row.run_id,
        turn_id: row.turn_id,
        payload_json: row.opening_json,
      });
      const opening = runtimeEventInvocationOpening(event);
      if (!opening) {
        throw new Error(`RuntimeEvent ${event.id} is indexed as an opening fact but is not one`);
      }
      return {
        sessionId: event.sessionId,
        invocationId: event.invocationId,
        runId: event.runId,
        turnId: event.turnId,
        openedAt: event.ts,
        opening,
      };
    });
  }

  /**
   * An invocation's ending is its first terminal event, wherever it sits.
   *
   * The store seals a run on that event, so for anything it wrote itself the
   * first terminal is also the only one and the last event. Ledgers written
   * before the seal existed can carry a straggler after the terminal, and
   * reading those as unfinished would contradict every other reader of the same
   * rule: recovery, the read model and continuation resume all take the first
   * terminal. A ledger that somehow holds two is corrupt, and saying so is the
   * job of those readers — this inventory feeds Session lists, so it reports the
   * ending it can see rather than poisoning the whole Session over one run.
   */
  private completeInvocationRecordSync(
    record: Omit<RuntimeInvocationRecord, 'terminalEvent'>,
  ): RuntimeInvocationRecord {
    const terminalRow = this.db
      .prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
        FROM runtime_events
        WHERE invocation_id = ?
          AND ${TERMINAL_RUNTIME_EVENT_SQL}
        ORDER BY event_seq ASC
        LIMIT 1
      `)
      .get(record.invocationId) as unknown as RuntimeEventStorageRow | undefined;
    const terminal = terminalRow ? decodeRuntimeEventStorageRow(terminalRow) : undefined;
    return {
      ...record,
      ...(terminal && isTerminalRuntimeEvent(terminal) ? { terminalEvent: terminal } : {}),
    };
  }

  async scanRuntimeEvents(
    sessionId: string,
    runId: string,
    budget: RuntimeEventScanBudget,
    visit: (events: readonly RuntimeEvent[]) => void,
  ): Promise<RuntimeEventScanResult> {
    assertRuntimeEventScanBudget(budget);
    return this.readTransaction(() => {
      if (!this.runtimePartialSnapshotFitsScanBudget(sessionId, runId, budget)) {
        return { status: 'limit_exceeded' };
      }
      const snapshots = this.readRuntimePartialSnapshotsSync(sessionId, runId);
      const { leading, afterEvent } = groupRuntimePartialSnapshots(snapshots);
      if (leading.length > 0) {
        visit(leading.sort(compareRuntimePartialSnapshots).map(({ event }) => event));
      }

      let afterSequence = 0;
      let immutableRecords = 0;
      let immutableBytes = 0;
      for (;;) {
        const measured = this.db
          .prepare(
            `
              SELECT event_seq, length(CAST(payload_json AS BLOB)) AS stored_bytes
              FROM runtime_events
              WHERE session_id = ? AND run_id = ? AND event_seq > ?
              ORDER BY event_seq ASC, event_id ASC
              LIMIT ?
            `,
          )
          .all(sessionId, runId, afterSequence, RUNTIME_EVENT_SCAN_BATCH_SIZE) as Array<{
          event_seq?: unknown;
          stored_bytes?: unknown;
        }>;
        if (measured.length === 0) break;
        const sequences: number[] = [];
        let batchBytes = 0;
        for (const row of measured) {
          const sequence = requireRuntimeEventScanCount(row.event_seq);
          const storedBytes = requireRuntimeEventScanCount(row.stored_bytes);
          if (storedBytes < 1 || storedBytes > budget.maxRecordBytes) {
            return { status: 'limit_exceeded' };
          }
          if (sequences.length > 0 && batchBytes + storedBytes > budget.maxBatchBytes) break;
          if (
            immutableRecords + 1 > budget.maxImmutableRecords ||
            immutableBytes + storedBytes > budget.maxImmutableBytes
          ) {
            return { status: 'limit_exceeded' };
          }
          sequences.push(sequence);
          batchBytes += storedBytes;
          immutableRecords += 1;
          immutableBytes += storedBytes;
          if (batchBytes >= budget.maxBatchBytes) break;
        }
        const placeholders = sequences.map(() => '?').join(', ');
        const rows = this.db
          .prepare(
            `
              SELECT event_id, session_id, invocation_id, run_id, turn_id,
                event_seq, payload_json
              FROM runtime_events
              WHERE session_id = ? AND run_id = ? AND event_seq IN (${placeholders})
              ORDER BY event_seq ASC, event_id ASC
            `,
          )
          .all(sessionId, runId, ...sequences) as unknown as Array<
          RuntimeEventStorageRow & { event_seq: number }
        >;
        if (rows.length !== sequences.length) {
          throw new Error('RuntimeEvent scan changed inside its read transaction');
        }
        const batch: RuntimeEvent[] = [];
        for (const row of rows) {
          const event = decodeRuntimeEventStorageRow(row);
          batch.push(event);
          const anchored = afterEvent.get(event.id);
          if (anchored) {
            batch.push(
              ...anchored.sort(compareRuntimePartialSnapshots).map((snapshot) => snapshot.event),
            );
            afterEvent.delete(event.id);
          }
        }
        visit(batch);
        afterSequence = rows.at(-1)!.event_seq;
      }
      for (const orphaned of afterEvent.values()) {
        visit(orphaned.sort(compareRuntimePartialSnapshots).map((snapshot) => snapshot.event));
      }
      return { status: 'complete' };
    });
  }

  private runtimePartialSnapshotFitsScanBudget(
    sessionId: string,
    runId: string,
    budget: RuntimeEventScanBudget,
  ): boolean {
    const rows = this.db
      .prepare(
        `
          SELECT
            length(CAST(snapshot.payload_json AS BLOB)) +
            length(CAST(snapshot.text_content AS BLOB)) +
            coalesce(sum(length(CAST(segment.text_content AS BLOB))), 0) +
            coalesce(length(CAST(snapshot.after_event_id AS BLOB)), 0) AS stored_bytes
          FROM runtime_partial_snapshots AS snapshot
          LEFT JOIN runtime_partial_segments AS segment
            ON segment.stream_key = snapshot.stream_key
          WHERE snapshot.session_id = ? AND snapshot.run_id = ?
          GROUP BY snapshot.stream_key
          LIMIT ?
        `,
      )
      .all(sessionId, runId, budget.maxPartialRecords + 1) as Array<{ stored_bytes?: unknown }>;
    if (rows.length > budget.maxPartialRecords) return false;
    let bytes = 0;
    for (const row of rows) {
      const storedBytes = requireRuntimeEventScanCount(row.stored_bytes);
      if (storedBytes < 1 || storedBytes > budget.maxRecordBytes) return false;
      bytes += storedBytes;
      if (bytes > budget.maxPartialBytes) return false;
    }
    return true;
  }

  async readRuntimeEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<RuntimeEvent>> {
    assertEvidenceReadBudget(budget);
    const rows = this.db
      .prepare(`
        SELECT stored_bytes
        FROM (
          SELECT length(CAST(payload_json AS BLOB)) AS stored_bytes
          FROM runtime_events
          WHERE session_id = ? AND run_id = ?
          UNION ALL
          SELECT
            length(CAST(payload_json AS BLOB)) +
            length(CAST(text_content AS BLOB)) +
            coalesce((
              SELECT sum(length(CAST(segment.text_content AS BLOB)))
              FROM runtime_partial_segments AS segment
              WHERE segment.stream_key = runtime_partial_snapshots.stream_key
            ), 0) +
            coalesce(length(CAST(after_event_id AS BLOB)), 0) AS stored_bytes
          FROM runtime_partial_snapshots
          WHERE session_id = ? AND run_id = ?
        )
        LIMIT ?
      `)
      .all(sessionId, runId, sessionId, runId, budget.maxRecords + 1) as Array<{
      stored_bytes?: unknown;
    }>;
    const measurement = measureEvidenceRows(
      rows,
      budget,
      'Invalid SQLite RuntimeEvent evidence measurement row',
    );
    if (!measurement) return { status: 'limit_exceeded' };
    return {
      status: 'complete',
      records: this.readRuntimeEventsSync(sessionId, runId),
      ...measurement,
    };
  }

  private readRuntimeEventsSync(sessionId: string, runId: string): RuntimeEvent[] {
    const immutable = this.readImmutableRuntimeEventsSync(sessionId, runId);
    return mergeRuntimePartialSnapshots(
      immutable,
      this.readRuntimePartialSnapshotsSync(sessionId, runId),
    );
  }

  private readRuntimePartialSnapshotsSync(
    sessionId: string,
    runId: string,
  ): RuntimePartialSnapshot[] {
    const partials = this.db
      .prepare(`
      SELECT stream_key, session_id, invocation_id, run_id, turn_id,
        payload_json, text_content, after_event_id
      FROM runtime_partial_snapshots
      WHERE session_id = ? AND run_id = ?
      ORDER BY updated_at ASC, stream_key ASC
      `)
      .all(sessionId, runId) as unknown as RuntimePartialStorageRow[];
    const segmentText = new Map<string, string[]>();
    const segments = this.db
      .prepare(`
      SELECT segment.stream_key, segment.text_content
      FROM runtime_partial_segments AS segment
      INNER JOIN runtime_partial_snapshots AS snapshot
        ON snapshot.stream_key = segment.stream_key
      WHERE snapshot.session_id = ? AND snapshot.run_id = ?
      ORDER BY segment.stream_key ASC, segment.segment_seq ASC
    `)
      .iterate(sessionId, runId) as Iterable<{ stream_key: string; text_content: string }>;
    let streamKey: string | undefined;
    let chunks: string[] = [];
    let tail: string[] = [];
    let tailBytes = 0;
    const flushTail = () => {
      if (tail.length === 0) return;
      chunks.push(tail.join(''));
      tail = [];
      tailBytes = 0;
    };
    const flushStream = () => {
      if (streamKey === undefined) return;
      flushTail();
      segmentText.set(streamKey, chunks);
      chunks = [];
    };
    for (const segment of segments) {
      if (typeof segment.stream_key !== 'string' || typeof segment.text_content !== 'string') {
        throw new Error('Invalid RuntimeEvent partial segment');
      }
      if (segment.stream_key !== streamKey) {
        flushStream();
        streamKey = segment.stream_key;
      }
      const bytes = Buffer.byteLength(segment.text_content, 'utf8');
      if (bytes === 0) continue;
      if (bytes > RUNTIME_PARTIAL_SEGMENT_TARGET_BYTES) {
        flushTail();
        chunks.push(segment.text_content);
        continue;
      }
      if (tailBytes + bytes > RUNTIME_PARTIAL_SEGMENT_TARGET_BYTES) flushTail();
      tail.push(segment.text_content);
      tailBytes += bytes;
    }
    flushStream();
    return partials.flatMap((row) => {
      try {
        const event = decodeRuntimePartialStorageRow(row);
        if (event.content?.kind === 'text' || event.content?.kind === 'thinking') {
          event.content = {
            ...event.content,
            text: row.text_content + (segmentText.get(row.stream_key)?.join('') ?? ''),
          };
        }
        return [
          {
            event,
            ...(row.after_event_id ? { afterEventId: row.after_event_id } : {}),
          },
        ];
      } catch {
        // Mutable partial snapshots are presentation state, never ledger
        // authority. A corrupt snapshot is skipped without hiding immutable
        // RuntimeEvents from the same run.
        return [];
      }
    });
  }

  async readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return this.readImmutableRuntimeEventsSync(sessionId, runId);
  }

  private readImmutableRuntimeEventsSync(sessionId: string, runId: string): RuntimeEvent[] {
    const rows = this.db
      .prepare(`
      SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
      FROM runtime_events
      WHERE session_id = ? AND run_id = ?
      ORDER BY event_seq ASC, event_id ASC
    `)
      .all(sessionId, runId) as unknown as RuntimeEventStorageRow[];
    return rows.map(decodeRuntimeEventStorageRow);
  }

  async readImmutableRuntimePrefix(input: {
    sessionId: string;
    runId: string;
    upToEventSeq?: number;
  }): Promise<ImmutableRuntimePrefixV1> {
    return this.readImmutableRuntimePrefixSync(input);
  }

  private readImmutableRuntimePrefixSync(input: {
    sessionId: string;
    runId: string;
    upToEventSeq?: number;
  }): ImmutableRuntimePrefixV1 {
    if (
      input.upToEventSeq !== undefined &&
      (!Number.isSafeInteger(input.upToEventSeq) || input.upToEventSeq <= 0)
    ) {
      throw new Error('Invalid immutable RuntimeEvent prefix high-water');
    }
    const highWater = input.upToEventSeq ?? null;
    const rows = this.db
      .prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, event_seq, payload_json
        FROM runtime_events
        WHERE session_id = ? AND run_id = ?
          AND (? IS NULL OR event_seq <= ?)
        ORDER BY event_seq ASC
      `)
      .all(
        input.sessionId,
        input.runId,
        highWater,
        highWater,
      ) as unknown as RuntimeEventPrefixStorageRow[];
    if (rows.length === 0) {
      throw new Error('immutable RuntimeEvent prefix is empty');
    }
    const lastEventSeq = rows.at(-1)?.event_seq;
    if (input.upToEventSeq !== undefined && lastEventSeq !== input.upToEventSeq) {
      throw new Error(
        `immutable RuntimeEvent prefix high-water ${input.upToEventSeq} is unavailable`,
      );
    }
    const decoded = rows.map((row) => ({
      eventSeq: row.event_seq,
      event: decodeRuntimeEventStorageRow(row),
    }));
    const first = decoded[0]!.event;
    return buildImmutableRuntimePrefix(
      {
        sessionId: first.sessionId,
        invocationId: first.invocationId,
        runId: first.runId,
        turnId: first.turnId,
      },
      decoded,
    );
  }

  async readImmutableRuntimePrefixProof(
    input: { sessionId: string; runId: string; upToEventSeq?: number },
    budget: ImmutableRuntimePrefixProofReadBudget,
  ): Promise<ImmutableRuntimePrefixProofV1> {
    assertImmutableRuntimePrefixProofReadBudget(budget);
    if (
      input.upToEventSeq !== undefined &&
      (!Number.isSafeInteger(input.upToEventSeq) || input.upToEventSeq <= 0)
    ) {
      throw new Error('Invalid immutable RuntimeEvent prefix high-water');
    }
    const highWater = input.upToEventSeq ?? null;
    const cursor = this.db
      .prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, event_seq,
          length(CAST(payload_json AS BLOB)) AS stored_bytes,
          CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json END AS payload_json
        FROM runtime_events
        WHERE session_id = ? AND run_id = ?
          AND (? IS NULL OR event_seq <= ?)
        ORDER BY event_seq ASC
      `)
      .iterate(budget.maxRecordBytes, input.sessionId, input.runId, highWater, highWater)
      [Symbol.iterator]() as Iterator<RuntimeEventPrefixProofStorageRow>;
    const firstRow = cursor.next();
    if (firstRow.done) throw new Error('immutable RuntimeEvent prefix is empty');
    let count = 0;
    let bytes = 0;
    let lastEventSeq = 0;
    const decode = function* (): Iterable<{ eventSeq: number; event: RuntimeEvent }> {
      let step: IteratorResult<RuntimeEventPrefixProofStorageRow> = firstRow;
      while (!step.done) {
        const row = step.value;
        count += 1;
        if (count > budget.maxEvents) {
          throw new Error('Immutable RuntimeEvent prefix proof exceeds its event limit');
        }
        const payloadJson = row.payload_json;
        if (payloadJson === null) {
          throw new Error('Immutable RuntimeEvent prefix proof exceeds its record byte limit');
        }
        bytes += requireRuntimeEventScanCount(row.stored_bytes);
        if (bytes > budget.maxBytes) {
          throw new Error('Immutable RuntimeEvent prefix proof exceeds its byte limit');
        }
        lastEventSeq = requireRuntimeEventScanCount(row.event_seq);
        yield {
          eventSeq: lastEventSeq,
          event: decodeRuntimeEventStorageRow({ ...row, payload_json: payloadJson }),
        };
        step = cursor.next();
      }
    };
    const proof = buildImmutableRuntimePrefixProof(
      {
        sessionId: firstRow.value.session_id,
        invocationId: firstRow.value.invocation_id,
        runId: firstRow.value.run_id,
        turnId: firstRow.value.turn_id,
      },
      decode(),
    );
    if (input.upToEventSeq !== undefined && lastEventSeq !== input.upToEventSeq) {
      throw new Error(
        `immutable RuntimeEvent prefix high-water ${input.upToEventSeq} is unavailable`,
      );
    }
    return proof;
  }

  async claimContinuation(input: { claim: ContinuationClaimV1 }): Promise<ContinuationClaimResult> {
    const claim = decodeContinuationClaim(input.claim);
    if (
      claim.target.sessionId === WORKSPACE_AUTHORITY_SESSION_ID ||
      claim.boundary.segments.some(
        (segment) => segment.identity.sessionId === WORKSPACE_AUTHORITY_SESSION_ID,
      )
    ) {
      throw new Error('Continuation cannot target the reserved workspace authority stream');
    }
    const boundaryJson = stableJsonStringify(claim.boundary);
    return this.transaction(() => {
      this.assertContinuationAuthorityIntegrity();
      this.assertContinuationBoundaryMatchesLedger(claim);
      const byBoundary = this.readContinuationClaimRow('boundary_digest = ?', claim.boundaryDigest);
      if (byBoundary) {
        const existing = decodeContinuationClaimRow(byBoundary);
        if (byBoundary.boundary_json !== boundaryJson) {
          throw new Error('Continuation claim boundary digest has conflicting canonical JSON');
        }
        return { kind: 'existing', claim: existing };
      }

      const source = claim.boundary.segments.at(-1)!;
      const conflict = this.readContinuationClaimRow(
        `claim_id = ?
          OR target_invocation_id = ?
          OR target_run_id = ?
          OR (? = 0 AND target_session_id = ? AND target_turn_id = ?)
          OR (
            source_session_id = ?
            AND source_run_id = ?
            AND source_event_high_water = ?
          )`,
        claim.claimId,
        claim.target.invocationId,
        claim.target.runId,
        claim.targetOpening.source.kind === 'handoff' ? 1 : 0,
        claim.target.sessionId,
        claim.target.turnId,
        source.identity.sessionId,
        source.identity.runId,
        source.position.lastEventSeq,
      );
      if (conflict) {
        return { kind: 'conflict', claim: decodeContinuationClaimRow(conflict) };
      }
      if (this.continuationTargetHasRuntimeState(claim)) {
        throw new Error('Continuation claim target RuntimeEvent ledger is not empty');
      }

      try {
        this.db
          .prepare(`
            INSERT INTO runtime_continuation_claims (
              claim_id,
              source_session_id,
              source_invocation_id,
              source_run_id,
              source_turn_id,
              source_event_high_water,
              source_prefix_digest,
              boundary_digest,
              boundary_json,
              provider_projection_version,
              provider_replay_digest,
              target_session_id,
              target_invocation_id,
              target_run_id,
              target_turn_id,
              target_opening_json,
              claimed_at,
              protocol_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          `)
          .run(
            claim.claimId,
            source.identity.sessionId,
            source.identity.invocationId,
            source.identity.runId,
            source.identity.turnId,
            source.position.lastEventSeq,
            source.prefixDigest,
            claim.boundaryDigest,
            boundaryJson,
            claim.providerProjectionVersion,
            claim.providerReplayDigest,
            claim.target.sessionId,
            claim.target.invocationId,
            claim.target.runId,
            claim.target.turnId,
            stableJsonStringify(claim.targetOpening),
            claim.claimedAt,
          );
      } catch (error) {
        const raced =
          this.readContinuationClaimRow('boundary_digest = ?', claim.boundaryDigest) ??
          this.readContinuationClaimRow(
            `claim_id = ?
              OR target_invocation_id = ?
              OR target_run_id = ?
              OR (? = 0 AND target_session_id = ? AND target_turn_id = ?)
              OR (
                source_session_id = ?
                AND source_run_id = ?
                AND source_event_high_water = ?
              )`,
            claim.claimId,
            claim.target.invocationId,
            claim.target.runId,
            claim.targetOpening.source.kind === 'handoff' ? 1 : 0,
            claim.target.sessionId,
            claim.target.turnId,
            source.identity.sessionId,
            source.identity.runId,
            source.position.lastEventSeq,
          );
        if (!raced) throw error;
        const racedClaim = decodeContinuationClaimRow(raced);
        return racedClaim.boundaryDigest === claim.boundaryDigest
          ? { kind: 'existing', claim: racedClaim }
          : { kind: 'conflict', claim: racedClaim };
      }
      this.options.failpoint?.('after_continuation_claim_insert');
      return { kind: 'acquired', claim };
    });
  }

  async readContinuationClaimByBoundary(
    boundaryDigest: RuntimeBoundaryDigest,
  ): Promise<ContinuationClaimV1 | undefined> {
    return (await this.readContinuationClaimStateByBoundary(boundaryDigest))?.claim;
  }

  async readContinuationClaimStateByBoundary(
    boundaryDigest: RuntimeBoundaryDigest,
  ): Promise<ContinuationClaimStateV1 | undefined> {
    if (!/^sha256:[0-9a-f]{64}$/.test(boundaryDigest)) {
      throw new Error('Invalid continuation boundary digest');
    }
    const row = this.readContinuationClaimRow('boundary_digest = ?', boundaryDigest);
    return row ? this.decodeContinuationClaimStateRow(row) : undefined;
  }

  async listUnsettledContinuationClaimsForRecovery(
    sessionIds: readonly string[],
  ): Promise<ContinuationClaimStateV1[]> {
    const selectedSessionIds = [...new Set(sessionIds)];
    for (const sessionId of selectedSessionIds) {
      assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    }
    if (selectedSessionIds.length === 0) return [];
    const rows = this.db
      .prepare(`
        WITH selected(session_id) AS (SELECT value FROM json_each(?))
        SELECT
          claim.claim_id,
          claim.source_session_id,
          claim.source_invocation_id,
          claim.source_run_id,
          claim.source_turn_id,
          claim.source_event_high_water,
          claim.source_prefix_digest,
          claim.boundary_digest,
          claim.boundary_json,
          claim.provider_projection_version,
          claim.provider_replay_digest,
          claim.target_session_id,
          claim.target_invocation_id,
          claim.target_run_id,
          claim.target_turn_id,
          claim.target_opening_json,
          claim.claimed_at,
          claim.start_event_id,
          claim.start_kind,
          claim.protocol_version
        FROM selected
        JOIN runtime_continuation_claims AS claim
          ON claim.target_session_id = selected.session_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM runtime_events AS terminal INDEXED BY runtime_events_terminal
          WHERE terminal.invocation_id = claim.target_invocation_id
            AND ${TERMINAL_RUNTIME_EVENT_SQL.replaceAll('payload_json', 'terminal.payload_json')}
        )
        ORDER BY claim.claimed_at ASC, claim.claim_id ASC
      `)
      .all(JSON.stringify(selectedSessionIds)) as unknown as ContinuationClaimStorageRow[];
    return rows.map((row) => this.decodeContinuationClaimStateRow(row));
  }

  async listContinuationClaimsForRecovery(sessionId: string): Promise<ContinuationClaimStateV1[]> {
    const rows = this.db
      .prepare(`
        SELECT
          claim_id,
          source_session_id,
          source_invocation_id,
          source_run_id,
          source_turn_id,
          source_event_high_water,
          source_prefix_digest,
          boundary_digest,
          boundary_json,
          provider_projection_version,
          provider_replay_digest,
          target_session_id,
          target_invocation_id,
          target_run_id,
          target_turn_id,
          target_opening_json,
          claimed_at,
          start_event_id,
          start_kind,
          protocol_version
        FROM runtime_continuation_claims
        WHERE target_session_id = ?
        ORDER BY claimed_at ASC, claim_id ASC
      `)
      .all(sessionId) as unknown as ContinuationClaimStorageRow[];
    return rows.map((row) => this.decodeContinuationClaimStateRow(row));
  }

  async commitContinuationStart(input: {
    claim: ContinuationClaimV1;
    event: RuntimeEvent;
  }): Promise<ToolCommitResult> {
    return this.commitContinuationStartOfKind(input, 'runtime_admission');
  }

  async commitContinuationRepairStart(input: {
    claim: ContinuationClaimV1;
    event: RuntimeEvent;
  }): Promise<ToolCommitResult> {
    return this.commitContinuationStartOfKind(input, 'claim_repair');
  }

  private commitContinuationStartOfKind(
    input: {
      claim: ContinuationClaimV1;
      event: RuntimeEvent;
    },
    startKind: 'runtime_admission' | 'claim_repair',
  ): ToolCommitResult {
    const claim = decodeContinuationClaim(input.claim);
    const event = canonicalizeRuntimeEventForStorage(input.event);
    assertNoReservedWorkspaceAuthorityAppend(event);
    assertContinuationStartEvent(claim, event, startKind);
    return this.transaction(() => {
      const row = this.readContinuationClaimRow('boundary_digest = ?', claim.boundaryDigest);
      if (!row) {
        throw new Error('Continuation start requires an acquired durable claim');
      }
      const storedClaim = decodeContinuationClaimRow(row);
      if (!isDeepStrictEqual(storedClaim, claim)) {
        throw new Error('Continuation start claim identity conflict');
      }
      if (row.start_event_id) {
        if (row.start_event_id !== event.id || row.start_kind !== startKind) {
          throw new Error('Continuation claim already has a different start event');
        }
        assertStoredRuntimeEventEquals(event, this.readRuntimeEventJson(event.id));
        return { created: false, runtimeEventSeq: this.runtimeEventSeq(event.id) };
      }
      this.assertInvocationIdentity([event]);
      const runtimeEventSeq = this.insertRuntimeEvent(event, event.ts, false, claim.claimId);
      if (runtimeEventSeq !== 1) {
        throw new Error('Continuation start must be the first target RuntimeEvent');
      }
      this.options.failpoint?.('after_continuation_start_insert');
      this.db
        .prepare(`
          UPDATE runtime_continuation_claims
          SET start_event_id = ?, start_kind = ?
          WHERE claim_id = ? AND start_event_id IS NULL
        `)
        .run(event.id, startKind, claim.claimId);
      return { created: true, runtimeEventSeq };
    });
  }

  async readImmutableSteeringMessageProof(
    sessionId: string,
    messageId: string,
  ): Promise<ImmutableSteeringMessageProof | undefined> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    assertRuntimeStorageSafeId(messageId, 'Invalid message id');
    const matches = this.readImmutableSteeringMessageEvents(sessionId, messageId);
    if (matches.length > 1) {
      throw new Error(`Immutable steering message identity conflict: ${messageId}`);
    }
    return matches[0] ? Object.freeze({ event: matches[0] }) : undefined;
  }

  async readRecoveryMessageEvents(
    input: RecoveryMessageEventQuery,
  ): Promise<BoundedEvidenceReadResult<RuntimeEvent>> {
    assertRuntimeStorageSafeId(input.sessionId, 'Invalid session id');
    assertEvidenceReadBudget(input.budget);
    const turnIds = distinctSafeRuntimeIds(input.turnIds, 'Invalid recovery Turn id');
    const eventIds = distinctSafeRuntimeIds(input.eventIds, 'Invalid recovery event id');
    const selectedEventIds = new Set<string>();
    const measuredRows: Array<{ event_id: string; stored_bytes?: unknown }> = [];

    const measureEventsById = (ids: readonly string[]): boolean => {
      for (const batch of batches(ids, RECOVERY_MESSAGE_QUERY_BATCH_SIZE)) {
        const placeholders = batch.map(() => '?').join(', ');
        const rows = this.db
          .prepare(`
            SELECT event_id, session_id,
                   length(CAST(payload_json AS BLOB)) AS stored_bytes
              FROM runtime_events
             WHERE event_id IN (${placeholders})
          `)
          .all(...batch) as Array<{
          event_id?: unknown;
          session_id?: unknown;
          stored_bytes?: unknown;
        }>;
        for (const row of rows) {
          if (typeof row.event_id !== 'string' || typeof row.session_id !== 'string') {
            throw new Error('Invalid recovery RuntimeEvent measurement row');
          }
          if (row.session_id !== input.sessionId || selectedEventIds.has(row.event_id)) continue;
          selectedEventIds.add(row.event_id);
          measuredRows.push({ event_id: row.event_id, stored_bytes: row.stored_bytes });
          if (measuredRows.length > input.budget.maxRecords) return false;
        }
      }
      return true;
    };

    if (!measureEventsById(eventIds)) return { status: 'limit_exceeded' };

    const additionalTurnEventIds = new Set<string>();
    for (const batch of batches(turnIds, RECOVERY_MESSAGE_QUERY_BATCH_SIZE)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .prepare(`
          SELECT event_id
            FROM runtime_events
           WHERE session_id = ?
             AND turn_id IN (${placeholders})
             AND event_kind = 'text'
             AND CASE
               WHEN json_valid(payload_json)
               THEN json_extract(payload_json, '$.partial')
             END = 0
             AND CASE
               WHEN json_valid(payload_json)
               THEN json_extract(payload_json, '$.role')
             END = 'user'
             AND coalesce(CASE
               WHEN json_valid(payload_json)
               THEN json_extract(payload_json, '$.content.steering')
             END, 0) = 0
           LIMIT ?
        `)
        .all(input.sessionId, ...batch, input.budget.maxRecords + 1) as Array<{
        event_id?: unknown;
      }>;
      for (const row of rows) {
        if (typeof row.event_id !== 'string') {
          throw new Error('Invalid recovery RuntimeEvent identity row');
        }
        if (!selectedEventIds.has(row.event_id)) additionalTurnEventIds.add(row.event_id);
        if (selectedEventIds.size + additionalTurnEventIds.size > input.budget.maxRecords) {
          return { status: 'limit_exceeded' };
        }
      }
    }

    if (!measureEventsById([...additionalTurnEventIds])) return { status: 'limit_exceeded' };
    const measurement = measureEvidenceRows(
      measuredRows,
      input.budget,
      'Invalid recovery RuntimeEvent evidence measurement row',
    );
    if (!measurement) return { status: 'limit_exceeded' };

    const storedBytesById = new Map(
      measuredRows.map((row) => [row.event_id, requireRuntimeEventScanCount(row.stored_bytes)]),
    );
    const events = new Map<string, RuntimeEvent>();
    for (const batch of batches([...selectedEventIds], RECOVERY_MESSAGE_QUERY_BATCH_SIZE)) {
      const placeholders = batch.map(() => '?').join(', ');
      const rows = this.db
        .prepare(`
          SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json,
                 length(CAST(payload_json AS BLOB)) AS stored_bytes
            FROM runtime_events
           WHERE event_id IN (${placeholders})
        `)
        .all(...batch) as unknown as Array<RuntimeEventStorageRow & { stored_bytes: number }>;
      for (const row of rows) {
        const event = decodeRuntimeEventStorageRow(row);
        if (event.sessionId !== input.sessionId) continue;
        if (storedBytesById.get(event.id) !== requireRuntimeEventScanCount(row.stored_bytes)) {
          throw new Error('Recovery RuntimeEvent evidence changed while reading');
        }
        events.set(event.id, event);
      }
    }
    if (events.size !== selectedEventIds.size) {
      throw new Error('Recovery RuntimeEvent evidence changed while reading');
    }

    return {
      status: 'complete',
      records: [...events.values()].sort(
        (left, right) =>
          left.ts - right.ts ||
          left.runId.localeCompare(right.runId) ||
          left.id.localeCompare(right.id),
      ),
      ...measurement,
    };
  }

  /**
   * Narrows recall to the Sessions whose ledger could project a message
   * containing one of the folded terms. The answer is a superset of the true
   * matches, never an answer: the caller projects each candidate Session and
   * re-runs the real predicate on the projected, redacted text.
   *
   * Every event payload is scanned, whatever its kind: a message's visible
   * text — a user or model `text`, a `function_call` intent, the string values
   * of a `function_response` result — is a JSON string value of the event that
   * carries it, so a term inside the projected text is inside the payload
   * (escaped forms excepted, which the caller routes around). Kinds that never
   * project only cost the scan a little work.
   *
   * A Session with an in-flight partial stream is offered unconditionally: its
   * arriving text lives in segments a per-row `instr` could straddle, and the
   * read model presents that text as settled.
   */
  async listSessionsWithRuntimeEventText(
    sessionIds: readonly string[],
    terms: readonly string[],
  ): Promise<string[]> {
    if (sessionIds.length === 0 || terms.length === 0) return [];
    for (const sessionId of sessionIds) assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    for (const term of terms) assertFoldedSearchTerm(term);
    const sessions = sessionIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `
        SELECT DISTINCT session_id
          FROM runtime_events
         WHERE session_id IN (${sessions})
           AND (${recallFoldedMatchClause('payload_json', terms.length)})
        UNION
        SELECT DISTINCT session_id
          FROM runtime_partial_snapshots
         WHERE session_id IN (${sessions})
        `,
      )
      .all(...sessionIds, ...terms, ...sessionIds) as Array<{ session_id?: unknown }>;
    return rows.map((row) => {
      if (typeof row.session_id !== 'string') throw new Error('Invalid recall candidate row');
      return row.session_id;
    });
  }

  /**
   * How many ledger events could project to a searchable message, for
   * recall's idf term. Counted by event kind rather than by projecting, so it
   * is cheap and identical whichever path recall takes to find its hits.
   */
  async countRuntimeEventMessages(sessionIds: readonly string[]): Promise<number> {
    if (sessionIds.length === 0) return 0;
    for (const sessionId of sessionIds) assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    const sessions = sessionIds.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `
        SELECT count(*) AS total
          FROM runtime_events
         WHERE session_id IN (${sessions})
           AND event_kind IN ('text', 'function_call', 'function_response')
        `,
      )
      .get(...sessionIds) as { total?: unknown } | undefined;
    return typeof row?.total === 'number' ? row.total : 0;
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const rows = this.db
      .prepare(`
      SELECT run_id FROM runtime_events WHERE session_id = ?
      UNION
      SELECT run_id FROM runtime_partial_snapshots WHERE session_id = ?
      ORDER BY run_id ASC
    `)
      .all(sessionId, sessionId) as Array<{ run_id: string }>;
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const row of rows) {
      const events = await this.readRuntimeEvents(sessionId, row.run_id);
      for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
        ordered.push({ event: events[eventIndex]!, runId: row.run_id, eventIndex });
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

  async readSessionRuntimeEventEntries(sessionId: string): Promise<SessionRuntimeEventEntry[]> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    const rows = this.db
      .prepare(`
        SELECT o.ordinal, e.event_id, e.session_id, e.invocation_id, e.run_id, e.turn_id,
               e.payload_json
        FROM runtime_session_event_ordinals o
        JOIN runtime_events e ON e.event_id = o.event_id
        WHERE o.session_id = ?
        ORDER BY o.ordinal ASC
      `)
      .all(sessionId) as unknown as Array<RuntimeEventStorageRow & { ordinal: unknown }>;
    return rows.map((row) => {
      if (
        typeof row.ordinal !== 'number' ||
        !Number.isSafeInteger(row.ordinal) ||
        row.ordinal < 1
      ) {
        throw new Error(`Invalid RuntimeEvent Session ordinal for ${sessionId}`);
      }
      const event = decodeRuntimeEventStorageRow(row);
      if (event.sessionId !== sessionId) {
        throw new Error(`RuntimeEvent Session ordinal identity mismatch for ${event.id}`);
      }
      return { ordinal: row.ordinal, event };
    });
  }

  async resequenceSessionEventOrdinals(sessionId: string): Promise<void> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    this.transaction(() => {
      // Lifted above the range first: the second statement renumbers into the
      // space these rows occupy, and (session_id, ordinal) is a primary key.
      // Shifting up rather than below zero keeps every intermediate value
      // inside the table's own `ordinal > 0`, and lands them past the 1..N the
      // renumber assigns, since the count cannot exceed the maximum.
      const { shift } = this.db
        .prepare(`
        SELECT COALESCE(MAX(ordinal), 0) AS shift
        FROM runtime_session_event_ordinals
        WHERE session_id = ?
      `)
        .get(sessionId) as { shift: number };
      this.db
        .prepare(`
        UPDATE runtime_session_event_ordinals
        SET ordinal = ordinal + :shift
        WHERE session_id = :sessionId
      `)
        .run({ sessionId, shift });
      this.db
        .prepare(`
        WITH opening AS (
          SELECT invocation_id, CAST(json_extract(payload_json, '$.ts') AS INTEGER) AS opened_at
          FROM runtime_events
          WHERE session_id = :sessionId AND event_kind = 'invocation_opened'
        ),
        ordered AS MATERIALIZED (
          SELECT
            o.event_id AS event_id,
            ROW_NUMBER() OVER (
              ORDER BY COALESCE(opening.opened_at, e.committed_at), e.invocation_id, o.ordinal
            ) AS ordinal
          FROM runtime_session_event_ordinals o
          JOIN runtime_events e ON e.event_id = o.event_id
          LEFT JOIN opening ON opening.invocation_id = e.invocation_id
          WHERE o.session_id = :sessionId
        )
        UPDATE runtime_session_event_ordinals
        SET ordinal = (
          SELECT ordered.ordinal
          FROM ordered
          WHERE ordered.event_id = runtime_session_event_ordinals.event_id
        )
        WHERE session_id = :sessionId
      `)
        .run({ sessionId });
      rebuildTranscriptTurnExtents(this.db, sessionId);
    });
  }

  async #commitWorkspaceBaseline(
    input: WorkspaceBaselineAuthorityInput,
    rootId: string,
  ): Promise<WorkspaceBaselineCommitResult> {
    const events = buildWorkspaceBaselineAuthorityEvents(input);
    return this.transaction(() => {
      this.#assertWorkspaceStorageRootBinding(rootId);
      const existingAuthority = this.readCanonicalWorkspaceAuthoritySync();
      const existingBaselines = existingAuthority.baselines;
      const existing = existingBaselines.find(
        (candidate) =>
          candidate.epoch.workspaceId === input.epoch.workspaceId &&
          candidate.epoch.workspaceEpochId === input.epoch.workspaceEpochId,
      );
      if (existing) {
        this.assertWorkspaceProjectionsMatchSync(existingAuthority);
        if (
          !isDeepStrictEqual(
            [
              this.readRequiredRuntimeEvent(existing.epochOpenedEventId),
              this.readRequiredRuntimeEvent(existing.baselineAcceptedEventId),
            ],
            [events.epochOpenedEvent, events.baselineAcceptedEvent],
          )
        ) {
          throw new Error('Workspace baseline authority conflict');
        }
        const head = existingAuthority.heads.find(
          (candidate) => candidate.workspaceEpochId === input.epoch.workspaceEpochId,
        );
        if (!head) throw new Error('Workspace baseline authority head is unavailable');
        return { created: false, head };
      }

      if (this.workspaceProjectionCountSync() !== 0 || existingBaselines.length !== 0) {
        this.assertWorkspaceProjectionsMatchSync(existingAuthority);
      }
      this.assertWorkspaceAuthorityStreamIsEmpty(events.epochOpenedEvent);
      this.assertInvocationIdentity([events.epochOpenedEvent, events.baselineAcceptedEvent]);
      const epochEventSeq = this.insertRuntimeEvent(
        events.epochOpenedEvent,
        input.committedAt,
        false,
      );
      if (epochEventSeq !== 1) {
        throw new Error('Workspace epoch-opened fact must be authority sequence one');
      }
      this.options.failpoint?.('after_workspace_epoch_event_insert');
      const baselineEventSeq = this.insertRuntimeEvent(
        events.baselineAcceptedEvent,
        input.committedAt,
        false,
      );
      if (baselineEventSeq !== 2) {
        throw new Error('Workspace baseline version fact must be authority sequence two');
      }
      this.options.failpoint?.('after_workspace_version_event_insert');

      const scanned = this.readCanonicalWorkspaceAuthoritySync();
      const accepted = scanned.baselines.find(
        (candidate) => candidate.epoch.workspaceEpochId === input.epoch.workspaceEpochId,
      );
      if (!accepted) throw new Error('Workspace baseline authority scan lost the committed epoch');
      this.insertWorkspaceEpochProjection(accepted, input.committedAt);
      this.options.failpoint?.('after_workspace_epoch_projection_insert');
      this.insertWorkspaceBaselineVersionProjection(accepted, input.committedAt);
      this.options.failpoint?.('after_workspace_version_projection_insert');
      const acceptedHead = scanned.heads.find(
        (candidate) => candidate.workspaceEpochId === input.epoch.workspaceEpochId,
      );
      if (!acceptedHead) throw new Error('Workspace baseline authority scan lost its head');
      this.insertWorkspaceHeadProjection(acceptedHead);
      this.options.failpoint?.('after_workspace_head_projection_insert');
      this.assertWorkspaceProjectionsMatchSync(scanned);
      const head = scanned.heads.find(
        (candidate) => candidate.workspaceEpochId === input.epoch.workspaceEpochId,
      );
      if (!head) throw new Error('Workspace baseline authority scan lost the committed head');
      return { created: true, head };
    });
  }

  async #commitWorkspaceSuccessor(
    input: {
      successor: WorkspaceSuccessorAuthorityInput;
      toolOutcome: WorkspaceSuccessorCommitInput['toolOutcome'];
    },
    rootId: string,
  ): Promise<WorkspaceSuccessorCommitResult> {
    const toolOutcome: CommitToolOutcomeInput = {
      ...input.toolOutcome,
      runtimeEvent: canonicalizeRuntimeEventForStorage(input.toolOutcome.runtimeEvent),
    };
    assertNoReservedWorkspaceAuthorityAppend(toolOutcome.runtimeEvent);
    assertOutcomeInput(toolOutcome);
    const successorEvent = buildWorkspaceSuccessorAuthorityEvent(input.successor);
    if (
      input.successor.origin.operationId !== toolOutcome.operationId ||
      input.successor.origin.outcomeEventId !== toolOutcome.runtimeEvent.id
    ) {
      throw new Error('Workspace successor does not match its tool outcome identity');
    }
    if (
      toolOutcome.runtimeEvent.content?.kind !== 'function_response' ||
      toolOutcome.runtimeEvent.content.isError === true
    ) {
      throw new Error('Workspace successor requires a successful tool outcome');
    }

    return this.transaction(() => {
      this.#assertWorkspaceStorageRootBinding(rootId);
      const before = this.readCanonicalWorkspaceAuthoritySync();
      this.assertWorkspaceProjectionsMatchSync(before);
      const currentHead = before.heads.find(
        (candidate) =>
          candidate.workspaceId === input.successor.successor.workspaceId &&
          candidate.workspaceEpochId === input.successor.successor.workspaceEpochId,
      );
      if (!currentHead) throw new Error('Workspace successor base head is unavailable');

      const existing = before.successors.find(
        (candidate) =>
          candidate.acceptedEventId === input.successor.acceptedEventId ||
          candidate.successor.workspaceVersionId === input.successor.successor.workspaceVersionId,
      );
      if (existing) {
        assertStoredRuntimeEventEquals(
          successorEvent,
          this.readRuntimeEventJson(successorEvent.id),
        );
        const operation = this.readToolOperationSync(toolOutcome.operationId);
        if (!operation?.resultEventId) {
          throw new Error('Workspace successor exists without its tool outcome');
        }
        assertStoredRuntimeEventEquals(
          toolOutcome.runtimeEvent,
          this.readRuntimeEventJson(operation.resultEventId),
        );
        return {
          created: false,
          committedSuccessor: {
            repositoryId: existing.successor.repositoryId,
            workspaceId: existing.successor.workspaceId,
            workspaceEpochId: existing.successor.workspaceEpochId,
            workspaceVersionId: existing.successor.workspaceVersionId,
            acceptedEventId: existing.acceptedEventId,
            commitOid: existing.successor.commitOid,
            treeOid: existing.successor.treeOid,
            revision: existing.successor.baseHeadRevision + 1,
          },
          outcomeRuntimeEventSeq: this.runtimeEventSeq(operation.resultEventId),
        };
      }

      const successor = input.successor.successor;
      if (
        successor.repositoryId !== currentHead.repositoryId ||
        successor.parentWorkspaceVersionId !== currentHead.workspaceVersionId ||
        successor.baseAcceptedEventId !== currentHead.acceptedEventId ||
        successor.baseHeadRevision !== currentHead.revision
      ) {
        throw new Error('Workspace successor compare-and-set base head conflict');
      }
      const operation = this.readToolOperationSync(toolOutcome.operationId);
      if (
        !operation ||
        operation.currentState !== 'prepared' ||
        operation.resultEventId !== undefined ||
        operation.dispatchEventId !== input.successor.origin.dispatchEventId ||
        operation.recoveryMode !== 'reconcile' ||
        (operation.toolName !== 'Write' && operation.toolName !== 'Edit')
      ) {
        throw new Error('Workspace successor requires one prepared Write/Edit reconcile operation');
      }
      if (!operation.dispatchEventId) {
        throw new Error('Workspace successor operation is missing its dispatch event');
      }
      const dispatchJson = this.readRuntimeEventJson(operation.dispatchEventId);
      const dispatchEvent = dispatchJson
        ? decodeRuntimeEvent(JSON.parse(dispatchJson) as unknown)
        : undefined;
      const mutation = dispatchEvent?.actions?.toolDispatch?.managedMutation;
      const reservation = this.db
        .prepare(`
          SELECT
            workspace_instance_id, repository_id, workspace_id, workspace_epoch_id,
            operation_id, dispatch_event_id, base_workspace_version_id,
            base_accepted_event_id, base_head_revision, base_commit_oid, base_tree_oid,
            expected_paths_json, execution_profile_digest, protocol_version, reserved_at
          FROM runtime_managed_mutation_reservations
          WHERE operation_id = ?
        `)
        .get(operation.operationId) as ManagedMutationReservationProjectionRow | undefined;
      if (
        !mutation ||
        !reservation ||
        reservation.workspace_instance_id !== mutation.workspaceInstanceId ||
        reservation.repository_id !== mutation.repositoryId ||
        reservation.workspace_id !== mutation.workspaceId ||
        reservation.workspace_epoch_id !== mutation.workspaceEpochId ||
        reservation.operation_id !== operation.operationId ||
        reservation.dispatch_event_id !== operation.dispatchEventId ||
        reservation.base_workspace_version_id !== mutation.baseWorkspaceVersionId ||
        reservation.base_accepted_event_id !== mutation.baseAcceptedEventId ||
        reservation.base_head_revision !== mutation.baseHeadRevision ||
        reservation.base_commit_oid !== mutation.baseCommitOid ||
        reservation.base_tree_oid !== mutation.baseTreeOid ||
        reservation.execution_profile_digest !== mutation.executionProfileDigest ||
        mutation.repositoryId !== successor.repositoryId ||
        mutation.workspaceId !== successor.workspaceId ||
        mutation.workspaceEpochId !== successor.workspaceEpochId ||
        mutation.objectFormat !== successor.objectFormat ||
        mutation.baseWorkspaceVersionId !== successor.parentWorkspaceVersionId ||
        mutation.baseAcceptedEventId !== successor.baseAcceptedEventId ||
        mutation.baseHeadRevision !== successor.baseHeadRevision ||
        mutation.baseCommitOid !== currentHead.commitOid ||
        mutation.baseTreeOid !== currentHead.treeOid ||
        mutation.executionProfileDigest !== successor.executionProfileDigest
      ) {
        throw new Error('Workspace successor requires its exact durable mutation reservation');
      }
      const reservedPaths = JSON.parse(reservation.expected_paths_json) as unknown;
      if (
        !isDeepStrictEqual(reservedPaths, [mutation.expectedPath]) ||
        !isDeepStrictEqual(successor.changedPaths, [mutation.expectedPath])
      ) {
        throw new Error('Managed mutation path authorization conflict');
      }

      const outcomeResult = this.commitToolOutcomeSync(toolOutcome, 'workspace_successor');
      const successorSeq = this.insertRuntimeEvent(
        successorEvent,
        input.successor.committedAt,
        false,
      );
      if (successorSeq !== currentHead.revision + 2) {
        throw new Error('Workspace successor fact is not the next authority event');
      }
      this.options.failpoint?.('after_workspace_successor_event_insert');

      const after = this.readCanonicalWorkspaceAuthoritySync();
      const accepted = after.successors.find(
        (candidate) => candidate.acceptedEventId === input.successor.acceptedEventId,
      );
      const nextHead = after.heads.find(
        (candidate) =>
          candidate.workspaceId === successor.workspaceId &&
          candidate.workspaceEpochId === successor.workspaceEpochId,
      );
      if (!accepted || !nextHead) {
        throw new Error('Workspace successor authority scan lost the committed version');
      }
      this.insertWorkspaceSuccessorVersionProjection(accepted, input.successor.committedAt);
      this.options.failpoint?.('after_workspace_successor_projection_insert');
      const updated = this.db
        .prepare(`
          UPDATE runtime_workspace_heads
          SET workspace_version_id = ?, accepted_event_id = ?, commit_oid = ?, tree_oid = ?,
              revision = ?
          WHERE workspace_id = ? AND workspace_epoch_id = ?
            AND workspace_version_id = ? AND accepted_event_id = ? AND revision = ?
        `)
        .run(
          nextHead.workspaceVersionId,
          nextHead.acceptedEventId,
          nextHead.commitOid,
          nextHead.treeOid,
          nextHead.revision,
          currentHead.workspaceId,
          currentHead.workspaceEpochId,
          currentHead.workspaceVersionId,
          currentHead.acceptedEventId,
          currentHead.revision,
        );
      if (updated.changes !== 1) {
        throw new Error('Workspace successor head compare-and-set failed');
      }
      this.options.failpoint?.('after_workspace_successor_head_update');
      const released = this.db
        .prepare(`
          DELETE FROM runtime_managed_mutation_reservations
          WHERE workspace_instance_id = ? AND operation_id = ? AND dispatch_event_id = ?
        `)
        .run(mutation.workspaceInstanceId, operation.operationId, operation.dispatchEventId);
      if (released.changes !== 1) {
        throw new Error('Managed mutation reservation release compare-and-set failed');
      }
      this.assertWorkspaceProjectionsMatchSync(after);
      return {
        created: true,
        committedSuccessor: nextHead,
        outcomeRuntimeEventSeq: outcomeResult.runtimeEventSeq,
      };
    });
  }

  async #commitManagedMutationTerminal(
    input: {
      noEffect: ManagedMutationNoEffectClaimV1;
      toolOutcome: ManagedMutationTerminalCommitInput['toolOutcome'];
    },
    rootId: string,
  ): Promise<ManagedMutationTerminalCommitResult> {
    const toolOutcome: CommitToolOutcomeInput = {
      ...input.toolOutcome,
      runtimeEvent: canonicalizeRuntimeEventForStorage(input.toolOutcome.runtimeEvent),
    };
    assertOutcomeInput(toolOutcome);
    const terminal = toolOutcome.runtimeEvent.actions?.managedMutationTerminal;
    if (!terminal) throw new Error('Managed mutation terminal fact is missing');
    if (
      input.noEffect.operationId !== terminal.operationId ||
      input.noEffect.dispatchEventId !== terminal.dispatchEventId ||
      input.noEffect.workspaceInstanceId !== terminal.workspaceInstanceId ||
      input.noEffect.terminalKind !== terminal.terminalKind
    ) {
      throw new Error('Managed mutation terminal does not match its owner-issued no-effect proof');
    }

    return this.transaction(() => {
      this.#assertWorkspaceStorageRootBinding(rootId);
      const operation = this.readToolOperationSync(toolOutcome.operationId);
      if (
        !operation ||
        !operation.dispatchEventId ||
        operation.dispatchEventId !== terminal.dispatchEventId ||
        terminal.operationId !== operation.operationId ||
        operation.recoveryMode !== 'reconcile' ||
        (operation.toolName !== 'Write' && operation.toolName !== 'Edit')
      ) {
        throw new Error('Managed mutation terminal requires its exact prepared operation');
      }
      const dispatchJson = this.readRuntimeEventJson(operation.dispatchEventId);
      const dispatchEvent = dispatchJson
        ? decodeRuntimeEvent(JSON.parse(dispatchJson) as unknown)
        : undefined;
      const mutation = dispatchEvent?.actions?.toolDispatch?.managedMutation;
      if (!mutation || mutation.workspaceInstanceId !== terminal.workspaceInstanceId) {
        throw new Error('Managed mutation terminal requires its exact durable reservation');
      }
      const response = toolOutcome.runtimeEvent.content;
      if (
        response?.kind !== 'function_response' ||
        (terminal.terminalKind === 'no_workspace_change'
          ? response.isError === true
          : response.isError !== true)
      ) {
        throw new Error('Managed mutation terminal outcome has the wrong success state');
      }

      const result = this.commitToolOutcomeSync(toolOutcome, 'workspace_terminal');
      const released = this.db
        .prepare(`
          DELETE FROM runtime_managed_mutation_reservations
          WHERE workspace_instance_id = ? AND operation_id = ? AND dispatch_event_id = ?
        `)
        .run(terminal.workspaceInstanceId, operation.operationId, operation.dispatchEventId);
      if (result.created && released.changes !== 1) {
        throw new Error('Managed mutation terminal reservation release compare-and-set failed');
      }
      if (!result.created && released.changes !== 0) {
        throw new Error('Managed mutation terminal exact retry found an active reservation');
      }
      const authority = this.readCanonicalWorkspaceAuthoritySync();
      this.assertWorkspaceProjectionsMatchSync(authority);
      return { created: result.created, outcomeRuntimeEventSeq: result.runtimeEventSeq };
    });
  }

  private registerWorkspaceBaselineAuthorityWriter(): void {
    registerWorkspaceBaselineAuthorityWriterInternal(
      this,
      (input, rootId) => this.#commitWorkspaceBaseline(input, rootId),
      (input, rootId) => this.#commitWorkspaceSuccessor(input, rootId),
      (input, rootId) => this.#commitManagedMutationTerminal(input, rootId),
      (rootId) => this.#bindWorkspaceStorageRoot(rootId),
      (workspaceInstanceId) => this.#readActiveManagedMutation(workspaceInstanceId),
    );
  }

  async #readActiveManagedMutation(
    workspaceInstanceId: string,
  ): Promise<
    | import('./workspace-version-authority-internal.js').ManagedMutationReservationRecordV1
    | undefined
  > {
    return this.readTransaction(() => {
      const authority = this.readCanonicalWorkspaceAuthoritySync();
      this.assertWorkspaceProjectionsMatchSync(authority);
      const reservation = authority.activeManagedMutations.find(
        (candidate) => candidate.workspace_instance_id === workspaceInstanceId,
      );
      if (!reservation) return undefined;
      const expectedPaths = JSON.parse(reservation.expected_paths_json) as unknown;
      if (
        !Array.isArray(expectedPaths) ||
        expectedPaths.length !== 1 ||
        typeof expectedPaths[0] !== 'string'
      ) {
        throw new Error('Managed mutation reservation has invalid expected paths');
      }
      return {
        workspaceInstanceId: reservation.workspace_instance_id,
        repositoryId: reservation.repository_id,
        workspaceId: reservation.workspace_id,
        workspaceEpochId: reservation.workspace_epoch_id,
        operationId: reservation.operation_id,
        dispatchEventId: reservation.dispatch_event_id,
        baseWorkspaceVersionId: reservation.base_workspace_version_id,
        baseAcceptedEventId: reservation.base_accepted_event_id,
        baseHeadRevision: reservation.base_head_revision,
        baseCommitOid: reservation.base_commit_oid,
        baseTreeOid: reservation.base_tree_oid,
        expectedPath: expectedPaths[0],
        executionProfileDigest: reservation.execution_profile_digest,
        reservedAt: reservation.reserved_at,
      };
    });
  }

  #bindWorkspaceStorageRoot(rootId: string): void {
    this.transaction(() => {
      const existing = this.#readWorkspaceStorageRootBinding();
      if (existing) {
        if (existing.root_id !== rootId || existing.protocol_version !== 1) {
          throw new Error(
            'Workspace authority database belongs to a different durable storage root',
          );
        }
        return;
      }
      if (this.#databaseHasLogicalStateBeforeRootBinding()) {
        throw new Error('Unbound operational data require explicit storage-root adoption');
      }
      this.db
        .prepare(`
          INSERT INTO runtime_storage_root_binding(singleton, root_id, protocol_version)
          VALUES (1, ?, 1)
        `)
        .run(rootId);
    });
  }

  #assertWorkspaceStorageRootBinding(rootId: string): void {
    const existing = this.#readWorkspaceStorageRootBinding();
    if (!existing || existing.root_id !== rootId || existing.protocol_version !== 1) {
      throw new Error('Workspace authority database durable storage-root binding changed');
    }
  }

  #readWorkspaceStorageRootBinding(): { root_id: string; protocol_version: number } | undefined {
    return this.db
      .prepare(`
        SELECT root_id, protocol_version
        FROM runtime_storage_root_binding
        WHERE singleton = 1
      `)
      .get() as { root_id: string; protocol_version: number } | undefined;
  }

  #databaseHasLogicalStateBeforeRootBinding(): boolean {
    const metadataTables = new Set([
      'operational_schema_migrations',
      'runtime_capabilities',
      'runtime_storage_root_binding',
    ]);
    const tables = this.db
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `)
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      if (metadataTables.has(name)) continue;
      const quotedName = `"${name.replaceAll('"', '""')}"`;
      if (this.db.prepare(`SELECT 1 FROM ${quotedName} LIMIT 1`).get()) return true;
    }
    return false;
  }

  async readWorkspaceEpoch(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceEpochRecordV1 | undefined> {
    return this.readTransaction(() => {
      const authority = this.readCanonicalWorkspaceAuthoritySync();
      this.assertWorkspaceProjectionsMatchSync(authority);
      const baseline = authority.baselines.find(
        (candidate) =>
          candidate.epoch.workspaceId === workspaceId &&
          candidate.epoch.workspaceEpochId === workspaceEpochId,
      );
      return baseline ? workspaceEpochRecord(baseline) : undefined;
    });
  }

  async readWorkspaceVersion(
    workspaceVersionId: string,
  ): Promise<WorkspaceVersionRecordV1 | undefined> {
    return this.readTransaction(() => {
      const authority = this.readCanonicalWorkspaceAuthoritySync();
      this.assertWorkspaceProjectionsMatchSync(authority);
      const baseline = authority.baselines.find(
        (candidate) => candidate.baseline.workspaceVersionId === workspaceVersionId,
      );
      if (baseline) return workspaceBaselineVersionRecord(baseline);
      const successor = authority.successors.find(
        (candidate) => candidate.successor.workspaceVersionId === workspaceVersionId,
      );
      return successor ? workspaceSuccessorVersionRecord(successor) : undefined;
    });
  }

  async readWorkspaceHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined> {
    return this.readTransaction(() => {
      const authority = this.readCanonicalWorkspaceAuthoritySync();
      this.assertWorkspaceProjectionsMatchSync(authority);
      return authority.heads.find(
        (candidate) =>
          candidate.workspaceId === workspaceId && candidate.workspaceEpochId === workspaceEpochId,
      );
    });
  }

  async rebuildWorkspaceVersionProjections(): Promise<WorkspaceProjectionRebuildResult> {
    return this.transaction(() => {
      const authority = this.readCanonicalWorkspaceAuthoritySync();
      this.db.prepare('DELETE FROM runtime_managed_mutation_reservations').run();
      this.db.prepare('DELETE FROM runtime_workspace_heads').run();
      this.db.prepare('DELETE FROM runtime_workspace_versions').run();
      this.db.prepare('DELETE FROM runtime_workspace_epochs').run();
      for (const baseline of authority.baselines) {
        const committedAt = Math.max(
          this.runtimeEventCommittedAt(baseline.epochOpenedEventId),
          this.runtimeEventCommittedAt(baseline.baselineAcceptedEventId),
        );
        this.insertWorkspaceEpochProjection(baseline, committedAt);
        this.insertWorkspaceBaselineVersionProjection(baseline, committedAt);
      }
      for (const successor of authority.successors) {
        this.insertWorkspaceSuccessorVersionProjection(
          successor,
          this.runtimeEventCommittedAt(successor.acceptedEventId),
        );
      }
      for (const head of authority.heads) this.insertWorkspaceHeadProjection(head);
      for (const reservation of authority.activeManagedMutations) {
        this.insertManagedMutationReservationProjectionSync(reservation);
      }
      this.assertWorkspaceProjectionsMatchSync(authority);
      return {
        epochs: authority.baselines.length,
        versions: authority.baselines.length + authority.successors.length,
        heads: authority.heads.length,
      };
    });
  }

  private readCanonicalWorkspaceAuthoritySync(): CanonicalWorkspaceAuthority {
    const partial = this.db
      .prepare(`
        SELECT stream_key FROM runtime_partial_snapshots
        WHERE session_id = ?
        LIMIT 1
      `)
      .get(WORKSPACE_AUTHORITY_SESSION_ID) as { stream_key: string } | undefined;
    if (partial) {
      throw new Error(
        `Corrupt workspace RuntimeEvent authority: authority_stream_contamination at ${partial.stream_key}`,
      );
    }
    const rows = this.db
      .prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, event_seq, payload_json
        FROM runtime_events
        ORDER BY invocation_id ASC, event_seq ASC, event_id ASC
      `)
      .all() as unknown as RuntimeEventPrefixStorageRow[];
    const events = rows.map(decodeRuntimeEventStorageRow);
    const authorityRows: WorkspaceAuthorityLedgerRow[] = rows.map((row, index) => ({
      event: events[index]!,
      eventSeq: row.event_seq,
    }));
    const scan = scanWorkspaceBaselineAuthority(authorityRows);
    if (scan.hasCorruption) {
      const issue = scan.issues[0]!;
      throw new Error(
        `Corrupt workspace RuntimeEvent authority: ${issue.code} at ${issue.eventId}`,
      );
    }
    const toolScan = scanToolLedger(events);
    for (const accepted of scan.successors) {
      const origin = accepted.successor.origin;
      const operation = toolScan.operations.find(
        (candidate) => candidate.operationId === origin.operationId,
      );
      const dispatch = operation?.dispatchEvent?.actions?.toolDispatch;
      const response = operation?.responseEvent;
      const epoch = scan.baselines.find(
        (candidate) =>
          candidate.epoch.workspaceId === accepted.successor.workspaceId &&
          candidate.epoch.workspaceEpochId === accepted.successor.workspaceEpochId,
      )?.epoch;
      const baseHead = workspaceHeadBeforeSuccessor(scan, accepted.successor);
      if (
        !operation ||
        operation.issues.length > 0 ||
        operation.dispatchEvent?.id !== origin.dispatchEventId ||
        !dispatch ||
        dispatch.operationId !== origin.operationId ||
        dispatch.recoveryMode !== 'reconcile' ||
        (dispatch.toolName !== 'Write' && dispatch.toolName !== 'Edit') ||
        !epoch ||
        !baseHead ||
        !managedMutationMatchesAcceptedSuccessor(
          dispatch.managedMutation,
          accepted.successor,
          baseHead,
          epoch.workspaceInstanceId,
        ) ||
        !response ||
        response.id !== origin.outcomeEventId ||
        response.content?.kind !== 'function_response' ||
        response.content.isError === true
      ) {
        throw new Error(
          `Corrupt workspace successor tool evidence: identity_conflict at ${accepted.acceptedEventId}`,
        );
      }
    }
    const activeManagedMutations = this.scanCanonicalManagedMutationReservationsSync(
      toolScan,
      scan,
    );
    this.options.failpoint?.('after_workspace_canonical_scan');
    return { ...scan, activeManagedMutations };
  }

  private scanCanonicalManagedMutationReservationsSync(
    toolScan: ReturnType<typeof scanToolLedger>,
    authority: ReturnType<typeof scanWorkspaceBaselineAuthority>,
  ): ManagedMutationReservationProjectionRow[] {
    const acceptedOperations = new Set(
      authority.successors.map((candidate) => candidate.successor.origin.operationId),
    );
    const reservations: ManagedMutationReservationProjectionRow[] = [];
    const occupied = new Set<string>();
    for (const operation of toolScan.operations) {
      const dispatchEvent = operation.dispatchEvent;
      const dispatch = dispatchEvent?.actions?.toolDispatch;
      const mutation = dispatch?.managedMutation;
      if (!mutation) continue;
      if (
        operation.issues.length > 0 ||
        !dispatchEvent ||
        dispatch.operationId !== operation.operationId ||
        dispatch.recoveryMode !== 'reconcile' ||
        (dispatch.toolName !== 'Write' && dispatch.toolName !== 'Edit')
      ) {
        throw new Error(
          `Corrupt managed mutation reservation: identity_conflict at ${dispatchEvent?.id ?? operation.operationId}`,
        );
      }
      if (acceptedOperations.has(operation.operationId)) continue;
      if (operation.responseEvent) {
        const terminal = operation.responseEvent.actions?.managedMutationTerminal;
        if (
          !terminal ||
          terminal.operationId !== operation.operationId ||
          terminal.dispatchEventId !== dispatchEvent.id ||
          terminal.workspaceInstanceId !== mutation.workspaceInstanceId ||
          operation.responseEvent.content?.kind !== 'function_response' ||
          (terminal.terminalKind === 'no_workspace_change'
            ? operation.responseEvent.content.isError === true
            : operation.responseEvent.content.isError !== true)
        ) {
          throw new Error(
            `Corrupt managed mutation reservation: generic_outcome at ${operation.responseEvent.id}`,
          );
        }
        continue;
      }
      const epoch = authority.baselines.find(
        (candidate) =>
          candidate.epoch.workspaceId === mutation.workspaceId &&
          candidate.epoch.workspaceEpochId === mutation.workspaceEpochId,
      )?.epoch;
      const head = authority.heads.find(
        (candidate) =>
          candidate.workspaceId === mutation.workspaceId &&
          candidate.workspaceEpochId === mutation.workspaceEpochId,
      );
      if (
        !epoch ||
        !head ||
        epoch.repositoryId !== mutation.repositoryId ||
        epoch.workspaceInstanceId !== mutation.workspaceInstanceId ||
        epoch.objectFormat !== mutation.objectFormat ||
        head.workspaceVersionId !== mutation.baseWorkspaceVersionId ||
        head.acceptedEventId !== mutation.baseAcceptedEventId ||
        head.revision !== mutation.baseHeadRevision ||
        head.commitOid !== mutation.baseCommitOid ||
        head.treeOid !== mutation.baseTreeOid ||
        occupied.has(mutation.workspaceInstanceId)
      ) {
        throw new Error(
          `Corrupt managed mutation reservation: workspace_conflict at ${dispatchEvent.id}`,
        );
      }
      occupied.add(mutation.workspaceInstanceId);
      reservations.push({
        workspace_instance_id: mutation.workspaceInstanceId,
        repository_id: mutation.repositoryId,
        workspace_id: mutation.workspaceId,
        workspace_epoch_id: mutation.workspaceEpochId,
        operation_id: operation.operationId,
        dispatch_event_id: dispatchEvent.id,
        base_workspace_version_id: mutation.baseWorkspaceVersionId,
        base_accepted_event_id: mutation.baseAcceptedEventId,
        base_head_revision: mutation.baseHeadRevision,
        base_commit_oid: mutation.baseCommitOid,
        base_tree_oid: mutation.baseTreeOid,
        expected_paths_json: JSON.stringify([mutation.expectedPath]),
        execution_profile_digest: mutation.executionProfileDigest,
        protocol_version: 1,
        reserved_at: this.runtimeEventCommittedAt(dispatchEvent.id),
      });
    }
    return reservations.sort((left, right) =>
      left.workspace_instance_id.localeCompare(right.workspace_instance_id),
    );
  }

  private assertWorkspaceAuthorityStreamIsEmpty(event: RuntimeEvent): void {
    const row = this.db
      .prepare(`
        SELECT event_id FROM runtime_events
        WHERE invocation_id = ?
          OR (session_id = ? AND run_id = ?)
          OR (session_id = ? AND turn_id = ?)
        LIMIT 1
      `)
      .get(event.invocationId, event.sessionId, event.runId, event.sessionId, event.turnId) as
      | { event_id: string }
      | undefined;
    if (row) throw new Error('Workspace baseline authority conflict');
  }

  private insertWorkspaceEpochProjection(
    baseline: ReturnType<typeof scanWorkspaceBaselineAuthority>['baselines'][number],
    committedAt: number,
  ): void {
    const { epoch, authority } = baseline;
    this.db
      .prepare(`
        INSERT INTO runtime_workspace_epochs (
          workspace_id,
          workspace_epoch_id,
          repository_id,
          workspace_instance_id,
          mode,
          object_format,
          source_commit_oid,
          source_tree_oid,
          initial_workspace_version_id,
          materialization_profile_digest,
          materialization_semantics,
          policy_hash,
          authority_session_id,
          authority_invocation_id,
          authority_run_id,
          authority_turn_id,
          epoch_opened_event_id,
          protocol_version,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      .run(
        epoch.workspaceId,
        epoch.workspaceEpochId,
        epoch.repositoryId,
        epoch.workspaceInstanceId,
        epoch.mode,
        epoch.objectFormat,
        epoch.sourceCommitOid,
        epoch.sourceTreeOid,
        epoch.initialWorkspaceVersionId,
        epoch.materializationProfileDigest,
        epoch.materializationSemantics,
        epoch.policyHash,
        authority.sessionId,
        authority.invocationId,
        authority.runId,
        authority.turnId,
        baseline.epochOpenedEventId,
        committedAt,
      );
  }

  private insertWorkspaceBaselineVersionProjection(
    accepted: ReturnType<typeof scanWorkspaceBaselineAuthority>['baselines'][number],
    committedAt: number,
  ): void {
    const { baseline } = accepted;
    this.db
      .prepare(`
        INSERT INTO runtime_workspace_versions (
          workspace_version_id,
          repository_id,
          workspace_id,
          workspace_epoch_id,
          object_format,
          origin_kind,
          origin_event_id,
          parents_json,
          operation_id,
          dispatch_event_id,
          outcome_event_id,
          base_head_revision,
          execution_profile_digest,
          commit_oid,
          tree_oid,
          policy_hash,
          tree_delta_digest,
          changed_paths_json,
          changed_file_count,
          deleted_file_count,
          accepted_event_id,
          protocol_version,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, 'baseline', ?, '[]', NULL, NULL, NULL, NULL, NULL,
          ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      .run(
        baseline.workspaceVersionId,
        baseline.repositoryId,
        baseline.workspaceId,
        baseline.workspaceEpochId,
        baseline.objectFormat,
        baseline.origin.epochOpenedEventId,
        baseline.commitOid,
        baseline.treeOid,
        baseline.policyHash,
        baseline.treeDeltaDigest,
        '[]',
        baseline.changedFileCount,
        baseline.deletedFileCount,
        accepted.baselineAcceptedEventId,
        committedAt,
      );
  }

  private insertWorkspaceSuccessorVersionProjection(
    accepted: ScannedWorkspaceSuccessorAuthority,
    committedAt: number,
  ): void {
    const { successor } = accepted;
    this.db
      .prepare(`
        INSERT INTO runtime_workspace_versions (
          workspace_version_id,
          repository_id,
          workspace_id,
          workspace_epoch_id,
          object_format,
          origin_kind,
          origin_event_id,
          parents_json,
          operation_id,
          dispatch_event_id,
          outcome_event_id,
          base_head_revision,
          execution_profile_digest,
          commit_oid,
          tree_oid,
          policy_hash,
          tree_delta_digest,
          changed_paths_json,
          changed_file_count,
          deleted_file_count,
          accepted_event_id,
          protocol_version,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, 'tool_mutation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      .run(
        successor.workspaceVersionId,
        successor.repositoryId,
        successor.workspaceId,
        successor.workspaceEpochId,
        successor.objectFormat,
        successor.origin.outcomeEventId,
        JSON.stringify(successor.parents),
        successor.origin.operationId,
        successor.origin.dispatchEventId,
        successor.origin.outcomeEventId,
        successor.baseHeadRevision,
        successor.executionProfileDigest,
        successor.commitOid,
        successor.treeOid,
        successor.policyHash,
        successor.treeDeltaDigest,
        JSON.stringify(successor.changedPaths),
        successor.changedFileCount,
        successor.deletedFileCount,
        accepted.acceptedEventId,
        committedAt,
      );
  }

  private insertWorkspaceHeadProjection(head: WorkspaceHeadRecordV1): void {
    this.db
      .prepare(`
        INSERT INTO runtime_workspace_heads (
          workspace_id,
          workspace_epoch_id,
          repository_id,
          workspace_version_id,
          accepted_event_id,
          commit_oid,
          tree_oid,
          revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        head.workspaceId,
        head.workspaceEpochId,
        head.repositoryId,
        head.workspaceVersionId,
        head.acceptedEventId,
        head.commitOid,
        head.treeOid,
        head.revision,
      );
  }

  private assertWorkspaceProjectionsMatchSync(authority: CanonicalWorkspaceAuthority): void {
    const expectedEpochs = authority.baselines
      .map(workspaceEpochProjectionRow)
      .sort(compareWorkspaceEpochRow);
    const expectedVersions = [
      ...authority.baselines.map(workspaceBaselineVersionProjectionRow),
      ...authority.successors.map(workspaceSuccessorVersionProjectionRow),
    ].sort(compareWorkspaceVersionRow);
    const expectedHeads = authority.heads
      .map(workspaceHeadProjectionRow)
      .sort(compareWorkspaceHeadRow);
    const epochs = (
      this.db
        .prepare(`
        SELECT
          workspace_id,
          workspace_epoch_id,
          repository_id,
          workspace_instance_id,
          mode,
          object_format,
          source_commit_oid,
          source_tree_oid,
          initial_workspace_version_id,
          materialization_profile_digest,
          materialization_semantics,
          policy_hash,
          authority_session_id,
          authority_invocation_id,
          authority_run_id,
          authority_turn_id,
          epoch_opened_event_id,
          protocol_version,
          committed_at
        FROM runtime_workspace_epochs
        ORDER BY workspace_id ASC, workspace_epoch_id ASC
      `)
        .all() as unknown as WorkspaceEpochProjectionRow[]
    )
      .map((row) => ({ ...row }))
      .sort(compareWorkspaceEpochRow);
    const versions = (
      this.db
        .prepare(`
        SELECT
          workspace_version_id,
          repository_id,
          workspace_id,
          workspace_epoch_id,
          object_format,
          origin_kind,
          origin_event_id,
          parents_json,
          operation_id,
          dispatch_event_id,
          outcome_event_id,
          base_head_revision,
          execution_profile_digest,
          commit_oid,
          tree_oid,
          policy_hash,
          tree_delta_digest,
          changed_paths_json,
          changed_file_count,
          deleted_file_count,
          accepted_event_id,
          protocol_version,
          committed_at
        FROM runtime_workspace_versions
        ORDER BY workspace_version_id ASC
      `)
        .all() as unknown as WorkspaceVersionProjectionRow[]
    )
      .map((row) => ({ ...row }))
      .sort(compareWorkspaceVersionRow);
    const heads = (
      this.db
        .prepare(`
        SELECT
          workspace_id,
          workspace_epoch_id,
          repository_id,
          workspace_version_id,
          accepted_event_id,
          commit_oid,
          tree_oid,
          revision
        FROM runtime_workspace_heads
        ORDER BY workspace_id ASC, workspace_epoch_id ASC
      `)
        .all() as unknown as WorkspaceHeadProjectionRow[]
    )
      .map((row) => ({ ...row }))
      .sort(compareWorkspaceHeadRow);
    const activeManagedMutations = (
      this.db
        .prepare(`
          SELECT
            workspace_instance_id, repository_id, workspace_id, workspace_epoch_id,
            operation_id, dispatch_event_id, base_workspace_version_id,
            base_accepted_event_id, base_head_revision, base_commit_oid, base_tree_oid,
            expected_paths_json, execution_profile_digest, protocol_version, reserved_at
          FROM runtime_managed_mutation_reservations
          ORDER BY workspace_instance_id ASC
        `)
        .all() as unknown as ManagedMutationReservationProjectionRow[]
    ).map((row) => ({ ...row }));
    if (
      !isDeepStrictEqual(epochs, expectedEpochs) ||
      !isDeepStrictEqual(versions, expectedVersions) ||
      !isDeepStrictEqual(heads, expectedHeads)
    ) {
      throw new Error('Workspace version projection is incomplete or inconsistent');
    }
    if (!isDeepStrictEqual(activeManagedMutations, authority.activeManagedMutations)) {
      throw new Error('Managed mutation reservation projection is incomplete or inconsistent');
    }
  }

  private workspaceProjectionCountSync(): number {
    const row = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM runtime_workspace_epochs) +
          (SELECT COUNT(*) FROM runtime_workspace_versions) +
          (SELECT COUNT(*) FROM runtime_workspace_heads) +
          (SELECT COUNT(*) FROM runtime_managed_mutation_reservations) AS count
      `)
      .get() as { count: number };
    return row.count;
  }

  private runtimeEventCommittedAt(eventId: string): number {
    const row = this.db
      .prepare('SELECT committed_at FROM runtime_events WHERE event_id = ?')
      .get(eventId) as { committed_at: number } | undefined;
    if (!row) throw new Error(`Missing RuntimeEvent committed time for ${eventId}`);
    return row.committed_at;
  }

  async commitToolPrepared(input: CommitToolPreparedInput): Promise<ToolCommitResult> {
    const canonicalInput: CommitToolPreparedInput = {
      ...input,
      runtimeEvent: canonicalizeRuntimeEventForStorage(input.runtimeEvent),
      dispatchRuntimeEvent: canonicalizeRuntimeEventForStorage(input.dispatchRuntimeEvent),
    };
    assertNoReservedWorkspaceAuthorityAppend(canonicalInput.runtimeEvent);
    assertNoReservedWorkspaceAuthorityAppend(canonicalInput.dispatchRuntimeEvent);
    assertPreparedInput(canonicalInput);
    return this.transaction(() => {
      this.assertToolLedgerTransition(
        [canonicalInput.runtimeEvent, canonicalInput.dispatchRuntimeEvent],
        't1_prepare',
      );
      const existing = this.readToolOperationSync(canonicalInput.operationId);
      if (existing) {
        assertPreparedIdentity(existing, canonicalInput);
        assertStoredRuntimeEventEquals(
          canonicalInput.runtimeEvent,
          this.readRuntimeEventJson(canonicalInput.runtimeEvent.id),
        );
        assertStoredRuntimeEventEquals(
          canonicalInput.dispatchRuntimeEvent,
          this.readRuntimeEventJson(canonicalInput.dispatchRuntimeEvent.id),
        );
        if (canonicalInput.dispatchRuntimeEvent.actions?.toolDispatch?.managedMutation) {
          const authority = this.readCanonicalWorkspaceAuthoritySync();
          this.assertWorkspaceProjectionsMatchSync(authority);
        }
        return {
          created: false,
          runtimeEventSeq: this.runtimeEventSeq(canonicalInput.dispatchRuntimeEvent.id),
        };
      }
      this.assertManagedMutationReservationAvailableSync(canonicalInput);
      this.insertRuntimeEvent(canonicalInput.runtimeEvent, canonicalInput.committedAt, true);
      const runtimeEventSeq = this.insertRuntimeEvent(
        canonicalInput.dispatchRuntimeEvent,
        canonicalInput.committedAt,
        false,
      );
      this.options.failpoint?.('after_runtime_event_insert');
      this.db
        .prepare(`
        INSERT INTO tool_journal_events (
          journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
          runtime_event_id, canonical_args_hash, recovery_mode, committed_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)
      `)
        .run(
          canonicalInput.journalEventId,
          canonicalInput.operationId,
          canonicalInput.runtimeEvent.invocationId,
          canonicalInput.runtimeEvent.runId,
          canonicalInput.runtimeEvent.turnId,
          canonicalInput.dispatchRuntimeEvent.id,
          canonicalInput.canonicalArgsHash,
          canonicalInput.recoveryMode,
          canonicalInput.committedAt,
        );
      this.options.failpoint?.('after_journal_event_insert');
      this.db
        .prepare(`
        INSERT INTO tool_operations (
          operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
          tool_name, canonical_args_hash, recovery_mode, current_state,
          call_event_id, dispatch_event_id, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, 1)
      `)
        .run(
          canonicalInput.operationId,
          canonicalInput.runtimeEvent.invocationId,
          canonicalInput.runtimeEvent.runId,
          canonicalInput.runtimeEvent.turnId,
          canonicalInput.providerToolCallId,
          canonicalInput.toolName,
          canonicalInput.canonicalArgsHash,
          canonicalInput.recoveryMode,
          canonicalInput.runtimeEvent.id,
          canonicalInput.dispatchRuntimeEvent.id,
        );
      this.insertManagedMutationReservationSync(canonicalInput);
      return { created: true, runtimeEventSeq };
    });
  }

  private assertManagedMutationReservationAvailableSync(input: CommitToolPreparedInput): void {
    const mutation = input.dispatchRuntimeEvent.actions?.toolDispatch?.managedMutation;
    if (!mutation) return;
    const call = input.runtimeEvent.content;
    const callArgs = call?.kind === 'function_call' ? call.args : undefined;
    const callPath =
      callArgs && typeof callArgs === 'object' && !Array.isArray(callArgs)
        ? (callArgs as { path?: unknown }).path
        : undefined;
    if (
      (input.toolName !== 'Write' && input.toolName !== 'Edit') ||
      input.recoveryMode !== 'reconcile' ||
      input.dispatchRuntimeEvent.actions?.toolDispatch?.toolName !== input.toolName
    ) {
      throw new Error('Managed mutation reservation requires a reconcile Write operation');
    }
    if (typeof callPath !== 'string' || mutation.expectedPath !== callPath) {
      throw new Error('Managed mutation path does not match its durable tool call');
    }
    if (!this.#readWorkspaceStorageRootBinding()) {
      throw new Error('Managed mutation reservation requires a durable storage-root binding');
    }
    const authority = this.readCanonicalWorkspaceAuthoritySync();
    this.assertWorkspaceProjectionsMatchSync(authority);
    const epoch = authority.baselines.find(
      (candidate) =>
        candidate.epoch.workspaceId === mutation.workspaceId &&
        candidate.epoch.workspaceEpochId === mutation.workspaceEpochId,
    )?.epoch;
    const head = authority.heads.find(
      (candidate) =>
        candidate.workspaceId === mutation.workspaceId &&
        candidate.workspaceEpochId === mutation.workspaceEpochId,
    );
    if (
      !epoch ||
      !head ||
      epoch.repositoryId !== mutation.repositoryId ||
      epoch.workspaceInstanceId !== mutation.workspaceInstanceId ||
      epoch.objectFormat !== mutation.objectFormat ||
      head.workspaceVersionId !== mutation.baseWorkspaceVersionId ||
      head.acceptedEventId !== mutation.baseAcceptedEventId ||
      head.revision !== mutation.baseHeadRevision ||
      head.commitOid !== mutation.baseCommitOid ||
      head.treeOid !== mutation.baseTreeOid
    ) {
      throw new Error('Managed mutation reservation does not match the canonical workspace head');
    }
    const active = this.db
      .prepare(`
        SELECT operation_id FROM runtime_managed_mutation_reservations
        WHERE workspace_instance_id = ?
      `)
      .get(mutation.workspaceInstanceId) as { operation_id: string } | undefined;
    if (active) {
      throw new Error(
        `Managed mutation reservation conflict with operation ${active.operation_id}`,
      );
    }
  }

  private insertManagedMutationReservationSync(input: CommitToolPreparedInput): void {
    const dispatch = input.dispatchRuntimeEvent.actions?.toolDispatch;
    const mutation = dispatch?.managedMutation;
    if (!dispatch || !mutation) return;
    this.insertManagedMutationReservationProjectionSync({
      workspace_instance_id: mutation.workspaceInstanceId,
      repository_id: mutation.repositoryId,
      workspace_id: mutation.workspaceId,
      workspace_epoch_id: mutation.workspaceEpochId,
      operation_id: input.operationId,
      dispatch_event_id: input.dispatchRuntimeEvent.id,
      base_workspace_version_id: mutation.baseWorkspaceVersionId,
      base_accepted_event_id: mutation.baseAcceptedEventId,
      base_head_revision: mutation.baseHeadRevision,
      base_commit_oid: mutation.baseCommitOid,
      base_tree_oid: mutation.baseTreeOid,
      expected_paths_json: JSON.stringify([mutation.expectedPath]),
      execution_profile_digest: mutation.executionProfileDigest,
      protocol_version: 1,
      reserved_at: input.committedAt,
    });
  }

  private insertManagedMutationReservationProjectionSync(
    reservation: ManagedMutationReservationProjectionRow,
  ): void {
    this.db
      .prepare(`
        INSERT INTO runtime_managed_mutation_reservations (
          workspace_instance_id, repository_id, workspace_id, workspace_epoch_id,
          operation_id, dispatch_event_id, base_workspace_version_id,
          base_accepted_event_id, base_head_revision, base_commit_oid, base_tree_oid,
          expected_paths_json, execution_profile_digest, protocol_version, reserved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `)
      .run(
        reservation.workspace_instance_id,
        reservation.repository_id,
        reservation.workspace_id,
        reservation.workspace_epoch_id,
        reservation.operation_id,
        reservation.dispatch_event_id,
        reservation.base_workspace_version_id,
        reservation.base_accepted_event_id,
        reservation.base_head_revision,
        reservation.base_commit_oid,
        reservation.base_tree_oid,
        reservation.expected_paths_json,
        reservation.execution_profile_digest,
        reservation.reserved_at,
      );
  }

  async commitToolOutcome(input: CommitToolOutcomeInput): Promise<ToolCommitResult> {
    const canonicalInput: CommitToolOutcomeInput = {
      ...input,
      runtimeEvent: canonicalizeRuntimeEventForStorage(input.runtimeEvent),
    };
    assertNoReservedWorkspaceAuthorityAppend(canonicalInput.runtimeEvent);
    assertOutcomeInput(canonicalInput);
    return this.transaction(() => this.commitToolOutcomeSync(canonicalInput));
  }

  async commitToolRecoveryBundle(input: RuntimeRecoveryBundleCommit): Promise<void> {
    const canonicalInput: RuntimeRecoveryBundleCommit = {
      ...input,
      reconcileRuntimeEvent: canonicalizeRuntimeEventForStorage(input.reconcileRuntimeEvent),
      ...(input.outcomeRuntimeEvent
        ? { outcomeRuntimeEvent: canonicalizeRuntimeEventForStorage(input.outcomeRuntimeEvent) }
        : {}),
      decisionRuntimeEvent: canonicalizeRuntimeEventForStorage(input.decisionRuntimeEvent),
    };
    assertNoReservedWorkspaceAuthorityAppend(canonicalInput.reconcileRuntimeEvent);
    assertNoReservedWorkspaceAuthorityAppend(canonicalInput.decisionRuntimeEvent);
    if (canonicalInput.outcomeRuntimeEvent) {
      assertNoReservedWorkspaceAuthorityAppend(canonicalInput.outcomeRuntimeEvent);
      assertNoReservedRecoveryFact(canonicalInput.outcomeRuntimeEvent);
    }
    this.transaction(() => {
      const operation = this.readToolOperationSync(canonicalInput.operationId);
      if (!operation) throw new Error(`Unknown tool operation ${canonicalInput.operationId}`);
      if (!operation.dispatchEventId) {
        throw new Error('Recovery bundle requires a durable dispatch RuntimeEvent');
      }
      assertToolRecoveryEventBundle({
        operation: recoveryOperationIdentity(operation),
        callEvent: this.readRequiredRuntimeEvent(operation.callEventId),
        dispatchEvent: this.readRequiredRuntimeEvent(operation.dispatchEventId),
        reconcileEvent: canonicalInput.reconcileRuntimeEvent,
        outcomeEvent: canonicalInput.outcomeRuntimeEvent,
        decisionEvent: canonicalInput.decisionRuntimeEvent,
      });
      assertStrictRuntimeEventOrder([
        this.runtimeEventSeq(operation.callEventId),
        this.runtimeEventSeq(operation.dispatchEventId),
      ]);
      this.assertToolLedgerTransition(
        [
          canonicalInput.reconcileRuntimeEvent,
          ...(canonicalInput.outcomeRuntimeEvent ? [canonicalInput.outcomeRuntimeEvent] : []),
          canonicalInput.decisionRuntimeEvent,
        ],
        'recovery_bundle',
      );
      if (operation.currentState !== 'prepared' || operation.resultEventId !== undefined) {
        this.assertExactRecoveryBundleAlreadyCommitted(canonicalInput, operation);
        return;
      }

      this.commitRecoveryFactSync(
        operation,
        canonicalInput.reconcileRuntimeEvent,
        'reconcile_observed',
      );
      this.options.failpoint?.('after_recovery_reconcile');
      if (canonicalInput.outcomeRuntimeEvent) {
        this.commitToolOutcomeSync({
          operationId: canonicalInput.operationId,
          journalEventId: `${canonicalInput.operationId}_outcome`,
          runtimeEvent: canonicalInput.outcomeRuntimeEvent,
          committedAt: canonicalInput.outcomeRuntimeEvent.ts,
        });
        this.options.failpoint?.('after_recovery_outcome');
      }

      const decision = canonicalInput.decisionRuntimeEvent.actions?.toolRecovery;
      if (!decision || decision.kind !== 'maka.tool.recovery_decision') {
        throw new Error('Recovery bundle requires a recovery decision');
      }
      const current = this.readToolOperationSync(canonicalInput.operationId);
      if (!current) throw new Error(`Unknown tool operation ${canonicalInput.operationId}`);
      this.commitRecoveryFactSync(
        current,
        canonicalInput.decisionRuntimeEvent,
        decision.payload.disposition === 'completed' ? 'recovery_completed' : 'recovery_parked',
        decision.payload,
      );
      this.options.failpoint?.('after_recovery_decision');
    });
  }

  async readToolOperation(operationId: string): Promise<ToolOperationRecord | undefined> {
    return this.readToolOperationSync(operationId);
  }

  async listUnsettledToolOperations(
    sessionIds?: string | readonly string[],
  ): Promise<UnsettledToolOperationRecord[]> {
    const selectedSessionIds =
      sessionIds === undefined
        ? undefined
        : [...new Set(typeof sessionIds === 'string' ? [sessionIds] : sessionIds)];
    if (selectedSessionIds?.length === 0) return [];
    const query = `
      SELECT call_event.session_id,
        tool_operations.operation_id, tool_operations.invocation_id,
        tool_operations.run_id, tool_operations.turn_id,
        tool_operations.provider_tool_call_id, tool_operations.tool_name,
        tool_operations.canonical_args_hash, tool_operations.recovery_mode,
        tool_operations.current_state, tool_operations.call_event_id,
        tool_operations.dispatch_event_id, tool_operations.result_event_id,
        tool_operations.version
      FROM tool_operations
      JOIN runtime_events AS call_event
        ON call_event.event_id = tool_operations.call_event_id
      WHERE tool_operations.current_state = 'prepared'
        AND tool_operations.result_event_id IS NULL
        AND tool_operations.dispatch_event_id IS NOT NULL
        ${
          selectedSessionIds === undefined
            ? ''
            : 'AND call_event.session_id IN (SELECT value FROM json_each(?))'
        }
      ORDER BY tool_operations.invocation_id ASC, tool_operations.operation_id ASC
    `;
    const statement = this.db.prepare(query);
    const rows = (selectedSessionIds === undefined
      ? statement.all()
      : statement.all(
          JSON.stringify(selectedSessionIds),
        )) as unknown as UnsettledToolOperationRow[];
    return rows.map((row) => ({ sessionId: row.session_id, ...toolOperationFromRow(row) }));
  }

  async readToolJournal(operationId: string): Promise<ToolJournalEventRecord[]> {
    const rows = this.db
      .prepare(`
      SELECT journal_event_id, operation_id, invocation_id, run_id, turn_id,
        state, runtime_event_id, canonical_args_hash, recovery_mode,
        external_handle, metadata_json, committed_at
      FROM tool_journal_events
      WHERE operation_id = ?
      ORDER BY journal_seq ASC
    `)
      .all(operationId) as unknown as ToolJournalRow[];
    return rows.map(toolJournalRecordFromRow);
  }

  /** Explicit full-workspace integrity audit and disposable projection rebuild. */
  async rebuildToolProjectionsFromRuntimeEvents(): Promise<ToolProjectionRebuildResult> {
    return this.transaction(() => this.rebuildToolProjectionsFromRuntimeEventsSync());
  }

  /** Rebuild one Session's disposable tool projections while its owner holds a fence. */
  async rebuildToolProjectionsForSession(sessionId: string): Promise<void> {
    await this.transaction(() => this.rebuildToolProjectionsFromRuntimeEventsSync(sessionId));
  }

  /**
   * Repair terminal projections for unsettled tools without decoding the
   * Session's full RuntimeEvent history. Bundle export is a compatibility
   * boundary: unrelated historical payloads may be byte-preserved and newer
   * or older than the RuntimeEvent schema understood by this build.
   */
  async rebuildTerminalToolProjectionsForSessions(sessionIds: readonly string[]): Promise<void> {
    const operations = await this.listUnsettledToolOperations(sessionIds);
    if (operations.length === 0) return;

    this.transaction(() => {
      const dispatchSequence = this.db.prepare(`
        SELECT event_seq
        FROM runtime_events
        WHERE event_id = ? AND session_id = ? AND invocation_id = ?
      `);
      const firstTerminal = this.db.prepare(`
        SELECT event_id, event_seq, committed_at
        FROM runtime_events
        WHERE session_id = ? AND invocation_id = ?
          AND ${TERMINAL_RUNTIME_EVENT_SQL}
        ORDER BY event_seq ASC, event_id ASC
        LIMIT 1
      `);
      const insertJournal = this.db.prepare(`
        INSERT INTO tool_journal_events (
          journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
          runtime_event_id, canonical_args_hash, recovery_mode, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateOperation = this.db.prepare(`
        UPDATE tool_operations
        SET current_state = ?, version = version + 1
        WHERE operation_id = ? AND current_state = 'prepared' AND result_event_id IS NULL
      `);

      for (const operation of operations) {
        if (!operation.dispatchEventId) continue;
        const dispatch = dispatchSequence.get(
          operation.dispatchEventId,
          operation.sessionId,
          operation.invocationId,
        ) as { event_seq: number } | undefined;
        if (!dispatch) continue;
        const terminal = firstTerminal.get(operation.sessionId, operation.invocationId) as
          | { event_id: string; event_seq: number; committed_at: number }
          | undefined;
        if (!terminal || terminal.event_seq <= dispatch.event_seq) continue;

        const state =
          operation.toolName === 'AskUserQuestion' && operation.recoveryMode === 'never_auto_retry'
            ? 'abandoned'
            : 'interrupted_unknown';
        insertJournal.run(
          journalEventIdFor(operation.operationId, terminal.event_id, state),
          operation.operationId,
          operation.invocationId,
          operation.runId,
          operation.turnId,
          state,
          terminal.event_id,
          operation.canonicalArgsHash,
          operation.recoveryMode,
          terminal.committed_at,
        );
        const updated = updateOperation.run(state, operation.operationId);
        if (updated.changes !== 1) {
          throw new Error(
            `Tool operation projection changed during export: ${operation.operationId}`,
          );
        }
      }
    });
  }

  private rebuildToolProjectionsFromRuntimeEventsSync(
    sessionId?: string,
  ): ToolProjectionRebuildResult {
    const statement = this.db.prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id,
          event_seq, payload_json, committed_at
        FROM runtime_events
        ${sessionId === undefined ? '' : 'WHERE session_id = ?'}
        ORDER BY invocation_id ASC, event_seq ASC, event_id ASC
      `);
    const rows = (sessionId === undefined
      ? statement.all()
      : statement.all(sessionId)) as unknown as Array<
      RuntimeEventStorageRow & { event_seq: number; committed_at: number }
    >;
    const events = rows.map(decodeRuntimeEventStorageRow);
    const eventOrder = new Map(events.map((event, index) => [event.id, index] as const));
    const runtimeInvocationKey = (event: RuntimeEvent): string =>
      JSON.stringify([event.sessionId, event.invocationId]);
    const terminalEventsByInvocation = new Map<string, RuntimeEvent>();
    for (const event of events) {
      if (
        isTerminalRuntimeEvent(event) &&
        !terminalEventsByInvocation.has(runtimeInvocationKey(event))
      ) {
        terminalEventsByInvocation.set(runtimeInvocationKey(event), event);
      }
    }
    const committedAt = new Map(
      rows.map((row, index) => [events[index]!.id, row.committed_at] as const),
    );
    const scan = scanToolLedger(events);
    if (scan.hasCorruption) {
      const first = scan.issues[0];
      throw new Error(
        `Corrupt tool RuntimeEvent ledger: ${first?.code ?? 'unknown'} at ${first?.eventId ?? 'unknown'}`,
      );
    }
    const projected = scan.operations.filter((operation) => operation.dispatchEvent);

    // Mainline schema 4 can contain pre-authority projections without a
    // dispatch RuntimeEvent. They remain readable but quarantined from
    // recovery; only projections backed by canonical T1 facts are rebuilt.
    if (sessionId === undefined) {
      this.db.exec(`
        DELETE FROM tool_journal_events
        WHERE operation_id IN (
          SELECT operation_id FROM tool_operations WHERE dispatch_event_id IS NOT NULL
        );
        DELETE FROM tool_operations WHERE dispatch_event_id IS NOT NULL;
      `);
    } else {
      this.db
        .prepare(`
          DELETE FROM tool_journal_events
          WHERE operation_id IN (
            SELECT operation_id
            FROM tool_operations
            WHERE dispatch_event_id IS NOT NULL
              AND call_event_id IN (
                SELECT event_id FROM runtime_events WHERE session_id = ?
              )
          )
        `)
        .run(sessionId);
      this.db
        .prepare(`
          DELETE FROM tool_operations
          WHERE dispatch_event_id IS NOT NULL
            AND call_event_id IN (
              SELECT event_id FROM runtime_events WHERE session_id = ?
            )
        `)
        .run(sessionId);
    }
    let journalEvents = 0;
    for (const operation of projected) {
      const call = operation.callEvent;
      const event = operation.dispatchEvent;
      const dispatch = event?.actions?.toolDispatch;
      if (!call || !event || !dispatch) {
        throw new Error('Tool projection scan produced an incomplete dispatched operation');
      }
      const recovery = interpretScannedToolRecovery(operation, eventOrder);
      if (recovery.kind === 'corruption') {
        throw new Error(
          `Corrupt tool recovery bundle for ${dispatch.operationId}: ${recovery.code}`,
        );
      }
      const reconcileEvent = recovery.kind === 'valid' ? recovery.reconcileEvent : undefined;
      const decisionEvent = recovery.kind === 'valid' ? recovery.decisionEvent : undefined;
      const decision = recovery.kind === 'valid' ? recovery.decision : undefined;
      const terminalEvent = terminalEventsByInvocation.get(runtimeInvocationKey(event));
      const terminalAfterDispatch =
        terminalEvent !== undefined &&
        requireRuntimeEventOrder(eventOrder, terminalEvent.id) >
          requireRuntimeEventOrder(eventOrder, event.id);
      const abandoned =
        !decision &&
        !operation.responseEvent &&
        dispatch.toolName === 'AskUserQuestion' &&
        dispatch.recoveryMode === 'never_auto_retry' &&
        terminalAfterDispatch;
      // A terminal invocation closes the tool's execution window, but does not
      // prove whether an external side effect completed. Preserve that
      // uncertainty in the query projection without rewriting the immutable
      // RuntimeEvent history.
      const interruptedUnknown =
        !decision && !operation.responseEvent && !abandoned && terminalAfterDispatch;

      this.db
        .prepare(`
          INSERT INTO tool_journal_events (
            journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
            runtime_event_id, canonical_args_hash, recovery_mode, committed_at
          ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)
        `)
        .run(
          `${dispatch.operationId}_prepared`,
          dispatch.operationId,
          event.invocationId,
          event.runId,
          event.turnId,
          event.id,
          dispatch.canonicalArgsHash,
          dispatch.recoveryMode,
          committedAt.get(event.id) ?? event.ts,
        );
      journalEvents += 1;
      const response = operation.responseEvent;
      const currentState = decision
        ? decision.disposition === 'completed'
          ? 'recovery_completed'
          : 'recovery_parked'
        : response
          ? 'outcome_committed'
          : abandoned
            ? 'abandoned'
            : interruptedUnknown
              ? 'interrupted_unknown'
              : 'prepared';
      const tail = [
        ...(reconcileEvent
          ? [{ event: reconcileEvent, state: 'reconcile_observed' as const }]
          : []),
        ...(response ? [{ event: response, state: 'outcome_committed' as const }] : []),
        ...(decisionEvent
          ? [
              {
                event: decisionEvent,
                state:
                  decision?.disposition === 'parked'
                    ? ('recovery_parked' as const)
                    : ('recovery_completed' as const),
              },
            ]
          : []),
        ...(abandoned && terminalEvent
          ? [{ event: terminalEvent, state: 'abandoned' as const }]
          : []),
        ...(interruptedUnknown && terminalEvent
          ? [{ event: terminalEvent, state: 'interrupted_unknown' as const }]
          : []),
      ].sort(
        (a, b) =>
          requireRuntimeEventOrder(eventOrder, a.event.id) -
          requireRuntimeEventOrder(eventOrder, b.event.id),
      );
      this.db
        .prepare(`
          INSERT INTO tool_operations (
            operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
            tool_name, canonical_args_hash, recovery_mode, current_state,
            call_event_id, dispatch_event_id, result_event_id, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          dispatch.operationId,
          event.invocationId,
          event.runId,
          event.turnId,
          dispatch.providerToolCallId,
          dispatch.toolName,
          dispatch.canonicalArgsHash,
          dispatch.recoveryMode,
          currentState,
          call.id,
          event.id,
          response?.id ?? null,
          1 + tail.length,
        );
      for (const item of tail) {
        this.db
          .prepare(`
            INSERT INTO tool_journal_events (
              journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
              runtime_event_id, canonical_args_hash, recovery_mode, metadata_json, committed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            journalEventIdFor(dispatch.operationId, item.event.id, item.state),
            dispatch.operationId,
            item.event.invocationId,
            item.event.runId,
            item.event.turnId,
            item.state,
            item.event.id,
            dispatch.canonicalArgsHash,
            dispatch.recoveryMode,
            item.event.actions?.toolRecovery
              ? JSON.stringify(item.event.actions.toolRecovery)
              : null,
            committedAt.get(item.event.id) ?? item.event.ts,
          );
        journalEvents += 1;
      }
    }
    return { operations: projected.length, journalEvents };
  }

  private commitToolOutcomeSync(
    input: CommitToolOutcomeInput,
    settlementOwner: 'generic' | 'workspace_successor' | 'workspace_terminal' = 'generic',
  ): ToolCommitResult {
    const operation = this.readToolOperationSync(input.operationId);
    if (!operation) throw new Error(`Unknown tool operation ${input.operationId}`);
    assertOutcomeIdentity(operation, input.runtimeEvent);
    this.assertToolLedgerTransition([input.runtimeEvent], 't2_outcome');
    if (operation.resultEventId) {
      if (operation.resultEventId !== input.runtimeEvent.id) {
        throw new Error(`Tool operation outcome conflict for ${input.operationId}`);
      }
      assertStoredRuntimeEventEquals(
        input.runtimeEvent,
        this.readRuntimeEventJson(input.runtimeEvent.id),
      );
      return { created: false, runtimeEventSeq: this.runtimeEventSeq(input.runtimeEvent.id) };
    }
    if (!operation.dispatchEventId) {
      throw new Error(`Tool operation ${input.operationId} is missing its dispatch event`);
    }
    const dispatchJson = this.readRuntimeEventJson(operation.dispatchEventId);
    const dispatchEvent = dispatchJson
      ? decodeRuntimeEvent(JSON.parse(dispatchJson) as unknown)
      : undefined;
    if (
      dispatchEvent?.actions?.toolDispatch?.resultProjectionVersion === 1 &&
      input.runtimeEvent.content?.kind === 'function_response' &&
      input.runtimeEvent.content.modelProjection === undefined
    ) {
      throw new Error('Projected Tool Result T2 requires its durable model projection');
    }
    if (dispatchEvent?.actions?.toolDispatch?.managedMutation) {
      const reservation = this.db
        .prepare(`
          SELECT operation_id FROM runtime_managed_mutation_reservations
          WHERE operation_id = ?
        `)
        .get(input.operationId) as { operation_id: string } | undefined;
      if (!reservation) {
        throw new Error('Managed mutation T1 is missing its durable reservation');
      }
      if (settlementOwner === 'generic') {
        throw new Error('Managed mutation outcome requires a managed mutation authority writer');
      }
    }
    const runtimeEventSeq = this.insertRuntimeEvent(input.runtimeEvent, input.committedAt, false);
    this.options.failpoint?.('after_runtime_event_insert');
    this.insertToolJournalEvent(
      operation,
      input.runtimeEvent,
      'outcome_committed',
      input.journalEventId,
      input.committedAt,
    );
    const updated = this.db
      .prepare(`
      UPDATE tool_operations
      SET current_state = 'outcome_committed', result_event_id = ?, version = version + 1
      WHERE operation_id = ? AND current_state = 'prepared' AND result_event_id IS NULL
    `)
      .run(input.runtimeEvent.id, input.operationId);
    if (updated.changes !== 1) {
      throw new Error(`Tool operation compare-and-set failed for ${input.operationId}`);
    }
    return { created: true, runtimeEventSeq };
  }

  private commitRecoveryFactSync(
    operation: ToolOperationRecord,
    event: RuntimeEvent,
    state: 'reconcile_observed' | 'recovery_completed' | 'recovery_parked',
    decision?: ToolRecoveryDecisionFact,
  ): void {
    this.insertRuntimeEvent(event, event.ts, false);
    this.options.failpoint?.('after_runtime_event_insert');
    this.insertToolJournalEvent(operation, event, state);
    if (state === 'reconcile_observed') {
      const updated = this.db
        .prepare('UPDATE tool_operations SET version = version + 1 WHERE operation_id = ?')
        .run(operation.operationId);
      if (updated.changes !== 1) {
        throw new Error(`Tool operation compare-and-set failed for ${operation.operationId}`);
      }
      return;
    }

    if (
      state === 'recovery_completed' &&
      (decision?.disposition !== 'completed' ||
        operation.currentState !== 'outcome_committed' ||
        operation.resultEventId !== decision.outcomeEventId)
    ) {
      throw new Error('Completed recovery decision does not match the persisted outcome');
    }
    if (
      state === 'recovery_parked' &&
      (decision?.disposition !== 'parked' ||
        operation.currentState !== 'prepared' ||
        operation.resultEventId !== undefined)
    ) {
      throw new Error('Parked recovery decision does not match the prepared operation');
    }
    const updated = this.db
      .prepare(`
      UPDATE tool_operations
      SET current_state = ?, version = version + 1
      WHERE operation_id = ? AND current_state = ?
    `)
      .run(
        state,
        operation.operationId,
        state === 'recovery_completed' ? 'outcome_committed' : 'prepared',
      );
    if (updated.changes !== 1) {
      throw new Error(`Tool operation compare-and-set failed for ${operation.operationId}`);
    }
  }

  private insertToolJournalEvent(
    operation: ToolOperationRecord,
    event: RuntimeEvent,
    state: ToolJournalState,
    journalEventId = `${event.id}_journal`,
    committedAt = event.ts,
  ): void {
    this.db
      .prepare(`
      INSERT INTO tool_journal_events (
        journal_event_id, operation_id, invocation_id, run_id, turn_id, state,
        runtime_event_id, canonical_args_hash, recovery_mode, metadata_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        journalEventId,
        operation.operationId,
        operation.invocationId,
        operation.runId,
        operation.turnId,
        state,
        event.id,
        operation.canonicalArgsHash,
        operation.recoveryMode,
        event.actions?.toolRecovery ? JSON.stringify(event.actions.toolRecovery) : null,
        committedAt,
      );
    this.options.failpoint?.('after_journal_event_insert');
  }

  private assertExactRecoveryBundleAlreadyCommitted(
    input: RuntimeRecoveryBundleCommit,
    operation: ToolOperationRecord,
  ): void {
    const decision = input.decisionRuntimeEvent.actions?.toolRecovery;
    const completed =
      decision?.kind === 'maka.tool.recovery_decision' &&
      decision.payload.disposition === 'completed';
    if (
      (completed &&
        (!input.outcomeRuntimeEvent ||
          operation.currentState !== 'recovery_completed' ||
          operation.resultEventId !== input.outcomeRuntimeEvent.id)) ||
      (!completed &&
        (input.outcomeRuntimeEvent !== undefined ||
          operation.currentState !== 'recovery_parked' ||
          operation.resultEventId !== undefined))
    ) {
      throw new Error(`Tool operation ${operation.operationId} is already settled`);
    }
    for (const event of [
      input.reconcileRuntimeEvent,
      ...(input.outcomeRuntimeEvent ? [input.outcomeRuntimeEvent] : []),
      input.decisionRuntimeEvent,
    ]) {
      const stored = this.readRuntimeEventJson(event.id);
      if (stored === undefined) {
        throw new Error(`Tool recovery bundle is incomplete for ${operation.operationId}`);
      }
      assertStoredRuntimeEventEquals(event, stored);
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.databaseLease) {
      const nested = this.db.isTransaction;
      return this.databaseLease.transaction('write', () => {
        // A sibling lease may have changed the shared transaction view since
        // this store last used its reconstructible cache.
        if (nested) this.clearToolLedgerCache();
        return operation();
      });
    }
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = operation();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the protocol failure that caused rollback.
      }
      // Reducers may have loaded rows written earlier in this transaction as
      // their immutable base. Bump the local view even on rollback so the next
      // admission discards that phantom base before retrying.
      this.localCommittedWriteRevision += 1;
      this.settleEventCommits(false);
      this.settleToolLedgerStates(false);
      throw error;
    }
    this.localCommittedWriteRevision += 1;
    this.settleEventCommits(true);
    this.settleToolLedgerStates(true);
    return result;
  }

  private noteEventCommit(sessionId: string): void {
    if (this.uncommittedEventSessions.size === 0 && this.databaseLease) {
      this.databaseLease.onTransactionSettled((committed) => this.settleEventCommits(committed));
    }
    this.uncommittedEventSessions.add(sessionId);
  }

  private settleEventCommits(committed: boolean): void {
    const sessionIds = [...this.uncommittedEventSessions];
    this.uncommittedEventSessions.clear();
    if (!committed) return;
    for (const sessionId of sessionIds) {
      for (const listener of this.eventCommitListeners) listener(sessionId);
    }
  }

  subscribeRuntimeEventCommits(listener: (sessionId: string) => void): () => void {
    this.eventCommitListeners.add(listener);
    return () => this.eventCommitListeners.delete(listener);
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
        // Preserve the consistency failure that caused rollback.
      }
      throw error;
    }
  }

  private readContinuationClaimRow(
    predicate: string,
    ...values: readonly SQLInputValue[]
  ): ContinuationClaimStorageRow | undefined {
    return this.db
      .prepare(`
        SELECT
          claim_id,
          source_session_id,
          source_invocation_id,
          source_run_id,
          source_turn_id,
          source_event_high_water,
          source_prefix_digest,
          boundary_digest,
          boundary_json,
          provider_projection_version,
          provider_replay_digest,
          target_session_id,
          target_invocation_id,
          target_run_id,
          target_turn_id,
          target_opening_json,
          claimed_at,
          start_event_id,
          start_kind,
          protocol_version
        FROM runtime_continuation_claims
        WHERE ${predicate}
        LIMIT 1
      `)
      .get(...values) as ContinuationClaimStorageRow | undefined;
  }

  private readContinuationClaimRows(): ContinuationClaimStorageRow[] {
    return this.db
      .prepare(`
        SELECT
          claim_id,
          source_session_id,
          source_invocation_id,
          source_run_id,
          source_turn_id,
          source_event_high_water,
          source_prefix_digest,
          boundary_digest,
          boundary_json,
          provider_projection_version,
          provider_replay_digest,
          target_session_id,
          target_invocation_id,
          target_run_id,
          target_turn_id,
          target_opening_json,
          claimed_at,
          start_event_id,
          start_kind,
          protocol_version
        FROM runtime_continuation_claims
        ORDER BY claimed_at ASC, claim_id ASC
      `)
      .all() as unknown as ContinuationClaimStorageRow[];
  }

  private assertContinuationAuthorityIntegrity(): void {
    for (const row of this.readContinuationClaimRows()) {
      this.decodeContinuationClaimStateRow(row);
    }
  }

  private continuationTargetHasRuntimeState(claim: ContinuationClaimV1): boolean {
    const { target } = claim;
    const values = [
      target.invocationId,
      target.sessionId,
      target.runId,
      claim.targetOpening.source.kind === 'handoff' ? 1 : 0,
      target.sessionId,
      target.turnId,
    ] as const;
    const runtimeEvent = this.db
      .prepare(`
        SELECT 1 AS found
        FROM runtime_events
        WHERE invocation_id = ?
          OR (session_id = ? AND run_id = ?)
          OR (? = 0 AND session_id = ? AND turn_id = ?)
        LIMIT 1
      `)
      .get(...values) as { found: number } | undefined;
    if (runtimeEvent) return true;
    return (
      (this.db
        .prepare(`
          SELECT 1 AS found
          FROM runtime_partial_snapshots
          WHERE invocation_id = ?
            OR (session_id = ? AND run_id = ?)
            OR (? = 0 AND session_id = ? AND turn_id = ?)
          LIMIT 1
        `)
        .get(...values) as { found: number } | undefined) !== undefined
    );
  }

  private decodeContinuationClaimStateRow(
    row: ContinuationClaimStorageRow,
  ): ContinuationClaimStateV1 {
    const claim = decodeContinuationClaimRow(row);
    if (!row.start_event_id) {
      if (row.start_kind !== null) {
        throw new Error(`Continuation claim start kind exists without event for ${claim.claimId}`);
      }
      return { claim };
    }
    if (row.start_kind !== 'runtime_admission' && row.start_kind !== 'claim_repair') {
      throw new Error(`Continuation claim start kind is missing for ${claim.claimId}`);
    }
    const start = this.readRequiredRuntimeEvent(row.start_event_id);
    assertContinuationStartEvent(claim, start, row.start_kind);
    if (start.id !== row.start_event_id || this.runtimeEventSeq(start.id) !== 1) {
      throw new Error(`Continuation claim start identity mismatch for ${claim.claimId}`);
    }
    return { claim, startEventId: row.start_event_id, startKind: row.start_kind };
  }

  private assertContinuationBoundaryMatchesLedger(claim: ContinuationClaimV1): void {
    const lastIndex = claim.boundary.segments.length - 1;
    let previousPrefix: ImmutableRuntimePrefixV1 | undefined;
    for (const [index, segment] of claim.boundary.segments.entries()) {
      let prefix: ImmutableRuntimePrefixV1;
      try {
        prefix = this.readImmutableRuntimePrefixSync({
          sessionId: segment.identity.sessionId,
          runId: segment.identity.runId,
          ...(index === lastIndex ? {} : { upToEventSeq: segment.position.lastEventSeq }),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'immutable RuntimeEvent prefix is empty' ||
            error.message.includes('high-water') ||
            error.message.includes('event_seq gap'))
        ) {
          throw new Error(
            index === lastIndex
              ? 'Continuation source boundary is missing'
              : `Continuation ancestor boundary is missing for ${segment.identity.runId}`,
          );
        }
        throw error;
      }
      if (
        !isDeepStrictEqual(prefix.identity, segment.identity) ||
        !isDeepStrictEqual(prefix.position, segment.position) ||
        prefix.prefixDigest !== segment.prefixDigest
      ) {
        throw new Error(
          index === lastIndex
            ? 'Continuation source boundary changed'
            : `Continuation ancestor boundary changed for ${segment.identity.runId}`,
        );
      }
      const opening = prefix.events[0]?.content;
      const repeatsTurn = previousPrefix?.identity.turnId === prefix.identity.turnId;
      if (
        repeatsTurn ||
        (opening?.kind === 'invocation_opened' && opening.source.kind === 'handoff')
      ) {
        if (
          !previousPrefix ||
          opening?.kind !== 'invocation_opened' ||
          opening.source.kind !== 'handoff'
        ) {
          throw new Error('Same-turn boundary requires an authenticated handoff edge');
        }
        const row = this.readContinuationClaimRow('claim_id = ?', opening.source.claimId);
        const state = row && this.decodeContinuationClaimStateRow(row);
        if (
          !state ||
          state.startEventId !== prefix.events[0]?.id ||
          !isDeepStrictEqual(
            state.claim.boundary.segments,
            claim.boundary.segments.slice(0, index),
          ) ||
          !continuationStartEventMatchesClaim(prefix.events[0], state.claim, state.startKind)
        ) {
          throw new Error('Same-turn boundary handoff claim does not authenticate its lineage');
        }
        assertHandoffClaimSource(state.claim, previousPrefix);
      }
      if (index === lastIndex) {
        assertHandoffClaimSource(claim, prefix);
        const terminalEvents = prefix.events.filter(isTerminalRuntimeEvent);
        const terminal = terminalEvents[0];
        if (terminalEvents.length !== 1 || !terminal || prefix.events.at(-1)?.id !== terminal.id) {
          throw new Error(
            'Continuation source boundary must end with exactly one terminal RuntimeEvent',
          );
        }
      }
      previousPrefix = prefix;
    }
  }

  private assertToolLedgerTransition(
    candidateEvents: readonly RuntimeEvent[],
    expectedTransition: ToolLedgerTransitionKind,
  ): void {
    const canonicalEncodings = candidateEvents.map(encodeCanonicalRuntimeEvent);
    const canonicalEvents = canonicalEncodings.map(({ event }) => event);
    const entry = this.toolLedgerCacheEntry(canonicalEvents);
    const appendedEncodings = canonicalEncodings.filter(
      ({ event }) => entry.reducer.event(event.id) === undefined,
    );
    const validation = validateIncrementalToolLedgerTransition({
      reducer: entry.reducer,
      candidateEvents: canonicalEvents,
      expectedTransition,
    });
    if (!validation.ok) {
      if (validation.source === 'existing') {
        throw new ToolLedgerCorruptionError(validation.code, validation.eventId);
      }
      throw new ToolLedgerRejectionError(validation.code, validation.eventId);
    }
    if (validation.appendedEvents === 0) return;
    this.noteToolLedgerState(
      entry,
      validation.checkpoint,
      canonicalEvents.map((event) => event.invocationId),
      {
        eventCount: validation.appendedEvents,
        estimatedBytes: estimateToolLedgerCacheBytes(
          appendedEncodings.reduce(
            (bytes, encoding) => bytes + Buffer.byteLength(encoding.json, 'utf8'),
            0,
          ),
          validation.appendedEvents,
        ),
      },
    );
  }

  private toolLedgerCacheEntry(candidateEvents: readonly RuntimeEvent[]): ToolLedgerCacheEntry {
    const currentVersion = this.currentToolLedgerCacheVersion();
    if (this.toolLedgerCacheVersion !== currentVersion) this.refreshToolLedgerCacheVersion();

    const directInvocationIds = new Set(candidateEvents.map((event) => event.invocationId));
    const directOperationIds = referencedToolOperationIds(candidateEvents);
    for (const invocationId of this.toolLedgerOperationInvocations(directOperationIds)) {
      directInvocationIds.add(invocationId);
    }

    for (const [key, entry] of this.toolLedgerCache) {
      if (
        entry.seedInvocationIds.size === directInvocationIds.size &&
        [...directInvocationIds].every((invocationId) => entry.seedInvocationIds.has(invocationId))
      ) {
        this.toolLedgerCacheMetrics.hits += 1;
        this.touchToolLedgerCacheEntry(key, entry);
        return entry;
      }
    }
    this.toolLedgerCacheMetrics.misses += 1;

    const invocationIds = new Set(directInvocationIds);
    const operationIds = new Set(directOperationIds);
    const resolvedOperationIds = new Set<string>();
    const loadedInvocationIds = new Set<string>();
    const scopedEvents: Array<{ event: RuntimeEvent; eventSeq: number }> = [];
    let storedPayloadBytes = 0;
    const readInvocation = this.db.prepare(`
      SELECT event_id, session_id, invocation_id, run_id, turn_id, event_seq, payload_json,
             length(CAST(payload_json AS BLOB)) AS stored_bytes
      FROM runtime_events
      WHERE invocation_id = ?
      ORDER BY event_seq ASC, event_id ASC
    `);

    while (true) {
      const pendingOperationIds = [...operationIds].filter(
        (operationId) => !resolvedOperationIds.has(operationId),
      );
      if (pendingOperationIds.length > 0) {
        for (const operationId of pendingOperationIds) resolvedOperationIds.add(operationId);
        for (const invocationId of this.toolLedgerOperationInvocations(pendingOperationIds)) {
          invocationIds.add(invocationId);
        }
      }

      const pendingInvocationIds = [...invocationIds]
        .filter((invocationId) => !loadedInvocationIds.has(invocationId))
        .sort();
      if (pendingInvocationIds.length === 0 && pendingOperationIds.length === 0) break;
      for (const invocationId of pendingInvocationIds) {
        loadedInvocationIds.add(invocationId);
        const rows = readInvocation.all(
          invocationId,
        ) as unknown as ToolLedgerRuntimeEventStorageRow[];
        for (const row of rows) {
          storedPayloadBytes += requireRuntimeEventScanCount(row.stored_bytes);
          const event = decodeRuntimeEventStorageRow(row);
          scopedEvents.push({ event, eventSeq: row.event_seq });
          if (event.refs?.parentOperationId) operationIds.add(event.refs.parentOperationId);
        }
      }
    }

    const sortedSeedInvocationIds = [...directInvocationIds].sort();
    const sortedInvocationIds = [...invocationIds].sort();
    const key = JSON.stringify([sortedSeedInvocationIds, sortedInvocationIds]);
    const existing = this.toolLedgerCache.get(key);
    if (existing) {
      this.touchToolLedgerCacheEntry(key, existing);
      return existing;
    }
    scopedEvents.sort(
      (left, right) =>
        left.event.invocationId.localeCompare(right.event.invocationId) ||
        left.eventSeq - right.eventSeq ||
        left.event.id.localeCompare(right.event.id),
    );
    const entry: ToolLedgerCacheEntry = {
      reducer: new ToolLedgerReducer(scopedEvents.map(({ event }) => event)),
      seedInvocationIds: new Set(sortedSeedInvocationIds),
      invocationIds: new Set(sortedInvocationIds),
      eventCount: scopedEvents.length,
      estimatedBytes: estimateToolLedgerCacheBytes(storedPayloadBytes, scopedEvents.length),
    };
    if (this.toolLedgerEntryExceedsAdmissionBudget(entry)) {
      this.toolLedgerCacheMetrics.transientEntries += 1;
      return entry;
    }
    this.retainToolLedgerCacheEntry(key, entry);
    this.trimToolLedgerCache();
    return entry;
  }

  private toolLedgerOperationInvocations(operationIds: Iterable<string>): Set<string> {
    const ids = [...new Set(operationIds)].sort();
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`
        SELECT DISTINCT invocation_id
        FROM runtime_events
        WHERE event_kind = 'tool_dispatch'
          AND CASE
            WHEN json_valid(payload_json)
              THEN json_extract(payload_json, '$.actions.toolDispatch.operationId')
          END IN (${placeholders})
      `)
      .all(...ids) as Array<{ invocation_id: string }>;
    return new Set(rows.map((row) => row.invocation_id));
  }

  private noteToolLedgerState(
    entry: ToolLedgerCacheEntry,
    checkpoint: number,
    invocationIds: readonly string[],
    delta: Pick<ToolLedgerCacheEntry, 'estimatedBytes' | 'eventCount'>,
  ): void {
    const reducer = entry.reducer;
    const existing = this.uncommittedToolLedgerStates.get(reducer);
    if (existing) {
      for (const invocationId of invocationIds) existing.changedInvocationIds.add(invocationId);
      this.adjustToolLedgerCacheEntry(entry, delta);
      return;
    }
    if (this.uncommittedToolLedgerStates.size === 0 && this.databaseLease) {
      this.databaseLease.onTransactionSettled((committed) =>
        this.settleToolLedgerStates(committed),
      );
    }
    this.uncommittedToolLedgerStates.set(reducer, {
      checkpoint,
      changedInvocationIds: new Set(invocationIds),
      entry,
      estimatedBytesBefore: entry.estimatedBytes,
      eventCountBefore: entry.eventCount,
    });
    this.adjustToolLedgerCacheEntry(entry, delta);
  }

  private settleToolLedgerStates(committed: boolean): void {
    const states = [...this.uncommittedToolLedgerStates.entries()];
    this.uncommittedToolLedgerStates.clear();
    if (states.length === 0) return;
    if (!committed) {
      for (const [reducer, state] of states.reverse()) {
        reducer.rollback(state.checkpoint);
        this.restoreToolLedgerCacheEntry(state);
      }
      this.trimToolLedgerCache();
      return;
    }

    const retained = new Set(states.map(([reducer]) => reducer));
    const changedInvocationIds = new Set(
      states.flatMap(([, state]) => [...state.changedInvocationIds]),
    );
    for (const [key, entry] of this.toolLedgerCache) {
      if (retained.has(entry.reducer)) continue;
      if ([...entry.invocationIds].some((id) => changedInvocationIds.has(id))) {
        this.deleteToolLedgerCacheEntry(key);
      }
    }
    for (const [reducer, state] of states) reducer.commit(state.checkpoint);
    this.toolLedgerCacheVersion = this.currentToolLedgerCacheVersion();
    this.trimToolLedgerCache();
  }

  private refreshToolLedgerCacheVersion(): void {
    if (this.uncommittedToolLedgerStates.size > 0) {
      throw new Error('Cannot invalidate tool ledger state during an open write transaction');
    }
    this.clearToolLedgerCache();
    this.toolLedgerCacheVersion = this.currentToolLedgerCacheVersion();
  }

  private retainToolLedgerCacheEntry(key: string, entry: ToolLedgerCacheEntry): void {
    entry.cacheKey = key;
    this.toolLedgerCache.set(key, entry);
    this.toolLedgerCacheEstimatedBytes += entry.estimatedBytes;
    this.toolLedgerCacheEventCount += entry.eventCount;
  }

  private touchToolLedgerCacheEntry(key: string, entry: ToolLedgerCacheEntry): void {
    this.toolLedgerCache.delete(key);
    this.toolLedgerCache.set(key, entry);
  }

  private adjustToolLedgerCacheEntry(
    entry: ToolLedgerCacheEntry,
    delta: Pick<ToolLedgerCacheEntry, 'estimatedBytes' | 'eventCount'>,
  ): void {
    entry.estimatedBytes += delta.estimatedBytes;
    entry.eventCount += delta.eventCount;
    if (entry.cacheKey && this.toolLedgerCache.get(entry.cacheKey) === entry) {
      this.toolLedgerCacheEstimatedBytes += delta.estimatedBytes;
      this.toolLedgerCacheEventCount += delta.eventCount;
    }
  }

  private restoreToolLedgerCacheEntry(state: UncommittedToolLedgerState): void {
    const entry = state.entry;
    if (entry.cacheKey && this.toolLedgerCache.get(entry.cacheKey) === entry) {
      this.toolLedgerCacheEstimatedBytes += state.estimatedBytesBefore - entry.estimatedBytes;
      this.toolLedgerCacheEventCount += state.eventCountBefore - entry.eventCount;
    }
    entry.estimatedBytes = state.estimatedBytesBefore;
    entry.eventCount = state.eventCountBefore;
  }

  private deleteToolLedgerCacheEntry(key: string, reason?: 'budget' | 'terminal'): void {
    const entry = this.toolLedgerCache.get(key);
    if (!entry) return;
    this.toolLedgerCache.delete(key);
    if (entry.cacheKey === key) entry.cacheKey = undefined;
    this.toolLedgerCacheEstimatedBytes -= entry.estimatedBytes;
    this.toolLedgerCacheEventCount -= entry.eventCount;
    if (reason === 'budget') this.toolLedgerCacheMetrics.budgetEvictions += 1;
    if (reason === 'terminal') this.toolLedgerCacheMetrics.terminalEvictions += 1;
  }

  private clearToolLedgerCache(): void {
    for (const entry of this.toolLedgerCache.values()) entry.cacheKey = undefined;
    this.toolLedgerCache.clear();
    this.toolLedgerCacheEstimatedBytes = 0;
    this.toolLedgerCacheEventCount = 0;
  }

  private invalidateToolLedgerCacheForInvocation(invocationId: string): void {
    for (const [key, entry] of this.toolLedgerCache) {
      if (entry.invocationIds.has(invocationId)) {
        this.deleteToolLedgerCacheEntry(key, 'terminal');
      }
    }
  }

  private toolLedgerEntryExceedsAdmissionBudget(entry: ToolLedgerCacheEntry): boolean {
    return entry.estimatedBytes > this.toolLedgerCacheBudget.maxSingleEntryEstimatedBytes;
  }

  private toolLedgerCacheExceedsBudget(): boolean {
    return (
      this.toolLedgerCache.size > this.toolLedgerCacheBudget.maxEntries ||
      this.toolLedgerCacheEstimatedBytes > this.toolLedgerCacheBudget.maxEstimatedBytes
    );
  }

  private trimToolLedgerCache(): void {
    for (;;) {
      let victim: string | undefined;
      for (const [key, entry] of this.toolLedgerCache) {
        if (this.uncommittedToolLedgerStates.has(entry.reducer)) continue;
        if (this.toolLedgerEntryExceedsAdmissionBudget(entry)) {
          victim = key;
          break;
        }
      }
      if (!victim && this.toolLedgerCacheExceedsBudget()) {
        victim = [...this.toolLedgerCache].find(
          ([, entry]) => !this.uncommittedToolLedgerStates.has(entry.reducer),
        )?.[0];
      }
      if (!victim) return;
      this.deleteToolLedgerCacheEntry(victim, 'budget');
    }
  }

  private currentToolLedgerCacheVersion(): string {
    return `${this.runtimeDataVersion()}:${
      this.databaseLease?.writeViewRevision() ?? this.localCommittedWriteRevision
    }`;
  }

  private runtimeDataVersion(): number {
    const row = this.db.prepare('PRAGMA data_version').get() as { data_version: number };
    return row.data_version;
  }

  private assertInvocationIdentity(events: readonly RuntimeEvent[]): void {
    const candidates = new Map<string, { sessionId: string; runId: string; turnId: string }>();
    const runs = new Map<
      string,
      { sessionId: string; invocationId: string; runId: string; turnId: string }
    >();
    for (const event of events) {
      const identity = {
        sessionId: event.sessionId,
        runId: event.runId,
        turnId: event.turnId,
      };
      const prior = candidates.get(event.invocationId);
      if (
        prior &&
        (prior.sessionId !== identity.sessionId ||
          prior.runId !== identity.runId ||
          prior.turnId !== identity.turnId)
      ) {
        throw new Error(`RuntimeEvent invocation identity conflict for ${event.invocationId}`);
      }
      candidates.set(event.invocationId, identity);
      const runKey = `${event.sessionId}\0${event.runId}`;
      const priorRun = runs.get(runKey);
      if (
        priorRun &&
        (priorRun.invocationId !== event.invocationId || priorRun.turnId !== event.turnId)
      ) {
        throw new Error(`RuntimeEvent run identity conflict for ${event.runId}`);
      }
      runs.set(runKey, {
        sessionId: event.sessionId,
        invocationId: event.invocationId,
        runId: event.runId,
        turnId: event.turnId,
      });
    }
    for (const [invocationId, identity] of candidates) {
      const rows = this.db
        .prepare(`
          SELECT DISTINCT session_id, run_id, turn_id
          FROM runtime_events
          WHERE invocation_id = ?
          UNION
          SELECT DISTINCT session_id, run_id, turn_id
          FROM runtime_partial_snapshots
          WHERE invocation_id = ?
        `)
        .all(invocationId, invocationId) as Array<{
        session_id: string;
        run_id: string;
        turn_id: string;
      }>;
      if (
        rows.some(
          (row) =>
            row.session_id !== identity.sessionId ||
            row.run_id !== identity.runId ||
            row.turn_id !== identity.turnId,
        )
      ) {
        throw new Error(`RuntimeEvent invocation identity conflict for ${invocationId}`);
      }
    }
    for (const identity of runs.values()) {
      const rows = this.db
        .prepare(`
          SELECT DISTINCT invocation_id, turn_id
          FROM runtime_events
          WHERE session_id = ? AND run_id = ?
          UNION
          SELECT DISTINCT invocation_id, turn_id
          FROM runtime_partial_snapshots
          WHERE session_id = ? AND run_id = ?
        `)
        .all(identity.sessionId, identity.runId, identity.sessionId, identity.runId) as Array<{
        invocation_id: string;
        turn_id: string;
      }>;
      if (
        rows.some(
          (row) => row.invocation_id !== identity.invocationId || row.turn_id !== identity.turnId,
        )
      ) {
        throw new Error(`RuntimeEvent run identity conflict for ${identity.runId}`);
      }
    }
  }

  private assertContinuationAuthorityAllowsEvent(
    event: RuntimeEvent,
    authorizedPendingClaimId?: string,
    exactRetry = false,
  ): void {
    const rows = this.readContinuationClaimRows();
    const ownClaim = rows.find(
      (row) =>
        row.target_session_id === event.sessionId &&
        row.target_invocation_id === event.invocationId &&
        row.target_run_id === event.runId &&
        row.target_turn_id === event.turnId,
    );
    const ownHandoff = ownClaim && decodeContinuationClaimRow(ownClaim);
    for (const row of rows) {
      const claim = decodeContinuationClaimRow(row);
      const source = claim.boundary.segments.find(
        (segment) =>
          segment.identity.sessionId === event.sessionId && segment.identity.runId === event.runId,
      );
      if (source && !exactRetry) {
        throw new Error(
          `RuntimeEvent source boundary is sealed by continuation claim ${claim.claimId}`,
        );
      }
      if (source && exactRetry) continue;

      const target = claim.target;
      const collidesWithTarget =
        event.invocationId === target.invocationId ||
        (event.sessionId === target.sessionId && event.runId === target.runId) ||
        (event.sessionId === target.sessionId &&
          event.turnId === target.turnId &&
          !(
            ownHandoff?.targetOpening.source.kind === 'handoff' &&
            ownHandoff.boundary.segments.some((segment) => segment.identity.runId === target.runId)
          ));
      if (!collidesWithTarget) continue;
      if (
        event.sessionId !== target.sessionId ||
        event.invocationId !== target.invocationId ||
        event.runId !== target.runId ||
        event.turnId !== target.turnId
      ) {
        throw new Error(`RuntimeEvent continuation target identity conflict for ${claim.claimId}`);
      }
      if (!row.start_event_id && authorizedPendingClaimId !== claim.claimId) {
        throw new Error(
          `RuntimeEvent target sequence one is reserved for continuation-start by claim ${claim.claimId}`,
        );
      }
    }
  }

  private assertRunNotSealed(event: RuntimeEvent): void {
    const rows = this.db
      .prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
        FROM runtime_events
        WHERE session_id = ? AND run_id = ?
          AND ${TERMINAL_RUNTIME_EVENT_SQL}
        ORDER BY event_seq ASC
      `)
      .all(event.sessionId, event.runId) as unknown as RuntimeEventStorageRow[];
    const terminal = rows.map(decodeRuntimeEventStorageRow).find(isTerminalRuntimeEvent);
    if (terminal) {
      throw new RunSealedError(event.runId);
    }
  }

  private importRuntimeEventSync(
    event: RuntimeEvent,
    allowLegacyTerminalWithUnsettledOperation = false,
  ): boolean {
    const canonicalEvent = canonicalizeRuntimeEventForStorage(event);
    this.assertInvocationIdentity([canonicalEvent]);
    const partial = partialRuntimeStream(canonicalEvent);
    if (partial) {
      this.assertContinuationAuthorityAllowsEvent(canonicalEvent);
      this.assertRunNotSealed(canonicalEvent);
      return this.upsertRuntimePartial(canonicalEvent, partial);
    }
    const existing = this.readRuntimeEventJson(canonicalEvent.id) !== undefined;
    // Seal before tool-ledger semantics, so every post-terminal append
    // refuses the same way (#2311): a late tool-bearing straggler must read
    // as the sealed-run boundary it is, not as a producer bug or ledger
    // corruption. Continuation authority stays ahead of the seal, its
    // refusals are more specific, and an exact-id retry keeps its dedup
    // semantics: the event is already inside the seal, so only new events
    // consult either.
    if (!existing) {
      this.assertContinuationAuthorityAllowsEvent(canonicalEvent);
      if (isTerminalRuntimeEvent(canonicalEvent) && !allowLegacyTerminalWithUnsettledOperation) {
        const unresolved = this.db
          .prepare(`
            SELECT operation_id FROM tool_operations
            WHERE invocation_id = ?
              AND current_state = 'prepared'
              AND result_event_id IS NULL
              AND dispatch_event_id IS NOT NULL
            LIMIT 1
          `)
          .get(canonicalEvent.invocationId) as { operation_id?: unknown } | undefined;
        if (unresolved && typeof unresolved.operation_id === 'string') {
          throw new Error(
            `Cannot terminalize invocation ${canonicalEvent.invocationId} with unsettled tool operation ${unresolved.operation_id}`,
          );
        }
      }
      this.assertRunNotSealed(canonicalEvent);
    }
    if (isToolLedgerBearingEvent(canonicalEvent)) {
      this.assertToolLedgerTransition([canonicalEvent], 'generic_append');
    }
    this.insertRuntimeEvent(canonicalEvent, canonicalEvent.ts, true);
    return !existing;
  }

  private importRuntimePartialBatchSync(events: readonly RuntimeEvent[]): void {
    const first = events[0];
    if (!first) return;
    const partials = events.map((event) => partialRuntimeStream(event));
    const firstPartial = partials[0];
    if (!firstPartial) {
      throw new Error('Runtime partial batch contains a non-partial event');
    }
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      const partial = partials[index];
      if (!partial) throw new Error('Runtime partial batch contains a non-partial event');
      if (
        partial.key !== firstPartial.key ||
        event.sessionId !== first.sessionId ||
        event.invocationId !== first.invocationId ||
        event.runId !== first.runId ||
        event.turnId !== first.turnId
      ) {
        throw new Error('Runtime partial batch must contain exactly one presentation stream');
      }
    }
    this.assertInvocationIdentity(events);
    this.assertContinuationAuthorityAllowsEvent(first);
    this.assertRunNotSealed(first);
    const last = events.at(-1)!;
    this.upsertRuntimePartial(first, {
      ...firstPartial,
      text: partials.map((partial) => partial!.text).join(''),
      updatedAt: last.ts,
    });
  }

  private assertImmutableSteeringMessageIdentity(event: RuntimeEvent): void {
    const messageId = immutableSteeringMessageId(event);
    if (!messageId) return;
    const matches = this.readImmutableSteeringMessageEvents(event.sessionId, messageId);
    if (matches.some((candidate) => !isDeepStrictEqual(candidate, event))) {
      throw new Error(`Immutable steering message identity conflict: ${messageId}`);
    }
  }

  private readImmutableSteeringMessageEvents(sessionId: string, messageId: string): RuntimeEvent[] {
    const rows = this.db
      .prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
          FROM runtime_events
         WHERE session_id = ?
           AND ${IMMUTABLE_STEERING_SQL_PREDICATE}
           AND CASE
             WHEN json_valid(payload_json)
             THEN json_extract(payload_json, '$.refs.providerEventId')
           END = ?
         ORDER BY committed_at ASC, event_id ASC
      `)
      .all(sessionId, messageId) as unknown as RuntimeEventStorageRow[];
    return rows
      .map(decodeRuntimeEventStorageRow)
      .filter((event) => immutableSteeringMessageId(event) === messageId);
  }

  private insertRuntimeEvent(
    event: RuntimeEvent,
    committedAt: number,
    allowExactDuplicate: boolean,
    authorizedPendingContinuationClaimId?: string,
  ): number {
    const encoding = encodeCanonicalRuntimeEvent(event);
    const canonicalEvent = encoding.event;
    this.assertInvocationIdentity([canonicalEvent]);
    assertRuntimeEventIdentity(canonicalEvent);
    this.assertImmutableSteeringMessageIdentity(canonicalEvent);
    const existingJson = this.readRuntimeEventJson(canonicalEvent.id);
    if (existingJson !== undefined) {
      assertStoredRuntimeEventEquals(canonicalEvent, existingJson);
      this.assertContinuationAuthorityAllowsEvent(
        canonicalEvent,
        authorizedPendingContinuationClaimId,
        true,
      );
      this.deleteCompletedPartialSnapshot(canonicalEvent);
      if (!allowExactDuplicate) {
        throw new Error(
          `RuntimeEvent ${canonicalEvent.id} already exists outside this tool transaction`,
        );
      }
      if (isTerminalRuntimeEvent(canonicalEvent)) {
        this.invalidateToolLedgerCacheForInvocation(canonicalEvent.invocationId);
      }
      return this.runtimeEventSeq(canonicalEvent.id);
    }
    this.assertContinuationAuthorityAllowsEvent(
      canonicalEvent,
      authorizedPendingContinuationClaimId,
    );
    this.assertRunNotSealed(canonicalEvent);
    const next = this.nextRuntimeEventSeq(canonicalEvent.invocationId);
    this.db
      .prepare(`
      INSERT INTO runtime_events (
        event_id, session_id, invocation_id, run_id, turn_id, event_seq,
        event_kind, payload_json, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        canonicalEvent.id,
        canonicalEvent.sessionId,
        canonicalEvent.invocationId,
        canonicalEvent.runId,
        canonicalEvent.turnId,
        next,
        runtimeEventKind(canonicalEvent),
        encoding.json,
        committedAt,
      );
    const ordinalRow = this.db
      .prepare(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
        FROM runtime_session_event_ordinals
        WHERE session_id = ?
      `)
      .get(canonicalEvent.sessionId) as { next_ordinal?: unknown };
    const ordinal = ordinalRow.next_ordinal;
    if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 1) {
      throw new Error(`Invalid next RuntimeEvent Session ordinal for ${canonicalEvent.sessionId}`);
    }
    this.db
      .prepare(`
        INSERT INTO runtime_session_event_ordinals(session_id, ordinal, event_id)
        VALUES (?, ?, ?)
      `)
      .run(canonicalEvent.sessionId, ordinal, canonicalEvent.id);
    recordTranscriptTurnExtent(
      this.db,
      { ...canonicalEvent, kind: runtimeEventKind(canonicalEvent) },
      ordinal,
    );
    this.noteEventCommit(canonicalEvent.sessionId);
    this.deleteCompletedPartialSnapshot(canonicalEvent);
    if (isTerminalRuntimeEvent(canonicalEvent)) {
      this.invalidateToolLedgerCacheForInvocation(canonicalEvent.invocationId);
    }
    return next;
  }

  private deleteCompletedPartialSnapshot(event: RuntimeEvent): void {
    const completedPartialKey = completedPartialRuntimeStreamKey(event);
    if (!completedPartialKey) return;
    this.db
      .prepare('DELETE FROM runtime_partial_snapshots WHERE stream_key = ?')
      .run(completedPartialKey);
  }

  private upsertRuntimePartial(
    event: RuntimeEvent,
    partial: { key: string; snapshot: RuntimeEvent; text: string; updatedAt?: number },
  ): boolean {
    const existing = this.db
      .prepare(`
      SELECT 1 AS found FROM runtime_partial_snapshots WHERE stream_key = ?
    `)
      .get(partial.key) as { found: number } | undefined;
    if (!existing && this.hasCompletedPartialStream(event.sessionId, event.runId, partial.key)) {
      return false;
    }
    const anchor = existing
      ? undefined
      : (this.db
          .prepare(`
      SELECT event_id FROM runtime_events
      WHERE session_id = ? AND run_id = ?
      ORDER BY event_seq DESC LIMIT 1
    `)
          .get(event.sessionId, event.runId) as { event_id: string } | undefined);
    if (!existing) {
      this.db
        .prepare(`
      INSERT INTO runtime_partial_snapshots (
        stream_key, session_id, invocation_id, run_id, turn_id,
        after_event_id, payload_json, text_content, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
        .run(
          partial.key,
          event.sessionId,
          event.invocationId,
          event.runId,
          event.turnId,
          anchor?.event_id ?? null,
          JSON.stringify(partial.snapshot),
          '',
          partial.updatedAt ?? event.ts,
        );
    } else {
      this.db
        .prepare('UPDATE runtime_partial_snapshots SET updated_at = ? WHERE stream_key = ?')
        .run(partial.updatedAt ?? event.ts, partial.key);
    }
    if (partial.text.length > 0) {
      this.appendRuntimePartialSegment(partial.key, partial.text, partial.updatedAt ?? event.ts);
    }
    return !existing;
  }

  private appendRuntimePartialSegment(streamKey: string, text: string, updatedAt: number): void {
    const tail = this.db
      .prepare(`
        SELECT segment_seq, length(CAST(text_content AS BLOB)) AS stored_bytes
        FROM runtime_partial_segments
        WHERE stream_key = ?
        ORDER BY segment_seq DESC
        LIMIT 1
      `)
      .get(streamKey) as { segment_seq?: unknown; stored_bytes?: unknown } | undefined;
    if (tail) {
      const segmentSequence = requireRuntimeEventScanCount(tail.segment_seq);
      const storedBytes = requireRuntimeEventScanCount(tail.stored_bytes);
      if (storedBytes + Buffer.byteLength(text, 'utf8') <= RUNTIME_PARTIAL_SEGMENT_TARGET_BYTES) {
        this.db
          .prepare(`
            UPDATE runtime_partial_segments
            SET text_content = text_content || ?, updated_at = ?
            WHERE stream_key = ? AND segment_seq = ?
          `)
          .run(text, updatedAt, streamKey, segmentSequence);
        return;
      }
    }
    this.db
      .prepare(`
        INSERT INTO runtime_partial_segments(stream_key, segment_seq, text_content, updated_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        streamKey,
        tail ? requireRuntimeEventScanCount(tail.segment_seq) + 1 : 1,
        text,
        updatedAt,
      );
  }

  private hasCompletedPartialStream(sessionId: string, runId: string, streamKey: string): boolean {
    const rows = this.db
      .prepare(`
      SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
      FROM runtime_events
      WHERE session_id = ? AND run_id = ?
    `)
      .all(sessionId, runId) as unknown as RuntimeEventStorageRow[];
    return rows.some(
      (row) => completedPartialRuntimeStreamKey(decodeRuntimeEventStorageRow(row)) === streamKey,
    );
  }

  private nextRuntimeEventSeq(invocationId: string): number {
    const row = this.db
      .prepare(`
      SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq
      FROM runtime_events
      WHERE invocation_id = ?
    `)
      .get(invocationId) as { next_seq: number };
    return row.next_seq;
  }

  private runtimeEventSeq(eventId: string): number {
    const row = this.db
      .prepare(`
      SELECT event_seq FROM runtime_events WHERE event_id = ?
    `)
      .get(eventId) as { event_seq: number } | undefined;
    if (!row) throw new Error(`Missing RuntimeEvent ${eventId}`);
    return row.event_seq;
  }

  private readRuntimeEventJson(eventId: string): string | undefined {
    const row = this.db
      .prepare(`
      SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
      FROM runtime_events
      WHERE event_id = ?
    `)
      .get(eventId) as RuntimeEventStorageRow | undefined;
    if (row) decodeRuntimeEventStorageRow(row);
    return row?.payload_json;
  }

  private readRequiredRuntimeEvent(eventId: string): RuntimeEvent {
    const stored = this.readRuntimeEventJson(eventId);
    if (stored === undefined) throw new Error(`Missing RuntimeEvent ${eventId}`);
    return decodeStoredRuntimeEvent(stored);
  }

  private readToolOperationSync(operationId: string): ToolOperationRecord | undefined {
    const row = this.db
      .prepare(`
      SELECT operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
        tool_name, canonical_args_hash, recovery_mode, current_state,
        call_event_id, dispatch_event_id, result_event_id, version
      FROM tool_operations
      WHERE operation_id = ?
    `)
      .get(operationId) as ToolOperationRow | undefined;
    return row ? toolOperationFromRow(row) : undefined;
  }
}

interface ToolLedgerCacheEntry {
  reducer: ToolLedgerReducer;
  seedInvocationIds: ReadonlySet<string>;
  invocationIds: ReadonlySet<string>;
  estimatedBytes: number;
  eventCount: number;
  cacheKey?: string;
}

interface UncommittedToolLedgerState {
  checkpoint: number;
  changedInvocationIds: Set<string>;
  entry: ToolLedgerCacheEntry;
  estimatedBytesBefore: number;
  eventCountBefore: number;
}

interface ToolLedgerCacheBudget {
  maxEntries: number;
  maxEstimatedBytes: number;
  maxSingleEntryEstimatedBytes: number;
}

interface ToolLedgerCacheMetrics {
  hits: number;
  misses: number;
  budgetEvictions: number;
  terminalEvictions: number;
  transientEntries: number;
}

interface ToolOperationRow {
  operation_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  provider_tool_call_id: string;
  tool_name: string;
  canonical_args_hash: string;
  recovery_mode: ToolRecoveryMode;
  current_state:
    | 'prepared'
    | 'outcome_committed'
    | 'recovery_completed'
    | 'recovery_parked'
    | 'abandoned'
    | 'interrupted_unknown';
  call_event_id: string;
  dispatch_event_id: string | null;
  result_event_id: string | null;
  version: number;
}

interface UnsettledToolOperationRow extends ToolOperationRow {
  session_id: string;
}

interface ToolJournalRow {
  journal_event_id: string;
  operation_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  state: ToolJournalState;
  runtime_event_id: string | null;
  canonical_args_hash: string | null;
  recovery_mode: ToolRecoveryMode | null;
  external_handle: string | null;
  metadata_json: string | null;
  committed_at: number;
}

function toolOperationFromRow(row: ToolOperationRow): ToolOperationRecord {
  return {
    operationId: row.operation_id,
    invocationId: row.invocation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    providerToolCallId: row.provider_tool_call_id,
    toolName: row.tool_name,
    canonicalArgsHash: row.canonical_args_hash,
    recoveryMode: row.recovery_mode,
    currentState: row.current_state,
    callEventId: row.call_event_id,
    ...(row.dispatch_event_id ? { dispatchEventId: row.dispatch_event_id } : {}),
    ...(row.result_event_id ? { resultEventId: row.result_event_id } : {}),
    version: row.version,
  };
}

function toolJournalRecordFromRow(row: ToolJournalRow): ToolJournalEventRecord {
  return {
    journalEventId: row.journal_event_id,
    operationId: row.operation_id,
    invocationId: row.invocation_id,
    runId: row.run_id,
    turnId: row.turn_id,
    state: row.state,
    ...(row.runtime_event_id ? { runtimeEventId: row.runtime_event_id } : {}),
    ...(row.canonical_args_hash ? { canonicalArgsHash: row.canonical_args_hash } : {}),
    ...(row.recovery_mode ? { recoveryMode: row.recovery_mode } : {}),
    ...(row.external_handle ? { externalHandle: row.external_handle } : {}),
    ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) } : {}),
    committedAt: row.committed_at,
  };
}

function assertRuntimeEventIdentity(event: RuntimeEvent): void {
  decodeRuntimeEvent(event);
  for (const [field, value] of Object.entries({
    id: event.id,
    sessionId: event.sessionId,
    invocationId: event.invocationId,
    runId: event.runId,
    turnId: event.turnId,
  })) {
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`Invalid RuntimeEvent ${field}`);
  }
}

function assertStoredRuntimeEventEquals(event: RuntimeEvent, storedJson: string | undefined): void {
  if (storedJson === undefined) return;
  const stored = decodeStoredRuntimeEvent(storedJson);
  if (!isDeepStrictEqual(stored, canonicalizeRuntimeEventForStorage(event))) {
    throw new Error(`RuntimeEvent identity conflict for ${event.id}`);
  }
}

function canonicalizeRuntimeEventForStorage(event: RuntimeEvent): RuntimeEvent {
  return encodeCanonicalRuntimeEvent(event).event;
}

function assertNoReservedRecoveryFact(event: RuntimeEvent): void {
  if (event.actions?.toolRecovery !== undefined) {
    throw new Error('Tool recovery facts require the atomic recovery bundle writer');
  }
}

function assertNoReservedToolLedgerFact(event: RuntimeEvent): void {
  assertNoReservedWorkspaceAuthorityAppend(event);
  if (event.actions?.continuationStart !== undefined) {
    throw new Error('Continuation start facts require the continuation authority writer');
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

function isToolLedgerBearingEvent(event: RuntimeEvent): boolean {
  return (
    event.content?.kind === 'function_call' ||
    event.content?.kind === 'function_response' ||
    event.actions?.toolDispatch !== undefined ||
    event.actions?.toolRecovery !== undefined
  );
}

function recoveryOperationIdentity(operation: ToolOperationRecord) {
  if (!operation.dispatchEventId) {
    throw new Error('Recovery bundle requires a durable dispatch RuntimeEvent');
  }
  return {
    operationId: operation.operationId,
    invocationId: operation.invocationId,
    runId: operation.runId,
    turnId: operation.turnId,
    providerToolCallId: operation.providerToolCallId,
    toolName: operation.toolName,
    canonicalArgsHash: operation.canonicalArgsHash,
    recoveryMode: operation.recoveryMode,
    callEventId: operation.callEventId,
    dispatchEventId: operation.dispatchEventId,
  };
}

function assertStrictRuntimeEventOrder(eventSequences: readonly number[]): void {
  if (
    eventSequences.some(
      (eventSequence, index) => index > 0 && eventSequence <= (eventSequences[index - 1] ?? -1),
    )
  ) {
    throw new Error('Recovery facts violate canonical RuntimeEvent causal order');
  }
}

function requireRuntimeEventOrder(
  eventOrder: ReadonlyMap<string, number>,
  eventId: string,
): number {
  const order = eventOrder.get(eventId);
  if (order === undefined) throw new Error(`Missing RuntimeEvent order for ${eventId}`);
  return order;
}

function journalEventIdFor(
  operationId: string,
  eventId: string,
  state: Exclude<ToolJournalState, 'prepared'>,
): string {
  if (state === 'outcome_committed') return `${operationId}_outcome`;
  if (state === 'abandoned' || state === 'interrupted_unknown') {
    // One invocation terminal can close multiple tool operations. Its journal
    // fact is therefore unique per operation, unlike per-operation recovery
    // events whose RuntimeEvent ids are already distinct.
    return `${operationId}_${eventId}_journal`;
  }
  return `${eventId}_journal`;
}

function assertRecoveryAuthorityCapability(db: DatabaseSync): void {
  const row = db
    .prepare('SELECT version FROM runtime_capabilities WHERE capability = ?')
    .get(RUNTIME_RECOVERY_AUTHORITY_CAPABILITY) as { version?: unknown } | undefined;
  if (row?.version !== RUNTIME_RECOVERY_AUTHORITY_CAPABILITY_VERSION) {
    throw new Error(
      `SQLite runtime recovery capability ${RUNTIME_RECOVERY_AUTHORITY_CAPABILITY}@${RUNTIME_RECOVERY_AUTHORITY_CAPABILITY_VERSION} is unavailable`,
    );
  }
}

function assertContinuationStartEvent(
  claim: ContinuationClaimV1,
  event: RuntimeEvent,
  startKind: 'runtime_admission' | 'claim_repair',
): void {
  if (!continuationStartEventMatchesClaim(event, claim, startKind)) {
    throw new Error('Invalid continuation-start authority event');
  }
}

function assertContinuationAuthorityCapability(db: DatabaseSync): void {
  const row = db
    .prepare('SELECT version FROM runtime_capabilities WHERE capability = ?')
    .get(RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY) as { version?: unknown } | undefined;
  if (row?.version !== RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY_VERSION) {
    throw new Error(
      `SQLite runtime continuation capability ${RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY}@${RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY_VERSION} is unavailable`,
    );
  }
}

function assertRuntimeStorageSafeId(value: string, message: string): void {
  if (!isRuntimeStorageSafeId(value)) throw new Error(message);
}

function distinctSafeRuntimeIds(values: readonly string[], message: string): string[] {
  const result = new Set<string>();
  for (const value of values) {
    assertRuntimeStorageSafeId(value, message);
    result.add(value);
  }
  return [...result];
}

function* batches<T>(values: readonly T[], size: number): Iterable<readonly T[]> {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size);
  }
}

function assertInvocationSearchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new RangeError('Runtime invocation search limit must be an integer between 1 and 256');
  }
}

interface RuntimeEventStorageRow {
  event_id: string;
  session_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  payload_json: string;
}

interface RuntimeInvocationRecoveryInventoryRow {
  opening_rowid: number | null;
  session_id: string;
  invocation_id: string;
  run_id: string | null;
  turn_id: string | null;
  opened_at: number | null;
  from_events: number;
  terminal_rowid: number | null;
}

interface RuntimeInvocationRecoveryOpeningRow {
  event_id: string;
  session_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  committed_at: number;
  payload_json?: string;
}

interface RuntimeHandoffTerminalStorageRow extends RuntimeEventStorageRow {
  terminal_rowid: number;
}

interface ManagedMutationReservationProjectionRow {
  workspace_instance_id: string;
  repository_id: string;
  workspace_id: string;
  workspace_epoch_id: string;
  operation_id: string;
  dispatch_event_id: string;
  base_workspace_version_id: string;
  base_accepted_event_id: string;
  base_head_revision: number;
  base_commit_oid: string;
  base_tree_oid: string;
  expected_paths_json: string;
  execution_profile_digest: string;
  protocol_version: number;
  reserved_at: number;
}

type CanonicalWorkspaceAuthority = ReturnType<typeof scanWorkspaceBaselineAuthority> & {
  activeManagedMutations: ManagedMutationReservationProjectionRow[];
};

function assertWorkspaceVersionAuthorityCapability(db: DatabaseSync): void {
  const row = db
    .prepare('SELECT version FROM runtime_capabilities WHERE capability = ?')
    .get(RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY) as { version?: unknown } | undefined;
  if (row?.version !== RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY_VERSION) {
    throw new Error(
      `SQLite runtime workspace capability ${RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY}@${RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY_VERSION} is unavailable`,
    );
  }
}

interface WorkspaceEpochProjectionRow {
  workspace_id: string;
  workspace_epoch_id: string;
  repository_id: string;
  workspace_instance_id: string;
  mode: string;
  object_format: string;
  source_commit_oid: string;
  source_tree_oid: string;
  initial_workspace_version_id: string;
  materialization_profile_digest: string;
  materialization_semantics: string;
  policy_hash: string;
  authority_session_id: string;
  authority_invocation_id: string;
  authority_run_id: string;
  authority_turn_id: string;
  epoch_opened_event_id: string;
  protocol_version: number;
  committed_at: number;
}

interface WorkspaceVersionProjectionRow {
  workspace_version_id: string;
  repository_id: string;
  workspace_id: string;
  workspace_epoch_id: string;
  object_format: string;
  origin_kind: string;
  origin_event_id: string;
  parents_json: string;
  operation_id: string | null;
  dispatch_event_id: string | null;
  outcome_event_id: string | null;
  base_head_revision: number | null;
  execution_profile_digest: string | null;
  commit_oid: string;
  tree_oid: string;
  policy_hash: string;
  tree_delta_digest: string;
  changed_paths_json: string;
  changed_file_count: number;
  deleted_file_count: number;
  accepted_event_id: string;
  protocol_version: number;
  committed_at: number;
}

interface WorkspaceHeadProjectionRow {
  workspace_id: string;
  workspace_epoch_id: string;
  repository_id: string;
  workspace_version_id: string;
  accepted_event_id: string;
  commit_oid: string;
  tree_oid: string;
  revision: number;
}

function workspaceEpochRecord(
  authority: ScannedWorkspaceBaselineAuthority,
): WorkspaceEpochRecordV1 {
  return {
    ...authority.epoch,
    epochOpenedEventId: authority.epochOpenedEventId,
    authority: authority.authority,
    committedAt: authority.epochOpenedAt,
  };
}

function workspaceBaselineVersionRecord(authority: ScannedWorkspaceBaselineAuthority) {
  return {
    ...authority.baseline,
    acceptedEventId: authority.baselineAcceptedEventId,
    committedAt: authority.baselineAcceptedAt,
  };
}

function workspaceSuccessorVersionRecord(authority: ScannedWorkspaceSuccessorAuthority) {
  return {
    ...authority.successor,
    acceptedEventId: authority.acceptedEventId,
    committedAt: authority.acceptedAt,
  };
}

function workspaceHeadBeforeSuccessor(
  authority: ReturnType<typeof scanWorkspaceBaselineAuthority>,
  successor: WorkspaceVersionAcceptedV1,
): WorkspaceHeadRecordV1 | undefined {
  const parentId = successor.parents[0];
  const baseline = authority.baselines.find(
    (candidate) => candidate.baseline.workspaceVersionId === parentId,
  );
  if (baseline) {
    return {
      repositoryId: baseline.baseline.repositoryId,
      workspaceId: baseline.baseline.workspaceId,
      workspaceEpochId: baseline.baseline.workspaceEpochId,
      workspaceVersionId: baseline.baseline.workspaceVersionId,
      acceptedEventId: baseline.baselineAcceptedEventId,
      commitOid: baseline.baseline.commitOid,
      treeOid: baseline.baseline.treeOid,
      revision: successor.baseHeadRevision,
    };
  }
  const prior = authority.successors.find(
    (candidate) => candidate.successor.workspaceVersionId === parentId,
  );
  if (!prior) return undefined;
  return {
    repositoryId: prior.successor.repositoryId,
    workspaceId: prior.successor.workspaceId,
    workspaceEpochId: prior.successor.workspaceEpochId,
    workspaceVersionId: prior.successor.workspaceVersionId,
    acceptedEventId: prior.acceptedEventId,
    commitOid: prior.successor.commitOid,
    treeOid: prior.successor.treeOid,
    revision: successor.baseHeadRevision,
  };
}

function managedMutationMatchesAcceptedSuccessor(
  mutation: RuntimeEventManagedWorkspaceMutationV2 | undefined,
  successor: WorkspaceVersionAcceptedV1,
  baseHead: WorkspaceHeadRecordV1,
  workspaceInstanceId: string,
): boolean {
  return (
    mutation?.protocol === 'managed_mutation_v2' &&
    mutation.repositoryId === successor.repositoryId &&
    mutation.workspaceId === successor.workspaceId &&
    mutation.workspaceEpochId === successor.workspaceEpochId &&
    mutation.workspaceInstanceId === workspaceInstanceId &&
    mutation.objectFormat === successor.objectFormat &&
    mutation.baseWorkspaceVersionId === successor.parents[0] &&
    mutation.baseAcceptedEventId === successor.baseAcceptedEventId &&
    mutation.baseHeadRevision === successor.baseHeadRevision &&
    mutation.baseCommitOid === baseHead.commitOid &&
    mutation.baseTreeOid === baseHead.treeOid &&
    mutation.executionProfileDigest === successor.executionProfileDigest &&
    isDeepStrictEqual([mutation.expectedPath], successor.changedPaths)
  );
}

function workspaceEpochProjectionRow(
  authority: ScannedWorkspaceBaselineAuthority,
): WorkspaceEpochProjectionRow {
  const record = workspaceEpochRecord(authority);
  return {
    workspace_id: record.workspaceId,
    workspace_epoch_id: record.workspaceEpochId,
    repository_id: record.repositoryId,
    workspace_instance_id: record.workspaceInstanceId,
    mode: record.mode,
    object_format: record.objectFormat,
    source_commit_oid: record.sourceCommitOid,
    source_tree_oid: record.sourceTreeOid,
    initial_workspace_version_id: record.initialWorkspaceVersionId,
    materialization_profile_digest: record.materializationProfileDigest,
    materialization_semantics: record.materializationSemantics,
    policy_hash: record.policyHash,
    authority_session_id: record.authority.sessionId,
    authority_invocation_id: record.authority.invocationId,
    authority_run_id: record.authority.runId,
    authority_turn_id: record.authority.turnId,
    epoch_opened_event_id: record.epochOpenedEventId,
    protocol_version: 1,
    committed_at: record.committedAt,
  };
}

function workspaceBaselineVersionProjectionRow(
  authority: ScannedWorkspaceBaselineAuthority,
): WorkspaceVersionProjectionRow {
  const record = workspaceBaselineVersionRecord(authority);
  return {
    workspace_version_id: record.workspaceVersionId,
    repository_id: record.repositoryId,
    workspace_id: record.workspaceId,
    workspace_epoch_id: record.workspaceEpochId,
    object_format: record.objectFormat,
    origin_kind: record.origin.kind,
    origin_event_id: record.origin.epochOpenedEventId,
    parents_json: '[]',
    operation_id: null,
    dispatch_event_id: null,
    outcome_event_id: null,
    base_head_revision: null,
    execution_profile_digest: null,
    commit_oid: record.commitOid,
    tree_oid: record.treeOid,
    policy_hash: record.policyHash,
    tree_delta_digest: record.treeDeltaDigest,
    changed_paths_json: '[]',
    changed_file_count: record.changedFileCount,
    deleted_file_count: record.deletedFileCount,
    accepted_event_id: record.acceptedEventId,
    protocol_version: 1,
    committed_at: record.committedAt,
  };
}

function workspaceSuccessorVersionProjectionRow(
  authority: ScannedWorkspaceSuccessorAuthority,
): WorkspaceVersionProjectionRow {
  const record = workspaceSuccessorVersionRecord(authority);
  return {
    workspace_version_id: record.workspaceVersionId,
    repository_id: record.repositoryId,
    workspace_id: record.workspaceId,
    workspace_epoch_id: record.workspaceEpochId,
    object_format: record.objectFormat,
    origin_kind: record.origin.kind,
    origin_event_id: record.origin.outcomeEventId,
    parents_json: JSON.stringify(record.parents),
    operation_id: record.origin.operationId,
    dispatch_event_id: record.origin.dispatchEventId,
    outcome_event_id: record.origin.outcomeEventId,
    base_head_revision: record.baseHeadRevision,
    execution_profile_digest: record.executionProfileDigest,
    commit_oid: record.commitOid,
    tree_oid: record.treeOid,
    policy_hash: record.policyHash,
    tree_delta_digest: record.treeDeltaDigest,
    changed_paths_json: JSON.stringify(record.changedPaths),
    changed_file_count: record.changedFileCount,
    deleted_file_count: record.deletedFileCount,
    accepted_event_id: record.acceptedEventId,
    protocol_version: 1,
    committed_at: record.committedAt,
  };
}

function workspaceHeadProjectionRow(record: WorkspaceHeadRecordV1): WorkspaceHeadProjectionRow {
  return {
    workspace_id: record.workspaceId,
    workspace_epoch_id: record.workspaceEpochId,
    repository_id: record.repositoryId,
    workspace_version_id: record.workspaceVersionId,
    accepted_event_id: record.acceptedEventId,
    commit_oid: record.commitOid,
    tree_oid: record.treeOid,
    revision: record.revision,
  };
}

function compareWorkspaceEpochRow(
  left: WorkspaceEpochProjectionRow,
  right: WorkspaceEpochProjectionRow,
): number {
  return (
    left.workspace_id.localeCompare(right.workspace_id) ||
    left.workspace_epoch_id.localeCompare(right.workspace_epoch_id)
  );
}

function compareWorkspaceVersionRow(
  left: WorkspaceVersionProjectionRow,
  right: WorkspaceVersionProjectionRow,
): number {
  return left.workspace_version_id.localeCompare(right.workspace_version_id);
}

function compareWorkspaceHeadRow(
  left: WorkspaceHeadProjectionRow,
  right: WorkspaceHeadProjectionRow,
): number {
  return (
    left.workspace_id.localeCompare(right.workspace_id) ||
    left.workspace_epoch_id.localeCompare(right.workspace_epoch_id)
  );
}

interface RuntimeEventPrefixStorageRow extends RuntimeEventStorageRow {
  event_seq: number;
}

interface ToolLedgerRuntimeEventStorageRow extends RuntimeEventPrefixStorageRow {
  stored_bytes: number;
}

type RuntimeEventPrefixProofStorageRow = Omit<RuntimeEventPrefixStorageRow, 'payload_json'> & {
  stored_bytes: number;
  payload_json: string | null;
};

interface ContinuationClaimStorageRow {
  claim_id: string;
  source_session_id: string;
  source_invocation_id: string;
  source_run_id: string;
  source_turn_id: string;
  source_event_high_water: number;
  source_prefix_digest: string;
  boundary_digest: string;
  boundary_json: string;
  provider_projection_version: number;
  provider_replay_digest: string;
  target_session_id: string;
  target_invocation_id: string;
  target_run_id: string;
  target_turn_id: string;
  target_opening_json: string;
  claimed_at: number;
  start_event_id: string | null;
  start_kind: 'runtime_admission' | 'claim_repair' | null;
  protocol_version: number;
}

interface RuntimePartialStorageRow {
  stream_key: string;
  session_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  payload_json: string;
  text_content: string;
  after_event_id: string | null;
}

function decodeRuntimeEventStorageRow(row: RuntimeEventStorageRow): RuntimeEvent {
  const event = decodeStoredRuntimeEvent(row.payload_json);
  if (
    event.id !== row.event_id ||
    event.sessionId !== row.session_id ||
    event.invocationId !== row.invocation_id ||
    event.runId !== row.run_id ||
    event.turnId !== row.turn_id
  ) {
    throw new Error(`RuntimeEvent row/payload identity mismatch for ${row.event_id}`);
  }
  return event;
}

function decodeRuntimePartialStorageRow(row: RuntimePartialStorageRow): RuntimeEvent {
  const event = decodeStoredRuntimeEvent(row.payload_json);
  if (
    event.sessionId !== row.session_id ||
    event.invocationId !== row.invocation_id ||
    event.runId !== row.run_id ||
    event.turnId !== row.turn_id ||
    partialRuntimeStream(event)?.key !== row.stream_key
  ) {
    throw new Error(`Runtime partial row/payload identity mismatch for ${row.stream_key}`);
  }
  return event;
}

function decodeStoredRuntimeEvent(storedJson: string): RuntimeEvent {
  return decodeRuntimeEvent(JSON.parse(storedJson));
}

function decodeContinuationClaimRow(row: ContinuationClaimStorageRow): ContinuationClaimV1 {
  if (row.protocol_version !== 1) {
    throw new Error(`Unsupported continuation claim protocol ${row.protocol_version}`);
  }
  const boundary = JSON.parse(row.boundary_json) as unknown;
  const targetOpening = JSON.parse(row.target_opening_json) as unknown;
  const claim = decodeContinuationClaim({
    protocol: 'continuation_claim_v1',
    claimId: row.claim_id,
    boundaryDigest: row.boundary_digest,
    boundary,
    providerProjectionVersion: row.provider_projection_version,
    providerReplayDigest: row.provider_replay_digest,
    target: {
      sessionId: row.target_session_id,
      invocationId: row.target_invocation_id,
      runId: row.target_run_id,
      turnId: row.target_turn_id,
    },
    targetOpening,
    claimedAt: row.claimed_at,
  });
  const source = claim.boundary.segments.at(-1)!;
  if (
    row.source_session_id !== source.identity.sessionId ||
    row.source_invocation_id !== source.identity.invocationId ||
    row.source_run_id !== source.identity.runId ||
    row.source_turn_id !== source.identity.turnId ||
    row.source_event_high_water !== source.position.lastEventSeq ||
    row.source_prefix_digest !== source.prefixDigest
  ) {
    throw new Error(`Continuation claim row/payload identity mismatch for ${row.claim_id}`);
  }
  return claim;
}
