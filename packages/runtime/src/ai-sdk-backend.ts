/**
 * AiSdkBackend — single backend for all LLM providers via Vercel AI SDK.
 *
 * Provides one `streamText` API across Anthropic / OpenAI / Google / DeepSeek /
 * OpenAI-compatible endpoints, while keeping all of our home-grown
 * machinery: session sandbox boundaries, materializer, AsyncEventQueue,
 * SessionStore JSONL persistence.
 *
 * Maka owns the agent loop. Each ModelAdapter call performs exactly one
 * provider request; returned tool calls settle through ToolRuntime, become
 * durable, and are reloaded before the next provider request.
 *
 * Design:
 *   send()
 *     ├─ build AsyncEventQueue<SessionEvent>
 *     ├─ resolve LanguageModelV2 via deps.modelFactory(connection, modelId)
 *     ├─ expose schema-only tools to the provider
 *     ├─ background task: project → stream one step → settle → reload
 *     └─ yield from queue
 */

import type {
  SessionEvent,
  CompleteEvent,
  AbortEvent,
  ErrorEvent,
  TextCompleteEvent,
  ThinkingCompleteEvent,
  TokenUsageEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ProviderRetryEvent,
  ProviderRetryReason,
  StorageRef,
  AttachmentRef,
  QuoteRef,
} from '@maka/core/events';
import type {
  StoredMessage,
  AssistantMessage,
  AssistantThinkingPart,
  ToolCallMessage,
  ToolResultMessage,
  PermissionDecisionMessage,
  TokenUsageMessage,
  SystemNoteMessage,
  BackendKind,
  SessionHeader,
} from '@maka/core/session';
import type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
  BackendSendInput,
} from '@maka/core/backend-types';
import type { AgentSpec } from '@maka/core/runtime-inputs';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { EphemeralVoiceAudio } from '@maka/core/voice';
import {
  resolveEffectiveOrchestration,
  type EffectiveOrchestration,
} from '@maka/core/orchestration';
import type { PlanToolResult } from './plan-tools.js';
import type { AttachmentByteReader } from '@maka/core/attachments';
import {
  MAX_PROVIDER_IMAGE_REQUEST_BYTES,
  PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE,
} from '@maka/core';
import type {
  LlmCallRecord,
  PricingConfig,
  ToolInvocationRecord,
} from '@maka/core/usage-stats/types';
import type { ContextBudgetDiagnostic, PromptSegmentEstimate } from '@maka/core/usage-stats/types';
import type {
  AudioPart,
  JSONValue,
  ModelFinishReason,
  ModelMessage,
  ReasoningPart,
  ModelToolSet,
  NormalizedUsage,
  ModelFailureKind,
  ToolCallPart,
  ToolResultOutput,
  UserContent,
} from './model-protocol.js';
import { z } from 'zod';
import { llmCallUsageFields } from './telemetry/llm-call-usage.js';

