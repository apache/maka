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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  OPENCODE_FREE_DEFAULT_MODEL,
} from '@maka/core/llm-connections';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { ensureBootstrapRuntimePolicy } from '../server/bootstrap-runtime-policy.js';

test('a fresh Host starts with one anonymous runnable target', async () => {
  await withFixture(async ({ root, stores }) => {
    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.connections.length, 1);
    const free = catalog.connections[0];
    assert.equal(free?.slug, 'opencode-free');
    assert.equal(free?.enabled, true);
    // The free set is derived from the models.dev snapshot and rotates with
    // refreshes; assert the structural contract, not today's ids.
    assert.deepEqual(free?.enabledModelIds, [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS]);
    assert.ok(free.enabledModelIds.length > 0);
    assert.equal(free.enabledModelIds[0], OPENCODE_FREE_DEFAULT_MODEL);
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: free?.connectionId,
      modelId: OPENCODE_FREE_DEFAULT_MODEL,
    });
    assert.deepEqual(
      catalog.connections.map(({ slug }) => slug),
      ['opencode-free'],
    );
  });
});

test('bootstrap resumes after interruption and prefers the supported environment key', async () => {
  await withFixture(async ({ root, stores }) => {
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'opencode-free',
        name: 'OpenCode Free',
        providerType: 'opencode-free',
        enabled: true,
        enabledModelIds: ['nemotron-3-ultra-free'],
      },
    });
    assert.equal(created.kind, 'committed');
    await writeFile(
      join(root, '.runtime-host-bootstrap.json'),
      '{"version":1,"state":"initializing"}\n',
      'utf8',
    );

    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: {
        ANTHROPIC_API_KEY: 'anthropic-secret',
        OPENAI_API_KEY: 'openai-secret',
      },
    });

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(
      catalog.connections.map(({ slug }) => slug),
      ['opencode-free', 'env-anthropic'],
    );
    const anthropic = catalog.connections[1];
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: anthropic?.connectionId,
      modelId: 'claude-sonnet-4-5-20250929',
    });
    const status = await stores.credentialVault.getStatus({
      scope: 'connection',
      connectionId: anthropic!.connectionId,
      kind: 'api_key',
    });
    assert.equal(status.kind, 'status');
    if (status.kind === 'status') assert.equal(status.status.configured, true);
  });
});

test('bootstrap preserves DeepSeek provider semantics for a DeepSeek environment key', async () => {
  await withFixture(async ({ root, stores }) => {
    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: {
        DEEPSEEK_API_KEY: 'deepseek-secret',
        DEEPSEEK_BASE_URL: 'https://deepseek.example/v1',
      },
    });

    const catalog = await stores.connectionCatalog.getSnapshot();
    const deepseek = catalog.connections.find(({ slug }) => slug === 'env-deepseek');
    assert.equal(deepseek?.providerType, 'deepseek');
    assert.equal(deepseek?.baseUrl, 'https://deepseek.example/v1');
    assert.deepEqual(deepseek?.enabledModelIds, ['deepseek-v4-flash']);
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: deepseek?.connectionId,
      modelId: 'deepseek-v4-flash',
    });
  });
});

test('bootstrap does not alter an existing user catalog', async () => {
  await withFixture(async ({ root, stores }) => {
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'local',
        name: 'Local',
        providerType: 'ollama',
        enabled: true,
        enabledModelIds: ['local-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    const before = await stores.connectionCatalog.getSnapshot();

    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: { OPENAI_API_KEY: 'must-not-be-imported' },
    });

    assert.deepEqual(await stores.connectionCatalog.getSnapshot(), before);
    assert.deepEqual((await stores.credentialVault.getSnapshot()).entries, []);
  });
});

test('an invalid optional environment credential does not keep bootstrap active', async () => {
  await withFixture(async ({ root, stores }) => {
    const errors: unknown[] = [];
    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: { OPENAI_API_KEY: 'x'.repeat(64 * 1024 + 1) },
      onDeferredError: (error) => errors.push(error),
    });

    assert.equal(errors.length, 1);
    const catalog = await stores.connectionCatalog.getSnapshot();
    const free = catalog.connections.find(({ slug }) => slug === 'opencode-free');
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: free?.connectionId,
      modelId: 'nemotron-3-ultra-free',
    });
    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: { OPENAI_API_KEY: 'x'.repeat(64 * 1024 + 1) },
      onDeferredError: (error) => errors.push(error),
    });
    assert.equal(errors.length, 1);
  });
});

