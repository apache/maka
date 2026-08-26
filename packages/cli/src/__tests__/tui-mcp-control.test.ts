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
import type { McpConfigFile, McpServerStatus, McpToolSnapshot } from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import type {
  ClientCapabilityProvider,
  RuntimeHostConnectionAvailability,
} from '@maka/runtime-host/client';
import { createTuiMcpController } from '../tui-mcp-control.js';

test('TUI MCP startup stays backgrounded and publishes the discovered snapshot', async () => {
  const config = deferredValue<McpConfigFile>();
  const manager = managerHarness(1, [connectedStatus('local', 2)]);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: { get: () => config.promise },
      manager: manager.manager,
      createProvider: () => provider('provider-1'),
    },
  );

  assert.equal(controller.snapshot().initialization, 'loading');
  assert.equal(connection.replacements.length, 0);
  config.resolve(emptyConfig());
  await waitFor(() => controller.snapshot().publication === 'published');
  assert.equal(controller.snapshot().initialization, 'ready');
  assert.equal(controller.snapshot().toolCount, 1);
  assert.deepEqual(controller.snapshot().servers, [
    {
      serverId: 'local',
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
      configStore: { get: async () => emptyConfig() },
      manager: manager.manager,
      createProvider: () => {
        const id = `provider-${providers.length + 1}`;
        providers.push(id);
        return provider(id);
      },
    },
  );

  await waitFor(() => connection.replacements.length === 1);
  manager.changeRevision(2);
  firstPublication.resolve();
  await waitFor(() => connection.replacements.length === 2);
  await waitFor(() => controller.snapshot().publication === 'published');
  assert.deepEqual(providers, ['provider-1', 'provider-2']);
  await controller.close();
});

test('TUI MCP invalidates a lost generation and republishes on its replacement', async () => {
  const manager = managerHarness(1, [connectedStatus('local', 1)]);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: { get: async () => emptyConfig() },
      manager: manager.manager,
      createProvider: () => provider(`provider-${connection.replacements.length + 1}`),
    },
  );

  await waitFor(() => connection.replacements.length === 1);
  connection.emit({ kind: 'unavailable' });
  assert.equal(controller.snapshot().publication, 'host_unavailable');
  connection.emit({ kind: 'connected', hostEpoch: 'host-2', connectionId: 'connection-2' });
  await waitFor(() => connection.replacements.length === 2);
  await waitFor(() => controller.snapshot().publication === 'published');
  await controller.close();
});

test('TUI MCP unregisters the current generation when discovery removes every tool', async () => {
  const manager = managerHarness(1, [connectedStatus('local', 1)]);
  const connection = connectionHarness();
  const controller = createTuiMcpController(
    { workspaceRoot: '/unused', connection: connection.connection },
    {
      configStore: { get: async () => emptyConfig() },
      manager: manager.manager,
      createProvider: (current) =>
        current.toolSnapshot().tools.length === 0 ? undefined : provider('provider'),
    },
  );

  await waitFor(() => controller.snapshot().publication === 'published');
  manager.changeRevision(2, 0);
  await waitFor(() => controller.snapshot().publication === 'not_published');
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
      configStore: {
        get: async () => {
          throw new Error('config contains secret-value');
        },
      },
      manager: manager.manager,
      createProvider: () => provider('must-not-publish'),
    },
  );

  await waitFor(() => controller.snapshot().initialization === 'error');
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
      configStore: { get: async () => emptyConfig() },
      manager: manager.manager,
      createProvider: () => provider('provider'),
    },
  );

  await waitFor(() => connection.replacements.length === 1);
  const closing = controller.close();
  publication.resolve();
  await closing;
  assert.equal(connection.unregisters, 1);
  assert.equal(manager.closed, 1);
});

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
    'sync' | 'statuses' | 'toolSnapshot' | 'callTool' | 'onChange' | 'close'
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !condition(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(condition());
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
