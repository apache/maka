import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutomationProjection } from '@maka/runtime-host/protocol';
import { listAgentAutomationsForScheduledTasks } from '../agent-automations-for-plans.js';

function automation(
  overrides: Partial<AutomationProjection> & Pick<AutomationProjection, 'id' | 'sessionId'>,
): AutomationProjection {
  return {
    kind: 'cron',
    name: overrides.name ?? overrides.id,
    status: 'active',
    prompt: 'do work',
    schedule: { type: 'cron', expression: '0 9 * * *' },
    createdAt: 100,
    updatedAt: 100,
    nextFireAt: 200,
    lastFireAt: null,
    lastRunId: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: null,
    lastError: null,
    consecutiveFailures: 0,
    durable: true,
    deferredFireCount: 0,
    firePending: false,
    waiting: null,
    ...overrides,
  };
}

describe('listAgentAutomationsForScheduledTasks', () => {
  it('dedupes durable automations seen from multiple sessions and skips heartbeats', async () => {
    const calls: string[] = [];
    const client = {
      async listSessions() {
        return [
          { id: 'live', isArchived: false },
          { id: 'old', isArchived: true },
        ] as never;
      },
      async listAutomations(sessionId: string) {
        calls.push(sessionId);
        if (sessionId === 'live') {
          return [
            automation({ id: 'cron-a', sessionId: 'live', createdAt: 20 }),
            automation({
              id: 'hb',
              sessionId: 'live',
              kind: 'heartbeat',
              durable: false,
            }),
          ];
        }
        return [
          automation({ id: 'cron-a', sessionId: 'creator', createdAt: 10 }),
          automation({ id: 'cron-b', sessionId: 'creator', createdAt: 5 }),
        ];
      },
    };

    const listed = await listAgentAutomationsForScheduledTasks(client);
    assert.deepEqual(calls, ['live', 'old']);
    assert.deepEqual(
      listed.map((entry) => entry.id),
      ['cron-b', 'cron-a'],
    );
    // Live session is preferred when the same id is seen twice.
    assert.equal(listed.find((entry) => entry.id === 'cron-a')?.sessionId, 'live');
  });

  it('survives a single session list failure', async () => {
    const client = {
      async listSessions() {
        return [
          { id: 'broken', isArchived: false },
          { id: 'ok', isArchived: false },
        ] as never;
      },
      async listAutomations(sessionId: string) {
        if (sessionId === 'broken') throw new Error('session gone');
        return [automation({ id: 'cron-ok', sessionId: 'ok' })];
      },
    };
    const listed = await listAgentAutomationsForScheduledTasks(client);
    assert.deepEqual(
      listed.map((entry) => entry.id),
      ['cron-ok'],
    );
  });
});
