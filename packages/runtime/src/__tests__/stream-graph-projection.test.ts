import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import {
  projectAgentGraphRecords,
  readCommittedAgentGraphProjection,
  replayAgentGraphRecords,
} from '../stream-graph-projection.js';

const baseTs = 1_800_000_000_000;

describe('committed stream graph projection', () => {
  test('projects immutable child-session events into a stable reference-only graph trace', async () => {
    const runA = runHeader({
      sessionId: 'child-a',
      runId: 'run-a',
      turnId: 'turn-a',
      status: 'completed',
      createdAt: baseTs,
    });
    const runB = runHeader({
      sessionId: 'child-b',
      runId: 'run-b',
      turnId: 'turn-b',
      status: 'failed',
      createdAt: baseTs + 1,
    });
    const eventsByRun = new Map<string, RuntimeEvent[]>([
      [
        runA.runId,
        [
          runtimeEvent(runA, {
            id: 'a-message',
            ts: baseTs + 1,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text: 'payload-must-not-be-copied' },
          }),
          runtimeEvent(runA, {
            id: 'a-partial',
            ts: baseTs + 2,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text: 'mutable-stream-chunk' },
          }),
          runtimeEvent(runA, {
            id: 'a-permission',
            ts: baseTs + 4,
            actions: {
              permissionRequest: {
                kind: 'tool_permission',
                requestId: 'permission-a',
                toolUseId: 'tool-a',
                toolName: 'Read',
                category: 'read',
                reason: 'custom',
                args: {},
                rememberForTurnAllowed: true,
              },
            },
          }),
          runtimeEvent(runA, {
            id: 'a-permission-decision',
            ts: baseTs + 5,
            author: 'user',
            actions: {
              permissionDecision: {
                requestId: 'permission-a',
                decision: 'allow',
                rememberForTurn: false,
              },
            },
          }),
          runtimeEvent(runA, {
            id: 'a-complete',
            ts: baseTs + 8,
            status: 'completed',
            actions: { endInvocation: true },
          }),
        ],
      ],
      [
        runB.runId,
        [
          runtimeEvent(runB, {
            id: 'b-tool-call',
            ts: baseTs + 2,
            role: 'model',
            author: 'agent',
            content: { kind: 'function_call', id: 'tool-b', name: 'Grep', args: {} },
          }),
          runtimeEvent(runB, {
            id: 'b-tool-result',
            ts: baseTs + 6,
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'tool-b',
              name: 'Grep',
              result: { matches: 0 },
            },
          }),
          runtimeEvent(runB, {
            id: 'b-failed',
            ts: baseTs + 7,
            status: 'failed',
            content: { kind: 'error', message: 'provider failed' },
          }),
        ],
      ],
    ]);

    const projection = await readCommittedAgentGraphProjection({
      graphId: 'graph-1',
      operators: [
        { operatorId: 'research', sessionId: runA.sessionId },
        { operatorId: 'verify', sessionId: runB.sessionId },
      ],
      runStore: {
        async listSessionRuns(sessionId) {
          return sessionId === runA.sessionId ? [runA] : [runB];
        },
      },
      runtimeEventStore: {
        async readImmutableRuntimeEvents(_sessionId, runId) {
          return eventsByRun.get(runId) ?? [];
        },
      },
    });

    assert.equal(projection.ignoredPartialEvents, 1);
    assert.deepEqual(
      projection.records.map((record) => record.source.runtimeEventId),
      [
        'a-message',
        'b-tool-call',
        'a-permission',
        'a-permission-decision',
        'b-tool-result',
        'b-failed',
        'a-complete',
      ],
    );
    assert.deepEqual(
      projection.records.map((record) => record.eventTime),
      [baseTs + 1, baseTs + 2, baseTs + 4, baseTs + 5, baseTs + 6, baseTs + 7, baseTs + 8],
    );
    assert.deepEqual(
      projection.records
        .filter((record) => record.operatorId === 'research')
        .map((record) => record.orderKey.committedEventOrdinal),
      [0, 1, 2, 3],
      'partial events do not renumber committed source facts',
    );
    assert.deepEqual(projection.records[0]?.facets, ['message']);
    assert.deepEqual(projection.records[1]?.facets, ['tool_call']);
    assert.deepEqual(projection.records[5]?.facets, ['error', 'failed']);
    assert.deepEqual(projection.records[2]?.supervisorSignals, [
      { kind: 'attention', reason: 'permission_request' },
    ]);
    assert.deepEqual(projection.records[5]?.supervisorSignals, [
      { kind: 'terminal', status: 'failed' },
    ]);
    assert.deepEqual(
      projection.supervisorMetaStream.map((record) => record.recordId),
      projection.records.map((record) => record.recordId),
      'the supervisor observes every graph record, not only attention records',
    );
    assert.deepEqual(projection.supervisorMetaStream[0]?.signals, []);
    assert.deepEqual(projection.supervisorMetaStream[2]?.signals, [
      { kind: 'attention', reason: 'permission_request' },
    ]);
    assert.equal(
      replayAgentGraphRecords(projection.records.slice(0, 3)).operators.research?.status,
      'running',
      'supervisor attention is orthogonal to graph lifecycle',
    );
    assert.equal(projection.state.operators.research?.status, 'completed');
    assert.equal(projection.state.operators.verify?.status, 'failed');
    assert.equal(projection.state.operators.research?.activations['run-a']?.recordCount, 4);
    assert.equal(projection.records[0]?.previousRecordId, undefined);
    assert.equal(
      projection.records[2]?.previousRecordId,
      projection.records[0]?.recordId,
      'predecessors are activation-local rather than global',
    );
    assert.doesNotMatch(JSON.stringify(projection.records), /payload-must-not-be-copied/);
    assert.doesNotMatch(JSON.stringify(projection.records), /mutable-stream-chunk/);
  });

  test('replay is deterministic for reordered delivery and idempotent duplicates', () => {
    const run = runHeader({
      sessionId: 'child-a',
      runId: 'run-a',
      turnId: 'turn-a',
      status: 'completed',
      createdAt: baseTs,
    });
    const { records } = projectAgentGraphRecords({
      graphId: 'graph-replay',
      streams: [
        {
          operator: { operatorId: 'research', sessionId: run.sessionId },
          run,
          events: [
            runtimeEvent(run, {
              id: 'message',
              ts: baseTs + 1,
              role: 'model',
              author: 'agent',
              content: { kind: 'text', text: 'result' },
            }),
            runtimeEvent(run, {
              id: 'complete',
              ts: baseTs + 2,
              status: 'completed',
            }),
          ],
        },
      ],
    });

    const canonical = replayAgentGraphRecords(records);
    const reorderedWithDuplicates = replayAgentGraphRecords([
      records[1]!,
      records[0]!,
      records[0]!,
      records[1]!,
    ]);
    assert.deepEqual(reorderedWithDuplicates, canonical);
  });

  test('replays reserved JavaScript property names as ordinary graph identities', () => {
    const run = runHeader({
      sessionId: 'reserved-session',
      runId: 'constructor',
      turnId: 'reserved-turn',
      status: 'running',
      createdAt: baseTs,
    });
    const { records } = projectAgentGraphRecords({
      graphId: 'graph-reserved-identities',
      streams: [
        {
          operator: { operatorId: '__proto__', sessionId: run.sessionId },
          run,
          events: [runtimeEvent(run, { id: 'toString', ts: baseTs + 1 })],
        },
      ],
    });

    const state = replayAgentGraphRecords(records);
    assert.equal(Object.hasOwn(state.operators, '__proto__'), true);
    assert.equal(state.operators['__proto__']?.operatorId, '__proto__');
    assert.equal(
      Object.hasOwn(state.operators['__proto__']?.activations ?? {}, 'constructor'),
      true,
    );
    const reservedActivation = Object.entries(state.operators['__proto__']?.activations ?? {}).find(
      ([activationId]) => activationId === 'constructor',
    )?.[1];
    assert.equal(reservedActivation?.agentRunId, 'constructor');
  });

  test('rejects one Session projected under different operators across observations', () => {
    const run = runHeader({
      sessionId: 'child-a',
      runId: 'run-a',
      turnId: 'turn-a',
      status: 'running',
      createdAt: baseTs,
    });
    const event = runtimeEvent(run, {
      id: 'shared-event',
      ts: baseTs + 1,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'one durable fact' },
    });
    const first = projectAgentGraphRecords({
      graphId: 'graph-session-owner',
      streams: [
        {
          operator: { operatorId: 'one', sessionId: run.sessionId },
          run,
          events: [event],
        },
      ],
    });
    const second = projectAgentGraphRecords({
      graphId: 'graph-session-owner',
      streams: [
        {
          operator: { operatorId: 'two', sessionId: run.sessionId },
          run,
          events: [event],
        },
      ],
    });

    assert.notEqual(first.records[0]?.recordId, second.records[0]?.recordId);
    assert.throws(
      () => replayAgentGraphRecords([...first.records, ...second.records]),
      /Session child-a is bound to both one and two/,
    );
  });

  test('keeps existing records byte-stable when a late operator contributes earlier event time', () => {
    const runA = runHeader({
      sessionId: 'child-a',
      runId: 'run-a',
      turnId: 'turn-a',
      status: 'running',
      createdAt: baseTs,
    });
    const runB = runHeader({
      sessionId: 'child-b',
      runId: 'run-b',
      turnId: 'turn-b',
      status: 'running',
      createdAt: baseTs + 1,
    });
    const streamA = {
      operator: { operatorId: 'research', sessionId: runA.sessionId },
      run: runA,
      events: [
        runtimeEvent(runA, {
          id: 'event-a',
          ts: baseTs + 100,
          role: 'model' as const,
          author: 'agent' as const,
          content: { kind: 'text' as const, text: 'A' },
        }),
      ],
    };
    const streamB = {
      operator: { operatorId: 'verify', sessionId: runB.sessionId },
      run: runB,
      events: [
        runtimeEvent(runB, {
          id: 'event-b',
          ts: baseTs + 90,
          role: 'model' as const,
          author: 'agent' as const,
          content: { kind: 'text' as const, text: 'B' },
        }),
      ],
    };

    const initial = projectAgentGraphRecords({
      graphId: 'graph-incremental',
      streams: [streamA],
    });
    const expanded = projectAgentGraphRecords({
      graphId: 'graph-incremental',
      streams: [streamA, streamB],
    });
    const initialA = initial.records.find((record) => record.source.runtimeEventId === 'event-a');
    const expandedA = expanded.records.find((record) => record.source.runtimeEventId === 'event-a');

    assert.deepEqual(expandedA, initialA);
    assert.deepEqual(
      expanded.records.map((record) => record.source.runtimeEventId),
      ['event-b', 'event-a'],
    );
    const replayed = replayAgentGraphRecords([...initial.records, ...expanded.records]);
    assert.equal(replayed.appliedRecordIds.length, 2);
  });

  test('allows equal event times and resolves them with the stable source order key', () => {
    const first = runHeader({
      sessionId: 'child-z',
      runId: 'run-z',
      turnId: 'turn-z',
      status: 'running',
      createdAt: baseTs,
    });
    const second = runHeader({
      sessionId: 'child-a',
      runId: 'run-a',
      turnId: 'turn-a',
      status: 'running',
      createdAt: baseTs + 1,
    });
    const { records } = projectAgentGraphRecords({
      graphId: 'graph-equal-time',
      streams: [
        {
          operator: { operatorId: 'z-operator', sessionId: first.sessionId },
          run: first,
          events: [runtimeEvent(first, { id: 'event-z', ts: baseTs + 10 })],
        },
        {
          operator: { operatorId: 'a-operator', sessionId: second.sessionId },
          run: second,
          events: [runtimeEvent(second, { id: 'event-a', ts: baseTs + 10 })],
        },
      ],
    });

    assert.deepEqual(
      records.map((record) => record.source.runtimeEventId),
      ['event-z', 'event-a'],
      'run creation time wins before lexical operator identity',
    );
    assert.deepEqual(
      records.map((record) => record.eventTime),
      [baseTs + 10, baseTs + 10],
    );
    assert.equal(replayAgentGraphRecords(records).appliedRecordIds.length, 2);
  });

  test('projects concurrent tool commits whose immutable event times are not commit-monotonic', () => {
    const run = runHeader({
      sessionId: 'child-concurrent',
      runId: 'run-concurrent',
      turnId: 'turn-concurrent',
      status: 'running',
      createdAt: baseTs,
    });
    const { records } = projectAgentGraphRecords({
      graphId: 'graph-concurrent-tools',
      streams: [
        {
          operator: { operatorId: 'implementation', sessionId: run.sessionId },
          run,
          // Canonical stores return commit/event-sequence order. A later-started
          // concurrent tool may commit after a newer progress fact.
          events: [
            runtimeEvent(run, { id: 'newer-progress', ts: baseTs + 20 }),
            runtimeEvent(run, {
              id: 'earlier-tool-call',
              ts: baseTs + 10,
              role: 'model',
              author: 'agent',
              content: { kind: 'function_call', id: 'call-1', name: 'Read', args: {} },
            }),
          ],
        },
      ],
    });

    assert.deepEqual(
      records.map((record) => record.source.runtimeEventId),
      ['earlier-tool-call', 'newer-progress'],
    );
    assert.deepEqual(
      records.map((record) => record.orderKey.committedEventOrdinal),
      [1, 0],
      'the stable source ordinal continues to describe canonical commit order',
    );
  });

  test('orders locale-equivalent Unicode source identities independently of stream input order', () => {
    const precomposedId = '\u00e9';
    const decomposedId = 'e\u0301';
    assert.equal(precomposedId.localeCompare(decomposedId), 0);
    const precomposed = runHeader({
      sessionId: 'child-precomposed',
      runId: precomposedId,
      turnId: 'turn-precomposed',
      status: 'running',
      createdAt: baseTs,
    });
    const decomposed = runHeader({
      sessionId: 'child-decomposed',
      runId: decomposedId,
      turnId: 'turn-decomposed',
      status: 'running',
      createdAt: baseTs,
    });
    const streams = [
      {
        operator: { operatorId: precomposedId, sessionId: precomposed.sessionId },
        run: precomposed,
        events: [runtimeEvent(precomposed, { id: precomposedId, ts: baseTs + 1 })],
      },
      {
        operator: { operatorId: decomposedId, sessionId: decomposed.sessionId },
        run: decomposed,
        events: [runtimeEvent(decomposed, { id: decomposedId, ts: baseTs + 1 })],
      },
    ];

    const canonical = projectAgentGraphRecords({
      graphId: 'graph-unicode-order',
      streams,
    });
    const reversed = projectAgentGraphRecords({
      graphId: 'graph-unicode-order',
      streams: [...streams].reverse(),
    });

    assert.deepEqual(reversed, canonical);
  });

  test('routes human-interaction facts to the always-on supervisor without blocking lifecycle', () => {
    const run = runHeader({
      sessionId: 'child-a',
      runId: 'run-a',
      turnId: 'turn-a',
      status: 'running',
      createdAt: baseTs,
    });
    const { records } = projectAgentGraphRecords({
      graphId: 'graph-supervisor',
      streams: [
        {
          operator: { operatorId: 'research', sessionId: run.sessionId },
          run,
          events: [
            runtimeEvent(run, {
              id: 'permission-request',
              ts: baseTs + 1,
              actions: {
                permissionRequest: {
                  kind: 'tool_permission',
                  requestId: 'permission-1',
                  toolUseId: 'tool-1',
                  toolName: 'Read',
                  category: 'read',
                  reason: 'custom',
                  args: {},
                  rememberForTurnAllowed: true,
                },
              },
            }),
            runtimeEvent(run, {
              id: 'question-request',
              ts: baseTs + 2,
              actions: {
                userQuestionRequest: {
                  requestId: 'question-1',
                  toolUseId: 'tool-2',
                  questions: [{ question: 'Choose', options: [{ label: 'Continue' }] }],
                },
              },
            }),
            runtimeEvent(run, {
              id: 'question-answer',
              ts: baseTs + 3,
              actions: {
                userQuestionAnswerAccepted: { requestId: 'question-1' },
              },
            }),
          ],
        },
      ],
    });

    assert.deepEqual(
      records.map((record) => record.supervisorSignals),
      [
        [{ kind: 'attention', reason: 'permission_request' }],
        [{ kind: 'attention', reason: 'user_question_request' }],
        [],
      ],
    );
    assert.deepEqual(records[2]?.facets, ['runtime_fact']);
    assert.equal(replayAgentGraphRecords(records).operators.research?.status, 'running');
  });

  test('keeps later session-inline runs as distinct activations of one operator', () => {
    const first = runHeader({
      sessionId: 'child-a',
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      createdAt: baseTs,
    });
    const followup = runHeader({
      sessionId: 'child-a',
      runId: 'run-2',
      turnId: 'turn-2',
      status: 'completed',
      createdAt: baseTs + 10,
    });
    const { records } = projectAgentGraphRecords({
      graphId: 'graph-followup',
      streams: [
        {
          operator: { operatorId: 'research', sessionId: first.sessionId },
          run: followup,
          events: [
            runtimeEvent(followup, {
              id: 'followup-complete',
              ts: baseTs + 11,
              status: 'completed',
            }),
          ],
        },
        {
          operator: { operatorId: 'research', sessionId: first.sessionId },
          run: first,
          events: [
            runtimeEvent(first, {
              id: 'initial-complete',
              ts: baseTs + 1,
              status: 'completed',
            }),
          ],
        },
      ],
    });

    const state = replayAgentGraphRecords(records);
    assert.deepEqual(Object.keys(state.operators.research?.activations ?? {}), ['run-1', 'run-2']);
    assert.equal(state.operators.research?.currentActivationId, 'run-2');
  });

  test('fails closed on ambiguous authority or impossible replay order', async () => {
    const run = runHeader({
      sessionId: 'child-a',
      runId: 'run-a',
      turnId: 'turn-a',
      status: 'completed',
      createdAt: baseTs,
    });
    const runtimeEventStore: Pick<RuntimeEventStore, 'readImmutableRuntimeEvents'> = {};

    await assert.rejects(
      readCommittedAgentGraphProjection({
        graphId: 'graph-no-immutable-reader',
        operators: [{ operatorId: 'research', sessionId: run.sessionId }],
        runStore: {
          async listSessionRuns() {
            return [run];
          },
        },
        runtimeEventStore,
      }),
      /requires immutable RuntimeEvent reads/,
    );

    const { records } = projectAgentGraphRecords({
      graphId: 'graph-terminal',
      streams: [
        {
          operator: { operatorId: 'research', sessionId: run.sessionId },
          run,
          events: [
            runtimeEvent(run, { id: 'terminal', ts: baseTs + 1, status: 'completed' }),
            runtimeEvent(run, {
              id: 'after-terminal',
              ts: baseTs + 2,
              role: 'model',
              author: 'agent',
              content: { kind: 'text', text: 'impossible' },
            }),
          ],
        },
      ],
    });
    assert.throws(() => replayAgentGraphRecords(records), /appears after terminal record/);
  });

  test('preserves graph identity when no committed operator facts exist yet', async () => {
    const projection = await readCommittedAgentGraphProjection({
      graphId: 'graph-empty',
      operators: [],
      runStore: {
        async listSessionRuns() {
          return [];
        },
      },
      runtimeEventStore: {
        async readImmutableRuntimeEvents() {
          return [];
        },
      },
    });

    assert.deepEqual(projection.state, {
      graphId: 'graph-empty',
      appliedRecordIds: [],
      operators: {},
    });
  });
});

function runHeader(input: {
  sessionId: string;
  runId: string;
  turnId: string;
  status: AgentRunHeader['status'];
  createdAt: number;
}): AgentRunHeader {
  return {
    ...input,
    invocationId: `invocation-${input.runId}`,
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'deepseek',
    modelId: 'deepseek-chat',
    cwd: '/workspace',
    permissionMode: 'explore',
    updatedAt: input.createdAt + 1,
    ...(input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled'
      ? { completedAt: input.createdAt + 1 }
      : {}),
  };
}

function runtimeEvent(
  run: AgentRunHeader,
  overrides: Partial<RuntimeEvent> & Pick<RuntimeEvent, 'id' | 'ts'>,
): RuntimeEvent {
  return {
    invocationId: run.invocationId ?? `invocation-${run.runId}`,
    runId: run.runId,
    sessionId: run.sessionId,
    turnId: run.turnId,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}
