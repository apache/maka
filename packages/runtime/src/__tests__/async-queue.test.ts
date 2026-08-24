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
import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import { AsyncEventQueue } from '../async-queue.js';

describe('AsyncEventQueue', () => {
  test('close before any push → consumer completes immediately', async () => {
    const q = new AsyncEventQueue<number>();
    q.close();
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([]);
  });

  test('push after close is dropped (no throw)', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.close();
    q.push(2); // silently dropped
    const out: number[] = [];
    for await (const v of q) out.push(v);
    expect(out).toEqual([1]);
  });

  test('error rejects waiting consumer', async () => {
    const q = new AsyncEventQueue<number>();
    const failure = new Error('boom');

    const consumerErr = (async () => {
      try {
        for await (const _ of q) {
          // unreached
        }
        return null;
      } catch (e) {
        return e;
      }
    })();

    await Promise.resolve(); // let consumer park
    q.error(failure);
    expect(await consumerErr).toBe(failure);
  });

  test('return() from iterator closes the queue', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);

    const iter = q[Symbol.asyncIterator]();
    const r1 = await iter.next();
    expect(r1).toEqual({ value: 1, done: false });
    await iter.return?.();
    const r2 = await iter.next();
    expect(r2).toEqual({ value: 2, done: false });
  });

  test('interleaved push/next preserves FIFO', async () => {
    const q = new AsyncEventQueue<number>();
    const out: number[] = [];

    const reader = (async () => {
      for await (const v of q) out.push(v);
    })();

    q.push(10);
    await Promise.resolve();
    q.push(20);
    await Promise.resolve();
    q.push(30);
    q.close();
    await reader;

    expect(out).toEqual([10, 20, 30]);
  });
});

describe('AsyncEventQueue consumption boundary', () => {
  test('pushAndWaitUntilConsumed resolves only when its exact sequence is processed', async () => {
    const q = new AsyncEventQueue<number>();
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    let settled = false;
    const consumed = q.pushAndWaitUntilConsumed(1).then(() => {
      settled = true;
    });
    q.push(2);

    const consumer = (async () => {
      const iter = q[Symbol.asyncIterator]();
      expect(await iter.next()).toEqual({ value: 1, done: false });
      await ackGate;
      q.ackConsumed();
      expect(await iter.next()).toEqual({ value: 2, done: false });
      q.ackConsumed();
    })();

    await Promise.resolve();
    expect(settled).toBe(false);

    releaseAck();
    await consumed;
    expect(settled).toBe(true);
    await consumer;
    q.close();
  });

  test('waitUntilConsumedThroughCurrent captures a fixed boundary', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    const throughFirst = q.waitUntilConsumedThroughCurrent();
    let settled = false;
    void throughFirst.then(() => {
      settled = true;
    });
    q.push(2);

    const iter = q[Symbol.asyncIterator]();
    await iter.next();
    q.ackConsumed();
    await throughFirst;
    expect(settled).toBe(true);
    expect(await iter.next()).toEqual({ value: 2, done: false });
    q.ackConsumed();
    q.close();
  });

  test('pushAndWaitUntilConsumed rejects instead of dropping on closed or errored queues', async () => {
    const q = new AsyncEventQueue<number>();
    q.close();
    await assert.rejects(q.pushAndWaitUntilConsumed(1), /queue is closed/);

    const failed = new AsyncEventQueue<number>();
    const failure = new Error('queue failed');
    failed.error(failure);
    await assert.rejects(failed.pushAndWaitUntilConsumed(1), (error) => error === failure);
  });

  test('detach or queue error before consumption rejects the pending boundary', async () => {
    const q = new AsyncEventQueue<number>();
    const detached = q.pushAndWaitUntilConsumed(1);
    q.noteConsumerDetached();
    await assert.rejects(detached, /consumer detached/);

    const failed = new AsyncEventQueue<number>();
    const pending = failed.pushAndWaitUntilConsumed(1);
    const failure = new Error('consumer persistence failed');
    failed.error(failure);
    await assert.rejects(pending, (error) => error === failure);
  });

  test('detach after consumption does not reverse a fulfilled boundary', async () => {
    const q = new AsyncEventQueue<number>();
    const consumed = q.pushAndWaitUntilConsumed(1);
    const iter = q[Symbol.asyncIterator]();
    await iter.next();
    q.ackConsumed();
    q.noteConsumerDetached();
    await consumed;

    // The already-consumed current boundary remains successful after detach.
    await q.waitUntilConsumedThroughCurrent();
    q.close();
  });
});
