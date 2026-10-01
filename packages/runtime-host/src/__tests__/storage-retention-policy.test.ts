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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HostStorageRetentionPolicy,
  retentionDeadline,
  RETENTION_DAY_MS,
} from '../server/storage-retention-policy.js';

test('retention defaults off, persists a Host clock, and changes restart aging', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 10_000;
  const store = await HostStorageRetentionPolicy.open(root, () => now);
  assert.equal(retentionDeadline(store.snapshot(), 0), null);
  const policy = await store.set({ enabled: true, days: 30, expectedRevision: 0 });
  assert.equal(policy?.enabledAt, now);
  assert.equal(retentionDeadline(policy!, 0), now + 30 * RETENTION_DAY_MS);
  assert.equal(retentionDeadline(policy!), now + 30 * RETENTION_DAY_MS);
  assert.equal(retentionDeadline(policy!, now + 100), now + 100 + 30 * RETENTION_DAY_MS);
  assert.equal(await store.set({ enabled: false, days: 30, expectedRevision: 0 }), undefined);
  now += 1_000;
  const changed = await store.set({ enabled: true, days: 60, expectedRevision: 1 });
  assert.equal(changed?.enabledAt, now);
  assert.deepEqual((await HostStorageRetentionPolicy.open(root)).snapshot(), changed);
  const disabled = await store.set({ enabled: false, days: 60, expectedRevision: 2 });
  assert.equal(disabled?.enabledAt, null);
  assert.equal(retentionDeadline(disabled!), null);
});

test('policy changes serialize with admitted removal and reject stale sweeps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await HostStorageRetentionPolicy.open(root, () => 100);
  await store.set({ enabled: true, days: 30, expectedRevision: 0 });
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const removing = store.withCurrent(1, async () => {
    await barrier;
    return 'removed';
  });
  const disabling = store.set({ enabled: false, days: 30, expectedRevision: 1 });
  await Promise.resolve();
  assert.equal(store.snapshot().enabled, true);
  finish();
  assert.equal(await removing, 'removed');
  await disabling;
  assert.equal(await store.withCurrent(1, async () => assert.fail('stale removal')), undefined);
});

test('malformed destructive opt-in never silently enables retention', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'storage-retention.json'), '{"enabled":true}');
  await assert.rejects(HostStorageRetentionPolicy.open(root));
});
