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
import { deferred } from '@maka/core/test-only/async-primitives';
import { createNotificationAuthorizationReader, notificationPermissionSnapshot } from '../notification-permission.js';

test('maps native authorization without claiming unsupported future states are granted', async () => {
  for (const [native, expected] of [
    [0, 'not_determined'], [1, 'denied'], [2, 'granted'], [3, 'granted'], [4, 'unknown'],
  ] as const) {
    const snapshot = await notificationPermissionSnapshot(123, 'darwin', true, async () => native);
    assert.equal(snapshot.status, expected);
    assert.equal(snapshot.source, 'platform');
    assert.equal(snapshot.checkedAt, 123);
    assert.equal(snapshot.canRequest, false);
    assert.equal(snapshot.canOpenSettings, true);
    assert.equal(Boolean(snapshot.reason), native >= 3);
  }
});

test('reports load and native query failures as unknown, not denied or unsupported', async () => {
  for (const message of ['module could not be loaded', 'Notification settings query timed out']) {
    const snapshot = await notificationPermissionSnapshot(123, 'darwin', true, async () => {
      throw new Error(message);
    });
    assert.equal(snapshot.status, 'unknown');
    assert.ok(snapshot.reason?.includes(message));
    assert.equal(snapshot.canOpenSettings, true);
  }
});

test('never loads the native bridge on another platform or when notifications are unsupported', async () => {
  const read = async (): Promise<number> => { assert.fail('native query must not run'); };
  for (const platform of ['linux', 'win32'] as const) {
    const snapshot = await notificationPermissionSnapshot(123, platform, true, read);
    assert.equal(snapshot.status, 'unknown');
    assert.equal(snapshot.canOpenSettings, false);
    assert.equal(snapshot.source, 'electron');
  }
  const unsupported = await notificationPermissionSnapshot(123, 'darwin', false, read);
  assert.equal(unsupported.status, 'unsupported');
});

test('overlapping snapshots share native work but retain each caller timestamp', async () => {
  let calls = 0;
  let status = 2;
  const pending = deferred<number>();
  const read = createNotificationAuthorizationReader(() => {
    calls++;
    return calls === 1 ? pending.promise : Promise.resolve(status);
  });
  const snapshots = Array.from({ length: 8 }, (_, now) =>
    notificationPermissionSnapshot(now, 'darwin', true, read));
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve(status);
  const results = await Promise.all(snapshots);
  results.forEach((result, now) => {
    assert.equal(result.status, 'granted');
    assert.equal(result.checkedAt, now);
  });
  status = 1;
  assert.equal((await notificationPermissionSnapshot(10, 'darwin', true, read)).status, 'denied');
  assert.equal(calls, 2);
});

test('a shared native rejection settles all callers and a later refresh retries', async () => {
  const pending = deferred<number>();
  let calls = 0;
  const read = createNotificationAuthorizationReader(() => {
    calls++;
    return calls === 1 ? pending.promise : Promise.resolve(0);
  });
  const snapshots = Array.from({ length: 8 }, (_, now) =>
    notificationPermissionSnapshot(now, 'darwin', true, read));
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.reject(new Error('Notification settings query timed out'));
  for (const result of await Promise.all(snapshots)) {
    assert.equal(result.status, 'unknown');
    assert.match(result.reason ?? '', /timed out/);
  }
  assert.equal((await notificationPermissionSnapshot(10, 'darwin', true, read)).status, 'not_determined');
  assert.equal(calls, 2);
});

test('a synchronous module load failure also clears the in-flight reader', async () => {
  let calls = 0;
  const read = createNotificationAuthorizationReader(() => {
    if (++calls === 1) throw new Error('module could not be loaded');
    return Promise.resolve(2);
  });
  const failed = await notificationPermissionSnapshot(1, 'darwin', true, read);
  assert.equal(failed.status, 'unknown');
  assert.match(failed.reason ?? '', /module could not be loaded/);
  assert.equal((await notificationPermissionSnapshot(2, 'darwin', true, read)).status, 'granted');
  assert.equal(calls, 2);
});
