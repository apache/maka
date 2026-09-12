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

import type { AgentRunEvent, AgentRunStore, EmittedAgentRunEvent } from '@maka/core/agent-run';
import { RUN_COMPOSITION_RECORDED_EVENT_TYPE } from '@maka/core/agent-run';
import type {
  RuntimeEvent,
  RuntimeEventInvocationOpenedContent,
  RuntimeInvocationRootAuthority,
  ToolBoundaryProtocol,
} from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import { isRuntimeHandoffPause, type RuntimeHandoffIntent } from '@maka/core/runtime-handoff';
import { RunHandoffGate, type RunHandoffRequest } from './run-handoff-gate.js';
import { preserveHandoffOpening } from './runtime-resume.js';
import type {
  RequestCompositionSnapshot,
  RequestCompositionSnapshotInput,
  RunCompositionSnapshot,
} from '@maka/core/run-composition';
import {
  createRequestCompositionSnapshot,
  decodeRequestCompositionSnapshot,
  decodeRunCompositionSnapshot,
} from '@maka/core/run-composition';
import { DurableStoreWriteError, RunSealedError } from '@maka/core/runtime-event-store';
import {
  buildInvocationOpenedEvent,
  buildSyntheticTerminalRuntimeEvent,
  isSessionInlineInvocation,
} from '@maka/core/runtime-invocation';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import type { RuntimeInvocationLineage } from '@maka/core/runtime-event';
import {
  MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import {
  ToolLedgerCorruptionError,
  ToolLedgerRejectionError,
} from '@maka/core/tool-ledger-scanner';
import type { ModelCallCommit } from '@maka/core/agent-run';

import { stableHash } from './request-shape.js';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { redactSecrets } from '@maka/core/redaction';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { MODEL_FAILURE_MESSAGE_MAX_BYTES } from '@maka/core/model-failure';
import {
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type {
  SessionBlockedReason,
  SessionHeader,
  SessionHeaderPatch,
  SessionStatus,
  RuntimeSystemNoteKind,
  UserMessage,
  AssistantMessage,
} from '@maka/core/session';
import type { UserMessageInput } from '@maka/core/runtime-inputs';
import {
  resolveEffectiveOrchestration,
  type EffectiveOrchestration,
} from '@maka/core/orchestration';
import type { SessionEvent } from '@maka/core/events';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import type { RunTraceEvent } from './run-trace.js';
import type { StopSessionInput } from './session-manager.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';
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
import { admittedPromptEventId } from './message-authority.js';
import { commitOrCreateTerminalRunFact } from './terminal-run-commit.js';
import type { RuntimeContinuation } from './runtime-resume.js';
import {
  createRuntimeContinuationStartAdmissionProof,
  type RuntimeContinuationStartAdmissionProof,
} from './runtime-continuation-admission.js';
import { DEFAULT_TOOL_MODE, isToolMode, type ToolMode } from '@maka/core/tool-mode';
import { cloneAndFreezeRuntimeSnapshot } from './runtime-snapshot.js';
import { projectRuntimeEventUserMessage } from './runtime-event-read-model.js';

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
  updateHeader(sessionId: string, patch: SessionHeaderPatch): Promise<SessionHeader>;
  updateStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
    ts?: number,
  ): Promise<void>;
  /**
   * The catalog facts a durable message carries — its time, the Session list's
   * preview line, and the connection lock a Session takes on its first user
   * message. The transcript write used to commit these on its way to disk; the
   * ledger is not that store, so the run commits them here instead.
   */
  commitMessageProjection?(
    sessionId: string,
    message: UserMessage | AssistantMessage,
  ): Promise<void>;
}

export type AgentRunLineage = Partial<
  Pick<RuntimeInvocationLineage, 'parentRunId' | 'resumedFromRunId' | 'retriedFromRunId'> &
    Pick<
      UserMessageInput,
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
  /** Internal lineage for runtime-owned continuations; never accepted by live turn input. */
  runLineage?: AgentRunLineage;
  rootExecutionKind?: 'context_compact';
  runId?: string;
  userMessageId?: string | null;
  durability?: AgentRunDurability;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  newId: () => string;
  now: () => number;
  workspaceIdentity?: string;
  continuationFailpoint?: (point: RuntimeContinuationFailpoint) => Promise<void>;
  /** Exact target opening fact already committed inside the durable continuation claim. */
  claimedOpening?: RuntimeEventInvocationOpenedContent;
  /** Authenticated source authority is not part of provider-visible replay. */
  handoffSourceOpening?: RuntimeEventInvocationOpenedContent;
  /** Durable composition of the authenticated sealed handoff source. */
  handoffSourceComposition?: RunCompositionSnapshot;
  /** The moment that claim was taken; the target invocation opens at it. */
  claimedOpenedAt?: number;
  /** Commits the claimed continuation provider-call T1 after Run creation. */
  commitContinuationStart?: (startedAt: number) => Promise<{ startEventId: string; created: true }>;
  hooks: AgentRunHooks;
  invocationId?: string;
  /** Pre-resolved snapshot used by continuations; normal turns derive it from header + input. */
  effectiveOrchestration?: EffectiveOrchestration;
  /** Pre-resolved tool protocol used by continuations. */
  effectiveToolMode?: ToolMode;
  /** Set only when this run's backend tool path is guarded by canonical T1. */
  toolBoundaryProtocol?: ToolBoundaryProtocol;
}

export type RuntimeContinuationFailpoint =
  | 'after_continuation_claim_committed'
  | 'after_continuation_start_committed'
  | 'after_terminal_event_committed';

export class ContinuationStartCommitError extends Error {
  readonly name = 'ContinuationStartCommitError';

  constructor(readonly storeCause: unknown) {
    super(
      `Continuation start was not durably committed: ${
        storeCause instanceof Error ? storeCause.message : String(storeCause)
      }`,
    );
  }
}

export interface AgentRunBeginResult {
  backend: AgentBackend;
  backendInput: BackendSendInput;
  initialRuntimeEvent: RuntimeEvent;
}

export interface AgentRunOperationBeginResult {
  backend: AgentBackend;
  runtimeContext: RuntimeEvent[];
  runtimeContextInvocations: RuntimeInvocationRecord[];
  startedAt: number;
}

export interface AgentRunContinuationBeginResult {
  backend: AgentBackend;
  startedAt: number;
  continuationStartAdmission: RuntimeContinuationStartAdmissionProof;
}

const RUNTIME_PARTIAL_FLUSH_INTERVAL_MS = 80;
const RUNTIME_PARTIAL_BATCH_MAX_BYTES = 8 * 1024;

export interface AgentRunHandoffRequest extends RunHandoffRequest {
  readonly sealed: Promise<boolean>;
  /** Hypothetical seal for read-only replay validation while the live gate is held. */
  preview(): RuntimeEvent;
}

export class AgentRun {
  readonly runId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolBoundaryProtocol: ToolBoundaryProtocol | undefined;
  readonly lineage: AgentRunLineage;
  readonly effectiveOrchestration: EffectiveOrchestration;
  readonly toolMode: ToolMode;

