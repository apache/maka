import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionSummary } from '@maka/core/session';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import {
  normalizeActiveChatModel,
  pickNewChatModel,
} from '../../renderer/shell-chat-model-selection.js';

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

});
