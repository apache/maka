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

test('a fresh Host starts with one anonymous runnable target', async () => {
  await withFixture(async ({ root, stores }) => {
    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.connections.length, 1);
    const free = catalog.connections[0];
    assert.equal(free?.slug, 'opencode-free');
    assert.equal(free?.enabled, true);
    assert.deepEqual(free?.enabledModelIds, [
      'nemotron-3-ultra-free',
      'mimo-v2.5-free',
      'deepseek-v4-flash-free',
    ]);
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: free?.connectionId,
      modelId: 'nemotron-3-ultra-free',
    });
    assert.deepEqual(
      catalog.connections.map(({ slug }) => slug),
      ['opencode-free'],
    );
  });
});

test('bootstrap resumes after interruption and prefers the supported environment key', async () => {
  await withFixture(async ({ root, stores }) => {
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'opencode-free',
        name: 'OpenCode Free',
        providerType: 'opencode-free',
        enabled: true,
        enabledModelIds: ['nemotron-3-ultra-free'],
      },
    });
    assert.equal(created.kind, 'committed');
    await writeFile(
      join(root, '.runtime-host-bootstrap.json'),
      '{"version":1,"state":"initializing"}\n',
      'utf8',
    );

    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: {
        ANTHROPIC_API_KEY: 'anthropic-secret',
        OPENAI_API_KEY: 'openai-secret',
      },
    });

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(
      catalog.connections.map(({ slug }) => slug),
      ['opencode-free', 'env-anthropic'],
    );
    const anthropic = catalog.connections[1];
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: anthropic?.connectionId,
      modelId: 'claude-sonnet-4-5-20250929',
    });
    const status = await stores.credentialVault.getStatus({
      scope: 'connection',
      connectionId: anthropic!.connectionId,
      kind: 'api_key',
    });
    assert.equal(status.kind, 'status');
    if (status.kind === 'status') assert.equal(status.status.configured, true);
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

test('an invalid optional environment credential does not keep bootstrap active', async () => {
  await withFixture(async ({ root, stores }) => {
    const errors: unknown[] = [];
    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: { OPENAI_API_KEY: 'x'.repeat(64 * 1024 + 1) },
      onDeferredError: (error) => errors.push(error),
    });

    assert.equal(errors.length, 1);
    const catalog = await stores.connectionCatalog.getSnapshot();
    const free = catalog.connections.find(({ slug }) => slug === 'opencode-free');
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: free?.connectionId,
      modelId: 'nemotron-3-ultra-free',
    });
    await ensureBootstrapRuntimePolicy({
      workspaceRoot: root,
      stores,
      environment: { OPENAI_API_KEY: 'x'.repeat(64 * 1024 + 1) },
      onDeferredError: (error) => errors.push(error),
    });
    assert.equal(errors.length, 1);
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
