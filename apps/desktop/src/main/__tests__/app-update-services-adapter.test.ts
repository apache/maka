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
import test from 'node:test';
import {
  createDesktopAppUpdateServices,
  type DesktopAppUpdateBridge,
} from '../../renderer/platform/desktop/create-app-update-services.js';

test('the Desktop adapter forwards exactly the five update capabilities to the app bridge', async () => {
  const calls: string[] = [];
  const app = {
    updateStatus: async () => {
      calls.push('updateStatus');
      return { state: 'idle' as const, currentVersion: '1.0.0' };
    },
    checkForUpdates: async () => {
      calls.push('checkForUpdates');
      return { state: 'checking' as const, currentVersion: '1.0.0' };
    },
    retryUpdateDownload: async () => {
      calls.push('retryUpdateDownload');
      return { state: 'idle' as const, currentVersion: '1.0.0' };
    },
    installUpdate: async (input: { allowInterruptActiveTasks: boolean }) => {
      calls.push(`installUpdate:${String(input.allowInterruptActiveTasks)}`);
      return { ok: true as const };
    },
    subscribeUpdateStatus: () => {
      calls.push('subscribeUpdateStatus');
      return () => undefined;
    },
    openArtifactPath: async () => undefined,
  };
  const bridge = { app } as unknown as DesktopAppUpdateBridge;

  const services = createDesktopAppUpdateServices(bridge);

  await services.appUpdate.updateStatus();
  await services.appUpdate.checkForUpdates();
  await services.appUpdate.retryUpdateDownload();
  await services.appUpdate.installUpdate({ allowInterruptActiveTasks: true });
  services.appUpdate.subscribeUpdateStatus(() => undefined)();

  assert.deepEqual(calls, [
    'updateStatus',
    'checkForUpdates',
    'retryUpdateDownload',
    'installUpdate:true',
    'subscribeUpdateStatus',
  ]);
  assert.deepEqual(Object.keys(services.appUpdate).sort(), [
    'checkForUpdates',
    'installUpdate',
    'retryUpdateDownload',
    'subscribeUpdateStatus',
    'updateStatus',
  ]);
});
