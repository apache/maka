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
import { ToolAccesses } from '../tool-access.js';
import { settleToolCallBatch } from '../tool-call-batch.js';

const POSIX = { cwd: '/repo', platform: 'linux' as const };

describe('settleToolCallBatch', () => {
  test('waits for every access plan before submitting tasks in model order', async () => {
    const preparation = deferred<void>();
    const first = deferred<string>();
    const second = deferred<string>();
    const bothStarted = deferred<void>();
    const starts: string[] = [];
    const batch = settleToolCallBatch(
      [
        {
          id: 'first',
          resolveAccesses: async () => {
            await preparation.promise;
            return ToolAccesses.writeFile('/repo/a', POSIX);
          },
          run: () => {
            starts.push('first');
            return first.promise;
          },
        },
        {
          id: 'second',
          resolveAccesses: () => ToolAccesses.writeFile('/repo/b', POSIX),
          run: () => {
            starts.push('second');
            bothStarted.resolve();
            return second.promise;
          },
        },
      ],
      POSIX,
    );

    await flushMicrotasks();
    assert.deepEqual(starts, []);
    preparation.resolve();
    await bothStarted.promise;
    assert.deepEqual(starts, ['first', 'second']);
    second.resolve('B');
    first.resolve('A');
    assert.deepEqual(await batch, [
      { status: 'fulfilled', value: 'A' },
      { status: 'fulfilled', value: 'B' },
    ]);
  });

  test('keeps result slots ordered when tasks complete B, C, A and one fails', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const batch = settleToolCallBatch(
      gates.map((gate, index) => ({
        id: String(index),
        resolveAccesses: () => ToolAccesses.none(),
        run: () => gate.promise,
      })),
      POSIX,
    );

    gates[1]!.resolve('B');
    gates[2]!.reject(new Error('C failed'));
    gates[0]!.resolve('A');
    const outcomes = await batch;
    assert.equal(outcomes[0]?.status, 'fulfilled');
    assert.equal(outcomes[0]?.status === 'fulfilled' ? outcomes[0].value : undefined, 'A');
    assert.equal(outcomes[1]?.status, 'fulfilled');
    assert.equal(outcomes[1]?.status === 'fulfilled' ? outcomes[1].value : undefined, 'B');
    assert.equal(outcomes[2]?.status, 'rejected');
    assert.match(
      String(outcomes[2]?.status === 'rejected' ? outcomes[2].reason : undefined),
      /C failed/,
    );
  });

  test('fails closed to all when an access declaration is absent or throws', async () => {
    for (const resolveAccesses of [
      undefined,
      () => {
        throw new Error('bad declaration');
      },
    ]) {
      const first = deferred<void>();
      const unknownStarted = deferred<void>();
      const starts: string[] = [];
      const batch = settleToolCallBatch(
        [
          {
            id: 'unknown',
            ...(resolveAccesses ? { resolveAccesses } : {}),
            run: () => {
              starts.push('unknown');
              unknownStarted.resolve();
              return first.promise;
            },
          },
          {
            id: 'writer',
            resolveAccesses: () => ToolAccesses.writeFile('/repo/a', POSIX),
            run: () => {
              starts.push('writer');
              return undefined;
            },
          },
        ],
        POSIX,
      );

      await unknownStarted.promise;
      assert.deepEqual(starts, ['unknown']);
      first.resolve();
      await batch;
      assert.deepEqual(starts, ['unknown', 'writer']);
    }
  });

  test('does not start a queued task cancelled during preparation', async () => {
    const preparation = deferred<void>();
    const controller = new AbortController();
    let starts = 0;
    const batch = settleToolCallBatch(
      [
        {
          id: 'preparing',
          resolveAccesses: async () => {
            await preparation.promise;
            return ToolAccesses.none();
          },
          run: () => 'ok',
        },
        {
          id: 'cancelled',
          signal: controller.signal,
          resolveAccesses: () => ToolAccesses.none(),
          run: () => {
            starts += 1;
            return 'should not run';
          },
        },
      ],
      POSIX,
    );

    controller.abort(new Error('turn cancelled'));
    preparation.resolve();
    const outcomes = await batch;
    assert.equal(starts, 0);
    assert.equal(outcomes[0]?.status, 'fulfilled');
    assert.equal(outcomes[1]?.status, 'rejected');
  });

  test('abort releases a batch whose access planner never settles', async () => {
    const controller = new AbortController();
    let starts = 0;
    const batch = settleToolCallBatch(
      [
        {
          id: 'hung-planner',
          signal: controller.signal,
          resolveAccesses: () => new Promise(() => {}),
          run: () => {
            starts += 1;
          },
        },
      ],
      POSIX,
    );

    controller.abort(new Error('stop planning'));
    const outcomes = await batch;
    assert.equal(starts, 0);
    assert.equal(outcomes[0]?.status, 'rejected');
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
