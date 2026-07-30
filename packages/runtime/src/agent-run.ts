import type {
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  RuntimeEvent,
  RuntimeEventStore,
  ToolBoundaryProtocol,
} from '@maka/core';
import { DurableStoreWriteError, isSessionInlineRun, isTerminalRuntimeEvent } from '@maka/core';
import { redactSecrets } from '@maka/core/redaction';
import type {
  SessionBlockedReason,
  SessionHeader,
  SessionStatus,
  StoredMessage,
  SystemNoteMessage,
  TurnRecord,
  UserMessage,
} from '@maka/core/session';
import type { UserMessageInput } from '@maka/core/runtime-inputs';
import {
  resolveEffectiveOrchestration,
  type EffectiveOrchestration,
} from '@maka/core/orchestration';
import type { SessionEvent } from '@maka/core/events';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import type { RunTraceEvent } from './run-trace.js';
import type { SessionStore, StopSessionInput } from './session-manager.js';
import type { ActiveFullCompactBlock } from './active-full-compact.js';
import type { SemanticCompactBlock } from './semantic-compact.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';
import { projectRuntimeEventsToStoredMessages } from './runtime-event-read-model.js';
import {
  buildPriorRuntimeContext as buildPriorRuntimeContextProjection,
  type PriorRuntimeContext,
} from './prior-run-context.js';
import {
  buildStatusPatch,
  isTerminalRunStatus,
  normalizeStopSessionSource,
  statusFromEvent,
  turnStatusFromEvent,
} from './session-projection-helpers.js';
import {
  buildSyntheticTerminalRuntimeEvent,
  commitOrCreateTerminalRunFact,
} from './terminal-run-commit.js';
import { AiSdkFlow } from './ai-sdk-flow.js';
import type { InvocationContext } from './invocation-context.js';
import { buildInitialUserRuntimeEvent } from './runtime-runner.js';
import type { RuntimeContinuation } from './runtime-resume.js';
import type {
  ProviderRequestAttemptRecord,
  ProviderRequestCaptureLedgerRecord,
} from './provider-request-telemetry.js';

export interface AgentRunActiveSession {
  sessionId: string;
  backend: AgentBackend;
  cachedHeader: SessionHeader;
  activeRuns: Map<string, AgentRun>;
  turnToRunId: Map<string, string>;
}

export interface AgentRunHooks {
  reserveRun(
    sessionId: string,
    header: SessionHeader,
    run: AgentRun,
  ): Promise<AgentRunActiveSession>;
  unregisterRun(active: AgentRunActiveSession, run: AgentRun): void | Promise<void>;
  updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader>;
  updateStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
    ts?: number,
  ): Promise<void>;
  appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage?: AgentRunLineage,
    options?: { ts?: number; errorClass?: string; abortSource?: string },
  ): Promise<void>;
}

export type AgentRunLineage = Partial<
  Pick<
    UserMessageInput,
    | 'parentRunId'
    | 'resumedFromRunId'
    | 'retriedFromRunId'
    | 'parentTurnId'
    | 'retriedFromTurnId'
    | 'regeneratedFromTurnId'
    | 'branchOfTurnId'
    | 'parentSessionId'
  >
>;

export type AgentRunDurability = 'best_effort' | 'required';

export interface AgentRunInput {
  sessionId: string;
  header: SessionHeader;
  userInput: UserMessageInput;
  runId?: string;
  userMessageId?: string;
  durability?: AgentRunDurability;
  store: SessionStore;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  repairRunRuntimeLedger?: (sessionId: string, runId: string) => Promise<boolean>;
  newId: () => string;
  now: () => number;
  workspaceIdentity?: string;
  continuationFailpoint?: (point: RuntimeContinuationFailpoint) => Promise<void>;
  hooks: AgentRunHooks;
  recordSessionMessages?: boolean;
  invocationId?: string;
  /** Pre-resolved snapshot used by continuations; normal turns derive it from header + input. */
  effectiveOrchestration?: EffectiveOrchestration;
  /** Set only when this run's backend tool path is guarded by canonical T1. */
  toolBoundaryProtocol?: ToolBoundaryProtocol;
}

export type RuntimeContinuationFailpoint =
  | 'after_run_created'
  | 'after_continuation_start_committed'
  | 'after_terminal_event_committed'
  | 'after_terminal_header_committed';

export interface AgentRunBeginResult {
  backend: AgentBackend;
  backendInput: BackendSendInput;
  initialRuntimeEvent: RuntimeEvent;
}

export interface AgentRunOperationBeginResult {
  backend: AgentBackend;
  runtimeContext: RuntimeEvent[];
  startedAt: number;
}

export interface AgentRunContinuationBeginResult {
  backend: AgentBackend;
  startedAt: number;
}

export class AgentRun {
  readonly runId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolBoundaryProtocol: ToolBoundaryProtocol | undefined;
  readonly lineage: AgentRunLineage;
  readonly effectiveOrchestration: EffectiveOrchestration;

  private header: SessionHeader;
  private active: AgentRunActiveSession | undefined;
  private stopped = false;
  private abortSource: string | undefined;
  private traceQueue: Promise<void> = Promise.resolve();
  private runtimeEventQueue: Promise<void> = Promise.resolve();
  private runStoreAvailable = true;
  private runtimeEventStoreAvailable = true;
  private runtimeEventStoreFailure: unknown;
  private traceWriteError: string | undefined;
  private failureClass: string | undefined;
  private failureMessage: string | undefined;
  private lastTs = 0;
  private sawCompletion = false;
  private finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined;
  private turnFailed = false;
  private finalized = false;
  private terminalRunHeaderCommitted = false;
  private continuationActive = false;
  private terminalClaim:
    | {
        owner: 'event' | 'stop';
        event?: RuntimeEvent;
        write?: Promise<void>;
        stopCompleted?: boolean;
      }
    | undefined;

