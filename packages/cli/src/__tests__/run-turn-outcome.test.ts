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

const denied: StoredMessage = {
  type: 'tool_result',
  id: 'denied',
  toolUseId: 'write',
  turnId: 'turn',
  ts: 1,
  isError: true,
  content: {
    kind: 'text',
    text: 'Permission denied',
    sandboxFailure: { reason: 'sandbox_boundary_required' },
  },
};

test('a tool denial does not replace a completed Runtime terminal or final answer', () => {
  const classifier = new TurnOutcomeClassifier('turn');
  acceptStoredTurn(
    classifier,
    [
      denied,
      {
        type: 'assistant',
        modelId: 'test-model',
        id: 'answer',
        turnId: 'turn',
        ts: 2,
        text: 'Permission was denied; no file was written.',
      },
      { type: 'turn_state', id: 'end', turnId: 'turn', ts: 3, status: 'completed' },
    ],
    'turn',
  );
  const outcome = classifier.outcome('pending');
  assert.equal(outcome?.status, 'completed');
  assert.equal(outcome?.finalOutput, 'Permission was denied; no file was written.');
  assert.equal(outcome?.failure, undefined);
});

test('a real Runtime failure retains its original error after a tool denial', () => {
  const classifier = new TurnOutcomeClassifier('turn');
  acceptStoredTurn(
    classifier,
    [
      denied,
      {
        type: 'turn_state',
        id: 'end',
        turnId: 'turn',
        ts: 3,
        status: 'failed',
        errorClass: 'provider_error',
        failureMessage: 'Insufficient credits',
      },
    ],
    'turn',
  );
  assert.deepEqual(classifier.outcome('pending')?.failure, {
    class: 'provider_error',
    message: 'Insufficient credits',
  });
});

test('a tool denial is not a terminal event', () => {
  const classifier = new TurnOutcomeClassifier('turn');
  acceptStoredTurn(classifier, [denied], 'turn');
  assert.equal(classifier.outcome('pending'), undefined);
});
