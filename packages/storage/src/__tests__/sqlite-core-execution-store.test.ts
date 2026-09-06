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
import type { EmittedAgentRunEvent } from '@maka/core/agent-run';
import { agentRunCompositionFromEvents } from '@maka/core/agent-run';
import type { RunCompositionSnapshot } from '@maka/core/run-composition';
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
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteShellRunStore } from '../shell-run-store.js';
import {
  removeTrackedControlDirectories,
  trackControlDirectory,
} from './fixtures/control-directory-hygiene.js';
import { openInvocation } from './fixtures/invocation-opening.js';

// The control directory of each resolved root lives outside that root, so a
// temporary root's removal leaves it behind; reclaim the recorded rootIds here.
after(removeTrackedControlDirectories);

describe('SQLite core execution stores', () => {
  test('persists AgentRun events against the invocation that opened them', async () => {
    await withRoot(async (root) => {
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
      await store.appendEvent('session-1', 'run-1', runEvent());
      store.close?.();

      const reopened = createSqliteAgentRunStore(root);
      try {
        assert.equal((await reopened.readEvents('session-1', 'run-1'))[0]?.id, 'event-1');
      } finally {
        reopened.close?.();
      }
    });
  });

  test('refuses to hang an event on a run no invocation ever opened', async () => {
    await withRoot(async (root) => {
      const store = createSqliteAgentRunStore(root);
      try {
        await assert.rejects(store.appendEvent('session-1', 'run-missing', runEvent()), {
          code: 'ENOENT',
        });
      } finally {
        store.close?.();
      }
    });
  });

  test('advances the model-call high-water index with the authority append', async () => {
    await withRoot(async (root) => {
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
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

  test('commits canonical authority without guessing a malformed projection order', async () => {
    await withRoot(async (root) => {
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
      await store.appendEvent(
        'session-1',
        'run-1',
        {
          ...runEvent(),
          id: 'model-call-newer',
          type: 'model_call_attempt_recorded',
          ts: 100,
          data: {
            ...modelCallAttempt({
              attemptId: 'attempt-newer',
              completedAt: 100,
              latencyMs: 99,
            }),
          },
        },
        {
          latestContext: {
            attemptId: 'attempt-newer',
            orderedAt: 100,
            snapshot: {
              schemaVersion: 2,
              attemptId: 'attempt-newer',
              providerId: 'openai',
              modelId: 'gpt-5',
              completedAt: 100,
            },
          },
        },
      );
      store.close?.();

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        database
          .prepare(`
            UPDATE core_agent_run_projections
            SET event_json = '{malformed'
            WHERE session_id = 'session-1' AND event_type = 'latest_context'
          `)
          .run();
      } finally {
        database.close();
      }

      const reopened = createSqliteAgentRunStore(root);
      try {
        await reopened.appendEvent(
          'session-1',
          'run-1',
          {
            ...runEvent(),
            id: 'model-call-older',
            type: 'model_call_attempt_recorded',
            ts: 50,
            data: {
              ...modelCallAttempt({
                logicalCallId: 'call-older',
                attemptId: 'attempt-older',
                traceId: 'trace-older',
                completedAt: 50,
                latencyMs: 49,
              }),
            },
          },
          {
            latestContext: {
              attemptId: 'attempt-older',
              orderedAt: 50,
              snapshot: {
                schemaVersion: 2,
                attemptId: 'attempt-older',
                providerId: 'openai',
                modelId: 'gpt-5',
                completedAt: 50,
              },
            },
          },
        );

        assert.ok(
          (await reopened.readEvents('session-1', 'run-1')).some(
            (event) => event.id === 'model-call-older',
          ),
        );
      } finally {
        reopened.close?.();
      }

      const inspected = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(
          inspected
            .prepare(`
              SELECT event_json AS eventJson
              FROM core_agent_run_projections
              WHERE session_id = 'session-1' AND event_type = 'latest_context'
            `)
            .get()?.eventJson,
          '{malformed',
          'unknown incumbent ordering stays untouched until a ledger rebuild can repair it',
        );
      } finally {
        inspected.close();
      }
    });
  });

  test('does not repair a malformed projection from a stale ledger revision', async () => {
    await withRoot(async (root) => {
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
      await store.appendEvent('session-1', 'run-1', runEvent());
      await store.repairEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
        {
          ...runEvent(),
          id: 'checkpoint-a',
          type: 'history_compact_checkpoint_recorded',
        },
        { ifLedgerRevision: await store.readEventLedgerRevision('session-1') },
      );

      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        database
          .prepare(`
            UPDATE core_agent_run_projections
            SET event_json = '{malformed'
            WHERE session_id = 'session-1'
              AND event_type = 'history_compact_checkpoint_recorded'
          `)
          .run();
      } finally {
        database.close();
      }

      const staleRevision = await store.readEventLedgerRevision('session-1');
      await store.appendEvent('session-1', 'run-1', {
        ...runEvent(),
        id: 'event-2',
        ts: 2,
      });
      await store.repairEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
        {
          ...runEvent(),
          id: 'checkpoint-a',
          type: 'history_compact_checkpoint_recorded',
        },
        { ifLedgerRevision: staleRevision },
      );

      const inspected = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
      try {
        assert.equal(
          inspected
            .prepare(`
              SELECT event_json AS eventJson
              FROM core_agent_run_projections
              WHERE session_id = 'session-1'
                AND event_type = 'history_compact_checkpoint_recorded'
            `)
            .get()?.eventJson,
          '{malformed',
        );
      } finally {
        inspected.close();
        store.close?.();
      }
    });
  });

  test('rejects a projection repair without a canonical ledger revision', async () => {
    await withRoot(async (root) => {
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
      await store.appendEvent('session-1', 'run-1', runEvent());
      const before = await store.readEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
      );

      await assert.rejects(
        // @ts-expect-error A repair must prove which canonical ledger revision it rebuilt.
        store.repairEventProjection('session-1', 'history_compact_checkpoint_recorded', {
          ...runEvent(),
          id: 'checkpoint-a',
          type: 'history_compact_checkpoint_recorded',
        }),
        /ledger revision/i,
      );

      assert.equal(
        await store.readEventProjection('session-1', 'history_compact_checkpoint_recorded'),
        before,
      );
      store.close?.();
    });
  });

  test('backfills the model-call high-water when upgrading existing AgentRun rows', async () => {
    await withRoot(async (root) => {
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
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

  test('drops obsolete Host-Epoch message receipt tables on upgrade', async () => {
    await withRoot(async (root) => {
      createSqliteAgentRunStore(root).close?.();
      const path = join(root, 'runtime.sqlite');
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE core_message_host_epochs (host_epoch TEXT PRIMARY KEY);
        CREATE TABLE core_message_receipts (
          host_epoch TEXT NOT NULL,
          operation TEXT NOT NULL,
          session_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          PRIMARY KEY (host_epoch, operation, session_id, operation_id)
        );
        UPDATE operational_schema_migrations SET version = 4 WHERE scope = 'core_execution';
      `);
      legacy.close();

      createSqliteAgentRunStore(root).close?.();
      const migrated = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(
          migrated
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'core_message_%'",
            )
            .all(),
          [],
        );
      } finally {
        migrated.close();
      }
    });
  });

  test('drops the obsolete AgentRun identity index on upgrade', async () => {
    await withRoot(async (root) => {
      createSqliteAgentRunStore(root).close?.();
      const path = join(root, 'runtime.sqlite');
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE INDEX IF NOT EXISTS core_agent_runs_identity
          ON core_agent_runs(run_id, session_id);
        UPDATE operational_schema_migrations SET version = 5 WHERE scope = 'core_execution';
      `);
      legacy.close();

      createSqliteAgentRunStore(root).close?.();
      const migrated = new DatabaseSync(path, { readOnly: true });
      try {
        assert.deepEqual(
          migrated
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'core_agent_runs_identity'",
            )
            .all(),
          [],
        );
      } finally {
        migrated.close();
      }
    });
  });

  test('preserves provider failure diagnostics in the AgentRun authority after reopen', async () => {
    await withRoot(async (root) => {
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
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
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
      try {
        const composition = runComposition('1');
        await store.appendEvent('session-1', 'run-1', compositionEvent('event-1', composition));
        await store.appendEvent('session-1', 'run-1', compositionEvent('event-2', composition));
        const events = await store.readEvents('session-1', 'run-1');
        assert.deepEqual(agentRunCompositionFromEvents(events), composition);
        assert.equal(
          events.filter((event) => event.type === 'run_composition_recorded').length,
          1,
          'an identical re-append is the writer retrying, not a second composition',
        );
        await assert.rejects(
          store.appendEvent('session-1', 'run-1', compositionEvent('event-3', runComposition('2'))),
          /AgentRun Run Composition is immutable/u,
        );
      } finally {
        store.close?.();
      }
    });
  });

  test('reads an AgentRun event type this build does not write', async () => {
    await withRoot(async (root) => {
      await openRun(root);
      const store = createSqliteAgentRunStore(root);
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

function openRun(root: string): Promise<void> {
  return openInvocation(root, { sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1' });
}

function runEvent(): EmittedAgentRunEvent {
  return {
    type: 'turn_started',
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

function compositionEvent(id: string, composition: RunCompositionSnapshot): EmittedAgentRunEvent {
  return {
    type: 'run_composition_recorded',
    id,
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 5,
    data: { runComposition: composition },
  };
}

function runComposition(seed: string): RunCompositionSnapshot {
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
