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

import {
  decodeMessageContent,
  TOOL_ACTIVITY_KINDS,
  type MessageContent,
  type ToolActivityKind,
  type ToolResultContent,
} from './events.js';
import {
  isPermissionMode,
  isToolCategory,
  type PermissionMode,
  type PolicyDecision,
  type ToolCategory,
} from './permission.js';
import type { CollaborationMode } from './collaboration.js';
import type { OrchestrationMode } from './orchestration.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';
import { isPermissionDecisionFields } from './interaction-record-schema.js';
import { isTokenUsageFields, type TokenUsageFields } from './usage-record-schema.js';
import { decodeCanonicalToolResultContent } from './tool-result-record-schema.js';
import type { SubagentWorkspaceBinding } from './subagent-workspace.js';
import { decodeTurnOrigin, type TurnOrigin } from './turn-origin.js';

export { DEEP_RESEARCH_SESSION_LABEL, isDeepResearchSession } from './explore-agent.js';

/** Runtime execution states. Archive visibility is represented by `isArchived`. */
export const SESSION_STATUSES = [
  'active',
  'running',
  'waiting_for_user',
  'blocked',
  'aborted',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_BLOCKED_REASONS = [
  'NO_REAL_CONNECTION',
  'auth',
  'permission_required',
  'tool_failed',
  'unknown',
] as const;

export type SessionBlockedReason = (typeof SESSION_BLOCKED_REASONS)[number];

export const TURN_STATUSES = ['running', 'completed', 'aborted', 'failed'] as const;

export type TurnStatus = (typeof TURN_STATUSES)[number];

export const SUBAGENT_SESSION_LIFECYCLES = ['foreground'] as const;

export type SubagentSessionLifecycle = (typeof SUBAGENT_SESSION_LIFECYCLES)[number];
export const SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION = 1 as const;
export const SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION = 1 as const;

/**
 * Durable control-plane lineage for a subagent session.
 *
 * The relation lives only on the child. Parents do not persist a reciprocal
 * child-id array; reverse lookup is a read-model concern. Cross-session
 * provenance deliberately stays out of AgentRun.parentRunId so runs inside the
 * child session can retain normal session-inline history semantics.
 */
export interface SubagentSessionParent {
  kind: 'subagent';
  parentSessionId: string;
  spawnedBy: {
    parentRunId: string;
    parentTurnId: string;
    toolCallId: string;
  };
  swarm?: {
    swarmId: string;
    itemId: string;
  };
  graph?: {
    graphId: string;
    workId: string;
    operatorId: string;
  };
  lifecycle: SubagentSessionLifecycle;
}

/**
 * Durable execution snapshot for a linked subagent session.
 *
 * The snapshot prevents a reopened child session from silently inheriting a
 * wider tool surface from a later parent/default configuration. The concrete
 * SessionHeader continues to own backend/model/cwd while ExecutionBoundary is
 * the authoritative local execution authority.
 */
export interface SubagentSessionRuntime {
  schemaVersion: typeof SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION;
  definitionVersion: number;
  agentId: string;
  agentName: string;
  profile: string;
  /** User-approved model route selected at spawn time. Absent for legacy profile spawns. */
  presetId?: string;
  systemPrompt: string;
  toolNames: string[];
  categoryPolicy: Partial<Record<ToolCategory, PolicyDecision>>;
  /** Legacy decode-only metadata. Current child sessions do not write it. */
  permissionCeiling?: PermissionMode;
}

/**
 * Durable identity of the initial child invocation.
 *
 * The SQLite metadata control plane derives its unique spawn key from
 * subagentParent. This block binds that key to the exact requested work and
 * preallocates the first run identities so a retry can reuse or recover them.
 */
export interface SubagentSessionSpawn {
  schemaVersion: typeof SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION;
  requestFingerprint: string;
  initialTurnId: string;
  initialRunId: string;
}

/**
 * Internal publication state for a Host-owned cross-Session conversation copy.
 *
 * Preparing copies are not product Sessions yet. The Host publishes them only
 * after Messages, Runtime Events, Artifacts, and Task Ledger state are durable.
 */
export interface SessionConversationCopy {
  kind: 'branch' | 'revision';
  sourceSessionId: string;
  sourceTurnId: string;
  requestFingerprint: `sha256:${string}`;
  state: 'preparing' | 'committed';
}

export type SubagentSessionRuntimeSummary = Omit<
  SubagentSessionRuntime,
  'systemPrompt' | 'categoryPolicy'
>;

/**
 * Client-facing child-session relation when the durable spawn record remains
 * inside the Runtime Host authority boundary.
 */
export interface SessionSubagentProjection {
  parentSessionId: string;
  agentId?: string;
  agentName?: string;
  profile?: string;
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isSessionBlockedReason(value: unknown): value is SessionBlockedReason {
  return (
    typeof value === 'string' && (SESSION_BLOCKED_REASONS as readonly string[]).includes(value)
  );
}

export function isTurnStatus(value: unknown): value is TurnStatus {
  return typeof value === 'string' && (TURN_STATUSES as readonly string[]).includes(value);
}

// ============================================================================
// Header (JSONL line 1)
// ============================================================================

export const SESSION_TOOL_PROFILES = ['headless-coding-v1'] as const;
export type SessionToolProfile = (typeof SESSION_TOOL_PROFILES)[number];

export function isSessionToolProfile(value: unknown): value is SessionToolProfile {
  return typeof value === 'string' && (SESSION_TOOL_PROFILES as readonly string[]).includes(value);
}

export interface SessionExternalOrigin {
  readonly adapterId: string;
  readonly sourceSessionId: string;
}

export interface SessionHeader {
  // Identity
  id: string;
  workspaceRoot: string;
  cwd: string;
  /** Stable project-catalog association. Null means the user explicitly chose no project. */
  projectId?: string | null;

  // Lifecycle timestamps
  createdAt: number;
  lastUsedAt: number;
  lastMessageAt?: number;

  // User metadata
  name: string;
  titleIsManual: boolean;
  isFlagged: boolean;
  labels: string[];

  isArchived: boolean;
  status: SessionStatus;
  blockedReason?: SessionBlockedReason;
  statusUpdatedAt?: number;
  /** Ordinary branch lineage. Subagent lineage uses subagentParent instead. */
  parentSessionId?: string;
  branchOfTurnId?: string;
  /** Immutable control-plane relation for a linked child-agent session. */
  subagentParent?: SubagentSessionParent;
  /** Immutable runtime/profile snapshot for child-session execution. */
  subagentRuntime?: SubagentSessionRuntime;
  /** Immutable idempotency and initial-run identity for child creation. */
  subagentSpawn?: SubagentSessionSpawn;
  /** Immutable host-managed filesystem isolation for this child Session. */
  subagentWorkspace?: SubagentWorkspaceBinding;
  /** Immutable Host publication identity for a cross-Session conversation copy. */
  conversationCopy?: SessionConversationCopy;
  /** Immutable identity of the external Session imported into this Session. */
  readonly externalOrigin?: SessionExternalOrigin;
  /** Stable root id for an edit-and-resend version family. */
  revisionRootSessionId?: string;
  /** Immediate previous version in the same conversation slot. */
  revisionParentSessionId?: string;
  /** User turn replaced when this revision was created. */
  revisionOfTurnId?: string;
  /** Stable display order inside the revision family; root is implicitly 1. */
  revisionIndex?: number;
  /** Preparing versions are hidden after restart until their first run starts. */
  revisionState?: 'preparing' | 'committed';

  // Unread tracking
  lastReadMessageId?: string;
  hasUnread: boolean;

  // Backend / model config
  backend: PersistedBackendKind;
  llmConnectionSlug: string;
  /** True after first UserMessage is flushed. Storage self-heals (§5.2). */
  connectionLocked: boolean;
  /** Sticky session default model id, captured when the session is created. */
  model: string;
  /** Immutable versioned prompt/tool contract for non-product execution surfaces. */
  toolProfile?: SessionToolProfile;
  /** Per-model reasoning-depth variant; `undefined` = model default. Cleared on model switch. */
  thinkingLevel?: import('./model-thinking.js').ThinkingLevel;
  permissionMode: PermissionMode;
  /** Defaults to `agent` when absent on legacy session records. */
  collaborationMode?: CollaborationMode;
  /** Defaults to `default` when absent on legacy session records. */
  orchestrationMode?: OrchestrationMode;

  /** Zero while an imported transcript is staging; one after materialization. */
  transcriptLedgerVersion?: 0 | 1;

  /** Forward-compatible schema versioning. V0.1 only writes 1. */
  schemaVersion: 1;
}

export type SessionHeaderPatch = Partial<Omit<SessionHeader, 'isArchived'>> & {
  readonly isArchived?: never;
};

/**
 * The backend a live build may select.
 *
 * `'fake'` was retired with the in-process FakeBackend (#3211): nothing in a
 * shipped build may choose it, so it is not a member here. Values read back
 * from durable state use {@link PersistedBackendKind} instead.
 */
export type BackendKind = 'ai-sdk';

/**
 * The backend value a persisted record may carry.
 *
 * Sessions, runs and Automations written by builds that still shipped
 * FakeBackend hold `'fake'` forever. Decode keeps accepting it so those rows
 * stay readable — rewriting them to `'ai-sdk'` would only make an unrunnable
 * task look runnable, since their `llmConnectionSlug` still points at nothing.
 * Activation refuses them with the product's `fake_backend` reason (see the
 * refusal registered in `execution-composition.ts`).
 *
 * Never write this type: writers take {@link BackendKind}.
 */
export type PersistedBackendKind = BackendKind | 'fake';

export interface SessionSummary {
  id: string;
  cwd?: string;
  projectId?: string | null;
  name: string;
  isFlagged: boolean;
  isArchived: boolean;
  labels: string[];
  hasUnread: boolean;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  status: SessionStatus;
  blockedReason?: SessionBlockedReason;
  statusUpdatedAt?: number;
  /**
   * The turns the runtime is running for this session right now. An explicit
   * empty array means the runtime authoritatively knows there are none; omission
   * means the summary source does not know the live state.
   *
   * Projected from the live runs, never persisted: "a run is in flight" is a
   * fact about the running process, so it must read false again after a crash.
   * `status` cannot serve that purpose — it is written to storage, so a crash
   * between a turn's end and its status write leaves `running` behind forever,
   * and it carries no turn identity, reading the same before a turn starts and
   * after it ends.
   *
   * A set rather than one turn because a session can carry concurrent runs: a
   * client asking "is anything OTHER than the turn I sent still running" cannot
   * answer that from an arbitrary one of them.
   *
   * Only populated where the runtime is in a position to know: session LISTS
   * come from the authority holding the runs and include the field even when it
   * is empty. A summary returned by a mutation (rename, model change) describes
   * the header alone and omits it.
   */
  runningTurnIds?: string[];
  parentSessionId?: string;
  branchOfTurnId?: string;
  subagent?: SessionSubagentProjection;
  subagentParent?: SubagentSessionParent;
  subagentRuntime?: SubagentSessionRuntimeSummary;
  subagentWorkspace?: SubagentWorkspaceBinding;
  revisionRootSessionId?: string;
  revisionParentSessionId?: string;
  revisionOfTurnId?: string;
  revisionIndex?: number;
  revisionState?: 'preparing' | 'committed';
  backend: PersistedBackendKind;
  llmConnectionSlug: string;
  /**
   * True once the session has user messages — its connection/model is
   * sticky and compatibility projections never select a replacement target.
   * Surfaced so onboarding can project existing-session health (#1038).
   */
  connectionLocked: boolean;
  /** Sticky session default model id for renderer/header display. */
  model: string;
  /** Per-model reasoning-depth variant; `undefined` = model default. Cleared on model switch. */
  thinkingLevel?: import('./model-thinking.js').ThinkingLevel;
  permissionMode: PermissionMode;
  /** Defaults to `agent` when absent on legacy summaries. */
  collaborationMode?: CollaborationMode;
  /** Defaults to `default` when absent on legacy summaries. */
  orchestrationMode?: OrchestrationMode;
}

export function sessionRevisionFamilyId(
  session: Pick<SessionSummary, 'id' | 'revisionRootSessionId'>,
): string {
  return session.revisionRootSessionId ?? session.id;
}

/**
 * Host-facing projection of linked subagent Sessions.
 *
 * The flat Session list remains the storage/read authority. Hosts use this
 * projection to nest a linked child beneath its durable parent without
 * confusing ordinary branch lineage with subagent ownership. Missing-parent
 * and cyclic relations fail open into roots so an inspectable child can never
 * disappear from the product surface.
 */
export interface LinkedSessionTree {
  roots: SessionSummary[];
  childrenByParentId: ReadonlyMap<string, readonly SessionSummary[]>;
}

export interface LinkedSessionTreeProjectionOptions {
  /**
   * Read-model aliases from durable physical parent ids to visible logical
   * Session ids. Revision projection uses this to keep a child attached when
   * its spawning parent revision is no longer the selected representative.
   */
  parentSessionIdAliases?: ReadonlyMap<string, string>;
}

const SUBAGENT_SESSION_PARENT_SHAPE = defineObjectShape<SubagentSessionParent>()(
  ['kind', 'parentSessionId', 'spawnedBy', 'lifecycle'],
  ['swarm', 'graph'],
);
const SUBAGENT_SESSION_SPAWN_SHAPE = defineObjectShape<SubagentSessionParent['spawnedBy']>()(
  ['parentRunId', 'parentTurnId', 'toolCallId'],
  [],
);
const SUBAGENT_SESSION_SWARM_SHAPE = defineObjectShape<
  NonNullable<SubagentSessionParent['swarm']>
>()(['swarmId', 'itemId'], []);
const SUBAGENT_SESSION_GRAPH_SHAPE = defineObjectShape<
  NonNullable<SubagentSessionParent['graph']>
>()(['graphId', 'workId', 'operatorId'], []);
const SUBAGENT_SESSION_RUNTIME_SHAPE = defineObjectShape<SubagentSessionRuntime>()(
  [
    'schemaVersion',
    'definitionVersion',
    'agentId',
    'agentName',
    'profile',
    'systemPrompt',
    'toolNames',
    'categoryPolicy',
  ],
  ['permissionCeiling', 'presetId'],
);
const SUBAGENT_SESSION_SPAWN_IDENTITY_SHAPE = defineObjectShape<SubagentSessionSpawn>()(
  ['schemaVersion', 'requestFingerprint', 'initialTurnId', 'initialRunId'],
  [],
);
const SESSION_CONVERSATION_COPY_SHAPE = defineObjectShape<SessionConversationCopy>()(
  ['kind', 'sourceSessionId', 'sourceTurnId', 'requestFingerprint', 'state'],
  [],
);
const SESSION_LINEAGE_ID_MAX_CHARS = 512;
const SESSION_LINEAGE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SUBAGENT_RUNTIME_NAME_MAX_CHARS = 512;
const SUBAGENT_RUNTIME_SYSTEM_PROMPT_MAX_CHARS = 100_000;
const SUBAGENT_RUNTIME_TOOL_LIMIT = 128;
const SUBAGENT_REQUEST_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/** Strict decoder guard for the persisted child-session relation. */
export function isSubagentSessionParent(value: unknown): value is SubagentSessionParent {
  if (
    !isRecord(value) ||
    !hasExactShape(value, SUBAGENT_SESSION_PARENT_SHAPE) ||
    value.kind !== 'subagent' ||
    !isSessionLineageId(value.parentSessionId) ||
    value.lifecycle !== 'foreground' ||
    !isRecord(value.spawnedBy) ||
    !hasExactShape(value.spawnedBy, SUBAGENT_SESSION_SPAWN_SHAPE) ||
    !isSessionLineageId(value.spawnedBy.parentRunId) ||
    !isSessionLineageId(value.spawnedBy.parentTurnId) ||
    !isSessionLineageId(value.spawnedBy.toolCallId)
  ) {
    return false;
  }
  const swarmValid =
    value.swarm === undefined ||
    (isRecord(value.swarm) &&
      hasExactShape(value.swarm, SUBAGENT_SESSION_SWARM_SHAPE) &&
      isSessionLineageId(value.swarm.swarmId) &&
      isSessionLineageId(value.swarm.itemId));
  const graphValid =
    value.graph === undefined ||
    (isRecord(value.graph) &&
      hasExactShape(value.graph, SUBAGENT_SESSION_GRAPH_SHAPE) &&
      isSessionLineageId(value.graph.graphId) &&
      isSessionLineageId(value.graph.workId) &&
      isSessionLineageId(value.graph.operatorId));
  return swarmValid && graphValid && !(value.swarm && value.graph);
}

/** Strict decoder guard for the persisted child execution snapshot. */
export function isSubagentSessionRuntime(value: unknown): value is SubagentSessionRuntime {
  if (
    !isRecord(value) ||
    !hasExactShape(value, SUBAGENT_SESSION_RUNTIME_SHAPE) ||
    value.schemaVersion !== SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.definitionVersion) ||
    (value.definitionVersion as number) < 1 ||
    !isSessionLineageId(value.agentId) ||
    !isSessionLineageId(value.profile) ||
    (value.presetId !== undefined && !isSessionLineageId(value.presetId)) ||
    typeof value.agentName !== 'string' ||
    value.agentName.length === 0 ||
    value.agentName.length > SUBAGENT_RUNTIME_NAME_MAX_CHARS ||
    SESSION_LINEAGE_CONTROL_CHARACTERS.test(value.agentName) ||
    typeof value.systemPrompt !== 'string' ||
    value.systemPrompt.length === 0 ||
    value.systemPrompt.length > SUBAGENT_RUNTIME_SYSTEM_PROMPT_MAX_CHARS ||
    value.systemPrompt.includes('\u0000') ||
    !Array.isArray(value.toolNames) ||
    value.toolNames.length > SUBAGENT_RUNTIME_TOOL_LIMIT ||
    !value.toolNames.every(isSessionLineageId) ||
    new Set(value.toolNames).size !== value.toolNames.length ||
    !isSubagentCategoryPolicy(value.categoryPolicy)
  ) {
    return false;
  }
  return value.permissionCeiling === undefined || isPermissionMode(value.permissionCeiling);
}

/** Strict decoder guard for durable child-spawn idempotency metadata. */
export function isSubagentSessionSpawn(value: unknown): value is SubagentSessionSpawn {
  return (
    isRecord(value) &&
    hasExactShape(value, SUBAGENT_SESSION_SPAWN_IDENTITY_SHAPE) &&
    value.schemaVersion === SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION &&
    typeof value.requestFingerprint === 'string' &&
    SUBAGENT_REQUEST_FINGERPRINT_PATTERN.test(value.requestFingerprint) &&
    isSessionLineageId(value.initialTurnId) &&
    isSessionLineageId(value.initialRunId)
  );
}

/** Strict decoder guard for Host-owned conversation-copy publication state. */
export function isSessionConversationCopy(value: unknown): value is SessionConversationCopy {
  return (
    isRecord(value) &&
    hasExactShape(value, SESSION_CONVERSATION_COPY_SHAPE) &&
    (value.kind === 'branch' || value.kind === 'revision') &&
    isSessionLineageId(value.sourceSessionId) &&
    isSessionLineageId(value.sourceTurnId) &&
    typeof value.requestFingerprint === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.requestFingerprint) &&
    (value.state === 'preparing' || value.state === 'committed')
  );
}