  private readonly input: AgentRunInput;
  private readonly header: SessionHeader;
  private active: AgentRunActiveSession | undefined;
  private stopped = false;
  private abortSource: string | undefined;
  private traceQueue: Promise<void> = Promise.resolve();
  private runtimeEventQueue: Promise<void> = Promise.resolve();
  private runStoreAvailable = true;
  private runtimeEventStoreAvailable = true;
  private runtimeEventStoreFailure: unknown;
  private lastAssistantPreview: AssistantMessage | undefined;
  private runtimePartialStreamKey: string | undefined;
  private runtimePartialBuffer: RuntimeEvent[] = [];
  private runtimePartialBufferBytes = 0;
  private runtimePartialFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private traceWriteError: string | undefined;
  private runComposition: RunCompositionSnapshot | undefined;
  private runCompositionWrite: Promise<void> | undefined;
  private runCompositionCommitted = false;
  private requestComposition: RequestCompositionSnapshot | undefined;
  private requestCompositionIndex: Map<string, RequestCompositionSnapshot> | undefined;
  private requestCompositionIndexRead: Promise<void> | undefined;
  private failureClass: string | undefined;
  private failureMessage: string | undefined;
  private lastTs = 0;
  private sawCompletion = false;
  private finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined;
  private turnFailed = false;
  private finalized = false;
  private readonly handoffGate = new RunHandoffGate();
  private handoffRequest:
    | {
        pause: RuntimeHandoffIntent;
        preview?: RuntimeEvent;
        committed: boolean;
        settle(sealed: boolean): void;
        fail(error: unknown): void;
      }
    | undefined;
  private handoffPaused = false;
  private terminalRunFactCommitted = false;
  private continuationActive = false;
  private providerStateIdentity: `sha256:${string}` | undefined;
  private invocationOpening: RuntimeEventInvocationOpenedContent | undefined;
  private invocationOpeningCommitted = false;
  /** Set once `begin()` owes this run's prompt, cleared once the ledger has it. */
  private initialRuntimeEventPending = false;
  private terminalClaim:
    | {
        owner: 'event' | 'stop';
        event?: RuntimeEvent;
        write?: Promise<void>;
        stopCompleted?: boolean;
      }
    | undefined;

