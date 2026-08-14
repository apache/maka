import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import { mergeSettings, normalizeSettings } from '../settings.js';

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

test('a chat-default thinking level the app does not recognize drops to no preference', () => {
  const normalized = normalizeSettings({
    chatDefaults: { thinkingLevel: 'ultra' as unknown as undefined },
  });
  expect(normalized.chatDefaults.thinkingLevel).toBe(undefined);
});

test('normalizes Project defaults independently', () => {
  const normalized = normalizeSettings({
    projects: {
      defaultProjectId: 'project-1',
      defaultWorkingDirectory: '/Users/example/agent',
    },
  });

  expect(normalized.projects).toEqual({
    defaultProjectId: 'project-1',
    defaultWorkingDirectory: '/Users/example/agent',
  });
});

test('drops blank or malformed default working directories', () => {
  for (const defaultWorkingDirectory of [undefined, '', '  ', 42]) {
    const normalized = normalizeSettings({
      projects: { defaultWorkingDirectory },
    });
    expect(normalized.projects.defaultWorkingDirectory).toBe(undefined);
  }
});

test('clears the default working directory without clearing the default Project', () => {
  const current = normalizeSettings({
    projects: {
      defaultProjectId: 'project-1',
      defaultWorkingDirectory: '/Users/example/agent',
    },
  });

  const merged = mergeSettings(current, {
    projects: { defaultWorkingDirectory: undefined },
  });

  expect(merged.projects).toEqual({ defaultProjectId: 'project-1' });
});
