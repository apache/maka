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
import { registerHooks } from 'node:module';
import test from 'node:test';
import { structuredToolPatch, textToolPatch } from '../app/toolPatch.ts';

const app = new URL('../app/', import.meta.url);
const locale = `
  export const currentLocale = () => 'en';
  export const localizedPresentation = value => value;
  export const displayText = ({ fallback }) => fallback;
  export const tr = (key, values = {}) =>
    key.replace(/\\{(\\w+)\\}/g, (placeholder, name) => values[name] ?? placeholder);
`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(app.href)) {
      if (specifier === './locale')
        return { url: `data:text/javascript,${encodeURIComponent(locale)}`, shortCircuit: true };
      if (specifier.startsWith('.') && !/\.\w+$/.test(specifier))
        return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});
const { activityFailure, activityPresentation, activityProjection, activityTitle } = await import(
  new URL('toolActivityPresentation.ts', app)
);
const { toolResult } = await import(new URL('toolCards.ts', app));
hooks.deregister();

const sendKey = 'maka.agent.Agent@1/send';
const workKey = 'maka.agent.Agent@1/work';

test('a queued message says what was sent, where it is going and that it is queued', () => {
  assert.equal(
    activityTitle({ name: 'SessionSend', presentation: sendKey }),
    'Send message to agent',
  );
  const send = activityPresentation(sendKey);
  assert.deepEqual(
    activityProjection(
      send,
      'arguments',
      { sessionId: 'opaque-session-id', message: 'Check the compiler output.' },
      { returned: true, sessionTitle: () => 'Compiler investigation' },
    ).sections.map(({ label, text }) => [label, text]),
    [
      ['Message', 'Check the compiler output.'],
      ['Conversation', 'Compiler investigation'],
    ],
  );
  assert.deepEqual(
    activityProjection(
      send,
      'result',
      { kind: 'queued', messageId: 'opaque-message-id', completion: 'registered' },
      { returned: true },
    ).sections.map(({ text }) => text),
    ['Message queued', 'Notify when work ends'],
  );
});

test('a rejected send shows its reason and a Host error shows a readable diagnosis', () => {
  const rejected = activityProjection(
    activityPresentation(sendKey),
    'result',
    { kind: 'rejected', reason: 'model_unavailable' },
    { returned: true },
  );
  assert.deepEqual(
    rejected.sections.map(({ text, tone }) => [text, tone]),
    [['Selected model is unavailable', 'error']],
  );
  assert.deepEqual(
    activityFailure({
      receipt: {
        kind: 'recorded',
        outcome: {
          kind: 'returned',
          result: { kind: 'failure', diagnostic: 'agent_session_unavailable' },
        },
      },
    }),
    { kind: 'failure', message: 'Conversation is unavailable' },
  );
});

test('checking work shows the captured wait or the final response', () => {
  const work = activityPresentation(workKey);
  const render = (state, answer) =>
    activityProjection(
      work,
      'result',
      { kind: 'delivered', execution: { state }, answer },
      { returned: true },
    ).sections.map(({ text }) => text);
  assert.deepEqual(render({ kind: 'waiting', waits: [{ kind: 'approval' }] }, null), [
    'Waiting when checked',
    'Approval',
  ]);
  assert.deepEqual(render({ kind: 'completed' }, { text: 'The build passed.' }), [
    'Completed',
    'The build passed.',
  ]);
});

test('ApplyPatch details preserve excerpts for each requested hunk', () => {
  const patch =
    '@@ first function\n keep\n-return false;\n+return true;\n@@\n-newName\n+betterName';
  assert.deepEqual(structuredToolPatch('src/example.ts', 'update_file', patch), [
    {
      path: 'src/example.ts',
      operation: 'update',
      hunks: [
        { context: 'first function', before: 'keep\nreturn false;', after: 'keep\nreturn true;' },
        { context: '', before: 'newName', after: 'betterName' },
      ],
    },
  ]);
});

test('a freeform patch shows an added file and a deletion without fabricating the deleted text', () => {
  assert.deepEqual(
    textToolPatch(
      '*** Begin Patch\n*** Add File: notes.md\n+hello\n*** Delete File: old.md\n*** End Patch',
    ),
    [
      {
        path: 'notes.md',
        operation: 'create',
        hunks: [{ context: '', before: '', after: 'hello' }],
      },
      { path: 'old.md', operation: 'delete', hunks: [] },
    ],
  );
});

test('a partially applied patch shows the failed file and files already changed', () => {
  const projection = toolResult('patch', {
    kind: 'completed',
    value: {
      status: 'failed',
      applied: [{ type: 'create_file', path: 'notes.md' }],
      failed: { type: 'update_file', path: 'src/example.ts' },
      error: 'Could not find the expected context.',
    },
  });
  assert.deepEqual(
    projection.sections.map(({ label, text }) => [label, text]),
    [
      ['Patch did not finish', 'src/example.ts\nCould not find the expected context.'],
      ['Files already changed', 'notes.md'],
    ],
  );
});
