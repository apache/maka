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
import { discoverFixtureIdentity } from './real-model.mjs';

test('real-model fixture discovery binds fresh Windows windows to the live app id', async () => {
  const result = await discoverFixtureIdentity(42, [{ title: 'Target' }], {
    listApps: async () => [{ appId: 'win32:c:\\fixture.exe', pid: 42, windowCount: 1 }],
    listWindows: async () => [
      {
        appId: 'win32:c:\\fixture.exe',
        pid: 42,
        windowId: 123,
        layer: 0,
        zIndex: 1,
        onScreen: true,
      },
    ],
    observeWindow: async () => ({
      appId: 'win32:c:\\fixture.exe',
      pid: 42,
      windowId: 123,
      windowTitle: 'Target',
    }),
  });

  assert.deepEqual(result, {
    appIds: ['win32:c:\\fixture.exe'],
    instances: [{ pid: 42, windowIds: [123] }],
  });
});
