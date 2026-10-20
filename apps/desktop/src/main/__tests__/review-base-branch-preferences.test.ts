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
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createReviewBaseBranchPreferences,
  REVIEW_BASE_BRANCH_STORAGE_KEY,
} from '../../renderer/platform/desktop/review-base-branch-preferences.js';

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
}

describe('Desktop review base branch preferences', () => {
  let storage: ReturnType<typeof memoryStorage>;
  let originalStorage: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    storage = memoryStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  });

  afterEach(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('persists explicit refs across adapter instances without pinning new Sessions', () => {
    const preferences = createReviewBaseBranchPreferences();
    preferences.write('session-a', 'refs/remotes/origin/develop');
    preferences.write('session-b', 'refs/heads/main');
    const reopened = createReviewBaseBranchPreferences();
    assert.equal(reopened.read('session-a'), 'refs/remotes/origin/develop');
    assert.equal(reopened.read('session-b'), 'refs/heads/main');
    assert.equal(reopened.read('new-session'), null);
    reopened.write('session-a', null);
    assert.equal(preferences.read('session-a'), null);
    assert.equal(preferences.read('session-b'), 'refs/heads/main');
  });

  it('ignores malformed records and recovers on the next explicit choice', () => {
    const preferences = createReviewBaseBranchPreferences();
    for (const invalid of ['{ not json', 'null', '[]', '3']) {
      storage.setItem(REVIEW_BASE_BRANCH_STORAGE_KEY, invalid);
      assert.equal(preferences.read('session'), null);
      preferences.write('session', 'refs/heads/main');
      assert.equal(preferences.read('session'), 'refs/heads/main');
    }
    storage.setItem(REVIEW_BASE_BRANCH_STORAGE_KEY, JSON.stringify({
      empty: '', invalid: 7, valid: 'refs/heads/main',
    }));
    assert.equal(preferences.read('empty'), null);
    assert.equal(preferences.read('invalid'), null);
    assert.equal(preferences.read('valid'), 'refs/heads/main');
    preferences.write('another', 'refs/heads/develop');
    assert.deepEqual(JSON.parse(storage.getItem(REVIEW_BASE_BRANCH_STORAGE_KEY)!), {
      valid: 'refs/heads/main', another: 'refs/heads/develop',
    });
  });

  it('handles a restricted localStorage getter lazily', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('Storage access denied'); },
    });
    const preferences = createReviewBaseBranchPreferences();
    assert.equal(preferences.read('session'), null);
    assert.doesNotThrow(() => preferences.write('session', 'refs/heads/main'));
    assert.doesNotThrow(() => preferences.write('session', null));
  });

  it('handles read failures and quota errors without breaking comparisons', () => {
    storage.getItem = () => { throw new Error('Read denied'); };
    storage.setItem = () => { throw new Error('Quota exceeded'); };
    const preferences = createReviewBaseBranchPreferences();
    assert.equal(preferences.read('session'), null);
    assert.doesNotThrow(() => preferences.write('session', 'refs/heads/main'));
  });
});
