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
  decodeProjectCatalogProject,
  decodeProjectCatalogProjectDetails,
  type ConnectionCatalogCursor,
  type ConnectionCatalogPageItem,
  type ConnectionCatalogQueryResult,
  type RelayModelProfile,
  type RelayModelProfiles,
  type SessionCatalogItem,
  type SkillCatalogWorkspaceContext,
  type SkillCatalogInvocableItem,
  type SkillCatalogInvocableTarget,
  type SkillCatalogPageItem,
  type SkillCatalogRevision,
  type SkillCatalogView,
  type WorkspaceProjection,
  type OperationOutput,
  type ProjectCatalogPageItem,
  type ProjectCatalogProject,
  type ProjectCatalogProjectDetails,
  type ProjectCatalogQueryResult,
  type ProjectCatalogView,
} from '../protocol/index.js';
import type { RuntimeHostConnection } from './connection.js';

const MAX_STABLE_READ_ATTEMPTS = 8;
const STABLE_READ_RETRY_BASE_DELAY_MS = 8;
const STABLE_READ_RETRY_MAX_DELAY_MS = 64;
type RuntimeHostCatalogConnection = Pick<RuntimeHostConnection, 'request'>;

export interface RuntimeHostSkillCatalogSnapshot {
  readonly revision: SkillCatalogRevision;
  readonly view: SkillCatalogView;
  readonly items: readonly SkillCatalogPageItem[];
  readonly resolvedWorkspace: WorkspaceProjection;
}

export type RuntimeHostConnectionCatalogEntry = Omit<
  Extract<ConnectionCatalogPageItem, { kind: 'connection' }>,
  'kind' | 'connectionIndex' | 'enabledModelIdCount' | 'modelCount'
> & {
  readonly enabledModelIds: readonly string[];
  readonly models: readonly Extract<ConnectionCatalogPageItem, { kind: 'model' }>['model'][];
  readonly relayModelProfiles?: RelayModelProfiles;
};

export interface RuntimeHostConnectionCatalogSnapshot {
  readonly revision: Extract<ConnectionCatalogQueryResult, { kind: 'page' }>['revision'];
  readonly defaultTarget: Extract<ConnectionCatalogQueryResult, { kind: 'page' }>['defaultTarget'];
  readonly connections: readonly RuntimeHostConnectionCatalogEntry[];
}

export class RuntimeHostCatalogReadError extends Error {
  constructor(
    readonly catalog: 'connection' | 'project' | 'session' | 'skill' | 'runtime_resource',
    readonly reason: 'unstable' | 'invalid_projection' | 'repeated_cursor',
  ) {
    super(`Runtime Host ${catalog} catalog read failed: ${reason}`);
    this.name = 'RuntimeHostCatalogReadError';
  }
}

export async function readRuntimeHostConnectionCatalog(
  connection: RuntimeHostCatalogConnection,
): Promise<RuntimeHostConnectionCatalogSnapshot> {
  const { first, pages } = await collectStablePages(
    'connection',
    async () => {
      const result = await connection.request('connection.catalog.query', { kind: 'start' });
      return result.kind === 'page' ? result : null;
    },
    async (revision, cursor) => {
      const result = await connection.request('connection.catalog.query', {
        kind: 'continue',
        revision,
        cursor,
      });
      return result.kind === 'page' ? result : null;
    },
  );
  return assembleConnectionCatalog(
    first,
    pages.flatMap((page) => page.items),
  );
}

export async function readRuntimeHostSkillCatalog(
  connection: RuntimeHostCatalogConnection,
  context: SkillCatalogWorkspaceContext,
  view: SkillCatalogView,
): Promise<RuntimeHostSkillCatalogSnapshot> {
  let resolvedWorkspace: WorkspaceProjection | undefined;
  const { first, pages } = await collectStablePages(
    'skill',
    async () => {
      const result = await connection.request('skill.catalog.query', {
        kind: 'start',
        context,
        view,
      });
      if (result.kind !== 'page' || result.view !== view) return null;
      resolvedWorkspace = result.resolvedWorkspace;
      return result;
    },
    async (revision, cursor) => {
      const result = await connection.request('skill.catalog.query', {
        kind: 'continue',
        context,
        view,
        revision,
        cursor,
      });
      return result.kind === 'page' &&
        result.view === view &&
        workspaceProjectionsEqual(result.resolvedWorkspace, resolvedWorkspace)
        ? result
        : null;
    },
  );
  return {
    revision: first.revision,
    view,
    items: pages.flatMap((page) => page.items),
    resolvedWorkspace: first.resolvedWorkspace,
  };
}

