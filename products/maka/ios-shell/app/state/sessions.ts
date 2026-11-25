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
  hostQuery,
  onSubscriptionEnded,
  onSubscriptionItem,
  subscribe,
  unsubscribe,
  type AgentSession,
  type AgentSessionPage,
  type SubscriptionHandle,
} from '../bridge';
import { connectedHosts, selectedScopeRootId } from './hostPool';

export interface ScopedSession {
  key: string;
  rootId: string;
  hostName: string;
  session: AgentSession;
}

const sessionsByHost = signal<Record<string, ScopedSession[]>>({});
const loading = signal(false);
const searchQuery = signal('');
const showArchived = signal(false);

const activeSubscriptions = new Map<string, { generation: number; handle: SubscriptionHandle }>();
let subSeq = 0;
let initialized = false;

export const sessionsLoading = () => loading();
export const sessionSearchQuery = () => searchQuery();
export const showingArchivedSessions = () => showArchived();

export function setSessionSearchQuery(q: string) {
  searchQuery.set(q);
}

export function setShowingArchivedSessions(archived: boolean) {
  showArchived.set(archived);
  void refreshAllSessions();
}

export const allSessions = computed<ScopedSession[]>(() => {
  const byHost = sessionsByHost();
  const merged: ScopedSession[] = [];
  for (const list of Object.values(byHost)) {
    for (const item of list) merged.push(item);
  }
  merged.sort((a, b) => (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0));
  return merged;
});

export const filteredSessions = computed<ScopedSession[]>(() => {
  const scope = selectedScopeRootId();
  const q = searchQuery().trim().toLowerCase();
  const archived = showArchived();
  return allSessions().filter((item) => {
    if (scope !== 'all' && item.rootId !== scope) return false;
    if (Boolean(item.session.archived) !== archived) return false;
    if (!q) return true;
    const hay = [
      item.session.title,
      item.session.workspace?.name ?? '',
      item.session.workspace?.path ?? '',
      item.hostName,
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
});

export const needsAttentionSessions = computed<ScopedSession[]>(() =>
  filteredSessions().filter((item) => item.session.activity === 'waiting'),
);

export const workingSessions = computed<ScopedSession[]>(() =>
  filteredSessions().filter((item) => item.session.activity === 'working'),
);

export const pinnedSessions = computed<ScopedSession[]>(() =>
  filteredSessions().filter(
    (item) =>
      item.session.pinned &&
      item.session.activity !== 'waiting' &&
      item.session.activity !== 'working',
  ),
);

export const recentSessions = computed<ScopedSession[]>(() =>
  filteredSessions().filter(
    (item) =>
      !item.session.pinned &&
      item.session.activity !== 'waiting' &&
      item.session.activity !== 'working',
  ),
);

export async function refreshHostSessions(rootId: string, hostName: string) {
  try {
    const page = await hostQuery<AgentSessionPage>(
      'agent',
      'list',
      {
        kind: null,
        filter: showArchived() ? 'archived' : 'all',
        includeArchived: showArchived(),
        rootsOnly: false,
        position: { kind: 'start' },
        scope: { kind: 'all' },
        titleQuery: '',
      },
      undefined,
      rootId,
    );
    const items: ScopedSession[] = (page?.sessions ?? []).map((session) => ({
      key: rootId + '::' + session.id,
      rootId,
      hostName,
      session,
    }));
    sessionsByHost.update((prev) => ({ ...prev, [rootId]: items }));
  } catch {
    // Keep prior snapshot on transient error; host connection status shows disconnects.
  }
}

export async function refreshAllSessions() {
  const hosts = connectedHosts().filter((entry) => hasAgentEndpoint(entry.connection));
  if (!hosts.length) return;
  loading.set(true);
  try {
    await Promise.all(
      hosts.map((entry) => refreshHostSessions(entry.host.rootId, entry.host.hostName)),
    );
  } finally {
    loading.set(false);
  }
}

export function startSessionsStore() {
  if (initialized) return;
  initialized = true;

  onSubscriptionItem((payload) => {
    if (!payload.subscriptionId.startsWith('sessions:')) return;
    const rootId = payload.rootId;
    if (!rootId) return;
    const entry = connectedHosts().find((c) => c.host.rootId === rootId);
    if (entry) {
      void refreshHostSessions(rootId, entry.host.hostName);
    }
  });

  onSubscriptionEnded((payload) => {
    if (!payload.subscriptionId.startsWith('sessions:')) return;
    if (payload.rootId) {
      const existing = activeSubscriptions.get(payload.rootId);
      if (existing && existing.handle.subscriptionId === payload.subscriptionId) {
        activeSubscriptions.delete(payload.rootId);
      }
    }
  });

  effect(() => {
    const current = connectedHosts().filter((entry) => hasAgentEndpoint(entry.connection));
    const currentRoots = new Set(current.map((entry) => entry.host.rootId));

    // Clean up disconnected hosts' subscriptions & cached sessions.
    for (const [rootId, sub] of [...activeSubscriptions.entries()]) {
      if (!currentRoots.has(rootId)) {
        activeSubscriptions.delete(rootId);
        void unsubscribe(sub.handle).catch(() => {});
      }
    }

    for (const entry of current) {
      const { rootId, hostName } = entry.host;
      const gen = entry.connection.generation ?? 0;
      const existing = activeSubscriptions.get(rootId);
      if (existing && existing.generation === gen) continue;
      if (existing) {
        activeSubscriptions.delete(rootId);
        void unsubscribe(existing.handle).catch(() => {});
      }
      void refreshHostSessions(rootId, hostName);
      const subscriptionId = 'sessions:' + rootId + ':' + String(++subSeq);
      void subscribe(
        subscriptionId,
        'agent',
        'sessions',
        {
          kind: null,
          filter: 'all',
          includeArchived: false,
          rootsOnly: false,
          scope: { kind: 'all' },
        },
        rootId,
      )
        .then((handle) => {
          activeSubscriptions.set(rootId, { generation: gen, handle });
        })
        .catch(() => {});
    }
  });
}
