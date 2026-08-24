/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
