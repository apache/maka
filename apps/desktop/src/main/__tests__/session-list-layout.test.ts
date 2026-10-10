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

import { strict as assert } from 'node:assert';
import * as testing from 'node:test';
import { createSessionRailLayoutStore as createLayoutStore } from '../../renderer/features/session-navigation/testing.js';
const STORAGE_KEYS = Object.freeze({
  mode: 'maka-chat-list-view-mode-v1',
  width: 'maka-chat-list-width-v1',
});
const { mode: VIEW_MODE_KEY, width: WIDTH_KEY } = STORAGE_KEYS;
const memoryStorage = (seed: Readonly<Record<string, string>> = {}): Storage => {
  const values = new Map(Object.entries(seed));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

function withStorage<T>(seed: Readonly<Record<string, string>>, run: (storage: Storage) => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = memoryStorage(seed);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    return run(storage);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    if (!previous) Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

testing.describe('session rail grouping persistence', () => {
  testing.it('accepts exactly the serialized public modes', () => {
    const projection = (stored: string | undefined) =>
      withStorage(stored === undefined ? {} : { [VIEW_MODE_KEY]: stored }, () =>
        createLayoutStore().getState().viewMode,
      );
    assert.deepEqual(
      [undefined, 'conversation', 'project', '', 'time', 'PROJECT', 'conversation\n'].map(projection),
      ['conversation', 'conversation', 'project', 'conversation', 'conversation', 'conversation', 'conversation'],
    );
  });

  testing.it('round-trips every supported mode through a fresh store', () => {
    withStorage({}, (storage) => {
      const store = createLayoutStore();
      for (const mode of ['project', 'conversation', 'project'] as const) {
        store.setViewMode(mode);
        assert.equal(storage.getItem(VIEW_MODE_KEY), mode);
        assert.equal(createLayoutStore().getState().viewMode, mode);
      }
    });
  });
});

testing.describe('session rail width persistence', () => {
  testing.it('coalesces a resize burst into the final expanded width', () => {
    withStorage({}, (storage) => {
      testing.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const store = createLayoutStore();
        for (const width of [320, 360, 400]) store.setWidth(width);
        assert.equal(storage.getItem(WIDTH_KEY), null);
        testing.mock.timers.tick(200);
        assert.equal(store.getState().width, 400);
        assert.equal(storage.getItem(WIDTH_KEY), '400');
      } finally {
        testing.mock.timers.reset();
      }
    });
  });

  testing.it('treats collapse width zero as presentation state, not persisted geometry', () => {
    withStorage({ [WIDTH_KEY]: '400' }, (storage) => {
      testing.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const store = createLayoutStore();
        store.setCollapsed(true);
        store.setWidth(0);
        testing.mock.timers.tick(200);
        assert.equal(store.getState().width, 400);
        assert.equal(storage.getItem(WIDTH_KEY), '400');
      } finally {
        testing.mock.timers.reset();
      }
    });
  });
});

testing.describe('session rail compact spell', () => {
  const COLLAPSED_KEY = 'maka-chat-list-collapsed-v1';

  testing.it('hides the rail on a compact window without touching the stored preference', () => {
    withStorage({ [COLLAPSED_KEY]: 'false' }, (storage) => {
      const store = createLayoutStore();

      store.setCompact(true);
      assert.equal(store.getState().collapsed, true);
      store.setCompact(false);
      assert.equal(store.getState().collapsed, false);
      assert.equal(storage.getItem(COLLAPSED_KEY), 'false');
    });
  });

  testing.it('promotes a rail opened while compact into the stored preference', () => {
    withStorage({ [COLLAPSED_KEY]: 'true' }, (storage) => {
      const store = createLayoutStore();

      store.setCompact(true);
      store.setCollapsed(false);
      assert.equal(store.getState().collapsed, false);
      store.setCompact(false);
      assert.equal(store.getState().collapsed, false);
      assert.equal(storage.getItem(COLLAPSED_KEY), 'false');
    });
  });

  testing.it('keeps a rail the user closed while compact closed when the window widens', () => {
    withStorage({ [COLLAPSED_KEY]: 'false' }, (storage) => {
      const store = createLayoutStore();

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

  testing.it('conceals the rail for the Workbar without touching the stored preference', () => {
    withStorage({ [COLLAPSED_KEY]: 'false' }, (storage) => {
      const store = createLayoutStore();

      // The Workbar's compact band is wider than the rail's own: concealment
      // must also work while the rail itself is not compact.
      store.setSpaceConcealed(true);
      assert.equal(store.getState().collapsed, true);
      store.setSpaceConcealed(false);
      assert.equal(store.getState().collapsed, false);
      assert.equal(storage.getItem(COLLAPSED_KEY), 'false');
    });
  });

  testing.it('lets a user toggle end a space concealment', () => {
    withStorage({ [COLLAPSED_KEY]: 'false' }, () => {
      const store = createLayoutStore();

      store.setSpaceConcealed(true);
      store.setCollapsed(false);
      assert.equal(store.getState().collapsed, false);
    });
  });
});
