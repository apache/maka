/**
 * Backend → UI unified event stream.
 *
 * Runtime backends normalize their provider-native streams to
 * this `SessionEvent` union. The UI never imports SDK types directly.
 *
 * Connection-setup events live in ./connections.ts (separate channel).
 */

import type {
  AdditionalPermissionRequest,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  SandboxEscalationRequest,
} from './permission.js';
import type { UserQuestionRequest } from './user-question.js';
import type {
  PipeShellOutput,
  PtyShellOutput,
  ShellOutput,
  ShellRunOperation,
  ShellRunStatus,
  ShellRunTerminalStatus,
} from './shell-run.js';
import type {
  CacheMissInputSource,
  ContextBudgetDiagnostic,
  PrefixChangeReason,
  PromptSegmentEstimate,
} from './usage-stats/types.js';

export const TOOL_OUTPUT_STREAMS = ['stdout', 'stderr'] as const;
export const TOOL_OUTPUT_DELTA_MAX_CHARS = 8192;
export const TOOL_ACTIVITY_KINDS = [
  'read',
  'search',
  'websearch',
  'webfetch',
  'edit',
  'command',
  'explore',
  'browser',
  'tool',
] as const;
export type ToolActivityKind = (typeof TOOL_ACTIVITY_KINDS)[number];
type TerminalToolResultStatus = Exclude<ShellRunTerminalStatus, 'orphaned'>;

// ============================================================================
// Storage refs (shared by attachments, image tool results, etc.)
// ============================================================================

export type StorageRef =
  | { kind: 'session_file'; sessionId: string; relativePath: string }
  | { kind: 'workspace_file'; relativePath: string }
  | { kind: 'external_file'; absolutePath: string };

export interface AttachmentRef {
  kind: 'image' | 'pdf' | 'doc' | 'code' | 'other';
  name: string;
  mimeType: string;
  bytes: number;
  ref: StorageRef;
}

/**
 * An inline quoted excerpt attached to a user message — e.g. text selected in
 * the transcript and carried into a follow-up. Unlike {@link AttachmentRef}
 * (file-backed), the quoted text lives inline: it renders as a chip on the user
 * bubble (never as raw body text) and is folded into the model-facing content.
 */
export interface QuoteRef {
  text: string;
  /** Optional label shown on the chip (e.g. the source turn's role/preview). */
  label?: string;
  /** Provenance: the transcript turn the excerpt was selected from. */
  sourceTurnId?: string;
}

// ============================================================================
// Event union
// ============================================================================

interface BaseEvent {
  /** Event uuid — used for dedup on reconnect/replay. */
  id: string;
  /** Groups all events from one agent turn. */
  turnId: string;
  /** Unix ms timestamp. */
  ts: number;
}

export type SessionEvent =
  | TextDeltaEvent
  | TextCompleteEvent
  | ThinkingDeltaEvent
  | ThinkingCompleteEvent
  | ToolStartEvent
  | ToolOutputDeltaEvent
  | ToolProgressEvent
  | ToolResultEvent
  | AnyPermissionRequestEvent
  | PermissionDecisionAckEvent
  | UserQuestionRequestEvent
  | PlanSubmittedEvent
  | TokenUsageEvent
  | SteeringMessageEvent
  | QueueUpdateEvent
  | ProviderRetryEvent
  | ErrorEvent
  | CompleteEvent
  | AbortEvent;

export interface TextDeltaEvent extends BaseEvent {
  type: 'text_delta';
  messageId: string;
  text: string;
}

export interface TextCompleteEvent extends BaseEvent {
  type: 'text_complete';
  messageId: string;
  text: string;
}

export interface ThinkingDeltaEvent extends BaseEvent {
  type: 'thinking_delta';
  messageId: string;
  text: string;
}

export interface ThinkingCompleteEvent extends BaseEvent {
  type: 'thinking_complete';
  messageId: string;
  text: string;
  /** Anthropic signed thinking — MUST be re-sent on replay. */
  signature?: string;
  /** Provider-owned replay metadata that must survive backend recreation. */
  providerOptions?: Record<string, unknown>;
}

