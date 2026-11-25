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

import type {
  AgentRoomReaction,
  HistoryOrder,
  HistoryRowAddress,
} from '../../../../packages/plugin-sdk/src/index.js';
import { host } from 'nsh';
import { currentLocale, tr } from './locale';

export type HostViewFilter =
  | { kind: 'all_computers' }
  | { kind: 'single_computer'; root_id: string };

export interface SavedHostItem {
  rootId: string;
  hostName: string;
  peerId: string;
  endpoints: string[];
  connected: boolean; // Legacy selected-Host projection.
  status?: HostConnectionState['status'];
  relayUrls?: string[];
}

export interface ActiveHostInfo {
  rootId: string;
  hostName: string;
  epoch: string;
  session: string;
  endpoints: string[];
  pathSummary: PathSummary | null;
  transport: 'quic' | 'websocket';
}

export interface PathSummary {
  kind: 'direct' | 'relay';
  rttMs: number;
}

export function pathLabel(
  path: PathSummary | null | undefined,
  transport?: ActiveHostInfo['transport'],
): string {
  if (transport === 'websocket') return tr('WebSocket');
  if (!path) return tr('QUIC');
  return tr(path.kind === 'direct' ? 'Direct QUIC · {latency} ms' : 'Relay · {latency} ms', {
    latency: new Intl.NumberFormat(currentLocale()).format(path.rttMs),
  });
}

export type HostConnectionState =
  | { status: 'offline' | 'connecting' }
  | { status: 'connected'; connection: ActiveHostInfo }
  | { status: 'error'; error: string };

export interface HostStateSnapshot {
  revision: number;
  devicePeerId: string;
  filter: HostViewFilter;
  hosts: SavedHostItem[];
  active: ActiveHostInfo | null;
  activeRootId?: string | null;
  connections?: Record<string, HostConnectionState>;
  pendingPairUri?: string;
  disconnectReason?: string;
  disconnectedRootId?: string;
}

export interface BootstrapSnapshot extends HostStateSnapshot {}

export interface ParsedTicketInfo {
  pairingId: number;
  rootId: string;
  hostName: string;
  peerId: string;
  sasCode: string;
  devicePeerId: string;
  pathSummary: PathSummary | null;
}

export interface SubscriptionHandle {
  subscriptionId: string;
  generation: number;
}

export interface SubscriptionItemPayload {
  rootId?: string;
  subscriptionId: string;
  generation: number;
  item: unknown;
}

export interface SubscriptionEndedPayload {
  rootId?: string;
  subscriptionId: string;
  generation: number;
  error?: string;
}

/* ---- Agent contract wire models (aligned 1:1 with plugins/agent/api & facts) ---- */

export interface AgentProject {
  reference: { id: string; revision: string };
  name: string;
  archived: boolean;
  available: boolean;
  path: string | null;
}

export type AgentBackendPreference =
  | {
      kind: 'model';
      connectionId: string;
      modelId: string;
      serviceTier?: string | null;
      thinkingLevel?: string | null;
    }
  | {
      kind: 'executor';
      selection: {
        executor: string;
        settings?: Record<string, unknown>;
      };
    };

export interface AgentModelChoice {
  selection: AgentBackendPreference;
  aliases?: AgentBackendPreference[];
  sourceName: string;
  label: string;
  thinkingLevels: string[];
  defaultThinkingLevel: string | null;
}

export type AgentWorkspaceSelection =
  | { kind: 'project'; projectId: string; path: string }
  | { kind: 'directory'; path: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'isolated_git'; path: string };

export interface AgentGoalDetail {
  id: string;
  revision: number;
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'achieved' | 'cancelled' | string;
  iterations: number;
  tokenBudget: number | null;
  consumed?: { known: number; missing: number };
  remainingTokens: number | null;
  elapsedSeconds: number;
  retryAt: number | null;
  createdAt: number;
  pending: boolean;
  dismissed: boolean;
  report?: { status?: string; note?: string } | null;
  note: string;
}

