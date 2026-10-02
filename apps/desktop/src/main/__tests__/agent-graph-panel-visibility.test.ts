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
import type { AgentGraphClientSnapshot } from '@maka/runtime/stream-graph-read-model';
import {
  createAgentGraphPanelModel,
  isAgentGraphLive,
  isAgentGraphPanelDismissible,
  reduceAgentGraphPanelModel,
  shouldShowAgentGraphPanel,
} from '../../renderer/agent-graph-panel-visibility.js';

type Status = AgentGraphClientSnapshot['status'];

const STATUS_CONTRACT: ReadonlyArray<{
  status: Status | undefined;
  live: boolean;
  dismissible: boolean;
}> = [
  { status: undefined, live: false, dismissible: false },
  { status: 'empty', live: false, dismissible: false },
  { status: 'active', live: true, dismissible: false },
  { status: 'waiting', live: true, dismissible: false },
  { status: 'closing', live: true, dismissible: false },
  { status: 'completed', live: false, dismissible: true },
  { status: 'stopped', live: false, dismissible: true },
  { status: 'failed', live: false, dismissible: true },
];

const commit = (
  state: ReturnType<typeof createAgentGraphPanelModel>,
  rootSessionId: string,
  graphId: string,
  status: Status,
  current = true,
) =>
  reduceAgentGraphPanelModel(state, {
    type: 'commit-snapshot',
    current,
    snapshot: { rootSessionId, graphId, status },
  });

describe('Agent Graph status partition', () => {
  it('classifies every protocol status into disjoint live and dismissible sets', () => {
    for (const row of STATUS_CONTRACT) {
      assert.equal(isAgentGraphLive(row.status), row.live, String(row.status));
      assert.equal(isAgentGraphPanelDismissible(row.status), row.dismissible, String(row.status));
      assert.equal(row.live && row.dismissible, false, String(row.status));
    }
  });
});

describe('Agent Graph visibility invariant', () => {
  it('depends on a dismissal only for the same terminal graph in the same session', () => {
    for (const row of STATUS_CONTRACT) {
      const hidden = shouldShowAgentGraphPanel({
        enabled: true,
        hasGraphActivity: true,
        sessionId: 'session-a',
        graphId: 'graph-a',
        status: row.status,
        dismissedBySession: { 'session-a': 'graph-a' },
      });
      assert.equal(hidden, !row.dismissible, String(row.status));

      for (const changedIdentity of [
        { sessionId: 'session-b', graphId: 'graph-a' },
        { sessionId: 'session-a', graphId: 'graph-b' },
      ]) {
        assert.equal(
          shouldShowAgentGraphPanel({
            enabled: true,
            hasGraphActivity: true,
            ...changedIdentity,
            status: row.status,
            dismissedBySession: { 'session-a': 'graph-a' },
          }),
          true,
        );
      }
    }
  });

  it('is monotone when graph activity or graph mode is added', () => {
    for (const enabled of [false, true]) {
      for (const hasGraphActivity of [false, true]) {
        const visible = shouldShowAgentGraphPanel({
          enabled,
          hasGraphActivity,
          sessionId: 'session-a',
          dismissedBySession: {},
        });
        assert.equal(visible, enabled || hasGraphActivity);
      }
    }
  });
});

describe('Agent Graph presentation state machine', () => {
  it('retains a matching terminal dismissal and clears it for every revival', () => {
    for (const terminal of ['completed', 'stopped', 'failed'] as const) {
      let state = createAgentGraphPanelModel('session-a');
      state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-a' });
      state = commit(state, 'session-a', 'graph-a', terminal);
      assert.deepEqual(state.dismissedBySession, { 'session-a': 'graph-a' });

      for (const live of ['active', 'waiting', 'closing'] as const) {
        const revived = commit(state, 'session-a', 'graph-a', live);
        assert.deepEqual(revived.dismissedBySession, {}, `${terminal} -> ${live}`);
      }
    }
  });

  it('treats graph rollover as a new identity regardless of terminal status', () => {
    let state = createAgentGraphPanelModel('session-a');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-a' });
    for (const status of ['active', 'completed', 'failed'] as const) {
      assert.deepEqual(commit(state, 'session-a', 'graph-b', status).dismissedBySession, {});
    }
  });

  it('ignores stale snapshots after a session transition', () => {
    let state = createAgentGraphPanelModel('session-a');
    state = reduceAgentGraphPanelModel(state, { type: 'dismiss', graphId: 'graph-a' });
    state = reduceAgentGraphPanelModel(state, {
      type: 'enter-session',
      rootSessionId: 'session-b',
    });
    const before = state;
    state = commit(state, 'session-a', 'graph-a', 'active');
    assert.strictEqual(state, before);
  });

  it('initializes collapse once, then preserves explicit user intent', () => {
    let state = commit(createAgentGraphPanelModel('session-a'), 'session-a', 'graph-a', 'completed');
    assert.equal(state.collapsed, true);
    state = reduceAgentGraphPanelModel(state, { type: 'toggle-collapse' });
    assert.equal(state.collapsed, false);
    state = commit(state, 'session-a', 'graph-a', 'completed');
    assert.equal(state.collapsed, false);
  });
});
