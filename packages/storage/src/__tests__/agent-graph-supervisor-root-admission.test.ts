import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import { createSqliteAgentRunStore, type AdmitRootTurnInput } from '../agent-run-store.js';

test('Agent Graph supervisor admission durably binds wake identity and Graph orchestration', async () => {
  await withTempRoot(async (root) => {
    const store = createSqliteAgentRunStore(root);
    const admitted = await store.admitRootTurn(admissionInput());

    assert.equal(admitted.kind, 'admitted');
    assert.deepEqual(admitted.admission.execution, admissionInput().execution);
    assert.deepEqual(admitted.admission.turnOrchestration, {
      mode: 'graph',
      source: 'host_api',
    });

    const reopened = createSqliteAgentRunStore(root);
    assert.deepEqual(
      await reopened.readRootTurnAdmission('root-session', 'supervisor-turn'),
      admitted.admission,
    );
  });
});

test('Agent Graph supervisor admission rejects malformed identity and non-Graph orchestration', async () => {
  await withTempRoot(async (root) => {
    const store = createSqliteAgentRunStore(root);
    await assert.rejects(
      () =>
        store.admitRootTurn(
          admissionInput({
            execution: {
              ...admissionInput().execution,
              wakeId: ' wake ',
            } as RootExecutionDescriptor,
          }),
        ),
      /Invalid root execution descriptor/,
    );
    await assert.rejects(
      () =>
        store.admitRootTurn(
          admissionInput({
            turnOrchestration: { mode: 'swarm', source: 'host_api' },
          }),
        ),
      /requires Host Graph orchestration/,
    );
    await assert.rejects(
      () =>
        store.admitRootTurn(
          admissionInput({
            execution: {
              ...admissionInput().execution,
              wakeId: 'agent_graph_ffffffffffffffffffffffffffffffff:snapshot-1',
            } as RootExecutionDescriptor,
          }),
        ),
      /Invalid root execution descriptor/,
    );
    await assert.rejects(
      () =>
        store.admitRootTurn(
          admissionInput({
            turnOrchestration: undefined,
          }),
        ),
      /requires Host Graph orchestration/,
    );
  });
});

function admissionInput(overrides: Partial<AdmitRootTurnInput> = {}): AdmitRootTurnInput {
  return {
    sessionId: 'root-session',
    turnId: 'supervisor-turn',
    proposedRunId: 'supervisor-run',
    proposedUserMessageId: 'supervisor-message',
    execution: {
      kind: 'agent_graph_supervisor_wake',
      graphId: 'agent_graph_0123456789abcdef0123456789abcdef',
      wakeId: 'agent_graph_0123456789abcdef0123456789abcdef:snapshot-1',
      attemptId: 'attempt-1',
    },
    previousRootTurnId: null,
    normalizedInput: { text: 'Inspect the durable graph.' },
    turnOrchestration: { mode: 'graph', source: 'host_api' },
    sourceMessages: [],
    admittedAt: 50,
    ...overrides,
  };
}

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-graph-supervisor-admission-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
