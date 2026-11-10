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

test('a late prediction cannot replace the next turn’s suggestion', async (t) => {
  const { conversation } = await bundles(t);
  const { controller, requests, errors } = prediction(t, conversation, async () => ({
    revision: 1,
    predictions: { enabled: true },
  }));
  controller.source('turn-one', 'live');
  controller.eligible(true, 'empty');
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
  requests[0].finish(1, 'An obsolete next step.');
  await setImmediate();
  assert.equal(controller.presentation.current(), null);
  assert.equal(requests[1].input.expectedTurnId, 'turn-two');
  requests[1].finish(1, 'Review the new patch.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-two',
    text: 'Review the new patch.',
  });
  assert.deepEqual(errors, []);
});

let bundleSequence = 0;
async function bundles(t) {
  delete globalThis[Symbol.for('maka.prediction-preferences')];
  t.after(() => delete globalThis[Symbol.for('maka.prediction-preferences')]);
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

test('a draft entered while preferences load retires that turn even after clearing', async (t) => {
  const { conversation } = await bundles(t);
  const read = deferred();
  const { controller, requests, errors } = prediction(t, conversation, () => read.promise);
  controller.source('turn-one', 'live');
  controller.eligible(true, 'empty');
  controller.eligible(true, 'occupied');
  read.resolve({ revision: 1, predictions: { enabled: true } });
  await setImmediate();
  assert.equal(requests.length, 0);
  controller.eligible(true, 'empty');
  await setImmediate();
  assert.equal(requests.length, 0, 'clearing a draft must not start the skipped prediction');

  controller.source('turn-two', 'catch_up');
  await setImmediate();
  assert.deepEqual(requests[0].input, {
    sessionId: 'conversation',
    expectedTurnId: 'turn-two',
    trigger: 'catch_up',
  });
  requests[0].finish(1, 'Review the latest result.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-two',
    text: 'Review the latest result.',
  });
  controller.eligible(true, 'occupied');
  controller.source('turn-two', 'catch_up', 'changed-model');
  controller.eligible(true, 'empty');
  controller.source('turn-two', 'catch_up', 'changed-model');
  await setImmediate();
  assert.equal(requests.length, 1, 'the same skipped context must not be retried');
  controller.source('turn-two', 'catch_up', 'another-model');
  await setImmediate();
  assert.equal(requests.length, 2, 'a new context may predict once the composer is empty');
  requests[1].finish(1, null);
  await setImmediate();
  assert.deepEqual(errors, []);
});

test('restoring a composer waits for its contents before predicting or skipping', async (t) => {
  const { conversation } = await bundles(t);
  const { controller, requests } = prediction(t, conversation, async () => ({
    revision: 1,
    predictions: { enabled: true },
  }));
  controller.source('empty-turn', 'catch_up');
  controller.eligible(true, 'restoring');
  await setImmediate();
  assert.equal(requests.length, 0);
  controller.eligible(true, 'empty');
  await setImmediate();
  assert.equal(requests[0].input.expectedTurnId, 'empty-turn');
  requests[0].finish(1, null);
  await setImmediate();

  controller.eligible(true, 'restoring');
  controller.source('occupied-turn', 'catch_up');
  await setImmediate();
  controller.eligible(true, 'occupied');
  controller.eligible(true, 'empty');
  await setImmediate();
  assert.equal(requests.length, 1, 'restored drafts skip rather than defer');
});

test('a replacement turn occupied while an older request drains is skipped', async (t) => {
  const { conversation } = await bundles(t);
  const { controller, requests } = prediction(t, conversation, async () => ({
    revision: 1,
    predictions: { enabled: true },
  }));
  controller.source('old-turn', 'live');
  controller.eligible(true, 'empty');
  await setImmediate();
  const old = requests[0];
  controller.eligible(true, 'occupied');
  controller.source('new-turn', 'live');
  assert.equal(old.cancelled, true);
  controller.eligible(true, 'empty');
  old.finish(1, 'Obsolete.');
  await setImmediate();
  assert.equal(requests.length, 1, 'clearing before cleanup must not revive the new turn');
});

