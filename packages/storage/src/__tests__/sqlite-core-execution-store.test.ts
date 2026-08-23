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
import { after, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { AgentRunHeader, EmittedAgentRunEvent } from '@maka/core/agent-run';
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  decodeModelCallAttempt,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { InteractionCanonicalOutcome, InteractionRequest } from '@maka/core/interaction';
import type { ShellRunRecord } from '@maka/core/shell-run';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import {
  closeSqliteInteractionStoreFacade,
  openSqliteInteractiveInteractionStoreForWrite,
  type StoredInteractionRequest,
} from '../interaction-store.js';
import { createSqliteMessageReceiptStore } from '../message-receipt-store.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteShellRunStore } from '../shell-run-store.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

describe('SQLite core execution stores', () => {
  test('persists AgentRun header and events', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      await store.createRun(runHeader());
      await store.appendEvent('session-1', 'run-1', runEvent());
      store.close?.();

      const reopened = createSqliteAgentRunStore(root);
      try {
        assert.equal((await reopened.readRun('session-1', 'run-1')).runId, 'run-1');
        assert.equal((await reopened.readEvents('session-1', 'run-1'))[0]?.id, 'event-1');
      } finally {
        reopened.close?.();
      }
    });
  });

  test('advances the model-call high-water index with the authority append', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      await store.createRun(runHeader());
      await store.appendEvent('session-1', 'run-1', runEvent());
      await store.appendEvent('session-1', 'run-1', {
        ...runEvent(),
        id: 'model-call-event',
        type: 'model_call_attempt_recorded',
        data: { ...modelCallAttempt() },
      });

      const database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(
          database
            .prepare(`
              SELECT latest_model_call_sequence AS sequence
              FROM core_agent_runs
              WHERE session_id = 'session-1' AND run_id = 'run-1'
            `)
            .get()?.sequence,
          1,
        );
      } finally {
        database.close();
        store.close?.();
      }
    });
  });

  test('backfills the model-call high-water when upgrading existing AgentRun rows', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      await store.createRun(runHeader());
      await store.appendEvent('session-1', 'run-1', {
        ...runEvent(),
        id: 'legacy-model-call-event',
        type: 'model_call_attempt_recorded',
        data: { ...modelCallAttempt() },
      });
      store.close?.();

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      database.exec(`
        DROP INDEX core_agent_runs_model_call_high_water;
        ALTER TABLE core_agent_runs DROP COLUMN latest_model_call_sequence;
        UPDATE operational_schema_migrations SET version = 3 WHERE scope = 'core_execution';
      `);
      database.close();

      const migrated = createSqliteAgentRunStore(root);
      try {
        const inspected = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
        try {
          assert.equal(
            inspected
              .prepare(`
                SELECT latest_model_call_sequence AS sequence
                FROM core_agent_runs
                WHERE session_id = 'session-1' AND run_id = 'run-1'
              `)
              .get()?.sequence,
            0,
          );
        } finally {
          inspected.close();
        }
      } finally {
        migrated.close?.();
      }
    });
  });

  test('pages AgentRuns by stable creation and run identity order', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      try {
        await store.createRun(runHeader({ runId: 'run-a', turnId: 'turn-a', createdAt: 1 }));
        await store.createRun(runHeader({ runId: 'run-b', turnId: 'turn-b', createdAt: 2 }));
        await store.createRun(runHeader({ runId: 'run-c', turnId: 'turn-c', createdAt: 2 }));

        const first = await store.listSessionRunsPage('session-1', { limit: 2 });
        assert.deepEqual(
          first.runs.map((run) => run.runId),
          ['run-c', 'run-b'],
        );
        assert.deepEqual(first.nextCursor, { createdAt: 2, runId: 'run-b' });

        await store.createRun(runHeader({ runId: 'run-d', turnId: 'turn-d', createdAt: 3 }));
        const older = await store.listSessionRunsPage('session-1', {
          limit: 2,
          before: first.nextCursor ?? undefined,
        });
        assert.deepEqual(
          older.runs.map((run) => run.runId),
          ['run-a'],
        );
        assert.equal(older.nextCursor, null);
      } finally {
        store.close?.();
      }
    });
  });

  test('rejects a non-finite AgentRun page cursor', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      try {
        await assert.rejects(
          store.listSessionRunsPage('session-1', {
            limit: 1,
            before: { createdAt: Number.NaN, runId: 'run-1' },
          }),
          /Invalid AgentRun page cursor/u,
        );
      } finally {
        store.close?.();
      }
    });
  });

  test('preserves provider failure diagnostics in the AgentRun authority after reopen', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      await store.createRun(runHeader());
      await store.appendEvent('session-1', 'run-1', {
        type: 'model_call_attempt_recorded',
        id: 'attempt-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ts: 10,
        data: {
          ...modelCallAttempt({
            callKind: 'history_compact',
            historyCompactRoute: 'provider_native',
            connectionSlug: 'codex-subscription',
            providerId: 'openai-codex',
            modelId: 'gpt-5.6-sol',
            completedAt: 10,
            latencyMs: 9,
            status: 'failed',
            errorClass: 'RequestRejected',
            httpStatus: 400,
            providerCode: 'invalid_request_error',
            providerRequestId: 'req-authority-1',
            retryable: false,
            usageBasis: 'missing',
            inputTokens: undefined,
            outputTokens: undefined,
            costBasis: 'unpriced',
            costUsd: undefined,
          }),
        },
      });
      store.close?.();

      const reopened = createSqliteAgentRunStore(root);
      try {
        const event = (await reopened.readEvents('session-1', 'run-1'))[0];
        const attempt = decodeModelCallAttempt(event?.data);
        assert.equal(attempt.historyCompactRoute, 'provider_native');
        assert.equal(attempt.httpStatus, 400);
        assert.equal(attempt.providerRequestId, 'req-authority-1');
      } finally {
        reopened.close?.();
      }
    });
  });

  test('commits one immutable Run Composition snapshot', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      try {
        await store.createRun(runHeader());
        const composition = runComposition('1');
        await store.updateRun('session-1', 'run-1', { runComposition: composition });
        await store.updateRun('session-1', 'run-1', { runComposition: composition });
        assert.deepEqual((await store.readRun('session-1', 'run-1')).runComposition, composition);
        await assert.rejects(
          store.updateRun('session-1', 'run-1', { runComposition: runComposition('2') }),
          /AgentRun Run Composition is immutable/u,
        );
      } finally {
        store.close?.();
      }
    });
  });

  test('reads an AgentRun event type this build does not write', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      await store.createRun(runHeader());
      await store.appendEvent('session-1', 'run-1', runEvent());
      store.close?.();

      // Rewrite the stored row into what a build that still had this writer would have left
      // behind. Going through the database rather than appendEvent is the point: this build
      // must be able to read a record it is no longer allowed to produce (#1942).
      const db = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        const record = {
          ...runEvent(),
          type: 'written_by_another_version',
          data: { inputTokens: 7 },
        };
        db.prepare(
          `UPDATE core_agent_run_events SET event_type = ?, record_json = ? WHERE event_id = ?`,
        ).run('written_by_another_version', JSON.stringify(record), 'event-1');
      } finally {
        db.close();
      }

      const reopened = createSqliteAgentRunStore(root);
      try {
        const events = await reopened.readEvents('session-1', 'run-1');
        assert.deepEqual(
          events.map((event) => event.type),
          ['written_by_another_version'],
        );
        assert.equal(events[0]?.data?.inputTokens, 7);

        const recovered = await reopened.readEventsForRecovery('session-1', 'run-1');
        assert.deepEqual(
          recovered.map((event) => event.type),
          ['written_by_another_version'],
        );
      } finally {
        reopened.close?.();
      }
    });
  });

  test('persists ShellRun records', async () => {
    await withRoot(async (root) => {
      const store = createSqliteShellRunStore(root);
      await store.createShellRun(shellRun());
      store.close();

      const reopened = createSqliteShellRunStore(root);
      try {
        assert.equal((await reopened.readShellRun('session-1', 'shell-1')).command, 'printf "ok"');
      } finally {
        reopened.close();
      }
    });
  });

  test('reports a missing ShellRun with the ENOENT store contract', async () => {
    await withRoot(async (root) => {
      const store = createSqliteShellRunStore(root);
      try {
        await assert.rejects(store.readShellRun('session-1', 'missing-shell'), { code: 'ENOENT' });
      } finally {
        store.close();
      }
    });
  });

  test('persists message receipts', async () => {
    await withRoot(async (root) => {
      const store = createSqliteMessageReceiptStore(root);
      await store.beginHostEpoch('epoch-1');
      await store.commit('epoch-1', 'submit', 'session-1', 'operation-1', {
        payload: { text: 'hello' },
        result: { disposition: 'turn_started', turnId: 'turn-1' },
      });
      store.close();

      const reopened = createSqliteMessageReceiptStore(root);
      try {
        assert.deepEqual(
          (await reopened.read('epoch-1', 'submit', 'session-1', 'operation-1'))?.payload,
          { text: 'hello' },
        );
      } finally {
        reopened.close();
      }
    });
  });

  test('persists interaction request and outcome', async () => {
    await withRoot(async (root) => {
      const capability = trackControlDirectory(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const store = await openSqliteInteractiveInteractionStoreForWrite(owner.lease);
      try {
        await store.establishRequest(storedQuestion());
        await store.commitOutcome('request-1', questionOutcome());
        assert.equal(
          (await store.readInteraction('request-1'))?.outcome?.outcome.kind,
          'question_answer',
        );
      } finally {
        closeSqliteInteractionStoreFacade(store);
        await owner.close();
      }
    });
  });
});

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-execution-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function runEvent(): EmittedAgentRunEvent {
  return {
    type: 'run_started',
    id: 'event-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
  };
}

function modelCallAttempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main' as const,
    providerId: 'openai',
    modelId: 'gpt-5',
    startedAt: 1,
    completedAt: 2,
    latencyMs: 1,
    status: 'completed' as const,
    usageBasis: 'reported' as const,
    inputTokens: 1,
    outputTokens: 1,
    costBasis: 'priced' as const,
    costUsd: 0.001,
    ...overrides,
  };
}

function runComposition(seed: string): NonNullable<AgentRunHeader['runComposition']> {
  return {
    schemaVersion: 1,
    composerId: 'maka.interactive',
    composerRevision: '1',
    sourceRevisions: [
      { id: 'runtime-policy', revision: '1' },
      { id: 'skill-catalog', revision: 'skills-1' },
    ],
    baseSystemPromptHash: hash(seed),
    toolCatalogHash: hash(seed),
    toolAvailabilityHash: hash(seed),
    baseProviderOptionsHash: hash(seed),
    toolNames: ['Read'],
    contextWindow: 128_000,
  };
}

function hash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64)}`;
}

function shellRun(): ShellRunRecord {
  return {
    shellRunId: 'shell-1',
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: 'printf "ok"',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

function storedQuestion(): StoredInteractionRequest {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    requestId: 'request-1',
    createdAt: 1,
    request: {
      kind: 'question',
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Choose',
          options: [
            { label: 'First', description: 'First' },
            { label: 'Second', description: 'Second' },
          ],
        },
      ],
    } as InteractionRequest,
  };
}

function questionOutcome(): InteractionCanonicalOutcome {
  return {
    kind: 'question_answer',
    answers: ['First'],
    committedAt: 2,
  } as InteractionCanonicalOutcome;
}
