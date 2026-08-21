import { describe, test } from 'node:test';
import { expect } from './test-helpers.js';
import { createDefaultSettings, mergeSettings, normalizeSettings } from '../settings.js';

test('normalizes user-approved subagent presets without widening the catalog', () => {
  const normalized = normalizeSettings({
    subagents: {
      presets: [
        {
          id: 'fast-reader',
          name: ' Fast reader ',
          description: ' Cheap repository scans ',
          profile: 'local_read',
          connectionSlug: 'openai-main',
          model: 'gpt-5-mini',
          thinkingLevel: 'low',
          enabled: true,
        },
        {
          id: 'fast-reader',
          name: 'duplicate',
          description: '',
          profile: 'implementation',
          connectionSlug: 'other',
          model: 'other',
          enabled: true,
        },
        {
          id: 'unsafe id',
          name: 'unsafe',
          profile: 'root',
          connectionSlug: 'other',
          model: 'other',
          enabled: true,
        },
      ],
    },
  });

  expect(normalized.subagents.presets).toEqual([
    {
      id: 'fast-reader',
      name: 'Fast reader',
      description: 'Cheap repository scans',
      profile: 'local_read',
      connectionSlug: 'openai-main',
      model: 'gpt-5-mini',
      thinkingLevel: 'low',
      enabled: true,
    },
  ]);
});

describe('custom pet selection settings', () => {
  test('fails closed for missing, unsafe, or malformed persisted selections', () => {
    for (const selectedPetId of [undefined, '../maodie', 42]) {
      const normalized = normalizeSettings({
        personalization: {
          displayName: '',
          assistantTone: '',
          uiLocale: 'auto',
          selectedPetId,
        },
      });
      expect(normalized.personalization.selectedPetId).toBe(null);
    }
  });
});

test('shell settings default, normalize, and merge through their shared boundary', () => {
  const defaults = createDefaultSettings();
  expect(defaults.shell).toEqual({ preference: 'auto', executable: '' });

  expect(
    normalizeSettings({
      shell: { preference: 'git_bash', executable: ' C:\\Program Files\\Git\\bin\\bash.exe ' },
    }).shell,
  ).toEqual({
    preference: 'git_bash',
    executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
  });
  expect(normalizeSettings({ shell: { preference: 'fish', executable: 42 } }).shell).toEqual({
    preference: 'auto',
    executable: '',
  });
  expect(
    mergeSettings(defaults, {
      shell: { preference: 'git_bash', executable: 'C:\\Git\\bin\\bash.exe' },
    }).shell,
  ).toEqual({ preference: 'git_bash', executable: 'C:\\Git\\bin\\bash.exe' });
});

test('a chat-default thinking level the app does not recognize drops to no preference', () => {
  const normalized = normalizeSettings({
    chatDefaults: { thinkingLevel: 'ultra' as unknown as undefined },
  });
  expect(normalized.chatDefaults.thinkingLevel).toBe(undefined);
});
