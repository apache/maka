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

import { approvalOutcome, approvalRejectionError } from '../approval';
import type { AgentInteractionResult } from '../../../../../packages/plugin-sdk/src/generated/runtime';
import { computed, effect, signal, untracked } from 'nsh';
import {
  hasAgentEndpoint,
  hostMutate,
  hostQuery,
  watchHost,
  type AgentInteractionRecord,
  type AgentInteractionSummary,
  type AgentSessionPage,
  type AgentSession,
} from '../bridge';
import { activeHostInfo, connectedHosts, showToast } from './hostPool';
import { hapticNotification } from './preferences';
import { refreshAllSessions } from './sessions';
import { catalogInput, readCatalog } from './sessionCatalog';

export interface InboxItem {
  key: string;
  rootId: string;
  hostName: string;
  sessionId: string;
  sessionTitle: string;
  workspaceName: string;
  requestId: string;
  summary: AgentInteractionSummary;
  record: AgentInteractionRecord | null;
}

const itemsByHost = signal<Record<string, InboxItem[]>>({});
type SyncState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed'; error: string };
interface InboxStatus {
  sync: SyncState;
  watchError?: string;
}
const statusByHost = signal<Record<string, InboxStatus>>({});
const busyKeys = signal<Record<string, boolean>>({});
let initialized = false;

export const inboxLoading = computed(() =>
  Object.values(statusByHost()).some(({ sync }) => sync.kind === 'loading'),
);
export const inboxError = computed(() => {
  for (const { sync, watchError } of Object.values(statusByHost())) {
    if (watchError) return watchError;
    if (sync.kind === 'failed') return sync.error;
  }
  return null;
});

export const allInboxItems = computed<InboxItem[]>(() => {
  const map = itemsByHost();
  const out: InboxItem[] = [];
  for (const list of Object.values(map)) {
    for (const item of list) out.push(item);
  }
  out.sort((a, b) => (b.record?.createdAt ?? 0) - (a.record?.createdAt ?? 0));
  return out;
});

export const totalPendingCount = computed<number>(() => allInboxItems().length);

export function pendingCountForHost(rootId: string): number {
  return (itemsByHost()[rootId] ?? []).length;
}

export function isInboxItemBusy(key: string): boolean {
  return !!busyKeys()[key];
}

interface InboxHost {
  rootId: string;
  hostName: string;
  connectionGeneration: number;
  stopWatch?: () => void;
  queued?: string | null;
  flight?: { hint: string | null; revision?: string; dismissed: Set<string> };
  syncedRevision?: string;
}
const inboxHosts = new Map<string, InboxHost>();
let inboxSequence = 0;

const current = (host: InboxHost) =>
  inboxHosts.get(host.rootId) === host &&
  activeHostInfo(host.rootId)?.generation === host.connectionGeneration;
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function setStatus(host: InboxHost, patch: Partial<InboxStatus>) {
  statusByHost.update((prev) => ({
    ...prev,
    [host.rootId]: { ...prev[host.rootId], ...patch },
  }));
}

function startWatch(host: InboxHost) {
  if (host.stopWatch || !current(host)) return;
  host.stopWatch = watchHost<AgentSessionPage>(
    host.rootId,
    host.connectionGeneration,
    'pending:' + host.rootId + ':' + ++inboxSequence,
    'catalog',
    catalogInput('needs_you'),
    ({ revision }) => enqueueInbox(host, revision),
    (cause) => {
      host.stopWatch = undefined;
      setStatus(host, { watchError: message(cause) });
    },
    () => setStatus(host, { watchError: undefined }),
  );
}

function enqueueInbox(host: InboxHost, hint: string | null) {
  if (!current(host)) return;
  if (hint !== null) {
    if (hint === host.flight?.revision) {
      // The ordered stream has caught up to the revision we're reading.
      if (host.queued !== null) host.queued = undefined;
      return;
    }
    if (
      host.queued === null ||
      hint === host.flight?.hint ||
      (!host.flight && hint === host.syncedRevision)
    )
      return;
  }
  host.queued = hint;
  if (!host.flight) void drainInbox(host);
}

export function refreshHostInbox(rootId: string) {
  const host = inboxHosts.get(rootId);
  if (host) enqueueInbox(host, null);
}

async function drainInbox(host: InboxHost) {
  const { rootId, hostName } = host;
  // Revisions are opaque digests. A list retry can overtake the stream,
  // so re-read the head instead of publishing a delayed push's page.
  while (current(host) && host.queued !== undefined) {
    const hint = host.queued;
    host.queued = undefined;
    if (hint !== null && hint === host.syncedRevision) continue;
    const flight: NonNullable<InboxHost['flight']> = { hint, dismissed: new Set() };
    host.flight = flight;
    try {
      const catalog = await readCatalog(rootId, 'needs_you', () => current(host), Infinity, {
        kind: 'head',
      });
      if (!catalog || !current(host)) return;
      flight.revision = catalog.revision;
      if (hint !== null && catalog.revision === host.syncedRevision) continue;
      const results = await readInboxItems(host, catalog.sessions);
      if (!current(host)) return;
      itemsByHost.update((prev) => ({
        ...prev,
        [rootId]: results.filter(({ key }) => !flight.dismissed.has(key)),
      }));
      host.syncedRevision = catalog.revision;
      setStatus(host, { sync: { kind: 'ready' } });
    } catch (cause) {
      if (!current(host)) return;
      host.syncedRevision = undefined;
      setStatus(host, { sync: { kind: 'failed', error: message(cause) } });
    } finally {
      host.flight = undefined;
    }
  }
}

