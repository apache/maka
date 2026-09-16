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

test('ordinary rerenders keep the layer anchor attached', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb',
    getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  const styleDescriptor = Object.getOwnPropertyDescriptor(window.Element.prototype, 'style')!;
  const styleProxies = new WeakMap<Element, CSSStyleDeclaration>();
  const anchorNameWrites: string[] = [];
  let recordAnchorNameWrites = false;
  Object.defineProperty(window.Element.prototype, 'style', {
    configurable: true,
    get(this: Element) {
      const existing = styleProxies.get(this);
      if (existing) return existing;
      const style = styleDescriptor.get!.call(this) as CSSStyleDeclaration;
      const proxy = new Proxy(style, {
        set: (target, property, value) => {
          if (recordAnchorNameWrites && property === 'anchorName'
            && this.classList.contains('maka-model-wheel-anchor')) {
            anchorNameWrites.push(String(value));
          }
          return Reflect.set(target, property, value);
        },
      });
      styleProxies.set(this, proxy);
      return proxy;
    },
  });
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  const options = ['A', 'B'].map((value) => ({ value, label: value }));
  try {
    await act(() => root.render(<ModelWheelPicker open options={options} value="A" label="A"
      ariaLabel="Model" onValueChange={() => {}} />));
    recordAnchorNameWrites = true;

    await act(() => root.render(<ModelWheelPicker open options={options} value="A" label="renamed"
      ariaLabel="Model" onValueChange={() => {}} />));

    assert.deepEqual(anchorNameWrites, [], 'rerendering must not remove and restore the CSS anchor name');
  } finally {
    await act(() => root.unmount());
    Object.defineProperty(window.Element.prototype, 'style', styleDescriptor);
    Object.assign(globalThis, original);
  }
});

test('the wheel applies settled selection once and restores the saved model on failure', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb',
    getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
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
    assert.equal(wheel.scrollTop, 132, 'opening centers the current model');
    await act(() => wheel.dispatchEvent(event('scroll')));
    await settle();
    assert.deepEqual(calls, [], 'initial positioning never changes the model');

    await act(() => {
      wheel.dispatchEvent(event('wheel'));
      wheel.scrollTop = 176;
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
    assert.equal(wheel.scrollTop, 176, 'a failed save recenters the authoritative value');
    assert.equal(wheel.querySelector('[aria-selected="true"]')?.textContent, 'C');

    await act(() => wheel.dispatchEvent(Object.assign(event('keydown'), { key: 'ArrowDown' })));
    assert.deepEqual(calls, ['C', 'A', 'A'], 'the last model wraps to its visible next neighbor');
    await act(async () => { finish?.(true); });

    await act(() => root.render(<Harness disabled />));
    await act(() => wheel.dispatchEvent(Object.assign(event('keydown'), { key: 'Home' })));
    assert.deepEqual(calls, ['C', 'A', 'A'], 'disabled navigation does not change the model');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
