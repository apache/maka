import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PROVIDER_DEFAULTS, type LlmConnection } from '@maka/core/llm-connections';
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

  // Onboarding "保存供应商" (and any other create path that only states a
  // defaultModel) must land the same free inventory bootstrap seeds — not a
  // one-model connection that then fails the first-run e2e contract.
  test('creates OpenCode Free with the default free inventory when enabled models are omitted', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'opencode-free',
        name: 'OpenCode Free',
        providerType: 'opencode-free',
        defaultModel: 'nemotron-3-ultra-free',
      });

      assert.deepEqual(created.enabledModelIds, [
        'nemotron-3-ultra-free',
        'mimo-v2.5-free',
        'deepseek-v4-flash-free',
      ]);
    });
  });

  test('still honors an explicit subset when creating OpenCode Free', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'opencode-free',
        name: 'OpenCode Free',
        providerType: 'opencode-free',
        defaultModel: 'nemotron-3-ultra-free',
        enabledModelIds: ['nemotron-3-ultra-free'],
      });

      assert.deepEqual(created.enabledModelIds, ['nemotron-3-ultra-free']);
    });
  });

  test('relay profiles sanitize on create and prune when a model is disabled', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'my-relay',
        name: 'My Relay',
        providerType: 'openai-compatible',
        baseUrl: 'https://relay.example/v1',
        defaultModel: 'reasoner',
        relayModelProfiles: {
          reasoner: { thinkingLevels: ['high', 'low'], vision: true },
          // Not in the seeded selection (only the default starts enabled), so
          // the ⊆ enabledModelIds invariant drops it at the boundary.
          'not-enabled': { vision: false },
        },
      });
      assert.deepEqual(created.relayModelProfiles, {
        reasoner: { thinkingLevels: ['low', 'high'], vision: true },
      });

      // Enabling a second model and declaring it keeps both profiles under an
      // update that names no table.
      await store.update(created.slug, {
        enabledModelIds: ['reasoner', 'plain'],
        relayModelProfiles: { reasoner: { vision: true }, plain: { contextWindow: 32_000 } },
      });
      // Disabling one model with no profile instruction prunes ONLY its row;
      // the still-enabled model's declaration survives.
      const pruned = await store.update(created.slug, { enabledModelIds: ['plain'] });
      assert.deepEqual(pruned.enabledModelIds, ['plain']);
      assert.deepEqual(pruned.relayModelProfiles, { plain: { contextWindow: 32_000 } });

      // `null` clears the whole table outright.
      const cleared = await store.update(created.slug, { relayModelProfiles: null });
      assert.equal(cleared.relayModelProfiles, undefined);
      const reloaded = await store.get(created.slug);
      assert.equal(reloaded?.relayModelProfiles, undefined);
    });
  });

  test('relay profile invariants match the catalog codec on every write shape', async () => {
    await withConnectionStore(async (store) => {
      // Foreign providers carry no table at all — in create, update, and
      // snapshot save alike (same gate the catalog codec enforces).
      await assert.rejects(
        () =>
          store.create({
            slug: 'openai-main',
            name: 'OpenAI',
            providerType: 'openai',
            defaultModel: 'gpt-5',
            relayModelProfiles: { 'gpt-5': { vision: true } },
          }),
        /openai-compatible/,
      );
      const plain = await store.create({
        slug: 'openai-plain',
        name: 'OpenAI Plain',
        providerType: 'openai',
        defaultModel: 'gpt-5',
      });
      assert.equal(plain.relayModelProfiles, undefined);
      await assert.rejects(
        () => store.update(plain.slug, { relayModelProfiles: { 'gpt-5': { vision: true } } }),
        /openai-compatible/,
      );
      await assert.rejects(
        () => store.save({ ...plain, relayModelProfiles: { 'gpt-5': { vision: true } } }),
        /openai-compatible/,
      );

      const relay = await store.create({
        slug: 'my-relay',
        name: 'My Relay',
        providerType: 'openai-compatible',
        baseUrl: 'https://relay.example/v1',
        defaultModel: 'reasoner',
      });

      // An update's explicit table is pruned against the FINAL selection,
      // not taken as stated: keys for models outside it never land.
      const tightened = await store.update(relay.slug, {
        enabledModelIds: ['reasoner'],
        relayModelProfiles: {
          reasoner: { vision: true },
          'freshly-listed': { vision: false },
        },
      });
      assert.deepEqual(tightened.relayModelProfiles, { reasoner: { vision: true } });

      // save() is the full-snapshot shape of the same rule: a snapshot
      // naming a model the selection does not have loses that row rather
      // than stranding it.
      const saved = await store.save({
        ...tightened,
        relayModelProfiles: {
          reasoner: { vision: false },
          ghost: { vision: true },
        },
      });
      assert.deepEqual(saved.relayModelProfiles, { reasoner: { vision: false } });
      const reloaded = await store.get(relay.slug);
      assert.deepEqual(reloaded?.relayModelProfiles, { reasoner: { vision: false } });

      // Endpoint moves retire the table: declarations belong to the relay
      // that answered for them, and a same-named model id on relay-b is a
      // different model — the catalog document store enforces the same.
      const moved = await store.update(relay.slug, {
        baseUrl: 'https://relay-b.example/v1',
      });
      assert.equal(moved.relayModelProfiles, undefined);
      const movedReloaded = await store.get(relay.slug);
      assert.equal(movedReloaded?.relayModelProfiles, undefined);

      // A table riding the moving update declares the NEW endpoint's facts,
      // so it replaces as written (same rule as the catalog document store).
      const movedWithTable = await store.update(relay.slug, {
        baseUrl: 'https://relay-c.example/v1',
        relayModelProfiles: { reasoner: { contextWindow: 64_000 } },
      });
      assert.deepEqual(movedWithTable.relayModelProfiles, {
        reasoner: { contextWindow: 64_000 },
      });

      // Restating the SAME persisted endpoint is not a move: the comparison
      // runs on persisted (trimmed, default-collapsed) values, so a routine
      // edit that submits the unchanged endpoint cannot retire the table.
      const restated = await store.update(relay.slug, {
        baseUrl: 'https://relay-c.example/v1',
      });
      assert.deepEqual(restated.relayModelProfiles, {
        reasoner: { contextWindow: 64_000 },
      });
    });
  });

  test('normalizes an updated enabled-model list and writes it as stated', async () => {
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

      // Trimmed and de-duplicated, but not extended: the default is not merged
      // back in. A default outside the stated set is no longer the default.
      assert.deepEqual(updated.enabledModelIds, ['gpt-5']);
      assert.equal(updated.defaultModel, '');
    });
  });

  test('clearing the enabled models clears the default with them', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o-mini',
      });

      // Enabling no models is a real answer: the connection stays configured
      // and testable, it just offers nothing to chat. Keeping the default here
      // would re-assert a choice the user had withdrawn.
      const updated = await store.update(created.slug, { enabledModelIds: [] });

      assert.deepEqual(updated.enabledModelIds, []);
      assert.equal(updated.defaultModel, '');
      // Survives a reload — the emptied list is persisted, not just returned.
      const reloaded = (await store.list()).find((entry) => entry.slug === created.slug);
      assert.deepEqual(reloaded?.enabledModelIds, []);
      assert.equal(reloaded?.defaultModel, '');
      // And the workspace default goes with it: the runtime starts a chat on a
      // {connection, model} pair, so half a pair is not a state to keep.
      assert.equal(await store.getDefault(), null);
    });
  });

  test('unchecking the default model is not silently undone', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o',
      });
      await store.update(created.slug, { enabledModelIds: ['gpt-4o', 'gpt-4o-mini'] });

      // The store used to merge the default back into every write, so this
      // selection came back as ['gpt-4o', 'gpt-4o-mini'] — identical to the
      // current one. Callers that skip no-op writes therefore never wrote, and
      // the checkbox re-checked itself.
      const updated = await store.update(created.slug, { enabledModelIds: ['gpt-4o-mini'] });

      assert.deepEqual(updated.enabledModelIds, ['gpt-4o-mini']);
      assert.equal(updated.defaultModel, '');
    });
  });

  test('an emptied selection survives the next model fetch', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o-mini',
      });
      // Give it an inventory first: bootstrapping a default is a first-fetch
      // affordance, and this connection has now had its first fetch.
      await store.update(created.slug, {
        models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1,
      });
      await store.update(created.slug, { enabledModelIds: [] });

      // Refreshing the catalog used to re-seed `liveIds[0]`, so "enable
      // nothing" only lasted until the next 更新模型目录 — or until the silent
      // auto-fetch that follows saving a key.
      const refreshed = await store.update(created.slug, {
        models: [{ id: 'gpt-5' }, { id: 'gpt-4o' }],
        modelSource: 'fetched',
        modelsFetchedAt: 2,
      });

      assert.deepEqual(refreshed.enabledModelIds, []);
      assert.equal(refreshed.defaultModel, '');
    });
  });

  test('half a default target is unreachable from every write path', async () => {
    await withConnectionStore(async (store) => {
      // Created with no default model at all — the four providers that ship no
      // `fallbackModels`. It used to claim the vacant workspace default on the
      // way in, which showed a 默认 badge over a picker reading 未设置.
      await store.create({ slug: 'lmstudio-local', name: 'LM Studio', providerType: 'lm-studio' });
      assert.equal(await store.getDefault(), null);

      const openai = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o',
      });
      assert.equal(await store.getDefault(), openai.slug);

      await store.update(openai.slug, { enabledModelIds: [] });
      assert.equal(await store.getDefault(), null);
      // And it cannot be handed back: update() cleared the slug, so setDefault()
      // has to refuse the same state rather than restore it.
      await assert.rejects(
        () => store.setDefault(openai.slug),
        /Connection has no default model: openai-main/,
      );
    });
  });

  test('a default slug already on disk without a model reads back as unset', async () => {
    await withConnectionStore(async (store, dir) => {
      await writeFile(
        join(dir, 'llm-connections.json'),
        JSON.stringify({
          defaultSlug: 'openai-main',
          connections: [
            {
              slug: 'openai-main',
              name: 'OpenAI',
              providerType: 'openai',
              defaultModel: '',
              enabled: true,
              enabledModelIds: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
        'utf8',
      );

      assert.equal(await store.getDefault(), null);
    });
  });

  test('a saved snapshot keeps the default its caller reconciled', async () => {
    await withConnectionStore(async (store) => {
      await store.save({
        slug: 'github-copilot',
        name: 'GitHub Copilot',
        providerType: 'github-copilot',
        defaultModel: 'gpt-4.1',
        enabled: true,
        enabledModelIds: ['gpt-4.1'],
        models: [{ id: 'gpt-4.1' }],
        modelSource: 'fetched',
        createdAt: 1,
        updatedAt: 1,
      });

      // The provider retires gpt-4.1 and the sync repairs the default to a live
      // id, but hands back the stored selection unchanged — the exact snapshot
      // it used to write. save() sees only a snapshot, so it cannot tell that
      // repaired default from one a user just contradicted; reading the stale
      // list as their word threw the repair away and left the connection
      // pointing at a model that no longer exists.
      const existing = (await store.get('github-copilot'))!;
      const synced = await store.save({
        ...existing,
        defaultModel: 'gpt-5',
        enabledModelIds: ['gpt-4.1'],
        models: [{ id: 'gpt-5' }],
      });

      assert.equal(synced.defaultModel, 'gpt-5');
      assert.ok(synced.enabledModelIds?.includes('gpt-5'));
      assert.equal(await store.getDefault(), 'github-copilot');
    });
  });

  test('a cached fallback catalog is an inventory too', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o-mini',
      });
      // Providers without live discovery only ever cache a fallback catalog.
      // That list is still a list the user picked from, so emptying it is an
      // answer — keying the bootstrap on `modelSource === 'fetched'` would have
      // treated the next fetch as a first fetch and re-seeded it.
      await store.update(created.slug, {
        models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
        modelSource: 'fallback',
        modelsFetchedAt: 1,
      });
      await store.update(created.slug, { enabledModelIds: [] });

      const refreshed = await store.update(created.slug, {
        models: [{ id: 'gpt-5' }],
        modelSource: 'fetched',
        modelsFetchedAt: 2,
      });

      assert.deepEqual(refreshed.enabledModelIds, []);
      assert.equal(refreshed.defaultModel, '');
    });
  });

  test('the first model fetch still seeds a provider that ships no fallback models', async () => {
    await withConnectionStore(async (store) => {
      // LM Studio and the three *-compatible providers have no
      // `fallbackModels`, so they are created with an empty default. Their
      // first discovery is the only place a usable default can come from.
      const created = await store.create({
        slug: 'lmstudio-local',
        name: 'LM Studio',
        providerType: 'lm-studio',
      });
      assert.equal(created.defaultModel, '');

      const fetched = await store.update(created.slug, {
        models: [{ id: 'qwen3-30b' }, { id: 'llama-3.3-70b' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1,
      });

      assert.equal(fetched.defaultModel, 'qwen3-30b');
      assert.deepEqual(fetched.enabledModelIds, ['qwen3-30b']);
      // And that is where it becomes able to hold the workspace default. It
      // could not at create — it had no model — so if discovery does not claim
      // the vacant slug, the user finishes setting up their only connection and
      // onboarding still has nothing to point at.
      assert.equal(await store.getDefault(), 'lmstudio-local');
    });
  });

  test('a routine account sync never takes the vacant workspace default', async () => {
    await withConnectionStore(async (store) => {
      const xai: LlmConnection = {
        slug: 'xai-oauth',
        name: 'xAI OAuth',
        providerType: 'xai-oauth',
        defaultModel: 'grok-4.5',
        enabled: true,
        enabledModelIds: ['grok-4.5'],
        models: [{ id: 'grok-4.5' }],
        modelSource: 'fetched',
        createdAt: 1,
        updatedAt: 1,
      };
      await store.create({
        slug: 'openai-main',
        name: 'OpenAI',
        providerType: 'openai',
        defaultModel: 'gpt-4o',
      });
      await store.save(xai);
      assert.equal(await store.getDefault(), 'openai-main');

      await store.update('openai-main', { enabledModelIds: [] });
      assert.equal(await store.getDefault(), null);

      // What one `connections:list` does: it runs the OAuth account sync before
      // every read, and each sync ends in save() on a connection that already
      // exists. Claiming any vacant slug meant clearing your own default handed
      // the workspace to another provider — the next chat went to a different
      // account, with nothing on screen to say so.
      await store.save({ ...xai, updatedAt: 2 });

      assert.equal(await store.getDefault(), null);
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

  test('conditionally updates a bootstrap seed without overwriting concurrent edits', async () => {
    await withConnectionStore(async (store) => {
      const created = await store.create({
        slug: 'opencode-free',
        name: 'OpenCode Free',
        providerType: 'opencode-free',
        defaultModel: 'big-pickle',
      });

      assert.equal(
        await store.updateIfUnchanged(created.slug, created.updatedAt - 1, {
          defaultModel: 'nemotron-3-ultra-free',
        }),
        null,
      );
      assert.equal((await store.get(created.slug))?.defaultModel, 'big-pickle');

      const migrated = await store.updateIfUnchanged(created.slug, created.updatedAt, {
        defaultModel: 'nemotron-3-ultra-free',
        enabledModelIds: ['nemotron-3-ultra-free', 'mimo-v2.5-free', 'deepseek-v4-flash-free'],
        extras: { makaBootstrap: { id: 'opencode-free', version: 3 } },
      });
      assert.equal(migrated?.defaultModel, 'nemotron-3-ultra-free');
      assert.deepEqual(migrated?.enabledModelIds, [
        'nemotron-3-ultra-free',
        'mimo-v2.5-free',
        'deepseek-v4-flash-free',
      ]);
      assert.deepEqual(migrated?.extras, {
        makaBootstrap: { id: 'opencode-free', version: 3 },
      });
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
