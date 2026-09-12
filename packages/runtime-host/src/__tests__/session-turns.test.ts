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
import { MODEL_FAILURE_MESSAGE_MAX_BYTES } from '@maka/core/model-failure';
import test from 'node:test';
import {
  decodeSessionTurnsQueryResult,
  decodeSessionTurnLandmarksQueryResult,
  projectSessionTurnLandmarkForWire,
  projectSessionTurnContribution,
  projectSessionTurnContributionForWire,
  SESSION_TURN_DIAGNOSTIC_MAX_BYTES,
  SESSION_TURN_LANDMARK_RESULT_MAX_BYTES,
} from '../protocol/session-turns.js';

test('keeps a full sampled landmark index inside its encoded result budget', () => {
  const result = {
    sessionId: 'session-1',
    throughSequence: 1_000,
    landmarks: Array.from({ length: 64 }, (_, index) =>
      projectSessionTurnLandmarkForWire({
        turnId: `${index}`.padEnd(128, 't'),
        sequence: Number.MAX_SAFE_INTEGER - index,
        label: '\0'.repeat(256),
      }),
    ),
  };

  assert.ok(
    Buffer.byteLength(JSON.stringify(result), 'utf8') <= SESSION_TURN_LANDMARK_RESULT_MAX_BYTES,
  );
  assert.doesNotThrow(() => decodeSessionTurnLandmarksQueryResult(result));
});

test('publishes no Turn until its recorded state is on the page', () => {
  assert.strictEqual(
    projectSessionTurnContribution({
      turnId: 'turn-1',
      firstSequence: 0,
      latestState: null,
      userPromptPreview: 'hello',
    }),
    undefined,
  );
});

test('takes the published Turn from the recorded turn state', () => {
  assert.deepEqual(
    projectSessionTurnContribution({
      turnId: 'turn-1',
      firstSequence: 0,
      latestState: {
        sequence: 4,
        message: {
          type: 'turn_state',
          id: 'state-1',
          turnId: 'turn-1',
          ts: 1,
          status: 'failed',
        },
      },
      userPromptPreview: 'hello',
    }),
    {
      turnId: 'turn-1',
      firstSequence: 0,
      userPromptPreview: 'hello',
      status: 'failed',
      statusSource: 'recorded',
    },
  );
});

test('bounds turn diagnostics before publishing a contribution', () => {
  const contribution = projectSessionTurnContributionForWire({
    turnId: 'turn-1',
    firstSequence: 0,
    latestState: {
      sequence: 0,
      message: {
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: 1,
        status: 'failed',
        errorClass: '失败'.repeat(100_000),
        failureMessage: '失败'.repeat(100_000),
        retry: { decision: 'declined', because: 'side_effects' },
      },
    },
    userPromptPreview: 'hello',
  });

  assert.ok(
    Buffer.byteLength(contribution.latestState!.message.errorClass!, 'utf8') <=
      SESSION_TURN_DIAGNOSTIC_MAX_BYTES,
  );
  assert.doesNotThrow(() =>
    decodeSessionTurnsQueryResult({
      sessionId: 'session-1',
      throughSequence: 0,
      contributions: [contribution],
      nextPosition: null,
    }),
  );
  const turn = projectSessionTurnContribution(contribution);
  assert.ok(turn);
  assert.ok(turn.failureMessage);
  assert.ok(Buffer.byteLength(turn.failureMessage) <= MODEL_FAILURE_MESSAGE_MAX_BYTES);
  assert.equal(turn.failureMessage, contribution.latestState!.message.failureMessage);
  assert.deepEqual(turn.retry, { decision: 'declined', because: 'side_effects' });
});

test('rejects invalid turn-state references before publishing a contribution', () => {
  assert.throws(() =>
    projectSessionTurnContributionForWire({
      turnId: 'turn-1',
      firstSequence: 0,
      latestState: {
        sequence: 0,
        message: {
          type: 'turn_state',
          id: 'state-1',
          turnId: 'turn-1',
          ts: 1,
          status: 'completed',
          parentTurnId: 'x'.repeat(129),
        },
      },
      userPromptPreview: null,
    }),
  );
});
