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

import { computed, effect, lifecycle, network, signal, untracked, UrlScheme } from 'nsh';
import {
  beginPairing,
  bootstrap,
  cancelPairing,
  confirmPairing,
  connectHost,
  connectWebSocket,
  disconnectHost,
  hostQuery,
  networkChange,
  onHostState,
  onHostPath,
  type PathSummary,
  onOperationRecovery,
  removeHost,
  setFilter,
  setHostSnapshot,
  type ActiveHostInfo,
  type HostConnectionState,
  type HostStateSnapshot,
  type ParsedTicketInfo,
  type SavedHostItem,
} from '../bridge';
import { tr } from '../locale';
import type { StatusKind } from '../ui/StatusDot';
import { hapticNotification, hapticSelection } from './preferences';

export const PAIR_URI_PREFIX = 'maka://pair/v1?payload=';

export interface RecoveryNotice {
  session: string;
  settled: number;
  pending: number;
}

export interface DisconnectNotice {
  rootId?: string;
  reason: string;
}

const snapshot = signal<HostStateSnapshot | null>(null);
const bootstrapped = signal(false);
const bootstrapError = signal<string | null>(null);

// Chats scope ('all' or a specific rootId).
const selectedScope = signal<string>('all');

// Onboarding / "+ Add Computer" pairing state.
const pairingModalOpen = signal(false);
const advancedSheetOpen = signal(false);
const incomingPairUri = signal<string | null>(null);
const pendingTicket = signal<ParsedTicketInfo | null>(null);
const pendingDeviceLabel = signal<string>('iPhone');
const pairingBusy = signal(false);
const pairingError = signal<string | null>(null);
let pairingGeneration = 0;

// Read-only deep-link navigation target (maka://chats | maka://pending | maka://settings | maka://scan).
export type DeepLinkTarget = 'chats' | 'pending' | 'settings' | 'scan';
const deepLinkRequest = signal<{ seq: number; target: DeepLinkTarget } | null>(null);
let deepLinkSeq = 0;

export const currentDeepLink = () => deepLinkRequest();
export const clearDeepLink = () => deepLinkRequest.set(null);

// Inline notices & transient feedback toast.
const recoveryNotice = signal<RecoveryNotice | null>(null);
const disconnectNotice = signal<DisconnectNotice | null>(null);
const toastMessage = signal<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;

// Per-host connection check status (for DeviceDetailScreen).
const hostCheckStatus = signal<Record<string, string>>({});

export const hostSnapshot = () => snapshot();
export const isBootstrapped = () => bootstrapped();
export const hostBootstrapError = () => bootstrapError();
export const savedHosts = computed<SavedHostItem[]>(() => snapshot()?.hosts ?? []);
export const devicePeerId = computed<string>(() => snapshot()?.devicePeerId ?? '');
export const hasPairedHosts = computed<boolean>(() => savedHosts().length > 0);

export const selectedScopeRootId = () => selectedScope();
export const isPairingModalOpen = () => pairingModalOpen();
export const isAdvancedSheetOpen = () => advancedSheetOpen();
export const currentIncomingPairUri = () => incomingPairUri();
export const currentPendingTicket = () => pendingTicket();
export const currentDeviceLabel = () => pendingDeviceLabel();
export const isPairingBusy = () => pairingBusy();
export const currentPairingError = () => pairingError();
export const currentRecoveryNotice = () => recoveryNotice();
export const currentDisconnectNotice = () => disconnectNotice();
export const currentToastMessage = () => toastMessage();

export function hostConnectionState(rootId: string): HostConnectionState {
  const snap = snapshot();
  if (!snap) return { status: 'offline' };
  const pooled = snap.connections?.[rootId];
  if (pooled) return pooled;
  if (snap.active && snap.active.rootId === rootId) {
    return { status: 'connected', connection: snap.active };
  }
  const item = snap.hosts.find((h) => h.rootId === rootId);
  if (item?.status === 'connecting') return { status: 'connecting' };
  if (item?.status === 'error') return { status: 'error', error: tr('Connection failed') };
  return { status: 'offline' };
}

export function activeHostInfo(rootId: string): ActiveHostInfo | null {
  const state = hostConnectionState(rootId);
  return state.status === 'connected' ? state.connection : null;
}

