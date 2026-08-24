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
import { test } from 'node:test';
import { MCP_CONFIG_VERSION, type McpConfigFile, type McpServerStatus } from '@maka/core/mcp';
import { McpServerExistsError } from '@maka/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpConfigStore } from '@maka/storage';
import { createMcpExclusiveLane, registerMcpIpcMain } from '../mcp-ipc-main.js';

test('MCP IPC commits config before publishing capabilities and emitting status', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = { version: MCP_CONFIG_VERSION, mcpServers: {} };
  const calls: string[] = [];
  const connected: McpServerStatus = {
    serverId: 'fixture', state: 'connected', transport: 'stdio', toolCount: 1,
    tools: [{ serverId: 'fixture', name: 'echo', inputSchema: { type: 'object' } }], updatedAt: 1,
  };
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      transform: async (apply) => {
        calls.push('store');
        config = apply(config);
        return config;
      },
      set: async (next) => { calls.push('store'); config = next; return next; },
      upsert: async (serverId, server) => {
        calls.push('store');
        config = { version: MCP_CONFIG_VERSION, mcpServers: { ...config.mcpServers, [serverId]: server } };
        return config;
      },
      remove: async (serverId) => {
        const { [serverId]: _removed, ...mcpServers } = config.mcpServers;
        config = { version: MCP_CONFIG_VERSION, mcpServers };
        return config;
      },
    },
    manager: {
      cancelConnect: () => { calls.push('cancel'); return true; },
      forgetServerCredentials: async () => { calls.push('forget'); },
      sync: async () => { calls.push('sync'); },
      statuses: () => [connected],
      test: async () => ({ ok: true, status: connected, latencyMs: 1 }),
    },
    oauth: {
      isActive: () => false,
      cancelLogin: () => false,
      login: async () => connected,
      logout: async () => connected,
      resumeLogin: async () => undefined,
    },
    ensureReady: async () => { calls.push('ready'); },
    publishCapabilities: async () => { calls.push('publish'); },
    onPublicationError: () => { calls.push('publication:error'); },
    emitChanged: () => { calls.push('emit'); },
  });

  const upsert = handlers.get('mcp:upsert');
  assert.ok(upsert);
  const result = await upsert({}, 'fixture', { command: 'node' });
  assert.deepEqual(result.mcpServers.fixture, { command: 'node' });
  assert.deepEqual(calls, ['store', 'sync', 'emit', 'publish']);

  calls.length = 0;
  const setConfig = handlers.get('mcp:setConfig');
  assert.ok(setConfig);
  const imported = await setConfig({}, {
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: 'https://example.com/mcp', enabled: false } },
  });
  assert.deepEqual(imported.mcpServers, {
    remote: { url: 'https://example.com/mcp', enabled: false },
  });
  // The bulk edit removed `fixture`: its credentials retire BEFORE the
  // config write, so a restart in between cannot orphan them.
  assert.deepEqual(calls, ['forget', 'store', 'sync', 'emit', 'publish']);

  calls.length = 0;
  const add = handlers.get('mcp:add');
  assert.ok(add);
  const added = await add({}, 'brave', { command: 'npx' });
  assert.equal(added.status, 'added');
  assert.deepEqual(added.config.mcpServers.brave, { command: 'npx' });
  assert.deepEqual(calls, ['store', 'sync', 'emit', 'publish']);
  // A taken id comes back as data, not an IPC error, and commits nothing —
  // the existence check now fails before the transaction ever reaches the
  // credential-erase or write steps.
  calls.length = 0;
  assert.deepEqual(await add({}, 'brave', { command: 'other' }), { status: 'exists' });
  assert.deepEqual(calls, []);

  calls.length = 0;
  const testHandler = handlers.get('mcp:test');
  assert.ok(testHandler);
  assert.equal((await testHandler({}, 'fixture')).ok, true);
  assert.deepEqual(calls, ['ready', 'emit']);

  calls.length = 0;
  config = { version: MCP_CONFIG_VERSION, mcpServers: { fixture: { command: 'node' } } };
  const cancelInstall = handlers.get('mcp:cancelInstall');
  assert.ok(cancelInstall);
  const cancelled = await cancelInstall({}, 'fixture');
  assert.equal(cancelled.mcpServers.fixture, undefined);
  assert.deepEqual(calls, ['cancel', 'forget', 'store', 'sync', 'emit', 'publish']);
});

