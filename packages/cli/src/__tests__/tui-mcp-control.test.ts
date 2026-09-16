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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { McpConfigFile, McpServerStatus, McpToolSnapshot } from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import type {
  ClientCapabilityProvider,
  RuntimeHostConnectionAvailability,
} from '@maka/runtime-host/client';
import {
  AtomicFileWriteCommitUnknownError,
  createMcpConfigStore,
} from '@maka/storage/mcp-config-store';
import { createTuiMcpController, type TuiMcpPublicationAvailability } from '../tui-mcp-control.js';
import { waitFor } from './tui-terminal-mock.js';

test('TUI MCP startup stays backgrounded and publishes the discovered snapshot', async () => {
  const config = deferredValue<McpConfigFile>();
  const manager = managerHarness(1, [connectedStatus('local', 2)]);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: configStoreHarness(() => config.promise),
      manager: manager.manager,
      createProvider: () => provider('provider-1'),
    },
  );

  assert.equal(controller.snapshot().initialization, 'loading');
  assert.equal(connection.replacements.length, 0);
  config.resolve(emptyConfig());
  await waitFor(
    () => controller.snapshot().publication === 'published',
    "TUI MCP startup publication to reach 'published'",
  );
  assert.equal(controller.snapshot().initialization, 'ready');
  assert.equal(controller.snapshot().toolCount, 1);
  assert.deepEqual(controller.snapshot().servers, [
    {
      serverId: 'local',
      configured: false,
      synchronized: false,
      state: 'connected',
      transport: 'stdio',
      negotiatedProtocol: { era: 'legacy', revision: '2024-11-05' },
      toolCount: 2,
    },
  ]);
  assert.equal(connection.replacements.length, 1);
  await controller.close();
  assert.equal(connection.unregisters, 1);
  assert.equal(manager.closed, 1);
});

test('TUI MCP serializes remote provider credential changes through its publication lane', async () => {
  let availability: TuiMcpPublicationAvailability = {
    kind: 'unavailable',
    reason: 'credential_required',
  };
  let listener: ((value: TuiMcpPublicationAvailability) => void) | undefined;
  const credentials: string[] = [];
  let removed = 0;
  let closed = 0;
  const connection = {
    replaceClientCapabilities: async () => ({ registrationId: 'registration', revision: 1 }),
    unregisterClientCapabilities: async () => ({ registrationId: 'registration', revision: 1 }),
    subscribeConnectionAvailability: (next: (value: TuiMcpPublicationAvailability) => void) => {
      listener = next;
      next(availability);
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    setCredential: async (credential: string) => {
      credentials.push(credential);
      availability = { kind: 'connected', hostEpoch: 'host-1', connectionId: 'provider-1' };
      listener?.(availability);
    },
    removeCredential: async () => {
      removed += 1;
      availability = { kind: 'unavailable', reason: 'credential_required' };
      listener?.(availability);
    },
    closePublication: async () => {
      closed += 1;
    },
  };
  const manager = managerHarness(0, []);
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection },
    {
      configStore: configStoreHarness(async () => emptyConfig()),
      manager: manager.manager,
      createProvider: () => undefined,
    },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    'remote MCP controller initialization',
  );
  assert.equal(controller.snapshot().publication, 'credential_required');
  assert.equal(controller.snapshot().canManagePublicationCredential, true);

  assert.deepEqual(
    await controller.execute({
      kind: 'set_publication_credential',
      credential: 'provider-secret',
    }),
    { status: 'applied', effect: 'published' },
  );
  assert.deepEqual(credentials, ['provider-secret']);
  assert.deepEqual(await controller.execute({ kind: 'remove_publication_credential' }), {
    status: 'applied',
    effect: 'pending_host',
  });
  assert.equal(removed, 1);
  assert.equal(controller.snapshot().publication, 'credential_required');
  availability = { kind: 'unavailable', reason: 'provider_conflict' };
  listener?.(availability);
  assert.equal(controller.snapshot().publication, 'provider_conflict');
  assert.equal(controller.snapshot().canManagePublicationCredential, false);
  await controller.close();
  assert.equal(closed, 1);
});

