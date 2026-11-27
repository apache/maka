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

import { cleanup, computed, effect, signal, untracked, type Signal } from 'nsh';
import {
  hasAgentEndpoint,
  hostMutate,
  hostQuery,
  watchHost,
  type AgentBackendPreference,
  type AgentProject,
  type AgentSession,
  type ServiceMethods,
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
import { tr } from '../locale';
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

type SessionRetry =
  | { kind: 'failed'; limit: number; error: string }
  | { kind: 'interrupted'; limit: number };

interface SessionReadPlan {
  limit: number;
  retry?: SessionRetry;
}

type SessionWindow =
  | { kind: 'ready'; snapshot: SessionSnapshot }
  | ({ kind: 'reading'; snapshot?: SessionSnapshot; revision?: string } & SessionReadPlan)
  | ({ kind: 'loadingHead'; snapshot?: SessionSnapshot } & SessionReadPlan)
  | (SessionRetry & { snapshot?: SessionSnapshot });

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

interface SessionSubscription {
  connectionGeneration: number;
  stopCatalog?: () => void;
  catalogWatchError: Signal<string | null>;
  stopBot: () => void;
  headRequest?: object;
  botRequest?: object;
}
const activeSubscriptions = new Map<string, SessionSubscription>();
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
    for (const item of byHost[host.rootId]?.snapshot?.items ?? []) {
      merged.push(item.hostName === host.hostName ? item : { ...item, hostName: host.hostName });
    }
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

function refreshPlan(previous?: SessionWindow): SessionReadPlan {
  if (previous?.kind === 'reading' || previous?.kind === 'loadingHead') {
    return { limit: previous.limit, retry: previous.retry };
  }
  if (!previous) return { limit: 1 };
  const { snapshot, ...state } = previous;
  return {
    limit: snapshot?.catalog.pages ?? 1,
    retry: state.kind === 'ready' ? undefined : state,
  };
}

function publishCatalog(rootId: string, snapshot: SessionSnapshot, retry?: SessionRetry) {
  setWindow(
    rootId,
    retry && retry.limit > snapshot.catalog.pages && snapshot.catalog.after !== null
      ? { ...retry, snapshot }
      : { kind: 'ready', snapshot },
  );
}

async function readSessionWindow(
  rootId: string,
  hostName: string,
  start: CatalogStart,
  plan: SessionReadPlan,
) {
  const sub = activeSubscriptions.get(rootId);
  if (!sub || activeHostInfo(rootId)?.generation !== sub.connectionGeneration) return;
  const snapshot = sessionsByHost()[rootId]?.snapshot;
  const window: SessionWindow = {
    kind: 'reading',
    snapshot,
    revision: start.kind === 'head' ? start.page?.revision : start.window.revision,
    ...plan,
  };
  setWindow(rootId, window);
  const current = () =>
    sessionsByHost()[rootId] === window &&
    activeHostInfo(rootId)?.generation === sub.connectionGeneration;
  try {
    const catalog = await readCatalog(rootId, sessionFilter(), current, plan.limit, start);
    if (!catalog || !current()) return;
    if (catalog.revision !== window.revision) sub.headRequest = undefined;
    const items = catalog.sessions.map((session) => ({
      key: rootId + '::' + session.id,
      rootId,
      hostName,
      session,
    }));
    publishCatalog(rootId, { catalog, items }, plan.retry);
  } catch (cause) {
    if (!current()) return;
    setWindow(rootId, {
      kind: 'failed',
      snapshot,
      limit: plan.retry?.limit ?? plan.limit,
      error: errorMessage(cause),
    });
  }
}

export function isBotSession(rootId: string, sessionId: string) {
  return botsByHost()[rootId]?.sessionId === sessionId;
}

export function watchSideQuestions(item: ScopedSession, enabled: () => boolean) {
  const { rootId } = item;
  const sessionId = item.session.id;
  const sessions = signal<AgentSession[] | null>(null);
  const error = signal<string | null>(null);
  const scope = { kind: 'side_questions', sessionId } as const;
  const connectedGeneration = computed(() => activeHostInfo(rootId)?.generation);
  effect(() => {
    const generation = connectedGeneration();
    if (!enabled() || generation == null) return;
    sessions.set(null);
    error.set(null);
    let revision: string | undefined;
    let epoch = 0;
    const report = (cause: unknown) => {
      console.warn('Could not load side questions', cause);
      error.set(tr('Could not load side questions'));
    };
    const stop = watchHost<AgentSessionPage>(
      rootId,
      generation,
      'sides:' + rootId + ':' + ++subSeq,
      'catalog',
      catalogInput('all', undefined, scope),
      (page) => {
        if (page.revision === revision) return;
        revision = page.revision;
        const request = ++epoch;
        const current = () =>
          epoch === request && activeHostInfo(rootId)?.generation === generation;
        void readCatalog(rootId, 'all', current, Infinity, { kind: 'head', page }, scope).then(
          (catalog) => {
            if (!catalog || !current()) return;
            sessions.set(
              catalog.sessions.filter(
                (session) => session.branch?.side && session.branch.sessionId === sessionId,
              ),
            );
            error.set(null);
          },
          (cause) => {
            if (!current()) return;
            revision = undefined;
            report(cause);
          },
        );
      },
      (cause) => {
        epoch++;
        report(cause);
      },
    );
    cleanup(() => {
      epoch++;
      stop();
    });
  });
  return { sessions, error };
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function applySessionPage(rootId: string, hostName: string, page: AgentSessionPage) {
  const previous = sessionsByHost()[rootId];
  if (previous?.kind === 'reading' && previous.revision === page.revision) return;
  const snapshot = previous?.snapshot;
  // A background head refresh may update the committed range, but cannot
  // authorize the extra page of a failed or interrupted extension.
  const plan = refreshPlan(previous);
  if (
    snapshot &&
    snapshot.catalog.revision === page.revision &&
    snapshot.catalog.pages >= plan.limit
  ) {
    if (previous?.kind !== 'ready') publishCatalog(rootId, snapshot, plan.retry);
    return;
  }
  return readSessionWindow(rootId, hostName, { kind: 'head', page }, plan);
}

export const scopedSessionLoad = computed(() => {
  const scope = selectedScopeRootId();
  const windows = sessionsByHost();
  let hasItems = false;
  let loading = false;
  let refreshing = false;
  let error: string | null = null;
  for (const { rootId } of savedHosts()) {
    if (scope !== 'all' && scope !== rootId) continue;
    const window = windows[rootId];
    if (window?.snapshot?.items.length) hasItems = true;
    const connection = activeHostInfo(rootId);
    if (!connection || !hasAgentEndpoint(connection)) continue;
    if (window?.kind === 'failed') error ??= window.error;
    else if (!window?.snapshot) loading = true;
    else if (window.kind === 'loadingHead' || window.kind === 'reading') refreshing = true;
    const sub = activeSubscriptions.get(rootId);
    if (sub?.connectionGeneration === connection.generation) error ??= sub.catalogWatchError();
  }
  return { hasItems, loading, refreshing, error };
});

function scopedWindows() {
  const scope = selectedScopeRootId();
  const byHost = sessionsByHost();
  return connectedHosts().flatMap(({ host, connection }) => {
    const window = byHost[host.rootId];
    return window && (scope === 'all' || scope === host.rootId) && hasAgentEndpoint(connection)
      ? [{ host, window }]
      : [];
  });
}

export const hasMoreSessions = () =>
  scopedWindows().some(({ window }) => window.snapshot?.catalog.after != null);
const extendableCatalog = (window: SessionWindow) =>
  window.kind === 'ready' && window.snapshot.catalog.after !== null
    ? window.snapshot.catalog
    : undefined;
export const canLoadMoreSessions = () =>
  scopedWindows().some(({ window }) => extendableCatalog(window) !== undefined);
export const loadingMoreSessions = () =>
  scopedWindows().some(({ window }) => window.kind === 'reading' || window.kind === 'loadingHead');
export const sessionPaginationFailed = () =>
  scopedWindows().some(({ window }) => window.kind === 'failed' || window.kind === 'interrupted');

export async function loadMoreSessions() {
  await Promise.all(
    scopedWindows().map(({ host: { rootId, hostName }, window }) => {
      const catalog = extendableCatalog(window);
      if (catalog)
        return readSessionWindow(
          rootId,
          hostName,
          { kind: 'extend', window: catalog },
          { limit: catalog.pages + 1 },
        );
    }),
  );
}

export function retryFailedSessions() {
  for (const {
    host: { rootId, hostName },
    window,
  } of scopedWindows()) {
    const sub = activeSubscriptions.get(rootId);
    if (window.kind === 'failed' || window.kind === 'interrupted')
      void refreshHostSessions(rootId, hostName, true);
    else if (sub && sub.catalogWatchError() !== null) watchSessionCatalog(rootId, hostName, sub);
  }
}

function watchSessionCatalog(rootId: string, hostName: string, sub: SessionSubscription) {
  if (sub.stopCatalog) return;
  sub.stopCatalog = watchHost<AgentSessionPage>(
    rootId,
    sub.connectionGeneration,
    'catalog:' + rootId + ':' + ++subSeq,
    'catalog',
    catalogInput('all'),
    (page) => {
      if (showArchived()) return;
      sub.headRequest = undefined;
      void applySessionPage(rootId, hostName, page);
    },
    (cause) => {
      sub.stopCatalog = undefined;
      sub.catalogWatchError.set(errorMessage(cause));
    },
    () => sub.catalogWatchError.set(null),
  );
}

export async function refreshHostSessions(rootId: string, hostName: string, retry = false) {
  const sub = activeSubscriptions.get(rootId);
  if (!sub) return;
  watchSessionCatalog(rootId, hostName, sub);
  const request = {};
  sub.headRequest = request;
  sub.botRequest = request;
  const current = () =>
    activeSubscriptions.get(rootId) === sub &&
    activeHostInfo(rootId)?.generation === sub.connectionGeneration;
  const previous = sessionsByHost()[rootId];
  if (previous?.kind !== 'reading') {
    const plan = refreshPlan(previous);
    setWindow(rootId, {
      kind: 'loadingHead',
      snapshot: previous?.snapshot,
      ...(retry && plan.retry ? { limit: plan.retry.limit } : plan),
    });
  }
  const filter = sessionFilter();
  await Promise.all([
    listSessionPage(rootId, filter)
      .then((page) => {
        if (current() && sub.headRequest === request)
          return applySessionPage(rootId, hostName, page);
      })
      .catch((cause) => {
        if (!current() || sub.headRequest !== request) return;
        const window = sessionsByHost()[rootId];
        if (window?.kind === 'loadingHead') {
          setWindow(rootId, {
            kind: 'failed',
            snapshot: window.snapshot,
            limit: window.retry?.limit ?? window.limit,
            error: errorMessage(cause),
          });
        } else {
          console.warn('Could not refresh sessions', cause);
        }
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
      sub.stopCatalog?.();
      sub.stopBot();
      const window = untracked(() => sessionsByHost()[rootId]);
      if (window?.kind === 'reading' || window?.kind === 'loadingHead') {
        setWindow(rootId, {
          ...(window.retry ?? { kind: 'interrupted', limit: window.limit }),
          snapshot: window.snapshot,
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
      const sub: SessionSubscription = {
        connectionGeneration: generation,
        catalogWatchError: signal<string | null>(null),
        stopBot: watchHost<BotOutbox>(
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
      };
      activeSubscriptions.set(rootId, sub);
      untracked(() => void refreshHostSessions(rootId, hostName));
    }
  });
}