  constructor(input: AgentRunInput) {
    const acceptedInput: AgentRunInput = {
      ...input,
      userInput: cloneAndFreezeRuntimeSnapshot(input.userInput),
      ...(input.effectiveOrchestration
        ? { effectiveOrchestration: cloneAndFreezeRuntimeSnapshot(input.effectiveOrchestration) }
        : {}),
      ...(input.handoffSourceComposition
        ? { handoffSourceComposition: decodeRunCompositionSnapshot(input.handoffSourceComposition) }
        : {}),
    };
    this.input = acceptedInput;
    if (acceptedInput.runStore && !acceptedInput.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    if (
      acceptedInput.durability === 'required' &&
      (!acceptedInput.runStore || !acceptedInput.runtimeEventStore)
    ) {
      throw new Error('Required AgentRun durability needs AgentRunStore and RuntimeEventStore');
    }
    this.runId = acceptedInput.runId ?? acceptedInput.newId();
    this.invocationId = acceptedInput.invocationId ?? this.runId;
    this.sessionId = acceptedInput.sessionId;
    this.turnId = acceptedInput.userInput.turnId;
    this.toolBoundaryProtocol = acceptedInput.toolBoundaryProtocol;
    this.header = acceptedInput.header;
    this.effectiveOrchestration =
      acceptedInput.effectiveOrchestration ??
      resolveEffectiveOrchestration(
        acceptedInput.header.orchestrationMode,
        acceptedInput.userInput.turnOrchestration,
      );
    if (
      acceptedInput.userInput.toolMode !== undefined &&
      !isToolMode(acceptedInput.userInput.toolMode)
    ) {
      throw new Error(`Invalid tool mode: ${String(acceptedInput.userInput.toolMode)}`);
    }
    const requestedToolMode =
      acceptedInput.effectiveToolMode ??
      acceptedInput.header.toolMode ??
      acceptedInput.userInput.toolMode ??
      DEFAULT_TOOL_MODE;
    if (!isToolMode(requestedToolMode)) {
      throw new Error(`Invalid tool mode: ${String(requestedToolMode)}`);
    }
    this.toolMode = requestedToolMode;
    this.lineage = {
      ...acceptedInput.runLineage,
      ...(acceptedInput.userInput.parentTurnId
        ? { parentTurnId: acceptedInput.userInput.parentTurnId }
        : {}),
      ...(acceptedInput.userInput.retriedFromTurnId
        ? { retriedFromTurnId: acceptedInput.userInput.retriedFromTurnId }
        : {}),
      ...(acceptedInput.userInput.regeneratedFromTurnId
        ? { regeneratedFromTurnId: acceptedInput.userInput.regeneratedFromTurnId }
        : {}),
      ...(acceptedInput.userInput.branchOfTurnId
        ? { branchOfTurnId: acceptedInput.userInput.branchOfTurnId }
        : {}),
      ...(acceptedInput.userInput.parentSessionId
        ? { parentSessionId: acceptedInput.userInput.parentSessionId }
        : {}),
    };
  }

  stop(
    source: StopSessionInput['source'] | undefined,
    workHubActionId?: StopSessionInput['workHubActionId'],
  ): boolean {
    const abortSource = normalizeStopSessionSource(source, workHubActionId);
    if (this.terminalClaim) return false;
    this.terminalClaim = { owner: 'stop' };
    this.stopped = true;
    this.handoffGate.close();
    this.abortSource = abortSource;
    return true;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  requestHandoff(pause: RuntimeHandoffIntent, signal: AbortSignal): AgentRunHandoffRequest {
    if (
      this.handoffRequest ||
      this.finalized ||
      this.terminalClaim ||
      this.input.runtimeEventStore?.durability !== 'canonical' ||
      !this.toolBoundaryProtocol ||
      Object.hasOwn(pause, 'remainingSteps') ||
      !isRuntimeHandoffPause({ ...pause, remainingSteps: null }) ||
      !this.invocationOpening ||
      pause.rootRunId !==
        (this.invocationOpening.source.kind === 'handoff'
          ? this.invocationOpening.source.rootRunId
          : this.runId)
    ) {
      throw new Error('Run cannot reserve a cooperative handoff');
    }
    let settle!: (sealed: boolean) => void;
    let fail!: (error: unknown) => void;
    const sealed = new Promise<boolean>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    void sealed.catch(() => {});
    const pending = {
      pause: cloneAndFreezeRuntimeSnapshot(pause),
      preview: undefined as RuntimeEvent | undefined,
      committed: false,
      settle: (value: boolean) => {
        signal.removeEventListener('abort', onAbort);
        settle(value);
      },
      fail: (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        fail(error);
      },
    };
    this.handoffRequest = pending;
    const gate = this.handoffGate.request(signal);
    const cancel = () => {
      if (pending.committed || this.handoffRequest !== pending) return;
      gate.cancel();
      this.handoffRequest = undefined;
      pending.settle(false);
    };
    const onAbort = () => cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) cancel();
    void gate.ready.then((ready) => {
      if (!ready) cancel();
    });
    return {
      ready: gate.ready,
      sealed,
      cancel,
      preview: () => {
        if (
          this.handoffRequest !== pending ||
          this.stopped ||
          pending.committed ||
          !pending.preview
        ) {
          throw new Error('Handoff preview requires the currently held Runtime boundary');
        }
        this.assertRunCompositionCommitted();
        return pending.preview;
      },
      commit: () => {
        this.assertRunCompositionCommitted();
        if (this.handoffRequest !== pending || !gate.commit()) return false;
        pending.committed = true;
        return true;
      },
    };
  }

  async reachHandoffBoundary(
    signal: AbortSignal,
    remainingSteps: number | null,
  ): Promise<'continue' | 'pause'> {
    if (remainingSteps !== null && (!Number.isSafeInteger(remainingSteps) || remainingSteps <= 0)) {
      throw new Error('Invalid handoff step budget');
    }
    const pending = this.handoffRequest;
    if (pending) {
      pending.preview = cloneAndFreezeRuntimeSnapshot({
        id: this.input.newId(),
        sessionId: this.sessionId,
        runId: this.runId,
        invocationId: this.invocationId,
        turnId: this.turnId,
        ts: this.input.now(),
        partial: false,
        role: 'system',
        author: 'host',
        modelVisibility: 'hidden',
        actions: { endInvocation: true, handoffPause: { ...pending.pause, remainingSteps } },
      });
    }
    const decision = await this.handoffGate.reachBoundary(signal);
    if (decision === 'pause') {
      this.handoffPaused = true;
    }
    return decision;
  }

  hasCommittedHandoff(): boolean {
    return (
      this.handoffPaused &&
      this.handoffRequest?.committed === true &&
      !this.stopped &&
      !this.failureClass &&
      !this.terminalClaim
    );
  }

  headerSnapshot(): SessionHeader {
    return this.header;
  }

  bindProviderStateIdentity(identity: `sha256:${string}` | undefined): void {
    const claimed = claimedProviderStateIdentity(this.input.claimedOpening);
    const expected = claimed ?? this.providerStateIdentity;
    if (expected !== undefined && expected !== identity) {
      throw new Error('Prepared backend provider state does not match the AgentRun admission');
    }
    this.providerStateIdentity = identity;
  }

  isSessionInline(): boolean {
    const opening = this.invocationOpening;
    if (opening) return isSessionInlineInvocation(opening);
    // Before the opening fact exists there is only the lineage the turn was
    // admitted with, which decides the same question the same way.
    return this.lineage.parentRunId === undefined;
  }

  hasPendingStop(): boolean {
    return this.terminalClaim?.owner === 'stop' && this.terminalClaim.stopCompleted !== true;
  }

  completeStop(): void {
    if (this.terminalClaim?.owner === 'stop') this.terminalClaim.stopCompleted = true;
  }

  /**
   * Cash the terminal claim a stop already took.
   *
   * `stop()` claims the terminal outcome, but only `finalize()` — reached when
   * the backend's event stream ends — has ever cashed it. A turn parked on an
   * unanswered interaction never ends that stream, so the Session projection
   * read as aborted while the run stayed non-terminal in the ledger forever,
   * and every later turn dropped it from model context. Cash the claim at the
   * stop instead. The claim keeps this idempotent: a stream that later
   * produces its own terminal event finds the claim taken and writes nothing.
   */
  async settleStopTerminal(): Promise<void> {
    if (this.terminalClaim?.owner !== 'stop' || this.terminalRunFactCommitted) return;
    // Nothing durable is configured, so there is no fact to land. Every other
    // failure below is real and must reach the stop's caller: a stop that
    // reports success while the run stays non-terminal is the silent loss this
    // method exists to prevent.
    const runStore = this.input.runStore;
    if (!this.input.runtimeEventStore || !runStore) return;
    await this.flushRuntimePartialBuffer(true);
    // The claim only fences writers inside this Run. Another owner — a Host
    // recovery, a resumed continuation — may have sealed the ledger already,
    // and a sealed run rejects further appends. Nothing to land in that case:
    // the fact this method exists to guarantee is already there. This claim's
    // own reserved event is not foreign — that is a settlement being retried.
    const claimedEventId = this.terminalClaim.event?.id;
    const events = await this.loadTurnRuntimeEvents();
    if (events.some((event) => isTerminalRuntimeEvent(event) && event.id !== claimedEventId))
      return;
    if (!this.runStoreAvailable) {
      // The Run-store latch is best-effort history (one busy trace append
      // sets it) and commitTerminalRun silently skips under it, which here
      // would turn the stop into a reported success with no terminal fact:
      // the silent variant of the loss this method exists to prevent.
      // Probe like the RuntimeEvent read above; a store that answers lifts
      // the latch, one that cannot fails the settlement loudly so the stop
      // stays retryable.
      try {
        await runStore.readEvents(this.sessionId, this.runId);
        this.runStoreAvailable = true;
      } catch (error) {
        throw new Error('AgentRun store is unavailable for stop settlement', { cause: error });
      }
    }
    const ts = this.lastTs || this.input.now();
    const finalStatus = { status: 'aborted' as const };
    this.finalStatus ??= finalStatus;
    this.reserveFinalizationTerminal(finalStatus, ts);
    const runStoreAvailable = this.runStoreAvailable;
    try {
      await this.commitTerminalRun(finalStatus, ts);
    } catch (error) {
      // This commit runs ahead of the stream's own finalize, so one failure is
      // not evidence the store is gone for the rest of the run. Undo the marks
      // that would turn a single failed attempt into a permanently unwritable
      // run, and let the caller decide whether to retry. The reserved event
      // stays, so a retry lands the same terminal fact rather than a new one.
      this.runStoreAvailable = runStoreAvailable;
      if (this.terminalClaim) this.terminalClaim.write = undefined;
      throw error;
    }
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

  recordRunComposition(snapshot: RunCompositionSnapshot): Promise<void> {
    if (!this.input.runStore) {
      return Promise.reject(new Error('AgentRun store is not configured'));
    }
    const normalized = decodeRunCompositionSnapshot(snapshot);
    const expected = this.input.handoffSourceComposition;
    if (
      expected &&
      (normalized.baseSystemPromptHash !== expected.baseSystemPromptHash ||
        normalized.toolCatalogHash !== expected.toolCatalogHash ||
        normalized.toolAvailabilityHash !== expected.toolAvailabilityHash ||
        normalized.baseProviderOptionsHash !== expected.baseProviderOptionsHash ||
        normalized.contextWindow !== expected.contextWindow)
    ) {
      return Promise.reject(new Error('Handoff Run Composition execution semantics changed'));
    }
    if (this.runComposition && !isDeepStrictEqual(this.runComposition, normalized)) {
      return Promise.reject(new Error('AgentRun Run Composition changed after resolution'));
    }
    this.runComposition ??= normalized;
    if (this.runCompositionWrite) return this.runCompositionWrite;
    const write = this.enqueueRequiredRunStoreWrite('commit Run Composition', async () => {
      await this.input.runStore?.appendEvent(
        this.sessionId,
        this.runId,
        {
          type: RUN_COMPOSITION_RECORDED_EVENT_TYPE,
          id: this.input.newId(),
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: this.turnId,
          ts: this.input.now(),
          data: { runComposition: normalized },
        },
        {
          durable:
            this.requiresDurablePersistence() ||
            this.input.runtimeEventStore?.durability === 'canonical',
        },
      );
    }).then(() => {
      this.runCompositionCommitted = true;
    });
    this.runCompositionWrite = write;
    return write.catch((error: unknown) => {
      if (this.runCompositionWrite === write) this.runCompositionWrite = undefined;
      throw error;
    });
  }

  assertRunCompositionCommitted(): void {
    if (!this.runCompositionCommitted) {
      throw new Error('Cooperative handoff requires a durably committed Run Composition');
    }
  }

  /**
   * Durably binds one logical model step to its effective request surface.
   * Unchanged steps reuse the latest snapshot; a changed surface appends a full
   * replacement before provider dispatch, matching DSH request/header epochs.
   */
  async recordRequestComposition(input: RequestCompositionSnapshotInput): Promise<string> {
    if (!this.input.runStore) {
      throw new Error('AgentRun store is not configured');
    }
    await this.loadRequestCompositionIndex();
    const snapshot = createRequestCompositionSnapshot(
      input,
      this.requestCompositionIndex?.size ? 'change' : 'initial',
    );
    const surfaceHash = requestCompositionSurfaceHash(snapshot);
    const existing = this.requestCompositionIndex?.get(surfaceHash);
    if (existing) {
      if (!sameRequestCompositionSurface(existing, snapshot)) {
        throw new Error(`Request Composition surface hash collision: ${surfaceHash}`);
      }
      this.requestComposition = existing;
      return existing.compositionId;
    }
    await this.enqueueRequiredRunStoreWrite('append request composition', async () => {
      await this.input.runStore?.appendEvent(
        this.sessionId,
        this.runId,
        {
          type: 'request_composition_resolved',
          id: snapshot.compositionId,
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: this.turnId,
          ts: this.input.now(),
          data: { snapshot },
        },
        { durable: true },
      );
    });
    this.requestComposition = snapshot;
    this.requestCompositionIndex?.set(surfaceHash, snapshot);
    return snapshot.compositionId;
  }

  private async loadRequestCompositionIndex(): Promise<void> {
    if (this.requestCompositionIndex) return;
    if (this.requestCompositionIndexRead) return await this.requestCompositionIndexRead;
    const read = (async (): Promise<void> => {
      const index = new Map<string, RequestCompositionSnapshot>();
      const events = await this.input.runStore?.readEvents(this.sessionId, this.runId);
      for (const event of events ?? []) {
        if (event.type !== 'request_composition_resolved') continue;
        const snapshot = decodeRequestCompositionSnapshot(event.data?.snapshot);
        const surfaceHash = requestCompositionSurfaceHash(snapshot);
        const existing = index.get(surfaceHash);
        if (existing && !sameRequestCompositionSurface(existing, snapshot)) {
          throw new Error(`Request Composition surface hash collision: ${surfaceHash}`);
        }
        index.set(surfaceHash, existing ?? snapshot);
        this.requestComposition = snapshot;
      }
      this.requestCompositionIndex = index;
    })();
    this.requestCompositionIndexRead = read;
    try {
      await read;
    } finally {
      if (this.requestCompositionIndexRead === read) this.requestCompositionIndexRead = undefined;
    }
  }

  /**
   * Canonical accounting record for one physical provider request (#1679).
   *
   * Durable, unlike the diagnostic attempt append above: this is the metering
   * source of truth, and a record lost to a crashed flush is spend nothing else
   * can reconstruct.
   *
   * It reports the failure as `trace_write_failed` and then rejects, so the
   * caller can tell whether the authority actually holds the record — the Usage
   * read model must not be written for a call the authority never committed.
   * Rejecting here is safe: settlement runs inside the model stream's `pull`
   * handler, and the seam swallows this so a billed, completed response is
   * never failed by its own bookkeeping.
   */
  recordModelCallAttempt(commit: ModelCallCommit<ModelCallAttempt>): Promise<void> {
    const { attempt, latestContext } = commit;
    if (!this.input.runStore) return Promise.resolve();
    return this.enqueueRequiredRunStoreWrite('append model call attempt', async () => {
      await this.input.runStore?.appendEvent(
        this.sessionId,
        this.runId,
        {
          type: MODEL_CALL_ATTEMPT_EVENT_TYPE,
          id: attempt.attemptId,
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: attempt.turnId,
          ts: attempt.completedAt,
          data: { ...attempt },
        },
        // The latest-context projection rides this durable append rather than
        // racing it: one commit for the request, and derived state that cannot
        // survive a metering write that failed (#2323).
        { durable: true, ...(latestContext ? { latestContext } : {}) },
      );
    });
  }

  /**
   * Durable append for one model-projection transition (#4283).
   *
   * Rethrows like the checkpoint recorder above: the caller may only show the
   * replacement once the ledger holds the record, so a failed append must be a
   * failed prune, not a silent one.
   */
  recordModelProjectionTransition(transition: ModelProjectionTransition): Promise<void> {
    if (!this.input.runStore) return Promise.reject(new Error('AgentRun store is not configured'));
    if (!this.runStoreAvailable) return Promise.reject(new Error('AgentRun store is unavailable'));
    return this.enqueueRunStore(
      'append model projection transition',
      async () => {
        await this.input.runStore?.appendEvent(this.sessionId, this.runId, {
          type: MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
          id: transition.transitionId,
          runId: this.runId,
          sessionId: this.sessionId,
          turnId: this.turnId,
          ts: transition.createdAt,
          data: {
            runtimeEventId: transition.target.runtimeEventId,
            part: transition.target.part,
            transition,
          },
        });
      },
      { rethrow: true },
    );
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
    const store = this.input.runtimeEventStore;
    if (!store) {
      throw new Error('RuntimeEvent store is unavailable for turn runtime events');
    }
    await this.flushRuntimePartialBuffer(false);
    await this.runtimeEventQueue.catch(() => {});
    if (this.runtimeEventStoreAvailable) {
      return await store.readRuntimeEvents(this.sessionId, this.runId);
    }
    // The unavailability latch records that a past write failed, not that
    // the store cannot answer now. This read is the probe that
    // disambiguates, the same way recordRuntimeEvents reads the ledger back
    // after an ambiguous append: a store that answers is available again
    // and the latch lifts, so a stop retried after one rejected write can
    // still settle its terminal fact (#2253) instead of failing on stale
    // history forever. A store that cannot answer keeps rejecting, and
    // coverage is never computed over a projection the ledger cannot
    // replay.
    try {
      const events = await store.readRuntimeEvents(this.sessionId, this.runId);
      this.runtimeEventStoreAvailable = true;
      return events;
    } catch (error) {
      throw new Error('RuntimeEvent store is unavailable for turn runtime events', {
        cause: error,
      });
    }
  }

  async acceptMappedEvent(
    sessionEvent: SessionEvent,
    runtimeEvent: RuntimeEvent,
    options: { requireTerminalWrite?: boolean; allowInteractionResume?: boolean } = {},
  ): Promise<void> {
    const partialStreamKey = runtimePartialCoalescingKey(runtimeEvent);
    if (!partialStreamKey) await this.flushRuntimePartialBuffer(true);
    if (isTerminalRuntimeEvent(runtimeEvent)) {
      await this.recordRuntimeEvents([runtimeEvent], {
        requireTerminalWrite: options.requireTerminalWrite ?? Boolean(this.input.runtimeEventStore),
      });
      await this.recordSessionEvent(sessionEvent, options);
      await this.commitMessageProjection(this.lastAssistantPreview);
      return;
    }
    this.rememberAssistantPreview(runtimeEvent);
    if (this.requiresDurablePersistence() && isInteractionResumeAck(sessionEvent)) {
      // A hosted continuation may resume execution only after its identity-only
      // settlement fact is durable. Session status advances next, and the queue
      // consumer acknowledges the event only after both.
      await this.recordRuntimeEvents([runtimeEvent], { requireDurableWrite: true });
      await this.recordSessionEvent(sessionEvent, options);
      return;
    }
    await this.recordSessionEvent(sessionEvent, options);
    if (sessionEvent.type === 'provider_retry') return;
    if (partialStreamKey) {
      await this.recordRuntimePartial(runtimeEvent, partialStreamKey);
      return;
    }
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
      if (steering) {
        await this.commitMessageProjection(
          projectRuntimeEventUserMessage(runtimeEvent, runtimeEvent.id),
        );
      }
    }
  }

  /**
   * A user message is fail-CLOSED: it also takes the Session's connection lock,
   * and no other path re-derives that latch now that the transcript is not a
   * second authority. An assistant preview is fail-open — losing it costs a
   * stale sidebar entry, never the turn.
   */
  private async commitMessageProjection(
    message: UserMessage | AssistantMessage | undefined,
  ): Promise<void> {
    const commit = this.input.hooks.commitMessageProjection;
    if (!commit || !message) return;
    const committed = commit.call(this.input.hooks, this.sessionId, message);
    if (message.type === 'user') return committed;
    await committed.catch(() => {});
  }

  /**
   * The assistant text the Session list shows once the Turn ends.
   *
   * Kept as the run goes so the catalog costs one write per Turn rather than
   * one per streamed step, and read only after the terminal fact is durable —
   * a Turn that never spoke leaves the previous preview standing.
   */
  private rememberAssistantPreview(event: RuntimeEvent): void {
    if (event.role !== 'model' || event.content?.kind !== 'text') return;
    if (!event.content.text?.trim()) return;
    this.lastAssistantPreview = {
      type: 'assistant',
      id: event.id,
      turnId: event.turnId,
      ts: event.ts,
      text: event.content.text,
      modelId: this.header.model,
    };
  }

  private async beginUserTurn(): Promise<RuntimeEvent> {
    // Owed from here, not from after the opening: `openInvocation` can leave the
    // invocation open and still throw, and `finalize` reopens what it can.
    this.initialRuntimeEventPending = true;
    await this.openInvocation();

    this.lastTs = this.input.now();
    const initialRuntimeEvent = await this.recordInitialRuntimeEvent(this.lastTs);

    return initialRuntimeEvent;
  }

  /** Host actions share Turn facts and finalization without activating a provider. */
  async beginCoordination(): Promise<void> {
    await this.beginUserTurn();
    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, this.lastTs);
  }

