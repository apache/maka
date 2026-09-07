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
import type { PreparedOperation, ResourceClaim } from '../preparation/types.js';
import { ToolScheduler } from '../tool-scheduler.js';

const FILE = 'filesystem:workspace';

const read = (key: string): ResourceClaim[] => [
  { kind: 'keyed', authority: FILE, key, mode: 'read' },
];
const tree = (key: string): ResourceClaim[] => [
  { kind: 'keyed', authority: FILE, key, mode: 'read', scope: 'tree' },
];
const write = (key: string): ResourceClaim[] => [
  { kind: 'keyed', authority: FILE, key, mode: 'write' },
];
const all = (): ResourceClaim[] => [{ kind: 'all' }];
const none = (): ResourceClaim[] => [];

function operation<Result = void>(
  claims: readonly ResourceClaim[],
  run?: (signal?: AbortSignal) => Promise<Result> | Result,
): PreparedOperation<Result> {
  return {
    claims,
    execute: (signal) => Promise.resolve(run ? run(signal) : (undefined as Result)),
  };
}

// The Scheduler always calls task.run; route that through the op.execute so the
// test observes the operation's own effects.
const runThrough =
  <Result>() =>
  (execution: PreparedOperation<unknown>, signal?: AbortSignal) =>
    execution.execute(signal) as Promise<Result>;

