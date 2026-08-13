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

test('serves the sealed snapshot without reading a single run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    await writer.createRun(runHeader('run-1', 1));
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200),
      { durable: true, latestContext: latestContext('attempt-1', 10) },
    );

    const reader = createSqliteAgentRunStore(root);
    let scanned = 0;
    const counted = countingStore(reader, () => {
      scanned += 1;
    });

    const diagnostics = await readLatestContextDiagnostics(counted, 'session-1');

    assert.equal(diagnostics.status, 'available');
    if (diagnostics.status !== 'available') return;
    assert.deepEqual(diagnostics.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
    assert.equal(scanned, 0, 'a sealed snapshot is one projection read');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed call does not replace the last good snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    await writer.createRun(runHeader('run-1', 1));
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200),
      { durable: true, latestContext: latestContext('attempt-1', 10) },
    );
    // A failed attempt still writes its metering record. It must not touch the
    // snapshot: the reader would otherwise lose its warm answer to a call that
    // never produced a context at all.
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-2', 20, 'model-failed', undefined, undefined, {
        status: 'failed',
      }),
    );

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });
    const diagnostics = await readLatestContextDiagnostics(counted, 'session-1');

    assert.equal(diagnostics.status, 'available');
    if (diagnostics.status !== 'available') return;
    assert.equal(diagnostics.modelId, 'model', 'the completed call still answers');
    assert.equal(scanned, 0, 'and the read stays warm');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a subagent's run never becomes the session's context", async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    await writer.createRun(runHeader('run-parent', 1));
    await writer.createRun({
      ...runHeader('run-child', 2),
      parentRunId: 'run-parent',
      agentId: 'sub',
    });
    await writer.appendEvent(
      'session-1',
      'run-parent',
      meteringEvent('run-parent', 'a-parent', 10, 'model', 40, 200),
      { durable: true, latestContext: latestContext('a-parent', 10) },
    );
    await writer.appendEvent(
      'session-1',
      'run-child',
      meteringEvent('run-child', 'a-child', 20, 'model-child', 40, 200),
      { durable: true, latestContext: latestContext('a-child', 20, 'model-child') },
    );

    const diagnostics = await readLatestContextDiagnostics(
      createSqliteAgentRunStore(root),
      'session-1',
    );

    assert.equal(diagnostics.status, 'available');
    if (diagnostics.status !== 'available') return;
    assert.equal(diagnostics.modelId, 'model', "a child's prompt is not this session's context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rebuilds a legacy ledger, then repairs it so the next read scans nothing', async () => {
  // A session written before canonical metering sealed anything. The scan is
  // the compatibility path; proving it happens ONCE needs two reads.
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    await writer.createRun(runHeader('run-1', 1));
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 20, 'model-new', 40, 200),
    );
    await writer.appendEvent(
      'session-1',
      'run-1',
      attemptEvent('run-1', 'attempt-1', 20, 'completed', 'model-new', 40, 200, [
        { kind: 'tool_schema', index: 0, cacheable: true, hash: 't', bytes: 800, label: 'Bash' },
      ]),
    );

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });

    const cold = await readLatestContextDiagnostics(counted, 'session-1');
    assert.equal(cold.status, 'available');
    if (cold.status !== 'available') return;
    assert.equal(cold.modelId, 'model-new');
    assert.deepEqual(cold.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
    assert.ok(scanned > 0, 'the first read falls back to the ledger');

    scanned = 0;
    const warm = await readLatestContextDiagnostics(counted, 'session-1');
    assert.equal(warm.status, 'available');
    if (warm.status !== 'available') return;
    assert.deepEqual(warm.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
    assert.equal(scanned, 0, 'the cold read repaired the projection on its way out');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reads a provider-only ledger that predates canonical metering', async () => {
  // No `model_call_attempt_recorded` anywhere. The provider attempt is the
  // only record of the request, and returning "no completed request" would
  // lose an answer the ledger still holds.
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [
        attemptEvent('run-1', 'attempt-1', 20, 'completed', 'model-old', 40, 200, [
          { kind: 'tool_schema', index: 0, cacheable: true, hash: 't', bytes: 800, label: 'Bash' },
        ]),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-old');
  assert.deepEqual(diagnostics.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
});

test('a canonical record on the ledger keeps the legacy path out of it', async () => {
  // The fallback must never become a second authority: once a canonical
  // attempt exists, a newer provider-only attempt is not promoted over it.
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-canonical', 40, 200),
        attemptEvent('run-1', 'attempt-2', 30, 'completed', 'model-provider-only', 50, 200),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-canonical');
});

test('a legacy request whose capture is missing reports no composition, not an older one', async () => {
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-old', 10, 100),
        attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model-old', 10, 100, [
          { kind: 'tool_schema', index: 0, cacheable: true, hash: 't', bytes: 800, label: 'Bash' },
        ]),
        meteringEvent('run-1', 'attempt-2', 20, 'model-new', 40, 200),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-new');
  assert.equal(diagnostics.composition, undefined);
});

