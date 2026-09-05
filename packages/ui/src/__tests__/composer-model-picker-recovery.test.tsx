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
import { parseHTML } from 'linkedom';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { SessionSummary } from '@maka/core/session';
import { Composer, type ComposerHandle } from '../composer.js';
import { deriveComposerModelSwitchAvailability } from '../composer-helpers.js';
import { LocaleProvider } from '../locale-context.js';

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
    matchMedia: globalThis.matchMedia,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
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
    assert.match(document.documentElement.innerHTML, /aria-expanded="false"[^>]*aria-haspopup="menu"/);

    await act(() => composer.current?.openModelPicker());

    assert.match(document.documentElement.innerHTML, /aria-expanded="true"[^>]*aria-haspopup="menu"/);
    assert.match(document.documentElement.innerHTML, /GPT-5/);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.equal(items.length, 1, 'the stale legacy target is not a selectable current row');

    await act(() => items[0]?.dispatchEvent(new window.Event('click', { bubbles: true })));

    assert.deepEqual(selected, {
      llmConnectionId: 'connection-openrouter',
      llmConnectionSlug: 'openrouter',
      model: 'openai/gpt-5',
    });
    assert.match(document.documentElement.innerHTML, /aria-expanded="false"[^>]*aria-haspopup="menu"/);

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

    const selectedRadio = document.querySelector<HTMLElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    assert.equal(selectedRadio?.textContent?.includes('GPT-5'), true);
    assert.match(
      document.querySelector<HTMLElement>('.maka-model-switcher-trigger')?.getAttribute('aria-label') ?? '',
      /GPT-5/,
    );
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
