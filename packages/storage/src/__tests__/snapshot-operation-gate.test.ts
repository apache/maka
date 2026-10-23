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
import { setImmediate } from 'node:timers/promises';
import { SnapshotOperationGate } from '../snapshot-operation-gate.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('snapshot drains admitted operations, allows its own reads and fences later writes', async () => {
  const gate = new SnapshotOperationGate();
  const first = deferred();
  const snapshot = deferred();
  const entered = deferred();
  const events: string[] = [];
  const writer = gate.run(async () => {
    events.push('write-1');
    await first.promise;
    events.push('write-1-end');
  });
  const copy = gate.exclusive(async () => {
    events.push('copy');
    await gate.run(async () => {
      events.push('read-in-copy');
    });
    entered.resolve();
    await snapshot.promise;
    events.push('copy-end');
  });
  const next = gate.run(async () => {
    events.push('write-2');
  });
  await setImmediate();
  assert.deepEqual(events, ['write-1']);
  first.resolve();
  await entered.promise;
  assert.deepEqual(events, ['write-1', 'write-1-end', 'copy', 'read-in-copy']);
  snapshot.resolve();
  await Promise.all([writer, copy, next]);
  assert.equal(events.at(-1), 'write-2');
});
test('serial snapshots preserve intervening writes and release after failures', async () => {
  const gate = new SnapshotOperationGate();
  const first = deferred();
  const events: string[] = [];
  const left = gate.exclusive(async () => {
    events.push('left');
    await first.promise;
    throw new Error('failed copy');
  });
  const failure = assert.rejects(left, /failed copy/);
  const write = gate.run(async () => {
    events.push('write');
  });
  const right = gate.exclusive(async () => {
    events.push('right');
  });
  first.resolve();
  await Promise.all([failure, write, right]);
  assert.deepEqual(events, ['left', 'write', 'right']);
  await gate.run(async () => {
    events.push('after');
  });
  assert.equal(events.at(-1), 'after');
});
test('a detached callback cannot retain an expired snapshot context', async () => {
  const gate = new SnapshotOperationGate();
  const detached = deferred();
  const hold = deferred();
  const entered = deferred();
  let later!: Promise<void>;
  let wrote = false;
  await gate.exclusive(async () => {
    later = (async () => {
      await detached.promise;
      await gate.run(async () => {
        wrote = true;
      });
    })();
  });
  const snapshot = gate.exclusive(async () => {
    entered.resolve();
    await hold.promise;
  });
  await entered.promise;
  detached.resolve();
  await setImmediate();
  assert.equal(wrote, false);
  hold.resolve();
  await Promise.all([snapshot, later]);
  assert.equal(wrote, true);
});
