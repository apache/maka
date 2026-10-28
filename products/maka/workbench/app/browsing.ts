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

import { createText, errorText, UiError } from './text';
import { batch, cleanup, signal } from 'nsh';
import type { Host } from './host';
import type {
  AgentSessionListScope,
  AgentSessionFilter,
  AgentSession,
  AgentSessionPage,
  AgentProject,
  AgentProjectsPage,
  AgentProjectsRead,
  AgentProjectCursor,
  AgentWorkspaceSelection,
  AgentSessionPosition,
} from '../../../../packages/plugin-sdk/src/index.js';

export type BrowserScope = AgentSessionListScope;
export type BrowserSession = AgentSession;
export type BrowserProject = AgentProject;
export type BrowserWorkspace = AgentWorkspaceSelection;

export type Browsing = {
  scope(): BrowserScope;
  filter(): AgentSessionFilter;
  sessions(): BrowserSession[];
  projects(): BrowserProject[];
  loading(): boolean;
  error(): string;
  projectError(): string;
  setScope(scope: BrowserScope): void;
  setFilter(filter: AgentSessionFilter): void;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
};

type SessionPage = AgentSessionPage;
type ProjectCursor = AgentProjectCursor;
type ProjectsPage = AgentProjectsPage;
type Subscription = {
  next(): Promise<SessionPage | null>;
  close(): Promise<void>;
};
type CatalogRead = {
  scope: BrowserScope;
  filter: AgentSessionFilter;
  stream: Subscription | null;
  // Local read intent: the last published row and one requested next page.
  extent: string | null;
  extend: boolean;
  ready(): void;
};

const uniqueSessions = (items: BrowserSession[]) => [
  ...new Map(items.map((session) => [session.id, session])).values(),
];