import { AsyncEventQueue } from './async-queue.js';
import { StreamWatchdog, formatStreamWatchdogError } from './stream-watchdog.js';
import {
  MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  ToolRuntime,
  formatSyntheticToolErrorText,
  type MakaTool,
  type MakaToolContext,
  type ToolRuntimeInput,
} from './tool-runtime.js';
import type { RuntimeCommitSink } from './runtime-commit-sink.js';
import type { SubagentExecutionRef } from './subagent-execution.js';
import {
  ModelAdapter,
  type ModelFactoryInput,
  type NormalizedAiSdkUsage,
  type ModelStreamResult,
  type RepairableAiSdkToolCall,
} from './model-adapter.js';
import {
  composeRequestProjection,
  type RequestProjection,
  type RequestProjectionContext,
  type RequestProjectionStage,
} from './request-projection.js';
import type { ActiveToolResultPruneDiagnosticPatch } from './active-tool-result-prune.js';
import { toolResultOutput } from './tool-result-output.js';
import { buildActiveCompactionHeadAnchor } from './active-full-compact.js';
import { compactionDecisionDiagnosticPatch } from './compaction-boundary.js';
import {
  AiSdkCompaction,
  composeActiveCompactionProjection,
  hasActiveToolResultPruneDiagnosticPatch,
  hasBlockingReplayDiagnostics,
} from './ai-sdk-compaction.js';
import type { AiSdkCompactionCapabilities } from './ai-sdk-compaction-contract.js';
import type { ToolArtifactRecorder } from './tool-artifacts.js';
import { kimiReasoningFieldFromProviderOptions } from './kimi-openai-transport.js';
import { RunTrace, type RunTraceRecorder } from './run-trace.js';
import {
  toSandboxRunTraceProjection,
  type SandboxDiagnosticsSnapshot,
} from './sandbox/diagnostics.js';
import { renderSandboxTurnTailPrompt } from './system-prompt/sandbox-context-prompt.js';
import { computeCost } from './telemetry/cost.js';
import { getBuiltinPricing } from './telemetry/builtin-pricing.js';
import {
  buildRuntimeEventModelReplayPlan,
  buildSteeringEnvelope,
  collectToolActivityTurnIds,
  formatTextWithInlineRefs,
  steeringMessagesMissingFromBase,
  steeringModelMessage,
  steeringProviderOptions,
  stripSteeringMessages,
  type RuntimeEventModelReplayItem,
  type RuntimeEventModelReplayPlan,
  type RuntimeEventReplayFallbackGate,
} from './model-history.js';
import {
  computeRequestShapeDiagnostic,
  toolSchemaCharsForDiagnostics,
  type RequestShapeDiagnostic,
} from './request-shape.js';
import {
  ProviderRequestTracker,
  type ProviderRequestAttemptRecord,
  type ProviderRequestCaptureRecord,
} from './provider-request-telemetry.js';
import { ToolAvailabilityRuntime, type ToolAvailabilityConfig } from './tool-availability.js';
import { renderSwarmModePrompt } from './swarm-mode.js';
import { renderGraphModePrompt } from './graph-mode.js';
import {
  applyRuntimeEventContextBudget,
  buildContextBudgetDiagnosticShell,
  buildHistoryCompactBlockFromSummary,
  buildHistorySearchSource,
  buildPromptSegmentEstimates,
  estimateRuntimeEventsTokens,
  mergeContextBudgetDiagnostic,
  mergeContextBudgetDiagnosticPatches,
  mergeRuntimeEventsInOriginalOrder,
  minimalContextBudgetDiagnostic,
  rawEvidenceRequestReason,
  retrieveArchivedToolResultsForReplay,
  retrieveReplayHistoryAroundSearchSource,
  retrieveRuntimeEventHistoryAround,
  runtimeEventTurnKey,
  shouldAppendContextCompactedNote,
  shouldAppendContextCompactionFailedOpenNote,
  type ContextBudgetPolicy,
  type ToolResultArchiveReader,
} from './context-budget.js';
import {
  evaluateHistoryCompactCheckpointReplay,
  replaceHistoryCompactReplayBlocks,
} from './history-compact.js';
import { selectSynthesisCacheForReplay } from './synthesis-cache.js';
import {
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  projectHistoryCompactCheckpointReplay,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import { resolveSelectedModelContextWindow } from './context-budget-policy.js';
export {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
  MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN,
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatSyntheticToolErrorText,
} from './tool-runtime.js';
export { normalizeAiSdkUsage } from './model-adapter.js';
export type { ModelFactory, ModelFactoryInput, RepairableAiSdkToolCall } from './model-adapter.js';
export type { RunTraceEvent, RunTraceRecorder } from './run-trace.js';

const CHILD_STEP_BUDGET_FINALIZATION_PROMPT = [
  '<step_budget_finalization>',
  'This is the final budgeted step for this child-agent turn.',
  'Do not call tools. Return the best concise final answer now using evidence already gathered.',
  'Clearly separate verified findings from inference and explicitly name any remaining gaps.',
  '</step_budget_finalization>',
].join('\n');

// ============================================================================
// AgentBackend interface — port contract now lives in @maka/core/backend-types;
// re-exported here for backward compatibility with existing import sites.
// ============================================================================

export type {
  AgentBackend,
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
} from '@maka/core/backend-types';

export const INVALID_TOOL_NAME = 'invalid';

function joinPromptFragments(fragments: readonly (string | undefined)[]): string | undefined {
  const joined = fragments
    .map((fragment) => fragment?.trim())
    .filter((fragment): fragment is string => Boolean(fragment))
    .join('\n\n');
  return joined.length > 0 ? joined : undefined;
}

// ============================================================================
// Constructor input — single object matches @kabi's BackendRegistry call site
// ============================================================================

/**
 * Append-message writer — usually `(m) => store.appendMessage(sessionId, m)`.
 * Allows callers to inject a custom queueing/buffering strategy if needed.
 */
export type AppendMessageFn = (m: StoredMessage) => Promise<void>;
export type ToolTelemetryRecorder = (record: ToolInvocationRecord) => void;
export type {
  ActiveFullCompactBlockRecorder,
  HistoryCompactCheckpointLoader,
  HistoryCompactCheckpointRecorder,
  HistoryCompactLoader,
  HistoryCompactLoadInput,
  HistoryCompactLoadResult,
  HistoryCompactSummarizer,
  HistoryCompactSummaryInput,
  HistoryCompactWriter,
  HistoryCompactWriteInput,
  HistoryCompactWriteResult,
  LlmTelemetryRecorder,
  SemanticCompactBlockRecorder,
  SynthesisCacheLoader,
  SynthesisCacheLoadInput,
  SynthesisCacheLoadResult,
  SynthesisCacheWriter,
  SynthesisCacheWriteInput,
  SynthesisCacheWriteResult,
  ToolResultArchiveRecorder,
  ToolResultArchiveRecorderInput,
} from './ai-sdk-compaction-contract.js';

export interface AiSdkBackendInput extends AiSdkCompactionCapabilities {
  // ── Session context ────────────────────────────────────────────────────
  sessionId: string;
  header: SessionHeader;
  /** Append-message function bound to this session (e.g. SessionStore wrapper). */
  appendMessage: AppendMessageFn;
  /** Reads the authoritative session boundary immediately before every local tool invocation. */
  readExecutionBoundary: ToolRuntimeInput['readExecutionBoundary'];
  createSandboxBoundaryRequest?: ToolRuntimeInput['createSandboxBoundaryRequest'];
  settleSandboxBoundaryRequest?: ToolRuntimeInput['settleSandboxBoundaryRequest'];

  // ── Process-singleton deps ─────────────────────────────────────────────
  /** Canonical-named tools available this session. */
  tools: MakaTool[];
  /** Active profile and enforcement capability snapshot for this session backend. */
  sandboxDiagnosticsSnapshot?: SandboxDiagnosticsSnapshot;
  /** Diagnostic-only Plan Mode/execution identity snapshot. */
  planTraceContext?: {
    mode: 'agent' | 'plan';
    storeVersion: number;
    planId?: string;
    proposalId?: string;
    executionId?: string;
  };
  /**
   * Optional unified tool-availability config (issue #37). With `economy: true`,
   * only core + ungrouped tools are advertised each turn; each group's tools are
   * withheld until the model activates the group via `load_tools`, which takes
   * effect in the next Runtime request projection and persists across turns via the
   * RuntimeEvent ledger. Omitted or `economy: false` advertises every tool every
   * turn (full surface). The runtime owns the catalog, connector, activation,
   * gating, and diagnostics.
   */
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
  /** Test seam for the Runtime-owned provider retry clock. */
  providerRetrySleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Optional system prompt (skills + workspace AGENTS.md merged upstream). */
  systemPrompt?:
    | string
    | ((context: SystemPromptContext) => string | undefined | Promise<string | undefined>);
  /** Optional provider-visible current-turn tail kept out of the durable system prefix. */
  turnTailPrompt?:
    | string
    | ((context: SystemPromptContext) => string | undefined | Promise<string | undefined>);
  /** Optional volatile ShellRun summary. Not persisted; appended to the current user turn tail only. */
  shellRunContextSummary?: () => string | undefined | Promise<string | undefined>;
  /** Provider-native options passed through to ai-sdk. */
  providerOptions?: Record<string, unknown>;
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
  spawnChildAgent?: (input: {
    parentRunId: string;
    spec: AgentSpec;
    prompt: string;
    abortSignal: AbortSignal;
    onReady?: (input: {
      turnId: string;
      agentId: string;
      agentName: string;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  spawnChildSession?: ToolRuntimeInput['spawnChildSession'];
  prepareChildAgentResume?: ToolRuntimeInput['prepareChildAgentResume'];
  resumeChildAgent?: ToolRuntimeInput['resumeChildAgent'];
  retryChildAgent?: (input: {
    parentRunId: string;
    sourceRunId: string;
    execution?: SubagentExecutionRef;
    abortSignal: AbortSignal;
    onReady?: (input: {
      childSessionId?: string;
      turnId: string;
      runId?: string;
      agentId: string;
      agentName: string;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: ToolRuntimeInput['readChildAgentOutput'];
  /** Optional diagnostic trace hook for explaining a runtime turn without changing renderer events. */
  recordRunTrace?: RunTraceRecorder;
  /**
   * Durable prepared-request capture boundary. When configured, rejection
   * prevents the corresponding provider request from being dispatched.
   */
  recordProviderRequestCapture?: (
    capture: ProviderRequestCaptureRecord,
  ) => Promise<{ artifactId: string }>;
  /** Best-effort durable row for one physical provider request attempt. */
  recordProviderRequestAttempt?: (attempt: ProviderRequestAttemptRecord) => void | Promise<void>;
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
  /**
   * Whether the selected model accepts image input. Only explicit true sends
   * image parts; false/unknown stay as text refs with a fallback note.
   */
  supportsVision?: boolean;
  maxProviderImageRequestBytes?: number;
  /**
   * Optional archive reader for replay-only stale tool-result retrieval. The
   * runtime never mutates persisted RuntimeEvents; successful reads hydrate
   * the current model request only.
   */
  readToolResultArchive?: ToolResultArchiveReader;
}

export interface SystemPromptContext {
  sessionId: string;
  turnId: string;
  cwd: string;
  workspaceRoot: string;
  /** Diagnostic-only skill catalog trace; never affects prompt construction. */
  emitSkillCatalogTrace?: (message: string, data?: Record<string, unknown>) => void;
}

function appendNonVisionImageFallbackNotice(textContent: string): string {
  return `${textContent}\n\n[image attachments omitted: the selected model does not support image input. Tell the user you cannot view the attached image(s) and ask them to describe the image or switch to a vision-capable model.]`;
}

function isImageToolResult(
  value: unknown,
): value is { kind: 'image'; mimeType: string; ref: StorageRef } {
  if (!value || typeof value !== 'object') return false;
  const image = value as { kind?: unknown; mimeType?: unknown; ref?: unknown };
  return (
    image.kind === 'image' &&
    typeof image.mimeType === 'string' &&
    image.ref !== null &&
    typeof image.ref === 'object'
  );
}

function toolResultText(text: string): ToolResultOutput {
  return { type: 'content', value: [{ type: 'text', text }] };
}

const MAX_PROVIDER_ATTEMPTS_PER_STEP = 10;
const PROVIDER_RETRY_BASE_DELAY_MS = 1_000;
const PROVIDER_RETRY_MAX_DELAY_MS = 32_000;
const PROVIDER_RETRY_JITTER_FACTOR = 0.25;

function providerRetryDelayMs(failedAttempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const base = Math.min(
    PROVIDER_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failedAttempt - 1),
    PROVIDER_RETRY_MAX_DELAY_MS,
  );
  return Math.ceil(base + Math.random() * PROVIDER_RETRY_JITTER_FACTOR * base);
}

function providerRetryReason(kind: ModelFailureKind): ProviderRetryReason {
  switch (kind) {
    case 'network':
    case 'provider_unavailable':
    case 'rate_limit':
    case 'timeout':
      return kind;
    default:
      return 'unknown';
  }
}

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
  private readonly toolRuntime: ToolRuntime;
  private readonly modelAdapter: ModelAdapter;
  private readonly toolAvailabilityRuntime: ToolAvailabilityRuntime;

  private aborted = false;
  private abortController: AbortController | null = null;
  private currentTurnId: string | null = null;
  private loopStopRequested = false;
  private handoffStopReason: CompleteEvent['stopReason'] | undefined;
  private currentInvocationId: string | null = null;
  /**
   * User messages steered into the running turn, drained from the caller's
   * queue at step boundaries. Each entry is the canonical envelope-wrapped
   * user ModelMessage — the SAME form the replay plan projects the persisted
   * steering event as, so the envelope text is the message's identity when
   * deduping against ledger-derived request bases (bare text is not an
   * identity: a steer can equal the current prompt verbatim). Entries are
   * added only AFTER the echoed steering_message event is durably consumed
   * (seq-ack), so a provider request never carries an unpersisted steering
   * directive. Reset per turn.
   */
  private injectedSteeringMessages: ModelMessage[] = [];
  private currentRunId: string | null = null;
  private currentOrchestration: EffectiveOrchestration | undefined;
  private imageRequestBudget: { used: number; decisions: Map<string, boolean> } | null = null;
  /** Side-channel for ToolRuntime settlement to push events into the iterator. */
  private currentQueue: AsyncEventQueue<SessionEvent> | null = null;
  /** Paused while the backend is waiting on a user permission decision. */
  private currentWatchdog: StreamWatchdog | null = null;
  private currentRunTrace: RunTrace | null = null;
  private currentUserIntent: string | undefined;
  private priorRequestShape: RequestShapeDiagnostic | undefined;
  private readonly compaction: AiSdkCompaction;
  private cumulativeUsageCheckpoint: NormalizedAiSdkUsage | undefined;
  constructor(input: AiSdkBackendInput) {
    this.input = input;
    this.sessionId = input.sessionId;
    this.newId = input.newId ?? (() => crypto.randomUUID());
    this.now = input.now ?? (() => Date.now());
    this.maxSteps = input.maxSteps;
    this.providerRetrySleep = input.providerRetrySleep ?? sleepForProviderRetry;
    this.modelAdapter = new ModelAdapter({
      connection: input.connection,
      apiKey: input.apiKey,
      modelId: input.modelId,
      modelFactory: input.modelFactory,
      providerOptions: input.providerOptions,
      newId: this.newId,
      now: this.now,
    });
    this.compaction = new AiSdkCompaction({
      input,
      sessionId: this.sessionId,
      now: this.now,
      modelAdapter: this.modelAdapter,
      computeCostUsd: (usage) => this.computeTokenUsageCostUsd(usage),
      materializeRuntimeReplayPlan: (plan) => this.materializeRuntimeReplayPlan(plan),
      canReplayProviderNative: (plan) => this.canReplayProviderNative(plan),
      appendTurnTailPrompt: (content, turnTailPrompt) =>
        this.appendTurnTailPrompt(content, turnTailPrompt),
    });
    this.toolAvailabilityRuntime = new ToolAvailabilityRuntime(
      input.tools,
      input.toolAvailability,
      buildInvalidMakaTool(),
    );
    this.toolRuntime = new ToolRuntime({
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
      getPermissionPauseTarget: () => this.currentWatchdog,
      getCurrentInvocationId: () => this.currentInvocationId ?? undefined,
      getCurrentRunId: () => this.currentRunId ?? undefined,
      materializeDefaultToolResultOutput: ({ toolCallId, output }) =>
        this.materializeToolResultOutput(output, false, toolCallId),
      getCurrentOrchestration: () => this.currentOrchestration,
      spawnChildAgent: input.spawnChildAgent,
      spawnChildSession: input.spawnChildSession,
      prepareChildAgentResume: input.prepareChildAgentResume,
      resumeChildAgent: input.resumeChildAgent,
      retryChildAgent: input.retryChildAgent,
      listChildAgents: input.listChildAgents,
      readChildAgentOutput: input.readChildAgentOutput,
      getRunTrace: () => this.currentRunTrace,
      recordToolInvocation: input.recordToolInvocation,
      runtimeCommitSink: input.runtimeCommitSink,
      recordToolArtifacts: input.recordToolArtifacts,
    });
  }

  // --------------------------------------------------------------------------
  // manual history compaction
  // --------------------------------------------------------------------------

  async compactHistory(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult> {
    return this.compaction.compactHistory(input, this.priorRequestShape?.requestShapeHash);
  }

  // --------------------------------------------------------------------------
  // send()
  // --------------------------------------------------------------------------

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.aborted = false;
    const turnId = input.turnId;
    this.currentTurnId = turnId;
    this.currentInvocationId = input.invocationId ?? input.runId ?? null;
    this.currentRunId = input.runId ?? null;
    this.currentOrchestration =
      input.orchestration ??
      resolveEffectiveOrchestration(this.input.header.orchestrationMode, undefined);
    this.currentUserIntent = input.text;
    this.toolRuntime.beginTurn(turnId, input.hostedInteraction);
    const turnAbortController = new AbortController();
    this.abortController = turnAbortController;
    this.imageRequestBudget = { used: 0, decisions: new Map() };

    const midTurnState = this.compaction.buildMidTurnCapacityCompactState(input);
    const queue = new AsyncEventQueue<SessionEvent>();
    this.currentQueue = queue;
    this.injectedSteeringMessages = [];

    // One AssistantMessage is flushed per provider step (not per turn), so the
    // ledger records the text↔tool timeline at step granularity and each step's
    // Anthropic thinking signature stays paired with its own thinking text. The
    // turn's first step reuses this id; every later step rotates to a fresh one
    // at its step boundary (see the stream loop below).
    let currentStepMessageId = this.newId();
    let stepText = '';
    let stepThinking = '';
    let sawStepThinking = false;
    let stepThinkingProviderOptions: NonNullable<ModelMessage['providerOptions']> | undefined;
    let stepResponsesThinkingParts: AssistantThinkingPart[] = [];
    let stepSignature: string | undefined;
    const startedAt = this.now();

    // Flush the current step's AssistantMessage (text + thinking) and the paired
    // terminal thinking/text events, then clear the per-step accumulators.
    // Persist when the step produced text OR reasoning — a thinking-only step
    // (Anthropic's signed/omitted reasoning has empty text) still round-trips its
    // signed block; a pure-tool step (no text, no thinking) writes nothing, so
    // tool-only steps leave no placeholder assistant row. thinking_complete
    // precedes text_complete so the read-model attaches this step's reasoning to
    // this step's assistant row. Hoisted to send() scope so both the streaming
    // path and the abort/error handler can flush a partial step.
    const flushStep = async (): Promise<void> => {
      const hasThinking = sawStepThinking || stepSignature !== undefined;
      if (stepText.length === 0 && !hasThinking) return;
      const stepId = currentStepMessageId;
      const thinkingParts: AssistantThinkingPart[] =
        stepResponsesThinkingParts.length > 0
          ? stepResponsesThinkingParts
          : [
              {
                text: stepThinking,
                ...(stepSignature !== undefined ? { signature: stepSignature } : {}),
                ...(stepThinkingProviderOptions !== undefined
                  ? { providerOptions: stepThinkingProviderOptions }
                  : {}),
              },
            ];
      const msg: AssistantMessage = {
        type: 'assistant',
        id: stepId,
        turnId,
        ts: this.now(),
        text: stepText,
        modelId: this.input.modelId,
        ...(hasThinking
          ? {
              thinking: {
                text: stepThinking,
                ...(thinkingParts.length === 1 && thinkingParts[0]!.signature !== undefined
                  ? { signature: thinkingParts[0]!.signature }
                  : {}),
                ...(thinkingParts.length === 1 && thinkingParts[0]!.providerOptions !== undefined
                  ? { providerOptions: thinkingParts[0]!.providerOptions }
                  : {}),
                ...(thinkingParts.length > 1 ? { parts: thinkingParts } : {}),
              },
            }
          : {}),
      };
      await this.input.appendMessage(msg);
      if (hasThinking) {
        for (const part of thinkingParts) {
          queue.push({
            type: 'thinking_complete',
            id: this.newId(),
            turnId,
            ts: this.now(),
            messageId: stepId,
            text: part.text,
            ...(part.signature !== undefined ? { signature: part.signature } : {}),
            ...(part.providerOptions !== undefined
              ? { providerOptions: part.providerOptions }
              : {}),
          } satisfies ThinkingCompleteEvent);
        }
      }
      queue.push({
        type: 'text_complete',
        id: this.newId(),
        turnId,
        ts: this.now(),
        messageId: stepId,
        text: stepText,
      } satisfies TextCompleteEvent);
      stepText = '';
      stepThinking = '';
      sawStepThinking = false;
      stepThinkingProviderOptions = undefined;
      stepResponsesThinkingParts = [];
      stepSignature = undefined;
    };
    let tokenUsage: NormalizedAiSdkUsage | undefined;
    let tokenUsageCostUsd: number | undefined;
    // Per-send sum of every COMPLETED step's usage, merged at each finish-step
    // boundary. When the send aborts (mid-turn exhaust, user stop, stream
    // error) the SDK's cumulative `usage` promise may not resolve, but this sum is
    // real provider-reported evidence for the steps that did finish — IF every
    // completed step produced a usable sample. One unusable sample makes the
    // sum a partial cost, and LlmCallRecord has no partial marker, so the flag
    // fails the whole fallback closed (#972: incomplete usage is no usage).
    let completedStepUsage: NormalizedAiSdkUsage | undefined;
    let sawUnusableStepUsage = false;
    // Input tokens from the last completed step — the actual prompt token count
    // of the final API request. Used to compute contextRemaining for the TUI
    // statusline ctx segment (#1067): contextRemaining = contextWindow - this.
    // result.usage.inputTokens is cumulative across steps and would produce
    // misleading >100% percentages, so the per-step value is captured here.
    let lastStepInputTokens: number | undefined;
    let streamStatus: LlmCallRecord['status'] = 'success';
    let streamErrorClass: string | undefined;
    let rawFinishReason: string | undefined;
    let runtimeSteps = 0;
    let requestShapeForTelemetry: RequestShapeDiagnostic | undefined;
    let promptSegmentsForTelemetry: PromptSegmentEstimate[] = [];
    let contextBudgetForTelemetry: ContextBudgetDiagnostic | undefined;
    let contextCompactedNoteWritten = false;
    let contextCompactionFailedOpenNoteWritten = false;
    const trace = new RunTrace({
      sessionId: this.sessionId,
      turnId,
      connectionSlug: this.input.connection.slug,
      providerId: this.input.connection.providerType,
      modelId: this.input.modelId,
      newId: this.newId,
      now: this.now,
      record: this.input.recordRunTrace,
    });
    this.currentRunTrace = trace;
    trace.turnStarted({
      orchestrationMode: this.currentOrchestration.mode,
      orchestrationSource: this.currentOrchestration.source,
      agentSwarmAuthorization: this.currentOrchestration.agentSwarmAuthorization,
    });
    if (this.input.planTraceContext) {
      trace.emit('plan', 'plan_context_resolved', 'Plan context resolved', {
        ...this.input.planTraceContext,
      });
      if (this.input.planTraceContext.executionId) {
        trace.emit('plan', 'plan_execution_started', 'Plan execution turn started', {
          ...this.input.planTraceContext,
        });
      }
    }
    if (this.input.sandboxDiagnosticsSnapshot) {
      trace.sandboxContextResolved(
        toSandboxRunTraceProjection(this.input.sandboxDiagnosticsSnapshot),
      );
    }
    const recordProviderRequestCapture = this.input.recordProviderRequestCapture;
    const providerRequestTraceId = recordProviderRequestCapture ? this.newId() : undefined;
    const providerRequestTracker = providerRequestTraceId
      ? new ProviderRequestTracker({
          traceId: providerRequestTraceId,
          turnId,
          contextWindow: resolveSelectedModelContextWindow(
            this.input.connection,
            this.input.modelId,
          ),
          now: this.now,
          newId: this.newId,
          persistCapture: recordProviderRequestCapture!,
          recordAttempt: this.input.recordProviderRequestAttempt ?? (() => {}),
        })
      : undefined;

    // --- Resolve model (API key already attached at construct time) ---
    let model: unknown;
    try {
      model = this.modelAdapter.resolveModel();
      trace.modelResolved();
    } catch (err) {
      trace.modelResolveFailed(err);
      queue.push(this.makeErrorEvent(turnId, err));
      queue.push({
        type: 'complete',
        id: this.newId(),
        turnId,
        ts: this.now(),
        stopReason: 'error',
      } satisfies CompleteEvent);
      queue.close();
      await this.cleanupAfterTurn(turnId);
      yield* this.drain(queue);
      return;
    }

    // --- Build the provider-visible schema set. Tool execution stays in Runtime. ---
    // One runtime owns provider-visible tool availability (issue #37): the
    // catalog, the `load_tools` connector, same-turn activation between requests,
    // the execute-boundary gating, and the diagnostics. Seed prior-turn group
    // activations from the durable ledger (the current turn is excluded — it has
    // not committed yet) so a group loaded earlier stays advertised.
    const requiredOrchestrationTools =
      this.currentOrchestration.mode === 'swarm'
        ? new Set(['agent_swarm'])
        : this.currentOrchestration.mode === 'graph'
          ? new Set(['view_agent_graph', 'update_agent_graph', 'agent_output'])
          : new Set<string>();
    const plan = this.toolAvailabilityRuntime.prepare(
      (input.runtimeContext ?? []).filter((event) => event.turnId !== turnId),
      requiredOrchestrationTools,
    );
    const providerTools = plan.providerTools;
    let activeToolResultPruneDiagnosticPatch: ActiveToolResultPruneDiagnosticPatch = {};
    let activeCompactDiagnosticPatch: Partial<ContextBudgetDiagnostic> | undefined;
    // Tool names the repair path matches a mis-cased call against — follows the
    // current step's snapshot so a group loaded mid-turn is repairable on the
    // step it becomes active, not routed to `invalid`.
    const currentRepairToolNames = plan.currentRepairToolNames;
    // Establish clean per-turn ToolRuntime state at the START of the turn, then
    // install this turn's gating. cleanupAfterTurn() also resets at turn end, but
    // that runs in send()'s finally and so depends on the consumer draining (or
    // .return()-ing) the generator; resetting here makes each turn's state — the
    // loop-gate streak, subagent count, gating — depend only on this turn, not on
    // the previous turn's teardown.
    if (plan.gating) {
      this.toolRuntime.setGating(plan.gating);
    }

    const modelTools: ModelToolSet = {};
    for (const t of providerTools) {
      modelTools[t.name] = {
        description: t.description,
        inputSchema: t.parameters,
      };
    }

    // --- Build messages from RuntimeEvent history and its compatibility projection. ---
    const priorReplay = await this.buildPriorMessages(input);
    if (input.continuation && priorReplay.messages.length === 0) {
      const replay = priorReplayFailureTrace(priorReplay);
      const error = new ContinuationReplayEmptyError(replay.gate, replay.diagnosticCodes);
      trace.modelStreamFailed(error.code, error, replay);
      queue.push(this.makeErrorEvent(turnId, error));
      queue.push({
        type: 'complete',
        id: this.newId(),
        turnId,
        ts: this.now(),
        stopReason: 'error',
      } satisfies CompleteEvent);
      queue.close();
      await this.cleanupAfterTurn(turnId);
      yield* this.drain(queue);
      return;
    }
    if (midTurnState) {
      // Roll-forward seed: the latest durable checkpoint (loaded or written at
      // turn start) so a mid-turn summary only re-reads the newly folded span.
      midTurnState.previousCheckpoint = priorReplay.latestHistoryCompactCheckpoint;
    }

    // --- Background pump: streamText → stream → normalize → queue ---
    const pumpDone: Promise<void> = (async () => {
      let watchdog: StreamWatchdog | null = null;
      let watchdogTimeoutError: Error | null = null;
      try {
        watchdog = new StreamWatchdog({
          now: this.now,
          connectTimeoutMs: this.input.streamConnectTimeoutMs,
          idleTimeoutMs: this.input.streamIdleTimeoutMs,
          onTimeout: (timeout) => {
            const message = formatStreamWatchdogError(timeout);
            watchdogTimeoutError = new Error(message);
            queue.push(this.makeErrorEvent(turnId, watchdogTimeoutError));
            trace.modelStreamFailed(
              'Timeout',
              watchdogTimeoutError,
              priorReplayFailureTrace(priorReplay),
            );
            turnAbortController.abort(watchdogTimeoutError);
          },
        });
        this.currentWatchdog = watchdog;
        watchdog.start();
        const activeTools = plan.activeTools;
        const systemPrompt = joinPromptFragments([
          await this.resolveSystemPrompt(turnId),
          this.currentOrchestration?.mode === 'swarm' ? renderSwarmModePrompt() : undefined,
          this.currentOrchestration?.mode === 'graph' ? renderGraphModePrompt() : undefined,
        ]);
        const turnTailPrompt = input.continuation
          ? undefined
          : joinPromptFragments([
              await this.resolveTurnTailPrompt(turnId),
              await this.resolveShellRunContextSummary(),
              this.input.sandboxDiagnosticsSnapshot
                ? renderSandboxTurnTailPrompt(this.input.sandboxDiagnosticsSnapshot)
                : undefined,
            ]);
        const currentUserContent = input.continuation
          ? undefined
          : await this.buildCurrentUserContent(
              input.text,
              input.voiceAudio,
              input.attachments,
              input.quotes,
              input.headAnchorRuntimeEvent?.id,
            );
        const messages =
          currentUserContent === undefined
            ? [...priorReplay.messages]
            : [
                ...priorReplay.messages,
                {
                  role: 'user' as const,
                  content: this.appendTurnTailPrompt(currentUserContent, turnTailPrompt),
                } as ModelMessage,
              ];
        const settledModelOutputs = new Map<string, ToolResultOutput>();
        const loadDurableTurnEvents = async (): Promise<RuntimeEvent[]> => {
          const loadTurnRuntimeEvents = this.input.loadTurnRuntimeEvents;
          if (!loadTurnRuntimeEvents) {
            throw new Error('durable current-run reader is required for tool continuation');
          }
          await queue.waitUntilConsumedThroughCurrent();
          return (await loadTurnRuntimeEvents(turnId)).filter((event) => event.turnId === turnId);
        };
        const loadDurableTurnProjection = async (): Promise<ModelMessage[]> => {
          const turnEvents = await loadDurableTurnEvents();
          const replayPlan = buildRuntimeEventModelReplayPlan(turnEvents, {
            toolActivityTurnIds: collectToolActivityTurnIds([
              ...(input.runtimeContext ?? []),
              ...turnEvents,
            ]),
          });
          if (
            hasBlockingReplayDiagnostics(replayPlan) ||
            (replayPlan.hasProviderNativeSemantics && !this.canReplayProviderNative(replayPlan))
          ) {
            throw new Error('durable current-run projection is not replayable');
          }
          const anchorEventId = input.headAnchorRuntimeEvent?.id;
          let decoratedCurrentUser = false;
          let currentUserOrdinal = -1;
          let userOrdinal = 0;
          const replayItems = replayPlan.items.map((item) => {
            if (item.kind !== 'text' || item.role !== 'user') {
              return item;
            }
            const ordinal = userOrdinal++;
            if (
              anchorEventId !== undefined ? item.eventId !== anchorEventId : decoratedCurrentUser
            ) {
              return item;
            }
            decoratedCurrentUser = true;
            currentUserOrdinal = ordinal;
            return {
              ...item,
              content: this.appendTurnTailPrompt(item.content, turnTailPrompt) as string,
            };
          });
          const currentTurnMessages = await this.materializeRuntimeReplayPlan(
            { ...replayPlan, items: replayItems },
            settledModelOutputs,
          );
          const operationAudio = input.voiceAudio ? voiceAudioPart(input.voiceAudio) : undefined;
          return [
            ...priorReplay.messages,
            ...(operationAudio && currentUserOrdinal >= 0
              ? attachAudioToUserOrdinal(currentTurnMessages, currentUserOrdinal, operationAudio)
              : currentTurnMessages),
          ];
        };
        const activeCompactionHeadAnchor =
          messages[messages.length - 1]?.role === 'user'
            ? buildActiveCompactionHeadAnchor(
                messages,
                messages.length - 1,
                this.input.contextBudget?.charsPerToken,
              )
            : undefined;
        // Diagnostics describe the provider-visible (active) tool subset. A group
        // loaded *this* turn expands that subset on later provider requests,
        // so the durable cost record is refined against the final active set once
        // the stream is consumed (see below). Both computations classify against
        // the same pre-turn baseline. The availability runtime builds the tool
        // diagnostic from the same per-step active set + schema-char measurement.
        contextBudgetForTelemetry = priorReplay.contextBudget;
        const priorShapeBaseline = this.priorRequestShape;
        const computeTurnDiagnostics = (active: readonly string[]) => {
          const toolSchemaChars = toolSchemaCharsForDiagnostics(providerTools, active);
          const toolAvailabilityDiagnostic = plan.diagnostics(active, toolSchemaChars);
          return {
            promptSegments: buildPromptSegmentEstimates({
              systemPrompt,
              toolSchemaChars,
              toolCount: active.length,
              priorMessages: priorReplay.messages,
              priorRuntimeEventCount: priorReplay.runtimeEventCount,
              currentUserContent: input.continuation
                ? ''
                : formatTextWithInlineRefs(input.text, {
                    ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
                    ...(input.quotes !== undefined ? { quotes: input.quotes } : {}),
                  }),
              turnTailPrompt,
            }),
            requestShape: computeRequestShapeDiagnostic(
              {
                connection: this.input.connection,
                modelId: this.input.modelId,
                systemPrompt,
                providerOptions: this.input.providerOptions,
                providerTools,
                activeTools: active,
                priorMessages: priorReplay.messages,
                ...(toolAvailabilityDiagnostic !== undefined
                  ? { toolAvailability: toolAvailabilityDiagnostic }
                  : {}),
              },
              priorShapeBaseline,
            ),
          };
        };
        // Publish a diagnostics snapshot to every telemetry sink at once so the
        // cost record, the prefix baseline, and the context-budget high-water
        // "after" hash never diverge — they must all describe the same active
        // tool set. A same-turn deferred load re-publishes the final snapshot
        // below; the high-water "before" hash is the pre-turn baseline, set once.
        let turnDiagnostics = computeTurnDiagnostics(activeTools);
        const publishTurnDiagnostics = (diag: typeof turnDiagnostics): void => {
          turnDiagnostics = diag;
          promptSegmentsForTelemetry = diag.promptSegments;
          requestShapeForTelemetry = diag.requestShape;
          this.priorRequestShape = diag.requestShape;
          if (priorReplay.contextBudget?.highWaterReason) {
            priorReplay.contextBudget.highWaterRequestShapeHashAfter =
              diag.requestShape.requestShapeHash;
          }
        };
        // Step-0 (turn-start) view: literally what the first request carries, so
        // the stream-start trace reports it as the prefix actually sent.
        if (priorReplay.contextBudget?.highWaterReason) {
          priorReplay.contextBudget.highWaterRequestShapeHashBefore =
            priorShapeBaseline?.requestShapeHash;
        }
        publishTurnDiagnostics(turnDiagnostics);
        trace.modelStreamStarted(activeTools, {
          systemPromptHash: turnDiagnostics.requestShape.componentHashes.systemPromptHash,
          prefixHash: turnDiagnostics.requestShape.prefixHash,
          prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
          requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
          requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
          ...(turnDiagnostics.requestShape.toolSchemaChangeReason !== undefined
            ? { toolSchemaChangeReason: turnDiagnostics.requestShape.toolSchemaChangeReason }
            : {}),
          ...(turnDiagnostics.requestShape.toolAvailability !== undefined
            ? { toolAvailability: turnDiagnostics.requestShape.toolAvailability }
            : {}),
          promptSegments: turnDiagnostics.promptSegments,
          ...(priorReplay.contextBudget ? { contextBudget: priorReplay.contextBudget } : {}),
        });

        const stepRequestShapeHash = (
          stepMessages: readonly ModelMessage[],
          activeToolsForStep: readonly string[] | undefined,
        ): string =>
          computeRequestShapeDiagnostic(
            {
              connection: this.input.connection,
              modelId: this.input.modelId,
              systemPrompt,
              providerOptions: this.input.providerOptions,
              providerTools,
              activeTools: activeToolsForStep ?? plan.activeTools,
              priorMessages: stepMessages,
            },
            priorShapeBaseline,
          ).requestShapeHash;
        const activeCompactHook = composeActiveCompactionProjection(
          this.compaction.buildSemanticCompactProjection(
            turnId,
            model,
            input.runtimeContext,
            activeCompactionHeadAnchor,
            (messagesForStep, activeToolsForStep) =>
              stepRequestShapeHash(messagesForStep, activeToolsForStep),
            (patch) => {
              activeCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
                activeCompactDiagnosticPatch,
                patch,
              );
            },
            turnAbortController.signal,
          ),
          this.compaction.buildActiveFullCompactProjection(
            turnId,
            input.runtimeContext,
            activeCompactionHeadAnchor,
            (messagesForStep, activeToolsForStep) =>
              stepRequestShapeHash(messagesForStep, activeToolsForStep),
            (patch) => {
              activeCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
                activeCompactDiagnosticPatch,
                patch,
              );
            },
          ),
        );
        // Deterministic priority on a capacity-replaced step: the hard window
        // invariant owns the projection, so semantic/active-full compaction
        // yields for that step (recorded as a decision) instead of running a
        // second summarizer over the same request.
        const activeCompactAfterMidTurn =
          activeCompactHook && midTurnState
            ? (options: RequestProjectionContext) => {
                if (midTurnState.replacedStepNumber === options.stepNumber) {
                  activeCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
                    activeCompactDiagnosticPatch,
                    compactionDecisionDiagnosticPatch({
                      stage: 'activeStep',
                      sourceKind: 'providerMessages',
                      decision: 'unchanged',
                      boundaryKind: 'historyCompact',
                      reason: 'mid_turn_capacity_precedence',
                      skippedReasonCounts: { mid_turn_capacity_precedence: 1 },
                    }),
                  );
                  return undefined;
                }
                return activeCompactHook(options);
              }
            : activeCompactHook;
        const onMidTurnDiagnosticPatch = (patch: Partial<ContextBudgetDiagnostic>): void => {
          activeCompactDiagnosticPatch = mergeContextBudgetDiagnosticPatches(
            activeCompactDiagnosticPatch,
            patch,
          );
        };
        const midTurnSystemPromptChars = systemPrompt?.length ?? 0;
        const midTurnCapacityHook = this.compaction.buildMidTurnCapacityCompactProjection(
          turnId,
          midTurnState,
          queue,
          providerTools,
          () => currentRepairToolNames(),
          turnTailPrompt,
          midTurnSystemPromptChars,
          onMidTurnDiagnosticPatch,
          turnAbortController.signal,
        );
        // When mid-turn capacity compaction is active, the prune must also cover
        // the newest completed step; see collectPrunableCompletedStepToolCallIds.
        const activeToolResultPruneIncludesNewestStep = midTurnState !== undefined;
        const activeToolResultPruneHook = this.compaction.buildActiveToolResultPruneProjection(
          turnId,
          activeToolResultPruneIncludesNewestStep,
          (patch) => {
            activeToolResultPruneDiagnosticPatch = mergeActiveToolResultPruneDiagnosticPatches(
              activeToolResultPruneDiagnosticPatch,
              patch,
            );
          },
        );
        const shapedProjection = composeRequestProjection(
          plan.projectActiveTools,
          midTurnCapacityHook,
          activeToolResultPruneHook,
          activeCompactAfterMidTurn,
        );
        // The verdict owner wraps the WHOLE shaping pipeline: hooks shape, one
        // owner measures the final payload and decides pass/terminate.
        const requestProjection =
          midTurnState && midTurnCapacityHook && shapedProjection
            ? this.compaction.buildMidTurnFinalRequestVerdict({
                shaped: shapedProjection,
                reentry: composeRequestProjection(
                  undefined,
                  midTurnCapacityHook,
                  activeToolResultPruneHook,
                )!,
                state: midTurnState,
                providerTools,
                fallbackActiveTools: () => currentRepairToolNames(),
                charsPerToken: this.input.contextBudget?.charsPerToken ?? 4,
                systemPromptChars: midTurnSystemPromptChars,
                onDiagnosticPatch: onMidTurnDiagnosticPatch,
                abortController: turnAbortController,
              })
            : shapedProjection;

        const completedProviderSteps: RequestProjectionContext['completedSteps'][number][] = [];
        let requestMessages: ModelMessage[] = messages;
        let overflowRetryUsed = false;
        let result: ModelStreamResult;
        let finishReason: ModelFinishReason = 'stop';
        agentLoop: for (;;) {
          await this.drainSteeringInto(input, turnId, queue, turnAbortController.signal);
          if (this.input.loadTurnRuntimeEvents) {
            requestMessages = await loadDurableTurnProjection();
          } else {
            const missingSteering = steeringMessagesMissingFromBase(
              this.injectedSteeringMessages,
              requestMessages,
            );
            if (missingSteering.length > 0)
              requestMessages = [...requestMessages, ...missingSteering];
          }
          const shaped = requestProjection
            ? await requestProjection({
                completedSteps: completedProviderSteps,
                stepNumber: runtimeSteps,
                model,
                messages: requestMessages,
              })
            : undefined;
          const projectedMessages = shaped?.messages ?? requestMessages;
          const finalChildSummaryStep =
            this.input.header.collaborationMode === 'agent' &&
            this.maxSteps !== undefined &&
            this.maxSteps > 1 &&
            runtimeSteps === this.maxSteps - 1 &&
            completedProviderSteps.length > 0;
          const activeToolsForRequest = finalChildSummaryStep
            ? []
            : (shaped?.activeTools ?? currentRepairToolNames());
          const requestSystemPrompt = finalChildSummaryStep
            ? joinPromptFragments([systemPrompt, CHILD_STEP_BUDGET_FINALIZATION_PROMPT])
            : systemPrompt;
          providerRequestTracker?.setStep(runtimeSteps);
          let attemptMessages = projectedMessages;
          let providerAttempt = 1;
          const returnedToolCalls: ToolCallPart[] = [];
          const providerStepId = currentStepMessageId;
          let providerStepUsage: NormalizedUsage | undefined;
          const attemptHasNoObservableOutput = () =>
            returnedToolCalls.length === 0 &&
            stepText.length === 0 &&
            stepThinking.length === 0 &&
            stepSignature === undefined;
          for (;;) {
            result = await this.modelAdapter.startStream({
              model,
              messages: attemptMessages,
              tools: modelTools,
              activeTools: activeToolsForRequest,
              repairToolCall: async ({
                toolCall,
                error,
              }: {
                toolCall: RepairableAiSdkToolCall;
                error: unknown;
              }) => {
                return repairMakaToolCall({
                  toolCall,
                  availableToolNames: currentRepairToolNames(),
                  error,
                });
              },
              system: requestSystemPrompt,
              abortSignal: turnAbortController.signal,
              ...(providerRequestTracker ? { providerRequestTracker } : {}),
            });

            let streamFailure: unknown;
            let sawStreamError = false;
            try {
              for await (const event of result.events) {
                if (this.aborted) break;
                watchdog.markActivity();
                if (event.kind === 'error') {
                  // A request-level error ends this stream; capture it and stop
                  // consuming (the synthesized trailer carries no real step) so
                  // the recovery decision runs on the outcome, not the trailer.
                  streamFailure = event.failure;
                  sawStreamError = true;
                  break;
                }
                if (event.kind === 'step-finish') {
                  // Step boundary: AI SDK 7 delimits steps with `finish-step`
                  // (and `step-finish` for legacy replay fixtures); the adapter
                  // reduces both to this event. A duplicate boundary is harmless:
                  // the second flush no-ops (accumulators already cleared) and one
                  // extra id rotation just discards an unused id.
                  runtimeSteps += 1;
                  const stepUsage = event.usage;
                  providerStepUsage = stepUsage;
                  if (!stepUsage) sawUnusableStepUsage = true;
                  // Fail closed: reset on every step boundary so a missing final
                  // step's usage does not leave a stale value from an earlier step.
                  lastStepInputTokens = stepUsage?.inputTokens;
                  if (stepUsage) {
                    completedStepUsage = mergeNormalizedUsage(completedStepUsage, stepUsage);
                    this.cumulativeUsageCheckpoint = mergeNormalizedUsage(
                      this.cumulativeUsageCheckpoint,
                      stepUsage,
                    );
                    await this.input.recordUsageCheckpoint?.({
                      ...this.cumulativeUsageCheckpoint,
                      costUsd: this.computeTokenUsageCostUsd(this.cumulativeUsageCheckpoint),
                    });
                  }
                }
                if (event.kind === 'finish' || event.kind === 'step-finish') {
                  rawFinishReason = event.finishReason ?? rawFinishReason;
                }
                if (event.kind === 'text') {
                  stepText += event.text;
                  queue.push({
                    type: 'text_delta',
                    id: this.newId(),
                    turnId,
                    ts: this.now(),
                    messageId: currentStepMessageId,
                    text: event.text,
                  } satisfies TextDeltaEvent);
                } else if (event.kind === 'thinking') {
                  sawStepThinking = true;
                  stepThinking += event.text;
                  if (event.providerOptions !== undefined) {
                    stepThinkingProviderOptions = event.providerOptions;
                  }
                  const openai = event.providerOptions?.openai;
                  const itemId =
                    openai && typeof openai === 'object' && !Array.isArray(openai)
                      ? (openai as { itemId?: unknown }).itemId
                      : undefined;
                  if (typeof itemId === 'string' && itemId.length > 0) {
                    let part = stepResponsesThinkingParts.find(
                      (candidate) =>
                        (candidate.providerOptions?.openai as { itemId?: unknown } | undefined)
                          ?.itemId === itemId,
                    );
                    if (!part) {
                      part = {
                        text:
                          stepResponsesThinkingParts.length === 0 && event.text.length === 0
                            ? stepThinking
                            : '',
                        providerOptions: event.providerOptions,
                      };
                      stepResponsesThinkingParts.push(part);
                    } else {
                      part.providerOptions = event.providerOptions;
                    }
                    part.text += event.text;
                  } else if (stepResponsesThinkingParts.length > 0) {
                    stepResponsesThinkingParts.at(-1)!.text += event.text;
                  }
                  queue.push({
                    type: 'thinking_delta',
                    id: this.newId(),
                    turnId,
                    ts: this.now(),
                    messageId: currentStepMessageId,
                    text: event.text,
                  } satisfies ThinkingDeltaEvent);
                } else if (event.kind === 'thinking-signature') {
                  stepSignature = event.signature;
                } else if (event.kind === 'tool-call') {
                  returnedToolCalls.push(event.toolCall);
                } else if (event.kind === 'step-finish') {
                  // The step's text/thinking deltas are all in (the stream is
                  // drained in order), so flush this step's AssistantMessage and
                  // rotate to a fresh id for the next step. Tool settlement
                  // below receives this step's pre-rotation id, so durable replay
                  // can regroup calls with this reasoning/text.
                  await flushStep();
                  if (midTurnState) {
                    // Durability clock: step N's thinking/text completion events
                    // are enqueued by flushStep just above, so only after this
                    // boundary can a seq-ack wait for step N mean anything. Wake
                    // waiters AFTER the increment or they would re-check a stale
                    // count and sleep.
                    midTurnState.flushedSteps += 1;
                    queue.wake();
                  }
                }
              }
            } catch (error) {
              streamFailure = error;
              sawStreamError = true;
            }

            if (sawStreamError && !this.aborted) {
              if (this.loopStopRequested) throw streamFailure;
              // A retry is a fresh provider request that would run at least one
              // more step; with the send-level budget already spent there is
              // nothing left to grant it, so the error is terminal.
              const stepBudgetRemains = this.maxSteps === undefined || runtimeSteps < this.maxSteps;
              const recovered =
                stepBudgetRemains && attemptHasNoObservableOutput()
                  ? await this.compaction.recoverFromOverflowError({
                      error: streamFailure,
                      retryAlreadyUsed: overflowRetryUsed,
                      midTurnState,
                      turnId,
                      currentMessages: attemptMessages,
                      providerTools,
                      activeTools: activeToolsForRequest,
                      systemPromptChars: midTurnSystemPromptChars,
                      turnTailPrompt,
                      queue,
                      onDiagnosticPatch: onMidTurnDiagnosticPatch,
                      abortSignal: turnAbortController.signal,
                    })
                  : undefined;
              if (recovered) {
                overflowRetryUsed = true;
                // Recovery rebuilds the request from the durable ledger, whose
                // tool results intentionally retain their full bodies. Re-enter
                // the active-result projection before dispatch so an archived
                // result cannot reappear in provider context on the retry.
                const recoveredProjection = activeToolResultPruneHook
                  ? await activeToolResultPruneHook({
                      completedSteps: completedProviderSteps,
                      stepNumber: runtimeSteps,
                      model,
                      messages: recovered.messages,
                      activeTools: activeToolsForRequest,
                    })
                  : undefined;
                attemptMessages = recoveredProjection?.messages ?? recovered.messages;
                continue;
              }
              const failure = this.modelAdapter.normalizeFailure(streamFailure);
              if (
                failure.retryable &&
                providerAttempt < MAX_PROVIDER_ATTEMPTS_PER_STEP &&
                stepBudgetRemains &&
                attemptHasNoObservableOutput()
              ) {
                // The failed request did not return authoritative usage. Keep
                // effectiveness recoverable, but fail final metering closed.
                sawUnusableStepUsage = true;
                const delayMs = providerRetryDelayMs(providerAttempt, failure.retryAfterMs);
                const nextAttempt = providerAttempt + 1;
                const reason = providerRetryReason(failure.kind);
                queue.push({
                  type: 'provider_retry',
                  id: this.newId(),
                  turnId,
                  ts: this.now(),
                  phase: 'scheduled',
                  attempt: nextAttempt,
                  maxAttempts: MAX_PROVIDER_ATTEMPTS_PER_STEP,
                  delayMs,
                  reason,
                } satisfies ProviderRetryEvent);
                watchdog.pause();
                try {
                  await this.providerRetrySleep(delayMs, turnAbortController.signal);
                } finally {
                  watchdog.resume();
                }
                providerAttempt = nextAttempt;
                queue.push({
                  type: 'provider_retry',
                  id: this.newId(),
                  turnId,
                  ts: this.now(),
                  phase: 'started',
                  attempt: providerAttempt,
                  maxAttempts: MAX_PROVIDER_ATTEMPTS_PER_STEP,
                  reason,
                } satisfies ProviderRetryEvent);
                continue;
              }
              // Unrecoverable (not context-length, latch spent, no seam, or no
              // safe fold): surface the real provider error via the terminal
              // handler — never a fabricated success.
              throw streamFailure;
            }
            break;
          }

          // If the stream loop exited because stop() flipped this.aborted while a
          // provider kept yielding after abort instead of throwing, route to the
          // abort handling below. Without this, the post-stream success path would
          // persist a partial assistant turn and emit a false end_turn completion.
          if (this.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          }

          // Mid-turn exhaustion aborts the SDK stream, but streamText ends
          // gracefully on abort instead of throwing; route to the explicit
          // outcome regardless of how the stream wound down.
          if (midTurnState?.exhaustedDetail) {
            throw Object.assign(
              new Error(`mid-turn context budget exhausted: ${midTurnState.exhaustedDetail}`),
              { name: 'MidTurnContextBudgetExhaustedError' },
            );
          }

          // Catch-all: flush any residual step content if the provider closed the
          // stream without a trailing `finish-step` for the last step.
          await flushStep();

          finishReason = (await result.finishReason.catch(() => 'stop')) ?? 'stop';
          rawFinishReason = rawFinishReason ?? finishReason;
          await queue.waitUntilConsumedThroughCurrent();

          if (returnedToolCalls.length > 0) {
            const continuationBudgetRemains =
              this.maxSteps === undefined || runtimeSteps < this.maxSteps;
            if (continuationBudgetRemains && !this.input.loadTurnRuntimeEvents) {
              throw new Error('durable current-run reader is required for tool continuation');
            }
            if (this.input.loadTurnRuntimeEvents) {
              // Queue consumption alone does not prove that the latest assistant
              // facts remain readable. Fail before any external tool side effect
              // when the authoritative ledger became unavailable after the step.
              await loadDurableTurnEvents();
            }
            const toolsByName = new Map(providerTools.map((tool) => [tool.name, tool]));
            const settlementOutcomes = await Promise.allSettled(
              returnedToolCalls.map(async (toolCall) => {
                if (toolCall.providerExecuted) {
                  throw new Error(
                    `Provider-executed tool call "${toolCall.toolName}" is outside the main-agent tool loop`,
                  );
                }
                const requestedTool = toolsByName.get(toolCall.toolName);
                const tool = requestedTool ?? toolsByName.get(INVALID_TOOL_NAME);
                if (!tool) throw new Error('Runtime invalid-tool fallback is unavailable');
                return await this.toolRuntime.settleToolCall({
                  tool,
                  turnId,
                  stepId: providerStepId,
                  toolCallId: toolCall.toolCallId,
                  ...(toolCall.providerOptions !== undefined
                    ? { providerOptions: toolCall.providerOptions }
                    : {}),
                  input:
                    requestedTool !== undefined
                      ? toolCall.input
                      : {
                          tool: toolCall.toolName,
                          error: 'returned tool is unavailable',
                        },
                  abortSignal: turnAbortController.signal,
                  eventSink: queue,
                });
              }),
            );
            const rejectedSettlement = settlementOutcomes.find(
              (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
            );
            if (rejectedSettlement) throw rejectedSettlement.reason;
            const settlements = settlementOutcomes.flatMap((outcome) =>
              outcome.status === 'fulfilled' ? [outcome.value] : [],
            );
            for (const settlement of settlements) {
              if (isPlanToolResult(settlement.result)) {
                this.handlePlanToolResult(settlement.result, turnId, queue);
              }
            }
            await queue.waitUntilConsumedThroughCurrent();
            for (let index = 0; index < returnedToolCalls.length; index += 1) {
              const toolCall = returnedToolCalls[index];
              const settlement = settlements[index];
              if (toolCall && settlement) {
                settledModelOutputs.set(toolCall.toolCallId, settlement.modelOutput);
              }
            }
          }

          completedProviderSteps.push({
            toolCalls: returnedToolCalls,
            ...(providerStepUsage ? { usage: providerStepUsage } : {}),
          });
          const stepLimitReached = this.maxSteps !== undefined && runtimeSteps >= this.maxSteps;
          if (
            returnedToolCalls.length > 0 &&
            !stepLimitReached &&
            !this.loopStopRequested &&
            !this.aborted
          ) {
            currentStepMessageId = this.newId();
            continue agentLoop;
          }
          break agentLoop;
        }

        // Same-turn deferred load: request projection expanded the provider tool set on
        // later steps, so refine the durable cost record + prefix baseline against
        // the final active set — otherwise this turn under-reports the loaded
        // schema and the cache reset would surface a turn late. No-op when nothing
        // loaded this turn (the active set length is unchanged; the ratchet only
        // grows it).
        const finalActiveTools = currentRepairToolNames();
        if (finalActiveTools.length !== activeTools.length) {
          publishTurnDiagnostics(computeTurnDiagnostics(finalActiveTools));
        }

        // Final usage event. Each adapter result covers one provider request.
        // The send-level owner is `completedStepUsage`, which spans every
        // Runtime loop step and retry. Recording only the final result would
        // silently drop prior requests. An unusable sample in ANY request fails
        // the whole record closed (#972).
        try {
          const attemptTotalUsage = await result.usage;
          tokenUsage = sawUnusableStepUsage ? undefined : (completedStepUsage ?? attemptTotalUsage);
          if (tokenUsage) {
            const systemPromptHash = turnDiagnostics.requestShape.componentHashes.systemPromptHash;
            tokenUsageCostUsd = this.computeTokenUsageCostUsd(tokenUsage);
            trace.usageRecorded({
              ...tokenUsage,
              ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
              systemPromptHash,
              prefixHash: turnDiagnostics.requestShape.prefixHash,
              prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
              requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
              requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
              ...(turnDiagnostics.requestShape.toolSchemaChangeReason !== undefined
                ? { toolSchemaChangeReason: turnDiagnostics.requestShape.toolSchemaChangeReason }
                : {}),
              ...(turnDiagnostics.requestShape.toolAvailability !== undefined
                ? { toolAvailability: turnDiagnostics.requestShape.toolAvailability }
                : {}),
            });
            const contextBudgetForUsage = contextBudgetWithActiveProjectionDiagnostics(
              contextBudgetForTelemetry,
              activeToolResultPruneDiagnosticPatch,
              activeCompactDiagnosticPatch,
            );
            const tu: TokenUsageMessage = {
              type: 'token_usage',
              id: this.newId(),
              turnId,
              ts: this.now(),
              input: tokenUsage.inputTokens,
              output: tokenUsage.outputTokens,
              cacheHitInput: tokenUsage.cacheHitInputTokens,
              cacheMissInput: tokenUsage.cacheMissInputTokens,
              cacheMissInputSource: tokenUsage.cacheMissInputSource,
              cacheWriteInput: tokenUsage.cacheWriteInputTokens,
              reasoning: tokenUsage.reasoningTokens,
              total: tokenUsage.totalTokens,
              ...(tokenUsage.rawFinishReason !== undefined
                ? { rawFinishReason: tokenUsage.rawFinishReason }
                : {}),
              ...(runtimeSteps > 0 ? { runtimeSteps } : {}),
              ...(tokenUsage.cachedInputTokens > 0
                ? { cacheRead: tokenUsage.cachedInputTokens }
                : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0
                ? { cacheCreation: tokenUsage.cacheWriteInputTokens }
                : {}),
              ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
              systemPromptHash,
              prefixHash: turnDiagnostics.requestShape.prefixHash,
              prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
              requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
              requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
              promptSegments: turnDiagnostics.promptSegments,
              ...(contextBudgetForUsage ? { contextBudget: contextBudgetForUsage } : {}),
              ...(providerRequestTraceId ? { providerRequestTraceId } : {}),
            };
            await this.input.appendMessage(tu).catch(() => {});
            if (
              !contextCompactionFailedOpenNoteWritten &&
              shouldAppendContextCompactionFailedOpenNote(contextBudgetForUsage)
            ) {
              contextCompactionFailedOpenNoteWritten = true;
              const note: SystemNoteMessage = {
                type: 'system_note',
                id: this.newId(),
                turnId,
                ts: this.now(),
                kind: 'context_compaction_failed_open',
              };
              await this.input.appendMessage(note).catch(() => {});
            }
            if (
              !contextCompactedNoteWritten &&
              shouldAppendContextCompactedNote(contextBudgetForUsage)
            ) {
              contextCompactedNoteWritten = true;
              const note: SystemNoteMessage = {
                type: 'system_note',
                id: this.newId(),
                turnId,
                ts: this.now(),
                kind: 'context_compacted',
              };
              await this.input.appendMessage(note).catch(() => {});
            }
            const contextRemainingForUsage = (() => {
              const contextWindow = resolveSelectedModelContextWindow(
                this.input.connection,
                this.input.modelId,
              );
              if (lastStepInputTokens !== undefined && contextWindow !== undefined) {
                return Math.max(0, contextWindow - lastStepInputTokens);
              }
              return undefined;
            })();
            queue.push({
              type: 'token_usage',
              id: this.newId(),
              turnId,
              ts: this.now(),
              input: tokenUsage.inputTokens,
              output: tokenUsage.outputTokens,
              cacheHitInput: tokenUsage.cacheHitInputTokens,
              cacheMissInput: tokenUsage.cacheMissInputTokens,
              cacheMissInputSource: tokenUsage.cacheMissInputSource,
              cacheWriteInput: tokenUsage.cacheWriteInputTokens,
              reasoning: tokenUsage.reasoningTokens,
              total: tokenUsage.totalTokens,
              ...(tokenUsage.rawFinishReason !== undefined
                ? { rawFinishReason: tokenUsage.rawFinishReason }
                : {}),
              ...(runtimeSteps > 0 ? { runtimeSteps } : {}),
              ...(tokenUsage.cachedInputTokens > 0
                ? { cacheRead: tokenUsage.cachedInputTokens }
                : {}),
              ...(tokenUsage.cacheWriteInputTokens > 0
                ? { cacheCreation: tokenUsage.cacheWriteInputTokens }
                : {}),
              ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
              systemPromptHash,
              prefixHash: turnDiagnostics.requestShape.prefixHash,
              prefixChangeReason: turnDiagnostics.requestShape.prefixChangeReason,
              requestShapeHash: turnDiagnostics.requestShape.requestShapeHash,
              requestShapeChangeReason: turnDiagnostics.requestShape.requestShapeChangeReason,
              promptSegments: turnDiagnostics.promptSegments,
              ...(contextBudgetForUsage ? { contextBudget: contextBudgetForUsage } : {}),
              ...(contextRemainingForUsage !== undefined
                ? { contextRemaining: contextRemainingForUsage }
                : {}),
              ...(providerRequestTraceId ? { providerRequestTraceId } : {}),
            } satisfies TokenUsageEvent);
          }
        } catch {
          // best-effort; ai-sdk usage promise may reject on abort
        }

        // Nothing may await between this check and terminal emission: Stop must
        // win even when it arrives during post-stream usage persistence.
        if (this.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const stopReason =
          this.handoffStopReason ??
          (this.maxSteps !== undefined && finishReason === 'tool-calls'
            ? 'step_limit'
            : this.mapFinishReason(finishReason));
        trace.modelStreamCompleted(stopReason);
        queue.push({
          type: 'complete',
          id: this.newId(),
          turnId,
          ts: this.now(),
          stopReason,
        } satisfies CompleteEvent);
      } catch (err) {
        streamStatus = this.aborted ? 'aborted' : 'error';
        streamErrorClass = this.modelAdapter.classifyError(watchdogTimeoutError ?? err);
        // Flush the in-flight step's partial text/thinking before the terminal
        // abort/error events. Earlier steps already flushed at their
        // `finish-step`; this keeps their and this step's streamed-out output on
        // BOTH exits — user stop and provider error / watchdog timeout — so
        // partialOutputRetained reflects what the user actually saw.
        await flushStep().catch(() => {});
        if (!this.aborted && midTurnState?.exhaustedDetail) {
          // Mid-turn compaction could not produce a provider-safe request: end
          // the turn with the explicit first-class outcome, not a raw error.
          streamErrorClass = 'ContextBudgetExhausted';
          trace.modelStreamCompleted('context_budget_exhausted');
          queue.push({
            type: 'complete',
            id: this.newId(),
            turnId,
            ts: this.now(),
            stopReason: 'context_budget_exhausted',
            contextBudgetExhaustedDetail: midTurnState.exhaustedDetail,
          } satisfies CompleteEvent);
        } else if (this.aborted) {
          queue.push({
            type: 'abort',
            id: this.newId(),
            turnId,
            ts: this.now(),
            reason: 'user_stop',
          } satisfies AbortEvent);
          queue.push({
            type: 'complete',
            id: this.newId(),
            turnId,
            ts: this.now(),
            stopReason: 'user_stop',
          } satisfies CompleteEvent);
        } else {
          if (!watchdogTimeoutError) {
            queue.push(this.makeErrorEvent(turnId, err));
            trace.modelStreamFailed(streamErrorClass, err, priorReplayFailureTrace(priorReplay));
          }
          queue.push({
            type: 'complete',
            id: this.newId(),
            turnId,
            ts: this.now(),
            stopReason: 'error',
          } satisfies CompleteEvent);
        }
      } finally {
        watchdog?.stop();
        if (this.currentWatchdog === watchdog) this.currentWatchdog = null;
        contextBudgetForTelemetry = contextBudgetWithActiveProjectionDiagnostics(
          contextBudgetForTelemetry,
          activeToolResultPruneDiagnosticPatch,
          activeCompactDiagnosticPatch,
        );
        // The terminal record is fail-closed on usage evidence: no evidence,
        // no record. An aborted send may have no final `usage`, but when EVERY
        // completed step produced a usable sample their accumulated usage IS
        // the complete evidence — record it, carrying the real cost of the
        // steps that ran plus the diagnostics riding this record. Otherwise
        // (no finish-step at all, or any unusable sample) the record is
        // skipped: a partial sum posed as the whole call would violate the
        // #972 no-fabrication invariant. The terminal outcome itself does not
        // depend on this record — stopReason and the exhausted detail are
        // durable on the CompleteEvent either way.
        if (!tokenUsage && completedStepUsage && !sawUnusableStepUsage) {
          tokenUsage = completedStepUsage;
          tokenUsageCostUsd = this.computeTokenUsageCostUsd(tokenUsage);
        }
        if (tokenUsage)
          this.input.recordLlmCall?.({
            sessionId: this.sessionId,
            turnId,
            connectionSlug: this.input.connection.slug,
            providerId: this.input.connection.providerType,
            modelId: this.input.modelId,
            ...llmCallUsageFields(tokenUsage),
            latencyMs: Math.max(0, this.now() - startedAt),
            status: streamStatus,
            ...(streamErrorClass ? { errorClass: streamErrorClass } : {}),
            startedAt,
            ...(requestShapeForTelemetry !== undefined
              ? {
                  systemPromptHash: requestShapeForTelemetry.componentHashes.systemPromptHash,
                  prefixHash: requestShapeForTelemetry.prefixHash,
                  prefixChangeReason: requestShapeForTelemetry.prefixChangeReason,
                  requestShapeHash: requestShapeForTelemetry.requestShapeHash,
                  requestShapeChangeReason: requestShapeForTelemetry.requestShapeChangeReason,
                  ...(requestShapeForTelemetry.toolSchemaChangeReason !== undefined
                    ? { toolSchemaChangeReason: requestShapeForTelemetry.toolSchemaChangeReason }
                    : {}),
                  ...(requestShapeForTelemetry.toolAvailability !== undefined
                    ? { toolAvailability: requestShapeForTelemetry.toolAvailability }
                    : {}),
                }
              : {}),
            ...(tokenUsageCostUsd !== undefined ? { costUsd: tokenUsageCostUsd } : {}),
            ...(promptSegmentsForTelemetry.length > 0
              ? { promptSegments: promptSegmentsForTelemetry }
              : {}),
            ...(contextBudgetForTelemetry !== undefined
              ? { contextBudget: contextBudgetForTelemetry }
              : {}),
          });
        queue.close();
      }
    })();

    let drainedNormally = false;
    try {
      // drain() carries the seq-ack semantics (consumer pull = processed ack);
      // every consumer-facing path must go through it.
      yield* this.drain(queue);
      drainedNormally = true;
    } finally {
      if (!drainedNormally) turnAbortController.abort();
      await pumpDone.catch(() => {});
      await this.cleanupAfterTurn(turnId);
    }
  }

  private handlePlanToolResult(
    result: PlanToolResult,
    turnId: string,
    queue: AsyncEventQueue<SessionEvent>,
  ): void {
    if (result.kind === 'plan_submitted') {
      const proposal = result.proposal;
      queue.push({
        type: 'plan_submitted',
        id: this.newId(),
        turnId,
        ts: this.now(),
        planId: proposal.planId,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        title: proposal.title,
        ...(proposal.overview ? { overview: proposal.overview } : {}),
        ...(proposal.risks ? { risks: proposal.risks } : {}),
        steps: proposal.steps.map((step) => ({ ...step, status: 'pending' })),
      });
      this.currentRunTrace?.emit('plan', 'plan_submitted', 'Plan submitted', {
        planId: proposal.planId,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        storeVersion: result.storeVersion,
      });
      this.handoffStopReason = 'plan_handoff';
      this.loopStopRequested = true;
      return;
    }

    const traceType = result.kind;
    this.currentRunTrace?.emit('plan', traceType, 'Plan execution state changed', {
      planId: result.execution.planId,
      proposalId: result.execution.proposalId,
      executionId: result.execution.executionId,
      storeVersion: result.storeVersion,
    });
    if (result.kind === 'plan_execution_completed' || result.kind === 'plan_execution_cancelled') {
      this.loopStopRequested = true;
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  async stop(
    _reason: 'user_stop' | 'redirect',
    mode: 'immediate' | 'after_step' = 'immediate',
  ): Promise<void> {
    if (mode === 'after_step') {
      this.loopStopRequested = true;
      this.currentRunTrace?.abortRequested(_reason);
      return;
    }
    this.aborted = true;
    this.abortController?.abort();
    this.compaction.abortHistoryCompact();
    if (this.currentTurnId !== null) {
      await this.toolRuntime.endTurn(this.currentTurnId, 'aborted');
    }
    this.currentRunTrace?.abortRequested(_reason);
  }

  async respondToSandboxBoundary(decision: SandboxBoundaryResponse): Promise<void> {
    if (await this.toolRuntime.respondToSandboxBoundaryResponse(decision)) {
      return;
    }
    throw new Error(`No pending sandbox boundary request ${decision.requestId}`);
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    if (this.currentTurnId === null) return;
    this.toolRuntime.respondToUserQuestion(this.currentTurnId, response);
  }

  async dispose(): Promise<void> {
    if (!this.aborted) await this.stop('user_stop');
  }

  /** Map ai-sdk finishReason → our CompleteEvent.stopReason. */
  private mapFinishReason(reason: unknown): CompleteEvent['stopReason'] {
    return this.modelAdapter.mapFinishReason(reason);
  }

  private makeErrorEvent(turnId: string, err: unknown): ErrorEvent {
    return this.modelAdapter.makeErrorEvent(turnId, err);
  }

  private computeTokenUsageCostUsd(usage: NormalizedAiSdkUsage): number | undefined {
    try {
      const pricing = (this.input.lookupPricing ?? getBuiltinPricing)(
        `${this.input.connection.providerType}:${this.input.modelId}`,
      );
      if (pricing === null) return undefined;
      return computeCost(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheHitInputTokens: usage.cacheHitInputTokens,
          cacheMissInputTokens: usage.cacheMissInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
        },
        pricing,
      ).totalCost;
    } catch {
      return undefined;
    }
  }

  /** Materialize RuntimeEvent-derived projections into ai-sdk's message format.
   *  V0.1: text-only round-tripping. Tool calls / results within projected
   *  history are deliberately NOT replayed unless RuntimeEvent native replay
   *  is available for the provider. */
  private async buildPriorMessages(input: BackendSendInput): Promise<{
    messages: ModelMessage[];
    gate: RuntimeEventReplayFallbackGate | 'stored_message_projection';
    diagnostics: RuntimeEventModelReplayPlan['diagnostics'];
    runtimeEventCount?: number;
    contextBudget?: ContextBudgetDiagnostic;
    /** Latest durable checkpoint (loaded or written this turn) for mid-turn roll-forward. */
    latestHistoryCompactCheckpoint?: HistoryCompactCheckpoint;
  }> {
    const priorStored = input.context.filter((message) => message.turnId !== input.turnId);
    if (!input.runtimeContext) {
      return {
        messages: await this.materializePriorMessages(priorStored),
        gate: 'stored_message_projection',
        diagnostics: [],
      };
    }
    const priorRuntimeContext = input.runtimeContext.filter(
      (event) => event.turnId !== input.turnId,
    );
    const projectedMessages = await this.materializePriorMessages(
      priorStored,
      buildSteeringSidecar(priorRuntimeContext),
    );
    const preparedContextBudget =
      await this.compaction.prepareContextBudgetPolicy(priorRuntimeContext);
    const contextBudget = preparedContextBudget.policy;
    const budgeted = applyRuntimeEventContextBudget(priorRuntimeContext, contextBudget, {
      historyCompactProtocol:
        contextBudget?.historyCompact?.checkpoint ||
        this.compaction.hasHistoryCompactCheckpointWriter()
          ? 'checkpoint_v2'
          : 'legacy_v1',
    });
    let runtimeContext = budgeted?.events ?? priorRuntimeContext;
    let contextBudgetDiagnostic = budgeted?.diagnostic;
    let latestHistoryCompactCheckpoint = contextBudget?.historyCompact?.checkpoint;
    if (preparedContextBudget.diagnosticPatch) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        preparedContextBudget.diagnosticPatch,
      );
    }
    if (
      budgeted?.historyCompactBlocks?.length &&
      contextBudget?.historyCompact?.mode === 'read_write' &&
      this.compaction.hasHistoryCompactWriter()
    ) {
      const loadedBlockIds = new Set(
        (contextBudget.historyCompact.blocks ?? []).map((block) => block.blockId),
      );
      const draftBlocks = budgeted.historyCompactBlocks.filter(
        (block) => !loadedBlockIds.has(block.blockId),
      );
      if (draftBlocks.length > 0) {
        if (this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint) {
          const writePatch = await this.compaction.writeHistoryCompactCheckpoint({
            turnId: input.turnId,
            contextBudget,
            priorRuntimeContext,
            draftBlock: draftBlocks[0]!,
            abortSignal: this.abortController?.signal,
            requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
          });
          if (writePatch.replacementCheckpoint) {
            latestHistoryCompactCheckpoint = writePatch.replacementCheckpoint;
            runtimeContext = [
              historyCompactCheckpointToRuntimeEvent(writePatch.replacementCheckpoint),
              ...runtimeContext.filter((event) => !event.id.startsWith('history-compact:')),
            ];
          } else {
            runtimeContext = writePatch.fallbackCheckpoint
              ? buildHistoryCompactCheckpointFailOpenContext(
                  writePatch.fallbackCheckpoint,
                  priorRuntimeContext,
                  contextBudget,
                  runtimeContext.filter((event) => !event.id.startsWith('history-compact:')),
                )
              : runtimeContext.filter((event) => !event.id.startsWith('history-compact:'));
          }
          contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
            contextBudgetDiagnostic ??
              buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
            writePatch.diagnosticPatch,
          );
        } else {
          const writePatch = await this.compaction.writeHistoryCompactBlocks({
            turnId: input.turnId,
            contextBudget,
            priorRuntimeContext,
            draftBlocks,
            abortSignal: this.abortController?.signal,
            requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
          });
          if (writePatch.replacementBlocks.length > 0) {
            runtimeContext = replaceHistoryCompactReplayBlocks(
              runtimeContext,
              writePatch.replacementBlocks,
            );
          } else {
            runtimeContext = priorRuntimeContext;
            contextBudgetDiagnostic = buildContextBudgetDiagnosticShell(
              priorRuntimeContext,
              runtimeContext,
              contextBudget,
            );
          }
          contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
            contextBudgetDiagnostic ??
              buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
            writePatch.diagnosticPatch,
          );
        }
      }
    }

    const historySearchSource = buildHistorySearchSource(priorRuntimeContext, contextBudget);
    const historyAround =
      contextBudget?.archiveRetrieval?.mode === 'history_search_gated'
        ? retrieveReplayHistoryAroundSearchSource(
            historySearchSource,
            priorRuntimeContext,
            input.text,
            contextBudget?.historySearch,
            { charsPerToken: contextBudget?.charsPerToken },
          )
        : retrieveRuntimeEventHistoryAround(
            historySearchSource,
            input.text,
            contextBudget?.historySearch,
            { charsPerToken: contextBudget?.charsPerToken },
          );
    const archiveRetrievalAllowedTurnIds =
      contextBudget?.archiveRetrieval?.mode === 'history_search_gated'
        ? new Set(historyAround.events.map((event) => runtimeEventTurnKey(event)))
        : undefined;
    if (historyAround.events.length > 0) {
      runtimeContext = mergeRuntimeEventsInOriginalOrder(
        priorRuntimeContext,
        runtimeContext,
        historyAround.events,
      );
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        historyAround.diagnosticPatch,
      );
    } else if (contextBudget?.historySearch?.enabled === true) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        historyAround.diagnosticPatch,
      );
    }

    const synthesis = selectSynthesisCacheForReplay(
      runtimeContext,
      input.text,
      contextBudget?.synthesisCache,
      {
        sessionId: this.sessionId,
        charsPerToken: contextBudget?.charsPerToken,
      },
    );
    runtimeContext = synthesis.events;
    if (contextBudget?.synthesisCache?.enabled === true) {
      contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
        contextBudgetDiagnostic ??
          buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
        synthesis.diagnosticPatch,
      );
    }

    if (synthesis.selectedBlocks.length === 0) {
      const retrieval = await retrieveArchivedToolResultsForReplay(
        runtimeContext,
        contextBudget?.archiveRetrieval,
        this.input.readToolResultArchive,
        {
          sessionId: this.sessionId,
          charsPerToken: contextBudget?.charsPerToken,
          allowedTurnIds: archiveRetrievalAllowedTurnIds,
        },
      );
      runtimeContext = retrieval.events;
      if (contextBudget?.archiveRetrieval?.enabled === true) {
        contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
          contextBudgetDiagnostic ??
            buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
          retrieval.diagnosticPatch,
        );
      }
      if (
        contextBudget?.synthesisCache?.enabled === true &&
        contextBudget.synthesisCache.mode === 'read_write' &&
        this.input.writeSynthesisCache &&
        (retrieval.retrievedSourceRefs?.length ?? 0) > 0 &&
        (retrieval.diagnosticPatch.retrievedArchiveToolResults ?? 0) > 0
      ) {
        const evidenceRequestReason = rawEvidenceRequestReason(input.text);
        if (evidenceRequestReason) {
          contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
            contextBudgetDiagnostic ??
              buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
            {
              synthesisCacheWriteSkipped: 1,
              synthesisCacheWriteSkippedReasonCounts: { [evidenceRequestReason]: 1 },
            },
          );
        } else {
          const writePatch = await this.compaction.writeSynthesisCacheBlocks({
            turnId: input.turnId,
            query: input.text,
            hydratedRuntimeEvents: runtimeContext,
            retrievedArchiveRefs: retrieval.retrievedSourceRefs ?? [],
            archiveRetrievalMode: contextBudget.archiveRetrieval?.mode ?? 'eager',
            contextBudget,
            requestShapeHashBefore: this.priorRequestShape?.requestShapeHash,
          });
          contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
            contextBudgetDiagnostic ??
              buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
            writePatch,
          );
        }
      } else if (
        contextBudget?.synthesisCache?.enabled === true &&
        contextBudget.synthesisCache.mode === 'read_write' &&
        synthesis.selectedBlocks.length === 0 &&
        (retrieval.diagnosticPatch.retrievedArchiveToolResults ?? 0) === 0
      ) {
        contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
          contextBudgetDiagnostic ??
            buildContextBudgetDiagnosticShell(priorRuntimeContext, runtimeContext, contextBudget),
          {
            synthesisCacheWriteSkipped: 1,
            synthesisCacheWriteSkippedReasonCounts: { source_missing: 1 },
          },
        );
      }
    }

    const plan = buildRuntimeEventModelReplayPlan(
      runtimeContext,
      // `runtimeContext` may be a budget/history-search slice; the tool-turn
      // thinking skip is a whole-history invariant, so seed it from the full
      // prior ledger so a sliced-in tool-turn thinking still gets skipped.
      { toolActivityTurnIds: collectToolActivityTurnIds(priorRuntimeContext) },
    );
    if (plan.items.length === 0) {
      return {
        messages: input.continuation
          ? await this.materializeRuntimeReplayTextOnly(plan)
          : projectedMessages,
        gate: input.continuation ? 'runtime_replay_text_only' : 'stored_message_projection',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    if (hasBlockingReplayDiagnostics(plan)) {
      return {
        messages: input.continuation
          ? await this.materializeRuntimeReplayTextOnly(plan)
          : projectedMessages,
        gate: input.continuation
          ? 'runtime_replay_text_only'
          : 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    if (!plan.hasProviderNativeSemantics) {
      return {
        messages: await this.materializeRuntimeReplayPlan(plan),
        gate: 'runtime_replay_text_only',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    if (!this.canReplayProviderNative(plan)) {
      return {
        messages: input.continuation
          ? await this.materializeRuntimeReplayTextOnly(plan)
          : projectedMessages,
        gate: input.continuation
          ? 'runtime_replay_text_only'
          : 'runtime_replay_unsupported_semantics',
        diagnostics: plan.diagnostics,
        runtimeEventCount: runtimeContext.length,
        ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
        ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
      };
    }

    return {
      messages: await this.materializeRuntimeReplayPlan(plan),
      gate: 'runtime_replay_provider_native',
      diagnostics: plan.diagnostics,
      runtimeEventCount: runtimeContext.length,
      ...(contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {}),
      ...(latestHistoryCompactCheckpoint ? { latestHistoryCompactCheckpoint } : {}),
    };
  }

  private canReplayProviderNative(plan: RuntimeEventModelReplayPlan): boolean {
    const support = this.modelAdapter.runtimeEventReplaySupport();
    for (const item of plan.items) {
      if (item.kind === 'tool_call' && !support.toolCalls) return false;
      if (item.kind === 'tool_result' && !support.toolResults) return false;
      if (item.kind === 'thinking' && item.signature && !support.signedThinking) return false;
    }
    return true;
  }

  /**
   * Materialize a replay plan into provider messages, grouping each assistant
   * step's reasoning + text + tool calls into ONE assistant message (Anthropic
   * requires the signed thinking block to lead the tool-use assistant message).
   *
   * The ledger lands a step's parts as: tool_call(s), tool_result(s), thinking,
   * text (the per-step AssistantMessage flushes at `finish-step`, after the
   * step's tool events). Model text carries the step id and closes the step: it
   * emits `[reasoning, text, tool-call…]` then the tool results. Steps with no
   * text closer — a thinking + tool step (its empty text closer is skipped from
   * the plan as `empty_text_skipped`) or a pure-tool step — flush grouped by
   * stepId, claiming any parked reasoning for that step. Legacy per-turn items
   * (no step id) keep the older shape: tool calls form a tool-only assistant,
   * text/thinking become standalone messages.
   */
  private async materializeRuntimeReplayPlan(
    plan: RuntimeEventModelReplayPlan,
    settledModelOutputs?: ReadonlyMap<string, ToolResultOutput>,
  ): Promise<ModelMessage[]> {
    type ToolCallItem = Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }>;
    type ToolResultItem = Extract<RuntimeEventModelReplayItem, { kind: 'tool_result' }>;
    type ThinkingItem = Extract<RuntimeEventModelReplayItem, { kind: 'thinking' }>;
    type ReplayReasoning = {
      part?: ReasoningPart;
      providerOptions?: NonNullable<ModelMessage['providerOptions']>;
    };
    const out: ModelMessage[] = [];
    let bufferedCalls: ToolCallItem[] = [];
    const results = new Map<string, ToolResultItem>();
    const reasoningByStep = new Map<string, ThinkingItem[]>();
    const textByStep = new Map<string, string>();

    const replaySupport = this.modelAdapter.runtimeEventReplaySupport();
    const reasoningReplay = (item: ThinkingItem): ReplayReasoning | undefined => {
      if (item.signature) {
        return replaySupport.signedThinking
          ? {
              part: {
                type: 'reasoning' as const,
                text: item.text,
                providerOptions: { anthropic: { signature: item.signature } },
              },
            }
          : undefined;
      }
      if (replaySupport.openAiResponsesThinking) {
        const openai = item.providerOptions?.openai;
        if (openai && typeof openai === 'object' && !Array.isArray(openai)) {
          const { itemId, reasoningEncryptedContent } = openai as {
            itemId?: unknown;
            reasoningEncryptedContent?: unknown;
          };
          if (typeof itemId === 'string' && itemId.length > 0) {
            return {
              part: {
                type: 'reasoning' as const,
                text: item.text,
                providerOptions: {
                  openai: {
                    itemId,
                    ...(typeof reasoningEncryptedContent === 'string' ||
                    reasoningEncryptedContent === null
                      ? { reasoningEncryptedContent }
                      : {}),
                  },
                },
              },
            };
          }
        }
      }
      if (!replaySupport.unsignedThinking) return undefined;
      const kimiReasoningField = kimiReasoningFieldFromProviderOptions(item.providerOptions);
      if (!kimiReasoningField) return undefined;
      return {
        providerOptions: {
          openaiCompatible: { [kimiReasoningField]: item.text },
        } as NonNullable<ModelMessage['providerOptions']>,
      };
    };
    // Tool results are emitted only when their tool_call claims them here. A
    // result whose call never appears in the plan (sliced-away call, corrupt
    // ledger) is INTENTIONALLY dropped at the end: a standalone tool message
    // with no preceding tool_use in an assistant message is an Anthropic 400.
    // The old item-by-item materializer emitted such orphans; do not "fix" this
    // back — the plan flags them as `unmatched_tool_result` (a non-blocking
    // diagnostic precisely so this drop path is reachable; see
    // hasBlockingReplayDiagnostics).
    const pushToolResults = async (calls: readonly ToolCallItem[]) => {
      for (const call of calls) {
        const result = results.get(call.toolCallId);
        if (!result) continue;
        results.delete(call.toolCallId);
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              output:
                settledModelOutputs?.get(result.toolCallId) ??
                (await this.materializeToolResultOutput(
                  result.output,
                  result.isError,
                  `runtime-event:${result.eventId}:tool-result`,
                )),
            },
          ],
        });
      }
    };
    // Emit one assistant message for a step: reasoning (if any), text (if any),
    // then the step's tool calls, followed by those calls' tool results.
    const emitStep = async (
      reasoning: readonly ThinkingItem[] | undefined,
      text: string,
      calls: readonly ToolCallItem[],
    ) => {
      const content: unknown[] = [];
      const replayReasoning = reasoning
        ?.map(reasoningReplay)
        .filter((item): item is ReplayReasoning => item !== undefined);
      for (const item of replayReasoning ?? []) {
        if (item.part) content.push(item.part);
      }
      if (text.length > 0) content.push({ type: 'text', text });
      for (const call of calls) {
        content.push({
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
          ...(call.providerOptions !== undefined ? { providerOptions: call.providerOptions } : {}),
        });
      }
      const replayProviderOptions = replayReasoning?.find(
        (item) => item.providerOptions !== undefined,
      )?.providerOptions;
      if (content.length > 0 || replayProviderOptions) {
        out.push({
          role: 'assistant',
          content,
          ...(replayProviderOptions ? { providerOptions: replayProviderOptions } : {}),
        } as ModelMessage);
      }
      await pushToolResults(calls);
    };
    // Emit tool calls no assistant text closed: a thinking + tool step with no
    // text (its empty closer is skipped from the plan), a pure-tool step, or a
    // legacy per-turn tool block. Group consecutive calls by stepId so each step
    // stays one assistant message, and claim the step's parked reasoning by
    // stepId — this is how the common Anthropic interleaved-thinking step shape
    // (reasoning + tool call, no text) gets its reasoning merged ahead of its
    // calls. Calls without a stepId group together (legacy shape, no reasoning).
    const emitGroupedCalls = async (calls: readonly ToolCallItem[]) => {
      let group: ToolCallItem[] = [];
      const emitGroup = async () => {
        if (group.length === 0) return;
        const stepId = group[0]!.stepId;
        const reasoning = stepId !== undefined ? reasoningByStep.get(stepId) : undefined;
        const text = stepId !== undefined ? (textByStep.get(stepId) ?? '') : '';
        if (stepId !== undefined) {
          reasoningByStep.delete(stepId);
          textByStep.delete(stepId);
        }
        await emitStep(reasoning, text, group);
        group = [];
      };
      for (const call of calls) {
        if (group.length > 0 && group[0]!.stepId !== call.stepId) await emitGroup();
        group.push(call);
      }
      await emitGroup();
    };
    const flushLooseCalls = async () => {
      if (bufferedCalls.length === 0) return;
      const calls = bufferedCalls;
      bufferedCalls = [];
      await emitGroupedCalls(calls);
    };
    const flushPendingSteps = async () => {
      await flushLooseCalls();
      for (const [stepId, text] of textByStep) {
        textByStep.delete(stepId);
        const reasoning = reasoningByStep.get(stepId);
        reasoningByStep.delete(stepId);
        await emitStep(reasoning, text, []);
      }
      for (const [stepId, reasoning] of reasoningByStep) {
        reasoningByStep.delete(stepId);
        await emitStep(reasoning, '', []);
      }
    };

    for (const item of plan.items) {
      switch (item.kind) {
        case 'tool_call':
          bufferedCalls.push(item);
          break;
        case 'tool_result':
          results.set(item.toolCallId, item);
          break;
        case 'thinking':
          if (item.stepId !== undefined) {
            const stepReasoning = reasoningByStep.get(item.stepId) ?? [];
            stepReasoning.push(item);
            reasoningByStep.set(item.stepId, stepReasoning);
          } else {
            // Legacy standalone reasoning (pure-reasoning turn): emit on its own.
            await flushPendingSteps();
            const replayReasoning = reasoningReplay(item);
            if (replayReasoning) {
              out.push({
                role: 'assistant',
                content: replayReasoning.part ? [replayReasoning.part] : [],
                ...(replayReasoning.providerOptions
                  ? { providerOptions: replayReasoning.providerOptions }
                  : {}),
              } as ModelMessage);
            }
          }
          break;
        case 'text':
          if (item.role !== 'assistant') {
            await flushPendingSteps();
            out.push(await this.materializeRuntimeReplayItem(item));
            break;
          }
          if (item.stepId !== undefined) {
            const stepId = item.stepId;
            const thisCalls = bufferedCalls.filter((call) => call.stepId === stepId);
            const otherCalls = bufferedCalls.filter((call) => call.stepId !== stepId);
            bufferedCalls = [];
            // Earlier steps' unclosed calls flush first (with their own parked
            // reasoning, if any) so step order is preserved.
            if (otherCalls.length > 0) await emitGroupedCalls(otherCalls);
            if (thisCalls.length > 0) {
              await emitStep(reasoningByStep.get(stepId), item.content, thisCalls);
              reasoningByStep.delete(stepId);
            } else {
              // Runtime-owned settlement persists assistant facts before the
              // matching tool calls. Hold the step closer until those calls
              // arrive; a terminal text-only step flushes below.
              textByStep.set(stepId, item.content);
            }
          } else {
            // Legacy per-turn assistant text: standalone after any tool block.
            await flushPendingSteps();
            out.push({ role: 'assistant', content: item.content });
          }
          break;
      }
    }
    await flushPendingSteps();
    return out;
  }

  private async materializeRuntimeReplayTextOnly(
    plan: RuntimeEventModelReplayPlan,
  ): Promise<ModelMessage[]> {
    const messages: ModelMessage[] = [];
    for (const item of plan.items) {
      if (item.kind === 'text') messages.push(await this.materializeRuntimeReplayItem(item));
    }
    return messages;
  }

  private async materializeRuntimeReplayItem(
    item: Extract<RuntimeEventModelReplayItem, { kind: 'text' }>,
  ): Promise<ModelMessage> {
    if (item.role === 'user') {
      if (item.steering) {
        // Already envelope-wrapped by the plan; carry the structured identity
        // so injection dedupe recognizes the replayed message.
        return {
          role: 'user',
          content: item.content,
          providerOptions: steeringProviderOptions(item.steering.eventId),
        };
      }
      return {
        role: 'user',
        content: await this.appendImageParts(
          item.content,
          item.attachments,
          `runtime-event:${item.eventId}`,
        ),
      } as ModelMessage;
    }
    return { role: item.role, content: item.content };
  }

  private async materializePriorMessages(
    stored: readonly StoredMessage[],
    steeringSidecar?: ReadonlyMap<string, { eventId: string }>,
  ): Promise<ModelMessage[]> {
    const out: ModelMessage[] = [];
    for (const m of stored) {
      if (m.type === 'user') {
        // Degraded projections lose the RuntimeEvent steering marker; the
        // sidecar (keyed by the projection's stable message ids) restores the
        // canonical envelope + structured identity so a fallback-gated turn
        // still presents steering exactly once, in its one provider form.
        const sidecar = steeringSidecar?.get(m.id);
        if (sidecar) {
          out.push(
            steeringModelMessage(
              sidecar.eventId,
              await this.appendImageParts(
                buildSteeringEnvelope(formatTextWithInlineRefs(m.text, m)),
                m.attachments,
                `steering:${sidecar.eventId}`,
              ),
            ),
          );
          continue;
        }
        out.push({
          role: 'user',
          content: await this.appendImageParts(formatTextWithInlineRefs(m.text, m), m.attachments),
        } as ModelMessage);
      }
      // A thinking/tool-only step projects an assistant row with empty text;
      // replaying it as an empty text block is a hard 400 on Anthropic-protocol
      // providers.
      else if (m.type === 'assistant' && m.text.length > 0)
        out.push({ role: 'assistant', content: m.text });
      // empty assistant / tool_call / tool_result / permission_decision / token_usage / system_note skipped
    }
    return out;
  }

  /** Append provider-visible volatile turn facts after the durable user content. */
  private appendTurnTailPrompt(
    content: ModelMessage['content'],
    turnTailPrompt?: string,
  ): ModelMessage['content'] {
    if (!turnTailPrompt) return content;
    if (typeof content === 'string') return `${content}\n\n${turnTailPrompt}`;
    return [
      ...(content as unknown[]),
      { type: 'text', text: turnTailPrompt },
    ] as ModelMessage['content'];
  }

  /** A decision key deduplicates re-materialization; no key charges each occurrence. */
  private chargeImageBudget(bytes: number, decisionKey?: string): boolean {
    const budget = this.imageRequestBudget;
    if (!budget) return true;
    if (decisionKey !== undefined) {
      const cached = budget.decisions.get(decisionKey);
      if (cached !== undefined) return cached;
    }
    const keep =
      budget.used + bytes <=
      (this.input.maxProviderImageRequestBytes ?? MAX_PROVIDER_IMAGE_REQUEST_BYTES);
    if (keep) budget.used += bytes;
    if (decisionKey !== undefined) budget.decisions.set(decisionKey, keep);
    return keep;
  }

  /**
   * Render provider-visible content for a user message: keep the given
   * (already-formatted) text, and append image attachments as provider image
   * parts only for explicitly vision-capable models. Non-image attachments stay
   * as placeholder refs in the text. Shared by the current turn, RuntimeEvent
   * replay, and the stored-message fallback so all paths present images identically.
   */
  private async appendImageParts(
    textContent: string,
    attachments?: AttachmentRef[],
    decisionKeyPrefix?: string,
  ): Promise<UserContent> {
    const images = attachments?.filter((a) => a.kind === 'image') ?? [];
    if (images.length === 0) {
      return textContent;
    }
    if (this.input.supportsVision !== true) {
      return appendNonVisionImageFallbackNotice(textContent);
    }
    if (!this.input.readAttachmentBytes) {
      return textContent;
    }
    const parts: Array<
      | { type: 'text'; text: string }
      | { type: 'file'; data: { type: 'data'; data: Uint8Array }; mediaType: string }
    > = [{ type: 'text', text: textContent }];
    let omittedByBudget = 0;
    for (const [index, image] of images.entries()) {
      const read = await this.input.readAttachmentBytes(image.ref);
      if (!read.ok) {
        parts.push({
          type: 'text',
          text: `Image attachment "${image.name}" could not be loaded: ${read.reason}.`,
        });
        continue;
      }
      const decisionKey =
        decisionKeyPrefix === undefined ? undefined : `${decisionKeyPrefix}:image:${index}`;
      if (!this.chargeImageBudget(read.bytes.length, decisionKey)) {
        omittedByBudget += 1;
        continue;
      }
      parts.push({
        type: 'file',
        data: { type: 'data', data: read.bytes },
        mediaType: image.mimeType,
      });
    }
    if (omittedByBudget > 0) {
      parts.push({
        type: 'text',
        text: `[${omittedByBudget} image attachment(s) omitted: the per-request image budget was exceeded. Earlier images were sent; ask the user to send fewer or smaller images.]`,
      });
    }
    return parts;
  }

  private async materializeToolResultOutput(
    output: unknown,
    isError: boolean,
    decisionKey: string,
  ): Promise<ToolResultOutput> {
    if (isError || !isImageToolResult(output)) return toolResultOutput(output, isError);
    if (this.input.supportsVision !== true) {
      return toolResultText('Image was read, but the selected model does not support image input.');
    }
    if (!this.input.readAttachmentBytes) {
      return toolResultText('Image was read, but its stored bytes are unavailable.');
    }
    const budget = this.imageRequestBudget;
    if (budget && budget.decisions.get(decisionKey) === false) {
      return toolResultText(PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE);
    }
    let read: Awaited<ReturnType<AttachmentByteReader>>;
    try {
      read = await this.input.readAttachmentBytes(output.ref);
    } catch {
      return toolResultText('Image could not be loaded from artifact storage: read_failed.');
    }
    if (!read.ok) {
      return toolResultText(`Image could not be loaded from artifact storage: ${read.reason}.`);
    }
    if (!this.chargeImageBudget(read.bytes.length, decisionKey)) {
      return toolResultText(PROVIDER_IMAGE_BUDGET_EXCEEDED_MESSAGE);
    }
    return {
      type: 'content',
      value: [
        { type: 'text', text: 'Image read successfully.' },
        {
          type: 'file',
          data: { type: 'data', data: Buffer.from(read.bytes).toString('base64') },
          mediaType: output.mimeType,
        },
      ],
    };
  }

  private async buildCurrentUserContent(
    text: string,
    voiceAudio?: EphemeralVoiceAudio,
    attachments?: AttachmentRef[],
    quotes?: QuoteRef[],
    runtimeEventId?: string,
  ): Promise<UserContent> {
    const content = await this.appendImageParts(
      formatTextWithInlineRefs(text, {
        ...(attachments !== undefined ? { attachments } : {}),
        ...(quotes !== undefined ? { quotes } : {}),
      }),
      attachments,
      runtimeEventId === undefined ? undefined : `runtime-event:${runtimeEventId}`,
    );
    if (!voiceAudio) return content;
    const parts: Exclude<UserContent, string> =
      typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
    parts.push(voiceAudioPart(voiceAudio));
    return parts;
  }

  private async resolveSystemPrompt(turnId: string): Promise<string | undefined> {
    if (typeof this.input.systemPrompt === 'function') {
      return await this.input.systemPrompt({
        sessionId: this.sessionId,
        turnId,
        cwd: this.input.header.cwd,
        workspaceRoot: this.input.header.workspaceRoot,
        emitSkillCatalogTrace: (message, data) =>
          this.currentRunTrace?.emit('skill', 'skill_catalog_built', message, data),
      });
    }
    return this.input.systemPrompt;
  }

  private async resolveTurnTailPrompt(turnId: string): Promise<string | undefined> {
    if (typeof this.input.turnTailPrompt === 'function') {
      return await this.input.turnTailPrompt({
        sessionId: this.sessionId,
        turnId,
        cwd: this.input.header.cwd,
        workspaceRoot: this.input.header.workspaceRoot,
      });
    }
    return this.input.turnTailPrompt;
  }

  private async resolveShellRunContextSummary(): Promise<string | undefined> {
    return await this.input.shellRunContextSummary?.();
  }

  private async *drain(queue: AsyncEventQueue<SessionEvent>): AsyncIterable<SessionEvent> {
    try {
      for await (const ev of queue) {
        yield ev;
        // Generator backpressure IS the consumer's ack: this line runs only
        // when the consumer's loop body finished for `ev` and pulled the next
        // event, so `consumedCount` counts fully PROCESSED events. AgentRun
        // persists each mapped event before continuing, so an acked event is
        // either durable or deliberately skipped (partials, non-terminal
        // errors) — exactly the set a durable read can ever return.
        queue.ackConsumed();
      }
    } finally {
      // The consumer abandoned or finished the stream; wake any seq-ack waiter
      // so it observes `consumerDetached` instead of blocking forever.
      queue.noteConsumerDetached();
    }
  }

  private async cleanupAfterTurn(turnId: string): Promise<void> {
    this.abortController = null;
    this.currentQueue = null;
    this.currentTurnId = null;
    this.currentInvocationId = null;
    this.currentRunId = null;
    this.currentOrchestration = undefined;
    this.currentRunTrace = null;
    this.currentUserIntent = undefined;
    this.loopStopRequested = false;
    this.handoffStopReason = undefined;
    this.injectedSteeringMessages = [];
    try {
      await this.toolRuntime.endTurn(turnId, this.aborted ? 'aborted' : 'completed');
    } finally {
      this.aborted = false;
    }
  }

  /**
   * Drain the caller's pending steering at a step boundary. Each message is
   * echoed as a `steering_message` event (so the ledger + transcript render the
   * interjection in place) and accumulated as an envelope-wrapped user message
   * for injection into subsequent provider requests.
   *
   * Persist-before-include invariant: the initial user message is durable
   * before the backend is invoked, and a steered message must hold the same
   * line — the provider must never start executing a directive the ledger does
   * not carry. The seq-ack boundary provides that without a second write path:
   * the consumer's pull is the ack, and AgentRun persists each mapped event
   * before continuing (see drain()), so once everything enqueued up to the
   * steering event is consumed, the event is durable. If the consumer detaches
   * (the persist path failed or the turn is being torn down) before that, the
   * message is nacked and NOT included in any request; an abort after the push
   * waits for that same convergence — durable ⇒ ack (history owns it), detach
   * ⇒ nack — and only then throws so the dying request is never sent.
   */
  private async drainSteeringInto(
    input: BackendSendInput,
    turnId: string,
    queue: AsyncEventQueue<SessionEvent>,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const pull = input.pullSteering;
    if (!pull) return;
    const leases = pull();
    if (leases.length === 0) return;
    // Binary settlement: every pulled lease settles exactly once, decided
    // ONLY by the persistence fact — durably consumed ⇒ ack + injection set;
    // provably never persisted (never pushed, or the consumer detached
    // without consuming it) ⇒ nack. An abort does NOT settle a pushed lease:
    // it only stops new pushes and the dying request; the wait continues
    // until the teardown converges it (the flow drains after terminal events
    // or detaches on failure), because nacking a durably appended event
    // would put the same directive in the account twice — once via history
    // replay, once via the reclaimed queue.
    const undelivered = [...leases];
    try {
      for (const lease of leases) {
        if (this.aborted || abortSignal?.aborted) {
          // Never pushed: settles as undelivered.
          throw Object.assign(new Error('aborted before steering was pushed'), {
            name: 'AbortError',
          });
        }
        if (queue.consumerDetached) {
          throw new Error('steering message was not durably consumed: event consumer detached');
        }
        // Materialize provider content before publishing the durable event.
        // After consumption there must be no fallible gap before ack/injection.
        const eventId = this.newId();
        const providerContent = await this.appendImageParts(
          buildSteeringEnvelope(formatTextWithInlineRefs(lease.content.text, lease.content)),
          lease.content.attachments,
          `steering:${eventId}`,
        );
        if (this.aborted || abortSignal?.aborted) {
          throw Object.assign(new Error('aborted before steering was pushed'), {
            name: 'AbortError',
          });
        }
        if (queue.consumerDetached) {
          throw new Error('steering message was not durably consumed: event consumer detached');
        }
        await queue.pushAndWaitUntilConsumed({
          type: 'steering_message',
          id: eventId,
          turnId,
          ts: this.now(),
          messageId: lease.messageId,
          content: lease.content,
        } satisfies SessionEvent);
        // The mapped RuntimeEvent inherits this session event's id, so the
        // injected message and its future ledger replay share one identity.
        this.injectedSteeringMessages.push(steeringModelMessage(eventId, providerContent));
        input.ackSteering?.([lease.id]);
        undelivered.shift();
        if (this.aborted || abortSignal?.aborted) {
          // Settled (the ledger owns the message; the next turn replays it),
          // but the send is dying: stop before any request is built with it.
          throw Object.assign(new Error('aborted after steering was durable'), {
            name: 'AbortError',
          });
        }
      }
    } catch (error) {
      if (undelivered.length > 0) {
        input.nackSteering?.(undelivered.map((lease) => lease.id));
      }
      throw error;
    }
  }
}