export interface AgentGoalView {
  enabled: boolean;
  current: AgentGoalDetail | null;
}

export interface AgentSession {
  id: string;
  title: string;
  kind: 'agent' | 'room';
  parentSessionId: string | null;
  backend?: AgentBackendPreference | null;
  labels: string[];
  workspace: {
    path?: string;
    name?: string;
    projectId?: string | null;
  };
  revision: number;
  updatedAt: number;
  archived: boolean;
  pinned: boolean;
  hasUnread: boolean;
  tailMessageId?: string | null;
  activity: 'idle' | 'working' | 'waiting';
}

export interface AgentSessionPage {
  revision: string;
  needsYouCount: number;
  sessions: AgentSession[];
  before: string | null;
  after: string | null;
}

export interface AgentRun {
  backend: 'model' | 'executor';
  runId: string;
  turnId: string;
  state: 'admitted' | 'running' | 'waiting_for_user';
}

export interface AgentObservation {
  session: AgentSession;
  lastCompletedTurnId: string | null;
  compacting: { id: string; startedAt: number } | null;
  latestRunId?: string | null;
  through: number;
  run: AgentRun | null;
  parts: unknown[];
  toolSeeds: unknown[];
}

export interface AgentHistoryChunk {
  field: 'thinking' | 'body';
  position: HistoryRowAddress;
  order: HistoryOrder;
  offset: number;
  messageId: string | null;
  turnId: string | null;
  timestamp: number | null;
  role: string;
  text: string;
  tool?: {
    toolUseId?: string;
    name?: string;
    title?: string | { text?: string };
    input?: unknown;
    isError?: boolean;
  } | null;
  finalOutput?: boolean;
}

export interface AgentExecutionIdentity {
  sessionId: string;
  turnId: string;
  runId: string;
}

export type AgentRoomAuthor =
  | { kind: 'human' }
  | { kind: 'session'; execution: AgentExecutionIdentity };

export interface AgentRoomMessage {
  id: string;
  sequence: number;
  at: number;
  author: AgentRoomAuthor;
  content: {
    text: string;
  };
  replyTo: string | null;
  mentions: string[];
  deliveries?: unknown[];
  reactions: AgentRoomReaction[];
  deletedAt?: number;
}

export type AgentHistoryPage =
  | {
      kind: 'ready';
      through: number | null;
      chunks: AgentHistoryChunk[];
      before: unknown;
      after: unknown;
    }
  | {
      kind: 'room';
      page: {
        items: AgentRoomMessage[];
        through: number;
        before: string | null;
        after: string | null;
      };
    };

export type AgentDeliveryFact =
  | { kind: 'opened' }
  | { kind: 'executor_started' }
  | { kind: 'executor_message_started'; messageId: string; stepId: string; attemptId: string }
  | { kind: 'executor_text_changed'; messageId: string; thinking: boolean }
  | { kind: 'transcript_changed' }
  | { kind: 'step_ended'; stepId: string; attemptId: string; completed: boolean }
  | {
      kind: 'part_committed';
      stepId: string;
      attemptId: string;
      messageId: string;
      ordinal: number;
    }
  | { kind: 'delta'; stepId: string; attemptId: string; partId: string; text: string }
  | { kind: 'tool_input_ready'; toolUseId: string; name: string; providerExecuted: boolean }
  | { kind: 'tool_dispatched'; toolUseId: string; name: string; title: unknown }
  | { kind: 'tool_rejected'; toolUseId: string }
  | { kind: 'tool_settled'; toolUseId: string; settlement: unknown }
  | { kind: 'provider_tool_result'; toolUseId: string; isError: boolean }
  | { kind: 'executor_tool_start'; toolUseId: string; name: string; title?: unknown }
  | { kind: 'executor_tool_progress'; toolUseId: string; text: string }
  | { kind: 'executor_tool_result'; toolUseId: string; isError: boolean }
  | { kind: 'ended'; failed: boolean };

