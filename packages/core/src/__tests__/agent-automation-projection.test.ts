import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agentAutomationReminderId,
  isAgentAutomationPlanReminder,
  mergePlanRemindersWithAgentAutomations,
  parseAgentAutomationReminderId,
  projectAgentAutomationAsPlanReminder,
  type AgentAutomationProjectionSource,
} from '../agent-automation-projection.js';
import type { PlanReminder } from '../plan-reminders.js';

function automation(
  overrides: Partial<AgentAutomationProjectionSource> = {},
): AgentAutomationProjectionSource {
  return {
    id: 'auto-1',
    kind: 'cron',
    name: 'Morning brief',
    status: 'active',
    prompt: 'Summarize overnight PRs.',
    sessionId: 'session-1',
    schedule: { type: 'cron', expression: '0 9 * * 1-5' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    nextFireAt: 1_700_086_400_000,
    lastFireAt: 1_700_000_050_000,
    lastRunId: 'run-1',
    fireCount: 2,
    lastError: null,
    durable: true,
    ...overrides,
  };
}

describe('agent automation → plan-reminder projection', () => {
  it('projects a durable cron into a scheduled-tasks row with agent origin', () => {
    const row = projectAgentAutomationAsPlanReminder(automation());
    assert.equal(row.id, agentAutomationReminderId('auto-1'));
    assert.equal(row.title, 'Morning brief');
    assert.equal(row.note, 'Summarize overnight PRs.');
    assert.equal(row.status, 'scheduled');
    assert.equal(row.enabled, true);
    assert.equal(row.nextRunAt, 1_700_086_400_000);
    assert.deepEqual(row.schedule, {
      kind: 'cron',
      startAt: 1_700_000_000_000,
      expression: '0 9 * * 1-5',
    });
    assert.equal(row.agentOrigin?.automationId, 'auto-1');
    assert.equal(row.agentOrigin?.sessionId, 'session-1');
    assert.equal(row.agentOrigin?.kind, 'cron');
    assert.equal(row.agentOrigin?.durable, true);
    assert.equal(row.lastRun?.status, 'triggered');
    assert.equal(row.runCount, 2);
    assert.equal(isAgentAutomationPlanReminder(row), true);
  });

  it('maps paused / completed / failed states', () => {
    assert.equal(projectAgentAutomationAsPlanReminder(automation({ status: 'paused' })).status, 'paused');
    assert.equal(
      projectAgentAutomationAsPlanReminder(automation({ status: 'completed' })).status,
      'completed',
    );
    assert.equal(
      projectAgentAutomationAsPlanReminder(automation({ status: 'expired' })).status,
      'completed',
    );
    const failed = projectAgentAutomationAsPlanReminder(
      automation({ lastError: 'model rate limited' }),
    );
    assert.equal(failed.lastRun?.status, 'failed');
    assert.equal(failed.lastRun?.message, 'model rate limited');
  });

  it('parses the stable agent-automation reminder id prefix', () => {
    assert.equal(parseAgentAutomationReminderId(agentAutomationReminderId('x')), 'x');
    assert.equal(parseAgentAutomationReminderId('plain-uuid'), undefined);
  });

  it('merges agent automations into the plan-reminder list without clobbering real rows', () => {
    const real: PlanReminder = {
      id: 'plan-1',
      title: 'UI reminder',
      note: '',
      schedule: { kind: 'once', runAt: 1_700_100_000_000 },
      delivery: { channel: 'local' },
      status: 'scheduled',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      nextRunAt: 1_700_100_000_000,
      runs: [],
      runCount: 0,
    };
    const heartbeatOnly = automation({
      id: 'hb-1',
      kind: 'heartbeat',
      durable: false,
      name: 'private heartbeat',
    });
    const cron = automation({ id: 'cron-1', name: 'Agent cron' });
    const merged = mergePlanRemindersWithAgentAutomations([real], [heartbeatOnly, cron]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.id, 'plan-1');
    assert.equal(merged[1]?.title, 'Agent cron');
    assert.equal(merged[1]?.agentOrigin?.automationId, 'cron-1');
  });
});
