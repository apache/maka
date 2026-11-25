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

import { computed, effect, signal } from 'nsh';
import {
  hasAgentEndpoint,
  hostMutate,
  hostQuery,
  type AgentInteractionRecord,
  type AgentInteractionSummary,
  type AgentSessionPage,
} from '../bridge';
import { connectedHosts, showToast } from './hostPool';
import { hapticNotification } from './preferences';
import { allSessions, refreshAllSessions } from './sessions';

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
const loading = signal(false);
const busyKeys = signal<Record<string, boolean>>({});
let initialized = false;

export const inboxLoading = () => loading();

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

export async function refreshHostInbox(rootId: string, hostName: string) {
  try {
    const page = await hostQuery<AgentSessionPage>(
      'agent',
      'list',
      {
        kind: null,
        filter: 'needs_you',
        includeArchived: false,
        rootsOnly: false,
        position: { kind: 'start' },
        scope: { kind: 'all' },
        titleQuery: '',
      },
      undefined,
      rootId,
    );
    const sessions = page?.sessions ?? [];
    const results: InboxItem[] = [];
    for (const session of sessions) {
      const pending = await hostQuery<{
        revision: number;
        entries: AgentInteractionSummary[];
      }>('agent', 'pendingInteractions', { sessionId: session.id }, undefined, rootId).catch(
        () => null,
      );
      if (!pending?.entries?.length) continue;
      for (const summary of pending.entries) {
        const record = await hostQuery<AgentInteractionRecord | null>(
          'agent',
          'interaction',
          { sessionId: session.id, requestId: summary.requestId },
          undefined,
          rootId,
        ).catch(() => null);
        if (record && record.outcome !== null && record.outcome !== undefined) {
          continue;
        }
        const workspaceName =
          session.workspace?.name ||
          session.workspace?.path?.split('/').filter(Boolean).pop() ||
          '';
        results.push({
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
    }
    itemsByHost.update((prev) => ({ ...prev, [rootId]: results }));
  } catch {
    // Keep prior inbox items on transient query error.
  }
}

export async function refreshAllInbox() {
  const hosts = connectedHosts().filter((entry) => hasAgentEndpoint(entry.connection));
  if (!hosts.length) {
    itemsByHost.set({});
    return;
  }
  loading.set(true);
  try {
    await Promise.all(
      hosts.map((entry) => refreshHostInbox(entry.host.rootId, entry.host.hostName)),
    );
  } finally {
    loading.set(false);
  }
}

export async function respondInboxItem(
  item: InboxItem,
  answer: Record<string, unknown>,
  successKind: 'success' | 'warning' = 'success',
): Promise<boolean> {
  busyKeys.update((prev) => ({ ...prev, [item.key]: true }));
  try {
    const result = await hostMutate<{ kind: 'recorded' } | { kind: 'rejected'; reason: unknown }>(
      'agent',
      'respond',
      {
        sessionId: item.sessionId,
        requestId: item.requestId,
        answer,
      },
      { rootId: item.rootId },
    );
    if (result.kind === 'rejected') throw new Error(String(result.reason));
    hapticNotification(successKind);
    await Promise.all([refreshHostInbox(item.rootId, item.hostName), refreshAllSessions()]);
    return true;
  } catch (cause) {
    hapticNotification('error');
    showToast(cause instanceof Error ? cause.message : String(cause));
    return false;
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
    // Re-sync inbox whenever connected hosts or session activity changes.
    const hosts = connectedHosts().filter((entry) => hasAgentEndpoint(entry.connection));
    void allSessions();
    const activeRoots = new Set(hosts.map((h) => h.host.rootId));
    itemsByHost.update((prev) => {
      let changed = false;
      const next: Record<string, InboxItem[]> = {};
      for (const [rootId, list] of Object.entries(prev)) {
        if (activeRoots.has(rootId)) next[rootId] = list;
        else changed = true;
      }
      return changed ? next : prev;
    });
    for (const entry of hosts) {
      void refreshHostInbox(entry.host.rootId, entry.host.hostName);
    }
  });
}
