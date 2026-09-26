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
import {
  activateSessionWorkbarTab,
  classifyPendingInteractionKind,
  createSessionWorkbarPanelsState,
  createSessionWorkbarTabsState,
  hostExecutionProjection,
  openSessionWorkbarLauncher,
  parentTaskStatusFromFacts,
  projectWorkbarPanelsForSession,
  visibleParentTaskStatus,
  visibleSideChatParentSessionId,
  type HostPendingInteractionKind,
  type SessionWorkbarPanelsState,
  type SessionWorkbarTab,
} from '../../renderer/features/workbar/testing.js';

const ALL_KINDS: readonly HostPendingInteractionKind[] = [
  'permission',
  'question',
  'form',
  'sandbox_boundary',
  'client_capability',
];

const runningTurn = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  runId: 'run-1',
  status: 'running' as const,
};

describe('parentTaskStatusFromFacts', () => {
  it('classifies every canonical pending kind as input or approval', () => {
    const classified = Object.fromEntries(
      ALL_KINDS.map((kind) => [kind, classifyPendingInteractionKind(kind)]),
    );
    assert.deepEqual(classified, {
      permission: 'approval',
      question: 'input',
      form: 'input',
      sandbox_boundary: 'approval',
      client_capability: 'approval',
    });
  });

  it('maps pending question and form to waiting input', () => {
    for (const kind of ['question', 'form'] as const) {
      assert.equal(
        parentTaskStatusFromFacts({
          execution: hostExecutionProjection(true, runningTurn, [kind]),
          latestTurnRead: { status: 'pending' },
        }),
        'waiting_input',
      );
    }
  });

  it('maps pending permission, sandbox, and client capability to waiting approval', () => {
    for (const kind of ['permission', 'sandbox_boundary', 'client_capability'] as const) {
      assert.equal(
        parentTaskStatusFromFacts({
          execution: hostExecutionProjection(true, runningTurn, [kind]),
          latestTurnRead: { status: 'pending' },
        }),
        'waiting_approval',
      );
    }
  });

  it('maps mixed input and approval pending kinds together', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, runningTurn, ['form', 'permission']),
        latestTurnRead: { status: 'pending' },
      }),
      'waiting_input_and_approval',
    );
  });

  it('maps a live root turn without pending interactions to running', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, {
          ...runningTurn,
          status: 'waiting_for_user',
        }),
        latestTurnRead: { status: 'pending' },
      }),
      'running',
    );
  });

  it('labels terminal root turns as the latest parent turn', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, {
          ...runningTurn,
          status: 'completed',
          terminalEventId: 'done',
        }),
        latestTurnRead: { status: 'pending' },
      }),
      'last_turn_completed',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, {
          ...runningTurn,
          status: 'failed',
          terminalEventId: 'fail',
          failureClass: 'provider',
        }),
        latestTurnRead: { status: 'pending' },
      }),
      'last_turn_failed',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, {
          ...runningTurn,
          status: 'cancelled',
          terminalEventId: 'stop',
          abortSource: 'user_stop',
        }),
        latestTurnRead: { status: 'pending' },
      }),
      'last_turn_interrupted',
    );
  });

  it('does not treat an idle session with no turns as completed', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: null },
      }),
      'idle',
    );
    assert.equal(
      visibleParentTaskStatus('idle'),
      null,
    );
  });

  it('uses the latest TurnRecord when rootTurn is empty', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: { status: 'completed' } },
      }),
      'last_turn_completed',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: { status: 'failed' } },
      }),
      'last_turn_failed',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: { status: 'aborted' } },
      }),
      'last_turn_interrupted',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: { status: 'running' } },
      }),
      'unavailable',
    );
  });


  it('reports nothing until the projection or a needed history read answers', () => {
    // No projection yet: an initial load, not a failure.
    assert.equal(
      parentTaskStatusFromFacts({
        execution: undefined,
        latestTurnRead: { status: 'ready', turn: { status: 'completed' } },
      }),
      null,
    );
    // A history read still in flight is equally not a failure.
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'pending' },
      }),
      null,
    );
    assert.equal(visibleParentTaskStatus(null), null);
  });

  it('stays silent while a known execution projection is being re-observed', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: {
          ...hostExecutionProjection(false, runningTurn),
          observationPending: true,
        },
        latestTurnRead: { status: 'pending' },
      }),
      null,
    );
  });

  it('does not keep a previous success when observation is unavailable', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(false, {
          ...runningTurn,
          status: 'completed',
          terminalEventId: 'done',
        }),
        latestTurnRead: { status: 'ready', turn: { status: 'completed' } },
      }),
      'unavailable',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'failed' },
      }),
      'unavailable',
    );
  });
});

