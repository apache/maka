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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { deferred } from '@maka/core/test-only/async-primitives';
import { createDefaultMcpConfig, type McpConfigFile, type McpServerStatus } from '@maka/core/mcp';
import { createFakeModuleHubServices, ModuleHubServicesProvider, useMcpController } from '../../renderer/features/module-hub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('MCP create rejects an occupied ID and refreshes committed config after a failed connection', async () => {
  const { root } = installReactRenderer();
  const defaults = createFakeModuleHubServices();
  let saved: McpConfigFile = { ...createDefaultMcpConfig(), mcpServers: { existing: { command: 'original' } } };
  let updates = 0;
  const services = createFakeModuleHubServices({ mcp: {
    ...defaults.mcp,
    getConfig: async () => saved,
    add: async (id, server) => {
      if (id in saved.mcpServers) return { status: 'exists' };
      saved = { ...saved, mcpServers: { ...saved.mcpServers, [id]: server } };
      throw new Error('connection failed after save');
    },
    update: async () => { updates++; return { status: 'updated', config: saved }; },
  } });
  let controller!: ReturnType<typeof useMcpController>;
  function Probe() { controller = useMcpController(); return null; }
  await act(async () => root.render(createElement(ModuleHubServicesProvider, { services }, createElement(Probe))));
  await act(async () => assert.deepEqual(await controller.add('existing', { command: 'replacement' }), { status: 'exists' }));
  assert.deepEqual(saved.mcpServers.existing, { command: 'original' });
  assert.equal(updates, 0);
  await act(async () => { await controller.add('new', { command: 'server' }); });
  assert.deepEqual(controller.config.mcpServers.new, { command: 'server' });
  assert.match(String(controller.error), /connection failed/);
  assert.equal(controller.busy, null);
});

test('MCP holds an action until its refreshed config lands', async () => {
  const { root } = installReactRenderer();
  const defaults = createFakeModuleHubServices();
  const added = deferred<void>();
  let refresh: ReturnType<typeof deferred<McpConfigFile>> | undefined;
  let adds = 0;
  const services = createFakeModuleHubServices({ mcp: {
    ...defaults.mcp,
    getConfig: async () => refresh ? refresh.promise : createDefaultMcpConfig(),
    add: async () => {
      adds++;
      refresh = deferred<McpConfigFile>();
      added.resolve();
      return { status: 'added', config: createDefaultMcpConfig() };
    },
  } });
  let controller!: ReturnType<typeof useMcpController>;
  function Probe() { controller = useMcpController(); return null; }
  await act(async () => root.render(createElement(ModuleHubServicesProvider, { services }, createElement(Probe))));
  let first!: Promise<unknown>;
  await act(async () => { first = controller.add('notion', { url: 'https://mcp.notion.com/mcp' }); await added.promise; });
  assert.equal(controller.busy, 'save');
  await act(async () => assert.equal(await controller.add('notion', { url: 'https://mcp.notion.com/mcp' }), undefined));
  assert.equal(adds, 1);
  await act(async () => {
    refresh?.resolve({ ...createDefaultMcpConfig(), mcpServers: { notion: { url: 'https://mcp.notion.com/mcp' } } });
    await first;
  });
  assert.equal(controller.busy, null);
  assert.deepEqual(Object.keys(controller.config.mcpServers), ['notion']);
});

test('MCP login can be cancelled on its original Host and never writes a late result into another Host', async () => {
  const { root } = installReactRenderer();
  const defaults = createFakeModuleHubServices();
  let host = { profileId: 'a', hostId: 'a' };
  let changed!: () => void;
  const login = deferred<McpServerStatus>();
  const started = deferred<void>();
  const cancelled: string[] = [];
  const services = createFakeModuleHubServices({
    runtimeHosts: { getDefault: async () => host, subscribeChanges: (handler) => { changed = () => handler({ ...host, isDefault: true, readiness: 'ready' }); return () => {}; } },
    mcp: {
      ...defaults.mcp,
      getConfig: async (scope) => ({ ...createDefaultMcpConfig(), mcpServers: { [scope.hostId]: { command: 'server' } } }),
      login: async () => { started.resolve(); return login.promise; },
      cancelLogin: async (_id, scope) => { cancelled.push(scope.hostId); login.reject(new Error('Login cancelled')); return true; },
    },
  });
  let controller!: ReturnType<typeof useMcpController>;
  function Probe() { controller = useMcpController(); return null; }
  await act(async () => root.render(createElement(ModuleHubServicesProvider, { services }, createElement(Probe))));
  let pending!: Promise<McpServerStatus | undefined>;
  await act(async () => { pending = controller.login('remote'); await started.promise; });
  assert.equal(controller.busy, 'login:remote');
  await act(async () => { host = { profileId: 'b', hostId: 'b' }; changed(); });
  await act(async () => { await controller.cancelLogin('remote'); await pending; });
  assert.deepEqual(cancelled, ['a']);
  assert.equal(controller.error, null);
  assert.deepEqual(Object.keys(controller.config.mcpServers), ['b']);
  assert.equal(controller.busy, null);
});

test('MCP ignores an older config read after a change notification', async () => {
  const { root } = installReactRenderer();
  const defaults = createFakeModuleHubServices();
  const oldRead = deferred<McpConfigFile>();
  let first = true;
  let changed!: () => void;
  let unsubscribed = false;
  const services = createFakeModuleHubServices({ mcp: {
    ...defaults.mcp,
    getConfig: async () => { if (first) { first = false; return oldRead.promise; } return { ...createDefaultMcpConfig(), mcpServers: { newer: { command: 'server' } } }; },
    subscribeChanges: (handler) => { changed = handler; return () => { unsubscribed = true; }; },
  } });
  let controller!: ReturnType<typeof useMcpController>;
  function Probe() { controller = useMcpController(); return null; }
  await act(async () => root.render(createElement(ModuleHubServicesProvider, { services }, createElement(Probe))));
  await act(async () => changed());
  await act(async () => oldRead.resolve(createDefaultMcpConfig()));
  assert.deepEqual(Object.keys(controller.config.mcpServers), ['newer']);
  await act(async () => root.unmount());
  assert.equal(unsubscribed, true);
});

test('MCP can cancel an active login after reopening the page', async () => {
  const { root } = installReactRenderer();
  const defaults = createFakeModuleHubServices();
  let pending = true;
  const services = createFakeModuleHubServices({ mcp: {
    ...defaults.mcp,
    listStatuses: async () => [{ serverId: 'remote', state: 'needs-auth', toolCount: 0, tools: [], updatedAt: 1, authorizationPending: pending }],
    cancelLogin: async () => { pending = false; return true; },
  } });
  let controller!: ReturnType<typeof useMcpController>;
  function Probe() { controller = useMcpController(); return null; }
  await act(async () => root.render(createElement(ModuleHubServicesProvider, { services }, createElement(Probe))));
  assert.equal(controller.statuses[0]?.authorizationPending, true);
  await act(async () => { await controller.cancelLogin('remote'); });
  assert.equal(controller.statuses[0]?.authorizationPending, false);
});