test('a historical persisted seed migrates atomically, inventory and default included', async () => {
  await withFixture(async ({ root, stores }) => {
    // An actual pre-#3409 persisted document: the three-model seed, the
    // pinned four-model fallback inventory of that build, and a default
    // target on a model the migration removes.
    const connectionId = '00000000-0000-4000-8000-000000000001';
    await writeFile(
      join(root, 'connection-catalog.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 7,
        defaultTarget: { connectionId, modelId: 'deepseek-v4-flash-free' },
        connections: [
          {
            connectionId,
            revision: 3,
            slug: 'opencode-free',
            name: 'OpenCode Free',
            providerType: 'opencode-free',
            enabled: true,
            enabledModelIds: ['nemotron-3-ultra-free', 'mimo-v2.5-free', 'deepseek-v4-flash-free'],
            models: [
              { id: 'nemotron-3-ultra-free' },
              { id: 'mimo-v2.5-free' },
              { id: 'big-pickle' },
              { id: 'deepseek-v4-flash-free' },
            ],
            modelSource: 'fallback',
            modelsFetchedAt: 0,
          },
        ],
      })}\n`,
    );

    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });

    // One document write carried all three: enabled ids, the re-derived
    // static inventory, and the retargeted default.
    const catalog = await stores.connectionCatalog.getSnapshot();
    const migrated = catalog.connections.find(({ slug }) => slug === 'opencode-free');
    assert.deepEqual(migrated?.enabledModelIds, [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS]);
    assert.deepEqual(
      migrated?.models.map(({ id }) => id),
      [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS],
    );
    assert.deepEqual(catalog.defaultTarget, {
      connectionId,
      modelId: OPENCODE_FREE_DEFAULT_MODEL,
    });

    // Restart on the far side of the commit boundary: a second bootstrap is a
    // byte-identical no-op. (On the near side the single write never happened,
    // so the original document simply migrates on the next start.)
    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });
    assert.deepEqual(await stores.connectionCatalog.getSnapshot(), catalog);
  });
});

test('a historical seed with a user-cleared default migrates without inventing one', async () => {
  await withFixture(async ({ root, stores }) => {
    const connectionId = '00000000-0000-4000-8000-000000000002';
    await writeFile(
      join(root, 'connection-catalog.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 4,
        defaultTarget: null,
        connections: [
          {
            connectionId,
            revision: 2,
            slug: 'opencode-free',
            name: 'OpenCode Free',
            providerType: 'opencode-free',
            enabled: true,
            enabledModelIds: ['nemotron-3-ultra-free'],
            models: [{ id: 'nemotron-3-ultra-free' }],
            modelSource: 'fallback',
            modelsFetchedAt: 0,
          },
        ],
      })}\n`,
    );

    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });

    const catalog = await stores.connectionCatalog.getSnapshot();
    const migrated = catalog.connections.find(({ slug }) => slug === 'opencode-free');
    assert.deepEqual(migrated?.enabledModelIds, [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS]);
    assert.equal(catalog.defaultTarget, null);
  });
});

test('a user-modified opencode-free inventory is never migrated', async () => {
  // A reordered seed counts as user-modified too: exact sequence equality is
  // the (documented, lossy) proof a row is still system-owned.
  for (const enabledModelIds of [
    ['nemotron-3-ultra-free', 'big-pickle'],
    ['deepseek-v4-flash-free', 'nemotron-3-ultra-free', 'mimo-v2.5-free'],
  ]) {
    await withFixture(async ({ root, stores }) => {
      const created = await stores.connectionCatalog.create({
        expectedCatalogRevision: 0,
        connection: {
          slug: 'opencode-free',
          name: 'OpenCode Free',
          providerType: 'opencode-free',
          enabled: true,
          enabledModelIds,
        },
      });
      assert.equal(created.kind, 'committed');
      const before = await stores.connectionCatalog.getSnapshot();

      await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });

      assert.deepEqual(await stores.connectionCatalog.getSnapshot(), before);
    });
  }
});

async function withFixture(
  run: (fixture: { root: string; stores: RuntimePolicyStoresWriter }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-host-bootstrap-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    await run({ root, stores });
  } finally {
    try {
      await owner.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
}
