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
  onSubscriptionEnded,
  onSubscriptionItem,
  subscribe,
  unsubscribe,
  type AgentBackendPreference,
  type AgentProject,
  type AgentSession,
  type AgentSessionPage,
  type AgentWorkspaceSelection,
  type SubscriptionHandle,
} from '../bridge';
import { connectedHosts, hostById, selectedScopeRootId, showToast } from './hostPool';
import { hapticNotification, hapticSelection } from './preferences';

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

export function findScopedSession(rootId: string, sessionId: string): ScopedSession | undefined {
  return (sessionsByHost()[rootId] ?? []).find((s) => s.session.id === sessionId);
}

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

export async function togglePinSession(item: ScopedSession): Promise<boolean> {
  try {
    const res = await hostMutate<{ kind: string; reason?: unknown }>(
      'agent',
      'metadata',
      {
        sessionId: item.session.id,
        expectedRevision: item.session.revision,
        title: item.session.title,
        labels: item.session.labels ?? [],
        pinned: !item.session.pinned,
      },
      { rootId: item.rootId },
    );
    if (res?.kind === 'rejected') {
      throw new Error(String(res.reason ?? 'rejected'));
    }
    hapticSelection();
    await refreshHostSessions(item.rootId, item.hostName);
    return true;
  } catch (cause) {
    hapticNotification('error');
    showToast(cause instanceof Error ? cause.message : String(cause));
    return false;
  }
}

export async function renameSession(item: ScopedSession, nextTitle: string): Promise<boolean> {
  const trimmed = nextTitle.trim();
  if (!trimmed) return false;
  try {
    const res = await hostMutate<{ kind: string; reason?: unknown }>(
      'agent',
      'metadata',
      {
        sessionId: item.session.id,
        expectedRevision: item.session.revision,
        title: trimmed,
        labels: item.session.labels ?? [],
        pinned: item.session.pinned,
      },
      { rootId: item.rootId },
    );
    if (res?.kind === 'rejected') {
      throw new Error(String(res.reason ?? 'rejected'));
    }
    hapticNotification('success');
    await refreshHostSessions(item.rootId, item.hostName);
    return true;
  } catch (cause) {
    hapticNotification('error');
    showToast(cause instanceof Error ? cause.message : String(cause));
    return false;
  }
}

export async function deleteSession(item: ScopedSession): Promise<boolean> {
  try {
    const res = await hostMutate<{ kind: string; reason?: unknown }>(
      'agent',
      'changeSession',
      {
        sessionId: item.session.id,
        expectedRevision: item.session.revision,
        action: 'remove',
      },
      { rootId: item.rootId },
    );
    if (res?.kind === 'rejected') {
      throw new Error(String(res.reason ?? 'rejected'));
    }
    hapticNotification('warning');
    await refreshHostSessions(item.rootId, item.hostName);
    return true;
  } catch (cause) {
    hapticNotification('error');
    showToast(cause instanceof Error ? cause.message : String(cause));
    return false;
  }
}

export async function listHostProjects(rootId: string): Promise<AgentProject[]> {
  try {
    const page = await hostQuery<{ kind: string; projects?: AgentProject[] }>(
      'agent',
      'projects',
      { kind: 'list', cursor: null },
      undefined,
      rootId,
    );
    return page && page.kind === 'projects' && Array.isArray(page.projects) ? page.projects : [];
  } catch {
    return [];
  }
}

export async function listHostDirectoryRoots(
  rootId: string,
): Promise<{ name: string; path: string }[]> {
  try {
    const page = await hostQuery<{ kind: string; roots?: { name: string; path: string }[] }>(
      'agent',
      'directories',
      { kind: 'roots' },
      undefined,
      rootId,
    );
    return page && page.kind === 'roots' && Array.isArray(page.roots) ? page.roots : [];
  } catch {
    return [];
  }
}

export async function listHostDirectoryChildren(
  rootId: string,
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
  }>('agent', 'directories', { kind: 'children', path, after }, undefined, rootId);
  if (page && page.kind === 'children' && Array.isArray(page.children)) {
    return {
      directory: page.directory ?? null,
      children: page.children,
      after: page.after ?? null,
    };
  }
  return { directory: null, children: [], after: null };
}

export async function createHostSession(params: {
  rootId: string;
  title: string;
  kind: 'agent' | 'room';
  workspace: AgentWorkspaceSelection;
  automaticTitle: boolean;
  backend?: AgentBackendPreference | null;
}): Promise<ScopedSession> {
  const res = await hostMutate<
    | { kind: 'created'; session: AgentSession }
    | { kind: 'rejected'; reason: unknown }
    | AgentSession
  >(
    'agent',
    'create',
    {
      incognito: false,
      kind: params.kind,
      presetId: null,
      backend: params.kind === 'room' ? null : (params.backend ?? null),
      automaticTitle: params.kind === 'room' ? false : params.automaticTitle,
      tools: null,
      title: params.title,
      labels: [],
      workspace: params.workspace,
    },
    { rootId: params.rootId },
  );
  let session: AgentSession;
  if (res && typeof res === 'object' && 'kind' in res) {
    if (res.kind === 'created' && 'session' in res && res.session) {
      session = res.session;
    } else if (res.kind === 'rejected') {
      const reason = 'reason' in res ? res.reason : 'unknown';
      throw new Error(typeof reason === 'string' ? reason : JSON.stringify(reason));
    } else {
      session = res as AgentSession;
    }
  } else {
    session = res as AgentSession;
  }
  const hostName = hostById(params.rootId)?.hostName ?? params.rootId;
  await refreshHostSessions(params.rootId, hostName);
  return {
    key: params.rootId + '::' + session.id,
    rootId: params.rootId,
    hostName,
    session,
  };
}

export function startSessionsStore() {
  if (initialized) return;
  initialized = true;

  onSubscriptionItem((payload) => {
    if (!payload.subscriptionId.startsWith('catalog:')) return;
    const rootId = payload.rootId;
    if (!rootId) return;
    const entry = connectedHosts().find((c) => c.host.rootId === rootId);
    if (entry) {
      void refreshHostSessions(rootId, entry.host.hostName);
    }
  });

  onSubscriptionEnded((payload) => {
    if (!payload.subscriptionId.startsWith('catalog:')) return;
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
      const subscriptionId = 'catalog:' + rootId + ':' + String(++subSeq);
      void subscribe(
        subscriptionId,
        'agent',
        'catalog',
        {
          kind: null,
          filter: 'all',
          includeArchived: false,
          rootsOnly: false,
          position: { kind: 'start' },
          scope: { kind: 'all' },
          titleQuery: '',
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
