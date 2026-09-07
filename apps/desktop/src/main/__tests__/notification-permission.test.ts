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
import { notificationPermissionSnapshot } from '../notification-permission.js';

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

test('requeries after a system settings change instead of retaining a stale grant', async () => {
  let status = 2;
  const read = async () => status;
  assert.equal((await notificationPermissionSnapshot(1, 'darwin', true, read)).status, 'granted');
  status = 1;
  assert.equal((await notificationPermissionSnapshot(2, 'darwin', true, read)).status, 'denied');
});
