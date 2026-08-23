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

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  buildWorkspaceBaselineAuthorityEvents,
  scanWorkspaceBaselineAuthority,
  WORKSPACE_AUTHORITY_SESSION_ID,
  WORKSPACE_VERSION_AUTHORITY_CAPABILITY_V1,
  type ScannedWorkspaceBaselineAuthority,
  type WorkspaceAuthorityLedgerRow,
  type WorkspaceBaselineAuthorityInput,
  type WorkspaceBaselineCommitResult,
  type WorkspaceEpochRecordV1,
  type WorkspaceHeadRecordV1,
  type WorkspaceProjectionRebuildResult,
  type WorkspaceVersionRecordV1,
} from '@maka/core/workspace-version-authority';
import {
  decodeRuntimeEvent,
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type ToolRecoveryMode,
} from '@maka/core/runtime-event';
import {
  RunSealedError,
  RUNTIME_CONTINUATION_AUTHORITY_V1,
  TOOL_RECOVERY_BUNDLE_CAPABILITY_V1,
  type ContinuationClaimResult,
  type ContinuationClaimStateV1,
  type RuntimeContinuationAuthorityStore,
  type RuntimeRecoveryBundleCommit,
  type RuntimeRecoveryBundleStore,
  type RuntimeWorkspaceVersionAuthorityStore,
} from '@maka/core/runtime-event-store';
import { type ToolRecoveryDecisionFact } from '@maka/core/tool-recovery-fact';
import { canonicalToolArgsHash, stableJsonStringify } from '@maka/core/tool-args-identity';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import {
  scanToolLedger,
  ToolLedgerCorruptionError,
  ToolLedgerRejectionError,
  validateGenericToolLedgerAppend,
  validateToolLedgerEventLane,
  validateToolLedgerTransition,
} from '@maka/core/tool-ledger-scanner';
import {
  buildImmutableRuntimePrefix,
  decodeContinuationClaim,
  type ContinuationClaimV1,
  type ImmutableRuntimePrefixV1,
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
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from './sqlite-runtime-schema.js';
import { registerWorkspaceBaselineAuthorityWriterInternal } from './workspace-version-authority-internal.js';
import type {
  ConversationCopyRuntimeEventBatch,
  ImmutableSteeringMessageProof,
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
import { immutableSteeringMessageId, isRuntimeStorageSafeId } from './runtime-event-invariants.js';
import { assertNoReservedWorkspaceAuthorityAppend } from './runtime-event-authority.js';

export { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';

export type { ToolRecoveryMode } from '@maka/core/runtime-event';

const RUNTIME_EVENT_SCAN_BATCH_SIZE = 128;
const RUNTIME_PARTIAL_SEGMENT_TARGET_BYTES = 64 * 1024;

function assertRuntimeEventScanBudget(budget: RuntimeEventScanBudget): void {
  for (const [name, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid RuntimeEvent scan ${name}`);
    }
  }
}

function requireRuntimeEventScanCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Invalid RuntimeEvent scan measurement');
  }
  return value as number;
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
  | 'recovery_parked';

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
  | 'after_workspace_canonical_scan';

export interface SqliteRuntimeStoreOptions {
  failpoint?: (point: SqliteRuntimeStoreFailpoint) => void;
  readOnly?: boolean;
  /** @internal Repository connection supplied by the operational DB owner. */
  databaseLease?: OperationalStateDatabaseLease;
}

export interface CommitToolPreparedInput {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  dispatchRuntimeEvent: RuntimeEvent;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  committedAt: number;
}

export interface CommitToolOutcomeInput {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  committedAt: number;
}

export interface ToolCommitResult {
  created: boolean;
  runtimeEventSeq: number;
}

export interface RuntimeEventBatchImportResult {
  created: boolean[];
}

/** Storage-owned, immutable append position for an Event within one Session. */
export interface SessionRuntimeEventEntry {
  readonly ordinal: number;
  readonly event: RuntimeEvent;
}

export interface ToolProjectionRebuildResult {
  operations: number;
  journalEvents: number;
}

export interface ToolOperationRecord {
  operationId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  currentState: 'prepared' | 'outcome_committed' | 'recovery_completed' | 'recovery_parked';
  callEventId: string;
  dispatchEventId?: string;
  resultEventId?: string;
  version: number;
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
  private toolLedgerHealth: ToolLedgerHealth | undefined;
  private closed = false;

  constructor(
    path: string,
    private readonly options: SqliteRuntimeStoreOptions = {},
  ) {
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
      if (!options.readOnly) {
        this.registerWorkspaceBaselineAuthorityWriter(options.databaseLease.databasePath);
        this.refreshToolLedgerHealth();
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
      if (!options.readOnly) {
        this.registerWorkspaceBaselineAuthorityWriter(path);
        this.refreshToolLedgerHealth();
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
      const created = events.map((event) => this.importRuntimeEventSync(event));
      return { created };
    });
  }

  async importConversationCopyRuntimeEvents(
    sessionId: string,
    batches: readonly ConversationCopyRuntimeEventBatch[],
  ): Promise<void> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    const runIds = new Set<string>();
    const canonicalBatches = batches.map(({ runId, events }) => {
      assertRuntimeStorageSafeId(runId, 'Invalid run id');
      if (runIds.has(runId)) {
        throw new Error(`Conversation copy contains duplicate run ${runId}`);
      }
      runIds.add(runId);
      return {
        runId,
        events: events.map(canonicalizeRuntimeEventForStorage),
      };
    });
    const canonicalEvents = canonicalBatches.flatMap(({ events }) => events);
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
      for (const { runId, events } of canonicalBatches) {
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
        if (existing.length === 0) {
          for (const event of events) this.insertRuntimeEvent(event, event.ts, true);
        }
      }
      if (canonicalEvents.some(isToolLedgerBearingEvent)) {
        this.rebuildToolProjectionsFromRuntimeEventsSync(sessionId);
      }
    });
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return this.readRuntimeEventsSync(sessionId, runId);
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
          OR (target_session_id = ? AND target_turn_id = ?)
          OR (
            source_session_id = ?
            AND source_run_id = ?
            AND source_event_high_water = ?
          )`,
        claim.claimId,
        claim.target.invocationId,
        claim.target.runId,
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
              target_run_header_json,
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
            stableJsonStringify(claim.targetRunHeader),
            claim.claimedAt,
          );
      } catch (error) {
        const raced =
          this.readContinuationClaimRow('boundary_digest = ?', claim.boundaryDigest) ??
          this.readContinuationClaimRow(
            `claim_id = ?
              OR target_invocation_id = ?
              OR target_run_id = ?
              OR (target_session_id = ? AND target_turn_id = ?)
              OR (
                source_session_id = ?
                AND source_run_id = ?
                AND source_event_high_water = ?
              )`,
            claim.claimId,
            claim.target.invocationId,
            claim.target.runId,
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
          target_run_header_json,
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
    const matches = this.readImmutableSessionRuntimeEvents(sessionId).filter(
      (event) => immutableSteeringMessageId(event) === messageId,
    );
    if (matches.length > 1) {
      throw new Error(`Immutable steering message identity conflict: ${messageId}`);
    }
    return matches[0] ? Object.freeze({ event: matches[0] }) : undefined;
  }

  async repairImmutableSteeringMessageProofsForRecovery(sessionId: string): Promise<void> {
    assertRuntimeStorageSafeId(sessionId, 'Invalid session id');
    const messages = new Map<string, RuntimeEvent>();
    for (const event of this.readImmutableSessionRuntimeEvents(sessionId)) {
      const messageId = immutableSteeringMessageId(event);
      if (!messageId) continue;
      const existing = messages.get(messageId);
      if (existing && !isDeepStrictEqual(existing, event)) {
        throw new Error(`Immutable steering message identity conflict: ${messageId}`);
      }
      messages.set(messageId, event);
    }
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

  async #commitWorkspaceBaseline(
    input: WorkspaceBaselineAuthorityInput,
    rootId: string,
  ): Promise<WorkspaceBaselineCommitResult> {
    const events = buildWorkspaceBaselineAuthorityEvents(input);
    return this.transaction(() => {
      this.#assertWorkspaceStorageRootBinding(rootId);
      const existingBaselines = this.readCanonicalWorkspaceBaselinesSync();
      const existing = existingBaselines.find(
        (candidate) =>
          candidate.epoch.workspaceId === input.epoch.workspaceId &&
          candidate.epoch.workspaceEpochId === input.epoch.workspaceEpochId,
      );
      if (existing) {
        this.assertWorkspaceProjectionsMatchSync(existingBaselines);
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
        return { created: false, head: workspaceHeadRecord(existing) };
      }

      if (this.workspaceProjectionCountSync() !== 0 || existingBaselines.length !== 0) {
        this.assertWorkspaceProjectionsMatchSync(existingBaselines);
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

      const scanned = this.readCanonicalWorkspaceBaselinesSync();
      const accepted = scanned.find(
        (candidate) => candidate.epoch.workspaceEpochId === input.epoch.workspaceEpochId,
      );
      if (!accepted) throw new Error('Workspace baseline authority scan lost the committed epoch');
      this.insertWorkspaceEpochProjection(accepted, input.committedAt);
      this.options.failpoint?.('after_workspace_epoch_projection_insert');
      this.insertWorkspaceVersionProjection(accepted, input.committedAt);
      this.options.failpoint?.('after_workspace_version_projection_insert');
      this.insertWorkspaceHeadProjection(accepted);
      this.options.failpoint?.('after_workspace_head_projection_insert');
      this.assertWorkspaceProjectionsMatchSync(scanned);
      return { created: true, head: workspaceHeadRecord(accepted) };
    });
  }

  private registerWorkspaceBaselineAuthorityWriter(databasePath: string): void {
    const readWorkspaceHead = this.readWorkspaceHead.bind(this);
    registerWorkspaceBaselineAuthorityWriterInternal(
      this,
      databasePath,
      (input, rootId) => this.#commitWorkspaceBaseline(input, rootId),
      (rootId) => this.#bindWorkspaceStorageRoot(rootId),
      readWorkspaceHead,
    );
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
      const baselines = this.readCanonicalWorkspaceBaselinesSync();
      this.assertWorkspaceProjectionsMatchSync(baselines);
      const baseline = baselines.find(
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
      const baselines = this.readCanonicalWorkspaceBaselinesSync();
      this.assertWorkspaceProjectionsMatchSync(baselines);
      const baseline = baselines.find(
        (candidate) => candidate.baseline.workspaceVersionId === workspaceVersionId,
      );
      return baseline ? workspaceVersionRecord(baseline) : undefined;
    });
  }

  async readWorkspaceHead(
    workspaceId: string,
    workspaceEpochId: string,
  ): Promise<WorkspaceHeadRecordV1 | undefined> {
    return this.readTransaction(() => {
      const baselines = this.readCanonicalWorkspaceBaselinesSync();
      this.assertWorkspaceProjectionsMatchSync(baselines);
      const baseline = baselines.find(
        (candidate) =>
          candidate.epoch.workspaceId === workspaceId &&
          candidate.epoch.workspaceEpochId === workspaceEpochId,
      );
      return baseline ? workspaceHeadRecord(baseline) : undefined;
    });
  }

  async rebuildWorkspaceVersionProjections(): Promise<WorkspaceProjectionRebuildResult> {
    return this.transaction(() => {
      const baselines = this.readCanonicalWorkspaceBaselinesSync();
      this.db.prepare('DELETE FROM runtime_workspace_heads').run();
      this.db.prepare('DELETE FROM runtime_workspace_versions').run();
      this.db.prepare('DELETE FROM runtime_workspace_epochs').run();
      for (const baseline of baselines) {
        const committedAt = Math.max(
          this.runtimeEventCommittedAt(baseline.epochOpenedEventId),
          this.runtimeEventCommittedAt(baseline.baselineAcceptedEventId),
        );
        this.insertWorkspaceEpochProjection(baseline, committedAt);
        this.insertWorkspaceVersionProjection(baseline, committedAt);
        this.insertWorkspaceHeadProjection(baseline);
      }
      this.assertWorkspaceProjectionsMatchSync(baselines);
      return {
        epochs: baselines.length,
        versions: baselines.length,
        heads: baselines.length,
      };
    });
  }

  private readCanonicalWorkspaceBaselinesSync() {
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
    const authorityRows: WorkspaceAuthorityLedgerRow[] = rows.map((row) => ({
      event: decodeRuntimeEventStorageRow(row),
      eventSeq: row.event_seq,
    }));
    const scan = scanWorkspaceBaselineAuthority(authorityRows);
    if (scan.hasCorruption) {
      const issue = scan.issues[0]!;
      throw new Error(
        `Corrupt workspace RuntimeEvent authority: ${issue.code} at ${issue.eventId}`,
      );
    }
    this.options.failpoint?.('after_workspace_canonical_scan');
    return scan.baselines;
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

  private insertWorkspaceVersionProjection(
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
          commit_oid,
          tree_oid,
          policy_hash,
          tree_delta_digest,
          changed_file_count,
          deleted_file_count,
          accepted_event_id,
          protocol_version,
          committed_at
        ) VALUES (?, ?, ?, ?, ?, 'baseline', ?, '[]', ?, ?, ?, ?, ?, ?, ?, 1, ?)
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
        baseline.changedFileCount,
        baseline.deletedFileCount,
        accepted.baselineAcceptedEventId,
        committedAt,
      );
  }

  private insertWorkspaceHeadProjection(
    accepted: ReturnType<typeof scanWorkspaceBaselineAuthority>['baselines'][number],
  ): void {
    const head = workspaceHeadRecord(accepted);
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

  private assertWorkspaceProjectionsMatchSync(
    baselines: ReturnType<typeof scanWorkspaceBaselineAuthority>['baselines'],
  ): void {
    const expectedEpochs = baselines
      .map(workspaceEpochProjectionRow)
      .sort(compareWorkspaceEpochRow);
    const expectedVersions = baselines
      .map(workspaceVersionProjectionRow)
      .sort(compareWorkspaceVersionRow);
    const expectedHeads = baselines.map(workspaceHeadProjectionRow).sort(compareWorkspaceHeadRow);
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
          commit_oid,
          tree_oid,
          policy_hash,
          tree_delta_digest,
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
    if (
      !isDeepStrictEqual(epochs, expectedEpochs) ||
      !isDeepStrictEqual(versions, expectedVersions) ||
      !isDeepStrictEqual(heads, expectedHeads)
    ) {
      throw new Error('Workspace version projection is incomplete or inconsistent');
    }
  }

  private workspaceProjectionCountSync(): number {
    const row = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM runtime_workspace_epochs) +
          (SELECT COUNT(*) FROM runtime_workspace_versions) +
          (SELECT COUNT(*) FROM runtime_workspace_heads) AS count
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
        return {
          created: false,
          runtimeEventSeq: this.runtimeEventSeq(canonicalInput.dispatchRuntimeEvent.id),
        };
      }
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
      return { created: true, runtimeEventSeq };
    });
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

  async listUnsettledToolOperations(sessionId?: string): Promise<ToolOperationRecord[]> {
    const query = `
      SELECT operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
        tool_name, canonical_args_hash, recovery_mode, current_state,
        call_event_id, dispatch_event_id, result_event_id, version
      FROM tool_operations
      WHERE current_state = 'prepared'
        AND result_event_id IS NULL
        AND dispatch_event_id IS NOT NULL
        ${
          sessionId === undefined
            ? ''
            : 'AND call_event_id IN (SELECT event_id FROM runtime_events WHERE session_id = ?)'
        }
      ORDER BY invocation_id ASC, operation_id ASC
    `;
    const statement = this.db.prepare(query);
    const rows = (sessionId === undefined
      ? statement.all()
      : statement.all(sessionId)) as unknown as ToolOperationRow[];
    return rows.map(toolOperationFromRow);
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

  async rebuildToolProjectionsFromRuntimeEvents(): Promise<ToolProjectionRebuildResult> {
    return this.transaction(() => this.rebuildToolProjectionsFromRuntimeEventsSync());
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
      const decision = recovery.kind === 'valid' ? recovery.decision : undefined;
      const currentState = decision
        ? decision.disposition === 'completed'
          ? 'recovery_completed'
          : 'recovery_parked'
        : response
          ? 'outcome_committed'
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
            journalEventIdFor(dispatch.operationId, item.event, item.state),
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

  private commitToolOutcomeSync(input: CommitToolOutcomeInput): ToolCommitResult {
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
        // Preserve the protocol failure that caused rollback.
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
          target_run_header_json,
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
          target_run_header_json,
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
      target.sessionId,
      target.turnId,
    ] as const;
    const runtimeEvent = this.db
      .prepare(`
        SELECT 1 AS found
        FROM runtime_events
        WHERE invocation_id = ?
          OR (session_id = ? AND run_id = ?)
          OR (session_id = ? AND turn_id = ?)
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
            OR (session_id = ? AND turn_id = ?)
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
      if (index === lastIndex) {
        const terminalEvents = prefix.events.filter(isTerminalRuntimeEvent);
        const terminal = terminalEvents[0];
        if (terminalEvents.length !== 1 || !terminal || prefix.events.at(-1)?.id !== terminal.id) {
          throw new Error(
            'Continuation source boundary must end with exactly one terminal RuntimeEvent',
          );
        }
      }
    }
  }

  private assertToolLedgerTransition(
    candidateEvents: readonly RuntimeEvent[],
    expectedTransition: Parameters<typeof validateToolLedgerTransition>[0]['expectedTransition'],
  ): void {
    this.assertWorkspaceToolLedgerHealthy();
    // Tool-call identity is scoped by invocation. Reading unrelated invocations here turns
    // concurrent subagents into repeated whole-workspace scans without strengthening the
    // transition check; event and operation uniqueness remain enforced by SQLite keys.
    const rows: RuntimeEventStorageRow[] = [];
    const invocationIds = [...new Set(candidateEvents.map((event) => event.invocationId))].sort();
    const readInvocation = this.db.prepare(`
      SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
      FROM runtime_events
      WHERE invocation_id = ?
      ORDER BY event_seq ASC, event_id ASC
    `);
    for (const invocationId of invocationIds) {
      rows.push(...(readInvocation.all(invocationId) as unknown as RuntimeEventStorageRow[]));
    }
    const validation = validateToolLedgerTransition({
      existingEvents: rows.map(decodeRuntimeEventStorageRow),
      candidateEvents: candidateEvents.map(canonicalizeRuntimeEventForStorage),
      expectedTransition,
    });
    if (!validation.ok) {
      throw new ToolLedgerRejectionError(validation.code, validation.eventId);
    }
  }

  private assertWorkspaceToolLedgerHealthy(): void {
    const dataVersion = this.runtimeDataVersion();
    if (!this.toolLedgerHealth || this.toolLedgerHealth.dataVersion !== dataVersion) {
      this.refreshToolLedgerHealth();
    }
    const health = this.toolLedgerHealth!;
    if (health.decodeFailure) throw health.decodeFailure.error;
    if (health.issue) {
      // Pre-existing damage, not a bad candidate. Note the reach of "refused":
      // this gate is only ever consulted for tool-bearing events, so a damaged
      // ledger refuses tool facts and takes everything else. Callers that treat
      // this as "the store is gone" are overreading it — see the note on the
      // latch in `AgentRun.enqueueRuntimeEventStore`.
      throw new ToolLedgerCorruptionError(health.issue.code, health.issue.eventId);
    }
  }

  private refreshToolLedgerHealth(): void {
    const dataVersion = this.runtimeDataVersion();
    try {
      const rows = this.db
        .prepare(`
          SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
          FROM runtime_events
          ORDER BY invocation_id ASC, event_seq ASC, event_id ASC
        `)
        .all() as unknown as RuntimeEventStorageRow[];
      const scan = scanToolLedger(rows.map(decodeRuntimeEventStorageRow));
      this.toolLedgerHealth = { dataVersion, issue: scan.issues[0] };
    } catch (error) {
      this.toolLedgerHealth = { dataVersion, decodeFailure: { error } };
    }
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
    for (const row of this.readContinuationClaimRows()) {
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

      const target = claim.target;
      const collidesWithTarget =
        event.invocationId === target.invocationId ||
        (event.sessionId === target.sessionId && event.runId === target.runId) ||
        (event.sessionId === target.sessionId && event.turnId === target.turnId);
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
          AND (
            json_extract(payload_json, '$.actions.endInvocation') = 1
            OR json_extract(payload_json, '$.status')
              IN ('completed', 'failed', 'aborted', 'cancelled')
          )
        ORDER BY event_seq ASC
      `)
      .all(event.sessionId, event.runId) as unknown as RuntimeEventStorageRow[];
    const terminal = rows.map(decodeRuntimeEventStorageRow).find(isTerminalRuntimeEvent);
    if (terminal) {
      throw new RunSealedError(event.runId);
    }
  }

  private importRuntimeEventSync(event: RuntimeEvent): boolean {
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
    const matches = this.readImmutableSessionRuntimeEvents(event.sessionId).filter(
      (candidate) => immutableSteeringMessageId(candidate) === messageId,
    );
    if (matches.some((candidate) => !isDeepStrictEqual(candidate, event))) {
      throw new Error(`Immutable steering message identity conflict: ${messageId}`);
    }
  }

  private readImmutableSessionRuntimeEvents(sessionId: string): RuntimeEvent[] {
    const rows = this.db
      .prepare(`
      SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
      FROM runtime_events
      WHERE session_id = ?
      ORDER BY committed_at ASC, event_id ASC
    `)
      .all(sessionId) as unknown as RuntimeEventStorageRow[];
    return rows.map(decodeRuntimeEventStorageRow);
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
    this.deleteCompletedPartialSnapshot(canonicalEvent);
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

interface ToolLedgerHealth {
  dataVersion: number;
  issue?: ReturnType<typeof scanToolLedger>['issues'][number];
  decodeFailure?: { error: unknown };
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
  current_state: 'prepared' | 'outcome_committed' | 'recovery_completed' | 'recovery_parked';
  call_event_id: string;
  dispatch_event_id: string | null;
  result_event_id: string | null;
  version: number;
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

function assertPreparedInput(input: CommitToolPreparedInput): void {
  if (input.journalEventId !== `${input.operationId}_prepared`) {
    throw new Error('T1 journal identity must be derived from the tool operation');
  }
  assertNoReservedRecoveryFact(input.runtimeEvent);
  assertNoReservedRecoveryFact(input.dispatchRuntimeEvent);
  const content = input.runtimeEvent.content;
  if (content?.kind !== 'function_call')
    throw new Error('T1 requires a function_call RuntimeEvent');
  if (content.id !== input.providerToolCallId || content.name !== input.toolName) {
    throw new Error('T1 RuntimeEvent identity does not match the tool operation');
  }
  let derivedArgsHash: string;
  try {
    derivedArgsHash = canonicalToolArgsHash(content.name, content.args);
  } catch {
    throw new Error('T1 argument hash does not match its canonical function call');
  }
  if (
    derivedArgsHash !== input.canonicalArgsHash ||
    validateToolLedgerEventLane(input.runtimeEvent).ok !== true
  ) {
    throw new Error('T1 argument hash does not match its canonical function call');
  }
  const dispatch = input.dispatchRuntimeEvent.actions?.toolDispatch;
  if (
    !dispatch ||
    input.dispatchRuntimeEvent.content !== undefined ||
    input.dispatchRuntimeEvent.partial ||
    dispatch.operationId !== input.operationId ||
    dispatch.providerToolCallId !== input.providerToolCallId ||
    dispatch.toolName !== input.toolName ||
    dispatch.canonicalArgsHash !== input.canonicalArgsHash ||
    dispatch.recoveryMode !== input.recoveryMode ||
    validateToolLedgerEventLane(input.dispatchRuntimeEvent).ok !== true
  ) {
    throw new Error('T1 requires a matching tool-dispatch RuntimeEvent');
  }
  assertSameRuntimeIdentity(input.runtimeEvent, input.dispatchRuntimeEvent, 'T1');
}

function assertOutcomeInput(input: CommitToolOutcomeInput): void {
  if (input.journalEventId !== `${input.operationId}_outcome`) {
    throw new Error('T2 journal identity must be derived from the tool operation');
  }
  assertNoReservedRecoveryFact(input.runtimeEvent);
  const content = input.runtimeEvent.content;
  if (content?.kind !== 'function_response') {
    throw new Error('T2 requires a function_response RuntimeEvent');
  }
  if (
    input.runtimeEvent.refs?.operationId !== input.operationId ||
    input.runtimeEvent.refs?.toolCallId !== content.id
  ) {
    throw new Error(
      'T2 requires operation and tool-call refs on the function_response RuntimeEvent',
    );
  }
  if (validateToolLedgerEventLane(input.runtimeEvent).ok !== true) {
    throw new Error('T2 requires one canonical function-response semantic lane');
  }
}

function assertPreparedIdentity(
  operation: ToolOperationRecord,
  input: CommitToolPreparedInput,
): void {
  const event = input.runtimeEvent;
  const matches =
    operation.invocationId === event.invocationId &&
    operation.runId === event.runId &&
    operation.turnId === event.turnId &&
    operation.providerToolCallId === input.providerToolCallId &&
    operation.toolName === input.toolName &&
    operation.canonicalArgsHash === input.canonicalArgsHash &&
    operation.recoveryMode === input.recoveryMode &&
    operation.callEventId === event.id &&
    operation.dispatchEventId === input.dispatchRuntimeEvent.id;
  if (!matches) throw new Error(`Tool operation identity conflict for ${input.operationId}`);
}

function assertSameRuntimeIdentity(
  first: RuntimeEvent,
  second: RuntimeEvent,
  boundary: string,
): void {
  if (
    first.sessionId !== second.sessionId ||
    first.invocationId !== second.invocationId ||
    first.runId !== second.runId ||
    first.turnId !== second.turnId
  ) {
    throw new Error(`${boundary} RuntimeEvents do not share one execution identity`);
  }
}

function assertOutcomeIdentity(operation: ToolOperationRecord, event: RuntimeEvent): void {
  const content = event.content;
  const matches =
    content?.kind === 'function_response' &&
    operation.invocationId === event.invocationId &&
    operation.runId === event.runId &&
    operation.turnId === event.turnId &&
    operation.providerToolCallId === content.id &&
    operation.toolName === content.name;
  if (!matches)
    throw new Error(`Tool operation outcome identity conflict for ${operation.operationId}`);
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
  event: RuntimeEvent,
  state: Exclude<ToolJournalState, 'prepared'>,
): string {
  return state === 'outcome_committed' ? `${operationId}_outcome` : `${event.id}_journal`;
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
  const start = event.actions?.continuationStart;
  const runtimeProtocol = event.actions?.runtimeProtocol;
  const actionKeys = event.actions ? Object.keys(event.actions) : [];
  const validActionShape =
    actionKeys.includes('continuationStart') &&
    actionKeys.every((key) => key === 'continuationStart' || key === 'runtimeProtocol') &&
    actionKeys.length === (runtimeProtocol === undefined ? 1 : 2);
  const validRuntimeProtocol =
    runtimeProtocol === undefined ||
    (startKind === 'runtime_admission' &&
      runtimeProtocol.toolBoundary === TOOL_BOUNDARY_PROTOCOL_V1);
  const source = claim.boundary.segments.at(-1)!;
  if (
    event.sessionId !== claim.target.sessionId ||
    event.invocationId !== claim.target.invocationId ||
    event.runId !== claim.target.runId ||
    event.turnId !== claim.target.turnId ||
    event.ts < claim.claimedAt ||
    event.partial ||
    event.role !== 'system' ||
    event.author !== 'system' ||
    event.status !== undefined ||
    event.content !== undefined ||
    !event.actions ||
    !validActionShape ||
    !validRuntimeProtocol ||
    !start ||
    start.protocol !== 'continuation_start_v2' ||
    start.provenance !== startKind ||
    start.claimId !== claim.claimId ||
    start.boundaryDigest !== claim.boundaryDigest ||
    start.replayManifestDigest !== claim.boundary.manifestDigest ||
    start.providerProjectionVersion !== claim.providerProjectionVersion ||
    start.providerReplayDigest !== claim.providerReplayDigest ||
    !isDeepStrictEqual(start.immediateSource, {
      sessionId: source.identity.sessionId,
      invocationId: source.identity.invocationId,
      runId: source.identity.runId,
      turnId: source.identity.turnId,
      highWater: source.position.lastEventSeq,
      prefixDigest: source.prefixDigest,
    })
  ) {
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

interface RuntimeEventStorageRow {
  event_id: string;
  session_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  payload_json: string;
}

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
  commit_oid: string;
  tree_oid: string;
  policy_hash: string;
  tree_delta_digest: string;
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

function workspaceVersionRecord(
  authority: ScannedWorkspaceBaselineAuthority,
): WorkspaceVersionRecordV1 {
  return {
    ...authority.baseline,
    baselineAcceptedEventId: authority.baselineAcceptedEventId,
    committedAt: authority.baselineAcceptedAt,
  };
}

function workspaceHeadRecord(authority: ScannedWorkspaceBaselineAuthority): WorkspaceHeadRecordV1 {
  return {
    repositoryId: authority.epoch.repositoryId,
    workspaceId: authority.epoch.workspaceId,
    workspaceEpochId: authority.epoch.workspaceEpochId,
    workspaceVersionId: authority.baseline.workspaceVersionId,
    acceptedEventId: authority.baselineAcceptedEventId,
    commitOid: authority.baseline.commitOid,
    treeOid: authority.baseline.treeOid,
    revision: 1,
  };
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

function workspaceVersionProjectionRow(
  authority: ScannedWorkspaceBaselineAuthority,
): WorkspaceVersionProjectionRow {
  const record = workspaceVersionRecord(authority);
  return {
    workspace_version_id: record.workspaceVersionId,
    repository_id: record.repositoryId,
    workspace_id: record.workspaceId,
    workspace_epoch_id: record.workspaceEpochId,
    object_format: record.objectFormat,
    origin_kind: record.origin.kind,
    origin_event_id: record.origin.epochOpenedEventId,
    parents_json: '[]',
    commit_oid: record.commitOid,
    tree_oid: record.treeOid,
    policy_hash: record.policyHash,
    tree_delta_digest: record.treeDeltaDigest,
    changed_file_count: record.changedFileCount,
    deleted_file_count: record.deletedFileCount,
    accepted_event_id: record.baselineAcceptedEventId,
    protocol_version: 1,
    committed_at: record.committedAt,
  };
}

function workspaceHeadProjectionRow(
  authority: ScannedWorkspaceBaselineAuthority,
): WorkspaceHeadProjectionRow {
  const record = workspaceHeadRecord(authority);
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
  target_run_header_json: string;
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

function runtimeEventKind(event: RuntimeEvent): string {
  return (
    event.content?.kind ??
    event.status ??
    (event.actions?.workspaceFact ? 'workspace_fact' : undefined) ??
    (event.actions?.toolDispatch ? 'tool_dispatch' : undefined) ??
    (event.actions?.endInvocation ? 'invocation_end' : 'runtime_fact')
  );
}

interface RuntimePartialSnapshot {
  event: RuntimeEvent;
  afterEventId?: string;
}

function mergeRuntimePartialSnapshots(
  immutableEvents: readonly RuntimeEvent[],
  snapshots: readonly RuntimePartialSnapshot[],
): RuntimeEvent[] {
  const { leading, afterEvent } = groupRuntimePartialSnapshots(snapshots);
  const merged = leading.sort(compareRuntimePartialSnapshots).map(({ event }) => event);
  for (const event of immutableEvents) {
    merged.push(event);
    const anchored = afterEvent.get(event.id);
    if (!anchored) continue;
    merged.push(...anchored.sort(compareRuntimePartialSnapshots).map((snapshot) => snapshot.event));
    afterEvent.delete(event.id);
  }
  for (const orphaned of afterEvent.values()) {
    merged.push(...orphaned.sort(compareRuntimePartialSnapshots).map((snapshot) => snapshot.event));
  }
  return merged;
}

function groupRuntimePartialSnapshots(snapshots: readonly RuntimePartialSnapshot[]): {
  leading: RuntimePartialSnapshot[];
  afterEvent: Map<string, RuntimePartialSnapshot[]>;
} {
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
  return { leading, afterEvent };
}

function compareRuntimePartialSnapshots(
  left: RuntimePartialSnapshot,
  right: RuntimePartialSnapshot,
): number {
  return left.event.ts - right.event.ts || left.event.id.localeCompare(right.event.id);
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
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function decodeContinuationClaimRow(row: ContinuationClaimStorageRow): ContinuationClaimV1 {
  if (row.protocol_version !== 1) {
    throw new Error(`Unsupported continuation claim protocol ${row.protocol_version}`);
  }
  const boundary = JSON.parse(row.boundary_json) as unknown;
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
    targetRunHeader: JSON.parse(row.target_run_header_json) as unknown,
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
