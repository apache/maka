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

import { host } from 'nsh';

export type HostViewFilter =
  | { kind: 'all_computers' }
  | { kind: 'single_computer'; root_id: string };

export interface SavedHostItem {
  rootId: string;
  hostName: string;
  peerId: string;
  endpoints: string[];
  credentialId: string;
  lastConnectedAtMs: number;
  collapsedInAllView: boolean;
  connected: boolean;
  hasCredential: boolean;
}

export interface ActiveHostInfo {
  rootId: string;
  hostName: string;
  epoch: string;
  session: string;
  endpoints: string[];
}

export interface HostStateSnapshot {
  devicePeerId: string;
  filter: HostViewFilter;
  hosts: SavedHostItem[];
  active: ActiveHostInfo | null;
  pendingPairUri?: string;
}

export interface ParsedTicketInfo {
  rootId: string;
  hostName: string;
  peerId: string;
  endpoints: string[];
  nonce: string;
  expiresAtMs: number;
  sasCode: string;
  devicePeerId: string;
}

export interface PairHostResult {
  sasCode: string;
  state: HostStateSnapshot;
}

export interface HostCallResult {
  events: unknown[];
}

export interface SubscriptionHandle {
  subscriptionId: string;
  generation: number;
}

export interface SubscriptionItemPayload {
  subscriptionId: string;
  generation: number;
  item: unknown;
}

export interface SubscriptionEndedPayload {
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

export interface AgentSession {
  id: string;
  title: string;
  kind: 'agent' | 'room';
  parentSessionId: string | null;
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
}

export type AgentDeliveryPage =
  | { kind: 'room'; through: number }
  | { kind: 'events'; through: number; nextAfter: number; events: AgentDelivery[] }
  | { kind: 'preview'; page: AgentPreviewPage }
  | { kind: 'queue'; queue: { revision: number; entries: AgentQueueEntry[] } }
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

export function bootstrap(): Promise<HostStateSnapshot> {
  return host.call('ios.bootstrap', {}) as Promise<HostStateSnapshot>;
}

export function parseTicket(uri: string): Promise<ParsedTicketInfo> {
  return host.call('ios.parseTicket', { uri }) as Promise<ParsedTicketInfo>;
}

export function pairHost(uri: string): Promise<PairHostResult> {
  return host.call('ios.pairHost', { uri }) as Promise<PairHostResult>;
}

export function connectHost(rootId: string): Promise<HostStateSnapshot> {
  return host.call('ios.connectHost', { rootId }) as Promise<HostStateSnapshot>;
}

export function disconnectHost(): Promise<HostStateSnapshot> {
  return host.call('ios.disconnectHost', {}) as Promise<HostStateSnapshot>;
}

export function removeHost(rootId: string): Promise<HostStateSnapshot> {
  return host.call('ios.removeHost', { rootId }) as Promise<HostStateSnapshot>;
}

export function setFilter(filter: HostViewFilter): Promise<HostStateSnapshot> {
  return host.call('ios.setFilter', { filter }) as Promise<HostStateSnapshot>;
}

export function hostCall(
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
): Promise<HostCallResult> {
  return host.call('ios.hostCall', { endpoint, method, input }) as Promise<HostCallResult>;
}

export async function hostQuery<T = unknown>(
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const res = (await host.call('ios.hostQuery', { endpoint, method, input })) as { value: T };
  return res.value;
}

export async function hostMutate<T = unknown>(
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const res = (await host.call('ios.hostMutate', { endpoint, method, input })) as { value: T };
  return res.value;
}

export function subscribe(
  subscriptionId: string,
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
): Promise<SubscriptionHandle> {
  return host.call('ios.subscribe', {
    subscriptionId,
    endpoint,
    method,
    input,
  }) as Promise<SubscriptionHandle>;
}

export function unsubscribe(subscriptionId: string): Promise<{ cancelled: boolean }> {
  return host.call('ios.unsubscribe', { subscriptionId }) as Promise<{ cancelled: boolean }>;
}

export function onHostState(listener: (state: HostStateSnapshot) => void): () => void {
  return host.on('ios.hostState', (payload) => {
    if (payload && typeof payload === 'object') {
      listener(payload as HostStateSnapshot);
    }
  });
}

export function onPairingUri(listener: (uri: string) => void): () => void {
  return host.on('ios.pairingUri', (payload) => {
    const uri = (payload as { uri?: unknown } | null)?.uri;
    if (typeof uri === 'string' && uri.length > 0) {
      listener(uri);
    }
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
): Promise<AgentSessionPage> {
  return hostQuery<AgentSessionPage>('agent', 'list', {
    kind: null,
    filter,
    includeArchived: false,
    rootsOnly: false,
    position: { kind: 'start' },
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

export function agentCreateSession(
  title: string,
  kind: 'agent' | 'room',
  workspacePath: string,
): Promise<AgentSession> {
  return hostMutate<AgentSession>('agent', 'create', {
    incognito: false,
    kind,
    presetId: null,
    backend: null,
    automaticTitle: false,
    tools: null,
    title,
    labels: [],
    workspace: { kind: 'directory', path: workspacePath },
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

export function agentHistory(sessionId: string): Promise<AgentHistoryPage> {
  return hostQuery<AgentHistoryPage>('agent', 'history', {
    sessionId,
    through: null,
    position: { kind: 'tail' },
    includeThinking: true,
    view: 'conversation',
  });
}

export function agentSend(
  sessionId: string,
  message: string,
  delivery: 'steer' | 'queue',
  mentions: string[] = [],
): Promise<{
  kind: string;
  sessionId?: string;
  runId?: string;
  messageId?: string;
  reason?: string;
}> {
  return hostMutate('agent', 'send', {
    mentions,
    replyTo: null,
    onComplete: null,
    quotes: [],
    delivery,
    expectedRunId: null,
    attachments: [],
    backend: null,
    sessionId,
    message,
  });
}

export function agentStop(sessionId: string, runId: string): Promise<unknown> {
  return hostMutate('agent', 'stop', { sessionId, runId });
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
): Promise<AgentInteractionRecord | null> {
  return hostQuery('agent', 'interaction', { sessionId, requestId });
}

export function agentRespondInteraction(
  sessionId: string,
  requestId: string,
  answer: Record<string, unknown>,
): Promise<{ kind: string; reason?: string }> {
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

export function formatSas(sasCode: string): string {
  const digits = sasCode.replace(/[^0-9]/g, '');
  if (digits.length === 6) {
    return digits.slice(0, 3) + ' ' + digits.slice(3);
  }
  return sasCode;
}
