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
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { UserQuestionPrompt } from '../user-question-prompt.js';
import { LocaleProvider } from '../locale-context.js';
import type { UserQuestionResponse } from '@maka/core/user-question';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  KeyboardEvent: globalThis.KeyboardEvent,
  Node: globalThis.Node,
  HTMLElement: globalThis.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  Object.assign(globalThis, originalGlobals);
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

async function mount(count: number) {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  window.getSelection = () => null;
  document.getSelection = () => null;
  Object.assign(globalThis, { document, window, Node: window.Node, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector('#root')!);
  cleanup = async () => { await act(() => root.unmount()); };
  const responses: UserQuestionResponse[] = [];
  await act(() => root.render(<LocaleProvider locale="en"><UserQuestionPrompt
    request={{ type: 'user_question_request', id: 'event', turnId: 'turn', ts: 1, requestId: 'request', toolUseId: 'tool',
      questions: Array.from({ length: count }, (_, i) => ({ question: `Question ${i}`, options: [{ label: 'Apple' }, { label: 'Pear' }] })) }}
    onRespond={response => { responses.push(response); }} onStop={() => {}} /></LocaleProvider>));
  return { document, responses, click: async (index: number) => {
    await act(async () => { document.querySelectorAll<HTMLElement>('[role="option"]')[index]!.click(); await Promise.resolve(); });
  } };
}

test('clicking an option immediately submits that answer, not the previous draft', async () => {
  const h = await mount(1);
  await h.click(1);
  assert.deepEqual(h.responses, [{ requestId: 'request', answers: ['Pear'] }]);
});
test('clicking advances questions and submits all choices only on the last question', async () => {
  const h = await mount(2);
  await h.click(1);
  assert.equal(h.responses.length, 0);
  assert.equal(h.document.querySelector('h2')?.textContent, 'Question 1');
  await h.click(0);
  assert.deepEqual(h.responses, [{ requestId: 'request', answers: ['Pear', 'Apple'] }]);
});
