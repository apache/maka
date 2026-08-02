import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createMcpConfigStore, normalizeMcpConfig } from '../mcp-config-store.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

test('creates and atomically updates a Claude-compatible mcp.json', async () => {
  const root = await tempRoot();
  const store = createMcpConfigStore(root);
  assert.deepEqual(await store.get(), { version: 1, mcpServers: {} });
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
    () => normalizeMcpConfig({ version: 1, mcpServers: { constructor: { command: 'x' } } }),
    /Invalid server id/u,
  );
  assert.throws(
    () => normalizeMcpConfig({ version: 1, mcpServers: { bad: { url: 'file:///tmp/x' } } }),
    /http or https/u,
  );
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 1,
        mcpServers: { bad: { url: 'https://user:secret@example.com/mcp' } },
      }),
    /embedded credentials/u,
  );
  assert.throws(() => normalizeMcpConfig({ version: 2, mcpServers: {} }), /Unsupported/u);
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-mcp-store-'));
  roots.push(root);
  return root;
}
