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
import { describe, it } from 'node:test';
import type { SandboxBoundaryRequestEvent } from '@maka/core/events';
import type { SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import type { SessionSummary } from '@maka/core/session';
import { armLiveTurn, confirmLiveTurn } from '@maka/ui';
import { settledSessionTransientIds } from '../../renderer/settled-session-transients.js';
import { normalizeSessionSummaryForDisplay } from '../../renderer/session-status-presentation.js';
import {
  clearAppShellSessionUiStateForSession,
  createAppShellSessionUiStateController,
  createInitialAppShellSessionUiState,
  type AppShellSessionUiState,
} from '../../renderer/app-shell-session-ui-state.js';
import {
  createTranscriptRestoreLifecycle,
  loadTranscriptHistory,
  refreshTranscriptTurnLandmarks,
  restoreSessionTranscriptRange,
  type TranscriptHistoryGates,
  type TranscriptHistoryPending,
} from '../../renderer/features/conversation/testing.js';

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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function deferredHistoryController() {
  const before = deferred();
  const after = deferred();
  const latest = deferred();
  const calls: string[] = [];
  return {
    controller: {
      loadBefore: () => {
        calls.push('before');
        return before.promise;
      },
      loadAfter: (maxBytes: number, anchorTurnId?: string) => {
        calls.push(`after:${maxBytes}:${anchorTurnId}`);
        return after.promise;
      },
      loadLatest: () => {
        calls.push('latest');
        return latest.promise;
      },
    },
    calls,
    settleBefore: before.resolve,
    settleAfter: after.resolve,
    settleLatest: latest.resolve,
    failBefore: before.reject,
  };
}

function crossSessionGateScenario() {
  type HistoryRequest = Parameters<typeof loadTranscriptHistory>[0]['request'];
  const gates: TranscriptHistoryGates = new WeakMap();
  const sessionIds = { a: 'session', b: 'session:a' } as const;
  const sides = {
    a: deferredHistoryController(),
    b: deferredHistoryController(),
  };
  let active: 'a' | 'b' = 'a';
  let range: object = sides.a.controller;
  let currentPending: TranscriptHistoryPending | undefined;
  const pending = {
    a: [] as Array<Pick<HistoryRequest, 'target'> | undefined>,
    b: [] as Array<Pick<HistoryRequest, 'target'> | undefined>,
  };
  const errors = { a: [] as unknown[], b: [] as unknown[] };
  return {
    sides,
    pending,
    errors,
    currentPending: () => currentPending,
    switchTo(id: 'a' | 'b') {
      active = id;
      range = sides[id].controller;
    },
    load(
      id: 'a' | 'b',
      request: { target: 'earlier' | 'later' | 'latest'; anchorTurnId?: string },
    ) {
      const side = sides[id];
      return loadTranscriptHistory({
        gates,
        sessionId: sessionIds[id],
        request,
        controller: side.controller,
        maxBytes: 4096,
        isCurrent: () => active === id && range === side.controller,
        setPending: (update) => {
          currentPending = update(currentPending);
          pending[id].push(currentPending?.sessionId === sessionIds[id]
            ? { target: currentPending.target }
            : undefined);
        },
        onError: (error) => errors[id].push(error),
      });
    },
  };
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
    transcriptRestoreUnavailableBySession: { drop: 'turn-drop', keep: 'turn-keep' },
  };
}

describe('session live run display state', () => {
  it('keeps persisted running as a fallback only while live state is unknown', () => {
    const unknown = { id: 'unknown', status: 'running' } as SessionSummary;
    const knownEmpty = {
      id: 'known-empty',
      status: 'running',
      runningTurnIds: [],
    } as unknown as SessionSummary;

    assert.equal(normalizeSessionSummaryForDisplay(unknown).status, 'running');
    assert.equal(normalizeSessionSummaryForDisplay(knownEmpty).status, 'active');
  });

});

