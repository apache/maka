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

import {
  hostQuery,
  type AgentSession,
  type ServiceMethods,
  type AgentSessionPage,
} from '../bridge';

type List = ServiceMethods['agent']['list']['input'];
export type CatalogFilter = List['filter'];
type CatalogScope = NonNullable<List['scope']>;

export function catalogInput(
  filter: CatalogFilter,
  position: List['position'] = { kind: 'start' },
  scope: CatalogScope = { kind: 'all' },
) {
  return {
    kind: null,
    filter,
    includeArchived: filter === 'archived',
    rootsOnly: false,
    scope,
    titleQuery: '',
    position,
  } satisfies List;
}

export function listSessionPage(rootId: string, filter: CatalogFilter, scope?: CatalogScope) {
  return hostQuery<AgentSessionPage>(
    'agent',
    'list',
    catalogInput(filter, undefined, scope),
    undefined,
    rootId,
  );
}

function catalogChanged(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    message.replace(/^Host rejected call or control request: /, '') === 'agent_catalog_changed'
  );
}

function pageCursor(
  page: Pick<AgentSessionPage, 'after' | 'sessions'>,
  seen: ReadonlySet<string>,
): string | null {
  if (page.after == null) return null;
  if (!page.after || seen.has(page.after) || page.sessions.length === 0)
    throw new Error('Conversation paging did not advance');
  return page.after;
}

async function nextSessionPage(
  rootId: string,
  filter: CatalogFilter,
  revision: string,
  cursor: string,
  scope?: CatalogScope,
) {
  const page = await hostQuery<AgentSessionPage>(
    'agent',
    'list',
    catalogInput(filter, { kind: 'after', revision, cursor }, scope),
    undefined,
    rootId,
  );
  if (page.revision !== revision) throw new Error('agent_catalog_changed');
  return page;
}

export interface CatalogWindow {
  revision: string;
  sessions: AgentSession[];
  after: string | null;
  seen: ReadonlySet<string>;
  pages: number;
}

export type CatalogStart =
  | { kind: 'head'; page?: AgentSessionPage }
  | { kind: 'extend'; window: CatalogWindow };

export async function readCatalog(
  rootId: string,
  filter: CatalogFilter,
  current: () => boolean,
  limit: number,
  start: CatalogStart,
  scope?: CatalogScope,
): Promise<CatalogWindow | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const head =
        start.kind === 'extend'
          ? start.window
          : (start.page ?? (await listSessionPage(rootId, filter, scope)));
      if (!current()) return;
      const rows = new Map(head.sessions.map((session) => [session.id, session]));
      const seen = new Set(start.kind === 'extend' ? start.window.seen : undefined);
      let pages = start.kind === 'extend' ? start.window.pages : 1;
      const revision = head.revision;
      let after = pageCursor(head, seen);
      while (after !== null && pages < limit) {
        seen.add(after);
        const next = await nextSessionPage(rootId, filter, revision, after, scope);
        if (!current()) return;
        for (const session of next.sessions) rows.set(session.id, session);
        after = pageCursor(next, seen);
        pages++;
      }
      return { revision, sessions: [...rows.values()], after, seen, pages };
    } catch (cause) {
      if (!current()) return;
      if (attempt !== 0 || !catalogChanged(cause)) throw cause;
      // A new push can supersede this retry; never stitch two revisions together.
      start = { kind: 'head' };
    }
  }
}