export interface ToolStartEvent extends BaseEvent {
  type: 'tool_start';
  toolUseId: string;
  toolName: string;
  /** Runtime-owned durable tool-operation identity (Phase 2). */
  operationId?: string;
  /** Stable semantic category for presentation; absent on legacy events. */
  activityKind?: ToolActivityKind;
  args: unknown;
  /** Provider-owned opaque call metadata that must survive model replay. */
  providerOptions?: Record<string, unknown>;
  displayName?: string;
  intent?: string;
  /**
   * Id of the assistant step this tool call belongs to (equals the step's
   * AssistantMessage id / the step's text+thinking messageId). Lets model
   * replay group a step's reasoning + text + tool calls into one provider
   * assistant message. Absent on legacy events; consumers treat a missing
   * stepId as un-pairable (degraded, per-turn) history.
   */
  stepId?: string;
}

export type ToolOutputStream = (typeof TOOL_OUTPUT_STREAMS)[number];

/**
 * Live output side-channel for long-running tools.
 *
 * This is intentionally separate from ToolResultEvent: deltas are transient UI
 * updates, while tool_result remains the terminal persisted result. `seq` is
 * monotonic per toolCallId/toolUseId so renderers can de-dupe and repair
 * event/result races without relying on arrival order.
 */
export interface ToolOutputDeltaEvent extends BaseEvent {
  type: 'tool_output_delta';
  sessionId: string;
  toolCallId: string;
  /** Existing UI/runtime name for the same identifier. */
  toolUseId: string;
  seq: number;
  stream: ToolOutputStream;
  chunk: string;
  redacted: boolean;
  createdAt: number;
}

export interface ToolProgressEvent extends BaseEvent {
  type: 'tool_progress';
  toolUseId: string;
  chunk: string | { kind: 'stdout' | 'stderr'; text: string };
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolUseId: string;
  /** Runtime-owned durable tool-operation identity (Phase 2). */
  operationId?: string;
  isError: boolean;
  content: ToolResultContent;
  durationMs?: number;
}

type ShellRunResultMetadata = {
  kind: 'shell_run';
  ref: string;
  status: ShellRunStatus;
  cwd: string;
  cmd: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  exitCode?: number;
  failureMessage?: string;
  revision: number;
  timeoutMs?: number;
  sandboxDenial?: SandboxDenialRecovery;
};

export interface SandboxDenialRecovery {
  likely: true;
  backend?: 'macos-seatbelt' | 'linux';
  recovery: 'require_escalated';
}

export type ShellRunCompactResult = ShellRunResultMetadata &
  ({ mode: 'pipes'; output?: never } | { mode: 'pty'; output?: never });

export type ShellRunSnapshotResult = ShellRunResultMetadata &
  ({ mode: 'pipes'; output: PipeShellOutput } | { mode: 'pty'; output: PtyShellOutput });

export type ShellRunStateResult = ShellRunCompactResult | ShellRunSnapshotResult;

type ShellRunStopOperation = Extract<ShellRunOperation, { kind: 'stop' }>;
type ShellRunPtyControlOperation = Extract<ShellRunOperation, { kind: 'pty_control' }>;
type ShellRunToolResultContent =
  | (ShellRunCompactResult & { operation?: never })
  | (ShellRunSnapshotResult &
      (
        | { operation?: never }
        | { operation: ShellRunStopOperation }
        | { mode: 'pty'; output: PtyShellOutput; operation: ShellRunPtyControlOperation }
      ));

