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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TranscriptGapRow } from '../chat-view.js';

function createHarness() {
  const original = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML(
    '<html><body><div id="root"></div><button id="outside">Outside</button></body></html>',
  );
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  let activeElement: Element = document.body;
  const focusCalls: FocusOptions[] = [];
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => activeElement,
  });
  window.HTMLElement.prototype.focus = function focus(options?: FocusOptions) {
    activeElement = this;
    focusCalls.push(options ?? {});
  };
  Object.assign(globalThis, {
    cancelAnimationFrame() {},
    document,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = document.querySelector('#root');
  const outside = document.querySelector('#outside');
  assert.ok(container);
  assert.ok(outside);
  const root = createRoot(container);
  let activations = 0;

  const render = async (isPending: boolean) => {
    await act(() => root.render(
      <TranscriptGapRow
        direction="newer"
        description="Newer messages are not loaded."
        actionLabel="Load newer messages"
        isPending={isPending}
        onActivate={() => {
          activations += 1;
        }}
      />,
    ));
  };

  return {
    active: () => activeElement,
    activations: () => activations,
    async cleanup() {
      await act(() => root.unmount());
      Object.assign(globalThis, original);
    },
    focusCalls,
    outside,
    render,
    setActive(element: Element) {
      activeElement = element;
    },
    button() {
      const button = container.querySelector('button');
      assert.ok(button);
      return button;
    },
    window,
  };
}

test('restores the activating gap button focus after its pending load completes', async () => {
  const dom = createHarness();
  try {
    await dom.render(false);
    const button = dom.button();
    dom.setActive(button);
    button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    assert.equal(dom.activations(), 1);

    await dom.render(true);
    dom.setActive(dom.window.document.body);
    await dom.render(false);

    assert.equal(dom.active() === button, true, 'the completed gap load did not restore focus');
    assert.deepEqual(dom.focusCalls, [{ preventScroll: true }]);
  } finally {
    await dom.cleanup();
  }
});

test('does not reclaim gap focus when the reader moved to another control while loading', async () => {
  const dom = createHarness();
  try {
    await dom.render(false);
    const button = dom.button();
    dom.setActive(button);
    button.dispatchEvent(new dom.window.Event('click', { bubbles: true }));

    await dom.render(true);
    dom.setActive(dom.outside);
    await dom.render(false);

    assert.equal(dom.active() === dom.outside, true, 'the gap stole focus from another control');
    assert.deepEqual(dom.focusCalls, []);
  } finally {
    await dom.cleanup();
  }
});
