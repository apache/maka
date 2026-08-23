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

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import { createSqliteAgentRunStore, type AdmitRootTurnInput } from '../agent-run-store.js';

test('Agent Graph supervisor admission durably binds wake identity and Graph orchestration', async () => {
  await withTempRoot(async (_root, openStore) => {
    const store = openStore();
    const admitted = await store.admitRootTurn(admissionInput());

    assert.equal(admitted.kind, 'admitted');
    assert.deepEqual(admitted.admission.execution, admissionInput().execution);
    assert.deepEqual(admitted.admission.turnOrchestration, {
      mode: 'graph',
      source: 'host_api',
    });

    const reopened = openStore();
    assert.deepEqual(
      await reopened.readRootTurnAdmission('root-session', 'supervisor-turn'),
      admitted.admission,
    );
  });
});

test('Agent Graph supervisor admission rejects malformed identity and non-Graph orchestration', async () => {
  await withTempRoot(async (_root, openStore) => {
    const store = openStore();
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

async function withTempRoot(
  run: (
    root: string,
    openStore: () => ReturnType<typeof createSqliteAgentRunStore>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-graph-supervisor-admission-'));
  const stores: ReturnType<typeof createSqliteAgentRunStore>[] = [];
  try {
    await run(root, () => {
      const store = createSqliteAgentRunStore(root);
      stores.push(store);
      return store;
    });
  } finally {
    for (const store of stores.reverse()) store.close?.();
    await rm(root, { recursive: true, force: true });
  }
}
