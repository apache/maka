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
import { sectionedSummary } from './history-compact-test-fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { AgentRunEvent, AgentRunStore, EmittedAgentRunEvent } from '@maka/core/agent-run';
import type { RuntimeEventInvocationOpenedContent } from '@maka/core/runtime-event';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { readLatestContextDiagnostics } from '../context-diagnostics.js';
import { readLatestContextSnapshot } from '../latest-context-snapshot.js';
import { seedInvocation } from './invocation-fixture.js';

test('rejects v2 snapshots that the canonical writer cannot produce', () => {
  const base = {
    schemaVersion: 2,
    attemptId: 'attempt-1',
    providerId: 'anthropic',
    modelId: 'model',
    completedAt: 10,
  };
  const impossible = [
    { ...base, composition: { segments: [] } },
    { ...base, composition: { segments: [{ kind: 'messages', bytes: 0 }] } },
    {
      ...base,
      composition: {
        segments: [{ kind: 'messages', bytes: 10 }],
        tools: [{ name: 'Bash', bytes: 10 }],
      },
    },
    {
      ...base,
      composition: {
        segments: [{ kind: 'tool_definitions', bytes: 10 }],
        remainingTools: { count: 0, bytes: 0 },
      },
    },
    {
      ...base,
      compaction: {
        kind: 'history',
        phase: 'pre_turn',
        eventCount: 0,
        turnCount: 0,
        estimatedTokens: 10,
      },
    },
  ];

  for (const snapshot of impossible) {
    assert.equal(readLatestContextSnapshot({ type: 'latest_context', data: snapshot }), undefined);
  }
});

test('serves the sealed snapshot without reading a single run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
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

    const diagnostics = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);

    assert.equal(diagnostics.status, 'available');
    if (diagnostics.status !== 'available') return;
    assert.deepEqual(diagnostics.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
    assert.equal(scanned, 0, 'a sealed snapshot is one projection read');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not trust a pre-observation projection over its canonical attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
    const oldProjection = latestContext('attempt-1', 10);
    oldProjection.snapshot.schemaVersion = 1;
    oldProjection.snapshot.composition = {
      segments: [{ kind: 'messages', bytes: 999 }],
      tools: [],
    };
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200),
      { durable: true, latestContext: oldProjection },
    );

    const reader = createSqliteAgentRunStore(root);
    const warm = await readLatestContextDiagnostics(reader, 'session-1', ['run-1']);
    const cold = await readLatestContextDiagnostics(
      { readEvents: (sessionId, runId) => reader.readEvents(sessionId, runId) },
      'session-1',
      ['run-1'],
    );

    assert.equal(warm.status, 'available');
    assert.equal(cold.status, 'available');
    if (warm.status !== 'available' || cold.status !== 'available') return;
    assert.equal(warm.composition, undefined);
    assert.equal(cold.composition, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upgrades exact-matched mixed-era composition into the current projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
    const oldProjection = latestContext('attempt-1', 10);
    oldProjection.snapshot.schemaVersion = 1;
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200),
      { durable: true, latestContext: oldProjection },
    );
    await writer.appendEvent(
      'session-1',
      'run-1',
      attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model', 40, 200, [
        {
          kind: 'tool_schema',
          index: 0,
          cacheable: true,
          hash: 'legacy',
          bytes: 700,
          label: 'HistoricalTool',
        },
      ]),
    );

    let scanned = 0;
    const reader = createSqliteAgentRunStore(root);
    const counted = countingStore(reader, () => {
      scanned += 1;
    });
    const upgraded = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);

    assert.equal(upgraded.status, 'available');
    if (upgraded.status !== 'available') return;
    assert.deepEqual(upgraded.composition?.tools, [{ name: 'HistoricalTool', bytes: 700 }]);

    scanned = 0;
    const warm = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(warm.status, 'available');
    if (warm.status !== 'available') return;
    assert.deepEqual(warm.composition, upgraded.composition);
    assert.equal(scanned, 0, 'the mixed-era composition is sealed into the v2 projection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed call does not replace the last good snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
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
    const diagnostics = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);

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
    await openRun(root, 'session-1', 'run-parent');
    await openRun(root, 'session-1', 'run-child', {
      lineage: { parentRunId: 'run-parent', agentId: 'reviewer' },
    });
    const writer = createSqliteAgentRunStore(root);
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

    // The caller names the session-inline runs, so the child is never scanned.
    const diagnostics = await readLatestContextDiagnostics(
      createSqliteAgentRunStore(root),
      'session-1',
      ['run-parent'],
    );

    assert.equal(diagnostics.status, 'available');
    if (diagnostics.status !== 'available') return;
    assert.equal(diagnostics.modelId, 'model', "a child's prompt is not this session's context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rebuilds a canonical observation, then repairs it so the next read scans nothing', async () => {
  // The event is durable but predates a sealed projection. The first read
  // rebuilds from its canonical observation; proving that happens once needs
  // two reads.
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 20, 'model-new', 40, 200, {
        requestObservation: requestObservation([
          {
            kind: 'tool_schema',
            index: 0,
            cacheable: true,
            comparison: 'exact',
            digest: `sha256:${'a'.repeat(64)}`,
            bytes: 800,
            label: 'Bash',
          },
        ]),
      }),
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

    const cold = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(cold.status, 'available');
    if (cold.status !== 'available') return;
    assert.equal(cold.modelId, 'model-new');
    assert.deepEqual(cold.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
    assert.ok(scanned > 0, 'the first read falls back to the ledger');

    scanned = 0;
    const warm = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(warm.status, 'available');
    if (warm.status !== 'available') return;
    assert.deepEqual(warm.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
    assert.equal(scanned, 0, 'the cold read repaired the projection on its way out');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rebuilds without repairing when the store lacks a ledger revision capability', async () => {
  const base = runStore([
    {
      runId: 'run-1',
      events: [meteringEvent('run-1', 'attempt-1', 20, 'model', 40, 200)],
    },
  ]);
  let repaired = false;
  const store: Parameters<typeof readLatestContextDiagnostics>[0] = {
    ...base,
    repairEventProjection: async () => {
      repaired = true;
    },
  };

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

  assert.equal(diagnostics.status, 'available');
  assert.equal(repaired, false);
});

