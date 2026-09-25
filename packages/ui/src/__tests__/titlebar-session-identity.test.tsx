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

/**
 * Every branch of TitlebarSessionIdentity must hand its rendered text node to
 * the truncation measurement — the read-only branch once rendered without the
 * measure ref, leaving shared-session titles without their full-name tooltip.
 * Tooltip contents themselves need real layout; the story plays own them.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LocaleProvider } from '../locale-context.js';
import { presentSessionName } from '../session-status-presentation.js';
import { TitlebarSessionIdentity } from '../titlebar-session-identity.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  matchMedia: globalThis.matchMedia,
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

async function renderIdentity(sessionName: string, readOnly = false, onRenameSession = (_name: string) => {}) {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () =>
    new Proxy(
      { direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' },
      { get: (target, key) => (key in target ? target[key as keyof typeof target] : '') },
    ) as unknown as CSSStyleDeclaration;
  window.matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root') as HTMLElement;
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(() => {
    root.render(
      <StrictMode>
        <LocaleProvider locale="en">
          <TitlebarSessionIdentity
            sessionName={sessionName}
            readOnly={readOnly}
            onRenameSession={onRenameSession}
            project={{ name: 'p' }}
          />
        </LocaleProvider>
      </StrictMode>,
    );
  });
  return container.querySelector<HTMLElement>('.maka-titlebar-identity__segment--session');
}

test('both branches hand their rendered span to the truncation measurement', async () => {
  const observed: unknown[] = [];
  const originalObserver = globalThis.ResizeObserver;
  class RecordingObserver {
    observe(el: unknown) { observed.push(el); }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = RecordingObserver as unknown as typeof ResizeObserver;
  try {
    const editableSpan = await renderIdentity('Short name');
    assert.ok(observed.includes(editableSpan));
    const readOnlySpan = await renderIdentity('Another long shared-session title that overflows the chip', true);
    assert.ok(observed.includes(readOnlySpan));
  } finally {
    globalThis.ResizeObserver = originalObserver;
  }
});

test('the Host untitled name reads as the localized placeholder', async () => {
  assert.equal((await renderIdentity('New Chat'))?.textContent, 'New task');
  assert.equal((await renderIdentity('Fix the build'))?.textContent, 'Fix the build');
  assert.equal(presentSessionName('New Chat', 'zh-CN'), '新建任务');
});

test('committing the untitled placeholder unchanged keeps the stored name', async () => {
  const renamed: string[] = [];
  const span = await renderIdentity('New Chat', false, (name) => renamed.push(name));
  window.HTMLInputElement.prototype.select ??= () => {};
  await act(() => { span?.closest('button')?.click(); });
  const input = document.querySelector<HTMLInputElement>('.maka-titlebar-identity__rename-input input, input.maka-titlebar-identity__rename-input');
  assert.equal(input?.value, 'New task');
  await act(() => { input?.dispatchEvent(new window.Event('focusout', { bubbles: true })); });
  assert.equal(document.querySelector('.maka-titlebar-identity__rename-input'), null, 'the rename closed');
  assert.deepEqual(renamed, []);
});
