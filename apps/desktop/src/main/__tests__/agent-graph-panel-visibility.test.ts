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
  createAgentGraphPanelModel,
  isAgentGraphLive,
  isAgentGraphPanelDismissible,
  reduceAgentGraphPanelModel,
  shouldShowAgentGraphPanel,
} from '../../renderer/agent-graph-panel-visibility.js';

describe('isAgentGraphLive', () => {
  it('treats in-flight statuses as live and settled ones as not', () => {
    for (const status of ['active', 'waiting', 'closing'] as const) {
      assert.equal(isAgentGraphLive(status), true, status);
    }
    for (const status of ['empty', 'stopped', 'failed', 'completed'] as const) {
      assert.equal(isAgentGraphLive(status), false, status);
    }
    assert.equal(isAgentGraphLive(undefined), false);
  });
});

describe('isAgentGraphPanelDismissible', () => {
  it('allows hiding a graph that no longer has active work', () => {
    assert.equal(isAgentGraphPanelDismissible('completed'), true);
    assert.equal(isAgentGraphPanelDismissible('stopped'), true);
    assert.equal(isAgentGraphPanelDismissible('failed'), true);
  });

  it('keeps the panel while the graph is still in flight', () => {
    for (const status of ['empty', 'active', 'closing', 'waiting'] as const) {
      assert.equal(isAgentGraphPanelDismissible(status), false, status);
    }
    assert.equal(isAgentGraphPanelDismissible(undefined), false);
  });
});

describe('shouldShowAgentGraphPanel', () => {
  it('hides a dismissed completed graph for that session', () => {
    assert.equal(
      shouldShowAgentGraphPanel({
        enabled: true,
        hasGraphActivity: true,
        sessionId: 'session-1',
        graphId: 'graph-1',
        status: 'completed',
        dismissedBySession: { 'session-1': 'graph-1' },
      }),
      false,
    );
  });

  it('shows a new graph after the previous one was dismissed', () => {
    assert.equal(
      shouldShowAgentGraphPanel({
        enabled: true,
        hasGraphActivity: true,
        sessionId: 'session-1',
        graphId: 'graph-2',
        status: 'active',
        dismissedBySession: { 'session-1': 'graph-1' },
      }),
      true,
    );
  });

  it('shows the same graph again if it leaves a terminal state', () => {
    assert.equal(
      shouldShowAgentGraphPanel({
        enabled: true,
        hasGraphActivity: true,
        sessionId: 'session-1',
        graphId: 'graph-1',
        status: 'active',
        dismissedBySession: { 'session-1': 'graph-1' },
      }),
      true,
    );
  });

  it('does not apply another session\'s dismissal', () => {
    assert.equal(
      shouldShowAgentGraphPanel({
        enabled: true,
        hasGraphActivity: true,
        sessionId: 'session-2',
        graphId: 'graph-1',
        status: 'completed',
        dismissedBySession: { 'session-1': 'graph-1' },
      }),
      true,
    );
  });

  it('keeps the existing empty-state hide when graph mode is off', () => {
    assert.equal(
      shouldShowAgentGraphPanel({
        enabled: false,
        hasGraphActivity: false,
        sessionId: 'session-1',
        dismissedBySession: {},
      }),
      false,
    );
  });

  it('still shows an enabled graph that has not produced activity yet', () => {
    assert.equal(
      shouldShowAgentGraphPanel({
        enabled: true,
        hasGraphActivity: false,
        sessionId: 'session-1',
        dismissedBySession: {},
      }),
      true,
    );
  });
});

describe('dismiss and reconcile', () => {
  it('records the dismissed graph for the session', () => {
    const state = reduceAgentGraphPanelModel(createAgentGraphPanelModel('session-1'), {
      type: 'dismiss',
      graphId: 'graph-1',
    });
    assert.deepEqual(state.dismissedBySession, { 'session-1': 'graph-1' });
  });

  it('drops a stale dismissal when a later snapshot is a different graph', () => {
    let state = createAgentGraphPanelModel('session-1');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-1' });
    state = reduceAgentGraphPanelModel(state, {
      type: 'commit-snapshot',
      current: true,
      snapshot: { rootSessionId: 'session-1', graphId: 'graph-2', status: 'active' },
    });
    assert.deepEqual(state.dismissedBySession, {});
  });

  it('drops a stale dismissal when the same graph becomes active again', () => {
    let state = createAgentGraphPanelModel('session-1');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-1' });
    state = reduceAgentGraphPanelModel(state, {
      type: 'commit-snapshot',
      current: true,
      snapshot: { rootSessionId: 'session-1', graphId: 'graph-1', status: 'active' },
    });
    assert.deepEqual(state.dismissedBySession, {});
  });

  it('keeps a matching terminal dismissal', () => {
    let state = createAgentGraphPanelModel('session-1');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-1' });
    state = reduceAgentGraphPanelModel(state, {
      type: 'commit-snapshot',
      current: true,
      snapshot: { rootSessionId: 'session-1', graphId: 'graph-1', status: 'completed' },
    });
    assert.deepEqual(state.dismissedBySession, { 'session-1': 'graph-1' });
  });

  it('does not clear a dismissal against a snapshot still owned by the previous session', () => {
    let state = createAgentGraphPanelModel('session-a');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-a' });
    state = reduceAgentGraphPanelModel(state, { type: 'enter-session', rootSessionId: 'session-b' });
    state = reduceAgentGraphPanelModel(state, {
      type: 'commit-snapshot',
      current: true,
      snapshot: { rootSessionId: 'session-a', graphId: 'graph-a', status: 'completed' },
    });
    assert.deepEqual(state.dismissedBySession, { 'session-a': 'graph-a' });
  });
});