function workspaceProjectionsEqual(
  left: WorkspaceProjection,
  right: WorkspaceProjection | undefined,
): boolean {
  if (!right) return false;
  if (left.hostCwd !== right.hostCwd || left.target.kind !== right.target.kind) return false;
  return left.target.kind === 'project'
    ? right.target.kind === 'project' && left.target.projectId === right.target.projectId
    : right.target.kind === 'host_path' && left.target.path === right.target.path;
}

export async function readRuntimeHostInvocableSkills(
  connection: RuntimeHostCatalogConnection,
  target: SkillCatalogInvocableTarget,
): Promise<readonly SkillCatalogInvocableItem[]> {
  const { pages } = await collectStablePages(
    'skill',
    async () => {
      const result = await connection.request('skill.catalog.invocable.query', {
        kind: 'start',
        target,
      });
      return result.kind === 'page' ? result : null;
    },
    async (revision, cursor) => {
      const result = await connection.request('skill.catalog.invocable.query', {
        kind: 'continue',
        target,
        revision,
        cursor,
      });
      return result.kind === 'page' ? result : null;
    },
  );
  return pages.flatMap((page) => page.items);
}

export async function readRuntimeHostSessions(
  connection: RuntimeHostCatalogConnection,
): Promise<SessionCatalogItem[]> {
  const { pages } = await collectStablePages(
    'session',
    async () => {
      const result = await connection.request('session.catalog.query', {
        kind: 'list_start',
      });
      return result.kind === 'page' ? result : null;
    },
    async (revision, cursor) => {
      const result = await connection.request('session.catalog.query', {
        kind: 'list_continue',
        revision,
        cursor,
      });
      return result.kind === 'page' ? result : null;
    },
  );
  return pages.flatMap((page) => page.sessions);
}

export async function readRuntimeHostProjects(
  connection: RuntimeHostCatalogConnection,
): Promise<ProjectCatalogProject[]> {
  return readRuntimeHostProjectCatalog(connection, 'summary');
}

export async function readRuntimeHostProjectDetails(
  connection: RuntimeHostCatalogConnection,
): Promise<ProjectCatalogProjectDetails[]> {
  return readRuntimeHostProjectCatalog(connection, 'locations');
}

function readRuntimeHostProjectCatalog(
  connection: RuntimeHostCatalogConnection,
  view: 'summary',
): Promise<ProjectCatalogProject[]>;
function readRuntimeHostProjectCatalog(
  connection: RuntimeHostCatalogConnection,
  view: 'locations',
): Promise<ProjectCatalogProjectDetails[]>;
async function readRuntimeHostProjectCatalog(
  connection: RuntimeHostCatalogConnection,
  view: ProjectCatalogView,
): Promise<ProjectCatalogProject[] | ProjectCatalogProjectDetails[]> {
  const { first, pages } = await collectStablePages(
    'project',
    async () => {
      const result = await connection.request('project.catalog.query', {
        kind: 'list_start',
        view,
      });
      return result.kind === 'page' && result.view === view ? result : null;
    },
    async (revision, cursor) => {
      const result = await connection.request('project.catalog.query', {
        kind: 'list_continue',
        view,
        revision,
        cursor,
      });
      return result.kind === 'page' && result.view === view ? result : null;
    },
  );
  return assembleProjectCatalog(
    first,
    pages.flatMap((page) => page.items),
  );
}

export async function readRuntimeHostResources(
  connection: RuntimeHostCatalogConnection,
  sessionId: string,
): Promise<
  Extract<OperationOutput<'runtime.resource.query'>, { kind: 'page' }>['resources'][number][]