/**
 * Steering identities for degraded StoredMessage projections, keyed by every
 * stable id the projection may have used for the message (event id,
 * providerEventId, storedMessageId), so the sidecar restore is exact.
 */
function buildSteeringSidecar(events: readonly RuntimeEvent[]): Map<string, { eventId: string }> {
  const sidecar = new Map<string, { eventId: string }>();
  for (const event of events) {
    if (event.partial === true) continue;
    if (event.content?.kind !== 'text' || event.content.steering !== true) continue;
    const identity = { eventId: event.id };
    sidecar.set(event.id, identity);
    if (event.refs?.providerEventId) sidecar.set(event.refs.providerEventId, identity);
    if (event.refs?.storedMessageId) sidecar.set(event.refs.storedMessageId, identity);
  }
  return sidecar;
}

function isPlanToolResult(output: unknown): output is PlanToolResult {
  if (!output || typeof output !== 'object') return false;
  return [
    'plan_submitted',
    'plan_progress_updated',
    'plan_execution_completed',
    'plan_execution_cancelled',
  ].includes(String((output as { kind?: unknown }).kind));
}

export function repairMakaToolCall(input: {
  toolCall: RepairableAiSdkToolCall;
  availableToolNames: readonly string[];
  error: unknown;
}): RepairableAiSdkToolCall | null {
  const requestedName = input.toolCall.toolName;
  if (requestedName === INVALID_TOOL_NAME) return null;

  const lowerRequestedName = requestedName.toLowerCase();
  const exactLowercaseMatch = input.availableToolNames.find(
    (name) => name.toLowerCase() === lowerRequestedName,
  );
  if (exactLowercaseMatch && exactLowercaseMatch !== requestedName) {
    return { ...input.toolCall, toolName: exactLowercaseMatch };
  }

  return {
    ...input.toolCall,
    toolName: INVALID_TOOL_NAME,
    input: JSON.stringify({
      tool: requestedName,
      error: formatSyntheticToolErrorText(input.error),
    }),
  };
}

