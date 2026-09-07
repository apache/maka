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
import {
  describeOwnerTurnRequestIntent,
  describeTurnRequestIntent,
  groupPendingTurnRequests,
  samePendingTurnRequests,
  turnRequestPreview,
  unseenTurnRequests,
} from '../../renderer/features/session-collaboration/testing.js';

test('Turn-request inbox keeps only actionable requests and detects new arrivals', () => {
  const first = request('request-1', 'session-1', '  Review\nthis change  ');
  const second = request('request-2', 'session-1', 'Continue');
  const decided: SessionTurnAccessRequest = {
    ...request('request-3', 'session-2', 'Already handled'),
    state: {
      kind: 'rejected',
      decidedAt: '2026-09-01T00:00:03.000Z',
      decidedBy: 'local_owner',
    },
  };

  assert.deepEqual([...groupPendingTurnRequests([first, decided, second])], [
    ['session-1', [first, second]],
  ]);
  assert.deepEqual(unseenTurnRequests([first, second], new Set(['request-1'])), [second]);
  assert.equal(samePendingTurnRequests([first, second], [first, second]), true);
  assert.equal(samePendingTurnRequests([first], [second]), false);
  assert.equal(
    turnRequestPreview(describeTurnRequestIntent(first.intent, 'Regenerate response')),
    'Review this change',
  );
  assert.equal(
    describeTurnRequestIntent(
      {
        sessionId: 'session-1',
        turnId: 'turn-regenerated',
        sourceTurnId: 'turn-original',
      },
      'Regenerate response',
    ),
    'Regenerate response',
  );
  assert.equal(
    describeOwnerTurnRequestIntent(
      {
        sessionId: 'session-1',
        turnId: 'turn-regenerated',
        sourceTurnId: 'turn-original',
      },
      [{
        type: 'user',
        id: 'message-original',
        turnId: 'turn-original',
        ts: 1,
        text: 'Explain the failed deployment',
        displayText: 'Why did deployment fail?',
      }],
      'Regenerate response',
    ),
    'Regenerate response: Why did deployment fail?',
  );
});

function request(
  requestId: string,
  sessionId: string,
  text: string,
): SessionTurnAccessRequest {
  return {
    requestId,
    principalId: `session_guest:${requestId}`,
    grantId: `grant-${requestId}`,
    intent: { sessionId, turnId: `turn-${requestId}`, content: { text } },
    createdAt: '2026-09-01T00:00:00.000Z',
    state: { kind: 'pending' },
  };
}
