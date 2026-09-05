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
import type {
  AppUpdateInstallRequest,
  AppUpdateInstallResult,
} from '../../preload/bridge-contract.js';
import {
  isAppUpdateInstallFailure,
  requestDownloadedAppUpdate,
} from '../../renderer/app-update-install.js';

describe('requestDownloadedAppUpdate', () => {
  test('identifies asynchronous install failures from update status', () => {
    assert.equal(isAppUpdateInstallFailure({
      state: 'error',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      operation: 'install',
      message: 'signature rejected',
    }), true);
    assert.equal(isAppUpdateInstallFailure({
      state: 'error',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      operation: 'download',
      message: 'offline',
    }), false);
  });

  test('installs immediately when main reports no active work', async () => {
    const requests: AppUpdateInstallRequest[] = [];
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async (request) => {
        requests.push(request);
        return { ok: true };
      },
      confirmActiveTasks: async () => {
        throw new Error('confirmation should not open');
      },
    });

    assert.deepEqual(requests, [{ allowInterruptActiveTasks: false }]);
    assert.deepEqual(outcome, { kind: 'install-started' });
  });

  test('leaves the downloaded update pending when the user cancels', async () => {
    const requests: AppUpdateInstallRequest[] = [];
    let confirmed = false;
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async (request) => {
        requests.push(request);
        return { ok: false, reason: 'active_tasks' };
      },
      confirmActiveTasks: async () => {
        confirmed = true;
        return false;
      },
    });

    assert.equal(confirmed, true);
    assert.deepEqual(requests, [{ allowInterruptActiveTasks: false }]);
    assert.deepEqual(outcome, { kind: 'cancelled' });
  });

  test('sends explicit interruption authority only after confirmation', async () => {
    const requests: AppUpdateInstallRequest[] = [];
    const results: AppUpdateInstallResult[] = [
      { ok: false, reason: 'active_tasks' },
      { ok: true },
    ];
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async (request) => {
        requests.push(request);
        return results.shift()!;
      },
      confirmActiveTasks: async () => true,
    });

    assert.deepEqual(requests, [
      { allowInterruptActiveTasks: false },
      { allowInterruptActiveTasks: true },
    ]);
    assert.deepEqual(outcome, { kind: 'install-started' });
  });

  test('returns a terminal failure from the authorized install attempt', async () => {
    const results: AppUpdateInstallResult[] = [
      { ok: false, reason: 'active_tasks' },
      { ok: false, reason: 'install_failed' },
    ];
    const outcome = await requestDownloadedAppUpdate({
      installUpdate: async () => results.shift()!,
      confirmActiveTasks: async () => true,
    });

    assert.deepEqual(outcome, { kind: 'failed', reason: 'install_failed' });
  });
});
