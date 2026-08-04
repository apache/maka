import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDefaultSettings, mergeSettings } from '@maka/core';
import type { SettingsStore } from '@maka/storage';
import { resolveDesktopWebSearchAvailability } from '../web-search/surface.js';

describe('Desktop WebSearch availability', () => {
  const cases = [
    {
      name: 'disabled',
      settings: mergeSettings(createDefaultSettings(), {
        webSearch: {
          enabled: false,
          providers: { tavily: { apiKey: 'configured-key' } },
        },
      }),
      privacy: { incognitoActive: false },
      expected: false,
    },
    {
      name: 'credential not configured',
      settings: mergeSettings(createDefaultSettings(), {
        webSearch: {
          enabled: true,
          providers: { tavily: { apiKey: '' } },
        },
      }),
      privacy: { incognitoActive: false },
      expected: false,
    },
    {
      name: 'privacy mode',
      settings: mergeSettings(createDefaultSettings(), {
        webSearch: {
          enabled: true,
          providers: { tavily: { apiKey: 'configured-key' } },
        },
      }),
      privacy: { incognitoActive: true },
      expected: false,
    },
    {
      name: 'ready',
      settings: mergeSettings(createDefaultSettings(), {
        webSearch: {
          enabled: true,
          providers: { tavily: { apiKey: 'configured-key' } },
        },
      }),
      privacy: { incognitoActive: false },
      expected: true,
    },
  ] as const;

  for (const fixture of cases) {
    it(`reports ${fixture.name}`, async () => {
      const available = await resolveDesktopWebSearchAvailability({
        settingsStore: {
          get: async () => fixture.settings,
        } as Pick<SettingsStore, 'get'>,
        getPrivacyContext: async () => fixture.privacy,
        env: {},
      });

      assert.equal(available, fixture.expected);
    });
  }
});
