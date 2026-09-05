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
import { afterEach, describe, test } from 'node:test';
import { act, createElement } from 'react';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  AppUpdateServicesProvider,
  createFakeAppUpdateServices,
  useAppUpdateController,
  type AppUpdateController,
  type AppUpdateStatus,
} from '../../renderer/features/app-update/testing.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let latest: AppUpdateController | undefined;

function ControllerProbe() {
  latest = useAppUpdateController();
  return null;
}

afterEach(() => {
  latest = undefined;
  cleanupFakeDom();
});

describe('App Update controller', () => {
  test('subscribes before reading and rejects a stale initial snapshot', async () => {
    const { root } = installReactRenderer();
    const initial = deferred<AppUpdateStatus>();
    const order: string[] = [];
    let emit: ((status: AppUpdateStatus) => void) | undefined;
    let unsubscribeCount = 0;
    const services = createFakeAppUpdateServices({
      appUpdate: {
        updateStatus: () => {
          order.push('read');
          return initial.promise;
        },
        checkForUpdates: async () => ({ state: 'idle', currentVersion: '1.0.0' }),
        retryUpdateDownload: async () => ({ state: 'idle', currentVersion: '1.0.0' }),
        installUpdate: async () => ({ ok: false, reason: 'not_downloaded' }),
        subscribeUpdateStatus: (handler) => {
          order.push('subscribe');
          emit = handler;
          return () => {
            unsubscribeCount += 1;
          };
        },
      },
    });

    await act(async () => {
      root.render(createElement(
        AppUpdateServicesProvider,
        { services },
        createElement(ControllerProbe),
      ));
    });
    assert.deepEqual(order, ['subscribe', 'read']);

    const downloaded: AppUpdateStatus = {
      state: 'downloaded',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    };
    await act(async () => emit?.(downloaded));
    await act(async () => {
      initial.resolve({ state: 'idle', currentVersion: '1.0.0' });
      await initial.promise;
    });
    assert.deepEqual(latest?.status, downloaded);

    await act(async () => root.unmount());
    assert.equal(unsubscribeCount, 1);
    emit?.({ state: 'checking', currentVersion: '1.0.0' });
    assert.deepEqual(latest?.status, downloaded);
  });

  test('deduplicates manual checks and fences their returned snapshot behind pushes', async () => {
    const { root } = installReactRenderer();
    const check = deferred<AppUpdateStatus>();
    let checkCount = 0;
    let emit: ((status: AppUpdateStatus) => void) | undefined;
    const services = createFakeAppUpdateServices({
      appUpdate: {
        updateStatus: async () => ({ state: 'idle', currentVersion: '1.0.0' }),
        checkForUpdates: () => {
          checkCount += 1;
          return check.promise;
        },
        retryUpdateDownload: async () => ({ state: 'idle', currentVersion: '1.0.0' }),
        installUpdate: async () => ({ ok: false, reason: 'not_downloaded' }),
        subscribeUpdateStatus: (handler) => {
          emit = handler;
          return () => undefined;
        },
      },
    });

    await act(async () => {
      root.render(createElement(
        AppUpdateServicesProvider,
        { services },
        createElement(ControllerProbe),
      ));
    });

    let first!: Promise<AppUpdateStatus>;
    let second!: Promise<AppUpdateStatus>;
    await act(async () => {
      first = latest!.commands.checkForUpdates();
      second = latest!.commands.checkForUpdates();
    });
    assert.equal(first, second);
    assert.equal(checkCount, 1);
    assert.equal(latest?.checking, true);

    const progress: AppUpdateStatus = {
      state: 'downloading',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      progress: { percent: 42 },
    };
    await act(async () => emit?.(progress));
    await act(async () => {
      check.resolve({ state: 'checking', currentVersion: '1.0.0' });
      await Promise.all([first, second]);
    });

    assert.deepEqual(latest?.status, progress);
    assert.equal(latest?.checking, false);
    await act(async () => root.unmount());
  });
});
