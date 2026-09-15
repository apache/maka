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
import type { SearchRequest, SearchResult } from '@maka/core/search';

// Cover the complete overlay owner -> modal -> Desktop service path.
// A rebase must preserve request identity and cancellation from #5256.
test('overlay search preserves cancellation across supersession, close, reopen, and unmount', async () => {
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
  const { LocaleProvider } = await import('@maka/ui');
  const { OverlaysRoot, OverlaysServicesProvider, SearchModalHost } =
    await import('../../renderer/features/overlays/index.js');
  const { createDesktopOverlaysServices } =
    await import('../../renderer/platform/desktop/create-overlays-services.js');
  const requests: ReturnType<typeof deferred<SearchResult[]>>[] = [];
  const requestIds: string[] = [];
  const cancelled: string[] = [];
  const search = {
    thread: (_request: SearchRequest, requestId?: string) => {
      assert.ok(requestId);
      requestIds.push(requestId);
      const request = deferred<SearchResult[]>();
      requests.push(request);
      return request.promise;
    },
    cancelThread: async (requestId: string) => { cancelled.push(requestId); },
  };
  const root = createRoot(document.getElementById('root')!);
  let overlays: import('../../renderer/features/overlays/testing.js').OverlaysShellProjection;
  const services = createDesktopOverlaysServices({ search }, {
    storage: { setItem() {} }, document,
  });
  const navigate = () => {};
  const render = () => root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(OverlaysServicesProvider, { services, children:
      createElement(OverlaysRoot, { children: (projection) => {
        overlays = projection;
        return createElement(SearchModalHost, { onNavigateToSession: navigate });
      } }),
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
    await act(async () => { overlays.commands.openSearch(); });
    await type('old');
    assert.equal(requests.length, 1);
    assert.equal(busy(), 1);
    await act(async () => {
      input().dispatchEvent(Object.assign(new window.Event('keydown', { bubbles: true }), { key: 'Escape' }));
    });
    assert.equal(overlays!.selectors.searchOpen, false);
    await act(async () => { overlays.commands.openSearch(); });
    assert.equal(busy(), 0, 'reopening must not wait for the dismissed request');
    assert.equal(input().value, '');
    assert.deepEqual(cancelled, [requestIds[0]]);

    await type('older');
    await type('maka');
    assert.equal(requests.length, 3);
    await act(async () => { requests[2]!.resolve([
      { source: 'thread', title: 'Latest maka match', target: { kind: 'thread', sessionId: 'latest' } },
    ]); });
    assert.match(document.body.textContent ?? '', /Latest maka match/);
    assert.equal(busy(), 0, 'completed results must not wait for the superseded request');
    assert.equal(input().value, 'maka');
    assert.deepEqual(cancelled, [requestIds[0], requestIds[1]]);

    await act(async () => { requests[0]!.resolve([]); requests[1]!.resolve([]); });
    assert.match(document.body.textContent ?? '', /Latest maka match/);
    assert.equal(busy(), 0);

    await type('programmatic close');
    await act(async () => { overlays.commands.closeSearch(); });
    await act(async () => { overlays.commands.openSearch(); });
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
