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

/**
 * Session-level AI SDK backend. It wires provider, compaction, projection,
 * telemetry, and tool services once, then delegates each `send()` to an
 * isolated AiSdkTurn. Provider-message construction and turn execution live in
 * their own modules; this file owns composition and cross-turn control only.
 */

import type { SessionEvent } from '@maka/core/events';
import type { BackendKind, SessionHeader, StoredMessage } from '@maka/core/session';
import type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
  BackendSendInput,
  HostedInteractionBridge,
} from '@maka/core/backend-types';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { EffectiveOrchestration } from '@maka/core/orchestration';
import type { AttachmentByteReader } from '@maka/core/attachments';
import { pricingModelKey } from '@maka/core/usage-stats/pricing';
import type { PricingConfig, ToolInvocationRecord } from '@maka/core/usage-stats/types';
import type { ModelCallCommit } from '@maka/core/agent-run';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';

import { AdmissionLimiter } from './admission-limiter.js';
import {
  ToolRuntime,
  type MakaTool,
  type MakaToolContext,
  type ToolRuntimeInput,
} from './tool-runtime.js';
import type { RuntimeCommitSink } from './runtime-commit-sink.js';
import { ModelAdapter, type NormalizedAiSdkUsage } from './model-adapter.js';
import { buildProviderOptions } from './model-factory.js';
import type { OpenAiResponsesTransportState } from './openai-responses-websocket.js';
import type { StreamWatchdogInput } from './stream-watchdog.js';
import { AiSdkCompaction } from './ai-sdk-compaction.js';
import type { AiSdkCompactionCapabilities } from './ai-sdk-compaction-contract.js';
import type { ToolArtifactRecorder } from './tool-artifacts.js';
import type { RunTraceRecorder } from './run-trace.js';
import { getBuiltinPricing } from './telemetry/builtin-pricing.js';
import { ProviderRequestTelemetry } from './provider-request-telemetry.js';
import { AiSdkMessageProjection } from './ai-sdk-message-projection.js';
import { AiSdkTurn, type AiSdkSessionState } from './ai-sdk-turn.js';
import { buildInvalidMakaTool } from './ai-sdk-tool-repair.js';
import { ToolAvailabilityRuntime, type ToolAvailabilityConfig } from './tool-availability.js';
import {
  MEMORY_EXTRACT_TOOL_NAME,
  MEMORY_REMEMBER_TOOL_NAME,
  buildMemoryExtractionTriggerTools,
  type MemoryExtractionSourceCapabilities,
  type MemoryExtractionSourceSnapshot,
  type MemoryExtractionTrigger,
} from './memory-extraction.js';
import { modelUsesNativeOpenAiResponses, resolveModelRuntime } from './model-runtime.js';
import { routeApplyPatchTools } from './apply-patch-profile.js';
import { bindToolResultArchiveDecoder } from './tool-result-archive-capability.js';
import { resolveSelectedModelContextWindow } from './context-budget-policy.js';
export {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatSyntheticToolErrorText,
} from './tool-runtime.js';
export { normalizeAiSdkUsage } from './model-adapter.js';
export type {
  ModelFactory,
  ModelFactoryInput,
  RepairableAiSdkToolCall,
} from './model-adapter.js';
export type { RunTraceEvent, RunTraceRecorder } from './run-trace.js';

// AgentBackend's port contract lives in core; keep the historical exports.
export type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
} from '@maka/core/backend-types';
export { INVALID_TOOL_NAME, repairMakaToolCall } from './ai-sdk-tool-repair.js';

export type AppendMessageFn = (m: StoredMessage) => Promise<void>;
export type ToolTelemetryRecorder = (record: ToolInvocationRecord) => void;
export type {
  HistoryCompactCheckpointLoader,
  HistoryCompactCheckpointRecorder,
  HistoryCompactSummarizer,
  HistoryCompactSummaryInput,
} from './ai-sdk-compaction-contract.js';

export interface AiSdkBackendInput extends AiSdkCompactionCapabilities {
  // ── Session context ────────────────────────────────────────────────────
  sessionId: string;
  header: SessionHeader;
  /** Host-frozen provider endpoint and credential ownership for this backend generation. */
  providerStateIdentity?: `sha256:${string}`;
  /** Append-message function bound to this session (e.g. SessionStore wrapper). */
  appendMessage: AppendMessageFn;
  /** Reads the authoritative session boundary immediately before every local tool invocation. */
  readExecutionBoundary: ToolRuntimeInput['readExecutionBoundary'];
  createSandboxBoundaryRequest?: ToolRuntimeInput['createSandboxBoundaryRequest'];
  settleSandboxBoundaryRequest?: ToolRuntimeInput['settleSandboxBoundaryRequest'];

