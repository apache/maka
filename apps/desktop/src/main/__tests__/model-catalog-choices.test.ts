import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { build } from 'esbuild';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionSummary } from '@maka/core/session';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import {
  normalizeActiveChatModel,
  pickNewChatModel,
} from '../../renderer/shell-chat-model-selection.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

type ModelCatalogChoicesModule = {
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
          slug: 'codex-work',
          name: 'person@example.com',
          providerType: 'openai-codex',
          models: [{ id: 'shared-model', displayName: 'Shared Model' }],
          modelSource: 'fetched',
        }),
        connection({
          slug: 'codex-home',
          name: 'private@example.com',
          providerType: 'openai-codex',
          models: [{ id: 'shared-model', displayName: 'Shared Model' }],
          modelSource: 'fetched',
        }),
      ],
      '',
    );
    assert.deepEqual(options, [
      [
        'codex-work::shared-model',
        'Shared Model · OpenAI OAuth (ChatGPT / Codex) · codex-work',
      ],
      [
        'codex-home::shared-model',
        'Shared Model · OpenAI OAuth (ChatGPT / Codex) · codex-home',
      ],
    ]);
    assert.ok(options.every(([, label]) => !label.includes('@')));

    assert.deepEqual(
      buildCatalogDailyReviewModelOptions([], 'deleted-openai::gpt-4o-mini'),
      [['deleted-openai::gpt-4o-mini', 'gpt-4o-mini · deleted-openai · 当前不可用']],
    );
  });
});
