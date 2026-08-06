import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { build } from 'esbuild';
import type { ChatModelChoice, LlmConnection, SessionSummary } from '@maka/core';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import { buildConnectionModelCatalogEntries } from '@maka/core/model-catalog';
import {
  normalizeActiveChatModel,
  pickNewChatModel,
} from '../../renderer/shell-chat-model-selection.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

type ModelCatalogChoicesModule = {
  buildCatalogRecommendedDefaultModel(providerType: LlmConnection['providerType']): string;
  buildCatalogDailyReviewModelOptions(
    connections: readonly LlmConnection[],
    currentModelKey: string,
  ): Array<readonly [string, string]>;
};

let modulePromise: Promise<ModelCatalogChoicesModule> | undefined;

function importModelCatalogChoices(): Promise<ModelCatalogChoicesModule> {
  return (modulePromise ??= (async () => {
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
    return (await import(pathToFileURL(outfile).href)) as ModelCatalogChoicesModule;
  })());
}

function connection(
  overrides: Partial<LlmConnection> & Pick<LlmConnection, 'slug' | 'providerType'>,
): LlmConnection {
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

function choiceIdentity(choice: {
  connectionSlug: string;
  providerType: string;
  model: string;
}): string {
  return `${choice.connectionSlug}:${choice.providerType}:${choice.model}`;
}

describe('model catalog picker helpers', () => {
  it('keeps the first offered Codex model when replacing an unsupported stored model', () => {
    const choices: ChatModelChoice[] = [
      {
        connectionSlug: 'codex-account',
        providerType: 'openai-codex',
        providerLabel: 'OpenAI OAuth',
        model: 'first-offered',
        label: 'First offered',
        isDefault: false,
        thinkingLevels: [],
      },
      {
        connectionSlug: 'codex-account',
        providerType: 'openai-codex',
        providerLabel: 'OpenAI OAuth',
        model: 'later-default',
        label: 'Later default',
        isDefault: true,
        thinkingLevels: [],
      },
    ];
    const session: SessionSummary = {
      id: 'session-1',
      name: 'Legacy Codex session',
      isFlagged: false,
      isArchived: false,
      labels: [],
      hasUnread: false,
      status: 'active',
      backend: 'ai-sdk',
      llmConnectionSlug: 'codex-account',
      connectionLocked: true,
      model: 'gpt-5-codex',
      permissionMode: 'ask',
    };

    assert.equal(
      normalizeActiveChatModel(
        session,
        connection({
          slug: 'codex-account',
          providerType: 'openai-codex',
          defaultModel: 'gpt-5-codex',
        }),
        choices,
      ),
      'first-offered',
    );
  });

  it('uses the first offered model when no user or workspace preference exists', () => {
    assert.deepEqual(
      pickNewChatModel({
        pending: null,
        catalogDefault: undefined,
        choices: [
          {
            connectionSlug: 'opencode-free',
            providerType: 'opencode-free',
            providerLabel: 'OpenCode Zen',
            model: 'mimo-v2.5-free',
            label: 'MiMo V2.5 Free',
            isDefault: true,
            thinkingLevels: [],
          },
        ],
      }),
      { llmConnectionSlug: 'opencode-free', model: 'mimo-v2.5-free' },
    );
  });

  it('uses the readiness-checked activation candidate before an unverified first choice', () => {
    assert.deepEqual(
      pickNewChatModel({
        pending: null,
        activationCandidate: {
          llmConnectionSlug: 'ready-second',
          model: 'ready-model',
        },
        catalogDefault: undefined,
        choices: [
          {
            connectionSlug: 'missing-key-first',
            providerType: 'anthropic',
            providerLabel: 'Anthropic',
            model: 'unusable-model',
            label: 'Unusable',
            isDefault: true,
            thinkingLevels: [],
          },
          {
            connectionSlug: 'ready-second',
            providerType: 'opencode-free',
            providerLabel: 'OpenCode Zen',
            model: 'ready-model',
            label: 'Ready',
            isDefault: true,
            thinkingLevels: [],
          },
        ],
      }),
      { llmConnectionSlug: 'ready-second', model: 'ready-model' },
    );
  });

  it('offers the normalized fallback for legacy Codex-only inventory', () => {
    const choices = buildChatModelChoices([
      connection({
        slug: 'codex-account',
        providerType: 'openai-codex',
        defaultModel: 'gpt-5-codex',
        enabledModelIds: ['gpt-5-codex'],
        models: [{ id: 'gpt-5-codex' }],
      }),
    ]);

    assert.deepEqual(choices.map(choiceIdentity), [
      'codex-account:openai-codex:gpt-5.6-sol',
    ]);
  });

  it('projects enabled models across wired providers without collapsing provider identities', () => {
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
      buildChatModelChoices([openrouter]).map((choice) => choice.model),
      ['openrouter/auto', 'anthropic/claude-sonnet-4.6'],
    );
    assert.deepEqual(
      buildConnectionModelCatalogEntries({ connection: openrouter }).map((choice) => choice.id),
      ['openrouter/auto', 'anthropic/claude-sonnet-4.6', 'openai/gpt-5.5'],
    );

    const choices = buildChatModelChoices([
      connection({
        slug: 'ollama-cloud',
        providerType: 'ollama-cloud',
        defaultModel: 'qwen3.5:397b',
        models: [{ id: 'qwen3.5:397b' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'ollama-local',
        providerType: 'ollama',
        defaultModel: 'qwen3.5:cloud',
        models: [{ id: 'qwen3.5' }, { id: 'qwen3.5:cloud' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'github-copilot',
        providerType: 'github-copilot',
        models: [{ id: 'gpt-5.4' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'xai-oauth',
        providerType: 'xai-oauth',
        models: [{ id: 'grok-4.5' }],
        modelSource: 'fetched',
      }),
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
    assert.deepEqual(choices.map(choiceIdentity), [
      'ollama-cloud:ollama-cloud:qwen3.5:397b',
      'ollama-local:ollama:qwen3.5',
      'ollama-local:ollama:qwen3.5:cloud',
      'github-copilot:github-copilot:gpt-5.4',
      'xai-oauth:xai-oauth:grok-4.5',
      'codex-account:openai-codex:gpt-5.5',
    ]);
  });

  it('keeps API connection labels while redacting OAuth account identities', () => {
    const choices = buildChatModelChoices([
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
        name: 'private@example.com',
        providerType: 'openai-codex',
        models: [{ id: 'gpt-5.5' }],
        modelSource: 'fetched',
      }),
    ]);
    const bySlug = new Map(choices.map((choice) => [choice.connectionSlug, choice]));
    assert.equal(bySlug.get('openrouter')?.connectionName, 'Openrouter');
    assert.equal(bySlug.get('claude-sub')?.connectionName, undefined);
    assert.equal(bySlug.get('codex-account')?.connectionName, undefined);
    assert.ok(choices.every((choice) => !(choice.connectionName ?? '').includes('@')));
  });

  it('keeps Daily Review choices enabled, private, and recoverable', async () => {
    const { buildCatalogDailyReviewModelOptions } = await importModelCatalogChoices();
    const openrouter = connection({
      slug: 'openrouter-main',
      providerType: 'openrouter',
      enabledModelIds: ['openrouter/auto'],
      models: [{ id: 'openrouter/auto' }, { id: 'openai/gpt-5.5' }],
      modelSource: 'fetched',
    });
    assert.deepEqual(
      buildCatalogDailyReviewModelOptions(
        [openrouter],
        'openrouter-main::openai/gpt-5.5',
      ),
      [
        ['openrouter-main::openrouter/auto', 'Auto Router'],
        ['openrouter-main::openai/gpt-5.5', 'GPT-5.5 · 当前不可用'],
      ],
    );

    const options = buildCatalogDailyReviewModelOptions(
      [
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
          providerType: 'gemini-cli',
          models: [{ id: 'gemini-2.5-pro' }],
          modelSource: 'fetched',
        }),
        connection({
          slug: 'deepseek-api',
          providerType: 'deepseek',
          models: [{ id: 'deepseek-v4-flash' }],
          modelSource: 'fetched',
        }),
      ],
      '',
    );
    assert.deepEqual(options, [
      [
        'claude-work::shared-model',
        'Shared Model · Claude Subscription (Pro / Max OAuth) · claude-work',
      ],
      [
        'claude-home::shared-model',
        'Shared Model · Claude Subscription (Pro / Max OAuth) · claude-home',
      ],
      ['deepseek-api::deepseek-v4-flash', 'DeepSeek V4 Flash'],
    ]);
    assert.ok(options.every(([, label]) => !label.includes('@')));

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([], 'deleted-openai::gpt-4o-mini'),
      [['deleted-openai::gpt-4o-mini', 'gpt-4o-mini · deleted-openai · 当前不可用']],
    );
    assert.deepEqual(
      buildCatalogDailyReviewModelOptions(
        [
          connection({
            slug: 'openai-api',
            providerType: 'openai',
            models: [{ id: 'gpt-4o-mini' }],
            modelSource: 'fetched',
          }),
        ],
        'openai-api::custom-model',
      ),
      [
        ['openai-api::gpt-4o-mini', 'GPT-4o mini'],
        ['openai-api::custom-model', 'custom-model · 当前不可用'],
      ],
    );
  });

  it('derives canonical defaults, exact provider ids, and missing-default state', async () => {
    const { buildCatalogRecommendedDefaultModel } = await importModelCatalogChoices();
    assert.deepEqual(
      [
        'deepseek',
        'siliconflow',
        'vercel',
        'zenmux',
        'opencode',
        'opencode-go',
        'openai-compatible',
      ].map((providerType) =>
        buildCatalogRecommendedDefaultModel(providerType as LlmConnection['providerType']),
      ),
      [
        'deepseek-v4-flash',
        'moonshotai/Kimi-K2.6',
        'anthropic/claude-opus-4.8',
        'moonshotai/kimi-k2.5',
        'gpt-5.5',
        'minimax-m3',
        '',
      ],
    );

    const zenmux = connection({
      slug: 'zenmux',
      providerType: 'zenmux',
      defaultModel: 'moonshotai/kimi-k2.5',
      models: [
        { id: 'moonshotai/kimi-k2.5' },
        { id: 'moonshotai/kimi-k2.7-code' },
      ],
      modelSource: 'fetched',
    });
    assert.deepEqual(
      buildConnectionModelCatalogEntries({ connection: zenmux }).map(({ id, source, isDefault }) => ({
        id,
        source,
        isDefault,
      })),
      [
        { id: 'moonshotai/kimi-k2.5', source: 'provider_api', isDefault: true },
        { id: 'moonshotai/kimi-k2.7-code', source: 'provider_api', isDefault: false },
      ],
    );
    assert.deepEqual(buildChatModelChoices([zenmux]).map(choiceIdentity), [
      'zenmux:zenmux:moonshotai/kimi-k2.5',
      'zenmux:zenmux:moonshotai/kimi-k2.7-code',
    ]);
    const missingDefault = buildConnectionModelCatalogEntries({
      connection: connection({
        slug: 'openai-api',
        providerType: 'openai',
        defaultModel: 'gpt-5',
        models: [{ id: 'gpt-4o-mini' }],
        modelSource: 'fetched',
      }),
    });
    assert.deepEqual(
      missingDefault.map(({ id, availability, unavailableReason, isDefault }) => ({
        id,
        availability,
        unavailableReason,
        isDefault,
      })),
      [
        {
          id: 'gpt-5',
          availability: 'blocked',
          unavailableReason: 'not_in_live_list',
          isDefault: true,
        },
        {
          id: 'gpt-4o-mini',
          availability: 'available',
          unavailableReason: 'none',
          isDefault: false,
        },
      ],
    );
    assert.equal(
      buildConnectionModelCatalogEntries({
        connection: connection({
          slug: 'deepseek-api',
          providerType: 'deepseek',
          defaultModel: 'deepseek-v4-flash',
          modelSource: 'fallback',
        }),
      }).filter((choice) => choice.source === 'static_catalog').length,
      4,
    );
  });
});
