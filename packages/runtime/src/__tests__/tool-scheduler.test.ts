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
import { ToolScheduler } from '../tool-scheduler.js';

const POSIX = { cwd: '/repo', platform: 'linux' as const };

describe('ToolScheduler', () => {
  test('starts non-conflicting tasks immediately', async () => {
    const scheduler = new ToolScheduler();
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];

    const firstResult = scheduler.add({
      id: 'read-a-1',
      sequence: 0,
      accesses: ToolAccesses.readFile('/repo/a', POSIX),
      run: () => {
        started.push('first');
        return first.promise;
      },
    });
    const secondResult = scheduler.add({
      id: 'read-a-2',
      sequence: 1,
      accesses: ToolAccesses.readFile('/repo/a', POSIX),
      run: () => {
        started.push('second');
        return second.promise;
      },
    });

    assert.deepEqual(started, ['first', 'second']);
    assert.equal(scheduler.activeCount, 2);
    first.resolve('one');
    second.resolve('two');
    assert.deepEqual(await Promise.all([firstResult, secondResult]), ['one', 'two']);
    assert.equal(scheduler.activeCount, 0);
  });

  test('preserves writer fairness while allowing independent work to bypass the queue', async () => {
    const scheduler = new ToolScheduler();
    const reader = deferred<void>();
    const writer = deferred<void>();
    const laterReader = deferred<void>();
    const independent = deferred<void>();
    const started: string[] = [];
    const task = (
      id: string,
      sequence: number,
      accesses: ReturnType<typeof ToolAccesses.readFile>,
      gate: ReturnType<typeof deferred<void>>,
    ) =>
      scheduler.add({
        id,
        sequence,
        accesses,
        run: () => {
          started.push(id);
          return gate.promise;
        },
      });

    const results = [
      task('reader-1', 0, ToolAccesses.readFile('/repo/a', POSIX), reader),
      task('writer', 1, ToolAccesses.writeFile('/repo/a', POSIX), writer),
      task('reader-2', 2, ToolAccesses.readFile('/repo/a', POSIX), laterReader),
      task('independent', 3, ToolAccesses.writeFile('/repo/b', POSIX), independent),
    ];

    assert.deepEqual(started, ['reader-1', 'independent']);
    reader.resolve();
    await flushMicrotasks();
    assert.deepEqual(started, ['reader-1', 'independent', 'writer']);
    writer.resolve();
    await flushMicrotasks();
    assert.deepEqual(started, ['reader-1', 'independent', 'writer', 'reader-2']);
    laterReader.resolve();
    independent.resolve();
    await Promise.all(results);
  });

  test('one drain starts every newly unblocked non-conflicting task', async () => {
    const scheduler = new ToolScheduler();
    const blocker = deferred<void>();
    const a = deferred<void>();
    const b = deferred<void>();
    const started: string[] = [];
    const results = [
      scheduler.add({
        id: 'all',
        sequence: 0,
        accesses: ToolAccesses.all(),
        run: () => {
          started.push('all');
          return blocker.promise;
        },
      }),
      scheduler.add({
        id: 'a',
        sequence: 1,
        accesses: ToolAccesses.writeFile('/repo/a', POSIX),
        run: () => {
          started.push('a');
          return a.promise;
        },
      }),
      scheduler.add({
        id: 'b',
        sequence: 2,
        accesses: ToolAccesses.writeFile('/repo/b', POSIX),
        run: () => {
          started.push('b');
          return b.promise;
        },
      }),
    ];

    assert.deepEqual(started, ['all']);
    blocker.resolve();
    await flushMicrotasks();
    assert.deepEqual(started, ['all', 'a', 'b']);
    a.resolve();
    b.resolve();
    await Promise.all(results);
  });

  test('releases resources after asynchronous rejection and synchronous throw', async () => {
    for (const firstRun of [
      () => Promise.reject(new Error('async failure')),
      () => {
        throw new Error('sync failure');
      },
    ]) {
      const scheduler = new ToolScheduler();
      const started: string[] = [];
      const first = scheduler.add({
        id: 'first',
        sequence: 0,
        accesses: ToolAccesses.writeFile('/repo/a', POSIX),
        run: firstRun,
      });
      const second = scheduler.add({
        id: 'second',
        sequence: 1,
        accesses: ToolAccesses.readFile('/repo/a', POSIX),
        run: () => {
          started.push('second');
          return 'ok';
        },
      });

      await assert.rejects(first, /failure/);
      assert.equal(await second, 'ok');
      assert.deepEqual(started, ['second']);
    }
  });

  test('cancels queued work without running it', async () => {
    const scheduler = new ToolScheduler();
    const active = deferred<void>();
    const controller = new AbortController();
    let queuedStarts = 0;
    const activeResult = scheduler.add({
      id: 'active',
      sequence: 0,
      accesses: ToolAccesses.writeFile('/repo/a', POSIX),
      run: () => active.promise,
    });
    const queuedResult = scheduler.add({
      id: 'queued',
      sequence: 1,
      accesses: ToolAccesses.writeFile('/repo/a', POSIX),
      signal: controller.signal,
      run: () => {
        queuedStarts += 1;
      },
    });
    const queuedOutcome = Promise.allSettled([queuedResult]);

    controller.abort(new Error('turn stopped'));
    assert.equal((await queuedOutcome)[0]?.status, 'rejected');
    assert.equal(queuedStarts, 0);
    assert.equal(scheduler.queuedCount, 0);
    active.resolve();
    await activeResult;
  });

  test('releases active work after the tool observes cancellation', async () => {
    const scheduler = new ToolScheduler();
    const controller = new AbortController();
    const started: string[] = [];
    const active = scheduler.add({
      id: 'active',
      sequence: 0,
      accesses: ToolAccesses.writeFile('/repo/a', POSIX),
      signal: controller.signal,
      run: () =>
        new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          });
        }),
    });
    const next = scheduler.add({
      id: 'next',
      sequence: 1,
      accesses: ToolAccesses.readFile('/repo/a', POSIX),
      run: () => {
        started.push('next');
        return 'done';
      },
    });

    controller.abort(new Error('cancel active'));
    await assert.rejects(active, /cancel active/);
    assert.equal(await next, 'done');
    assert.deepEqual(started, ['next']);
  });

  test('rejects duplicate or out-of-order sequence submission', () => {
    const scheduler = new ToolScheduler();
    void scheduler.add({
      id: 'first',
      sequence: 1,
      accesses: ToolAccesses.none(),
      run: () => undefined,
    });
    assert.throws(
      () =>
        scheduler.add({
          id: 'duplicate',
          sequence: 1,
          accesses: ToolAccesses.none(),
          run: () => undefined,
        }),
      /strictly increasing sequence order/,
    );
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
