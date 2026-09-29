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
import type { UserQuestionRequestEvent } from '@maka/core/events';
import { clearUserQuestionWizardState } from '../user-question-prompt-state.js';
import { UserQuestionPrompt } from '../user-question-prompt.js';
import { LocaleProvider } from '../locale-context.js';

const request: UserQuestionRequestEvent = {
  type: 'user_question_request',
  id: 'event-1',
  turnId: 'turn-1',
  ts: 1,
  requestId: 'question-1',
  toolUseId: 'tool-1',
  questions: [
    {
      question: 'First question?',
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
    },
    {
      question: 'Second question?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    },
  ],
};

test('remounting the same request restores wizard progress after a session switch', async () => {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  clearUserQuestionWizardState(request.requestId);

  const render = async () => {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <UserQuestionPrompt request={request} onRespond={() => undefined} onStop={() => undefined} />
      </LocaleProvider>,
    ));
  };

  try {
    await render();
    assert.match(container.textContent ?? '', /1 \/ 2/);

    const beta = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Beta'));
    assert.ok(beta);
    await act(() => beta.click());

    const nextButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Next');
    assert.ok(nextButton);
    await act(() => nextButton.click());

    assert.match(container.textContent ?? '', /2 \/ 2/);
    assert.match(container.textContent ?? '', /Second question\?/);

    await act(() => root.render(null));
    await render();

    assert.match(container.textContent ?? '', /2 \/ 2/);
    assert.match(container.textContent ?? '', /Second question\?/);

    const previousButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Previous');
    assert.ok(previousButton);
    await act(() => previousButton.click());

    const restoredBeta = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Beta'));
    assert.ok(restoredBeta);
    assert.equal(restoredBeta.getAttribute('aria-selected'), 'true');
    await act(() => root.render(null));
    await act(() => root.render(
      <LocaleProvider locale="en">
        <UserQuestionPrompt
          request={{ ...request, requestId: 'question-2' }}
          onRespond={() => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));
    assert.match(container.textContent ?? '', /1 \/ 2/);
    assert.match(container.textContent ?? '', /First question\?/);
  } finally {
    clearUserQuestionWizardState(request.requestId);
    clearUserQuestionWizardState('question-2');
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
