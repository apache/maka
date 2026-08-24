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
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { AgentRunHeader, EmittedAgentRunEvent } from '@maka/core/agent-run';
import { MODEL_CALL_ATTEMPT_SCHEMA_VERSION } from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  EXECUTION_INSPECT_EVIDENCE_MAX_BYTES,
  EXECUTION_INSPECT_RESULT_MAX_BYTES,
  EXECUTION_INSPECT_SESSION_MAX_RUNS,
  EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS,
} from '../protocol/index.js';
import { HostExecutionInspectCoordinator } from '../server/execution-inspect-coordinator.js';

describe('HostExecutionInspectCoordinator', () => {
  test('reports a corrupt persisted model-call event as unreadable evidence', async () => {
    await withCoordinator(async ({ root, stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Corrupt model call'));
      const runId = 'corrupt-model-call-run';
      await stores.agentRunStore.createRun(runHeader(session.id, runId, 1));
      await stores.agentRunStore.appendEvent(session.id, runId, {
        type: 'model_call_attempt_recorded',
        id: 'corrupt-model-call-event',
        sessionId: session.id,
        runId,
        turnId: `turn-${runId}`,
        ts: 1,
        data: {},
      });
      const database = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        database
          .prepare('UPDATE core_agent_run_events SET record_json = ? WHERE event_id = ?')
          .run('{', 'corrupt-model-call-event');
      } finally {
        database.close();
      }

      const result = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );

      assert.equal(result.ok, true);
      if (!result.ok || result.result.kind !== 'session_trace_page') return;
      assert.equal(result.result.coverage.unreadableRecords, 1);
      assert.equal(result.result.coverage.modelCalls, 'partial');
    });
  });

  test('projects persisted history-compaction failure facts into the Session trace', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Compaction diagnostics'));
      const runId = 'compact-run';
      const turnId = `turn-${runId}`;
      await stores.agentRunStore.createRun(runHeader(session.id, runId, 1));
      await stores.agentRunStore.appendEvent(session.id, runId, {
        type: 'model_call_attempt_recorded',
        id: 'attempt-compact-1',
        sessionId: session.id,
        runId,
        turnId,
        ts: 10,
        data: {
          schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
          logicalCallId: 'call-compact-1',
          attemptId: 'attempt-compact-1',
          traceId: 'trace-compact-1',
          sessionId: session.id,
          runId,
          turnId,
          step: 0,
          attempt: 0,
          callKind: 'history_compact',
          historyCompactRoute: 'provider_native',
          connectionSlug: 'codex-subscription',
          providerId: 'openai-codex',
          modelId: 'gpt-5.6-luna',
          startedAt: 1,
          completedAt: 10,
          latencyMs: 9,
          status: 'failed',
          errorClass: 'RequestRejected',
          httpStatus: 400,
          providerCode: 'invalid_request_error',
          providerRequestId: 'req-compact-1',
          retryable: false,
          usageBasis: 'missing',
          costBasis: 'unpriced',
        },
      });

      const result = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );

      assert.equal(result.ok, true);
      if (!result.ok || result.result.kind !== 'session_trace_page') return;
      const step = result.result.turns[0]?.steps[0];
      assert.equal(step?.kind, 'model_call');
      if (step?.kind !== 'model_call') return;
      assert.equal(step.historyCompactRoute, 'provider_native');
      assert.deepEqual(step.attempts[0], {
        attemptId: 'attempt-compact-1',
        attempt: 0,
        status: 'failed',
        startedAt: 1,
        completedAt: 10,
        latencyMs: 9,
        errorClass: 'RequestRejected',
        httpStatus: 400,
        providerCode: 'invalid_request_error',
        providerRequestId: 'req-compact-1',
        retryable: false,
        costBasis: 'unpriced',
        usageBasis: 'missing',
      });
    });
  });

  test('resolves duplicate AgentRun identities and returns canonical evidence documents', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const first = await stores.sessionStore.create(sessionInput('First'));
      const second = await stores.sessionStore.create(sessionInput('Second'));
      await stores.agentRunStore.createRun(runHeader(first.id, 'shared-run', 1));
      await stores.agentRunStore.createRun(runHeader(second.id, 'shared-run', 2));
      await stores.agentRunStore.createRun(runHeader(second.id, first.id, 3));

      const crossKind = await coordinator.handlers['execution.inspect.resolve'](
        { id: first.id },
        connectionContext(),
      );
      assert.equal(crossKind.ok, true);
      if (!crossKind.ok) return;
      assert.equal(crossKind.result.status, 'ambiguous');
      assert.deepEqual(
        crossKind.result.candidates.map((candidate) => candidate.kind),
        ['agent_run', 'session'],
      );

      const ambiguous = await coordinator.handlers['execution.inspect.resolve'](
        { id: 'shared-run', requestedKind: 'agent_run' },
        connectionContext(),
      );
      assert.equal(ambiguous.ok, true);
      if (!ambiguous.ok) return;
      assert.equal(ambiguous.result.status, 'ambiguous');
      assert.deepEqual(
        ambiguous.result.candidates.map((candidate) =>
          candidate.kind === 'agent_run' ? candidate.sessionId : undefined,
        ),
        [first.id, second.id].sort(),
      );

      const resolved = await coordinator.handlers['execution.inspect.resolve'](
        { id: 'shared-run', requestedKind: 'agent_run', sessionId: second.id },
        connectionContext(),
      );
      assert.equal(resolved.ok, true);
      if (!resolved.ok) return;
      assert.equal(resolved.result.status, 'resolved');

      const run = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: second.id, agentRunId: 'shared-run' },
        connectionContext(),
      );
      assert.equal(run.ok, true);
      if (!run.ok || run.result.kind !== 'agent_run') return;
      assert.equal(run.result.document.agentRun.sessionId, second.id);
      assert.equal(run.result.document.agentRun.agentRunId, 'shared-run');

      const session = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session', sessionId: first.id },
        connectionContext(),
      );
      assert.equal(session.ok, true);
      if (!session.ok || session.result.kind !== 'session') return;
      assert.equal(session.result.document.session.sessionId, first.id);
      assert.deepEqual(
        session.result.document.agentRuns.map((document) => document.agentRun.agentRunId),
        ['shared-run'],
      );

      await stores.runtimeEventStore.appendRuntimeEvent(
        first.id,
        'shared-run',
        runtimeEvent(first.id, 'shared-run', 4),
      );
      await stores.agentRunStore.createRun(runHeader(first.id, 'older-run', 0));
      await stores.runtimeEventStore.appendRuntimeEvent(
        first.id,
        'older-run',
        runtimeEvent(first.id, 'older-run', 0),
      );
      const trace = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: first.id },
        connectionContext(),
      );
      assert.equal(trace.ok, true);
      if (!trace.ok || trace.result.kind !== 'session_trace_page') return;
      assert.deepEqual(
        trace.result.turns.map((turn) => turn.runId),
        ['older-run', 'shared-run'],
      );
      assert.equal(trace.result.turns[0]?.steps[0]?.kind, 'error');
      assert.equal(trace.result.nextCursor, null);
    });
  });

  test('bounds live Session inspection and reports missing evidence without mutation', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Large'));
      for (let index = 0; index <= EXECUTION_INSPECT_SESSION_MAX_RUNS; index += 1) {
        await stores.agentRunStore.createRun(runHeader(session.id, `run-${index}`, index));
      }

      const oversized = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session', sessionId: session.id },
        connectionContext(),
      );
      assert.deepEqual(oversized, {
        ok: false,
        error: {
          code: 'invalid_request',
          message:
            'Session inspection exceeds the live Host run limit; inspect one AgentRun instead',
        },
      });
      const missing = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: session.id, agentRunId: 'missing' },
        connectionContext(),
      );
      assert.equal(missing.ok, false);
      if (missing.ok) return;
      assert.equal(missing.error.code, 'not_found');
    });
  });

  test('fills Session trace pages with complete runs up to the turn budget', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Paged turns'));
      const runCount = EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS + 8;
      for (let index = 0; index < runCount; index += 1) {
        const runId = `paged-run-${index}`;
        await stores.agentRunStore.createRun(runHeader(session.id, runId, index));
        await stores.runtimeEventStore.appendRuntimeEvent(
          session.id,
          runId,
          runtimeEvent(session.id, runId, index),
        );
      }

      const first = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );
      assert.equal(first.ok, true);
      if (!first.ok || first.result.kind !== 'session_trace_page') return;
      assert.equal(first.result.turns.length, EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS);
      assert.ok(first.result.nextCursor);

      const second = await coordinator.handlers['execution.inspect.query'](
        {
          kind: 'session_trace_continue',
          sessionId: session.id,
          cursor: first.result.nextCursor,
        },
        connectionContext(),
      );
      assert.equal(second.ok, true);
      if (!second.ok || second.result.kind !== 'session_trace_page') return;
      assert.equal(second.result.turns.length, 8);
      assert.equal(second.result.nextCursor, null);
      assert.equal(
        new Set([...first.result.turns, ...second.result.turns].map((turn) => turn.runId)).size,
        runCount,
      );
    });
  });

  test('continues from every finite AgentRun timestamp accepted by the storage contract', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Legacy timestamps'));
      for (let index = 0; index <= EXECUTION_INSPECT_TRACE_PAGE_MAX_TURNS; index += 1) {
        await stores.agentRunStore.createRun(
          runHeader(session.id, `legacy-run-${index}`, index + 0.5),
        );
      }

      const first = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );
      assert.equal(first.ok, true);
      if (!first.ok || first.result.kind !== 'session_trace_page' || !first.result.nextCursor)
        return;

      const second = await coordinator.handlers['execution.inspect.query'](
        {
          kind: 'session_trace_continue',
          sessionId: session.id,
          cursor: first.result.nextCursor,
        },
        connectionContext(),
      );
      assert.equal(second.ok, true);
    });
  });

  test('reads one Turn trace without charging unrelated Session runs', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Target Turn'));
      for (let index = 0; index <= EXECUTION_INSPECT_SESSION_MAX_RUNS; index += 1) {
        await stores.agentRunStore.createRun(runHeader(session.id, `unrelated-${index}`, index));
      }
      const runId = 'target-run';
      const turnId = `turn-${runId}`;
      await stores.agentRunStore.admitRootTurn({
        sessionId: session.id,
        turnId,
        proposedRunId: runId,
        proposedUserMessageId: 'target-user-message',
        execution: { kind: 'external_message' },
        previousRootTurnId: null,
        normalizedInput: { text: 'diagnose this' },
        sourceMessages: [],
        admittedAt: 100,
      });
      await stores.agentRunStore.createRun(runHeader(session.id, runId, 100));
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        runId,
        runtimeEvent(session.id, runId, 101),
      );

      const sessionTrace = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );
      assert.equal(sessionTrace.ok, true);

      const target = await coordinator.handlers['execution.inspect.query'](
        { kind: 'turn_trace', sessionId: session.id, turnId },
        connectionContext(),
      );
      assert.equal(target.ok, true);
      if (!target.ok || target.result.kind !== 'turn_trace') return;
      assert.equal(target.result.turn.turnId, turnId);
      assert.equal(target.result.turn.runId, runId);
      assert.equal(target.result.turn.failure?.message, 'fixture failure');
    });
  });

  test('rejects oversized evidence at the bounded Store read boundary', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Large evidence'));
      await stores.agentRunStore.createRun(runHeader(session.id, 'large-run', 1));
      await stores.agentRunStore.appendEvent(session.id, 'large-run', {
        type: 'run_started',
        id: 'large-event',
        sessionId: session.id,
        runId: 'large-run',
        turnId: 'turn-large-run',
        ts: 1,
        data: { payload: 'x'.repeat(EXECUTION_INSPECT_EVIDENCE_MAX_BYTES) },
      });

      const result = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: session.id, agentRunId: 'large-run' },
        connectionContext(),
      );

      assert.deepEqual(result, {
        ok: false,
        error: {
          code: 'invalid_request',
          message:
            'AgentRun inspection exceeds the live Host evidence limit; stop the Host to inspect it offline',
        },
      });
    });
  });

  test('does not charge unrelated AgentRun diagnostics to the Session trace budget', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Trace evidence'));
      await stores.agentRunStore.createRun(runHeader(session.id, 'trace-run', 1));
      await stores.agentRunStore.appendEvent(session.id, 'trace-run', {
        type: 'run_started',
        id: 'large-unrelated-event',
        sessionId: session.id,
        runId: 'trace-run',
        turnId: 'turn-trace-run',
        ts: 1,
        data: { payload: 'x'.repeat(EXECUTION_INSPECT_EVIDENCE_MAX_BYTES) },
      });
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'trace-run',
        runtimeEvent(session.id, 'trace-run', 2),
      );

      const result = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );

      assert.equal(result.ok, true);
      if (!result.ok || result.result.kind !== 'session_trace_page') return;
      assert.equal(result.result.turns.length, 1);
    });
  });

  test('keeps a Session trace pageable when one run exceeds the evidence budget', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Oversized trace page'));
      await stores.agentRunStore.createRun(runHeader(session.id, 'oversized-run', 2));
      await stores.runtimeEventStore.appendRuntimeEvent(session.id, 'oversized-run', {
        ...runtimeEvent(session.id, 'oversized-run', 2),
        content: { kind: 'text', text: 'x'.repeat(EXECUTION_INSPECT_EVIDENCE_MAX_BYTES) },
      });
      await stores.agentRunStore.createRun(runHeader(session.id, 'older-run', 1));
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'older-run',
        runtimeEvent(session.id, 'older-run', 1),
      );

      const first = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );

      assert.equal(first.ok, true);
      if (!first.ok || first.result.kind !== 'session_trace_page') return;
      assert.equal(first.result.coverage.modelCalls, 'partial');
      assert.equal(first.result.coverage.unreadableRecords, 0);
      assert.equal(first.result.coverage.oversizedRuns, 1);
      assert.ok(first.result.nextCursor);

      const older = await coordinator.handlers['execution.inspect.query'](
        {
          kind: 'session_trace_continue',
          sessionId: session.id,
          cursor: first.result.nextCursor,
        },
        connectionContext(),
      );
      assert.equal(older.ok, true);
      if (!older.ok || older.result.kind !== 'session_trace_page') return;
      assert.equal(older.result.turns[0]?.runId, 'older-run');
    });
  });

  test('keeps earlier Session history reachable when one projected page exceeds the result limit', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Oversized trace result'));
      await stores.agentRunStore.createRun(runHeader(session.id, 'oversized-result-run', 2));
      for (let index = 0; index < 128; index += 1) {
        await stores.runtimeEventStore.appendRuntimeEvent(session.id, 'oversized-result-run', {
          ...runtimeEvent(session.id, 'oversized-result-run', index + 2),
          id: `oversized-result-event-${index}`,
          content: { kind: 'error', message: 'x'.repeat(EXECUTION_INSPECT_RESULT_MAX_BYTES / 64) },
        });
      }
      await stores.agentRunStore.createRun(runHeader(session.id, 'older-run', 1));
      await stores.runtimeEventStore.appendRuntimeEvent(
        session.id,
        'older-run',
        runtimeEvent(session.id, 'older-run', 1),
      );

      const first = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );

      assert.equal(first.ok, true);
      if (!first.ok || first.result.kind !== 'session_trace_page') return;
      assert.equal(first.result.turns.length, 0);
      assert.equal(first.result.coverage.modelCalls, 'partial');
      assert.equal(first.result.coverage.unreadableRecords, 0);
      assert.equal(first.result.coverage.oversizedRuns, 1);
      assert.ok(first.result.nextCursor);

      const older = await coordinator.handlers['execution.inspect.query'](
        {
          kind: 'session_trace_continue',
          sessionId: session.id,
          cursor: first.result.nextCursor,
        },
        connectionContext(),
      );
      assert.equal(older.ok, true);
      if (!older.ok || older.result.kind !== 'session_trace_page') return;
      assert.equal(older.result.turns[0]?.runId, 'older-run');
    });
  });

  test('classifies a malformed opaque continuation cursor as invalid input', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Malformed trace cursor'));
      const cursor = Buffer.from(
        JSON.stringify({ v: 1, createdAt: 1, runId: 'not/safe' }),
        'utf8',
      ).toString('base64url');

      const result = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_continue', sessionId: session.id, cursor },
        connectionContext(),
      );

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, 'invalid_request');
    });
  });

  test('accepts evidence that exactly consumes the shared byte budget before an empty ledger', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Exact evidence budget'));
      await stores.agentRunStore.createRun(runHeader(session.id, 'exact-run', 1));
      const baseEvent: EmittedAgentRunEvent = {
        type: 'run_started',
        id: 'exact-event',
        sessionId: session.id,
        runId: 'exact-run',
        turnId: 'turn-exact-run',
        ts: 1,
        data: { payload: '' },
      };
      const baseBytes = Buffer.byteLength(JSON.stringify(baseEvent), 'utf8');
      assert.ok(baseBytes < EXECUTION_INSPECT_EVIDENCE_MAX_BYTES);
      const event = {
        ...baseEvent,
        data: {
          payload: 'x'.repeat(EXECUTION_INSPECT_EVIDENCE_MAX_BYTES - baseBytes),
        },
      };
      await stores.agentRunStore.appendEvent(session.id, 'exact-run', event);

      const exact = await stores.agentRunStore.readEventsBounded(session.id, 'exact-run', {
        maxRecords: 1,
        maxBytes: EXECUTION_INSPECT_EVIDENCE_MAX_BYTES,
      });
      assert.equal(exact.status, 'complete');
      const oneByteShort = await stores.agentRunStore.readEventsBounded(session.id, 'exact-run', {
        maxRecords: 1,
        maxBytes: EXECUTION_INSPECT_EVIDENCE_MAX_BYTES - 1,
      });
      assert.equal(oneByteShort.status, 'limit_exceeded');

      const result = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: session.id, agentRunId: 'exact-run' },
        connectionContext(),
      );
      assert.equal(result.ok, true);
    });
  });

  test('pages a Session trace when aggregate evidence exceeds one live read budget', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Aggregate evidence'));
      for (const [index, runId] of ['aggregate-run-1', 'aggregate-run-2'].entries()) {
        await stores.agentRunStore.createRun(runHeader(session.id, runId, index + 1));
        await stores.runtimeEventStore.appendRuntimeEvent(session.id, runId, {
          id: `aggregate-event-${index + 1}`,
          invocationId: runId,
          sessionId: session.id,
          turnId: `turn-${runId}`,
          runId,
          ts: index + 1,
          // Partial transport evidence is read and charged to the Host budget,
          // then intentionally omitted from the causal projection. Two such
          // runs exceed one old whole-Session budget without also exercising
          // the separate result-size fallback.
          partial: true,
          role: 'model',
          author: 'agent',
          content: {
            kind: 'text',
            text: 'x'.repeat(Math.floor(EXECUTION_INSPECT_EVIDENCE_MAX_BYTES * 0.55)),
          },
        });
      }

      const first = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session_trace_start', sessionId: session.id },
        connectionContext(),
      );
      assert.equal(first.ok, true);
      if (!first.ok || first.result.kind !== 'session_trace_page') return;
      assert.equal(first.result.turns.length, 0);
      assert.ok(first.result.nextCursor !== null);
    });
  });
});

function sessionInput(name: string) {
  return {
    cwd: '/tmp/workspace',
    name,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  } as const;
}

function runHeader(sessionId: string, runId: string, createdAt: number): AgentRunHeader {
  return {
    sessionId,
    runId,
    turnId: `turn-${runId}`,
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/workspace',
    permissionMode: 'ask',
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  };
}

function runtimeEvent(sessionId: string, runId: string, ts: number): RuntimeEvent {
  return {
    id: `event-${runId}`,
    invocationId: runId,
    sessionId,
    turnId: `turn-${runId}`,
    runId,
    ts,
    partial: false,
    role: 'system',
    author: 'system',
    content: { kind: 'error', message: 'fixture failure' },
  };
}

function connectionContext() {
  return {
    hostEpoch: 'host-1',
    connectionId: 'connection-1',
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release: () => undefined }),
  };
}

async function withCoordinator(
  run: (input: {
    root: string;
    stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
    coordinator: HostExecutionInspectCoordinator;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-host-inspect-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    await run({ root, stores, coordinator: new HostExecutionInspectCoordinator(stores) });
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
