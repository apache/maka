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
import test from 'node:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ModelWheelPicker } from '../model-wheel-picker.js';

test('the wheel applies settled selection once and restores the saved model on failure', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  const calls: string[] = [];
  let finish: ((success: boolean) => void) | undefined;
  const options = ['A', 'B', 'C'].map((value) => ({ value, label: value }));
  function Harness({ disabled = false }: { disabled?: boolean }) {
    const [value, setValue] = useState('B');
    return <ModelWheelPicker open options={options} value={value} label={value}
      ariaLabel="Model" disabled={disabled} onValueChange={(next) => {
        calls.push(next);
        return new Promise<void>((resolve, reject) => {
          finish = (success) => {
            if (success) { setValue(next); resolve(); }
            else reject(new Error('save failed'));
          };
        });
      }} />;
  }
  const event = (type: string) => new window.Event(type, { bubbles: true, cancelable: true });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
  try {
    await act(() => root.render(<Harness />));
    const wheel = document.querySelector<HTMLElement>('[role="listbox"]')!;
    assert.equal(wheel.scrollTop, 44, 'opening centers the current model');
    await act(() => wheel.dispatchEvent(event('scroll')));
    await settle();
    assert.deepEqual(calls, [], 'initial positioning never changes the model');

    await act(() => {
      wheel.dispatchEvent(event('wheel'));
      wheel.scrollTop = 88;
      wheel.dispatchEvent(event('scroll'));
    });
    await settle();
    assert.deepEqual(calls, ['C'], 'scrolling applies the snapped model without a click');
    assert.equal(wheel.getAttribute('aria-busy'), 'true');
    assert.equal(wheel.querySelector('[aria-selected="true"]')?.textContent, 'C');
    await act(() => {
      wheel.dispatchEvent(event('scrollend'));
      wheel.dispatchEvent(Object.assign(event('keydown'), { key: 'Home' }));
    });
    await settle();
    assert.deepEqual(calls, ['C'], 'pending saves cannot overlap');
    await act(async () => { finish?.(true); });
    assert.equal(wheel.getAttribute('aria-busy'), 'false');
    assert.equal(wheel.querySelector('[aria-selected="true"]')?.textContent, 'C');

    await act(() => wheel.dispatchEvent(Object.assign(event('keydown'), { key: 'Home' })));
    assert.deepEqual(calls, ['C', 'A'], 'keyboard navigation also applies immediately');
    await act(async () => { finish?.(false); });
    assert.equal(wheel.scrollTop, 88, 'a failed save recenters the authoritative value');
    assert.equal(wheel.querySelector('[aria-selected="true"]')?.textContent, 'C');

    await act(() => root.render(<Harness disabled />));
    await act(() => wheel.dispatchEvent(Object.assign(event('keydown'), { key: 'Home' })));
    assert.deepEqual(calls, ['C', 'A'], 'disabled navigation does not change the model');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
