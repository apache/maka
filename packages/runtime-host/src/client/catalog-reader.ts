import type {
  ConnectionCatalogCursor,
  ConnectionCatalogPageItem,
  ConnectionCatalogQueryResult,
  RelayModelProfile,
  RelayModelProfiles,
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
  readonly relayModelProfiles?: RelayModelProfiles;
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
  connection: RuntimeHostConnection,
  context: SkillCatalogLocalContext,
  view: SkillCatalogView,
): Promise<RuntimeHostSkillCatalogSnapshot> {
  const { first, pages } = await collectStablePages(
    'skill',
    async () => {
      const result = await connection.request('skill.catalog.query', {
        kind: 'start',
        context,
        view,
      });
      return result.kind === 'page' && result.view === view ? result : null;
    },
    async (revision, cursor) => {
      const result = await connection.request('skill.catalog.query', {
        kind: 'continue',
        context,
        view,
        revision,
        cursor,
      });
      return result.kind === 'page' && result.view === view ? result : null;
    },
  );
  return { revision: first.revision, view, items: pages.flatMap((page) => page.items) };
}

export async function readRuntimeHostSessions(
  connection: RuntimeHostConnection,
  filter?: SessionCatalogFilter,
): Promise<SessionCatalogItem[]> {
  const { pages } = await collectStablePages(
    'session',
    async () => {
      const result = await connection.request('session.catalog.query', {
        kind: 'list_start',
        ...(filter ? { filter } : {}),
      });
      return result.kind === 'page' ? result : null;
    },
    async (revision, cursor) => {
      const result = await connection.request('session.catalog.query', {
        kind: 'list_continue',
        revision,
        cursor,
        ...(filter ? { filter } : {}),
      });
      return result.kind === 'page' ? result : null;
    },
  );
  return pages.flatMap((page) => page.sessions);
}

export async function readRuntimeHostResources(
  connection: RuntimeHostConnection,
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