test('TUI MCP publication coalesces a discovery change behind the in-flight revision', async () => {
  const manager = managerHarness(1, [connectedStatus('local', 1)]);
  const connection = connectionHarness();
  const firstPublication = deferred();
  connection.replace = async () => {
    connection.replacements.push('replace');
    if (connection.replacements.length === 1) await firstPublication.promise;
  };
  const providers: string[] = [];
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: configStoreHarness(async () => emptyConfig()),
      manager: manager.manager,
      createProvider: () => {
        const id = `provider-${providers.length + 1}`;
        providers.push(id);
        return provider(id);
      },
    },
  );

  await waitFor(
    () => connection.replacements.length === 1,
    'first capability publication before revision change',
  );
  manager.changeRevision(2);
  firstPublication.resolve();
  await waitFor(
    () => connection.replacements.length === 2,
    'second capability publication after coalesced revision',
  );
  await waitFor(
    () => controller.snapshot().publication === 'published',
    "coalesced TUI MCP publication to reach 'published'",
  );
  assert.deepEqual(providers, ['provider-1', 'provider-2']);
  await controller.close();
});

test('TUI MCP invalidates a lost generation and republishes on its replacement', async () => {
  const manager = managerHarness(1, [connectedStatus('local', 1)]);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: configStoreHarness(async () => emptyConfig()),
      manager: manager.manager,
      createProvider: () => provider(`provider-${connection.replacements.length + 1}`),
    },
  );

  await waitFor(
    () => connection.replacements.length === 1,
    'first capability publication before host unavailable',
  );
  connection.emit({ kind: 'unavailable' });
  assert.equal(controller.snapshot().publication, 'host_unavailable');
  connection.emit({ kind: 'connected', hostEpoch: 'host-2', connectionId: 'connection-2' });
  await waitFor(
    () => connection.replacements.length === 2,
    'second capability publication after generation replacement',
  );
  await waitFor(
    () => controller.snapshot().publication === 'published',
    "TUI MCP publication to reach 'published' after generation replacement",
  );
  await controller.close();
});

test('TUI MCP unregisters the current generation when discovery removes every tool', async () => {
  const manager = managerHarness(1, [connectedStatus('local', 1)]);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: configStoreHarness(async () => emptyConfig()),
      manager: manager.manager,
      createProvider: (current) =>
        current.toolSnapshot().tools.length === 0 ? undefined : provider('provider'),
    },
  );

  await waitFor(
    () => controller.snapshot().publication === 'published',
    "initial TUI MCP publication to reach 'published' before empty snapshot",
  );
  manager.changeRevision(2, 0);
  await waitFor(
    () => controller.snapshot().publication === 'not_published',
    "TUI MCP publication to reach 'not_published' after empty tool snapshot",
  );
  assert.equal(connection.unregisters, 1);
  await controller.close();
  assert.equal(connection.unregisters, 1);
});

test('TUI MCP fails closed when its saved config cannot be read', async () => {
  const manager = managerHarness(0, []);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: configStoreHarness(async () => {
        throw new Error('config contains secret-value');
      }),
      manager: manager.manager,
      createProvider: () => provider('must-not-publish'),
    },
  );

  await waitFor(
    () => controller.snapshot().initialization === 'error',
    "TUI MCP initialization to reach 'error' when config read fails",
  );
  assert.equal(controller.snapshot().publication, 'not_published');
  assert.equal(JSON.stringify(controller.snapshot()).includes('secret-value'), false);
  assert.equal(connection.replacements.length, 0);
  await controller.close();
});

test('TUI MCP unregisters a publication that settles while close is waiting', async () => {
  const manager = managerHarness(1, [connectedStatus('local', 1)]);
  const connection = connectionHarness();
  const publication = deferred();
  connection.replace = async () => {
    connection.replacements.push('replace');
    await publication.promise;
  };
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: configStoreHarness(async () => emptyConfig()),
      manager: manager.manager,
      createProvider: () => provider('provider'),
    },
  );

  await waitFor(
    () => connection.replacements.length === 1,
    'initial capability publication before close',
  );
  const closing = controller.close();
  publication.resolve();
  await closing;
  assert.equal(connection.unregisters, 1);
  assert.equal(manager.closed, 1);
});

test('TUI MCP add commits before manager synchronization and reports Host convergence', async () => {
  const order: string[] = [];
  const store = mutableConfigStore(emptyConfig(), order);
  const manager = managementManager(order);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: store.store,
      manager: manager.manager,
      createProvider: () => undefined,
    },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before add",
  );
  order.length = 0;

  const result = await controller.execute({
    kind: 'add',
    serverId: 'docs',
    config: { url: 'https://docs.example/mcp', protocol: 'auto' },
  });

  assert.deepEqual(result, { status: 'applied', effect: 'published' });
  assert.deepEqual(order, ['transform', 'sync']);
  assert.deepEqual((await store.store.get()).mcpServers.docs, {
    enabled: true,
    url: 'https://docs.example/mcp',
    transport: 'auto',
    protocol: 'auto',
  });
  assert.equal(controller.snapshot().configuration, 'ready');
  await controller.close();
});