const paths = signal<Record<string, { generation: number; pathSummary: PathSummary | null }>>({});
export function hostPath(rootId: string) {
  const connection = activeHostInfo(rootId);
  const current = paths()[rootId];
  return current?.generation === connection?.generation && current
    ? current.pathSummary
    : connection?.pathSummary;
}

export function isHostConnected(rootId: string): boolean {
  return hostConnectionState(rootId).status === 'connected';
}

export function hostReconnectNotice(rootId: string): { error?: string } | null {
  const host = hostConnectionState(rootId);
  if (host.status === 'error' && host.autoReconnect !== false) return { error: host.error };
  const retry = reconnects().get(rootId);
  if (host.status === 'connecting' && retry?.kind === 'dialing') return { error: retry.error };
  return null;
}

export function hostStatusKind(rootId: string): StatusKind {
  if (hostReconnectNotice(rootId)) return 'working';
  const state = hostConnectionState(rootId);
  switch (state.status) {
    case 'connected':
      return 'online';
    case 'connecting':
      return 'waiting';
    case 'error':
      return 'error';
    default:
      return 'offline';
  }
}

export function hostStatusText(rootId: string): string {
  if (hostReconnectNotice(rootId)) return tr('Reconnecting…');
  const state = hostConnectionState(rootId);
  switch (state.status) {
    case 'connected':
      return tr('Connected');
    case 'connecting':
      return tr('Connecting…');
    case 'error':
      return tr('Connection error');
    default:
      return tr('Offline');
  }
}

export const connectedHosts = computed<{ host: SavedHostItem; connection: ActiveHostInfo }[]>(
  () => {
    const out: { host: SavedHostItem; connection: ActiveHostInfo }[] = [];
    for (const host of savedHosts()) {
      const connection = activeHostInfo(host.rootId);
      if (connection) out.push({ host, connection });
    }
    return out;
  },
);

export function hostById(rootId: string): SavedHostItem | undefined {
  return savedHosts().find((h) => h.rootId === rootId);
}

export function hostCheckMessage(rootId: string): string | null {
  return hostCheckStatus()[rootId] ?? null;
}

export function showToast(message: string) {
  if (toastTimer) clearTimeout(toastTimer);
  toastMessage.set(message);
  toastTimer = setTimeout(() => {
    toastMessage.set(null);
  }, 3200);
}

export function dismissToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastMessage.set(null);
}

export function dismissRecoveryNotice() {
  recoveryNotice.set(null);
}

export function dismissDisconnectNotice() {
  disconnectNotice.set(null);
}

export function selectScope(scope: string) {
  hapticSelection();
  selectedScope.set(scope);
  void setFilter(
    scope === 'all' ? { kind: 'all_computers' } : { kind: 'single_computer', root_id: scope },
  ).catch(() => {});
}

export function setDeviceLabel(label: string) {
  pendingDeviceLabel.set(label);
}

export function openAddComputerFlow() {
  pairingError.set(null);
  pendingTicket.set(null);
  incomingPairUri.set(null);
  pairingModalOpen.set(true);
}

export function closeAddComputerFlow() {
  void cancelActivePairing();
  pairingModalOpen.set(false);
  advancedSheetOpen.set(false);
}

export function openAdvancedConnectSheet(prefillUri?: string) {
  pairingError.set(null);
  if (prefillUri !== undefined) {
    incomingPairUri.set(prefillUri);
  }
  advancedSheetOpen.set(true);
}

export function closeAdvancedConnectSheet() {
  advancedSheetOpen.set(false);
}

function applySnapshot(next: HostStateSnapshot) {
  const prev = snapshot();
  if (prev && next.revision <= prev.revision) return;
  setHostSnapshot(next);
  snapshot.set(next);
  paths.update((previous) =>
    Object.fromEntries(
      Object.entries(previous).filter(
        ([rootId, path]) => activeHostInfo(rootId)?.generation === path.generation,
      ),
    ),
  );

  const filter = next.filter;
  if (filter?.kind === 'single_computer') {
    const exists = next.hosts.some((h) => h.rootId === filter.root_id);
    if (exists) {
      selectedScope.set(filter.root_id);
    } else {
      selectedScope.set('all');
    }
  } else if (selectedScope() !== 'all' && !next.hosts.some((h) => h.rootId === selectedScope())) {
    selectedScope.set('all');
  }

  if (next.disconnectReason) {
    disconnectNotice.set({
      rootId: next.disconnectedRootId,
      reason: next.disconnectReason,
    });
  } else if (
    disconnectNotice() &&
    disconnectNotice()!.rootId &&
    (isHostConnected(disconnectNotice()!.rootId!) || !hostById(disconnectNotice()!.rootId!))
  ) {
    disconnectNotice.set(null);
  }

  syncReconnect();

  if (next.pendingPairUri) {
    handleIncomingUrl(next.pendingPairUri);
  }
}

