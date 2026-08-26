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

// #2578: an explicit tool-mode override rides the external-message execution
// descriptor into the durable admission, so a retried or recovered Turn keeps
// its start-time protocol. Only concrete modes are durable — `auto` never is.

test('external-message admission durably carries an explicit tool mode', async () => {
  await withTempRoot(async (_root, openStore) => {
    const store = openStore();
    const admitted = await store.admitRootTurn(admissionInput());

    assert.equal(admitted.kind, 'admitted');
    assert.deepEqual(admitted.admission.execution, {
      kind: 'external_message',
      inputDigest: `sha256:${'a'.repeat(64)}`,
      toolMode: 'code_mode',
    });

    const reopened = openStore();
    assert.deepEqual(
      await reopened.readRootTurnAdmission('root-session', 'tool-mode-turn'),
      admitted.admission,
    );
  });
});

test('external-message admission rejects a non-mode tool value and omits nothing else', async () => {
  await withTempRoot(async (_root, openStore) => {
    const store = openStore();
    await assert.rejects(
      () =>
        store.admitRootTurn(
          admissionInput({
            // 'auto' is not a Runtime mode; the descriptor refuses to persist it.
            execution: {
              kind: 'external_message',
              inputDigest: `sha256:${'a'.repeat(64)}`,
              toolMode: 'auto',
            } as unknown as RootExecutionDescriptor,
          }),
        ),
      /Invalid root execution descriptor/,
    );

    // Absence stays absence — descriptors written before the field existed
    // decode unchanged, and no key is invented for them.
    const withoutOverride = await store.admitRootTurn(
      admissionInput({
        turnId: 'legacy-turn',
        proposedRunId: 'legacy-run',
        proposedUserMessageId: 'legacy-message',
        execution: {
          kind: 'external_message',
          inputDigest: `sha256:${'a'.repeat(64)}`,
        },
      }),
    );
    assert.deepEqual(withoutOverride.admission.execution, {
      kind: 'external_message',
      inputDigest: `sha256:${'a'.repeat(64)}`,
    });
    const reopened = openStore();
    assert.deepEqual(
      (await reopened.readRootTurnAdmission('root-session', 'legacy-turn'))?.execution,
      { kind: 'external_message', inputDigest: `sha256:${'a'.repeat(64)}` },
    );
  });
});

function admissionInput(overrides: Partial<AdmitRootTurnInput> = {}): AdmitRootTurnInput {
  return {
    sessionId: 'root-session',
    turnId: 'tool-mode-turn',
    proposedRunId: 'tool-mode-run',
    proposedUserMessageId: 'tool-mode-message',
    execution: {
      kind: 'external_message',
      inputDigest: `sha256:${'a'.repeat(64)}`,
      toolMode: 'code_mode',
    },
    previousRootTurnId: null,
    normalizedInput: { text: 'Inspect the workspace.' },
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
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-mode-admission-'));
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