test('TUI MCP retires endpoint credentials before persistence and aborts on cleanup failure', async () => {
  const order: string[] = [];
  const store = mutableConfigStore(
    {
      version: 3,
      mcpServers: { docs: { url: 'https://old.example/mcp' } },
    },
    order,
  );
  const manager = managementManager(order, { credentialFailure: true });
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store.store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before credential-retiring edit",
  );
  order.length = 0;
  const edit = controller.configForEdit('docs');
  assert.ok(edit);

  const result = await controller.execute({
    kind: 'edit',
    serverId: 'docs',
    expectedRevision: edit.revision,
    config: { url: 'https://new.example/mcp' },
  });

  assert.deepEqual(result, { status: 'failed', reason: 'credential-cleanup-failed' });
  assert.deepEqual(order, ['transform', 'forget:docs']);
  const stored = (await store.store.get()).mcpServers.docs;
  assert.ok(stored && 'url' in stored);
  assert.equal(stored.url, 'https://old.example/mcp');
  await controller.close();
});

test('TUI MCP rejects an invalid endpoint before retiring the previous credentials', async () => {
  const order: string[] = [];
  const store = mutableConfigStore(
    { version: 3, mcpServers: { docs: { url: 'https://old.example/mcp' } } },
    order,
  );
  const manager = managementManager(order);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store.store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before invalid edit",
  );
  const edit = controller.configForEdit('docs');
  assert.ok(edit);
  order.length = 0;

  assert.deepEqual(
    await controller.execute({
      kind: 'edit',
      serverId: 'docs',
      expectedRevision: edit.revision,
      config: { url: 'http://public.example/mcp' },
    }),
    { status: 'failed', reason: 'invalid-config' },
  );
  assert.deepEqual(order, ['transform']);
  await controller.close();
});

test('TUI MCP edit rejects a stale revision without touching credentials or disk', async () => {
  const order: string[] = [];
  const store = mutableConfigStore(
    { version: 3, mcpServers: { docs: { url: 'https://one.example/mcp' } } },
    order,
  );
  const manager = managementManager(order);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store.store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before stale-revision edit",
  );
  const edit = controller.configForEdit('docs');
  assert.ok(edit);
  store.replace({ version: 3, mcpServers: { docs: { url: 'https://other.example/mcp' } } });
  order.length = 0;

  const result = await controller.execute({
    kind: 'edit',
    serverId: 'docs',
    expectedRevision: edit.revision,
    config: { url: 'https://new.example/mcp' },
  });

  assert.deepEqual(result, { status: 'conflict', reason: 'stale_edit' });
  assert.deepEqual(order, ['transform']);
  await controller.close();
});

test('TUI MCP import preserves unrelated external edits and rejects changed preview entries', async () => {
  const order: string[] = [];
  const store = mutableConfigStore(
    { version: 3, mcpServers: { existing: { command: 'one' } } },
    order,
  );
  const manager = managementManager(order);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store.store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before import preview",
  );
  const preview = controller.previewImport('{"docs":{"url":"https://docs.example/mcp"}}');
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') throw new Error('preview did not prepare');
  store.replace({
    version: 3,
    mcpServers: { existing: { command: 'externally-edited' } },
  });

  assert.deepEqual(
    await controller.execute({ kind: 'commit_import', previewId: preview.preview.previewId }),
    {
      status: 'applied',
      effect: 'published',
    },
  );
  const existing = (await store.store.get()).mcpServers.existing;
  assert.ok(existing && 'command' in existing);
  assert.equal(existing.command, 'externally-edited');

  const stale = controller.previewImport('{"docs":{"url":"https://replacement.example/mcp"}}');
  assert.equal(stale.status, 'ready');
  if (stale.status !== 'ready') throw new Error('preview did not prepare');
  store.replace({
    version: 3,
    mcpServers: {
      ...(await store.store.get()).mcpServers,
      docs: { url: 'https://concurrent.example/mcp' },
    },
  });
  assert.deepEqual(
    await controller.execute({ kind: 'commit_import', previewId: stale.preview.previewId }),
    {
      status: 'conflict',
      reason: 'stale_import',
    },
  );
  await controller.close();
});

test('TUI MCP keeps a durable mutation visible when manager synchronization fails', async () => {
  const order: string[] = [];
  const store = mutableConfigStore(emptyConfig(), order);
  const manager = managementManager(order);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store.store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before sync-failed mutation",
  );
  manager.failNextSync();

  const result = await controller.execute({
    kind: 'add',
    serverId: 'local',
    config: { command: 'server' },
  });

  assert.deepEqual(result, { status: 'applied', effect: 'sync_failed' });
  assert.equal(controller.snapshot().configuration, 'out_of_sync');
  assert.deepEqual(controller.snapshot().servers[0], {
    serverId: 'local',
    configured: true,
    synchronized: false,
    enabled: true,
    configuredTransport: 'stdio',
    configuredProtocol: 'legacy',
    toolCount: 0,
  });
  assert.ok((await store.store.get()).mcpServers.local);
  await controller.close();
});

