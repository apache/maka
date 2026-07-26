/**
 * SessionManager — the public Runtime API.
 *
 * Ties together:
 *   SessionStore (storage)           — JSONL persistence
 *   AgentBackend (AiSdkBackend etc) — SDK adapter
 *   PermissionEngine                  — policy + parking
 *
 * `SessionStore` comes from `@maka/storage`; its public interface owns
 * persistence and same-session serialization semantics.
 */

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  SessionEvent,
  CompleteEvent,
  TextDeltaEvent,
  ErrorEvent,
  AbortEvent,
  PermissionDecisionAckEvent,
  PermissionRequestEvent,
  QueueEnqueueOutcome,
  ShellRunUpdate,
} from '@maka/core/events';
import type {
  SessionHeader,
  SessionBlockedReason,
  SessionStatus,
  SessionSummary,
  StoredMessage,
  SubagentSessionParent,
  TurnRecord,
  UserMessage,
  PermissionDecisionMessage,
  SystemNoteMessage,
  BackendKind,
} from '@maka/core/session';
import type {
  AgentSpec,
  ChildAgentTurnInput,
  CreateSessionInput,
  BranchFromTurnInput,
  RegenerateTurnInput,
  ReviseBeforeTurnInput,
  UserMessageInput,
  SessionListFilter,
} from '@maka/core/runtime-inputs';
import type { PermissionResponse } from '@maka/core/permission';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { PermissionMode } from '@maka/core/permission';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type {
  ApprovePlanProposalInput,
  PlanMutationResult,
  PlanSessionState,
  PlanStore,
} from '@maka/core/plan';
import {
  DEFAULT_SESSION_NAME,
  DEEP_RESEARCH_SESSION_LABEL,
  SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION,
  SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION,
  childSessionsForParent,
  decodeAgentGraphIntentClaim,
  failureClassFromCompleteStopReason,
  isDeepResearchSession,
  isPermissionModeWithinCeiling,
  isSessionInlineRun,
  subagentSessionRuntimeSummary,
} from '@maka/core';
import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimStore,
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  ArtifactRecord,
  RootExecutionDescriptor,
  RuntimeEvent,
  RuntimeEventStore,
  ToolBoundaryProtocol,
} from '@maka/core';
import { type RuntimeEventTerminalFact } from './runtime-event-read-model.js';
import {
  RuntimeReadModel,
  RuntimeReadModelError,
  type RuntimeReadModelSessionView,
} from './runtime-read-model.js';
import { inspectAgentRunReadModel, type AgentRunInspectModel } from './agent-run-inspect.js';
import { firstRuntimeRepairRunId, RuntimeLedgerRepair } from './runtime-ledger-repair.js';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
  effectiveRunHeaderFromTerminalFact,
  terminalRunStatusFromRuntimeEvent,
} from './terminal-run-commit.js';

import type { AgentBackend, BackendStopMode } from '@maka/core/backend-types';
import type { AgentTeamExecutionContext, MakaTool } from './tool-runtime.js';
import type { RunTraceRecorder } from './run-trace.js';
import type {
  ProviderRequestAttemptRecord,
  ProviderRequestCaptureLedgerRecord,
} from './provider-request-telemetry.js';
import type { ShellRunProcessManager } from './shell-run-manager.js';
import type { ActiveFullCompactBlock } from './active-full-compact.js';
import type { SemanticCompactBlock } from './semantic-compact.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';
import type { AgentRunLineage, RuntimeContinuationFailpoint } from './agent-run.js';
import { classifyAgentRunRecovery, type AgentRunRecoveryDecision } from './agent-run-recovery.js';
import type { InvocationResult, InvocationSource } from './invocation-context.js';
import {
  isRuntimeHostedRootAuthority,
  RuntimeMessageAuthorityInvariantError,
  type RuntimeHostedRootExecutionInput,
  type RuntimeMessageAuthority,
  type RuntimeMessageRunIdentity,
} from './message-authority.js';
import {
  RuntimeInteractionInvariantError,
  type CanonicalPermissionOutcomeReader,
  type RuntimeInteractionAuthority,
} from './interaction-authority.js';
import {
  RuntimeKernel,
  type BackendActivationBoundary,
  type RuntimeExecutionClaim,
  type RuntimeKernelLike,
  type TurnStartOptions,
} from './runtime-kernel.js';
import { fallbackSessionTitle, sessionTitleSource } from './session-title.js';
import type { HistoryCompactCleanupRequest } from './runtime-kernel.js';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  turnHasRetainedOutput as messagesHaveRetainedOutput,
} from './session-projection-helpers.js';
import {
  assertAgentDefinitionRunnable,
  buildToolsForAgentDefinition,
  getBuiltinAgentDefinition,
  listBuiltinAgentDefinitions,
  requireBuiltinAgentDefinitionByProfile,
  type AgentProfile,
  type AgentDefinition,
  type AgentDefinitionListItem,
} from './agent-catalog.js';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import { requireResolvedAgentDefinition } from './expert-catalog.js';
import type { SubagentExecutionRef } from './subagent-execution.js';
import {
  buildResumePlanFromRuntimeEvents,
  RuntimeContinuationPlanner,
  type RuntimeContinuation,
  type RuntimeContinuationPlannerInput,
  type RuntimeContinuationSafetyObservation,
  type SafeBoundaryContinuationPlan,
} from './runtime-resume.js';

export interface StopSessionInput {
  source?: 'stop_button' | 'benchmark_deadline';
  mode?: BackendStopMode;
}

export interface CompactSessionInput {
  turnId?: string;
}

export type PlanSafeBoundaryContinuationInput = Omit<RuntimeContinuationPlannerInput, 'sessionId'>;

export interface PlanAuthoritativeSafeBoundaryContinuationInput {
  sourceRunId: string;
  expectedRuntimeEventHighWater?: number;
}

export interface SpawnChildAgentInput {
  parentRunId: string;
  turnId?: string;
  spec: AgentSpec;
  prompt: string;
  abortSignal?: AbortSignal;
  onReady?: (input: { turnId: string; agentId: string; agentName: string }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

export interface SpawnChildSessionInput {
  spawnedBy: SubagentSessionParent['spawnedBy'];
  agentProfile: AgentProfile;
  prompt: string;
  name?: string;
  turnId?: string;
  runId?: string;
  swarm?: SubagentSessionParent['swarm'];
  abortSignal?: AbortSignal;
  onReady?: (input: {
    childSessionId: string;
    turnId: string;
    runId: string;
    agentId: string;
    agentName: string;
  }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

export interface SpawnChildSessionResult extends SpawnChildAgentResult {
  childSessionId: string;
  runId: string;
  profile: string;
}

export interface RunClaimedAgentGraphIntentInput {
  claimStore: AgentGraphIntentClaimStore;
  graphId: string;
  intentId: string;
  prompt: string;
  abortSignal?: AbortSignal;
  onReady?: (input: {
    claimId: string;
    graphId: string;
    intentId: string;
    operatorId: string;
    childSessionId: string;
    turnId: string;
    runId: string;
    agentId: string;
    agentName: string;
  }) => void | Promise<void>;
  /** Presentation-only observer for the newly started runtime stream. */
  onEvent?: (event: SessionEvent) => void;
}

export interface ClaimedAgentGraphIntentResult extends SpawnChildSessionResult {
  claimId: string;
  graphId: string;
  intentId: string;
  operatorId: string;
}

type ResolvedClaimedAgentGraphIntentInput = Omit<
  RunClaimedAgentGraphIntentInput,
  'claimStore' | 'graphId' | 'intentId'
> & {
  claim: AgentGraphIntentClaim;
};

export interface PrepareChildAgentResumeResult {
  sourceRunId: string;
  execution: SubagentExecutionRef;
  agentId: string;
  agentName: string;
  profile: string;
}

export interface ResumeChildAgentInput {
  parentRunId: string;
  sourceRunId: string;
  turnId?: string;
  prompt: string;
  abortSignal?: AbortSignal;
  onReady?: (input: {
    childSessionId?: string;
    turnId: string;
    runId?: string;
    agentId: string;
    agentName: string;
  }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

export interface SpawnChildAgentResult {
  childSessionId?: string;
  agentId: string;
  agentName: string;
  turnId: string;
  runId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user';
  permissionMode: PermissionMode;
  summary: string;
  artifactIds: string[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  eventCount: number;
  failureClass?: string;
  resumedFromRunId?: string;
  retriedFromRunId?: string;
}

export interface RetryChildAgentInput {
  parentRunId: string;
  sourceRunId: string;
  execution?: SubagentExecutionRef;
  abortSignal?: AbortSignal;
  onReady?: (input: {
    childSessionId?: string;
    turnId: string;
    runId?: string;
    agentId: string;
    agentName: string;
  }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

const CHILD_AGENT_SUMMARY_MAX_CHARS = 4_000;
const MAX_RUNTIME_LEDGER_REPAIR_ATTEMPTS = 8;

export interface AgentListItem {
  runId: string;
  turnId: string;
  parentRunId: string;
  agentId?: string;
  agentName?: string;
  status: AgentRunHeader['status'];
  permissionMode: AgentRunHeader['permissionMode'];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  failureClass?: string;
}

export interface SubagentExecutionListItem {
  execution: SubagentExecutionRef;
  agentId?: string;
  agentName?: string;
  profile?: string;
  turnId?: string;
  status: AgentRunHeader['status'];
  permissionMode: PermissionMode;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  failureClass?: string;
}

export interface AgentListResult {
  definitions: AgentDefinitionListItem[];
  /** Canonical mixed projection for new child Sessions and legacy same-session child AgentRuns. */
  executions: SubagentExecutionListItem[];
  /** Legacy projection retained while callers migrate to executions. */
  runs: AgentListItem[];
}

export interface AgentOutputInput {
  execution?: SubagentExecutionRef;
  runId?: string;
  turnId?: string;
  maxEvents?: number;
}

export interface AgentOutputResult {
  execution: SubagentExecutionRef;
  header: AgentRunHeader;
  events: AgentRunEvent[];
  runtimeEvents: RuntimeEvent[];
  sourceHealth: AgentRunInspectModel['sourceHealth'];
  diagnostics: AgentRunInspectModel['diagnostics'];
  artifacts: ArtifactRecord[];
  truncated: {
    events: boolean;
    runtimeEvents: boolean;
    diagnostics: boolean;
  };
}

// ============================================================================
// SessionStore contract (matches the storage package surface)
// ============================================================================

// StoredMessage rows remain a projection/cache surface for existing public
// shapes. RuntimeEventStore is the semantic conversation ledger.
export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionHeader>;
  createSubagent(input: CreateSessionInput): Promise<{ header: SessionHeader; created: boolean }>;
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  appendMessage(sessionId: string, m: StoredMessage): Promise<void>;
  appendMessages(sessionId: string, ms: StoredMessage[]): Promise<void>;
  updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader>;
  markSessionReadThrough(sessionId: string, readThroughTs: number): Promise<SessionHeader>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setGeneratedTitleIfAbsent?(sessionId: string, title: string): Promise<SessionHeader | null>;
  remove(sessionId: string): Promise<void>;
}

export interface StrictRecoverySessionStore extends SessionStore {
  listForRecovery(): Promise<SessionHeader[]>;
  readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]>;
}

export interface StrictRecoveryAgentRunStore extends AgentRunStore {
  listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]>;
  readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
}

export interface StrictRecoveryStores {
  sessionStore: StrictRecoverySessionStore;
  agentRunStore: StrictRecoveryAgentRunStore;
}

// ============================================================================
// BackendRegistry — factory dispatch by BackendKind
// ============================================================================

export interface BackendFactoryContext {
  sessionId: string;
  workspaceRoot: string;
  header: SessionHeader;
  store: SessionStore;
  appendMessage?: (message: StoredMessage) => Promise<void>;
  /**
   * Child-agent instruction channel. Legacy child runs and linked child
   * sessions populate this; an ordinary main-session activation leaves it
   * undefined. A
   * main-session factory that needs a system prompt must source it from
   * its own closure (the desktop path and the headless benchmark path
   * both do this) — do NOT route a main-session prompt through this
   * field, it is semantically the child instruction, not the session
   * system prompt.
   */
  systemPrompt?: string;
  /**
   * Optional hard tool ceiling for this backend activation. When present, a
   * host may remove tools for stricter local policy, but must never append,
   * substitute, or otherwise expose a tool outside this exact set.
   */
  tools?: readonly MakaTool[];
  /** Trusted child expert-team identity. Main-session factories leave this undefined. */
  agentTeam?: AgentTeamExecutionContext;
  recordRunTrace?: RunTraceRecorder;
  /** Durable AgentRun metadata row written after the private capture artifact. */
  recordProviderRequestCapture?: (capture: ProviderRequestCaptureLedgerRecord) => Promise<void>;
  /** Best-effort AgentRun row for one physical provider call. */
  recordProviderRequestAttempt?: (attempt: ProviderRequestAttemptRecord) => void;
  loadHistoryCompactCheckpoint?: () => Promise<HistoryCompactCheckpoint | undefined>;
  recordHistoryCompactCheckpoint?: (
    checkpoint: HistoryCompactCheckpoint,
    turnId: string,
  ) => Promise<void>;
  /**
   * Durable read of the given turn's persisted RuntimeEvents from the
   * authoritative run ledger. The Runtime reloads this projection between
   * provider requests; mid-turn compaction also derives its coverage pool from
   * the same durable facts.
   */
  loadTurnRuntimeEvents?: (turnId: string) => Promise<RuntimeEvent[]>;
  /** Whether this activation may fold its run ledger into session-scoped history. */
  allowMidTurnHistoryCompaction?: boolean;
  recordActiveFullCompactBlock?: (block: ActiveFullCompactBlock) => void;
  recordSemanticCompactBlock?: (block: SemanticCompactBlock) => void;
  shellRunContextSummary?: () => Promise<string | undefined>;
}

export type BackendFactory = (ctx: BackendFactoryContext) => AgentBackend | Promise<AgentBackend>;

export class BackendRegistry {
  private readonly factories = new Map<BackendKind, BackendFactory>();

  register(kind: BackendKind, factory: BackendFactory): void {
    this.factories.set(kind, factory);
  }

  async build(kind: BackendKind, ctx: BackendFactoryContext): Promise<AgentBackend> {
    const f = this.factories.get(kind);
    if (!f) throw new Error(`No backend factory registered for kind="${kind}"`);
    return await f(ctx);
  }

  has(kind: BackendKind): boolean {
    return this.factories.has(kind);
  }
}

// ============================================================================
// SessionManager
// ============================================================================

interface SessionManagerBaseDeps {
  store: SessionStore;
  planStore?: PlanStore;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  /** Host capability; RuntimeKernel gates it by the selected backend. */
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
  childTools?: readonly MakaTool[];
  listArtifactsForTurn?: (sessionId: string, turnId: string) => Promise<ArtifactRecord[]>;
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  runtimeKernel?: RuntimeKernelLike;
  /** Optional host-owned parent run authority for runtimes that execute the parent externally. */
  isParentRunActive?: (sessionId: string, runId: string, turnId: string) => boolean;
  shellRuns?: ShellRunProcessManager;
  cleanupHistoryCompactArtifacts?: (input: HistoryCompactCleanupRequest) => Promise<void>;
  inspectContinuationSafety?: (sessionId: string) => Promise<RuntimeContinuationSafetyObservation>;
  continuationFailpoint?: (point: RuntimeContinuationFailpoint) => Promise<void>;
  runBackendActivation?: BackendActivationBoundary;
  safeBoundaryResumeEnabled?: boolean;
  /** Hosted composition capability. Omit for the production embedded queue. */
  messageAuthority?: RuntimeMessageAuthority;
  onContinuationLifecycleEvent?: (event: RuntimeContinuationLifecycleEvent) => void | Promise<void>;
  generateSessionTitle?: (input: {
    sessionId: string;
    header: SessionHeader;
    sourceText: string;
  }) => Promise<string | undefined>;
  onSessionTitleChanged?: (sessionId: string) => void;
}

type SessionManagerInteractionDeps =
  | {
      /** Hosted composition capabilities. Omit both for embedded interaction ownership. */
      interactionAuthority: RuntimeInteractionAuthority;
      canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader;
    }
  | {
      interactionAuthority?: undefined;
      canonicalPermissionOutcomes?: undefined;
    };

export type SessionManagerDeps = SessionManagerBaseDeps & SessionManagerInteractionDeps;

export type RuntimeContinuationLifecycleEvent =
  | {
      type: 'plan_approved';
      sessionId: string;
      sourceRunId: string;
      targetRunId: string;
    }
  | {
      type: 'plan_parked';
      sessionId: string;
      sourceRunId: string;
      rejectionReasons: readonly string[];
    }
  | {
      type: 'execution_started' | 'execution_completed';
      sessionId: string;
      sourceRunId: string;
      targetRunId: string;
    }
  | {
      type: 'execution_failed';
      sessionId: string;
      sourceRunId: string;
      targetRunId: string;
      errorClass: string;
    };

export class SessionManager {
  private readonly runtimeKernel: RuntimeKernelLike;
  private readonly runtimeLedgerRepair?: RuntimeLedgerRepair;
  private readonly activeHostedLinkedChildSessions = new Set<string>();
  private readonly childSessionSpawns = new Map<
    string,
    { requestFingerprint: string; promise: Promise<SpawnChildSessionResult> }
  >();
  private readonly claimedAgentGraphIntentRuns = new Map<
    string,
    { requestFingerprint: string; promise: Promise<ClaimedAgentGraphIntentResult> }
  >();
  private readonly claimedAgentGraphSessionTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionManagerDeps) {
    if (deps.runStore && !deps.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    if (deps.runStore && deps.runtimeEventStore) {
      this.runtimeLedgerRepair = new RuntimeLedgerRepair({
        runStore: deps.runStore,
        runtimeEventStore: deps.runtimeEventStore,
        readMessages: (sessionId) => deps.store.readMessages(sessionId),
        appendTurnState: (sessionId, turnId, status, lineage, options) =>
          this.appendTurnState(sessionId, turnId, status, lineage, options),
        newId: deps.newId,
        now: deps.now,
      });
    }
    this.runtimeKernel =
      deps.runtimeKernel ??
      new RuntimeKernel({
        ...deps,
        repairRunRuntimeLedger: (sessionId, runId) =>
          this.repairMissingTerminalFactOnce(sessionId, runId),
      });
  }

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<SessionSummary> {
    const header = await this.deps.store.create(input);
    return headerToSummary(header);
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionSummary[]> {
    return this.deps.store.list(filter);
  }

  async listChildSessions(parentSessionId: string): Promise<SessionSummary[]> {
    const sessions = await this.deps.store.list({ subagentParentSessionId: parentSessionId });
    return childSessionsForParent(sessions, parentSessionId);
  }

  /** Invalidate backend snapshots now, or immediately after active turns settle. */
  async refreshIdleBackends(): Promise<void> {
    await this.runtimeKernel.invalidateCachedBackends();
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return (await this.getSessionView(sessionId)).messages;
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return (await this.getSessionView(sessionId)).turns;
  }

  async listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]> {
    const shellRuns = this.deps.shellRuns;
    if (!shellRuns) return [];

    const ownUpdates = await shellRuns.listSessionUpdates(sessionId);
    const ownToolCalls = new Set(ownUpdates.map((update) => update.sourceToolCallId));
    let messages: StoredMessage[];
    try {
      messages = await this.getMessages(sessionId);
    } catch (error) {
      if (!(error instanceof RuntimeReadModelError)) throw error;
      // ShellRun hydration is a best-effort UI projection. A legacy RuntimeEvent
      // incompatibility must not turn its retry loop into a permanent IPC error.
      try {
        messages = await this.deps.store.readMessages(sessionId);
      } catch {
        return ownUpdates;
      }
    }
    const bashToolCalls = new Set(
      messages.flatMap((message) =>
        message.type === 'tool_call' && message.toolName === 'Bash' ? [message.id] : [],
      ),
    );
    const inherited = new Map<
      string,
      {
        ref: string;
        turnId: string;
        toolUseId: string;
        result: ShellRunUpdate['result'];
      }
    >();
    for (const message of messages) {
      if (
        message.type === 'tool_result' &&
        bashToolCalls.has(message.toolUseId) &&
        !ownToolCalls.has(message.toolUseId) &&
        message.content.kind === 'shell_run' &&
        message.content.status === 'running'
      ) {
        const { operation: _operation, ...result } = message.content;
        inherited.set(message.toolUseId, {
          ref: message.content.ref,
          turnId: message.turnId,
          toolUseId: message.toolUseId,
          result,
        });
      }
    }
    if (inherited.size === 0) return ownUpdates;

    const inheritedFrom = await this.deps.store.readHeader(sessionId);
    const parentSessionId = inheritedFrom.revisionParentSessionId ?? inheritedFrom.parentSessionId;
    if (!parentSessionId) return ownUpdates;
    const inheritedUpdates = await Promise.all(
      [...inherited.values()].map(async (candidate) => {
        const owner = await this.resolveShellRunOwner(parentSessionId, candidate.ref);
        return {
          sessionId,
          ownership: owner
            ? {
                kind: 'source_owned',
                sourceSessionId: parentSessionId,
                ownerSessionId: owner.sessionId,
              }
            : { kind: 'source_unavailable', sourceSessionId: parentSessionId },
          sourceTurnId: candidate.turnId,
          sourceToolCallId: candidate.toolUseId,
          result: owner?.result ?? candidate.result,
        } satisfies ShellRunUpdate;
      }),
    );
    return [...ownUpdates, ...inheritedUpdates];
  }

  async recoverInterruptedSessions(): Promise<string[]> {
    return this.recoverInterruptedSessionsWithPolicy({ kind: 'best_effort' });
  }

  async recoverInterruptedSessionsStrict(stores: StrictRecoveryStores): Promise<string[]> {
    if (stores.sessionStore !== this.deps.store || stores.agentRunStore !== this.deps.runStore) {
      throw new Error('Strict recovery stores must match the SessionManager composition');
    }
    return this.recoverInterruptedSessionsWithPolicy({ kind: 'strict', stores });
  }

  private async recoverInterruptedSessionsWithPolicy(policy: RecoveryPolicy): Promise<string[]> {
    const interrupted = (await listSessionsForRecovery(this.deps.store, policy)).filter(
      (session) => session.status !== 'archived',
    );
    const recovered = new Set<string>();
    for (const session of interrupted) {
      if (this.runtimeKernel.hasActiveRuns(session.id)) continue;
      if (this.deps.planStore) {
        const planRecovery = await recoverOr(
          policy,
          () => this.deps.planStore!.interruptActiveExecution(session.id, 'runtime_recovery'),
          null,
        );
        if (planRecovery) recovered.add(session.id);
      }
      if (this.deps.shellRuns) {
        const recoveredShellRuns = await recoverOr(
          policy,
          () => this.deps.shellRuns!.recoverOrphanedSession(session.id),
          0,
        );
        if (recoveredShellRuns > 0) recovered.add(session.id);
      }
      let messages: StoredMessage[] = [];
      let messagesReadable = true;
      try {
        messages =
          policy.kind === 'strict'
            ? await policy.stores.sessionStore.readMessagesForRecovery(session.id)
            : await this.deps.store.readMessages(session.id);
      } catch (error) {
        if (policy.kind === 'strict') throw error;
        messagesReadable = false;
      }

      if (session.revisionState === 'preparing' && messagesReadable) {
        if (hasRevisionUserMessage(messages)) {
          await recoverOr(policy, () => this.commitRevisionVersion(session.id), undefined);
        } else {
          await recoverOr(policy, () => this.remove(session.id), undefined);
          recovered.add(session.id);
          continue;
        }
      }

      if (this.deps.runStore) {
        const runRecovery = await recoverOr(
          policy,
          () => this.recoverAgentRunsFromLedger(session.id, policy),
          undefined,
        );
        if (runRecovery?.hasLedger) {
          if (runRecovery.recovered) {
            await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
            recovered.add(session.id);
          } else if (
            !messagesReadable &&
            (session.status === 'running' || session.status === 'waiting_for_user')
          ) {
            await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
            recovered.add(session.id);
          }
          continue;
        }
      }

      if (!messagesReadable) {
        if (session.status === 'running' || session.status === 'waiting_for_user') {
          // Recovery may run in BACKGROUND startup (#456): re-check for a
          // run the user started while this session's recovery was in
          // flight, so we never stomp a live run's status.
          if (this.runtimeKernel.hasActiveRuns(session.id)) continue;
          await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
          recovered.add(session.id);
        }
        continue;
      }

      const recoveries = interruptedTurnRecoveries(messages);
      if (recoveries.length === 0) continue;
      for (const recovery of recoveries) {
        await recoverOr(
          policy,
          () =>
            this.appendTurnState(session.id, recovery.turnId, 'failed', recovery.lineage, {
              errorClass: recovery.errorClass,
            }),
          undefined,
        );
      }
      if (session.status === 'running' || session.status === 'waiting_for_user') {
        // Same double-check as above: a message sent mid-recovery owns
        // the session status now (its own transitions will settle it).
        if (this.runtimeKernel.hasActiveRuns(session.id)) {
          recovered.add(session.id);
          continue;
        }
        await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
      }
      recovered.add(session.id);
    }
    return [...recovered];
  }

  async updateSession(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionSummary> {
    const backendConfigChanged = changesBackendConfig(patch);
    if (backendConfigChanged && this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('Cannot change backend configuration while a turn is running');
    }

    const { name, titleIsManual: _titleIsManual, ...rest } = patch;
    if (name !== undefined) await this.deps.store.rename(sessionId, name);
    const next =
      Object.keys(rest).length > 0
        ? await this.deps.store.updateHeader(sessionId, rest)
        : await this.deps.store.readHeader(sessionId);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    if (backendConfigChanged) {
      // AgentBackend instances snapshot backend/model config at construction
      // time. If a stale session is rebound to a real default connection, the
      // next turn must build a fresh backend instead of reusing FakeBackend or
      // an AiSdkBackend pointed at a deleted connection.
      await this.runtimeKernel.disposeBackend(sessionId);
    }
    return headerToSummary(next);
  }

  async archive(sessionId: string): Promise<void> {
    const shellRunClose = await this.deps.shellRuns?.terminateSession(sessionId);
    try {
      await this.deps.store.archive(sessionId);
    } catch (error) {
      if (shellRunClose) this.deps.shellRuns?.rollbackSessionClose(shellRunClose);
      throw error;
    }
    if (shellRunClose) await this.deps.shellRuns?.commitSessionClose(shellRunClose);
    await this.runtimeKernel.disposeBackend(sessionId);
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.deps.store.unarchive(sessionId);
    this.deps.shellRuns?.resumeSession(sessionId);
  }

  async setSessionStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
  ): Promise<SessionSummary> {
    const next = await this.deps.store.updateHeader(
      sessionId,
      buildStatusPatch(status, this.deps.now(), blockedReason),
    );
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return headerToSummary(next);
  }

  async commitRevisionVersion(sessionId: string): Promise<SessionSummary> {
    const current = await this.deps.store.readHeader(sessionId);
    if (current.revisionState !== 'preparing') return headerToSummary(current);
    const next = await this.deps.store.updateHeader(sessionId, { revisionState: 'committed' });
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return headerToSummary(next);
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.deps.store.setFlagged(sessionId, isFlagged);
    const header = await this.deps.store.readHeader(sessionId).catch(() => undefined);
    if (header) this.runtimeKernel.updateCachedHeader(sessionId, header);
  }

  async markSessionRead(sessionId: string, readThroughTs: number | undefined): Promise<void> {
    if (readThroughTs === undefined || !Number.isFinite(readThroughTs)) return;
    const next = await this.deps.store.markSessionReadThrough(sessionId, readThroughTs);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.deps.store.rename(sessionId, name);
    const header = await this.deps.store.readHeader(sessionId).catch(() => undefined);
    if (header) this.runtimeKernel.updateCachedHeader(sessionId, header);
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    if (
      previous.subagentRuntime &&
      !isPermissionModeWithinCeiling(mode, previous.subagentRuntime.permissionCeiling)
    ) {
      throw new Error(
        `Child session permission mode "${mode}" exceeds its "${previous.subagentRuntime.permissionCeiling}" ceiling`,
      );
    }
    const leavingDeepResearch = isDeepResearchSession(previous.labels) && mode !== 'explore';
    if (previous.permissionMode === mode && !leavingDeepResearch) return headerToSummary(previous);

    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('当前对话正在运行，等结束后再切换权限模式。');
    }
    if (previous.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换权限模式。');
    }

    const next = await this.deps.store.updateHeader(sessionId, {
      permissionMode: mode,
      labels: leavingDeepResearch
        ? previous.labels.filter((label) => label !== DEEP_RESEARCH_SESSION_LABEL)
        : previous.labels,
    });
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'mode_change',
      data: { from: previous.permissionMode, to: mode },
    } satisfies SystemNoteMessage);

    this.runtimeKernel.updateCachedHeader(sessionId, next);
    // AiSdkBackend snapshots the header at construction time. Rebuild the
    // backend before the next turn so PermissionEngine receives the new mode.
    await this.runtimeKernel.disposeBackend(sessionId);
    return headerToSummary(next);
  }

  async getPlanState(sessionId: string): Promise<PlanSessionState> {
    return this.requirePlanStore().readState(sessionId);
  }

  async setCollaborationMode(sessionId: string, mode: CollaborationMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    const from = previous.collaborationMode ?? 'agent';
    if (from === mode) return headerToSummary(previous);
    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('当前对话正在运行，等结束后再切换协作模式。');
    }
    if (previous.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换协作模式。');
    }
    const planState = await this.requirePlanStore().readState(sessionId);
    if (mode === 'plan' && planState.activeExecutionId) {
      throw new Error('当前计划仍在执行，结束或中断后才能切换到 Plan Mode。');
    }
    const latestProposal = planState.proposals.find(
      (proposal) => proposal.proposalId === planState.latestProposalId,
    );
    if (mode === 'agent' && latestProposal?.status === 'pending_approval') {
      throw new Error('当前方案正在等待审批，请明确放弃方案后再退出 Plan Mode。');
    }

    const next = await this.deps.store.updateHeader(sessionId, {
      collaborationMode: mode,
    });
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'mode_change',
      data: { dimension: 'collaboration', from, to: mode },
    } satisfies SystemNoteMessage);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    await this.runtimeKernel.disposeBackend(sessionId);
    return headerToSummary(next);
  }