  // ── Process-singleton deps ─────────────────────────────────────────────
  /** Canonical-named tools available this session. */
  tools: MakaTool[];
  /** Diagnostic-only Plan Mode/execution identity snapshot. */
  planTraceContext?: {
    mode: 'agent' | 'plan';
    storeVersion: number;
    planId?: string;
    proposalId?: string;
    executionId?: string;
  };
  /** Search-space groups derived from the currently bound tool ceiling. */
  toolAvailability?: ToolAvailabilityConfig;

  // ── Optional knobs (defaults shown) ────────────────────────────────────
  /** ID generator; default `crypto.randomUUID()`. */
  newId?: () => string;
  /** Clock; default `Date.now()`. */
  now?: () => number;
  /** Optional cap on tool-call steps per turn; omitted means no step cap. */
  maxSteps?: number;
  /** Timeout before first SDK stream event; default 30s. */
  streamConnectTimeoutMs?: number;
  /** Timeout between SDK/tool events; paused while a tool is active. Default 120s. */
  streamIdleTimeoutMs?: number;
  /** Test seam for the Runtime-owned stream watchdog clock. */
  streamWatchdogTimer?: Pick<Required<StreamWatchdogInput>, 'setTimer' | 'clearTimer'>;
  /** Test seam for the Runtime-owned provider retry clock. */
  providerRetrySleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Optional system prompt (skills + workspace AGENTS.md merged upstream). */
  systemPrompt?:
    | string
    | ((context: SystemPromptContext) => string | undefined | Promise<string | undefined>);
  /** Provider-native options passed through to ai-sdk. */
  providerOptions?: Record<string, unknown>;
  /** Test seam for the adapter-owned incremental Responses transport. */
  openAiResponsesTransportState?: OpenAiResponsesTransportState;
  /** Optional fire-and-forget telemetry hook. Tool implementations remain unaware. */
  recordToolInvocation?: ToolTelemetryRecorder;
  /** Optional Phase 2 SQLite T1/T2 boundary for real tool execution. */
  runtimeCommitSink?: RuntimeCommitSink;
  /** Durable session-lifetime cumulative usage checkpoint after each completed provider step. */
  recordUsageCheckpoint?: (
    usage: NormalizedAiSdkUsage & { costUsd?: number },
  ) => void | Promise<void>;
  /** Optional pricing lookup shared with telemetry; defaults to builtin public pricing. */
  lookupPricing?: (modelKey: string) => PricingConfig | null;
  spawnChildSession?: ToolRuntimeInput['spawnChildSession'];
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: ToolRuntimeInput['readChildAgentOutput'];
  /** Optional diagnostic trace hook for explaining a runtime turn without changing renderer events. */
  recordRunTrace?: RunTraceRecorder;
  /**
   * Commits one settled provider request: the canonical attempt and, when it
   * is the completed main call, the derived latest-context row it authorises.
   * One object so a layer cannot forward half of it (#2323).
   */
  recordModelCallAttempt?: (commit: ModelCallCommit<ModelCallAttempt>) => void | Promise<void>;
  /**
   * Pre-dispatch accounting gate, paired with `recordModelCallAttempt` and read
   * only when it is present. Throws when the canonical record could not be
   * written for this dispatch, which fails the send before the provider is
   * called rather than producing spend nothing recorded.
   */
  assertModelCallAccountingReady?: () => void;
  /** Durable gate for every provider call attributed to an AgentRun. */
  beforeRunProviderDispatch?: (input: {
    sessionId: string;
    turnId: string;
    runId: string;
  }) => void | Promise<void>;
  /**
   * Optional artifact recorder. Runtime derives only deterministic candidates
   * from structured tool results / explicit redirects; desktop main owns
   * file-backed persistence.
   */
  recordToolArtifacts?: ToolArtifactRecorder;
  /**
   * Optional attachment byte reader. When set, image attachments on the current
   * user turn may be rendered as provider image parts instead of placeholder text.
   * Caller wires this to the session ArtifactStore; runtime never imports storage.
   */
  readAttachmentBytes?: AttachmentByteReader;
  /** Host-owned exact ref plan for inline images, persisted only after projection validation. */
  prepareDurableProjectionArtifact?: ToolRuntimeInput['prepareDurableProjectionArtifact'];
  /**
   * Whether the selected model accepts image input. Only explicit true sends
   * image parts; false/unknown keep the attachment's model-facing Read reference.
   */
  supportsVision?: boolean;
  maxProviderImageRequestBytes?: number;
  /** Host-owned bounded long-term-memory extraction. Source tools are Runtime-reserved. */
  memoryExtraction?: MemoryExtractionSourceCapabilities;
}