test('MCP remove aborts before touching the config when credential deletion fails', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = { version: MCP_CONFIG_VERSION, mcpServers: { fixture: { command: 'node' } } };
  let removed = false;
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      transform: async (apply) => {
        config = apply(config);
        return config;
      },
      set: async (next) => { config = next; return next; },
      upsert: async (serverId, server) => {
        config = { version: MCP_CONFIG_VERSION, mcpServers: { ...config.mcpServers, [serverId]: server } };
        return config;
      },
      remove: async (serverId) => {
        removed = true;
        const { [serverId]: _gone, ...mcpServers } = config.mcpServers;
        config = { version: MCP_CONFIG_VERSION, mcpServers };
        return config;
      },
    },
    manager: {
      cancelConnect: () => false,
      forgetServerCredentials: async () => { throw new Error('credential store unavailable'); },
      sync: async () => {},
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
    onPublicationError: () => {},
    emitChanged: () => {},
  });

  const remove = handlers.get('mcp:remove');
  assert.ok(remove);
  await assert.rejects(remove({}, 'fixture'), /credential store unavailable/u);
  // The config was never touched: the server stays configured and the
  // removal is retryable — no orphaned token for a same-id re-add.
  assert.equal(removed, false);
  assert.ok(config.mcpServers.fixture);
});

test('MCP IPC redacts clientSecret toward the renderer and restores the sentinel from disk', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      notion: {
        url: 'https://mcp.notion.com/mcp',
        oauth: { clientId: 'abc', clientSecret: 'real-secret' },
      },
      scratch: {
        command: 'npx',
        // An arbitrary flag name hiding a pattern-recognized token: the
        // value marks it as a secret, not the name.
        args: ['server', '--custom=sk-ant-api03-abcdef123456'],
        env: { API_TOKEN: 'scratch-token' },
      },
    },
  };
  const synced: McpConfigFile[] = [];
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      transform: async (apply) => {
        config = apply(config);
        return config;
      },
      set: async (next) => { config = next; return next; },
      upsert: async (serverId, server) => {
        config = { version: MCP_CONFIG_VERSION, mcpServers: { ...config.mcpServers, [serverId]: server } };
        return config;
      },
      remove: async (serverId) => {
        const { [serverId]: _removed, ...mcpServers } = config.mcpServers;
        config = { version: MCP_CONFIG_VERSION, mcpServers };
        return config;
      },
    },
    manager: {
      cancelConnect: () => false,
      forgetServerCredentials: async () => {},
      sync: async (next) => { synced.push(next); },
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
    onPublicationError: () => {},
    emitChanged: () => {},
  });

  const getConfig = handlers.get('mcp:getConfig');
  assert.ok(getConfig);
  const seen = await getConfig({});
  const notion = seen.mcpServers.notion;
  assert.ok(notion && 'url' in notion);
  assert.notEqual(notion.oauth?.clientSecret, 'real-secret');
  assert.ok(notion.oauth?.clientSecret);
  const seenScratch = seen.mcpServers.scratch;
  assert.ok(seenScratch && 'command' in seenScratch);
  assert.ok(!seenScratch.args?.some((arg: string) => arg.includes('sk-ant-api03-abcdef123456')));

  // The renderer round-trips the masked arg unchanged; the store gets the
  // real token back from disk.
  const upsertScratch = handlers.get('mcp:upsert');
  assert.ok(upsertScratch);
  await upsertScratch({}, 'scratch', { ...seenScratch, enabled: false });
  const storedScratch = config.mcpServers.scratch;
  assert.ok(storedScratch && 'command' in storedScratch);
  assert.deepEqual(storedScratch.args, ['server', '--custom=sk-ant-api03-abcdef123456']);

  // The renderer edits the redacted config and sends the sentinel back:
  // the store must get the real secret, the renderer only the sentinel.
  const upsert = handlers.get('mcp:upsert');
  assert.ok(upsert);
  const returned = await upsert({}, 'notion', { ...notion, transport: 'sse' });
  const stored = config.mcpServers.notion;
  assert.ok(stored && 'url' in stored);
  assert.equal(stored.oauth?.clientSecret, 'real-secret');
  const syncedNotion = synced.at(-1)?.mcpServers.notion;
  assert.ok(syncedNotion && 'url' in syncedNotion);
  assert.equal(syncedNotion.oauth?.clientSecret, 'real-secret');
  const echoed = returned.mcpServers.notion;
  assert.ok(echoed && 'url' in echoed);
  assert.notEqual(echoed.oauth?.clientSecret, 'real-secret');

  // Removing or cancelling an unrelated server also returns a full config
  // crossing toward the renderer — the survivors' secrets stay sentinels.
  const remove = handlers.get('mcp:remove');
  assert.ok(remove);
  const afterRemove = await remove({}, 'scratch');
  const survivorAfterRemove = afterRemove.mcpServers.notion;
  assert.ok(survivorAfterRemove && 'url' in survivorAfterRemove);
  assert.ok(survivorAfterRemove.oauth?.clientSecret);
  assert.notEqual(survivorAfterRemove.oauth?.clientSecret, 'real-secret');

  config = {
    version: MCP_CONFIG_VERSION,
    mcpServers: { ...config.mcpServers, doomed: { command: 'npx' } },
  };
  const cancelInstall = handlers.get('mcp:cancelInstall');
  assert.ok(cancelInstall);
  const afterCancel = await cancelInstall({}, 'doomed');
  assert.equal(afterCancel.mcpServers.doomed, undefined);
  const survivorAfterCancel = afterCancel.mcpServers.notion;
  assert.ok(survivorAfterCancel && 'url' in survivorAfterCancel);
  assert.ok(survivorAfterCancel.oauth?.clientSecret);
  assert.notEqual(survivorAfterCancel.oauth?.clientSecret, 'real-secret');
});

