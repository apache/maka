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
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { SessionSummary } from '@maka/core/session';
import { ChatModelSwitcher } from '../chat-model-switcher.js';
import { LocaleProvider } from '../locale-context.js';

const WARNING = 'Switching may rebuild the provider prompt cache';

function choice(connectionSlug: string, model: string, label: string): ChatModelChoice {
  return {
    connectionId: `connection-${connectionSlug}`,
    connectionSlug,
    connectionName: connectionSlug,
    providerType: 'openrouter',
    providerLabel: 'OpenRouter',
    model,
    label,
    isDefault: false,
    thinkingLevels: [],
  };
}

test('the prompt-cache notice is acknowledged per Session without closing the list', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () =>
    new Proxy(
      { direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' },
      { get: (target, key) => (key in target ? target[key as keyof typeof target] : '') },
    ) as unknown as CSSStyleDeclaration;
  window.matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  window.scrollTo = () => {};
  Object.assign(globalThis, {
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    matchMedia: window.matchMedia,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const choices = [choice('openrouter', 'openai/gpt-5', 'GPT-5'), choice('openrouter', 'openai/o3', 'o3')];
  const switches: unknown[] = [];
  const session = (id: string) =>
    ({ id, llmConnectionId: 'connection-openrouter', llmConnectionSlug: 'openrouter', model: 'openai/gpt-5' }) as SessionSummary;
  const render = (sessionId: string, openNonce: number) =>
    act(() => root.render(
      <LocaleProvider locale="en">
        <ChatModelSwitcher
          activeSession={session(sessionId)}
          choices={choices}
          hasConversationHistory
          openNonce={openNonce}
          onChange={(input) => { switches.push(input); }}
        />
      </LocaleProvider>,
    ));
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const noticeRow = () => options().find((option) => option.textContent?.includes(WARNING));
  const expanded = () =>
    document.querySelector('[aria-haspopup="listbox"]')?.getAttribute('aria-expanded');

  try {
    await render('session-a', 1);
    assert.equal(expanded(), 'true', 'the nonce opens the list');
    const notice = noticeRow();
    assert.ok(notice, 'the notice leads the open list');
    assert.equal(options()[0], notice);
    assert.notEqual(notice.getAttribute('aria-disabled'), 'true', 'the notice row is activatable');
    assert.equal(options().length, 3);

    await act(() => notice.dispatchEvent(new window.Event('click', { bubbles: true })));

    assert.equal(noticeRow(), undefined, 'activating the notice dismisses it');
    assert.equal(options().length, 2, 'the model rows remain');
    assert.equal(expanded(), 'true', 'the list is open again after the acknowledgement');
    assert.deepEqual(switches, [], 'acknowledging is not a model switch');

    await render('session-a', 2);
    assert.equal(noticeRow(), undefined, 'a Selector remount keeps the mounted switcher acknowledgement');

    await render('session-b', 0);
    assert.equal(expanded(), 'false', 'a fresh Session mounts closed');
    await render('session-b', 1);
    assert.ok(noticeRow(), 'another Session raises its own notice');

    await render('session-a', 3);
    assert.equal(noticeRow(), undefined, 'direct Session switches preserve the mounted switcher acknowledgement');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
