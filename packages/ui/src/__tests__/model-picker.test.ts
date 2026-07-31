import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelPickerOptions,
  createModelSelectionGuard,
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
        model: 'claude-sonnet-4',
        label: 'Claude Sonnet 4',
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
        model: 'gpt-5',
        label: 'GPT-5',
      },
      {
        connectionSlug: 'openai-main',
        providerType: 'openai',
        model: 'o3-mini',
        label: 'o3-mini',
      },
    ],
  },
];

describe('ModelPicker option shaping', () => {
  it('leaves a catalog with no choices empty', () => {
    assert.deepEqual(buildModelPickerOptions([]), []);
  });

  it('maps each provider group to an Astryx section without losing provider identity', () => {
    assert.deepEqual(buildModelPickerOptions(groups), [
      {
        type: 'section',
        title: 'Anthropic Team',
        options: [
          {
            value: 'anthropic-team:claude-sonnet-4',
            label: 'Claude Sonnet 4',
            providerType: 'anthropic',
          },
        ],
      },
      {
        type: 'section',
        title: 'OpenAI',
        options: [
          { value: 'openai-main:gpt-5', label: 'GPT-5', providerType: 'openai' },
          { value: 'openai-main:o3-mini', label: 'o3-mini', providerType: 'openai' },
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
          providerType: 'openai-compatible',
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
});

describe('model selection action', () => {
  it('accepts one async selection at a time and releases after it settles', async () => {
    const guard = createModelSelectionGuard();
    let release: (() => void) | undefined;
    const calls: string[] = [];
    const action = async (value: string) => {
      calls.push(value);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const first = guard.run('first', action);
    const duplicate = await guard.run('duplicate', action);
    assert.equal(duplicate, false);
    assert.deepEqual(calls, ['first']);

    release?.();
    assert.equal(await first, true);

    const next = guard.run('next', async (value) => {
      calls.push(value);
    });
    assert.equal(await next, true);
    assert.deepEqual(calls, ['first', 'next']);
  });
});