  constructor(private readonly input: AgentRunInput) {
    if (input.runStore && !input.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    if (input.durability === 'required' && (!input.runStore || !input.runtimeEventStore)) {
      throw new Error('Required AgentRun durability needs AgentRunStore and RuntimeEventStore');
    }
    this.runId = input.runId ?? input.newId();
    this.invocationId = input.invocationId ?? this.runId;
    this.sessionId = input.sessionId;
    this.turnId = input.userInput.turnId;
    this.toolBoundaryProtocol = input.toolBoundaryProtocol;
    this.header = input.header;
    this.effectiveOrchestration =
      input.effectiveOrchestration ??
      resolveEffectiveOrchestration(
        input.header.orchestrationMode,
        input.userInput.turnOrchestration,
      );
    this.lineage = {
      ...(input.userInput.parentRunId ? { parentRunId: input.userInput.parentRunId } : {}),
      ...(input.userInput.resumedFromRunId
        ? { resumedFromRunId: input.userInput.resumedFromRunId }
        : {}),
      ...(input.userInput.retriedFromRunId
        ? { retriedFromRunId: input.userInput.retriedFromRunId }
        : {}),
      ...(input.userInput.parentTurnId ? { parentTurnId: input.userInput.parentTurnId } : {}),
      ...(input.userInput.retriedFromTurnId
        ? { retriedFromTurnId: input.userInput.retriedFromTurnId }
        : {}),
      ...(input.userInput.regeneratedFromTurnId
        ? { regeneratedFromTurnId: input.userInput.regeneratedFromTurnId }
        : {}),
      ...(input.userInput.branchOfTurnId ? { branchOfTurnId: input.userInput.branchOfTurnId } : {}),
      ...(input.userInput.parentSessionId
        ? { parentSessionId: input.userInput.parentSessionId }
        : {}),
    };
  }

  stop(source: StopSessionInput['source'] | undefined): boolean {
    if (this.terminalClaim) return false;
    this.terminalClaim = { owner: 'stop' };
    this.stopped = true;
    this.abortSource = normalizeStopSessionSource(source);
    return true;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  isSessionInline(): boolean {
    return isSessionInlineRun({
      ...(this.lineage.parentRunId ? { parentRunId: this.lineage.parentRunId } : {}),
      ...(this.continuationActive ? { continuationSource: true } : {}),
    });
  }

  hasPendingStop(): boolean {
    return this.terminalClaim?.owner === 'stop' && this.terminalClaim.stopCompleted !== true;
  }

  completeStop(): void {
    if (this.terminalClaim?.owner === 'stop') this.terminalClaim.stopCompleted = true;
  }

  recordRunTrace(event: RunTraceEvent): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('append trace event', async () => {
      await this.input.runStore?.appendEvent(
        this.sessionId,
        this.runId,
        traceToRunEvent(event, this.runId),
      );
    });
  }

  recordProviderRequestCapture(capture: ProviderRequestCaptureLedgerRecord): Promise<void> {
    if (!this.input.runStore) return Promise.reject(new Error('AgentRun store is not configured'));
    return this.enqueueRequiredRunStoreWrite('append provider request capture', async () => {
      const {
        schemaVersion,
        serializedRequest: _serializedRequest,
        ...data
      } = capture as ProviderRequestCaptureLedgerRecord & { serializedRequest?: string };
      await this.input.runStore?.appendEvent(
        this.sessionId,
        this.runId,
        {
          type: 'provider_request_captured',
          id: capture.captureId,
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: capture.turnId,
          ts: this.input.now(),
          data: { schemaVersion, ...data },
        },
        { durable: true },
      );
    });
  }

  recordProviderRequestAttempt(attempt: ProviderRequestAttemptRecord): void {
    if (!this.input.runStore) return;
    this.enqueueBestEffortProviderAttempt('append provider request attempt', async () => {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'provider_request_attempt_recorded',
        id: attempt.attemptId,
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: attempt.turnId,
        ts: attempt.completedAt,
        data: { ...attempt },
      });
    });
  }

  recordActiveFullCompactBlock(block: ActiveFullCompactBlock): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('append active full compact block', async () => {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'active_full_compact_block_recorded',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: block.turnId || this.turnId,
        ts: this.input.now(),
        data: {
          blockId: block.blockId,
          highWaterName: block.highWaterName,
          highWaterSeq: block.highWaterSeq,
          boundaryKind: 'activeFullCompact',
          block,
        },
      });
    });
  }

  recordHistoryCompactCheckpoint(checkpoint: HistoryCompactCheckpoint): Promise<void> {
    if (!this.input.runStore) return Promise.reject(new Error('AgentRun store is not configured'));
    if (!this.runStoreAvailable) return Promise.reject(new Error('AgentRun store is unavailable'));
    return this.enqueueRunStore(
      'append history compact checkpoint',
      async () => {
        await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
          type: 'history_compact_checkpoint_recorded',
          id: this.input.newId(),
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: this.turnId,
          ts: this.input.now(),
          data: {
            checkpointId: checkpoint.checkpointId,
            highWaterName: checkpoint.highWaterName,
            highWaterSeq: checkpoint.highWaterSeq,
            boundaryKind: 'historyCompact',
            checkpoint,
          },
        });
      },
      { rethrow: true },
    );
  }

  /**
   * Durable read of this run's RuntimeEvent ledger for the mid-turn capacity
   * invariant: waits for every write enqueued so far, then reads the store, so
   * a caller-derived coverage prefix can only ever span events that are
   * already persisted. Rejects when the store is unavailable — coverage must
   * never be computed over a projection the ledger cannot replay.
   */
  async loadTurnRuntimeEvents(): Promise<RuntimeEvent[]> {
    if (!this.input.runtimeEventStore || !this.runtimeEventStoreAvailable) {
      throw new Error('RuntimeEvent store is unavailable for turn runtime events');
    }
    await this.runtimeEventQueue.catch(() => {});
    // A write may have failed while we waited; a snapshot from a store that
    // just went unavailable must not be treated as a complete durable read.
    if (!this.runtimeEventStoreAvailable) {
      throw new Error('RuntimeEvent store became unavailable for turn runtime events');
    }
    return await this.input.runtimeEventStore.readRuntimeEvents(this.sessionId, this.runId);
  }

  recordSemanticCompactBlock(block: SemanticCompactBlock): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.enqueueRunStore('append semantic compact block', async () => {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'semantic_compact_block_recorded',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: block.turnId || this.turnId,
        ts: this.input.now(),
        data: {
          blockId: block.blockId,
          highWaterName: block.highWaterName,
          highWaterSeq: block.highWaterSeq,
          boundaryKind: 'semanticCompact',
          block,
        },
      });
    });
  }

  async *execute(): AsyncIterable<SessionEvent> {
    try {
      const begin = await this.begin();
      const invocationId = begin.initialRuntimeEvent.invocationId;
      const source = 'desktop' as const;
      const request: InvocationContext['request'] = {
        sessionId: this.sessionId,
        invocationId,
        runId: this.runId,
        turnId: this.turnId,
        orchestration: this.effectiveOrchestration,
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments
          ? { attachments: this.input.userInput.attachments }
          : {}),
        ...(this.input.userInput.quotes ? { quotes: this.input.userInput.quotes } : {}),
        context: begin.backendInput.context,
        ...(begin.backendInput.runtimeContext
          ? { runtimeContext: begin.backendInput.runtimeContext }
          : {}),
        initialRuntimeEvent: begin.initialRuntimeEvent,
        source,
        lineage: this.lineage,
      };
      const ctx: InvocationContext = {
        sessionId: this.sessionId,
        invocationId,
        runId: this.runId,
        turnId: this.turnId,
        source,
        startedAt: begin.initialRuntimeEvent.ts,
        request,
        newId: this.input.newId,
        now: this.input.now,
      };
      let acceptedSessionEvent: SessionEvent | undefined;
      const flow = new AiSdkFlow({
        backend: begin.backend,
        drainAfterTerminal: true,
        onSessionEvent: async (sessionEvent, runtimeEvent) => {
          await this.acceptMappedEvent(sessionEvent, runtimeEvent);
          acceptedSessionEvent = sessionEvent;
        },
      });
      for await (const _runtimeEvent of flow.run(ctx, {
        text: begin.backendInput.text,
        ...(begin.backendInput.attachments ? { attachments: begin.backendInput.attachments } : {}),
        ...(begin.backendInput.quotes ? { quotes: begin.backendInput.quotes } : {}),
        context: begin.backendInput.context,
        ...(begin.backendInput.runtimeContext
          ? { runtimeContext: begin.backendInput.runtimeContext }
          : {}),
      })) {
        if (acceptedSessionEvent) {
          yield acceptedSessionEvent;
          acceptedSessionEvent = undefined;
        }
      }
    } catch (error) {
      await this.recordFailure(error);
      throw error;
    } finally {
      await this.finalize();
    }
  }

  async acceptMappedEvent(
    sessionEvent: SessionEvent,
    runtimeEvent: RuntimeEvent,
    options: { requireTerminalWrite?: boolean; allowInteractionResume?: boolean } = {},
  ): Promise<void> {
    if (isTerminalRuntimeEvent(runtimeEvent)) {
      await this.recordRuntimeEvents([runtimeEvent], {
        requireTerminalWrite: options.requireTerminalWrite ?? Boolean(this.input.runtimeEventStore),
      });
      await this.recordSessionEvent(sessionEvent, options);
      return;
    }
    if (this.requiresDurablePersistence() && isInteractionResumeAck(sessionEvent)) {
      // A hosted continuation may resume execution only after its identity-only
      // settlement fact is durable. Run status advances next, then Session
      // status; the queue consumer acknowledges the event only after all three.
      await this.recordRuntimeEvents([runtimeEvent], { requireDurableWrite: true });
      await this.recordSessionEvent(sessionEvent, options);
      return;
    }
    await this.recordSessionEvent(sessionEvent, options);
    if (sessionEvent.type === 'provider_retry') return;
    // ToolRuntime already persisted protocol-tagged tool calls/results through
    // the atomic RuntimeCommitSink. Re-appending the mapped UI event through
    // the generic lane would duplicate the fact and violate that boundary.
    if (isAtomicToolBoundaryProjection(runtimeEvent, this.toolBoundaryProtocol)) return;
    if (!isNonTerminalErrorRuntimeEvent(runtimeEvent)) {
      // A steered user message is fail-CLOSED: the backend's delivery ack
      // waits on this consume, and the provider must never execute a
      // directive the ledger does not carry. Every other non-terminal event
      // stays fail-open (a trace gap, not a correctness gap).
      const steering =
        runtimeEvent.content?.kind === 'text' && runtimeEvent.content.steering === true;
      await this.recordRuntimeEvents([runtimeEvent], steering ? { requireDurableWrite: true } : {});
    }
  }

  async begin(): Promise<AgentRunBeginResult> {
    await this.createRunRecord();

    let initialRuntimeEventId: string;
    if (this.recordsSessionMessages()) {
      const userMessageId = this.input.userMessageId ?? this.input.newId();
      const userMessageTs = this.input.now();
      initialRuntimeEventId = userMessageId;
      const userMsg: UserMessage = {
        type: 'user',
        id: userMessageId,
        turnId: this.turnId,
        ts: userMessageTs,
        text: this.input.userInput.text,
        ...(this.input.userInput.displayText !== undefined
          ? { displayText: this.input.userInput.displayText }
          : {}),
        ...(this.input.userInput.attachments
          ? { attachments: this.input.userInput.attachments }
          : {}),
        ...(this.input.userInput.quotes ? { quotes: this.input.userInput.quotes } : {}),
        ...(this.input.userInput.origin ? { origin: this.input.userInput.origin } : {}),
      };
      await this.input.store.appendMessage(this.sessionId, userMsg);
      await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage);
      this.lastTs = userMessageTs;
    } else {
      initialRuntimeEventId = this.input.newId();
      this.lastTs = this.input.now();
    }

    const initialRuntimeEvent = this.buildInitialRuntimeEvent(initialRuntimeEventId, this.lastTs);
    await this.recordRuntimeEvents([initialRuntimeEvent], {
      requireDurableWrite: this.requiresDurablePersistence(),
    });

    if (!this.header.connectionLocked) {
      this.header = await this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true });
    }

    this.active = await this.input.hooks.reserveRun(this.sessionId, this.header, this);
    await this.markRunStarted(this.lastTs);

    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, this.lastTs);

    const priorRuntimeContext = await this.buildPriorRuntimeContext();
    const projectionContext = priorRuntimeContext
      ? projectRuntimeEventsToStoredMessages(priorRuntimeContext.events, {
          runHeaders: priorRuntimeContext.runs,
        }).messages
      : [];

    return {
      backend: this.active.backend,
      backendInput: {
        turnId: this.turnId,
        orchestration: this.effectiveOrchestration,
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments
          ? { attachments: this.input.userInput.attachments }
          : {}),
        ...(this.input.userInput.quotes ? { quotes: this.input.userInput.quotes } : {}),
        context: projectionContext,
        ...(priorRuntimeContext ? { runtimeContext: priorRuntimeContext.events } : {}),
      },
      initialRuntimeEvent,
    };
  }

  async beginOperation(): Promise<AgentRunOperationBeginResult> {
    await this.createRunRecord();

    const startedAt = this.input.now();
    this.lastTs = startedAt;
    if (this.recordsSessionMessages()) {
      await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage, {
        ts: startedAt,
      });
    }

    if (!this.header.connectionLocked) {
      this.header = await this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true });
    }

    this.active = await this.input.hooks.reserveRun(this.sessionId, this.header, this);
    await this.markRunStarted(startedAt);

    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, startedAt);

    const priorRuntimeContext = await this.buildPriorRuntimeContext();
    return {
      backend: this.active.backend,
      runtimeContext: priorRuntimeContext?.events ?? [],
      startedAt,
    };
  }

  async beginContinuation(
    continuation: RuntimeContinuation,
  ): Promise<AgentRunContinuationBeginResult> {
    if (
      continuation.sessionId !== this.sessionId ||
      continuation.runId !== this.runId ||
      continuation.turnId !== this.turnId
    ) {
      throw new Error('Runtime continuation identity does not match the target AgentRun');
    }

    this.continuationActive = true;
    await this.createRunRecord(continuation);
    await this.input.continuationFailpoint?.('after_run_created');
    const startedAt = this.input.now();
    this.lastTs = startedAt;
    if (this.recordsSessionMessages()) {
      await this.input.hooks.appendTurnState(this.sessionId, this.turnId, 'running', this.lineage, {
        ts: startedAt,
      });
    }

    if (!this.header.connectionLocked) {
      this.header = await this.input.hooks.updateHeader(this.sessionId, { connectionLocked: true });
    }

    this.active = await this.input.hooks.reserveRun(this.sessionId, this.header, this);
    await this.markRunStarted(startedAt);
    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, startedAt);

    return { backend: this.active.backend, startedAt };
  }

  private buildInitialRuntimeEvent(id: string, ts: number): RuntimeEvent {
    return buildInitialUserRuntimeEvent({
      id,
      invocationId: this.invocationId,
      runId: this.runId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      ts,
      text: this.input.userInput.text,
      ...(this.input.userInput.displayText !== undefined
        ? { displayText: this.input.userInput.displayText }
        : {}),
      ...(this.input.userInput.origin !== undefined ? { origin: this.input.userInput.origin } : {}),
      ...(this.input.userInput.attachments !== undefined
        ? { attachments: this.input.userInput.attachments }
        : {}),
      ...(this.input.userInput.quotes !== undefined ? { quotes: this.input.userInput.quotes } : {}),
      ...(this.toolBoundaryProtocol ? { toolBoundaryProtocol: this.toolBoundaryProtocol } : {}),
    });
  }

  async recordStoredSessionEvent(ev: SessionEvent): Promise<void> {
    if (!this.recordsSessionMessages()) return;
    if (ev.type === 'token_usage') {
      await this.input.store.appendMessage(this.sessionId, { ...ev } satisfies StoredMessage);
    }
  }

  async recordSessionEvent(
    ev: SessionEvent,
    options: { allowInteractionResume?: boolean } = {},
  ): Promise<void> {
    this.lastTs = ev.ts;
    const transition = statusFromEvent(ev, options);
    const terminalSessionEvent =
      (ev.type === 'complete' || ev.type === 'abort') && !this.turnFailed;
    const turnStatus = terminalSessionEvent ? turnStatusFromEvent(ev) : undefined;
    if (terminalSessionEvent) {
      this.sawCompletion = true;
      if (ev.type === 'abort' && !this.abortSource) this.abortSource = ev.reason;
      if (ev.type === 'complete' && ev.stopReason === 'user_stop' && !this.abortSource)
        this.abortSource = 'user_stop';
      this.finalStatus = this.stopped
        ? { status: 'aborted' }
        : (transition ?? { status: 'active' });
      // A terminal complete event can carry a failure without a preceding
      // error event. Record it now so finalize preserves the precise class.
      if (
        turnStatus?.status === 'failed' &&
        turnStatus.errorClass &&
        !this.failureClass &&
        !this.stopped
      ) {
        this.markRunFailed(
          turnStatus.errorClass,
          `turn ended with stopReason=${ev.type === 'complete' ? ev.stopReason : 'unknown'}`,
          ev.ts,
        );
      }
    }
    if (transition && !this.stopped) {
      const updateSessionStatus = async (): Promise<void> => {
        if (terminalSessionEvent || ev.type === 'error') {
          await this.input.hooks
            .updateStatus(this.sessionId, transition.status, transition.blockedReason, ev.ts)
            .catch((error) => this.enqueueTraceWriteFailure(error, 'terminal session projection'));
          return;
        }
        await this.input.hooks.updateStatus(
          this.sessionId,
          transition.status,
          transition.blockedReason,
          ev.ts,
        );
      };
      // On resume, advance the Run before the Session so an interrupted pair
      // remains conservatively waiting rather than advertising false readiness.
      if (this.requiresDurablePersistence() && isInteractionResumeAck(ev)) {
        await this.recordStatusFromTransition(ev, transition, ev.ts);
        await updateSessionStatus();
      } else {
        await updateSessionStatus();
        await this.recordStatusFromTransition(ev, transition, ev.ts);
      }
    }
    if (turnStatus && !this.stopped && this.recordsSessionMessages()) {
      const appendTurnState = this.input.hooks.appendTurnState(
        this.sessionId,
        this.turnId,
        turnStatus.status,
        this.lineage,
        {
          ts: ev.ts,
          errorClass: turnStatus.errorClass,
          ...(turnStatus.status === 'aborted' && this.abortSource
            ? { abortSource: this.abortSource }
            : {}),
        },
      );
      if (terminalSessionEvent || ev.type === 'error') {
        await appendTurnState.catch((error) =>
          this.enqueueTraceWriteFailure(error, 'terminal session projection'),
        );
      } else {
        await appendTurnState;
      }
    }
    if (ev.type === 'error') {
      if (this.stopped) {
        this.finalStatus = { status: 'aborted' };
      } else {
        this.turnFailed = true;
        this.finalStatus = transition ?? { status: 'blocked', blockedReason: 'unknown' };
        if (this.recordsSessionMessages()) {
          await this.input.hooks
            .appendTurnState(this.sessionId, this.turnId, 'failed', this.lineage, {
              ts: ev.ts,
              errorClass: ev.reason ?? ev.code ?? 'unknown',
            })
            .catch((error) => this.enqueueTraceWriteFailure(error, 'terminal session projection'));
        }
        this.markRunFailed(ev.reason ?? ev.code ?? 'unknown', ev.message, ev.ts);
      }
    }
  }

  async recordRuntimeEvents(
    events: readonly RuntimeEvent[],
    options: { requireTerminalWrite?: boolean; requireDurableWrite?: boolean } = {},
  ): Promise<void> {
    if (events.length === 0) return;
    for (const event of events) {
      const terminal = isTerminalRuntimeEvent(event);
      const eventForStore = terminal ? this.reserveTerminalEvent(event) : event;
      if (!eventForStore) continue;
      if (!this.input.runtimeEventStore || !this.runtimeEventStoreAvailable) {
        if (this.input.runtimeEventStore?.durability === 'canonical') {
          throw (
            this.runtimeEventStoreFailure ??
            new Error('canonical RuntimeEvent store is unavailable')
          );
        }
        if (terminal && options.requireTerminalWrite) {
          throw new Error('terminal RuntimeEvent store is unavailable');
        }
        if (options.requireDurableWrite && this.input.runtimeEventStore) {
          // The store exists but earlier writes failed: a durability-required
          // event (steering) must not silently skip the ledger.
          throw new Error('RuntimeEvent store is unavailable for a durability-required event');
        }
        continue;
      }
      const write = this.enqueueRuntimeEventStore(
        'append runtime event',
        async () => {
          await this.input.runtimeEventStore?.appendRuntimeEvent(
            this.sessionId,
            this.runId,
            eventForStore,
            { durable: terminal || options.requireDurableWrite === true },
          );
        },
        {
          rethrow:
            terminal ||
            options.requireTerminalWrite ||
            options.requireDurableWrite ||
            this.input.runtimeEventStore.durability === 'canonical',
        },
      );
      if (terminal && this.terminalClaim) this.terminalClaim.write = write;
      if (options.requireDurableWrite && !terminal) {
        // An append error is AMBIGUOUS: the bytes may have landed before the
        // failure (e.g. a close error after the write). For a
        // durability-required event the caller settles a delivery lease on
        // this outcome, so a false "not durable" would redeliver a message
        // the ledger already owns. Read the ledger back to disambiguate:
        // present ⇒ durable (continue on the ack path); absent or read-back
        // also failing ⇒ fail closed (rethrow ⇒ nack).
        try {
          await write;
        } catch (error) {
          if (error instanceof DurableStoreWriteError) throw error;
          if (!(await this.eventLandedInLedger(eventForStore.id))) throw error;
          // The write landed and the ledger answered a fresh read — the
          // failure was in the reporting, not the store. Lift the
          // unavailability latch so the rest of the turn (including its
          // required terminal write) keeps persisting; a genuinely broken
          // store re-latches on its next write.
          this.runtimeEventStoreAvailable = true;
        }
        continue;
      }
      await write;
    }
  }

  private reserveTerminalEvent(event: RuntimeEvent): RuntimeEvent | undefined {
    if (this.terminalClaim?.event) return undefined;
    this.terminalClaim ??= { owner: 'event' };
    const eventForStore =
      this.terminalClaim.owner === 'stop' ? this.abortedRuntimeEvent(event) : event;
    this.terminalClaim.event = eventForStore;
    return eventForStore;
  }

  private abortedRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
    const { content: _content, ...rest } = event;
    void _content;
    return {
      ...rest,
      status: 'aborted',
      actions: {
        ...event.actions,
        endInvocation: true,
        stateDelta: {
          ...event.actions?.stateDelta,
          abortSource: this.abortSource ?? 'user_stop',
        },
      },
    };
  }

  async recordFailure(error: unknown): Promise<void> {
    if (this.stopped) {
      this.finalStatus = { status: 'aborted' };
      return;
    }
    this.finalStatus = { status: 'blocked', blockedReason: 'unknown' };
    if (this.recordsSessionMessages()) {
      await this.input.hooks
        .appendTurnState(this.sessionId, this.turnId, 'failed', this.lineage, {
          errorClass: error instanceof Error ? error.name : 'unknown',
        })
        .catch(() => {});
    }
    this.markRunFailed(
      error instanceof Error ? error.name : 'unknown',
      errorMessage(error),
      this.input.now(),
    );
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const lastTs = this.lastTs || this.input.now();
    if (this.stopped) this.finalStatus = { status: 'aborted' };
    if (!this.finalStatus) {
      this.finalStatus = { status: 'blocked', blockedReason: 'unknown' };
      this.markRunFailed(
        'missing_terminal_event',
        'run finalized without a terminal SessionEvent',
        lastTs,
      );
    }
    this.reserveFinalizationTerminal(this.finalStatus, lastTs);
    if (this.active) {
      await this.input.hooks.unregisterRun(this.active, this);
    }
    const nextStatus =
      this.active && this.active.activeRuns.size > 0
        ? { status: 'running' as const }
        : (this.finalStatus ?? { status: 'active' as const });
    try {
      await this.input.hooks.updateHeader(this.sessionId, {
        lastUsedAt: lastTs,
        lastMessageAt: lastTs,
        hasUnread: true,
        ...buildStatusPatch(nextStatus.status, lastTs, nextStatus.blockedReason),
      });
    } catch {
      // The user-visible turn already completed; preserve existing behavior.
    }
    if (this.sawCompletion && this.recordsSessionMessages()) {
      await this.input.store
        .appendMessage(this.sessionId, {
          type: 'system_note',
          id: this.input.newId(),
          turnId: this.turnId,
          ts: lastTs,
          kind: 'session_resume',
        } satisfies SystemNoteMessage)
        .catch(() => {});
    }
    await this.finishRun(this.finalStatus, lastTs);
  }

  private recordsSessionMessages(): boolean {
    return this.input.recordSessionMessages !== false;
  }

  private async createRunRecord(continuation?: RuntimeContinuation): Promise<void> {
    if (!this.input.runStore) {
      if (continuation) throw new Error('Runtime continuation requires a durable run store');
      return;
    }
    const createdAt = this.input.now();
    const header: AgentRunHeader = {
      runId: this.runId,
      invocationId: this.invocationId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      status: 'created',
      backendKind: this.header.backend,
      llmConnectionSlug: this.header.llmConnectionSlug,
      modelId: this.header.model,
      cwd: this.header.cwd,
      ...(this.input.workspaceIdentity ? { workspaceIdentity: this.input.workspaceIdentity } : {}),
      permissionMode: this.header.permissionMode,
      collaborationMode: this.header.collaborationMode ?? 'agent',
      orchestrationMode: this.effectiveOrchestration.mode,
      orchestrationSource: this.effectiveOrchestration.source,
      agentSwarmAuthorization: this.effectiveOrchestration.agentSwarmAuthorization,
      createdAt,
      updatedAt: createdAt,
      ...this.lineage,
      ...(continuation
        ? {
            continuationSource: {
              sourceInvocationId: continuation.sourceInvocationId,
              sourceRunId: continuation.sourceRunId,
              sourceTurnId: continuation.sourceTurnId,
              sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
            },
          }
        : {}),
      ...(this.input.userInput.agentId ? { agentId: this.input.userInput.agentId } : {}),
      ...(this.input.userInput.agentName ? { agentName: this.input.userInput.agentName } : {}),
      ...(this.input.userInput.origin?.kind === 'automation'
        ? { automationId: this.input.userInput.origin.automationId }
        : {}),
      ...(this.input.userInput.origin?.kind === 'agent_graph'
        ? {
            agentGraphWakeId: this.input.userInput.origin.wakeId,
            agentGraphWakeAttemptId: this.input.userInput.origin.attemptId,
          }
        : {}),
    };
    try {
      const durable = this.requiresDurablePersistence();
      await this.input.runStore.createRun(header, { durable });
      await this.input.runStore.appendEvent(
        this.sessionId,
        this.runId,
        {
          type: 'run_created',
          id: this.input.newId(),
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: this.turnId,
          ts: createdAt,
          data: {
            textLength: this.input.userInput.text.length,
            attachmentCount: this.input.userInput.attachments?.length ?? 0,
            orchestrationMode: this.effectiveOrchestration.mode,
            orchestrationSource: this.effectiveOrchestration.source,
            agentSwarmAuthorization: this.effectiveOrchestration.agentSwarmAuthorization,
          },
        },
        { durable },
      );
    } catch (error) {
      this.runStoreAvailable = false;
      if (this.requiresDurablePersistence()) throw error;
      this.enqueueTraceWriteFailure(error);
      if (continuation) throw error;
    }
  }

  private requiresDurablePersistence(): boolean {
    return this.input.durability === 'required';
  }

  private async buildPriorRuntimeContext(): Promise<PriorRuntimeContext | undefined> {
    return await buildPriorRuntimeContextProjection({
      sessionId: this.sessionId,
      currentRunId: this.runId,
      currentTurnId: this.turnId,
      parentRunId: this.lineage.parentRunId,
      resumedFromRunId: this.lineage.resumedFromRunId,
      agentId: this.input.userInput.agentId,
      linkedChildSession: this.input.header.subagentParent?.kind === 'subagent',
      runStore: this.input.runStore,
      runtimeEventStore: this.input.runtimeEventStore,
      runStoreAvailable: this.runStoreAvailable,
      runtimeEventStoreAvailable: this.runtimeEventStoreAvailable,
      repairRunRuntimeLedger: this.input.repairRunRuntimeLedger,
      readMessages: () => this.input.store.readMessages(this.sessionId),
    });
  }

  private async markRunStarted(ts: number): Promise<void> {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    const durable = this.requiresDurablePersistence();
    const write = this.enqueueRunStore(
      'mark run started',
      async () => {
        await this.input.runStore?.appendEvent(
          this.sessionId,
          this.runId,
          {
            type: 'run_started',
            id: this.input.newId(),
            runId: this.runId,
            sessionId: this.sessionId,
            turnId: this.turnId,
            ts,
          },
          { durable },
        );
        await this.input.runStore?.updateRun(
          this.sessionId,
          this.runId,
          { status: 'running', updatedAt: ts },
          { durable },
        );
      },
      { rethrow: durable },
    );
    if (durable) await write;
  }

  private async recordStatusFromTransition(
    ev: SessionEvent,
    transition: { status: SessionStatus; blockedReason?: SessionBlockedReason },
    ts: number,
  ): Promise<void> {
    const durable = this.requiresDurablePersistence();
    const runStore = this.input.runStore;
    if (!runStore) {
      if (durable) {
        throw new Error('AgentRun store is unavailable for a required status transition');
      }
      return;
    }
    const status =
      transition.status === 'waiting_for_user'
        ? 'waiting_for_user'
        : transition.status === 'aborted'
          ? 'cancelled'
          : transition.status === 'blocked'
            ? 'failed'
            : transition.status === 'active'
              ? 'completed'
              : 'running';
    if (isTerminalRunStatus(status)) return;
    const appendAudit = async (): Promise<void> => {
      await runStore.appendEvent(
        this.sessionId,
        this.runId,
        {
          type: 'run_status_changed',
          id: this.input.newId(),
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: this.turnId,
          ts,
          data: {
            sessionStatus: transition.status,
            ...(transition.blockedReason ? { blockedReason: transition.blockedReason } : {}),
          },
        },
        { durable },
      );
    };
    if (durable) {
      await this.enqueueRequiredRunStoreWrite('record required run status', async () => {
        await runStore.updateRun(
          this.sessionId,
          this.runId,
          { status, updatedAt: ts },
          { durable: true },
        );
      });
      this.enqueueRunStore('append run status audit', appendAudit);
    } else {
      this.enqueueRunStore('record run status', async () => {
        await runStore.updateRun(this.sessionId, this.runId, { status, updatedAt: ts });
        await appendAudit();
      });
    }
    if (ev.type === 'abort') {
      this.markRunCancelled(ev.reason, ts);
    }
  }

  private markRunFailed(failureClass: string, message: string, ts: number): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    this.failureClass = failureClass;
    this.failureMessage = redactTraceString(message);
    if (this.input.runtimeEventStore) return;
    this.enqueueRunStore('mark run failed', async () => {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, {
        status: 'failed',
        updatedAt: ts,
        completedAt: ts,
        failureClass,
        failureMessage: this.failureMessage,
      });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'run_failed',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts,
        message: redactTraceString(message),
        data: { failureClass },
      });
    });
  }

  private markRunCancelled(reason: string | undefined, ts: number): void {
    if (!this.input.runStore || !this.runStoreAvailable) return;
    if (this.input.runtimeEventStore) return;
    this.enqueueRunStore('mark run cancelled', async () => {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, {
        status: 'cancelled',
        updatedAt: ts,
        completedAt: ts,
      });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'run_cancelled',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts,
        ...(reason ? { message: redactTraceString(reason) } : {}),
      });
    });
  }

  private async finishRun(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): Promise<void> {
    await this.traceQueue.catch(() => {});
    if (!this.input.runStore || !this.runStoreAvailable) return;
    const status = this.runStatusForFinalStatus(finalStatus);
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    if (isTerminal && this.input.runtimeEventStore) {
      await this.commitTerminalRun(finalStatus, ts);
      return;
    }
    await this.enqueueRunStore('finish run', async () => {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, {
        status,
        updatedAt: ts,
        ...(isTerminal ? { completedAt: ts } : {}),
        ...(status === 'failed'
          ? {
              failureClass: this.failureClass ?? finalStatus?.blockedReason ?? 'unknown',
              ...(this.failureMessage ? { failureMessage: this.failureMessage } : {}),
            }
          : {}),
      });
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type:
          status === 'cancelled'
            ? 'run_cancelled'
            : status === 'failed'
              ? 'run_failed'
              : status === 'completed'
                ? 'run_completed'
                : 'run_status_changed',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts,
        ...(status === 'failed'
          ? { data: { failureClass: this.failureClass ?? finalStatus?.blockedReason ?? 'unknown' } }
          : status === 'waiting_for_user'
            ? {
                data: {
                  sessionStatus: 'waiting_for_user',
                  blockedReason: finalStatus?.blockedReason ?? 'permission_required',
                },
              }
            : {}),
      });
    });
    await this.traceQueue.catch(() => {});
  }

  private runStatusForFinalStatus(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
  ): AgentRunHeader['status'] {
    if (this.stopped || finalStatus?.status === 'aborted') return 'cancelled';
    if (this.failureClass || finalStatus?.status === 'blocked') return 'failed';
    if (finalStatus?.status === 'waiting_for_user') return 'waiting_for_user';
    return 'completed';
  }

  private async commitTerminalRun(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): Promise<void> {
    if (this.terminalRunHeaderCommitted) return;
    const runStore = this.input.runStore;
    const runtimeEventStore = this.input.runtimeEventStore;
    if (
      !runStore ||
      !this.runStoreAvailable ||
      !runtimeEventStore ||
      !this.runtimeEventStoreAvailable
    )
      return;
    const fallbackStatus =
      this.stopped || finalStatus?.status === 'aborted' ? 'cancelled' : 'failed';
    const fallbackFailureClass = 'missing_terminal_event';
    const fallbackFailureMessage =
      this.failureMessage ?? 'run finalized without a terminal RuntimeEvent';
    try {
      const terminalClaim = this.terminalClaim;
      const terminalEvent = terminalClaim?.event;
      if (!terminalEvent) throw new Error('terminal RuntimeEvent claim is missing');
      await terminalClaim.write;
      if (this.continuationActive) {
        await this.input.continuationFailpoint?.('after_terminal_event_committed');
      }
      const commit = commitOrCreateTerminalRunFact({
        runStore,
        runtimeEventStore,
        newId: this.input.newId,
        sessionId: this.sessionId,
        runId: this.runId,
        turnId: this.turnId,
        ts,
        terminalEvent,
        ...((this.failureClass ?? finalStatus?.blockedReason)
          ? { failureClass: this.failureClass ?? finalStatus?.blockedReason }
          : {}),
        ...(this.failureMessage ? { failureMessage: this.failureMessage } : {}),
        ...(this.traceWriteError ? { traceWriteError: this.traceWriteError } : {}),
        ...(this.abortSource || fallbackStatus === 'cancelled'
          ? { abortSource: this.abortSource ?? 'user_stop' }
          : {}),
        fallbackStatus,
        fallbackInvocationId: this.runId,
        ...(fallbackStatus === 'failed' ? { fallbackFailureClass, fallbackFailureMessage } : {}),
        allowHeaderCommitFailure: true,
      });
      if (!terminalClaim.write) {
        terminalClaim.write = commit.then(() => undefined);
        void terminalClaim.write.catch(() => {});
      }
      const result = await commit;
      this.terminalRunHeaderCommitted = result.headerCommitted;
      if (result.headerCommitted && this.continuationActive) {
        await this.input.continuationFailpoint?.('after_terminal_header_committed');
      }
      if (result.headerCommitError !== undefined) {
        await this.enqueueTraceWriteFailure(result.headerCommitError, 'commit terminal run header');
      }
    } catch (error) {
      this.runStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, 'commit terminal run header');
      throw error;
    }
    await this.traceQueue.catch(() => {});
  }

  private reserveFinalizationTerminal(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): void {
    if (this.terminalClaim?.event) return;
    const runStatus = this.runStatusForFinalStatus(finalStatus);
    if (runStatus !== 'completed' && runStatus !== 'failed' && runStatus !== 'cancelled') return;
    const status =
      this.terminalClaim?.owner === 'stop' || this.stopped || finalStatus?.status === 'aborted'
        ? 'cancelled'
        : 'failed';
    const failureClass = 'missing_terminal_event';
    const failureMessage = this.failureMessage ?? 'run finalized without a terminal RuntimeEvent';
    if (status === 'failed') {
      this.failureClass = failureClass;
      this.failureMessage = failureMessage;
    }
    this.reserveTerminalEvent(
      buildSyntheticTerminalRuntimeEvent({
        id: this.input.newId(),
        invocationId: this.invocationId,
        run: { sessionId: this.sessionId, runId: this.runId, turnId: this.turnId },
        status,
        ts,
        ...(status === 'failed' ? { failureClass, message: failureMessage } : {}),
        ...(status === 'cancelled' ? { abortSource: this.abortSource ?? 'user_stop' } : {}),
      }),
    );
  }

  private enqueueRunStore(
    label: string,
    operation: () => Promise<void>,
    options: { rethrow?: boolean } = {},
  ): Promise<void> {
    if (!this.input.runStore || !this.runStoreAvailable) return Promise.resolve();
    const next = this.traceQueue.then(operation, operation).catch(async (error) => {
      this.runStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, label);
      if (options.rethrow) throw error;
    });
    this.traceQueue = next.catch(() => {});
    return next;
  }

  /**
   * Each physical provider request gets its own best-effort diagnostic row.
   * One failed attempt append must not suppress later attempts or poison the
   * general AgentRun store latch; a required capture independently gates every
   * provider dispatch.
   */
  private enqueueBestEffortProviderAttempt(label: string, operation: () => Promise<void>): void {
    const next = this.traceQueue
      .then(operation, operation)
      .catch((error) => this.enqueueTraceWriteFailure(error, label));
    this.traceQueue = next.catch(() => {});
  }

  /**
   * Serialize a required Run-store write without consulting the best-effort
   * latch. A successful required write proves the store is available again;
   * a failed operation rejects its caller without changing the general latch.
   */
  private enqueueRequiredRunStoreWrite(
    label: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const probe = async (): Promise<void> => {
      await operation();
      this.runStoreAvailable = true;
    };
    const next = this.traceQueue.then(probe, probe).catch(async (error) => {
      await this.enqueueTraceWriteFailure(error, label);
      throw error;
    });
    this.traceQueue = next.catch(() => {});
    return next;
  }

  /**
   * Read-back disambiguation for a failed durability-required append: true
   * only when the ledger demonstrably contains the event. Any doubt (no
   * read-back capability, read failure, event absent) reports false so the
   * caller stays fail-closed.
   */
  private async eventLandedInLedger(eventId: string): Promise<boolean> {
    const store = this.input.runtimeEventStore;
    if (!store?.readImmutableRuntimeEvents) return false;
    try {
      const events = await store.readImmutableRuntimeEvents(this.sessionId, this.runId);
      return events.some((event) => event.id === eventId);
    } catch {
      return false;
    }
  }

  private enqueueRuntimeEventStore(
    label: string,
    operation: () => Promise<void>,
    options: { rethrow?: boolean } = {},
  ): Promise<void> {
    if (!this.input.runtimeEventStore || !this.runtimeEventStoreAvailable) return Promise.resolve();
    const next = this.runtimeEventQueue.then(operation, operation).catch(async (error) => {
      this.runtimeEventStoreAvailable = false;
      this.runtimeEventStoreFailure = error;
      await this.enqueueTraceWriteFailure(error, label);
      if (options.rethrow) throw error;
    });
    this.runtimeEventQueue = next.catch(() => {});
    return next;
  }

  private async enqueueTraceWriteFailure(
    error: unknown,
    label = 'agent run store write',
  ): Promise<void> {
    const message = errorMessage(error);
    this.traceWriteError ??= `${label}: ${message}`;
    try {
      await this.input.runStore?.updateRun(this.sessionId, this.runId, {
        traceWriteError: this.traceWriteError,
        updatedAt: this.input.now(),
      });
    } catch {
      // The terminal header commit retries the in-memory latch.
    }
    try {
      await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
        type: 'trace_write_failed',
        id: this.input.newId(),
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts: this.input.now(),
        message,
      });
    } catch {
      // Diagnostic persistence is best effort; never perturb model/tool execution.
    }
  }
}

