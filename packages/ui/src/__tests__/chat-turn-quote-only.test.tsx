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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TransientUserMessage } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TransientUserMessageProjection } from '../chat-view.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function renderMessage(message: TransientUserMessageProjection) {
  const parsed = parseHTML('<div id="root"></div>');
  const { document, window } = parsed;
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return async () => {
    await (act(() => {
      root.render(
        <LocaleProvider locale="en">
          <TransientUserMessage message={message} />
        </LocaleProvider>,
      );
    }) as unknown as Promise<void>);
    return container;
  };
}

test('a quote-only user message renders the quote without an empty text bubble', async () => {
  const container = await renderMessage({
    id: 'quote-only',
    text: '',
    ts: 1,
    transientPlacement: 'current_turn',
    quotes: [{ text: 'selected excerpt' }],
  })();

  // #4804: a structured-only Message (empty text carrying a quote) must show
  // the quote chips, and the unconditional text bubble must not render empty.
  const bubble = container.querySelector('.maka-chat-message-bubble-user');
  assert.equal(bubble, null, 'an empty text must not render an empty user bubble');
  const quotes = container.querySelector('.maka-user-quotes');
  assert.ok(quotes, 'the staged quote still renders');
  assert.match(quotes?.textContent ?? '', /selected excerpt/);
});

test('a user message with text still renders its bubble', async () => {
  const container = await renderMessage({
    id: 'with-text',
    text: 'explain this',
    ts: 1,
    transientPlacement: 'current_turn',
    quotes: [{ text: 'selected excerpt' }],
  })();

  const bubble = container.querySelector('.maka-chat-message-bubble-user');
  assert.ok(bubble, 'a text message keeps its bubble');
  assert.match(bubble?.textContent ?? '', /explain this/);
});