test('MCP market cancellation waits for an in-flight config write before rolling it back', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = { version: MCP_CONFIG_VERSION, mcpServers: {} };
  let releaseWrite!: () => void;
  let markWriteStarted!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
  const calls: string[] = [];

  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      transform: async (apply) => {
        calls.push('write:start');
        markWriteStarted();
        await writeGate;
        config = apply(config);
        calls.push('write:end');
        return config;
      },
      set: async (next) => { config = next; return next; },
      upsert: async (serverId, server) => {
        config = { version: MCP_CONFIG_VERSION, mcpServers: { ...config.mcpServers, [serverId]: server } };
        return config;
      },
      remove: async (serverId) => {
        calls.push('remove');
        const { [serverId]: _removed, ...mcpServers } = config.mcpServers;
        config = { version: MCP_CONFIG_VERSION, mcpServers };
        return config;
      },
    },
    manager: {
      cancelConnect: () => { calls.push('cancel'); return true; },
      forgetServerCredentials: async () => { calls.push('forget'); },
      sync: async () => { calls.push('sync'); },
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
    publishCapabilities: async () => { calls.push('publish'); },
    onPublicationError: () => { calls.push('publication:error'); },
    emitChanged: () => { calls.push('emit'); },
  });

  const install = handlers.get('mcp:install');
  const cancelInstall = handlers.get('mcp:cancelInstall');
  assert.ok(install);
  assert.ok(cancelInstall);

  // The fake store skips normalizeMcpConfig, so the install config is given
  // in its normal form — the real-store variant below covers the
  // normalization mismatch.
  const installing = install({}, 'fixture', { enabled: true, command: 'node' });
  await writeStarted;
  const cancelling = cancelInstall({}, 'fixture');
  releaseWrite();

  const [, cancelled] = await Promise.all([installing, cancelling]);
  assert.equal(cancelled.mcpServers.fixture, undefined);
  assert.equal(config.mcpServers.fixture, undefined);
  // The cancellation's own removal is a full transaction on the same lane:
  // credentials retire first, then the conditional write.
  assert.deepEqual(calls, [
    'write:start', 'cancel', 'write:end',
    'forget', 'write:start', 'write:end',
    'sync', 'emit', 'publish',
  ]);
});