function traceToRunEvent(event: RunTraceEvent, runId: string): AgentRunEvent {
  return {
    type: event.type,
    id: event.id,
    runId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    ts: event.ts,
    message: redactTraceString(event.message),
    data: sanitizeTraceData(event.data),
  };
}

function sanitizeTraceData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, sanitizeTraceValue(value)]),
  );
}

function sanitizeTraceValue(value: unknown): unknown {
  if (typeof value === 'string') return redactTraceString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeTraceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, nested]) => [key, sanitizeTraceValue(nested)]),
    );
  }
  return value;
}

function redactTraceString(value: string): string {
  const redacted = redactSecrets(value);
  return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}...[truncated]` : redacted;
}

function errorMessage(error: unknown): string {
  return redactTraceString(error instanceof Error ? error.message : String(error));
}
function isInteractionResumeAck(event: SessionEvent): boolean {
  return (
    event.type === 'sandbox_boundary_decision_ack' || event.type === 'user_question_answer_ack'
  );
}

/**
 * Non-terminal error content never reaches the ledger: the trailing terminal
 * event carries the failure. Exported so readers can reason about which mapped
 * RuntimeEvents a projection will ever be asked to read.
 */
export function isNonTerminalErrorRuntimeEvent(event: RuntimeEvent): boolean {
  return event.content?.kind === 'error' && !isTerminalRuntimeEvent(event);
}

function isAtomicToolBoundaryProjection(
  event: RuntimeEvent,
  protocol: ToolBoundaryProtocol | undefined,
): boolean {
  if (!protocol || event.refs?.operationId === undefined) return false;
  return event.content?.kind === 'function_call' || event.content?.kind === 'function_response';
}