export type ToolResultContent =
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown }
  | { kind: 'file_diff'; paths: string[]; diff: string }
  | { kind: 'file_write'; path: string; bytes: number }
  | {
      kind: 'archived_tool_result';
      status: 'not_loaded' | 'missing' | 'corrupt';
      runtimeEventId: string;
      toolCallId: string;
      toolName: string;
      artifactId?: string;
      bodySha256?: string;
      originalEstimatedTokens: number;
      originalBytes: number;
      rewriteVersion: number;
      reason: 'stale_tool_result_pruned_before_compact';
    }
  | {
      kind: 'terminal';
      cwd: string;
      cmd: string;
      status: TerminalToolResultStatus;
      exitCode?: number;
      failureMessage?: string;
      output: ShellOutput;
      sandboxDenial?: SandboxDenialRecovery;
    }
  | ShellRunToolResultContent
  | { kind: 'image'; mimeType: string; ref: StorageRef }
  | { kind: 'summary'; original: string; summarized: string; reason: 'too_large' }
  /**
   * PR-CHAT-WEB-SEARCH-RENDER-0: structured tool-result for the gated
   * WebSearch agent tool. The chat renderer surfaces these as plain
   * text cards (title + url + snippet + source); never markdown, never
   * HTML, matching the Settings → 联网搜索 live-query verification surface.
   *
   * Rows are an opaque `unknown[]` here so the storage layer does not
   * need to import the `@maka/core/web-search` row type; the renderer
   * narrows each row at render time.
   */
  | {
      kind: 'web_search';
      provider: string;
      query: string;
      rows: ReadonlyArray<{
        title: string;
        url: string;
        snippet: string;
        source: string;
      }>;
    }
  | {
      kind: 'web_search_error';
      ok: false;
      provider: string;
      query?: string;
      reason: string;
      message: string;
      credentialSource?: string;
    }
  | {
      kind: 'office_document';
      ok: boolean;
      operation?: string;
      path?: string;
      args?: string[];
      stdout?: string;
      stderr?: string;
      truncated?: boolean;
      reason?: string;
      message?: string;
    }
  | {
      kind: 'explore_agent';
      ok: boolean;
      partial?: boolean;
      terminalStatus?: 'completed' | 'completed_empty' | 'failed' | 'canceled' | 'canceled_partial';
      mode: 'read_only';
      objective: string;
      roots: string[];
      queries: string[];
      ignoredPaths?: string[];
      stoppingCondition?: string;
      limitReasons?: ReadonlyArray<
        'candidate_budget' | 'file_budget' | 'match_budget' | 'byte_budget'
      >;
      filesDiscovered?: number;
      filesInspected: number;
      filesSkipped: number;
      sensitiveFilesSkipped?: number;
      bytesRead: number;
      startedAt?: number;
      completedAt?: number;
      durationMs?: number;
      progress: string[];
      recentEvents?: ReadonlyArray<{ type: string; at: number; message: string }>;
      evidence?: ReadonlyArray<{
        type: 'match' | 'candidate';
        path: string;
        line?: number;
        label: string;
        score?: number;
      }>;
      summary?: string;
      report?: string;
      candidateFiles: ReadonlyArray<{ path: string; score: number; reasons: string[] }>;
      matches: ReadonlyArray<{ path: string; line: number; query: string; snippet: string }>;
      notes: string[];
      reason?: 'invalid_objective' | 'invalid_root' | 'no_readable_roots' | 'aborted';
      message?: string;
    }
  | {
      kind: 'subagent';
      childSessionId?: string;
      agentId?: string;
      agentName: string;
      turnId: string;
      runId?: string;
      status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_permission';
      permissionMode: PermissionMode;
      summary: string;
      artifactIds: readonly string[];
      startedAt?: number;
      completedAt?: number;
      durationMs?: number;
      eventCount?: number;
      failureClass?: string;
    }
  | {
      kind: 'agent_swarm';
      status: 'completed' | 'partial' | 'cancelled';
      items: ReadonlyArray<{
        itemId: string;
        index: number;
        profile: string;
        started: boolean;
        childSessionId?: string;
        agentId?: string;
        agentName?: string;
        turnId?: string;
        runId?: string;
        resumedFromRunId?: string;
        status: 'completed' | 'failed' | 'cancelled';
        summary: string;
        artifactIds: readonly string[];
        startedAt?: number;
        completedAt?: number;
        durationMs?: number;
        failureClass?: string;
      }>;
      startedAt: number;
      completedAt: number;
      durationMs: number;
    }
  | {
      kind: 'rive_workflow';
      ok: boolean;
      action: string;
      command: string[];
      state?: string;
      ids: {
        workflowRunId?: string;
        schedulerRunId?: string;
        rootWorkNodeId?: string;
      };
      summary: string;
      projection?: {
        templateId?: string;
        version?: number;
        templateHash?: string;
        idempotencyStatus?: string;
        workflowRunId?: string;
        schedulerRunId?: string;
        rootWorkNodeId?: string;
        state?: string;
        schedulerState?: string;
        rootState?: string;
      };
      nodes?: ReadonlyArray<{
        id?: string;
        templateId?: string;
        title?: string;
        state?: string;
        runner?: string;
        worker?: string;
      }>;
      stdoutTail?: string;
      stderrTail?: string;
      error?: {
        reason: string;
        message: string;
        code?: string;
        suggestedAction?: string;
      };
    };

