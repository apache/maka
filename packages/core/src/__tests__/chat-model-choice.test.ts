import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatModelChoices } from '../chat-model-choice.js';
import type { LlmConnection } from '../llm-connections.js';

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'openai-main',
    name: 'Work API',
    providerType: 'openai',
    defaultModel: 'gpt-5.5',
    enabled: true,
    enabledModelIds: ['gpt-5.5'],
    models: [{ id: 'gpt-5.5' }, { id: 'gpt-4o' }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('projects only enabled chat models with display, default, and thinking metadata', () => {
  assert.deepEqual(buildChatModelChoices([connection()]), [
    {
      connectionSlug: 'openai-main',
      providerType: 'openai',
      providerLabel: 'OpenAI',
      model: 'gpt-5.5',
      label: 'GPT-5.5',
      connectionName: 'Work API',
      isDefault: true,
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
    },
  ]);
});

test('redacts OAuth names and normalizes legacy Codex inventory', () => {
  const [choice] = buildChatModelChoices([
    connection({
      slug: 'codex-account',
      name: 'private@example.com',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5-codex',
      enabledModelIds: ['gpt-5-codex'],
      models: [{ id: 'gpt-5-codex' }],
    }),
  ]);
  assert.equal(choice?.model, 'gpt-5.6-sol');
  assert.equal(choice?.providerLabel, 'OpenAI OAuth');
  assert.equal(choice?.connectionName, undefined);
  assert.equal(choice?.isDefault, true);
});
