import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  dismissAgentGraphPanel,
  isAgentGraphPanelDismissible,
  reconcileAgentGraphPanelDismissals,
  shouldShowAgentGraphPanel,
} from '../../renderer/agent-graph-panel-visibility.js';

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
        error: false,
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
        error: false,
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
        error: false,
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
        error: false,
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
        error: false,
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
        error: false,
        sessionId: 'session-1',
        dismissedBySession: {},
      }),
      true,
    );
  });
});

describe('dismiss and reconcile', () => {
  it('records the dismissed graph for the session', () => {
    assert.deepEqual(dismissAgentGraphPanel({}, 'session-1', 'graph-1'), {
      'session-1': 'graph-1',
    });
  });

  it('drops a stale dismissal when a later snapshot is a different graph', () => {
    assert.deepEqual(
      reconcileAgentGraphPanelDismissals(
        { 'session-1': 'graph-1' },
        'session-1',
        { rootSessionId: 'session-1', graphId: 'graph-2', status: 'active' },
      ),
      {},
    );
  });

  it('drops a stale dismissal when the same graph becomes active again', () => {
    assert.deepEqual(
      reconcileAgentGraphPanelDismissals(
        { 'session-1': 'graph-1' },
        'session-1',
        { rootSessionId: 'session-1', graphId: 'graph-1', status: 'active' },
      ),
      {},
    );
  });

  it('keeps a matching terminal dismissal', () => {
    assert.deepEqual(
      reconcileAgentGraphPanelDismissals(
        { 'session-1': 'graph-1' },
        'session-1',
        { rootSessionId: 'session-1', graphId: 'graph-1', status: 'completed' },
      ),
      { 'session-1': 'graph-1' },
    );
  });

  it('does not clear a dismissal against a snapshot still owned by the previous session', () => {
    assert.deepEqual(
      reconcileAgentGraphPanelDismissals(
        { 'session-a': 'graph-a' },
        'session-a',
        { rootSessionId: 'session-b', graphId: 'graph-b', status: 'completed' },
      ),
      { 'session-a': 'graph-a' },
    );
  });
});