// One mounted read projection serves the workspace browser and session picker.
// Host revisions own paging; these snapshots grant no mutation authority.
export function createBrowsing(host: Host): Browsing {
  const scope = signal<BrowserScope>({ kind: 'all' });
  const filter = signal<AgentSessionFilter>('all');
  const sessions = signal<BrowserSession[]>([]);
  const projects = signal<BrowserProject[]>([]);
  const loading = signal(true);
  const error = createText();
  const projectError = createText();
  let alive = true;
  let current: CatalogRead | null = null;
  let page: SessionPage | null = null;
  let continuation: SessionPage | null = null;
  let projectRead: object | null = null;
  const owns = (read: CatalogRead) => alive && current === read;
  const list = async (read: CatalogRead, position: AgentSessionPosition): Promise<SessionPage> =>
    host.query('agent', 'list', {
      filter: read.filter,
      scope: read.scope,
      position,
    });
  const sameRevision = (next: SessionPage, revision: string) => {
    if (next.revision !== revision) throw new Error('agent_catalog_changed');
  };
  const after = async (read: CatalogRead, previous: SessionPage): Promise<SessionPage> => {
    const next = await list(read, {
      kind: 'after',
      revision: previous.revision,
      cursor: previous.after!,
    });
    sameRevision(next, previous.revision);
    if (next.after === previous.after)
      throw new UiError('Conversation paging did not advance. Refresh to continue.');
    return next;
  };
  const close = (read: CatalogRead | null) => {
    if (!read) return;
    read.ready();
    const stream = read.stream;
    read.stream = null;
    if (stream) void stream.close().catch(() => {});
  };
  cleanup(() => {
    alive = false;
    close(current);
    current = null;
    projectRead = null;
  });

  const restart = (clear: boolean): Promise<void> => {
    const extent = clear ? null : (current?.extent ?? sessions().at(-1)?.id ?? null);
    const extend = !clear && (current?.extend ?? false);
    close(current);
    let ready!: () => void;
    const firstPage = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const read: CatalogRead = {
      scope: scope(),
      filter: filter(),
      stream: null,
      extent,
      extend,
      ready,
    };
    current = read;
    page = null;
    continuation = null;
    batch(() => {
      loading.set(clear || sessions().length === 0);
      error.set('');
      if (clear) sessions.set([]);
    });
    void (async () => {
      const opened: Subscription = await host.subscribe('agent', 'catalog', {
        filter: read.filter,
        scope: read.scope,
        position: { kind: 'start' },
      });
      if (!owns(read)) {
        await opened.close();
        return;
      }
      read.stream = opened;
      for (;;) {
        const next = await opened.next();
        if (!owns(read)) return;
        if (next === null) throw new UiError('Conversation updates ended. Refresh to reconnect.');
        if (page?.revision === next.revision) continue;
        // Preserve the requested read range, never append across revisions.
        // The old snapshot stays mounted while this revision is assembled.
        continuation = next;
        if (sessions().length) loading.set(false);
        let tail = next;
        const rows = new Map(next.sessions.map((session) => [session.id, session]));
        const through = read.extent;
        let boundary = through;
        try {
          if (boundary && !rows.has(boundary) && tail.after) {
            const located = await list(read, { kind: 'at', cursor: boundary });
            if (!owns(read)) return;
            sameRevision(located, next.revision);
            // At returns the current successor window, or the last window if
            // the old boundary was removed at the end. Do not parse its ID.
            if (!located.sessions.some((session) => session.id === boundary))
              boundary = located.sessions.at(-1)?.id ?? null;
          }
          for (;;) {
            const reached = boundary === null || rows.has(boundary);
            const extended =
              boundary !== through ||
              (through !== null && rows.has(through) && tail.sessions.at(-1)?.id !== through);
            if ((reached && (!read.extend || extended)) || !tail.after) break;
            tail = await after(read, tail);
            if (!owns(read)) return;
            for (const session of tail.sessions) rows.set(session.id, session);
          }
        } catch (reason) {
          if (!owns(read)) return;
          // Subscription-before-read guarantees a newer catalog window for
          // this conflict. Keep the gate until it arrives, without retry IO.
          if (errorText(reason) === 'agent_catalog_changed') continue;
          throw reason;
        }
        const snapshot = [...rows.values()];
        page = tail;
        continuation = null;
        read.extent = snapshot.at(-1)?.id ?? null;
        read.extend = false;
        batch(() => {
          sessions.set(snapshot);
          loading.set(false);
          error.set('');
        });
        read.ready();
      }
    })()
      .catch((reason) => {
        if (!owns(read)) return;
        page = null;
        continuation = null;
        batch(() => {
          error.set(errorText(reason));
          loading.set(false);
        });
      })
      .finally(() => close(read));
    return firstPage;
  };

  const loadMore = async () => {
    const read = current;
    const original = page;
    if (!read || !owns(read) || error()) return;
    if (!original) {
      if (read.extent !== null) read.extend = true;
      return;
    }
    if (!original.after) return;
    read.extend = true;
    if (continuation || loading()) return;
    continuation = original;
    loading.set(true);
    let waitForCatalog = false;
    try {
      const next = await after(read, original);
      if (!owns(read) || continuation !== original) return;
      const snapshot = uniqueSessions([...sessions(), ...next.sessions]);
      page = next;
      read.extent = snapshot.at(-1)?.id ?? null;
      read.extend = false;
      sessions.set(snapshot);
    } catch (reason) {
      if (!owns(read) || continuation !== original) return;
      if (errorText(reason) === 'agent_catalog_changed') {
        waitForCatalog = true;
        return;
      }
      error.set(errorText(reason));
    } finally {
      if (owns(read) && continuation === original) {
        if (!waitForCatalog) continuation = null;
        loading.set(false);
      }
    }
  };

  const loadProjects = async () => {
    const reading = {};
    projectRead = reading;
    projectError.set('');
    try {
      // Only an explicit revision change starts another read. Transport and
      // availability errors stay visible instead of becoming retry loops.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const items: BrowserProject[] = [];
        let cursor: ProjectCursor | null = null;
        for (;;) {
          const next: ProjectsPage = await host.query('agent', 'projects', {
            kind: 'list',
            cursor,
          } satisfies AgentProjectsRead);
          if (!alive || projectRead !== reading) return;
          if (next.kind === 'changed') break;
          if (next.kind !== 'projects') throw new UiError('Projects are unavailable.');
          if (cursor && next.revision !== cursor.revision)
            throw new UiError('The project list changed between pages. Refresh to try again.');
          if (cursor && next.next?.after === cursor.after)
            throw new UiError('Project paging did not advance. Refresh to try again.');
          items.push(...next.projects);
          cursor = next.next;
          if (cursor === null) {
            projects.set(items);
            return;
          }
        }
      }
      throw new UiError('Projects changed while reading. Refresh to try again.');
    } catch (reason) {
      if (alive && projectRead === reading) projectError.set(errorText(reason));
    }
  };

  const refresh = async () => {
    if (!alive) return;
    await Promise.all([restart(false), loadProjects()]);
  };
  const setScope = (next: BrowserScope) => {
    if (!alive) return;
    const previous = scope();
    if (
      previous.kind === next.kind &&
      (previous.kind === 'all' ||
        (previous.kind === 'project' &&
          next.kind === 'project' &&
          previous.projectId === next.projectId) ||
        (previous.kind === 'workspace' &&
          next.kind === 'workspace' &&
          previous.sessionId === next.sessionId))
    )
      return;
    batch(() => {
      scope.set({ ...next });
      void restart(true);
    });
  };
  const setFilter = (next: AgentSessionFilter) => {
    if (!alive || next === filter()) return;
    batch(() => {
      filter.set(next);
      void restart(true);
    });
  };
  void refresh();
  return {
    scope,
    filter,
    sessions,
    projects,
    loading,
    error,
    projectError,
    setScope,
    setFilter,
    loadMore,
    refresh,
  };
}
