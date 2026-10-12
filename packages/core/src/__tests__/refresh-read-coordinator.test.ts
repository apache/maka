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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createRefreshReadCoordinator } from '../refresh-read-coordinator.js';

function fakeScheduler() {
  let pending: (() => void) | undefined;
  return {
    schedule(callback: () => void) {
      pending = callback;
      return () => {
        if (pending === callback) pending = undefined;
      };
    },
    flush() {
      const callback = pending;
      pending = undefined;
      callback?.();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('createRefreshReadCoordinator', () => {
  it('retires an in-flight read as soon as a newer authority event arrives', async () => {
    const scheduler = fakeScheduler();
    const reads: Array<ReturnType<typeof deferred<string>>> = [];
    const applied: string[] = [];
    const coordinator = createRefreshReadCoordinator({
      read: () => {
        const read = deferred<string>();
        reads.push(read);
        return read.promise;
      },
      apply: (result) => applied.push(result),
      delayMs: 400,
      schedule: scheduler.schedule,
    });

    coordinator.refresh();
    assert.equal(reads.length, 1);
    coordinator.observe();
    reads[0]!.resolve('stale');
    await Promise.resolve();
    assert.deepEqual(applied, []);

    scheduler.flush();
    assert.equal(reads.length, 2);
    reads[1]!.resolve('fresh');
    await Promise.resolve();
    assert.deepEqual(applied, ['fresh']);
  });

  it('retires an in-flight read when an immediate refresh replaces it', async () => {
    const scheduler = fakeScheduler();
    const reads: Array<ReturnType<typeof deferred<string>>> = [];
    const applied: string[] = [];
    const coordinator = createRefreshReadCoordinator({
      read: () => {
        const read = deferred<string>();
        reads.push(read);
        return read.promise;
      },
      apply: (result) => applied.push(result),
      delayMs: 400,
      schedule: scheduler.schedule,
    });

    coordinator.refresh();
    coordinator.refresh();
    assert.equal(reads.length, 2);
    reads[0]!.resolve('old');
    await Promise.resolve();
    assert.deepEqual(applied, []);
    reads[1]!.resolve('new');
    await Promise.resolve();
    assert.deepEqual(applied, ['new']);
  });
});
