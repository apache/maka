import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createSettingsRuntimeEffects } from '../settings-runtime-effects.js';

function harness() {
  const settings = {
    chatDefaults: { permissionMode: 'bypass' },
  } as unknown as Parameters<
    ReturnType<typeof createSettingsRuntimeEffects>['applySettingsRuntimeEffects']
  >[0];

  const effects = createSettingsRuntimeEffects({
    settingsStore: { get: async () => settings } as never,
    botRegistry: {} as never,
    openGateway: {} as never,
    keepSystemAwake: { apply: () => {} } as never,
    safeSendToRenderer: () => {},
  });

  return { effects, settings };
}

describe('default permission mode', () => {
  it('applies only to future sessions and never rewrites existing boundaries', async () => {
    const h = harness();
    await h.effects.applySettingsRuntimeEffects(h.settings, {
      chatDefaults: { permissionMode: 'bypass' },
    } as never);

    const source = await readFile(
      fileURLToPath(new URL('../../../src/main/settings-runtime-effects.ts', import.meta.url)),
      'utf8',
    );
    assert.doesNotMatch(source, /syncDefaultPermissionModeToSessions/);
    assert.doesNotMatch(source, /runtime\.setPermissionMode/);
  });
});
