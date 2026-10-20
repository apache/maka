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
import type { StoredMessage } from '@maka/core/session';
import { acceptStoredTurn, TurnOutcomeClassifier } from '../run-turn-outcome.js';

const call = (
  id: string,
  stepId: string | undefined,
  args: unknown = { url: 'https://example.test' },
  toolName = 'Fetch',
): Extract<StoredMessage, { type: 'tool_call' }> => ({
  type: 'tool_call',
  id,
  turnId: 'turn',
  ts: 1,
  toolName,
  args,
  ...(stepId ? { stepId } : {}),
});
const result = (toolUseId: string, failed: boolean): StoredMessage => ({
  type: 'tool_result',
  id: toolUseId + '-result',
  toolUseId,
  turnId: 'turn',
  ts: 2,
  isError: failed,
  content: failed
    ? { kind: 'text', text: 'Denied', sandboxFailure: { reason: 'sandbox_boundary_required' } }
    : { kind: 'text', text: 'Success' },
});
function classify(messages: StoredMessage[], recoverStoredRetries = true) {
  const classifier = new TurnOutcomeClassifier('turn', { recoverStoredRetries });
  acceptStoredTurn(
    classifier,
    [...messages, { type: 'turn_state', id: 'end', turnId: 'turn', ts: 9, status: 'completed' }],
    'turn',
  );
  return classifier.outcome('fail').sandboxBoundary;
}
test('Session result recognizes an exact tool retry in a later step', () => {
  const messages = [call('a', 'step1'), result('a', true), call('b', 'step2'), result('b', false)];
  assert.equal(classify(messages), 'none');
  assert.equal(classify(messages, false), 'unresolved', 'blocking policy must still deny recovery');
});
for (const [name, retry] of [
  ['same-step sibling', call('b', 'step1')],
  ['different arguments', call('b', 'step2', { url: 'https://other.test' })],
  ['different tool', call('b', 'step2', { url: 'https://example.test' }, 'Read')],
  ['missing step', call('b', undefined)],
  ['missing arguments', { ...call('b', 'step2'), args: undefined }],
] as const)
  test(`Session recovery preserves failure after ${name}`, () => {
    assert.equal(
      classify([call('a', 'step1'), result('a', true), retry, result('b', false)]),
      'unresolved',
    );
  });
test('one successful retry does not clear a second failed call', () => {
  assert.equal(
    classify([
      call('a', 'step1'),
      call('c', 'step1'),
      result('a', true),
      result('c', true),
      call('b', 'step2'),
      result('b', false),
    ]),
    'unresolved',
  );
});
test('a later sandbox failure remains unresolved after a recovered call', () => {
  assert.equal(
    classify([
      call('a', 'step1'),
      result('a', true),
      call('b', 'step2'),
      result('b', false),
      call('c', 'step3'),
      result('c', true),
    ]),
    'unresolved',
  );
});
