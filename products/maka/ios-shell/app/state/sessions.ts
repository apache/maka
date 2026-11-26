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

import { computed, effect, signal, untracked } from 'nsh';
import { tr } from '../locale';
import {
  hasAgentEndpoint,
  hostMutate,
  hostQuery,
  watchHost,
  type AgentBackendPreference,
  type AgentProject,
  type AgentSession,
  type AgentSessionPage,
  type AgentWorkspaceSelection,
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
import {
  catalogInput,
  listSessionPage,
  readCatalog,
  type CatalogStart,
  type CatalogWindow,
} from './sessionCatalog';

export interface ScopedSession {
  key: string;
  rootId: string;
  hostName: string;
  session: AgentSession;
}

interface SessionSnapshot {
  catalog: CatalogWindow;
  items: ScopedSession[];
}

type SessionWindow =
  | { kind: 'ready'; snapshot: SessionSnapshot }
  | { kind: 'reading'; snapshot?: SessionSnapshot; revision: string; limit: number }
  | { kind: 'failed' | 'interrupted'; snapshot?: SessionSnapshot; limit: number };

const sessionsByHost = signal<Record<string, SessionWindow>>({});
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
  if (result.kind !== 'opened')
    throw new Error(tr('Could not open the conversation.'), { cause: result.reason });
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
    connectionGeneration: number;
    stop: (() => void)[];
    headRequest?: object;
    botRequest?: object;
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
  if (showArchived() === archived) return;
  for (const sub of activeSubscriptions.values()) sub.headRequest = undefined;
  sessionsByHost.set({});
  showArchived.set(archived);
  void refreshAllSessions();
}

export const allSessions = computed<ScopedSession[]>(() => {
  const byHost = sessionsByHost();
  const merged: ScopedSession[] = [];
  for (const host of savedHosts()) {
    for (const item of byHost[host.rootId]?.snapshot?.items ?? []) merged.push(item);
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
  return (sessionsByHost()[rootId]?.snapshot?.items ?? []).find((s) => s.session.id === sessionId);
}

const sessionFilter = () => (showArchived() ? 'archived' : 'all');

function setWindow(rootId: string, window: SessionWindow) {
  sessionsByHost.update((prev) => ({ ...prev, [rootId]: window }));
}

async function readSessionWindow(
  rootId: string,
  hostName: string,
  limit: number,
  start: { kind: 'head'; page: AgentSessionPage } | Extract<CatalogStart, { kind: 'extend' }>,
) {
  const sub = activeSubscriptions.get(rootId);
  if (!sub || activeHostInfo(rootId)?.generation !== sub.connectionGeneration) return;
  const snapshot = sessionsByHost()[rootId]?.snapshot;
  const window: SessionWindow = {
    kind: 'reading',
    snapshot,
    revision: start.kind === 'head' ? start.page.revision : start.window.revision,
    limit,
  };
  setWindow(rootId, window);
  const current = () =>
    sessionsByHost()[rootId] === window &&
    activeHostInfo(rootId)?.generation === sub.connectionGeneration;
  try {
    const catalog = await readCatalog(rootId, sessionFilter(), current, limit, start);
    if (!catalog || !current()) return;
    if (catalog.revision !== window.revision) sub.headRequest = undefined;
    const items = catalog.sessions.map((session) => ({
      key: rootId + '::' + session.id,
      rootId,
      hostName,
      session,
    }));
    setWindow(rootId, { kind: 'ready', snapshot: { catalog, items } });
  } catch (cause) {
    if (!current()) return;
    setWindow(rootId, { kind: 'failed', snapshot, limit });
    showToast(cause instanceof Error ? cause.message : String(cause));
  }
}

function applySessionPage(rootId: string, hostName: string, page: AgentSessionPage) {
  const previous = sessionsByHost()[rootId];
  if (
    (previous?.kind === 'ready' && previous.snapshot.catalog.revision === page.revision) ||
    (previous?.kind === 'reading' && previous.revision === page.revision)
  )
    return;
  // Rebuild only the range already requested, and swap it in as one revision.
  const limit =
    previous && previous.kind !== 'ready'
      ? previous.limit
      : (previous?.snapshot?.catalog.pages ?? 1);
  return readSessionWindow(rootId, hostName, limit, { kind: 'head', page });
}

function scopedWindows() {
  const scope = selectedScopeRootId();
  const byHost = sessionsByHost();
  return connectedHosts().flatMap(({ host: { rootId }, connection }) => {
    const window = byHost[rootId];
    return window && (scope === 'all' || scope === rootId) && hasAgentEndpoint(connection)
      ? [[rootId, window] as const]
      : [];
  });
}

export const hasMoreSessions = () =>
  scopedWindows().some(
    ([, window]) =>
      window.kind === 'failed' ||
      window.kind === 'interrupted' ||
      window.snapshot?.catalog.after != null,
  );
export const loadingMoreSessions = () =>
  scopedWindows().some(([, window]) => window.kind === 'reading');

export async function loadMoreSessions() {
  if (loadingMoreSessions()) return;
  await Promise.all(
    scopedWindows().map(([rootId, window]) => {
      const host = hostById(rootId);
      if (!host) return;
      if (window.kind === 'failed' || window.kind === 'interrupted')
        return refreshHostSessions(rootId, host.hostName);
      if (window.kind === 'ready' && window.snapshot.catalog.after)
        return readSessionWindow(rootId, host.hostName, window.snapshot.catalog.pages + 1, {
          kind: 'extend',
          window: window.snapshot.catalog,
        });
    }),
  );
}

export async function refreshHostSessions(rootId: string, hostName: string) {
  const sub = activeSubscriptions.get(rootId);
  if (!sub) return;
  const request = {};
  sub.headRequest = request;
  sub.botRequest = request;
  const current = () =>
    activeSubscriptions.get(rootId) === sub &&
    activeHostInfo(rootId)?.generation === sub.connectionGeneration;
  const filter = sessionFilter();
  await Promise.all([
    listSessionPage(rootId, filter)
      .then((page) => {
        if (current() && sub.headRequest === request)
          return applySessionPage(rootId, hostName, page);
      })
      .catch((cause) => {
        if (current() && sub.headRequest === request)
          console.warn('Could not refresh sessions', cause);
      }),
    hostQuery<BotOutbox>('agent', 'botOutbox', { limit: 0 }, undefined, rootId)
      .then((outbox) => {
        if (current() && sub.botRequest === request)
          botsByHost.update((prev) => ({ ...prev, [rootId]: outbox }));
      })
      .catch((cause) => {
        if (current()) console.warn('Bot outbox unavailable', cause);
      }),
  ]);
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
      throw new Error(tr('Refresh and try again.'));
    }
    if (res.kind === 'rejected')
      throw new Error(tr('Could not update the conversation.'), { cause: res.reason });
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
      throw new Error(tr('Refresh and try again.'));
    }
    if (res.kind === 'rejected')
      throw new Error(tr('Could not update the conversation.'), { cause: res.reason });
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
      throw new Error(tr('Refresh and try again.'));
    }
    if (res.kind !== 'removed')
      throw new Error(tr('Could not update the conversation.'), {
        cause: res.kind === 'rejected' ? res.reason : res.kind,
      });
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
    if (page.kind !== 'projects')
      throw new Error(tr('Projects are unavailable.'), { cause: page.kind });
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
    if (page.kind !== 'ready') throw new Error(tr('Could not load models.'), { cause: page.kind });
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
  if (page.kind !== 'roots') throw new Error(tr('Unavailable'), { cause: page.kind });
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
  if (result.kind !== 'room')
    throw new Error(tr('Could not load conversation history.'), { cause: result.kind });
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
  if (res.kind === 'rejected')
    throw new Error(tr('Could not open the conversation.'), { cause: res.reason });
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

