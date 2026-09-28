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
import { describe, it, mock } from 'node:test';
import { createSessionRailLayoutStore } from '../../renderer/features/session-navigation/testing.js';

const VIEW_MODE_KEY = 'maka-chat-list-view-mode-v1';
const WIDTH_KEY = 'maka-chat-list-width-v1';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, value);
  }

  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function withStorage<T>(seed: Record<string, string>, run: (storage: MemoryStorage) => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage(seed);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    return run(storage);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

describe('session rail grouping persistence', () => {
  it('accepts exactly the serialized public modes', () => {
    for (const [stored, expected] of [
      [undefined, 'conversation'],
      ['conversation', 'conversation'],
      ['project', 'project'],
      ['', 'conversation'],
      ['time', 'conversation'],
      ['PROJECT', 'conversation'],
      ['conversation\n', 'conversation'],
    ] as const) {
      const seed: Record<string, string> = {};
      if (stored !== undefined) seed[VIEW_MODE_KEY] = stored;
      withStorage(seed, () => {
        assert.equal(createSessionRailLayoutStore().getState().viewMode, expected);
      });
    }
  });

  it('round-trips every supported mode through a fresh store', () => {
    withStorage({}, (storage) => {
      const store = createSessionRailLayoutStore();
      for (const mode of ['project', 'conversation', 'project'] as const) {
        store.setViewMode(mode);
        assert.equal(storage.getItem(VIEW_MODE_KEY), mode);
        assert.equal(createSessionRailLayoutStore().getState().viewMode, mode);
      }
    });
  });
});

describe('session rail width persistence', () => {
  it('coalesces a resize burst into the final expanded width', () => {
    withStorage({}, (storage) => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const store = createSessionRailLayoutStore();
        for (const width of [320, 360, 400]) store.setWidth(width);
        assert.equal(storage.getItem(WIDTH_KEY), null);
        mock.timers.tick(200);
        assert.equal(store.getState().width, 400);
        assert.equal(storage.getItem(WIDTH_KEY), '400');
      } finally {
        mock.timers.reset();
      }
    });
  });

  it('treats collapse width zero as presentation state, not persisted geometry', () => {
    withStorage({ [WIDTH_KEY]: '400' }, (storage) => {
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const store = createSessionRailLayoutStore();
        store.setCollapsed(true);
        store.setWidth(0);
        mock.timers.tick(200);
        assert.equal(store.getState().width, 400);
        assert.equal(storage.getItem(WIDTH_KEY), '400');
      } finally {
        mock.timers.reset();
      }
    });
  });
});
