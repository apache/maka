import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection, SubagentPreset } from '@maka/core';
import {
  subagentPresetAvailability,
  suggestSubagentPresetId,
} from '../../renderer/settings/subagent-preset-presentation.js';

function connection(input: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'deepseek',
    name: 'DeepSeek',
    providerType: 'deepseek',
    defaultModel: 'deepseek-chat',
    enabled: true,
    enabledModelIds: ['deepseek-chat'],
    createdAt: 0,
    updatedAt: 0,
    ...input,
  };
}

function preset(input: Partial<SubagentPreset> = {}): SubagentPreset {
  return {
    id: 'fast-reader',
    name: 'Fast reader',
    description: 'Read large repositories quickly',
    profile: 'local_read',
    connectionSlug: 'deepseek',
    model: 'deepseek-chat',
    enabled: true,
    ...input,
  };
}

describe('subagentPresetAvailability', () => {
  it('distinguishes disabled and broken model routes from usable presets', () => {
    assert.deepEqual(subagentPresetAvailability(preset(), [connection()]), {
      kind: 'available',
      tone: 'success',
    });
    assert.equal(subagentPresetAvailability(preset({ enabled: false }), []).kind, 'disabled');
    assert.equal(subagentPresetAvailability(preset(), []).kind, 'missing_connection');
    assert.equal(
      subagentPresetAvailability(preset(), [connection({ enabled: false })]).kind,
      'connection_disabled',
    );
    assert.equal(
      subagentPresetAvailability(preset({ model: 'deepseek-reasoner' }), [connection()]).kind,
      'model_disabled',
    );
  });
});

describe('suggestSubagentPresetId', () => {
  it('creates stable safe ids and resolves collisions', () => {
    assert.equal(suggestSubagentPresetId('Fast Code Reader', new Set()), 'fast-code-reader');
    assert.equal(suggestSubagentPresetId('快速阅读', new Set()), 'subagent');
    assert.equal(
      suggestSubagentPresetId('Fast Code Reader', new Set(['fast-code-reader', 'fast-code-reader-2'])),
      'fast-code-reader-3',
    );
  });
});
