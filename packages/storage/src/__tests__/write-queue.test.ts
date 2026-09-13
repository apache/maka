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
import { chainWrite } from '../write-queue.js';

// Flush all pending microtasks (e.g. a .finally cleanup callback queued
// after a chain settles) before asserting on Map state.
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('chainWrite', () => {
  it('evicts queue entries once the chain drains', async () => {
    const queues = new Map<string, Promise<void>>();
    for (let i = 0; i < 50; i++) {
      await chainWrite(queues, `k${i}`, async () => {});
    }
    // Earlier keys' .finally cleanups run during the subsequent awaits;
    // setImmediate drains the last key's residual microtask.
    await flushMicrotasks();
    assert.equal(queues.size, 0);
  });

  it('does not evict while a newer write is queued behind', async () => {
    const queues = new Map<string, Promise<void>>();
    let resolveOp1!: () => void;
    let resolveOp2!: () => void;
    const op1 = () =>
      new Promise<void>((resolve) => {
        resolveOp1 = resolve;
      });
    const op2 = () =>
      new Promise<void>((resolve) => {
        resolveOp2 = resolve;
      });

    const p1 = chainWrite(queues, 'k', op1);
    const p2 = chainWrite(queues, 'k', op2); // queues behind op1; overwrites map entry

    // Let op1's body run (it sets resolveOp1) without completing it.
    // op2 stays queued behind op1's pending chain.
    await flushMicrotasks();
    resolveOp1();
    await p1; // op1 drains; op2 starts running
    await flushMicrotasks();
    // op2 is now in flight — the identity guard must keep its entry
    // alive (op1's .finally saw get(k) !== its own tracked promise).
    assert.equal(queues.has('k'), true);

    resolveOp2();
    await p2;
    await flushMicrotasks();
    assert.equal(queues.has('k'), false);
  });

  it('does not evict when a successor is queued behind a failing write', async () => {
    // Combines the two axes the tests above split: the in-flight write
    // rejects *while* a successor is already queued behind it (rather than
    // a successor queued after the rejection settles). Guards the identity
    // check under rejection: op1's .finally must see get(k) !== its own
    // tracked promise (op2 overwrote it) and leave the entry in place for
    // the still-in-flight op2. Note: this does NOT guard the .catch(noop)
    // swallow — op2's .then(op, op) already absorbs op1's rejection — that
    // invariant is covered by the "keeps the chain alive" test below.
    const queues = new Map<string, Promise<void>>();
    let rejectOp1!: (e: Error) => void;
    let resolveOp2!: () => void;
    const p1 = chainWrite(
      queues,
      'k',
      () =>
        new Promise<void>((_, rej) => {
          rejectOp1 = rej;
        }),
    );
    const p2 = chainWrite(
      queues,
      'k',
      () =>
        new Promise<void>((res) => {
          resolveOp2 = res;
        }),
    );

    // op1's body runs and parks on rejectOp1; op2 stays queued behind it.
    await flushMicrotasks();
    rejectOp1(new Error('boom'));
    await assert.rejects(p1, /boom/);
    await flushMicrotasks();
    // op2 is now in flight — the identity guard kept its entry alive.
    assert.equal(queues.has('k'), true);

    resolveOp2();
    await p2;
    await flushMicrotasks();
    assert.equal(queues.size, 0);
  });

  it('serializes operations under the same key in call order', async () => {
    const queues = new Map<string, Promise<void>>();
    const order: number[] = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        chainWrite(queues, 'k', async () => {
          order.push(i);
        }),
      );
    }
    await Promise.all(promises);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it('propagates rejection to the caller and keeps the chain alive', async () => {
    const queues = new Map<string, Promise<void>>();
    await assert.rejects(
      chainWrite(queues, 'k', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    // The Map-held chain swallowed the rejection; a subsequent write
    // under the same key must still run.
    let ran = false;
    await chainWrite(queues, 'k', async () => {
      ran = true;
    });
    assert.equal(ran, true);
    await flushMicrotasks();
    assert.equal(queues.size, 0);
  });
});
