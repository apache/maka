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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, LocaleProvider } from '@maka/ui';
import type { GoalArmOutcome } from '../../shared/goal-arm.js';
import { GoalDialog } from '../../renderer/features/goals/testing.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  CSS: globalThis.CSS,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

test('ignores a stale Goal arm result after switching Sessions', async () => {
  const first = deferred<GoalArmOutcome>();
  const calls: string[] = [];
  const harness = installGoalDialog(async (sessionId) => {
    calls.push(sessionId);
    return first.promise;
  });
  await harness.render('session-1');
  await setInputValue(harness.document, 'textarea', 'Finish session one');
  await clickButton(harness.document, 'Start');
  assert.deepEqual(calls, ['session-1']);

  await harness.render('session-2');
  first.resolve({ kind: 'reconciliation_unavailable' });
  await act(async () => {
    await first.promise;
    await Promise.resolve();
  });

  assert.doesNotMatch(harness.document.body.textContent, /cannot be confirmed/);
  assert.equal(harness.closed, 0);
});

test('ignores a stale Goal arm rejection after closing and reopening', async () => {
  const first = deferred<GoalArmOutcome>();
  const harness = installGoalDialog(async () => first.promise);
  await harness.render('session-1');
  await setInputValue(harness.document, 'textarea', 'Finish session one');
  await clickButton(harness.document, 'Start');

  await harness.render(undefined);
  await harness.render('session-1');
  first.reject(new Error('old rejection'));
  await act(async () => {
    await first.promise.catch(() => undefined);
    await Promise.resolve();
  });

  assert.doesNotMatch(harness.document.body.textContent, /goal could not be set/i);
  assert.equal(harness.document.querySelector('textarea')?.hasAttribute('disabled'), false);
  assert.equal(harness.closed, 0);
});

test('closes only for armed and locks reconciled state until reopen', async () => {
  const goal = goalState();
  let outcome: GoalArmOutcome = {
    kind: 'reconciled',
    currentGoal: null,
    matchesRequestedState: false,
  };
  const harness = installGoalDialog(async () => outcome);
  await harness.render('session-1');
  await setInputValue(harness.document, 'textarea', 'Finish session one');
  await clickButton(harness.document, 'Start');

  assert.equal(harness.closed, 0);
  assert.match(harness.document.body.textContent, /no Goal was found/);
  assert.equal(harness.document.querySelector('textarea')?.hasAttribute('disabled'), true);
  assert.equal(findButton(harness.document, 'Start').hasAttribute('disabled'), true);

  await harness.render(undefined);
  await harness.render('session-1');
  assert.doesNotMatch(harness.document.body.textContent, /no Goal was found/);
  assert.equal(harness.document.querySelector('textarea')?.hasAttribute('disabled'), false);

  outcome = { kind: 'armed', goal };
  await setInputValue(harness.document, 'textarea', 'Finish session one');
  await clickButton(harness.document, 'Start');
  assert.equal(harness.closed, 1);
});

test('keeps the Goal form editable after a deterministic rejection', async () => {
  const harness = installGoalDialog(async () => {
    throw new Error('Goal already exists');
  });
  await harness.render('session-1');
  await setInputValue(harness.document, 'textarea', 'Finish session one');
  await clickButton(harness.document, 'Start');

  assert.equal(harness.closed, 0);
  assert.match(harness.document.body.textContent, /goal could not be set/i);
  assert.equal(harness.document.querySelector('textarea')?.hasAttribute('disabled'), false);
  assert.equal(findButton(harness.document, 'Start').hasAttribute('disabled'), false);
});

function installGoalDialog(
  arm: (sessionId: string) => Promise<GoalArmOutcome>,
) {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>');
  const { document, window } = parsed;
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(window, { matchMedia, scrollTo() {} });
  Object.assign(window.HTMLElement.prototype, {
    showModal(this: HTMLElement) {
      this.setAttribute('open', '');
    },
    close(this: HTMLElement) {
      this.removeAttribute('open');
    },
  });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event,
    Node: window.Node,
    CSS: { escape: (value: string) => value },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  let closed = 0;
  return {
    document,
    get closed() {
      return closed;
    },
    async render(sessionId: string | undefined) {
      await act(async () => {
        root.render(
          createElement(LocaleProvider, {
            locale: 'en',
            children: createElement(AstryxLocaleProvider, {
              children: createElement(GoalDialog, {
                sessionId,
                onArm: arm,
                onClose: () => {
                  closed += 1;
                },
              }),
            }),
          }),
        );
        await Promise.resolve();
      });
    },
  };
}

async function setInputValue(
  document: Document,
  selector: string,
  value: string,
): Promise<void> {
  const input = document.querySelector(selector) as HTMLInputElement | null;
  assert.ok(input, `missing input: ${selector}`);
  await act(async () => {
    input.value = value;
    const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
    assert.ok(propsKey, 'missing React props on input');
    const props = (input as unknown as Record<string, unknown>)[propsKey] as {
      onChange?: (event: { target: HTMLInputElement; defaultPrevented: boolean }) => void;
    };
    assert.ok(props.onChange, 'missing React change handler');
    props.onChange({ target: input, defaultPrevented: false });
    await Promise.resolve();
  });
}

async function clickButton(document: Document, label: string): Promise<void> {
  const button = findButton(document, label);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function findButton(document: Document, label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  ) as HTMLButtonElement | undefined;
  assert.ok(button, `missing button: ${label}`);
  return button;
}
function goalState() {
  return {
    id: 'goal-1',
    revision: 1,
    sessionId: 'session-1',
    condition: 'Finish session one',
    status: 'active' as const,
    setAt: 1,
    iterations: 0,
    maxIterations: 50,
    consecutiveNoProgress: 0,
    blockCap: 8,
    tokensAtStart: 0,
    tokensNow: 0,
    tokensBaselinePending: false,
  };
}
