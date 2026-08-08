import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultSettings, mergeSettings } from '@maka/core/settings';
import { buildClientSettingsTools } from '../client-settings-tools.js';

test('the bound client confirms and applies only UI and operating-system settings', async () => {
  let settings = createDefaultSettings();
  let proposed: readonly string[] = [];
  const tools = buildClientSettingsTools({
    read: async () => settings,
    update: async (patch) => {
      settings = mergeSettings(settings, patch);
      return settings;
    },
    confirm: async (changes) => {
      proposed = changes;
      return true;
    },
  });
  const update = tools.find(({ name }) => name === 'MakaClientSettingsUpdate');
  assert.ok(update);

  const result = await update.impl(
    {
      appearance: { theme: 'dark' },
      uiLocale: 'en',
      system: { keepSystemAwake: true },
    },
    {} as never,
  );

  assert.deepEqual(proposed, [
    'Theme: auto → dark',
    'UI language: auto → en',
    'Keep system awake: false → true',
  ]);
  assert.equal((result as { applied: boolean }).applied, true);
  assert.equal(settings.appearance.theme, 'dark');
  assert.equal(settings.personalization.uiLocale, 'en');
  assert.equal(settings.system.keepSystemAwake, true);
});
