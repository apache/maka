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
import {
  ACTION_TOAST_DURATION_MS,
  DEFAULT_TOAST_DURATION_MS,
  GLOBAL_TOAST_STORE_KEY,
  createToastStore,
  getToastStore,
  toast,
} from '../app/toastStore.ts';

function createFakeClock() {
  let current = 1000;
  let nextHandle = 1;
  const timers = new Map();

  const setTimeout = (fn, ms) => {
    const handle = nextHandle++;
    timers.set(handle, { fn, runAt: current + ms });
    return handle;
  };
  const clearTimeout = (handle) => {
    timers.delete(handle);
  };
  const advance = (ms) => {
    const target = current + ms;
    while (true) {
      let earliestHandle = null;
      let earliest = null;
      for (const [handle, entry] of timers.entries()) {
        if (entry.runAt <= target && (earliest === null || entry.runAt < earliest.runAt)) {
          earliestHandle = handle;
          earliest = entry;
        }
      }
      if (earliest === null) break;
      timers.delete(earliestHandle);
      current = earliest.runAt;
      earliest.fn();
    }
    current = target;
  };

  return {
    now: () => current,
    setTimeout,
    clearTimeout,
    advance,
    pendingCount: () => timers.size,
  };
}

test('toastStore orders persistent toasts ahead of transient toasts and newest first within each tier', () => {
  const clock = createFakeClock();
  const store = createToastStore(clock);

  const first = store.show({ tone: 'info', message: 'First transient' });
  const second = store.show({ tone: 'danger', message: 'Second transient' });
  const persistent = store.show({
    id: 'conn',
    tone: 'warning',
    message: 'Connection interrupted',
    persistent: true,
  });
  const third = store.show({ tone: 'info', message: 'Third transient' });

  assert.deepEqual(
    store.snapshot().map((item) => item.id),
    [persistent, third, second, first],
  );

  // Persistent toast does not expire even after long idle time; transients expire at 3.5s.
  clock.advance(DEFAULT_TOAST_DURATION_MS + 1000);
  assert.deepEqual(
    store.snapshot().map((item) => item.id),
    [persistent],
  );
  assert.equal(clock.pendingCount(), 0);
  store.dispose();
});

test('toastStore uses longer duration for actionable toasts and deduplicates by id while refreshing timer', () => {
  const clock = createFakeClock();
  const store = createToastStore(clock);

  let clicks = 0;
  store.show({
    id: 'fork',
    tone: 'info',
    message: 'Forked from Main',
    actions: [{ label: 'Back', onPress: () => clicks++ }],
  });

  // Still visible past default 3.5s because it carries an action (8s duration).
  clock.advance(DEFAULT_TOAST_DURATION_MS + 500);
  assert.equal(store.snapshot().length, 1);
  assert.equal(store.snapshot()[0].durationMs, ACTION_TOAST_DURATION_MS);

  // Updating with the same id replaces in place and refreshes the full 8s timer.
  store.upsert('fork', {
    tone: 'warning',
    message: 'Forked from Main (updated)',
    actions: [{ label: 'Back', onPress: () => clicks++ }],
  });
  assert.equal(store.snapshot().length, 1);
  assert.equal(store.snapshot()[0].message, 'Forked from Main (updated)');

  clock.advance(ACTION_TOAST_DURATION_MS - 100);
  assert.equal(store.snapshot().length, 1);

  clock.advance(100);
  assert.equal(store.snapshot().length, 0);
  assert.equal(clicks, 0);
  store.dispose();
});

test('toastStore pauses remaining timers while hovered and resumes cleanly afterward', () => {
  const clock = createFakeClock();
  const store = createToastStore(clock);

  store.show({ id: 'a', message: 'Copied', durationMs: 3000 });
  clock.advance(1200); // 1800ms remaining

  store.pause();
  assert.equal(store.isPaused(), true);
  assert.equal(clock.pendingCount(), 0);

  // New toast added while paused should stay queued without scheduling until resume.
  store.show({ id: 'b', message: 'Saved', durationMs: 1000 });
  clock.advance(20000);
  assert.deepEqual(
    store.snapshot().map((item) => item.id),
    ['b', 'a'],
  );

  store.resume();
  assert.equal(store.isPaused(), false);

  // 'b' had full 1000ms remaining; expires first.
  clock.advance(1000);
  assert.deepEqual(
    store.snapshot().map((item) => item.id),
    ['a'],
  );

  // 'a' had 1800ms remaining (1000ms elapsed since resume, 800ms left).
  clock.advance(799);
  assert.equal(store.snapshot().length, 1);
  clock.advance(1);
  assert.equal(store.snapshot().length, 0);
  store.dispose();
});

test('toastStore notifies subscribers, supports dismiss/clear/dispose without leaking timers', () => {
  const clock = createFakeClock();
  const store = createToastStore(clock);
  let notifications = 0;
  const unsub = store.subscribe(() => {
    notifications++;
  });

  store.show({ id: 'p', message: 'Offline', persistent: true });
  store.show({ id: 't1', message: 'One' });
  store.show({ id: 't2', message: 'Two' });
  assert.equal(notifications, 3);

  // clear() keeps persistent toasts by default.
  store.clear();
  assert.deepEqual(
    store.snapshot().map((item) => item.id),
    ['p'],
  );
  assert.equal(clock.pendingCount(), 0);

  store.dismiss('p');
  assert.equal(store.snapshot().length, 0);

  unsub();
  store.show({ id: 'after-unsub', message: 'Quiet' });
  const beforeDispose = notifications;
  store.dispose();
  assert.equal(clock.pendingCount(), 0);
  assert.equal(store.snapshot().length, 0);
  assert.equal(notifications, beforeDispose);
});

test('getToastStore shares one singleton queue via globalThis Symbol.for across bundles', () => {
  const previous = globalThis[GLOBAL_TOAST_STORE_KEY];
  delete globalThis[GLOBAL_TOAST_STORE_KEY];
  try {
    const storeA = getToastStore();
    const storeB = globalThis[Symbol.for('maka.workbench.toastStore')];
    assert.equal(storeA, storeB);

    const id = toast.show({
      id: 'cross-bundle',
      tone: 'warning',
      message: 'Shared queue',
      persistent: true,
    });
    assert.equal(
      storeB.snapshot().some((item) => item.id === id),
      true,
    );

    toast.dismiss(id);
    assert.equal(storeA.snapshot().length, 0);
    storeA.dispose();
  } finally {
    if (previous === undefined) delete globalThis[GLOBAL_TOAST_STORE_KEY];
    else globalThis[GLOBAL_TOAST_STORE_KEY] = previous;
  }
});
