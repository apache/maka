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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionChangedEvent, SessionSummary, StoredMessage } from '@maka/core/session';
import type { TransientUserMessageProjection } from '@maka/ui';
import { handleSessionChangedEvent } from '../../renderer/application/contracts/session-catalog/session-change-effects.js';
import { createSessionWorkspaceActions } from '../../renderer/session-workspace-actions.js';
import type { DesktopTranscriptRangeController } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';

function row(id: string): SessionSummary {
  return { id, name: id } as SessionSummary;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(activeId: string | undefined, catalog: SessionSummary[]) {
  const sessionsRef = { current: [...catalog] };
  const activeIdRef = { current: activeId };
  const requestedRef = { current: activeId };
  const retired: string[] = [];
  const workspace = createSessionWorkspaceActions({
    activeIdRef,
    readRequestedSessionId: () => requestedRef.current,
    isReadableSession: () => true,
    messagesRef: { current: [] as StoredMessage[] },
    transientMessagesBySessionRef: { current: new Map<string, Map<string, TransientUserMessageProjection>>() },
    transcriptRangeRef: { current: undefined as DesktopTranscriptRangeController | undefined },
    selectionRevisionRef: { current: 0 },
    setActiveIdState: (next) => {
      activeIdRef.current = next;
    },
    setMessagesState: () => {},
    setTransientMessagesState: () => {},
    setMessageLoadPending: () => {},
    clearSessionUiState: () => {},
  });
  const options = {
    uiLocale: 'en' as const,
    activeIdRef,
    sessionsRef,
    retireSession: (sessionId: string) => retired.push(sessionId),
    retiredSessionIds: workspace.retiredSessionIds,
    clearPendingTurnActionsForSession: () => {},
    refreshMessages: () => Promise.resolve(true),
    refreshProjects: () => Promise.resolve(),
    refreshSessions: () => Promise.resolve(sessionsRef.current as SessionSummary[]),
    // Mirrors the production drain: the committed catalog is updated before the
    // row read resolves, so a resolved promise means sessionsRef is current.
    refreshChangedSession: (sessionId: string) => {
      const next = catalog.find((session) => session.id === sessionId) ?? null;
      return Promise.resolve(next);
    },
    setSessionEventHealthBySession: () => {},
    notifyModelRebound: () => {},
    toastApi: {
      error: () => {},
      info: () => {},
      toast: () => {},
    },
  };
  return { options, retired, sessionsRef };
}

describe('session retirement sweep', () => {
  it('keeps the selected session when an unrelated row changes', async () => {
    const { options, retired } = harness('viewer', [row('viewer'), row('background')]);
    const event: SessionChangedEvent = {
      reason: 'message-appended',
      sessionId: 'background',
      ts: 1,
    };
    handleSessionChangedEvent(event, options);
    await flush();
    assert.deepEqual(retired, []);
  });

  it('retires the selected session when its row leaves the catalog', async () => {
    const { options, retired, sessionsRef } = harness('viewer', [row('viewer'), row('background')]);
    options.refreshChangedSession = () => {
      sessionsRef.current = [row('background')];
      return Promise.resolve(null);
    };
    handleSessionChangedEvent(
      { reason: 'deleted', sessionId: 'viewer', ts: 1 },
      options,
    );
    await flush();
    assert.deepEqual(retired, ['viewer']);
  });

  it('retires nothing when a row read fails and the catalog keeps the row', async () => {
    const { options, retired } = harness('viewer', [row('viewer'), row('background')]);
    options.refreshChangedSession = () => Promise.resolve(null);
    handleSessionChangedEvent(
      { reason: 'status-change', sessionId: 'background', ts: 1 },
      options,
    );
    await flush();
    assert.deepEqual(retired, []);
  });

  it('sweeps retired rows after a membership refresh', async () => {
    const { options, retired, sessionsRef } = harness('viewer', [row('viewer'), row('background')]);
    options.refreshSessions = () => {
      sessionsRef.current = [row('background')];
      return Promise.resolve(sessionsRef.current);
    };
    handleSessionChangedEvent({ reason: 'status-change', ts: 1 }, options);
    await flush();
    assert.deepEqual(retired, ['viewer']);
  });
});