> {
  const { pages } = await collectStablePages(
    'runtime_resource',
    async () => {
      const result = await connection.request('runtime.resource.query', {
        kind: 'list_start',
        sessionId,
      });
      return result.kind === 'page' && result.sessionId === sessionId ? result : null;
    },
    async (revision, cursor) => {
      const result = await connection.request('runtime.resource.query', {
        kind: 'list_continue',
        sessionId,
        revision,
        cursor,
      });
      return result.kind === 'page' && result.sessionId === sessionId ? result : null;
    },
  );
  return pages.flatMap((page) => page.resources);
}

interface StableCatalogPage {
  readonly revision: string | number;
  readonly nextCursor: string | ConnectionCatalogCursor | null;
}

async function collectStablePages<Page extends StableCatalogPage>(
  catalog: RuntimeHostCatalogReadError['catalog'],
  readFirst: () => Promise<Page | null>,
  readNext: (
    revision: Page['revision'],
    cursor: NonNullable<Page['nextCursor']>,
  ) => Promise<Page | null>,
): Promise<{ first: Page; pages: Page[] }> {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const first = await readFirst();
    if (!first) continue;
    const pages = [first];
    const cursors = new Set<string>();
    let page = first;
    let retry = false;
    while (page.nextCursor !== null) {
      const cursor = uniqueCursor(catalog, cursors, page.nextCursor);
      const next = await readNext(first.revision, cursor);
      if (!next || next.revision !== first.revision) {
        retry = true;
        break;
      }
      pages.push(next);
      page = next;
    }
    if (!retry) return { first, pages };
    if (attempt + 1 < MAX_STABLE_READ_ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(STABLE_READ_RETRY_BASE_DELAY_MS * 2 ** attempt, STABLE_READ_RETRY_MAX_DELAY_MS),
        ),
      );
    }
  }
  throw new RuntimeHostCatalogReadError(catalog, 'unstable');
}

function uniqueCursor<T>(
  catalog: RuntimeHostCatalogReadError['catalog'],
  cursors: Set<string>,
  cursor: T,
): T {
  const key = typeof cursor === 'string' ? cursor : JSON.stringify(cursor);
  if (cursors.has(key)) throw new RuntimeHostCatalogReadError(catalog, 'repeated_cursor');
  cursors.add(key);
  return cursor;
}

function assembleProjectCatalog(
  first: Extract<ProjectCatalogQueryResult, { kind: 'page' }>,
  items: readonly ProjectCatalogPageItem[],
): ProjectCatalogProject[] {
  const projects = new Map<
    number,
    {
      header: Extract<ProjectCatalogPageItem, { kind: 'project' }>;
      aliases: Map<number, string>;
      locations: Map<number, Extract<ProjectCatalogPageItem, { kind: 'location' }>['location']>;
    }
  >();
  for (const item of items) {
    if (item.kind !== 'project') continue;
    if (projects.has(item.projectIndex)) {
      throw new RuntimeHostCatalogReadError('project', 'invalid_projection');
    }
    projects.set(item.projectIndex, { header: item, aliases: new Map(), locations: new Map() });
  }
  for (const item of items) {
    if (item.kind === 'project') continue;
    const project = projects.get(item.projectIndex);
    if (!project) throw new RuntimeHostCatalogReadError('project', 'invalid_projection');
    const values = item.kind === 'alias' ? project.aliases : project.locations;
    const expectedCount =
      item.kind === 'alias' ? project.header.aliasCount : project.header.locationCount;
    if (item.itemIndex >= expectedCount || values.has(item.itemIndex)) {
      throw new RuntimeHostCatalogReadError('project', 'invalid_projection');
    }
    if (item.kind === 'alias') project.aliases.set(item.itemIndex, item.alias);
    else project.locations.set(item.itemIndex, item.location);
  }
  if (projects.size !== first.projectCount) {
    throw new RuntimeHostCatalogReadError('project', 'invalid_projection');
  }
  return [...projects.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, { header, aliases, locations }]) => {
      if (
        aliases.size !== header.aliasCount ||
        header.available !== (header.preferredLocationIndex !== null) ||
        (header.preferredLocationIndex !== null &&
          header.preferredLocationIndex >= header.locationCount)
      ) {
        throw new RuntimeHostCatalogReadError('project', 'invalid_projection');
      }
      const project = decodeProjectCatalogProject({
        id: header.id,
        aliases: orderedValues(aliases),
        name: header.name,
        locationCount: header.locationCount,
        archivedAt: header.archivedAt,
        available: header.available,
      });
      if (first.view === 'summary') {
        if (locations.size !== 0) {
          throw new RuntimeHostCatalogReadError('project', 'invalid_projection');
        }
        return project;
      }
      if (locations.size !== header.locationCount) {
        throw new RuntimeHostCatalogReadError('project', 'invalid_projection');
      }
      const orderedLocations = orderedValues(locations);
      const preferredPath =
        header.preferredLocationIndex === null
          ? null
          : orderedLocations[header.preferredLocationIndex]?.path;
      if (preferredPath === undefined) {
        throw new RuntimeHostCatalogReadError('project', 'invalid_projection');
      }
      return decodeProjectCatalogProjectDetails({
        ...project,
        locations: orderedLocations,
        preferredPath,
      });
    });
}

