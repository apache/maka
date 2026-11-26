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
  ephemeral?: boolean;
  status?: HostConnectionState['status'];
  relayUrls?: string[];
}

export interface ActiveHostInfo {
  rootId: string;
  hostName: string;
  epoch: string;
  session: string;
  generation: number;
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
  rootId: string;
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

import type {
  AgentModelChoice,
  AgentBackendPreference,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
export type { AgentModelChoice, AgentBackendPreference };

export type {
  AgentProject,
  AgentWorkspaceSelection,
  AgentSession,
  AgentSessionPage,
  AgentObservation,
  AgentHistoryChunk,
  AgentHistoryPage,
  AgentRoomMessage,
  AgentDeliveryPage,
  AgentQueue,
  AgentPreviewPage,
  AgentInteractionSummary,
  InteractionQuestion as AgentQuestionItem,
  InteractionRequest as AgentInteractionRequest,
  InteractionRecord as AgentInteractionRecord,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
export type { AgentGitWorkspaceDiffOutput_GitWorkspaceDiff as AgentGitWorkspaceDiff } from '../../../../packages/plugin-sdk/src/generated/methods';

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

export function confirmPairing(
  pairingId: number,
  sas: string,
  deviceLabel: string,
): Promise<HostStateSnapshot> {
  return host.call('ios.confirmPairing', {
    pairingId,
    sas,
    deviceLabel,
  }) as Promise<HostStateSnapshot>;
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

let hostState: HostStateSnapshot | undefined;

export function setHostSnapshot(snapshot: HostStateSnapshot) {
  hostState = snapshot;
}

function connection(rootId: string | undefined): ActiveHostInfo | undefined {
  if (rootId === undefined) return hostState?.active ?? undefined;
  const entry = hostState?.connections?.[rootId];
  return entry?.status === 'connected' ? entry.connection : undefined;
}

export async function hostQuery<T = unknown>(
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
  targetAnchor = hostState?.active?.session,
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

export interface MutationProgress {
  rootId: string;
  generation: number;
  progressId: string;
  value: unknown;
}

type ProgressListener = (progress: MutationProgress) => void;
const progressListeners = new Map<string, ProgressListener>();
let nextProgressId = 0;

function progressKey(rootId: string, generation: number, progressId: string) {
  return JSON.stringify([rootId, generation, progressId]);
}

host.on('ios.mutationProgress', (data) => {
  const progress = data as unknown as MutationProgress & { deliveryId: number; sequence: number };
  try {
    if (connection(progress.rootId)?.generation === progress.generation) {
      progressListeners.get(
        progressKey(progress.rootId, progress.generation, progress.progressId),
      )?.(progress);
    }
  } finally {
    // Return credit even if the event belongs to a Host or call that has since ended.
    host.post('ios.ackMutationProgress', {
      deliveryId: progress.deliveryId,
      sequence: progress.sequence,
    });
  }
});

export async function hostMutate<T = unknown>(
  endpoint: string,
  method: string,
  input: Record<string, unknown> = {},
  {
    rootId,
    generation,
    secret,
    progressId,
    onProgress,
  }: {
    rootId?: string;
    generation?: number;
    secret?: string;
    progressId?: string;
    onProgress?: ProgressListener;
  } = {},
): Promise<T> {
  const target = connection(rootId);
  if (
    (rootId !== undefined && target?.generation === undefined) ||
    (generation !== undefined && target?.generation !== generation)
  )
    throw new Error(tr('Computer is offline'));
  let key: string | undefined;
  if (onProgress) {
    if (!target) throw new Error('remote Host is not connected');
    progressId ??= 'mutation:' + String(++nextProgressId);
    key = progressKey(target.rootId, target.generation, progressId);
    if (progressListeners.has(key)) throw new Error('mutation progress ID is already in use');
    progressListeners.set(key, onProgress);
  }
  try {
    const res = (await host.call(
      'ios.hostMutate',
      {
        anchorSession: rootId ? undefined : hostState?.active?.session,
        rootId,
        generation: generation ?? target?.generation,
        endpoint,
        method,
        input,
        secret,
        progressId: onProgress ? progressId : undefined,
      },
      onProgress ? { timeout: 0 } : undefined,
    )) as { value: T };
    return res.value;
  } finally {
    if (key !== undefined) progressListeners.delete(key);
  }
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
    anchorSession: rootId ? undefined : hostState?.active?.session,
    endpoint,
    method,
    input,
  }) as Promise<SubscriptionHandle>;
}

export function unsubscribe(handle: SubscriptionHandle): Promise<{ cancelled: boolean }> {
  return host.call('ios.unsubscribe', handle) as Promise<{ cancelled: boolean }>;
}

export function onHostState(listener: (state: HostStateSnapshot) => void): () => void {
  return host.on('ios.hostState', (payload) => {
    if (payload && typeof payload === 'object') {
      listener(payload as unknown as HostStateSnapshot);
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
      listener(payload as unknown as SubscriptionItemPayload);
    }
  });
}

export function onSubscriptionEnded(
  listener: (payload: SubscriptionEndedPayload) => void,
): () => void {
  return host.on('ios.subscriptionEnded', (payload) => {
    if (payload && typeof payload === 'object') {
      listener(payload as unknown as SubscriptionEndedPayload);
    }
  });
}

/* ---- Typed Agent Host RPC helpers ---- */

export function hasAgentEndpoint(active: ActiveHostInfo | null): boolean {
  return !!active && active.endpoints.includes('agent');
}

export function onHostPath(
  listener: (event: {
    rootId: string;
    generation: number;
    pathSummary: PathSummary | null;
  }) => void,
) {
  return host.on('ios.hostPath', (event) =>
    listener(event as unknown as Parameters<typeof listener>[0]),
  );
}
