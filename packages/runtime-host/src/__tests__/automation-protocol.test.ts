import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AUTOMATION_MAX_FIRES,
  AUTOMATION_OPERATION_SPECS,
  AUTOMATION_PAGE_MAX_ITEMS,
  decodeAutomationMutateInput,
  decodeAutomationMutateResult,
  decodeAutomationQueryInput,
  decodeAutomationQueryResult,
  type AutomationProjection,
} from '../protocol/automation.js';
import { RuntimeHostProtocolError } from '../protocol/errors.js';

describe('Automation protocol', () => {
  test('declares one ready query and one ready command', () => {
    assert.equal(AUTOMATION_OPERATION_SPECS['automation.query'].mode, 'query');
    assert.equal(AUTOMATION_OPERATION_SPECS['automation.mutate'].mode, 'command');
    assert.equal(AUTOMATION_OPERATION_SPECS['automation.query'].availability, 'ready');
    assert.equal(AUTOMATION_OPERATION_SPECS['automation.mutate'].availability, 'ready');
  });

  test('round-trips every query and mutation branch', () => {
    for (const input of [
      { kind: 'list_start', sessionId: 'session-1' },
      { kind: 'list_continue', sessionId: 'session-1', revision: 2, cursor: '64' },
      { kind: 'get', sessionId: 'session-1', automationId: 'automation-1' },
    ] as const) {
      assert.deepEqual(decodeAutomationQueryInput(input), input);
    }
    const automation = projection();
    for (const result of [
      {
        kind: 'page',
        sessionId: 'session-1',
        revision: 2,
        automations: [automation],
        nextCursor: '1',
      },
      { kind: 'revision_changed', expected: 1, actual: 2 },
      {
        kind: 'automation',
        sessionId: 'session-1',
        revision: 2,
        automation,
      },
      {
        kind: 'automation',
        sessionId: 'session-1',
        revision: 2,
        automation: null,
      },
    ] as const) {
      assert.deepEqual(decodeAutomationQueryResult(result), result);
    }

    const create = {
      kind: 'create' as const,
      sessionId: 'session-1',
      automationKind: 'cron' as const,
      name: 'daily summary',
      prompt: 'Summarize the workspace.',
      schedule: { type: 'once' as const, delaySeconds: 30 },
      maxFires: 1,
      durable: true,
      requiredCapabilityGroups: ['client_contract'],
    };
    assert.deepEqual(decodeAutomationMutateInput(create), create);
    for (const kind of ['delete', 'pause', 'resume'] as const) {
      const input = { kind, sessionId: 'session-1', automationId: 'automation-1' };
      assert.deepEqual(decodeAutomationMutateInput(input), input);
    }
    assert.deepEqual(decodeAutomationMutateResult({ kind: 'committed', revision: 3, automation }), {
      kind: 'committed',
      revision: 3,
      automation,
    });
    assert.deepEqual(decodeAutomationMutateResult({ kind: 'rejected', reason: 'fire_pending' }), {
      kind: 'rejected',
      reason: 'fire_pending',
    });
  });

  test('rejects unknown fields, blank content, and out-of-range schedules', () => {
    assertInvalid(() =>
      decodeAutomationQueryInput({
        kind: 'get',
        sessionId: 'session-1',
        automationId: 'automation-1',
        execution: { cwd: '/private' },
      }),
    );
    for (const input of [
      createInput({ name: '   ' }),
      createInput({ prompt: '\n\t' }),
      createInput({ maxFires: AUTOMATION_MAX_FIRES + 1 }),
      createInput({ schedule: { type: 'interval', seconds: 9 } }),
      createInput({ schedule: { type: 'once', delaySeconds: 86_401 } }),
      createInput({ schedule: { type: 'cron', expression: '*'.repeat(101) } }),
      createInput({ requiredCapabilityGroups: ['client_contract', 'client_contract'] }),
      createInput({ requiredCapabilityGroups: Array.from({ length: 33 }, (_, i) => `group_${i}`) }),
    ]) {
      assertInvalid(() => decodeAutomationMutateInput(input));
    }
    assertInvalid(() =>
      decodeAutomationMutateResult({ kind: 'rejected', reason: 'permission_denied' }),
    );
  });

  test('uses one Unicode text contract for mutations and projections', () => {
    const accepted = createInput({
      name: '名'.repeat(100),
      prompt: '提'.repeat(2_000),
    });
    assert.deepEqual(decodeAutomationMutateInput(accepted), accepted);
    assertInvalid(() => decodeAutomationMutateInput(createInput({ name: '名'.repeat(101) })));
    assertInvalid(() => decodeAutomationMutateInput(createInput({ prompt: '提'.repeat(2_001) })));

    const acceptedProjection = { ...projection(), lastError: '故'.repeat(2_000) };
    assert.deepEqual(
      decodeAutomationQueryResult({
        kind: 'automation',
        sessionId: 'session-1',
        revision: 1,
        automation: acceptedProjection,
      }),
      {
        kind: 'automation',
        sessionId: 'session-1',
        revision: 1,
        automation: acceptedProjection,
      },
    );
    assertInvalid(() =>
      decodeAutomationQueryResult({
        kind: 'automation',
        sessionId: 'session-1',
        revision: 1,
        automation: { ...projection(), lastError: '故'.repeat(2_001) },
      }),
    );
  });

  test('enforces bounded query pages and excludes internal execution settings', () => {
    const item = projection();
    assertInvalid(() =>
      decodeAutomationQueryResult({
        kind: 'page',
        sessionId: 'session-1',
        revision: 1,
        automations: Array.from({ length: AUTOMATION_PAGE_MAX_ITEMS + 1 }, () => item),
        nextCursor: null,
      }),
    );
    assertInvalid(() =>
      decodeAutomationQueryResult({
        kind: 'automation',
        sessionId: 'session-1',
        revision: 1,
        automation: { ...item, execution: { cwd: '/private' } },
      }),
    );
  });
});

function createInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'create',
    sessionId: 'session-1',
    automationKind: 'heartbeat',
    name: 'check build',
    prompt: 'Check the build.',
    schedule: { type: 'interval', seconds: 60 },
    ...overrides,
  };
}

function projection(): AutomationProjection {
  return {
    id: 'automation-1',
    kind: 'cron',
    name: 'daily summary',
    status: 'active',
    prompt: 'Summarize the workspace.',
    sessionId: 'session-1',
    schedule: { type: 'cron', expression: '0 9 * * 1-5' },
    createdAt: 1,
    updatedAt: 2,
    nextFireAt: 3,
    lastFireAt: null,
    lastRunId: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: 4,
    lastError: null,
    consecutiveFailures: 0,
    durable: true,
    deferredFireCount: 0,
    firePending: false,
    waiting: {
      reason: 'client_capability_provider_unavailable',
      since: 2,
      message: 'Capability provider is offline',
    },
  };
}

function assertInvalid(run: () => unknown): void {
  assert.throws(run, (error) => error instanceof RuntimeHostProtocolError);
}