/** Durable ShellRun state updates use a separate observer channel from model turns. */
export type ShellRunUpdateOwnership =
  | { kind: 'local' }
  | { kind: 'source_owned'; sourceSessionId: string; ownerSessionId: string }
  | { kind: 'source_unavailable'; sourceSessionId: string };

export interface ShellRunUpdate {
  /** Session whose conversation view should consume this projection. */
  sessionId: string;
  /** Whether the process is local or inherited, and whether its real owner is still resolvable. */
  ownership: ShellRunUpdateOwnership;
  sourceTurnId: string;
  sourceToolCallId: string;
  result: ShellRunStateResult;
}

export interface PermissionRequestEvent extends BaseEvent, PermissionRequest {
  type: 'permission_request';
}

export interface AdditionalPermissionRequestEvent extends BaseEvent, AdditionalPermissionRequest {
  type: 'permission_request';
  /** Additional-permission prompts deliberately do not expose raw tool arguments. */
  args: undefined;
  rememberForTurnAllowed?: false;
}

export interface SandboxEscalationRequestEvent extends BaseEvent, SandboxEscalationRequest {
  type: 'permission_request';
  /** Escalation prompts expose only bounded command and justification fields. */
  args: undefined;
  rememberForTurnAllowed?: false;
}

export type AnyPermissionRequestEvent =
  | PermissionRequestEvent
  | AdditionalPermissionRequestEvent
  | SandboxEscalationRequestEvent;

export interface UserQuestionRequestEvent extends BaseEvent, UserQuestionRequest {
  type: 'user_question_request';
}

/**
 * Echo of the user's permission decision back through the event stream so
 * all UI observers (and JSONL audit) see the same outcome. Mirrors the
 * PermissionDecisionMessage that storage appends.
 */
export interface PermissionDecisionAckEvent extends BaseEvent {
  type: 'permission_decision_ack';
  requestId: string;
  toolUseId: string;
  decision: 'allow' | 'deny';
  rememberForTurn?: boolean;
  reviewer?: import('./permission.js').ApprovalsReviewer;
  rationale?: string;
  riskLevel?: import('./permission.js').ApprovalRiskLevel;
}

export interface PlanSubmittedEvent extends BaseEvent {
  type: 'plan_submitted';
  planId: string;
  proposalId?: string;
  revision?: number;
  title: string;
  overview?: string;
  risks?: string[];
  /** Legacy file-backed proposal representation. */
  markdownPath?: string;
  steps?: PlanStep[];
}

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  files?: string[];
  complexity?: 'low' | 'medium' | 'high';
}

export interface TokenUsageEvent extends BaseEvent {
  type: 'token_usage';
  input: number;
  output: number;
  cacheHitInput?: number;
  cacheMissInput?: number;
  cacheWriteInput?: number;
  cacheMissInputSource?: CacheMissInputSource;
  reasoning?: number;
  total?: number;
  rawFinishReason?: string;
  /** Number of provider runtime/tool-loop steps represented by this usage. */
  runtimeSteps?: number;
  /** Backward-compatible alias for cacheHitInput. */
  cacheRead?: number;
  /** Backward-compatible alias for cacheWriteInput. */
  cacheCreation?: number;
  costUsd?: number;
  systemPromptHash?: string;
  contextRemaining?: number;
  prefixHash?: string;
  prefixChangeReason?: PrefixChangeReason;
  requestShapeHash?: string;
  requestShapeChangeReason?: PrefixChangeReason;
  promptSegments?: PromptSegmentEstimate[];
  contextBudget?: ContextBudgetDiagnostic;
  /** Links this aggregate to per-physical-request AgentRun trace rows. */
  providerRequestTraceId?: string;
}

/**
 * A user message injected into a running turn at a step boundary (steering).
 * The runtime persists it as a user event in the ledger and echoes it through
 * the stream so the transcript renders the interjection in place. `text` is the
 * raw user text; the backend wraps it in a steering envelope for the model.
 */
export interface SteeringMessageEvent extends BaseEvent {
  type: 'steering_message';
  messageId: string;
  text: string;
}

