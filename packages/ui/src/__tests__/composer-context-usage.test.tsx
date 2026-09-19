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

test('the context usage action keeps one control while its reading resolves', async () => {
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

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          contextUsage={{ pending: true, onOpen: () => undefined }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));
    const pendingAction = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open usage trace"]',
    );
    assert.ok(pendingAction);
    const value = pendingAction.querySelector('.maka-context-usage-value');
    assert.ok(value);
    assert.equal(value.getAttribute('aria-busy'), 'true');
    assert.equal(pendingAction.textContent?.trim(), '--%');
    assert.ok(pendingAction.querySelector('.maka-context-usage-value'));

    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          contextUsage={{
            usageTokens: 40_000,
            metadataContextWindow: 100_000,
            onOpen: () => undefined,
          }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));
    const resolvedAction = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open usage trace"]',
    );
    assert.equal(resolvedAction, pendingAction);
    assert.equal(resolvedAction?.querySelector('.maka-context-usage-value'), value);
    assert.equal(value.getAttribute('aria-busy'), null);
    assert.equal(resolvedAction?.textContent?.trim(), '40%');
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

test('the git branch chip shows the branch, the short sha when detached, and nothing without Git', async () => {
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

  const render = (branch?: { name?: string; shortSha?: string }) =>
    root.render(
      <LocaleProvider locale="en">
        <Composer
          {...(branch ? { gitBranch: branch } : {})}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    );

  // The chip is a readout, not a control: nothing under it may be a button, so
  // a click has nothing to land on.
  const branchEl = () => container.querySelector('.maka-composer-git-branch');
  const chipText = () => branchEl()?.textContent?.trim();

  try {
    // No `gitBranch` — a non-repository workspace — means no chip at all, not an
    // empty one: absence of Git is the normal case and must not leave a husk.
    await act(() => render(undefined));
    assert.equal(chipText(), undefined, 'no chip may render outside a Git repository');

    await act(() => render({ name: 'feature/chip' }));
    assert.equal(chipText(), 'feature/chip', 'a named branch must render its name');
    // The chip must be a readout, not a control: whatever carries the branch
    // text may not be (or contain) a button, so a click has nothing to land on.
    assert.equal(
      branchEl()?.closest('button'),
      null,
      'the branch chip must not be a button — the branch is a readout, not an action',
    );
    assert.equal(
      branchEl()?.tagName,
      'SPAN',
      'the chip must be a plain span, not a control',
    );
    // The full branch must survive on the element a truncating row can still
    // name: `title` is what hover shows when the text had to be shortened.
    assert.match(branchEl()?.getAttribute('title') ?? '', /feature\/chip/u);

    // Detached HEAD: the branch name is unknown, so the short sha is the label.
    await act(() => render({ shortSha: 'abc1234' }));
    assert.equal(chipText(), 'abc1234', 'a detached HEAD must name itself through the short sha');
    assert.equal(branchEl()?.closest('button'), null, 'a detached HEAD readout must not be a button');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
