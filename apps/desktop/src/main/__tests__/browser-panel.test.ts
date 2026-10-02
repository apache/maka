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
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { BrowserState } from '@maka/core/browser';
import { LocaleProvider, ToastProvider } from '@maka/ui';
import {
  BrowserPanel, createFakeWorkbarServices, WorkbarServicesProvider, type WorkbarServices,
} from '../../renderer/features/workbar/testing.js';
import { getBrowserCopy } from '../../renderer/locales/browser-copy.js';

const empty: BrowserState = {
  url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
  hasPage: false, secure: false, loadError: null,
};
const failed: BrowserState = { ...empty, loadError: { url: 'https://example.test/failed', code: -105 } };
let root: Root | undefined;
let restore: (() => void) | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

function setup() {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const matchMedia = (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} });
  const getComputedStyle = () => ({ direction: 'ltr', getPropertyValue: () => '' });
  // These tests exercise state and actions; geometry is owned by native smoke.
  const requestAnimationFrame = () => 1;
  const cancelAnimationFrame = () => {};
  class ResizeObserver { observe() {} disconnect() {} unobserve() {} }
  Object.assign(window, { matchMedia, getComputedStyle, requestAnimationFrame, cancelAnimationFrame, ResizeObserver });
  const values = {
    document, window, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, MutationObserver: window.MutationObserver, ResizeObserver,
    matchMedia, getComputedStyle, requestAnimationFrame, cancelAnimationFrame,
    CSS: { supports: () => false, escape: (value: string) => value },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, values);
  restore = () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  const container = document.querySelector<HTMLElement>('#root')!;
  root = createRoot(container);
  return container;
}

function render(services: WorkbarServices, sessionId = 'a', hidden = false, locale: 'en' | 'zh-CN' | 'zh-TW' = 'en') {
  root!.render(createElement(LocaleProvider, {
    locale,
    children: createElement(ToastProvider, {
      children: createElement(WorkbarServicesProvider, { services }, createElement(BrowserPanel, { sessionId, hidden })),
    }),
  }));
}

for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
  test(`shows the failed address and retries the owning session in ${locale}`, async () => {
    const container = setup();
    const defaults = createFakeWorkbarServices();
    const reloads: string[] = [];
    let publish!: Parameters<WorkbarServices['browser']['subscribeState']>[0];
    const services = createFakeWorkbarServices({ browser: {
      ...defaults.browser, getState: async () => failed,
      subscribeState: (handler) => { publish = handler; return () => {}; },
      reload: async (id) => { reloads.push(id); },
    } });
    await act(async () => render(services, 'a', false, locale));
    const copy = getBrowserCopy(locale);
    assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes(copy.loadFailed));
    assert.ok(container.textContent?.includes(copy.loadFailureDns));
    assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes(copy.retryDetail));
    assert.equal(container.querySelector('input')?.value, failed.loadError!.url);
    const retry = container.querySelector<HTMLButtonElement>(`button[aria-label="${copy.retryAria}"]`);
    assert.ok(retry);
    await act(async () => retry.click());
    assert.deepEqual(reloads, ['a']);
    for (const [code, message] of [
      [-137, copy.loadFailureDns],
      [-107, copy.loadFailureSecureConnection],
      [-113, copy.loadFailureSecureConnection],
      [-20, copy.loadFailureBlocked],
      [-27, copy.loadFailureBlocked],
    ] as const) {
      await act(async () => publish({ sessionId: 'a', state: {
        ...failed, loadError: { url: failed.loadError!.url, code },
      } }));
      const alert = container.querySelector('[role="alert"]');
      assert.ok(alert?.textContent?.includes(message), `localized reason for ${code}`);
      assert.ok(!alert?.textContent?.includes(copy.loadFailureNetwork));
    }
  });
}

test('new state pushes win over a delayed initial snapshot and recovery clears the error', async () => {
  const container = setup();
  const initial = deferred<BrowserState | null>();
  let publish!: Parameters<WorkbarServices['browser']['subscribeState']>[0];
  const defaults = createFakeWorkbarServices();
  const services = createFakeWorkbarServices({ browser: {
    ...defaults.browser, getState: () => initial.promise,
    subscribeState: (handler) => { publish = handler; return () => {}; },
  } });
  await act(async () => render(services));
  await act(async () => publish({ sessionId: 'a', state: failed }));
  await act(async () => initial.resolve(empty));
  assert.ok(container.querySelector('[role="alert"]'));
  await act(async () => publish({ sessionId: 'a', state: { ...empty, url: 'https://example.test/ok', hasPage: true } }));
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(container.querySelector('input')?.value, 'https://example.test/ok');
});

test('hiding and switching sessions cannot leak an old failure; showing reseeds state', async () => {
  const container = setup();
  const defaults = createFakeWorkbarServices();
  const listeners = new Set<Parameters<WorkbarServices['browser']['subscribeState']>[0]>();
  const services = createFakeWorkbarServices({ browser: {
    ...defaults.browser, getState: async (id) => id === 'a' ? failed : empty,
    subscribeState: (handler) => { listeners.add(handler); return () => { listeners.delete(handler); }; },
  } });
  await act(async () => render(services));
  assert.ok(container.querySelector('[role="alert"]'));
  const oldListener = [...listeners][0]!;
  await act(async () => render(services, 'a', true));
  assert.equal(listeners.size, 0);
  await act(async () => render(services, 'b'));
  await act(async () => oldListener({ sessionId: 'a', state: failed }));
  assert.equal(container.querySelector('[role="alert"]'), null);
  await act(async () => render(services, 'a'));
  assert.ok(container.querySelector('[role="alert"]'));
});
