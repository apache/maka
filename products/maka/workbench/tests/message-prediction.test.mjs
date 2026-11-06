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

let bundleSequence = 0;
async function bundles() {
  const fixture = ++bundleSequence;
  const settings = await import(`../app/messagePrediction.ts?fixture=${fixture}&bundle=settings`);
  const conversation = await import(
    `../app/messagePrediction.ts?fixture=${fixture}&bundle=conversation`
  );
  return { settings, conversation };
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function prediction(t, conversation, preferences) {
  const requests = [];
  const errors = [];
  const controller = conversation.createMessagePrediction({
    sessionId: 'conversation',
    preferences,
    changed() {},
    report: (reason) => errors.push(reason),
    async begin(input) {
      const result = deferred();
      const request = {
        input,
        cancelled: false,
        finish(revision, suggestion) {
          result.resolve({
            kind: 'finished',
            reply: {
              receipt: {
                kind: 'recorded',
                outcome: {
                  kind: 'returned',
                  value: {
                    sourceTurnId: input.expectedTurnId,
                    policyRevision: revision,
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
        next: () => result.promise,
        cancel() {
          request.cancelled = true;
        },
      };
    },
  });
  t.after(() => controller.dispose());
  return { controller, requests, errors };
}

test('settings in one bundle retire another bundle’s suggestion and its late original result', async (t) => {
  const { settings, conversation } = await bundles();
  let preferences = { revision: 100, predictions: { enabled: true } };
  settings.observePredictionPreferences(preferences);
  const { controller, requests, errors } = prediction(t, conversation, async () => preferences);
  controller.source('turn-one', 'live');
  controller.eligible(true);
  await setImmediate();
  requests[0].finish(100, 'Review the first patch.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-one',
    text: 'Review the first patch.',
  });

  preferences = { revision: 101, predictions: { enabled: false } };
  settings.invalidatePredictionPreferences(101);
  assert.equal(controller.presentation.current(), null);
  await setImmediate();

  controller.source('turn-two', 'live');
  preferences = { revision: 102, predictions: { enabled: true } };
  settings.observePredictionPreferences(preferences);
  await setImmediate();
  const original = requests.at(-1);
  assert.deepEqual(original.input, {
    sessionId: 'conversation',
    expectedTurnId: 'turn-two',
    trigger: 'live',
  });
  preferences = { revision: 103, predictions: { enabled: false } };
  settings.invalidatePredictionPreferences(103);
  assert.equal(original.cancelled, true);
  original.finish(102, 'This result belongs to the retired settings.');
  await setImmediate();
  assert.equal(controller.presentation.current(), null);
  assert.deepEqual(errors, []);
});

test('a cross-bundle invalidation fences an older settings read until current preferences arrive', async (t) => {
  const { settings, conversation } = await bundles();
  settings.observePredictionPreferences({ revision: 200, predictions: { enabled: true } });
  settings.invalidatePredictionPreferences(201);
  const reads = [];
  const { controller, requests, errors } = prediction(t, conversation, () => {
    const read = deferred();
    reads.push(read);
    return read.promise;
  });
  controller.source('turn-current', 'live');
  controller.eligible(true);
  settings.invalidatePredictionPreferences(202);
  reads[0].resolve({ revision: 201, predictions: { enabled: true } });
  await setImmediate();
  assert.equal(controller.presentation.current(), null);
  assert.equal(requests.length, 0);

  reads[1].resolve({ revision: 202, predictions: { enabled: false } });
  await setImmediate();
  settings.observePredictionPreferences({ revision: 201, predictions: { enabled: true } });
  await setImmediate();
  assert.equal(requests.length, 0);

  settings.observePredictionPreferences({ revision: 203, predictions: { enabled: true } });
  await setImmediate();
  const original = requests.at(-1);
  assert.deepEqual(original.input, {
    sessionId: 'conversation',
    expectedTurnId: 'turn-current',
    trigger: 'live',
  });
  original.finish(203, 'Use the current settings.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-current',
    text: 'Use the current settings.',
  });
  assert.deepEqual(errors, []);
});
