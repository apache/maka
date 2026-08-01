import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { createConnectionStore } from '../connection-store.js';

describe('FileConnectionStore', () => {
  test('seeds a new connection with only its default model enabled', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openrouter-main',
        name: 'OpenRouter',
        providerType: 'openrouter',
        defaultModel: 'openrouter/auto',
      });

      assert.deepEqual(created.enabledModelIds, ['openrouter/auto']);
    });
  });

  test('migrates a legacy connection to only its default model enabled', async () => {
    await withConnectionStore(async (store, dir) => {
      await writeFile(
        join(dir, 'llm-connections.json'),
        JSON.stringify({
          defaultSlug: 'openrouter-main',
          connections: [
            {
              slug: 'openrouter-main',
              name: 'OpenRouter',
              providerType: 'openrouter',
              defaultModel: 'openrouter/auto',
              enabled: true,
              models: [{ id: 'openrouter/auto' }, { id: 'anthropic/claude-opus-4.8' }],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
        'utf8',
      );

      const migrated = await store.get('openrouter-main');

      assert.deepEqual(migrated?.enabledModelIds, ['openrouter/auto']);
    });
  });

  test('normalizes an updated enabled-model list and keeps the default enabled', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o-mini',
      });

      const updated = await store.update(created.slug, {
        enabledModelIds: [' gpt-5 ', 'gpt-5', ''],
      });

      assert.deepEqual(updated.enabledModelIds, ['gpt-4o-mini', 'gpt-5']);
    });
  });

  test('automatically enables a model when it becomes the default', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o-mini',
      });

      const updated = await store.update(created.slug, { defaultModel: 'gpt-5' });

      assert.deepEqual(updated.enabledModelIds, ['gpt-5', 'gpt-4o-mini']);
    });
  });
  test('repairs a stale default after live models are stored (moonshot regression)', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'moonshot-main',
        name: 'Moonshot',
        providerType: 'moonshot',
        defaultModel: 'moonshot-v1-8k',
      });

      const updated = await store.update(created.slug, {
        models: [{ id: 'kimi-k2.6' }, { id: 'kimi-k2.5' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1,
        enabledModelIds: ['moonshot-v1-8k', 'kimi-k2.6'],
      });

      assert.equal(updated.defaultModel, 'kimi-k2.6');
      assert.deepEqual(updated.enabledModelIds, ['kimi-k2.6']);
      assert.equal(updated.modelSource, 'fetched');
    });
  });

  test('persists the GitHub Copilot account endpoint and per-model wire protocol', async () => {
    await withConnectionStore(async (store, dir) => {
      const created = await store.create({
        slug: 'github-copilot',
        name: 'GitHub Copilot',
        providerType: 'github-copilot',
        baseUrl: 'https://api.business.githubcopilot.com',
        defaultModel: 'gpt-5.4',
      });

      await store.update(created.slug, {
        models: [{ id: 'gpt-5.4', apiProtocol: 'openai-responses' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1_800_000_000_000,
      });

      const reloaded = await store.get(created.slug);
      assert.equal(reloaded?.providerType, 'github-copilot');
      assert.equal(reloaded?.baseUrl, 'https://api.business.githubcopilot.com');
      assert.deepEqual(reloaded?.models, [{ id: 'gpt-5.4', apiProtocol: 'openai-responses' }]);
    });
  });

  test('keeps provider create defaults independent from catalog recommendation refreshes', async () => {
    await withConnectionStore(async (store) => {
      const openai = await store.create({
        slug: 'openai-default',
        name: 'OpenAI',
        providerType: 'openai',
      });
      const google = await store.create({
        slug: 'google-default',
        name: 'Google',
        providerType: 'google',
      });
      const zai = await store.create({
        slug: 'zai-default',
        name: 'Z.AI',
        providerType: 'zai-coding-plan',
      });

      assert.equal(openai.defaultModel, 'gpt-4o-mini');
      assert.equal(google.defaultModel, 'gemini-2.5-flash');
      assert.equal(zai.defaultModel, 'glm-4.7');
    });
  });

  test('persists explicit connection test status updates', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'anthropic-main',
        name: 'Claude',
        providerType: 'anthropic',
        defaultModel: 'claude-sonnet-4-5-20250929',
      });

      await store.update(created.slug, {
        lastTestStatus: 'verified',
        lastTestAt: '2026-05-21T09:00:00.000Z',
        lastTestMessage: 'Connection verified',
      });

      const next = await store.get(created.slug);
      assert.equal(next?.lastTestStatus, 'verified');
      assert.equal(next?.lastTestAt, '2026-05-21T09:00:00.000Z');
      assert.equal(next?.lastTestMessage, 'Connection verified');
    });
  });

  test('invalidates old verified status when configuration changes', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o-mini',
      });
      await store.update(created.slug, {
        lastTestStatus: 'verified',
        lastTestAt: '2026-05-21T09:00:00.000Z',
        lastTestMessage: 'Connection verified',
      });

      await store.update(created.slug, { defaultModel: 'gpt-5' });
      let next = await store.get(created.slug);
      assert.equal(next?.lastTestStatus, undefined);
      assert.equal(next?.lastTestAt, undefined);
      assert.equal(next?.lastTestMessage, undefined);

      await store.update(created.slug, {
        lastTestStatus: 'verified',
        lastTestAt: '2026-05-21T10:00:00.000Z',
        lastTestMessage: 'Connection verified',
      });
      await store.update(created.slug, { apiKey: 'new-secret' });
      next = await store.get(created.slug);
      assert.equal(next?.lastTestStatus, undefined);
    });
  });

  test('non-configuration updates do not erase last test status', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'ollama-local',
        name: 'Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });
      await store.update(created.slug, {
        lastTestStatus: 'verified',
        lastTestAt: '2026-05-21T09:00:00.000Z',
        lastTestMessage: 'Connection verified',
      });

      await store.update(created.slug, { enabled: false, name: 'Ollama Disabled' });

      const next = await store.get(created.slug);
      assert.equal(next?.enabled, false);
      assert.equal(next?.lastTestStatus, 'verified');
    });
  });

  test('persists successful model discovery metadata', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'zai-main',
        name: 'Z.ai',
        providerType: 'zai-coding-plan',
        defaultModel: 'glm-4.7',
      });

      await store.update(created.slug, {
        models: [{ id: 'glm-5' }, { id: 'glm-5.1' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1_800_000_000_000,
      });

      const next = await store.get(created.slug);
      assert.deepEqual(next?.models, [{ id: 'glm-5' }, { id: 'glm-5.1' }]);
      // Stale default (not in the live inventory) is repaired so readiness
      // does not fail with model_not_enabled after a successful fetch.
      assert.equal(next?.defaultModel, 'glm-5');
      assert.deepEqual(next?.enabledModelIds, ['glm-5']);
      assert.equal(next?.modelSource, 'fetched');
      assert.equal(next?.modelsFetchedAt, 1_800_000_000_000);
    });
  });

  test('does not reconcile a stale default from a fallback model catalog', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'fallback-main',
        name: 'Fallback',
        providerType: 'openai-compatible',
        defaultModel: 'configured-model',
      });

      const next = await store.update(created.slug, {
        models: [{ id: 'catalog-fallback' }],
        modelSource: 'fallback',
        modelsFetchedAt: 1,
      });

      assert.equal(next.defaultModel, 'configured-model');
      assert.deepEqual(next.enabledModelIds, ['configured-model']);
      assert.deepEqual(next.models, [{ id: 'catalog-fallback' }]);
    });
  });

  test('does not reconcile when fetched metadata is updated without a model payload', async () => {
    await withConnectionStore(async (store, dir) => {
      await writeFile(
        join(dir, 'llm-connections.json'),
        JSON.stringify({
          defaultSlug: 'moonshot-main',
          connections: [
            {
              slug: 'moonshot-main',
              name: 'Moonshot',
              providerType: 'moonshot',
              defaultModel: 'moonshot-v1-8k',
              enabled: true,
              enabledModelIds: ['moonshot-v1-8k'],
              models: [{ id: 'kimi-k2.6' }],
              modelSource: 'fallback',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
        'utf8',
      );

      const next = await store.update('moonshot-main', {
        modelSource: 'fetched',
        modelsFetchedAt: 2,
      });
      assert.equal(next.defaultModel, 'moonshot-v1-8k');
      assert.deepEqual(next.enabledModelIds, ['moonshot-v1-8k']);
      assert.equal(next.models, undefined);
    });
  });

  test('does not reconcile a stale default during an unrelated display-only update', async () => {
    await withConnectionStore(async (store, dir) => {
      await writeFile(
        join(dir, 'llm-connections.json'),
        JSON.stringify({
          defaultSlug: 'moonshot-main',
          connections: [
            {
              slug: 'moonshot-main',
              name: 'Moonshot',
              providerType: 'moonshot',
              defaultModel: 'moonshot-v1-8k',
              enabled: true,
              enabledModelIds: ['moonshot-v1-8k'],
              models: [{ id: 'kimi-k2.6' }],
              modelSource: 'fetched',
              modelsFetchedAt: 1_800_000_000_000,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
        'utf8',
      );

      // A rename does not own model discovery and therefore must not silently
      // switch the selected model. The next discovery write will reconcile it.
      await store.update('moonshot-main', { name: 'Moonshot Primary' });
      const next = await store.get('moonshot-main');
      assert.equal(next?.defaultModel, 'moonshot-v1-8k');
      assert.deepEqual(next?.enabledModelIds, ['moonshot-v1-8k']);
    });
  });

  test('preserves the last successful model catalog when credentials or base URL change', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'zai-main',
        name: 'Z.ai',
        providerType: 'zai-coding-plan',
        defaultModel: 'glm-4.7',
      });
      await store.update(created.slug, {
        models: [{ id: 'glm-5' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1_800_000_000_000,
      });

      await store.update(created.slug, { apiKey: 'new-secret' });
      let next = await store.get(created.slug);
      assert.deepEqual(next?.models, [{ id: 'glm-5' }]);
      assert.equal(next?.modelSource, 'fetched');
      assert.equal(next?.modelsFetchedAt, 1_800_000_000_000);

      await store.update(created.slug, {
        models: [{ id: 'glm-5.1' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1_800_000_000_001,
      });
      await store.update(created.slug, { baseUrl: 'https://api.z.ai/api/coding/paas/v4' });
      next = await store.get(created.slug);
      assert.deepEqual(next?.models, [{ id: 'glm-5.1' }]);
      assert.equal(next?.modelSource, 'fetched');
      assert.equal(next?.modelsFetchedAt, 1_800_000_000_001);
    });
  });

  test('keeps model cache metadata for display-only and default-model updates', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o-mini',
      });
      await store.update(created.slug, {
        models: [{ id: 'gpt-4o-mini' }, { id: 'gpt-5' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1_800_000_000_000,
      });

      await store.update(created.slug, {
        name: 'OpenAI Primary',
        enabled: false,
        defaultModel: 'gpt-5',
      });

      const next = await store.get(created.slug);
      assert.deepEqual(next?.models, [{ id: 'gpt-4o-mini' }, { id: 'gpt-5' }]);
      assert.equal(next?.modelSource, 'fetched');
      assert.equal(next?.modelsFetchedAt, 1_800_000_000_000);
    });
  });

  test('does not keep or assign disabled connections as the default', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'claude-subscription',
        name: 'Claude OAuth',
        providerType: 'claude-subscription',
        defaultModel: 'claude-sonnet-4-5-20250929',
      });
      assert.equal(await store.getDefault(), created.slug);

      await store.update(created.slug, { enabled: false, lastTestStatus: 'needs_reauth' });
      assert.equal(await store.getDefault(), null);

      await assert.rejects(
        () => store.setDefault(created.slug),
        /Connection is disabled: claude-subscription/,
      );

      await store.save({
        ...created,
        enabled: false,
        updatedAt: Date.now(),
      });
      assert.equal(await store.getDefault(), null);
    });
  });

  test('drops stale persisted default slugs on read without hiding connections', async () => {
    await withConnectionStore(async (store, dir) => {
      await writeFile(
        join(dir, 'llm-connections.json'),
        JSON.stringify({
          defaultSlug: 'deleted-connection',
          connections: [
            {
              slug: 'anthropic-live',
              name: 'Claude',
              providerType: 'anthropic',
              defaultModel: 'claude-sonnet-4-5-20250929',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }) + '\n',
        'utf8',
      );

      assert.equal(await store.getDefault(), null);
      assert.deepEqual(
        (await store.list()).map((connection) => connection.slug),
        ['anthropic-live'],
      );
    });
  });

  test('drops disabled persisted default slugs on read while preserving enabled defaults', async () => {
    await withConnectionStore(async (store, dir) => {
      await writeFile(
        join(dir, 'llm-connections.json'),
        JSON.stringify({
          defaultSlug: 'disabled-claude',
          connections: [
            {
              slug: 'disabled-claude',
              name: 'Claude',
              providerType: 'anthropic',
              defaultModel: 'claude-sonnet-4-5-20250929',
              enabled: false,
              createdAt: 1,
              updatedAt: 1,
            },
            {
              slug: 'enabled-openai',
              name: 'OpenAI',
              providerType: 'openai',
              defaultModel: 'gpt-5',
              enabled: true,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }) + '\n',
        'utf8',
      );

      assert.equal(await store.getDefault(), null);
      await store.setDefault('enabled-openai');
      assert.equal(await store.getDefault(), 'enabled-openai');
    });
  });

  test('rejects wrong top-level connection files instead of overwriting them as empty', async () => {
    await withConnectionStore(async (store, dir) => {
      const filePath = join(dir, 'llm-connections.json');
      const invalid = JSON.stringify({ defaultSlug: null }, null, 2) + '\n';
      await writeFile(filePath, invalid, 'utf8');

      await assert.rejects(() => store.list(), /connections must be an array/);
      await assert.rejects(
        () =>
          store.create({
            slug: 'openai-main',
            name: 'OpenAI',
            providerType: 'openai',
            defaultModel: 'gpt-4o-mini',
          }),
        /connections must be an array/,
      );
      assert.equal(await readFile(filePath, 'utf8'), invalid);
    });
  });

  test('does not persist the provider default baseUrl as an explicit override on create', async () => {
    await withConnectionStore(async (store, dir) => {
      // The add-form submits defaults.baseUrl verbatim when the field isn't
      // customized; the store drops it so the connection follows the live default.
      const created = await store.create({
        slug: 'openai-default',
        name: 'OpenAI',
        providerType: 'openai',
        baseUrl: PROVIDER_DEFAULTS.openai.baseUrl,
        defaultModel: 'gpt-4o-mini',
      });
      assert.equal(created.baseUrl, undefined);

      const onDisk = JSON.parse(await readFile(join(dir, 'llm-connections.json'), 'utf8'));
      assert.equal(
        onDisk.connections[0].baseUrl,
        undefined,
        'default must not be written to disk as an override',
      );
    });
  });

  test('persists a custom baseUrl override on create and trims surrounding whitespace', async () => {
    await withConnectionStore(async (store, dir) => {
      const custom = 'https://my-openai-proxy.example.com/v1';
      const created = await store.create({
        slug: 'openai-proxy',
        name: 'OpenAI Proxy',
        providerType: 'openai',
        baseUrl: `  ${custom}  `,
        defaultModel: 'gpt-4o-mini',
      });
      assert.equal(created.baseUrl, custom);

      const onDisk = JSON.parse(await readFile(join(dir, 'llm-connections.json'), 'utf8'));
      assert.equal(onDisk.connections[0].baseUrl, custom, 'custom override is persisted, trimmed');
    });
  });

  test('update clears the override when the default is submitted and stores a custom override verbatim', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        baseUrl: 'https://my-openai-proxy.example.com/v1',
        defaultModel: 'gpt-4o-mini',
      });
      assert.equal(created.baseUrl, 'https://my-openai-proxy.example.com/v1');

      // Submitting the provider default clears the override (no pin).
      const cleared = await store.update(created.slug, {
        baseUrl: PROVIDER_DEFAULTS.openai.baseUrl,
      });
      assert.equal(cleared.baseUrl, undefined);

      // A custom override is stored.
      const overridden = await store.update(created.slug, {
        baseUrl: 'https://other-proxy.example.com/v1',
      });
      assert.equal(overridden.baseUrl, 'https://other-proxy.example.com/v1');

      // An explicit clear (empty string) also clears the override.
      const clearedAgain = await store.update(created.slug, { baseUrl: '' });
      assert.equal(clearedAgain.baseUrl, undefined);
    });
  });

  test('save drops the provider default baseUrl instead of persisting it as an override', async () => {
    await withConnectionStore(async (store, dir) => {
      // save()'s OAuth-sync caller constructs `{ baseUrl: defaults.baseUrl }`;
      // without persistedBaseUrl that pins the connection to the current default.
      const created = await store.create({
        slug: 'claude-oauth',
        name: 'Claude OAuth',
        providerType: 'claude-subscription',
        defaultModel: 'claude-sonnet-4-5-20250929',
      });
      assert.equal(created.baseUrl, undefined);

      const saved = await store.save({
        ...created,
        baseUrl: PROVIDER_DEFAULTS['claude-subscription'].baseUrl,
        updatedAt: Date.now(),
      });
      assert.equal(
        saved.baseUrl,
        undefined,
        'save must not persist the provider default as an override',
      );

      const onDisk = JSON.parse(await readFile(join(dir, 'llm-connections.json'), 'utf8'));
      assert.equal(
        onDisk.connections[0].baseUrl,
        undefined,
        'default must not be written to disk by save',
      );

      // A custom override round-trips through save.
      const custom = 'https://my-anthropic-proxy.example.com';
      const overridden = await store.save({
        ...created,
        baseUrl: custom,
        updatedAt: Date.now(),
      });
      assert.equal(overridden.baseUrl, custom);
    });
  });

  test('rejects invalid defaultSlug types without overwriting connection bytes', async () => {
    await withConnectionStore(async (store, dir) => {
      const filePath = join(dir, 'llm-connections.json');
      const invalid = JSON.stringify({ defaultSlug: 42, connections: [] }, null, 2) + '\n';
      await writeFile(filePath, invalid, 'utf8');

      await assert.rejects(() => store.getDefault(), /defaultSlug must be a string or null/);
      await assert.rejects(
        () =>
          store.save({
            slug: 'anthropic-main',
            name: 'Claude',
            providerType: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          }),
        /defaultSlug must be a string or null/,
      );
      assert.equal(await readFile(filePath, 'utf8'), invalid);
    });
  });
});

async function withConnectionStore<T>(
  fn: (store: ReturnType<typeof createConnectionStore>, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-connection-store-'));
  try {
    return await fn(createConnectionStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