export function subagentSessionRuntimeSummary(
  value: SubagentSessionRuntime,
): SubagentSessionRuntimeSummary {
  const { systemPrompt: _systemPrompt, categoryPolicy: _categoryPolicy, ...summary } = value;
  return summary;
}

/** Read-model projection; input order is preserved. */
export function childSessionsForParent(
  sessions: readonly SessionSummary[],
  parentSessionId: string,
): SessionSummary[] {
  return sessions.filter((session) => linkedSubagentParentId(session) === parentSessionId);
}

/** Whether a Session is a linked child in either local or Host projection form. */
export function isLinkedSubagentSession(
  session: Pick<SessionSummary, 'subagent' | 'subagentParent'>,
): boolean {
  return linkedSubagentParentId(session) !== undefined;
}

/** Immediate linked parent session id, if this session is a linked child. */
export function linkedSubagentParentSessionId(
  session: Pick<SessionSummary, 'subagent' | 'subagentParent'>,
): string | undefined {
  return linkedSubagentParentId(session);
}

/** Read-model projection; input order is preserved at every tree level. */
export function projectLinkedSessionTree(
  sessions: readonly SessionSummary[],
  options: LinkedSessionTreeProjectionOptions = {},
): LinkedSessionTree {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const nestedParentByChildId = new Map<string, string>();
  const linkedParentId = (session: SessionSummary): string | undefined => {
    const parentSessionId = linkedSubagentParentId(session);
    if (!parentSessionId) return undefined;
    return options.parentSessionIdAliases?.get(parentSessionId) ?? parentSessionId;
  };

  for (const session of sessions) {
    const parentSessionId = linkedParentId(session);
    if (!parentSessionId) continue;
    if (!sessionsById.has(parentSessionId)) continue;
    if (parentSessionId === session.id) continue;
    if (linkedParentChainContainsCycle(session.id, sessionsById, linkedParentId)) continue;
    nestedParentByChildId.set(session.id, parentSessionId);
  }

  const roots: SessionSummary[] = [];
  const mutableChildren = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const parentSessionId = nestedParentByChildId.get(session.id);
    if (!parentSessionId) {
      roots.push(session);
      continue;
    }
    const children = mutableChildren.get(parentSessionId) ?? [];
    children.push(session);
    mutableChildren.set(parentSessionId, children);
  }

  return {
    roots,
    childrenByParentId: mutableChildren,
  };
}

