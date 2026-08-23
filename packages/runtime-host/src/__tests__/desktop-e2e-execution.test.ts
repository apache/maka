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
import test from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import type { HistoryCompactCheckpoint } from '@maka/runtime/history-compact-checkpoint';
import type { BackendFactoryContext } from '@maka/runtime/session-manager';
import { DesktopE2eBackend } from '../test-only/desktop-e2e-execution.js';

function backendContext(overrides: Partial<BackendFactoryContext> = {}): BackendFactoryContext {
  return {
    sessionId: 'session-1',
    workspaceRoot: '/tmp/workspace',
    header: { model: 'fake-model' } as SessionHeader,
    store: {} as BackendFactoryContext['store'],
    ...overrides,
  };
}

test('Desktop E2E compaction requires a checkpoint recorder', async () => {
  const backend = new DesktopE2eBackend(backendContext());
  await assert.rejects(
    backend.compactHistory({
      turnId: 'turn-1',
      runId: 'run-1',
      runtimeContext: [userEvent()],
    }),
    /Desktop E2E compaction requires a checkpoint recorder/,
  );
});

test('Desktop E2E compaction records a deterministic checkpoint', async () => {
  const recorded: Array<{ checkpoint: HistoryCompactCheckpoint; turnId: string }> = [];
  const backend = new DesktopE2eBackend(
    backendContext({
      recordHistoryCompactCheckpoint: async (checkpoint, turnId) => {
        recorded.push({ checkpoint, turnId });
      },
    }),
  );

  const result = await backend.compactHistory({
    turnId: 'turn-1',
    runId: 'run-1',
    runtimeContext: [userEvent()],
  });

  assert.deepEqual(result, {});
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.turnId, 'turn-1');
  const checkpoint = recorded[0]!.checkpoint;
  assert.equal(checkpoint.version, 2);
  if (checkpoint.version !== 2) return;
  // The fixture is shaped like a real sectioned checkpoint so the builder's
  // summary validation admits it and stamps the contract marker.
  assert.match(checkpoint.summary, /^## Goal\nDeterministic Desktop E2E context checkpoint\./);
  assert.equal(checkpoint.summaryFormat, 'sections_v1');
});

function userEvent(): RuntimeEvent {
  return {
    id: 'evt-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'hello' },
  };
}
