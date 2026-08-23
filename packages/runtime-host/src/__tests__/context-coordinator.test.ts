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
