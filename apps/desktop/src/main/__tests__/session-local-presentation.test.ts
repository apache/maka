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
import { test } from 'node:test';
import { localMessagePresentation, composerFollowUp } from '../../renderer/features/conversation/testing.js';
import type { DesktopLocalMessage } from '../../shared/session-local-contract.js';
import type { MessageQueueEntryProjection } from '@maka/core/events';

const message: DesktopLocalMessage = {
  sessionId: 'session', messageId: 'message', text: 'hello', state: 'accepted', createdAt: 1,
  canCancel: false, placement: 'current_turn', attachments: [], inlineReferences: [],
};
test('receipt disposition does not claim current queue or processing progress', () => {
  assert.equal(localMessagePresentation({ ...message, admission: 'followup' }, 'en').status, 'Delivered for a later reply · waiting for an update');
  assert.equal(localMessagePresentation({ ...message, turnId: 'old-turn' }, 'en', [], ['new-turn']).status, 'Delivered · waiting for an update');
  assert.equal(localMessagePresentation({ ...message, turnId: 'new-turn' }, 'en', [], ['new-turn']).status, 'Processing this message');
  const queue: MessageQueueEntryProjection[] = [{ entryId: 'entry', messageId: 'message', content: { text: 'hello' }, placement: 'next_turn', state: 'queued' }];
  assert.equal(localMessagePresentation(message, 'en', queue).status, 'Queued for the next reply');
  queue[0] = { ...queue[0]!, placement: 'current_turn', state: 'in_flight' };
  assert.equal(localMessagePresentation(message, 'en', queue).status, 'Added to the current reply');
});
test('unknown outcome only promises checking when a check is active or scheduled', () => {
  const unknown = { ...message, state: 'unknown' as const };
  assert.equal(localMessagePresentation(unknown, 'en').status, 'Delivery not confirmed');
  assert.doesNotMatch(localMessagePresentation(unknown, 'en').detail!, /automatically/);
  assert.equal(localMessagePresentation({ ...unknown, checking: true }, 'en').status, 'Checking delivery');
  assert.match(localMessagePresentation({ ...unknown, retryScheduled: true }, 'en').detail!, /automatically/);
  assert.doesNotMatch(localMessagePresentation({ ...unknown, retryScheduled: true, waitingForConnection: true }, 'en').detail!, /automatically/);
});


test('follow-up recovery consumes context only after admission and preserves it on refusal or error', async () => {
  const quotes = [{ text: 'original quote', sourceTurnId: 'old-turn' }];
  for (const outcome of [false, true, 'error'] as const) {
    let cleared = 0;
    let errors = 0;
    const submit = composerFollowUp({
      pending: undefined, quotes, directoryOptions: {},
      async enqueueMessage(sessionId, text, placement, pending, options) {
        assert.equal(sessionId, 'session');
        assert.equal(text, 'recovered');
        assert.equal(placement, 'next_turn');
        assert.equal(pending, undefined);
        assert.deepEqual(options.quotes, quotes);
        if (outcome === 'error') throw new Error('delivery failed');
        return outcome;
      },
      clearSubmittedContext() { cleared++; }, clearQuotes() { cleared++; },
      onError() { errors++; },
    });
    assert.equal(await submit('session', 'recovered', 'queue'), outcome === true);
    assert.equal(cleared, outcome === true ? 2 : 0);
    assert.equal(errors, outcome === 'error' ? 1 : 0);
  }
});
