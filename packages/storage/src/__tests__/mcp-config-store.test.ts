import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { MCP_CONFIG_VERSION, resolveMcpRemoteProtocolPreference } from '@maka/core/mcp';
import { createMcpConfigStore, normalizeMcpConfig } from '../mcp-config-store.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

test('creates and atomically updates a Claude-compatible mcp.json', async () => {
  const root = await tempRoot();
  const store = createMcpConfigStore(root);
  assert.deepEqual(await store.get(), { version: 2, mcpServers: {} });
  const next = await store.upsert('filesystem', {
    command: 'npx',
    args: ['-y', 'server'],
    env: { TOKEN: 'secret' },
    enabled: true,
  });
  assert.equal(
    next.mcpServers.filesystem && 'command' in next.mcpServers.filesystem
      ? next.mcpServers.filesystem.command
      : undefined,
    'npx',
  );
  assert.deepEqual(JSON.parse(await readFile(join(root, 'mcp.json'), 'utf8')), next);
  if (process.platform !== 'win32')
    assert.equal((await stat(join(root, 'mcp.json'))).mode & 0o777, 0o600);
  await store.remove('filesystem');
  assert.deepEqual((await store.get()).mcpServers, {});
});

test('reads version 1 without rewriting and persists version 2 on the next mutation', async () => {
  const root = await tempRoot();
  const path = join(root, 'mcp.json');
  const legacyText = `${JSON.stringify(
    {
      version: 1,
      mcpServers: {
        remote: { enabled: false, url: 'https://example.com/mcp' },
      },
    },
    null,
    2,
  )}\n`;
  await writeFile(path, legacyText, 'utf8');

  const store = createMcpConfigStore(root);
  const migrated = await store.get();
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.mcpServers.remote, {
    enabled: false,
    url: 'https://example.com/mcp',
    transport: 'auto',
  });
  assert.equal(await readFile(path, 'utf8'), legacyText);

  await store.upsert('local', { command: 'node' });
  const persisted = JSON.parse(await readFile(path, 'utf8')) as {
    version: number;
    mcpServers: Record<string, Record<string, unknown>>;
  };
  assert.equal(persisted.version, 2);
  assert.equal(Object.hasOwn(persisted.mcpServers.remote, 'protocol'), false);
});

test('reads a missing wrapper version as version 1 without rewriting it', async () => {
  const root = await tempRoot();
  const path = join(root, 'mcp.json');
  const legacyText = '{"mcpServers":{"remote":{"url":"https://example.com/mcp"}}}\n';
  await writeFile(path, legacyText, 'utf8');

  const migrated = await createMcpConfigStore(root).get();
  const remote = migrated.mcpServers.remote;
  assert.ok(remote && 'url' in remote);
  assert.equal(migrated.version, 2);
  assert.equal(Object.hasOwn(remote, 'protocol'), false);
  assert.equal(resolveMcpRemoteProtocolPreference(remote), 'legacy');
  assert.equal(await readFile(path, 'utf8'), legacyText);
});

test('round-trips every version 2 remote protocol preference', () => {
  for (const protocol of ['legacy', 'auto', '2026-07-28'] as const) {
    const normalized = normalizeMcpConfig({
      version: 2,
      mcpServers: {
        remote: {
          url: 'https://example.com/mcp',
          transport: 'streamable-http',
          protocol,
        },
      },
    });
    assert.deepEqual(normalized.mcpServers.remote, {
      enabled: true,
      url: 'https://example.com/mcp',
      transport: 'streamable-http',
      protocol,
    });
  }
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 2,
        mcpServers: {
          remote: { url: 'https://example.com/mcp', protocol: 'future' },
        },
      }),
    /remote\.protocol is invalid/u,
  );
});

test('rejects protocol fields under missing or version 1 wrappers', () => {
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 1,
        mcpServers: {
          remote: { url: 'https://example.com/mcp', protocol: 'legacy' },
        },
      }),
    /version 1 must not contain "protocol"/u,
  );
  assert.throws(
    () =>
      normalizeMcpConfig({
        mcpServers: {
          remote: { url: 'https://example.com/mcp', protocol: undefined },
        },
      }),
    /without a version must not contain "protocol"/u,
  );
});

test('rejects protocol on version 2 stdio servers', () => {
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 2,
        mcpServers: { local: { command: 'node', protocol: 'legacy' } },
      }),
    /protocol is not supported for stdio in version 2/u,
  );
});

