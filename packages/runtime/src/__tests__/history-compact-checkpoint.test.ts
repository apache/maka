import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildHistoryCompactCheckpoint,
  canReplaceHistoryCompactCheckpoint,
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  validateHistoryCompactCheckpointShape,
} from '../history-compact-checkpoint.js';
import {
  loadHistoryCompactCheckpointsFromRunLedger,
  loadLatestHistoryCompactCheckpointFromRunLedger,
} from '../history-compact-ledger.js';
import { estimateRuntimeEventsTokens } from '../context-budget.js';
import { applyRuntimeEventHistoryCompact } from '../history-compact.js';

describe('history compact checkpoint', () => {
  test('validates the exact ordered source prefix', () => {
    const events = Array.from({ length: 4 }, (_, index) => textEvent(index));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'Continuation summary.',
      now: 1_800_000_010_000,
    });

    assert.equal(validateHistoryCompactCheckpointShape(checkpoint, 'session-1'), true);
    const prefixMatch = matchHistoryCompactCheckpointPrefix(checkpoint, [...events, textEvent(4)]);
    assert.equal(prefixMatch.coveredEventCount, 4);
    assert.deepEqual(
      prefixMatch.successorRuntimeEvents.map((event) => event.id),
      ['event-4'],
    );

    const changed = [...events];
    changed[1] = {
      ...changed[1]!,
      content: { kind: 'text', text: 'changed source fact' },
    };
    assert.equal(
      matchHistoryCompactCheckpointPrefix(checkpoint, changed).reason,
      'source_hash_mismatch',
    );
    assert.equal(
      matchHistoryCompactCheckpointPrefix(checkpoint, [events[1]!, events[0]!, ...events.slice(2)])
        .reason,
      'coverage_miss',
    );
  });

  test('rejects blank summaries instead of persisting an unusable checkpoint', () => {
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: [textEvent(0)],
          summary: '   ',
        }),
      /non-empty summary/,
    );
  });

  test('preserves the complete model-produced summary instead of truncating it after generation', () => {
    const summary = [
      '## Goal',
      'Keep every section intact.',
      '## Critical Context',
      'LAST_REQUIRED_FACT',
    ]
      .join('\n')
      .repeat(80);

    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary,
    });

    assert.equal(checkpoint.summary, summary);
    assert.ok(checkpoint.summary.endsWith('LAST_REQUIRED_FACT'));
  });

  test('rejects a source projection assembled from more than one session', () => {
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: [textEvent(0), { ...textEvent(1), sessionId: 'session-2' }],
          summary: 'mixed source',
        }),
      /one session/,
    );
  });

  test('rejects inconsistent projection cursors', () => {
    const events = [textEvent(0), textEvent(1)];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'source-bound',
    });
    const invalid = {
      ...checkpoint,
      source: {
        ...checkpoint.source!,
        coverage: {
          ...checkpoint.source!.coverage,
          highWater: { ...checkpoint.source!.coverage.highWater, sequence: 99 },
        },
      },
    };
    assert.equal(validateHistoryCompactCheckpointShape(invalid, 'session-1'), false);
    assert.equal(matchHistoryCompactCheckpointPrefix(invalid, events).reason, 'invalid_checkpoint');
  });

  test('only accepts an equal-coverage checkpoint as an explicit successor of the same source', () => {
    const source = [textEvent(0), textEvent(1)];
    const current = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'current',
    });
    const successor = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'smaller replacement',
      previousCheckpointId: current.checkpointId,
    });
    const stale = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'stale replacement',
      previousCheckpointId: 'another-checkpoint',
    });
    const differentSource = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(2), textEvent(3)],
      summary: 'different source',
      previousCheckpointId: current.checkpointId,
    });

    assert.equal(canReplaceHistoryCompactCheckpoint(current, successor), true);
    assert.equal(canReplaceHistoryCompactCheckpoint(current, stale), false);
    assert.equal(canReplaceHistoryCompactCheckpoint(current, differentSource), false);
    const { source: _source, ...legacySuccessor } = successor;
    assert.equal(
      canReplaceHistoryCompactCheckpoint(current, legacySuccessor as typeof successor),
      false,
    );
  });

  test('loads the latest valid checkpoint from the run ledger', async () => {
    const first = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'first',
      now: 10,
    });
    const latest = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'latest',
      previousCheckpointId: first.checkpointId,
      now: 20,
    });
    const store = new StubAgentRunStore(
      [run('run-1', 10), run('run-2', 20), run('run-3', 30)],
      new Map([
        ['run-1', [checkpointEvent('ledger-1', 'run-1', first, 10)]],
        ['run-2', [checkpointEvent('ledger-2', 'run-2', latest, 20)]],
        [
          'run-3',
          [
            {
              ...checkpointEvent('ledger-3', 'run-3', latest, 30),
              data: { checkpoint: { ...latest, summary: ' ' } },
            },
          ],
        ],
      ]),
    );

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, latest.checkpointId);
    assert.deepEqual(
      (await loadHistoryCompactCheckpointsFromRunLedger(store, 'session-1')).map(
        (checkpoint) => checkpoint.checkpointId,
      ),
      [first.checkpointId, latest.checkpointId],
    );
  });

  test('binds an automatic Memory boundary into checkpoint identity while legacy remains valid', () => {
    const source = [textEvent(0)];
    const legacy = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'same summary',
    });
    const automatic = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'same summary',
      memoryExtractionBoundary: {
        runId: 'run-1',
        turnId: 'turn-1',
        runtimeEventId: 'event-boundary',
      },
    });
    const denied = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'same summary',
      memoryExtractionBoundary: {
        runId: 'run-1',
        turnId: 'turn-1',
        runtimeEventId: 'event-boundary',
        disposition: 'policy_denied',
      },
    });

    assert.notEqual(automatic.checkpointId, legacy.checkpointId);
    assert.notEqual(denied.checkpointId, automatic.checkpointId);
    assert.equal(validateHistoryCompactCheckpointShape(legacy, 'session-1'), true);
    assert.equal(validateHistoryCompactCheckpointShape(automatic, 'session-1'), true);
    assert.equal(
      validateHistoryCompactCheckpointShape(
        {
          ...automatic,
          memoryExtractionBoundary: {
            ...automatic.memoryExtractionBoundary!,
            runtimeEventId: '',
          },
        },
        'session-1',
      ),
      false,
    );
    assert.equal(
      validateHistoryCompactCheckpointShape(
        {
          ...denied,
          memoryExtractionBoundary: {
            ...denied.memoryExtractionBoundary!,
            disposition: 'invalid' as never,
          },
        },
        'session-1',
      ),
      false,
    );
  });

  test('loads the furthest checkpoint when a later run records stale coverage', async () => {
    const furthest = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1), textEvent(2)],
      summary: 'furthest coverage',
    });
    const stale = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'stale coverage',
    });
    const store = new StubAgentRunStore(
      [run('run-furthest', 10), run('run-stale', 20)],
      new Map([
        ['run-furthest', [checkpointEvent('ledger-furthest', 'run-furthest', furthest, 30)]],
        ['run-stale', [checkpointEvent('ledger-stale', 'run-stale', stale, 40)]],
      ]),
    );

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, furthest.checkpointId);
  });

  test('recovers the tip of an out-of-order same-coverage successor chain across runs', async () => {
    const source = [textEvent(0), textEvent(1)];
    const first = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'first',
      now: 10,
    });
    const second = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'second',
      previousCheckpointId: first.checkpointId,
      now: 20,
    });
    const tip = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'tip',
      previousCheckpointId: second.checkpointId,
      now: 30,
    });
    const store = new StubAgentRunStore(
      [run('parent-created-first', 10), run('child-created-later', 20)],
      new Map([
        [
          'parent-created-first',
          [
            checkpointEvent('ledger-second', 'parent-created-first', second, 20),
            checkpointEvent('ledger-tip', 'parent-created-first', tip, 30),
          ],
        ],
        [
          'child-created-later',
          [checkpointEvent('ledger-first', 'child-created-later', first, 10)],
        ],
      ]),
    );
    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, tip.checkpointId);
  });

  test('loads a bounded checkpoint projection without enumerating run ledgers', async () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'bounded projection',
    });
    const projectedEvent = checkpointEvent('projection-event', 'run-projection', checkpoint, 20);
    const store = {
      readEventProjection: async () => projectedEvent,
      listSessionRuns: async () => {
        throw new Error('run enumeration must stay cold');
      },
      readEvents: async () => {
        throw new Error('run ledger reads must stay cold');
      },
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, checkpoint.checkpointId);
  });

  test('uses an empty bounded projection without enumerating run ledgers', async () => {
    const store = {
      readEventProjection: async () => null,
      listSessionRuns: async () => {
        throw new Error('run enumeration must stay cold');
      },
      readEvents: async () => {
        throw new Error('run ledger reads must stay cold');
      },
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded, undefined);
  });

  test('recovers and repairs an uninitialized bounded projection from the canonical ledger', async () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'recovered checkpoint',
    });
    const event = checkpointEvent('recovered-event', 'run-recovered', checkpoint, 20);
    const repaired: Array<AgentRunEvent | null> = [];
    const store = {
      readEventProjection: async () => undefined,
      repairEventProjection: async (
        _sessionId: string,
        _type: AgentRunEvent['type'],
        repairedEvent: AgentRunEvent | null,
      ) => {
        repaired.push(repairedEvent);
      },
      listSessionRuns: async () => [run('run-recovered', 10)],
      readEvents: async () => [event],
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, checkpoint.checkpointId);
    assert.deepEqual(repaired, [event]);
  });

  test('identifies a parseable but invalid projection when repairing from the canonical ledger', async () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'canonical checkpoint',
    });
    const canonicalEvent = checkpointEvent('canonical-event', 'run-canonical', checkpoint, 20);
    const invalidProjection = {
      ...canonicalEvent,
      id: 'invalid-projection-event',
      data: { checkpoint: { coverage: { eventCount: 999 } } },
    } as AgentRunEvent;
    const replacedEventIds: Array<string | undefined> = [];
    const store = {
      readEventProjection: async () => invalidProjection,
      repairEventProjection: async (
        _sessionId: string,
        _type: AgentRunEvent['type'],
        _event: AgentRunEvent | null,
        options?: { replaceEventId?: string },
      ) => {
        replacedEventIds.push(options?.replaceEventId);
      },
      listSessionRuns: async () => [run('run-canonical', 10)],
      readEvents: async () => [canonicalEvent],
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, checkpoint.checkpointId);
    assert.deepEqual(replacedEventIds, [invalidProjection.id]);
  });

  test('propagates recovery failure from a damaged bounded projection', async () => {
    const store = {
      readEventProjection: async () => {
        throw new Error('damaged projection');
      },
      listSessionRuns: async () => {
        throw new Error('ledger recovery failed');
      },
      readEvents: async () => [],
    };

    await assert.rejects(
      loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1'),
      /ledger recovery failed/,
    );
  });

  test('replays a matching checkpoint with only the uncovered raw tail', () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      ...textEvent(index),
      content: {
        kind: 'text' as const,
        text: `source-payload-${index} `.repeat(index < 4 ? 40 : 1),
      },
    }));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 4),
      summary: 'checkpoint summary',
    });

    const replay = applyRuntimeEventHistoryCompact(
      events,
      {
        enabled: true,
        mode: 'read_write',
        checkpoint,
        highWaterRatio: 0.01,
        tailEstimatedTokens: 1,
      },
      1,
      1_000,
    );

    assert.equal(replay.events[0]?.id, `history-compact:${checkpoint.checkpointId}`);
    assert.match(
      replay.events[0]?.content?.kind === 'text' ? replay.events[0].content.text : '',
      /checkpoint summary/,
    );
    assert.deepEqual(
      replay.events.slice(1).map((event) => event.id),
      events.slice(4).map((event) => event.id),
    );
    assert.equal(replay.checkpoint?.checkpointId, checkpoint.checkpointId);
  });

  test('replays a durable pre_turn checkpoint below the current high water', () => {
    const events = Array.from({ length: 6 }, (_, index) => ({
      ...textEvent(index),
      content: {
        kind: 'text' as const,
        text: `small-payload-${index} `.repeat(index < 4 ? 200 : 1),
      },
    }));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 4),
      summary: 'recovery checkpoint summary',
    });

    // The raw history is deliberately far below high water. Once a durable
    // checkpoint exists, replaying it is nevertheless mandatory: otherwise a
    // recovery/manual compaction only affects its own turn and the next turn
    // resurrects the covered raw prefix.
    const replay = applyRuntimeEventHistoryCompact(
      events,
      { enabled: true, mode: 'read_write', checkpoint },
      4,
      1_000_000,
    );

    assert.equal(replay.checkpoint?.checkpointId, checkpoint.checkpointId);
    assert.deepEqual(
      replay.events.map((event) => event.id),
      [`history-compact:${checkpoint.checkpointId}`, 'event-4', 'event-5'],
    );
    assert.equal(replay.diagnosticPatch.historyCompactBlocksSelected, 1);
    assert.equal(replay.diagnosticPatch.historyCompactSkippedReasonCounts, undefined);
  });

  test('accepts a complete checkpoint above legacy block limits when the full replay fits', () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      ...textEvent(index),
      content: {
        kind: 'text' as const,
        text: `source-payload-${index} `.repeat(index < 4 ? 80 : 1),
      },
    }));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 4),
      summary: 'checkpoint summary '.repeat(20),
      charsPerToken: 1,
    });
    assert.ok(checkpoint.estimatedTokens > 100);

    const replay = applyRuntimeEventHistoryCompact(
      events,
      {
        enabled: true,
        mode: 'read_write',
        checkpoint,
        maxBlockEstimatedTokens: 10_000,
        maxEstimatedTokens: 100,
        highWaterRatio: 0.000001,
        tailEstimatedTokens: 1,
      },
      1,
      10_000,
    );

    assert.equal(replay.checkpoint?.checkpointId, checkpoint.checkpointId);
    assert.equal(
      replay.events.some((event) => event.id === `history-compact:${checkpoint.checkpointId}`),
      true,
    );
  });

  test('applies max-history overrides to checkpoint replay validation', () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      ...textEvent(index),
      content: { kind: 'text' as const, text: `payload-${index} `.repeat(20) },
    }));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 6),
      summary: 'short checkpoint',
      charsPerToken: 1,
    });
    const checkpointTokens = estimateRuntimeEventsTokens(
      [historyCompactCheckpointToRuntimeEvent(checkpoint)],
      1,
    );
    const overrideMax = checkpointTokens + 1;

    const replay = applyRuntimeEventHistoryCompact(
      events,
      {
        enabled: true,
        mode: 'read_write',
        checkpoint,
        maxBlockEstimatedTokens: 10_000,
        maxEstimatedTokens: 10_000,
        highWaterRatio: 0.000001,
        tailEstimatedTokens: 1,
      },
      1,
      10_000,
      { maxHistoryEstimatedTokens: overrideMax },
    );

    assert.equal(replay.checkpoint, undefined);
  });
});

