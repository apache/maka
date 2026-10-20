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
import { act, createElement } from 'react';
import { parseHTML } from 'linkedom';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { RecallSearchOutcome, RecallSearchRequest } from '../search-modal.js';

// Exercise the real palette's async transitions: source-only tests cannot see
// a canceled request retaining its optimistic input and loading indicator.
test('dismissed and superseded searches stop holding the palette busy', async () => {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  document.oninput = null;
  window.scrollTo = () => {};
  window.getComputedStyle = () => ({
    direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', ''); },
    close(this: HTMLElement) { this.removeAttribute('open'); },
    scrollIntoView() {},
  });
  const globals = {
    document, window, HTMLElement: window.HTMLElement,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    CSS: { supports: () => false, escape: (value: string) => value },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  Object.assign(globalThis, globals);
  const { createRoot } = await import('react-dom/client');
  const { SearchModal } = await import('../search-modal.js');
  const { LocaleProvider } = await import('../locale-context.js');
  const requests: ReturnType<typeof deferred<RecallSearchOutcome>>[] = [];
  const requestIds: string[] = [];
  const cancelled: string[] = [];
  const deps = {
    searchRecall: (_request: RecallSearchRequest, requestId?: string) => {
      assert.ok(requestId);
      requestIds.push(requestId);
      const request = deferred<RecallSearchOutcome>();
      requests.push(request);
      return request.promise;
    },
    cancelRecall: async (requestId: string) => { cancelled.push(requestId); },
  };
  const root = createRoot(document.getElementById('root')!);
  let isOpen = true;
  const navigate = () => {};
  const onOpenChange = (open: boolean) => { isOpen = open; render(); };
  const render = () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(SearchModal, {
      isOpen, deps, onNavigateToSession: navigate, onOpenChange,
    }),
  }));
  const input = () => document.querySelector<HTMLInputElement>('input')!;
  const busy = () => document.querySelectorAll('[role="status"][aria-label="Loading"]').length;
  const type = async (query: string) => act(async () => {
    // Bypass React's value tracker just as a native input edit does.
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), query);
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  try {
    await act(async () => { render(); });
    await type('old');
    assert.equal(requests.length, 1);
    assert.equal(busy(), 1);
    await act(async () => {
      input().dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Escape' }));
    });
    assert.equal(isOpen, false);
    await act(async () => { isOpen = true; render(); });
    assert.equal(busy(), 0, 'reopening must not wait for the dismissed request');
    assert.equal(input().value, '');
    assert.deepEqual(cancelled, [requestIds[0]]);

    await type('older');
    await type('maka');
    assert.equal(requests.length, 3);
    await act(async () => { requests[2]!.resolve({
      passages: [{
        sessionId: 'latest',
        sessionTitle: 'Latest maka match',
        anchorMessageId: 'latest-anchor',
        sequence: 0,
        messages: [{
          messageId: 'latest-anchor',
          role: 'assistant',
          matchKind: 'assistant_message',
          text: 'Latest maka match',
          timestamp: 1,
          isAnchor: true,
        }],
        matchedTerms: ['maka'],
        score: 1,
      }],
      gaps: '',
      searchedEverySession: true,
    }); });
    assert.match(document.body.textContent ?? '', /Latest maka match/);
    assert.equal(busy(), 0, 'completed results must not wait for the superseded request');
    assert.equal(input().value, 'maka');
    assert.deepEqual(cancelled, [requestIds[0], requestIds[1]]);

    await act(async () => {
      requests[0]!.resolve({ passages: [], gaps: '', searchedEverySession: true });
      requests[1]!.resolve({ passages: [], gaps: '', searchedEverySession: true });
    });
    assert.match(document.body.textContent ?? '', /Latest maka match/);
    assert.equal(busy(), 0);

    await type('programmatic close');
    await act(async () => { isOpen = false; render(); });
    await act(async () => { isOpen = true; render(); });
    assert.equal(busy(), 0);
    assert.equal(input().value, '');
    assert.deepEqual(cancelled, [requestIds[0], requestIds[1], requestIds[3]]);

    await type('unmount');
    await act(async () => { root.unmount(); });
    assert.deepEqual(cancelled, [requestIds[0], requestIds[1], requestIds[3], requestIds[4]]);
  } finally {
    await act(async () => { root.unmount(); });
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