/**
 * Result of enqueuing a steering / followup message. `fallback` means there was
 * no active run to attach to (the turn just ended) and the caller should open a
 * fresh turn with the text instead, so a message is never silently dropped.
 * Queue contents travel on ONE path only: the `queue_update` event.
 */
export type QueueEnqueueOutcome = { kind: 'queued' } | { kind: 'fallback' };

/**
 * Authoritative queue snapshot pushed into the active turn's event stream
 * whenever either pending queue changes (enqueue, step-boundary consumption, or
 * interrupt clear). UI observers mirror it; the runtime owns the source of truth.
 */
export interface QueueUpdateEvent extends BaseEvent {
  type: 'queue_update';
  steering: string[];
  followup: string[];
}

export type ProviderRetryReason =
  | 'network'
  | 'provider_unavailable'
  | 'rate_limit'
  | 'timeout'
  | 'unknown';

/**
 * Transient progress for a provider request that Runtime will retry.
 *
 * This event is intentionally not a durable conversation fact. `attempt`
 * names the next/current physical request (2–10), while `maxAttempts`
 * includes the first request.
 */
export type ProviderRetryEvent = ProviderRetryScheduledEvent | ProviderRetryStartedEvent;

export interface ProviderRetryScheduledEvent extends BaseEvent {
  type: 'provider_retry';
  phase: 'scheduled';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: ProviderRetryReason;
}

export interface ProviderRetryStartedEvent extends BaseEvent {
  type: 'provider_retry';
  phase: 'started';
  attempt: number;
  maxAttempts: number;
  reason: ProviderRetryReason;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  recoverable: boolean;
  code?: string;
  /** Stable machine-readable reason for UI / telemetry routing. */
  reason?: string;
  message: string;
  /** Adapter MUST scrub secrets before populating this field. */
  details?: string[] | Record<string, unknown>;
}

export interface CompleteEvent extends BaseEvent {
  type: 'complete';
  stopReason:
    | 'end_turn'
    | 'user_stop'
    | 'error'
    | 'plan_handoff'
    | 'permission_handoff'
    | 'step_limit'
    | 'max_tokens'
    | 'context_budget_exhausted';
  /**
   * Detail for `stopReason: 'context_budget_exhausted'` — the runtime could not
   * produce a provider-safe request even after mid-turn compaction. A first-class
   * outcome, not a provider context-length error.
   */
  contextBudgetExhaustedDetail?: ContextBudgetExhaustedDetail;
}

export type ContextBudgetExhaustedDetail =
  | 'no_safe_completed_span'
  | 'summarizer_failed'
  | 'head_anchor_exceeds_capacity';

export type CompleteStopReason = CompleteEvent['stopReason'];

/** Stable failure taxonomy for complete events that did not finish the turn. */
export function failureClassFromCompleteStopReason(
  reason: CompleteStopReason,
): 'runtime_error' | 'tool_step_cap_reached' | 'context_budget_exhausted' | undefined {
  if (reason === 'error') return 'runtime_error';
  if (reason === 'step_limit') return 'tool_step_cap_reached';
  if (reason === 'context_budget_exhausted') return 'context_budget_exhausted';
  return undefined;
}

export interface AbortEvent extends BaseEvent {
  type: 'abort';
  reason: 'user_stop' | 'redirect' | 'timeout' | 'crash';
}

// ============================================================================
// UI → Backend commands
// ============================================================================

/**
 * SessionCommand: commands that target a specific session.
 *
 * Connection-management commands live in ConnectionCommand (./connections.ts).
 *
 * `permission_response` composes PermissionResponse rather than flattening
 * its fields, so there is exactly ONE shape for a permission decision in
 * the codebase.
 */
export type AttachmentIngestItem =
  | { approvalId: string; name: string; mimeType?: string }
  | { name: string; mimeType?: string; base64: string };

export type SessionCommand =
  | {
      type: 'send';
      turnId: string;
      text: string;
      attachmentItems?: AttachmentIngestItem[];
    }
  | { type: 'stop' }
  | { type: 'permission_response'; response: PermissionResponse }
  | {
      type: 'plan_response';
      planId: string;
      action: 'approve' | 'refine';
      feedback?: string;
    };