function linkedSubagentParentId(
  session: Pick<SessionSummary, 'subagent' | 'subagentParent'>,
): string | undefined {
  if (isSubagentSessionParent(session.subagentParent)) {
    return session.subagentParent.parentSessionId;
  }
  return session.subagent?.parentSessionId;
}

function linkedParentChainContainsCycle(
  startSessionId: string,
  sessionsById: ReadonlyMap<string, SessionSummary>,
  linkedParentId: (session: SessionSummary) => string | undefined,
): boolean {
  const visited = new Set<string>();
  let sessionId: string | undefined = startSessionId;
  while (sessionId) {
    if (visited.has(sessionId)) return true;
    visited.add(sessionId);
    const session = sessionsById.get(sessionId);
    if (!session) return false;
    const parentSessionId = linkedParentId(session);
    if (!parentSessionId || !sessionsById.has(parentSessionId)) return false;
    sessionId = parentSessionId;
  }
  return false;
}

function isSessionLineageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SESSION_LINEAGE_ID_MAX_CHARS &&
    !SESSION_LINEAGE_CONTROL_CHARACTERS.test(value)
  );
}

function isSubagentCategoryPolicy(
  value: unknown,
): value is Partial<Record<ToolCategory, PolicyDecision>> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([category, decision]) =>
      isToolCategory(category) &&
      (decision === 'allow' || decision === 'prompt' || decision === 'block'),
  );
}

