import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { build } from 'esbuild';
import type { LlmConnection } from '@maka/core';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

type ModelCatalogChoicesModule = {
  buildCatalogRecommendedDefaultModel(providerType: LlmConnection['providerType']): string;
  buildCatalogChatModelChoices(connections: readonly LlmConnection[]): Array<{
    connectionSlug: string;
    providerType: string;
    model: string;
    label: string;
    connectionName?: string;
  }>;
  pickCatalogDefaultChatModel(connection: LlmConnection): {
    llmConnectionSlug: string;
    model: string;
  } | undefined;
  buildCatalogDailyReviewModelOptions(
    connections: readonly LlmConnection[],
    currentModelKey: string,
  ): Array<readonly [string, string]>;
  buildCatalogModelChoices(connection: LlmConnection): Array<{
    id: string;
    displayName?: string;
    source: string;
    recommendedRank?: number;
    lifecycle: string;
    docsUrl?: string;
    availability: string;
    unavailableReason: string;
    isDefault: boolean;
  }>;
};

async function importModelCatalogChoices(): Promise<ModelCatalogChoicesModule> {
  const outdir = await mkdtemp(resolve(tmpdir(), 'maka-model-catalog-choices-'));
  const outfile = resolve(outdir, 'model-catalog-choices.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(REPO_ROOT, 'apps/desktop/src/renderer/model-catalog-choices.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`) as ModelCatalogChoicesModule;
}

function connection(overrides: Partial<LlmConnection> & Pick<LlmConnection, 'slug' | 'providerType'>): LlmConnection {
  return {
    name: overrides.slug,
    defaultModel: '',
    enabled: true,
    enabledModelIds: overrides.enabledModelIds ?? overrides.models?.map((model) => model.id),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('model catalog picker helpers', () => {
  it('exposes only enabled models to Chat while retaining the full connection catalog', async () => {
    const { buildCatalogChatModelChoices, buildCatalogModelChoices } = await importModelCatalogChoices();
    const openrouter = connection({
      slug: 'openrouter-main',
      providerType: 'openrouter',
      defaultModel: 'openrouter/auto',
      enabledModelIds: ['openrouter/auto', 'anthropic/claude-sonnet-4.6'],
      models: [
        { id: 'openrouter/auto' },
        { id: 'anthropic/claude-sonnet-4.6' },
        { id: 'openai/gpt-5.5' },
      ],
      modelSource: 'fetched',
    });

    assert.deepEqual(
      buildCatalogChatModelChoices([openrouter]).map((choice) => choice.model),
      ['openrouter/auto', 'anthropic/claude-sonnet-4.6'],
    );
    assert.deepEqual(
      buildCatalogModelChoices(openrouter).map((choice) => choice.id),
      ['openrouter/auto', 'anthropic/claude-sonnet-4.6', 'openai/gpt-5.5'],
    );
  });

  it('limits Daily Review to enabled models while retaining its disabled current value', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();
    const openrouter = connection({
      slug: 'openrouter-main',
      providerType: 'openrouter',
      defaultModel: 'openrouter/auto',
      enabledModelIds: ['openrouter/auto'],
      models: [
        { id: 'openrouter/auto' },
        { id: 'anthropic/claude-sonnet-4.6' },
        { id: 'openai/gpt-5.5' },
      ],
      modelSource: 'fetched',
    });

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([openrouter], 'openrouter-main::openai/gpt-5.5'),
      [
        ['openrouter-main::openrouter/auto', 'Auto Router'],
        ['openrouter-main::openai/gpt-5.5', 'GPT-5.5 · 当前不可用'],
      ],
    );
  });

  it('keeps an Ollama cloud alias distinct and selects it unchanged', async () => {
    const { buildCatalogChatModelChoices, pickCatalogDefaultChatModel } = await importModelCatalogChoices();
    const ollama = connection({
      slug: 'ollama-local',
      providerType: 'ollama',
      defaultModel: 'qwen3.5:cloud',
      models: [{ id: 'qwen3.5' }, { id: 'qwen3.5:cloud' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
    });

    assert.deepEqual(
      buildCatalogChatModelChoices([ollama]).map(({ connectionSlug, providerType, model }) => ({
        connectionSlug,
        providerType,
        model,
      })),
      [
        { connectionSlug: 'ollama-local', providerType: 'ollama', model: 'qwen3.5' },
        { connectionSlug: 'ollama-local', providerType: 'ollama', model: 'qwen3.5:cloud' },
      ],
    );
    assert.deepEqual(pickCatalogDefaultChatModel(ollama), {
      llmConnectionSlug: 'ollama-local',
      model: 'qwen3.5:cloud',
    });
  });

  it('keeps the remote Ollama Cloud connection distinct from local cloud aliases', async () => {
    const { buildCatalogChatModelChoices, pickCatalogDefaultChatModel } = await importModelCatalogChoices();
    const remote = connection({
      slug: 'ollama-cloud',
      providerType: 'ollama-cloud',
      defaultModel: 'qwen3.5:397b',
      models: [{ id: 'qwen3.5:397b' }, { id: 'gpt-oss:120b' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
    });
    const local = connection({
      slug: 'ollama-local',
      providerType: 'ollama',
      defaultModel: 'qwen3.5:cloud',
      models: [{ id: 'qwen3.5:cloud' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
    });

    assert.deepEqual(
      buildCatalogChatModelChoices([remote, local]).map(({ connectionSlug, providerType, model }) => ({
        connectionSlug,
        providerType,
        model,
      })),
      [
        { connectionSlug: 'ollama-cloud', providerType: 'ollama-cloud', model: 'qwen3.5:397b' },
        { connectionSlug: 'ollama-cloud', providerType: 'ollama-cloud', model: 'gpt-oss:120b' },
        { connectionSlug: 'ollama-local', providerType: 'ollama', model: 'qwen3.5:cloud' },
      ],
    );
    assert.deepEqual(pickCatalogDefaultChatModel(remote), {
      llmConnectionSlug: 'ollama-cloud',
      model: 'qwen3.5:397b',
    });
  });

  it('keeps Chat choices on send-wired providers and filters unsupported Codex ChatGPT models', async () => {
    const { buildCatalogChatModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogChatModelChoices([
      connection({
        slug: 'codex-account',
        providerType: 'openai-codex',
        models: [{ id: 'gpt-5-codex' }, { id: 'gpt-5.5' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'gemini-account',
        providerType: 'gemini-cli',
        models: [{ id: 'gemini-2.5-pro' }],
        modelSource: 'fetched',
      }),
    ]);

    assert.deepEqual(
      choices.map((choice) => `${choice.connectionSlug}:${choice.model}:${choice.label}`),
      ['codex-account:gpt-5.5:GPT-5.5'],
    );
  });

  it('exposes enabled GitHub Copilot models through the shared model picker', async () => {
    const { buildCatalogChatModelChoices } = await importModelCatalogChoices();
    const copilot = connection({
      slug: 'github-copilot',
      providerType: 'github-copilot',
      defaultModel: 'gpt-5.4',
      enabledModelIds: ['gpt-5.4'],
      models: [{ id: 'gpt-5.4' }],
      modelSource: 'fetched',
    });

    assert.deepEqual(
      buildCatalogChatModelChoices([copilot]).map(({ connectionSlug, providerType, model }) => ({
        connectionSlug,
        providerType,
        model,
      })),
      [{ connectionSlug: 'github-copilot', providerType: 'github-copilot', model: 'gpt-5.4' }],
    );
  });

  it('exposes enabled xAI OAuth models through the shared model picker', async () => {
    const { buildCatalogChatModelChoices } = await importModelCatalogChoices();
    const xaiOAuth = connection({
      slug: 'xai-oauth',
      providerType: 'xai-oauth',
      defaultModel: 'grok-4.5',
      enabledModelIds: ['grok-4.5'],
      models: [{ id: 'grok-4.5' }],
      modelSource: 'fetched',
    });

    assert.deepEqual(
      buildCatalogChatModelChoices([xaiOAuth]).map(
        ({ connectionSlug, providerType, model }) => ({
          connectionSlug,
          providerType,
          model,
        }),
      ),
      [{ connectionSlug: 'xai-oauth', providerType: 'xai-oauth', model: 'grok-4.5' }],
    );
  });

  it('surfaces connectionName for api-key connections but never for OAuth ones', async () => {
    const { buildCatalogChatModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogChatModelChoices([
      connection({
        slug: 'openrouter',
        name: 'Openrouter',
        providerType: 'openai-compatible',
        models: [{ id: 'anthropic/claude-sonnet-5' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'claude-sub',
        name: 'person@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'claude-sonnet-4-5-20250929' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'codex-account',
        name: 'person@example.com',
        providerType: 'openai-codex',
        models: [{ id: 'gpt-5.5' }],
        modelSource: 'fetched',
      }),
    ]);

    const bySlug = new Map(choices.map((choice) => [choice.connectionSlug, choice]));
    assert.equal(bySlug.get('openrouter')?.connectionName, 'Openrouter');
    // OAuth connection.name embeds the account email — it must never reach
    // the picker's ChatModelChoice (PR-CHAT-CHROME-FIX-0).
    assert.equal(bySlug.get('claude-sub')?.connectionName, undefined);
    assert.equal(bySlug.get('codex-account')?.connectionName, undefined);
    for (const choice of choices) {
      assert.ok(!(choice.connectionName ?? '').includes('@example.com'));
    }
  });

  it('keeps Daily Review runtime-wired model choices while using leak-safe duplicate labels', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();

    const options = buildCatalogDailyReviewModelOptions([
      connection({
        slug: 'claude-work',
        name: 'person@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'shared-model', displayName: 'Shared Model' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'claude-home',
        name: 'private@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'shared-model', displayName: 'Shared Model' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'gemini-account',
        name: 'user@example.com',
        providerType: 'gemini-cli',
        models: [{ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'deepseek-api',
        name: 'DeepSeek account',
        providerType: 'deepseek',
        models: [{ id: 'deepseek-v4-flash' }],
        modelSource: 'fetched',
      }),
    ], '');

    assert.deepEqual(options, [
      ['claude-work::shared-model', 'Shared Model · Claude Subscription (Pro / Max OAuth) · claude-work'],
      ['claude-home::shared-model', 'Shared Model · Claude Subscription (Pro / Max OAuth) · claude-home'],
      ['deepseek-api::deepseek-v4-flash', 'DeepSeek V4 Flash'],
    ]);
    assert.ok(options.every(([value]) => !value.startsWith('gemini-account::')));
    assert.ok(options.every(([, label]) => !label.includes('@example.com')));
  });

  it('recovers a missing saved Daily Review model key as a raw option', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();

    const options = buildCatalogDailyReviewModelOptions([
      connection({
        slug: 'openai-api',
        providerType: 'openai',
        models: [{ id: 'gpt-4o-mini' }],
        modelSource: 'fetched',
      }),
    ], 'openai-api::custom-model');

    assert.deepEqual(options, [
      ['openai-api::gpt-4o-mini', 'GPT-4o mini'],
      ['openai-api::custom-model', 'custom-model · 当前不可用'],
    ]);
  });

  it('keeps the current Daily Review value visible when its connection is unavailable', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([
        connection({
          slug: 'openai-api',
          name: 'person@example.com',
          providerType: 'openai',
          enabled: false,
          models: [{ id: 'gpt-4o-mini' }],
          modelSource: 'fetched',
        }),
      ], 'openai-api::gpt-4o-mini'),
      [['openai-api::gpt-4o-mini', 'gpt-4o-mini · openai-api · 当前不可用']],
    );

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([], 'deleted-openai::gpt-4o-mini'),
      [['deleted-openai::gpt-4o-mini', 'gpt-4o-mini · deleted-openai · 当前不可用']],
    );

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([
        connection({
          slug: 'openai-api',
          providerType: 'openai',
          models: [{ id: 'gpt-4o-mini' }],
          modelSource: 'fetched',
        }),
      ], 'openai-api::custom-model'),
      [
        ['openai-api::gpt-4o-mini', 'GPT-4o mini'],
        ['openai-api::custom-model', 'custom-model · 当前不可用'],
      ],
    );
  });

  it('derives new-connection defaults from catalog recommendations', async () => {
    const { buildCatalogRecommendedDefaultModel } = await importModelCatalogChoices();

    assert.equal(buildCatalogRecommendedDefaultModel('deepseek'), 'deepseek-v4-flash');
    assert.equal(buildCatalogRecommendedDefaultModel('siliconflow'), 'moonshotai/Kimi-K2.6');
    assert.equal(buildCatalogRecommendedDefaultModel('vercel'), 'anthropic/claude-opus-4.8');
    assert.equal(buildCatalogRecommendedDefaultModel('zenmux'), 'moonshotai/kimi-k2.5');
    assert.equal(buildCatalogRecommendedDefaultModel('opencode'), 'gpt-5.5');
    assert.equal(buildCatalogRecommendedDefaultModel('opencode-go'), 'minimax-m3');
    assert.equal(buildCatalogRecommendedDefaultModel('openai-compatible'), '');
  });

  it('keeps ZenMux creator/model ids exact across add, detail, and Chat selection helpers', async () => {
    const {
      buildCatalogChatModelChoices,
      buildCatalogModelChoices,
      pickCatalogDefaultChatModel,
    } = await importModelCatalogChoices();
    const zenmux = connection({
      slug: 'zenmux',
      name: 'ZenMux',
      providerType: 'zenmux',
      defaultModel: 'moonshotai/kimi-k2.5',
      models: [
        { id: 'moonshotai/kimi-k2.5', displayName: 'Kimi K2.5' },
        { id: 'moonshotai/kimi-k2.7-code', displayName: 'Kimi K2.7 Code' },
      ],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
    });

    assert.deepEqual(
      buildCatalogModelChoices(zenmux).map(({ id, source, isDefault }) => ({ id, source, isDefault })),
      [
        { id: 'moonshotai/kimi-k2.5', source: 'provider_api', isDefault: true },
        { id: 'moonshotai/kimi-k2.7-code', source: 'provider_api', isDefault: false },
      ],
    );
    assert.deepEqual(
      buildCatalogChatModelChoices([zenmux]).map(({ connectionSlug, providerType, model }) => ({
        connectionSlug,
        providerType,
        model,
      })),
      [
        { connectionSlug: 'zenmux', providerType: 'zenmux', model: 'moonshotai/kimi-k2.5' },
        { connectionSlug: 'zenmux', providerType: 'zenmux', model: 'moonshotai/kimi-k2.7-code' },
      ],
    );
    assert.deepEqual(pickCatalogDefaultChatModel(zenmux), {
      llmConnectionSlug: 'zenmux',
      model: 'moonshotai/kimi-k2.5',
    });
  });

  it('picks the new-chat default from the normalized catalog default entry', async () => {
    const { pickCatalogDefaultChatModel } = await importModelCatalogChoices();

    assert.deepEqual(
      pickCatalogDefaultChatModel(connection({
        slug: 'openai-api',
        providerType: 'openai',
        defaultModel: '  gpt-4o-mini  ',
        models: [{ id: 'gpt-4o-mini' }],
        modelSource: 'fetched',
      })),
      {
        llmConnectionSlug: 'openai-api',
        model: 'gpt-4o-mini',
      },
    );
  });

  it('keeps Settings model choices as catalog entries with missing-default state', async () => {
    const { buildCatalogModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogModelChoices(connection({
      slug: 'openai-api',
      providerType: 'openai',
      defaultModel: 'gpt-5',
      models: [{ id: 'gpt-4o-mini' }],
      modelSource: 'fetched',
    }));

    assert.deepEqual(
      choices.map((choice) => ({
        id: choice.id,
        displayName: choice.displayName,
        recommendedRank: choice.recommendedRank,
        lifecycle: choice.lifecycle,
        docsUrl: choice.docsUrl,
        availability: choice.availability,
        unavailableReason: choice.unavailableReason,
        isDefault: choice.isDefault,
      })),
      [
        {
          id: 'gpt-5',
          displayName: 'GPT-5',
          recommendedRank: 5,
          lifecycle: 'active',
          docsUrl: 'https://platform.openai.com/docs/models',
          availability: 'blocked',
          unavailableReason: 'not_in_live_list',
          isDefault: true,
        },
        {
          id: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          recommendedRank: undefined,
          lifecycle: 'active',
          docsUrl: 'https://platform.openai.com/docs/models',
          availability: 'available',
          unavailableReason: 'none',
          isDefault: false,
        },
      ],
    );
  });

  it('derives static fallback counts from catalog entries', async () => {
    const { buildCatalogModelChoices } = await importModelCatalogChoices();

    const choices = buildCatalogModelChoices(connection({
      slug: 'deepseek-api',
      providerType: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      modelSource: 'fallback',
    }));

    assert.equal(choices.filter((choice) => choice.source === 'static_catalog').length, 4);
  });
});