for (const scenario of [
  'remove',
  'edit',
  'newer-config',
  'read-failure',
  'sync-failure',
  'publication-failure',
] as const) {
  test(`TUI MCP reconciles an already-published write through execute: ${scenario}`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tui-mcp-commit-unknown-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = createMcpConfigStore(root);
    await store.upsert('docs', { url: 'https://old.example/mcp' });
    const previous = await store.get();
    let activeConfig = structuredClone(previous);
    const statuses = [connectedStatus('docs', 1)];
    const manager = managerHarness(1, statuses);
    const connection = connectionHarness();
    const fenceError = new Error('injected post-rename directory sync failure');
    const reconciliationError = new Error('injected reconciliation failure');
    let failing = false;
    let transforms = 0;
    let reloads = 0;
    let synchronizations = 0;
    let retirements = 0;
    let revision = 1;
    let writeError: unknown;
    manager.manager.sync = async (config) => {
      synchronizations += 1;
      if (failing && scenario === 'sync-failure') throw reconciliationError;
      activeConfig = structuredClone(config);
      statuses.splice(
        0,
        statuses.length,
        ...Object.keys(config.mcpServers).map((id) => connectedStatus(id, 1)),
      );
      manager.changeRevision(++revision, statuses.length);
    };
    manager.manager.forgetServerCredentials = async () => {
      retirements += 1;
    };
    const controller = createTuiMcpController(
      { workspaceRoot: root, connection: connection.connection },
      {
        configStore: {
          get: async () => {
            reloads += 1;
            if (failing && scenario === 'read-failure') throw reconciliationError;
            return store.get();
          },
          transform: async (apply) => {
            transforms += 1;
            try {
              return await store.transform(apply);
            } catch (error) {
              writeError = error;
              if (scenario === 'newer-config') {
                // Another writer commits after the failed transform releases
                // its lock, before this caller reloads the authority.
                await store.upsert('external', { command: 'concurrent-server' });
              }
              throw error;
            }
          },
        },
        manager: manager.manager,
        createProvider: (current) =>
          current.toolSnapshot().tools.length === 0 ? undefined : provider('docs'),
      },
    );
    t.after(() => controller.close());
    await waitFor(
      () => controller.snapshot().publication === 'published',
      'initial MCP publication before injected directory sync failure',
    );
    synchronizations = 0;
    reloads = 0;
    const originalOpen = fs.open;
    let failedFences = 0;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === root && args[1] === 'r' && failedFences === 0) {
        t.mock.method(handle, 'sync', async () => {
          failedFences += 1;
          throw fenceError;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    failing = true;
    if (scenario === 'publication-failure') {
      connection.replace = async () => {
        throw reconciliationError;
      };
    }
    const edit = controller.configForEdit('docs');
    assert.ok(edit);
    const result = await controller.execute(
      scenario === 'edit' || scenario === 'publication-failure'
        ? {
            kind: 'edit',
            serverId: 'docs',
            expectedRevision: edit.revision,
            config: { url: 'https://new.example/mcp' },
          }
        : { kind: 'remove', serverId: 'docs' },
    );

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed' || result.reason !== 'commit-unknown') {
      assert.fail('published write must retain its uncertain durability result');
    }
    assert.equal(result.cause, writeError);
    assert.ok(result.cause instanceof AtomicFileWriteCommitUnknownError);
    assert.equal(result.cause.published, true);
    assert.equal(result.cause.cause, fenceError);
    assert.equal(failedFences, 1);
    assert.equal(transforms, 1);
    assert.equal(retirements, 1);
    assert.equal(reloads, 1);
    const published = JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')) as McpConfigFile;
    if (scenario === 'edit' || scenario === 'publication-failure') {
      assert.equal((published.mcpServers.docs as { url: string }).url, 'https://new.example/mcp');
    } else if (scenario === 'newer-config') {
      assert.deepEqual(Object.keys(published.mcpServers), ['external']);
      assert.equal(
        (published.mcpServers.external as { command: string }).command,
        'concurrent-server',
      );
    } else {
      assert.deepEqual(published.mcpServers, {});
    }
    if (scenario === 'read-failure' || scenario === 'sync-failure') {
      assert.equal(result.reconciliationError, reconciliationError);
      assert.equal(controller.snapshot().configuration, 'out_of_sync');
      assert.ok(controller.snapshot().servers.every((server) => !server.synchronized));
      assert.deepEqual(activeConfig, previous);
      assert.equal(synchronizations, scenario === 'read-failure' ? 0 : 1);
    } else {
      assert.deepEqual(activeConfig, published);
      assert.equal(synchronizations, 1);
      assert.equal(controller.snapshot().configuration, 'ready');
      if (scenario === 'remove') {
        assert.equal(controller.configForEdit('docs'), undefined);
        assert.deepEqual(controller.snapshot().servers, []);
        assert.equal(controller.snapshot().publication, 'not_published');
        assert.equal(connection.unregisters, 1);
      } else if (scenario === 'newer-config') {
        assert.equal(controller.configForEdit('docs'), undefined);
        assert.deepEqual(
          controller.configForEdit('external')?.config,
          published.mcpServers.external,
        );
        assert.deepEqual(
          controller.snapshot().servers.map((server) => server.serverId),
          ['external'],
        );
        assert.equal(controller.snapshot().servers[0]?.synchronized, true);
        assert.equal(controller.snapshot().publication, 'published');
        assert.equal(connection.replacements.length, 2);
      } else {
        assert.deepEqual(controller.configForEdit('docs')?.config, published.mcpServers.docs);
        assert.equal(controller.snapshot().servers[0]?.synchronized, true);
        assert.equal(
          controller.snapshot().publication,
          scenario === 'publication-failure' ? 'error' : 'published',
        );
        if (scenario === 'edit') assert.equal(connection.replacements.length, 2);
      }
    }
  });
}

