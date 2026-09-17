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
import { DatabaseSync } from 'node:sqlite';
import type { UsageScreen, UsageScreenRequest } from '@maka/core/settings';
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { MODEL_CALL_ATTEMPT_SCHEMA_VERSION } from '@maka/core/model-call-attempt';
import {
  PricingCommitUnknownError,
  PricingRevisionConflictError,
  PricingStoreClosedError,
  PricingStoreNotLoadedError,
  PricingStorePublicationError,
  PricingValidationError,
} from '../pricing-store.js';
import {
  resolveStorageRoot,
  STORAGE_ROOT_MARKER_FILE,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootReader,
  tryAcquireInteractiveRootOwner,
  type StorageRootAuthorityErrorCode,
} from '../root-authority.js';
import {
  TelemetryQueryValidationError,
  TelemetryRepoClosedError,
  TelemetryRepoNotLoadedError,
  TelemetryRepoPublicationError,
} from '../telemetry-repo.js';
import {
  classifyInteractiveUsageStoresFailure,
  InteractiveUsageStoresClosedError,
  openInteractiveUsageStoresForRead,
  openInteractiveUsageStoresForWrite,
} from '../usage-stores.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import { removeControlDirectory } from './fixtures/control-directory-hygiene.js';

describe('InteractiveUsageStores', () => {
  test('classifies facade failures without exposing concrete errors to callers', () => {
    assert.deepEqual(
      classifyInteractiveUsageStoresFailure(new PricingRevisionConflictError(3, 4)),
      { kind: 'revision_conflict', expectedRevision: 3, actualRevision: 4 },
    );
    for (const error of [
      new PricingValidationError('bad mutation'),
      new TelemetryQueryValidationError('bad query'),
    ]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'invalid_request',
      });
    }
    for (const error of [
      new InteractiveUsageStoresClosedError(),
      new PricingStoreClosedError(),
      new TelemetryRepoClosedError(),
      new StorageRootAuthorityError('invalid_lease', 'revoked'),
      new StorageRootAuthorityError('invalid_owner', 'inauthentic'),
    ]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'lifecycle',
      });
    }
    for (const error of [
      new PricingCommitUnknownError({ cause: new Error('directory sync') }),
      new TelemetryRepoPublicationError(true, { cause: new Error('directory sync') }),
    ]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'commit_outcome_unknown',
        needsDrain: true,
      });
    }
    for (const error of [
      new PricingStorePublicationError({ cause: new Error('rename') }),
      new TelemetryRepoPublicationError(false, { cause: new Error('rename') }),
    ]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'persistence_failed',
        needsDrain: true,
      });
    }
    for (const error of [new PricingStoreNotLoadedError(), new TelemetryRepoNotLoadedError()]) {
      assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
        kind: 'persistence_failed',
        needsDrain: false,
      });
    }
    const rootAuthorityNeedsDrain = {
      invalid_root: false,
      invalid_root_kind: false,
      root_not_found: false,
      root_unmarked: true,
      invalid_marker: true,
      root_identity_collision: true,
      root_identity_changed: true,
      invalid_repair: false,
      invalid_capability: false,
      invalid_lock_artifact: false,
      insecure_control_directory: false,
      root_io_failed: false,
      control_io_failed: false,
      lock_failed: false,
    } as const satisfies Record<
      Exclude<StorageRootAuthorityErrorCode, 'invalid_lease' | 'invalid_owner'>,
      boolean
    >;
    for (const [code, needsDrain] of Object.entries(rootAuthorityNeedsDrain)) {
      assert.deepEqual(
        classifyInteractiveUsageStoresFailure(
          new StorageRootAuthorityError(code as StorageRootAuthorityErrorCode, code),
        ),
        { kind: 'persistence_failed', needsDrain },
      );
    }

    const unknown = new Error('unknown');
    assert.deepEqual(classifyInteractiveUsageStoresFailure(unknown), {
      kind: 'unknown',
      error: unknown,
    });
  });

  test('seeds an empty pricing authority for a fresh workspace', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      try {
        assert.deepEqual(await stores.pricing.snapshot(), { revision: 0, overrides: [] });
      } finally {
        await stores.close();
        await owner.close();
      }
    });
  });

  test('publishes the owning Session after each durable model-usage write', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      const changed: string[] = [];
      const unsubscribe = stores.subscribeSessionUsageChanges((sessionId) =>
        changed.push(sessionId),
      );
      try {
        await stores.telemetry.recordLlmCall(llmRecord({ sessionId: 'session-legacy' }));
        appendModelCallAuthorityEvent(root, modelCallAttempt('session-canonical'));
        await stores.modelCalls.catchUpModelCallProjection({ sessionId: 'session-canonical' });
        assert.deepEqual(changed, ['session-legacy', 'session-canonical']);
      } finally {
        unsubscribe();
        await stores.close();
        await owner.close();
      }
    });
  });

  test('publishes the owning Session after a durable tool-usage write', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      const changed: string[] = [];
      const unsubscribe = stores.subscribeSessionUsageChanges((sessionId) =>
        changed.push(sessionId),
      );
      try {
        // A session whose last activity is a tool invocation must still see the
        // usage summary refresh — the trace panel's time ring reads the
        // summary on exactly this signal.
        await stores.telemetry.recordToolInvocation(toolRecord({ sessionId: 'session-tool' }));
        assert.deepEqual(changed, ['session-tool']);
      } finally {
        unsubscribe();
        await stores.close();
        await owner.close();
      }
    });
  });

  test('does not republish idempotent model-usage mutations', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      const changed: string[] = [];
      const unsubscribe = stores.subscribeSessionUsageChanges((sessionId) =>
        changed.push(sessionId),
      );
      try {
        const record = modelCallAttempt('session-idempotent');
        appendModelCallAuthorityEvent(root, record);
        await stores.modelCalls.catchUpModelCallProjection({ sessionId: 'session-idempotent' });
        await stores.modelCalls.catchUpModelCallProjection({ sessionId: 'session-idempotent' });

        assert.deepEqual(changed, ['session-idempotent']);
      } finally {
        unsubscribe();
        await stores.close();
        await owner.close();
      }
    });
  });

  test('classifies a renamed or replaced live root as a draining persistence failure', {
    skip:
      process.platform === 'win32'
        ? 'Windows does not permit renaming a directory with an open SQLite database'
        : false,
  }, async () => {
    for (const replacement of [false, true]) {
      await withInteractiveRoot(async ({ root, capability }) => {
        const owner = await tryAcquireInteractiveRootOwner(capability);
        assert(owner);
        const stores = await openInteractiveUsageStoresForWrite(owner.lease);
        try {
          await rename(root, `${root}-moved`);
          if (replacement) await mkdir(root);
          await assert.rejects(
            () => stores.pricing.snapshot(),
            (error: unknown) => {
              assert.ok(error instanceof StorageRootAuthorityError);
              assert.equal(error.code, 'root_identity_changed');
              assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
                kind: 'persistence_failed',
                needsDrain: true,
              });
              return true;
            },
          );
        } finally {
          await stores.close();
          await owner.close();
        }
      });
    }
  });

  test('classifies poisoned live root markers as draining persistence failures', async () => {
    const scenarios: ReadonlyArray<{
      code: 'root_unmarked' | 'invalid_marker';
      poison(markerPath: string): Promise<void>;
    }> = [
      {
        code: 'root_unmarked',
        poison: (markerPath) => rm(markerPath),
      },
      {
        code: 'invalid_marker',
        poison: (markerPath) => writeFile(markerPath, '{'),
      },
      {
        code: 'invalid_marker',
        poison: async (markerPath) => {
          const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { kind: string };
          marker.kind = 'retired_kind';
          await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
        },
      },
    ];

    for (const scenario of scenarios) {
      await withInteractiveRoot(async ({ root, capability }) => {
        const owner = await tryAcquireInteractiveRootOwner(capability);
        assert(owner);
        const stores = await openInteractiveUsageStoresForWrite(owner.lease);
        await scenario.poison(join(root, STORAGE_ROOT_MARKER_FILE));
        try {
          await assert.rejects(
            () => stores.pricing.snapshot(),
            (error: unknown) => {
              assert.ok(error instanceof StorageRootAuthorityError);
              assert.equal(error.code, scenario.code);
              assert.deepEqual(classifyInteractiveUsageStoresFailure(error), {
                kind: 'persistence_failed',
                needsDrain: true,
              });
              return true;
            },
          );
        } finally {
          await stores.close();
          await owner.close();
        }
      });
    }
  });

  test('drain waits accepted writes and rejects new admission', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      const accepted = stores.telemetry.recordLlmCall(llmRecord());
      const drained = stores.beginDrain();

      assert.throws(
        () => stores.telemetry.recordToolInvocation(toolRecord()),
        InteractiveUsageStoresClosedError,
      );
      await Promise.all([accepted, drained]);
      await stores.close();
      await assert.rejects(
        () => readFile(join(root, 'telemetry.json'), 'utf8'),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      await owner.close();
      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert(successor);
      const reopened = await openInteractiveUsageStoresForWrite(successor.lease);
      assert.equal((await reopened.telemetry.logs({ range: 'all' })).rows[0]?.id, 'usage_1');
      await reopened.close();
      await successor.close();
    });
  });

  test('lease-bound facade exposes separate LLM and filtered tool logs', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await stores.telemetry.recordLlmCall(llmRecord());
      await stores.telemetry.recordToolInvocation(toolRecord());

      assert.equal((await stores.telemetry.logs({ range: 'all' })).total, 1);
      const tools = await stores.telemetry.toolLogs({
        range: 'all',
        toolName: 'Bash',
        status: 'success',
      });
      assert.equal(tools.total, 1);
      assert.equal(tools.rows[0]?.toolName, 'Bash');
      await assert.rejects(
        () => stores.telemetry.logs({ range: 'all', toolName: 'Bash' }),
        /toolName is not applicable to LLM logs/,
      );
      await stores.close();
      await owner.close();
    });
  });

  test('legacy summary clamps each cache reading to its own input', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await stores.telemetry.recordLlmCall(
        llmRecord({
          id: 'malformed-cache',
          inputTokens: 100,
          cacheHitInputTokens: 200,
          cachedInputTokens: 200,
        }),
      );
      await stores.telemetry.recordLlmCall(
        llmRecord({ id: 'cache-miss', inputTokens: 100, cacheHitInputTokens: 0 }),
      );
      await stores.telemetry.recordLlmCall(
        llmRecord({
          id: 'impossible-cache-hit',
          inputTokens: 0,
          cacheHitInputTokens: 1,
          cachedInputTokens: 1,
          cacheMissInputTokens: 0,
        }),
      );

      const summary = await stores.telemetry.summary({ range: 'all' });
      assert.equal(summary.totalTokens.input, 200);
      assert.equal(summary.totalTokens.cacheRead, 100);
      assert.equal(summary.cacheHitRequests, 1);

      await stores.close();
      await owner.close();
    });
  });

  test('legacy usage buckets clamp each cache reading to its own input', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await stores.telemetry.recordLlmCall(
        llmRecord({
          inputTokens: 100,
          cacheHitInputTokens: 200,
          cachedInputTokens: 200,
        }),
      );

      const buckets = await stores.telemetry.buckets({ range: 'all' }, 'model');
      assert.equal(buckets[0]?.cacheReadTokens, 100);

      await stores.close();
      await owner.close();
    });
  });

  test('legacy summary reads only the requested Session', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await stores.telemetry.recordLlmCall(
        llmRecord({ id: 'session-a-call', sessionId: 'session-a', costUsd: 1 }),
      );
      await stores.telemetry.recordLlmCall(
        llmRecord({ id: 'session-b-call', sessionId: 'session-b', costUsd: 9 }),
      );

      const summary = await stores.telemetry.summary({
        range: 'all',
        sessionId: 'session-a',
      });
      assert.equal(summary.totalRequests, 1);
      assert.equal(summary.totalCostUsd, 1);

      await stores.close();
      await owner.close();
    });
  });

  test('legacy summary sums recorded call time over the same rows as its tokens', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await stores.telemetry.recordLlmCall(llmRecord({ id: 'call-a', latencyMs: 1_200 }));
      await stores.telemetry.recordLlmCall(llmRecord({ id: 'call-b', latencyMs: 300 }));

      const summary = await stores.telemetry.summary({ range: 'all' });
      assert.equal(summary.totalDurationMs, 1_500);

      await stores.close();
      await owner.close();
    });
  });

  test('tool summary scopes to the requested Session and range', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await stores.telemetry.recordToolInvocation(
        toolRecord({ id: 'tool-a', sessionId: 'session-a', durationMs: 120 }),
      );
      await stores.telemetry.recordToolInvocation(
        toolRecord({ id: 'tool-b', sessionId: 'session-b', durationMs: 80 }),
      );

      const sessionA = await stores.telemetry.toolSummary({
        range: 'all',
        sessionId: 'session-a',
      });
      assert.deepEqual(sessionA, { requests: 1, durationMs: 120 });

      // Without a session filter the ledger answers with everything in range —
      // the same contract the tool buckets follow.
      const everySession = await stores.telemetry.toolSummary({ range: 'all' });
      assert.deepEqual(everySession, { requests: 2, durationMs: 200 });

      const empty = await stores.telemetry.toolSummary({
        range: { from: 0, to: 1 },
        sessionId: 'session-a',
      });
      assert.deepEqual(empty, { requests: 0, durationMs: 0 });

      await stores.close();
      await owner.close();
    });
  });

  test('tool summary applies the full summary query to the tool rows', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await stores.telemetry.recordToolInvocation(
        toolRecord({
          id: 'tool-openai-ok',
          sessionId: 'session-a',
          toolName: 'Bash',
          providerId: 'openai',
          modelId: 'gpt-5',
          status: 'success',
          durationMs: 100,
        }),
      );
      await stores.telemetry.recordToolInvocation(
        toolRecord({
          id: 'tool-anthropic-err',
          sessionId: 'session-a',
          toolName: 'Read',
          providerId: 'anthropic',
          modelId: 'claude-opus-5',
          status: 'error',
          durationMs: 300,
        }),
      );

      // The tool ring sits beside the model totals under one query, so a
      // filter the rows can answer must narrow both sides the same way.
      const provider = await stores.telemetry.toolSummary({
        range: 'all',
        sessionId: 'session-a',
        providerId: 'openai',
      });
      assert.deepEqual(provider, { requests: 1, durationMs: 100 });

      const status = await stores.telemetry.toolSummary({
        range: 'all',
        sessionId: 'session-a',
        status: 'error',
      });
      assert.deepEqual(status, { requests: 1, durationMs: 300 });

      const model = await stores.telemetry.toolSummary({
        range: 'all',
        sessionId: 'session-a',
        modelId: 'gpt-5',
      });
      assert.deepEqual(model, { requests: 1, durationMs: 100 });

      const tool = await stores.telemetry.toolSummary({
        range: 'all',
        sessionId: 'session-a',
        toolName: 'Read',
      });
      assert.deepEqual(tool, { requests: 1, durationMs: 300 });

      await stores.close();
      await owner.close();
    });
  });

  test('tool buckets answer the full summary query, including Session and provider', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      // Two rows share provider and model, so only the session (and the tool
      // name) can tell them apart — the bucket view must apply the same
      // filters the summary beside it applies.
      await stores.telemetry.recordToolInvocation(
        toolRecord({
          id: 'bucket-session-a',
          sessionId: 'session-a',
          toolName: 'Bash',
          providerId: 'openai',
          modelId: 'gpt-5',
          durationMs: 100,
        }),
      );
      await stores.telemetry.recordToolInvocation(
        toolRecord({
          id: 'bucket-session-b',
          sessionId: 'session-b',
          toolName: 'Bash',
          providerId: 'openai',
          modelId: 'gpt-5',
          durationMs: 400,
        }),
      );

      const scoped = await stores.telemetry.buckets(
        { range: 'all', sessionId: 'session-a', providerId: 'openai' },
        'tool',
      );
      assert.deepEqual(
        scoped.map((bucket) => [bucket.key, bucket.requests, bucket.avgLatencyMs]),
        [['Bash', 1, 100]],
      );

      await stores.close();
      await owner.close();
    });
  });

  test('every facade read observes lease revocation', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const stores = await openInteractiveUsageStoresForWrite(owner.lease);
      await owner.close();

      await assert.rejects(
        () => stores.telemetry.summary({ range: 'all' }),
        (error) => error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      await assert.rejects(
        () => stores.pricing.snapshot(),
        (error) => error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      await stores.close();
    });
  });

  test('reader close releases local resources after lease revocation', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert(owner);
      const writer = await openInteractiveUsageStoresForWrite(owner.lease);
      await writer.close();
      await owner.close();

      const readerOwner = await tryAcquireInteractiveRootReader(capability);
      assert(readerOwner);
      const reader = await openInteractiveUsageStoresForRead(readerOwner.lease);
      await readerOwner.close();

      await assert.rejects(
        () => reader.pricing.snapshot(),
        (error) => error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
      );
      await reader.close();
    });
  });
});

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-usage-stores-'));
  try {
    const root = join(base, 'interactive');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    try {
      await run({ root, capability });
    } finally {
      await removeControlDirectory(capability.rootId);
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function llmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage_1',
    providerId: 'openai',
    modelId: 'gpt-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 100,
    ...overrides,
  } as Parameters<
    Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>['telemetry']['recordLlmCall']
  >[0];
}

function toolRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool_1',
    toolName: 'Bash',
    durationMs: 30,
    status: 'success',
    bytesIn: 1,
    bytesOut: 2,
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1),
    ...overrides,
  } as Parameters<
    Awaited<
      ReturnType<typeof openInteractiveUsageStoresForWrite>
    >['telemetry']['recordToolInvocation']
  >[0];
}

function modelCallAttempt(sessionId: string) {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId,
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
  };
}

function appendModelCallAuthorityEvent(
  root: string,
  value: ReturnType<typeof modelCallAttempt>,
): void {
  const lease = acquireOperationalStateDatabase(root);
  try {
    lease.transaction('write', () => {
      lease.database
        .prepare(`
          INSERT INTO core_agent_runs(session_id, run_id, created_at)
          VALUES (?, ?, 0)
        `)
        .run(value.sessionId, value.runId);
      lease.database
        .prepare(`
          INSERT INTO core_agent_run_events(
            session_id, run_id, sequence, event_id, event_type, event_ts, record_json
          ) VALUES (?, ?, 0, 'model-call-1', 'model_call_attempt_recorded', 0, ?)
        `)
        .run(
          value.sessionId,
          value.runId,
          JSON.stringify({
            id: 'model-call-1',
            type: 'model_call_attempt_recorded',
            ts: 0,
            sessionId: value.sessionId,
            runId: value.runId,
            turnId: value.turnId,
            data: value,
          }),
        );
      lease.database
        .prepare(`
          UPDATE core_agent_runs SET latest_model_call_sequence = 0
          WHERE session_id = ? AND run_id = ?
        `)
        .run(value.sessionId, value.runId);
    });
  } finally {
    lease.close();
  }
}