export type SessionChangedReason =
  | 'created'
  | 'migrated'
  | 'updated'
  | 'archived'
  | 'deleted'
  | 'message-appended'
  | 'pinned'
  | 'renamed'
  | 'mode-change'
  | 'status-change'
  | 'turn-status-change'
  | 'goal-change'
  | 'rebound';

export interface SessionChangedEvent {
  type: 'sessions_changed';
  reason: SessionChangedReason;
  sessionId?: string;
  connectionSlug?: string;
  modelId?: string;
  /**
   * The turn this change is ABOUT, when the change has a turn to name.
   *
   * Naming the turn is what makes a notification a causal answer to a specific
   * send rather than a bare invalidation: the session fields alone carry no
   * turn identity, and `status` reads the same before a turn starts and after
   * it ends.
   *
   * Emitter obligation, and its exact edge: a change about a turn some CLIENT
   * may be waiting on — one it submitted, so it holds a local claim until it
   * hears back — must name that turn. Its start, its refusal to start, and its
   * end all qualify. Changes with no single turn behind them (a rename, a
   * catalog migration) leave it unset, as do turns no client submitted and none
   * is waiting on — a linked child agent's own turns, for instance, which are
   * reported by `SessionSummary.runningTurnIds` instead. A client must never
   * read an unset change as an answer about a turn it is waiting on.
   */
  turnId?: string;
  ts: number;
}

