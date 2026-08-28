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
import test from 'node:test';
import type { SessionSendProjection } from '@maka/core/session-send-projection';
import { deriveSessionHealthNotice } from '../../renderer/session-health-notice.js';

const legacySession = {
  backend: 'ai-sdk',
  llmConnectionSlug: 'openrouter',
  model: 'openai/gpt-5',
  connectionLocked: false,
};

function blocked(
  reason: Extract<SessionSendProjection, { kind: 'blocked' }>['reason'],
  hasModelChoices: boolean,
  modelChoicesSettled = true,
) {
  return deriveSessionHealthNotice({
    locale: 'en',
    session: legacySession,
    outcome: { kind: 'blocked', reason, connectionLocked: false },
    connections: [],
    hasModelChoices,
    modelChoicesSettled,
    modelPickerDisabled: false,
    lastTestStatus: undefined,
  });
}

test('legacy connection recovery opens the existing model picker when choices exist', () => {
  const notice = blocked('legacy_connection_identity', true);
  assert.equal(notice?.onClickTarget, 'model_picker');
  assert.equal(notice?.label, 'Choose a model connection');
  assert.equal(notice?.actionLabel, 'Choose connection and model');
  assert.equal(
    notice?.tooltip,
    'This task comes from an older version. Choose the connection and model to use.',
  );
});

test('legacy connection recovery falls back to Models settings only when no choice exists', () => {
  const notice = blocked('legacy_connection_identity', false);
  assert.equal(notice?.onClickTarget, 'models');
  assert.equal(notice?.actionLabel, undefined);
  assert.equal(
    notice?.tooltip,
    'No connections are currently available. Add or enable one in Settings · Models first.',
  );
});

test('an unsettled connection snapshot offers a reload instead of an empty picker', () => {
  const notice = blocked('legacy_connection_identity', false, false);
  assert.equal(notice?.onClickTarget, 'model_choices_refresh');
  assert.equal(notice?.actionLabel, 'Reload connections');
  assert.equal(notice?.tooltip, 'The connection list has not loaded yet.');
});

test('a live turn disables connection selection until model switching is safe', () => {
  const notice = deriveSessionHealthNotice({
    locale: 'en',
    session: legacySession,
    outcome: { kind: 'blocked', reason: 'legacy_connection_identity', connectionLocked: false },
    connections: [],
    hasModelChoices: true,
    modelChoicesSettled: true,
    modelPickerDisabled: true,
    lastTestStatus: undefined,
  });
  assert.equal(notice?.onClickTarget, 'model_picker');
  assert.equal(notice?.actionDisabled, true);
});

test('credential repair remains owned by Models settings', () => {
  assert.equal(blocked('missing_api_key', true)?.onClickTarget, 'models');
});