test('TUI MCP does not reconcile or replay a write that fails before publication', async (t) => {
  const initial: McpConfigFile = { version: 3, mcpServers: { docs: { command: 'server' } } };
  let reads = 0;
  let transforms = 0;
  const manager = managementManager([]);
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connectionHarness().connection },
    {
      configStore: {
        get: async () => {
          reads += 1;
          return initial;
        },
        transform: async () => {
          transforms += 1;
          throw new Error('temporary file write failed');
        },
      },
      manager: manager.manager,
      createProvider: () => undefined,
    },
  );
  t.after(() => controller.close());
  await waitFor(() => controller.snapshot().initialization === 'ready', 'MCP initialization');
  assert.deepEqual(await controller.execute({ kind: 'remove', serverId: 'docs' }), {
    status: 'failed',
    reason: 'persist-failed',
  });
  assert.equal(reads, 1);
  assert.equal(transforms, 1);
  assert.deepEqual(controller.configForEdit('docs')?.config, initial.mcpServers.docs);
  assert.equal(controller.snapshot().configuration, 'ready');
});

test('TUI MCP close fences reconciliation while retaining the published write error', async () => {
  const initial: McpConfigFile = { version: 3, mcpServers: { docs: { command: 'server' } } };
  const reload = deferredValue<McpConfigFile>();
  const writeError = new AtomicFileWriteCommitUnknownError({ cause: new Error('directory sync') });
  let reads = 0;
  const order: string[] = [];
  const manager = managementManager(order);
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connectionHarness().connection },
    {
      configStore: {
        get: async () => (++reads === 1 ? initial : reload.promise),
        transform: async () => {
          throw writeError;
        },
      },
      manager: manager.manager,
      createProvider: () => undefined,
    },
  );
  await waitFor(() => controller.snapshot().initialization === 'ready', 'MCP initialization');
  order.length = 0;
  const executing = controller.execute({ kind: 'remove', serverId: 'docs' });
  await waitFor(() => reads === 2, 'authoritative reload before closing');
  const closing = controller.close();
  reload.resolve(emptyConfig());
  assert.deepEqual(await executing, {
    status: 'failed',
    reason: 'commit-unknown',
    cause: writeError,
  });
  await closing;
  assert.deepEqual(order, []);
  assert.equal(controller.configForEdit('docs'), undefined);
});

test('TUI MCP reports a committed action as pending while the Host is unavailable', async () => {
  const order: string[] = [];
  const store = mutableConfigStore(emptyConfig(), order);
  const manager = managementManager(order);
  const connection = connectionHarness();
  connection.emit({ kind: 'unavailable' });
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store.store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' while host unavailable",
  );

  assert.deepEqual(
    await controller.execute({ kind: 'add', serverId: 'local', config: { command: 'server' } }),
    { status: 'applied', effect: 'pending_host' },
  );
  await controller.close();
});

