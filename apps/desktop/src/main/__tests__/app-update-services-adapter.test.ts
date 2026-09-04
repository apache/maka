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

test('the Desktop adapter narrows the authoritative app bridge without wrapping it', () => {
  const app = {
    updateStatus: async () => ({ state: 'idle' as const, currentVersion: '1.0.0' }),
    checkForUpdates: async () => ({ state: 'checking' as const, currentVersion: '1.0.0' }),
    retryUpdateDownload: async () => ({ state: 'idle' as const, currentVersion: '1.0.0' }),
    installUpdate: async () => ({ ok: true as const }),
    subscribeUpdateStatus: () => () => undefined,
  };
  const bridge = { app } as unknown as DesktopAppUpdateBridge;

  const services = createDesktopAppUpdateServices(bridge);

  assert.equal(services.appUpdate, app);
});
