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
import { WorkHubControlOverlay, WorkHubServicesProvider, type WorkHubServices } from '../../renderer/features/workhub/index.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('moving the pointer does not take control; user clicks, scrolling and non-modifier keys do', async (t) => {
  const { root } = installReactRenderer();
  Object.defineProperty(document.documentElement, 'classList', { value: { remove() {} } });
  const listeners = new Map<string, EventListener>();
  t.mock.method(window, 'addEventListener', (type: string, listener: EventListener) => { listeners.set(type, listener); });
  t.mock.method(window, 'removeEventListener', (type: string) => { listeners.delete(type); });
  class PointerInput extends Event {
    readonly isTrusted = true;
    clientX = 10;
    clientY = 20;
    movementX = 4;
    movementY = 2;
  }
  class WheelInput extends Event { readonly isTrusted = true; }
  class KeyInput extends Event {
    readonly isTrusted = true;
    constructor(readonly key: string) { super('keydown'); }
  }
  for (const [name, value] of [['PointerEvent', PointerInput], ['WheelEvent', WheelInput]] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  let stops = 0;
  const services = { control: {
    getSnapshot: async () => ({ revision: 1, phase: 'acting', canUndo: false, cursor: { x: 10, y: 20, clicking: false } }),
    subscribe: () => () => {},
    stop: async () => { stops++; },
  } } as unknown as WorkHubServices;
  await act(async () => { root.render(createElement(WorkHubServicesProvider, { services }, createElement(WorkHubControlOverlay))); });
  const dispatch = async (event: Event) => { await act(async () => { listeners.get(event.type)?.(event); }); };
  await dispatch(new PointerInput('pointermove'));
  await dispatch(new KeyInput('Shift'));
  await dispatch(new Event('pointerdown'));
  assert.equal(stops, 0);
  await dispatch(new CustomEvent('maka-assistant:input', { detail: { x: 10, y: 20 } }));
  await dispatch(new PointerInput('pointermove'));
  await dispatch(new PointerInput('pointerdown'));
  assert.equal(stops, 0, 'the marked agent click must not interrupt itself');
  await dispatch(new PointerInput('pointerdown'));
  assert.equal(stops, 1);
  await dispatch(new CustomEvent('maka-assistant:input', { detail: { wheel: true } }));
  await dispatch(new WheelInput('wheel'));
  assert.equal(stops, 1);
  await dispatch(new WheelInput('wheel'));
  assert.equal(stops, 2);
  await dispatch(new CustomEvent('maka-assistant:input', { detail: { key: 'Enter' } }));
  await dispatch(new KeyInput('Enter'));
  assert.equal(stops, 2);
  await dispatch(new KeyInput('a'));
  assert.equal(stops, 3);
});
