import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRuntimeHostSettingsIpc } from '../runtime-host-settings-ipc-main.js';

test('returns the directory selected by the main process', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerRuntimeHostSettingsIpc({
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {} as never,
    settingsStore: {} as never,
    applyClientSettings: async () => undefined,
    chooseDefaultWorkingDirectory: async () => '/Users/example/agent',
  });

  const choose = handlers.get('settings:chooseDefaultWorkingDirectory');
  assert.ok(choose);
  assert.equal(await choose({}), '/Users/example/agent');
});
