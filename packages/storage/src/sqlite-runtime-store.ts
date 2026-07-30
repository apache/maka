import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalToolArgsHash,
  decodeRuntimeEvent,
  encodeCanonicalRuntimeEvent,
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
  scanToolLedger,
  TOOL_RECOVERY_BUNDLE_CAPABILITY_V1,
  validateGenericToolLedgerAppend,
  validateToolLedgerEventLane,
  validateToolLedgerTransition,
  type RuntimeEvent,
  type RuntimeRecoveryBundleCommit,
  type RuntimeRecoveryBundleStore,
  type ToolRecoveryDecisionFact,
  type ToolRecoveryMode,
} from '@maka/core';
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
} from './sqlite-runtime-schema.js';

export { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';

export type { ToolRecoveryMode } from '@maka/core';

const require = createRequire(import.meta.url);

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
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
  | 'after_recovery_decision';

export interface SqliteRuntimeStoreOptions {
  failpoint?: (point: SqliteRuntimeStoreFailpoint) => void;
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
  sourceAlreadyImported: boolean;
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

export class SqliteRuntimeStore implements RuntimeRecoveryBundleStore {
  readonly durability = 'canonical' as const;
  readonly toolBoundaryProtocol = 't1_after_preflight_v1' as const;
  readonly recoveryBundleCapability = TOOL_RECOVERY_BUNDLE_CAPABILITY_V1;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(
    path: string,
    private readonly options: SqliteRuntimeStoreOptions = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    this.db = new DatabaseSync(path);
    try {
      configureSqliteRuntimeDatabase(this.db);
      migrateSqliteRuntimeDatabase(this.db);
      assertRecoveryAuthorityCapability(this.db);
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
    this.db.close();
  }

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    const canonicalEvent = canonicalizeRuntimeEventForStorage(event);
    assertNoReservedToolLedgerFact(canonicalEvent);
    await this.importRuntimeEvent(sessionId, runId, canonicalEvent);
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
    source?: { path: string; fingerprint: string };
  }): Promise<RuntimeEventBatchImportResult> {
    const events = input.events.map(canonicalizeRuntimeEventForStorage);
    for (const event of events) {
      assertNoReservedToolLedgerFact(event);
      if (event.sessionId !== input.sessionId || event.runId !== input.runId) {
        throw new Error(`RuntimeEvent store identity does not match event ${event.id}`);
      }
    }
    return this.transaction(() => {
      if (input.source) {
        const existing = this.db
          .prepare(`
          SELECT fingerprint FROM runtime_import_sources WHERE source_path = ?
        `)
          .get(input.source.path) as { fingerprint: string } | undefined;
        if (existing?.fingerprint === input.source.fingerprint) {
          return { created: [], sourceAlreadyImported: true };
        }
      }
      if (events.some(isToolLedgerBearingEvent)) {
        this.assertToolLedgerTransition(events, 'generic_append');
      }
      const created = events.map((event) => this.importRuntimeEventSync(event));
      if (input.source) {
        this.db
          .prepare(`
          INSERT INTO runtime_import_sources (source_path, fingerprint, imported_at)
          VALUES (?, ?, ?)
          ON CONFLICT(source_path) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            imported_at = excluded.imported_at
        `)
          .run(input.source.path, input.source.fingerprint, Date.now());
      }
      return { created, sourceAlreadyImported: false };
    });
  }

  async isRuntimeImportSourceCurrent(path: string, fingerprint: string): Promise<boolean> {
    const existing = this.db
      .prepare(`
      SELECT fingerprint FROM runtime_import_sources WHERE source_path = ?
    `)
      .get(path) as { fingerprint: string } | undefined;
    return existing?.fingerprint === fingerprint;
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    const immutable = await this.readImmutableRuntimeEvents(sessionId, runId);
    const partials = this.db
      .prepare(`
      SELECT stream_key, session_id, invocation_id, run_id, turn_id,
        payload_json, text_content, after_event_id
      FROM runtime_partial_snapshots
      WHERE session_id = ? AND run_id = ?
      ORDER BY updated_at ASC, stream_key ASC
    `)
      .all(sessionId, runId) as unknown as RuntimePartialStorageRow[];
    return mergeRuntimePartialSnapshots(
      immutable,
      partials.flatMap((row) => {
        try {
          const event = decodeRuntimePartialStorageRow(row);
          if (event.content?.kind === 'text' || event.content?.kind === 'thinking') {
            event.content = { ...event.content, text: row.text_content };
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
      }),
    );
  }

  async readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
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

  async commitToolPrepared(input: CommitToolPreparedInput): Promise<ToolCommitResult> {
    const canonicalInput: CommitToolPreparedInput = {
      ...input,
      runtimeEvent: canonicalizeRuntimeEventForStorage(input.runtimeEvent),
      dispatchRuntimeEvent: canonicalizeRuntimeEventForStorage(input.dispatchRuntimeEvent),
    };
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
    if (canonicalInput.outcomeRuntimeEvent) {
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

  async listUnsettledToolOperations(): Promise<ToolOperationRecord[]> {
    const rows = this.db
      .prepare(`
      SELECT operation_id, invocation_id, run_id, turn_id, provider_tool_call_id,
        tool_name, canonical_args_hash, recovery_mode, current_state,
        call_event_id, dispatch_event_id, result_event_id, version
      FROM tool_operations
      WHERE current_state = 'prepared'
        AND result_event_id IS NULL
        AND dispatch_event_id IS NOT NULL
      ORDER BY invocation_id ASC, operation_id ASC
    `)
      .all() as unknown as ToolOperationRow[];
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
    return this.transaction(() => {
      const rows = this.db
        .prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id,
          event_seq, payload_json, committed_at
        FROM runtime_events
        ORDER BY invocation_id ASC, event_seq ASC, event_id ASC
      `)
        .all() as unknown as Array<
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
      this.db.exec(`
        DELETE FROM tool_journal_events
        WHERE operation_id IN (
          SELECT operation_id FROM tool_operations WHERE dispatch_event_id IS NOT NULL
        );
        DELETE FROM tool_operations WHERE dispatch_event_id IS NOT NULL;
      `);
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
    });
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

  private assertToolLedgerTransition(
    candidateEvents: readonly RuntimeEvent[],
    expectedTransition: Parameters<typeof validateToolLedgerTransition>[0]['expectedTransition'],
  ): void {
    const rows = this.db
      .prepare(`
        SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json
        FROM runtime_events
        ORDER BY invocation_id ASC, event_seq ASC, event_id ASC
      `)
      .all() as unknown as RuntimeEventStorageRow[];
    const validation = validateToolLedgerTransition({
      existingEvents: rows.map(decodeRuntimeEventStorageRow),
      candidateEvents: candidateEvents.map(canonicalizeRuntimeEventForStorage),
      expectedTransition,
    });
    if (!validation.ok) {
      throw new Error(
        `Tool ledger transition rejected: ${validation.code} at ${validation.eventId}`,
      );
    }
  }

  private assertInvocationIdentity(events: readonly RuntimeEvent[]): void {
    const candidates = new Map<string, { sessionId: string; runId: string; turnId: string }>();
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
    }
    for (const [invocationId, identity] of candidates) {
      const rows = this.db
        .prepare(`
          SELECT DISTINCT session_id, run_id, turn_id
          FROM runtime_events
          WHERE invocation_id = ?
        `)
        .all(invocationId) as Array<{
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
  }

  private importRuntimeEventSync(event: RuntimeEvent): boolean {
    const canonicalEvent = canonicalizeRuntimeEventForStorage(event);
    this.assertInvocationIdentity([canonicalEvent]);
    const partial = partialRuntimeStream(canonicalEvent);
    if (partial) return this.upsertRuntimePartial(canonicalEvent, partial);
    if (isToolLedgerBearingEvent(canonicalEvent)) {
      this.assertToolLedgerTransition([canonicalEvent], 'generic_append');
    }
    const existing = this.readRuntimeEventJson(canonicalEvent.id) !== undefined;
    this.insertRuntimeEvent(canonicalEvent, canonicalEvent.ts, true);
    return !existing;
  }

  private insertRuntimeEvent(
    event: RuntimeEvent,
    committedAt: number,
    allowExactDuplicate: boolean,
  ): number {
    const encoding = encodeCanonicalRuntimeEvent(event);
    const canonicalEvent = encoding.event;
    this.assertInvocationIdentity([canonicalEvent]);
    assertRuntimeEventIdentity(canonicalEvent);
    const existingJson = this.readRuntimeEventJson(canonicalEvent.id);
    if (existingJson !== undefined) {
      assertStoredRuntimeEventEquals(canonicalEvent, existingJson);
      this.deleteCompletedPartialSnapshot(canonicalEvent);
      if (!allowExactDuplicate) {
        throw new Error(
          `RuntimeEvent ${canonicalEvent.id} already exists outside this tool transaction`,
        );
      }
      return this.runtimeEventSeq(canonicalEvent.id);
    }
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
    partial: { key: string; snapshot: RuntimeEvent; text: string },
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
    this.db
      .prepare(`
      INSERT INTO runtime_partial_snapshots (
        stream_key, session_id, invocation_id, run_id, turn_id,
        after_event_id, payload_json, text_content, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stream_key) DO UPDATE SET
        text_content = runtime_partial_snapshots.text_content || excluded.text_content,
        updated_at = excluded.updated_at
    `)
      .run(
        partial.key,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        anchor?.event_id ?? null,
        JSON.stringify(partial.snapshot),
        partial.text,
        event.ts,
      );
    return !existing;
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

interface RuntimeEventStorageRow {
  event_id: string;
  session_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  payload_json: string;
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
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