  async begin(): Promise<AgentRunBeginResult> {
    const initialRuntimeEvent = await this.beginUserTurn();
    this.active = await this.input.hooks.reserveRun(this.sessionId, this.header, this);

    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, this.lastTs);

    const priorRuntimeContext = await this.buildPriorRuntimeContext();

    return {
      backend: this.active.backend,
      backendInput: cloneAndFreezeRuntimeSnapshot({
        turnId: this.turnId,
        orchestration: this.effectiveOrchestration,
        toolMode: this.toolMode,
        ...(this.input.userInput.maxSteps !== undefined
          ? { maxSteps: this.input.userInput.maxSteps }
          : {}),
        text: this.input.userInput.text,
        ...(this.input.userInput.attachments
          ? { attachments: this.input.userInput.attachments }
          : {}),
        ...(this.input.userInput.directoryReferences
          ? { directoryReferences: this.input.userInput.directoryReferences }
          : {}),
        ...(this.input.userInput.quotes ? { quotes: this.input.userInput.quotes } : {}),
        ...(priorRuntimeContext
          ? {
              runtimeContext: priorRuntimeContext.events,
              runtimeContextInvocations: priorRuntimeContext.invocations,
            }
          : {}),
      }),
      initialRuntimeEvent,
    };
  }

  /** Say what this run was asked to do. */
  private async recordInitialRuntimeEvent(ts: number): Promise<RuntimeEvent> {
    const event = cloneAndFreezeRuntimeSnapshot(
      this.buildInitialRuntimeEvent(
        admittedPromptEventId(this.runId, this.input.userMessageId),
        ts,
      ),
    );
    await this.recordRuntimeEvents([event], {
      requireDurableWrite: this.requiresDurablePersistence(),
    });
    // Owed until the catalog carries it too, not just until the ledger does:
    // the projection is where the connection lock latches, and re-recording the
    // event is free because its id is derived and the store dedupes it.
    await this.commitMessageProjection(projectRuntimeEventUserMessage(event, event.id));
    this.initialRuntimeEventPending = false;
    return event;
  }

  async beginOperation(): Promise<AgentRunOperationBeginResult> {
    await this.openInvocation();

    const startedAt = this.input.now();
    this.lastTs = startedAt;

    this.active = await this.input.hooks.reserveRun(this.sessionId, this.header, this);

    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, startedAt);

    const priorRuntimeContext = await this.buildPriorRuntimeContext();
    return {
      backend: this.active.backend,
      runtimeContext: priorRuntimeContext?.events ?? [],
      runtimeContextInvocations: priorRuntimeContext?.invocations ?? [],
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
    await this.openInvocation(continuation);
    const startedAt = this.input.now();
    this.lastTs = startedAt;
    if (!this.input.commitContinuationStart) {
      throw new Error('Runtime continuation requires a durable continuation-start authority');
    }
    let committedStart: { startEventId: string; created: true };
    try {
      committedStart = await this.input.commitContinuationStart(startedAt);
    } catch (error) {
      throw new ContinuationStartCommitError(error);
    }
    await this.input.continuationFailpoint?.('after_continuation_start_committed');

    this.active = await this.input.hooks.reserveRun(this.sessionId, this.header, this);
    await this.input.hooks.updateStatus(this.sessionId, 'running', undefined, startedAt);

    return {
      backend: this.active.backend,
      startedAt,
      continuationStartAdmission: createRuntimeContinuationStartAdmissionProof({
        startEventId: committedStart.startEventId,
        claimId: continuation.claimId ?? '',
        boundaryDigest: continuation.boundary?.manifestDigest ?? 'sha256:',
        providerProjectionVersion: continuation.providerProjectionVersion ?? 1,
        providerReplayDigest: continuation.providerReplayDigest ?? 'sha256:',
        ...(this.toolBoundaryProtocol ? { toolBoundaryProtocol: this.toolBoundaryProtocol } : {}),
        target: {
          sessionId: continuation.sessionId,
          invocationId: continuation.invocationId,
          runId: continuation.runId,
          turnId: continuation.turnId,
        },
      }),
    };
  }

  private buildInitialRuntimeEvent(id: string, ts: number): RuntimeEvent {
    const input = this.input.userInput;
    return {
      id,
      invocationId: this.invocationId,
      runId: this.runId,
      sessionId: this.sessionId,
      turnId: this.turnId,
      ts,
      partial: false,
      role: 'user',
      author: input.origin ? 'host' : 'user',
      content: {
        kind: 'text',
        text: input.text,
        ...(input.displayText !== undefined ? { displayText: input.displayText } : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        ...(input.attachments !== undefined && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
        ...(input.directoryReferences ? { directoryReferences: input.directoryReferences } : {}),
        ...(input.quotes !== undefined && input.quotes.length > 0 ? { quotes: input.quotes } : {}),
        ...(input.inlineReferences !== undefined
          ? { inlineReferences: input.inlineReferences }
          : {}),
      },
      // The marker belongs to the invocation's first event. Once an opening
      // fact exists it holds the marker, and a second copy here would read as
      // a stray marker to RecoveryResolver.
      ...(this.toolBoundaryProtocol && !this.invocationOpeningCommitted
        ? { actions: { runtimeProtocol: { toolBoundary: this.toolBoundaryProtocol } } }
        : {}),
    };
  }

  /**
   * Record something the runtime needs to tell the reader about this turn.
   *
   * It is a fact of the invocation, so it goes where the invocation's facts go.
   * Never model-visible: the note describes what happened to the conversation,
   * it is not part of it.
   */
  async recordSystemNote(kind: RuntimeSystemNoteKind, data?: unknown): Promise<void> {
    await this.recordRuntimeEvents([
      {
        id: this.input.newId(),
        invocationId: this.invocationId,
        runId: this.runId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        ts: this.input.now(),
        partial: false,
        role: 'system',
        author: 'system',
        modelVisibility: 'hidden',
        content: { kind: 'system_note', note: kind, ...(data !== undefined ? { data } : {}) },
      },
    ]);
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
        );
      }
    }
    if (transition && !this.stopped && ev.type !== 'error') {
      const updateSessionStatus = async (): Promise<void> => {
        if (terminalSessionEvent) {
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
      await updateSessionStatus();
    }
    if (ev.type === 'error') {
      if (this.stopped) {
        this.finalStatus = { status: 'aborted' };
      } else {
        this.turnFailed = true;
        this.finalStatus = transition ?? { status: 'blocked', blockedReason: 'unknown' };
        this.markRunFailed(ev.reason ?? ev.code ?? 'unknown', ev.message);
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
    this.markRunFailed(
      error instanceof Error ? error.name : 'unknown',
      error instanceof Error ? error.message : String(error),
    );
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.handoffGate.close();
    const handoff = this.handoffRequest;
    if (
      this.handoffPaused &&
      handoff?.committed &&
      !this.stopped &&
      !this.failureClass &&
      !this.terminalClaim
    ) {
      try {
        await this.flushRuntimePartialBuffer(true);
        // Stop may have claimed the logical outcome during the flush. Reserving
        // the pause below is synchronous up to its first write, so only one wins.
        if (!this.stopped && !this.failureClass && !this.terminalClaim) {
          this.assertRunCompositionCommitted();
          await this.recordRuntimeEvents([handoff.preview!], { requireTerminalWrite: true });
          this.terminalRunFactCommitted = true;
          if (this.active) await this.input.hooks.unregisterRun(this.active, this);
          await this.traceQueue;
          handoff.settle(true);
          return;
        }
      } catch (error) {
        handoff.fail(error);
        throw error;
      }
    }
    handoff?.settle(false);
    // A run cannot end without having begun. Finalizing one that never reached
    // its start would otherwise leave a terminal event on an invocation the
    // inventory cannot see, because nothing opened it. A continuation is the
    // exception at both ends: its opening rides the continuation-start event,
    // and a continuation that never committed one has no invocation to end.
    if (!this.input.commitContinuationStart) await this.openInvocation().catch(() => {});
    // A run also cannot end without saying what it was asked to do. `begin()`
    // can fail between opening the invocation and recording its prompt, and
    // the terminal event below seals the run against every later append —
    // including the one crash recovery would use to repair the same shape.
    if (this.initialRuntimeEventPending) {
      await this.recordInitialRuntimeEvent(this.lastTs || this.input.now()).catch(() => {});
    }
    await this.flushRuntimePartialBuffer(true);
    const lastTs = this.lastTs || this.input.now();
    if (this.stopped) this.finalStatus = { status: 'aborted' };
    if (!this.finalStatus) {
      this.finalStatus = { status: 'blocked', blockedReason: 'unknown' };
      this.markRunFailed('missing_terminal_event', 'run finalized without a terminal SessionEvent');
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
        lastMessageAt: lastTs,
        hasUnread: true,
        ...buildStatusPatch(nextStatus.status, lastTs, nextStatus.blockedReason),
      });
    } catch {
      // The user-visible turn already completed; preserve existing behavior.
    }
    await this.finishRun(this.finalStatus, lastTs);
  }

  private async openInvocation(continuation?: RuntimeContinuation): Promise<void> {
    if (!this.input.runStore && continuation) {
      throw new Error('Runtime continuation requires a durable run store');
    }
    // The opening fact is a RuntimeEvent, so it opens whenever this run has a
    // spine to open on. The operational ledger is a separate store with its own
    // availability, and a run without one still exists.
    if (!this.input.runtimeEventStore) return;
    const createdAt =
      continuation && this.input.claimedOpenedAt !== undefined
        ? this.input.claimedOpenedAt
        : this.input.now();
    const providerStateIdentity =
      claimedProviderStateIdentity(this.input.claimedOpening) ?? this.providerStateIdentity;
    this.providerStateIdentity = providerStateIdentity;
    const computedOpening = this.buildInvocationOpening(continuation, providerStateIdentity);
    if (
      continuation &&
      this.input.claimedOpening &&
      !isDeepStrictEqual(this.input.claimedOpening, computedOpening)
    ) {
      throw new Error('Claimed continuation target opening no longer matches execution');
    }
    this.invocationOpening = this.input.claimedOpening ?? computedOpening;
    // A continuation's opening fact rides its continuation-start event, which
    // the store requires to be event 1 of the target invocation. Every other
    // invocation opens with its own event, committed before any provider or
    // tool dispatch.
    if (!continuation) await this.commitInvocationOpening(createdAt);
  }

  /**
   * The one immutable statement of how this invocation was opened.
   *
   * Everything a later reader needs to know about the run's route,
   * configuration, root authority and lineage is decided here, once, and never
   * restated anywhere else.
   */
  private buildInvocationOpening(
    continuation: RuntimeContinuation | undefined,
    providerStateIdentity: `sha256:${string}` | undefined,
  ): RuntimeEventInvocationOpenedContent {
    const lineage = {
      ...this.lineage,
      ...(this.input.userInput.agentId ? { agentId: this.input.userInput.agentId } : {}),
      ...(this.input.userInput.agentName ? { agentName: this.input.userInput.agentName } : {}),
      ...(continuation ? { parentRunId: continuation.sourceRunId } : {}),
    };
    const opening: RuntimeEventInvocationOpenedContent = {
      kind: 'invocation_opened',
      protocol: 'invocation_opened_v1',
      route:
        this.header.llmConnectionId === undefined
          ? {
              provenance: 'unknown',
              backendKind: this.header.backend,
              llmConnectionSlug: this.header.llmConnectionSlug,
              modelId: this.header.model,
            }
          : {
              provenance: 'runtime',
              backendKind: this.header.backend,
              llmConnectionId: this.header.llmConnectionId,
              llmConnectionSlug: this.header.llmConnectionSlug,
              modelId: this.header.model,
              ...(providerStateIdentity ? { providerStateIdentity } : {}),
            },
      configuration: {
        cwd: this.header.cwd,
        permissionMode: this.header.permissionMode,
        collaborationMode: this.header.collaborationMode ?? 'agent',
        orchestrationMode: this.effectiveOrchestration.mode,
        orchestrationSource: this.effectiveOrchestration.source,
        toolMode: this.toolMode,
        ...(this.effectiveOrchestration.agentSwarmAuthorization !== undefined
          ? { agentSwarmAuthorization: this.effectiveOrchestration.agentSwarmAuthorization }
          : {}),
        ...(this.input.workspaceIdentity
          ? { workspaceIdentity: this.input.workspaceIdentity }
          : {}),
      },
      root: this.invocationRootAuthority(),
      source: continuation
        ? {
            kind: 'continuation',
            sourceInvocationId: continuation.sourceInvocationId,
            sourceRunId: continuation.sourceRunId,
            sourceTurnId: continuation.sourceTurnId,
            sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
            ...(continuation.claimId ? { claimId: continuation.claimId } : {}),
            ...(continuation.boundary
              ? { boundaryDigest: continuation.boundary.manifestDigest }
              : {}),
          }
        : { kind: 'fresh' },
      ...(Object.keys(lineage).length > 0 ? { lineage } : {}),
    };
    return continuation
      ? preserveHandoffOpening(continuation, opening, this.input.handoffSourceOpening)
      : opening;
  }

  private invocationRootAuthority(): RuntimeInvocationRootAuthority {
    const origin = this.input.userInput.origin;
    if (origin?.kind === 'scheduled_task') {
      return { kind: 'scheduled_task', scheduledTaskId: origin.scheduledTaskId };
    }
    if (origin?.kind === 'goal') return { kind: 'goal', goalId: origin.goalId };
    if (origin?.kind === 'agent_graph') {
      return {
        kind: 'agent_graph_supervisor_wake',
        wakeId: origin.wakeId,
        attemptId: origin.attemptId,
      };
    }
    if (this.input.rootExecutionKind === 'context_compact') return { kind: 'context_compact' };
    return { kind: 'user' };
  }

  /**
   * Make the invocation's opening fact durable before anything can dispatch.
   *
   * It is the invocation's first event, so it also carries the protocol marker
   * RecoveryResolver reads off event one.
   */
  private async commitInvocationOpening(ts: number): Promise<void> {
    const opening = this.invocationOpening;
    if (!opening || this.invocationOpeningCommitted) return;
    await this.recordRuntimeEvents(
      [
        {
          ...buildInvocationOpenedEvent({
            id: this.input.newId(),
            run: {
              sessionId: this.sessionId,
              invocationId: this.invocationId,
              runId: this.runId,
              turnId: this.turnId,
            },
            openedAt: ts,
            opening,
          }),
          ...(this.toolBoundaryProtocol
            ? { actions: { runtimeProtocol: { toolBoundary: this.toolBoundaryProtocol } } }
            : {}),
        },
      ],
      { requireDurableWrite: this.requiresDurablePersistence() },
    );
    this.invocationOpeningCommitted = true;
  }

  private requiresDurablePersistence(): boolean {
    return this.input.durability === 'required';
  }

  private async buildPriorRuntimeContext(): Promise<PriorRuntimeContext | undefined> {
    return await buildPriorRuntimeContextProjection({
      sessionId: this.sessionId,
      currentRunId: this.runId,
      currentTurnId: this.turnId,
      runtimeEventStore: this.input.runtimeEventStore,
      runtimeEventStoreAvailable: this.runtimeEventStoreAvailable,
    });
  }

  /**
   * Remember why this run is going to fail.
   *
   * Preserve diagnostic text without trace redaction, within the byte budget.
   * Nothing is written here: the terminal RuntimeEvent carries the failure, and
   * it is committed once, at the end, by `commitTerminalRun`.
   */
  private markRunFailed(failureClass: string, message: string): void {
    this.failureClass = failureClass;
    this.failureMessage = truncateUtf8(message, MODEL_FAILURE_MESSAGE_MAX_BYTES, '…');
  }

  /**
   * End the run by committing its terminal RuntimeEvent, and nothing else.
   *
   * A turn that parks on an interaction has not ended, so it commits nothing:
   * the absence of a terminal event is exactly what "still open" means.
   */
  private async finishRun(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): Promise<void> {
    await this.traceQueue.catch(() => {});
    if (!this.input.runtimeEventStore) return;
    if (this.runStatusForFinalStatus(finalStatus) === 'waiting_for_user') return;
    await this.commitTerminalRun(finalStatus, ts);
  }

  private runStatusForFinalStatus(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
  ): 'completed' | 'failed' | 'cancelled' | 'waiting_for_user' {
    if (this.stopped || finalStatus?.status === 'aborted') return 'cancelled';
    if (this.failureClass || finalStatus?.status === 'blocked') return 'failed';
    if (finalStatus?.status === 'waiting_for_user') return 'waiting_for_user';
    return 'completed';
  }

  private async commitTerminalRun(
    finalStatus: { status: SessionStatus; blockedReason?: SessionBlockedReason } | undefined,
    ts: number,
  ): Promise<void> {
    if (this.terminalRunFactCommitted) return;
    const runtimeEventStore = this.input.runtimeEventStore;
    if (!runtimeEventStore) return;
    // A latched RuntimeEvent store normally keeps the skip below: the latch
    // marks a write failure, and a transient one leaves the run non-terminal
    // on purpose so startup recovery repairs it with its own bookkeeping.
    // A corruption latch is the exception (#2313). The health scan refuses
    // tool-bearing appends only, so the terminal event is a write the
    // damaged ledger would have taken, and no recovery pass will ever be
    // safer than landing it now: the run must be able to say it ended. The
    // latch itself stays closed, nothing else may write; the terminal
    // durability barrier below doubles as the scoped probe, and if even
    // that write is refused the silent skip stands.
    let corruptionRecovery = false;
    if (!this.runtimeEventStoreAvailable) {
      if (!(this.runtimeEventStoreFailure instanceof ToolLedgerCorruptionError)) return;
      corruptionRecovery = true;
    }
    const fallbackStatus =
      this.stopped || finalStatus?.status === 'aborted' ? 'cancelled' : 'failed';
    const fallbackFailureClass = 'missing_terminal_event';
    const fallbackFailureMessage =
      this.failureMessage ?? 'run finalized without a terminal RuntimeEvent';
    try {
      const terminalClaim = this.terminalClaim;
      const terminalEvent = terminalClaim?.event;
      if (!terminalEvent) throw new Error('terminal RuntimeEvent claim is missing');
      try {
        await terminalClaim.write;
      } catch (error) {
        // Under a corruption latch the claimed event's write is the stale
        // latched failure, not the barrier's own verdict: clear it so
        // commitOrCreateTerminalRunFact lands the same claimed fact fresh
        // (#2313). On a store that was never latched the failure is live
        // and keeps propagating exactly as before.
        if (!corruptionRecovery) throw error;
        terminalClaim.write = undefined;
      }
      // Re-check after the await, not only at entry. Two callers — a stop
      // settling the claim and the stream's own finalize — can both pass the
      // entry guard and then queue behind the same write. The claim slot
      // dedupes the RuntimeEvent, so a second pass has nothing left to do.
      if (this.terminalRunFactCommitted) return;
      // On the recovery path the claimed event's write never committed, so
      // the boundary named after that commit must wait for the durability
      // barrier inside commitOrCreateTerminalRunFact; firing it here would
      // let a crash leave a durable continuation start without the terminal
      // fact it is contracted to follow.
      const deferContinuationBoundary = corruptionRecovery && !terminalClaim.write;
      if (this.continuationActive && !deferContinuationBoundary) {
        await this.input.continuationFailpoint?.('after_terminal_event_committed');
      }
      const commit = commitOrCreateTerminalRunFact({
        runtimeEventStore,
        ...(this.continuationActive && deferContinuationBoundary
          ? {
              afterTerminalDurable: async () => {
                await this.input.continuationFailpoint?.('after_terminal_event_committed');
              },
            }
          : {}),
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
        ...(this.abortSource || fallbackStatus === 'cancelled'
          ? { abortSource: this.abortSource ?? 'user_stop' }
          : {}),
        fallbackStatus,
        fallbackInvocationId: this.runId,
        ...(fallbackStatus === 'failed' ? { fallbackFailureClass, fallbackFailureMessage } : {}),
      });
      if (!terminalClaim.write) {
        terminalClaim.write = commit.then(() => undefined);
        void terminalClaim.write.catch(() => {});
      }
      await commit;
      this.terminalRunFactCommitted = true;
    } catch (error) {
      if (corruptionRecovery) {
        // The scoped barrier lost its bet: the ledger refused even the
        // terminal fact. The latch never lifted, so there is nothing to
        // restore; record the failure and keep the finalize path's
        // historical silence for a store that stays broken.
        await this.enqueueTraceWriteFailure(error, 'commit terminal run fact');
        return;
      }
      this.runStoreAvailable = false;
      await this.enqueueTraceWriteFailure(error, 'commit terminal run fact');
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
      // A rejection is the ledger refusing one malformed candidate, not the
      // store going away: it stays healthy and readable, so the latch would
      // only cost this run the writes it still owes — above all its own
      // terminal event, which `recordRuntimeEvents` refuses once the store
      // reads unavailable. That is how a single refused append left a run at
      // `running` with no terminal event and no visible failure (#2234). The
      // append still fails the caller (a producer bug must not pass quietly),
      // but the ledger stays open so the turn can end the way every other
      // failure ends.
      //
      // Only that one class is exempt. A store that went away keeps latching:
      // nothing this run emits next can land.
      //
      // `ToolLedgerCorruptionError` also keeps latching, and that is the
      // right economy for THIS path: stream writes stay fail-closed against
      // a damaged ledger. What the latch must not cost is the terminal fact
      // (#2313): the health scan gates only tool-bearing appends, so the
      // terminal event is a write the damaged ledger would have taken.
      // `commitTerminalRun` therefore carries the one exception: under a
      // corruption latch it still attempts the terminal durability barrier
      // (the barrier is its own scoped probe), so the run says it ended
      // while everything routed through here keeps failing closed.
      if (error instanceof RunSealedError) {
        // A refusal that is correct in itself (#2311): the run already owns
        // its terminal fact, and a straggler from the still-draining stream
        // is by definition not part of it. Neither the store nor this run's
        // durable history is at fault, so no latch and no trace-write
        // failure; a caller that asked for the rejection still receives it.
        if (options.rethrow) throw error;
        return;
      }
      if (!(error instanceof ToolLedgerRejectionError)) {
        this.runtimeEventStoreAvailable = false;
        this.runtimeEventStoreFailure = error;
      }
      await this.enqueueTraceWriteFailure(error, label);
      if (options.rethrow) throw error;
    });
    this.runtimeEventQueue = next.catch(() => {});
    return next;
  }

  private async recordRuntimePartial(event: RuntimeEvent, streamKey: string): Promise<void> {
    const store = this.input.runtimeEventStore;
    if (!store?.appendRuntimePartialBatch) {
      await this.recordRuntimeEvents([event]);
      return;
    }
    if (!this.runtimeEventStoreAvailable) {
      await this.recordRuntimeEvents([event]);
      return;
    }
    if (this.runtimePartialStreamKey !== streamKey) {
      await this.flushRuntimePartialBuffer(true);
      // Persist the first chunk synchronously. Besides bounding crash loss, this
      // captures the immutable anchor before an upstream tool boundary can
      // commit while later chunks are waiting in the coalescer.
      await this.recordRuntimeEvents([event]);
      this.runtimePartialStreamKey = streamKey;
      return;
    }
    this.runtimePartialBuffer.push(event);
    this.runtimePartialBufferBytes += runtimePartialTextBytes(event);
    if (this.runtimePartialBufferBytes >= RUNTIME_PARTIAL_BATCH_MAX_BYTES) {
      await this.flushRuntimePartialBuffer(false);
      return;
    }
    this.scheduleRuntimePartialFlush();
  }

  private scheduleRuntimePartialFlush(): void {
    if (this.runtimePartialFlushTimer) return;
    this.runtimePartialFlushTimer = setTimeout(() => {
      this.runtimePartialFlushTimer = undefined;
      void this.flushRuntimePartialBuffer(false).catch(() => {
        // enqueueRuntimeEventStore latches and reports the failure. The next
        // event or execution boundary observes that latch and fails closed.
      });
    }, RUNTIME_PARTIAL_FLUSH_INTERVAL_MS);
  }

  private async flushRuntimePartialBuffer(closeStream: boolean): Promise<void> {
    const ownedPartialWork =
      this.runtimePartialStreamKey !== undefined ||
      this.runtimePartialBuffer.length > 0 ||
      this.runtimePartialFlushTimer !== undefined;
    if (this.runtimePartialFlushTimer) {
      clearTimeout(this.runtimePartialFlushTimer);
      this.runtimePartialFlushTimer = undefined;
    }
    const events = this.runtimePartialBuffer;
    this.runtimePartialBuffer = [];
    this.runtimePartialBufferBytes = 0;
    if (closeStream) this.runtimePartialStreamKey = undefined;
    if (events.length === 0) {
      // A timer flush may already be queued. Waiting here preserves the rule
      // that an immutable boundary never overtakes prior presentation text.
      if (closeStream) {
        await this.runtimeEventQueue;
        if (
          ownedPartialWork &&
          !this.runtimeEventStoreAvailable &&
          this.input.runtimeEventStore?.durability === 'canonical'
        ) {
          throw (
            this.runtimeEventStoreFailure ??
            new Error('canonical RuntimeEvent store is unavailable')
          );
        }
      }
      return;
    }
    const store = this.input.runtimeEventStore;
    if (!store?.appendRuntimePartialBatch) {
      await this.recordRuntimeEvents(events);
      return;
    }
    await this.enqueueRuntimeEventStore(
      'append runtime partial batch',
      async () => {
        await store.appendRuntimePartialBatch?.(this.sessionId, this.runId, events);
      },
      { rethrow: store.durability === 'canonical' },
    );
  }

  private async enqueueTraceWriteFailure(
    error: unknown,
    label = 'agent run store write',
  ): Promise<void> {
    const message = errorMessage(error);
    this.traceWriteError ??= `${label}: ${message}`;
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

function runtimePartialCoalescingKey(event: RuntimeEvent): string | undefined {
  if (!event.partial || event.status !== undefined || event.actions) return undefined;
  const content = event.content;
  if (content?.kind !== 'text' && content?.kind !== 'thinking') return undefined;
  if (content.kind === 'text' && content.attachments !== undefined) return undefined;
  if (content.kind === 'thinking' && content.signature !== undefined) return undefined;
  const providerEventId = event.refs?.providerEventId;
  if (!providerEventId || Object.keys(event.refs ?? {}).some((key) => key !== 'providerEventId')) {
    return undefined;
  }
  return JSON.stringify([
    content.kind,
    providerEventId,
    event.sessionId,
    event.invocationId,
    event.runId,
    event.turnId,
    event.branch ?? null,
    event.role,
    event.author,
  ]);
}

function runtimePartialTextBytes(event: RuntimeEvent): number {
  const content = event.content;
  return content?.kind === 'text' || content?.kind === 'thinking'
    ? Buffer.byteLength(content.text, 'utf8')
    : 0;
}

function traceToRunEvent(event: RunTraceEvent, runId: string): EmittedAgentRunEvent {
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

function sameRequestCompositionSurface(
  current: RequestCompositionSnapshot,
  candidate: RequestCompositionSnapshot,
): boolean {
  const {
    schemaVersion: _schemaVersion,
    compositionId: _compositionId,
    step: _step,
    reason: _reason,
    ...currentSurface
  } = current;
  const {
    schemaVersion: _candidateSchemaVersion,
    compositionId: _candidateCompositionId,
    step: _candidateStep,
    reason: _candidateReason,
    ...candidateSurface
  } = candidate;
  return isDeepStrictEqual(currentSurface, candidateSurface);
}

function requestCompositionSurfaceHash(snapshot: RequestCompositionSnapshot): string {
  const {
    schemaVersion: _schemaVersion,
    compositionId: _compositionId,
    step: _step,
    reason: _reason,
    ...surface
  } = snapshot;
  return stableHash(surface);
}

function isInteractionResumeAck(event: SessionEvent): boolean {
  return (
    event.type === 'sandbox_boundary_decision_ack' ||
    event.type === 'user_question_answer_ack' ||
    event.type === 'form_answer_ack'
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

/** The provider endpoint identity a continuation claim froze, if it named one. */
function claimedProviderStateIdentity(
  opening: RuntimeEventInvocationOpenedContent | undefined,
): `sha256:${string}` | undefined {
  const route = opening?.route;
  return route?.provenance === 'runtime' ? route.providerStateIdentity : undefined;
}
