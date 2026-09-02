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

/**
 * The invocation index is a query over the canonical events, not a second
 * record. This test writes real turns through the production seams and then
 * asks both authorities the same question: which invocations does this Session
 * have, and what route did each one open with?
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runtimeInvocationOpeningFromRunHeader } from '@maka/core/agent-run';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { createSessionStore } from '@maka/storage/session-store';
import type { SessionEvent } from '@maka/core/events';
import type { BackendSendInput } from '@maka/core/backend-types';
import { BackendRegistry, SessionManager } from '../session-manager.js';

test('the invocation index returns the same inventory as the Run header table', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-invocation-index-'));
  try {
    const sessionStore = createSessionStore(root);
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (ctx) => ({
      kind: 'ai-sdk' as const,
      sessionId: ctx.sessionId,
      async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
        yield {
          type: 'complete',
          id: `${input.turnId}-complete`,
          turnId: input.turnId,
          ts: 2,
          stopReason: 'end_turn',
        };
      },
      async stop() {},
      async respondToSandboxBoundary() {},
      async dispose() {},
    }));
    let ids = 0;
    let clock = 1_000;
    const manager = new SessionManager({
      store: sessionStore,
      runStore,
      runtimeEventStore,
      backends,
      newId: () => `index-${++ids}`,
      now: () => (clock += 1),
    });
    const session = await manager.createSession({
      cwd: root,
      llmConnectionSlug: 'fake',
      permissionMode: 'bypass',
    });

    for (const turnId of ['turn-1', 'turn-2', 'turn-3']) {
      for await (const _event of manager.sendMessage(session.id, { turnId, text: turnId })) {
        // Drain the turn so its run reaches the durable ledger.
      }
    }

    const runs = await runStore.listSessionRuns(session.id);
    const invocations = await runtimeEventStore.listSessionInvocations(session.id);
    assert.equal(runs.length, 3);

    assert.deepStrictEqual(
      invocations
        .map((invocation) => ({
          runId: invocation.runId,
          invocationId: invocation.invocationId,
          turnId: invocation.turnId,
        }))
        .sort((a, b) => a.runId.localeCompare(b.runId)),
      runs
        .map((run) => ({
          runId: run.runId,
          invocationId: run.invocationId ?? run.runId,
          turnId: run.turnId,
        }))
        .sort((a, b) => a.runId.localeCompare(b.runId)),
      'clearing the index and rebuilding from events must give the same inventory',
    );

    for (const run of runs) {
      const invocation = invocations.find((candidate) => candidate.runId === run.runId);
      assert.ok(invocation, `invocation for ${run.runId} must be enumerable from events alone`);
      assert.deepStrictEqual(
        invocation.opening,
        runtimeInvocationOpeningFromRunHeader(run),
        'replay provenance read from events must equal the header projection',
      );
      assert.equal(
        invocation.terminalEvent?.status,
        'completed',
        'a finished invocation must expose its terminal event through the index',
      );
    }

    runStore.close?.();
    runtimeEventStore.close();
    sessionStore.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
