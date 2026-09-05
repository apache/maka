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
import { createDelayedFlag, type DelayedFlagScheduler } from '../delayed-flag.js';

// A manual scheduler: nothing fires until the test explicitly releases it, so
// the rising-edge timing is asserted without any real wall-clock wait.
function fakeScheduler() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  const scheduler: DelayedFlagScheduler = {
    setTimeout(handler) {
      const id = ++seq;
      pending.set(id, handler);
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    scheduler,
    pendingCount: () => pending.size,
    fireAll() {
      for (const [id, handler] of [...pending]) {
        pending.delete(id);
        handler();
      }
    },
  };
}

test('stays false until the delay elapses, then turns true once', () => {
  const changes: boolean[] = [];
  const s = fakeScheduler();
  const flag = createDelayedFlag({
    delayMs: 200,
    scheduler: s.scheduler,
    onChange: (v) => changes.push(v),
  });

  flag.setCondition(true);
  assert.equal(flag.get(), false, 'not visible before the timer fires');
  assert.deepEqual(changes, []);
  assert.equal(s.pendingCount(), 1, 'one reveal timer armed');

  s.fireAll();
  assert.equal(flag.get(), true);
  assert.deepEqual(changes, [true]);
});

test('a condition that drops before the delay never flashes true', () => {
  const changes: boolean[] = [];
  const s = fakeScheduler();
  const flag = createDelayedFlag({
    delayMs: 200,
    scheduler: s.scheduler,
    onChange: (v) => changes.push(v),
  });

  flag.setCondition(true);
  flag.setCondition(false);
  assert.equal(s.pendingCount(), 0, 'the pending reveal is cancelled on the fast drop');

  s.fireAll();
  assert.equal(flag.get(), false);
  assert.deepEqual(changes, [], 'never emitted — no flash');
});

test('falls to false immediately once visible, with no timer', () => {
  const changes: boolean[] = [];
  const s = fakeScheduler();
  const flag = createDelayedFlag({
    delayMs: 200,
    scheduler: s.scheduler,
    onChange: (v) => changes.push(v),
  });

  flag.setCondition(true);
  s.fireAll();
  assert.equal(flag.get(), true);

  flag.setCondition(false);
  assert.equal(flag.get(), false, 'falling edge is immediate');
  assert.equal(s.pendingCount(), 0);
  assert.deepEqual(changes, [true, false]);
});

test('a re-entrant true while pending arms only one timer', () => {
  const s = fakeScheduler();
  const flag = createDelayedFlag({ delayMs: 200, scheduler: s.scheduler });

  flag.setCondition(true);
  flag.setCondition(true);
  assert.equal(s.pendingCount(), 1);
});

test('dispose cancels a pending reveal', () => {
  const changes: boolean[] = [];
  const s = fakeScheduler();
  const flag = createDelayedFlag({
    delayMs: 200,
    scheduler: s.scheduler,
    onChange: (v) => changes.push(v),
  });

  flag.setCondition(true);
  flag.dispose();
  assert.equal(s.pendingCount(), 0);

  s.fireAll();
  assert.equal(flag.get(), false);
  assert.deepEqual(changes, []);
});
