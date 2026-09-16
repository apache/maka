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
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';

test('returns a structured WorkHub attachment rejection across IPC', async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostWorkHubIpc(
    {} as Parameters<typeof registerRuntimeHostWorkHubIpc>[0],
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    {
      attachmentIngest: {
        approvals: {} as never,
        stat: async () => ({ size: 0 }),
      },
    },
  );

  const prepareAttachments = handlers.get('workhub:prepareAttachments');
  assert.ok(prepareAttachments);
  const result = await prepareAttachments(
    { sender: { id: 7 } } as Parameters<IpcHandler>[0],
    Array.from({ length: 9 }, () => ({})),
  );
  assert.deepEqual(result, { ok: false, code: 'count_limit' });
});
