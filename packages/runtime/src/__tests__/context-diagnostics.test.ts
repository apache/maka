import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  EmittedAgentRunEvent,
} from '@maka/core/agent-run';
import { createSqliteAgentRunStore } from '@maka/storage';
import { readLatestContextDiagnostics } from '../context-diagnostics.js';

test('reads the latest completed provider request instead of a later failed attempt', async () => {
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model-old', 10, 100)],
    },
    {
      header: runHeader('run-2', 2),
      events: [
        attemptEvent('run-2', 'attempt-2', 20, 'completed', 'model-new', 40, 200),
        attemptEvent('run-2', 'attempt-3', 30, 'failed', 'model-failed', undefined, 300),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.deepEqual(diagnostics, {
    status: 'available',
    providerId: 'anthropic',
    modelId: 'model-new',
    completedAt: 20,
    inputTokens: 40,
    contextWindow: 200,
    segments: [],
  });
});

test('ignores non-inline child runs when reading session context', async () => {
  const store = runStore([
    {
      header: runHeader('run-parent', 1),
      events: [
        checkpointEvent('run-parent', 5, 12, 3, 77),
        attemptEvent('run-parent', 'attempt-parent', 10, 'completed', 'model-parent', 40, 200),
      ],
    },
    {
      header: { ...runHeader('run-child', 2), parentRunId: 'run-parent' },
      events: [
        checkpointEvent('run-child', 8, 99, 9, 999),
        attemptEvent('run-child', 'attempt-child', 20, 'completed', 'model-child', 50, 500),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-parent');
  assert.deepEqual(diagnostics.compaction, {
    kind: 'history',
    phase: 'pre_turn',
    eventCount: 12,
    turnCount: 3,
    estimatedTokens: 77,
  });
});

test('reports that no completed request exists instead of inferring session values', async () => {
  const diagnostics = await readLatestContextDiagnostics(
    runStore([{ header: runHeader('run-1', 1), events: [] }]),
    'session-1',
  );

  assert.deepEqual(diagnostics, {
    status: 'unavailable',
    reason: 'no_completed_request',
  });
});

test('does not fall back when the latest completed request trace is invalid', async () => {
  const older = attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model-old', 10, 100);
  const invalidLatest = attemptEvent('run-1', 'attempt-2', 20, 'completed', 'model-new', 20, 200);
  invalidLatest.data = {
    ...invalidLatest.data,
    segments: 'invalid',
  } as AgentRunEvent['data'];

  const diagnostics = await readLatestContextDiagnostics(
    runStore([{ header: runHeader('run-1', 1), events: [older, invalidLatest] }]),
    'session-1',
  );

  assert.deepEqual(diagnostics, {
    status: 'unavailable',
    reason: 'trace_unavailable',
  });
});

test('reports the latest history compaction that preceded the displayed request', async () => {
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [
        checkpointEvent('run-1', 5, 12, 3, 77),
        attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model', 40, 200),
        checkpointEvent('run-1', 12, 20, 5, 88),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.deepEqual(diagnostics.compaction, {
    kind: 'history',
    phase: 'pre_turn',
    eventCount: 12,
    turnCount: 3,
    estimatedTokens: 77,
  });
});

test('reads the same diagnostics after reopening the durable run ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    const header = runHeader('run-1', 1);
    await writer.createRun(header);
    await writer.appendEvent(
      'session-1',
      'run-1',
      attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model', 40, 200),
    );

    const diagnostics = await readLatestContextDiagnostics(
      createSqliteAgentRunStore(root),
      'session-1',
    );

    assert.equal(diagnostics.status, 'available');
    if (diagnostics.status !== 'available') return;
    assert.equal(diagnostics.inputTokens, 40);
    assert.equal(diagnostics.contextWindow, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runStore(
  runs: Array<{ header: AgentRunHeader; events: AgentRunEvent[] }>,
): Pick<AgentRunStore, 'listSessionRuns' | 'readEvents'> {
  return {
    listSessionRuns: async () => runs.map((run) => run.header),
    readEvents: async (_sessionId, runId) =>
      runs.find((run) => run.header.runId === runId)?.events ?? [],
  };
}

function runHeader(runId: string, createdAt: number): AgentRunHeader {
  return {
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    modelId: 'model',
    cwd: '/repo',
    permissionMode: 'ask',
    createdAt,
    updatedAt: createdAt,
  };
}

function attemptEvent(
  runId: string,
  attemptId: string,
  completedAt: number,
  status: 'completed' | 'failed',
  modelId: string,
  inputTokens: number | undefined,
  contextWindow: number,
  segments: Array<Record<string, unknown>> = [],
): EmittedAgentRunEvent {
  const turnId = `turn-${runId}`;
  return {
    type: 'provider_request_attempt_recorded',
    id: attemptId,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: completedAt,
    data: {
      traceId: `trace-${attemptId}`,
      attemptId,
      turnId,
      step: 0,
      attempt: 1,
      captureId: `capture-${attemptId}`,
      captureArtifactId: `artifact-${attemptId}`,
      providerId: 'anthropic',
      modelId,
      contextWindow,
      requestHash: `hash-${attemptId}`,
      requestBytes: 0,
      segments,
      startedAt: completedAt - 1,
      completedAt,
      status,
      latencyMs: 1,
      ...(inputTokens === undefined ? {} : { inputTokens }),
    },
  };
}

function checkpointEvent(
  runId: string,
  ts: number,
  eventCount: number,
  turnCount: number,
  estimatedTokens: number,
): EmittedAgentRunEvent {
  return {
    type: 'history_compact_checkpoint_recorded',
    id: `checkpoint-${ts}`,
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    ts,
    data: {
      checkpoint: {
        kind: 'maka.history_compact_checkpoint',
        version: 2,
        checkpointId: `history-${ts}`,
        sessionId: 'session-1',
        createdAt: ts,
        highWaterName: 'history',
        highWaterSeq: ts,
        coverage: {
          eventCount,
          turnCount,
          through: {
            runId,
            turnId: `turn-${runId}`,
            runtimeEventId: `runtime-${ts}`,
          },
          sourceDigest: `digest-${ts}`,
        },
        phase: 'pre_turn',
        summary: 'Earlier context summary.',
        limitations: ['Estimated summary.'],
        estimatedTokens,
      },
    },
  };
}