test('TUI MCP close fences an admitted mutation before persistence', async () => {
  const transactionAdmission = deferred();
  let reads = 0;
  let transforms = 0;
  let writes = 0;
  const store = {
    get: async () => {
      reads += 1;
      return emptyConfig();
    },
    transform: async (
      apply: (current: McpConfigFile) => McpConfigFile | Promise<McpConfigFile>,
    ) => {
      transforms += 1;
      await transactionAdmission.promise;
      const next = await apply(emptyConfig());
      writes += 1;
      return next;
    },
  };
  const manager = managementManager([]);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before fenced mutation",
  );
  const executing = controller.execute({
    kind: 'add',
    serverId: 'late',
    config: { command: 'server' },
  });
  await waitFor(() => transforms === 1, 'config transform to be admitted before close fence');
  const closing = controller.close();
  transactionAdmission.resolve();

  assert.deepEqual(await executing, { status: 'failed', reason: 'closed' });
  await closing;
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test('TUI MCP waits for manager synchronization before publishing an action snapshot', async () => {
  const store = mutableConfigStore(emptyConfig(), []);
  const actionSync = deferred();
  let syncCount = 0;
  let listener: (() => void) | undefined;
  let revision = 0;
  const manager = {
    sync: async () => {
      syncCount += 1;
      revision += 1;
      listener?.();
      if (syncCount === 2) await actionSync.promise;
    },
    statuses: () => [],
    toolSnapshot: () => ({ revision, tools: [{}] }) as unknown as McpToolSnapshot,
    callTool: async () => ({ content: [] }),
    test: async () => ({ ok: true, status: connectedStatus('local', 1), latencyMs: 1 }),
    reconnect: async () => connectedStatus('local', 1),
    forgetServerCredentials: async () => undefined,
    onChange: (next: () => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    close: async () => undefined,
  } as unknown as ReturnType<typeof managementManager>['manager'];
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store.store, manager, createProvider: () => provider('provider') },
  );
  await waitFor(
    () => controller.snapshot().publication === 'published',
    "initial TUI MCP publication to reach 'published' before action sync",
  );
  connection.replacements.length = 0;

  const executing = controller.execute({
    kind: 'add',
    serverId: 'local',
    config: { command: 'server' },
  });
  await waitFor(
    () => syncCount === 2,
    'manager sync to reach count 2 before publishing action snapshot',
  );
  assert.equal(connection.replacements.length, 0);
  assert.equal(controller.snapshot().configuration, 'synchronizing');
  actionSync.resolve();

  assert.deepEqual(await executing, { status: 'applied', effect: 'published' });
  assert.equal(connection.replacements.length, 1);
  await controller.close();
});

test('TUI MCP rebases an action over an unrelated concurrent config edit', async () => {
  let config: McpConfigFile = {
    version: 3,
    mcpServers: { existing: { command: 'before' } },
  };
  const store = {
    get: async () => structuredClone(config),
    transform: async (
      apply: (current: McpConfigFile) => McpConfigFile | Promise<McpConfigFile>,
    ) => {
      config = await apply({
        version: 3,
        mcpServers: { existing: { command: 'concurrent' } },
      });
      return structuredClone(config);
    },
  };
  const manager = managementManager([]);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before rebased concurrent edit",
  );

  assert.deepEqual(
    await controller.execute({ kind: 'add', serverId: 'local', config: { command: 'server' } }),
    { status: 'applied', effect: 'published' },
  );
  const existing = config.mcpServers.existing;
  assert.ok(existing && 'command' in existing);
  assert.equal(existing.command, 'concurrent');
  assert.ok(config.mcpServers.local);
  await controller.close();
});

test('independent TUI controllers preserve concurrent additions in one workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tui-mcp-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createMcpConfigStore(root).transform((current) => current);
  const left = createTuiMcpController(
    { workspaceRoot: root, connection: connectionHarness().connection },
    {
      configStore: createMcpConfigStore(root),
      manager: managementManager([]).manager,
      createProvider: () => undefined,
    },
  );
  const right = createTuiMcpController(
    { workspaceRoot: root, connection: connectionHarness().connection },
    {
      configStore: createMcpConfigStore(root),
      manager: managementManager([]).manager,
      createProvider: () => undefined,
    },
  );
  await waitFor(
    () => left.snapshot().initialization === 'ready' && right.snapshot().initialization === 'ready',
    "both TUI controllers to reach 'ready' before concurrent additions",
  );

  const [leftResult, rightResult] = await Promise.all([
    left.execute({ kind: 'add', serverId: 'left', config: { command: 'left-server' } }),
    right.execute({ kind: 'add', serverId: 'right', config: { command: 'right-server' } }),
  ]);

  assert.equal(leftResult.status, 'applied');
  assert.equal(rightResult.status, 'applied');
  const saved = await createMcpConfigStore(root).get();
  assert.ok(saved.mcpServers.left);
  assert.ok(saved.mcpServers.right);
  await Promise.all([left.close(), right.close()]);
});

