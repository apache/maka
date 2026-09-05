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
  startModuleHubLifecycle,
  type ModuleHubRuntimeHostChangedEvent,
} from '../../renderer/features/module-hub/testing.js';

test('Module Hub owns deferred startup, default-Host refresh, and cleanup', () => {
  let frame: FrameRequestCallback | undefined;
  let hostChange: ((event: ModuleHubRuntimeHostChangedEvent) => void) | undefined;
  const calls: string[] = [];
  const cleanup = startModuleHubLifecycle({
    runtimeHosts: {
      getDefault: async () => ({ profileId: 'local', hostId: 'local' }),
      subscribeChanges(handler) {
        hostChange = handler;
        return () => calls.push('unsubscribe-hosts');
      },
    },
    refreshProjectSkills: () => calls.push('skills'),
    refreshScheduledTasks: () => calls.push('tasks'),
    scheduler: {
      requestFrame(callback) {
        frame = callback;
        calls.push('request-frame');
        return 42;
      },
      cancelFrame(handle) {
        calls.push(`cancel-frame:${handle}`);
      },
    },
  });

  assert.deepEqual(calls, ['request-frame']);
  frame?.(0);
  assert.deepEqual(calls, ['request-frame', 'skills', 'tasks']);

  hostChange?.({
    profileId: 'remote',
    readiness: 'reconnecting',
    isDefault: true,
  });
  hostChange?.({
    profileId: 'remote',
    readiness: 'ready',
    isDefault: false,
  });
  assert.deepEqual(calls, ['request-frame', 'skills', 'tasks']);

  hostChange?.({
    profileId: 'remote',
    hostId: 'remote-host',
    readiness: 'ready',
    isDefault: true,
  });
  assert.deepEqual(calls, [
    'request-frame',
    'skills',
    'tasks',
    'skills',
    'tasks',
  ]);

  cleanup();
  assert.deepEqual(calls.slice(-2), [
    'cancel-frame:42',
    'unsubscribe-hosts',
  ]);
});
