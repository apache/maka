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
import {
  activeHostInfo,
  connectedHosts,
  hostById,
  savedHosts,
  selectedScopeRootId,
  showToast,
} from './hostPool';
import type { ServiceMethods } from '../../../../../packages/plugin-sdk/src/generated/methods';
import { hapticNotification, hapticSelection } from './preferences';

export interface ScopedSession {
  key: string;
  rootId: string;
  hostName: string;
  session: AgentSession;
}

const sessionsByHost = signal<Record<string, ScopedSession[]>>({});
type BotOutbox = ServiceMethods['agent']['botOutbox']['output'];
const botsByHost = signal<Record<string, BotOutbox>>({});

export const scopedBots = computed(() =>
  connectedHosts()
    .filter(
      ({ host, connection }) =>
        hasAgentEndpoint(connection) &&
        (selectedScopeRootId() === 'all' || selectedScopeRootId() === host.rootId),
    )
    .map(({ host }) => {
      const outbox = botsByHost()[host.rootId];
      const session = outbox?.sessionId
        ? findScopedSession(host.rootId, outbox.sessionId)
        : undefined;
      return { host, outbox, session };
    }),
);

export async function openHostBot(rootId: string, hostName: string): Promise<ScopedSession> {
  const result = await hostMutate<ServiceMethods['agent']['openBot']['output']>(
    'agent',
    'openBot',
    {},
    { rootId },
  );
  if (result.kind !== 'opened') throw new Error(result.reason);
  const observed = await hostQuery<{ session: AgentSession }>(
    'agent',
    'observe',
    { sessionId: result.sessionId },
    undefined,
    rootId,
  );
  await refreshHostSessions(rootId, hostName);
  return { key: rootId + '::' + result.sessionId, rootId, hostName, session: observed.session };
}

const loading = signal(false);
const searchQuery = signal('');
const showArchived = signal(false);

const activeSubscriptions = new Map<
  string,
  {
    generation: number | undefined;
    catalogId: string;
    botId: string;
    handles: SubscriptionHandle[];
  }
>();
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
  for (const host of savedHosts()) {
    for (const item of byHost[host.rootId] ?? []) merged.push(item);
  }
  merged.sort((a, b) => (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0));
  return merged;
});