export interface SystemPromptContext {
  sessionId: string;
  turnId: string;
  cwd: string;
  /** Diagnostic-only skill catalog trace; never affects prompt construction. */
  emitSkillCatalogTrace?: (message: string, data?: Record<string, unknown>) => void;
}

/** Bounds Code Mode execution across turns on this backend. */
const MAX_ACTIVE_CODE_MODE_CELLS = 1;

function sleepForProviderRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', abort, { once: true });

    function finish(): void {
      signal.removeEventListener('abort', abort);
      resolve();
    }

    function abort(): void {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }
  });
}

// ============================================================================
// Implementation
// ============================================================================

export class AiSdkBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  // Pulled out of the input for ergonomic access on hot paths.
  private readonly input: AiSdkBackendInput;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly maxSteps: number | undefined;
  private readonly providerRetrySleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly modelAdapter: ModelAdapter;
  private readonly messageProjection: AiSdkMessageProjection;
  private readonly providerTelemetry: ProviderRequestTelemetry;
  private readonly resolvedProviderOptions: Record<string, unknown>;
  private readonly toolAvailabilityRuntime: ToolAvailabilityRuntime;

  /** Bounds outstanding Code Mode cells on this backend. */
  private readonly codeCellAdmission = new AdmissionLimiter(MAX_ACTIVE_CODE_MODE_CELLS);

  /**
   * Every `send()` currently in flight on this backend.
   *
   * A set, not a map: nothing looks a scope up by turn id. Control calls that
   * arrive without a turn (`stop`, and the two `respond*` methods) iterate, and
   * each scope is already held by reference everywhere else.
   *
   * A backend instance is reused for a whole Session and RuntimeKernel lets one
   * backend generation hold several concurrent runs, so per-turn state cannot
   * live on the instance: whichever turn started or finished last would speak
   * for all of them. That is exactly how #1990 crashed a turn — one turn's
   * teardown cleared the run identity a *different* turn's tool execution then
   * read back as absent.
   */
  private readonly activeTurns = new Set<AiSdkTurn>();
  private readonly compaction: AiSdkCompaction;
  /**
   * The provider has been reported dropping context, for this backend.
   *
   * Not per send: the condition persists once a provider starts truncating, so
   * a note on every later turn would repeat one fact the user has already been
   * told. The scope is this backend's lifetime rather than the Session's, so a
   * backend that is disposed and rebuilt may say it once more.
   */
  private readonly turnSessionState: AiSdkSessionState = {
    contextProviderDroppingReported: false,
  };
  constructor(input: AiSdkBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
    this.maxSteps = input.maxSteps;
    this.providerRetrySleep = input.providerRetrySleep ?? sleepForProviderRetry;
    // One resolved options value for every reader: the main call, the
    // auxiliary memory-extraction call, and the provider request all use the
    // same options value, so they cannot disagree on what was sent.
    this.resolvedProviderOptions =
      input.providerOptions ??
      buildProviderOptions(input.connection, input.modelId, input.header.thinkingLevel);
    this.modelAdapter = new ModelAdapter({
      sessionId: input.sessionId,
      connection: input.connection,
      apiKey: input.apiKey,
      modelId: input.modelId,
      modelFactory: input.modelFactory,
      // `input.providerOptions` is an override escape hatch: when set it owns
      // the whole provider-options namespace (including reasoning effort), and
      // the computed defaults are dropped entirely. Keep providerOptions the
      // single seam — do not re-add a parallel reasoning channel here.
      providerOptions: this.resolvedProviderOptions,
      newId: this.newId,
      now: this.now,
      ...(input.openAiResponsesTransportState
        ? { openAiResponsesTransportState: input.openAiResponsesTransportState }
        : {}),
    });
    this.providerTelemetry = new ProviderRequestTelemetry({
      sessionId: this.sessionId,
      connectionSlug: input.connection.slug,
      providerId: input.connection.providerType,
      defaultModelId: input.modelId,
      now: this.now,
      newId: this.newId,
      resolveContextWindow: (modelId) =>
        resolveSelectedModelContextWindow(input.connection, modelId),
      resolvePricing: (modelId) =>
        (input.lookupPricing ?? getBuiltinPricing)(
          pricingModelKey(input.connection.providerType, modelId),
        ),
      recordModelCallAttempt: input.recordModelCallAttempt,
      assertModelCallAccountingReady: input.assertModelCallAccountingReady,
      beforeRunProviderDispatch: input.beforeRunProviderDispatch,
    });
    const runtime = resolveModelRuntime(input.connection, input.modelId);
    const applyPatchProfile = runtime.applyPatchProfile;
    this.messageProjection = new AiSdkMessageProjection({
      modelAdapter: this.modelAdapter,
      applyPatchProfile,
      supportsVision: input.supportsVision,
      readAttachmentBytes: input.readAttachmentBytes,
      maxProviderImageRequestBytes: input.maxProviderImageRequestBytes,
    });
    this.compaction = new AiSdkCompaction({
      input,
      sessionId: this.sessionId,
      targetConnectionId: input.header.llmConnectionId,
      targetProviderStateIdentity: input.providerStateIdentity,
      now: this.now,
      modelAdapter: this.modelAdapter,
      createProviderRequestTracker: (trackerInput) =>
        this.providerTelemetry.createTracker(trackerInput),
      materializeRuntimeReplayPlan: (
        plan,
        imageBudget,
        checkpoint,
        providerReasoningReplayEventIds,
      ) =>
        this.messageProjection.materializeRuntimeReplayPlan(
          plan,
          imageBudget,
          checkpoint,
          providerReasoningReplayEventIds,
        ),
      canReplayProviderNative: (plan) => this.messageProjection.canReplayProviderNative(plan),
    });
    if (
      input.tools.some(
        (tool) => tool.name === MEMORY_REMEMBER_TOOL_NAME || tool.name === MEMORY_EXTRACT_TOOL_NAME,
      )
    ) {
      throw new Error('Long-term Memory trigger tool names are reserved by Runtime');
    }
    const memoryTools = input.memoryExtraction
      ? buildMemoryExtractionTriggerTools({
          capabilities: input.memoryExtraction,
          snapshot: (trigger, context) => this.memorySourceSnapshot(trigger, context),
          markExtractRequested: (context) => {
            const turn = [...this.activeTurns].find(
              (candidate) =>
                candidate.turnId === context.turnId && candidate.runId === context.runId,
            );
            if (turn) turn.memoryExtractRequested = true;
          },
          ...(modelUsesNativeOpenAiResponses(input.connection, input.modelId)
            ? { unsupportedReason: 'provider_unsupported' as const }
            : {}),
        })
      : [];
    const modelTools = routeApplyPatchTools(input.tools, applyPatchProfile);
    this.toolAvailabilityRuntime = new ToolAvailabilityRuntime(
      // The archive decoder is a runtime protocol tool, not a host binding:
      // this session's placeholders name it, so this session advertises it.
      bindToolResultArchiveDecoder([...modelTools, ...memoryTools], input.toolResultArchive),
      input.toolAvailability,
      buildInvalidMakaTool(),
    );
  }

  private memorySourceSnapshot(
    trigger: MemoryExtractionTrigger,
    context: MakaToolContext,
  ): MemoryExtractionSourceSnapshot | undefined {
    if (trigger !== 'remember') return undefined;
    const turn = [...this.activeTurns].find(
      (candidate) => candidate.turnId === context.turnId && candidate.runId === context.runId,
    );
    return turn
      ? turn.memorySourceSnapshot({
          trigger: 'remember',
          toolCallId: context.toolCallId,
        })
      : undefined;
  }

  /**
   * One ToolRuntime per `send()`, bound to that turn's identity for its whole
   * lifetime. The scope is passed in rather than read back so a tool settling
   * long after its step still resolves this turn's watchdog, trace, and run.
   */
  private createToolRuntime(identity: {
    turnId: string;
    runId: string | undefined;
    invocationId: string | undefined;
    hostedInteraction: HostedInteractionBridge | undefined;
    orchestrationMode: EffectiveOrchestration['mode'];
    scope: () => AiSdkTurn;
  }): ToolRuntime {
    const input = this.input;
    return new ToolRuntime({
      sessionId: input.sessionId,
      header: input.header,
      connection: input.connection,
      modelId: input.modelId,
      appendMessage: input.appendMessage,
      readExecutionBoundary: input.readExecutionBoundary,
      createSandboxBoundaryRequest: input.createSandboxBoundaryRequest,
      settleSandboxBoundaryRequest: input.settleSandboxBoundaryRequest,
      newId: this.newId,
      now: this.now,
      getPermissionPauseTarget: () => identity.scope().watchdog,
      turnId: identity.turnId,
      ...(identity.hostedInteraction ? { hostedInteraction: identity.hostedInteraction } : {}),
      ...(identity.runId ? { runId: identity.runId } : {}),
      orchestrationMode: identity.orchestrationMode,
      ...(identity.invocationId ? { invocationId: identity.invocationId } : {}),
      prepareDurableProjectionArtifact: input.prepareDurableProjectionArtifact,
      spawnChildSession: input.spawnChildSession,
      listChildAgents: input.listChildAgents,
      readChildAgentOutput: input.readChildAgentOutput,
      getRunTrace: () => identity.scope().runTrace,
      recordToolInvocation: input.recordToolInvocation,
      runtimeCommitSink: input.runtimeCommitSink,
      recordToolArtifacts: input.recordToolArtifacts,
    });
  }

  // --------------------------------------------------------------------------
  // manual history compaction
  // --------------------------------------------------------------------------

  async compactHistory(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult> {
    return this.compaction.compactHistory(input);
  }

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  private openTurnScope(input: BackendSendInput): AiSdkTurn {
    const turn = new AiSdkTurn(
      {
        backend: this.input,
        modelAdapter: this.modelAdapter,
        messageProjection: this.messageProjection,
        providerTelemetry: this.providerTelemetry,
        compaction: this.compaction,
        toolAvailabilityRuntime: this.toolAvailabilityRuntime,
        codeCellAdmission: this.codeCellAdmission,
        resolvedProviderOptions: this.resolvedProviderOptions,
        session: this.turnSessionState,
        newId: this.newId,
        now: this.now,
        maxSteps: this.maxSteps,
        providerRetrySleep: this.providerRetrySleep,
        createToolRuntime: (owner) =>
          this.createToolRuntime({
            turnId: owner.turnId,
            runId: owner.runId,
            invocationId: input.invocationId ?? input.runId,
            hostedInteraction: input.hostedInteraction,
            orchestrationMode: owner.orchestration.mode,
            scope: () => owner,
          }),
      },
      input,
    );
    this.activeTurns.add(turn);
    return turn;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const turn = this.openTurnScope(input);
    try {
      yield* turn.run();
    } finally {
      this.activeTurns.delete(turn);
      await turn.close();
    }
  }

  /**
   * Stop every turn this backend is currently running.
   *
   * The control surface carries no turn id, so this stays a broadcast — the
   * behavior it has always had. What changes is that each turn is now stopped
   * as ITSELF: its own abort controller, its own ToolRuntime, and its own turn
   * id on the `endTurn` record. Previously one shared `currentTurnId` labelled
   * every concurrent turn's teardown, so an overlapping turn closed under a
   * sibling's identity.
   *
   * Teardown is settled for every scope before any failure surfaces. `endTurn`
   * throws when a durable sandbox denial cannot be written, and it is also the
   * ONLY thing that rejects a tool parked on `askUserQuestion` — an abort signal
   * does not wake the registry. So bailing on the first rejection would leave a
   * sibling parked forever: its own `send()` cannot reach the `finally` that
   * would clean it up, because that `finally` is waiting on the very tool the
   * skipped `endTurn` was supposed to reject.
   */
  async stop(
    _reason: 'user_stop' | 'redirect',
    mode: 'immediate' | 'after_step' = 'immediate',
  ): Promise<void> {
    const turns = [...this.activeTurns];
    if (mode === 'after_step') {
      for (const turn of turns) turn.requestStop(_reason, mode);
      return;
    }
    this.compaction.abortHistoryCompact();
    for (const turn of turns) turn.requestStop(_reason, mode);
    const settled = await Promise.allSettled(turns.map((turn) => turn.endAbortedTools()));
    const failures = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Failed to stop every active turn');
  }

  async respondToSandboxBoundary(decision: SandboxBoundaryResponse): Promise<void> {
    // Routed by request id, which is already the identity the registry matches
    // on: at most one turn parked this request.
    for (const turn of this.activeTurns) {
      if (await turn.respondToSandboxBoundary(decision)) return;
    }
    throw new Error(`No pending sandbox boundary request ${decision.requestId}`);
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    for (const turn of this.activeTurns) {
      if (turn.respondToUserQuestion(response)) return;
    }
  }

  async dispose(): Promise<void> {
    if (this.activeTurns.size > 0) await this.stop('user_stop');
    else this.compaction.abortHistoryCompact();
    this.modelAdapter.dispose();
  }
}
