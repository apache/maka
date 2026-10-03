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
 * The question wizard caches its progress on the request object the
 * interaction queue holds and never clears it itself: the Desktop adapters
 * report a failed answer or stop with a toast and RESOLVE rather than reject,
 * so fulfillment is no evidence that the request settled. These tests mount
 * the real prompt against the real adapters and a failing bridge: a failed
 * stop or answer must leave the wizard resumable, exactly the regression
 * reproduced in review.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { LocaleProvider, UserQuestionPrompt } from '@maka/ui';
import type { UserQuestionRequestEvent } from '@maka/core/events';
import { createAppShellStopAction } from '../../renderer/app-shell-stop-action.js';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';
import { createActionsDeps } from './app-shell-chat-actions-fixture.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

function makeRequest(requestId: string): UserQuestionRequestEvent {
  return {
    type: 'user_question_request',
    id: `event-${requestId}`,
    turnId: 'turn-1',
    ts: 1,
    requestId,
    toolUseId: `tool-${requestId}`,
    questions: [
      { question: 'First question?', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
      { question: 'Second question?', options: [{ label: 'One' }, { label: 'Two' }] },
    ],
  };
}

function mountPrompt(callbacks: {
  onRespond: Parameters<typeof UserQuestionPrompt>[0]['onRespond'];
  onStop: Parameters<typeof UserQuestionPrompt>[0]['onStop'];
}) {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(window, {
    getComputedStyle: () =>
      ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration,
    getSelection: () => null,
  });
  Object.assign(document, { getSelection: () => null });
  (document as unknown as { execCommand: () => boolean }).execCommand = () => true;
  window.HTMLElement.prototype.focus = () => undefined;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root') as unknown as HTMLElement;
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;

  const render = async (node: ReactNode) => {
    await act(async () => {
      root.render(node);
      await Promise.resolve();
    });
  };
  const prompt = (request: UserQuestionRequestEvent) =>
    h(LocaleProvider, {
      locale: 'en',
      children: h(UserQuestionPrompt, { request, onRespond: callbacks.onRespond, onStop: callbacks.onStop }),
    });
  const click = async (element: Element) => {
    const event = new window.Event('click', { bubbles: true, cancelable: true });
    Object.assign(event, { detail: 1, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
    await act(async () => {
      element.dispatchEvent(event);
      await Promise.resolve();
    });
  };
  return {
    window,
    render,
    prompt,
    progress: () => container.querySelector('.maka-question-progress')?.textContent ?? undefined,
    async clickOption(index: number) {
      const option = container.querySelectorAll('[role="option"]')[index];
      assert.ok(option, `option ${index} exists`);
      await click(option);
    },
    async clickButton(label: string) {
      const button = Array.from(container.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(button, `button "${label}" exists`);
      await click(button);
    },
  };
}

test('failed stop through the real app-shell stop action keeps the wizard resumable', async () => {
  const toasts: string[] = [];
  const request = makeRequest('adapter-stop');
  const dom = mountPrompt({
    onRespond: () => undefined,
    onStop: () => undefined, // replaced below; the real action needs window.maka
  });
  (dom.window as unknown as { maka: unknown }).maka = {
    sessions: {
      stop: async () => {
        throw new Error('ipc down');
      },
    },
  };
  const stop = createAppShellStopAction({
    uiLocale: 'en',
    activeIdRef: { current: 'session-1' },
    stopPending: { claim: () => true, release: () => undefined },
    removeTransientMessage: () => undefined,
    toastApi: { error(title?: string) { toasts.push(title ?? ''); } },
  });

  await dom.render(dom.prompt(request));
  // Re-render with the real stop action wired, as app-shell passes it.
  await dom.render(h(LocaleProvider, {
    locale: 'en',
    children: h(UserQuestionPrompt, { request, onRespond: () => undefined, onStop: stop }),
  }));
  await dom.clickOption(0);
  await dom.clickButton('Next');
  assert.equal(dom.progress(), '2 / 2');

  await dom.clickButton('Stop');
  assert.equal(toasts.length, 1, 'the failure surfaced as a toast');

  // Session switch round trip: the wizard must resume, not restart — even
  // though the adapter reported the failure as a toast and RESOLVED.
  await dom.render(null);
  await dom.render(h(LocaleProvider, {
    locale: 'en',
    children: h(UserQuestionPrompt, { request, onRespond: () => undefined, onStop: stop }),
  }));
  assert.equal(dom.progress(), '2 / 2');
});

test('failed answer through the real app-shell chat actions keeps the wizard resumable', async () => {
  const toasts: string[] = [];
  const request = makeRequest('adapter-respond');
  const dom = mountPrompt({ onRespond: () => undefined, onStop: () => undefined });
  (dom.window as unknown as { maka: unknown }).maka = {
    sessions: {
      respondToUserQuestion: async () => {
        throw new Error('ipc down');
      },
    },
  };
  const deps = createActionsDeps();
  deps.activeIdRef.current = 'session-1';
  const actions = createAppShellChatActions({
    ...deps,
    toastApi: { error(title?: string) { toasts.push(title ?? ''); }, info: () => undefined },
  } as Parameters<typeof createAppShellChatActions>[0]);
  const mount = () => h(LocaleProvider, {
    locale: 'en',
    children: h(UserQuestionPrompt, { request, onRespond: actions.respondToUserQuestion, onStop: () => undefined }),
  });

  await dom.render(mount());
  await dom.clickOption(0);
  await dom.clickButton('Next');
  await dom.clickOption(1);
  await dom.clickButton('Submit answers');
  assert.equal(toasts.length, 1, 'the failure surfaced as a toast');

  await dom.render(null);
  await dom.render(mount());
  assert.equal(dom.progress(), '2 / 2');
});
