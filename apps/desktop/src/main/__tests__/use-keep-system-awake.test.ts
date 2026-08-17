import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { createDefaultSettings } from '@maka/core/settings';
import {
  useKeepSystemAwake,
  type KeepSystemAwakeController,
} from '../../renderer/use-keep-system-awake.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

test('keeps the Desktop preference available when no Runtime Host settings bridge is usable', async () => {
  const { root } = installReactRenderer();
  let persisted = {
    ...createDefaultSettings(),
    system: { keepSystemAwake: true },
  };
  const updates: boolean[] = [];
  (globalThis.window as unknown as { maka: unknown }).maka = {
    settings: {
      getClient: async () => persisted,
      updateClient: async (patch: { system?: { keepSystemAwake?: boolean } }) => {
        const keepSystemAwake = patch.system?.keepSystemAwake ?? persisted.system.keepSystemAwake;
        updates.push(keepSystemAwake);
        persisted = { ...persisted, system: { keepSystemAwake } };
        return { settings: persisted };
      },
      subscribeClientChanged: () => () => undefined,
    },
  };

  let current: KeepSystemAwakeController | undefined;
  function Probe() {
    current = useKeepSystemAwake();
    return null;
  }

  await act(async () => {
    root.render(createElement(Probe));
  });
  assert.equal(current?.keepSystemAwake, true);

  await act(async () => {
    await current?.setKeepSystemAwake(false);
  });
  assert.deepEqual(updates, [false]);
  assert.equal(current?.keepSystemAwake, false);
});

afterEach(() => {
  cleanupFakeDom();
  delete (globalThis as { window?: unknown }).window;
});
