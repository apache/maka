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
import { settleToolCallBatch, type ToolCallBatchEntry } from '../tool-call-batch.js';
import type { PreparedOperation, ResourceClaim } from '../preparation/types.js';
import { noneOperation, processAllOperation } from '../preparation/placeholder-authorities.js';
import { createProcessResourceAdmissionCoordinator } from '../process-resource-admission.js';

const FILE = 'filesystem:workspace';
const write = (key: string): ResourceClaim[] => [
  { kind: 'keyed', authority: FILE, key, mode: 'write' },
];
const none = (): ResourceClaim[] => [];

function prepared(claims: readonly ResourceClaim[]): PreparedOperation<unknown> {
  return { claims, execute: () => Promise.resolve(undefined) };
}

function entry<Result>(
  id: string,
  prepare: () => Promise<PreparedOperation<unknown>>,
  run: () => Promise<Result> | Result,
  signal?: AbortSignal,
): ToolCallBatchEntry<Result> {
  return { id, ...(signal ? { signal } : {}), prepare, run };
}

describe('settleToolCallBatch', () => {
  test('waits for every prepare before submitting tasks in model order', async () => {
    const preparation = deferred<void>();
    const first = deferred<string>();
    const second = deferred<string>();
    const bothStarted = deferred<void>();
    const starts: string[] = [];
    const batch = settleToolCallBatch([
      entry(
        'first',
        async () => {
          await preparation.promise;
          return prepared(write('/repo/a'));
        },
        () => {
          starts.push('first');
          return first.promise;
        },
      ),
      entry(
        'second',
        async () => {
          await preparation.promise;
          return prepared(write('/repo/b'));
        },
        () => {
          starts.push('second');
          bothStarted.resolve();
          return second.promise;
        },
      ),
    ]);

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
      gates.map((gate, index) =>
        entry(
          String(index),
          async () => prepared(none()),
          () => gate.promise,
        ),
      ),
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

  test('uses all claims when prepare throws but the real fallback effect still runs', async () => {
    const reader = deferred<void>();
    const broken = deferred<void>();
    const readerStarted = deferred<void>();
    const brokenStarted = deferred<void>();
    const starts: string[] = [];
    const batch = settleToolCallBatch([
      entry(
        'reader',
        async () => prepared([{ kind: 'keyed', authority: FILE, key: '/repo/a', mode: 'read' }]),
        () => {
          starts.push('reader');
          readerStarted.resolve();
          return reader.promise;
        },
      ),
      entry(
        'broken',
        async () => {
          throw new Error('bad declaration');
        },
        () => {
          starts.push('broken');
          brokenStarted.resolve();
          return broken.promise;
        },
      ),
      entry(
        'writer',
        async () => prepared(write('/repo/b')),
        () => {
          starts.push('writer');
          return undefined;
        },
      ),
    ]);

    await readerStarted.promise;
    assert.deepEqual(starts, ['reader']);
    reader.resolve();
    await brokenStarted.promise;
    assert.deepEqual(starts, ['reader', 'broken']);
    broken.resolve();
    await batch;
    assert.deepEqual(starts, ['reader', 'broken', 'writer']);
  });

  test('does not start a task cancelled before it is submitted', async () => {
    const preparation = deferred<void>();
    const controller = new AbortController();
    let starts = 0;
    const batch = settleToolCallBatch([
      entry(
        'preparing',
        async () => {
          await preparation.promise;
          return prepared(none());
        },
        () => 'ok',
      ),
      entry(
        'cancelled',
        async () => {
          await preparation.promise;
          return prepared(none());
        },
        () => {
          starts += 1;
          return 'should not run';
        },
        controller.signal,
      ),
    ]);

    // Abort synchronously (before any prepare settles) so the cancelled entry
    // is submitted with an already-aborted signal and rejected by the
    // Scheduler before it runs.
    controller.abort(new Error('turn cancelled'));
    preparation.resolve();
    const outcomes = await batch;
    assert.equal(starts, 0);
    assert.equal(outcomes[0]?.status, 'fulfilled');
    assert.equal(outcomes[1]?.status, 'rejected');
  });

  test('lets none() start in the same batch while all() is active', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const releaseAll = deferred<void>();
    const allStarted = deferred<void>();
    const noneStarted = deferred<void>();
    const allOperation = processAllOperation(async () => {
      allStarted.resolve();
      await releaseAll.promise;
      return 'all';
    }, coordinator);
    const bypassOperation = noneOperation(async () => {
      noneStarted.resolve();
      return 'none';
    });

    const batch = settleToolCallBatch(
      [operationEntry('all', allOperation), operationEntry('none', bypassOperation)],
      { processAdmission: coordinator },
    );
    await allStarted.promise;
    await noneStarted.promise;
    assert.equal(coordinator.inspect().activeExclusive, true);
    releaseAll.resolve();
    assert.deepEqual(await batch, [
      { status: 'fulfilled', value: 'all' },
      { status: 'fulfilled', value: 'none' },
    ]);
  });

  test('lets none() bypass active and queued all() work across independent batches', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const releaseShared = deferred<void>();
    const releaseAll = deferred<void>();
    const allStarted = deferred<void>();
    let noneRuns = 0;
    const shared = coordinator.withShared(undefined, async () => {
      await releaseShared.promise;
    });
    const allBatch = settleToolCallBatch(
      [
        operationEntry(
          'all',
          processAllOperation(async () => {
            allStarted.resolve();
            await releaseAll.promise;
            return 'all';
          }, coordinator),
        ),
      ],
      { processAdmission: coordinator },
    );
    await flushMicrotasks();
    assert.equal(coordinator.inspect().queued[0]?.mode, 'exclusive');

    const queuedBypass = await settleToolCallBatch(
      [
        operationEntry(
          'none-queued',
          noneOperation(async () => {
            noneRuns += 1;
            return 'none-queued';
          }),
        ),
      ],
      { processAdmission: coordinator },
    );
    assert.deepEqual(queuedBypass, [{ status: 'fulfilled', value: 'none-queued' }]);
    releaseShared.resolve();
    await shared;
    await allStarted.promise;

    const activeBypass = await settleToolCallBatch(
      [
        operationEntry(
          'none-active',
          noneOperation(async () => {
            noneRuns += 1;
            return 'none-active';
          }),
        ),
      ],
      { processAdmission: coordinator },
    );
    assert.deepEqual(activeBypass, [{ status: 'fulfilled', value: 'none-active' }]);
    assert.equal(noneRuns, 2);
    releaseAll.resolve();
    await allBatch;
  });

  test('does not make all() wait for a long-running none()', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const releaseNone = deferred<void>();
    const noneStarted = deferred<void>();
    const allStarted = deferred<void>();
    const noneBatch = settleToolCallBatch(
      [
        operationEntry(
          'none',
          noneOperation(async () => {
            noneStarted.resolve();
            await releaseNone.promise;
            return 'none';
          }),
        ),
      ],
      { processAdmission: coordinator },
    );
    await noneStarted.promise;
    const allBatch = settleToolCallBatch(
      [
        operationEntry(
          'all',
          processAllOperation(async () => {
            allStarted.resolve();
            return 'all';
          }, coordinator),
        ),
      ],
      { processAdmission: coordinator },
    );

    await allStarted.promise;
    assert.deepEqual(await allBatch, [{ status: 'fulfilled', value: 'all' }]);
    releaseNone.resolve();
    await noneBatch;
  });

  test('runs a preparation-failure fallback under real exclusive admission', async () => {
    const coordinator = createProcessResourceAdmissionCoordinator();
    const releaseShared = deferred<void>();
    let fallbackStarted = false;
    const shared = coordinator.withShared(undefined, async () => {
      await releaseShared.promise;
    });
    const fallbackBatch = settleToolCallBatch(
      [
        entry(
          'fallback',
          async () => {
            throw new Error('prepare failed');
          },
          async () => {
            fallbackStarted = true;
            return 'fallback';
          },
        ),
      ],
      { processAdmission: coordinator },
    );
    await flushMicrotasks();
    assert.equal(fallbackStarted, false);
    assert.equal(coordinator.inspect().queued[0]?.mode, 'exclusive');

    releaseShared.resolve();
    await shared;
    assert.deepEqual(await fallbackBatch, [{ status: 'fulfilled', value: 'fallback' }]);
    assert.equal(fallbackStarted, true);
  });
});

function operationEntry<Result>(
  id: string,
  operation: PreparedOperation<Result>,
): ToolCallBatchEntry<Result> {
  return {
    id,
    prepare: async () => operation,
    run: async (candidate) => (await candidate?.execute()) as Result,
  };
}

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
