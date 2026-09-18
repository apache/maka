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
import { armLiveTurn, applyLiveTurnBufferEvent, reconcileLiveTurnBuffer } from '@maka/ui';
import type { StoredMessage } from '@maka/core/session';
import { act, createElement } from 'react';
import { LiveTurnReconciler } from '../../renderer/features/conversation/index.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { normalizeSessionSummaryForDisplay } from '../../renderer/session-status-presentation.js';
import {
  clearAppShellSessionUiStateForSession,
  createAppShellSessionUiStateController,
  createInitialAppShellSessionUiState,
  type AppShellSessionUiState,
} from '../../renderer/app-shell-session-ui-state.js';
import {
  createTranscriptRestoreLifecycle,
  restoreSessionTranscriptRange,
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

it('reconciles late predecessor content after its durable answer is already loaded', async () => {
  const { root } = installReactRenderer();
  try {
    const controller = createAppShellSessionUiStateController();
    const b = { turnId: 'B', steps: [{ stepId: 'bash', tools: [{ toolUseId: 'bash', toolName: 'Bash', args: {}, status: 'running' as const }] }] };
    controller.setLiveTurnBySession(() => ({ session: [b] }));
    controller.setExecution('session', { type: 'host_execution', available: true,
      rootTurn: { sessionId: 'session', turnId: 'B', runId: 'run-B', status: 'running' } });
    const messages: StoredMessage[] = [
      { type: 'assistant', id: 'answer-A', turnId: 'A', ts: 1, text: 'Alpha completed full answer', modelId: 'test' },
      { type: 'turn_state', id: 'terminal-A', turnId: 'A', ts: 2, status: 'completed' },
    ];
    const reconcile = (_id: string, durable: readonly StoredMessage[]) => controller.setLiveTurnBySession((current) => {
      const next = reconcileLiveTurnBuffer(current.session!, durable);
      return next === current.session ? current : { ...current, session: next ?? [] };
    });
    await act(async () => { root.render(createElement(LiveTurnReconciler, { controller, activeId: 'session', messages, reconcile })); });
    await act(async () => {
      controller.setLiveTurnBySession((current) => ({ ...current, session: applyLiveTurnBufferEvent(current.session, {
        type: 'text_delta', id: 'late-A', turnId: 'A', messageId: 'answer-A', ts: 1, text: 'Alpha',
      }, 'en')! }));
    });
    assert.deepEqual(controller.getState().liveTurnBySession.session, [b], 'late A cannot shadow its full durable answer while B stays unchanged');
  } finally { cleanupFakeDom(); }
});

function healthSnapshot(sessionId: string): SessionEventStreamSnapshot {
  return { sessionId, status: 'connected', subscribedAt: 1, checkedAt: 1 };
}

function seededState(): AppShellSessionUiState {
  return {
    ...createInitialAppShellSessionUiState(),
    messageLoadErrorBySession: { drop: 'failed', keep: 'still failed' },
    messageRetryPendingBySession: { drop: true, keep: true },
    stopPendingBySession: { drop: true, keep: true },
    liveTurnBySession: { drop: [armLiveTurn('turn-drop')], keep: [armLiveTurn('turn-keep')] },
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

    controller.setTranscriptReadingAnchor('drop', { turnId: 'turn-drop' });
    controller.setTranscriptReadingAnchor('keep', { turnId: 'turn-keep' });

    assert.deepEqual(controller.transcriptReadingAnchorBySessionRef.current, {
      drop: { turnId: 'turn-drop' },
      keep: { turnId: 'turn-keep' },
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

  it('does not restore a reading anchor from another Session range', () => {
    let anchor: { turnId: string } | undefined = { turnId: 'turn' };
    restoreSessionTranscriptRange({
      lifecycle: createTranscriptRestoreLifecycle(),
      sessionId: 'active',
      readingAnchor: { turnId: 'turn' },
      controller: {
        store: {
          range: () => ({ sessionId: 'stale', hasOlder: false, ready: true }),
          snapshot: () => ({ messages: [] }),
        },
        loadEarlier: async () => assert.fail('a stale range must not load'),
      },
      isCurrent: () => true,
      setReadingAnchor: (_sessionId, next) => {
        anchor = next;
      },
      onRestoreUnavailable: () => assert.fail('a stale range cannot declare the anchor unavailable'),
      onError: (error) => assert.fail(String(error)),
    });

    assert.deepEqual(anchor, { turnId: 'turn' });
  });

  it('abandons a restore that remains absent once no earlier history is left', async () => {
    let anchor: { turnId: string } | undefined = { turnId: 'missing' };
    let unavailable: { sessionId: string; turnId: string } | undefined;
    restoreSessionTranscriptRange({
      lifecycle: createTranscriptRestoreLifecycle(),
      sessionId: 'session',
      readingAnchor: { turnId: 'missing' },
      controller: {
        store: {
          range: () => ({ sessionId: 'session', hasOlder: false, ready: true }),
          snapshot: () => ({ messages: [{ turnId: 'latest' }] }),
        },
        loadEarlier: async () => assert.fail('all history is already loaded'),
      },
      isCurrent: () => true,
      setReadingAnchor: (_sessionId, next) => {
        anchor = next;
      },
      onRestoreUnavailable: (sessionId, turnId) => {
        unavailable = { sessionId, turnId };
      },
      onError: (error) => assert.fail(String(error)),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(anchor, undefined);
    assert.deepEqual(unavailable, { sessionId: 'session', turnId: 'missing' });
  });

  it('keeps the synchronous live-turn ref aligned with reducer updates', () => {
    const controller = createAppShellSessionUiStateController();
    const projection = [armLiveTurn('turn-1')];
    controller.setLiveTurnBySession((current) => ({ ...current, session: projection }));
    assert.equal(controller.liveTurnBySessionRef.current.session, projection);
  });
});