export function isValidPairUri(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith(PAIR_URI_PREFIX) && trimmed.length > PAIR_URI_PREFIX.length;
}

export function handleIncomingUrl(url: string) {
  const trimmed = url.trim();
  if (trimmed.startsWith('maka://pair/')) {
    pairingError.set(null);
    incomingPairUri.set(trimmed);
    pendingTicket.set(null);
    if (hasPairedHosts()) {
      pairingModalOpen.set(true);
    }
    advancedSheetOpen.set(true);
    return;
  }
  if (trimmed === 'maka://chats') {
    deepLinkRequest.set({ seq: ++deepLinkSeq, target: 'chats' });
  } else if (trimmed === 'maka://pending') {
    deepLinkRequest.set({ seq: ++deepLinkSeq, target: 'pending' });
  } else if (trimmed === 'maka://settings') {
    deepLinkRequest.set({ seq: ++deepLinkSeq, target: 'settings' });
  } else if (trimmed === 'maka://scan') {
    if (hasPairedHosts()) pairingModalOpen.set(true);
    advancedSheetOpen.set(false);
    deepLinkRequest.set({ seq: ++deepLinkSeq, target: 'scan' });
  }
}

export async function startPairingFromUri(
  uri: string,
  relayUrl?: string,
  relayToken?: string,
): Promise<ParsedTicketInfo | null> {
  const trimmed = uri.trim();
  if (!trimmed) {
    pairingError.set(tr('Paste a pairing link from Maka on your computer.'));
    return null;
  }
  const gen = ++pairingGeneration;
  pairingBusy.set(true);
  pairingError.set(null);
  try {
    const ticket = await beginPairing(
      trimmed,
      relayUrl?.trim() || undefined,
      relayToken?.trim() || undefined,
    );
    if (gen !== pairingGeneration) {
      return null;
    }
    pendingTicket.set(ticket);
    advancedSheetOpen.set(false);
    return ticket;
  } catch (cause) {
    if (gen === pairingGeneration) {
      pairingError.set(cause instanceof Error ? cause.message : String(cause));
    }
    return null;
  } finally {
    if (gen === pairingGeneration) {
      pairingBusy.set(false);
    }
  }
}

export async function confirmPendingPairing(): Promise<boolean> {
  const ticket = pendingTicket();
  if (!ticket || pairingBusy()) return false;
  if (new TextEncoder().encode(pendingDeviceLabel().trim()).length > 128) {
    pairingError.set(tr('Device name must be 128 UTF-8 bytes or fewer.'));
    return false;
  }
  const gen = ++pairingGeneration;
  pairingBusy.set(true);
  pairingError.set(null);
  try {
    const next = await confirmPairing(ticket.pairingId, ticket.sasCode, pendingDeviceLabel());
    if (gen !== pairingGeneration) {
      // Cancelled while confirming: ignore late admission snapshot.
      return false;
    }
    applySnapshot(next);
    pendingTicket.set(null);
    incomingPairUri.set(null);
    pairingModalOpen.set(false);
    advancedSheetOpen.set(false);
    hapticNotification('success');
    showToast(tr('Connected to {name}', { name: ticket.hostName }));
    return true;
  } catch (cause) {
    if (gen === pairingGeneration) {
      pendingTicket.set(null);
      hapticNotification('error');
      const message = cause instanceof Error ? cause.message : String(cause);
      pairingError.set(message);
      showToast(message);
    }
    return false;
  } finally {
    if (gen === pairingGeneration) {
      pairingBusy.set(false);
    }
  }
}

export async function cancelActivePairing() {
  pairingGeneration += 1;
  pairingBusy.set(false);
  pendingTicket.set(null);
  pairingError.set(null);
  incomingPairUri.set(null);
  try {
    await cancelPairing();
  } catch {
    // Cancellation is best-effort when no attempt is active.
  }
}