function sideChatPanels(
  tabs: readonly SessionWorkbarTab[],
  activeTabId?: string,
): SessionWorkbarPanelsState {
  return createSessionWorkbarPanelsState(
    createSessionWorkbarTabsState(
      [...tabs],
      activeTabId ?? tabs[0]?.id ?? null,
    ),
  );
}

const sideChatTab: SessionWorkbarTab = { id: 'side-chat:mine', kind: 'side-chat' };
const reviewTab: SessionWorkbarTab = { id: 'review', kind: 'review' };
const visible = { hidden: false, rightCollapsed: false, bottomOpen: false };

/** The projection the Surface and this gate share; nothing else may widen it. */
function projectedFor(
  panels: SessionWorkbarPanelsState,
  quoteIds: readonly string[],
): SessionWorkbarPanelsState {
  return projectWorkbarPanelsForSession(
    panels,
    'parent-1',
    new Set(quoteIds.map((id) => `side-chat:${id}`)),
  );
}

describe('visibleSideChatParentSessionId', () => {
  it('names the owning Session only for a Side Conversation the reader can see', () => {
    const panels = projectedFor(sideChatPanels([sideChatTab]), ['mine']);
    assert.equal(visibleSideChatParentSessionId(panels, visible, 'parent-1'), 'parent-1');
  });

  it('stays silent when the Workbar is hidden or has no owning Session', () => {
    const panels = projectedFor(sideChatPanels([sideChatTab]), ['mine']);
    assert.equal(
      visibleSideChatParentSessionId(panels, { ...visible, hidden: true }, 'parent-1'),
      undefined,
    );
    assert.equal(visibleSideChatParentSessionId(panels, visible, undefined), undefined);
  });

  it('stays silent for a collapsed placement', () => {
    const panels = projectedFor(sideChatPanels([sideChatTab]), ['mine']);
    assert.equal(
      visibleSideChatParentSessionId(panels, { ...visible, rightCollapsed: true }, 'parent-1'),
      undefined,
    );
  });

  it('stays silent while the launcher is open or another tab is active', () => {
    const panels = projectedFor(sideChatPanels([sideChatTab, reviewTab]), ['mine']);
    assert.equal(
      visibleSideChatParentSessionId(
        { ...panels, right: openSessionWorkbarLauncher(panels.right) },
        visible,
        'parent-1',
      ),
      undefined,
    );
    assert.equal(
      visibleSideChatParentSessionId(
        { ...panels, right: activateSessionWorkbarTab(panels.right, 'review') },
        visible,
        'parent-1',
      ),
      undefined,
    );
    assert.equal(
      visibleSideChatParentSessionId(
        { ...panels, right: activateSessionWorkbarTab(panels.right, 'side-chat:mine') },
        visible,
        'parent-1',
      ),
      'parent-1',
    );
  });

  it('stays silent for another Session’s quote or a tab the projection drops', () => {
    const otherSession = projectedFor(sideChatPanels([sideChatTab]), ['other']);
    assert.deepEqual(otherSession.right.tabs, [], 'another Session’s conversation is not open');
    assert.equal(visibleSideChatParentSessionId(otherSession, visible, 'parent-1'), undefined);
    const dropped = projectedFor(sideChatPanels([sideChatTab]), []);
    assert.equal(visibleSideChatParentSessionId(dropped, visible, 'parent-1'), undefined);
  });

  it('reads the bottom placement when that is the visible one', () => {
    const panels = createSessionWorkbarPanelsState(
      createSessionWorkbarTabsState(),
      createSessionWorkbarTabsState([{ id: 'side-chat:mine', kind: 'side-chat' }]),
      'bottom',
    );
    const stored = projectedFor(panels, ['mine']);
    assert.equal(
      visibleSideChatParentSessionId(stored, { hidden: false, rightCollapsed: true, bottomOpen: true }, 'parent-1'),
      'parent-1',
    );
    assert.equal(
      visibleSideChatParentSessionId(stored, { hidden: false, rightCollapsed: true, bottomOpen: false }, 'parent-1'),
      undefined,
    );
  });
});
