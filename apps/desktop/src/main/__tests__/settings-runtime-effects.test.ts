import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultSettings } from '@maka/core';
import type { BotRegistry } from '@maka/runtime';
import type { createSettingsStore } from '@maka/storage';
import type { KeepSystemAwakeController } from '../keep-system-awake.js';
import { createSettingsRuntimeEffects } from '../settings-runtime-effects.js';

test('webSearch and privacy settings refresh idle backends', async () => {
  const settings = createDefaultSettings();
  let refreshes = 0;
  const effects = createSettingsRuntimeEffects({
    settingsStore: {
      get: async () => settings,
    } as ReturnType<typeof createSettingsStore>,
    botRegistry: {} as BotRegistry,
    keepSystemAwake: {} as KeepSystemAwakeController,
    safeSendToRenderer: () => {},
    refreshIdleBackends: async () => {
      refreshes += 1;
    },
  });

  await effects.applySettingsRuntimeEffects(settings, {
    webSearch: { enabled: true },
  });
  await effects.applySettingsRuntimeEffects(settings, {
    privacy: { incognitoActive: true },
  });
  await effects.applySettingsRuntimeEffects(settings, {
    appearance: { theme: 'dark' },
  });

  assert.equal(refreshes, 2);
});
