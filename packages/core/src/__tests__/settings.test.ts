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
    for (const selectedPetId of [undefined, '../maodie', 'MAODIE', '', 42, {}]) {
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
  // Fail closed, matching permissionMode next to it: a level that reached
  // settings.json from an older build or a hand edit must not travel on to
  // session creation as a rung no picker can render.
  const normalized = normalizeSettings(
    mergeSettings(createDefaultSettings(), {
      chatDefaults: { thinkingLevel: 'ultra' as unknown as undefined },
    }),
  );
  expect(normalized.chatDefaults.thinkingLevel).toBe(undefined);
});

test('a blank default project id is dropped rather than stored', () => {
  // A blank id cannot name a project, so carrying it would make "a default is
  // set" true while nothing resolves — the settings row would claim a default
  // the app can never open.
  const normalized = normalizeSettings(
    mergeSettings(createDefaultSettings(), { projects: { defaultProjectId: '   ' } }),
  );
  expect(normalized.projects.defaultProjectId).toBe(undefined);
});