export async function connectManualWebSocket(
  endpoint: string,
  rootId: string,
  bearer: string,
  clientInstance?: string,
): Promise<boolean> {
  const gen = ++pairingGeneration;
  pairingBusy.set(true);
  pairingError.set(null);
  try {
    const next = await connectWebSocket(
      endpoint.trim(),
      rootId.trim(),
      bearer.trim(),
      clientInstance?.trim() || undefined,
    );
    if (gen !== pairingGeneration) return false;
    applySnapshot(next);
    advancedSheetOpen.set(false);
    pairingModalOpen.set(false);
    hapticNotification('success');
    return true;
  } catch (cause) {
    if (gen === pairingGeneration) {
      hapticNotification('error');
      pairingError.set(cause instanceof Error ? cause.message : String(cause));
    }
    return false;
  } finally {
    if (gen === pairingGeneration) {
      pairingBusy.set(false);
    }
  }
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;
type RetryPlan = { delay: number; immediate: boolean };
type ScheduledRetry = { kind: 'scheduled'; plan: RetryPlan; timer: ReturnType<typeof setTimeout> };
type DialingRetry = { kind: 'dialing'; next: RetryPlan; error?: string };
type ReconnectState =
  | { kind: 'waiting'; plan: RetryPlan }
  | ScheduledRetry
  | DialingRetry
  | { kind: 'manual' };
const reconnects = signal(new Map<string, ReconnectState>());

function setReconnect(rootId: string, state?: ReconnectState) {
  reconnects.update((previous) => {
    const current = previous.get(rootId);
    if (current === state) return previous;
    if (current?.kind === 'scheduled') clearTimeout(current.timer);
    const next = new Map(previous);
    if (state) next.set(rootId, state);
    else next.delete(rootId);
    return next;
  });
}

function reconnectAvailable() {
  return lifecycle() === 'active' && network().online;
}

async function dialSavedHost(rootId: string, scheduled: ScheduledRetry) {
  if (reconnects().get(rootId) !== scheduled) return;
  if (!reconnectAvailable()) {
    setReconnect(rootId, { kind: 'waiting', plan: scheduled.plan });
    return;
  }
  const host = hostConnectionState(rootId);
  const { delay, immediate } = scheduled.plan;
  const attempt: DialingRetry = {
    kind: 'dialing',
    next: { delay: immediate ? delay : Math.min(delay * 2, MAX_RETRY_MS), immediate: false },
    error: host.status === 'error' ? host.error : undefined,
  };
  setReconnect(rootId, attempt);
  try {
    applySnapshot(await connectHost(rootId, undefined, undefined, true));
  } catch (cause) {
    // The native snapshot carries the error. No toast or haptics for automatic dials.
    if (reconnects().get(rootId) === attempt)
      console.warn('Could not reconnect computer', rootId, cause);
  } finally {
    if (reconnects().get(rootId) === attempt) {
      setReconnect(rootId, { kind: 'waiting', plan: attempt.next });
      syncHostReconnect(rootId);
    }
  }
}

function syncHostReconnect(rootId: string, immediate = false) {
  const retry = reconnects().get(rootId);
  if (retry?.kind === 'manual') return;
  const saved = hostById(rootId);
  const host = hostConnectionState(rootId);
  if (
    !saved ||
    saved.ephemeral ||
    host.status === 'connected' ||
    ('autoReconnect' in host && host.autoReconnect === false)
  ) {
    setReconnect(rootId);
    return;
  }
  if (retry?.kind === 'dialing') {
    // Wakeups during a dial are consumed once, if that dial fails.
    if (immediate) retry.next = { delay: FIRST_RETRY_MS, immediate: true };
    return;
  }
  const ready = reconnectAvailable() && host.status !== 'connecting';
  if (retry?.kind === 'scheduled' && ready && !immediate) return;
  const plan = immediate || !retry ? { delay: FIRST_RETRY_MS, immediate } : retry.plan;
  if (!ready) {
    if (immediate || retry?.kind === 'scheduled') setReconnect(rootId, { kind: 'waiting', plan });
    return;
  }
  const scheduled: ScheduledRetry = {
    kind: 'scheduled',
    plan,
    timer: setTimeout(() => void dialSavedHost(rootId, scheduled), plan.immediate ? 0 : plan.delay),
  };
  setReconnect(rootId, scheduled);
}

function syncReconnect(immediate = false) {
  const roots = new Set(savedHosts().map(({ rootId }) => rootId));
  for (const rootId of roots) syncHostReconnect(rootId, immediate);
  for (const [rootId, state] of reconnects()) {
    if (!roots.has(rootId) && state.kind !== 'manual') setReconnect(rootId);
  }
}

export function retrySavedHostNow(rootId: string) {
  syncHostReconnect(rootId, true);
}

async function manualHostAction(
  rootId: string,
  action: () => Promise<HostStateSnapshot>,
  feedback: () => void,
): Promise<boolean> {
  if (reconnects().get(rootId)?.kind === 'manual') return false;
  setReconnect(rootId, { kind: 'manual' });
  try {
    applySnapshot(await action());
    feedback();
    return true;
  } catch (cause) {
    showToast(cause instanceof Error ? cause.message : String(cause));
    return false;
  } finally {
    setReconnect(rootId);
    syncHostReconnect(rootId);
  }
}

export async function connectSavedHost(
  rootId: string,
  relayUrl?: string,
  relayToken?: string,
): Promise<boolean> {
  const ok = await manualHostAction(
    rootId,
    () => connectHost(rootId, relayUrl?.trim() || undefined, relayToken?.trim() || undefined),
    () => hapticNotification('success'),
  );
  if (!ok) hapticNotification('error');
  return ok;
}

export function disconnectSavedHost(rootId: string): Promise<boolean> {
  return manualHostAction(rootId, () => disconnectHost(rootId), hapticSelection);
}

export function removeSavedHost(rootId: string): Promise<boolean> {
  return manualHostAction(
    rootId,
    () => removeHost(rootId),
    () => hapticNotification('warning'),
  );
}

export async function checkHostConnection(rootId: string): Promise<boolean> {
  const info = activeHostInfo(rootId);
  if (!info) {
    hostCheckStatus.update((prev) => ({ ...prev, [rootId]: tr('Computer is offline') }));
    return false;
  }
  try {
    const endpoint = info.endpoints.includes('agent')
      ? 'agent'
      : info.endpoints.includes('hostLogs')
        ? 'hostLogs'
        : info.endpoints[0];
    if (!endpoint) {
      const errMsg = tr('Computer has no available endpoint');
      hostCheckStatus.update((prev) => ({ ...prev, [rootId]: errMsg }));
      return false;
    }
    const method = endpoint === 'agent' ? 'projects' : 'read';
    const input =
      endpoint === 'agent' ? { kind: 'list', cursor: null } : { position: { kind: 'tail' } };
    await hostQuery(endpoint, method, input, undefined, rootId);
    const okMsg = tr('Computer responded');
    hostCheckStatus.update((prev) => ({ ...prev, [rootId]: okMsg }));
    showToast(okMsg);
    hapticNotification('success');
    return true;
  } catch (cause) {
    const errMsg = cause instanceof Error ? cause.message : String(cause);
    hostCheckStatus.update((prev) => ({ ...prev, [rootId]: errMsg }));
    showToast(errMsg);
    hapticNotification('error');
    return false;
  }
}

let started = false;

export function startHostPool() {
  if (started) return;
  started = true;

  onHostState((next) => {
    applySnapshot(next);
  });

  onHostPath(({ rootId, generation, pathSummary }) => {
    if (activeHostInfo(rootId)?.generation === generation)
      paths.update((previous) => ({ ...previous, [rootId]: { generation, pathSummary } }));
  });

  onOperationRecovery((status) => {
    recoveryNotice.set(status);
  });

  UrlScheme.on('open', ({ url }) => {
    if (url) handleIncomingUrl(url);
  });

  let wasActive: boolean | undefined;
  let previousNetwork: ReturnType<typeof network> | undefined;
  effect(() => {
    const active = lifecycle() === 'active';
    const route = network();
    const resumed = wasActive === false && active;
    const routeChanged = previousNetwork !== undefined && previousNetwork !== route;
    wasActive = active;
    previousNetwork = route;
    untracked(() => {
      if (active && (resumed || routeChanged) && connectedHosts().length > 0) {
        void networkChange().catch((cause) =>
          console.warn('Could not refresh network paths', cause),
        );
      }
      syncReconnect(active && route.online && (resumed || routeChanged));
    });
  });

  void bootstrap().then(
    (initial) => {
      applySnapshot(initial);
      bootstrapped.set(true);
    },
    (cause) => {
      bootstrapError.set(cause instanceof Error ? cause.message : String(cause));
      bootstrapped.set(true);
    },
  );
}
