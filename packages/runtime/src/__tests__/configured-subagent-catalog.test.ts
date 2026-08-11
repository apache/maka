import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../test-helpers.js';
import { createDefaultSettings } from '@maka/core/settings';
import { type LlmConnection } from '@maka/core/llm-connections';
import { createConfiguredSubagentCatalog } from '../configured-subagent-catalog.js';

const connection: LlmConnection = {
  slug: 'worker-provider',
  name: 'Worker provider',
  providerType: 'openai',
  defaultModel: 'gpt-5-mini',
  enabledModelIds: ['gpt-5-mini'],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

describe('configured subagent catalog', () => {
  test('lists availability and resolves only enabled user-approved targets', async () => {
    const settings = createDefaultSettings();
    settings.subagents.presets = [
      {
        id: 'fast-reader',
        name: 'Fast reader',
        description: 'Cheap scans',
        profile: 'local_read',
        connectionSlug: connection.slug,
        model: 'gpt-5-mini',
        enabled: true,
      },
      {
        id: 'missing-model',
        name: 'Missing model',
        description: '',
        profile: 'local_read',
        connectionSlug: connection.slug,
        model: 'gpt-5-nano',
        enabled: true,
      },
    ];
    const catalog = createConfiguredSubagentCatalog({
      getPresets: async () => settings.subagents.presets,
      getConnection: async (slug) => (slug === connection.slug ? connection : null),
    });

    expect(
      (await catalog.list()).map(({ id, availability }) => ({
        id,
        availability,
      })),
    ).toEqual([
      { id: 'fast-reader', availability: { status: 'available' } },
      {
        id: 'missing-model',
        availability: { status: 'unavailable', reason: 'model_disabled' },
      },
    ]);
    expect(await catalog.resolve('fast-reader')).toEqual(settings.subagents.presets[0]);
    await assert.rejects(catalog.resolve('missing-model'), /model_disabled/);
    await assert.rejects(catalog.resolve('invented'), /Call agent_list/);
  });
});