function buildInvalidMakaTool(): MakaTool<{ tool?: string; error?: string }, never> {
  return {
    name: INVALID_TOOL_NAME,
    description:
      'Internal repair target for malformed or unknown tool calls. Do not call directly.',
    parameters: z.object({
      tool: z.string().optional(),
      error: z.string().optional(),
    }),
    impl: ({ tool, error }) => {
      const requested = tool ? ` "${tool}"` : '';
      throw new Error(
        `模型请求了不可用或格式错误的工具${requested}：${error || 'tool call could not be parsed'}`,
      );
    },
  };
}

function priorReplayFailureTrace(replay: {
  gate: string;
  diagnostics: readonly { code: string }[];
}): { gate: string; diagnosticCodes: string[] } {
  return {
    gate: replay.gate,
    diagnosticCodes: [...new Set(replay.diagnostics.map((diagnostic) => diagnostic.code))],
  };
}

class ContinuationReplayEmptyError extends Error {
  readonly code = 'continuation_replay_empty';

  constructor(
    readonly replayGate: string,
    readonly diagnosticCodes: readonly string[],
  ) {
    super(`Continuation replay is empty after ${replayGate}`);
    this.name = 'ContinuationReplayEmptyError';
  }
}

function mergeActiveToolResultPruneDiagnosticPatches(
  left: ActiveToolResultPruneDiagnosticPatch,
  right: ActiveToolResultPruneDiagnosticPatch,
): ActiveToolResultPruneDiagnosticPatch {
  return {
    ...sumOptionalCounts('activePrunedToolResults', left, right),
    ...sumOptionalCounts('activeArchiveFailures', left, right),
    ...sumOptionalCounts('activeEstimatedTokensSaved', left, right),
  };
}

