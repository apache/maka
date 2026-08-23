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
import type { SessionSummary } from '@maka/core/session';
import { armLiveTurn } from '@maka/ui';
import { createAppShellSessionUiStateController } from '../../renderer/app-shell-session-ui-state.js';
import { reconcileSettledSessionTransients } from '../../renderer/settled-session-transients.js';

test('does not let a session snapshot retire a turn confirmed while its list request was in flight', () => {
  const sessionId = 'session-a';
  const turnId = 'turn-a';
  const controller = createAppShellSessionUiStateController();
  controller.setLiveTurnBySession(() => ({
    [sessionId]: armLiveTurn(turnId),
  }));
  const observedLiveTurnBySession = controller.liveTurnBySessionRef.current;

  controller.confirmLiveTurn(sessionId, turnId);
  reconcileSettledSessionTransients({
    activeId: sessionId,
    sessions: [settledSession(sessionId)],
    observedLiveTurnBySession,
    clearTurnTransientStateIfCurrent: controller.clearTurnTransientStateIfCurrent,
  });

  assert.equal(controller.getState().liveTurnBySession[sessionId]?.turnId, turnId);
  assert.equal(controller.getState().liveTurnBySession[sessionId]?.unconfirmed, undefined);
});

test('does not let an older session snapshot clear a replacement live turn', () => {
  const sessionId = 'session-a';
  const controller = createAppShellSessionUiStateController();
  controller.setLiveTurnBySession(() => ({
    [sessionId]: armLiveTurn('turn-a'),
  }));
  controller.confirmLiveTurn(sessionId, 'turn-a');
  const observedLiveTurnBySession = controller.liveTurnBySessionRef.current;

  controller.setLiveTurnBySession(() => ({
    [sessionId]: armLiveTurn('turn-b'),
  }));
  reconcileSettledSessionTransients({
    activeId: sessionId,
    sessions: [settledSession(sessionId)],
    observedLiveTurnBySession,
    clearTurnTransientStateIfCurrent: controller.clearTurnTransientStateIfCurrent,
  });

  assert.equal(controller.getState().liveTurnBySession[sessionId]?.turnId, 'turn-b');
});

test('clears a confirmed live turn when the accepted authority snapshot says it settled', () => {
  const sessionId = 'session-a';
  const controller = createAppShellSessionUiStateController();
  controller.setLiveTurnBySession(() => ({
    [sessionId]: armLiveTurn('turn-a'),
  }));
  controller.confirmLiveTurn(sessionId, 'turn-a');
  const observedLiveTurnBySession = controller.liveTurnBySessionRef.current;

  reconcileSettledSessionTransients({
    activeId: sessionId,
    sessions: [settledSession(sessionId)],
    observedLiveTurnBySession,
    clearTurnTransientStateIfCurrent: controller.clearTurnTransientStateIfCurrent,
  });

  assert.equal(controller.getState().liveTurnBySession[sessionId], undefined);
});

function settledSession(id: string): SessionSummary {
  return {
    id,
    name: 'Session A',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    runningTurnIds: [],
    backend: 'fake',
    llmConnectionSlug: 'fake',
    connectionLocked: true,
    model: 'fake-model',
    permissionMode: 'ask',
  };
}
