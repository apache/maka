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
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LocaleProvider } from '@maka/ui';
import {
  type WorkbarServices,
  createFakeWorkbarServices,
  WorkbarServicesProvider,
  SessionReviewPanel,
  persistSessionReviewBaseBranch,
} from '../../renderer/features/workbar/testing.js';

test('a saved failing comparison keeps the picker available and can recover', async () => {
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const storage = new Map<string, string>();
  const globals = {
    document, window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  };
  const previous = new Map(Object.keys(globals).map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  const requests: Array<string | undefined> = [];
  const branches = {
    currentBranch: 'feature',
    baseBranchOptions: [
      { label: 'main', value: 'refs/heads/main' },
      { label: 'gh-pages', value: 'refs/heads/gh-pages' },
    ],
  };
  const review: WorkbarServices['review'] = {
    read: async ({ baseBranch }) => {
      requests.push(baseBranch);
      if (baseBranch === 'refs/heads/gh-pages') {
        return { ok: false, reason: 'git_failed', branches };
      }
      return {
        ok: true,
        snapshot: {
          ...branches, source: 'branch', repositoryRoot: '/repo',
          baseBranch: 'refs/heads/main', revision: 'recovered',
          files: [], additions: 0, deletions: 0, truncated: false,
        },
      };
    },
    subscribeSessionEvents: () => () => undefined,
  };
  const services = createFakeWorkbarServices({ review });
  try {
    persistSessionReviewBaseBranch('saved-session', 'refs/heads/gh-pages');
    await act(async () => {
      root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(WorkbarServicesProvider, { services },
          createElement(SessionReviewPanel, { sessionId: 'saved-session', active: true })),
      }));
    });
    assert.match(container.textContent ?? '', /Could not read Git workspace changes/);
    const trigger = container.querySelector<HTMLButtonElement>('.maka-session-review-base-branch button');
    assert.ok(trigger, 'failed initial read must preserve a comparison picker');
    await act(async () => { trigger.click(); });
    const main = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent === 'main');
    assert.ok(main, 'main remains selectable after the diff fails');
    await act(async () => { main.click(); });
    assert.deepEqual(requests, ['refs/heads/gh-pages', 'refs/heads/main']);
    assert.doesNotMatch(container.textContent ?? '', /Could not read Git workspace changes/);
    assert.ok(container.querySelector<HTMLButtonElement>('.maka-session-review-base-branch button'));
  } finally {
    await act(async () => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