function mergeNormalizedUsage(
  current: NormalizedAiSdkUsage | undefined,
  next: NormalizedAiSdkUsage,
): NormalizedAiSdkUsage {
  if (!current) return next;
  const cacheMissInputSource =
    current.cacheMissInputSource === 'explicit' || next.cacheMissInputSource === 'explicit'
      ? 'explicit'
      : 'derived';
  const cacheHitInputTokens = current.cacheHitInputTokens + next.cacheHitInputTokens;
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    cacheHitInputTokens,
    cacheMissInputTokens: current.cacheMissInputTokens + next.cacheMissInputTokens,
    cacheMissInputSource,
    cacheWriteInputTokens: current.cacheWriteInputTokens + next.cacheWriteInputTokens,
    reasoningTokens: current.reasoningTokens + next.reasoningTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    ...(next.rawFinishReason !== undefined ? { rawFinishReason: next.rawFinishReason } : {}),
    cachedInputTokens: cacheHitInputTokens,
  };
}

function sumOptionalCounts<K extends keyof ActiveToolResultPruneDiagnosticPatch>(
  key: K,
  left: ActiveToolResultPruneDiagnosticPatch,
  right: ActiveToolResultPruneDiagnosticPatch,
): Pick<ActiveToolResultPruneDiagnosticPatch, K> | Record<string, never> {
  const total = (left[key] ?? 0) + (right[key] ?? 0);
  return total > 0 ? ({ [key]: total } as Pick<ActiveToolResultPruneDiagnosticPatch, K>) : {};
}

