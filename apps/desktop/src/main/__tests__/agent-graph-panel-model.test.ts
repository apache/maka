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
  reduceAgentGraphPanelModel,
  shouldShowAgentGraphPanel,
} from '../../renderer/features/overlays/testing.js';

describe('AgentGraphPanelModel', () => {
  it('keeps presentation state separate from backend snapshots', () => {
    let state = createAgentGraphPanelModel('session-a');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-a' });
    state = reduceAgentGraphPanelModel(state, {
      type: 'commit-snapshot',
      current: true,
      snapshot: { rootSessionId: 'session-a', graphId: 'graph-a', status: 'completed' },
    });

    assert.deepEqual(state.dismissedBySession, { 'session-a': 'graph-a' });
    assert.equal(state.selectedGraphId, 'graph-a');
    assert.equal(state.collapsed, true);
  });

  it('does not let a stale backend snapshot from another session mutate the model', () => {
    let state = createAgentGraphPanelModel('session-a');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-a' });
    state = reduceAgentGraphPanelModel(state, { type: 'enter-session', rootSessionId: 'session-b' });
    state = reduceAgentGraphPanelModel(state, {
      type: 'commit-snapshot',
      current: true,
      snapshot: { rootSessionId: 'session-a', graphId: 'graph-a', status: 'completed' },
    });

    assert.equal(state.selectedGraphId, undefined);
    assert.equal(state.rootSessionId, 'session-b');
    assert.deepEqual(state.dismissedBySession, { 'session-a': 'graph-a' });
  });

  it('ablation: removing graph identity hides a new terminal graph incorrectly', () => {
    let state = createAgentGraphPanelModel('session-a');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-a' });
    const dismissedState = state;
    state = reduceAgentGraphPanelModel(state, {
      type: 'commit-snapshot',
      current: true,
      snapshot: { rootSessionId: 'session-a', graphId: 'graph-b', status: 'completed' },
    });

    assert.equal(
      shouldShowAgentGraphPanel({
        enabled: true,
        hasGraphActivity: true,
        sessionId: 'session-a',
        graphId: 'graph-b',
        status: 'completed',
        dismissedBySession: state.dismissedBySession,
      }),
      true,
    );

    // Counterfactual: a session-only terminal flag would suppress graph-b too.
    const sessionOnlyDismissal = dismissedState.dismissedBySession['session-a'] !== undefined;
    const naiveShow = !(sessionOnlyDismissal && state.selectedGraphId === 'graph-b');
    assert.equal(naiveShow, false);
  });
});
