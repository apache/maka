/**
 * Inputs to runtime APIs (create session, send message, list/filter).
 */

import type { MessageContent } from './events.js';
import type {
  BackendKind,
  SessionBlockedReason,
  SessionStatus,
  SessionToolProfile,
  SubagentSessionParent,
  SubagentSessionRuntime,
  SubagentSessionSpawn,
} from './session.js';
import type { PermissionMode } from './permission.js';
import type { ThinkingLevel } from './model-thinking.js';
import type { CollaborationMode } from './collaboration.js';
import type { OrchestrationMode, TurnOrchestration } from './orchestration.js';
import type { SessionStartMode } from './explore-agent.js';
import type { SubagentWorkspaceBinding } from './subagent-workspace.js';
import type { ToolMode } from './tool-mode.js';

export type { TurnOrchestration } from './orchestration.js';

export interface CreateSessionInput {
  /** Absolute path to the session's working dir (project root). */
  cwd: string;
  /**
   * Stable project-catalog association. Main resolves `undefined`
   * automatically; `null` is the explicit no-project choice.
   */
  projectId?: string | null;
  /** If omitted, runtime auto-derives a placeholder; users may rename later. */
  name?: string;
  backend: BackendKind;
  llmConnectionSlug: string;
  /** Falls back to the connection's defaultModel if omitted. */
  model?: string;
  /** Per-model reasoning-depth variant; `undefined` = model default. */
  thinkingLevel?: ThinkingLevel;
  /** Immutable versioned prompt/tool contract for this Session. */
  toolProfile?: SessionToolProfile;
  permissionMode: PermissionMode;
  /** Defaults to `agent`. */
  collaborationMode?: CollaborationMode;
  /** Defaults to `default`. Orthogonal to Agent/Plan collaboration mode. */
  orchestrationMode?: OrchestrationMode;
  status?: SessionStatus;
  blockedReason?: SessionBlockedReason;
  parentSessionId?: string;
  branchOfTurnId?: string;
  subagentParent?: SubagentSessionParent;
  subagentRuntime?: SubagentSessionRuntime;
  subagentSpawn?: SubagentSessionSpawn;
  subagentWorkspace?: SubagentWorkspaceBinding;
  revisionRootSessionId?: string;
  revisionParentSessionId?: string;
  revisionOfTurnId?: string;
  revisionIndex?: number;
  revisionState?: 'preparing' | 'committed';
  labels?: string[];
}

/**
 * What the desktop `sessions:create` IPC accepts: a partial
 * `CreateSessionInput` the main process completes, plus the product intent the
 * renderer may name instead of spelling out what it implies (#1433).
 *
 * It lives beside `CreateSessionInput` rather than in the handler because
 * three modules describe this one wire shape — the handler, the preload
 * bridge, and the renderer's bridge contract — and only the first of them can
 * import from main. Written out three times it drifts silently: the renderer
 * type-checks against `bridge-contract.d.ts` alone, so a field added on one
 * side and not the other is a type error nowhere.
 */
export type CreateSessionRequestInput = Partial<CreateSessionInput> & {
  mode?: SessionStartMode;
};

export interface UserMessageInput extends MessageContent {
  /** Caller-generated uuid. Same id used in the UserMessage.turnId and in
   *  every event emitted by this turn. */
  turnId: string;
  /** Trusted per-turn cap on provider tool-call steps. */
  maxSteps?: number;
  /** Trusted host-supplied orchestration override for this turn only. */
  turnOrchestration?: TurnOrchestration;
  /** Trusted host-supplied tool protocol override for this run only. */
  toolMode?: ToolMode;
  parentRunId?: string;
  /** Child AgentRun whose durable conversation this child continues. */
  resumedFromRunId?: string;
  /** Immediate child AgentRun retried without appending another user prompt. */
  retriedFromRunId?: string;
  agentId?: string;
  agentName?: string;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  /** What triggered this turn, when it is not a direct user message. */
  origin?: TurnOrigin;
}

/** Non-user trigger source for a turn. */
export type TurnOrigin =
  | { kind: 'scheduled_task'; scheduledTaskId: string }
  | { kind: 'goal'; goalId: string }
  | {
      kind: 'agent_graph';
      graphId: string;
      /** Durable, graph-snapshot-scoped idempotency key for this supervisor wake. */
      wakeId: string;
      /** Durable identity of one delivery attempt for the wake. */
      attemptId: string;
    };

export interface AgentSpec {
  id: string;
  name: string;
  systemPrompt: string;
}

export interface ChildAgentTurnInput {
  turnId: string;
  parentRunId: string;
  spec: AgentSpec;
  prompt: string;
  /** Trusted, preflighted child AgentRun whose RuntimeEvent history is replayed. */
  resumedFromRunId?: string;
}

export interface RegenerateTurnInput {
  sourceTurnId: string;
  turnId?: string;
}

export interface BranchFromTurnInput {
  sourceTurnId: string;
  name?: string;
  /** Marks a transient read-only fork whose inherited history is reference-only. */
  sideConversation?: boolean;
}

export interface ReviseBeforeTurnInput {
  sourceTurnId: string;
}

export interface SessionListFilter {
  isArchived?: boolean;
  isFlagged?: boolean;
  labelSlug?: string;
  /** Return linked subagent sessions owned by this parent session. */
  subagentParentSessionId?: string;
}
