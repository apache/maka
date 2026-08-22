import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { projectRuntimeHostModelChoices } from '../runtime-host-onboarding.js';

function catalog(connections: ConnectionCatalogSnapshot['connections']): ConnectionCatalogSnapshot {
  return { revision: 1, defaultTarget: null, connections };
}

const live = {
  connectionId: 'live-id',
  revision: 1,
  slug: 'openai',
  name: 'OpenAI',
  providerType: 'openai',
  enabled: true,
  enabledModelIds: ['gpt-5-mini'],
  models: [{ id: 'gpt-5-mini', displayName: 'GPT-5 Mini' }],
} as const;

describe('projectRuntimeHostModelChoices', () => {
  test('a retained retired connection contributes no /model choices', () => {
    // Retirement keeps the connection enabled so its credential stays visible
    // and deletable. Filtering on `enabled` alone listed its models here and
    // only refused them after the user picked one.
    const choices = projectRuntimeHostModelChoices(
      catalog([
        live,
        {
          ...live,
          connectionId: 'retired-id',
          slug: 'claude-subscription',
          name: 'Claude Subscription',
          providerType: 'claude-subscription',
          enabledModelIds: ['claude-opus-5'],
          models: [{ id: 'claude-opus-5' }],
        },
      ]),
    );
    assert.deepEqual(
      choices.map(({ connectionSlug, model }) => ({ connectionSlug, model })),
      [{ connectionSlug: 'openai', model: 'gpt-5-mini' }],
    );
  });

  test('a disabled connection is also excluded, so the filter is not over-broad', () => {
    const choices = projectRuntimeHostModelChoices(
      catalog([live, { ...live, connectionId: 'off-id', slug: 'openai-off', enabled: false }]),
    );
    assert.deepEqual(
      choices.map(({ connectionSlug }) => connectionSlug),
      ['openai'],
    );
  });

  test('projects the catalog display name onto each model choice', () => {
    const choices = projectRuntimeHostModelChoices(catalog([live]));

    assert.equal(choices[0]?.displayName, 'GPT-5 Mini');
  });
});
