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
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

test('the context usage action opens its host trace surface', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  let opened = false;

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          contextUsage={{ onOpen: () => { opened = true; } }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));

    const action = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open usage trace"]',
    );
    assert.ok(
      action,
      'context usage must be an action that opens Trace; do not render a read-only hand-written label',
    );
    assert.equal(
      action.classList.contains('astryx-button'),
      true,
      'context usage must use Astryx Button; do not hand-write this control with raw JSX or custom control CSS',
    );
    assert.equal(action.textContent?.trim(), 'Usage');

    await act(() => action.dispatchEvent(new window.Event('click', { bubbles: true })));
    assert.equal(opened, true);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});

test('the context usage share resolves declared, then metered, then metadata window', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);

  const render = async (
    contextUsage: {
      usageTokens?: number;
      declaredContextWindow?: number;
      meteredContextWindow?: number;
      metadataContextWindow?: number;
    },
  ) => {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          contextUsage={{ ...contextUsage, onOpen: () => undefined }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));
    const action = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open usage trace"]',
    );
    assert.ok(action);
    return action.textContent?.trim();
  };

  try {
    // The user's declaration wins over every reported window.
    assert.equal(
      await render({
        usageTokens: 40_000,
        declaredContextWindow: 100_000,
        meteredContextWindow: 80_000,
        metadataContextWindow: 64_000,
      }),
      '40%',
    );
    // The metered window was frozen against the same request as the tokens,
    // so it outranks the catalog's metadata window.
    assert.equal(
      await render({ usageTokens: 40_000, meteredContextWindow: 80_000, metadataContextWindow: 64_000 }),
      '50%',
    );
    // Metadata is the fallback…
    assert.equal(await render({ usageTokens: 32_000, metadataContextWindow: 64_000 }), '50%');
    // …and with no window at all the usage stands alone, no invented share.
    assert.equal(await render({ usageTokens: 40_000 }), 'Usage');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
