import type {
  ConnectionCatalogPageItem,
  ConnectionCatalogQueryResult,
  SessionCatalogFilter,
  SessionCatalogItem,
  SkillCatalogLocalContext,
  SkillCatalogPageItem,
  SkillCatalogRevision,
  SkillCatalogView,
  OperationOutput,
} from '../protocol/index.js';
import type { RuntimeHostConnection } from './connection.js';

const MAX_STABLE_READ_ATTEMPTS = 3;

export interface RuntimeHostSkillCatalogSnapshot {
  readonly revision: SkillCatalogRevision;
  readonly view: SkillCatalogView;
  readonly items: readonly SkillCatalogPageItem[];
}

export type RuntimeHostConnectionCatalogEntry = Omit<
  Extract<ConnectionCatalogPageItem, { kind: 'connection' }>,
  'kind' | 'connectionIndex' | 'enabledModelIdCount' | 'modelCount'
> & {
  readonly enabledModelIds: readonly string[];
  readonly models: readonly Extract<ConnectionCatalogPageItem, { kind: 'model' }>['model'][];
};

export interface RuntimeHostConnectionCatalogSnapshot {
  readonly revision: Extract<ConnectionCatalogQueryResult, { kind: 'page' }>['revision'];
  readonly defaultTarget: Extract<ConnectionCatalogQueryResult, { kind: 'page' }>['defaultTarget'];
  readonly connections: readonly RuntimeHostConnectionCatalogEntry[];
}

export class RuntimeHostCatalogReadError extends Error {
  constructor(
    readonly catalog: 'connection' | 'session' | 'skill' | 'runtime_resource',
    readonly reason: 'unstable' | 'invalid_projection' | 'repeated_cursor',
  ) {
    super(`Runtime Host ${catalog} catalog read failed: ${reason}`);
    this.name = 'RuntimeHostCatalogReadError';
  }
}

export async function readRuntimeHostConnectionCatalog(
  connection: RuntimeHostConnection,
): Promise<RuntimeHostConnectionCatalogSnapshot> {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const first = await connection.request('connection.catalog.query', { kind: 'start' });
    if (first.kind !== 'page') continue;
    const items = [...first.items];
    const cursors = new Set<string>();
    let page = first;
    let retry = false;
    while (page.nextCursor !== null) {
      const cursor = uniqueCursor('connection', cursors, page.nextCursor);
      const next = await connection.request('connection.catalog.query', {
        kind: 'continue',
        revision: first.revision,
        cursor,
      });
      if (next.kind !== 'page' || next.revision !== first.revision) {
        retry = true;
        break;
      }
      items.push(...next.items);
      page = next;
    }
    if (!retry) return assembleConnectionCatalog(first, items);
  }
  throw new RuntimeHostCatalogReadError('connection', 'unstable');
}

export async function readRuntimeHostSkillCatalog(
  connection: RuntimeHostConnection,
  context: SkillCatalogLocalContext,
  view: SkillCatalogView,
): Promise<RuntimeHostSkillCatalogSnapshot> {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const first = await connection.request('skill.catalog.query', { kind: 'start', context, view });
    if (first.kind !== 'page' || first.view !== view) continue;
    const items = [...first.items];
    const cursors = new Set<string>();
    let page = first;
    let retry = false;
    while (page.nextCursor !== null) {
      const cursor = uniqueCursor('skill', cursors, page.nextCursor);
      const next = await connection.request('skill.catalog.query', {
        kind: 'continue',
        context,
        view,
        revision: first.revision,
        cursor,
      });
      if (next.kind !== 'page' || next.view !== view || next.revision !== first.revision) {
        retry = true;
        break;
      }
      items.push(...next.items);
      page = next;
    }
    if (!retry) return { revision: first.revision, view, items };
  }
  throw new RuntimeHostCatalogReadError('skill', 'unstable');
}

export async function readRuntimeHostSessions(
  connection: RuntimeHostConnection,
  filter?: SessionCatalogFilter,
): Promise<SessionCatalogItem[]> {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const first = await connection.request('session.catalog.query', {
      kind: 'list_start',
      ...(filter ? { filter } : {}),
    });
    if (first.kind !== 'page') continue;
    const sessions = [...first.sessions];
    const cursors = new Set<string>();
    let page = first;
    let retry = false;
    while (page.nextCursor !== null) {
      const cursor = uniqueCursor('session', cursors, page.nextCursor);
      const next = await connection.request('session.catalog.query', {
        kind: 'list_continue',
        revision: first.revision,
        cursor,
        ...(filter ? { filter } : {}),
      });
      if (next.kind !== 'page' || next.revision !== first.revision) {
        retry = true;
        break;
      }
      sessions.push(...next.sessions);
      page = next;
    }
    if (!retry) return sessions;
  }
  throw new RuntimeHostCatalogReadError('session', 'unstable');
}

export async function readRuntimeHostResources(
  connection: RuntimeHostConnection,
  sessionId: string,
): Promise<
  Extract<OperationOutput<'runtime.resource.query'>, { kind: 'page' }>['resources'][number][]
> {
  for (let attempt = 0; attempt < MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
    const first = await connection.request('runtime.resource.query', {
      kind: 'list_start',
      sessionId,
    });
    if (first.kind !== 'page' || first.sessionId !== sessionId) continue;
    const resources = [...first.resources];
    const cursors = new Set<string>();
    let page = first;
    let retry = false;
    while (page.nextCursor !== null) {
      const cursor = uniqueCursor('runtime_resource', cursors, page.nextCursor);
      const next = await connection.request('runtime.resource.query', {
        kind: 'list_continue',
        sessionId,
        revision: first.revision,
        cursor,
      });
      if (
        next.kind !== 'page' ||
        next.sessionId !== sessionId ||
        next.revision !== first.revision
      ) {
        retry = true;
        break;
      }
      resources.push(...next.resources);
      page = next;
    }
    if (!retry) return resources;
  }
  throw new RuntimeHostCatalogReadError('runtime_resource', 'unstable');
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
    if (item.kind === 'enabled_model_id') entry.enabledModelIds.set(item.itemIndex, item.modelId);
    else entry.models.set(item.itemIndex, item.model);
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
      };
    });
  return { revision: first.revision, defaultTarget: first.defaultTarget, connections };
}

function orderedValues<T>(values: ReadonlyMap<number, T>): T[] {
  return [...values.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
}
