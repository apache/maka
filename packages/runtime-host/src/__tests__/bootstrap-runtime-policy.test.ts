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
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { ensureBootstrapRuntimePolicy } from '../server/bootstrap-runtime-policy.js';

test('hosted initialization retries invalid input and rotates proxy credentials through the store', async () => {
  await withFixture(async ({ root, stores }) => {
    const initialize = (proxyUrl: string) =>
      ensureBootstrapRuntimePolicy({
        workspaceRoot: root,
        stores,
        environment: {},
        initialization: { incognito: true, proxyUrl },
      });
    await assert.rejects(
      initialize('socks5://user:secret@proxy.invalid:3128'),
      /Invalid hosted HTTP proxy/,
    );
    assert.equal((await stores.operations.resolveHostOutboundExecution()).kind, 'privacy_mode');
    await initialize('http://user:secret@proxy.invalid:3128');
    await initialize('http://user:replacement@proxy.invalid:3128');
    const admission = await stores.operations.resolveNetworkProxyExecution();
    assert.equal(admission.kind, 'ready');
    if (admission.kind !== 'ready') return;
    assert.equal(admission.secretMaterial.networkProxy?.secret, 'replacement');
    await initialize('http://proxy.invalid:3128');
    const anonymous = await stores.operations.resolveNetworkProxyExecution();
    assert.equal(anonymous.kind, 'ready');
    if (anonymous.kind !== 'ready') return;
    assert.equal(anonymous.networkProxy.authEnabled, false);
    assert.equal(anonymous.secretMaterial.networkProxy, undefined);
  });
});

test('a fresh Host without a user API key leaves provider selection to onboarding', async () => {
  await withFixture(async ({ root, stores }) => {
    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });
    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(catalog.connections, []);
    assert.equal(catalog.defaultTarget, null);
  });
});

test('an interrupted environment import resumes credential setup before selecting a default', async () => {
  await withFixture(async ({ root, stores }) => {
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'env-anthropic',
        name: 'Anthropic (env)',
        providerType: 'anthropic',
        enabled: true,
        enabledModelIds: ['claude-sonnet-4-5-20250929'],
      },
    });
    assert.equal(created.kind, 'committed');
    await writeFile(
      join(root, '.runtime-host-bootstrap.json'),
      '{"version":1,"state":"initializing"}\n',
    );
    await assert.rejects(
      ensureBootstrapRuntimePolicy({
        workspaceRoot: root,
        environment: { ANTHROPIC_API_KEY: 'anthropic-secret' },
        stores: {
          ...stores,
          connectionCatalog: {
            ...stores.connectionCatalog,
            setDefaultTarget: async () => {
              throw new Error('Interrupted default write');
            },
          },
        },
      }),
      /Interrupted default write/,
    );
    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: { ANTHROPIC_API_KEY: 'anthropic-secret', OPENAI_API_KEY: 'unused' },
    });
    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.connections.length, 1);
    const connection = catalog.connections[0]!;
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: connection.connectionId,
      modelId: 'claude-sonnet-4-5-20250929',
    });
    const status = await stores.credentialVault.getStatus({
      scope: 'connection',
      connectionId: connection.connectionId,
      kind: 'api_key',
    });
    assert.equal(status.kind, 'status');
    if (status.kind === 'status') assert.equal(status.status.configured, true);
    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });
    assert.deepEqual(await stores.connectionCatalog.getSnapshot(), catalog);
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

test('a failed environment credential leaves no unusable default and can be retried', async () => {
  await withFixture(async ({ root, stores }) => {
    const errors: unknown[] = [];
    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: { OPENAI_API_KEY: 'x'.repeat(64 * 1024 + 1) },
      onDeferredError: (error) => errors.push(error),
    });
    assert.equal(errors.length, 1);
    const failed = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(failed.connections, []);
    assert.equal(failed.defaultTarget, null);
    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: { OPENAI_API_KEY: 'valid-key' },
    });
    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: catalog.connections[0]!.connectionId,
      modelId: 'gpt-4o-mini',
    });
  });
});

test('an old Free default is released without deleting the connection or importing a paid replacement', async () => {
  await withFixture(async ({ root, stores }) => {
    const connectionId = '00000000-0000-4000-8000-000000000001';
    const connection = {
      connectionId,
      revision: 3,
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      enabled: true,
      enabledModelIds: ['nemotron-3-ultra-free'],
      models: [{ id: 'nemotron-3-ultra-free' }],
      modelSource: 'fallback',
      modelsFetchedAt: 0,
    };
    await writeFile(
      join(root, 'connection-catalog.json'),
      JSON.stringify({
        schemaVersion: 1,
        revision: 7,
        defaultTarget: { connectionId, modelId: 'nemotron-3-ultra-free' },
        connections: [connection],
      }),
    );
    await writeFile(
      join(root, '.runtime-host-bootstrap.json'),
      '{"version":1,"state":"initializing"}\n',
    );
    const initialize = () =>
      ensureBootstrapRuntimePolicy({
        workspaceRoot: root,
        stores,
        environment: { OPENAI_API_KEY: 'must-not-be-imported' },
      });
    await initialize();
    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.defaultTarget, null);
    assert.deepEqual(catalog.connections, [connection]);
    assert.deepEqual((await stores.credentialVault.getSnapshot()).entries, []);
    const admission = await stores.operations.resolveExecutionConnection({
      kind: 'catalog_slug',
      connectionSlug: 'opencode-free',
    });
    assert.equal(admission.kind, 'provider_retired');
    await initialize();
    assert.deepEqual(await stores.connectionCatalog.getSnapshot(), catalog);
  });
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
