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
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { SessionSummary } from '@maka/core/session';
import { Composer, type ComposerHandle } from '../composer.js';
import { ThinkingLevelSelector } from '../chat-model-switcher.js';
import { deriveComposerModelSwitchAvailability } from '../composer-helpers.js';
import { LocaleProvider } from '../locale-context.js';

test('the native model pair remains the model-selection slot fallback', () => {
  const session = {
    id: 'codex-session',
    llmConnectionSlug: 'executor:codex.app-server',
    model: 'gpt-6-astra',
  } as SessionSummary;
  const choice: ChatModelChoice = {
    connectionId: 'native-connection',
    connectionSlug: 'native',
    connectionName: 'Native',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'native-model',
    label: 'Native model',
    isDefault: true,
    thinkingLevels: ['low', 'high'],
  };
  const render = (executor: boolean) => renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer
        activeSession={session}
        activeModelConnectionId={choice.connectionId}
        activeModelConnectionSlug={choice.connectionSlug}
        activeModel={choice.model}
        activeModelLabel={choice.label}
        activeThinkingLevels={choice.thinkingLevels}
        modelChoices={[choice]}
        {...(executor
          ? { executorTarget: { executorId: 'codex.app-server', model: 'gpt-6-astra', thinkingLevel: 'high' } }
          : {})}
        onModelChange={() => undefined}
        onThinkingLevelChange={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
      />
    </LocaleProvider>,
  );

  const native = render(false);
  assert.match(native, /maka-model-switcher-trigger/u);
  assert.match(native, /maka-thinking-level-selector/u);

  const pluginExecutorWithoutClientContribution = render(true);
  assert.match(pluginExecutorWithoutClientContribution, /maka-model-switcher-trigger/u);
  assert.match(pluginExecutorWithoutClientContribution, /maka-thinking-level-selector/u);
  assert.match(pluginExecutorWithoutClientContribution, /conversation\.composer\.model-selection/u);
});

test('model switch availability has one priority-ordered contract', () => {
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({ streaming: true, sessionStatus: 'running', pending: true }),
    { available: false, pending: true, reason: 'streaming' },
  );
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({ sessionStatus: 'running', pending: true }),
    { available: false, pending: true, reason: 'running' },
  );
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({ sessionStatus: 'waiting_for_user', pending: true }),
    { available: false, pending: true, reason: 'permission' },
  );
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({ pending: true }),
    { available: false, pending: true, reason: 'pending' },
  );
  assert.deepEqual(
    deriveComposerModelSwitchAvailability({}),
    { available: true, pending: false },
  );
});

