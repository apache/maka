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
