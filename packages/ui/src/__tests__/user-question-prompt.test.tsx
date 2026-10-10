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
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { UserQuestionRequestEvent } from '@maka/core/events';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { UserQuestionPrompt } from '../user-question-prompt.js';
import { activeInteractionFor, enqueueInteraction, reconcileInteractions } from '../interaction-queue.js';
import { LocaleProvider } from '../locale-context.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
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

interface Harness {
  container: HTMLElement;
  render(request: UserQuestionRequestEvent | null): Promise<void>;
  responses: UserQuestionResponse[];
  clickOption(index: number): Promise<void>;
  clickButton(label: string): Promise<void>;
  progress(): string | undefined;
  selectedOptionId(): string | null;
}

async function harness(handlers: {
  onRespond?(response: UserQuestionResponse): void | Promise<void>;
  onStop?(): void | Promise<void>;
  responses?: UserQuestionResponse[];
} = {}): Promise<Harness> {
  const { document, window } = parseHTML('<div id="root"></div>');
  // The Astryx input editor expects these browser seams; the prompt never
  // exercises them, so inert stubs are enough.
  window.getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  window.getSelection = () => null;
  document.getSelection = () => null;
  window.HTMLElement.prototype.focus = () => undefined;
  document.execCommand = () => true;
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root') as unknown as HTMLElement;
  assert.ok(container);
  const root: Root = createRoot(container);
  cleanup = async () => { await act(() => root.unmount()); };
  const responses: UserQuestionResponse[] = handlers.responses ?? [];
  const render = async (request: UserQuestionRequestEvent | null) => {
    await act(async () => {
      root.render(request
        ? <LocaleProvider locale="en">
            <UserQuestionPrompt
              request={request}
              onRespond={handlers.onRespond ?? ((response) => { responses.push(response); })}
              onStop={handlers.onStop ?? (() => undefined)}
            />
          </LocaleProvider>
        : null);
      await Promise.resolve();
    });
  };
  const click = async (element: Element) => {
    const event = new window.Event('click', { bubbles: true, cancelable: true });
    Object.assign(event, { detail: 1, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false });
    await act(async () => {
      element.dispatchEvent(event);
      await Promise.resolve();
    });
  };
  return {
    container,
    render,
    responses,
    clickOption: async (index) => {
      const option = container.querySelectorAll('[role="option"]')[index];
      assert.ok(option, `option ${index} exists`);
      await click(option);
    },
    clickButton: async (label) => {
      const button = Array.from(container.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(button, `button "${label}" exists`);
      await click(button);
    },
    progress: () => container.querySelector('.maka-question-progress')?.textContent ?? undefined,
    selectedOptionId: () => container.querySelector('[role="listbox"]')?.getAttribute('aria-activedescendant') ?? null,
  };
}

test('switching sessions and back resumes the wizard instead of restarting it', async () => {
  const dom = await harness();
  const request = makeRequest('question-remount');
  await dom.render(request);
  assert.equal(dom.progress(), '1 / 2');

  await dom.clickOption(0);
  await dom.clickButton('Next');
  assert.equal(dom.progress(), '2 / 2');

  // Session switch: the prompt unmounts entirely, then remounts with the same
  // request when the user returns.
  await dom.render(null);
  await dom.render(request);

  assert.equal(dom.progress(), '2 / 2');
  // The first question's committed answer survived the round trip too.
  await dom.clickButton('Previous');
  assert.equal(dom.progress(), '1 / 2');
  assert.match(dom.selectedOptionId() ?? '', /option-0$/);
});

test('two pending requests keep independent progress', async () => {
  const dom = await harness();
  const first = makeRequest('question-first');
  const second = makeRequest('question-second');
  await dom.render(first);
  await dom.clickOption(1);
  await dom.clickButton('Next');
  assert.equal(dom.progress(), '2 / 2');

  // The other session's request replaces the prompt without an unmount.
  await dom.render(second);
  assert.equal(dom.progress(), '1 / 2');

  await dom.render(first);
  assert.equal(dom.progress(), '2 / 2');
  await dom.clickButton('Previous');
  assert.match(dom.selectedOptionId() ?? '', /option-1$/);
});

test('a failed submit keeps the cached progress for the retry', async () => {
  const dom = await harness({
    onRespond: () => Promise.reject(new Error('network down')),
  });
  const request = makeRequest('question-failing-submit');
  await dom.render(request);
  await dom.clickOption(0);
  await dom.clickButton('Next');
  await dom.clickOption(1);
  await dom.clickButton('Submit answers');
  assert.match(dom.container.textContent ?? '', /network down/);

  // The failure must not have cleared the cache: a remount resumes with both
  // answers intact so the retry does not re-ask anything.
  await dom.render(null);
  await dom.render(request);
  assert.equal(dom.progress(), '2 / 2');
  assert.match(dom.selectedOptionId() ?? '', /option-1$/);
});

test('a stop that did not go through keeps the cached progress', async () => {
  // The Desktop adapters report a failed stop with a toast and fulfill, so no
  // outcome of onStop may count as the request ending.
  let stops = 0;
  const dom = await harness({ onStop: () => { stops += 1; } });
  const request = makeRequest('question-failing-stop');
  await dom.render(request);
  await dom.clickOption(0);
  await dom.clickButton('Next');
  assert.equal(dom.progress(), '2 / 2');
  await dom.clickButton('Stop');
  assert.equal(stops, 1);

  await dom.render(null);
  await dom.render(request);
  assert.equal(dom.progress(), '2 / 2');
});

test('the prompt never forgets progress on its own: a fulfilled submit leaves the wizard resumable', async () => {
  // Forgetting is the interaction queue's job — the cache entry lives exactly
  // as long as the queue holds the request object. The prompt cannot tell a
  // real resolution from an adapter that swallowed a bridge failure and
  // fulfilled anyway, so it must not clear anything on fulfillment; that is
  // what keeps the answers for the retry in the swallowed-failure case.
  const dom = await harness();
  const request = makeRequest('question-submit');
  await dom.render(request);
  await dom.clickOption(0);
  await dom.clickButton('Next');
  await dom.clickOption(1);
  await dom.clickButton('Submit answers');

  assert.deepEqual(dom.responses, [{ requestId: 'question-submit', answers: ['Alpha', 'Two'] }]);

  await dom.render(null);
  await dom.render(request);
  assert.equal(dom.progress(), '2 / 2');
  assert.match(dom.selectedOptionId() ?? '', /option-1$/);
});

test("progress follows the queue's request object through a rehydration", async () => {
  // Returning to a session reads the runtime's live requests back over IPC —
  // a structurally equal copy of each request — and reconciles the queue
  // against them. The cache is keyed by the object the queue holds, so the
  // reconciled queue must keep that object for the wizard to resume.
  const dom = await harness();
  let queues = enqueueInteraction({}, 'session', makeRequest('question-rehydrated'));
  const shown = activeInteractionFor(queues, 'session') as UserQuestionRequestEvent;
  await dom.render(shown);
  await dom.clickOption(0);
  await dom.clickButton('Next');
  assert.equal(dom.progress(), '2 / 2');
  // Session switch: the prompt unmounts with the request still pending.
  await dom.render(null);

  queues = reconcileInteractions(queues, 'session', [structuredClone(shown)]);
  await dom.render(activeInteractionFor(queues, 'session') as UserQuestionRequestEvent);
  assert.equal(dom.progress(), '2 / 2');
  await dom.clickButton('Previous');
  assert.match(dom.selectedOptionId() ?? '', /option-0$/);
});

test('a copy of the request is a different request to the cache', async () => {
  // The cache is keyed by object identity, not requestId, so nothing but the
  // queue's own object can reach an entry — a requestId-keyed map would have
  // to decide when to forget, which is the judgement this design avoids.
  const dom = await harness();
  const request = makeRequest('question-copied');
  await dom.render(request);
  await dom.clickOption(0);
  await dom.clickButton('Next');
  assert.equal(dom.progress(), '2 / 2');
  await dom.render(null);

  await dom.render(structuredClone(request));
  assert.equal(dom.progress(), '1 / 2');
});