export interface AgentDelivery {
  sequence: number;
  runId: string;
  turnId: string;
  fact: AgentDeliveryFact;
}

export type AgentPreviewField =
  | { kind: 'text'; textKind: 'text' | 'thinking'; finalAnswer?: boolean }
  | { kind: 'tool_input'; toolUseId: string; name: string; providerExecuted: boolean };

export interface AgentPreviewPart {
  ordinal: number | null;
  messageId: string;
  providerPartId: string | null;
  startedAt: number;
  field: AgentPreviewField;
  offset: number;
  totalBytes: number;
  text: string;
}

export type AgentPreviewPage =
  | { kind: 'empty'; hostEpoch: string }
  | {
      kind: 'cut';
      hostEpoch: string;
      runId: string;
      turnId: string;
      stepId: string;
      attemptId: string;
      revision: number;
      dependsOn: number;
      first: boolean;
      last: boolean;
      parts: AgentPreviewPart[];
    };

export interface AgentQueueEntry {
  messageId: string;
  kind: 'in_flight' | 'steering' | 'followup' | 'held';
  preview: string;
  origin?: { kind: string } | null;
}

export interface AgentQueue {
  revision: number;
  entries: AgentQueueEntry[];
}

export type AgentQueueRead =
  | { kind: 'ready'; revision: number; message: string; hasAttachments: boolean; quotes: unknown[] }
  | { kind: 'revision_conflict'; expected: number; actual: number }
  | { kind: 'missing'; reason: string };

export type AgentQueueMutationResult =
  | { kind: 'committed'; revision: number }
  | { kind: 'revision_conflict'; expected: number; actual: number }
  | { kind: 'rejected'; reason: string };

export type AgentDeliveryPage =
  | { kind: 'room'; through: number }
  | { kind: 'events'; through: number; nextAfter: number; events: AgentDelivery[] }
  | { kind: 'preview'; page: AgentPreviewPage }
  | { kind: 'queue'; queue: AgentQueue }
  | {
      kind: 'interactions';
      pending: { revision: number; entries: AgentInteractionSummary[] };
    }
  | { kind: 'computer_apps'; apps: unknown };

