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
import { runWithContextValueMutation } from '../context-value-mutation-gate.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test('one root runs its context mutations one at a time', async () => {
  const order: string[] = [];
  const first = deferred();
  const started = deferred();

  const a = runWithContextValueMutation('/root', async () => {
    order.push('a:start');
    started.resolve();
    await first.promise;
    order.push('a:end');
  });
  await started.promise;
  const b = runWithContextValueMutation('/root', async () => {
    order.push('b:start');
  });

  // The whole point is what happens across an await. The Context Store reads
  // database state, awaits, and only then acts on files; a second writer that
  // gets in there acts on a decision that is no longer true.
  await Promise.resolve();
  assert.deepEqual(order, ['a:start'], 'the second mutation must not start inside the first');

  first.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start']);
});

test('a failed mutation does not wedge the root', async () => {
  await assert.rejects(() =>
    runWithContextValueMutation('/wedge', async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(
    await runWithContextValueMutation('/wedge', async () => 'ran'),
    'ran',
    'a rejection releases the turn like any other outcome',
  );
});

test('separate roots do not wait on each other', async () => {
  const held = deferred();
  const blocking = runWithContextValueMutation('/left', () => held.promise);
  // Two workspaces are two queues; serialising them would make an import into
  // one root stall the Context Store of another.
  assert.equal(await runWithContextValueMutation('/right', async () => 'ran'), 'ran');
  held.resolve();
  await blocking;
});
