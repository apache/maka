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
 * Titlebar tooltips must add information, not repeat what is on screen.
 * The name button shows the full name only when ellipsis truncated it; the
 * "..." button never repeats the name.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { afterEach } from 'node:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LocaleProvider } from '../locale-context.js';
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

function domRoot() {
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
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root } as {
    container: HTMLElement;
    root: ReturnType<typeof createRoot>;
  };
}

async function renderIdentity(sessionName: string) {
  const { container, root } = domRoot();
  await act(() => {
    root.render(
      <StrictMode>
        <LocaleProvider locale="en">
          <TitlebarSessionIdentity
            sessionName={sessionName}
            onRenameSession={() => undefined}
            project={{ name: 'p' }}
          />
        </LocaleProvider>
      </StrictMode>,
    );
  });
  return container;
}

test('an untruncated session name gets no tooltip', async () => {
  const container = await renderIdentity('Short name');
  const nameButton = container.querySelector<HTMLButtonElement>('.maka-titlebar-identity__name');
  assert.ok(nameButton);
  assert.equal(nameButton.getAttribute('aria-label'), 'Short name — Rename task');
  // A fully visible name must not produce a tooltip at all.
  const tooltipLight = container.querySelector('.maka-tooltip, [id*="tooltip"]');
  assert.equal(nameButton.getAttribute('title'), null);
  assert.equal(tooltipLight, null);
});
test('the task-actions button never repeats the session name in its tooltip', async () => {
  const longName = ' brew — a long task title about Homebrew updates that overflows the titlebar chip ';
  const container = await renderIdentity(longName);
  const menuButton = container.querySelector<HTMLButtonElement>('[aria-label$=" — Task actions"]');
  assert.ok(menuButton);
  assert.equal(menuButton.getAttribute('aria-label'), `${longName} — Task actions`);
  assert.equal(menuButton.getAttribute('title'), null);
});
