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
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { localExecutionPersistenceProvider } from '../local-execution-persistence.js';
import { createMemoryExecutionPersistenceProvider } from '../test-only/memory-execution-persistence.js';

for (const [name, provider] of [
  ['sqlite', localExecutionPersistenceProvider],
  ['memory', createMemoryExecutionPersistenceProvider()],
] as const)
  test(`${name}: provenance budgets measure only the requested immutable call`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-tool-proof-'));
    const stores = await provider.open({ rootId: 'root', canonicalPath: root });
    try {
      const identity = {
        sessionId: 'session',
        runId: 'run',
        invocationId: 'run',
        turnId: 'turn',
        ts: 1,
        partial: false,
      };
      const args = { command: 'true', run_in_background: true };
      const proof: RuntimeEvent[] = [
        {
          ...identity,
          id: 'call',
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'tool', name: 'Bash', args },
        },
        {
          ...identity,
          id: 'dispatch',
          role: 'system',
          author: 'system',
          refs: { operationId: 'operation', toolCallId: 'tool' },
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'operation',
              providerToolCallId: 'tool',
              toolName: 'Bash',
              canonicalArgsHash: canonicalToolArgsHash('Bash', args),
              recoveryMode: 'never_auto_retry',
            },
          },
        },
        {
          ...identity,
          id: 'result',
          role: 'tool',
          author: 'tool',
          refs: { operationId: 'operation', toolCallId: 'tool' },
          content: {
            kind: 'function_response',
            id: 'tool',
            name: 'Bash',
            result: { kind: 'shell_run', ref: 'maka://runtime/background-tasks/task' },
            isError: true,
          },
        },
      ];
      const unrelated: RuntimeEvent[] = Array.from({ length: 100 }, (_, i) => ({
        ...identity,
        id: `unrelated-${i}`,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'x'.repeat(10000) },
      }));
      await stores.runtimeEventStore.importConversationCopyRuntimeEvents('session', [
        { runId: 'run', events: [...unrelated, ...proof] },
      ]);
      const result = await stores.runtimeEventStore.readToolProvenanceEvents(
        'session',
        'run',
        'tool',
        { maxRecords: 3, maxBytes: 10000 },
      );
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.records, proof);
      for (const budget of [
        { maxRecords: 2, maxBytes: 10000 },
        { maxRecords: 3, maxBytes: 10 },
      ]) {
        const bounded = await stores.runtimeEventStore.readToolProvenanceEvents(
          'session',
          'run',
          'tool',
          budget,
        );
        assert.notEqual(bounded.status, 'complete');
        assert.deepEqual(bounded, { status: 'limit_exceeded' });
      }
      const otherSession = await stores.runtimeEventStore.readToolProvenanceEvents(
        'other',
        'run',
        'tool',
        { maxRecords: 3, maxBytes: 10000 },
      );
      assert.equal(otherSession.status, 'complete');
      if (otherSession.status === 'complete') assert.equal(otherSession.records.length, 0);
      const otherRun = await stores.runtimeEventStore.readToolProvenanceEvents(
        'session',
        'other',
        'tool',
        { maxRecords: 3, maxBytes: 10000 },
      );
      assert.equal(otherRun.status, 'complete');
      if (otherRun.status === 'complete') assert.equal(otherRun.records.length, 0);
    } finally {
      await stores.close();
      await rm(root, { recursive: true, force: true });
    }
  });
