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
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { MCP_CONFIG_VERSION, resolveMcpProtocolPreference } from '@maka/core/mcp';
import {
  createMcpConfigStore,
  normalizeMcpConfig,
  normalizeMcpImport,
} from '../mcp-config-store.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

test('creates and atomically updates a Claude-compatible mcp.json', async () => {
  const root = await tempRoot();
  const store = createMcpConfigStore(root);
  assert.deepEqual(await store.get(), { version: MCP_CONFIG_VERSION, mcpServers: {} });
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

test('reads version 1 without rewriting and persists version 3 on the next mutation', async () => {
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
  assert.equal(migrated.version, MCP_CONFIG_VERSION);
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
  assert.equal(persisted.version, MCP_CONFIG_VERSION);
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
  assert.equal(migrated.version, MCP_CONFIG_VERSION);
  assert.equal(Object.hasOwn(remote, 'protocol'), false);
  assert.equal(resolveMcpProtocolPreference(remote), 'legacy');
  assert.equal(await readFile(path, 'utf8'), legacyText);
});

test('reads version 2 remote pins without rewriting and projects them as version 3', async () => {
  const root = await tempRoot();
  const path = join(root, 'mcp.json');
  const versionTwo =
    '{"version":2,"mcpServers":{"local":{"command":"node"},"remote":{"url":"https://example.com/mcp","protocol":"2026-07-28"}}}\n';
  await writeFile(path, versionTwo, 'utf8');

  const migrated = await createMcpConfigStore(root).get();
  assert.equal(migrated.version, MCP_CONFIG_VERSION);
  assert.equal(resolveMcpProtocolPreference(migrated.mcpServers.local!), 'legacy');
  assert.equal(resolveMcpProtocolPreference(migrated.mcpServers.remote!), '2026-07-28');
  assert.equal(await readFile(path, 'utf8'), versionTwo);
});

test('round-trips every version 3 protocol preference for remote and stdio', () => {
  for (const protocol of ['legacy', 'auto', '2026-07-28'] as const) {
    const normalized = normalizeMcpConfig({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        local: { command: 'node', protocol },
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
    assert.deepEqual(normalized.mcpServers.local, {
      enabled: true,
      command: 'node',
      protocol,
    });
  }
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: MCP_CONFIG_VERSION,
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

test('transform sees the latest committed config, not a caller snapshot', async () => {
  // The restore-plus-mutation seam: a marker-bearing write that derived its
  // restores from a stale snapshot could roll a rotated secret back. Inside
  // transform, apply() must observe the concurrent writer's commit under the
  // shared file transaction.
  const root = await tempRoot();
  const store = createMcpConfigStore(root);
  await store.upsert('local', { command: 'npx', env: { TOKEN: 'v1' } });
  const rotate = store.upsert('local', { command: 'npx', env: { TOKEN: 'v2-rotated' } });
  const observed: string[] = [];
  const restoreLike = store.transform((current) => {
    const server = current.mcpServers.local;
    if (server && 'command' in server && server.env) observed.push(server.env.TOKEN ?? '');
    return current;
  });
  await Promise.all([rotate, restoreLike]);
  assert.deepEqual(observed, ['v2-rotated']);
  const final = (await store.get()).mcpServers.local;
  assert.ok(final && 'command' in final);
  assert.equal(final.env?.TOKEN, 'v2-rotated');
});

test('two independent stores preserve concurrent additions to one workspace', async () => {
  const root = await tempRoot();
  await createMcpConfigStore(root).get();
  const desktop = createMcpConfigStore(root);
  const tui = createMcpConfigStore(root);

  await Promise.all([
    desktop.upsert('desktop', { command: 'desktop-server' }),
    tui.upsert('tui', { command: 'tui-server' }),
  ]);

  const saved = await createMcpConfigStore(root).get();
  assert.equal(
    saved.mcpServers.desktop && 'command' in saved.mcpServers.desktop
      ? saved.mcpServers.desktop.command
      : undefined,
    'desktop-server',
  );
  assert.equal(
    saved.mcpServers.tui && 'command' in saved.mcpServers.tui
      ? saved.mcpServers.tui.command
      : undefined,
    'tui-server',
  );
});

test('a new store commits after a killed MCP config writer releases its native lock', async (t) => {
  const root = await tempRoot();
  const holder = fork(new URL('./fixtures/mcp-config-lock-holder.js', import.meta.url), [root], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  t.after(() => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    holder.once('message', (message) => {
      if (message === 'locked') resolve();
      else reject(new Error(`Unexpected child message: ${String(message)}`));
    });
    holder.once('error', reject);
    holder.once('exit', (code, signal) => {
      reject(new Error(`MCP config lock holder exited early (${String(code)}, ${signal})`));
    });
  });

  holder.kill('SIGKILL');
  await new Promise<void>((resolve) => holder.once('exit', () => resolve()));

  const saved = await createMcpConfigStore(root).upsert('recovered', {
    command: 'recovered-server',
  });
  const recovered = saved.mcpServers.recovered;
  assert.ok(recovered && 'command' in recovered);
  assert.equal(recovered.command, 'recovered-server');
  const reopened = (await createMcpConfigStore(root).get()).mcpServers.recovered;
  assert.ok(reopened && 'command' in reopened);
  assert.equal(reopened.command, 'recovered-server');
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
  await assert.rejects(
    createMcpConfigStore(await tempRoot()).upsert('bad', {
      url: 'https://user:secret@example.com/mcp',
    }),
    /embedded credentials/u,
  );
  assert.throws(() => normalizeMcpConfig({ version: 4, mcpServers: {} }), /Unsupported/u);
});

test('leaves a higher-version file untouched when it is rejected', async () => {
  const root = await tempRoot();
  const path = join(root, 'mcp.json');
  const futureText = '{"version":4,"mcpServers":{}}\n';
  await writeFile(path, futureText, 'utf8');

  const store = createMcpConfigStore(root);
  await assert.rejects(store.get(), /Unsupported MCP config version: 4/u);
  await assert.rejects(
    store.upsert('local', { command: 'node' }),
    /Unsupported MCP config version: 4/u,
  );
  assert.equal(await readFile(path, 'utf8'), futureText);
});

test('normalizes wrapped imports and direct maps without losing source-version rules', () => {
  assert.deepEqual(
    normalizeMcpImport(
      '{"version":2,"mcpServers":{"remote":{"url":"https://example.com/mcp","protocol":"auto"}}}',
    ),
    {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: {
          enabled: true,
          url: 'https://example.com/mcp',
          transport: 'auto',
          protocol: 'auto',
        },
      },
    },
  );
  assert.deepEqual(normalizeMcpImport('{"version":{"command":"node"}}'), {
    version: MCP_CONFIG_VERSION,
    mcpServers: { version: { enabled: true, command: 'node' } },
  });
  assert.deepEqual(normalizeMcpImport('{"mcpServers":{"command":"node"}}'), {
    version: MCP_CONFIG_VERSION,
    mcpServers: { mcpServers: { enabled: true, command: 'node' } },
  });
});

test('import rejects malformed wrappers and protocol fields from older eras', () => {
  assert.throws(() => normalizeMcpImport('{bad'), { reason: 'invalid-json' });
  assert.throws(() => normalizeMcpImport('[]'), { reason: 'not-object' });
  assert.throws(() => normalizeMcpImport('{"version":3}'), { reason: 'missing-servers' });
  assert.throws(() => normalizeMcpImport('{"version":4,"mcpServers":{}}'), {
    reason: 'unsupported-version',
    version: '4',
  });
  for (const source of [
    '{"remote":{"url":"https://example.com/mcp","protocol":"auto"}}',
    '{"version":1,"mcpServers":{"remote":{"url":"https://example.com/mcp","protocol":"auto"}}}',
    '{"version":2,"mcpServers":{"local":{"command":"node","protocol":"auto"}}}',
  ]) {
    assert.throws(() => normalizeMcpImport(source), { reason: 'protocol-version' });
  }
});

test('refuses cleartext http for non-loopback hosts at the write boundary', async () => {
  const store = createMcpConfigStore(await tempRoot());
  await assert.rejects(
    store.upsert('bad', { url: 'http://example.com/mcp' }),
    /https for non-loopback/u,
  );
  for (const url of [
    'http://127.0.0.1:8080/mcp',
    'http://localhost:3000/mcp',
    'https://example.com/mcp',
  ]) {
    await assert.doesNotReject(store.upsert('ok', { url }));
  }
});

test('grandfathers a pre-existing cleartext server on read and keeps the file repairable', async () => {
  // A single entry every prior release accepted must not brick the whole
  // file: the page would come up empty and even the remove that could fix
  // it would take the same throwing path.
  const root = await tempRoot();
  const path = join(root, 'mcp.json');
  await writeFile(
    path,
    `${JSON.stringify({
      version: 2,
      mcpServers: {
        internal: { url: 'http://mcp.internal.corp/mcp', transport: 'auto' },
        good: { command: 'npx' },
      },
    })}\n`,
    'utf8',
  );
  const store = createMcpConfigStore(root);

  const loaded = await store.get();
  assert.ok(loaded.mcpServers.internal);
  assert.ok(loaded.mcpServers.good);

  // Repair paths stay open: removing either server works, and toggling the
  // grandfathered entry (same URL) works.
  await assert.doesNotReject(store.remove('good'));
  await assert.doesNotReject(
    store.upsert('internal', { url: 'http://mcp.internal.corp/mcp', enabled: false }),
  );
  // Introducing or repointing a cleartext endpoint still refuses.
  await assert.rejects(
    store.upsert('internal', { url: 'http://other.internal.corp/mcp' }),
    /https for non-loopback/u,
  );
  await assert.rejects(
    store.upsert('fresh', { url: 'http://example.com/mcp' }),
    /https for non-loopback/u,
  );
  await assert.doesNotReject(store.remove('internal'));
  assert.deepEqual((await store.get()).mcpServers, {});
});

test('normalizes and bounds the remote oauth block', async () => {
  const normalized = normalizeMcpConfig({
    version: 1,
    mcpServers: {
      notion: {
        url: 'https://mcp.notion.com/mcp',
        oauth: { clientId: 'abc', scopes: ['read', 'write'], callbackPort: 33389 },
      },
    },
  });
  const notion = normalized.mcpServers.notion;
  assert.ok(notion && 'url' in notion);
  assert.deepEqual(notion.oauth, {
    clientId: 'abc',
    scopes: ['read', 'write'],
    callbackPort: 33389,
  });

  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 1,
        mcpServers: { bad: { url: 'https://example.com/mcp', oauth: { callbackPort: 0 } } },
      }),
    /callbackPort/u,
  );
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 1,
        mcpServers: { bad: { url: 'https://example.com/mcp', oauth: { clientId: '' } } },
      }),
    /clientId/u,
  );
  // Scopes join space-delimited on the wire and must be RFC 6749 §3.3
  // scope-tokens: an empty, whitespace-containing, control-carrying,
  // quoted/backslashed or non-ASCII entry would silently change the
  // requested grant or come back as invalid_scope far from the mistake.
  for (const scopes of [
    [''],
    ['read write'],
    ['read', 'a\tb'],
    ['read"admin'],
    ['read\\admin'],
    ['read\u0001admin'],
    ['caf\u00e9'],
  ]) {
    assert.throws(
      () =>
        normalizeMcpConfig({
          version: 1,
          mcpServers: { bad: { url: 'https://example.com/mcp', oauth: { clientId: 'x', scopes } } },
        }),
      /scope token/u,
    );
  }
  // A clientSecret alone cannot form static client credentials.
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 1,
        mcpServers: { bad: { url: 'https://example.com/mcp', oauth: { clientSecret: 's3cr3t' } } },
      }),
    /clientId is required/u,
  );
  // Scopes join space-delimited on the wire and must be RFC 6749 §3.3
  // scope-tokens: an empty, whitespace-containing, control-carrying,
  // quoted/backslashed or non-ASCII entry would silently change the
  // requested grant or come back as invalid_scope far from the mistake.
  for (const scopes of [
    [''],
    ['read write'],
    ['read', 'a\tb'],
    ['read"admin'],
    ['read\\admin'],
    ['readadmin'],
    ['café'],
  ]) {
    assert.throws(
      () =>
        normalizeMcpConfig({
          version: 1,
          mcpServers: { bad: { url: 'https://example.com/mcp', oauth: { clientId: 'x', scopes } } },
        }),
      /scope token/u,
    );
  }
  // stdio servers have no oauth block; unknown fields there stay rejected
  // by the stdio branch simply dropping them.
  const stdio = normalizeMcpConfig({
    version: 1,
    mcpServers: { local: { command: 'npx', oauth: { clientId: 'x' } } },
  }).mcpServers.local;
  assert.ok(stdio && !('oauth' in stdio));
});

test('rejects a config that declares both an Authorization header and oauth', () => {
  assert.throws(
    () =>
      normalizeMcpConfig({
        version: 1,
        mcpServers: {
          bad: {
            url: 'https://example.com/mcp',
            headers: { authorization: 'Bearer x' },
            oauth: { clientId: 'abc' },
          },
        },
      }),
    /must not include Authorization when oauth is configured/u,
  );
  // Either alone is fine.
  assert.doesNotThrow(() =>
    normalizeMcpConfig({
      version: 1,
      mcpServers: {
        headerOnly: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
        oauthOnly: { url: 'https://example.com/mcp', oauth: { clientId: 'abc' } },
      },
    }),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-mcp-store-'));
  roots.push(root);
  return root;
}
