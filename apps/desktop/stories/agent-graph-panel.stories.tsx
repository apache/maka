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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import type {
  AgentGraphClientOperator,
  AgentGraphClientSnapshot,
} from '@maka/runtime/stream-graph-read-model';
import { AgentGraphPanel, getAgentGraphPanelCopy } from '../src/renderer/agent-graph-panel';
import { withScopedMakaBridge } from './maka-bridge';

// Fidelity convention (#1433): every story names the real app path that
// reaches it. See apps/desktop/stories/FIDELITY.md.
//
// Real host: app-shell.tsx mounts <AgentGraphPanel> in the conversation column
// when the active session runs in `graph` orchestration mode. The panel reads
// its snapshot from `window.maka.graphs` itself (not props or context), so each
// story installs a scoped bridge that serves one pinned snapshot rather than
// driving a live graph. The panel renders operators as a flat list — it draws
// no edges or hierarchy — so tree depth and cycles have no distinct rendering
// and are not enumerated here.

const ROOT_SESSION_ID = 'session-graph';
const GRAPH_ID = 'graph-storybook';
const LOCALE = 'zh';
const copy = getAgentGraphPanelCopy(LOCALE);

const meta = {
  title: 'Product/Agent Graph',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function snapshot(
  overrides: Pick<AgentGraphClientSnapshot, 'status'> & Partial<AgentGraphClientSnapshot>,
): AgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: ROOT_SESSION_ID,
    graphId: GRAPH_ID,
    orchestrationMode: 'graph',
    snapshotVersion: '1',
    scheduleRevision: 1,
    topologyFingerprint: 'fp',
    closed: overrides.status === 'completed',
    operators: [],
    edges: [],
    work: [],
    reconciliationFailures: [],
    stoppedTargets: [],
    claims: [],
    recentControlDecisions: [],
    recentActivity: [],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      reconciliationFailures: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
    ...overrides,
  };
}

function operator(
  overrides: Pick<AgentGraphClientOperator, 'operatorId' | 'status'> &
    Partial<AgentGraphClientOperator>,
): AgentGraphClientOperator {
  return {
    childSessionId: `child-${overrides.operatorId}`,
    provisionId: `prov-${overrides.operatorId}`,
    agentId: 'code-reviewer',
    provisionedAt: 1,
    inboundEdgeIds: [],
    outboundEdgeIds: [],
    scheduledWorkIds: [],
    readiness: [],
    omitted: {
      inboundEdgeIds: 0,
      outboundEdgeIds: 0,
      scheduledWorkIds: 0,
      readiness: 0,
      readinessWaits: 0,
    },
    ...overrides,
  };
}

// A scoped `window.maka.graphs` bridge that serves one pinned snapshot. `fail`
// makes getSnapshot reject, exercising the panel's load-error banner. The full
// method set is required: the panel calls `subscribe` outside its try/catch, so
// a missing bridge would throw into React rather than settle into the UI.
function graphBridge(snap: AgentGraphClientSnapshot, fail = false) {
  const directory = {
    epochs: [{ epoch: 1, graphId: snap.graphId, createdAt: 1, current: true }],
    truncated: false,
  };
  return {
    graphs: {
      listEpochs: async () => directory,
      listCurrentEpochs: async () => directory,
      getSnapshot: async () => {
        if (fail) throw new Error('graph read failed');
        return snap;
      },
      inspectOperator: async () => {
        throw new Error('inspectOperator is unused by AgentGraphPanel');
      },
      subscribe: (_sessionId: string, _listener: () => void) => () => undefined,
      stop: async () => undefined,
    },
  };
}

