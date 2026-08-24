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
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('serializes operations for one Session', async () => {
  const gate = new SessionAdmissionGate();
  const entered = deferred();
  const release = deferred();
  const order: string[] = [];

  const first = gate.run('session', async () => {
    order.push('first:start');
    entered.resolve();
    await release.promise;
    order.push('first:end');
  });
  await entered.promise;
  const second = gate.run('session', () => {
    order.push('second');
  });

  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('does not serialize operations for different Sessions', async () => {
  const gate = new SessionAdmissionGate();
  const entered = deferred();
  const release = deferred();
  const first = gate.run('first', async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  assert.equal(await gate.run('second', () => 'completed'), 'completed');
  release.resolve();
  await first;
});

test('serializes overlapping multi-Session admissions without lock-order deadlocks', async () => {
  const gate = new SessionAdmissionGate();
  const entered = deferred();
  const release = deferred();
  const order: string[] = [];

  const first = gate.runMany(['second', 'first'], async (lease) => {
    order.push('first:start');
    assert.equal(await gate.runAdmitted('first', lease, () => 'first-owned'), 'first-owned');
    assert.equal(await gate.runAdmitted('second', lease, () => 'second-owned'), 'second-owned');
    entered.resolve();
    await release.promise;
    order.push('first:end');
  });
  await entered.promise;
  const second = gate.runMany(['first', 'second'], () => {
    order.push('second');
  });
  const independent = gate.run('third', () => {
    order.push('third');
  });

  await independent;
  assert.deepEqual(order, ['first:start', 'third']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'third', 'first:end', 'second']);
});

test('keeps the admission open until admitted child work settles', async () => {
  const gate = new SessionAdmissionGate();
  const childEntered = deferred();
  const releaseChild = deferred();
  let outerSettled = false;

  const outer = gate
    .run('session', (lease) => {
      void gate.runAdmitted('session', lease, async () => {
        childEntered.resolve();
        await releaseChild.promise;
      });
      return 'accepted';
    })
    .then((value) => {
      outerSettled = true;
      return value;
    });

  await childEntered.promise;
  await Promise.resolve();
  assert.equal(outerSettled, false);
  releaseChild.resolve();
  assert.equal(await outer, 'accepted');
});

test('queues detached publication after the active admission', async () => {
  const gate = new SessionAdmissionGate();
  const release = deferred();
  const order: string[] = [];
  let detached!: Promise<void>;

  const active = gate.run('session', async () => {
    order.push('active:start');
    detached = gate.enqueueDetached('session', () => {
      order.push('detached');
    });
    await release.promise;
    order.push('active:end');
  });

  await Promise.resolve();
  assert.deepEqual(order, ['active:start']);
  release.resolve();
  await Promise.all([active, detached]);
  assert.deepEqual(order, ['active:start', 'active:end', 'detached']);
});

test('rejects accidental admission re-entry instead of deadlocking', async () => {
  const gate = new SessionAdmissionGate();
  await gate.run('session', async () => {
    await assert.rejects(
      gate.run('session', () => undefined),
      /reuse its lease/,
    );
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