  async setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    const from = previous.orchestrationMode ?? 'default';
    if (from === mode) return headerToSummary(previous);
    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('Cannot change orchestration mode while a turn is running.');
    }
    if (previous.status === 'waiting_for_user') {
      throw new Error('Cannot change orchestration mode while a tool call awaits confirmation.');
    }
    const next = await this.deps.store.updateHeader(sessionId, { orchestrationMode: mode });
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'mode_change',
      data: { dimension: 'orchestration', from, to: mode },
    } satisfies SystemNoteMessage);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return headerToSummary(next);
  }

  async requestPlanRevision(sessionId: string, proposalId: string): Promise<PlanMutationResult> {
    const result = await this.requirePlanStore().requestRevision({ sessionId, proposalId });
    const header = await this.deps.store.readHeader(sessionId);
    if ((header.collaborationMode ?? 'agent') !== 'plan') {
      const next = await this.deps.store.updateHeader(sessionId, { collaborationMode: 'plan' });
      this.runtimeKernel.updateCachedHeader(sessionId, next);
    }
    await this.runtimeKernel.disposeBackend(sessionId);
    return result;
  }

  async abandonPlanProposal(sessionId: string, proposalId: string): Promise<PlanMutationResult> {
    const header = await this.deps.store.readHeader(sessionId);
    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('当前对话仍在运行，无法放弃计划。');
    }
    if (header.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，无法放弃计划。');
    }
    const result = await this.requirePlanStore().abandonProposal({
      sessionId,
      proposalId,
      reason: 'User exited Plan Mode before approval.',
    });
    const from = header.collaborationMode ?? 'agent';
    const next = await this.deps.store.updateHeader(sessionId, { collaborationMode: 'agent' });
    if (from !== 'agent') {
      await this.deps.store.appendMessage(sessionId, {
        type: 'system_note',
        id: this.deps.newId(),
        ts: this.deps.now(),
        kind: 'mode_change',
        data: { dimension: 'collaboration', from, to: 'agent' },
      } satisfies SystemNoteMessage);
    }
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    await this.runtimeKernel.disposeBackend(sessionId);
    return result;
  }

  async approvePlan(input: ApprovePlanProposalInput): Promise<PlanMutationResult> {
    const header = await this.deps.store.readHeader(input.sessionId);
    if (this.runtimeKernel.hasActiveRuns(input.sessionId)) {
      throw new Error('当前对话仍在运行，无法批准计划。');
    }
    if (header.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，无法批准计划。');
    }
    const result = await this.requirePlanStore().approveProposal(input);
    const next = await this.deps.store.updateHeader(input.sessionId, {
      collaborationMode: 'agent',
    });
    this.runtimeKernel.updateCachedHeader(input.sessionId, next);
    await this.runtimeKernel.disposeBackend(input.sessionId);
    return result;
  }

  async resumePlanExecution(sessionId: string, executionId: string): Promise<PlanMutationResult> {
    const result = await this.requirePlanStore().resumeExecution(sessionId, executionId);
    const next = await this.deps.store.updateHeader(sessionId, { collaborationMode: 'agent' });
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    await this.runtimeKernel.disposeBackend(sessionId);
    return result;
  }

  async cancelPlanExecution(sessionId: string, executionId: string): Promise<PlanMutationResult> {
    const planStore = this.requirePlanStore();
    const state = await planStore.readState(sessionId);
    const execution = state.executions.find((item) => item.executionId === executionId);
    if (execution?.status !== 'interrupted') {
      throw new Error('只有已中断的计划可以从这里放弃。');
    }
    const result = await planStore.cancelExecution({
      sessionId,
      executionId,
      reason: 'User abandoned the interrupted plan.',
    });
    await this.runtimeKernel.disposeBackend(sessionId);
    return result;
  }

  async interruptActivePlanExecution(
    sessionId: string,
    reason: string,
  ): Promise<PlanMutationResult | null> {
    const result = await this.requirePlanStore().interruptActiveExecution(sessionId, reason);
    if (result) await this.runtimeKernel.disposeBackend(sessionId);
    return result;
  }

  async remove(sessionId: string): Promise<void> {
    const shellRunClose = await this.deps.shellRuns?.terminateSession(sessionId);
    try {
      await this.runtimeKernel.disposeBackend(sessionId);
      await this.deps.store.remove(sessionId);
    } catch (error) {
      if (shellRunClose) this.deps.shellRuns?.rollbackSessionClose(shellRunClose);
      throw error;
    }
    if (shellRunClose) await this.deps.shellRuns?.commitSessionClose(shellRunClose);
  }

  // --------------------------------------------------------------------------
  // Send / stream — Phase 1 vertical heart
  // --------------------------------------------------------------------------

  /**
   * Send a user message and stream back normalized events. The caller
   * (desktop main) is expected to forward the events to the renderer over
   * the IPC bridge.
   *
   * Runtime v2 bridge: SessionManager remains the public facade; RuntimeKernel
   * owns AgentRun/AiSdkFlow/RuntimeRunner orchestration and ledger recording.
   */
  async *sendMessage(
    sessionId: string,
    input: UserMessageInput,
    options: TurnStartOptions = {},
  ): AsyncIterable<SessionEvent> {
    const sourceText = sessionTitleSource(input);
    const onRunStarted = this.deps.generateSessionTitle
      ? async (runId: string, header: SessionHeader) => {
          await options.onRunStarted?.(runId, header);
          if (
            !header.connectionLocked &&
            !header.titleIsManual &&
            header.name === DEFAULT_SESSION_NAME &&
            sourceText
          ) {
            void this.generateTitleInBackground(sessionId, header, sourceText);
          }
        }
      : options.onRunStarted;
    yield* this.runtimeKernel.startTurn(sessionId, input, { ...options, onRunStarted });
  }

  private async generateTitleInBackground(
    sessionId: string,
    header: SessionHeader,
    sourceText: string,
  ): Promise<void> {
    let generated: string | undefined;
    try {
      generated = await this.deps.generateSessionTitle?.({ sessionId, header, sourceText });
    } catch {}
    try {
      const title = generated ?? fallbackSessionTitle(sourceText);
      if (!title) return;
      const next = await this.deps.store.setGeneratedTitleIfAbsent?.(sessionId, title);
      if (!next) return;
      this.runtimeKernel.updateCachedHeader(sessionId, next);
      this.deps.onSessionTitleChanged?.(sessionId);
    } catch {}
  }

  async planSafeBoundaryContinuation(
    sessionId: string,
    input: PlanSafeBoundaryContinuationInput,
  ): Promise<SafeBoundaryContinuationPlan> {
    const planner = new RuntimeContinuationPlanner({
      readSourceRun: async (targetSessionId, runId) => {
        if (!this.deps.runStore) throw new Error('AgentRunStore is not configured');
        return this.deps.runStore.readRun(targetSessionId, runId);
      },
      readRuntimeEvents: async (targetSessionId, runId) => {
        if (!this.deps.runtimeEventStore) throw new Error('RuntimeEventStore is not configured');
        return this.deps.runtimeEventStore.readRuntimeEvents(targetSessionId, runId);
      },
      findExistingContinuation: async (
        targetSessionId,
        sourceRunId,
        sourceRuntimeEventHighWater,
      ) => {
        if (!this.deps.runStore) throw new Error('AgentRunStore is not configured');
        return (await this.deps.runStore.listSessionRuns(targetSessionId)).find(
          (run) =>
            run.continuationSource?.sourceRunId === sourceRunId &&
            run.continuationSource.sourceRuntimeEventHighWater === sourceRuntimeEventHighWater,
        );
      },
      newId: this.deps.newId,
    });
    const plan = await planner.plan({ sessionId, ...input });
    this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
    return plan;
  }

  async planAuthoritativeSafeBoundaryContinuation(
    sessionId: string,
    input: PlanAuthoritativeSafeBoundaryContinuationInput,
  ): Promise<SafeBoundaryContinuationPlan> {
    if (this.deps.safeBoundaryResumeEnabled !== true) {
      const plan = resumeFeatureDisabledPlan();
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    if (!this.deps.runStore || !this.deps.inspectContinuationSafety) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['safety_observation_unavailable'],
        diagnostics: [
          {
            code: 'safety_observation_unavailable',
            message: 'authoritative continuation safety inspection is not configured',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    const sourceRun = await this.deps.runStore
      .readRun(sessionId, input.sourceRunId)
      .catch(() => undefined);
    if (!sourceRun) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['source_run_unreadable'],
        diagnostics: [
          { code: 'source_run_unreadable', message: 'source AgentRun could not be read' },
        ],
      };
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    if (!sourceRun.workspaceIdentity) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['workspace_identity_missing'],
        diagnostics: [
          {
            code: 'workspace_identity_missing',
            message: 'source AgentRun has no authoritative workspace identity',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    const [header, observation] = await Promise.all([
      this.deps.store.readHeader(sessionId),
      this.deps.inspectContinuationSafety(sessionId),
    ]);
    return this.planSafeBoundaryContinuation(sessionId, {
      sourceRunId: input.sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: sourceRun.workspaceIdentity,
      currentWorkspaceIdentity: observation.workspaceIdentity,
      backgroundOperationsSettled: observation.backgroundOperationsSettled,
      availableToolNames: observation.availableToolNames,
      ...(input.expectedRuntimeEventHighWater !== undefined
        ? { expectedRuntimeEventHighWater: input.expectedRuntimeEventHighWater }
        : {}),
      ...(observation.workspaceCheckpoint
        ? { workspaceCheckpoint: observation.workspaceCheckpoint }
        : {}),
    });
  }

  async planLatestAuthoritativeSafeBoundaryContinuation(
    sessionId: string,
  ): Promise<SafeBoundaryContinuationPlan> {
    if (this.deps.safeBoundaryResumeEnabled !== true) {
      const plan = resumeFeatureDisabledPlan();
      this.recordContinuationPlan(sessionId, '', plan);
      return plan;
    }
    if (!this.deps.runStore) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['resume_candidate_missing'],
        diagnostics: [
          {
            code: 'resume_candidate_missing',
            message: 'no AgentRun store is configured for resume discovery',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, '', plan);
      return plan;
    }
    const candidate = (await this.deps.runStore.listSessionRuns(sessionId))
      .filter(
        (run) => (run.status === 'failed' || run.status === 'cancelled') && isSessionInlineRun(run),
      )
      .sort(
        (left, right) => right.createdAt - left.createdAt || right.runId.localeCompare(left.runId),
      )[0];
    if (!candidate) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['resume_candidate_missing'],
        diagnostics: [
          {
            code: 'resume_candidate_missing',
            message: 'no failed or cancelled top-level continuation candidate exists',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, '', plan);
      return plan;
    }
    return this.planAuthoritativeSafeBoundaryContinuation(sessionId, {
      sourceRunId: candidate.runId,
    });
  }

  async *resumeSafeBoundaryContinuation(
    continuation: RuntimeContinuation,
  ): AsyncIterable<SessionEvent> {
    const resume = this.runtimeKernel.resumeContinuation;
    if (!resume) throw new Error('RuntimeKernel does not support safe-boundary continuation');
    this.recordContinuationLifecycleEvent({
      type: 'execution_started',
      sessionId: continuation.sessionId,
      sourceRunId: continuation.sourceRunId,
      targetRunId: continuation.runId,
    });
    try {
      yield* resume.call(this.runtimeKernel, continuation);
      this.recordContinuationLifecycleEvent({
        type: 'execution_completed',
        sessionId: continuation.sessionId,
        sourceRunId: continuation.sourceRunId,
        targetRunId: continuation.runId,
      });
    } catch (error) {
      this.recordContinuationLifecycleEvent({
        type: 'execution_failed',
        sessionId: continuation.sessionId,
        sourceRunId: continuation.sourceRunId,
        targetRunId: continuation.runId,
        errorClass: continuationExecutionErrorClass(error),
      });
      throw error;
    }
  }

  private recordContinuationPlan(
    sessionId: string,
    sourceRunId: string,
    plan: SafeBoundaryContinuationPlan,
  ): void {
    if (plan.disposition === 'continue' && plan.continuation) {
      this.recordContinuationLifecycleEvent({
        type: 'plan_approved',
        sessionId,
        sourceRunId,
        targetRunId: plan.continuation.runId,
      });
      return;
    }
    this.recordContinuationLifecycleEvent({
      type: 'plan_parked',
      sessionId,
      sourceRunId,
      rejectionReasons: plan.rejectionReasons,
    });
  }

  private recordContinuationLifecycleEvent(event: RuntimeContinuationLifecycleEvent): void {
    try {
      const result = this.deps.onContinuationLifecycleEvent?.(event);
      if (result) void Promise.resolve(result).catch(() => {});
    } catch {
      // Operational telemetry must never alter resume correctness.
    }
  }

  async *compactSession(
    sessionId: string,
    input: CompactSessionInput = {},
  ): AsyncIterable<SessionEvent> {
    yield* this.runtimeKernel.compactSession(sessionId, input);
  }

  async *startChildTurn(
    sessionId: string,
    input: ChildAgentTurnInput,
  ): AsyncIterable<SessionEvent> {
    const execution = this.runtimeKernel.claimExecution(sessionId);
    try {
      yield* this.runtimeKernel.startChildTurn(sessionId, input, execution);
    } finally {
      execution.release();
    }
  }

  async spawnChildAgent(
    sessionId: string,
    input: SpawnChildAgentInput,
  ): Promise<SpawnChildAgentResult> {
    const execution = this.runtimeKernel.claimExecution(sessionId);
    try {
      const definition = requireResolvedAgentDefinition(input.spec.id);
      return await this.runChildAgent(sessionId, definition, input, execution);
    } finally {
      execution.release();
    }
  }

  /**
   * Create and run a durable linked child Session without changing the
   * parent-facing agent_spawn compatibility path.
   *
   * Cross-session provenance lives on the child header. The first AgentRun
   * intentionally carries no parentRunId, so it is an ordinary session-inline
   * run and every later child turn can reuse only the child's own history.
   */
  async spawnChildSession(
    parentSessionId: string,
    input: SpawnChildSessionInput,
  ): Promise<SpawnChildSessionResult> {
    const spawnKey = childSessionSpawnKey(parentSessionId, input);
    const requestFingerprint = childSessionRequestFingerprint(parentSessionId, input);
    const inFlight = this.childSessionSpawns.get(spawnKey);
    if (inFlight) {
      if (inFlight.requestFingerprint !== requestFingerprint) {
        throw new Error('Child-session spawn identity was reused for different work');
      }
      return await inFlight.promise;
    }
    const runtimeOwner = {
      execution: this.runtimeKernel.claimExecution(parentSessionId),
    };
    const promise = this.spawnChildSessionOnce(
      parentSessionId,
      input,
      requestFingerprint,
      runtimeOwner,
    ).finally(() => runtimeOwner.execution.release());
    this.childSessionSpawns.set(spawnKey, { requestFingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.childSessionSpawns.get(spawnKey)?.promise === promise) {
        this.childSessionSpawns.delete(spawnKey);
      }
    }
  }

  /**
   * Execute one durably claimed graph intent through the existing
   * session-inline child runtime primitive.
   *
   * The graph claim is admission authority only. Once its exact run identity
   * exists, the AgentRun/RuntimeEvent ledgers are execution authority and a
   * retry observes or recovers that run instead of invoking the backend again.
   */
  async runClaimedAgentGraphIntent(
    input: RunClaimedAgentGraphIntentInput,
  ): Promise<ClaimedAgentGraphIntentResult> {
    if (isRuntimeHostedRootAuthority(this.deps.messageAuthority)) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Claimed graph execution requires a Runtime Host graph composition',
      );
    }
    const claim = await input.claimStore.readAgentGraphIntentClaim(input.graphId, input.intentId);
    if (!claim) {
      throw new Error(`Graph intent ${input.graphId}/${input.intentId} has not been claimed`);
    }
    decodeAgentGraphIntentClaim(claim);
    if (claim.graphId !== input.graphId || claim.intentId !== input.intentId) {
      throw new Error('Graph intent claim store returned a mismatched identity');
    }
    if (!input.prompt.trim()) {
      throw new Error('Claimed graph intent prompt must not be empty');
    }
    const resolved: ResolvedClaimedAgentGraphIntentInput = {
      claim,
      prompt: input.prompt,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.onReady ? { onReady: input.onReady } : {}),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    };
    const requestFingerprint = claimedAgentGraphIntentRequestFingerprint(resolved);
    const inFlight = this.claimedAgentGraphIntentRuns.get(claim.claimId);
    if (inFlight) {
      if (inFlight.requestFingerprint !== requestFingerprint) {
        throw new Error('Graph intent claim identity was reused for different execution input');
      }
      return await inFlight.promise;
    }
    const runtimeExecution = this.runtimeKernel.claimExecution(claim.targetSessionId);
    const promise = this.enqueueClaimedAgentGraphIntent(resolved, runtimeExecution).finally(() =>
      runtimeExecution.release(),
    );
    this.claimedAgentGraphIntentRuns.set(claim.claimId, {
      requestFingerprint,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.claimedAgentGraphIntentRuns.get(claim.claimId)?.promise === promise) {
        this.claimedAgentGraphIntentRuns.delete(claim.claimId);
      }
    }
  }

  private enqueueClaimedAgentGraphIntent(
    input: ResolvedClaimedAgentGraphIntentInput,
    runtimeExecution: RuntimeExecutionClaim,
  ): Promise<ClaimedAgentGraphIntentResult> {
    const sessionId = input.claim.targetSessionId;
    const previous = this.claimedAgentGraphSessionTails.get(sessionId) ?? Promise.resolve();
    const execution = previous
      .catch(() => {
        // A failed predecessor releases the Session slot for the next claim.
      })
      .then(() => this.runClaimedAgentGraphIntentOnce(input, runtimeExecution));
    const tail = execution.then(
      () => {},
      () => {},
    );
    this.claimedAgentGraphSessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.claimedAgentGraphSessionTails.get(sessionId) === tail) {
        this.claimedAgentGraphSessionTails.delete(sessionId);
      }
    });
    return execution;
  }

  private async runClaimedAgentGraphIntentOnce(
    input: ResolvedClaimedAgentGraphIntentInput,
    runtimeExecution: RuntimeExecutionClaim,
  ): Promise<ClaimedAgentGraphIntentResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Claimed graph execution requires AgentRunStore and RuntimeEventStore');
    }
    if (input.abortSignal?.aborted) {
      throw new Error('Claimed graph execution was cancelled before runtime admission');
    }

    const { claim } = input;
    const child = await this.deps.store.readHeader(claim.targetSessionId);
    const snapshot = child.subagentRuntime;
    if (
      child.id !== claim.targetSessionId ||
      child.subagentParent?.kind !== 'subagent' ||
      !snapshot
    ) {
      throw new Error('Claimed graph execution target must be a linked child session');
    }
    const readyInfo = {
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: child.id,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
    };
    let readyNotification: Promise<void> | undefined;
    const notifyReady = (): Promise<void> => {
      readyNotification ??= Promise.resolve().then(() => input.onReady?.(readyInfo));
      return readyNotification;
    };

    let run = await this.deps.runStore.readRun(child.id, claim.targetRunId).catch((error) => {
      if (isNotFoundError(error)) return undefined;
      throw error;
    });
    if (run) {
      this.assertClaimedAgentGraphRun(child, snapshot, claim, run);
      await this.assertClaimedAgentGraphPrompt(child.id, claim.targetTurnId, input.prompt);
      await notifyReady();
      while (
        !isTerminalRunStatus(run.status) &&
        this.runtimeKernel.hasActiveRun?.(child.id, run.runId, run.turnId)
      ) {
        await delay(25, undefined, input.abortSignal ? { signal: input.abortSignal } : undefined);
        run = await this.deps.runStore.readRun(child.id, claim.targetRunId);
      }
      if (!isTerminalRunStatus(run.status)) {
        await this.recoverAgentRunsFromLedger(child.id);
        run = await this.deps.runStore.readRun(child.id, claim.targetRunId);
      }
      this.assertClaimedAgentGraphRun(child, snapshot, claim, run);
      await this.assertClaimedAgentGraphPrompt(child.id, claim.targetTurnId, input.prompt);
      return claimedAgentGraphIntentResult(claim, await this.projectExistingChildSpawn(child, run));
    }

    const [runs, messages] = await Promise.all([
      this.deps.runStore.listSessionRuns(child.id),
      this.deps.store.readMessages(child.id),
    ]);
    const turnOwner = runs.find((candidate) => candidate.turnId === claim.targetTurnId);
    if (turnOwner) {
      throw new Error(
        `Claimed graph turn ${claim.targetTurnId} is already owned by run ${turnOwner.runId}`,
      );
    }
    if (messages.some((message) => 'turnId' in message && message.turnId === claim.targetTurnId)) {
      throw new Error(`Claimed graph turn ${claim.targetTurnId} already has durable messages`);
    }
    if (child.isArchived || child.status === 'archived' || child.status === 'aborted') {
      throw new Error('Claimed graph execution target child session is terminated');
    }
    if (input.abortSignal?.aborted) {
      throw new Error('Claimed graph execution was cancelled before runtime admission');
    }

    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = false;
    let stopPromise: Promise<void> | undefined;
    const iterator = this.sendMessage(
      child.id,
      {
        turnId: claim.targetTurnId,
        text: input.prompt,
        agentId: snapshot.agentId,
        agentName: snapshot.agentName,
      },
      {
        runId: claim.targetRunId,
        durability: 'required',
        onRunStarted: notifyReady,
        execution: runtimeExecution,
      },
    )[Symbol.asyncIterator]();
    const onAbort = () => {
      aborted = true;
      stopPromise ??= this.stopSession(child.id, { source: 'stop_button' });
    };
    if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (input.abortSignal.aborted) onAbort();
    }
    try {
      while (!aborted) {
        const next = await iterator.next();
        if (next.done) break;
        summary.add(next.value);
        try {
          input.onEvent?.(next.value);
        } catch {
          // A presentation observer must not change graph execution.
        }
        if (aborted) break;
      }
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) {
        await stopPromise;
        await iterator.return?.();
      }
    }

    const completedAt = this.deps.now();
    const completedRun = await this.deps.runStore.readRun(child.id, claim.targetRunId);
    this.assertClaimedAgentGraphRun(child, snapshot, claim, completedRun);
    const failureClass = completedRun.failureClass ?? summary.failureClass;
    const artifacts = this.deps.listArtifactsForTurn
      ? await this.deps.listArtifactsForTurn(child.id, claim.targetTurnId)
      : [];
    return {
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: child.id,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      profile: snapshot.profile,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      status: agentRunStatusForSpawnResult(completedRun.status),
      permissionMode: child.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
    };
  }

  private assertClaimedAgentGraphRun(
    child: SessionHeader,
    snapshot: NonNullable<SessionHeader['subagentRuntime']>,
    claim: AgentGraphIntentClaim,
    run: AgentRunHeader,
  ): void {
    if (
      run.sessionId !== child.id ||
      run.runId !== claim.targetRunId ||
      run.turnId !== claim.targetTurnId ||
      !isSessionInlineRun(run) ||
      run.agentId !== snapshot.agentId ||
      (run.agentName !== undefined && run.agentName !== snapshot.agentName)
    ) {
      throw new Error('Existing AgentRun does not match the claimed graph activation identity');
    }
  }

  private async assertClaimedAgentGraphPrompt(
    sessionId: string,
    turnId: string,
    prompt: string,
  ): Promise<void> {
    const messages = await this.deps.store.readMessages(sessionId);
    const userMessages = messages.filter(
      (message): message is UserMessage => message.type === 'user' && message.turnId === turnId,
    );
    if (userMessages.length > 1 || (userMessages[0] && userMessages[0].text !== prompt)) {
      throw new Error('Graph intent claim identity was reused for different execution input');
    }
  }

  private async spawnChildSessionOnce(
    parentSessionId: string,
    input: SpawnChildSessionInput,
    requestFingerprint: string,
    runtimeOwner: { execution: RuntimeExecutionClaim },
  ): Promise<SpawnChildSessionResult> {
    if (input.abortSignal?.aborted) {
      throw new Error('Child session spawn was cancelled before creation');
    }
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child session creation requires AgentRunStore and RuntimeEventStore');
    }
    const [parentHeader, parentRun] = await Promise.all([
      this.deps.store.readHeader(parentSessionId),
      this.deps.runStore.readRun(parentSessionId, input.spawnedBy.parentRunId),
    ]);
    this.assertActiveParentRun(parentSessionId, parentRun, input.spawnedBy.parentTurnId);

    const definition = requireBuiltinAgentDefinitionByProfile(input.agentProfile);
    const availableChildTools = this.deps.childTools ?? [];
    assertAgentDefinitionRunnable({
      parentPermissionMode: parentHeader.permissionMode,
      definition,
      tools: availableChildTools,
    });

    const proposedTurnId = input.turnId ?? this.deps.newId();
    const proposedRunId = input.runId ?? this.deps.newId();
    const creation = await this.deps.store.createSubagent({
      cwd: parentHeader.cwd,
      name: input.name ?? definition.name,
      backend: parentHeader.backend,
      llmConnectionSlug: parentHeader.llmConnectionSlug,
      model: parentHeader.model,
      ...(parentHeader.thinkingLevel !== undefined
        ? { thinkingLevel: parentHeader.thinkingLevel }
        : {}),
      permissionMode: definition.permissionMode,
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      subagentParent: {
        kind: 'subagent',
        parentSessionId,
        spawnedBy: input.spawnedBy,
        ...(input.swarm ? { swarm: input.swarm } : {}),
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION,
        definitionVersion: definition.definitionVersion,
        agentId: definition.id,
        agentName: definition.name,
        profile: definition.profile,
        systemPrompt: definition.systemPrompt,
        toolNames: [...definition.tools],
        categoryPolicy: { ...definition.categoryPolicy },
        permissionCeiling: parentHeader.permissionMode,
      },
      subagentSpawn: {
        schemaVersion: SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION,
        requestFingerprint,
        initialTurnId: proposedTurnId,
        initialRunId: proposedRunId,
      },
    });
    const child = creation.header;
    const snapshot = child.subagentRuntime;
    const spawn = child.subagentSpawn;
    if (!snapshot || !spawn || !child.subagentParent) {
      throw new Error('Stored child session is missing its durable runtime or spawn identity');
    }
    try {
      runtimeOwner.execution = this.transferRuntimeExecution(runtimeOwner.execution, child.id);
    } catch (error) {
      if (creation.created) await this.updateStatus(child.id, 'aborted').catch(() => {});
      throw error;
    }
    const releaseHostedExecution = this.acquireHostedLinkedChildExecution(child.id);
    try {
      const turnId = spawn.initialTurnId;
      const runId = spawn.initialRunId;
      const readyInfo = {
        childSessionId: child.id,
        turnId,
        runId,
        agentId: snapshot.agentId,
        agentName: snapshot.agentName,
      };
      let readyNotification: Promise<void> | undefined;
      const notifyReady = (): Promise<void> => {
        readyNotification ??= Promise.resolve().then(() => input.onReady?.(readyInfo));
        return readyNotification;
      };

      // Close the create/start race: if the parent settled (or cancellation
      // arrived) while metadata was being written, retain an inspectable aborted
      // child but do not admit new foreground work.
      try {
        this.assertActiveParentRun(parentSessionId, parentRun, input.spawnedBy.parentTurnId);
        if (input.abortSignal?.aborted) {
          throw new Error('Child session spawn was cancelled before its first run');
        }
      } catch (error) {
        if (creation.created) await this.updateStatus(child.id, 'aborted').catch(() => {});
        throw error;
      }

      if (!creation.created) {
        const existing = await this.resolveExistingChildSpawn(child, input, notifyReady);
        if (existing) return existing;
      }

      // A committed metadata row without its initial AgentRun is a recoverable
      // crash boundary. Revalidate admission after the lookup: the parent or
      // caller may have settled while durable state was being inspected.
      try {
        const latestParentRun = await this.deps.runStore.readRun(
          parentSessionId,
          input.spawnedBy.parentRunId,
        );
        this.assertActiveParentRun(parentSessionId, latestParentRun, input.spawnedBy.parentTurnId);
        if (input.abortSignal?.aborted) {
          throw new Error('Child session spawn was cancelled before its first run');
        }
      } catch (error) {
        await this.updateStatus(child.id, 'aborted').catch(() => {});
        throw error;
      }

      const startedAt = this.deps.now();
      const summary = new ChildAgentSummaryAccumulator();
      let aborted = false;
      let stopPromise: Promise<void> | undefined;
      const identity = { sessionId: child.id, turnId, runId };
      const execution = this.consumeLinkedRootExecution(
        {
          ...identity,
          userMessageId: this.deps.newId(),
          execution: {
            kind: 'linked_child_initial',
            agentId: snapshot.agentId,
            agentName: snapshot.agentName,
          },
          content: { text: input.prompt },
          start: ({ runId: admittedRunId, userMessageId, onRunStarted }) =>
            this.sendMessage(
              child.id,
              {
                turnId,
                text: input.prompt,
                agentId: snapshot.agentId,
                agentName: snapshot.agentName,
              },
              {
                runId: admittedRunId,
                ...(userMessageId ? { userMessageId } : {}),
                durability: 'required',
                onRunStarted,
                execution: runtimeOwner.execution,
              },
            ),
          onReady: notifyReady,
          onEvent: (event) => {
            summary.add(event);
            try {
              input.onEvent?.(event);
            } catch {
              // A presentation observer must not change the child run outcome.
            }
          },
        },
        true,
      );
      const onAbort = () => {
        aborted = true;
        stopPromise ??= this.stopLinkedRoot(identity, { source: 'stop_button' });
      };
      if (input.abortSignal) {
        input.abortSignal.addEventListener('abort', onAbort, { once: true });
        if (input.abortSignal.aborted) onAbort();
      }
      try {
        await execution;
      } finally {
        input.abortSignal?.removeEventListener('abort', onAbort);
        if (aborted) await stopPromise;
      }

      const completedAt = this.deps.now();
      const run = await this.findRunByTurnId(child.id, turnId);
      const failureClass = run?.failureClass ?? summary.failureClass;
      const artifacts = this.deps.listArtifactsForTurn
        ? await this.deps.listArtifactsForTurn(child.id, turnId)
        : [];
      return {
        childSessionId: child.id,
        agentId: snapshot.agentId,
        agentName: snapshot.agentName,
        profile: snapshot.profile,
        turnId,
        runId,
        status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
        permissionMode: child.permissionMode,
        summary: summary.text(),
        artifactIds: artifacts.map((artifact) => artifact.id),
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
        eventCount: summary.eventCount,
        ...(failureClass ? { failureClass } : {}),
      };
    } finally {
      releaseHostedExecution();
    }
  }

  private async resolveExistingChildSpawn(
    child: SessionHeader,
    input: SpawnChildSessionInput,
    notifyReady: () => Promise<void>,
  ): Promise<SpawnChildSessionResult | undefined> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return undefined;
    const snapshot = child.subagentRuntime;
    const spawn = child.subagentSpawn;
    if (!snapshot || !spawn) {
      throw new Error('Stored child session is missing its durable runtime or spawn identity');
    }
    let run = await this.deps.runStore.readRun(child.id, spawn.initialRunId).catch((error) => {
      if (isNotFoundError(error)) return undefined;
      throw error;
    });
    if (!run) return undefined;
    await notifyReady();

    while (
      !isTerminalRunStatus(run.status) &&
      this.runtimeKernel.hasActiveRun?.(child.id, run.runId, run.turnId)
    ) {
      await delay(25, undefined, input.abortSignal ? { signal: input.abortSignal } : undefined);
      run = await this.deps.runStore.readRun(child.id, spawn.initialRunId);
    }
    if (!isTerminalRunStatus(run.status)) {
      await this.recoverAgentRunsFromLedger(child.id);
      run = await this.deps.runStore.readRun(child.id, spawn.initialRunId);
    }
    return await this.projectExistingChildSpawn(child, run);
  }

  private async projectExistingChildSpawn(
    child: SessionHeader,
    run: AgentRunHeader,
  ): Promise<SpawnChildSessionResult> {
    if (!this.deps.runtimeEventStore) {
      throw new Error('Child session projection requires RuntimeEventStore');
    }
    const snapshot = child.subagentRuntime;
    if (!snapshot) throw new Error('Stored child session is missing its durable runtime snapshot');
    const [messages, runtimeEvents, artifacts] = await Promise.all([
      this.deps.store.readMessages(child.id),
      this.deps.runtimeEventStore.readRuntimeEvents(child.id, run.runId),
      this.deps.listArtifactsForTurn
        ? this.deps.listArtifactsForTurn(child.id, run.turnId)
        : Promise.resolve([]),
    ]);
    const storedSummary =
      messages
        .filter(
          (message): message is Extract<StoredMessage, { type: 'assistant' }> =>
            message.type === 'assistant' && message.turnId === run.turnId,
        )
        .at(-1)?.text ?? '';
    const runtimeText = runtimeEvents.filter(
      (
        event,
      ): event is RuntimeEvent & {
        content: Extract<NonNullable<RuntimeEvent['content']>, { kind: 'text' }>;
      } => event.role === 'model' && event.content?.kind === 'text',
    );
    const durableRuntimeSummary = runtimeText.filter((event) => !event.partial).at(-1)
      ?.content.text;
    const partialRuntimeSummary = runtimeText
      .filter((event) => event.partial)
      .map((event) => event.content.text)
      .join('');
    const completedAt = run.completedAt ?? run.updatedAt;
    return {
      childSessionId: child.id,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      profile: snapshot.profile,
      turnId: run.turnId,
      runId: run.runId,
      status: agentRunStatusForSpawnResult(run.status),
      permissionMode: child.permissionMode,
      summary: trimSummary(durableRuntimeSummary ?? (storedSummary || partialRuntimeSummary)),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt: run.createdAt,
      completedAt,
      durationMs: Math.max(0, completedAt - run.createdAt),
      eventCount: runtimeEvents.length,
      ...(run.failureClass ? { failureClass: run.failureClass } : {}),
    };
  }

  async prepareChildAgentResume(
    sessionId: string,
    sourceRunId: string,
  ): Promise<PrepareChildAgentResumeResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child AgentRun resume requires AgentRunStore and RuntimeEventStore');
    }
    const execution = await this.resolveChildAgentExecution(sessionId, sourceRunId);
    return await this.prepareChildAgentResumeForExecution(sessionId, execution, sourceRunId);
  }

  private async prepareChildAgentResumeForExecution(
    sessionId: string,
    execution: SubagentExecutionRef,
    sourceRunId: string,
  ): Promise<PrepareChildAgentResumeResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child AgentRun resume requires AgentRunStore and RuntimeEventStore');
    }
    if (execution.kind === 'child_session') {
      return await this.prepareLinkedChildSessionResume(sessionId, execution, sourceRunId);
    }
    const runs = await this.deps.runStore.listSessionRuns(sessionId);
    const runsById = new Map(runs.map((run) => [run.runId, run]));
    const source = runsById.get(sourceRunId);
    if (!source || !source.parentRunId || isSessionInlineRun(source)) {
      throw new Error(`Child AgentRun resume source ${sourceRunId} was not found`);
    }
    const definition = source.agentId ? getBuiltinAgentDefinition(source.agentId) : undefined;
    if (!definition) {
      throw new Error(`AgentRun ${sourceRunId} is not a resumable built-in child agent`);
    }

    const sessionHeader = await this.deps.store.readHeader(sessionId);
    assertAgentDefinitionRunnable({
      parentPermissionMode: sessionHeader.permissionMode,
      definition,
      tools: this.deps.childTools ?? [],
    });
    const visited = new Set<string>();
    let cursor: AgentRunHeader | undefined = source;
    while (cursor) {
      if (visited.has(cursor.runId)) {
        throw new Error(`Child AgentRun resume lineage contains a cycle at ${cursor.runId}`);
      }
      visited.add(cursor.runId);
      if (!cursor.parentRunId || isSessionInlineRun(cursor) || cursor.agentId !== definition.id) {
        throw new Error(`Child AgentRun resume profile changed at ${cursor.runId}`);
      }
      if (
        cursor.backendKind !== sessionHeader.backend ||
        cursor.llmConnectionSlug !== sessionHeader.llmConnectionSlug ||
        cursor.modelId !== sessionHeader.model ||
        cursor.cwd !== sessionHeader.cwd ||
        cursor.permissionMode !== definition.permissionMode
      ) {
        throw new Error(`Child AgentRun resume environment changed for ${cursor.runId}`);
      }

      const events = await this.deps.runtimeEventStore
        .readRuntimeEvents(sessionId, cursor.runId)
        .catch(() => []);
      const replay = buildRuntimeEventModelReplayPlan(events);
      const unsafe = replay.diagnostics.find((diagnostic) =>
        isUnsafeChildResumeDiagnostic(diagnostic.code),
      );
      if (unsafe) {
        throw new Error(`Child AgentRun resume history is unsafe: ${unsafe.code}`);
      }
      const first = replay.items[0];
      if (!first || first.kind !== 'text' || first.role !== 'user') {
        throw new Error(
          `Child AgentRun resume source ${cursor.runId} has no user-anchored history`,
        );
      }
      const terminal = classifyTerminalRuntimeLedger(cursor, events);
      if (terminal.kind !== 'fact') {
        throw new Error(`Child AgentRun resume source ${cursor.runId} is not durably terminal`);
      }
      const effective = effectiveRunHeaderFromTerminalFact(cursor, terminal.fact);
      if (!['completed', 'failed', 'cancelled'].includes(effective.status)) {
        throw new Error(`Child AgentRun resume source ${cursor.runId} is not in a resumable state`);
      }

      const previousRunId = cursor.resumedFromRunId ?? cursor.retriedFromRunId;
      if (!previousRunId) break;
      cursor = runsById.get(previousRunId);
      if (!cursor) {
        throw new Error(`Child AgentRun resume source ${previousRunId} was not found`);
      }
    }

    this.assertChildRunHasNoSuccessor(runs, sourceRunId);
    return {
      sourceRunId,
      execution,
      agentId: definition.id,
      agentName: definition.name,
      profile: definition.profile,
    };
  }

  private async resolveChildAgentExecution(
    parentSessionId: string,
    sourceRunId: string,
  ): Promise<SubagentExecutionRef> {
    if (!this.deps.runStore) {
      throw new Error('Child AgentRun lookup requires AgentRunStore');
    }
    const legacy = await this.deps.runStore.readRun(parentSessionId, sourceRunId).catch((error) => {
      if (isNotFoundError(error)) return undefined;
      throw error;
    });
    if (legacy?.parentRunId && !isSessionInlineRun(legacy)) {
      return {
        kind: 'legacy_child_run',
        sessionId: parentSessionId,
        runId: sourceRunId,
      };
    }

    const children = await this.listChildSessions(parentSessionId);
    const matches = (
      await Promise.all(
        children.map(async (child) => {
          const run = await this.deps.runStore!.readRun(child.id, sourceRunId).catch((error) => {
            if (isNotFoundError(error)) return undefined;
            throw error;
          });
          return run && isSessionInlineRun(run) ? child.id : undefined;
        }),
      )
    ).filter((childSessionId): childSessionId is string => childSessionId !== undefined);
    if (matches.length !== 1) {
      throw new Error(`Child AgentRun resume source ${sourceRunId} was not found`);
    }
    return {
      kind: 'child_session',
      sessionId: matches[0]!,
      currentRunId: sourceRunId,
    };
  }

  private async prepareLinkedChildSessionResume(
    parentSessionId: string,
    execution: Extract<SubagentExecutionRef, { kind: 'child_session' }>,
    sourceRunId: string,
  ): Promise<PrepareChildAgentResumeResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child Session resume requires AgentRunStore and RuntimeEventStore');
    }
    const child = await this.deps.store.readHeader(execution.sessionId);
    const snapshot = child.subagentRuntime;
    if (
      child.subagentParent?.kind !== 'subagent' ||
      child.subagentParent.parentSessionId !== parentSessionId ||
      !snapshot
    ) {
      throw new Error(`Child AgentRun resume source ${sourceRunId} was not found`);
    }
    if (!isPermissionModeWithinCeiling(child.permissionMode, snapshot.permissionCeiling)) {
      throw new Error('Child Session permission mode exceeds its durable runtime ceiling');
    }
    const runnableTools = buildToolsForAgentDefinition(this.deps.childTools ?? [], {
      id: snapshot.agentId,
      permissionMode: child.permissionMode,
      tools: snapshot.toolNames,
      categoryPolicy: snapshot.categoryPolicy,
    });
    if (runnableTools.length !== snapshot.toolNames.length) {
      throw new Error('Child Session durable runtime tool snapshot is unavailable');
    }

    const runs = await this.deps.runStore.listSessionRuns(child.id);
    const runsById = new Map(runs.map((run) => [run.runId, run]));
    const source = runsById.get(sourceRunId);
    if (!source || !isSessionInlineRun(source)) {
      throw new Error(`Child AgentRun resume source ${sourceRunId} was not found`);
    }
    const visited = new Set<string>();
    const replaySegments: RuntimeEvent[][] = [];
    let cursor: AgentRunHeader | undefined = source;
    while (cursor) {
      if (visited.has(cursor.runId)) {
        throw new Error(`Child AgentRun resume lineage contains a cycle at ${cursor.runId}`);
      }
      visited.add(cursor.runId);
      if (!isSessionInlineRun(cursor) || cursor.agentId !== snapshot.agentId) {
        throw new Error(`Child AgentRun resume profile changed at ${cursor.runId}`);
      }
      if (
        cursor.backendKind !== child.backend ||
        cursor.llmConnectionSlug !== child.llmConnectionSlug ||
        cursor.modelId !== child.model ||
        cursor.cwd !== child.cwd ||
        cursor.permissionMode !== child.permissionMode
      ) {
        throw new Error(`Child AgentRun resume environment changed for ${cursor.runId}`);
      }

      const events = await this.deps.runtimeEventStore
        .readRuntimeEvents(child.id, cursor.runId)
        .catch(() => []);
      const replay = buildRuntimeEventModelReplayPlan(events);
      const unsafe = replay.diagnostics.find((diagnostic) =>
        isUnsafeChildResumeDiagnostic(diagnostic.code),
      );
      if (unsafe) {
        throw new Error(`Child AgentRun resume history is unsafe: ${unsafe.code}`);
      }
      replaySegments.unshift(events);
      const terminal = classifyTerminalRuntimeLedger(cursor, events);
      if (terminal.kind !== 'fact') {
        throw new Error(`Child AgentRun resume source ${cursor.runId} is not durably terminal`);
      }
      const effective = effectiveRunHeaderFromTerminalFact(cursor, terminal.fact);
      if (!['completed', 'failed', 'cancelled'].includes(effective.status)) {
        throw new Error(`Child AgentRun resume source ${cursor.runId} is not in a resumable state`);
      }

      const previousRunId = cursor.resumedFromRunId ?? cursor.retriedFromRunId;
      if (!previousRunId) break;
      cursor = runsById.get(previousRunId);
      if (!cursor) {
        throw new Error(`Child AgentRun resume source ${previousRunId} was not found`);
      }
    }

    const replay = buildRuntimeEventModelReplayPlan(replaySegments.flat());
    const first = replay.items[0];
    if (!first || first.kind !== 'text' || first.role !== 'user') {
      throw new Error(`Child AgentRun resume source ${sourceRunId} has no user-anchored history`);
    }
    this.assertChildRunHasNoSuccessor(runs, sourceRunId);
    return {
      sourceRunId,
      execution,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      profile: snapshot.profile,
    };
  }

  async resumeChildAgent(
    sessionId: string,
    input: ResumeChildAgentInput,
  ): Promise<SpawnChildAgentResult> {
    let runtimeExecution = this.runtimeKernel.claimExecution(sessionId);
    try {
      throwIfChildExecutionAborted(
        input.abortSignal,
        'Child agent resume was cancelled before start',
      );
      const execution = await this.resolveChildAgentExecution(sessionId, input.sourceRunId);
      if (execution.kind === 'child_session') {
        runtimeExecution = this.transferRuntimeExecution(runtimeExecution, execution.sessionId);
        const releaseHostedExecution = this.acquireHostedLinkedChildExecution(execution.sessionId);
        try {
          const prepared = await this.prepareChildAgentResumeForExecution(
            sessionId,
            execution,
            input.sourceRunId,
          );
          return await this.resumeLinkedChildSession(
            sessionId,
            execution,
            prepared,
            input,
            runtimeExecution,
            true,
          );
        } finally {
          releaseHostedExecution();
        }
      }
      const prepared = await this.prepareChildAgentResumeForExecution(
        sessionId,
        execution,
        input.sourceRunId,
      );
      const definition = getBuiltinAgentDefinition(prepared.agentId)!;
      return await this.runChildAgent(
        sessionId,
        definition,
        input,
        runtimeExecution,
        input.sourceRunId,
      );
    } finally {
      runtimeExecution.release();
    }
  }

  private transferRuntimeExecution(
    source: RuntimeExecutionClaim,
    targetSessionId: string,
  ): RuntimeExecutionClaim {
    if (source.sessionId === targetSessionId) return source;
    let target: RuntimeExecutionClaim;
    try {
      target = this.runtimeKernel.claimExecution(targetSessionId);
    } catch (error) {
      source.release();
      throw error;
    }
    return this.handoffRuntimeExecution(source, target);
  }

  private handoffRuntimeExecution(
    source: RuntimeExecutionClaim,
    target: RuntimeExecutionClaim,
  ): RuntimeExecutionClaim {
    if (source.sessionId === target.sessionId) {
      target.release();
      return source;
    }
    const stopped = source.isStopRequested();
    source.release();
    if (stopped) {
      target.release();
      throw new Error(
        `Session ${source.sessionId} stopped before child execution ownership transferred`,
      );
    }
    return target;
  }

  private async resumeLinkedChildSession(
    parentSessionId: string,
    execution: Extract<SubagentExecutionRef, { kind: 'child_session' }>,
    prepared: PrepareChildAgentResumeResult,
    input: ResumeChildAgentInput,
    runtimeExecution: RuntimeExecutionClaim,
    hostedGateAlreadyHeld: boolean,
  ): Promise<SpawnChildAgentResult> {
    throwIfChildExecutionAborted(
      input.abortSignal,
      'Child agent resume was cancelled before start',
    );
    if (!this.deps.runStore) {
      throw new Error('Child Session resume requires AgentRunStore');
    }
    const [parentRun, child] = await Promise.all([
      this.deps.runStore.readRun(parentSessionId, input.parentRunId),
      this.deps.store.readHeader(execution.sessionId),
    ]);
    this.assertActiveParentRun(parentSessionId, parentRun, parentRun.turnId);
    if (
      child.subagentParent?.kind !== 'subagent' ||
      child.subagentParent.parentSessionId !== parentSessionId ||
      child.subagentRuntime?.agentId !== prepared.agentId
    ) {
      throw new Error(`Child AgentRun resume source ${input.sourceRunId} was not found`);
    }

    const turnId = input.turnId ?? this.deps.newId();
    const runId = this.deps.newId();
    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = input.abortSignal?.aborted === true;
    let stopPromise: Promise<void> | undefined;
    const identity = { sessionId: child.id, turnId, runId };
    throwIfChildExecutionAborted(
      input.abortSignal,
      'Child agent resume was cancelled before start',
    );
    const executionPromise = this.consumeLinkedRootExecution(
      {
        ...identity,
        userMessageId: this.deps.newId(),
        execution: {
          kind: 'linked_child_resume',
          agentId: prepared.agentId,
          agentName: prepared.agentName,
          sourceRunId: input.sourceRunId,
        },
        content: { text: input.prompt },
        start: ({ runId: admittedRunId, userMessageId, onRunStarted }) =>
          this.sendMessage(
            child.id,
            {
              turnId,
              text: input.prompt,
              resumedFromRunId: input.sourceRunId,
              agentId: prepared.agentId,
              agentName: prepared.agentName,
            },
            {
              runId: admittedRunId,
              ...(userMessageId ? { userMessageId } : {}),
              durability: 'required',
              onRunStarted,
              execution: runtimeExecution,
            },
          ),
        onReady: () =>
          input.onReady?.({
            childSessionId: child.id,
            turnId,
            runId,
            agentId: prepared.agentId,
            agentName: prepared.agentName,
          }),
        onEvent: (event) => {
          summary.add(event);
          try {
            input.onEvent?.(event);
          } catch {
            // A presentation observer must not change the child run outcome.
          }
        },
      },
      hostedGateAlreadyHeld,
    );
    const onAbort = () => {
      aborted = true;
      stopPromise ??= this.stopLinkedRoot(identity, { source: 'stop_button' });
    };
    if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (input.abortSignal.aborted) onAbort();
    }
    try {
      await executionPromise;
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await stopPromise;
    }

    const completedAt = this.deps.now();
    const run = await this.findRunByTurnId(child.id, turnId);
    const failureClass = run?.failureClass ?? summary.failureClass;
    const artifacts = this.deps.listArtifactsForTurn
      ? await this.deps.listArtifactsForTurn(child.id, turnId)
      : [];
    return {
      childSessionId: child.id,
      agentId: prepared.agentId,
      agentName: prepared.agentName,
      turnId,
      runId,
      resumedFromRunId: input.sourceRunId,
      status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
      permissionMode: child.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
    };
  }

  private async runChildAgent(
    sessionId: string,
    definition: AgentDefinition,
    input: SpawnChildAgentInput | ResumeChildAgentInput,
    execution: RuntimeExecutionClaim,
    resumedFromRunId?: string,
  ): Promise<SpawnChildAgentResult> {
    throwIfChildExecutionAborted(
      input.abortSignal,
      'Child agent execution was cancelled before start',
    );
    const turnId = input.turnId ?? this.deps.newId();
    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = input.abortSignal?.aborted === true;
    await input.onReady?.({ turnId, agentId: definition.id, agentName: definition.name });
    const iterator = this.runtimeKernel
      .startChildTurn(
        sessionId,
        {
          turnId,
          parentRunId: input.parentRunId,
          spec: {
            id: definition.id,
            name: definition.name,
            systemPrompt: definition.systemPrompt,
          },
          prompt: input.prompt,
          ...(resumedFromRunId ? { resumedFromRunId } : {}),
        },
        execution,
      )
      [Symbol.asyncIterator]();
    const onAbort = () => {
      aborted = true;
      void iterator.return?.();
    };
    if (input.abortSignal && !input.abortSignal.aborted) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      while (!aborted) {
        const next = await iterator.next();
        if (next.done) break;
        summary.add(next.value);
        try {
          input.onEvent?.(next.value);
        } catch {
          // A presentation observer must not change the child run outcome.
        }
      }
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await iterator.return?.();
    }

    const completedAt = this.deps.now();
    const run = await this.findRunByTurnId(sessionId, turnId);
    const failureClass = run?.failureClass ?? summary.failureClass;
    const artifacts = this.deps.listArtifactsForTurn
      ? await this.deps.listArtifactsForTurn(sessionId, turnId)
      : [];
    return {
      agentId: definition.id,
      agentName: definition.name,
      turnId,
      ...(run?.runId ? { runId: run.runId } : {}),
      status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
      permissionMode: definition.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
      ...(resumedFromRunId ? { resumedFromRunId } : {}),
    };
  }

  async retryChildAgent(
    sessionId: string,
    input: RetryChildAgentInput,
  ): Promise<SpawnChildAgentResult> {
    let runtimeExecution = this.runtimeKernel.claimExecution(sessionId);
    let hintedTargetExecution: RuntimeExecutionClaim | undefined;
    try {
      if (input.execution?.kind === 'child_session') {
        hintedTargetExecution = this.runtimeKernel.claimExecution(input.execution.sessionId);
      }
      throwIfChildExecutionAborted(
        input.abortSignal,
        'Child agent retry was cancelled before start',
      );
      if (!this.deps.runStore || !this.deps.runtimeEventStore) {
        throw new Error('Child agent retry requires AgentRunStore and RuntimeEventStore');
      }
      const execution = await this.resolveChildAgentExecution(sessionId, input.sourceRunId);
      this.assertChildRetryExecutionIdentity(input, execution);
      if (execution.kind === 'child_session') {
        if (hintedTargetExecution) {
          runtimeExecution = this.handoffRuntimeExecution(runtimeExecution, hintedTargetExecution);
          hintedTargetExecution = undefined;
        } else {
          runtimeExecution = this.transferRuntimeExecution(runtimeExecution, execution.sessionId);
        }
      }
      const releaseHostedExecution =
        execution.kind === 'child_session'
          ? this.acquireHostedLinkedChildExecution(execution.sessionId)
          : () => {};
      try {
        return await this.retryChildAgentWithExecution(
          sessionId,
          input,
          execution,
          runtimeExecution,
        );
      } finally {
        releaseHostedExecution();
      }
    } finally {
      hintedTargetExecution?.release();
      runtimeExecution.release();
    }
  }

  private assertChildRetryExecutionIdentity(
    input: RetryChildAgentInput,
    execution: SubagentExecutionRef,
  ): void {
    if (
      input.execution &&
      (input.execution.kind !== execution.kind ||
        input.execution.sessionId !== execution.sessionId ||
        (input.execution.kind === 'legacy_child_run' &&
          (execution.kind !== 'legacy_child_run' || input.execution.runId !== execution.runId)) ||
        (input.execution.kind === 'child_session' &&
          input.execution.currentRunId !== undefined &&
          input.execution.currentRunId !== input.sourceRunId))
    ) {
      throw new Error('Child agent retry execution identity changed');
    }
  }

  private async retryChildAgentWithExecution(
    sessionId: string,
    input: RetryChildAgentInput,
    execution: SubagentExecutionRef,
    runtimeExecution: RuntimeExecutionClaim,
  ): Promise<SpawnChildAgentResult> {
    throwIfChildExecutionAborted(input.abortSignal, 'Child agent retry was cancelled before start');
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child agent retry requires AgentRunStore and RuntimeEventStore');
    }
    const targetSessionId = execution.sessionId;
    const runs = await this.deps.runStore.listSessionRuns(targetSessionId);
    const rawSourceRun = runs.find((run) => run.runId === input.sourceRunId);
    if (!rawSourceRun) throw new Error('Child agent retry source run was not found');
    const sourceRun = await this.effectiveRunHeaderFromRuntimeLedger(rawSourceRun);
    let definition: {
      id: string;
      name: string;
      systemPrompt: string;
      permissionMode: PermissionMode;
    };
    if (execution.kind === 'child_session') {
      const [parentRun, child] = await Promise.all([
        this.deps.runStore.readRun(sessionId, input.parentRunId),
        this.deps.store.readHeader(targetSessionId),
      ]);
      this.assertActiveParentRun(sessionId, parentRun, parentRun.turnId);
      const snapshot = child.subagentRuntime;
      if (
        child.subagentParent?.kind !== 'subagent' ||
        child.subagentParent.parentSessionId !== sessionId ||
        !snapshot ||
        !isSessionInlineRun(sourceRun) ||
        sourceRun.agentId !== snapshot.agentId
      ) {
        throw new Error('Child agent retry source does not belong to the parent Session');
      }
      definition = {
        id: snapshot.agentId,
        name: snapshot.agentName,
        systemPrompt: snapshot.systemPrompt,
        permissionMode: child.permissionMode,
      };
    } else {
      if (!sourceRun.parentRunId || sourceRun.parentRunId !== input.parentRunId) {
        throw new Error('Child agent retry source does not belong to the active parent run');
      }
      if (!sourceRun.agentId) throw new Error('Child agent retry source is missing its agent id');
      definition = requireResolvedAgentDefinition(sourceRun.agentId);
    }
    if (sourceRun.status !== 'failed' || sourceRun.failureClass !== 'RateLimit') {
      throw new Error('Child agent retry source must be a provider rate-limit failure');
    }
    this.assertChildRunHasNoSuccessor(runs, sourceRun.runId);

    const replaySegments: RuntimeEvent[][] = [];
    let chainRun: AgentRunHeader | undefined = rawSourceRun;
    const visited = new Set<string>();
    while (chainRun) {
      if (visited.has(chainRun.runId))
        throw new Error('Child agent retry lineage contains a cycle');
      visited.add(chainRun.runId);
      const events = await this.deps.runtimeEventStore.readRuntimeEvents(
        targetSessionId,
        chainRun.runId,
      );
      const plan = buildResumePlanFromRuntimeEvents(events);
      if (plan.disposition !== 'safe_replay') {
        throw new Error(`Child agent retry source is not safely replayable: ${chainRun.runId}`);
      }
      replaySegments.unshift(plan.replayRuntimeEvents);
      const previousRunId: string | undefined =
        chainRun.retriedFromRunId ?? chainRun.resumedFromRunId;
      if (!previousRunId) break;
      chainRun = runs.find((run) => run.runId === previousRunId);
      if (!chainRun) throw new Error('Child agent retry lineage source is missing');
    }

    const sourceEvents = await this.deps.runtimeEventStore.readRuntimeEvents(
      targetSessionId,
      sourceRun.runId,
    );
    const sourcePlan = buildResumePlanFromRuntimeEvents(sourceEvents);
    if (sourcePlan.disposition !== 'safe_replay') {
      throw new Error('Child agent retry source is not safely replayable');
    }
    const sourceInvocationId = sourceRun.invocationId ?? sourceEvents[0]?.invocationId;
    if (!sourceInvocationId) throw new Error('Child agent retry source has no invocation id');
    const retryReplay = buildRuntimeEventModelReplayPlan(replaySegments.flat());
    const retryAnchor = retryReplay.items[0];
    if (!retryAnchor || retryAnchor.kind !== 'text' || retryAnchor.role !== 'user') {
      throw new Error('Child agent retry source has no user-anchored history');
    }
    const turnId = this.deps.newId();
    const runId = this.deps.newId();
    const invocationId = this.deps.newId();
    const continuation: RuntimeContinuation = {
      sessionId: targetSessionId,
      invocationId,
      runId,
      turnId,
      sourceInvocationId,
      sourceRunId: sourceRun.runId,
      sourceTurnId: sourceRun.turnId,
      sourceRuntimeEventHighWater: sourceEvents.length,
      sourceRuntimeContext: sourcePlan.replayRuntimeEvents,
      runtimeContext: replaySegments.flat(),
      safetySnapshot: {
        workspaceIdentity: sourceRun.workspaceIdentity ?? sourceRun.cwd,
        backgroundOperationsSettled: true,
        availableToolNames: [],
      },
    };

    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = input.abortSignal?.aborted === true;
    const startChildRetry = this.runtimeKernel.startChildRetry;
    if (!startChildRetry) throw new Error('RuntimeKernel does not support child agent retry');
    const linkedIdentity = { sessionId: targetSessionId, turnId, runId };
    const emitReady = () =>
      input.onReady?.({
        ...(execution.kind === 'child_session'
          ? { childSessionId: execution.sessionId, runId }
          : {}),
        turnId,
        agentId: definition.id,
        agentName: definition.name,
      });
    const consumeEvent = (event: SessionEvent) => {
      summary.add(event);
      try {
        input.onEvent?.(event);
      } catch {
        // A presentation observer must not change the child run outcome.
      }
    };
    throwIfChildExecutionAborted(input.abortSignal, 'Child agent retry was cancelled before start');
    const executionPromise =
      execution.kind === 'child_session'
        ? this.consumeLinkedRootExecution(
            {
              ...linkedIdentity,
              userMessageId: null,
              execution: {
                kind: 'linked_child_provider_retry',
                agentId: definition.id,
                agentName: definition.name,
                sourceRunId: sourceRun.runId,
              },
              content: {
                text: retryAnchor.content,
                ...(retryAnchor.attachments ? { attachments: retryAnchor.attachments } : {}),
              },
              start: ({ onRunStarted }) =>
                startChildRetry.call(
                  this.runtimeKernel,
                  targetSessionId,
                  {
                    parentRunId: input.parentRunId,
                    spec: {
                      id: definition.id,
                      name: definition.name,
                      systemPrompt: definition.systemPrompt,
                    },
                    continuation,
                    linkedSession: true,
                    onRunStarted,
                  },
                  runtimeExecution,
                ),
              onReady: emitReady,
              onEvent: consumeEvent,
            },
            true,
          )
        : this.consumeRuntimeEvents(
            startChildRetry.call(
              this.runtimeKernel,
              targetSessionId,
              {
                parentRunId: input.parentRunId,
                spec: {
                  id: definition.id,
                  name: definition.name,
                  systemPrompt: definition.systemPrompt,
                },
                continuation,
              },
              runtimeExecution,
            ),
            emitReady,
            consumeEvent,
          );
    let stopPromise: Promise<void> | undefined;
    const onAbort = () => {
      aborted = true;
      if (execution.kind === 'child_session') {
        stopPromise ??= this.stopLinkedRoot(linkedIdentity, { source: 'stop_button' });
      } else {
        stopPromise ??= this.runtimeKernel.stopSession(targetSessionId, {
          source: 'stop_button',
        });
      }
    };
    if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (input.abortSignal.aborted) onAbort();
    }
    try {
      await executionPromise;
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await stopPromise;
    }

    const completedAt = this.deps.now();
    const run = await this.findRunByTurnId(targetSessionId, turnId);
    const failureClass = run?.failureClass ?? summary.failureClass;
    const artifacts = this.deps.listArtifactsForTurn
      ? await this.deps.listArtifactsForTurn(targetSessionId, turnId)
      : [];
    return {
      ...(execution.kind === 'child_session' ? { childSessionId: execution.sessionId } : {}),
      agentId: definition.id,
      agentName: definition.name,
      turnId,
      ...(run?.runId ? { runId: run.runId } : { runId }),
      retriedFromRunId: sourceRun.runId,
      status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
      permissionMode: definition.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
    };
  }

  private assertChildRunHasNoSuccessor(runs: readonly AgentRunHeader[], sourceRunId: string): void {
    if (
      runs.some(
        (run) => run.resumedFromRunId === sourceRunId || run.retriedFromRunId === sourceRunId,
      )
    ) {
      throw new Error(`Child AgentRun ${sourceRunId} already has a successor`);
    }
  }

  async listChildAgents(sessionId: string): Promise<AgentListResult> {
    const header = await this.deps.store.readHeader(sessionId);
    const definitions = listBuiltinAgentDefinitions({
      parentPermissionMode: header.permissionMode,
      tools: this.deps.childTools ?? [],
    });
    if (!this.deps.runStore) return { definitions, executions: [], runs: [] };
    const runs = await this.deps.runStore.listSessionRuns(sessionId);
    const childRuns = await Promise.all(
      runs
        .filter(
          (run): run is AgentRunHeader & { parentRunId: string } =>
            !!run.parentRunId && !isSessionInlineRun(run),
        )
        .map(
          async (run): Promise<AgentRunHeader & { parentRunId: string }> => ({
            ...(await this.effectiveRunHeaderFromRuntimeLedger(run)),
            parentRunId: run.parentRunId,
          }),
        ),
    );
    const legacyRuns = childRuns.map((run) => ({
      runId: run.runId,
      turnId: run.turnId,
      parentRunId: run.parentRunId,
      ...(run.agentId ? { agentId: run.agentId } : {}),
      ...(run.agentName ? { agentName: run.agentName } : {}),
      status: run.status,
      permissionMode: run.permissionMode,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      ...(run.completedAt !== undefined
        ? { durationMs: Math.max(0, run.completedAt - run.createdAt) }
        : {}),
      ...(run.failureClass ? { failureClass: run.failureClass } : {}),
    }));
    const childSessionHeaders = await Promise.all(
      (await this.listChildSessions(sessionId)).map((child) =>
        this.deps.store.readHeader(child.id),
      ),
    );
    const childSessionExecutions = await Promise.all(
      childSessionHeaders.map(async (child): Promise<SubagentExecutionListItem> => {
        const childRuns = await this.deps.runStore!.listSessionRuns(child.id);
        const latest = childRuns
          .slice()
          .sort(
            (left, right) =>
              right.createdAt - left.createdAt ||
              right.updatedAt - left.updatedAt ||
              right.runId.localeCompare(left.runId),
          )[0];
        const run = latest ? await this.effectiveRunHeaderFromRuntimeLedger(latest) : undefined;
        const currentRunId = run?.runId ?? child.subagentSpawn?.initialRunId;
        return {
          execution: {
            kind: 'child_session',
            sessionId: child.id,
            ...(currentRunId ? { currentRunId } : {}),
          },
          ...(child.subagentRuntime?.agentId ? { agentId: child.subagentRuntime.agentId } : {}),
          ...(child.subagentRuntime?.agentName
            ? { agentName: child.subagentRuntime.agentName }
            : {}),
          ...(child.subagentRuntime?.profile ? { profile: child.subagentRuntime.profile } : {}),
          ...(run?.turnId ? { turnId: run.turnId } : {}),
          status: run?.status ?? (child.status === 'aborted' ? 'cancelled' : 'created'),
          permissionMode: run?.permissionMode ?? child.permissionMode,
          createdAt: run?.createdAt ?? child.createdAt,
          updatedAt: run?.updatedAt ?? child.lastUsedAt,
          ...(run?.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
          ...(run?.completedAt !== undefined
            ? { durationMs: Math.max(0, run.completedAt - run.createdAt) }
            : {}),
          ...(run?.failureClass ? { failureClass: run.failureClass } : {}),
        };
      }),
    );
    return {
      definitions,
      executions: [
        ...childSessionExecutions,
        ...childRuns.map(
          (run): SubagentExecutionListItem => ({
            execution: {
              kind: 'legacy_child_run',
              sessionId,
              runId: run.runId,
            },
            ...(run.agentId ? { agentId: run.agentId } : {}),
            ...(run.agentName ? { agentName: run.agentName } : {}),
            turnId: run.turnId,
            status: run.status,
            permissionMode: run.permissionMode,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
            ...(run.completedAt !== undefined
              ? { durationMs: Math.max(0, run.completedAt - run.createdAt) }
              : {}),
            ...(run.failureClass ? { failureClass: run.failureClass } : {}),
          }),
        ),
      ],
      runs: legacyRuns,
    };
  }

  async readChildAgentOutput(
    sessionId: string,
    input: AgentOutputInput,
  ): Promise<AgentOutputResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('agent_output requires AgentRunStore and RuntimeEventStore');
    }
    const located = await this.findChildRunForOutput(sessionId, input);
    const { header } = located;
    const inspected = await inspectAgentRunReadModel(
      this.deps.runStore,
      this.deps.runtimeEventStore,
      {
        sessionId: header.sessionId,
        runId: header.runId,
        header,
      },
    );
    const artifacts = this.deps.listArtifactsForTurn
      ? await this.deps.listArtifactsForTurn(header.sessionId, header.turnId)
      : [];
    const maxEvents = normalizeAgentOutputMaxEvents(input.maxEvents);
    return {
      execution: located.execution,
      header: inspected.header,
      events: tail(inspected.events, maxEvents),
      runtimeEvents: tail(inspected.runtimeEvents, maxEvents),
      sourceHealth: inspected.sourceHealth,
      diagnostics: tail(inspected.diagnostics, maxEvents),
      artifacts,
      truncated: {
        events: inspected.events.length > maxEvents,
        runtimeEvents: inspected.runtimeEvents.length > maxEvents,
        diagnostics: inspected.diagnostics.length > maxEvents,
      },
    };
  }

  async stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    const hostedAuthority = isRuntimeHostedRootAuthority(this.deps.messageAuthority)
      ? this.deps.messageAuthority
      : undefined;
    const ownStop = hostedAuthority
      ? hostedAuthority.stopSession(sessionId, input)
      : this.runtimeKernel.stopSession(sessionId, input);
    let childStops: PromiseSettledResult<void>[] = [];
    let childLookupError: unknown;
    try {
      const children = await this.listChildSessions(sessionId);
      childStops = await Promise.allSettled(
        children
          .filter((child) => child.subagentParent?.lifecycle === 'foreground')
          .map((child) =>
            hostedAuthority
              ? hostedAuthority.stopSession(child.id, input)
              : this.runtimeKernel.stopSession(child.id, input),
          ),
      );
    } catch (error) {
      childLookupError = error;
    }
    await ownStop;
    const childStopError = childStops.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )?.reason;
    if (childLookupError !== undefined) throw childLookupError;
    if (childStopError !== undefined) throw childStopError;
  }

  async deliverHostedRootStop(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    const ownStop = this.runtimeKernel.stopSession(sessionId, input);
    const authority = isRuntimeHostedRootAuthority(this.deps.messageAuthority)
      ? this.deps.messageAuthority
      : undefined;
    let childStops: PromiseSettledResult<void>[] = [];
    let childLookupError: unknown;
    try {
      const children = await this.listChildSessions(sessionId);
      childStops = await Promise.allSettled(
        children
          .filter((child) => child.subagentParent?.lifecycle === 'foreground')
          .map((child) =>
            authority
              ? authority.stopSession(child.id, input)
              : this.runtimeKernel.stopSession(child.id, input),
          ),
      );
    } catch (error) {
      childLookupError = error;
    }
    await ownStop;
    const childStopError = childStops.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )?.reason;
    if (childLookupError !== undefined) throw childLookupError;
    if (childStopError !== undefined) throw childStopError;
  }

  async closePendingHostedLinkedChildAdmission(input: {
    sessionId: string;
    turnId: string;
    runId: string;
    admittedAt: number;
    execution: Exclude<RootExecutionDescriptor, { kind: 'external_message' }>;
  }): Promise<void> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Linked child admission recovery requires execution stores');
    }
    const session = await this.deps.store.readHeader(input.sessionId);
    if (
      session.subagentParent?.kind !== 'subagent' ||
      session.subagentRuntime?.agentId !== input.execution.agentId ||
      session.subagentRuntime.agentName !== input.execution.agentName
    ) {
      throw new Error(
        `Admitted Turn ${input.turnId} does not match its linked child Session identity`,
      );
    }

    let workspaceIdentity: string | undefined;
    if (input.execution.kind !== 'linked_child_initial') {
      const sourceRun = await this.deps.runStore.readRun(
        input.sessionId,
        input.execution.sourceRunId,
      );
      if (
        sourceRun.agentId !== input.execution.agentId ||
        sourceRun.agentName !== input.execution.agentName
      ) {
        throw new Error(`Admitted Turn ${input.turnId} source changed its trusted agent identity`);
      }
      workspaceIdentity = sourceRun.workspaceIdentity;
    }

    const run: AgentRunHeader = {
      runId: input.runId,
      invocationId: input.runId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      status: 'created',
      backendKind: session.backend,
      llmConnectionSlug: session.llmConnectionSlug,
      modelId: session.model,
      cwd: session.cwd,
      ...(workspaceIdentity !== undefined ? { workspaceIdentity } : {}),
      permissionMode: session.permissionMode,
      collaborationMode: session.collaborationMode ?? 'agent',
      createdAt: input.admittedAt,
      updatedAt: input.admittedAt,
      ...(input.execution.kind === 'linked_child_resume'
        ? { resumedFromRunId: input.execution.sourceRunId }
        : {}),
      ...(input.execution.kind === 'linked_child_provider_retry'
        ? { retriedFromRunId: input.execution.sourceRunId }
        : {}),
      agentId: input.execution.agentId,
      agentName: input.execution.agentName,
    };
    await this.deps.runStore.createRun(run, { durable: true });

    const ts = this.deps.now();
    const recoveryReason = 'child_internal_admission_without_run';
    const terminalEvent = buildRecoveredTerminalRuntimeEvent({
      id: this.deps.newId(),
      run,
      status: 'failed',
      ts,
      failureClass: 'app_restarted',
      recoveryReason,
      diagnostic: {
        executionKind: input.execution.kind,
        ...(input.execution.kind === 'linked_child_initial'
          ? {}
          : { sourceRunId: input.execution.sourceRunId }),
      },
      message: 'app_restarted',
    });
    await commitTerminalRunWithRuntimeFact({
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      newId: this.deps.newId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      status: 'failed',
      ts,
      terminalEvent,
      failureClass: 'app_restarted',
      runEventData: {
        recovered: true,
        recoveryReason,
        executionKind: input.execution.kind,
      },
      existingEvents: [],
    });
  }

  private async consumeLinkedRootExecution(
    input: RuntimeHostedRootExecutionInput,
    hostedGateAlreadyHeld = false,
  ): Promise<void> {
    const authority = isRuntimeHostedRootAuthority(this.deps.messageAuthority)
      ? this.deps.messageAuthority
      : undefined;
    if (authority) {
      const release = hostedGateAlreadyHeld
        ? undefined
        : this.acquireHostedLinkedChildExecution(input.sessionId);
      try {
        await authority.executeRoot(input);
        return;
      } finally {
        release?.();
      }
    }
    await this.consumeRuntimeEvents(
      input.start({
        runId: input.runId,
        userMessageId: input.userMessageId,
        onRunStarted: () => input.onReady?.(),
      }),
      undefined,
      input.onEvent,
    );
  }

  private acquireHostedLinkedChildExecution(sessionId: string): () => void {
    if (!isRuntimeHostedRootAuthority(this.deps.messageAuthority)) return () => {};
    if (this.activeHostedLinkedChildSessions.has(sessionId)) {
      throw new Error(`Child Session ${sessionId} already has an active execution`);
    }
    this.activeHostedLinkedChildSessions.add(sessionId);
    return () => {
      this.activeHostedLinkedChildSessions.delete(sessionId);
    };
  }

  private async consumeRuntimeEvents(
    events: AsyncIterable<SessionEvent>,
    onReady?: () => void | Promise<void>,
    onEvent?: (event: SessionEvent) => void,
  ): Promise<void> {
    await onReady?.();
    for await (const event of events) onEvent?.(event);
  }

  private stopLinkedRoot(
    identity: RuntimeMessageRunIdentity,
    input: StopSessionInput,
  ): Promise<void> {
    const authority = isRuntimeHostedRootAuthority(this.deps.messageAuthority)
      ? this.deps.messageAuthority
      : undefined;
    return authority
      ? authority.stopRoot(identity, input)
      : this.runtimeKernel.stopSession(identity.sessionId, input);
  }

  /** Queue a user message for mid-turn injection at the next step boundary. */
  steer(sessionId: string, text: string): QueueEnqueueOutcome {
    return this.runtimeKernel.steer(sessionId, text);
  }

  /** Queue a user message to open the turn after the current one finishes. */
  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome {
    return this.runtimeKernel.queueMessage(sessionId, text);
  }

  /** Drain the followup queue into one `\n\n`-joined prompt, or null if empty. */
  drainFollowup(sessionId: string): string | null {
    return this.runtimeKernel.drainFollowup(sessionId);
  }

  /** Take back every queued message (both queues) as one `\n\n`-joined string. */
  retractQueue(sessionId: string): string {
    return this.runtimeKernel.retractQueue(sessionId);
  }

  async *regenerateTurn(
    sessionId: string,
    input: RegenerateTurnInput,
  ): AsyncIterable<SessionEvent> {
    const execution = this.runtimeKernel.claimExecution(sessionId);
    try {
      // retry semantics merged into regenerate (#546): regenerate now accepts
      // failed/aborted turns too, not just completed — one action re-runs the
      // turn regardless of how the previous attempt ended.
      const source = await this.requireTurnForAction(
        sessionId,
        input.sourceTurnId,
        ['failed', 'aborted', 'completed'],
        'regenerate',
      );
      const user = await this.requireUserMessageForTurn(sessionId, source.turnId);
      yield* this.sendMessage(
        sessionId,
        {
          turnId: input.turnId ?? this.deps.newId(),
          text: user.text,
          ...(user.displayText !== undefined ? { displayText: user.displayText } : {}),
          ...(user.attachments ? { attachments: user.attachments } : {}),
          ...(user.quotes ? { quotes: user.quotes } : {}),
          parentTurnId: source.turnId,
          regeneratedFromTurnId: source.turnId,
        },
        { execution },
      );
    } finally {
      execution.release();
    }
  }

  async branchFromTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary> {
    const sourceView = await this.getSessionView(sessionId);
    // Inclusive: keep everything up to and including the chosen turn. A found
    // turn always has at least its own messages, so an empty copy means the
    // turn does not exist.
    const copied = copyMessagesThroughTurnBoundary(sourceView.messages, input.sourceTurnId);
    if (copied.length === 0)
      throw new Error(`Cannot branch from unknown turn ${input.sourceTurnId}`);
    return this.createBranchSession(sessionId, sourceView, copied, input);
  }

  async branchBeforeTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary> {
    const sourceView = await this.getSessionView(sessionId);
    // Exclusive dual of branchFromTurn: keep everything strictly before the
    // chosen turn, dropping it and every later turn. An empty copy is valid
    // here (the turn is the first one) — it branches to a fresh, empty context.
    const copied = copyMessagesBeforeTurn(sourceView.messages, input.sourceTurnId);
    if (copied === null) throw new Error(`Cannot branch before unknown turn ${input.sourceTurnId}`);
    return this.createBranchSession(sessionId, sourceView, copied, input);
  }

  /**
   * Create a non-destructive edit-and-resend version. Unlike branchBeforeTurn,
   * this is not a new sidebar conversation: revision lineage lets hosts fold
   * every version into one conversation slot while keeping old transcripts.
   */
  async reviseBeforeTurn(sessionId: string, input: ReviseBeforeTurnInput): Promise<SessionSummary> {
    const sourceView = await this.getSessionView(sessionId);
    const copied = copyMessagesBeforeTurn(sourceView.messages, input.sourceTurnId);
    if (copied === null) throw new Error(`Cannot revise before unknown turn ${input.sourceTurnId}`);
    return this.createRevisionSession(sessionId, sourceView, copied, input);
  }

  private async createRevisionSession(
    sessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copied: StoredMessage[],
    input: ReviseBeforeTurnInput,
  ): Promise<SessionSummary> {
    const header = await this.deps.store.readHeader(sessionId);
    const revisionRootSessionId = header.revisionRootSessionId ?? sessionId;
    const family = (await this.deps.store.list()).filter(
      (candidate) =>
        candidate.id === revisionRootSessionId ||
        candidate.revisionRootSessionId === revisionRootSessionId,
    );
    const revisionIndex =
      Math.max(1, ...family.map((candidate) => candidate.revisionIndex ?? 1)) + 1;
    const next = await this.deps.store.create({
      cwd: header.cwd,
      backend: header.backend,
      llmConnectionSlug: header.llmConnectionSlug,
      model: header.model,
      thinkingLevel: header.thinkingLevel,
      permissionMode: header.permissionMode,
      collaborationMode: header.collaborationMode,
      orchestrationMode: header.orchestrationMode ?? 'default',
      name: header.name,
      labels: header.labels,
      // A revision of a real branch remains in that branch's conversation
      // slot; revision lineage itself must not create a branch banner.
      parentSessionId: header.parentSessionId,
      branchOfTurnId: header.branchOfTurnId,
      revisionRootSessionId,
      revisionParentSessionId: sessionId,
      revisionOfTurnId: input.sourceTurnId,
      revisionIndex,
      revisionState: 'preparing',
      status: 'active',
    });
    await this.cloneConversationRuntimeLedger(next.id, sourceView, copied);
    if (copied.length > 0) await this.deps.store.appendMessages(next.id, copied);
    await this.deps.store.appendMessage(next.id, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'session_start',
      data: {
        revisionRootSessionId,
        revisionParentSessionId: sessionId,
        revisionOfTurnId: input.sourceTurnId,
        revisionIndex,
        revisionState: 'preparing',
      },
    });
    await this.deps.store.updateHeader(next.id, {
      isFlagged: header.isFlagged,
      titleIsManual: header.titleIsManual,
    });
    return headerToSummary(await this.deps.store.readHeader(next.id));
  }

  private async createBranchSession(
    sessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copied: StoredMessage[],
    input: BranchFromTurnInput,
  ): Promise<SessionSummary> {
    const header = await this.deps.store.readHeader(sessionId);
    const next = await this.deps.store.create({
      cwd: header.cwd,
      backend: header.backend,
      llmConnectionSlug: header.llmConnectionSlug,
      model: header.model,
      thinkingLevel: header.thinkingLevel,
      permissionMode: header.permissionMode,
      collaborationMode: header.collaborationMode,
      orchestrationMode: header.orchestrationMode ?? 'default',
      name: input.name ?? `${header.name} · 分支`,
      labels: header.labels,
      parentSessionId: sessionId,
      branchOfTurnId: input.sourceTurnId,
      status: 'active',
    });
    await this.cloneConversationRuntimeLedger(next.id, sourceView, copied);
    if (copied.length > 0) await this.deps.store.appendMessages(next.id, copied);
    await this.deps.store.appendMessage(next.id, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'session_start',
      data: { parentSessionId: sessionId, branchOfTurnId: input.sourceTurnId },
    });
    return headerToSummary(await this.deps.store.readHeader(next.id));
  }

  async respondToPermission(sessionId: string, response: PermissionResponse): Promise<void> {
    if (this.deps.interactionAuthority) {
      throw new RuntimeInteractionInvariantError(
        'Hosted permission answers must use the captured continuation',
      );
    }
    await this.runtimeKernel.respondToPermission(sessionId, response);
  }

  async respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
    if (this.deps.interactionAuthority) {
      throw new RuntimeInteractionInvariantError(
        'Hosted question answers must use the captured continuation',
      );
    }
    await this.runtimeKernel.respondToUserQuestion?.(sessionId, response);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async findRunByTurnId(
    sessionId: string,
    turnId: string,
  ): Promise<AgentRunHeader | undefined> {
    if (!this.deps.runStore) return undefined;
    const runs = await this.deps.runStore.listSessionRuns(sessionId).catch(() => []);
    const run = runs.find((candidate) => candidate.turnId === turnId);
    return run ? this.effectiveRunHeaderFromRuntimeLedger(run) : undefined;
  }

  private assertActiveParentRun(
    parentSessionId: string,
    parentRun: AgentRunHeader,
    parentTurnId: string,
  ): void {
    if (
      parentRun.sessionId !== parentSessionId ||
      parentRun.turnId !== parentTurnId ||
      !(
        this.runtimeKernel.hasActiveRun?.(parentSessionId, parentRun.runId, parentTurnId) ||
        this.deps.isParentRunActive?.(parentSessionId, parentRun.runId, parentTurnId)
      )
    ) {
      throw new Error('Child session parent run is not active');
    }
  }

  private async resolveShellRunOwner(
    firstParentSessionId: string,
    ref: string,
  ): Promise<{ sessionId: string; result: ShellRunUpdate['result'] } | undefined> {
    const shellRuns = this.deps.shellRuns;
    if (!shellRuns) return undefined;
    let ownerSessionId: string | undefined = firstParentSessionId;
    const visited = new Set<string>();
    while (ownerSessionId && !visited.has(ownerSessionId)) {
      visited.add(ownerSessionId);
      try {
        return {
          sessionId: ownerSessionId,
          result: await shellRuns.inspectResource(ownerSessionId, ref),
        };
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        try {
          const ownerHeader = await this.deps.store.readHeader(ownerSessionId);
          ownerSessionId = ownerHeader.revisionParentSessionId ?? ownerHeader.parentSessionId;
        } catch (headerError) {
          if (isNotFoundError(headerError)) return undefined;
          throw headerError;
        }
      }
    }
    return undefined;
  }

  private async findChildRunForOutput(
    sessionId: string,
    input: AgentOutputInput,
  ): Promise<{ header: AgentRunHeader; execution: SubagentExecutionRef }> {
    if (Number(!!input.execution) + Number(!!input.runId) + Number(!!input.turnId) !== 1) {
      throw new Error('agent_output requires exactly one execution, runId, or turnId locator');
    }
    if (input.execution?.kind === 'child_session') {
      const execution = input.execution;
      const child = await this.deps.store.readHeader(execution.sessionId).catch((error) => {
        if (isNotFoundError(error)) return undefined;
        throw error;
      });
      if (
        !child ||
        child.subagentParent?.kind !== 'subagent' ||
        child.subagentParent.parentSessionId !== sessionId
      ) {
        throw new Error('agent_output could not find the requested child session');
      }
      const runs = await this.deps.runStore?.listSessionRuns(child.id);
      const selected = execution.currentRunId
        ? runs?.find((run) => run.runId === execution.currentRunId)
        : runs
            ?.slice()
            .sort(
              (left, right) =>
                right.createdAt - left.createdAt ||
                right.updatedAt - left.updatedAt ||
                right.runId.localeCompare(left.runId),
            )[0];
      if (!selected || !isSessionInlineRun(selected)) {
        throw new Error('agent_output could not find the requested child session run');
      }
      const header = await this.effectiveRunHeaderFromRuntimeLedger(selected);
      return {
        header,
        execution: {
          kind: 'child_session',
          sessionId: child.id,
          currentRunId: header.runId,
        },
      };
    }

    const legacyExecution =
      input.execution?.kind === 'legacy_child_run' ? input.execution : undefined;
    if (legacyExecution && legacyExecution.sessionId !== sessionId) {
      throw new Error('agent_output could not find the requested legacy child run');
    }
    const runs = await this.deps.runStore?.listSessionRuns(sessionId);
    const header = runs?.find((run) =>
      legacyExecution
        ? run.runId === legacyExecution.runId
        : input.runId
          ? run.runId === input.runId
          : input.turnId
            ? run.turnId === input.turnId
            : false,
    );
    if (!header) throw new Error('agent_output could not find the requested child agent run');
    if (!header.parentRunId || isSessionInlineRun(header)) {
      throw new Error('agent_output only reads child agent runs');
    }
    return {
      header: await this.effectiveRunHeaderFromRuntimeLedger(header),
      execution: {
        kind: 'legacy_child_run',
        sessionId,
        runId: header.runId,
      },
    };
  }

  private async effectiveRunHeaderFromRuntimeLedger(run: AgentRunHeader): Promise<AgentRunHeader> {
    if (!this.deps.runtimeEventStore) return run;
    const runtimeEvents = await this.deps.runtimeEventStore
      .readRuntimeEvents(run.sessionId, run.runId)
      .catch(() => undefined);
    if (!runtimeEvents) return run;
    const ledger = classifyTerminalRuntimeLedger(run, runtimeEvents);
    return ledger.kind === 'fact' ? effectiveRunHeaderFromTerminalFact(run, ledger.fact) : run;
  }

  private async updateStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
    ts = this.deps.now(),
  ): Promise<void> {
    await this.updateHeader(sessionId, buildStatusPatch(status, ts, blockedReason));
  }

  private async updateHeader(
    sessionId: string,
    patch: Partial<SessionHeader>,
  ): Promise<SessionHeader> {
    const next = await this.deps.store.updateHeader(sessionId, patch);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return next;
  }

  private requirePlanStore(): PlanStore {
    if (!this.deps.planStore) throw new Error('Plan Mode is unavailable on this surface');
    return this.deps.planStore;
  }

  private async appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage: AgentRunLineage = {},
    options: { ts?: number; errorClass?: string; abortSource?: string } = {},
  ): Promise<void> {
    const ts = options.ts ?? this.deps.now();
    await this.deps.store.appendMessage(
      sessionId,
      buildTurnStateMessage({
        id: this.deps.newId(),
        turnId,
        ts,
        status,
        lineage,
        ...(options.abortSource ? { abortSource: options.abortSource } : {}),
        ...(options.errorClass !== undefined ? { errorClass: options.errorClass } : {}),
        partialOutputRetained: await this.turnHasRetainedOutput(sessionId, turnId),
      }),
    );
  }

  private async turnHasRetainedOutput(sessionId: string, turnId: string): Promise<boolean> {
    const messages = await this.deps.store.readMessages(sessionId).catch(() => []);
    return messagesHaveRetainedOutput(messages, turnId);
  }

  private async requireTurnForAction(
    sessionId: string,
    turnId: string,
    allowed: readonly TurnRecord['status'][],
    action: string,
  ): Promise<TurnRecord> {
    const turn = (await this.getSessionView(sessionId)).turns.find(
      (candidate) => candidate.turnId === turnId,
    );
    if (!turn) throw new Error(`Cannot ${action}: unknown turn ${turnId}`);
    if (!allowed.includes(turn.status)) {
      throw new Error(`Cannot ${action}: turn ${turnId} is ${turn.status}`);
    }
    return turn;
  }

  private async requireUserMessageForTurn(sessionId: string, turnId: string): Promise<UserMessage> {
    const user = (await this.getSessionView(sessionId)).messages.find(
      (message): message is UserMessage => message.type === 'user' && message.turnId === turnId,
    );
    if (!user) throw new Error(`Turn ${turnId} has no user message`);
    return user;
  }

  private async getSessionView(sessionId: string): Promise<RuntimeReadModelSessionView> {
    const repaired = new Set<string>();
    for (let attempt = 0; attempt < MAX_RUNTIME_LEDGER_REPAIR_ATTEMPTS; attempt += 1) {
      try {
        const view = await this.readModel().getSessionView(sessionId);
        const runId = firstRuntimeRepairRunId(view.diagnostics, repaired);
        if (!runId) return view;
        if (!(await this.repairMissingTerminalFactOnce(sessionId, runId))) return view;
        repaired.add(runId);
      } catch (error) {
        if (!(error instanceof RuntimeReadModelError)) throw error;
        const runId = firstRuntimeRepairRunId(error.diagnostics, repaired);
        if (!runId) throw error;
        if (!(await this.repairMissingTerminalFactOnce(sessionId, runId))) throw error;
        repaired.add(runId);
      }
    }
    return this.readModel().getSessionView(sessionId);
  }

  private readModel(): RuntimeReadModel {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('RuntimeReadModel requires AgentRunStore and RuntimeEventStore');
    }
    return new RuntimeReadModel({
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      projectionCache: this.deps.store,
      ...(this.deps.canonicalPermissionOutcomes
        ? { canonicalPermissionOutcomes: this.deps.canonicalPermissionOutcomes }
        : {}),
    });
  }

  private async repairMissingTerminalFactOnce(sessionId: string, runId: string): Promise<boolean> {
    return (
      (await this.runtimeLedgerRepair?.repairMissingTerminalFactOnce(sessionId, runId)) ?? false
    );
  }

  private async cloneConversationRuntimeLedger(
    childSessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copiedMessages: readonly StoredMessage[],
  ): Promise<void> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return;
    const copiedTurnIds = new Set<string>();
    for (const message of copiedMessages) {
      if ('turnId' in message && typeof message.turnId === 'string')
        copiedTurnIds.add(message.turnId);
    }
    if (copiedTurnIds.size === 0) return;
    const copiedPermissionDecisions = new Map(
      copiedMessages.flatMap((message) =>
        message.type === 'permission_decision' ? [[message.id, message] as const] : [],
      ),
    );

    for (const sourceRun of sourceView.runs) {
      if (!copiedTurnIds.has(sourceRun.turnId)) continue;
      const sourceEvents = sourceView.events.filter(
        (event) => event.runId === sourceRun.runId && copiedTurnIds.has(event.turnId),
      );
      if (sourceEvents.length === 0) continue;

      const runId = this.deps.newId();
      const invocationId = this.deps.newId();
      const clonedRun = cloneRunHeaderForConversationCopy(
        sourceRun,
        childSessionId,
        runId,
        invocationId,
      );
      await this.deps.runStore.createRun(clonedRun);

      const sourceTerminalLedger = classifyTerminalRuntimeLedger(sourceRun, sourceEvents);
      const clonedEventBySourceId = new Map<string, RuntimeEvent>();
      for (const event of sourceEvents) {
        const clonedEvent = cloneRuntimeEventForConversationCopy(
          event,
          {
            sessionId: childSessionId,
            runId,
            eventId: this.deps.newId(),
            invocationId,
          },
          copiedPermissionDecisions,
        );
        await this.deps.runtimeEventStore.appendRuntimeEvent(childSessionId, runId, clonedEvent);
        clonedEventBySourceId.set(event.id, clonedEvent);
      }

      if (sourceTerminalLedger.kind === 'fact' && isTerminalRunStatus(sourceRun.status)) {
        const terminalEvent = clonedEventBySourceId.get(sourceTerminalLedger.fact.terminalEvent.id);
        if (!terminalEvent) continue;
        await commitTerminalRunWithRuntimeFact({
          runStore: this.deps.runStore,
          runtimeEventStore: this.deps.runtimeEventStore,
          newId: this.deps.newId,
          sessionId: childSessionId,
          runId,
          turnId: sourceRun.turnId,
          status: sourceTerminalLedger.fact.runStatus,
          ts: terminalEvent.ts,
          terminalEvent,
          ...(sourceTerminalLedger.fact.failureClass
            ? { failureClass: sourceTerminalLedger.fact.failureClass }
            : {}),
          ...(sourceRun.failureMessage ? { failureMessage: sourceRun.failureMessage } : {}),
          ...(sourceTerminalLedger.fact.abortSource
            ? { abortSource: sourceTerminalLedger.fact.abortSource }
            : {}),
          runEventData: {
            recovered: true,
            recoveryReason: 'conversation_runtime_ledger_clone',
            sourceSessionId: sourceRun.sessionId,
            sourceRunId: sourceRun.runId,
          },
        });
      }
    }
  }

  private async recoverAgentRunsFromLedger(
    sessionId: string,
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<{ hasLedger: boolean; recovered: boolean }> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore)
      return { hasLedger: false, recovered: false };
    const runs =
      policy.kind === 'strict'
        ? await policy.stores.agentRunStore.listSessionRunsForRecovery(sessionId)
        : await this.deps.runStore.listSessionRuns(sessionId);
    if (runs.length === 0) return { hasLedger: false, recovered: false };

    let recovered = false;
    for (const run of runs) {
      if (policy.kind === 'strict') {
        await policy.stores.agentRunStore.readEventsForRecovery(sessionId, run.runId);
      }
      const inspected = await inspectAgentRunReadModel(
        this.deps.runStore,
        this.deps.runtimeEventStore,
        { sessionId, runId: run.runId, header: run },
      );
      if (inspected.sourceHealth.runtimeLedger === 'read_failed') {
        if (policy.kind === 'strict') {
          throw new Error(`RuntimeEvent ledger is unreadable for run ${run.runId}`);
        }
        continue;
      }
      if (
        policy.kind === 'strict' &&
        inspected.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'operational_ledger_read_failed' ||
            diagnostic.code === 'operational_event_corrupt',
        )
      ) {
        throw new Error(`AgentRun event ledger is unreadable for run ${run.runId}`);
      }
      const terminalLedger = classifyTerminalRuntimeLedger(run, inspected.runtimeEvents);
      if (terminalLedger.kind === 'ambiguous') {
        if (policy.kind === 'strict') {
          throw new Error(`RuntimeEvent ledger has ambiguous terminal facts for run ${run.runId}`);
        }
        continue;
      }
      if (isTerminalRunStatus(run.status) && !inspected.terminalRuntimeFact) {
        const repaired = await this.repairMissingTerminalFactOnce(sessionId, run.runId);
        if (repaired) {
          recovered = true;
        } else if (policy.kind === 'strict') {
          throw new Error(`Unable to repair the terminal RuntimeEvent fact for run ${run.runId}`);
        }
        continue;
      }
      const runtimeDecision = this.classifyRuntimeEventRecovery(inspected);
      const decision = runtimeDecision ?? classifyAgentRunRecovery(run, inspected.events);
      if (!decision) continue;
      if (await this.applyAgentRunRecovery(sessionId, decision, inspected, policy)) {
        recovered = true;
      }
    }
    return { hasLedger: true, recovered };
  }

  private classifyRuntimeEventRecovery(
    inspected: AgentRunInspectModel,
  ): AgentRunRecoveryDecision | undefined {
    if (isTerminalRunStatus(inspected.header.status) || !inspected.terminalRuntimeFact)
      return undefined;
    return runtimeTerminalFactToRecoveryDecision(inspected.header, inspected.terminalRuntimeFact);
  }

  private async applyAgentRunRecovery(
    sessionId: string,
    decision: AgentRunRecoveryDecision,
    inspected: AgentRunInspectModel,
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<boolean> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return false;
    const ts = this.deps.now();
    const terminalLedger = classifyTerminalRuntimeLedger(inspected.header, inspected.runtimeEvents);
    const existingTerminal =
      inspected.terminalRuntimeFact?.terminalEvent ??
      (terminalLedger.kind === 'incomplete_single_terminal'
        ? terminalLedger.terminalEvent
        : undefined);
    const status = existingTerminal
      ? (terminalRunStatusFromRuntimeEvent(existingTerminal) ?? decision.status)
      : decision.status;
    const failureClass =
      status === 'failed' ? (decision.failureClass ?? 'app_restarted') : undefined;
    const abortSource = status === 'cancelled' ? (decision.abortSource ?? 'unknown') : undefined;
    const terminalEvent =
      existingTerminal ??
      buildRecoveredTerminalRuntimeEvent({
        id: this.deps.newId(),
        run: inspected.header,
        status,
        ts,
        recoveryReason: diagnosticRecoveryReason(decision.diagnostic),
        ...(inspected.runtimeEvents[0]?.invocationId
          ? { invocationId: inspected.runtimeEvents[0].invocationId }
          : {}),
        ...(failureClass ? { failureClass, message: failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
        ...(decision.diagnostic ? { diagnostic: decision.diagnostic } : {}),
      });
    try {
      await commitTerminalRunWithRuntimeFact({
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        newId: this.deps.newId,
        sessionId,
        runId: decision.runId,
        turnId: decision.turnId,
        status,
        ts,
        terminalEvent,
        ...(failureClass ? { failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
        runEventData: { recovered: true, ...decision.diagnostic },
        existingEvents: inspected.events,
      });
    } catch (error) {
      if (policy.kind === 'strict') throw error;
      return false;
    }

    await recoverOr(
      policy,
      () =>
        this.appendTerminalTurnStateIfNeeded(
          sessionId,
          inspected.header,
          decision,
          terminalTurnStatus(status),
          {
            ts,
            ...(failureClass ? { errorClass: failureClass } : {}),
            ...(abortSource ? { abortSource } : {}),
          },
          policy,
        ),
      undefined,
    );
    return true;
  }

  private async appendTerminalTurnStateIfNeeded(
    sessionId: string,
    run: AgentRunHeader,
    decision: AgentRunRecoveryDecision,
    status: TurnRecord['status'],
    options: { ts: number; errorClass?: string; abortSource?: string },
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<void> {
    if (!isSessionInlineRun(run)) return;
    const messages = await recoverOr(
      policy,
      () => this.deps.store.readMessages(sessionId),
      [] as StoredMessage[],
    );
    const latest = latestTurnState(messages, decision.turnId);
    if (latest && isTerminalTurnStatus(latest.status) && latest.status === status) return;
    await this.appendTurnState(sessionId, decision.turnId, status, decision.lineage, options);
  }
}

function resumeFeatureDisabledPlan(): SafeBoundaryContinuationPlan {
  return {
    disposition: 'park',
    rejectionReasons: ['resume_feature_disabled'],
    diagnostics: [
      {
        code: 'resume_feature_disabled',
        message: 'safe-boundary resume is disabled by the host feature flag',
      },
    ],
  };
}

function continuationExecutionErrorClass(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as Error & { code?: unknown }).code === 'string'
  ) {
    return (error as Error & { code: string }).code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

type RecoveryPolicy = { kind: 'best_effort' } | { kind: 'strict'; stores: StrictRecoveryStores };

function listSessionsForRecovery(
  store: SessionStore,
  policy: RecoveryPolicy,
): Promise<Array<SessionHeader | SessionSummary>> {
  return policy.kind === 'strict' ? policy.stores.sessionStore.listForRecovery() : store.list();
}

async function recoverOr<T>(
  policy: RecoveryPolicy,
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (policy.kind === 'strict') throw error;
    return fallback;
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function headerToSummary(h: SessionHeader): SessionSummary {
  const summary: SessionSummary = {
    id: h.id,
    cwd: h.cwd,
    name: h.name === 'New Session' ? DEFAULT_SESSION_NAME : h.name,
    isFlagged: h.isFlagged,
    isArchived: h.isArchived,
    labels: h.labels,
    hasUnread: h.hasUnread,
    status: h.status,
    ...(h.blockedReason ? { blockedReason: h.blockedReason } : {}),
    ...(h.statusUpdatedAt !== undefined ? { statusUpdatedAt: h.statusUpdatedAt } : {}),
    ...(h.parentSessionId ? { parentSessionId: h.parentSessionId } : {}),
    ...(h.branchOfTurnId ? { branchOfTurnId: h.branchOfTurnId } : {}),
    ...(h.subagentParent ? { subagentParent: h.subagentParent } : {}),
    ...(h.subagentRuntime
      ? { subagentRuntime: subagentSessionRuntimeSummary(h.subagentRuntime) }
      : {}),
    ...(h.revisionRootSessionId ? { revisionRootSessionId: h.revisionRootSessionId } : {}),
    ...(h.revisionParentSessionId ? { revisionParentSessionId: h.revisionParentSessionId } : {}),
    ...(h.revisionOfTurnId ? { revisionOfTurnId: h.revisionOfTurnId } : {}),
    ...(h.revisionIndex !== undefined ? { revisionIndex: h.revisionIndex } : {}),
    ...(h.revisionState ? { revisionState: h.revisionState } : {}),
    backend: h.backend,
    llmConnectionSlug: h.llmConnectionSlug,
    connectionLocked: h.connectionLocked,
    model: h.model,
    permissionMode: h.permissionMode ?? 'ask',
    collaborationMode: h.collaborationMode ?? 'agent',
    orchestrationMode: h.orchestrationMode ?? 'default',
  };
  if (h.thinkingLevel !== undefined) summary.thinkingLevel = h.thinkingLevel;
  if (h.lastMessageAt !== undefined) {
    summary.lastMessageAt = h.lastMessageAt;
  }
  return summary;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function childSessionSpawnKey(
  parentSessionId: string,
  input: Pick<SpawnChildSessionInput, 'spawnedBy' | 'swarm'>,
): string {
  return JSON.stringify([
    1,
    parentSessionId,
    input.spawnedBy.parentRunId,
    input.spawnedBy.toolCallId,
    input.swarm?.swarmId ?? null,
    input.swarm?.itemId ?? null,
  ]);
}

function childSessionRequestFingerprint(
  parentSessionId: string,
  input: Pick<SpawnChildSessionInput, 'spawnedBy' | 'agentProfile' | 'prompt' | 'swarm'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        1,
        parentSessionId,
        input.spawnedBy.parentRunId,
        input.spawnedBy.parentTurnId,
        input.spawnedBy.toolCallId,
        input.agentProfile,
        input.prompt,
        input.swarm?.swarmId ?? null,
        input.swarm?.itemId ?? null,
      ]),
    )
    .digest('hex');
}

function claimedAgentGraphIntentRequestFingerprint(
  input: Pick<ResolvedClaimedAgentGraphIntentInput, 'claim' | 'prompt'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([1, input.claim, input.prompt]))
    .digest('hex');
}

function claimedAgentGraphIntentResult(
  claim: AgentGraphIntentClaim,
  result: SpawnChildSessionResult,
): ClaimedAgentGraphIntentResult {
  return {
    claimId: claim.claimId,
    graphId: claim.graphId,
    intentId: claim.intentId,
    operatorId: claim.targetOperatorId,
    ...result,
  };
}

export function changesBackendConfig(patch: Partial<SessionHeader>): boolean {
  return (
    'backend' in patch ||
    'llmConnectionSlug' in patch ||
    'model' in patch ||
    'thinkingLevel' in patch ||
    'cwd' in patch ||
    'collaborationMode' in patch
  );
}

function agentRunStatusForSpawnResult(
  status: AgentRunHeader['status'],
): SpawnChildAgentResult['status'] {
  if (status === 'waiting_for_user') return 'waiting_for_user';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'running' || status === 'created') return 'running';
  return 'completed';
}

function isUnsafeChildResumeDiagnostic(code: string): boolean {
  return (
    code === 'unmatched_tool_call' ||
    code === 'unmatched_tool_result' ||
    code === 'tool_id_mismatch' ||
    code === 'unsupported_role' ||
    code === 'unsupported_content'
  );
}

function trimSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= CHILD_AGENT_SUMMARY_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, CHILD_AGENT_SUMMARY_MAX_CHARS - 1)}…`;
}

class ChildAgentSummaryAccumulator {
  eventCount = 0;
  failureClass: string | undefined;
  private terminalStatus: SpawnChildAgentResult['status'] | undefined;
  private lastTextComplete = '';
  private textDeltaTail = '';
  private textDeltaTruncated = false;
  private lastError = '';

  add(event: SessionEvent): void {
    this.eventCount += 1;
    switch (event.type) {
      case 'text_complete':
        this.lastTextComplete = trimSummary(event.text);
        break;
      case 'text_delta':
        this.appendTextDelta(event.text);
        break;
      case 'error':
        this.terminalStatus = 'failed';
        this.lastError = trimSummary(event.message);
        break;
      case 'abort':
        this.terminalStatus = 'cancelled';
        break;
      case 'complete':
        this.failureClass = failureClassFromCompleteStopReason(event.stopReason);
        if (this.failureClass) this.terminalStatus = 'failed';
        else if (event.stopReason === 'user_stop') this.terminalStatus = 'cancelled';
        else this.terminalStatus = 'completed';
        break;
    }
  }

  status(aborted: boolean): SpawnChildAgentResult['status'] {
    if (aborted) return 'cancelled';
    return this.terminalStatus ?? 'running';
  }

  text(): string {
    if (this.lastTextComplete.trim()) return this.lastTextComplete;
    if (this.textDeltaTail.trim()) {
      return this.textDeltaTruncated
        ? `…${this.textDeltaTail.slice(1)}`
        : this.textDeltaTail.trim();
    }
    return this.lastError;
  }

  private appendTextDelta(text: string): void {
    this.textDeltaTail += text;
    if (this.textDeltaTail.length <= CHILD_AGENT_SUMMARY_MAX_CHARS) return;
    this.textDeltaTruncated = true;
    this.textDeltaTail = this.textDeltaTail.slice(-CHILD_AGENT_SUMMARY_MAX_CHARS);
  }
}

interface InterruptedTurnRecovery {
  turnId: string;
  errorClass: string;
  lineage: Partial<
    Pick<
      UserMessageInput,
      | 'parentTurnId'
      | 'retriedFromTurnId'
      | 'regeneratedFromTurnId'
      | 'branchOfTurnId'
      | 'parentSessionId'
    >
  >;
}

function hasRevisionUserMessage(messages: readonly StoredMessage[]): boolean {
  let boundary = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      message.type === 'system_note' &&
      message.kind === 'session_start' &&
      message.data &&
      typeof message.data === 'object' &&
      'revisionRootSessionId' in message.data
    ) {
      boundary = index;
    }
  }
  return boundary >= 0 && messages.slice(boundary + 1).some((message) => message.type === 'user');
}

function interruptedTurnRecoveries(messages: readonly StoredMessage[]): InterruptedTurnRecovery[] {
  const byTurn = new Map<
    string,
    {
      hasAssistant: boolean;
      states: Array<Extract<StoredMessage, { type: 'turn_state' }>>;
    }
  >();
  for (const message of messages) {
    const turnId = (message as { turnId?: string }).turnId;
    if (!turnId) continue;
    const bucket = byTurn.get(turnId) ?? { hasAssistant: false, states: [] };
    if (message.type === 'assistant') bucket.hasAssistant = true;
    if (message.type === 'turn_state') bucket.states.push(message);
    byTurn.set(turnId, bucket);
  }

  const recoveries: InterruptedTurnRecovery[] = [];
  for (const [turnId, bucket] of byTurn) {
    const latest = bucket.states.at(-1);
    if (!latest) continue;
    if (latest.status === 'running') {
      recoveries.push({
        turnId,
        errorClass: 'app_restarted',
        lineage: turnStateLineage(latest),
      });
      continue;
    }
    const failed = [...bucket.states].reverse().find((state) => state.status === 'failed');
    if (latest.status === 'completed' && !bucket.hasAssistant && failed) {
      recoveries.push({
        turnId,
        errorClass: failed.errorClass ?? 'unknown',
        lineage: turnStateLineage(failed),
      });
    }
  }
  return recoveries;
}

function turnStateLineage(
  state: Extract<StoredMessage, { type: 'turn_state' }>,
): Partial<
  Pick<
    UserMessageInput,
    | 'parentTurnId'
    | 'retriedFromTurnId'
    | 'regeneratedFromTurnId'
    | 'branchOfTurnId'
    | 'parentSessionId'
  >
> {
  return {
    ...(state.parentTurnId ? { parentTurnId: state.parentTurnId } : {}),
    ...(state.retriedFromTurnId ? { retriedFromTurnId: state.retriedFromTurnId } : {}),
    ...(state.regeneratedFromTurnId ? { regeneratedFromTurnId: state.regeneratedFromTurnId } : {}),
    ...(state.branchOfTurnId ? { branchOfTurnId: state.branchOfTurnId } : {}),
    ...(state.parentSessionId ? { parentSessionId: state.parentSessionId } : {}),
  };
}

function cloneRuntimeEventForConversationCopy(
  event: RuntimeEvent,
  ids: { sessionId: string; runId: string; eventId: string; invocationId: string },
  copiedPermissionDecisions: ReadonlyMap<
    string,
    Extract<StoredMessage, { type: 'permission_decision' }>
  >,
): RuntimeEvent {
  const cloned: RuntimeEvent = {
    ...event,
    id: ids.eventId,
    invocationId: ids.invocationId,
    sessionId: ids.sessionId,
    runId: ids.runId,
  };
  const accepted = event.actions?.permissionAnswerAccepted;
  const decision = accepted ? copiedPermissionDecisions.get(accepted.requestId) : undefined;
  if (!decision || !cloned.actions) return cloned;
  const { permissionAnswerAccepted: _accepted, ...actions } = cloned.actions;
  cloned.actions = {
    ...actions,
    permissionDecision: {
      requestId: decision.id,
      toolName: decision.toolName,
      decision: decision.decision,
      ...(decision.rememberForTurn !== undefined
        ? { rememberForTurn: decision.rememberForTurn }
        : {}),
      ...(decision.reviewer !== undefined ? { reviewer: decision.reviewer } : {}),
      ...(decision.rationale !== undefined ? { rationale: decision.rationale } : {}),
      ...(decision.riskLevel !== undefined ? { riskLevel: decision.riskLevel } : {}),
    },
  };
  cloned.ts = decision.ts;
  return cloned;
}

function cloneRunHeaderForConversationCopy(
  sourceRun: AgentRunHeader,
  childSessionId: string,
  runId: string,
  invocationId: string,
): AgentRunHeader {
  const cloned = { ...sourceRun, invocationId, sessionId: childSessionId, runId };
  if (isTerminalRunStatus(sourceRun.status)) {
    cloned.status = 'running';
    delete cloned.completedAt;
    delete cloned.failureClass;
    delete cloned.failureMessage;
    delete cloned.abortSource;
  }
  return cloned;
}

function copyMessagesThroughTurnBoundary(
  messages: readonly StoredMessage[],
  turnId: string,
): StoredMessage[] {
  let lastIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if ((message as { turnId?: string }).turnId === turnId) {
      lastIndex = index;
    }
  }
  if (lastIndex < 0) return [];
  // Branch v1 copies conversation context only. Turn metadata is intentionally
  // not copied into the child session; lineage lives on the child session
  // header (`parentSessionId` + `branchOfTurnId`) and future turns.
  return messages.slice(0, lastIndex + 1).filter((message) => message.type !== 'turn_state');
}

// Exclusive dual of copyMessagesThroughTurnBoundary: every message belonging to
// a turn strictly before the chosen one, dropping it and every later turn.
// Returns null when the turn is absent (so the caller can reject an unknown
// turn), and an empty array when the turn is the first one (a valid branch into
// empty context). Membership, not array position, decides what to keep: the read
// model does not guarantee a turn's messages are contiguous or that a user
// prompt precedes its turn_state in array order, so a positional slice could
// drop an earlier turn's prompt. turn_state is dropped for the same reason as in
// the inclusive copy — lineage lives on the child header, not copied metadata.
function copyMessagesBeforeTurn(
  messages: readonly StoredMessage[],
  turnId: string,
): StoredMessage[] | null {
  const turnOrder: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const messageTurnId = (message as { turnId?: string }).turnId;
    if (messageTurnId && !seen.has(messageTurnId)) {
      seen.add(messageTurnId);
      turnOrder.push(messageTurnId);
    }
  }
  const cut = turnOrder.indexOf(turnId);
  if (cut < 0) return null;
  const keep = new Set(turnOrder.slice(0, cut));
  return messages.filter((message) => {
    if (message.type === 'turn_state') return false;
    const messageTurnId = (message as { turnId?: string }).turnId;
    return messageTurnId !== undefined && keep.has(messageTurnId);
  });
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isTerminalTurnStatus(status: TurnRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

function terminalTurnStatus(status: AgentRunRecoveryDecision['status']): TurnRecord['status'] {
  if (status === 'cancelled') return 'aborted';
  return status;
}

function diagnosticRecoveryReason(diagnostic: Record<string, unknown> | undefined): string {
  const recoveryReason = diagnostic?.recoveryReason;
  return typeof recoveryReason === 'string' && recoveryReason.length > 0
    ? recoveryReason
    : 'agent_run_recovery';
}

function latestTurnState(
  messages: readonly StoredMessage[],
  turnId: string,
): Extract<StoredMessage, { type: 'turn_state' }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'turn_state' && message.turnId === turnId) return message;
  }
  return undefined;
}

function runtimeTerminalFactToRecoveryDecision(
  header: AgentRunHeader,
  fact: RuntimeEventTerminalFact,
): AgentRunRecoveryDecision {
  return {
    runId: fact.runId,
    turnId: fact.turnId,
    status: fact.runStatus,
    ...(fact.failureClass ? { failureClass: fact.failureClass } : {}),
    ...(fact.abortSource ? { abortSource: fact.abortSource } : {}),
    diagnostic: {
      recoveryReason: 'runtime_event_terminal_fact',
      runtimeEventId: fact.terminalEvent.id,
      runtimeEventStatus: fact.terminalEvent.status,
    },
    lineage: headerLineage(header),
  };
}

function headerLineage(header: AgentRunHeader): AgentRunRecoveryDecision['lineage'] {
  return {
    ...(header.parentRunId ? { parentRunId: header.parentRunId } : {}),
    ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
    ...(header.regeneratedFromTurnId
      ? { regeneratedFromTurnId: header.regeneratedFromTurnId }
      : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
  };
}

function normalizeAgentOutputMaxEvents(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function tail<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return items.slice(items.length - max);
}

function throwIfChildExecutionAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error(message), { name: 'AbortError' });
}

// Re-export the suppressed-unused types so this file is the canonical home
// for them. (Avoids TS "imported but unused" warnings.)
export type {
  TextDeltaEvent,
  CompleteEvent,
  ErrorEvent,
  AbortEvent,
  PermissionRequestEvent,
  PermissionDecisionAckEvent,
  PermissionDecisionMessage,
};