test('an active login on a secret-bearing server does not veto edits to another server', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      notion: {
        url: 'https://mcp.notion.com/mcp',
        oauth: { clientId: 'abc', clientSecret: 'real-secret' },
      },
      other: { command: 'node' },
    },
  };
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      transform: async (apply) => { config = apply(config); return config; },
      set: async (next) => { config = next; return next; },
      upsert: async (_serverId, _server) => config,
      remove: async () => config,
    },
    manager: {
      cancelConnect: () => false,
      forgetServerCredentials: async () => {},
      sync: async () => {},
      statuses: () => [],
      test: async () => { throw new Error('not used'); },
    },
    oauth: {
      // The login owns `notion` for the whole test.
      isActive: (serverId: string) => serverId === 'notion',
      cancelLogin: () => false,
      login: async () => { throw new Error('not used'); },
      logout: async () => { throw new Error('not used'); },
      resumeLogin: async () => undefined,
    },
    ensureReady: async () => {},
    publishCapabilities: async () => {},
    onPublicationError: () => {},
    emitChanged: () => {},
  });

  const getConfig = handlers.get('mcp:getConfig');
  const setConfig = handlers.get('mcp:setConfig');
  assert.ok(getConfig);
  assert.ok(setConfig);
  // The renderer edits the REDACTED config: notion comes back carrying the
  // clientSecret sentinel. A sentinel-versus-real-value comparison would
  // call that a change; the semantic (restored) comparison must not.
  const redacted = await getConfig({});
  const next = await setConfig({}, {
    ...redacted,
    mcpServers: {
      ...redacted.mcpServers,
      other: { command: 'node', args: ['--verbose'] },
    },
  });
  const other = next.mcpServers.other;
  assert.ok(other && 'command' in other);
  assert.deepEqual(other.args, ['--verbose']);
  const storedNotion = config.mcpServers.notion;
  assert.ok(storedNotion && 'url' in storedNotion);
  assert.equal(storedNotion.oauth?.clientSecret, 'real-secret');

  // Actually touching (here: removing) the login-owned server still fails.
  const { notion: _gone, ...withoutNotion } = redacted.mcpServers;
  await assert.rejects(
    setConfig({}, { ...redacted, mcpServers: withoutNotion }),
    /login in progress/u,
  );
  assert.ok(config.mcpServers.notion);
});

test('a URL change retires the old endpoint credentials before the write, and an erase failure aborts it', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = {
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: 'https://old.example.com/mcp' } },
  };
  const calls: string[] = [];
  let eraseFails = true;
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      transform: async (apply) => { calls.push('write'); config = apply(config); return config; },
      set: async (next) => { config = next; return next; },
      upsert: async (_serverId, _server) => config,
      remove: async () => config,
    },
    manager: {
      cancelConnect: () => false,
      forgetServerCredentials: async () => {
        calls.push('forget');
        if (eraseFails) throw new Error('credential store unavailable');
      },
      sync: async () => { calls.push('sync'); },
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
    onPublicationError: () => {},
    emitChanged: () => {},
  });

  const upsert = handlers.get('mcp:upsert');
  assert.ok(upsert);
  // Erase fails → nothing persists: the old endpoint's credentials cannot
  // outlive a committed repoint across a restart.
  await assert.rejects(
    upsert({}, 'remote', { url: 'https://new.example.com/mcp' }),
    /credential store unavailable/u,
  );
  assert.deepEqual(calls, ['forget']);
  const kept = config.mcpServers.remote;
  assert.ok(kept && 'url' in kept);
  assert.equal(kept.url, 'https://old.example.com/mcp');

  // Same repoint with a healthy credential store: erase strictly precedes
  // the write. An unchanged-URL upsert afterwards does not erase at all.
  eraseFails = false;
  calls.length = 0;
  await upsert({}, 'remote', { url: 'https://new.example.com/mcp' });
  assert.deepEqual(calls, ['forget', 'write', 'sync']);
  calls.length = 0;
  await upsert({}, 'remote', { url: 'https://new.example.com/mcp', enabled: false });
  assert.deepEqual(calls, ['write', 'sync']);
});