describe('ToolScheduler', () => {
  test('starts non-conflicting (overlapping-reader) tasks immediately', async () => {
    const scheduler = new ToolScheduler();
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];

    const firstResult = scheduler.add({
      id: 'read-a-1',
      sequence: 0,
      operation: operation(read('/repo/a'), () => {
        started.push('first');
        return first.promise;
      }),
      run: runThrough<string>(),
    });
    const secondResult = scheduler.add({
      id: 'read-a-2',
      sequence: 1,
      operation: operation(read('/repo/a'), () => {
        started.push('second');
        return second.promise;
      }),
      run: runThrough<string>(),
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
      claims: readonly ResourceClaim[],
      gate: ReturnType<typeof deferred<void>>,
    ) =>
      scheduler.add({
        id,
        sequence,
        operation: operation(claims, () => {
          started.push(id);
          return gate.promise;
        }),
        run: runThrough<void>(),
      });

    const results = [
      task('reader-1', 0, read('/repo/a'), reader),
      task('writer', 1, write('/repo/a'), writer),
      task('reader-2', 2, read('/repo/a'), laterReader),
      task('independent', 3, write('/repo/b'), independent),
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
        operation: operation(all(), () => {
          started.push('all');
          return blocker.promise;
        }),
        run: runThrough<void>(),
      }),
      scheduler.add({
        id: 'a',
        sequence: 1,
        operation: operation(write('/repo/a'), () => {
          started.push('a');
          return a.promise;
        }),
        run: runThrough<void>(),
      }),
      scheduler.add({
        id: 'b',
        sequence: 2,
        operation: operation(write('/repo/b'), () => {
          started.push('b');
          return b.promise;
        }),
        run: runThrough<void>(),
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

  test('freezes further dispatch after a fatal rejection (fail-stop)', async () => {
    const scheduler = new ToolScheduler();
    const started: string[] = [];
    const first = scheduler.add({
      id: 'first',
      sequence: 0,
      operation: operation(write('/repo/a'), () => Promise.reject(new Error('async failure'))),
      run: runThrough<void>(),
    });
    const second = scheduler.add({
      id: 'second',
      sequence: 1,
      operation: operation(read('/repo/a'), () => {
        started.push('second');
        return 'ok';
      }),
      run: runThrough<string>(),
    });

    await assert.rejects(first, /async failure/);
    // The frozen scheduler cancels queued work instead of running it.
    await assert.rejects(second, /frozen|cancelled before it started/);
    assert.deepEqual(started, []);
    assert.equal(scheduler.queuedCount, 0);
  });

  test('rejects a task submitted after the scheduler is frozen', async () => {
    const scheduler = new ToolScheduler();
    const first = scheduler.add({
      id: 'first',
      sequence: 0,
      operation: operation(write('/repo/a'), () => Promise.reject(new Error('boom'))),
      run: runThrough<void>(),
    });
    await assert.rejects(first, /boom/);
    await assert.rejects(
      scheduler.add({
        id: 'late',
        sequence: 1,
        operation: operation(none(), () => 'late'),
        run: runThrough<string>(),
      }),
      /frozen/,
    );
  });

  test('cancels queued work without running it', async () => {
    const scheduler = new ToolScheduler();
    const active = deferred<void>();
    const controller = new AbortController();
    let queuedStarts = 0;
    const activeResult = scheduler.add({
      id: 'active',
      sequence: 0,
      operation: operation(write('/repo/a'), () => active.promise),
      run: runThrough<void>(),
    });
    const queuedResult = scheduler.add({
      id: 'queued',
      sequence: 1,
      operation: operation(write('/repo/a'), () => {
        queuedStarts += 1;
      }),
      signal: controller.signal,
      run: runThrough<void>(),
    });
    const queuedOutcome = Promise.allSettled([queuedResult]);

    controller.abort(new Error('turn stopped'));
    assert.equal((await queuedOutcome)[0]?.status, 'rejected');
    assert.equal(queuedStarts, 0);
    assert.equal(scheduler.queuedCount, 0);
    active.resolve();
    await activeResult;
  });

  test('a fulfilled (abort-observed) active task releases the queue', async () => {
    const scheduler = new ToolScheduler();
    const controller = new AbortController();
    const started: string[] = [];
    const active = scheduler.add({
      id: 'active',
      sequence: 0,
      operation: operation(
        write('/repo/a'),
        () =>
          new Promise<string>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve('cancelled-but-fulfilled'), {
              once: true,
            });
          }),
      ),
      signal: controller.signal,
      run: runThrough<string>(),
    });
    const next = scheduler.add({
      id: 'next',
      sequence: 1,
      operation: operation(read('/repo/a'), () => {
        started.push('next');
        return 'done';
      }),
      run: runThrough<string>(),
    });

    controller.abort(new Error('cancel active'));
    assert.equal(await active, 'cancelled-but-fulfilled');
    assert.equal(await next, 'done');
    assert.deepEqual(started, ['next']);
  });

  test('a tree read conflicts with the in-tree writer but not a sibling tree read', async () => {
    const scheduler = new ToolScheduler();
    const reader = deferred<void>();
    const writer = deferred<void>();
    const started: string[] = [];
    const treeRead = scheduler.add({
      id: 'tree',
      sequence: 0,
      operation: operation(tree('/repo/src'), () => reader.promise),
      run: runThrough<void>(),
    });
    const inTreeWrite = scheduler.add({
      id: 'write-a',
      sequence: 1,
      operation: operation(write('/repo/src/a.ts'), () => {
        started.push('write-a');
        return writer.promise;
      }),
      run: runThrough<void>(),
    });
    const siblingRead = scheduler.add({
      id: 'src2-read',
      sequence: 2,
      operation: operation(tree('/repo/src2'), () => {
        started.push('src2');
        return undefined;
      }),
      run: runThrough<void>(),
    });

    assert.deepEqual(started, ['src2']);
    reader.resolve();
    await flushMicrotasks();
    assert.deepEqual(started, ['src2', 'write-a']);
    writer.resolve();
    await treeRead;
    await inTreeWrite;
    await siblingRead;
  });

  test('a Windows tree key conflicts with an in-tree Windows file key', async () => {
    const scheduler = new ToolScheduler();
    const reader = deferred<void>();
    const writer = deferred<void>();
    const started: string[] = [];
    const treeRead = scheduler.add({
      id: 'windows-tree',
      sequence: 0,
      operation: operation(tree('D:\\repo\\src'), () => reader.promise),
      run: runThrough<void>(),
    });
    const inTreeWrite = scheduler.add({
      id: 'windows-write',
      sequence: 1,
      operation: operation(write('D:\\repo\\src\\a.ts'), () => {
        started.push('windows-write');
        return writer.promise;
      }),
      run: runThrough<void>(),
    });

    assert.deepEqual(started, []);
    reader.resolve();
    await flushMicrotasks();
    assert.deepEqual(started, ['windows-write']);
    writer.resolve();
    await Promise.all([treeRead, inTreeWrite]);
  });

  test('rejects duplicate or out-of-order sequence submission', () => {
    const scheduler = new ToolScheduler();
    void scheduler.add({
      id: 'first',
      sequence: 1,
      operation: operation(none(), () => undefined),
      run: runThrough<void>(),
    });
    assert.throws(
      () =>
        scheduler.add({
          id: 'duplicate',
          sequence: 1,
          operation: operation(none(), () => undefined),
          run: runThrough<void>(),
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