async function readInboxItems(host: InboxHost, sessions: AgentSession[]) {
  const { rootId, hostName } = host;
  const results: InboxItem[] = [];
  // Bound RPC fan-out, but don't pay two sequential network round trips per
  // session across the entire inbox before we can publish a badge.
  const batchSize = 8;
  for (let offset = 0; offset < sessions.length; offset += batchSize) {
    const batch = await Promise.allSettled(
      sessions.slice(offset, offset + batchSize).map(async (session) => {
        const pending = await hostQuery<{
          revision: number;
          entries: AgentInteractionSummary[];
        }>('agent', 'pendingInteractions', { sessionId: session.id }, undefined, rootId);
        if (!current(host)) return;
        if (!pending?.entries?.length) return;
        const items: InboxItem[] = [];
        const workspaceName = session.workspace?.path?.split('/').filter(Boolean).pop() || '';
        for (const summary of pending.entries) {
          const record = await hostQuery<AgentInteractionRecord | null>(
            'agent',
            'interaction',
            { sessionId: session.id, requestId: summary.requestId },
            undefined,
            rootId,
          );
          if (!current(host)) return;
          if (!record) continue;
          if (record.outcome !== null && record.outcome !== undefined) {
            continue;
          }
          items.push({
            key: rootId + '::' + session.id + '::' + summary.requestId,
            rootId,
            hostName,
            sessionId: session.id,
            sessionTitle: session.title,
            workspaceName,
            requestId: summary.requestId,
            summary,
            record,
          });
        }
        return items;
      }),
    );
    if (!current(host)) break;
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      if (result.value) results.push(...result.value);
    }
  }
  return results;
}

export function refreshAllInbox() {
  for (const host of inboxHosts.values()) {
    startWatch(host);
    enqueueInbox(host, null);
  }
}

export function dismissInboxRequest(rootId: string, sessionId: string, requestId: string) {
  const key = rootId + '::' + sessionId + '::' + requestId;
  inboxHosts.get(rootId)?.flight?.dismissed.add(key);
  itemsByHost.update((prev) => {
    const items = prev[rootId];
    return items ? { ...prev, [rootId]: items.filter((item) => item.key !== key) } : prev;
  });
}

export async function respondInboxItem(item: InboxItem, answer: Record<string, unknown>) {
  if (isInboxItemBusy(item.key)) return null;
  busyKeys.update((prev) => ({ ...prev, [item.key]: true }));
  const generation = activeHostInfo(item.rootId)?.generation;
  try {
    const result = await hostMutate<AgentInteractionResult>(
      'agent',
      'respond',
      {
        sessionId: item.sessionId,
        requestId: item.requestId,
        answer,
      },
      { rootId: item.rootId },
    );
    if (
      (result.kind === 'recorded' || result.reason === 'closed') &&
      activeHostInfo(item.rootId)?.generation === generation
    ) {
      dismissInboxRequest(item.rootId, item.sessionId, item.requestId);
    }
    refreshHostInbox(item.rootId);
    if (result.kind === 'rejected') {
      throw approvalRejectionError(result.reason);
    }
    hapticNotification(approvalOutcome(result.record.outcome) === false ? 'warning' : 'success');
    void refreshAllSessions();
    return result.record;
  } catch (cause) {
    hapticNotification('error');
    showToast(cause instanceof Error ? cause.message : String(cause));
    return null;
  } finally {
    busyKeys.update((prev) => {
      const next = { ...prev };
      delete next[item.key];
      return next;
    });
  }
}

export function startInboxStore() {
  if (initialized) return;
  initialized = true;

  effect(() => {
    const hosts = connectedHosts().filter((entry) => hasAgentEndpoint(entry.connection));
    const roots = new Map(
      hosts.map(({ host, connection }) => [host.rootId, connection.generation]),
    );
    for (const [rootId, host] of inboxHosts) {
      if (roots.get(rootId) === host.connectionGeneration) continue;
      inboxHosts.delete(rootId);
      host.stopWatch?.();
      itemsByHost.update((prev) => {
        const next = { ...prev };
        delete next[rootId];
        return next;
      });
      statusByHost.update((prev) => {
        const next = { ...prev };
        delete next[rootId];
        return next;
      });
    }
    for (const {
      host: { rootId, hostName },
      connection: { generation },
    } of hosts) {
      if (inboxHosts.has(rootId)) continue;
      const host: InboxHost = { rootId, hostName, connectionGeneration: generation };
      inboxHosts.set(rootId, host);
      setStatus(host, { sync: { kind: 'loading' } });
      startWatch(host);
      untracked(() => enqueueInbox(host, null));
    }
  });
}
