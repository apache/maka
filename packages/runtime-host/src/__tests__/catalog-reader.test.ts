import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeHostConnection } from '../client/connection.js';
import {
  RuntimeHostCatalogReadError,
  readRuntimeHostConnectionCatalog,
  readRuntimeHostProjects,
  readRuntimeHostSessions,
  readRuntimeHostSkillCatalog,
} from '../client/catalog-reader.js';

test('waits out a burst of Session catalog revisions', async () => {
  let starts = 0;
  const connection = fakeConnection(async (operation, input) => {
    assert.equal(operation, 'session.catalog.query');
    if (input.kind === 'list_start') {
      starts += 1;
      return {
        kind: 'page',
        revision: `sha256:${starts}`,
        sessions: [],
        nextCursor: 'next',
      };
    }
    assert.equal(input.kind, 'list_continue');
    if (starts <= 3) {
      return {
        kind: 'revision_changed',
        expectedRevision: `sha256:${starts}`,
        actualRevision: `sha256:${starts + 1}`,
      };
    }
    return {
      kind: 'page',
      revision: `sha256:${starts}`,
      sessions: [],
      nextCursor: null,
    };
  });

  assert.deepEqual(await readRuntimeHostSessions(connection), []);
  assert.equal(starts, 4);
});

test('rejects a repeated Skill catalog cursor instead of looping forever', async () => {
  const connection = fakeConnection(async (operation, input) => {
    assert.equal(operation, 'skill.catalog.query');
    return {
      kind: 'page',
      view: 'governance',
      revision: 'sha256:skills',
      items: [],
      nextCursor: 'repeated',
    };
  });

  await assert.rejects(
    () => readRuntimeHostSkillCatalog(connection, { projectRoot: '/repo' }, 'governance'),
    (error) =>
      error instanceof RuntimeHostCatalogReadError &&
      error.catalog === 'skill' &&
      error.reason === 'repeated_cursor',
  );
});

test('reassembles per-item relay profiles into the connection profile table', async () => {
  const profile = { thinkingLevels: ['low'], vision: false, contextWindow: 65_536 } as const;
  const connection = fakeConnection(async (_operation, input) => {
    const continuation = input.kind === 'continue';
    return {
      kind: 'page',
      revision: 1,
      defaultTarget: null,
      connectionCount: 1,
      items: continuation
        ? [{ kind: 'enabled_model_id', connectionIndex: 0, itemIndex: 1, modelId: 'plain' }]
        : [
            connectionHeader(2),
            {
              kind: 'enabled_model_id',
              connectionIndex: 0,
              itemIndex: 0,
              modelId: 'declared',
              relayProfile: profile,
            },
          ],
      nextCursor: continuation
        ? null
        : { connectionIndex: 0, part: 'enabled_model_id', itemIndex: 1 },
    };
  });

  const catalog = await readRuntimeHostConnectionCatalog(connection);
  assert.deepEqual(catalog.connections, [
    {
      enabledModelIds: ['declared', 'plain'],
      models: [],
      // Only the profiled model lands in the reassembled table — the item
      // shape is wire-only and never surfaces per item downstream.
      relayModelProfiles: { declared: profile },
    },
  ]);
});

test('reassembles Project aliases and locations across bounded pages without truncation', async () => {
  const aliases = Array.from({ length: 300 }, (_, index) => `project-alias-${index}`);
  const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
  const locations = Array.from({ length: 70 }, (_, index) => ({
    path: `${root}${process.platform === 'win32' ? '\\' : '/'}location-${index}`,
    isWorktree: index > 0,
  }));
  const items = [
    {
      kind: 'project' as const,
      projectIndex: 0,
      id: 'project-1',
      name: 'Project',
      aliasCount: aliases.length,
      locationCount: locations.length,
      archivedAt: null,
      available: true,
      preferredPath: locations[0]!.path,
    },
    ...aliases.map((alias, itemIndex) => ({
      kind: 'alias' as const,
      projectIndex: 0,
      itemIndex,
      alias,
    })),
    ...locations.map((location, itemIndex) => ({
      kind: 'location' as const,
      projectIndex: 0,
      itemIndex,
      location,
    })),
  ];
  const connection = fakeConnection(async (_operation, input) => {
    const offset = input.kind === 'list_start' ? 0 : Number(input.cursor);
    const page = items.slice(offset, offset + 64);
    const nextOffset = offset + page.length;
    return {
      kind: 'page',
      revision: `sha256:${'a'.repeat(64)}`,
      projectCount: 1,
      items: page,
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    };
  });

  assert.deepEqual(await readRuntimeHostProjects(connection), [
    {
      id: 'project-1',
      aliases,
      name: 'Project',
      locations,
      archivedAt: null,
      available: true,
      preferredPath: locations[0]!.path,
    },
  ]);
});

test('rejects a Connection catalog with a missing index', async () => {
  const connection = fakeConnection(async () => ({
    kind: 'page',
    revision: 1,
    defaultTarget: null,
    connectionCount: 1,
    items: [
      connectionHeader(2),
      { kind: 'enabled_model_id', connectionIndex: 0, itemIndex: 1, modelId: 'second' },
    ],
    nextCursor: null,
  }));

  await assertInvalidConnectionCatalog(connection);
});

test('rejects a duplicate Connection catalog index across pages', async () => {
  const connection = fakeConnection(async (_operation, input) => {
    const continuation = input.kind === 'continue';
    return {
      kind: 'page',
      revision: 1,
      defaultTarget: null,
      connectionCount: 1,
      items: continuation
        ? [
            {
              kind: 'enabled_model_id',
              connectionIndex: 0,
              itemIndex: 0,
              modelId: 'duplicate',
            },
          ]
        : [
            connectionHeader(1),
            {
              kind: 'enabled_model_id',
              connectionIndex: 0,
              itemIndex: 0,
              modelId: 'first',
            },
          ],
      nextCursor: continuation
        ? null
        : { connectionIndex: 0, part: 'enabled_model_id', itemIndex: 1 },
    };
  });

  await assertInvalidConnectionCatalog(connection);
});

async function assertInvalidConnectionCatalog(connection: RuntimeHostConnection): Promise<void> {
  await assert.rejects(
    () => readRuntimeHostConnectionCatalog(connection),
    (error) =>
      error instanceof RuntimeHostCatalogReadError &&
      error.catalog === 'connection' &&
      error.reason === 'invalid_projection',
  );
}

function connectionHeader(enabledModelIdCount: number) {
  return {
    kind: 'connection',
    connectionIndex: 0,
    enabledModelIdCount,
    modelCount: 0,
  } as const;
}

function fakeConnection(
  request: (operation: string, input: Record<string, unknown>) => Promise<unknown>,
): RuntimeHostConnection {
  return { request } as unknown as RuntimeHostConnection;
}
