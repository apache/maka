import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import { projectAgentGraphRecords } from '../stream-graph-projection.js';
import {
  AGENT_GRAPH_TRACE_SCHEMA_VERSION,
  buildAgentGraphTraceSnapshot,
  type AgentGraphTraceTopology,
} from '../stream-graph-trace.js';

const baseTs = 1_800_000_000_000;

describe('stream graph trace topology', () => {
  test('materializes deterministic direct-edge routes without putting the supervisor in the path', () => {
    const research = runHeader('research', baseTs);
    const verify = runHeader('verify', baseTs + 1);
    const synthesize = runHeader('synthesize', baseTs + 2);
    const audit = runHeader('audit', baseTs + 3);
    const projection = projectAgentGraphRecords({
      graphId: 'graph-trace',
      streams: [
        stream(research, 'research', [
          runtimeEvent(research, 'research-message', baseTs + 10, 'private-research-payload'),
        ]),
        stream(verify, 'verify', [
          runtimeEvent(verify, 'verify-message', baseTs + 5, 'private-verification-payload'),
        ]),
        stream(synthesize, 'synthesize', [
          runtimeEvent(synthesize, 'synthesis-message', baseTs + 20, 'private-synthesis-payload'),
        ]),
      ],
    });
    const topology: AgentGraphTraceTopology = {
      graphId: 'graph-trace',
      operators: [
        binding(audit, 'audit'),
        binding(synthesize, 'synthesize'),
        binding(verify, 'verify'),
        binding(research, 'research'),
      ],
      edges: [
        {
          edgeId: 'synthesis-to-audit',
          fromOperatorId: 'synthesize',
          toOperatorId: 'audit',
        },
        {
          edgeId: 'verify-to-synthesis',
          fromOperatorId: 'verify',
          toOperatorId: 'synthesize',
        },
        {
          edgeId: 'research-to-synthesis',
          fromOperatorId: 'research',
          toOperatorId: 'synthesize',
        },
      ],
    };

    const snapshot = buildAgentGraphTraceSnapshot({
      topology,
      records: projection.records,
    });

    assert.equal(snapshot.schemaVersion, AGENT_GRAPH_TRACE_SCHEMA_VERSION);
    assert.deepEqual(snapshot.topologicalOrder, ['research', 'verify', 'synthesize', 'audit']);
    assert.deepEqual(snapshot.rootOperatorIds, ['research', 'verify']);
    assert.deepEqual(snapshot.sinkOperatorIds, ['audit']);
    assert.deepEqual(
      snapshot.recordIds,
      projection.records.map((record) => record.recordId),
    );
    assert.deepEqual(
      snapshot.routes.map((route) => [
        route.sourceOperatorId,
        route.targetOperatorId,
        route.sourceRecordId,
      ]),
      [
        ['verify', 'synthesize', projection.records[0]!.recordId],
        ['research', 'synthesize', projection.records[1]!.recordId],
        ['synthesize', 'audit', projection.records[2]!.recordId],
      ],
      'records travel across direct edges only; trace routing does not recursively invent work',
    );
    assert.deepEqual(snapshot.operators.synthesize?.upstreamOperatorIds, ['research', 'verify']);
    assert.equal(snapshot.operators.synthesize?.receivedRouteIds.length, 2);
    assert.equal(snapshot.operators.audit?.receivedRouteIds.length, 1);
    assert.equal(snapshot.operators.audit?.runtimeState, undefined);
    assert.equal(
      snapshot.operators.verify?.runtimeState?.activations[verify.runId]?.recordCount,
      1,
    );
    assert.deepEqual(
      projection.supervisorMetaStream.map((record) => record.recordId),
      projection.records.map((record) => record.recordId),
      'the always-on supervisor continues to observe source records independently',
    );
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /private-(research|verification|synthesis)-payload/,
    );
  });

  test('is deterministic and idempotent for reordered duplicate observations', () => {
    const source = runHeader('source', baseTs);
    const target = runHeader('target', baseTs + 1);
    const projection = projectAgentGraphRecords({
      graphId: 'graph-replay',
      streams: [
        stream(source, 'source', [
          runtimeEvent(source, 'first', baseTs + 1, 'first'),
          runtimeEvent(source, 'second', baseTs + 2, 'second'),
        ]),
      ],
    });
    const topology: AgentGraphTraceTopology = {
      graphId: 'graph-replay',
      operators: [binding(target, 'target'), binding(source, 'source')],
      edges: [
        {
          edgeId: 'source-to-target',
          fromOperatorId: 'source',
          toOperatorId: 'target',
        },
      ],
    };

    const canonical = buildAgentGraphTraceSnapshot({
      topology,
      records: projection.records,
    });
    const replayed = buildAgentGraphTraceSnapshot({
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
    });

    assert.deepEqual(replayed, canonical);
    assert.equal(new Set(canonical.routes.map((route) => route.routeId)).size, 2);
  });

  test('fingerprints only declared topology fields in raw identity order', () => {
    const precomposed = runHeader('unicode-precomposed', baseTs);
    const decomposed = runHeader('unicode-decomposed', baseTs + 1);
    const target = runHeader('unicode-target', baseTs + 2);
    const precomposedId = '\u00e9';
    const decomposedId = 'e\u0301';
    assert.equal(precomposedId.localeCompare(decomposedId), 0);

    const canonical = buildAgentGraphTraceSnapshot({
      topology: {
        graphId: 'graph-canonical-fingerprint',
        operators: [
          binding(precomposed, precomposedId),
          binding(decomposed, decomposedId),
          binding(target, 'target'),
        ],
        edges: [
          {
            edgeId: 'precomposed-target',
            fromOperatorId: precomposedId,
            toOperatorId: 'target',
          },
          {
            edgeId: 'decomposed-target',
            fromOperatorId: decomposedId,
            toOperatorId: 'target',
          },
        ],
      },
      records: [],
    });
    const noisyOperators = [
      { ...binding(target, 'target'), displayName: 'ignored target' },
      {
        ...binding(decomposed, decomposedId),
        displayName: 'ignored decomposed',
      },
      {
        ...binding(precomposed, precomposedId),
        displayName: 'ignored precomposed',
      },
    ];
    const noisyEdges = [
      {
        edgeId: 'decomposed-target',
        fromOperatorId: decomposedId,
        toOperatorId: 'target',
        debugColor: 'blue',
      },
      {
        edgeId: 'precomposed-target',
        fromOperatorId: precomposedId,
        toOperatorId: 'target',
        debugColor: 'red',
      },
    ];
    const reorderedWithExtras = buildAgentGraphTraceSnapshot({
      topology: {
        graphId: 'graph-canonical-fingerprint',
        operators: noisyOperators,
        edges: noisyEdges,
      },
      records: [],
    });

    assert.deepEqual(reorderedWithExtras, canonical);
    assert.equal(reorderedWithExtras.topologyFingerprint, canonical.topologyFingerprint);
  });

  test('keeps existing route identities stable as later observations arrive', () => {
    const source = runHeader('source', baseTs);
    const target = runHeader('target', baseTs + 1);
    const initialProjection = projectAgentGraphRecords({
      graphId: 'graph-incremental',
      streams: [stream(source, 'source', [runtimeEvent(source, 'first', baseTs + 10, 'first')])],
    });
    const expandedProjection = projectAgentGraphRecords({
      graphId: 'graph-incremental',
      streams: [
        stream(source, 'source', [
          runtimeEvent(source, 'first', baseTs + 10, 'first'),
          runtimeEvent(source, 'second', baseTs + 20, 'second'),
        ]),
      ],
    });
    const topology: AgentGraphTraceTopology = {
      graphId: 'graph-incremental',
      operators: [binding(source, 'source'), binding(target, 'target')],
      edges: [
        {
          edgeId: 'source-to-target',
          fromOperatorId: 'source',
          toOperatorId: 'target',
        },
      ],
    };

    const initial = buildAgentGraphTraceSnapshot({
      topology,
      records: initialProjection.records,
    });
    const expanded = buildAgentGraphTraceSnapshot({
      topology,
      records: expandedProjection.records,
    });

    assert.deepEqual(expanded.routes[0], initial.routes[0]);
    assert.equal(expanded.routes.length, 2);
  });

  test('retains an observable topology before any runtime facts arrive', () => {
    const source = runHeader('source', baseTs);
    const target = runHeader('target', baseTs + 1);

    const snapshot = buildAgentGraphTraceSnapshot({
      topology: {
        graphId: 'graph-empty-trace',
        operators: [binding(target, 'target'), binding(source, 'source')],
        edges: [
          {
            edgeId: 'source-to-target',
            fromOperatorId: 'source',
            toOperatorId: 'target',
          },
        ],
      },
      records: [],
    });

    assert.deepEqual(snapshot.topologicalOrder, ['source', 'target']);
    assert.deepEqual(snapshot.rootOperatorIds, ['source']);
    assert.deepEqual(snapshot.sinkOperatorIds, ['target']);
    assert.deepEqual(snapshot.recordIds, []);
    assert.deepEqual(snapshot.routes, []);
    assert.equal(snapshot.operators.source?.runtimeState, undefined);
    assert.equal(snapshot.operators.target?.runtimeState, undefined);
  });

  test('materializes reserved JavaScript property names as own snapshot keys', () => {
    const source = {
      ...runHeader('reserved-source', baseTs),
      runId: 'constructor',
      invocationId: 'reserved-invocation',
    };
    const target = runHeader('reserved-target', baseTs + 1);
    const projection = projectAgentGraphRecords({
      graphId: 'graph-reserved-keys',
      streams: [
        stream(source, '__proto__', [
          runtimeEvent(source, 'reserved-record', baseTs + 1, 'reserved'),
        ]),
      ],
    });

    const snapshot = buildAgentGraphTraceSnapshot({
      topology: {
        graphId: 'graph-reserved-keys',
        operators: [binding(source, '__proto__'), binding(target, 'toString')],
        edges: [
          {
            edgeId: '__proto__',
            fromOperatorId: '__proto__',
            toOperatorId: 'toString',
          },
        ],
      },
      records: projection.records,
    });

    assert.equal(Object.hasOwn(snapshot.operators, '__proto__'), true);
    assert.equal(Object.hasOwn(snapshot.operators, 'toString'), true);
    assert.equal(Object.hasOwn(snapshot.edges, '__proto__'), true);
    assert.equal(snapshot.edges['__proto__']?.routeIds.length, 1);
    assert.equal(
      Object.hasOwn(
        snapshot.operators['__proto__']?.runtimeState?.activations ?? {},
        'constructor',
      ),
      true,
    );
  });

  test('binds route identity to immutable edge endpoints', () => {
    const source = runHeader('route-source', baseTs);
    const targetA = runHeader('route-target-a', baseTs + 1);
    const targetB = runHeader('route-target-b', baseTs + 2);
    const projection = projectAgentGraphRecords({
      graphId: 'graph-edge-rebinding',
      streams: [
        stream(source, 'source', [runtimeEvent(source, 'source-record', baseTs + 1, 'source')]),
      ],
    });
    const operators = [
      binding(source, 'source'),
      binding(targetA, 'target-a'),
      binding(targetB, 'target-b'),
    ];

    const first = buildAgentGraphTraceSnapshot({
      topology: {
        graphId: 'graph-edge-rebinding',
        operators,
        edges: [
          {
            edgeId: 'edge',
            fromOperatorId: 'source',
            toOperatorId: 'target-a',
          },
        ],
      },
      records: projection.records,
    });
    const rebound = buildAgentGraphTraceSnapshot({
      topology: {
        graphId: 'graph-edge-rebinding',
        operators,
        edges: [
          {
            edgeId: 'edge',
            fromOperatorId: 'source',
            toOperatorId: 'target-b',
          },
        ],
      },
      records: projection.records,
    });

    assert.notEqual(first.routes[0]?.routeId, rebound.routes[0]?.routeId);
    assert.equal(first.routes[0]?.targetOperatorId, 'target-a');
    assert.equal(rebound.routes[0]?.targetOperatorId, 'target-b');
  });

  test('fails closed on invalid topology and record ownership', () => {
    const one = runHeader('one', baseTs);
    const two = runHeader('two', baseTs + 1);
    const three = runHeader('three', baseTs + 2);
    const projection = projectAgentGraphRecords({
      graphId: 'graph-invalid',
      streams: [stream(one, 'one', [runtimeEvent(one, 'one-message', baseTs + 1, 'one')])],
    });

    assert.throws(
      () =>
        buildAgentGraphTraceSnapshot({
          topology: {
            graphId: 'graph-invalid',
            operators: [binding(one, 'one'), binding(two, 'two'), binding(three, 'three')],
            edges: [
              { edgeId: 'one-two', fromOperatorId: 'one', toOperatorId: 'two' },
              {
                edgeId: 'two-three',
                fromOperatorId: 'two',
                toOperatorId: 'three',
              },
              {
                edgeId: 'three-one',
                fromOperatorId: 'three',
                toOperatorId: 'one',
              },
            ],
          },
          records: projection.records,
        }),
      /contains a cycle involving: one, three, two/,
    );
    assert.throws(
      () =>
        buildAgentGraphTraceSnapshot({
          topology: {
            graphId: 'graph-invalid',
            operators: [binding(one, 'one'), binding(two, 'two')],
            edges: [
              {
                edgeId: 'one-missing',
                fromOperatorId: 'one',
                toOperatorId: 'missing',
              },
            ],
          },
          records: projection.records,
        }),
      /unknown target missing/,
    );
    assert.throws(
      () =>
        buildAgentGraphTraceSnapshot({
          topology: {
            graphId: 'graph-invalid',
            operators: [{ operatorId: 'one', sessionId: 'different-session' }, binding(two, 'two')],
            edges: [{ edgeId: 'one-two', fromOperatorId: 'one', toOperatorId: 'two' }],
          },
          records: projection.records,
        }),
      /Topology operator one is bound to different-session/,
    );
    assert.throws(
      () =>
        buildAgentGraphTraceSnapshot({
          topology: {
            graphId: 'different-graph',
            operators: [binding(one, 'one'), binding(two, 'two')],
            edges: [{ edgeId: 'one-two', fromOperatorId: 'one', toOperatorId: 'two' }],
          },
          records: projection.records,
        }),
      /cannot observe records from graph graph-invalid/,
    );
    assert.throws(
      () =>
        buildAgentGraphTraceSnapshot({
          topology: {
            graphId: 'graph-invalid',
            operators: [binding(two, 'two')],
            edges: [],
          },
          records: projection.records,
        }),
      /unknown topology operator one/,
    );
  });
});

function runHeader(name: string, createdAt: number): AgentRunHeader {
  return {
    sessionId: `session-${name}`,
    runId: `run-${name}`,
    turnId: `turn-${name}`,
    invocationId: `invocation-${name}`,
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'deepseek',
    modelId: 'deepseek-chat',
    cwd: '/workspace',
    permissionMode: 'explore',
    status: 'running',
    createdAt,
    updatedAt: createdAt + 1,
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