function pruneForgottenHosts<T>(
  cache: { update: (update: (previous: Record<string, T>) => Record<string, T>) => void },
  saved: Set<string>,
) {
  cache.update((previous) => {
    const removed = Object.keys(previous).filter((rootId) => !saved.has(rootId));
    if (removed.length === 0) return previous;
    const next = { ...previous };
    for (const rootId of removed) delete next[rootId];
    return next;
  });
}

export function startSessionsStore() {
  if (initialized) return;
  initialized = true;

  effect(() => {
    const current = connectedHosts().filter(({ connection }) => hasAgentEndpoint(connection));
    const roots = new Map(
      current.map(({ host, connection }) => [host.rootId, connection.generation]),
    );
    for (const [rootId, sub] of activeSubscriptions) {
      if (roots.has(rootId) && roots.get(rootId) === sub.connectionGeneration) continue;
      activeSubscriptions.delete(rootId);
      for (const stop of sub.stop) stop();
      const window = untracked(() => sessionsByHost()[rootId]);
      if (window?.kind === 'reading') {
        setWindow(rootId, {
          kind: 'interrupted',
          snapshot: window.snapshot,
          limit: window.limit,
        });
      }
    }
    // Keep the last catalog visible across transport loss; only unpairing forgets it.
    const saved = new Set(savedHosts().map(({ rootId }) => rootId));
    pruneForgottenHosts(sessionsByHost, saved);
    pruneForgottenHosts(botsByHost, saved);
    for (const {
      host: { rootId, hostName },
      connection: { generation },
    } of current) {
      if (activeSubscriptions.has(rootId)) continue;
      const sub: {
        connectionGeneration: number;
        stop: (() => void)[];
        headRequest?: object;
        botRequest?: object;
      } = {
        connectionGeneration: generation,
        stop: [],
      };
      activeSubscriptions.set(rootId, sub);
      sub.stop.push(
        watchHost<AgentSessionPage>(
          rootId,
          generation,
          'catalog:' + rootId + ':' + ++subSeq,
          'catalog',
          catalogInput('all'),
          (page) => {
            if (showArchived()) return;
            sub.headRequest = undefined;
            void applySessionPage(rootId, hostName, page);
          },
          (cause) => console.warn('Could not watch catalog', cause),
        ),
        watchHost<BotOutbox>(
          rootId,
          generation,
          'bot:' + rootId + ':' + ++subSeq,
          'watchBotOutbox',
          { limit: 0 },
          (outbox) => {
            sub.botRequest = undefined;
            botsByHost.update((prev) => ({ ...prev, [rootId]: outbox }));
          },
          (cause) => console.warn('Could not watch Bot outbox', cause),
        ),
      );
      untracked(() => void refreshHostSessions(rootId, hostName));
    }
  });
}