test('same-server credential retirement stays inside the shared config transaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tui-mcp-retirement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createMcpConfigStore(root).upsert('docs', { url: 'https://old.example/mcp' });
  const retirement = deferred();
  const leftOrder: string[] = [];
  const rightOrder: string[] = [];
  const left = createTuiMcpController(
    { workspaceRoot: root, connection: connectionHarness().connection },
    {
      configStore: createMcpConfigStore(root),
      manager: managementManager(leftOrder, { credentialWait: retirement.promise }).manager,
      createProvider: () => undefined,
    },
  );
  const right = createTuiMcpController(
    { workspaceRoot: root, connection: connectionHarness().connection },
    {
      configStore: createMcpConfigStore(root),
      manager: managementManager(rightOrder).manager,
      createProvider: () => undefined,
    },
  );
  await waitFor(
    () => left.snapshot().initialization === 'ready' && right.snapshot().initialization === 'ready',
    "both TUI controllers to reach 'ready' before credential-retirement transaction",
  );
  const leftEdit = left.configForEdit('docs');
  const rightEdit = right.configForEdit('docs');
  assert.ok(leftEdit);
  assert.ok(rightEdit);

  const first = left.execute({
    kind: 'edit',
    serverId: 'docs',
    expectedRevision: leftEdit.revision,
    config: { url: 'https://left.example/mcp' },
  });
  await waitFor(
    () => leftOrder.includes('forget:docs'),
    'left controller to retire credentials inside the shared config transaction',
  );
  const second = right.execute({
    kind: 'edit',
    serverId: 'docs',
    expectedRevision: rightEdit.revision,
    config: { url: 'https://right.example/mcp' },
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(rightOrder.includes('forget:docs'), false);

  retirement.resolve();
  assert.deepEqual(await first, { status: 'applied', effect: 'published' });
  assert.deepEqual(await second, { status: 'conflict', reason: 'stale_edit' });
  assert.equal(rightOrder.includes('forget:docs'), false);
  const saved = (await createMcpConfigStore(root).get()).mcpServers.docs;
  assert.ok(saved && 'url' in saved);
  assert.equal(saved.url, 'https://left.example/mcp');
  await Promise.all([left.close(), right.close()]);
});

test('TUI MCP manages enabled state, tests, reconnects, and removes through one lane', async () => {
  const order: string[] = [];
  const store = mutableConfigStore(
    {
      version: 3,
      mcpServers: { docs: { enabled: false, url: 'https://docs.example/mcp' } },
    },
    order,
  );
  const manager = managementManager(order);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    { configStore: store.store, manager: manager.manager, createProvider: () => undefined },
  );
  await waitFor(
    () => controller.snapshot().initialization === 'ready',
    "TUI MCP initialization to reach 'ready' before enabled/test/reconnect/remove lane",
  );
  order.length = 0;

  assert.deepEqual(
    await controller.execute({ kind: 'set_enabled', serverId: 'docs', enabled: true }),
    { status: 'applied', effect: 'published' },
  );
  assert.equal((await store.store.get()).mcpServers.docs?.enabled, true);
  const tested = await controller.execute({ kind: 'test', serverId: 'docs' });
  assert.equal(tested.status, 'tested');
  assert.deepEqual(await controller.execute({ kind: 'reconnect', serverId: 'docs' }), {
    status: 'applied',
    effect: 'published',
  });
  assert.deepEqual(await controller.execute({ kind: 'remove', serverId: 'docs' }), {
    status: 'applied',
    effect: 'published',
  });
  assert.deepEqual(
    order.filter((entry) => entry.startsWith('test') || entry.startsWith('reconnect')),
    ['test:docs', 'reconnect:docs'],
  );
  assert.equal((await store.store.get()).mcpServers.docs, undefined);
  await controller.close();
});

function mutableConfigStore(initial: McpConfigFile, order: string[]) {
  let config = structuredClone(initial);
  const store = {
    get: async () => {
      order.push('get');
      return structuredClone(config);
    },
    transform: async (
      apply: (current: McpConfigFile) => McpConfigFile | Promise<McpConfigFile>,
    ) => {
      order.push('transform');
      config = structuredClone(await apply(structuredClone(config)));
      return structuredClone(config);
    },
  };
  return {
    store,
    replace(next: McpConfigFile) {
      config = structuredClone(next);
    },
  };
}

