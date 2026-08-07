import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultSettings } from '@maka/core/settings';
import { createClientSettingsEffects } from '../client-settings-effects.js';

test('applies each client settings snapshot once across local writes and file watcher echoes', async () => {
  let current = createDefaultSettings();
  const keepAwake: boolean[] = [];
  let botApplications = 0;
  let rendererEvents = 0;
  const effects = createClientSettingsEffects({
    settingsStore: { get: async () => current },
    applyKeepSystemAwake: async (enabled) => {
      keepAwake.push(enabled);
    },
    applyBotSettings: async () => {
      botApplications += 1;
    },
    emitExternalChanged: () => {
      rendererEvents += 1;
    },
  });

  assert.equal(await effects.refresh(false), true);
  assert.equal(await effects.refresh(true), false);

  current = {
    ...current,
    system: { keepSystemAwake: true },
  };
  assert.equal(await effects.apply(current, true), true);
  assert.equal(await effects.refresh(true), false);

  assert.deepEqual(keepAwake, [false, true]);
  assert.equal(botApplications, 1);
  assert.equal(rendererEvents, 1);
});