export const filteredSessions = computed<ScopedSession[]>(() => {
  const scope = selectedScopeRootId();
  const q = searchQuery().trim().toLowerCase();
  const archived = showArchived();
  return allSessions().filter((item) => {
    if (botsByHost()[item.rootId]?.sessionId === item.session.id) return false;
    if (scope !== 'all' && item.rootId !== scope) return false;
    if (Boolean(item.session.archived) !== archived) return false;
    if (!q) return true;
    const hay = [item.session.title, item.session.workspace?.path ?? '', item.hostName]
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

function applySessionPage(rootId: string, hostName: string, page: AgentSessionPage) {
  const items: ScopedSession[] = page.sessions.map((session) => ({
    key: rootId + '::' + session.id,
    rootId,
    hostName,
    session,
  }));
  sessionsByHost.update((prev) => ({ ...prev, [rootId]: items }));
}

export async function refreshHostSessions(rootId: string, hostName: string) {
  try {
    const generation = activeHostInfo(rootId)?.generation;
    const [page, outbox] = await Promise.all([
      hostQuery<AgentSessionPage>(
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
      ),
      hostQuery<BotOutbox>('agent', 'botOutbox', { limit: 0 }, undefined, rootId).catch((cause) => {
        console.warn('Bot outbox unavailable', cause);
        return undefined;
      }),
    ]);
    if (activeHostInfo(rootId)?.generation !== generation) return;
    if (outbox) botsByHost.update((prev) => ({ ...prev, [rootId]: outbox }));
    if (page) applySessionPage(rootId, hostName, page);
  } catch (cause) {
    console.warn('Could not refresh sessions', cause);
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
    if (res.kind === 'revision_conflict') {
      await refreshHostSessions(item.rootId, item.hostName);
      throw new Error(res.kind);
    }
    if (res.kind === 'rejected') throw new Error(String(res.reason ?? 'rejected'));
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
    if (res.kind === 'revision_conflict') {
      await refreshHostSessions(item.rootId, item.hostName);
      throw new Error(res.kind);
    }
    if (res.kind === 'rejected') throw new Error(String(res.reason ?? 'rejected'));
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
    const res = await hostMutate<ServiceMethods['agent']['changeSession']['output']>(
      'agent',
      'changeSession',
      {
        sessionId: item.session.id,
        expectedRevision: item.session.revision,
        action: 'remove',
      },
      { rootId: item.rootId },
    );
    if (res.kind === 'revision_conflict') {
      await refreshHostSessions(item.rootId, item.hostName);
      throw new Error(res.kind);
    }
    if (res.kind !== 'removed') throw new Error(res.kind === 'rejected' ? res.reason : res.kind);
    hapticNotification('warning');
    await refreshHostSessions(item.rootId, item.hostName);
    return true;
  } catch (cause) {
    hapticNotification('error');
    showToast(cause instanceof Error ? cause.message : String(cause));
    return false;
  }
}

export async function listHostProjects(rootId: string, current: () => boolean) {
  type Page = ServiceMethods['agent']['projects']['output'];
  const projects: (AgentProject & { path: string })[] = [];
  let cursor: Extract<Page, { kind: 'projects' }>['next'] = null;
  do {
    const page: Page = await hostQuery<Page>(
      'agent',
      'projects',
      { kind: 'list', cursor },
      undefined,
      rootId,
    );
    if (!current()) return [];
    if (page.kind !== 'projects') throw new Error(page.kind);
    for (const project of page.projects) {
      if (!project.archived && project.available !== false && project.path != null)
        projects.push({ ...project, path: project.path });
    }
    cursor = page.next;
  } while (cursor != null);
  return projects;
}

export async function listHostModels(rootId: string, current: () => boolean) {
  type Page = ServiceMethods['agent']['models']['output'];
  let input: ServiceMethods['agent']['models']['input'] = { kind: 'start', query: '' };
  const choices: Extract<Page, { kind: 'ready' }>['choices'] = [];
  for (;;) {
    const page: Page = await hostQuery<Page>('agent', 'models', input, undefined, rootId);
    if (!current()) return [];
    if (page.kind !== 'ready') throw new Error(page.kind);
    choices.push(...page.choices);
    if (page.next == null) return choices;
    input = { kind: 'continue', revision: page.revision, cursor: page.next };
  }
}

export async function listHostDirectoryRoots(
  rootId: string,
): Promise<{ name: string; path: string }[]> {
  const page = await hostQuery<ServiceMethods['agent']['directories']['output']>(
    'agent',
    'directories',
    { kind: 'roots' },
    undefined,
    rootId,
  );
  if (page.kind !== 'roots') throw new Error(page.kind);
  return page.roots;
}

export async function roomMembers(rootId: string, sessionId: string) {
  const result = await hostQuery<ServiceMethods['agent']['history']['output']>(
    'agent',
    'history',
    { sessionId, position: { kind: 'tail' }, view: 'chat', includeThinking: false },
    undefined,
    rootId,
  );
  if (result.kind !== 'room') throw new Error(result.kind);
  return result.page.participants ?? [];
}

export function listHostFiles(
  rootId: string,
  input: ServiceMethods['agent']['listFiles']['input'],
) {
  return hostQuery<ServiceMethods['agent']['listFiles']['output']>(
    'agent',
    'listFiles',
    { ...input },
    undefined,
    rootId,
  );
}

export async function createHostSession(params: {
  rootId: string;
  generation: number;
  title: string;
  kind: 'agent' | 'room';
  workspace: AgentWorkspaceSelection;
  automaticTitle: boolean;
  presetId?: string;
  backend?: AgentBackendPreference | null;
}): Promise<ScopedSession> {
  const res = await hostMutate<ServiceMethods['agent']['create']['output']>(
    'agent',
    'create',
    {
      incognito: false,
      kind: params.kind,
      presetId: params.presetId ?? null,
      backend: params.kind === 'room' ? null : (params.backend ?? null),
      automaticTitle: params.kind === 'room' ? false : params.automaticTitle,
      tools: null,
      title: params.title,
      labels: [],
      workspace: params.workspace,
    },
    { rootId: params.rootId, generation: params.generation },
  );
  if (res.kind === 'rejected') throw new Error(res.reason);
  const session = res.session;
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
    const rootId = payload.rootId;
    if (!rootId) return;
    const sub = activeSubscriptions.get(rootId);
    if (!sub || activeHostInfo(rootId)?.generation !== sub.generation) return;
    if (payload.subscriptionId === sub.botId) {
      const outbox = payload.item as BotOutbox;
      botsByHost.update((prev) => ({ ...prev, [rootId]: outbox }));
    } else if (payload.subscriptionId === sub.catalogId) {
      const host = hostById(rootId);
      if (host && !showArchived())
        applySessionPage(rootId, host.hostName, payload.item as AgentSessionPage);
    }
  });

  onSubscriptionEnded(({ rootId, subscriptionId }) => {
    if (!rootId) return;
    const sub = activeSubscriptions.get(rootId);
    if (sub) sub.handles = sub.handles.filter((handle) => handle.subscriptionId !== subscriptionId);
  });

  effect(() => {
    const current = connectedHosts().filter(({ connection }) => hasAgentEndpoint(connection));
    const roots = new Map(
      current.map(({ host, connection }) => [host.rootId, connection.generation]),
    );
    for (const [rootId, sub] of activeSubscriptions) {
      if (roots.has(rootId) && roots.get(rootId) === sub.generation) continue;
      activeSubscriptions.delete(rootId);
      sessionsByHost.update((prev) => {
        const next = { ...prev };
        delete next[rootId];
        return next;
      });
      botsByHost.update((prev) => {
        const next = { ...prev };
        delete next[rootId];
        return next;
      });
      for (const handle of sub.handles) {
        void unsubscribe(handle).catch((cause) =>
          console.warn('Could not stop session watch', cause),
        );
      }
    }
    for (const { host, connection } of current) {
      const { rootId, hostName } = host;
      if (activeSubscriptions.has(rootId)) continue;
      const sub = {
        generation: connection.generation,
        catalogId: 'catalog:' + rootId + ':' + String(++subSeq),
        botId: 'bot:' + rootId + ':' + String(subSeq),
        handles: [] as SubscriptionHandle[],
      };
      activeSubscriptions.set(rootId, sub);
      void refreshHostSessions(rootId, hostName);
      const watch = (id: string, method: string, input: Record<string, unknown>) =>
        subscribe(id, 'agent', method, input, rootId)
          .then((handle) => {
            if (activeSubscriptions.get(rootId) === sub) sub.handles.push(handle);
            else return unsubscribe(handle);
          })
          .catch((cause) => console.warn('Could not watch ' + method, cause));
      void watch(sub.catalogId, 'catalog', {
        kind: null,
        filter: 'all',
        includeArchived: false,
        rootsOnly: false,
        position: { kind: 'start' },
        scope: { kind: 'all' },
        titleQuery: '',
      });
      void watch(sub.botId, 'watchBotOutbox', { limit: 0 });
    }
  });
}