test('cancelling an install rolls back only its own write, never a newer same-id config', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = { version: MCP_CONFIG_VERSION, mcpServers: {} };
  let releaseInstallSync!: () => void;
  const installSyncGate = new Promise<void>((resolve) => { releaseInstallSync = resolve; });
  let syncs = 0;
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      transform: async (apply) => { config = apply(config); return config; },
      set: async (next) => { config = next; return next; },
      upsert: async (_serverId, _server) => config,
      remove: async () => config,
    },
    manager: {
      cancelConnect: () => { releaseInstallSync(); return true; },
      forgetServerCredentials: async () => {},
      sync: async () => {
        syncs += 1;
        // Only the install's connect parks; later syncs pass through.
        if (syncs === 1) await installSyncGate;
      },
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
    onPublicationError: () => {},
    emitChanged: () => {},
  });

  const install = handlers.get('mcp:install');
  const upsert = handlers.get('mcp:upsert');
  const cancelInstall = handlers.get('mcp:cancelInstall');
  assert.ok(install);
  assert.ok(upsert);
  assert.ok(cancelInstall);

  // The install commits A and parks in its connect; a newer same-id config
  // B lands through upsert while it waits.
  const installing = install({}, 'x', { command: 'installed-a' });
  await new Promise((resolve) => setImmediate(resolve));
  await upsert({}, 'x', { command: 'newer-b' });

  const cancelled = await cancelInstall({}, 'x');
  await installing;

  // The cancellation found B where it committed A: it must decline the
  // rollback instead of deleting the newer server (and its credentials).
  const survivor = config.mcpServers.x;
  assert.ok(survivor && 'command' in survivor);
  assert.equal(survivor.command, 'newer-b');
  const echoed = cancelled.mcpServers.x;
  assert.ok(echoed && 'command' in echoed);
  assert.equal(echoed.command, 'newer-b');
});

test('a login claim travels the shared lane and cannot land inside an open transaction', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = {
    version: MCP_CONFIG_VERSION,
    mcpServers: { x: { url: 'https://example.com/mcp' } },
  };
  const activeLogins = new Set<string>();
  let releaseWrite!: () => void;
  let markWriteStarted!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
  const lane = createMcpExclusiveLane();
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      transform: async (apply) => {
        markWriteStarted();
        await writeGate;
        config = apply(config);
        return config;
      },
      set: async (next) => { config = next; return next; },
      upsert: async (_serverId, _server) => config,
      remove: async () => config,
    },
    manager: {
      cancelConnect: () => false,
      forgetServerCredentials: async () => {},
      sync: async () => {},
      statuses: () => [],
      test: async () => { throw new Error('not used'); },
    },
    oauth: {
      isActive: (serverId: string) => activeLogins.has(serverId),
      cancelLogin: () => false,
      login: async () => { throw new Error('not used'); },
      logout: async () => { throw new Error('not used'); },
      resumeLogin: async () => undefined,
    },
    exclusiveLane: lane,
    ensureReady: async () => {},
    publishCapabilities: async () => {},
    onPublicationError: () => {},
    emitChanged: () => {},
  });

  const upsert = handlers.get('mcp:upsert');
  assert.ok(upsert);
  // A config transaction is mid-flight (its write is parked)…
  const updating = upsert({}, 'x', { url: 'https://new.example.com/mcp' });
  await writeStarted;
  // …when a login claim arrives through the SAME lane, the way the OAuth
  // controller claims. It must queue behind the transaction, not interleave
  // between the gate check and the write.
  let claimLanded = false;
  const claiming = lane(async () => {
    activeLogins.add('x');
    claimLanded = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claimLanded, false);

  releaseWrite();
  await updating;
  await claiming;
  assert.equal(claimLanded, true);

  // With the claim landed, the next transaction's in-lane gate refuses.
  await assert.rejects(
    upsert({}, 'x', { url: 'https://third.example.com/mcp' }),
    /login in progress/u,
  );
});

