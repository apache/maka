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
import fs, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MCP_CONFIG_VERSION, type McpConfigFile, type McpServerStatus } from '@maka/core/mcp';
import { McpClientManager } from '@maka/mcp';
import {
  AtomicFileWriteCommitUnknownError,
  createMcpConfigStore,
  type McpConfigStore,
} from '@maka/storage/mcp-config-store';
import { registerMcpIpcMain, type McpIpcMainDeps } from '../mcp-ipc-main.js';
import { getMcpCopy } from '../../renderer/locales/mcp-copy.js';
import { mcpConfigFailureMessage, unwrapMcpIpcResult } from '../../renderer/features/module-hub/testing.js';

test('MCP remove reconciles a live manager after the real store publishes then fails directory sync', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, store } = await fixtureStore(t);
  const fixturePath = fileURLToPath(new URL(
    '../../../../../packages/mcp/dist/__fixtures__/stdio-server.js', import.meta.url,
  ));
  const config = await store.upsert('fixture', {
    command: process.execPath,
    args: [fixturePath],
  });
  const manager = new McpClientManager({
    timeouts: { stdioConnectMs: 5_000, listToolsMs: 5_000 },
  });
  t.after(() => manager.close());
  await manager.sync(config);
  assert.equal(manager.status('fixture')?.state, 'connected');
  assert.ok(manager.toolSnapshot().tools.length > 0);

  const fault = failDirectorySync(t, root);
  const tracked = trackTransform(t, store);
  const publicationError = new Error('capability publication unavailable');
  const ipc = mutationHarness(t, store, {
    manager,
    publishCapabilities: async () => { throw publicationError; },
  });
  await assert.rejects(ipc.invoke('mcp:remove', 'fixture'), (error) => {
    assert.equal(error, tracked.error());
    assert.ok(error instanceof AtomicFileWriteCommitUnknownError);
    assert.equal(error.published, true);
    assert.equal(error.cause, fault.error);
    assert.equal(mcpConfigFailureMessage(error, getMcpCopy('en')), getMcpCopy('en').errors.writeDurabilityUnknown);
    return true;
  });
  assert.deepEqual(await diskConfig(root), { version: MCP_CONFIG_VERSION, mcpServers: {} });
  assert.deepEqual(manager.statuses(), []);
  assert.deepEqual(manager.toolSnapshot().tools, []);
  assert.deepEqual(ipc.emitted, [[]]);
  assert.equal(tracked.calls(), 1);
  assert.equal(tracked.applied(), 1);
  assert.equal(fault.calls(), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ipc.publicationErrors, [publicationError]);
});

test('MCP update reconciles the reread authority including an intervening writer without replaying its mutation', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, store } = await fixtureStore(t);
  await store.upsert('remote', { url: 'https://old.example.com/mcp', enabled: false });
  failDirectorySync(t, root);
  const otherStore = createMcpConfigStore(root);
  const tracked = trackTransform(t, store, async () => {
    await otherStore.upsert('remote', { url: 'https://latest.example.com/mcp', enabled: false });
  });
  const ipc = mutationHarness(t, store);
  const basis = (await ipc.invoke('mcp:getConfig')).mcpServers.remote;
  await assert.rejects(
    ipc.invoke('mcp:update', 'remote', { url: 'https://proposed.example.com/mcp', enabled: false }, basis),
    (error) => error === tracked.error(),
  );
  const authoritative = await diskConfig(root);
  assert.equal((authoritative.mcpServers.remote as { url: string }).url, 'https://latest.example.com/mcp');
  assert.deepEqual(ipc.synced, [authoritative]);
  assert.equal(ipc.emitted.length, 1);
  assert.deepEqual(ipc.retired, ['remote']);
  assert.equal(tracked.calls(), 1);
  assert.equal(tracked.applied(), 1);
});

for (const phase of ['read', 'sync', 'emit'] as const) {
  test(`MCP published write explicitly reports out-of-sync when reconciliation ${phase} fails`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const { root, store } = await fixtureStore(t);
    failDirectorySync(t, root);
    const tracked = trackTransform(t, store);
    const reconciliationError = new Error(`injected ${phase} failure`);
    const ipc = mutationHarness(t, store);
    if (phase === 'read') {
      t.mock.method(store, 'get', async () => { throw reconciliationError; });
    } else if (phase === 'sync') {
      t.mock.method(ipc.deps.manager, 'sync', async () => { throw reconciliationError; });
    } else {
      t.mock.method(ipc.deps, 'emitChanged', () => { throw reconciliationError; });
    }
    await assert.rejects(ipc.invoke('mcp:add', 'fixture', { command: 'node', enabled: false }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /out of sync/u);
      assert.equal(error.cause, tracked.error());
      assert.deepEqual(error.errors, [tracked.error(), reconciliationError]);
      assert.equal(mcpConfigFailureMessage(error, getMcpCopy('en')), getMcpCopy('en').errors.writeOutOfSync);
      return true;
    });
    assert.ok((await diskConfig(root)).mcpServers.fixture);
    assert.equal(tracked.calls(), 1);
    assert.equal(tracked.applied(), 1);
  });
}