function voiceAudioPart(voiceAudio: EphemeralVoiceAudio): AudioPart {
  return {
    type: 'audio',
    data: voiceAudio.bytes,
    mediaType: voiceAudio.mediaType,
    format: voiceAudio.format,
    durationMs: voiceAudio.durationMs,
    ...(voiceAudio.transcript ? { transcript: voiceAudio.transcript } : {}),
    retention: 'operation_memory',
  };
}

function attachAudioToUserOrdinal(
  messages: readonly ModelMessage[],
  targetOrdinal: number,
  audio: AudioPart,
): ModelMessage[] {
  let userOrdinal = 0;
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const ordinal = userOrdinal++;
    if (ordinal !== targetOrdinal) return message;
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }, audio]
        : [...message.content.filter((part) => part.type !== 'audio'), audio];
    return { ...message, content };
  });
}

function contextBudgetWithActiveProjectionDiagnostics(
  base: ContextBudgetDiagnostic | undefined,
  patch: ActiveToolResultPruneDiagnosticPatch,
  activeFullCompactPatch: Partial<ContextBudgetDiagnostic> | undefined,
): ContextBudgetDiagnostic | undefined {
  const prunePatch = hasActiveToolResultPruneDiagnosticPatch(patch) ? patch : undefined;
  const mergedPatch = mergeContextBudgetDiagnosticPatches(prunePatch, activeFullCompactPatch);
  if (!mergedPatch) return base;
  return mergeContextBudgetDiagnostic(base ?? minimalContextBudgetDiagnostic(), mergedPatch);
}

