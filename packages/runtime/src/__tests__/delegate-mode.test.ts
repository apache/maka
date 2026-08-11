import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  renderDelegateModePrompt,
  renderDelegateSupervisorWake,
  shouldWakeDelegateSupervisor,
} from '../delegate-mode.js';
import type { AgentGraphClientSnapshot } from '../stream-graph-read-model.js';

describe('Delegate Mode', () => {
  test('instructs the main agent to acknowledge and end normally without yielding', () => {
    const prompt = renderDelegateModePrompt();
    assert.match(prompt, /remain responsive/);
    assert.match(prompt, /exactly one structured decision/);
    assert.match(prompt, /zero tool calls/);
    assert.match(prompt, /requires any tool/);
    assert.match(prompt, /end this turn normally/);
    assert.match(prompt, /Do not poll, sleep/);
  });

  test('wakes only at durable attention or settled checkpoints', () => {
    const running = snapshot('running');
    assert.equal(shouldWakeDelegateSupervisor('root', undefined, running), false);

    const completed = snapshot('completed');
    assert.equal(shouldWakeDelegateSupervisor('root', undefined, completed), true);
    const wake = renderDelegateSupervisorWake('root', completed);
    assert.equal(wake?.orchestrationMode, 'delegate');
    assert.equal(wake?.displayText, 'Delegated task checkpoint.');
    assert.match(wake?.text ?? '', /end this turn normally/);
    assert.match(wake?.text ?? '', /Do not poll, sleep/);
  });

  test('does not wake again for reconciliation after a runtime checkpoint', () => {
    const completed = snapshot('completed');
    assert.equal(
      shouldWakeDelegateSupervisor(
        'root',
        {
          status: 'reconciled',
          newActivationCount: 0,
          observedExistingActivationCount: 1,
          dispatches: [],
          stops: [],
          deferredWork: [],
          failures: [],
          schedule: {} as never,
          observation: {} as never,
        },
        completed,
      ),
      false,
    );
  });

  test('does not claim ordinary Graph checkpoints', () => {
    const graph = snapshot('completed');
    graph.orchestrationMode = 'graph';
    assert.equal(shouldWakeDelegateSupervisor('root', undefined, graph), undefined);
    assert.equal(renderDelegateSupervisorWake('root', graph), undefined);
  });
});

function snapshot(status: 'running' | 'completed'): AgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'root',
    graphId: 'graph-root',
    orchestrationMode: 'delegate',
    snapshotVersion: 'snapshot-1',
    status: 'active',
    scheduleRevision: 1,
    topologyFingerprint: 'fingerprint',
    closed: false,
    operators: [
      {
        operatorId: 'operator-1',
        childSessionId: 'child-1',
        provisionId: 'provision-1',
        agentId: 'worker',
        provisionedAt: 1,
        status,
        inboundEdgeIds: [],
        outboundEdgeIds: [],
        scheduledWorkIds: ['work-1'],
        readiness: [],
        omitted: {
          inboundEdgeIds: 0,
          outboundEdgeIds: 0,
          scheduledWorkIds: 0,
          readiness: 0,
          readinessWaits: 0,
        },
        currentActivation: {
          activationId: 'activation-1',
          status,
          recordCount: 1,
          firstEventTime: 1,
          lastEventTime: 2,
          run: { sessionId: 'child-1', agentRunId: 'run-1' },
        },
      },
    ],
    edges: [],
    work: [
      {
        workId: 'work-1',
        target: { kind: 'preset', presetId: 'worker' },
        inputIds: [],
        status: 'requested',
        instructionPreview: 'Do bounded work.',
        instructionTruncated: false,
        revision: 1,
        committedAt: 1,
      },
    ],
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
  };
}
