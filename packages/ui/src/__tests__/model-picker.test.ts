import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelPickerGroups,
  filterModelPickerOption,
  modelPickerHasCatalogMatches,
  type ModelPickerOption,
} from '../model-picker-internals.js';
import type { ModelMenuGroup } from '../chat-model-helpers.js';

const groups: ModelMenuGroup[] = [
  {
    connectionSlug: 'openai-main',
    providerType: 'openai',
    heading: 'OpenAI main',
    choices: [
      { connectionSlug: 'openai-main', providerType: 'openai', model: 'gpt-5', label: 'GPT-5' },
      { connectionSlug: 'openai-main', providerType: 'openai', model: 'o3-mini', label: 'o3 mini' },
    ],
  },
  {
    connectionSlug: 'anthropic-team',
    providerType: 'anthropic',
    heading: 'Claude Team',
    choices: [
      { connectionSlug: 'anthropic-team', providerType: 'anthropic', model: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
    ],
  },
];

describe('ModelPicker filtering', () => {
  it('matches model labels and group headings with the same picker option data', () => {
    const pickerGroups = buildModelPickerGroups(groups);
    const options = pickerGroups.flatMap((group) => group.items);

    assert.deepEqual(
      options.filter((option) => filterModelPickerOption(option, 'sonnet')).map((option) => option.value),
      ['anthropic-team:claude-sonnet-4'],
    );
    assert.deepEqual(
      options.filter((option) => filterModelPickerOption(option, 'openai')).map((option) => option.value),
      ['openai-main:gpt-5', 'openai-main:o3-mini'],
    );
  });

  it('keeps a pinned item visible without counting it as a catalog match', () => {
    const pickerGroups = buildModelPickerGroups(groups, { value: '', label: '未设置' });
    const pinned = pickerGroups.flatMap((group) => group.items).find((option) => option.pinned) as ModelPickerOption;

    assert.equal(filterModelPickerOption(pinned, 'no-such-model'), true);
    assert.equal(modelPickerHasCatalogMatches([pinned]), false);
  });

  it('reports an empty state when no option matches', () => {
    const options = buildModelPickerGroups(groups).flatMap((group) => group.items);
    const visible = options.filter((option) => filterModelPickerOption(option, 'no-such-model'));

    assert.equal(modelPickerHasCatalogMatches(visible), false);
  });
});
