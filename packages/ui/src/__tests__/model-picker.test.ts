import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelPickerOptions,
  buildModelPickerProviderTypes,
} from '../model-picker-internals.js';
import type { ModelMenuGroup } from '../chat-model-helpers.js';

const groups: ModelMenuGroup[] = [
  {
    connectionSlug: 'anthropic-team',
    providerType: 'anthropic',
    heading: 'Anthropic Team',
    choices: [
      {
        connectionSlug: 'anthropic-team',
        providerType: 'anthropic',
        providerLabel: 'Anthropic',
        model: 'claude-sonnet-4',
        label: 'Claude Sonnet 4',
        isDefault: true,
        thinkingLevels: [],
      },
    ],
  },
  {
    connectionSlug: 'openai-main',
    providerType: 'openai',
    heading: 'OpenAI',
    choices: [
      {
        connectionSlug: 'openai-main',
        providerType: 'openai',
        providerLabel: 'OpenAI',
        model: 'gpt-5',
        label: 'GPT-5',
        isDefault: true,
        thinkingLevels: [],
      },
      {
        connectionSlug: 'openai-main',
        providerType: 'openai',
        providerLabel: 'OpenAI',
        model: 'o3-mini',
        label: 'o3-mini',
        isDefault: false,
        thinkingLevels: [],
      },
    ],
  },
];

describe('ModelPicker option shaping', () => {
  it('leaves a catalog with no choices empty', () => {
    assert.deepEqual(buildModelPickerOptions([]), []);
  });

  it('maps each provider group to public Astryx sections', () => {
    assert.deepEqual(buildModelPickerOptions(groups), [
      {
        type: 'section',
        title: 'Anthropic Team',
        options: [
          {
            value: 'anthropic-team:claude-sonnet-4',
            label: 'Claude Sonnet 4',
          },
        ],
      },
      {
        type: 'section',
        title: 'OpenAI',
        options: [
          { value: 'openai-main:gpt-5', label: 'GPT-5' },
          { value: 'openai-main:o3-mini', label: 'o3-mini' },
        ],
      },
    ]);
  });

  it('models an unknown current value as an ordinary option before the catalog', () => {
    assert.deepEqual(
      buildModelPickerOptions(groups, {
        value: 'legacy:model-that-is-no-longer-listed',
        label: 'model-that-is-no-longer-listed',
        providerType: 'openai-compatible',
      }),
      [
        {
          value: 'legacy:model-that-is-no-longer-listed',
          label: 'model-that-is-no-longer-listed',
        },
        { type: 'divider' },
        ...buildModelPickerOptions(groups),
      ],
    );
  });

  it('keeps an empty-value choice as an ordinary searchable option', () => {
    assert.deepEqual(buildModelPickerOptions([], { value: '', label: '未设置' }), [
      { value: '', label: '未设置' },
    ]);
  });

  it('maps provider marks by public option value without adding private Selector fields', () => {
    assert.deepEqual(
      [...buildModelPickerProviderTypes(groups, {
        value: 'legacy:model',
        label: 'Legacy model',
        providerType: 'openai-compatible',
      })],
      [
        ['legacy:model', 'openai-compatible'],
        ['anthropic-team:claude-sonnet-4', 'anthropic'],
        ['openai-main:gpt-5', 'openai'],
        ['openai-main:o3-mini', 'openai'],
      ],
    );
  });
});