test('a draft does not cancel an admitted prediction or discard its result', async (t) => {
  const { conversation } = await bundles(t);
  const { controller, requests, errors } = prediction(t, conversation, async () => ({
    revision: 1,
    predictions: { enabled: true },
  }));
  controller.source('turn-one', 'live');
  controller.eligible(true, 'empty');
  await setImmediate();
  const original = requests[0];
  controller.eligible(true, 'occupied');
  assert.equal(original.cancelled, false);
  original.finish(1, 'Continue with the patch.');
  await setImmediate();
  controller.eligible(true, 'empty');
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-one',
    text: 'Continue with the patch.',
  });
  assert.deepEqual(errors, []);
});

test('an occupied composer does not regenerate a stale result after a settings change', async (t) => {
  const { settings, conversation } = await bundles(t);
  let preferences = { revision: 1, predictions: { enabled: true } };
  const { controller, requests } = prediction(t, conversation, async () => preferences);
  controller.source('turn-one', 'live');
  controller.eligible(true, 'empty');
  await setImmediate();
  requests[0].finish(1, 'A suggestion.');
  await setImmediate();
  controller.eligible(true, 'occupied');
  settings.invalidatePredictionPreferences(2);
  preferences = { revision: 2, predictions: { enabled: true } };
  settings.observePredictionPreferences(preferences);
  controller.eligible(true, 'empty');
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.equal(controller.presentation.current(), null);
});

test('settings in one bundle retire another bundle’s suggestion and its late original result', async (t) => {
  const { settings, conversation } = await bundles(t);
  let preferences = { revision: 1, predictions: { enabled: true } };
  settings.observePredictionPreferences(preferences);
  const { controller, requests, errors } = prediction(t, conversation, async () => preferences);
  controller.source('turn-one', 'live');
  controller.eligible(true, 'empty');
  await setImmediate();
  requests[0].finish(1, 'Review the first patch.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-one',
    text: 'Review the first patch.',
  });

  preferences = { revision: 2, predictions: { enabled: false } };
  settings.invalidatePredictionPreferences(2);
  assert.equal(controller.presentation.current(), null);
  await setImmediate();

  controller.source('turn-two', 'live');
  preferences = { revision: 3, predictions: { enabled: true } };
  settings.observePredictionPreferences(preferences);
  await setImmediate();
  const original = requests.at(-1);
  assert.deepEqual(original.input, {
    sessionId: 'conversation',
    expectedTurnId: 'turn-two',
    trigger: 'live',
  });
  preferences = { revision: 4, predictions: { enabled: false } };
  settings.invalidatePredictionPreferences(4);
  assert.equal(original.cancelled, true);
  original.finish(3, 'This result belongs to the retired settings.');
  await setImmediate();
  assert.equal(controller.presentation.current(), null);
  assert.deepEqual(errors, []);
});

test('a cross-bundle invalidation fences an older settings read until current preferences arrive', async (t) => {
  const { settings, conversation } = await bundles(t);
  settings.observePredictionPreferences({ revision: 1, predictions: { enabled: true } });
  settings.invalidatePredictionPreferences(2);
  const reads = [];
  const { controller, requests, errors } = prediction(t, conversation, () => {
    const read = deferred();
    reads.push(read);
    return read.promise;
  });
  controller.source('turn-current', 'live');
  controller.eligible(true, 'empty');
  settings.invalidatePredictionPreferences(3);
  reads[0].resolve({ revision: 2, predictions: { enabled: true } });
  await setImmediate();
  assert.equal(controller.presentation.current(), null);
  assert.equal(requests.length, 0);

  reads[1].resolve({ revision: 3, predictions: { enabled: false } });
  await setImmediate();
  settings.observePredictionPreferences({ revision: 2, predictions: { enabled: true } });
  await setImmediate();
  assert.equal(requests.length, 0);

  settings.observePredictionPreferences({ revision: 4, predictions: { enabled: true } });
  await setImmediate();
  const original = requests.at(-1);
  assert.deepEqual(original.input, {
    sessionId: 'conversation',
    expectedTurnId: 'turn-current',
    trigger: 'live',
  });
  original.finish(4, 'Use the current settings.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-current',
    text: 'Use the current settings.',
  });
  assert.deepEqual(errors, []);
});

