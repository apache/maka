import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import {
  AGENT_GRAPH_READINESS_SCHEMA_VERSION,
  buildAgentGraphReadinessSnapshot,
  type AgentGraphReadinessPolicy,
} from '../stream-graph-readiness.js';
import { projectAgentGraphRecords } from '../stream-graph-projection.js';
import type { AgentGraphTraceTopology } from '../stream-graph-trace.js';

const baseTs = 1_800_000_000_000;

describe('operator-local stream graph readiness', () => {
  test('derives one stable map intent per direct input route without supervisor gating', () => {
    const source = runHeader('source', baseTs);
    const worker = runHeader('worker', baseTs + 1);
    const projection = projectAgentGraphRecords({
      graphId: 'graph-map',
      streams: [
        stream(source, 'source', [
          runtimeEvent(source, 'first', baseTs + 1, 'private-first-payload'),
          runtimeEvent(source, 'second', baseTs + 2, 'private-second-payload'),
        ]),
      ],
    });
    const topology: AgentGraphTraceTopology = {
      graphId: 'graph-map',
      operators: [binding(worker, 'worker'), binding(source, 'source')],
      edges: [
        {
          edgeId: 'source-worker',
          fromOperatorId: 'source',
          toOperatorId: 'worker',
        },
      ],
    };
    const policies: AgentGraphReadinessPolicy[] = [
      { readinessId: 'worker-map', operatorId: 'worker', kind: 'map' },
    ];

    const snapshot = buildAgentGraphReadinessSnapshot({
      topology,
      records: projection.records,
      policies,
    });
    const state = snapshot.readiness['worker-map'];

    assert.equal(snapshot.schemaVersion, AGENT_GRAPH_READINESS_SCHEMA_VERSION);
    assert.equal(state?.status, 'runnable');
    assert.equal(state?.intents.length, 2);
    assert.deepEqual(
      state?.intents.map((intent) => intent.targetSessionId),
      [worker.sessionId, worker.sessionId],
    );
    assert.deepEqual(
      state?.intents.map((intent) => intent.triggerRouteIds),
      snapshot.trace.routes.map((route) => [route.routeId]),
    );
    assert.deepEqual(
      state?.intents.map((intent) => intent.triggerRecordIds),
      projection.records.map((record) => [record.recordId]),
    );
    assert.equal(new Set(state?.intents.map((intent) => intent.intentId)).size, 2);
    assert.deepEqual(snapshot.supervisorView, [
      {
        graphId: 'graph-map',
        topologyFingerprint: snapshot.topologyFingerprint,
        readinessId: 'worker-map',
        operatorId: 'worker',
        policyKind: 'map',
        policyFingerprint: state?.policyFingerprint,
        readinessContextFingerprint: state?.readinessContextFingerprint,
        status: 'runnable',
        intentIds: state?.intents.map((intent) => intent.intentId),
        waitingFor: [],
      },
    ]);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-(first|second)-payload/);

    const replayed = buildAgentGraphReadinessSnapshot({
      topology: {
        ...topology,
        operators: [...topology.operators].reverse(),
        edges: [...topology.edges].reverse(),
      },
      records: [
        projection.records[1]!,
        projection.records[0]!,
        projection.records[1]!,
        projection.records[0]!,
      ],
      policies: [...policies].reverse(),
    });
    assert.deepEqual(replayed, snapshot);
  });

  test('keeps a map operator waiting while exposing that state to the supervisor', () => {
    const source = runHeader('empty-source', baseTs);
    const worker = runHeader('empty-worker', baseTs + 1);
    const snapshot = buildAgentGraphReadinessSnapshot({
      topology: {
        graphId: 'graph-map-waiting',
        operators: [binding(source, 'source'), binding(worker, 'worker')],
        edges: [
          {
            edgeId: 'source-worker',
            fromOperatorId: 'source',
            toOperatorId: 'worker',
          },
        ],
      },
      records: [],
      policies: [{ readinessId: 'worker-map', operatorId: 'worker', kind: 'map' }],
    });

    assert.deepEqual(snapshot.readiness['worker-map']?.waitingFor, [
      { kind: 'input_route', upstreamOperatorIds: ['source'] },
    ]);
    assert.equal(snapshot.readiness['worker-map']?.status, 'waiting');
    assert.deepEqual(snapshot.supervisorView[0]?.waitingFor, [
      { kind: 'input_route', upstreamOperatorIds: ['source'] },
    ]);
  });

  test('waits for an exact all-settled activation frontier and accepts every terminal outcome', () => {
    const branchA = runHeader('branch-a', baseTs, 'completed');
    const branchBRunning = runHeader('branch-b', baseTs + 1);
    const branchBFailed = {
      ...branchBRunning,
      status: 'failed' as const,
      completedAt: baseTs + 4,
    };
    const branchC = runHeader('branch-c', baseTs + 2, 'completed');
    const join = runHeader('join', baseTs + 3);
    const topology: AgentGraphTraceTopology = {
      graphId: 'graph-all-settled',
      operators: [
        binding(join, 'join'),
        binding(branchC, 'branch-c'),
        binding(branchBRunning, 'branch-b'),
        binding(branchA, 'branch-a'),
      ],
      edges: [
        { edgeId: 'c-join', fromOperatorId: 'branch-c', toOperatorId: 'join' },
        { edgeId: 'a-join', fromOperatorId: 'branch-a', toOperatorId: 'join' },
        { edgeId: 'b-join', fromOperatorId: 'branch-b', toOperatorId: 'join' },
      ],
    };
    const policy: AgentGraphReadinessPolicy = {
      readinessId: 'join-all',
      operatorId: 'join',
      kind: 'all_settled',
      inputs: [
        { operatorId: 'branch-c', activationId: branchC.runId },
        { operatorId: 'branch-b', activationId: branchBRunning.runId },
        { operatorId: 'branch-a', activationId: branchA.runId },
      ],
    };
    const partial = projectAgentGraphRecords({
      graphId: 'graph-all-settled',
      streams: [
        stream(branchA, 'branch-a', [
          terminalEvent(branchA, 'a-completed', baseTs + 10, 'completed'),
        ]),
        stream(branchBRunning, 'branch-b', [
          runtimeEvent(branchBRunning, 'b-progress', baseTs + 11, 'progress'),
        ]),
      ],
    });

    const waiting = buildAgentGraphReadinessSnapshot({
      topology,
      records: partial.records,
      policies: [policy],
    });
    assert.equal(waiting.readiness['join-all']?.status, 'waiting');
    assert.deepEqual(waiting.readiness['join-all']?.waitingFor, [
      {
        kind: 'activation_running',
        operatorId: 'branch-b',
        activationId: branchBRunning.runId,
      },
      {
        kind: 'activation_missing',
        operatorId: 'branch-c',
        activationId: branchC.runId,
      },
    ]);

    const settled = projectAgentGraphRecords({
      graphId: 'graph-all-settled',
      streams: [
        stream(branchA, 'branch-a', [
          terminalEvent(branchA, 'a-completed', baseTs + 10, 'completed'),
        ]),
        stream(branchBFailed, 'branch-b', [
          terminalEvent(branchBFailed, 'b-failed', baseTs + 12, 'failed'),
        ]),
        stream(branchC, 'branch-c', [
          terminalEvent(branchC, 'c-completed', baseTs + 13, 'completed'),
        ]),
      ],
    });
    const runnable = buildAgentGraphReadinessSnapshot({
      topology,
      records: settled.records,
      policies: [policy],
    });
    const intent = runnable.readiness['join-all']?.intents[0];
    assert.equal(runnable.readiness['join-all']?.status, 'runnable');
    assert.deepEqual(runnable.readiness['join-all']?.waitingFor, []);
    assert.deepEqual(runnable.readiness['join-all']?.sealedInputs, [
      { operatorId: 'branch-a', activationId: branchA.runId },
      { operatorId: 'branch-b', activationId: branchBRunning.runId },
      { operatorId: 'branch-c', activationId: branchC.runId },
    ]);
    assert.deepEqual(
      intent?.triggerRecordIds,
      ['a-completed', 'b-failed', 'c-completed'].map(
        (eventId) =>
          settled.records.find((record) => record.source.runtimeEventId === eventId)!.recordId,
      ),
    );
  });

  test('does not let a later follow-up activation rewrite a sealed all-settled intent', () => {
    const branchA = runHeader('sealed-a', baseTs, 'completed');
    const branchAFollowup = runHeader(
      'sealed-a-followup',
      baseTs + 20,
      'running',
      branchA.sessionId,
    );
    const branchB = runHeader('sealed-b', baseTs + 1, 'completed');
    const join = runHeader('sealed-join', baseTs + 2);
    const topology: AgentGraphTraceTopology = {
      graphId: 'graph-sealed-frontier',
      operators: [binding(branchA, 'a'), binding(branchB, 'b'), binding(join, 'join')],
      edges: [
        { edgeId: 'a-join', fromOperatorId: 'a', toOperatorId: 'join' },
        { edgeId: 'b-join', fromOperatorId: 'b', toOperatorId: 'join' },
      ],
    };
    const policies: AgentGraphReadinessPolicy[] = [
      {
        readinessId: 'join-all',
        operatorId: 'join',
        kind: 'all_settled',
        inputs: [
          { operatorId: 'a', activationId: branchA.runId },
          { operatorId: 'b', activationId: branchB.runId },
        ],
      },
    ];
    const settledStreams = [
      stream(branchA, 'a', [terminalEvent(branchA, 'a-completed', baseTs + 10, 'completed')]),
      stream(branchB, 'b', [terminalEvent(branchB, 'b-completed', baseTs + 11, 'completed')]),
    ];
    const initial = projectAgentGraphRecords({
      graphId: 'graph-sealed-frontier',
      streams: settledStreams,
    });
    const withFollowup = projectAgentGraphRecords({
      graphId: 'graph-sealed-frontier',
      streams: [
        ...settledStreams,
        stream(branchAFollowup, 'a', [
          runtimeEvent(branchAFollowup, 'a-followup-progress', baseTs + 21, 'new work'),
        ]),
      ],
    });

    const before = buildAgentGraphReadinessSnapshot({
      topology,
      records: initial.records,
      policies,
    });
    const after = buildAgentGraphReadinessSnapshot({
      topology,
      records: withFollowup.records,
      policies,
    });

    assert.equal(after.trace.operators.a?.runtimeState?.status, 'running');
    assert.equal(after.readiness['join-all']?.status, 'runnable');
    assert.deepEqual(after.readiness['join-all']?.intents, before.readiness['join-all']?.intents);
  });

  test('keeps local intent identity stable across unrelated and downstream-only topology changes', () => {
    const source = runHeader('fingerprint-source', baseTs);
    const worker = runHeader('fingerprint-worker', baseTs + 1);
    const observer = runHeader('fingerprint-observer', baseTs + 2);
    const records = projectAgentGraphRecords({
      graphId: 'graph-fingerprint',
      streams: [stream(source, 'source', [runtimeEvent(source, 'record', baseTs + 1, 'record')])],
    }).records;
    const policy: AgentGraphReadinessPolicy = {
      readinessId: 'worker-map',
      operatorId: 'worker',
      kind: 'map',
    };
    const initial = buildAgentGraphReadinessSnapshot({
      topology: {
        graphId: 'graph-fingerprint',
        operators: [binding(source, 'source'), binding(worker, 'worker')],
        edges: [
          {
            edgeId: 'source-worker',
            fromOperatorId: 'source',
            toOperatorId: 'worker',
          },
        ],
      },
      records,
      policies: [policy],
    });
    const disconnected = buildAgentGraphReadinessSnapshot({
      topology: {
        graphId: 'graph-fingerprint',
        operators: [
          binding(observer, 'observer'),
          binding(worker, 'worker'),
          binding(source, 'source'),
        ],
        edges: [
          {
            edgeId: 'source-worker',
            fromOperatorId: 'source',
            toOperatorId: 'worker',
          },
        ],
      },
      records,
      policies: [policy],
    });
    const downstreamOnly = buildAgentGraphReadinessSnapshot({
      topology: {
        graphId: 'graph-fingerprint',
        operators: [
          binding(observer, 'observer'),
          binding(worker, 'worker'),
          binding(source, 'source'),
        ],
        edges: [
          {
            edgeId: 'source-worker',
            fromOperatorId: 'source',
            toOperatorId: 'worker',
          },
          {
            edgeId: 'worker-observer',
            fromOperatorId: 'worker',
            toOperatorId: 'observer',
          },
        ],
      },
      records,
      policies: [policy],
    });

    assert.notEqual(initial.topologyFingerprint, disconnected.topologyFingerprint);
    assert.notEqual(initial.topologyFingerprint, downstreamOnly.topologyFingerprint);
    assert.deepEqual(
      disconnected.readiness['worker-map']?.intents,
      initial.readiness['worker-map']?.intents,
    );
    assert.deepEqual(
      downstreamOnly.readiness['worker-map']?.intents,
      initial.readiness['worker-map']?.intents,
    );
  });

  test('orders distinct Unicode identities canonically across topology and sealed inputs', () => {
    const precomposed = runHeader('unicode-precomposed', baseTs);
    const decomposed = runHeader('unicode-decomposed', baseTs + 1);
    const join = runHeader('unicode-join', baseTs + 2);
    const precomposedId = '\u00e9';
    const decomposedId = 'e\u0301';
    assert.equal(precomposedId.localeCompare(decomposedId), 0);

    const operators = [
      binding(precomposed, precomposedId),
      binding(decomposed, decomposedId),
      binding(join, 'join'),
    ];
    const edges = [
      {
        edgeId: 'precomposed-join',
        fromOperatorId: precomposedId,
        toOperatorId: 'join',
      },
      {
        edgeId: 'decomposed-join',
        fromOperatorId: decomposedId,
        toOperatorId: 'join',
      },
    ];
    const inputs = [
      { operatorId: precomposedId, activationId: precomposed.runId },
      { operatorId: decomposedId, activationId: decomposed.runId },
    ];
    const canonical = buildAgentGraphReadinessSnapshot({
      topology: { graphId: 'graph-unicode-readiness', operators, edges },
      records: [],
      policies: [
        {
          readinessId: 'join-all',
          operatorId: 'join',
          kind: 'all_settled',
          inputs,
        },
      ],
    });
    const reversed = buildAgentGraphReadinessSnapshot({
      topology: {
        graphId: 'graph-unicode-readiness',
        operators: [...operators].reverse(),
        edges: [...edges].reverse(),
      },
      records: [],
      policies: [
        {
          readinessId: 'join-all',
          operatorId: 'join',
          kind: 'all_settled',
          inputs: [...inputs].reverse(),
        },
      ],
    });

    assert.deepEqual(reversed, canonical);
  });

  test('keeps reserved JavaScript property names safe in readiness identities', () => {
    const source = runHeader('reserved-source', baseTs);
    const worker = runHeader('reserved-worker', baseTs + 1);
    const records = projectAgentGraphRecords({
      graphId: 'graph-reserved-readiness',
      streams: [stream(source, 'source', [runtimeEvent(source, 'record', baseTs + 1, 'record')])],
    }).records;

    const snapshot = buildAgentGraphReadinessSnapshot({
      topology: {
        graphId: 'graph-reserved-readiness',
        operators: [binding(source, 'source'), binding(worker, '__proto__')],
        edges: [
          {
            edgeId: 'toString',
            fromOperatorId: 'source',
            toOperatorId: '__proto__',
          },
        ],
      },
      records,
      policies: [{ readinessId: 'constructor', operatorId: '__proto__', kind: 'map' }],
    });

    assert.equal(Object.hasOwn(snapshot.readiness, 'constructor'), true);
    const reservedState = Object.entries(snapshot.readiness).find(
      ([readinessId]) => readinessId === 'constructor',
    )?.[1];
    assert.equal(reservedState?.operatorId, '__proto__');
    assert.equal(reservedState?.status, 'runnable');
  });

  test('fails closed on ambiguous or incomplete local readiness policies', () => {
    const sourceA = runHeader('invalid-a', baseTs);
    const sourceB = runHeader('invalid-b', baseTs + 1);
    const target = runHeader('invalid-target', baseTs + 2);
    const topology: AgentGraphTraceTopology = {
      graphId: 'graph-invalid-readiness',
      operators: [binding(sourceA, 'a'), binding(sourceB, 'b'), binding(target, 'target')],
      edges: [
        { edgeId: 'a-target', fromOperatorId: 'a', toOperatorId: 'target' },
        { edgeId: 'b-target', fromOperatorId: 'b', toOperatorId: 'target' },
      ],
    };

    assert.throws(
      () =>
        buildAgentGraphReadinessSnapshot({
          topology,
          records: [],
          policies: [
            { readinessId: 'duplicate', operatorId: 'target', kind: 'map' },
            { readinessId: 'duplicate', operatorId: 'target', kind: 'map' },
          ],
        }),
      /Duplicate graph readiness duplicate/,
    );
    assert.throws(
      () =>
        buildAgentGraphReadinessSnapshot({
          topology,
          records: [],
          policies: [
            { readinessId: 'first', operatorId: 'target', kind: 'map' },
            {
              readinessId: 'second',
              operatorId: 'target',
              kind: 'all_settled',
              inputs: [
                { operatorId: 'a', activationId: sourceA.runId },
                { operatorId: 'b', activationId: sourceB.runId },
              ],
            },
          ],
        }),
      /Operator target has readiness policies first and second/,
    );
    assert.throws(
      () =>
        buildAgentGraphReadinessSnapshot({
          topology,
          records: [],
          policies: [
            {
              readinessId: 'join',
              operatorId: 'target',
              kind: 'all_settled',
              inputs: [{ operatorId: 'a', activationId: sourceA.runId }],
            },
          ],
        }),
      /does not seal upstream: b/,
    );
    assert.throws(
      () =>
        buildAgentGraphReadinessSnapshot({
          topology,
          records: [],
          policies: [{ readinessId: 'root-map', operatorId: 'a', kind: 'map' }],
        }),
      /requires direct upstream input for a/,
    );
    assert.throws(
      () =>
        buildAgentGraphReadinessSnapshot({
          topology,
          records: [],
          policies: [
            {
              readinessId: 'unsupported',
              operatorId: 'target',
              kind: 'quorum',
            } as unknown as AgentGraphReadinessPolicy,
          ],
        }),
      /Unsupported graph readiness policy quorum/,
    );
  });
});

