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
import {
  clearUserQuestionWizardState,
  readUserQuestionWizardState,
} from '../user-question-prompt-state.js';
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

test('switching between pending requests without unmounting restores each wizard', async () => {
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
  const requestA = request;
  const requestB: UserQuestionRequestEvent = {
    ...request,
    id: 'event-2',
    requestId: 'question-2',
    toolUseId: 'tool-2',
  };
  clearUserQuestionWizardState(requestA.requestId);
  clearUserQuestionWizardState(requestB.requestId);

  const render = async (active: UserQuestionRequestEvent) => {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <UserQuestionPrompt request={active} onRespond={() => undefined} onStop={() => undefined} />
      </LocaleProvider>,
    ));
  };

  const clickNext = async () => {
    const beta = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Beta'));
    assert.ok(beta);
    await act(() => beta.click());
    const nextButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Next');
    assert.ok(nextButton);
    await act(() => nextButton.click());
  };

  try {
    await render(requestA);
    await clickNext();
    assert.match(container.textContent ?? '', /2 \/ 2/);

    await render(requestB);
    assert.match(container.textContent ?? '', /1 \/ 2/);
    assert.deepEqual(readUserQuestionWizardState(requestA.requestId)?.questionIndex, 1);

    await render(requestA);
    assert.match(container.textContent ?? '', /2 \/ 2/);

    await render(requestB);
    assert.match(container.textContent ?? '', /1 \/ 2/);
  } finally {
    clearUserQuestionWizardState(requestA.requestId);
    clearUserQuestionWizardState(requestB.requestId);
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});

test('successful submit clears remembered progress after unmount', async () => {
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

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <UserQuestionPrompt
          request={request}
          onRespond={async () => undefined}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));

    const beta = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Beta'));
    assert.ok(beta);
    await act(() => beta.click());
    const nextButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Next');
    assert.ok(nextButton);
    await act(() => nextButton.click());

    const yes = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Yes'));
    assert.ok(yes);
    await act(() => yes.click());

    const submitButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Submit answers');
    assert.ok(submitButton);
    await act(async () => submitButton.click());

    assert.equal(readUserQuestionWizardState(request.requestId), undefined);
    await act(() => root.unmount());
    assert.equal(readUserQuestionWizardState(request.requestId), undefined);
  } finally {
    clearUserQuestionWizardState(request.requestId);
    Object.assign(globalThis, original);
  }
});

test('late rejection after unmount keeps remembered progress', async () => {
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
  let rejectResponse: (() => void) | undefined;
  const response = new Promise<void>((_resolve, reject) => {
    rejectResponse = () => reject(new Error('host rejected'));
  });

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <UserQuestionPrompt
          request={request}
          onRespond={async () => response}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));

    const beta = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Beta'));
    assert.ok(beta);
    await act(() => beta.click());
    const nextButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Next');
    assert.ok(nextButton);
    await act(() => nextButton.click());

    const yes = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Yes'));
    assert.ok(yes);
    await act(() => yes.click());

    const submitButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Submit answers');
    assert.ok(submitButton);
    await act(() => submitButton.click());
    await act(() => root.unmount());
    assert.equal(readUserQuestionWizardState(request.requestId)?.questionIndex, 1);

    rejectResponse?.();
    await act(async () => {
      await response.catch(() => undefined);
    });
    assert.equal(readUserQuestionWizardState(request.requestId)?.questionIndex, 1);
  } finally {
    clearUserQuestionWizardState(request.requestId);
    Object.assign(globalThis, original);
  }
});

test('failed responses keep wizard progress for retry', async () => {
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
  let shouldFail = true;

  try {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <UserQuestionPrompt
          request={request}
          onRespond={async () => {
            if (shouldFail) throw new Error('host rejected');
          }}
          onStop={() => undefined}
        />
      </LocaleProvider>,
    ));

    const beta = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Beta'));
    assert.ok(beta);
    await act(() => beta.click());
    const nextButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Next');
    assert.ok(nextButton);
    await act(() => nextButton.click());
    assert.match(container.textContent ?? '', /2 \/ 2/);

    const yes = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('Yes'));
    assert.ok(yes);
    await act(() => yes.click());

    const submitButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Submit answers');
    assert.ok(submitButton);
    await act(async () => {
      try {
        await submitButton.click();
      } catch {
        // UserQuestionPrompt handles the rejection internally.
      }
    });

    assert.match(container.textContent ?? '', /2 \/ 2/);
    assert.ok(readUserQuestionWizardState(request.requestId));
    shouldFail = false;
  } finally {
    clearUserQuestionWizardState(request.requestId);
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});
