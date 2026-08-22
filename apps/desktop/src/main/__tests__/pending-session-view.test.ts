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
import { pendingSessionView } from '../../renderer/pending-session-view.js';

test('the pending chat view names no connection or model it cannot know', () => {
  const view = pendingSessionView({
    sessionId: 'session-1',
    name: '新任务',
    permissionMode: 'ask',
  });

  // #3211: the placeholder used to claim `backend: 'fake'` / `model:
  // 'fake-model'`, borrowing a retired backend to mean "not loaded".
  assert.equal(view.backend, 'ai-sdk');
  assert.equal(view.id, 'session-1');
  assert.equal(view.permissionMode, 'ask');
  assert.equal(view.connectionLocked, false);

  // The empty pair is load-bearing: this fallback covers any active id whose
  // summary has not arrived, so naming a plausible connection/model would let
  // the model switcher drop a real switch onto that model as a no-op against a
  // session that was never on it.
  assert.equal(view.llmConnectionSlug, '');
  assert.equal(view.model, '');
});

test('the pending chat view matches no offered model choice', () => {
  const view = pendingSessionView({
    sessionId: 'session-2',
    name: '新任务',
    permissionMode: 'execute',
  });
  const offered = [
    { connectionSlug: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    { connectionSlug: 'openai', model: 'gpt-5' },
  ];

  assert.equal(
    offered.some(
      (choice) =>
        choice.connectionSlug === view.llmConnectionSlug && choice.model === view.model,
    ),
    false,
  );
});