// ============================================================================
// Stored messages (JSONL line 2+, append-only)
// ============================================================================

export type StoredMessage =
  | UserMessage
  | AssistantMessage
  | ToolCallMessage
  | ToolResultMessage
  | PermissionDecisionMessage
  | TokenUsageMessage
  | TurnStateMessage
  | SystemNoteMessage;

export interface UserMessage extends MessageContent {
  type: 'user';
  id: string;
  turnId: string;
  ts: number;
  /** Canonical RuntimeEvent that materialized this mid-Turn steering projection. */
  steeringEventId?: string;
  /** Non-user trigger source. Lets the chat mark turns the user did not
   * hand-type. */
  origin?: TurnOrigin;
}

/** Prefer the human-facing view of a user message when one was stored. */
export function userFacingText(message: Pick<UserMessage, 'text' | 'displayText'>): string {
  return message.displayText ?? message.text;
}

export interface AssistantMessage {
  type: 'assistant';
  id: string;
  turnId: string;
  ts: number;
  text: string;
  /** Provider-owned text metadata such as Responses URL citations. */
  providerOptions?: Record<string, unknown>;
  thinking?: AssistantThinking;
  /**
   * First-observed order of visible content inside this assistant step.
   * RuntimeEvent projection records partial text/thinking and the paired tool
   * call before dropping partial rows, so live and persisted timelines can use
   * the same append-only order. Absent on legacy rows, which retain the older
   * semantic thinking → text → tools fallback.
   */
  contentOrder?: AssistantStepContentKind[];
  /** Actual model used for this turn. */
  modelId: string;
}

export interface AssistantThinkingPart {
  text: string;
  /** Anthropic signed thinking for replay. */
  signature?: string;
  /** Provider-owned replay metadata that must survive missing-ledger recovery. */
  providerOptions?: Record<string, unknown>;
}

export interface AssistantThinking extends AssistantThinkingPart {
  /**
   * Ordered provider reasoning items when one assistant step contains more than
   * one independently replayable item. The aggregate text remains available on
   * the parent for existing readers; single-item rows keep the legacy shape.
   */
  parts?: AssistantThinkingPart[];
}

export type AssistantStepContentKind = 'thinking' | 'text' | 'tools';

