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
import {
  readSessionListViewMode,
  writeSessionListViewMode,
} from '../../renderer/session-list-layout.js';

const VIEW_MODE_KEY = 'maka-chat-list-view-mode-v1';

function installMemoryLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const memory: Storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: memory,
  });
  return {
    store,
    restore() {
      if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    },
  };
}

describe('session list view mode persistence', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('defaults to conversation when nothing is stored', () => {
    cleanups.push(installMemoryLocalStorage().restore);
    assert.equal(readSessionListViewMode(), 'conversation');
  });

  it('round-trips a project grouping through the same key the shell hydrates', () => {
    const memory = installMemoryLocalStorage();
    cleanups.push(memory.restore);
    writeSessionListViewMode('project');
    assert.equal(memory.store.get(VIEW_MODE_KEY), 'project');
    assert.equal(readSessionListViewMode(), 'project');
  });

  it('keeps conversation when that is what was written', () => {
    cleanups.push(installMemoryLocalStorage({ [VIEW_MODE_KEY]: 'project' }).restore);
    writeSessionListViewMode('conversation');
    assert.equal(readSessionListViewMode(), 'conversation');
  });

  it('fails open to conversation for garbage or empty stored values', () => {
    for (const stored of ['', 'time', 'true', 'PROJECT', 'conversation\n']) {
      const memory = installMemoryLocalStorage({ [VIEW_MODE_KEY]: stored });
      assert.equal(readSessionListViewMode(), 'conversation', stored);
      memory.restore();
    }
  });
});
