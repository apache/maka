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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeepSystemAwakeController,
  type PowerSaveBlockerLike,
} from '../keep-system-awake.js';

/**
 * Fake Electron `powerSaveBlocker`: hands out incrementing ids and tracks
 * which are live, so the controller's start/stop bookkeeping can be asserted
 * without an Electron runtime (same philosophy as notifications-policy tests).
 */
function createFakeBlocker() {
  const started = new Set<number>();
  const startCalls: Array<'prevent-app-suspension' | 'prevent-display-sleep'> = [];
  const stopCalls: number[] = [];
  let nextId = 0;
  const blocker: PowerSaveBlockerLike = {
    start(type) {
      startCalls.push(type);
      const id = nextId++;
      started.add(id);
      return id;
    },
    stop(id) {
      stopCalls.push(id);
      started.delete(id);
    },
    isStarted(id) {
      return started.has(id);
    },
  };
  return { blocker, started, startCalls, stopCalls };
}

describe('keep-system-awake controller', () => {
  it('does NOT force the display on (never uses prevent-display-sleep)', () => {
    const fake = createFakeBlocker();
    const controller = createKeepSystemAwakeController(fake.blocker);

    controller.apply(true);

    assert.ok(
      !fake.startCalls.includes('prevent-display-sleep'),
      'background scheduled work must not keep the monitor lit',
    );
  });

  it('guards double-start: re-applying enabled does not leak a second blocker', () => {
    const fake = createFakeBlocker();
    const controller = createKeepSystemAwakeController(fake.blocker);

    controller.apply(true);
    controller.apply(true);
    controller.apply(true);

    assert.equal(fake.startCalls.length, 1, 'blocker must start exactly once');
    assert.equal(fake.started.size, 1);
    assert.equal(controller.isActive(), true);
  });

  it('re-enabling after a stop starts a fresh blocker', () => {
    const fake = createFakeBlocker();
    const controller = createKeepSystemAwakeController(fake.blocker);

    controller.apply(true);
    controller.apply(false);
    controller.apply(true);

    assert.equal(fake.startCalls.length, 2, 'a fresh blocker id is acquired after stop');
    assert.equal(fake.started.size, 1);
    assert.equal(controller.isActive(), true);
  });

  it('re-acquires a blocker when the previous id was released underneath it', () => {
    const fake = createFakeBlocker();
    const controller = createKeepSystemAwakeController(fake.blocker);

    controller.apply(true);
    // Simulate the blocker being torn down out of band (e.g. teardown race):
    // the controller still believes it holds id 0, but it is no longer live.
    fake.started.clear();
    assert.equal(controller.isActive(), false);

    controller.apply(true);
    assert.equal(fake.startCalls.length, 2);
    assert.equal(controller.isActive(), true);
  });

  it('a named hold keeps the blocker alive after the setting is turned off', () => {
    // The two callers are independent. Computer Use holding the machine awake
    // for a run in progress must survive the user turning 保持系统唤醒 off,
    // which is why this is refcounted rather than one boolean.
    const fake = createFakeBlocker();
    const controller = createKeepSystemAwakeController(fake.blocker);

    controller.apply(true);
    controller.hold('computer-use:s1');
    controller.apply(false);

    assert.equal(controller.isActive(), true);
    assert.equal(fake.stopCalls.length, 0);

    controller.release('computer-use:s1');
    assert.equal(controller.isActive(), false);
    assert.equal(fake.stopCalls.length, 1);
  });

  it('the setting survives a hold being released', () => {
    const fake = createFakeBlocker();
    const controller = createKeepSystemAwakeController(fake.blocker);

    controller.hold('computer-use:s1');
    controller.apply(true);
    controller.release('computer-use:s1');

    assert.equal(controller.isActive(), true);
    assert.equal(fake.stopCalls.length, 0);
  });

  it('holding twice for the same reason is one hold', () => {
    // The caller is driven by every action of a session, not by a state
    // change, so it must not have to de-duplicate before calling.
    const fake = createFakeBlocker();
    const controller = createKeepSystemAwakeController(fake.blocker);

    controller.hold('computer-use:s1');
    controller.hold('computer-use:s1');
    controller.release('computer-use:s1');

    assert.equal(fake.startCalls.length, 1);
    assert.equal(controller.isActive(), false);
  });

  it('two holds need two releases', () => {
    const fake = createFakeBlocker();
    const controller = createKeepSystemAwakeController(fake.blocker);

    controller.hold('computer-use:s1');
    controller.hold('computer-use:s2');
    controller.release('computer-use:s1');
    assert.equal(controller.isActive(), true);

    controller.release('computer-use:s2');
    assert.equal(controller.isActive(), false);
  });
});
