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
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

const first = await import('../app/uiSync.ts?bundle=first');
const second = await import('../app/uiSync.ts?bundle=second');

test('independent module copies deliver project scopes synchronously', (t) => {
  assert.notEqual(first.subscribe, second.subscribe);
  const actions = [];
  t.after(first.subscribe('actionDefinitions', (scope) => actions.push(scope)));

  second.invalidate('actionDefinitions', 'project-one');
  assert.deepEqual(actions, ['project-one']);
  first.invalidate('actionDefinitions', null);
  second.invalidate('actionDefinitions', 'project-two');
  assert.deepEqual(actions, ['project-one', null, 'project-two']);
});

test('origin exclusion and unsubscribe use the listener identity across module copies', (t) => {
  const calls = [];
  const origin = (scope) => calls.push(['origin', scope]);
  const peer = (scope) => calls.push(['peer', scope]);
  const unsubscribeOrigin = first.subscribe('actionDefinitions', origin);
  const unsubscribePeer = second.subscribe('actionDefinitions', peer);
  t.after(unsubscribeOrigin);
  t.after(unsubscribePeer);
  t.after(second.subscribe('actionDefinitions', peer));

  second.invalidate('actionDefinitions', 'project', origin);
  assert.deepEqual(calls, [['peer', 'project']]);
  unsubscribePeer();
  unsubscribePeer();
  first.invalidate('actionDefinitions', null);
  assert.deepEqual(calls, [
    ['peer', 'project'],
    ['origin', null],
  ]);
  unsubscribeOrigin();
  second.invalidate('actionDefinitions', 'closed');
  assert.deepEqual(calls, [
    ['peer', 'project'],
    ['origin', null],
  ]);
});

test('disposing another subscriber during notification removes it immediately', (t) => {
  const calls = [];
  let unsubscribePeer;
  t.after(
    first.subscribe('actionDefinitions', () => {
      calls.push('origin');
      unsubscribePeer();
    }),
  );
  unsubscribePeer = second.subscribe('actionDefinitions', () => calls.push('closed peer'));
  t.after(unsubscribePeer);
  second.invalidate('actionDefinitions', null);
  assert.deepEqual(calls, ['origin']);
});

test('subscriber errors propagate synchronously to the invalidating caller', (t) => {
  const failure = new Error('Subscriber failed.');
  t.after(
    first.subscribe('actionDefinitions', () => {
      throw failure;
    }),
  );
  assert.throws(
    () => second.invalidate('actionDefinitions', 'project'),
    (reason) => reason === failure,
  );
});

async function bundle(name) {
  const result = await build({
    stdin: {
      contents: `export * from './messagePrediction.ts';
        export * from './uiSync.ts';
        export const bundleName = ${JSON.stringify(name)};`,
      resolveDir: fileURLToPath(new URL('../app/', import.meta.url)),
      sourcefile: `${name}.ts`,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
}

test('separately compiled bundles share Action notifications and prediction preferences', async (t) => {
  delete globalThis[Symbol.for('maka.prediction-preferences')];
  t.after(() => delete globalThis[Symbol.for('maka.prediction-preferences')]);
  const settings = await bundle('settings');
  const conversation = await bundle('conversation');
  assert.notEqual(settings.subscribe, conversation.subscribe);
  const projects = [];
  t.after(conversation.subscribe('actionDefinitions', (scope) => projects.push(scope)));
  settings.invalidate('actionDefinitions', 'project');
  assert.deepEqual(projects, ['project']);

  let preferences = { revision: 1, predictions: { enabled: true } };
  let beginCount = 0;
  const errors = [];
  const controller = conversation.createMessagePrediction({
    sessionId: 'conversation',
    preferences: async () => preferences,
    changed() {},
    report: (reason) => errors.push(reason),
    async begin() {
      beginCount++;
      return {
        cancel() {},
        async next() {
          return {
            kind: 'finished',
            reply: {
              receipt: {
                kind: 'recorded',
                outcome: {
                  kind: 'returned',
                  result: {
                    kind: 'success',
                    value: {
                      sourceTurnId: 'turn',
                      policyRevision: 1,
                      suggestion: 'Review the patch.',
                    },
                  },
                },
              },
            },
          };
        },
      };
    },
  });
  t.after(() => controller.dispose());
  controller.source('turn', 'live');
  controller.eligible(true, 'empty');
  await setImmediate();
  assert.deepEqual(controller.presentation.current(), {
    sourceTurnId: 'turn',
    text: 'Review the patch.',
  });
  preferences = { revision: 2, predictions: { enabled: false } };
  settings.invalidatePredictionPreferences(2);
  assert.equal(controller.presentation.current(), null);
  await setImmediate();
  assert.equal(beginCount, 1);
  assert.deepEqual(projects, ['project']);
  assert.deepEqual(errors, []);
});
