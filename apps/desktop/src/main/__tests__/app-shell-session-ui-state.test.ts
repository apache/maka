import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SandboxBoundaryRequestEvent } from '@maka/core/events';
import type { SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import type { SessionSummary } from '@maka/core/session';
import { armLiveTurn, confirmLiveTurn } from '@maka/ui';
import { settledSessionTransientIds } from '../../renderer/settled-session-transients.js';
import {
  clearAppShellSessionUiStateForSession,
  createAppShellSessionUiStateController,
  createInitialAppShellSessionUiState,
  type AppShellSessionUiState,
} from '../../renderer/app-shell-session-ui-state.js';

function boundaryRequest(requestId: string): SandboxBoundaryRequestEvent {
  return {
    type: 'sandbox_boundary_request',
    id: `event-${requestId}`,
    turnId: 'turn-1',
    ts: 1,
    requestId,
    toolUseId: `tool-${requestId}`,
    justification: 'Read an external file.',
    expansion: {
      filesystem: {
        entries: [{ path: '/outside/file', access: 'read', scope: 'exact' }],
      },
    },
  };
}

function healthSnapshot(sessionId: string): SessionEventStreamSnapshot {
  return { sessionId, status: 'connected', subscribedAt: 1, checkedAt: 1 };
}

/** An arm the authority has already answered about — what every projection
 *  looks like once its turn has produced a single event. */
function answeredArm(turnId: string) {
  return confirmLiveTurn(armLiveTurn(turnId), turnId)!;
}

function seededState(): AppShellSessionUiState {
  return {
    ...createInitialAppShellSessionUiState(),
    messageLoadErrorBySession: { drop: 'failed', keep: 'still failed' },
    messageRetryPendingBySession: { drop: true, keep: true },
    stopPendingBySession: { drop: true, keep: true },
    liveTurnBySession: { drop: armLiveTurn('turn-drop'), keep: armLiveTurn('turn-keep') },
    interactionBySession: {
      drop: [boundaryRequest('drop')],
      keep: [boundaryRequest('keep')],
    },
    pendingPermissionModeBySession: { drop: true, keep: true },
    pendingSessionModelBySession: { drop: true, keep: true },
  };
}

describe('app shell session UI state controller', () => {
  it('selects background terminal sessions without cutting off the active handoff', () => {
    const sessions = [
      { id: 'running', status: 'running' },
      { id: 'background', status: 'active' },
      { id: 'active', status: 'active' },
    ] as SessionSummary[];
    const background = { ...answeredArm('turn-background'), terminal: true as const };
    const active = { ...answeredArm('turn-active'), terminal: true as const };

    assert.deepEqual(settledSessionTransientIds({
      activeId: 'active',
      sessions,
      liveTurnBySession: { background, active },
    }), ['background']);
  });

  // The runtime writes `status: 'running'` only at the end of `AgentRun.begin`,
  // so a list refreshed between the send and that write reports the pre-send
  // status — which is the same status a FINISHED turn leaves behind. Retiring
  // the arm on it is what made the first-token wait disappear until the first
  // content event rebuilt the projection as 'streamed'.
  it('keeps an armed turn while its send is still awaiting the authority', () => {
    const sessions = [{ id: 'sending', status: 'active' }] as SessionSummary[];

    assert.deepEqual(settledSessionTransientIds({
      activeId: 'sending',
      sessions,
      liveTurnBySession: { sending: armLiveTurn('turn-1') },
    }), []);
  });

  // The same pre-send status also has to stop protecting the arm once the send
  // has been answered, or a turn that ended while its stream wasn't followed
  // would leave the Stop affordance up forever.
  it('settles an armed turn once the authority has answered its send', () => {
    const sessions = [{ id: 'sending', status: 'active' }] as SessionSummary[];

    assert.deepEqual(settledSessionTransientIds({
      activeId: 'sending',
      sessions,
      liveTurnBySession: { sending: answeredArm('turn-1') },
    }), ['sending']);
  });

  // The live runs outrank the persisted status in BOTH directions. A status
  // that has not caught up yet, or one a crash left behind, must not decide
  // this while the runtime still reports the turn as running.
  it('keeps transients while the runtime still reports a running turn', () => {
    const sessions = [
      { id: 'running', status: 'active', runningTurnIds: ['turn-live'] },
    ] as SessionSummary[];

    assert.deepEqual(settledSessionTransientIds({
      activeId: 'running',
      sessions,
      liveTurnBySession: { running: answeredArm('turn-live') },
    }), []);
  });

  it('settles once the runtime reports no running turn, whatever the status says', () => {
    const sessions = [
      { id: 'ended', status: 'active', runningTurnIds: [] as string[] },
    ] as SessionSummary[];

    assert.deepEqual(settledSessionTransientIds({
      activeId: 'other',
      sessions,
      liveTurnBySession: { ended: answeredArm('turn-over') },
    }), ['ended']);
  });

  // A backgrounded session's arm is protected by the same bit — the guard must
  // not be an active-session special case, since a send can be backgrounded the
  // instant it is made.
  it('protects an unconfirmed arm in a backgrounded session too', () => {
    const sessions = [{ id: 'background', status: 'active' }] as SessionSummary[];

    assert.deepEqual(settledSessionTransientIds({
      activeId: 'other',
      sessions,
      liveTurnBySession: { background: armLiveTurn('turn-1') },
    }), []);
  });

  it('clears one session from every per-session UI map without touching other sessions', () => {
    const next = clearAppShellSessionUiStateForSession(seededState(), 'drop');

    assert.deepEqual(Object.keys(next.messageLoadErrorBySession), ['keep']);
    assert.deepEqual(Object.keys(next.messageRetryPendingBySession), ['keep']);
    assert.deepEqual(Object.keys(next.stopPendingBySession), ['keep']);
    assert.deepEqual(Object.keys(next.liveTurnBySession), ['keep']);
    assert.deepEqual(Object.keys(next.interactionBySession), ['keep']);
    assert.deepEqual(Object.keys(next.pendingPermissionModeBySession), ['keep']);
    assert.deepEqual(Object.keys(next.pendingSessionModelBySession), ['keep']);
  });

  it('keeps state identity for no-op map updates and only replaces the selected map', () => {
    const controller = createAppShellSessionUiStateController();
    const state = controller.getState();
    controller.setMessageLoadErrorBySession((current) => current);
    assert.equal(controller.getState(), state);

    controller.setMessageLoadErrorBySession((current) => ({ ...current, session: 'failed' }));
    const next = controller.getState();

    assert.notEqual(next, state);
    assert.deepEqual(next.messageLoadErrorBySession, { session: 'failed' });
    assert.equal(next.stopPendingBySession, state.stopPendingBySession);
    assert.equal(next.liveTurnBySession, state.liveTurnBySession);
  });

  it('records event-stream health without notifying render subscribers', () => {
    let notifications = 0;
    const controller = createAppShellSessionUiStateController();
    controller.subscribe(() => {
      notifications += 1;
    });
    const snapshot = healthSnapshot('session');

    controller.setSessionEventHealthBySession((current) => ({ ...current, session: snapshot }));

    assert.equal(controller.sessionEventHealthBySessionRef.current.session, snapshot);
    assert.equal(notifications, 0, 'stream health has no render consumer, so it must not force one');

    controller.setMessageLoadErrorBySession((current) => ({ ...current, session: 'failed' }));

    assert.equal(notifications, 1, 'maps that are rendered still notify');
  });

  it('drops event-stream health along with the rest of a cleared session', () => {
    const controller = createAppShellSessionUiStateController();
    controller.setSessionEventHealthBySession(() => ({
      drop: healthSnapshot('drop'),
      keep: healthSnapshot('keep'),
    }));

    controller.clearSessionUiState('drop');

    assert.deepEqual(Object.keys(controller.sessionEventHealthBySessionRef.current), ['keep']);
  });

  it('drops every Host-scoped session projection when the target changes', () => {
    const controller = createAppShellSessionUiStateController(seededState());
    controller.setSessionEventHealthBySession(() => ({
      drop: healthSnapshot('drop'),
      keep: healthSnapshot('keep'),
    }));

    controller.clearAllSessionUiState();

    assert.deepEqual(controller.getState(), createInitialAppShellSessionUiState());
    assert.deepEqual(controller.sessionEventHealthBySessionRef.current, {});
    assert.deepEqual(controller.liveTurnBySessionRef.current, {});
  });

  it('keeps the synchronous live-turn ref aligned with reducer updates', () => {
    const controller = createAppShellSessionUiStateController();
    const projection = armLiveTurn('turn-1');
    controller.setLiveTurnBySession((current) => ({ ...current, session: projection }));
    assert.equal(controller.liveTurnBySessionRef.current.session, projection);
  });
});
