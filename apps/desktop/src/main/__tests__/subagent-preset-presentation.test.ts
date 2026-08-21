import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SubagentPreset } from '@maka/core/subagent-settings';
import {
  isSelectableSubagentConnection,
  subagentPresetAvailability,
} from '../../renderer/settings/subagent-preset-presentation.js';

const preset: SubagentPreset = {
  id: 'worker',
  name: 'Worker',
  description: '',
  profile: 'local_read',
  connectionSlug: 'claude-subscription',
  model: 'claude-opus-5',
  enabled: true,
};

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'claude-subscription',
    name: 'Claude Subscription',
    providerType: 'claude-subscription',
    defaultModel: 'claude-opus-5',
    enabledModelIds: ['claude-opus-5'],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('a preset routed through a retained retired connection reads retired, not available', () => {
  // The retained row stays enabled, so the enabled/model checks alone would
  // badge this preset 可用 while every run through it is refused.
  assert.deepEqual(subagentPresetAvailability(preset, [connection()]), {
    kind: 'provider_retired',
    tone: 'destructive',
  });
});

test('retirement outranks disabled: there is no switch that repairs it', () => {
  assert.deepEqual(subagentPresetAvailability(preset, [connection({ enabled: false })]), {
    kind: 'provider_retired',
    tone: 'destructive',
  });
});

test('the editor cannot route a preset through a retained retired connection', () => {
  // The list badge alone was not enough: the editor's usableConnections /
  // validConnection / connectionOptions all consumed `enabled`, so a retained
  // retired row could still be selected and saved into a preset the runtime
  // admission then refuses as provider_retired.
  assert.equal(isSelectableSubagentConnection(connection()), false);
  assert.equal(isSelectableSubagentConnection(connection({ enabled: false })), false);
  assert.equal(
    isSelectableSubagentConnection(connection({ slug: 'openai', providerType: 'openai' })),
    true,
  );
  assert.equal(
    isSelectableSubagentConnection(
      connection({ slug: 'openai', providerType: 'openai', enabled: false }),
    ),
    false,
  );
});

test('a live connection with the model enabled stays available', () => {
  const live = connection({
    slug: 'openai',
    providerType: 'openai',
    enabledModelIds: ['gpt-5-mini'],
  });
  assert.deepEqual(
    subagentPresetAvailability({ ...preset, connectionSlug: 'openai', model: 'gpt-5-mini' }, [
      live,
    ]),
    { kind: 'available', tone: 'success' },
  );
});