test('a compaction call never becomes the reported context', async () => {
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-main', 40, 200),
        meteringEvent('run-1', 'attempt-2', 20, 'model-compact', 5, 200, {
          callKind: 'history_compact',
        }),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-main');
});

test('reports that no completed request exists instead of inferring session values', async () => {
  const diagnostics = await readLatestContextDiagnostics(
    runStore([{ header: runHeader('run-1', 1), events: [] }]),
    'session-1',
  );

  assert.deepEqual(diagnostics, { status: 'unavailable', reason: 'no_completed_request' });
});

test('a rebuilt session reports the fold that was in place when its request started', async () => {
  // The warm path seals the boundary the prompt was built under; the cold path
  // has to reach the same description from the ledger alone. A checkpoint
  // written AFTER the request started belongs to a later prompt, so the scan
  // takes the newest one at or before the anchor's start — the same "no field
  // here describes a different request" rule the sealed row enforces.
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [
        checkpointEvent('run-1', 5, 12, 3, 900),
        meteringEvent('run-1', 'attempt-1', 20, 'model-new', 40, 200),
        checkpointEvent('run-1', 25, 40, 9, 2_400),
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
    estimatedTokens: 900,
  });
});

test('a canonical ledger with nothing reportable does not fall back to a provider row', async () => {
  // `anchor` only ever holds a completed MAIN call, so a session whose
  // canonical records are all failed, aborted, a compaction's own request, or
  // undecodable leaves it empty — which is not the same as having no canonical
  // metering at all. Treating the two alike would let the compatibility path
  // resurrect exactly the request the canonical rule declined to report.
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-failed', 40, 200, { status: 'failed' }),
        meteringEvent('run-1', 'attempt-2', 15, 'model-compact', 5, 200, {
          callKind: 'history_compact',
        }),
        {
          type: 'model_call_attempt_recorded',
          id: 'metering-junk',
          runId: 'run-1',
          sessionId: 'session-1',
          turnId: 'turn-run-1',
          ts: 18,
          data: { schemaVersion: 1 },
        },
        attemptEvent('run-1', 'attempt-3', 30, 'completed', 'model-provider-only', 50, 200),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.deepEqual(diagnostics, { status: 'unavailable', reason: 'no_completed_request' });
});