test('the recovery handle opens the existing exact account-and-model picker', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLBRElement: globalThis.HTMLBRElement,
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
  window.scrollBy = () => {};
  window.getSelection = () =>
    ({
      rangeCount: 0,
      isCollapsed: true,
      anchorNode: null,
      focusNode: null,
      removeAllRanges() {},
      addRange() {},
      getRangeAt: () => {
        throw new Error('no range');
      },
    }) as unknown as Selection;
  document.createRange = () =>
    ({
      selectNodeContents() {},
      collapse() {},
      cloneRange() {
        return this;
      },
    }) as unknown as Range;
  // linkedom has no <dialog> behavior: the bottom sheet needs showModal/close
  // to mount its panel, so the stubs only toggle the `open` attribute.
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) { this.setAttribute('open', ''); },
    show(this: HTMLElement) { this.setAttribute('open', ''); },
    close(this: HTMLElement) { this.removeAttribute('open'); },
  });
  Object.assign(globalThis, {
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLBRElement: window.HTMLBRElement,
    Node: window.Node,
    matchMedia: window.matchMedia,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const composer = createRef<ComposerHandle>();
  let selected: {
    llmConnectionId: string;
    llmConnectionSlug: string;
    model: string;
  } | undefined;
  const choice: ChatModelChoice = {
    connectionId: 'connection-openrouter',
    connectionSlug: 'openrouter',
    connectionName: 'OpenRouter',
    providerType: 'openrouter',
    providerLabel: 'OpenRouter',
    model: 'openai/gpt-5',
    label: 'GPT-5',
    isDefault: true,
    thinkingLevels: [],
  };

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          ref={composer}
          activeSession={{
            id: 'legacy-session',
            llmConnectionSlug: 'openrouter',
            model: 'openai/gpt-5',
          } as SessionSummary}
          modelChoices={[choice]}
          hideUnavailableCurrentModel
          onModelChange={(input) => {
            selected = input;
          }}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));
    assert.match(document.documentElement.innerHTML, /aria-expanded="false"[^>]*aria-haspopup="listbox"/);

    await act(() => composer.current?.openModelPicker());

    assert.match(document.documentElement.innerHTML, /aria-expanded="true"[^>]*aria-haspopup="listbox"/);
    assert.match(document.documentElement.innerHTML, /GPT-5/);
    const items = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(items.length, 1, 'the stale legacy target is not a selectable current row');

    await act(() => items[0]?.dispatchEvent(new window.Event('click', { bubbles: true })));

    assert.deepEqual(selected, {
      llmConnectionId: 'connection-openrouter',
      llmConnectionSlug: 'openrouter',
      model: 'openai/gpt-5',
    });
    assert.match(document.documentElement.innerHTML, /aria-expanded="false"[^>]*aria-haspopup="listbox"/);

    await act(() => root.render(
      <LocaleProvider locale="en">
        <Composer
          ref={composer}
          activeSession={{
            id: 'legacy-session',
            llmConnectionSlug: 'legacy-openrouter',
            model: 'legacy-model',
          } as SessionSummary}
          activeModelConnectionId={choice.connectionId}
          activeModelConnectionSlug={choice.connectionSlug}
          activeModel={choice.model}
          activeModelLabel={choice.label}
          modelChoices={[choice]}
          onModelChange={() => undefined}
          onSend={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));
    await act(() => composer.current?.openModelPicker());

    const selectedOption = document.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    assert.equal(selectedOption?.textContent?.includes('GPT-5'), true);
    assert.match(
      document.querySelector<HTMLElement>('.maka-model-switcher-trigger')?.textContent ?? '',
      /GPT-5/,
    );

    selected = undefined;
    let sends = 0;
    const second = { ...choice, connectionId: 'connection-second', connectionSlug: 'second', connectionName: 'Second account' };
    await act(() => root.render(
      <LocaleProvider locale="en"><Composer ref={composer}
        activeSession={{ id: 'wheel-session', llmConnectionId: choice.connectionId, llmConnectionSlug: choice.connectionSlug, model: choice.model } as SessionSummary}
        pickerPresentation="bottom-sheet" modelChoices={[choice, second]}
        onModelChange={(input) => { selected = input; }} onSend={() => { sends++; }} onStop={() => undefined} />
      </LocaleProvider>,
    ));
    await act(() => composer.current?.openModelPicker());
    const sheetOptions = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    assert.equal(sheetOptions.length, 2, 'the sheet lists both accounts');
    const secondOption = sheetOptions[1];
    await act(() => secondOption.dispatchEvent(new window.Event('click', { bubbles: true })));
    assert.deepEqual(selected, { llmConnectionId: second.connectionId, llmConnectionSlug: second.connectionSlug, model: second.model });
    assert.equal(sends, 0, 'closing the picker must not send the composer draft');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});

test('the thinking picker survives levels arriving after mount', async () => {
  // Thinking levels resolve asynchronously; a picker that mounts variantless
  // must not change its hook count when they land.
  const { document, window } = parseHTML('<div id="root"></div>');
  window.matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  Object.assign(globalThis, {
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  try {
    const render = (levels: ('low' | 'high')[]) =>
      act(() => root.render(
        <LocaleProvider locale="en"><ThinkingLevelSelector levels={levels} onChange={() => undefined} /></LocaleProvider>,
      ));
    await render([]);
    await render(['low', 'high']);
    assert.equal(
      document.querySelector('.maka-thinking-level-selector') !== null,
      true,
      'the selector mounts once variants exist',
    );
  } finally {
    await act(() => root.unmount());
  }
});
