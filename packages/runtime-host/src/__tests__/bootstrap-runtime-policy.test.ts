import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  OPENCODE_FREE_DEFAULT_MODEL,
} from '@maka/core/llm-connections';
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
    // The free set is derived from the models.dev snapshot and rotates with
    // refreshes; assert the structural contract, not today's ids.
    assert.deepEqual(free?.enabledModelIds, [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS]);
    assert.ok(free.enabledModelIds.length > 0);
    assert.equal(free.enabledModelIds[0], OPENCODE_FREE_DEFAULT_MODEL);
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: free?.connectionId,
      modelId: OPENCODE_FREE_DEFAULT_MODEL,
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

test('an untouched legacy opencode-free seed follows the current seed', async () => {
  await withFixture(async ({ root, stores }) => {
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'opencode-free',
        name: 'OpenCode Free',
        providerType: 'opencode-free',
        enabled: true,
        enabledModelIds: ['nemotron-3-ultra-free', 'mimo-v2.5-free', 'deepseek-v4-flash-free'],
      },
    });
    assert.equal(created.kind, 'committed');

    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });

    const catalog = await stores.connectionCatalog.getSnapshot();
    const free = catalog.connections.find(({ slug }) => slug === 'opencode-free');
    assert.deepEqual(free?.enabledModelIds, [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS]);

    // Idempotent: a second bootstrap leaves the migrated row unchanged.
    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });
    assert.deepEqual(await stores.connectionCatalog.getSnapshot(), catalog);
  });
});

test('a legacy seed migrates and repairs a default target the migration nulled', async () => {
  await withFixture(async ({ root, stores }) => {
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'opencode-free',
        name: 'OpenCode Free',
        providerType: 'opencode-free',
        enabled: true,
        enabledModelIds: ['nemotron-3-ultra-free', 'mimo-v2.5-free', 'deepseek-v4-flash-free'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const free = created.snapshot.connections[0]!;
    // Default target on a model the migration removes: the retained-target
    // rules null it, and bootstrap must re-seed it.
    const targeted = await stores.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: created.snapshot.revision,
      target: { connectionId: free.connectionId, modelId: 'deepseek-v4-flash-free' },
    });
    assert.equal(targeted.kind, 'committed');

    await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });

    const catalog = await stores.connectionCatalog.getSnapshot();
    const migrated = catalog.connections.find(({ slug }) => slug === 'opencode-free');
    assert.deepEqual(migrated?.enabledModelIds, [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS]);
    // The migration write also refreshes the stored inventory to the current
    // build's candidates exactly, so every model the picker offers is one
    // execution admission accepts and no stale id survives.
    assert.deepEqual(
      migrated?.models.map(({ id }) => id),
      [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS],
    );
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: free.connectionId,
      modelId: OPENCODE_FREE_DEFAULT_MODEL,
    });
  });
});

test('a user-modified opencode-free inventory is never migrated', async () => {
  // A reordered seed counts as user-modified too: exact sequence equality is
  // the (documented, lossy) proof a row is still system-owned.
  for (const enabledModelIds of [
    ['nemotron-3-ultra-free', 'big-pickle'],
    ['deepseek-v4-flash-free', 'nemotron-3-ultra-free', 'mimo-v2.5-free'],
  ]) {
    await withFixture(async ({ root, stores }) => {
      const created = await stores.connectionCatalog.create({
        expectedCatalogRevision: 0,
        connection: {
          slug: 'opencode-free',
          name: 'OpenCode Free',
          providerType: 'opencode-free',
          enabled: true,
          enabledModelIds,
        },
      });
      assert.equal(created.kind, 'committed');
      const before = await stores.connectionCatalog.getSnapshot();

      await ensureBootstrapRuntimePolicy({ workspaceRoot: root, stores, environment: {} });

      assert.deepEqual(await stores.connectionCatalog.getSnapshot(), before);
    });
  }
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
