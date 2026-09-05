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
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { contextWindowTargetOptions } from '../chat-model-switcher.js';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

test('offers common targets up to the known model maximum', () => {
  assert.deepEqual(
    contextWindowTargetOptions(1_000_000),
    [256_000, 512_000, 1_000_000],
  );
  assert.deepEqual(contextWindowTargetOptions(400_000), [256_000, 400_000]);
});

test('keeps an existing non-standard target selectable', () => {
  assert.deepEqual(
    contextWindowTargetOptions(1_000_000, 384_000),
    [256_000, 384_000, 512_000, 1_000_000],
  );
});

test('the composer selects context targets and locks the control while running or saving', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({
    direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(globalThis, {
    document, window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const selected: Array<number | undefined> = [];
  const thinking: Array<string | undefined> = [];
  const render = async (options: {
    current?: number;
    streaming?: boolean;
    pending?: boolean;
    unknownMaximum?: boolean;
    noThinking?: boolean;
    thinkingHigh?: boolean;
    chinese?: boolean;
  } = {}) => act(() => root.render(createElement(LocaleProvider, {
    locale: options.chinese ? 'zh-CN' : 'en',
    children: createElement(Composer, {
      streaming: options.streaming,
      newChatThinkingLevels: options.noThinking ? [] : ['low', 'high'],
      newChatThinkingLevel: options.thinkingHigh ? 'high' : undefined,
      onNewChatThinkingLevelChange: (level) => { thinking.push(level); },
      contextUsage: {
        metadataContextWindow: options.unknownMaximum ? undefined : 1_000_000,
        declaredContextWindow: options.current,
        onOpen: () => {},
        onTargetChange: (target) => { selected.push(target); },
        targetChangePending: options.pending,
      },
      onSend: () => {},
      onStop: () => {},
    }),
  })));
  const trigger = () => container.querySelector<HTMLButtonElement>('.maka-thinking-level-selector');

  try {
    await render();
    assert.equal(trigger()?.textContent?.trim(), 'Model default');
    assert.equal(container.querySelector('.maka-context-window-target-selector'), null);
    await act(() => trigger()?.dispatchEvent(new window.Event('click', { bubbles: true })));
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.equal(rows.length, 7);
    assert.ok(rows.some((row) => row.textContent?.includes('1M (model maximum)')));
    const target = rows.find((row) => row.textContent?.trim() === '256K');
    assert.ok(target);
    await act(() => target.dispatchEvent(new window.Event('click', { bubbles: true })));
    assert.deepEqual(selected, [256_000]);
    assert.deepEqual(thinking, []);

    await render({ current: 256_000 });
    assert.equal(trigger()?.textContent?.trim(), 'Model default[256K]');
    await act(() => trigger()?.dispatchEvent(new window.Event('click', { bubbles: true })));
    const high = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((row) => row.textContent?.trim() === 'High');
    assert.ok(high);
    await act(() => high.dispatchEvent(new window.Event('click', { bubbles: true })));
    assert.deepEqual(thinking, ['high']);
    assert.deepEqual(selected, [256_000]);
    await render({ current: 256_000, thinkingHigh: true });
    assert.equal(trigger()?.textContent?.trim(), 'High[256K]');
    await act(() => trigger()?.dispatchEvent(new window.Event('click', { bubbles: true })));
    const automatic = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((row) => row.textContent?.includes('No proactive compaction target'));
    assert.ok(automatic);
    await act(() => automatic.dispatchEvent(new window.Event('click', { bubbles: true })));
    assert.deepEqual(selected, [256_000, undefined]);
    await render({ current: 1_000_000, chinese: true });
    assert.equal(trigger()?.textContent?.trim(), '默认[1M]');

    await render({ streaming: true });
    assert.equal(trigger()?.getAttribute('aria-disabled'), 'true');
    await act(() => trigger()?.dispatchEvent(new window.Event('click', { bubbles: true })));
    assert.equal(trigger()?.getAttribute('aria-expanded'), 'false');
    await render({ pending: true });
    assert.equal(trigger()?.getAttribute('aria-disabled'), 'true');
    await render({ unknownMaximum: true });
    assert.equal(trigger()?.textContent?.trim(), 'Model default');
    await render({ noThinking: true, current: 512_000 });
    assert.equal(trigger()?.textContent?.trim(), 'Model default[512K]');
    await render({ unknownMaximum: true, noThinking: true });
    assert.equal(trigger(), null);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