test('MCP pre-publication failure does not reconcile or retry the failed mutation', async (t) => {
  const { root, store } = await fixtureStore(t);
  const error = new Error('injected transform failure');
  const transform = t.mock.method(store, 'transform', async () => { throw error; });
  const get = t.mock.method(store, 'get');
  const ipc = mutationHarness(t, store);
  await assert.rejects(ipc.invoke('mcp:add', 'fixture', { command: 'node' }), (caught) => caught === error);
  assert.equal(transform.mock.callCount(), 1);
  assert.equal(get.mock.callCount(), 0);
  assert.deepEqual(await diskConfig(root), { version: MCP_CONFIG_VERSION, mcpServers: {} });
  assert.deepEqual(ipc.synced, []);
  assert.deepEqual(ipc.emitted, []);
});

async function fixtureStore(t: TestContext): Promise<{ root: string; store: McpConfigStore }> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-ipc-commit-unknown-'));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const store = createMcpConfigStore(root);
  await store.get();
  return { root, store };
}

function failDirectorySync(t: TestContext, root: string, beforeFailure?: () => Promise<void>) {
  const error = Object.assign(new Error('injected post-rename directory sync failure'), { code: 'EIO' });
  const open = fs.open;
  let calls = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] === root && args[1] === 'r' && calls === 0) {
      t.mock.method(handle, 'sync', async () => {
        calls += 1;
        await beforeFailure?.();
        throw error;
      }, { times: 1 });
    }
    return handle;
  });
  syncBuiltinESMExports();
  return { error, calls: () => calls };
}

function trackTransform(t: TestContext, store: McpConfigStore, afterFailure?: () => Promise<void>) {
  const transform = store.transform.bind(store);
  let error: unknown;
  let applied = 0;
  const tracked = t.mock.method(store, 'transform', async (apply: Parameters<McpConfigStore['transform']>[0]) => {
    try {
      return await transform((current) => {
        applied += 1;
        return apply(current);
      });
    } catch (caught) {
      error = caught;
      await afterFailure?.();
      throw caught;
    }
  });
  return { error: () => error, calls: () => tracked.mock.callCount(), applied: () => applied };
}

async function diskConfig(root: string): Promise<McpConfigFile> {
  return JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8'));
}

function mutationHarness(t: TestContext, store: McpConfigStore, overrides: Partial<McpIpcMainDeps> = {}) {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const synced: McpConfigFile[] = [];
  const emitted: McpServerStatus[][] = [];
  const retired: string[] = [];
  const publicationErrors: unknown[] = [];
  const deps: McpIpcMainDeps = {
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store,
    manager: {
      forgetServerCredentials: async (serverId) => { retired.push(serverId); },
      sync: async (next) => { synced.push(structuredClone(next)); },
      statuses: () => [],
      test: async () => { throw new Error('not used'); },
    },
    oauth: {
      isActive: () => false,
      cancelLogin: () => false,
      login: async () => { throw new Error('not used'); },
      logout: async () => { throw new Error('not used'); },
      resumeLogin: async () => undefined,
    },
    ensureReady: async () => {},
    publishCapabilities: async () => {},
    onPublicationError: (error) => { publicationErrors.push(error); },
    emitChanged: (statuses) => { emitted.push(statuses); },
    ...overrides,
  };
  // These cases are about this process's own writes, not following others'.
  t.mock.method(store, 'subscribeChanges', () => () => {});
  registerMcpIpcMain(deps);
  return {
    deps, synced, emitted, retired, publicationErrors,
    invoke(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      assert.ok(handler);
      return handler({}, ...args);
    },
  };
}

test('MCP IPC transports corrupt-file details for reads and every mutation without exposing parser secrets', async (t) => {
  const { root, store } = await fixtureStore(t);
  const path = join(root, 'mcp.json');
  const source = 'sk-live-SECRET';
  assert.throws(() => JSON.parse(source), (error) => {
    assert.ok(error instanceof SyntaxError && error.message.includes(source));
    return true;
  });
  await writeFile(path, source);
  const ipc = mutationHarness(t, store);
  const calls: [string, ...unknown[]][] = [
    ['mcp:getConfig'],
    ['mcp:importConfig', '{"new":{"command":"unused"}}'],
    ['mcp:add', 'new', { command: 'unused' }],
    ['mcp:update', 'old', { command: 'unused' }, { command: 'old' }],
    ['mcp:setEnabled', 'old', true],
    ['mcp:remove', 'old'],
  ];
  for (const [channel, ...args] of calls) {
    // Electron serializes the fulfilled value, not custom Error fields.
    const result: unknown = structuredClone(await ipc.invoke(channel, ...args));
    assert.deepEqual(result, { kind: 'invalid-mcp-config-file', path });
    assert.equal(JSON.stringify(result).includes(source), false);
    for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
      const copy = getMcpCopy(locale);
      assert.throws(() => unwrapMcpIpcResult(result), (error) => {
        const wrapped = new Error('Runtime Host action failed', { cause: error });
        assert.equal(mcpConfigFailureMessage(wrapped, copy), copy.errors.invalidConfigFile(path));
        return true;
      });
    }
    assert.equal(await readFile(path, 'utf8'), source);
  }
  assert.deepEqual(await ipc.invoke('mcp:importConfig', source), {
    status: 'invalid', reason: 'invalid-json',
  }, 'pasted invalid JSON remains an import validation result');
  assert.deepEqual(ipc.synced, []);
  assert.deepEqual(ipc.retired, []);
  assert.deepEqual(ipc.emitted, []);
});
