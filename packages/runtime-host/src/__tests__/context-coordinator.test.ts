import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionHeader } from '@maka/core/session';
import type { HostedExecutionPreparation } from '../server/hosted-execution-authority.js';
import { completedHostedExecutionAdmission } from '../server/hosted-execution-authority.js';
import { HostContextCoordinator } from '../server/context-coordinator.js';

test('context compaction waits for terminal execution cleanup before preparing', async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let prepareCalls = 0;
  const terminal = {
    sessionId: 'session-context',
    turnId: 'turn-terminal',
    runId: 'run-terminal',
    status: 'completed' as const,
    terminalEventId: 'event-terminal',
  };
  const compacted = {
    sessionId: terminal.sessionId,
    turnId: 'turn-compact',
    runId: 'run-compact',
    status: 'completed' as const,
    terminalEventId: 'event-compact',
  };
  const prepare = (): HostedExecutionPreparation => {
    prepareCalls += 1;
    if (prepareCalls === 1) {
      return {
        kind: 'busy',
        execution: terminal,
        whenIdle: cleanup,
      };
    }
    return {
      kind: 'prepared',
      admission: {
        sessionId: terminal.sessionId,
        admit: async () => completedHostedExecutionAdmission(compacted),
        release: () => {},
      },
    };
  };
  const coordinator = new HostContextCoordinator({
    runtime: {
      compactSession: async function* () {},
      getContextDiagnostics: async () => ({}) as never,
      listTurns: async () => [],
      preflightContextCompaction: async () => {},
    },
    executions: {
      lookup: async () => undefined,
      prepare,
      reconcile: async () => terminal,
      admit: async () => assert.fail('Context compaction must use its prepared admission'),
    },
    sessions: {
      readHeaderSnapshot: async () =>
        ({ status: 'active', isArchived: false }) as unknown as SessionHeader,
    },
    requestDrain: () => {},
    newId: () => compacted.runId,
  });

  const compaction = coordinator.handlers['context.compact'](
    {
      sessionId: terminal.sessionId,
      turnId: compacted.turnId,
    },
    {} as never,
  );
  let settled = false;
  void compaction.finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releaseCleanup();
  const outcome = await compaction;
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.result, compacted);
  assert.equal(prepareCalls, 2);
});