test('reads a provider-only ledger that predates canonical metering', async () => {
  // No `model_call_attempt_recorded` anywhere. The provider attempt is the
  // only record of the request, and returning "no completed request" would
  // lose an answer the ledger still holds.
  const store = runStore([
    {
      runId: 'run-1',
      events: [
        attemptEvent('run-1', 'attempt-1', 20, 'completed', 'model-old', 40, 200, [
          { kind: 'tool_schema', index: 0, cacheable: true, hash: 't', bytes: 800, label: 'Bash' },
        ]),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

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
      runId: 'run-1',
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-canonical', 40, 200),
        attemptEvent('run-1', 'attempt-2', 30, 'completed', 'model-provider-only', 50, 200),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-canonical');
});

test('cold rebuild takes composition from the canonical attempt observation', async () => {
  const store = runStore([
    {
      runId: 'run-1',
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-canonical', 40, 200, {
          requestObservation: requestObservation([
            {
              kind: 'tool_schema',
              index: 0,
              cacheable: true,
              comparison: 'exact',
              digest: `sha256:${'a'.repeat(64)}`,
              bytes: 800,
              label: 'CanonicalTool',
            },
          ]),
        }),
        attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model-canonical', 40, 200, [
          {
            kind: 'tool_schema',
            index: 0,
            cacheable: true,
            hash: 'legacy',
            bytes: 999,
            label: 'BestEffortTool',
          },
        ]),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.deepEqual(diagnostics.composition?.tools, [{ name: 'CanonicalTool', bytes: 800 }]);
});

test('does not enrich a canonical attempt from an identity-mismatched provider row', async () => {
  const store = runStore([
    {
      runId: 'run-1',
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-canonical', 40, 200),
        attemptEvent('run-1', 'attempt-1', 11, 'completed', 'model-other', 40, 200, [
          {
            kind: 'tool_schema',
            index: 0,
            cacheable: true,
            hash: 'legacy',
            bytes: 999,
            label: 'WrongRequestTool',
          },
        ]),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-canonical');
  assert.equal(diagnostics.composition, undefined);
});

test('a legacy request whose capture is missing reports no composition, not an older one', async () => {
  const store = runStore([
    {
      runId: 'run-1',
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-old', 10, 100),
        attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model-old', 10, 100, [
          { kind: 'tool_schema', index: 0, cacheable: true, hash: 't', bytes: 800, label: 'Bash' },
        ]),
        meteringEvent('run-1', 'attempt-2', 20, 'model-new', 40, 200),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-new');
  assert.equal(diagnostics.composition, undefined);
});

test('a compaction call never becomes the reported context', async () => {
  const store = runStore([
    {
      runId: 'run-1',
      events: [
        meteringEvent('run-1', 'attempt-1', 10, 'model-main', 40, 200),
        meteringEvent('run-1', 'attempt-2', 20, 'model-compact', 5, 200, {
          callKind: 'history_compact',
        }),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

  assert.equal(diagnostics.status, 'available');
  if (diagnostics.status !== 'available') return;
  assert.equal(diagnostics.modelId, 'model-main');
});

test('reports that no completed request exists instead of inferring session values', async () => {
  const diagnostics = await readLatestContextDiagnostics(
    runStore([{ runId: 'run-1', events: [] }]),
    'session-1',
    ['run-1'],
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
      runId: 'run-1',
      events: [
        checkpointEvent('run-1', 5, 12, 3, 900),
        meteringEvent('run-1', 'attempt-1', 20, 'model-new', 40, 200),
        checkpointEvent('run-1', 25, 40, 9, 2_400),
      ],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

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
      runId: 'run-1',
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

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

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
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
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
    const warm = await readLatestContextDiagnostics(reader, 'session-1', ['run-1']);
    // The same ledger read by a session whose projection was never
    // initialized: the answer has to come out identical.
    const cold = await readLatestContextDiagnostics(
      { readEvents: (sessionId, runId) => reader.readEvents(sessionId, runId) },
      'session-1',
      ['run-1'],
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

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });

    const cold = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.deepEqual(cold, { status: 'unavailable', reason: 'no_completed_request' });
    assert.ok(scanned > 0, 'an uninitialized projection is not an answer');

    scanned = 0;
    const warm = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.deepEqual(warm, { status: 'unavailable', reason: 'no_completed_request' });
    assert.equal(scanned, 0, 'the initialized-empty projection answers on its own');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('names at most the bounded number of tools, and accounts for the rest', async () => {
  // Historical provider-only ledgers can contain unbounded segment arrays.
  // Their reader still bounds the diagnostic instead of rejecting the row.
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
      runId: 'run-1',
      events: [attemptEvent('run-1', 'attempt-1', 10, 'completed', 'model', 40, 200, segments)],
    },
  ]);

  const diagnostics = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);

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
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
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
      ['run-1'],
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
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
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
      {
        ifLedgerRevision: await writer.readEventLedgerRevision('session-1'),
        replaceEventId: 'latest-context-attempt-1',
      },
    );

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });

    const first = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(first.status, 'available');
    if (first.status !== 'available') return;
    assert.equal(first.modelId, 'model', 'the damaged row does not answer');
    assert.ok(scanned > 0, 'the first read rebuilds from the ledger');

    scanned = 0;
    const second = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(second.status, 'available');
    assert.equal(scanned, 0, 'and the rebuild replaced the damaged row');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repairs malformed projection bytes from the canonical ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200, {
        requestObservation: requestObservation([
          {
            kind: 'tool_schema',
            index: 0,
            cacheable: true,
            comparison: 'exact',
            digest: `sha256:${'a'.repeat(64)}`,
            bytes: 800,
            label: 'Bash',
          },
        ]),
      }),
      { durable: true, latestContext: latestContext('attempt-1', 10) },
    );
    writer.close?.();

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

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });
    const first = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(first.status, 'available');
    if (first.status !== 'available') return;
    assert.deepEqual(first.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
    assert.ok(scanned > 0, 'the malformed bytes force a canonical rebuild');

    scanned = 0;
    const second = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(second.status, 'available');
    assert.equal(scanned, 0, 'the authority-derived candidate replaced the malformed row');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not persist a cold answer after canonical authority advances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const store = createSqliteAgentRunStore(root);
    await store.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model-1', 40, 200),
      { durable: true, latestContext: latestContext('attempt-1', 10, 'model-1') },
    );

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

    let advanced = false;
    const racing: Parameters<typeof readLatestContextDiagnostics>[0] = {
      readEvents: async (sessionId, runId) => {
        const events = await store.readEvents(sessionId, runId);
        if (!advanced) {
          advanced = true;
          await store.appendEvent(
            'session-1',
            'run-1',
            meteringEvent('run-1', 'attempt-2', 20, 'model-2', 40, 200),
            { durable: true, latestContext: latestContext('attempt-2', 20, 'model-2') },
          );
        }
        return events;
      },
      readEventProjection: (sessionId, type) => store.readEventProjection(sessionId, type),
      readEventLedgerRevision: (sessionId) => store.readEventLedgerRevision(sessionId),
      repairEventProjection: (sessionId, type, event, options) =>
        store.repairEventProjection(sessionId, type, event, options),
    };

    const cold = await readLatestContextDiagnostics(racing, 'session-1', ['run-1']);
    assert.equal(cold.status, 'available');
    if (cold.status !== 'available') return;
    assert.equal(cold.modelId, 'model-1', 'the in-flight read remains a valid earlier snapshot');

    const next = await readLatestContextDiagnostics(store, 'session-1', ['run-1']);
    assert.equal(next.status, 'available');
    if (next.status !== 'available') return;
    assert.equal(next.modelId, 'model-2', 'the stale scan never becomes the warm projection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rebuilds a nested-malformed v2 projection from the canonical ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200, {
        requestObservation: requestObservation([
          {
            kind: 'tool_schema',
            index: 0,
            cacheable: true,
            comparison: 'exact',
            digest: `sha256:${'a'.repeat(64)}`,
            bytes: 800,
            label: 'Bash',
          },
        ]),
      }),
      { durable: true, latestContext: latestContext('attempt-1', 10) },
    );
    await writer.repairEventProjection(
      'session-1',
      'latest_context',
      {
        type: 'latest_context',
        id: 'latest-context-malformed-v2',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-run-1',
        ts: 10,
        data: {
          ...latestContext('attempt-1', 10).snapshot,
          composition: { segments: 'not-an-array' },
        },
      },
      {
        ifLedgerRevision: await writer.readEventLedgerRevision('session-1'),
        replaceEventId: 'latest-context-attempt-1',
      },
    );

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });
    const first = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(first.status, 'available');
    if (first.status !== 'available') return;
    assert.deepEqual(first.composition?.tools, [{ name: 'Bash', bytes: 800 }]);
    assert.ok(scanned > 0, 'the malformed nested value cannot answer the warm read');

    scanned = 0;
    const second = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(second.status, 'available');
    assert.equal(scanned, 0, 'the canonical rebuild repaired the rejected projection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an old readable-order projection is upgraded after one cold rebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-context-diagnostics-'));
  try {
    await openRun(root, 'session-1', 'run-1');
    const writer = createSqliteAgentRunStore(root);
    await writer.appendEvent(
      'session-1',
      'run-1',
      meteringEvent('run-1', 'attempt-1', 10, 'model', 40, 200),
      { durable: true, latestContext: latestContext('attempt-1', 10) },
    );
    await writer.repairEventProjection(
      'session-1',
      'latest_context',
      {
        type: 'latest_context',
        id: 'latest-context-attempt-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-run-1',
        ts: 10,
        data: {
          ...latestContext('attempt-1', 10).snapshot,
          schemaVersion: 1,
          composition: { segments: [{ kind: 'tool_definitions', bytes: 999 }] },
        },
      },
      {
        ifLedgerRevision: await writer.readEventLedgerRevision('session-1'),
        replaceEventId: 'latest-context-attempt-1',
      },
    );

    let scanned = 0;
    const counted = countingStore(createSqliteAgentRunStore(root), () => {
      scanned += 1;
    });
    const first = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(first.status, 'available');
    assert.ok(scanned > 0, 'the old schema requires one canonical rebuild');

    scanned = 0;
    const second = await readLatestContextDiagnostics(counted, 'session-1', ['run-1']);
    assert.equal(second.status, 'available');
    assert.equal(scanned, 0, 'the rebuilt current schema replaces the old row');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Open the invocation these ledger writes belong to.
 *
 * The operational ledger anchors every run on its opening fact, so a test that
 * writes rows for a run has to say that the run began — and the opening is also
 * where a run says it belongs to a subagent rather than to the session.
 */
async function openRun(
  root: string,
  sessionId: string,
  runId: string,
  opening?: Partial<RuntimeEventInvocationOpenedContent>,
): Promise<void> {
  const runtimeStore = createWorkspaceRuntimeStore(root);
  try {
    await seedInvocation(runtimeStore, {
      sessionId,
      runId,
      turnId: `turn-${runId}`,
      ...(opening ? { opening } : {}),
    });
  } finally {
    runtimeStore.close();
  }
}

function countingStore(
  reader: ReturnType<typeof createSqliteAgentRunStore>,
  onScan: () => void,
): Parameters<typeof readLatestContextDiagnostics>[0] {
  return {
    readEvents: async (sessionId, runId) => {
      onScan();
      return reader.readEvents(sessionId, runId);
    },
    readEventProjection: (sessionId, type) => reader.readEventProjection(sessionId, type),
    readEventLedgerRevision: (sessionId) => reader.readEventLedgerRevision(sessionId),
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
      schemaVersion: 2,
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
  runs: Array<{ runId: string; events: AgentRunEvent[] }>,
): Pick<AgentRunStore, 'readEvents'> {
  return {
    readEvents: async (_sessionId, runId) => runs.find((run) => run.runId === runId)?.events ?? [],
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
  // A row from a retired writer. This build cannot emit the type; the diagnostic
  // reader still has to read what older builds persisted.
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
  } as unknown as EmittedAgentRunEvent;
}

/**
 * The durable canonical record. Identity, provider-reported numbers, and the
 * prepared-request observation all describe this one dispatched attempt.
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

function requestObservation(segments: Array<Record<string, unknown>>) {
  return {
    schemaVersion: 1,
    digest: `sha256:${'f'.repeat(64)}`,
    bytes: segments.reduce(
      (total, segment) => total + (typeof segment.bytes === 'number' ? segment.bytes : 0),
      0,
    ),
    segments,
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
        summary: sectionedSummary('Earlier context summary.'),
        summaryFormat: 'sections_v1',
        limitations: ['Estimated summary.'],
        estimatedTokens,
      },
    },
  };
}
