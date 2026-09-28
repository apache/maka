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
import { createDesktopE2eCheckpoint } from '../test-only/desktop-e2e-checkpoint.js';
import { DesktopE2eBackend } from '../test-only/desktop-e2e-backend.js';

function runtimeEvent(text: string, id = 'event-1'): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
}

function backendContext(
  record?: (checkpoint: HistoryCompactCheckpoint, turnId: string) => Promise<void>,
): BackendFactoryContext {
  return {
    sessionId: 'session-1',
    workspaceRoot: '/tmp/workspace',
    header: { model: 'fake-model' } as SessionHeader,
    store: {} as BackendFactoryContext['store'],
    ...(record ? { recordHistoryCompactCheckpoint: record } : {}),
  };
}

function compactInput(events: RuntimeEvent[]) {
  return { turnId: 'turn-1', runId: 'run-1', runtimeContext: events };
}

test('Desktop E2E compaction requires an explicit persistence boundary', async () => {
  const backend = new DesktopE2eBackend(backendContext());
  await assert.rejects(
    backend.compactHistory(compactInput([runtimeEvent('hello')])),
    /requires a checkpoint recorder/,
  );
});

test('backend and pure factory produce the same checkpoint contract', async () => {
  const events = [runtimeEvent('hello')];
  const writes: Array<{ checkpoint: HistoryCompactCheckpoint; turnId: string }> = [];
  const backend = new DesktopE2eBackend(
    backendContext(async (checkpoint, turnId) => {
      writes.push({ checkpoint, turnId });
    }),
  );
  const outcome = await backend.compactHistory(compactInput(events));
  assert.equal(writes.length, 1);
  const persisted = writes[0];
  assert.ok(persisted);
  assert.equal(persisted.turnId, 'turn-1');
  assert.deepEqual(persisted.checkpoint, createDesktopE2eCheckpoint('session-1', events));
  assert.deepEqual(outcome, {
    outcome: { kind: 'compacted', checkpointId: persisted.checkpoint.checkpointId },
  });
});

test('checkpoint envelope stays stable while covered event content changes', () => {
  const first = createDesktopE2eCheckpoint('session-1', [runtimeEvent('first')]);
  const second = createDesktopE2eCheckpoint('session-1', [runtimeEvent('second', 'event-2')]);

  for (const checkpoint of [first, second]) {
    assert.equal(checkpoint.version, 2);
    assert.equal(checkpoint.summaryFormat, 'sections_v1');
    assert.match(checkpoint.summary, /^## Goal\nDeterministic Desktop E2E context checkpoint\./);
  }
  assert.notEqual(first.checkpointId, second.checkpointId);
});
