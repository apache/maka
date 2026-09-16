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
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import { collectAvailablePendingTurnRequests } from '../../preload/runtime-host-turn-request-inbox.js';

function request(requestId: string, createdAt: string): SessionTurnAccessRequest {
  return { requestId, createdAt } as SessionTurnAccessRequest;
}

test('keeps available collaboration inboxes when another Owner Host rejects', async () => {
  const requests = await collectAvailablePendingTurnRequests([
    Promise.reject(new Error('Local Host does not expose collaboration authority')),
    Promise.resolve([
      request('later', '2026-09-01T00:00:02.000Z'),
      request('earlier', '2026-09-01T00:00:01.000Z'),
    ]),
  ]);

  assert.deepEqual(requests.map(({ requestId }) => requestId), ['earlier', 'later']);
});

test('retains the previous inbox projection when every Owner Host rejects', async () => {
  await assert.rejects(
    collectAvailablePendingTurnRequests([
      Promise.reject(new Error('first unavailable')),
      Promise.reject(new Error('second unavailable')),
    ]),
    /Every Runtime Host collaboration inbox request failed/,
  );
});
