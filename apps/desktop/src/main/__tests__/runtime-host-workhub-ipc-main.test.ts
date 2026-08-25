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
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';

test('projects WorkHub coordination resolution through its dedicated IPC domain', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let resolveCalls = 0;
  registerRuntimeHostWorkHubIpc(
    {
      resolveWorkHubCoordinationSession: async () => {
        resolveCalls += 1;
        return { sessionId: 'maka_workhub_coordination' };
      },
    } as never,
    {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    } as never,
  );

  const handler = handlers.get('workhub:resolveCoordinationSession');
  assert.ok(handler);
  assert.deepEqual(await handler({}), { sessionId: 'maka_workhub_coordination' });
  assert.equal(resolveCalls, 1);
});
