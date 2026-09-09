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
import { afterEach, describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  persistSessionReviewBaseBranch,
  readSessionReviewBaseBranch,
  resolveAdoptedBaseBranch,
  REVIEW_BASE_BRANCH_STORAGE_KEY,
  reviewBaseBranchRequestValue,
  SessionReviewBaseBranchPicker,
} from '../../renderer/features/workbar/testing.js';

function installMemoryLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const memory: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => store.set(key, String(value)),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: memory,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

const AUTO_SENTINEL = 'AUTO_SENTINEL';

function renderPicker(baseBranch: string | null) {
  return renderToStaticMarkup(
    createElement(SessionReviewBaseBranchPicker, {
      baseBranch,
      baseBranchOptions: ['main', 'origin/develop'],
      label: AUTO_SENTINEL,
      onSelect: () => undefined,
    }),
  );
}

/** The visible trigger only: `label` is required by Selector and always lands
 * in the markup as a visually hidden element, sentinel and all. */
function renderTrigger(baseBranch: string | null) {
  const markup = renderPicker(baseBranch);
  const start = markup.indexOf('<button');
  return markup.slice(start, markup.indexOf('</button>', start));
}

describe('session review base branch', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('omits the request value until a branch is selected', () => {
    assert.equal(reviewBaseBranchRequestValue(null), undefined);
    assert.equal(reviewBaseBranchRequestValue('origin/develop'), 'origin/develop');
  });

  it('adopts the resolved base branch only when the backend offers it', () => {
    const options = ['main', 'origin/develop'];
    assert.equal(
      resolveAdoptedBaseBranch('origin/develop', {
        baseBranch: 'main',
        baseBranchOptions: options,
      }),
      'origin/develop',
    );
    assert.equal(
      resolveAdoptedBaseBranch(null, { baseBranch: 'main', baseBranchOptions: options }),
      'main',
    );
    // A resolved branch the backend would reject on the next read stays unpinned.
    assert.equal(
      resolveAdoptedBaseBranch(null, {
        baseBranch: 'origin/gone',
        baseBranchOptions: options,
      }),
      null,
    );
    assert.equal(
      resolveAdoptedBaseBranch(null, { baseBranch: null, baseBranchOptions: options }),
      null,
    );
  });

  it('pins the branch per Session and survives corrupt storage', () => {
    cleanups.push(installMemoryLocalStorage());
    persistSessionReviewBaseBranch('session-a', 'origin/develop');
    persistSessionReviewBaseBranch('session-b', 'main');
    assert.equal(readSessionReviewBaseBranch('session-a'), 'origin/develop');
    assert.equal(readSessionReviewBaseBranch('session-b'), 'main');

    persistSessionReviewBaseBranch('session-a', null);
    assert.equal(readSessionReviewBaseBranch('session-a'), null);
    assert.equal(readSessionReviewBaseBranch('session-b'), 'main');

    localStorage.setItem(REVIEW_BASE_BRANCH_STORAGE_KEY, '{ not json');
    assert.equal(readSessionReviewBaseBranch('session-b'), null);
    localStorage.setItem(
      REVIEW_BASE_BRANCH_STORAGE_KEY,
      JSON.stringify({ 'session-c': 7, 'session-d': 'main' }),
    );
    assert.equal(readSessionReviewBaseBranch('session-c'), null);
    assert.equal(readSessionReviewBaseBranch('session-d'), 'main');
  });

  it('shows the compared branch instead of an auto pseudo-entry', () => {
    const trigger = renderTrigger('origin/develop');
    assert.match(trigger, /origin\/develop/);
    assert.doesNotMatch(trigger, new RegExp(AUTO_SENTINEL));
  });

  it('falls back to the plain label while nothing is pinned', () => {
    assert.match(renderTrigger(null), new RegExp(AUTO_SENTINEL));
  });
});
