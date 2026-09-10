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
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSqliteSessionMetadataStore } from '@maka/storage/sqlite-session-metadata-store';
import { AgentGraphCoordinator } from '../stream-graph-coordinator.js';
import { compileAgentGraphScheduleUpdate } from '../stream-graph-supervisor-tools.js';

test('retries an epoch lookup that returns a retired driver after successful handover', async () => {
  const rootSessionId = 'epoch-race-root';
  const store = createSqliteSessionMetadataStore(':memory:');
  let delayNextLookup = false;
  let markCaptured!: () => void;
  let releaseLookup!: () => void;
  const captured = new Promise<void>((resolve) => {
    markCaptured = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const coordinator = new AgentGraphCoordinator({
    sessionStore: {
      listForRecovery: async () => [],
      readHeader: async (id) => ({ id, status: 'active', isArchived: false }) as never,
    },
    runtimeEventStore: {
      listSessionInvocations: async () => [],
      readImmutableRuntimeEvents: async () => [],
    },
    controlStore: store,
    epochStore: new Proxy(store, {
      get(target, property) {
        if (property === 'resolveCurrentAgentGraphEpoch') {
          return async (...args: Parameters<typeof store.resolveCurrentAgentGraphEpoch>) => {
            const result = await store.resolveCurrentAgentGraphEpoch(...args);
            if (delayNextLookup) {
              delayNextLookup = false;
              markCaptured();
              await released;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    runtime: {
      provisionAgentGraphOperator: async () => {
        throw new Error('Unexpected provision');
      },
      runClaimedAgentGraphIntent: async () => {
        throw new Error('Unexpected dispatch');
      },
      stopSession: async () => {},
    },
    newId: randomUUID,
  });
  try {
    const graphId = await coordinator.currentGraphId(rootSessionId);
    await store.commitAgentGraphScheduleUpdate(
      compileAgentGraphScheduleUpdate({
        graphId,
        input: { operation: 'finish', finish: { result_ids: ['result-1'], reason: 'Done.' } },
        context: {
          sessionId: rootSessionId,
          runId: 'root-run',
          turnId: 'root-turn',
          toolCallId: 'finish',
        },
      }),
    );
    await coordinator.reconcile(rootSessionId);
    delayNextLookup = true;
    const delayed = coordinator.reconcile(rootSessionId);
    await captured;
    const next = await coordinator.beginNextGraphEpoch(rootSessionId, (operation) => operation());
    assert.equal(next.epoch, 2);
    releaseLookup();
    const result = await delayed;
    assert.equal(result.schedule.graphId, next.graphId);
    assert.equal(result.schedule.revision, 0);
  } finally {
    releaseLookup();
    await coordinator.close();
    store.close();
  }
});