function assembleConnectionCatalog(
  first: Extract<ConnectionCatalogQueryResult, { kind: 'page' }>,
  items: readonly ConnectionCatalogPageItem[],
): RuntimeHostConnectionCatalogSnapshot {
  const entries = new Map<
    number,
    {
      header: Extract<ConnectionCatalogPageItem, { kind: 'connection' }>;
      enabledModelIds: Map<number, string>;
      models: Map<number, RuntimeHostConnectionCatalogEntry['models'][number]>;
      relayProfiles: Map<string, RelayModelProfile>;
    }
  >();
  for (const item of items) {
    if (item.kind !== 'connection') continue;
    if (entries.has(item.connectionIndex)) {
      throw new RuntimeHostCatalogReadError('connection', 'invalid_projection');
    }
    entries.set(item.connectionIndex, {
      header: item,
      enabledModelIds: new Map(),
      models: new Map(),
      relayProfiles: new Map(),
    });
  }
  for (const item of items) {
    if (item.kind === 'connection') continue;
    const entry = entries.get(item.connectionIndex);
    if (!entry) throw new RuntimeHostCatalogReadError('connection', 'invalid_projection');
    const values = item.kind === 'enabled_model_id' ? entry.enabledModelIds : entry.models;
    const expectedCount =
      item.kind === 'enabled_model_id' ? entry.header.enabledModelIdCount : entry.header.modelCount;
    if (item.itemIndex >= expectedCount || values.has(item.itemIndex)) {
      throw new RuntimeHostCatalogReadError('connection', 'invalid_projection');
    }
    if (item.kind === 'enabled_model_id') {
      entry.enabledModelIds.set(item.itemIndex, item.modelId);
      // Reassemble the profile table the projector spread across items; the
      // downstream type is the per-model map, not the wire's per-item shape.
      if (item.relayProfile !== undefined) entry.relayProfiles.set(item.modelId, item.relayProfile);
    } else {
      entry.models.set(item.itemIndex, item.model);
    }
  }
  if (entries.size !== first.connectionCount) {
    throw new RuntimeHostCatalogReadError('connection', 'invalid_projection');
  }
  const connections = [...entries.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]): RuntimeHostConnectionCatalogEntry => {
      if (
        entry.enabledModelIds.size !== entry.header.enabledModelIdCount ||
        entry.models.size !== entry.header.modelCount
      ) {
        throw new RuntimeHostCatalogReadError('connection', 'invalid_projection');
      }
      const {
        kind: _kind,
        connectionIndex: _index,
        enabledModelIdCount: _enabledCount,
        modelCount: _modelCount,
        ...header
      } = entry.header;
      return {
        ...header,
        enabledModelIds: orderedValues(entry.enabledModelIds),
        models: orderedValues(entry.models),
        ...(entry.relayProfiles.size === 0
          ? {}
          : { relayModelProfiles: Object.fromEntries(entry.relayProfiles) }),
      };
    });
  return { revision: first.revision, defaultTarget: first.defaultTarget, connections };
}

function orderedValues<T>(values: ReadonlyMap<number, T>): T[] {
  return [...values.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
}