test('cancelling before begin returns still drains the original receipt after disposal', async (t) => {
  const { settings, conversation } = await bundles(t);
  const preferences = { revision: 1, predictions: { enabled: true } };
  settings.observePredictionPreferences(preferences);
  const admitted = deferred();
  const finished = deferred();
  const errors = [];
  let input;
  let cancelled = false;
  let progress = true;
  const controller = conversation.createMessagePrediction({
    sessionId: 'conversation',
    preferences: async () => preferences,
    begin(value) {
      input = value;
      return admitted.promise;
    },
    changed() {},
    report: (reason) => errors.push(reason.message),
  });
  t.after(() => controller.dispose());
  controller.source('turn-original', 'live');
  controller.eligible(true, 'empty');
  await setImmediate();
  assert.deepEqual(input, {
    sessionId: 'conversation',
    expectedTurnId: 'turn-original',
    trigger: 'live',
  });
  controller.source('turn-replacement', 'live');
  controller.dispose();
  admitted.resolve({
    cancel() {
      cancelled = true;
    },
    async next() {
      if (progress) {
        progress = false;
        return { kind: 'progress', value: { stage: 'accepted' } };
      }
      return finished.promise;
    },
  });
  await setImmediate();
  assert.equal(cancelled, true);
  finished.resolve({
    kind: 'finished',
    cleanupError: 'Original cleanup could not be confirmed.',
    reply: {
      receipt: {
        kind: 'recorded',
        outcome: {
          kind: 'returned',
          value: {
            sourceTurnId: 'turn-original',
            policyRevision: 1,
            suggestion: 'This belongs to the disposed observer.',
          },
        },
      },
    },
  });
  await setImmediate();
  assert.deepEqual(errors, ['Original cleanup could not be confirmed.']);
  assert.equal(controller.presentation.current(), null);
});

test('same-turn context changes replace the source while dismissal and empty results do not retry it', async (t) => {
  const { settings, conversation } = await bundles(t);
  const preferences = { revision: 1, predictions: { enabled: true } };
  settings.observePredictionPreferences(preferences);
  const { controller, requests, errors } = prediction(t, conversation, async () => preferences);
  controller.source('same-turn', 'live', 'first-context');
  controller.eligible(true, 'empty');
  await setImmediate();
  const original = requests[0];
  controller.source('same-turn', 'catch_up', 'second-context');
  await setImmediate();
  assert.equal(original.cancelled, true);
  assert.equal(requests.length, 1, 'the replacement must wait for the original receipt');
  original.finish(1, 'The first context is obsolete.');
  await setImmediate();
  const replacement = requests.at(-1);
  assert.deepEqual(replacement.input, {
    sessionId: 'conversation',
    expectedTurnId: 'same-turn',
    trigger: 'catch_up',
  });
  replacement.finish(1, 'This suggestion belongs to the second context.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'same-turn',
    text: 'This suggestion belongs to the second context.',
  });

  controller.presentation.dismiss('same-turn');
  controller.eligible(false, 'empty');
  controller.eligible(true, 'empty');
  controller.source('same-turn', 'catch_up', 'second-context');
  await setImmediate();
  assert.equal(controller.presentation.current(), null);
  assert.equal(requests.length, 2, 'visibility and the same context must not undo dismissal');

  controller.source('same-turn', 'live', 'third-context');
  await setImmediate();
  const empty = requests.at(-1);
  assert.deepEqual(empty.input, {
    sessionId: 'conversation',
    expectedTurnId: 'same-turn',
    trigger: 'live',
  });
  empty.finish(1, null);
  await setImmediate();
  controller.eligible(false, 'empty');
  controller.eligible(true, 'empty');
  await setImmediate();
  assert.equal(controller.presentation.current(), null);
  assert.equal(requests.length, 3, 'an empty settled result is not an unattempted source');
  assert.deepEqual(errors, []);
});

test('a late preferences read from a retired source cannot fence the replacement source', async (t) => {
  const { settings, conversation } = await bundles(t);
  settings.observePredictionPreferences({ revision: 1, predictions: { enabled: true } });
  const reads = [];
  const { controller, requests, errors } = prediction(t, conversation, () => {
    const read = deferred();
    reads.push(read);
    return read.promise;
  });
  controller.source('turn-old', 'live');
  controller.eligible(true, 'empty');
  controller.source('turn-new', 'catch_up');
  reads[0].resolve({ revision: 4, predictions: { enabled: false } });
  await setImmediate();
  reads[1].resolve({ revision: 2, predictions: { enabled: true } });
  await setImmediate();
  const current = requests.at(-1);
  assert.deepEqual(current.input, {
    sessionId: 'conversation',
    expectedTurnId: 'turn-new',
    trigger: 'catch_up',
  });
  current.finish(2, 'The replacement owns its preferences read.');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn-new',
    text: 'The replacement owns its preferences read.',
  });
  assert.deepEqual(errors, []);
});