const screenQuery = {
  range: { from: 0, to: Date.UTC(2030, 0, 1) },
  search: '',
  status: 'all' as const,
};
function continuation(screen: UsageScreen): Extract<UsageScreenRequest, { kind: 'activity' }> {
  assert.ok(screen.nextCursor);
  return {
    kind: 'activity',
    query: screen.query,
    revision: screen.revision,
    queryIdentity: screen.queryIdentity,
    cursor: screen.nextCursor,
  };
}
async function withScreenStores(
  run: (
    stores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>,
    root: string,
  ) => Promise<void>,
) {
  await withInteractiveRoot(async ({ root, capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const stores = await openInteractiveUsageStoresForWrite(owner.lease);
    try {
      await run(stores, root);
    } finally {
      await stores.close();
      await owner.close();
    }
  });
}
async function initialScreen(
  stores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>,
  query = screenQuery,
) {
  const result = await stores.readUsageScreen({ kind: 'screen', query });
  assert.equal(result.kind, 'screen');
  assert.ok(result.kind === 'screen');
  return result.screen;
}
async function seedScreen(stores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>) {
  for (let i = 0; i < 61; i++)
    await stores.telemetry.recordLlmCall(llmRecord({ id: `legacy-${i}` }));
}

describe('revision-consistent Usage screen', () => {
  test('SQL totals and connection/model/tool groups preserve canonical and legacy accounting', async () => {
    await withScreenStores(async (stores, root) => {
      await stores.telemetry.recordLlmCall(
        llmRecord({
          connectionSlug: 'custom',
          cacheHitInputTokens: 100,
          cachedInputTokens: 100,
          sessionId: 's',
        }),
      );
      await stores.telemetry.recordToolInvocation(
        toolRecord({ toolName: 'Read', status: 'error' }),
      );
      appendModelCallAuthorityEvent(root, modelCallAttempt('canonical-session'));
      await stores.modelCalls.catchUpModelCallProjection();
      const screen = await initialScreen(stores);
      const legacy = await stores.telemetry.summary({ range: screenQuery.range });
      const canonical = (
        await stores.modelCalls.modelCallSummary({ range: screenQuery.range }, screenQuery.range.to)
      ).projection;
      assert.equal(screen.summary.totalRequests, legacy.totalRequests + canonical.totalRequests);
      assert.equal(screen.summary.totalCostUsd, legacy.totalCostUsd + canonical.totalCostUsd);
      assert.equal(
        screen.summary.totalTokens,
        legacy.totalTokens.total + canonical.totalTokens.total,
      );
      assert.equal(screen.summary.cacheRead, 10);
      assert.deepEqual(screen.byProvider.map((row) => row.provider).sort(), ['custom', 'openai']);
      assert.deepEqual(screen.byModel, [
        { model: 'gpt-5', requests: 2, tokens: 32, costUsd: 0.002 },
      ]);
      assert.deepEqual(screen.byTool, [
        { tool: 'Read', calls: 1, errors: 1, success: 0, avgDurationMs: 30 },
      ]);
      assert.equal(screen.provenance.legacyRecords, 1);
      assert.equal(screen.provenance.coverage.pricedAttempts, 1);
      const db = acquireOperationalStateDatabase(root);
      try {
        db.database.exec(
          "UPDATE usage_model_call_attempts SET cost_basis = 'unpriced', cost_usd = NULL",
        );
        const unpriced = await initialScreen(stores);
        assert.equal(unpriced.provenance.coverage.unpricedAttempts, 1);
        assert.equal(
          Object.hasOwn(unpriced.logs.find((row) => row.id === 'attempt-1')!, 'costUsd'),
          false,
        );
        db.database.exec(
          "UPDATE usage_model_call_attempts SET cost_basis = 'priced', cost_usd = 0",
        );
        assert.equal(
          (await initialScreen(stores)).logs.find((row) => row.id === 'attempt-1')?.costUsd,
          0,
        );
        db.database.exec("DELETE FROM core_agent_runs WHERE session_id = 'canonical-session'");
        assert.equal(
          (await initialScreen(stores)).summary.totalRequests,
          2,
          'Session deletion retains Usage history',
        );
      } finally {
        db.close();
      }
    });
  });

  test('keyset pages handle equal timestamps and duplicate display IDs across sources without loss', async () => {
    await withScreenStores(async (stores, root) => {
      await seedScreen(stores);
      await stores.telemetry.recordToolInvocation(toolRecord({ id: 'legacy-0' }));
      appendModelCallAuthorityEvent(root, {
        ...modelCallAttempt('tie-session'),
        attemptId: 'legacy-0',
        completedAt: Date.UTC(2026, 0, 1),
      });
      await stores.modelCalls.catchUpModelCallProjection();
      const db = acquireOperationalStateDatabase(root);
      try {
        db.database.exec(
          "INSERT INTO usage_llm_calls SELECT 'other-key', id, ts, record_json, session_id FROM usage_llm_calls LIMIT 1",
        );
      } finally {
        db.close();
      }
      const screen = await initialScreen(stores);
      assert.equal(screen.logs.length, 50);
      assert.equal(screen.activityTotal, 64);
      const result = await stores.readUsageScreen(continuation(screen));
      assert.ok(result.kind === 'activity');
      assert.equal(result.page.logs.length, 14);
      assert.equal(result.page.nextCursor, null);
      assert.equal(screen.summary.totalRequests, 63);
      assert.equal(result.page.revision, screen.revision);
      assert.equal(screen.logs.filter((row) => row.kind === 'tool').length, 1);
      await assert.rejects(
        stores.readUsageScreen({ ...continuation(screen), queryIdentity: 'wrong' }),
        /query changed/,
      );
      const other = await initialScreen(stores, { ...screenQuery, search: 'missing' });
      await assert.rejects(
        stores.readUsageScreen({
          ...continuation(screen),
          query: other.query,
          queryIdentity: other.queryIdentity,
        }),
        /cursor/,
      );
      await assert.rejects(
        stores.readUsageScreen({ ...continuation(screen), cursor: 'malformed' }),
        /cursor/,
      );
    });
  });

  test('filters search the full range with Unicode and do not narrow headline totals or breakdowns', async () => {
    await withScreenStores(async (stores) => {
      await seedScreen(stores);
      await stores.telemetry.recordLlmCall(
        llmRecord({ id: 'old-match', ts: 1, modelId: 'ÄModel', status: 'error' }),
      );
      const query = { ...screenQuery, search: 'ämodel', status: 'error' as const };
      const result = await stores.readUsageScreen({ kind: 'screen', query });
      assert.ok(result.kind === 'screen');
      assert.equal(result.screen.summary.totalRequests, 62);
      assert.equal(result.screen.logs.length, 1);
      assert.equal(result.screen.activityTotal, 1);
      assert.equal(result.screen.logs[0]?.id, 'old-match');
      assert.equal(result.screen.byModel.length, 2);
      assert.deepEqual(
        (await initialScreen(stores, { ...screenQuery, search: '%_' })).logs,
        [],
        'SQL wildcards stay literal',
      );
    });
  });

  test('each durable writer, correction, deletion, and rollback fences continuation', async () => {
    await withScreenStores(async (stores, root) => {
      await seedScreen(stores);
      const db = acquireOperationalStateDatabase(root);
      try {
        const beforeRollback = await initialScreen(stores);
        db.database.exec(
          "INSERT INTO core_agent_runs(session_id, run_id, created_at) VALUES ('unrelated', 'run', 0)",
        );
        db.database.exec(
          "UPDATE core_agent_runs SET created_at = 1 WHERE session_id = 'unrelated'",
        );
        assert.equal(
          (await initialScreen(stores)).revision,
          beforeRollback.revision,
          'non-Usage source metadata does not invalidate',
        );
        assert.throws(() =>
          db.transaction('write', () => {
            db.database.exec('DELETE FROM usage_llm_calls');
            throw new Error('rollback');
          }),
        );
        assert.equal((await initialScreen(stores)).revision, beforeRollback.revision);
        assert.equal((await stores.readUsageScreen(continuation(beforeRollback))).kind, 'activity');
        const mutations = [
          () => stores.telemetry.recordLlmCall(llmRecord({ id: 'legacy-0', costUsd: 12 })),
          () => stores.telemetry.recordToolInvocation(toolRecord()),
          () =>
            stores.pricing.upsert(0, {
              modelKey: 'openai:gpt-5',
              inputUsdPer1M: 1,
              outputUsdPer1M: 2,
            }),
          () => appendModelCallAuthorityEvent(root, modelCallAttempt('source-session')),
          () => stores.modelCalls.catchUpModelCallProjection(),
          () => db.database.exec('UPDATE usage_model_call_attempts SET cost_usd = 3'),
          () =>
            db.database.exec(
              'UPDATE usage_model_call_projection_checkpoints SET unreadable_events = 1',
            ),
          () => db.database.exec('DELETE FROM usage_tool_invocations'),
          () => db.database.exec('DELETE FROM usage_model_call_attempts'),
          () => db.database.exec('DELETE FROM core_agent_run_events'),
          () => db.database.exec('DELETE FROM core_agent_runs'),
        ];
        for (const mutate of mutations) {
          const before = await initialScreen(stores);
          await mutate();
          assert.deepEqual(await stores.readUsageScreen(continuation(before)), {
            kind: 'revision_changed',
          });
        }
        const stable = await initialScreen(stores);
        await stores.pricing.upsert(1, {
          modelKey: 'openai:gpt-5',
          inputUsdPer1M: 1,
          outputUsdPer1M: 2,
        });
        await stores.modelCalls.catchUpModelCallProjection();
        assert.equal(
          (await initialScreen(stores)).revision,
          stable.revision,
          'idempotent price and repair do not invalidate',
        );
      } finally {
        db.close();
      }
    });
  });

  test('a concurrent WAL commit between aggregate and activity reads cannot mix versions', async () => {
    await withScreenStores(async (stores, root) => {
      await seedScreen(stores);
      const lease = acquireOperationalStateDatabase(await realpath(root));
      const external = new DatabaseSync(lease.databasePath);
      let committed = false;
      lease.database.function('usage_screen_lower', (value) => {
        if (!committed) {
          committed = true;
          external.exec(
            "UPDATE usage_llm_calls SET record_json = json_set(record_json, '$.costUsd', 99)",
          );
        }
        return String(value).toLowerCase();
      });
      try {
        const screen = await initialScreen(stores, { ...screenQuery, search: 'gpt' });
        assert.ok(committed);
        assert.ok(screen.summary.totalCostUsd < 1);
        assert.ok(screen.logs.every((row) => row.costUsd === 0.001));
        assert.deepEqual(await stores.readUsageScreen(continuation(screen)), {
          kind: 'revision_changed',
        });
        assert.equal((await initialScreen(stores)).summary.totalCostUsd, 61 * 99);
      } finally {
        external.close();
        lease.close();
      }
    });
  });

  test('database reopen rejects old tokens even when durable incarnation and counter repeat', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      let stores = await openInteractiveUsageStoresForWrite(owner.lease);
      try {
        await seedScreen(stores);
        const screen = await initialScreen(stores);
        const lease = acquireOperationalStateDatabase(root);
        const backupPath = `${root}.snapshot`;
        const databasePath = lease.databasePath;
        try {
          await lease.backup(backupPath);
        } finally {
          lease.close();
        }
        await stores.telemetry.recordLlmCall(llmRecord({ id: 'later-write' }));
        await stores.close();
        await copyFile(backupPath, databasePath);
        stores = await openInteractiveUsageStoresForWrite(owner.lease);
        assert.deepEqual(await stores.readUsageScreen(continuation(screen)), {
          kind: 'revision_changed',
        });
        assert.equal(
          (await initialScreen(stores)).summary.totalRequests,
          screen.summary.totalRequests,
        );
      } finally {
        await stores.close();
        await owner.close();
      }
    });
  });
});
