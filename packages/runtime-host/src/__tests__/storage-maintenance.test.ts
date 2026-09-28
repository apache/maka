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
import { HostStorageMaintenance } from '../server/storage-maintenance.js';

// Settle async lane continuations without advancing the next scheduled timer.
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

test('maintenance waits for start, yields between bounded batches, and stops on close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const cursors: (string | undefined)[] = [];
  let collections = 0;
  const maintenance = new HostStorageMaintenance({
    artifacts: {
      reclaimUpgradeResidue: async (input) => {
        assert.equal(input.maxPaths, 64);
        cursors.push(input.after);
        return {
          nextAfter: cursors.length === 1 ? 'page-1' : null,
          processedPaths: 64,
          failedPaths: 0,
        };
      },
    },
    contextOffload: {
      collectGarbage: async (input) => {
        assert.equal(input.maxBlobs, 64);
        assert.equal(input.maxBytes, 16 * 1024 * 1024);
        assert.equal(input.olderThan, Date.now());
        collections += 1;
        return { deletedBlobs: 64, deletedBytes: 1024, hasMore: true };
      },
    },
    onError: assert.fail,
  });
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(collections, 0);
  maintenance.start();
  maintenance.start();
  assert.equal(collections, 0);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(collections, 1);
  assert.deepEqual(cursors, [undefined]);
  t.mock.timers.tick(99);
  await settle();
  assert.equal(collections, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(collections, 2);
  assert.deepEqual(cursors, [undefined, 'page-1']);
  await maintenance.close();
  maintenance.start();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(collections, 2);
});

test('failed lanes back off independently, retry, and reset after success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  let pages = 0;
  const errors: string[] = [];
  const maintenance = new HostStorageMaintenance({
    artifacts: {
      reclaimUpgradeResidue: async () => {
        pages += 1;
        return { nextAfter: String(pages), processedPaths: 64, failedPaths: 0 };
      },
    },
    contextOffload: {
      collectGarbage: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('disk failure');
        return { deletedBlobs: 0, deletedBytes: 0, hasMore: false };
      },
    },
    onError: (name) => {
      errors.push(name);
    },
  });
  maintenance.start();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(attempts, 1);
  t.mock.timers.tick(999);
  await settle();
  assert.equal(attempts, 1);
  assert.ok(pages > 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(attempts, 2);
  t.mock.timers.tick(1999);
  await settle();
  assert.equal(attempts, 2);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(attempts, 3);
  assert.equal(errors.length, 2);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(attempts, 4);
  await maintenance.close();
});

test('close waits only for an admitted batch and never starts another one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const maintenance = new HostStorageMaintenance({
    artifacts: {
      reclaimUpgradeResidue: async () => {
        calls += 1;
        await blocked;
        return { nextAfter: 'more', processedPaths: 64, failedPaths: 0 };
      },
    },
    onError: assert.fail,
  });
  maintenance.start();
  t.mock.timers.tick(100);
  await settle();
  let closed = false;
  const closing = maintenance.close().then(() => {
    closed = true;
  });
  await settle();
  assert.equal(closed, false);
  release();
  await closing;
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(calls, 1);
});

test('failed paths do not pin the pagination cursor, and another sweep retries them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cursors: (string | undefined)[] = [];
  const maintenance = new HostStorageMaintenance({
    artifacts: {
      reclaimUpgradeResidue: async (input) => {
        cursors.push(input.after);
        return {
          nextAfter: cursors.length === 1 ? 'failed-path' : null,
          processedPaths: 1,
          failedPaths: 1,
        };
      },
    },
    onError: () => {
      throw new Error('broken logger');
    },
  });
  maintenance.start();
  t.mock.timers.tick(100);
  await settle();
  t.mock.timers.tick(100);
  await settle();
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(cursors, [undefined, 'failed-path', undefined]);
  await maintenance.close();
});