function buildHistoryCompactCheckpointFailOpenContext(
  checkpoint: HistoryCompactCheckpoint,
  priorRuntimeContext: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy,
  retainedCandidates: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const charsPerToken = policy.charsPerToken ?? 4;
  const compactableEvents = priorRuntimeContext.filter(
    (event) => estimateRuntimeEventsTokens([event], charsPerToken) > 0,
  );
  const match = matchHistoryCompactCheckpointPrefix(checkpoint, compactableEvents);
  if (match.reason) return [...retainedCandidates];
  const coveredIds = new Set(match.coveredRuntimeEvents.map((event) => event.id));
  const candidates = retainedCandidates.filter((event) => !coveredIds.has(event.id));
  const turnOrder: string[] = [];
  const byTurn = new Map<string, RuntimeEvent[]>();
  for (const event of candidates) {
    const group = byTurn.get(event.turnId);
    if (group) group.push(event);
    else {
      turnOrder.push(event.turnId);
      byTurn.set(event.turnId, [event]);
    }
  }
  const maxTokens = policy.maxHistoryEstimatedTokens ?? Number.POSITIVE_INFINITY;
  const replayPrefix = projectHistoryCompactCheckpointReplay(
    checkpoint,
    match.coveredRuntimeEvents,
    [],
  );
  let selectedTokens = estimateRuntimeEventsTokens(replayPrefix, charsPerToken);
  const selectedGroups: RuntimeEvent[][] = [];
  for (let index = turnOrder.length - 1; index >= 0; index -= 1) {
    const group = byTurn.get(turnOrder[index]!) ?? [];
    const groupTokens = estimateRuntimeEventsTokens(group, charsPerToken);
    if (selectedTokens + groupTokens > maxTokens) break;
    selectedGroups.unshift(group);
    selectedTokens += groupTokens;
  }
  const replayTail = selectedGroups.flat();
  const replayEvents = projectHistoryCompactCheckpointReplay(
    checkpoint,
    match.coveredRuntimeEvents,
    replayTail,
  );
  return evaluateHistoryCompactCheckpointReplay(
    checkpoint,
    replayEvents.slice(1),
    policy?.charsPerToken,
    policy?.maxHistoryEstimatedTokens,
    {
      sourceReplayEvents: [...match.coveredRuntimeEvents, ...replayTail],
    },
  ).fits
    ? replayEvents
    : [...retainedCandidates];
}