function textEvent(index: number): RuntimeEvent {
  return {
    id: `event-${index}`,
    sessionId: 'session-1',
    runId: `run-${Math.floor(index / 2)}`,
    turnId: `turn-${Math.floor(index / 2)}`,
    invocationId: `invocation-${Math.floor(index / 2)}`,
    ts: 1_800_000_000_000 + index,
    partial: false,
    role: index % 2 === 0 ? 'user' : 'model',
    author: index % 2 === 0 ? 'user' : 'agent',
    content: { kind: 'text', text: `payload-${index}` },
  };
}

function run(runId: string, createdAt: number): AgentRunHeader {
  return {
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'test',
    modelId: 'test',
    cwd: '/tmp',
    permissionMode: 'ask',
    createdAt,
    updatedAt: createdAt,
  };
}

function checkpointEvent(
  id: string,
  runId: string,
  checkpoint: ReturnType<typeof buildHistoryCompactCheckpoint>,
  ts: number,
): AgentRunEvent {
  return {
    type: 'history_compact_checkpoint_recorded',
    id,
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    ts,
    data: { checkpoint },
  };
}

class StubAgentRunStore implements AgentRunStore {
  constructor(
    private readonly runs: AgentRunHeader[],
    private readonly events: Map<string, AgentRunEvent[]>,
  ) {}

  async listSessionRuns(): Promise<AgentRunHeader[]> {
    return this.runs;
  }

  async readEvents(_sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.events.get(runId) ?? [];
  }

  async createRun(): Promise<AgentRunHeader> {
    throw new Error('not implemented');
  }
  async updateRun(): Promise<AgentRunHeader> {
    throw new Error('not implemented');
  }
  async readRun(): Promise<AgentRunHeader> {
    throw new Error('not implemented');
  }
  async appendEvent(): Promise<void> {
    throw new Error('not implemented');
  }
}
