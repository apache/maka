import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnectionStore } from '@maka/storage';
import {
  ConnectionModelDiscoveryPreconditionError,
  discoverConnectionModels,
} from '../connection-model-discovery.js';

test('precondition failures are explicitly safe to preserve across IPC', async () => {
  await assert.rejects(
    discoverConnectionModels(
      {
        connectionStore: {
          get: async () => null,
          update: async () => {
            throw new Error('update must not run for a missing connection');
          },
        },
        resolveConnectionSecret: async () => null,
      },
      'missing',
    ),
    (error: unknown) =>
      error instanceof ConnectionModelDiscoveryPreconditionError &&
      error.message === '找不到模型连接：missing',
  );
});

test('an empty discovery result leaves the last successful catalog intact', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-model-discovery-'));
  try {
    const connectionStore = createConnectionStore(workspaceRoot);
    const created = await connectionStore.create({
      slug: 'zai-main',
      name: 'Z.ai',
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-5',
    });
    await connectionStore.update(created.slug, {
      models: [{ id: 'glm-5' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
    });
    await connectionStore.update(created.slug, { apiKey: 'rotated-secret' });

    await assert.rejects(
      discoverConnectionModels(
        {
          connectionStore,
          resolveConnectionSecret: async () => 'rotated-secret',
          fetchModels: async () => [],
          now: () => 1_900_000_000_000,
        },
        created.slug,
      ),
      /no usable models/,
    );

    const persisted = await connectionStore.get(created.slug);
    assert.deepEqual(persisted?.models, [{ id: 'glm-5' }]);
    assert.equal(persisted?.modelSource, 'fetched');
    assert.equal(persisted?.modelsFetchedAt, 1_800_000_000_000);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('a fallback-only provider cannot turn its static snapshot into a fetched catalog', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-model-discovery-'));
  try {
    const connectionStore = createConnectionStore(workspaceRoot);
    const created = await connectionStore.create({
      slug: 'volcengine-ark',
      name: 'Volcengine Ark',
      providerType: 'volcengine-ark',
      defaultModel: 'doubao-seed-2-0-pro-260215',
    });

    await assert.rejects(
      discoverConnectionModels(
        {
          connectionStore,
          resolveConnectionSecret: async () => 'ark-inference-key',
          fetchModels: async () => [{ id: 'doubao-seed-2-0-pro-260215' }],
        },
        created.slug,
      ),
      /does not support remote model discovery/,
    );

    const persisted = await connectionStore.get(created.slug);
    assert.equal(persisted?.models, undefined);
    assert.equal(persisted?.modelSource, undefined);
    assert.equal(persisted?.modelsFetchedAt, undefined);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('a successful discovery atomically replaces the persisted catalog and provenance', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-model-discovery-'));
  try {
    const connectionStore = createConnectionStore(workspaceRoot);
    const created = await connectionStore.create({
      slug: 'zai-main',
      name: 'Z.ai',
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-old',
    });

    const result = await discoverConnectionModels(
      {
        connectionStore,
        resolveConnectionSecret: async () => 'zai-secret',
        fetchModels: async () => [{ id: 'glm-new' }],
        now: () => 1_900_000_000_000,
      },
      created.slug,
    );

    assert.deepEqual(result, {
      models: [{ id: 'glm-new' }],
      source: 'fetched',
      fetchedAt: 1_900_000_000_000,
    });
    const persisted = await connectionStore.get(created.slug);
    assert.deepEqual(persisted?.models, [{ id: 'glm-new' }]);
    assert.equal(persisted?.modelSource, 'fetched');
    assert.equal(persisted?.modelsFetchedAt, 1_900_000_000_000);
    assert.equal(persisted?.defaultModel, 'glm-new');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
