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
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { isAssistantInputTurnId, isAssistantOutputTurnId } from '@maka/core/assistant-turn-ids';
import {
  assistantBatchOutputTurnId,
  assistantErrorOutputTurnId,
  assistantInputTurnId,
  assistantOutputTurnId,
  legacyAssistantInputTurnId,
} from '../assistant/bot/turn-ids.js';
import {
  PENDING_ACTIVATION_TURN_PREFIX,
  isPendingActivationTurnId,
} from '../assistant/proactive-matters/matter.js';
import { requireEntityId } from '../protocol/codec.js';

// Caller-supplied text the bot receives: external connector ids and model-chosen batch ids.
const CALLER_TEXT = [
  'om_123',
  'x:y',
  '["batch",0]',
  'spaces and 中文',
  'a'.repeat(200),
  'batch.with/slash',
];

describe('assistant background turn ids', () => {
  it('produces ids the Host admits for any caller-supplied text', () => {
    for (const raw of CALLER_TEXT) {
      assert.doesNotThrow(() => requireEntityId(assistantInputTurnId(raw), 'turnId'), raw);
      assert.doesNotThrow(() => requireEntityId(assistantOutputTurnId(raw), 'turnId'), raw);
      for (const index of [0, 1, 19]) {
        assert.doesNotThrow(
          () => requireEntityId(assistantBatchOutputTurnId(raw, index), 'turnId'),
          raw,
        );
      }
    }
  });

  it('is classified by the shared predicates the UI uses for every producer', () => {
    for (const raw of CALLER_TEXT) {
      assert.equal(isAssistantInputTurnId(assistantInputTurnId(raw)), true, raw);
      assert.equal(isAssistantOutputTurnId(assistantOutputTurnId(raw)), true, raw);
      assert.equal(isAssistantOutputTurnId(assistantBatchOutputTurnId(raw, 0)), true, raw);
    }
    assert.equal(isAssistantOutputTurnId(assistantErrorOutputTurnId(randomUUID())), true);
    // Legacy transcript ids stay recognized; ordinary turn ids are not classified as assistant.
    assert.equal(isAssistantInputTurnId(legacyAssistantInputTurnId('m1')), true);
    assert.equal(isAssistantInputTurnId('turn-1'), false);
    assert.equal(isAssistantOutputTurnId('turn-1'), false);
  });

  it('keeps a retried batch on the same turn id and separates messages within a batch', () => {
    assert.equal(
      assistantBatchOutputTurnId('batch-1', 0),
      assistantBatchOutputTurnId('batch-1', 0),
    );
    assert.notEqual(
      assistantBatchOutputTurnId('batch-1', 0),
      assistantBatchOutputTurnId('batch-1', 1),
    );
    assert.notEqual(assistantOutputTurnId('batch-1'), assistantOutputTurnId('batch-2'));
  });

  it('documents the legacy colon input form that the Host rejects as a turn id', () => {
    assert.throws(
      () => requireEntityId(legacyAssistantInputTurnId('m1'), 'turnId'),
      /Invalid turnId/,
    );
    assert.notEqual(legacyAssistantInputTurnId('m1'), assistantInputTurnId('m1'));
  });

  it('mints admissible pending activation ids and still recognizes legacy pending ids', () => {
    assert.equal(PENDING_ACTIVATION_TURN_PREFIX, 'pending-');
    assert.doesNotThrow(() =>
      requireEntityId(`${PENDING_ACTIVATION_TURN_PREFIX}${randomUUID()}`, 'turnId'),
    );
    assert.equal(isPendingActivationTurnId(`pending-${randomUUID()}`), true);
    assert.equal(isPendingActivationTurnId('pending:legacy-activation'), true);
    assert.equal(isPendingActivationTurnId('turn-1'), false);
    assert.equal(isPendingActivationTurnId(undefined), false);
    assert.equal(isPendingActivationTurnId(null), false);
  });
});