describe('app shell session UI state controller', () => {
  it('does not mirror session-setting writes into UI pending state', () => {
    const state = createInitialAppShellSessionUiState();
    assert.equal('pendingPermissionModeBySession' in state, false);
    assert.equal('pendingSessionModelBySession' in state, false);
  });

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
      { id: 'ended', status: 'running', runningTurnIds: [] as string[] },
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
    assert.deepEqual(Object.keys(next.transcriptRestoreUnavailableBySession), ['keep']);
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

  it('owns per-session transcript reading anchors without notifying render subscribers', () => {
    let notifications = 0;
    const controller = createAppShellSessionUiStateController();
    controller.subscribe(() => {
      notifications += 1;
    });

    controller.setTranscriptReadingAnchor('drop', { turnId: 'turn-drop', sequence: 7 });
    controller.setTranscriptReadingAnchor('keep', { turnId: 'turn-keep', sequence: 11 });
    controller.setTranscriptReadingAnchor('drop', { turnId: 'turn-drop' });

    assert.deepEqual(controller.transcriptReadingAnchorBySessionRef.current, {
      drop: { turnId: 'turn-drop', sequence: 7 },
      keep: { turnId: 'turn-keep', sequence: 11 },
    });
    assert.equal(notifications, 0, 'reading anchors have no live render subscriber');

    controller.setTranscriptReadingAnchor('keep', undefined);
    controller.clearSessionUiState('drop');

    assert.deepEqual(controller.transcriptReadingAnchorBySessionRef.current, {});
    assert.equal(notifications, 0);
  });

  it('publishes unavailable transcript restores only until they are consumed', () => {
    let notifications = 0;
    const controller = createAppShellSessionUiStateController();
    controller.subscribe(() => {
      notifications += 1;
    });

    controller.setTranscriptRestoreUnavailable('session', 'turn-missing');

    assert.deepEqual(controller.getState().transcriptRestoreUnavailableBySession, {
      session: 'turn-missing',
    });
    assert.equal(notifications, 1);

    controller.setTranscriptRestoreUnavailable('session', undefined);

    assert.deepEqual(controller.getState().transcriptRestoreUnavailableBySession, {});
    assert.equal(notifications, 2);
  });

  it('clears Owner landmarks and ignores their late response when the active Session becomes a Guest', async () => {
    let resolveOwner!: (value: { throughSequence: number; landmarks: string[] }) => void;
    let index: { sessionId: string; throughSequence: number | null; turns: readonly string[] } | undefined = {
      sessionId: 'owner-session', throughSequence: 0, turns: ['previous-owner-turn'],
    };
    const dispose = refreshTranscriptTurnLandmarks({
      sessionId: 'owner-session',
      newestDurablePromptSequence: 1,
      list: () => new Promise<{ throughSequence: number; landmarks: string[] }>((resolve) => {
        resolveOwner = resolve;
      }),
      isCurrent: () => true,
      setIndex: (value) => { index = value; },
    });
    // The shell cleans up the Owner effect and passes no ownerActiveId for Guests.
    dispose?.();
    refreshTranscriptTurnLandmarks<string>({
      sessionId: undefined,
      newestDurablePromptSequence: 1,
      list: async () => assert.fail('Guests cannot query Owner turn landmarks'),
      isCurrent: () => true,
      setIndex: (value) => { index = value; },
    });
    resolveOwner({ throughSequence: 1, landmarks: ['owner-turn'] });
    await Promise.resolve();
    assert.equal(index, undefined);
  });

  it('enriches a Turn-only reading anchor when its range sequence arrives later', async () => {
    let anchor: { turnId: string; sequence?: number } | undefined;
    const admitted: Array<number | null> = [];
    restoreSessionTranscriptRange({
      lifecycle: createTranscriptRestoreLifecycle(),
      sessionId: 'session',
      readingAnchor: { turnId: 'turn' },
      controller: {
        store: {
          sessionId: 'session',
          range: () => ({ sessionId: 'session' }),
          sequenceForTurn: () => 17,
          newestDurableUserSequence: () => 17,
          snapshot: () => ({ messages: [] }),
        },
        setReadingAnchor: async (sequence) => { admitted.push(sequence); },
        loadAround: async () => assert.fail('the resident Turn must not load another range'),
      },
      isCurrent: () => true,
      setReadingAnchor: (_sessionId, next) => {
        anchor = next;
      },
      onError: (error) => assert.fail(String(error)),
    });

    assert.deepEqual(anchor, { turnId: 'turn', sequence: 17 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(admitted, [17]);
  });

  it('does not enrich a reading anchor from another Session range', () => {
    let sequenceReads = 0;
    let anchor: { turnId: string; sequence?: number } | undefined;
    restoreSessionTranscriptRange({
      lifecycle: createTranscriptRestoreLifecycle(),
      sessionId: 'active',
      readingAnchor: { turnId: 'turn' },
      controller: {
        store: {
          sessionId: 'stale',
          range: () => ({ sessionId: 'stale' }),
          sequenceForTurn: () => {
            sequenceReads += 1;
            return 17;
          },
          newestDurableUserSequence: () => 17,
          snapshot: () => ({ messages: [] }),
        },
        setReadingAnchor: async () => {},
        loadAround: async () => assert.fail('a stale range must not load'),
      },
      isCurrent: () => true,
      setReadingAnchor: (_sessionId, next) => {
        anchor = next;
      },
      onError: (error) => assert.fail(String(error)),
    });

    assert.equal(sequenceReads, 0);
    assert.equal(anchor, undefined);
  });

  it('abandons a Turn-only restore that remains absent after the range is ready', async () => {
    let anchor: { turnId: string; sequence?: number } | undefined = { turnId: 'missing' };
    let unavailable: { sessionId: string; turnId: string } | undefined;
    const options = {
      lifecycle: createTranscriptRestoreLifecycle(),
      sessionId: 'session',
      readingAnchor: { turnId: 'missing' },
      controller: {
        store: {
          sessionId: 'session',
          range: () => ({ sessionId: 'session' }),
          sequenceForTurn: () => null,
          newestDurableUserSequence: () => null,
          snapshot: () => ({ messages: [] }),
        },
        setReadingAnchor: async () => {},
        loadAround: async () => assert.fail('a Turn-only anchor has no load target'),
      },
      isCurrent: () => true,
      setReadingAnchor: (_sessionId: string, next: { turnId: string; sequence?: number } | undefined) => {
        anchor = next;
      },
      onRestoreUnavailable: (sessionId: string, turnId: string) => {
        unavailable = { sessionId, turnId };
      },
      onError: (error: unknown) => assert.fail(String(error)),
    };

    restoreSessionTranscriptRange(options);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(anchor, undefined);
    assert.deepEqual(unavailable, { sessionId: 'session', turnId: 'missing' });
  });

  it('abandons a known-sequence restore when loadAround cannot make the Turn resident', async () => {
    let loadedSequence: number | undefined;
    let unavailable: { sessionId: string; turnId: string } | undefined;
    let anchor: { turnId: string; sequence?: number } | undefined = { turnId: 'removed', sequence: 23 };
    const options = {
      lifecycle: createTranscriptRestoreLifecycle(),
      sessionId: 'session',
      readingAnchor: { turnId: 'removed', sequence: 23 },
      controller: {
        store: {
          sessionId: 'session',
          range: () => ({ sessionId: 'session' }),
          sequenceForTurn: () => null,
          newestDurableUserSequence: () => 29,
          snapshot: () => ({ messages: [{ id: 'latest' }] }),
        },
        setReadingAnchor: async () => assert.fail('a missing durable Turn must load its range'),
        loadAround: async (sequence: number) => {
          loadedSequence = sequence;
        },
      },
      isCurrent: () => true,
      setReadingAnchor: (_sessionId: string, next: { turnId: string; sequence?: number } | undefined) => {
        anchor = next;
      },
      onRestoreUnavailable: (sessionId: string, turnId: string) => {
        unavailable = { sessionId, turnId };
      },
      onError: (error: unknown) => assert.fail(String(error)),
    };

    restoreSessionTranscriptRange(options);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(loadedSequence, 23);
    assert.equal(anchor, undefined);
    assert.deepEqual(unavailable, { sessionId: 'session', turnId: 'removed' });
  });

  it('starts another Session history load without waiting behind an in-flight load elsewhere', async () => {
    const scenario = crossSessionGateScenario();
    const stale = scenario.load('a', { target: 'earlier' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(scenario.sides.a.calls, ['before']);
    assert.deepEqual(scenario.pending.a, [{ target: 'earlier' }]);

    scenario.switchTo('b');
    const navigation = scenario.load('b', { target: 'latest' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(scenario.sides.b.calls, ['latest']);
    assert.deepEqual(scenario.pending.b, [{ target: 'latest' }]);

    scenario.sides.a.settleBefore();
    await stale;
    assert.deepEqual(scenario.currentPending(), { sessionId: 'session:a', target: 'latest' });
    scenario.sides.b.settleLatest();
    await navigation;
  });

  it('leaves the switched-to Session untouched when a stale Session load settles late', async () => {
    const scenario = crossSessionGateScenario();
    const stale = scenario.load('a', { target: 'earlier' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    scenario.switchTo('b');
    const navigation = scenario.load('b', { target: 'latest' });
    scenario.sides.b.settleLatest();
    await navigation;
    assert.deepEqual(scenario.pending.b, [{ target: 'latest' }, undefined]);
    assert.deepEqual(scenario.sides.b.calls, ['latest']);

    scenario.sides.a.settleBefore();
    await stale;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(scenario.pending.b, [{ target: 'latest' }, undefined]);
    assert.deepEqual(scenario.sides.b.calls, ['latest']);
    assert.deepEqual(scenario.errors.b, []);
  });

  it('reports a late history load failure to its own Session alone', async () => {
    const scenario = crossSessionGateScenario();
    const stale = scenario.load('a', { target: 'earlier' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    scenario.switchTo('b');
    scenario.sides.a.failBefore(new Error('earlier read failed'));
    await stale;
    assert.deepEqual(scenario.errors.a, []);
    assert.deepEqual(scenario.pending.a, [{ target: 'earlier' }]);
    assert.deepEqual(scenario.pending.b, []);
  });

  it('replays the queued latest load once after an in-flight load settles on the same Session', async () => {
    const scenario = crossSessionGateScenario();
    const inFlight = scenario.load('a', { target: 'earlier' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const queuedEarlier = scenario.load('a', { target: 'earlier', anchorTurnId: 'turn-anchor' });
    const queuedLatest = scenario.load('a', { target: 'latest' });
    assert.deepEqual(scenario.sides.a.calls, ['before']);

    scenario.sides.a.settleBefore();
    await inFlight;
    assert.deepEqual(scenario.sides.a.calls, ['before', 'latest']);
    scenario.sides.a.settleLatest();
    await Promise.allSettled([queuedEarlier, queuedLatest]);
    assert.deepEqual(scenario.pending.a, [
      { target: 'earlier' },
      undefined,
      { target: 'latest' },
      undefined,
    ]);
  });

  it('replays a queued forward load with its reading anchor after a backward load settles', async () => {
    const scenario = crossSessionGateScenario();
    const inFlight = scenario.load('a', { target: 'earlier' });
    const queued = scenario.load('a', { target: 'later', anchorTurnId: 'turn-anchor' });
    assert.deepEqual(scenario.sides.a.calls, ['before']);

    scenario.sides.a.settleBefore();
    await inFlight;
    assert.deepEqual(scenario.sides.a.calls, ['before', 'after:4096:turn-anchor']);
    scenario.sides.a.settleAfter();
    await queued;
    assert.deepEqual(scenario.pending.a, [
      { target: 'earlier' },
      undefined,
      { target: 'later' },
      undefined,
    ]);
  });

  it('keeps the queued latest load when adjacent requests arrive after it', async () => {
    const scenario = crossSessionGateScenario();
    const inFlight = scenario.load('a', { target: 'earlier' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const queuedLatest = scenario.load('a', { target: 'latest' });
    const queuedEarlier = scenario.load('a', { target: 'earlier', anchorTurnId: 'turn-anchor' });
    const queuedLater = scenario.load('a', { target: 'later', anchorTurnId: 'turn-anchor' });
    assert.deepEqual(scenario.sides.a.calls, ['before']);

    scenario.sides.a.settleBefore();
    await inFlight;
    assert.deepEqual(scenario.sides.a.calls, ['before', 'latest']);
    scenario.sides.a.settleLatest();
    await Promise.allSettled([queuedLatest, queuedEarlier, queuedLater]);
    assert.deepEqual(scenario.pending.a, [
      { target: 'earlier' },
      undefined,
      { target: 'latest' },
      undefined,
    ]);
  });

  it('does not replay a settled load after its Session range was replaced', async () => {
    const scenario = crossSessionGateScenario();
    const inFlight = scenario.load('a', { target: 'earlier' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const queued = scenario.load('a', { target: 'latest' });
    scenario.switchTo('b');
    scenario.sides.a.settleBefore();
    await inFlight;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(scenario.sides.a.calls, ['before']);
    assert.deepEqual(scenario.sides.b.calls, []);
    assert.deepEqual(scenario.pending.a, [{ target: 'earlier' }]);
    scenario.sides.a.settleLatest();
    await queued;
  });

  it('replays a queued load through its own Session callbacks', async () => {
    const scenario = crossSessionGateScenario();
    const inFlight = scenario.load('a', { target: 'earlier' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const queued = scenario.load('a', { target: 'latest' });
    scenario.sides.a.settleBefore();
    await inFlight;
    assert.deepEqual(scenario.sides.a.calls, ['before', 'latest']);
    scenario.sides.a.settleLatest();
    await queued;
    assert.deepEqual(scenario.pending.a, [
      { target: 'earlier' },
      undefined,
      { target: 'latest' },
      undefined,
    ]);
    assert.deepEqual(scenario.pending.b, []);
    assert.deepEqual(scenario.sides.b.calls, []);
  });

  it('keeps the synchronous live-turn ref aligned with reducer updates', () => {
    const controller = createAppShellSessionUiStateController();
    const projection = armLiveTurn('turn-1');
    controller.setLiveTurnBySession((current) => ({ ...current, session: projection }));
    assert.equal(controller.liveTurnBySessionRef.current.session, projection);
  });
});