export interface AgentInteractionSummary {
  requestId: string;
  kind:
    | 'session_approval'
    | 'service_approval'
    | 'question'
    | 'permissions'
    | 'form'
    | 'client_capability'
    | 'computer_app'
    | 'system_permission';
  toolUseId: string | null;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestionItem {
  question: string;
  options: AgentQuestionOption[];
}

export interface AgentPermissionRequestPayload {
  reason: string;
  command: { command: string; cwd: string } | null;
  permissions: Record<string, unknown>;
  source?: string;
}

export type AgentInteractionRequest =
  | {
      kind: 'permissions';
      target: unknown;
      toolUseId: string | null;
      basis: unknown;
      request: AgentPermissionRequestPayload;
    }
  | {
      kind: 'question';
      toolUseId: string;
      questions: AgentQuestionItem[];
    }
  | {
      kind: 'session_approval';
      toolUseId: string;
      basis: unknown;
      sessionId: string;
      requestId: string;
      answer: unknown;
    }
  | {
      kind: 'service_approval';
      toolUseId: string;
      toolName: string;
      service: string;
      method: string;
      binding: string;
      through: number;
    }
  | {
      kind: 'client_capability';
      toolUseId: string;
      target: {
        providerId?: string;
        toolName?: string;
        capability?: string;
        serverId?: string;
      };
    }
  | {
      kind: 'computer_app';
      toolUseId: string;
      nativeOperationId: string;
      display: {
        name: string;
        appPath: string;
        risk: string | null;
        warning: string | null;
      };
      allowAlways: boolean;
      authorityRevision: number;
    }
  | {
      kind: 'form';
      toolUseId: string;
      message: string;
    }
  | {
      kind: 'system_permission';
      toolUseId: string;
      grants: string[];
      application: string;
    };

export interface AgentInteractionRecord {
  execution?: unknown;
  requestId: string;
  createdAt?: number;
  request: AgentInteractionRequest;
  outcome: unknown;
}

export interface AgentScheduledSummary {
  id: string;
  revision: number;
  title: string;
  sessionId: string;
  script: boolean;
  approved: boolean;
  status: 'active' | 'paused' | 'completed' | 'expired';
  backgroundFollowup?: boolean;
  nextFireAt: number | null;
  pendingFire: string | null;
  lastError: string | null;
}

export interface AgentGitWorkspaceDiff {
  patch: string;
  truncated: boolean;
  skippedFiles: number;
}

/* ---- Low-level nsh/host transport ---- */

export function bootstrap(): Promise<BootstrapSnapshot> {
  return host.call('ios.bootstrap', {}) as Promise<BootstrapSnapshot>;
}

export function beginPairing(
  uri: string,
  relayUrl?: string,
  relayToken?: string,
): Promise<ParsedTicketInfo> {
  return host.call('ios.beginPairing', { uri, relayUrl, relayToken }) as Promise<ParsedTicketInfo>;
}

export function confirmPairing(pairingId: number, sas: string): Promise<HostStateSnapshot> {
  return host.call('ios.confirmPairing', { pairingId, sas }) as Promise<HostStateSnapshot>;
}

export function cancelPairing(rootId?: string): Promise<unknown> {
  return host.call('ios.cancelPairing', { rootId });
}

export function connectWebSocket(
  endpoint: string,
  rootId: string,
  bearer: string,
  clientInstance?: string,
): Promise<HostStateSnapshot> {
  return host.call('ios.connectWebSocket', {
    endpoint,
    rootId,
    bearer,
    clientInstance,
  }) as Promise<HostStateSnapshot>;
}

export function connectHost(
  rootId: string,
  relayUrl?: string,
  relayToken?: string,
): Promise<HostStateSnapshot> {
  return host.call('ios.connectHost', {
    rootId,
    relayUrl,
    relayToken,
  }) as Promise<HostStateSnapshot>;
}

export function disconnectHost(rootId?: string): Promise<HostStateSnapshot> {
  return host.call('ios.disconnectHost', { rootId }) as Promise<HostStateSnapshot>;
}

export function removeHost(rootId: string): Promise<HostStateSnapshot> {
  return host.call('ios.removeHost', { rootId }) as Promise<HostStateSnapshot>;
}

export function setFilter(filter: HostViewFilter): Promise<HostStateSnapshot> {
  return host.call('ios.setFilter', { filter }) as Promise<HostStateSnapshot>;
}

let anchorSession: string | undefined;

export function setAnchorSession(session: string | undefined) {
  anchorSession = session;
}

export async function hostQuery<T = unknown>(
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
  targetAnchor = anchorSession,
  rootId?: string,
): Promise<T> {
  const res = (await host.call('ios.hostQuery', {
    anchorSession: rootId ? undefined : targetAnchor,
    rootId,
    endpoint,
    method,
    input,
  })) as {
    value: T;
  };
  return res.value;
}

export async function hostMutate<T = unknown>(
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
  { rootId, secret, progressId }: { rootId?: string; secret?: string; progressId?: string } = {},
): Promise<T> {
  const res = (await host.call('ios.hostMutate', {
    anchorSession: rootId ? undefined : anchorSession,
    rootId,
    endpoint,
    method,
    input,
    secret,
    progressId,
  })) as {
    value: T;
  };
  return res.value;
}

export function subscribe(
  subscriptionId: string,
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
  rootId?: string,
): Promise<SubscriptionHandle> {
  return host.call('ios.subscribe', {
    subscriptionId,
    rootId,
    anchorSession: rootId ? undefined : anchorSession,
    endpoint,
    method,
    input,
  }) as Promise<SubscriptionHandle>;
}

export function unsubscribe(subscriptionId: string, rootId?: string): Promise<{ cancelled: boolean }> {
  return host.call('ios.unsubscribe', { subscriptionId, rootId }) as Promise<{ cancelled: boolean }>;
}

export interface MutationProgress {
  rootId: string;
  progressId: string;
  value: unknown;
}

export function onMutationProgress(listener: (progress: MutationProgress) => void): () => void {
  return host.on('ios.mutationProgress', (data) => listener(data as MutationProgress));
}

export function onHostState(listener: (state: HostStateSnapshot) => void): () => void {
  return host.on('ios.hostState', (payload) => {
    if (payload && typeof payload === 'object') {
      listener(payload as HostStateSnapshot);
    }
  });
}

export function onOperationRecovery(
  listener: (status: { session: string; settled: number; pending: number }) => void,
): () => void {
  return host.on('ios.operationRecovery', (data) => {
    if (data && typeof data === 'object')
      listener(data as { session: string; settled: number; pending: number });
  });
}

export function onSubscriptionItem(
  listener: (payload: SubscriptionItemPayload) => void,
): () => void {
  return host.on('ios.subscriptionItem', (payload) => {
    if (payload && typeof payload === 'object') {
      listener(payload as SubscriptionItemPayload);
    }
  });
}

export function onSubscriptionEnded(
  listener: (payload: SubscriptionEndedPayload) => void,
): () => void {
  return host.on('ios.subscriptionEnded', (payload) => {
    if (payload && typeof payload === 'object') {
      listener(payload as SubscriptionEndedPayload);
    }
  });
}

/* ---- Typed Agent Host RPC helpers ---- */

export function hasAgentEndpoint(active: ActiveHostInfo | null): boolean {
  return !!active && active.endpoints.includes('agent');
}

export async function agentListProjects(): Promise<AgentProject[]> {
  const page = await hostQuery<{ kind: string; projects?: AgentProject[] }>('agent', 'projects', {
    kind: 'list',
    cursor: null,
  });
  return page && page.kind === 'projects' && Array.isArray(page.projects) ? page.projects : [];
}

export function agentListSessions(
  filter: 'all' | 'archived' | 'needs_you' = 'all',
  titleQuery = '',
  after?: { revision: string; cursor: string } | null,
): Promise<AgentSessionPage> {
  return hostQuery<AgentSessionPage>('agent', 'list', {
    kind: null,
    filter,
    includeArchived: filter === 'archived',
    rootsOnly: false,
    position: after
      ? { kind: 'after', revision: after.revision, cursor: after.cursor }
      : { kind: 'start' },
    scope: { kind: 'all' },
    titleQuery,
  });
}

export async function agentListDirectoryRoots(): Promise<{ name: string; path: string }[]> {
  const page = await hostQuery<{ kind: string; roots?: { name: string; path: string }[] }>(
    'agent',
    'directories',
    { kind: 'roots' },
  );
  return page && page.kind === 'roots' && Array.isArray(page.roots) ? page.roots : [];
}

export async function agentListDirectoryChildren(
  path: string,
  after: string | null = null,
): Promise<{
  directory: { name: string; path: string } | null;
  children: { name: string; path: string }[];
  after: string | null;
}> {
  const page = await hostQuery<{
    kind: string;
    directory?: { name: string; path: string };
    children?: { name: string; path: string }[];
    after?: string | null;
  }>('agent', 'directories', { kind: 'children', path, after });
  if (page && page.kind === 'children' && Array.isArray(page.children)) {
    return {
      directory: page.directory ?? null,
      children: page.children,
      after: page.after ?? null,
    };
  }
  return { directory: null, children: [], after: null };
}

export async function agentCreateSession(params: {
  title: string;
  kind: 'agent' | 'room';
  workspace: AgentWorkspaceSelection;
  automaticTitle: boolean;
  backend?: AgentBackendPreference | null;
}): Promise<AgentSession> {
  const res = await hostMutate<
    | { kind: 'created'; session: AgentSession }
    | { kind: 'rejected'; reason: unknown }
    | AgentSession
  >('agent', 'create', {
    incognito: false,
    kind: params.kind,
    presetId: null,
    backend: params.kind === 'room' ? null : (params.backend ?? null),
    automaticTitle: params.kind === 'room' ? false : params.automaticTitle,
    tools: null,
    title: params.title,
    labels: [],
    workspace: params.workspace,
  });
  if (res && typeof res === 'object' && 'kind' in res) {
    if (res.kind === 'created' && 'session' in res && res.session) {
      return res.session;
    }
    if (res.kind === 'rejected') {
      const reason = 'reason' in res ? res.reason : 'unknown';
      throw new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
    }
  }
  return res as AgentSession;
}

export function agentUpdateMetadata(params: {
  sessionId: string;
  expectedRevision: number;
  title: string;
  labels: string[];
  pinned?: boolean;
}): Promise<
  | { kind: 'committed'; session: AgentSession }
  | { kind: 'revision_conflict'; expected: number; actual: number }
  | { kind: 'rejected'; reason: unknown }
> {
  return hostMutate('agent', 'metadata', {
    sessionId: params.sessionId,
    expectedRevision: params.expectedRevision,
    title: params.title,
    labels: params.labels,
    ...(params.pinned === undefined ? {} : { pinned: params.pinned }),
  });
}

export function agentChangeSession(
  sessionId: string,
  expectedRevision: number,
  action: 'archive' | 'restore' | 'remove',
): Promise<
  | { kind: 'changed'; session: AgentSession }
  | { kind: 'removed'; sessionId: string }
  | { kind: 'revision_conflict'; expected: number; actual: number }
  | { kind: 'rejected'; reason: unknown }
> {
  return hostMutate('agent', 'changeSession', {
    sessionId,
    expectedRevision,
    action,
  });
}

export function agentMarkRead(
  sessionId: string,
  messageId: string,
): Promise<{ kind: 'observed'; session: AgentSession } | { kind: 'rejected'; reason: unknown }> {
  return hostMutate('agent', 'markRead', { sessionId, messageId });
}

export async function agentListModels(query = ''): Promise<AgentModelChoice[]> {
  const page = await hostQuery<{ kind: string; choices?: AgentModelChoice[] }>('agent', 'models', {
    kind: 'start',
    query,
  });
  return page && page.kind === 'ready' && Array.isArray(page.choices) ? page.choices : [];
}

export function agentSelectBackend(
  sessionId: string,
  backend: AgentBackendPreference,
): Promise<{ kind: string; session?: AgentSession; reason?: unknown }> {
  return hostMutate('agent', 'selectBackend', { sessionId, backend });
}

export function agentReadGoal(sessionId: string): Promise<AgentGoalView> {
  return hostQuery<AgentGoalView>('agent', 'goal', { sessionId });
}

export function agentControlGoal(
  sessionId: string,
  goalId: string,
  revision: number,
  action: 'pause' | 'resume' | 'cancel' | 'dismiss',
): Promise<
  | { kind: 'committed'; goalId: string; revision: number }
  | { kind: 'conflict'; actual: number | null }
  | { kind: 'rejected'; reason: string }
> {
  return hostMutate('agent', 'changeGoal', {
    kind: 'control',
    sessionId,
    goalId,
    revision,
    action,
  });
}

export function agentOpenBot(): Promise<{ kind: string; sessionId?: string }> {
  return hostMutate<{ kind: string; sessionId?: string }>('agent', 'openBot', {
    workspace: null,
    title: null,
  });
}

export function agentObserve(sessionId: string): Promise<AgentObservation> {
  return hostQuery<AgentObservation>('agent', 'observe', { sessionId });
}

export function agentHistory(
  sessionId: string,
  opts?: {
    through?: number | null;
    position?:
      | { kind: 'tail' }
      | { kind: 'before'; cursor: unknown }
      | { kind: 'before_message' | 'around_message'; messageId: string };
  },
): Promise<AgentHistoryPage> {
  return hostQuery<AgentHistoryPage>('agent', 'history', {
    sessionId,
    through: opts?.through ?? null,
    position: opts?.position ?? { kind: 'tail' },
    includeThinking: true,
    view: 'conversation',
  });
}

export function agentSetRoomReaction(
  sessionId: string,
  messageId: string,
  emoji: string,
  add: boolean,
): Promise<{ kind: string }> {
  return hostMutate('agent', 'roomManage', {
    sessionId,
    action: { kind: 'react', messageId, emoji, add },
  });
}

export function agentQueueMessage(
  sessionId: string,
  messageId: string,
  expectedRevision: number,
): Promise<AgentQueueRead> {
  return hostQuery('agent', 'queueMessage', { sessionId, messageId, expectedRevision });
}

export function agentEditQueue(
  sessionId: string,
  expectedRevision: number,
  edit:
    | { kind: 'update'; messageId: string; message: string }
    | { kind: 'reorder'; messageIds: string[] },
): Promise<AgentQueueMutationResult> {
  return hostMutate('agent', 'editQueue', { sessionId, expectedRevision, edit });
}

export function agentSend(
  sessionId: string,
  message: string,
  delivery: 'steer' | 'queue',
  opts?: {
    mentions?: string[];
    expectedRunId?: string | null;
    backend?: AgentBackendPreference | null;
  },
): Promise<{
  kind: string;
  sessionId?: string;
  runId?: string;
  messageId?: string;
  reason?: unknown;
}> {
  return hostMutate('agent', 'send', {
    mentions: opts?.mentions ?? [],
    replyTo: null,
    onComplete: null,
    quotes: [],
    delivery,
    expectedRunId: opts?.expectedRunId ?? null,
    attachments: [],
    backend: opts?.backend ?? null,
    sessionId,
    message,
  });
}

export function agentStop(sessionId: string, runId: string): Promise<{ requested?: boolean }> {
  return hostMutate<{ requested?: boolean }>('agent', 'stop', { sessionId, runId });
}

export function agentPendingInteractions(sessionId: string): Promise<{
  revision: number;
  entries: AgentInteractionSummary[];
}> {
  return hostQuery('agent', 'pendingInteractions', { sessionId });
}

export function agentReadInteraction(
  sessionId: string,
  requestId: string,
  targetAnchor: string,
): Promise<AgentInteractionRecord | null> {
  return hostQuery('agent', 'interaction', { sessionId, requestId }, targetAnchor);
}

export function agentRespondInteraction(
  sessionId: string,
  requestId: string,
  answer: Record<string, unknown>,
): Promise<
  { kind: 'recorded'; record?: AgentInteractionRecord } | { kind: 'rejected'; reason?: unknown }
> {
  return hostMutate('agent', 'respond', { sessionId, requestId, answer });
}

export async function agentListSchedules(): Promise<AgentScheduledSummary[]> {
  const res = await hostQuery<{ kind: string; tasks?: AgentScheduledSummary[] }>(
    'agent',
    'schedules',
    {
      kind: 'list',
      cursor: null,
      expectedRevision: null,
    },
  );
  return res && res.kind === 'page' && Array.isArray(res.tasks) ? res.tasks : [];
}

export function agentGitWorkspaceDiff(sessionId: string): Promise<AgentGitWorkspaceDiff | null> {
  return hostQuery<AgentGitWorkspaceDiff | null>('agent', 'gitWorkspaceDiff', {
    sessionId,
    area: null,
    worktreePath: null,
  });
}