function runHeader(
  name: string,
  createdAt: number,
  status: AgentRunHeader['status'] = 'running',
  sessionId = `session-${name}`,
): AgentRunHeader {
  return {
    sessionId,
    runId: `run-${name}`,
    turnId: `turn-${name}`,
    invocationId: `invocation-${name}`,
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'deepseek',
    modelId: 'deepseek-chat',
    cwd: '/workspace',
    permissionMode: 'explore',
    status,
    createdAt,
    updatedAt: createdAt + 1,
    ...(status === 'completed' || status === 'failed' || status === 'cancelled'
      ? { completedAt: createdAt + 1 }
      : {}),
  };
}

function binding(run: AgentRunHeader, operatorId: string) {
  return { operatorId, sessionId: run.sessionId };
}

function stream(run: AgentRunHeader, operatorId: string, events: readonly RuntimeEvent[]) {
  return {
    operator: binding(run, operatorId),
    run,
    events,
  };
}

function runtimeEvent(run: AgentRunHeader, id: string, ts: number, text: string): RuntimeEvent {
  return {
    id,
    invocationId: run.invocationId ?? `invocation-${run.runId}`,
    runId: run.runId,
    sessionId: run.sessionId,
    turnId: run.turnId,
    ts,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'text', text },
  };
}

function terminalEvent(
  run: AgentRunHeader,
  id: string,
  ts: number,
  status: Extract<AgentRunHeader['status'], 'completed' | 'failed' | 'cancelled'>,
): RuntimeEvent {
  return {
    id,
    invocationId: run.invocationId ?? `invocation-${run.runId}`,
    runId: run.runId,
    sessionId: run.sessionId,
    turnId: run.turnId,
    ts,
    partial: false,
    role: 'system',
    author: 'system',
    status,
    actions: { endInvocation: true },
  };
}