export interface ToolCallMessage {
  type: 'tool_call';
  /** Equals toolUseId — used to match ToolResultMessage.toolUseId. */
  id: string;
  turnId: string;
  ts: number;
  toolName: string;
  /** Stable semantic category for presentation; absent on legacy rows. */
  activityKind?: ToolActivityKind;
  displayName?: string;
  intent?: string;
  args: unknown;
  /** Provider-owned opaque call metadata retained for recovery backfill. */
  providerOptions?: Record<string, unknown>;
  providerExecuted?: boolean;
  /**
   * Assistant step this call belongs to (equals the step's AssistantMessage
   * id, stamped from the same source as ToolStartEvent.stepId). Optional for
   * legacy rows written before per-step persistence. First consumer is the UI
   * timeline (materializeTurns), which orders a step's thinking/text ahead of
   * the tools whose stepId matches that step; the backfill path also reads it
   * to re-pair tools with their step after a restart.
   */
  stepId?: string;
  /** Execution surface and replay policy retained for missing-ledger recovery. */
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
  parentToolCallId?: string;
  parentOperationId?: string;
}

export interface ToolResultMessage {
  type: 'tool_result';
  /** Own message id (not the tool's). */
  id: string;
  turnId: string;
  ts: number;
  /** Matches ToolCallMessage.id. */
  toolUseId: string;
  isError: boolean;
  content: ToolResultContent;
  providerExecuted?: boolean;
  /** Raw provider result retained only for provider-native replay. */
  providerOutput?: unknown;
  durationMs?: number;
  /** Execution surface and replay policy retained for missing-ledger recovery. */
  origin?: 'provider' | 'code_mode';
  modelVisibility?: 'visible' | 'hidden';
  parentToolCallId?: string;
  parentOperationId?: string;
}

export interface PermissionDecisionMessage {
  type: 'permission_decision';
  /** Equals PermissionRequestEvent.requestId for audit correlation. */
  id: string;
  turnId: string;
  ts: number;
  toolUseId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  rememberForTurn?: boolean;
  reviewer?: import('./permission.js').ApprovalsReviewer;
  rationale?: string;
  riskLevel?: import('./permission.js').ApprovalRiskLevel;
  hint?: string;
}

export interface TokenUsageMessage extends TokenUsageFields {
  type: 'token_usage';
  id: string;
  turnId: string;
  ts: number;
}

export interface TurnStateMessage {
  type: 'turn_state';
  id: string;
  turnId: string;
  ts: number;
  status: TurnStatus;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  abortedAt?: number;
  /** Diagnostic source for user/renderer-triggered aborts, e.g. renderer.stop_button. */
  abortSource?: string;
  errorClass?: string;
  partialOutputRetained: boolean;
}

export interface TurnRecord {
  turnId: string;
  firstSequence?: number;
  userPromptPreview?: string;
  status: TurnStatus;
  /**
   * Whether `status` came from a `turn_state` message or was reconstructed by
   * `inferLegacyTurnStatus` for a session written before them. Only a recorded
   * status is evidence about this turn; an inferred one is a reading of old
   * data, and callers reconciling against live state must not treat the two
   * alike. Absent on hand-built records, which are treated as non-evidence;
   * `deriveTurnRecords` is the only place that can know.
   */
  statusSource?: 'recorded' | 'inferred';
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  abortedAt?: number;
  abortSource?: string;
  errorClass?: string;
  partialOutputRetained: boolean;
}

export interface SystemNoteMessage {
  type: 'system_note';
  id: string;
  /** Session-level notes omit turnId. */
  turnId?: string;
  ts: number;
  kind:
    | 'session_start'
    | 'session_resume'
    | 'mode_change'
    | 'model_change'
    | 'context_compacted'
    | 'context_compaction_failed_open'
    | 'step_limit'
    | 'error'
    | 'abort';
  /** Shape depends on `kind`. */
  data?: unknown;
}

const USER_MESSAGE_SHAPE = defineObjectShape<UserMessage>()(
  ['type', 'id', 'turnId', 'ts', 'text'],
  ['displayText', 'attachments', 'quotes', 'inlineReferences', 'steeringEventId', 'origin'],
);
const ASSISTANT_MESSAGE_SHAPE = defineObjectShape<AssistantMessage>()(
  ['type', 'id', 'turnId', 'ts', 'text', 'modelId'],
  ['thinking', 'contentOrder', 'providerOptions'],
);
const TOOL_CALL_MESSAGE_SHAPE = defineObjectShape<ToolCallMessage>()(
  ['type', 'id', 'turnId', 'ts', 'toolName', 'args'],
  [
    'activityKind',
    'displayName',
    'intent',
    'providerOptions',
    'providerExecuted',
    'stepId',
    'origin',
    'modelVisibility',
    'parentToolCallId',
    'parentOperationId',
  ],
);
const TOOL_RESULT_MESSAGE_SHAPE = defineObjectShape<ToolResultMessage>()(
  ['type', 'id', 'turnId', 'ts', 'toolUseId', 'isError', 'content'],
  [
    'durationMs',
    'providerExecuted',
    'providerOutput',
    'origin',
    'modelVisibility',
    'parentToolCallId',
    'parentOperationId',
  ],
);
const PERMISSION_DECISION_MESSAGE_SHAPE = defineObjectShape<PermissionDecisionMessage>()(
  ['type', 'id', 'turnId', 'ts', 'toolUseId', 'toolName', 'decision'],
  ['rememberForTurn', 'reviewer', 'rationale', 'riskLevel', 'hint'],
);
const TOKEN_USAGE_MESSAGE_SHAPE = defineObjectShape<TokenUsageMessage>()(
  ['type', 'id', 'turnId', 'ts', 'input', 'output'],
  [
    'cacheHitInput',
    'cacheMissInput',
    'cacheWriteInput',
    'cacheMissInputSource',
    'reasoning',
    'total',
    'rawFinishReason',
    'runtimeSteps',
    'cacheRead',
    'cacheCreation',
    'costUsd',
    'systemPromptHash',
    'contextRemaining',
    'prefixHash',
    'prefixChangeReason',
    'requestShapeHash',
    'requestShapeChangeReason',
    'promptSegments',
    'contextBudget',
    'providerRequestTraceId',
  ],
);
const TURN_STATE_MESSAGE_SHAPE = defineObjectShape<TurnStateMessage>()(
  ['type', 'id', 'turnId', 'ts', 'status', 'partialOutputRetained'],
  [
    'parentTurnId',
    'retriedFromTurnId',
    'regeneratedFromTurnId',
    'branchOfTurnId',
    'parentSessionId',
    'abortedAt',
    'abortSource',
    'errorClass',
  ],
);
const SYSTEM_NOTE_MESSAGE_SHAPE = defineObjectShape<SystemNoteMessage>()(
  ['type', 'id', 'ts', 'kind'],
  ['turnId', 'data'],
);
const ASSISTANT_THINKING_PART_SHAPE = defineObjectShape<AssistantThinkingPart>()(
  ['text'],
  ['signature', 'providerOptions'],
);
const ASSISTANT_THINKING_SHAPE = defineObjectShape<AssistantThinking>()(
  ['text'],
  ['signature', 'providerOptions', 'parts'],
);
const SYSTEM_NOTE_KINDS = new Set([
  'session_start',
  'session_resume',
  'mode_change',
  'model_change',
  'context_compacted',
  'context_compaction_failed_open',
  'step_limit',
  'error',
  'abort',
]);

