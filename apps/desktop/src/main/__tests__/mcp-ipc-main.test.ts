import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_CONFIG_VERSION, type McpConfigFile, type McpServerStatus } from '@maka/core/mcp';
import { registerMcpIpcMain } from '../mcp-ipc-main.js';

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
      sync: async () => { calls.push('sync'); },
      statuses: () => [connected],
      test: async () => ({ ok: true, status: connected, latencyMs: 1 }),
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
  assert.deepEqual(calls, ['store', 'sync', 'emit', 'publish']);

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
  assert.deepEqual(calls, ['cancel', 'sync', 'emit', 'publish']);
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
      sync: async () => { calls.push('sync'); },
      statuses: () => [],
      test: async () => { throw new Error('not used'); },
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

  const installing = install({}, 'fixture', { command: 'node' });
  await writeStarted;
  const cancelling = cancelInstall({}, 'fixture');
  releaseWrite();

  const [, cancelled] = await Promise.all([installing, cancelling]);
  assert.equal(cancelled.mcpServers.fixture, undefined);
  assert.equal(config.mcpServers.fixture, undefined);
  assert.deepEqual(calls, ['write:start', 'cancel', 'write:end', 'remove', 'sync', 'emit', 'publish']);
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
        config = {
          version: MCP_CONFIG_VERSION,
          mcpServers: { ...config.mcpServers, [serverId]: server },
        };
        return config;
      },
      remove: async () => config,
    },
    manager: {
      cancelConnect: () => false,
      sync: async () => {},
      statuses: () => [],
      test: async () => { throw new Error('not used'); },
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
      remove: async (serverId) => {
        const { [serverId]: _removed, ...mcpServers } = config.mcpServers;
        config = { version: MCP_CONFIG_VERSION, mcpServers };
        return config;
      },
    },
    manager: {
      cancelConnect: () => false,
      sync: async (next) => {
        synced.push(next);
      },
      statuses: () => [],
      test: async () => {
        throw new Error('not used');
      },
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
  assert.equal(synced.at(-1)?.mcpServers.notion, stored);
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
