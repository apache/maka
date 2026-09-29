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

class TestStorage implements Storage {
  readonly #values: Map<string, string>;

  constructor(seed: Record<string, string>) {
    this.#values = new Map(Object.entries(seed));
  }

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

function withLocalStorage<T>(seed: Record<string, string>, run: (storage: TestStorage) => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new TestStorage(seed);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    return run(storage);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

function withMockedTimeouts(run: () => void): void {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    run();
  } finally {
    mock.timers.reset();
  }
}

describe('session grouping persistence', () => {
  it('hydrates only the two supported grouping values', () => {
    const cases = [
      { expected: 'conversation', stored: undefined },
      { expected: 'conversation', stored: 'conversation' },
      { expected: 'project', stored: 'project' },
      { expected: 'conversation', stored: '' },
      { expected: 'conversation', stored: 'time' },
      { expected: 'conversation', stored: 'PROJECT' },
      { expected: 'conversation', stored: 'conversation\n' },
    ] as const;
    for (const { expected, stored } of cases) {
      const seed: Record<string, string> = {};
      if (stored !== undefined) seed[VIEW_MODE_KEY] = stored;
      withLocalStorage(seed, () => {
        assert.equal(
          createSessionRailLayoutStore().getState().viewMode,
          expected,
          `stored=${JSON.stringify(stored)}`,
        );
      });
    }
  });

  it('persists each change and a new store hydrates the latest grouping', () => {
    withLocalStorage({}, (storage) => {
      const current = createSessionRailLayoutStore();
      current.setViewMode('project');
      assert.equal(storage.getItem(VIEW_MODE_KEY), 'project');
      assert.equal(createSessionRailLayoutStore().getState().viewMode, 'project');

      current.setViewMode('conversation');
      assert.equal(storage.getItem(VIEW_MODE_KEY), 'conversation');
      assert.equal(createSessionRailLayoutStore().getState().viewMode, 'conversation');
    });
  });
});

describe('session rail width persistence', () => {
  it('writes a debounced user width', () => {
    withLocalStorage({}, (storage) => {
      withMockedTimeouts(() => {
        const rail = createSessionRailLayoutStore();
        rail.setWidth(400);
        mock.timers.tick(200);
        assert.equal(rail.getState().width, 400);
        assert.equal(storage.getItem(WIDTH_KEY), '400');
      });
    });
  });

  it('does not replace the expanded width with the collapse sentinel', () => {
    withLocalStorage({}, (storage) => {
      withMockedTimeouts(() => {
        const rail = createSessionRailLayoutStore();
        rail.setWidth(400);
        mock.timers.tick(200);
        rail.setCollapsed(true);
        rail.setWidth(0);
        mock.timers.tick(200);
        assert.equal(rail.getState().width, 400);
        assert.equal(storage.getItem(WIDTH_KEY), '400');
      });
    });
  });
});

describe('session rail compact spell', () => {
  const COLLAPSED_KEY = 'maka-chat-list-collapsed-v1';

  it('hides the rail on a compact window without touching the stored preference', () => {
    withLocalStorage({ [COLLAPSED_KEY]: 'false' }, (storage) => {
      const store = createSessionRailLayoutStore();

      store.setCompact(true);
      assert.equal(store.getState().collapsed, true);
      store.setCompact(false);
      assert.equal(store.getState().collapsed, false);
      assert.equal(storage.getItem(COLLAPSED_KEY), 'false');
    });
  });

  it('promotes a rail opened while compact into the stored preference', () => {
    withLocalStorage({ [COLLAPSED_KEY]: 'true' }, (storage) => {
      const store = createSessionRailLayoutStore();

      store.setCompact(true);
      store.setCollapsed(false);
      assert.equal(store.getState().collapsed, false);
      store.setCompact(false);
      assert.equal(store.getState().collapsed, false);
      assert.equal(storage.getItem(COLLAPSED_KEY), 'false');
    });
  });

  it('keeps a rail the user closed while compact closed when the window widens', () => {
    withLocalStorage({ [COLLAPSED_KEY]: 'false' }, (storage) => {
      const store = createSessionRailLayoutStore();

      store.setCompact(true);
      store.setCollapsed(false);
      assert.equal(store.getState().collapsed, false);
      store.setCollapsed(true);
      assert.equal(store.getState().collapsed, true);
      store.setCompact(false);
      assert.equal(store.getState().collapsed, true);
      assert.equal(storage.getItem(COLLAPSED_KEY), 'true');
    });
  });

  it('conceals the rail for the Workbar without touching the stored preference', () => {
    withLocalStorage({ [COLLAPSED_KEY]: 'false' }, (storage) => {
      const store = createSessionRailLayoutStore();

      // The Workbar's compact band is wider than the rail's own: concealment
      // must also work while the rail itself is not compact.
      store.setSpaceConcealed(true);
      assert.equal(store.getState().collapsed, true);
      store.setSpaceConcealed(false);
      assert.equal(store.getState().collapsed, false);
      assert.equal(storage.getItem(COLLAPSED_KEY), 'false');
    });
  });

  it('lets a user toggle end a space concealment', () => {
    withLocalStorage({ [COLLAPSED_KEY]: 'false' }, () => {
      const store = createSessionRailLayoutStore();

      store.setSpaceConcealed(true);
      store.setCollapsed(false);
      assert.equal(store.getState().collapsed, false);
    });
  });
});
