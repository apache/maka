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

test('regenerate admission durably binds the immutable source Turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-regenerate-admission-'));
  try {
    const store = createSqliteAgentRunStore(root);
    const input = admissionInput();
    const admitted = await store.admitRootTurn(input);
    assert.equal(admitted.kind, 'admitted');
    assert.deepEqual(admitted.admission.execution, {
      kind: 'regenerate',
      sourceTurnId: 'source-turn',
    });
    store.close?.();

    const reopened = createSqliteAgentRunStore(root);
    assert.deepEqual(
      await reopened.readRootTurnAdmission(input.sessionId, input.turnId),
      admitted.admission,
    );
    await assert.rejects(
      () =>
        reopened.admitRootTurn(
          admissionInput({
            execution: {
              kind: 'regenerate',
              sourceTurnId: ' source-turn ',
            } as RootExecutionDescriptor,
          }),
        ),
      /Invalid root execution descriptor/,
    );
    await assert.rejects(
      () =>
        reopened.admitRootTurn(
          admissionInput({
            execution: { kind: 'regenerate', sourceTurnId: 'regenerated-turn' },
          }),
        ),
      /regenerate source Turn cannot be the admitted Turn/,
    );

    const compact = await reopened.admitRootTurn({
      sessionId: input.sessionId,
      turnId: 'compact-turn',
      proposedRunId: 'compact-run',
      proposedUserMessageId: null,
      execution: { kind: 'context_compact' },
      previousRootTurnId: input.turnId,
      normalizedInput: null,
      sourceMessages: [],
      admittedAt: 60,
    });
    assert.equal(compact.kind, 'admitted');
    assert.deepEqual(compact.admission.execution, { kind: 'context_compact' });
    reopened.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('new root admissions reject removed Automation authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-legacy-automation-admission-'));
  try {
    const store = createSqliteAgentRunStore(root);
    await assert.rejects(
      () =>
        store.admitRootTurn(
          admissionInput({
            execution: {
              kind: 'legacy_automation',
              automationId: 'automation-1',
            } as RootExecutionDescriptor,
          }),
        ),
      /removed Automation authority/,
    );
    store.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function admissionInput(overrides: Partial<AdmitRootTurnInput> = {}): AdmitRootTurnInput {
  return {
    sessionId: 'root-session',
    turnId: 'regenerated-turn',
    proposedRunId: 'regenerated-run',
    proposedUserMessageId: 'regenerated-message',
    execution: { kind: 'regenerate', sourceTurnId: 'source-turn' },
    previousRootTurnId: null,
    normalizedInput: { text: 'Original request' },
    sourceMessages: [],
    admittedAt: 50,
    ...overrides,
  };
}