test('allows SSE only with an omitted or explicit legacy protocol', () => {
  for (const config of [
    { url: 'https://example.com/sse', transport: 'sse' },
    { url: 'https://example.com/sse', transport: 'sse', protocol: 'legacy' },
  ] as const) {
    assert.doesNotThrow(() => normalizeMcpConfig({ version: 2, mcpServers: { remote: config } }));
  }
  for (const protocol of ['auto', '2026-07-28'] as const) {
    assert.throws(
      () =>
        normalizeMcpConfig({
          version: 2,
          mcpServers: {
            remote: {
              url: 'https://example.com/sse',
              transport: 'sse',
              protocol,
            },
          },
        }),
      /transport "sse" requires protocol "legacy"/u,
    );
  }
});

test('serializes concurrent updates without corrupting the file', async () => {
  const root = await tempRoot();
  const store = createMcpConfigStore(root);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.upsert(`s-${index}`, { command: `cmd-${index}` }),
    ),
  );
  const saved = await store.get();
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(saved.mcpServers).map(([id, server]) => [
        id,
        'command' in server ? server.command : undefined,
      ]),
    ),
    Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`s-${index}`, `cmd-${index}`])),
  );
  const text = await readFile(join(root, 'mcp.json'), 'utf8');
  assert.deepEqual(JSON.parse(text), saved);
});

test('rejects corrupt files and unsafe or invalid configs', async () => {
  const root = await tempRoot();
  await writeFile(join(root, 'mcp.json'), '{bad', 'utf8');
  await assert.rejects(createMcpConfigStore(root).get(), /JSON/u);
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 2,
        mcpServers: { constructor: { command: 'x' } },
      }),
    /Invalid server id/u,
  );
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 2,
        mcpServers: { bad: { url: 'file:///tmp/x' } },
      }),
    /http or https/u,
  );
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 2,
        mcpServers: { bad: { url: 'https://user:secret@example.com/mcp' } },
      }),
    /embedded credentials/u,
  );
  assert.throws(() => normalizeMcpConfig({ version: 3, mcpServers: {} }), /Unsupported/u);
});

test('leaves a higher-version file untouched when it is rejected', async () => {
  const root = await tempRoot();
  const path = join(root, 'mcp.json');
  const futureText = '{"version":3,"mcpServers":{}}\n';
  await writeFile(path, futureText, 'utf8');

  const store = createMcpConfigStore(root);
  await assert.rejects(store.get(), /Unsupported MCP config version: 3/u);
  await assert.rejects(
    store.set({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
    /Unsupported MCP config version: 3/u,
  );
  assert.equal(await readFile(path, 'utf8'), futureText);
});

test('full replacement preserves future wrappers but can repair malformed current data', async () => {
  const root = await tempRoot();
  const path = join(root, 'mcp.json');
  const store = createMcpConfigStore(root);

  for (const futureText of [
    '{"version":"future","mcpServers":{}}\n',
    '{"version":0,"mcpServers":{}}\n',
  ]) {
    await writeFile(path, futureText, 'utf8');
    await assert.rejects(
      store.set({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
      /Unsupported MCP config version/u,
    );
    assert.equal(await readFile(path, 'utf8'), futureText);
  }

  await writeFile(path, '{malformed', 'utf8');
  await store.set({
    version: MCP_CONFIG_VERSION,
    mcpServers: { repaired: { command: 'node' } },
  });
  assert.deepEqual(await store.get(), {
    version: MCP_CONFIG_VERSION,
    mcpServers: { repaired: { enabled: true, command: 'node' } },
  });
});

test('full replacement can migrate an existing version 1 wrapper to version 2', async () => {
  const root = await tempRoot();
  const path = join(root, 'mcp.json');
  await writeFile(path, '{"version":1,"mcpServers":{"old":{"command":"node"}}}\n', 'utf8');

  const store = createMcpConfigStore(root);
  await store.set({
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: 'https://example.com/mcp', protocol: 'auto' } },
  });

  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    version: MCP_CONFIG_VERSION,
    mcpServers: {
      remote: {
        enabled: true,
        url: 'https://example.com/mcp',
        transport: 'auto',
        protocol: 'auto',
      },
    },
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-mcp-store-'));
  roots.push(root);
  return root;
}
