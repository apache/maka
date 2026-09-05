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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeHostConnection } from '../client/connection.js';
import {
  RuntimeHostCatalogReadError,
  RuntimeHostSessionCatalogRevisionChangedError,
  readRuntimeHostConnectionCatalog,
  readRuntimeHostProjectDetails,
  readRuntimeHostProjects,
  readRuntimeHostSessionCatalogPage,
  readRuntimeHostSessions,
  readRuntimeHostSkillCatalog,
} from '../client/catalog-reader.js';

test('reads one Session catalog page and carries its revision into the continuation cursor', async () => {
  const inputs: Record<string, unknown>[] = [];
  const connection = fakeConnection(async (operation, input) => {
    assert.equal(operation, 'session.catalog.query');
    inputs.push(input);
    const continuation = input.kind === 'list_continue';
    return {
      kind: 'page',
      revision: 'sha256:sessions',
      sessions: [
        {
          kind: 'unsupported_legacy_record',
          id: continuation ? 'legacy-2' : 'legacy-1',
          revision: 1,
          reason: 'not_wire_representable',
        },
      ],
      nextCursor: continuation ? null : 'page-2',
    };
  });

  const first = await readRuntimeHostSessionCatalogPage(connection);
  assert.deepEqual(first, {
    revision: 'sha256:sessions',
    sessions: [
      {
        kind: 'unsupported_legacy_record',
        id: 'legacy-1',
        revision: 1,
        reason: 'not_wire_representable',
      },
    ],
    nextCursor: { revision: 'sha256:sessions', cursor: 'page-2' },
  });
  assert.deepEqual(await readRuntimeHostSessionCatalogPage(connection, first.nextCursor!), {
    revision: 'sha256:sessions',
    sessions: [
      {
        kind: 'unsupported_legacy_record',
        id: 'legacy-2',
        revision: 1,
        reason: 'not_wire_representable',
      },
    ],
    nextCursor: null,
  });
  assert.deepEqual(inputs, [
    { kind: 'list_start' },
    { kind: 'list_continue', revision: 'sha256:sessions', cursor: 'page-2' },
  ]);
});

test('reports a changed Session catalog revision through a typed page-reader error', async () => {
  const connection = fakeConnection(async () => ({
    kind: 'revision_changed',
    expectedRevision: 'sha256:old',
    actualRevision: 'sha256:new',
  }));

  await assert.rejects(
    () =>
      readRuntimeHostSessionCatalogPage(connection, {
        revision: 'sha256:old',
        cursor: 'page-2',
      }),
    (error) =>
      error instanceof RuntimeHostSessionCatalogRevisionChangedError &&
      error.expectedRevision === 'sha256:old' &&
      error.actualRevision === 'sha256:new',
  );
});

test('rejects a Session page reader cursor that does not advance', async () => {
  const connection = fakeConnection(async () => ({
    kind: 'page',
    revision: 'sha256:sessions',
    sessions: [],
    nextCursor: 'page-2',
  }));

  await assert.rejects(
    () =>
      readRuntimeHostSessionCatalogPage(connection, {
        revision: 'sha256:sessions',
        cursor: 'page-2',
      }),
    (error) =>
      error instanceof RuntimeHostCatalogReadError &&
      error.catalog === 'session' &&
      error.reason === 'repeated_cursor',
  );
});

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

test('retries when the first Session catalog page reports a revision change', async () => {
  let starts = 0;
  const connection = fakeConnection(async (operation, input) => {
    assert.equal(operation, 'session.catalog.query');
    assert.equal(input.kind, 'list_start');
    starts += 1;
    if (starts === 1) {
      return {
        kind: 'revision_changed',
        expectedRevision: 'sha256:old',
        actualRevision: 'sha256:new',
      };
    }
    return {
      kind: 'page',
      revision: 'sha256:new',
      sessions: [],
      nextCursor: null,
    };
  });

  assert.deepEqual(await readRuntimeHostSessions(connection), []);
  assert.equal(starts, 2);
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
      resolvedWorkspace: {
        target: { kind: 'host_path', path: '/repo' },
        hostCwd: '/repo',
      },
    };
  });

  await assert.rejects(
    () =>
      readRuntimeHostSkillCatalog(
        connection,
        { workspace: { kind: 'host_path', path: '/repo' } },
        'governance',
      ),
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
      catalogEntries: [],
      // Only the profiled model lands in the reassembled table — the item
      // shape is wire-only and never surfaces per item downstream.
      relayModelProfiles: { declared: profile },
    },
  ]);
});

test('reassembles Project aliases without exposing Host locations', async () => {
  const aliases = Array.from({ length: 300 }, (_, index) => `project-alias-${index}`);
  const locationCount = 70;
  const items = [
    {
      kind: 'project' as const,
      projectIndex: 0,
      id: 'project-1',
      name: 'Project',
      aliasCount: aliases.length,
      locationCount,
      preferredLocationIndex: 0,
      archivedAt: null,
      available: true,
    },
    ...aliases.map((alias, itemIndex) => ({
      kind: 'alias' as const,
      projectIndex: 0,
      itemIndex,
      alias,
    })),
  ];
  const connection = fakeConnection(async (_operation, input) => {
    assert.equal(input.view, 'summary');
    const offset = input.kind === 'list_start' ? 0 : Number(input.cursor);
    const page = items.slice(offset, offset + 64);
    const nextOffset = offset + page.length;
    return {
      kind: 'page',
      view: 'summary',
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
      locationCount,
      archivedAt: null,
      available: true,
    },
  ]);
});

test('reassembles more Project locations than fit in one protocol page', async () => {
  const locations = Array.from({ length: 70 }, (_, index) => ({
    path: `/workspace/worktree-${index}`,
    isWorktree: index !== 0,
  }));
  const items = [
    {
      kind: 'project' as const,
      projectIndex: 0,
      id: 'project-1',
      name: 'Project',
      aliasCount: 0,
      locationCount: locations.length,
      preferredLocationIndex: 0,
      archivedAt: null,
      available: true,
    },
    ...locations.map((location, itemIndex) => ({
      kind: 'location' as const,
      projectIndex: 0,
      itemIndex,
      location,
    })),
  ];
  const connection = fakeConnection(async (_operation, input) => {
    assert.equal(input.view, 'locations');
    const offset = input.kind === 'list_start' ? 0 : Number(input.cursor);
    const page = items.slice(offset, offset + 64);
    const nextOffset = offset + page.length;
    return {
      kind: 'page',
      view: 'locations',
      revision: `sha256:${'b'.repeat(64)}`,
      projectCount: 1,
      items: page,
      nextCursor: nextOffset < items.length ? String(nextOffset) : null,
    };
  });

  assert.deepEqual(await readRuntimeHostProjectDetails(connection), [
    {
      id: 'project-1',
      aliases: [],
      name: 'Project',
      locationCount: locations.length,
      archivedAt: null,
      available: true,
      locations,
      preferredPath: locations[0]?.path,
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
    catalogEntryCount: 0,
  } as const;
}

function fakeConnection(
  request: (operation: string, input: Record<string, unknown>) => Promise<unknown>,
): RuntimeHostConnection {
  return { request } as unknown as RuntimeHostConnection;
}