function managementManager(
  order: string[],
  options: { readonly credentialFailure?: boolean; readonly credentialWait?: Promise<void> } = {},
) {
  let listener: (() => void) | undefined;
  let syncFailure = false;
  let revision = 0;
  const statuses: McpServerStatus[] = [];
  const manager = {
    sync: async () => {
      order.push('sync');
      if (syncFailure) {
        syncFailure = false;
        throw new Error('sync failed');
      }
      revision += 1;
      listener?.();
    },
    statuses: () => statuses,
    toolSnapshot: () => ({ revision, tools: [] }) as McpToolSnapshot,
    callTool: async () => ({ content: [] }),
    test: async (serverId: string) => {
      order.push(`test:${serverId}`);
      return { ok: true, status: connectedStatus(serverId, 0), latencyMs: 1 };
    },
    reconnect: async (serverId: string) => {
      order.push(`reconnect:${serverId}`);
      return connectedStatus(serverId, 0);
    },
    forgetServerCredentials: async (serverId: string) => {
      order.push(`forget:${serverId}`);
      if (options.credentialFailure) throw new Error('credential cleanup failed');
      await options.credentialWait;
    },
    onChange: (next: () => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    close: async () => undefined,
  } as unknown as Pick<
    McpClientManager,
    | 'sync'
    | 'statuses'
    | 'toolSnapshot'
    | 'callTool'
    | 'test'
    | 'reconnect'
    | 'forgetServerCredentials'
    | 'onChange'
    | 'close'
  >;
  return {
    manager,
    failNextSync() {
      syncFailure = true;
    },
  };
}

function managerHarness(revision: number, statuses: McpServerStatus[]) {
  let currentRevision = revision;
  let toolCount = revision === 0 ? 0 : 1;
  let listener: (() => void) | undefined;
  let closed = 0;
  const manager = {
    sync: async () => undefined,
    statuses: () => statuses,
    toolSnapshot: () =>
      ({
        revision: currentRevision,
        tools: new Array(toolCount).fill({}),
      }) as McpToolSnapshot,
    callTool: async () => ({ content: [] }),
    test: async () => ({ ok: true, status: connectedStatus('local', 1), latencyMs: 1 }),
    reconnect: async () => connectedStatus('local', 1),
    forgetServerCredentials: async () => undefined,
    onChange: (next: () => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    close: async () => {
      closed += 1;
    },
  } as unknown as Pick<
    McpClientManager,
    | 'sync'
    | 'statuses'
    | 'toolSnapshot'
    | 'callTool'
    | 'onChange'
    | 'test'
    | 'reconnect'
    | 'forgetServerCredentials'
    | 'close'
  >;
  return {
    manager,
    changeRevision(next: number, nextToolCount = 1) {
      currentRevision = next;
      toolCount = nextToolCount;
      listener?.();
    },
    get closed() {
      return closed;
    },
  };
}

function connectionHarness() {
  let availability: RuntimeHostConnectionAvailability = {
    kind: 'connected',
    hostEpoch: 'host-1',
    connectionId: 'connection-1',
  };
  let listener: ((value: RuntimeHostConnectionAvailability) => void) | undefined;
  const replacements: string[] = [];
  let unregisters = 0;
  let registered = false;
  const harness = {
    replacements,
    replace: async (_provider: ClientCapabilityProvider) => {
      replacements.push('replace');
    },
    connection: {
      replaceClientCapabilities: async (provider: ClientCapabilityProvider) => {
        await harness.replace(provider);
        registered = true;
        return { registrationId: 'registration', revision: 1 };
      },
      unregisterClientCapabilities: async () => {
        if (!registered) throw new Error('No Client Capability registration is active');
        registered = false;
        unregisters += 1;
        return { registrationId: 'registration', revision: 1 };
      },
      subscribeConnectionAvailability: (
        next: (value: RuntimeHostConnectionAvailability) => void,
      ) => {
        listener = next;
        next(availability);
        return () => {
          if (listener === next) listener = undefined;
        };
      },
    },
    emit(next: RuntimeHostConnectionAvailability) {
      availability = next;
      listener?.(next);
    },
    get unregisters() {
      return unregisters;
    },
  };
  return harness;
}

function provider(_id: string): ClientCapabilityProvider {
  return { offers: () => [] };
}

function connectedStatus(serverId: string, toolCount: number): McpServerStatus {
  return {
    serverId,
    state: 'connected',
    transport: 'stdio',
    negotiatedProtocol: { era: 'legacy', revision: '2024-11-05' },
    toolCount,
    tools: [],
    updatedAt: 1,
  };
}

function emptyConfig(): McpConfigFile {
  return { version: 3, mcpServers: {} };
}

function configStoreHarness(get: () => Promise<McpConfigFile>) {
  return {
    get,
    transform: async (apply: (current: McpConfigFile) => McpConfigFile | Promise<McpConfigFile>) =>
      apply(await get()),
  };
}
function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