test('cancelling an install through the REAL store rolls the entry back despite normalization', async () => {
  // The fake stores in this file skip normalizeMcpConfig; the real store
  // rebuilds each server (key order, defaulted enabled/transport, WHATWG
  // URL) on write. The cancellation's identity check must compare in that
  // normal form, or it mismatches its own persisted entry and silently
  // keeps the cancelled server installed.
  const root = await mkdtemp(join(tmpdir(), 'mcp-ipc-real-'));
  try {
    const store = createMcpConfigStore(root);
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    let releaseInstallSync!: () => void;
    const installSyncGate = new Promise<void>((resolve) => { releaseInstallSync = resolve; });
    let syncs = 0;
    registerMcpIpcMain({
      ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
      store,
      manager: {
        cancelConnect: () => { releaseInstallSync(); return true; },
        forgetServerCredentials: async () => {},
        sync: async () => {
          syncs += 1;
          if (syncs === 1) await installSyncGate;
        },
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
      onPublicationError: () => {},
      emitChanged: () => {},
    });

    const install = handlers.get('mcp:install');
    const cancelInstall = handlers.get('mcp:cancelInstall');
    assert.ok(install);
    assert.ok(cancelInstall);

    // No `enabled`, no `transport`: the store materializes both on write.
    const installing = install({}, 'market', { url: 'https://mcp.vercel.com' });
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = await cancelInstall({}, 'market');
    await installing;

    assert.equal(cancelled.mcpServers.market, undefined);
    assert.equal((await store.get()).mcpServers.market, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the config write fails closed when the snapshot drifts under the transaction', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const config: McpConfigFile = { version: MCP_CONFIG_VERSION, mcpServers: {} };
  const drifted: McpConfigFile = {
    version: MCP_CONFIG_VERSION,
    mcpServers: { intruder: { command: 'node' } },
  };
  let wrote = false;
  registerMcpIpcMain({
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler as (...args: any[]) => Promise<any>); } },
    store: {
      get: async () => config,
      // Simulates an out-of-band writer landing between the snapshot read
      // and the serialized write: apply() observes a different config.
      transform: async (apply) => {
        const next = apply(drifted);
        wrote = true;
        return next;
      },
      set: async (next) => next,
      upsert: async (_serverId, _server) => config,
      remove: async () => config,
    },
    manager: {
      cancelConnect: () => false,
      forgetServerCredentials: async () => {},
      sync: async () => {},
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
    onPublicationError: () => {},
    emitChanged: () => {},
  });

  const upsert = handlers.get('mcp:upsert');
  assert.ok(upsert);
  await assert.rejects(upsert({}, 'fixture', { command: 'node' }), /changed while/u);
  assert.equal(wrote, false);
});

test('MCP config commit is not rolled back by a capability publication failure', async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  let config: McpConfigFile = { version: MCP_CONFIG_VERSION, mcpServers: {} };
  const publicationErrors: unknown[] = [];
  registerMcpIpcMain({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler as (...args: any[]) => Promise<any>);
      },
    },
    store: {
      get: async () => config,
      transform: async (apply) => {
        config = apply(config);
        return config;
      },
      set: async (next) => {
        config = next;
        return next;
      },
      upsert: async (serverId, server) => {
        config = { version: MCP_CONFIG_VERSION, mcpServers: { ...config.mcpServers, [serverId]: server } };
        return config;
      },
      remove: async () => config,
    },
    manager: {
      cancelConnect: () => false,
      forgetServerCredentials: async () => {},
      sync: async () => {},
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
    publishCapabilities: async () => {
      throw new Error('Host disconnected');
    },
    onPublicationError: (error) => publicationErrors.push(error),
    emitChanged() {},
  });

  const upsert = handlers.get('mcp:upsert');
  assert.ok(upsert);
  const committed = await upsert({}, 'fixture', { command: 'node' });
  assert.deepEqual(committed.mcpServers.fixture, { command: 'node' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(publicationErrors.map((error) => (error as Error).message), [
    'Host disconnected',
  ]);
});