// Production mounts <AgentGraphPanel> in the conversation composer slot
// (app-shell.tsx: ChatSurfaceLayout composer → `.mainColumn` →
// `.maka-detail-with-artifacts`). Reuse those wrapper classes so the panel
// inherits the composer column's seam rather than an arbitrary fixed box. The
// full AppShell grid and Composer chrome around it are not rebuilt here — that
// seam lives in Product/Shell Official AppShell, and its geometry is pinned by
// e2e/session-workbar.spec.ts — so this isolates the panel itself at a
// composer-column width.
function panel() {
  return (
    <div className="maka-detail-with-artifacts">
      <div className="mainColumn" style={{ maxWidth: 720 }}>
        <AgentGraphPanel
          rootSessionId={ROOT_SESSION_ID}
          enabled
          locale={LOCALE}
          onOpenSession={() => undefined}
        />
      </div>
    </div>
  );
}

// Real path: graph mode is enabled but the main agent has not provisioned any
// operator yet — the panel's own empty state, not a spinner and not an error.
export const EmptyGraph: Story = {
  decorators: [
    withScopedMakaBridge(graphBridge(snapshot({ status: 'empty', scheduleRevision: 0 }))),
  ],
  render: panel,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.textContent).toContain(copy.noOperators));
  },
};

// Real path: an operator failed and the graph settled failed. The failed row
// wears its status dot and label beside the operators that finished or are
// still running.
export const FailedGraph: Story = {
  decorators: [
    withScopedMakaBridge(
      graphBridge(
        snapshot({
          status: 'failed',
          operators: [
            operator({ operatorId: 'op-plan', status: 'completed' }),
            operator({ operatorId: 'op-build', status: 'failed' }),
            operator({ operatorId: 'op-verify', status: 'running' }),
          ],
        }),
      ),
    ),
  ],
  render: panel,
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(
        canvasElement.querySelector('.maka-agent-graph-operators li[data-status="failed"]'),
      ).not.toBeNull(),
    );
  },
};

// Real path: an operator cannot start until an upstream operator routes its
// input, so it sits blocked with the amber "waiting for …" line.
export const BlockedOnUpstream: Story = {
  decorators: [
    withScopedMakaBridge(
      graphBridge(
        snapshot({
          status: 'active',
          operators: [
            operator({ operatorId: 'op-planner', status: 'running' }),
            operator({
              operatorId: 'op-writer',
              status: 'blocked',
              readiness: [
                {
                  readinessId: 'r-writer',
                  status: 'waiting',
                  waitingFor: [{ kind: 'input_route', upstreamOperatorIds: ['op-planner'] }],
                  omittedWaitingFor: 0,
                },
              ],
            }),
          ],
        }),
      ),
    ),
  ],
  render: panel,
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      expect(
        canvasElement.querySelector('.maka-agent-graph-operators li[data-status="blocked"]'),
      ).not.toBeNull();
      expect(canvasElement.querySelector('.maka-agent-graph-wait')).not.toBeNull();
    });
  },
};

// Real path: a wide fan-out — many operators provisioned at once, the breadth a
// small graph never shows. The read-model only elides operators past 256 (far
// beyond a story's scale), so this shows a genuine many-operator list rather
// than a fabricated omitted count (review feedback).
export const ManyOperators: Story = {
  decorators: [
    withScopedMakaBridge(
      graphBridge(
        snapshot({
          status: 'active',
          operators: Array.from({ length: 28 }, (_, index) =>
            operator({
              operatorId: `op-${index}`,
              status: index % 3 === 0 ? 'running' : 'completed',
            }),
          ),
        }),
      ),
    ),
  ],
  render: panel,
  play: async ({ canvasElement }) => {
    // The full list renders (its last operator is reachable). An exact row
    // count and the omitted "+N" line are read-model contracts, covered by the
    // read-model's own tests rather than asserted here (review feedback).
    await waitFor(() => expect(canvasElement.textContent).toContain('op-27'));
  },
};

// Real path: reading the graph snapshot fails (the IPC read rejects); the panel
// raises its error Banner with a Retry action instead of a blank pane.
export const LoadError: Story = {
  decorators: [withScopedMakaBridge(graphBridge(snapshot({ status: 'active' }), true))],
  render: panel,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.textContent).toContain(copy.loadFailed));
  },
};