test('warm and cold agree on which of two requests that finished together is the latest', async () => {
  // Two records sharing a completion millisecond. The tie has to break the
  // same way in both writers — the storage transaction comparing an arriving
  // commit against the stored row, and the scan comparing every record of a
  // ledger — or a rebuilt session would disagree with a live one about which
  // request the panel is describing.
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    await writer.createRun(runHeader('run-1', 1));
    // Appended greater-id first, so a rule that simply kept the last write
    // would answer 'model-a' here and disagree with the scan below.
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-b', 10, 'model-b', 40, 200),
      { durable: true, latestContext: latestContext('attempt-b', 10, 'model-b') },
    );
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-a', 10, 'model-a', 40, 200),
      { durable: true, latestContext: latestContext('attempt-a', 10, 'model-a') },
    );

    const reader = createSqliteAgentRunStore(root);
    const warm = await readLatestContextDiagnostics(reader, 'session-1');
    // The same ledger read by a session whose projection was never
    // initialized: the answer has to come out identical.
    const cold = await readLatestContextDiagnostics(
      {
        listSessionRuns: (sessionId) => reader.listSessionRuns(sessionId),
        readEvents: (sessionId, runId) => reader.readEvents(sessionId, runId),
      },
      'session-1',
    );

    assert.equal(warm.status, 'available');
    assert.equal(cold.status, 'available');
    if (warm.status !== 'available' || cold.status !== 'available') return;
    assert.equal(warm.modelId, 'model-b', 'the tie breaks on the attempt id, not on arrival');
    assert.equal(cold.modelId, warm.modelId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a session confirmed to have nothing is answered from the projection, not re-scanned', async () => {
  // `null` is a decided answer, and the only thing that stops a session with
  // no completed request from scanning its whole ledger on every refresh.
  // `undefined` — never decided — is what still earns a scan.
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    await writer.createRun(runHeader('run-1', 1));

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });

    const cold = await readLatestContextDiagnostics(counted, 'session-1');
    assert.deepEqual(cold, { status: 'unavailable', reason: 'no_completed_request' });
    assert.ok(scanned > 0, 'an uninitialized projection is not an answer');

    scanned = 0;
    const warm = await readLatestContextDiagnostics(counted, 'session-1');
    assert.deepEqual(warm, { status: 'unavailable', reason: 'no_completed_request' });
    assert.equal(scanned, 0, 'the initialized-empty projection answers on its own');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('names at most the bounded number of tools, and accounts for the rest', async () => {
  // The 257th tool used to fail the whole query at the wire decoder. The fold
  // bounds it instead, so a large registry summarises rather than breaks.
  const segments = Array.from({ length: 300 }, (_, index) => ({
    kind: 'tool_schema',
    index,
    cacheable: true,
    hash: `t${index}`,
    bytes: 300 - index,
    label: `tool-${String(index).padStart(3, '0')}`,
  }));
  const store = runStore([
    {
      header: runHeader('run-1', 1),
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200),
        attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model', 40, 200, segments),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1');

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  const composition = diagnostics.composition;
  assert.equal(composition?.tools?.length, 64);
  assert.equal(composition?.remainingTools?.count, 236);
  const named = composition!.tools!.reduce((carry, tool) => carry + tool.bytes, 0);
  assert.equal(
    named + composition!.remainingTools!.bytes,
    composition!.segments.find((segment) => segment.kind === 'tool_definitions')?.bytes,
    'named rows plus the remainder account for every tool byte',
  );
});

test('a request that finished earlier cannot move the answer backwards', async () => {
  // Overlapping turns append on independent queues, so arrival order is not
  // completion order. The projection is monotonic on the request's own
  // completion, or a late arrival would permanently rewind the panel.
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    await writer.createRun(runHeader('run-1', 1));
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'late', 20, 'model-newer', 40, 200),
      { durable: true, latestContext: latestContext('late', 20, 'model-newer') },
    );
    // Appended second, but it finished FIRST.
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'early', 10, 'model-older', 40, 200),
      { durable: true, latestContext: latestContext('early', 10, 'model-older') },
    );

    const diagnostics = await readLatestContextDiagnostics(
      createSqliteAgentRunStore(root),
      'session-1',
    );

    assert.equal(diagnostics.status, 'available');
    if (diagnostics.status !== 'available') return;
    assert.equal(diagnostics.modelId, 'model-newer');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a damaged projection is repaired, not preserved forever', async () => {
  // The reader treats an undecodable row as unanswered and rebuilds from the
  // ledger — but the generic repair policy used to preserve any existing row,
  // so the rebuilt answer could never replace the damaged one and every later
  // refresh rescanned the whole session (#2323).
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    const writer = createSqliteAgentRunStore(root);
    await writer.createRun(runHeader('run-1', 1));
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200),
      { durable: true, latestContext: latestContext('attempt-1', 10) },
    );
    // Damage the row in place. `replaceEventId` is the seam for replacing a
    // known row, which is what corruption of the stored snapshot looks like —
    // the ordering rule itself refuses to overwrite a readable row with an
    // unreadable one, so this cannot be seeded through the normal path.
    await writer.repairEventProjection(
      'session-1',
      'latest_context',
      {
        type: 'latest_context',
        id: 'latest-context-damaged',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-run-1',
        ts: 10,
        data: { schemaVersion: 1, damaged: true },
      },
      { replaceEventId: 'latest-context-attempt-1' },
    );

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });

    const first = await readLatestContextDiagnostics(counted, 'session-1');
    assert.equal(first.status, 'available');
    if (first.status !== 'available') return;
    assert.equal(first.modelId, 'model', 'the damaged row does not answer');
    assert.ok(scanned > 0, 'the first read rebuilds from the ledger');

    scanned = 0;
    const second = await readLatestContextDiagnostics(counted, 'session-1');
    assert.equal(second.status, 'available');
    assert.equal(scanned, 0, 'and the rebuild replaced the damaged row');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function countingStore(
  reader: ReturnType<typeof createSqliteAgentRunStore>,
  onScan: () => void,
): Parameters<typeof readLatestContextDiagnostics>[0] {
  return {
    listSessionRuns: (sessionId) => reader.listSessionRuns(sessionId),
    readEvents: async (sessionId, runId) => {
      onScan();
      return reader.readEvents(sessionId, runId);
    },
    readEventProjection: (sessionId, type) => reader.readEventProjection(sessionId, type),
    repairEventProjection: (sessionId, type, event, options) =>
      reader.repairEventProjection(sessionId, type, event, options),
  };
}

