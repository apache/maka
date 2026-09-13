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
 * record. This test writes real turns through the production seams, then checks
 * that what the index answers is exactly what rebuilding from those events
 * alone produces.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import { runtimeInvocationsFromSessionEvents } from '@maka/core/runtime-invocation';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { createSessionStore } from '@maka/storage/session-store';
import type { SessionEvent } from '@maka/core/events';
import type { BackendSendInput } from '@maka/core/backend-types';
import { BackendRegistry, SessionManager } from '../session-manager.js';

test('the invocation index returns the same inventory as a rebuild from events alone', async () => {
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

    const invocations = await runtimeEventStore.listSessionInvocations(session.id);
    const rebuilt = runtimeInvocationsFromSessionEvents(
      session.id,
      await runtimeEventStore.readSessionRuntimeEvents(session.id),
    );
    assert.equal(invocations.length, 3);

    assert.deepStrictEqual(
      invocations,
      rebuilt,
      'the index must return exactly what a rebuild from events alone produces',
    );

    for (const invocation of invocations) {
      assert.equal(
        invocation.terminalEvent?.status,
        'completed',
        'a finished invocation must expose its terminal event through the index',
      );
    }

    // A ledger written before the store sealed runs can carry a straggler after
    // the terminal event: stop sealed the run while the stream was still
    // draining, and nothing has ever removed those. Recovery, the read model and
    // continuation resume all read such a run as ended, so the index must too —
    // reading it as active is what makes one reader disagree with the rest.
    const straggler = invocations[0]!;
    runtimeEventStore.close();
    const db = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    try {
      const { json } = encodeCanonicalRuntimeEvent({
        id: 'post-terminal-straggler',
        invocationId: straggler.invocationId,
        runId: straggler.runId,
        sessionId: session.id,
        turnId: straggler.turnId,
        ts: 9_999,
        partial: false,
        role: 'model',
        author: 'agent',
        modelVisibility: 'visible',
        content: { kind: 'text', text: 'arrived after the run was sealed' },
      });
      db.prepare(`
        INSERT INTO runtime_events (
          event_id, session_id, invocation_id, run_id, turn_id, event_seq,
          event_kind, payload_json, committed_at
        ) VALUES (?, ?, ?, ?, ?, (
          SELECT MAX(event_seq) + 1 FROM runtime_events WHERE invocation_id = ?
        ), 'text', ?, 9999)
      `).run(
        'post-terminal-straggler',
        session.id,
        straggler.invocationId,
        straggler.runId,
        straggler.turnId,
        straggler.invocationId,
        json,
      );
    } finally {
      db.close();
    }

    const reopened = createWorkspaceRuntimeStore(root);
    try {
      const afterStraggler = await reopened.listSessionInvocations(session.id);
      assert.deepStrictEqual(
        afterStraggler,
        runtimeInvocationsFromSessionEvents(
          session.id,
          await reopened.readSessionRuntimeEvents(session.id),
        ),
        'the index and a rebuild must still agree once a straggler follows the terminal',
      );
      assert.equal(
        afterStraggler.find((invocation) => invocation.invocationId === straggler.invocationId)
          ?.terminalEvent?.status,
        'completed',
        'a run that ended stays ended when an unsealed-era straggler follows it',
      );
    } finally {
      reopened.close();
    }

    runStore.close?.();
    sessionStore.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