export function decodeStoredMessage(value: unknown): StoredMessage {
  const message = decodeStoredMessageContent(value, decodeCanonicalToolResultContent);
  if (!isRecord(message)) throw new Error('Invalid stored message schema');
  switch (message.type) {
    case 'user':
      if (
        hasExactShape(message, USER_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        (message.origin === undefined || decodeTurnOrigin(message.origin) !== undefined)
      ) {
        const { displayText, attachments, quotes, inlineReferences, origin, ...envelope } = message;
        const decodedOrigin = origin === undefined ? undefined : decodeTurnOrigin(origin);
        try {
          return {
            ...envelope,
            ...decodeMessageContent({
              text: message.text,
              displayText,
              attachments,
              quotes,
              inlineReferences,
            }),
            ...(decodedOrigin !== undefined ? { origin: decodedOrigin } : {}),
          } as unknown as UserMessage;
        } catch {
          break;
        }
      }
      break;
    case 'assistant':
      if (
        hasExactShape(message, ASSISTANT_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.text === 'string' &&
        typeof message.modelId === 'string' &&
        (message.providerOptions === undefined || isRecord(message.providerOptions)) &&
        (message.thinking === undefined || isAssistantThinking(message.thinking)) &&
        (message.contentOrder === undefined ||
          (Array.isArray(message.contentOrder) &&
            message.contentOrder.every(
              (item) => item === 'thinking' || item === 'text' || item === 'tools',
            )))
      )
        return message as unknown as AssistantMessage;
      break;
    case 'tool_call':
      if (
        hasExactShape(message, TOOL_CALL_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.toolName === 'string' &&
        Object.hasOwn(message, 'args') &&
        (message.activityKind === undefined ||
          (TOOL_ACTIVITY_KINDS as readonly unknown[]).includes(message.activityKind)) &&
        isOptionalString(message.displayName) &&
        isOptionalString(message.intent) &&
        (message.providerOptions === undefined || isRecord(message.providerOptions)) &&
        (message.providerExecuted === undefined || typeof message.providerExecuted === 'boolean') &&
        isOptionalString(message.stepId) &&
        isToolActivityIdentity(message)
      )
        return message as unknown as ToolCallMessage;
      break;
    case 'tool_result':
      if (
        hasExactShape(message, TOOL_RESULT_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.toolUseId === 'string' &&
        typeof message.isError === 'boolean' &&
        (message.providerExecuted === undefined || typeof message.providerExecuted === 'boolean') &&
        isOptionalFiniteDuration(message.durationMs) &&
        isToolActivityIdentity(message)
      )
        return message as unknown as ToolResultMessage;
      break;
    case 'permission_decision':
      if (
        hasExactShape(message, PERMISSION_DECISION_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        typeof message.toolUseId === 'string' &&
        typeof message.toolName === 'string' &&
        isPermissionDecisionFields(message, { allowHint: true })
      )
        return message as unknown as PermissionDecisionMessage;
      break;
    case 'token_usage':
      if (
        hasExactShape(message, TOKEN_USAGE_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        isTokenUsageFields(message) &&
        isOptionalString(message.providerRequestTraceId)
      )
        return message as unknown as TokenUsageMessage;
      break;
    case 'turn_state':
      if (
        hasExactShape(message, TURN_STATE_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, true) &&
        isTurnStatus(message.status) &&
        typeof message.partialOutputRetained === 'boolean' &&
        isOptionalString(message.parentTurnId) &&
        isOptionalString(message.retriedFromTurnId) &&
        isOptionalString(message.regeneratedFromTurnId) &&
        isOptionalString(message.branchOfTurnId) &&
        isOptionalString(message.parentSessionId) &&
        (message.abortedAt === undefined || isFiniteNumber(message.abortedAt)) &&
        isOptionalString(message.abortSource) &&
        isOptionalString(message.errorClass)
      )
        return message as unknown as TurnStateMessage;
      break;
    case 'system_note':
      if (
        hasExactShape(message, SYSTEM_NOTE_MESSAGE_SHAPE) &&
        hasMessageEnvelope(message, false) &&
        isOptionalString(message.turnId) &&
        SYSTEM_NOTE_KINDS.has(message.kind as string)
      )
        return message as unknown as SystemNoteMessage;
      break;
  }
  throw new Error('Invalid stored message schema');
}

function decodeStoredMessageContent(
  value: unknown,
  decodeToolResultContent: (content: unknown) => ToolResultContent,
): unknown {
  if (!isRecord(value) || value.type !== 'tool_result') return value;
  return {
    ...value,
    content: decodeToolResultContent(value.content),
  };
}

function hasMessageEnvelope(value: Record<string, unknown>, turnRequired: boolean): boolean {
  return (
    typeof value.id === 'string' &&
    isFiniteNumber(value.ts) &&
    (turnRequired ? typeof value.turnId === 'string' : true)
  );
}

function isAssistantThinkingPart(value: unknown): value is AssistantThinkingPart {
  return (
    isRecord(value) &&
    hasExactShape(value, ASSISTANT_THINKING_PART_SHAPE) &&
    typeof value.text === 'string' &&
    isOptionalString(value.signature) &&
    (value.providerOptions === undefined || isRecord(value.providerOptions))
  );
}

function isAssistantThinking(value: unknown): value is AssistantThinking {
  return (
    isRecord(value) &&
    hasExactShape(value, ASSISTANT_THINKING_SHAPE) &&
    typeof value.text === 'string' &&
    isOptionalString(value.signature) &&
    (value.providerOptions === undefined || isRecord(value.providerOptions)) &&
    (value.parts === undefined ||
      (Array.isArray(value.parts) &&
        value.parts.length > 0 &&
        value.parts.every(isAssistantThinkingPart)))
  );
}

function isOptionalFiniteDuration(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isToolActivityIdentity(value: Record<string, unknown>): boolean {
  return (
    (value.origin === undefined || value.origin === 'provider' || value.origin === 'code_mode') &&
    (value.modelVisibility === undefined ||
      value.modelVisibility === 'visible' ||
      value.modelVisibility === 'hidden') &&
    isOptionalString(value.parentToolCallId) &&
    isOptionalString(value.parentOperationId)
  );
}

export const STEP_LIMIT_NOTICE_TEXT =
  'Reached the configured step limit. The task may be incomplete. Send “continue” to resume.';

/**
 * View-boundary facts for explaining a model selection without adding a
 * second persisted model authority. Assistant rows already record the actual
 * model used by each completed step, so the latest such row is the only
 * durable model fact the switcher needs.
 */
export function deriveModelSwitchTranscript(messages: readonly StoredMessage[]): {
  hasConversation: boolean;
  lastUsedModel?: string;
} {
  let lastUsedModel: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== 'assistant') continue;
    lastUsedModel = message.modelId;
    break;
  }
  return {
    hasConversation: messages.length > 0,
    ...(lastUsedModel ? { lastUsedModel } : {}),
  };
}

export function deriveTurnRecords(messages: readonly StoredMessage[]): TurnRecord[] {
  const order: string[] = [];
  const buckets = new Map<string, StoredMessage[]>();
  for (const message of messages) {
    const turnId = (message as { turnId?: string }).turnId;
    if (!turnId) continue;
    if (!buckets.has(turnId)) {
      buckets.set(turnId, []);
      order.push(turnId);
    }
    buckets.get(turnId)!.push(message);
  }

  return order.map((turnId) => {
    const bucket = buckets.get(turnId) ?? [];
    const latestState = bucket
      .filter((message): message is TurnStateMessage => message.type === 'turn_state')
      .at(-1);
    const partialOutputRetained = bucket.some(
      (message) =>
        (message.type === 'assistant' && message.text.trim().length > 0) ||
        message.type === 'tool_result',
    );
    if (latestState) {
      return {
        turnId,
        status: latestState.status,
        statusSource: 'recorded',
        ...(latestState.parentTurnId ? { parentTurnId: latestState.parentTurnId } : {}),
        ...(latestState.retriedFromTurnId
          ? { retriedFromTurnId: latestState.retriedFromTurnId }
          : {}),
        ...(latestState.regeneratedFromTurnId
          ? { regeneratedFromTurnId: latestState.regeneratedFromTurnId }
          : {}),
        ...(latestState.branchOfTurnId ? { branchOfTurnId: latestState.branchOfTurnId } : {}),
        ...(latestState.parentSessionId ? { parentSessionId: latestState.parentSessionId } : {}),
        ...(latestState.abortedAt !== undefined ? { abortedAt: latestState.abortedAt } : {}),
        ...(latestState.abortSource ? { abortSource: latestState.abortSource } : {}),
        ...(latestState.errorClass ? { errorClass: latestState.errorClass } : {}),
        partialOutputRetained: latestState.partialOutputRetained || partialOutputRetained,
      };
    }
    return {
      turnId,
      status: inferLegacyTurnStatus(bucket),
      statusSource: 'inferred',
      partialOutputRetained,
    };
  });
}

function inferLegacyTurnStatus(messages: readonly StoredMessage[]): TurnStatus {
  if (messages.some((message) => message.type === 'system_note' && message.kind === 'abort'))
    return 'aborted';
  if (messages.some((message) => message.type === 'assistant')) return 'completed';
  if (messages.some((message) => message.type === 'tool_result' && message.isError))
    return 'failed';
  return 'completed';
}