/**
 * The derived row as the canonical append commits it — the same shape the
 * store writes inside that transaction, never a separate ledger record.
 */
function latestContext(attemptId: string, completedAt: number, modelId = 'model') {
  return {
    attemptId,
    orderedAt: completedAt,
    snapshot: {
      schemaVersion: 1,
      attemptId,
      providerId: 'anthropic',
      modelId,
      completedAt,
      inputTokens: 40,
      contextWindow: 200,
      composition: {
        segments: [{ kind: 'tool_definitions', bytes: 800 }],
        tools: [{ name: 'Bash', bytes: 800 }],
      },
    },
  };
}

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

/**
 * The DURABLE metering record. It is the anchor now: identity and every
 * provider-reported number come from here, and the best-effort capture only
 * gets to describe the request this one names (#2323).
 */
function meteringEvent(
  runId: string,
  attemptId: string,
  completedAt: number,
  modelId: string,
  inputTokens: number | undefined,
  contextWindow: number | undefined,
  overrides: Record<string, unknown> = {},
): EmittedAgentRunEvent {
  const turnId = `turn-${runId}`;
  return {
    type: 'model_call_attempt_recorded',
    id: `metering-${attemptId}`,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: completedAt,
    data: {
      schemaVersion: 1,
      logicalCallId: `call-${attemptId}`,
      attemptId,
      traceId: `trace-${attemptId}`,
      sessionId: 'session-1',
      runId,
      turnId,
      step: 0,
      attempt: 0,
      callKind: 'main',
      providerId: 'anthropic',
      modelId,
      startedAt: completedAt - 1,
      completedAt,
      latencyMs: 1,
      status: 'completed',
      usageBasis: 'reported',
      costBasis: 'unpriced',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...overrides,
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
