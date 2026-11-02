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
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createMessagePrediction } from '../app/messagePrediction.ts';

test('a late prediction cannot replace the next turn’s suggestion', async (t) => {
  const requests = [];
  const controller = createMessagePrediction({
    sessionId: 'conversation',
    preferences: async () => ({ revision: 1, predictions: { enabled: true } }),
    changed() {},
    report: (reason) => assert.fail(reason),
    begin: async (input) => {
      let finish;
      const result = new Promise((resolve) => {
        finish = resolve;
      });
      const request = {
        input,
        cancelled: false,
        finish(suggestion) {
          finish({
            kind: 'finished',
            reply: {
              receipt: {
                kind: 'recorded',
                outcome: {
                  kind: 'returned',
                  value: {
                    sourceTurnId: input.expectedTurnId,
                    policyRevision: 1,
                    suggestion,
                  },
                },
              },
            },
          });
        },
      };
      requests.push(request);
      return {
        next: () => result,
        cancel: () => {
          request.cancelled = true;
        },
      };
    },
  });
  t.after(() => controller.dispose());
  controller.source('turn-one', 'live');
  controller.eligible(true);
  await setImmediate();
  assert.deepEqual(requests[0].input, {
    sessionId: 'conversation',
    expectedTurnId: 'turn-one',
    trigger: 'live',
  });
  controller.source('turn-two', 'live');
  await setImmediate();
  assert.equal(requests[0].cancelled, true);
  assert.equal(requests.length, 1, 'replacement waits for the original to settle');
  requests[0].finish('An obsolete next step.');
  await setImmediate();
  assert.equal(controller.presentation.current(), null);
  assert.equal(requests[1].input.expectedTurnId, 'turn-two');
  requests[1].finish('Review the new patch.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-two',
    text: 'Review the new patch.',
  });
});
