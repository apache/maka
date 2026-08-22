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

import { stableHash } from './request-shape.js';
import { compareAgentGraphIdentity } from './stream-graph-identity.js';
import {
  replayAgentGraphRecords,
  type AgentGraphOperatorBinding,
  type AgentGraphOperatorState,
  type AgentGraphRecord,
} from './stream-graph-projection.js';

export const AGENT_GRAPH_TRACE_SCHEMA_VERSION = 1 as const;

/**
 * One directed record path between two existing operator bindings.
 *
 * Edges deliberately do not own readiness policy. Every committed source
 * record is visible on every direct outgoing edge; a later operator adapter
 * can decide locally which inputs make one activation runnable.
 */
export interface AgentGraphTraceEdge {
  edgeId: string;
  fromOperatorId: string;
  toOperatorId: string;
}

/**
 * Read-only DAG topology for a trace snapshot.
 *
 * The topology identifies existing Session-backed operators. It does not
 * create, start, stop, or otherwise own those Sessions.
 */
export interface AgentGraphTraceTopology {
  graphId: string;
  operators: readonly AgentGraphOperatorBinding[];
  edges: readonly AgentGraphTraceEdge[];
}

/**
 * Reference-only observation that one committed graph record is visible to a
 * direct downstream operator.
 */
export interface AgentGraphTraceRoute {
  schemaVersion: typeof AGENT_GRAPH_TRACE_SCHEMA_VERSION;
  routeId: string;
  graphId: string;
  edgeId: string;
  sourceOperatorId: string;
  targetOperatorId: string;
  sourceActivationId: string;
  sourceRecordId: string;
  eventTime: number;
}

export interface AgentGraphTraceEdgeState extends AgentGraphTraceEdge {
  routeIds: string[];
  sourceRecordIds: string[];
}

export interface AgentGraphTraceOperatorState {
  operatorId: string;
  sessionId: string;
  topologicalIndex: number;
  upstreamOperatorIds: string[];
  downstreamOperatorIds: string[];
  emittedRecordIds: string[];
  receivedRouteIds: string[];
  runtimeState?: AgentGraphOperatorState;
}

/**
 * Deterministic, trace-only materialization of topology plus committed facts.
 *
 * This snapshot has no graph-wide completion or runnable state. Those require
 * explicit admission/closure and operator-readiness protocols in later slices.
 */
export interface AgentGraphTraceSnapshot {
  schemaVersion: typeof AGENT_GRAPH_TRACE_SCHEMA_VERSION;
  graphId: string;
  topologyFingerprint: string;
  topologicalOrder: string[];
  rootOperatorIds: string[];
  sinkOperatorIds: string[];
  recordIds: string[];
  operators: Record<string, AgentGraphTraceOperatorState>;
  edges: Record<string, AgentGraphTraceEdgeState>;
  routes: AgentGraphTraceRoute[];
}

export interface BuildAgentGraphTraceSnapshotInput {
  topology: AgentGraphTraceTopology;
  records: readonly AgentGraphRecord[];
}

interface ValidatedTopology {
  operatorsById: Map<string, AgentGraphOperatorBinding>;
  edges: AgentGraphTraceEdge[];
  incoming: Map<string, AgentGraphTraceEdge[]>;
  outgoing: Map<string, AgentGraphTraceEdge[]>;
  topologicalOrder: string[];
}

export function buildAgentGraphTraceSnapshot(
  input: BuildAgentGraphTraceSnapshotInput,
): AgentGraphTraceSnapshot {
  const validated = validateTopology(input.topology);
  const topologyFingerprint = fingerprintTopology(input.topology.graphId, validated);
  const replay =
    input.records.length > 0
      ? replayAgentGraphRecords(input.records)
      : {
          graphId: input.topology.graphId,
          appliedRecordIds: [],
          operators: {},
        };

  if (replay.graphId !== input.topology.graphId) {
    throw new Error(
      `Trace topology ${input.topology.graphId} cannot observe records from graph ${replay.graphId}`,
    );
  }

  const recordsById = new Map(input.records.map((record) => [record.recordId, record]));
  const orderedRecords = replay.appliedRecordIds.map((recordId) => recordsById.get(recordId)!);
  for (const record of orderedRecords) {
    const binding = validated.operatorsById.get(record.operatorId);
    if (!binding) {
      throw new Error(
        `Graph record ${record.recordId} references unknown topology operator ${record.operatorId}`,
      );
    }
    if (binding.sessionId !== record.sessionId) {
      throw new Error(
        `Topology operator ${record.operatorId} is bound to ${binding.sessionId}, record uses ${record.sessionId}`,
      );
    }
  }

  const topologicalIndex = new Map(
    validated.topologicalOrder.map((operatorId, index) => [operatorId, index]),
  );
  const compareOperators = (a: string, b: string): number =>
    topologicalIndex.get(a)! - topologicalIndex.get(b)! || compareAgentGraphIdentity(a, b);

  const replayOperators = new Map(Object.entries(replay.operators));
  const operators = new Map<string, AgentGraphTraceOperatorState>();
  for (const operatorId of validated.topologicalOrder) {
    const binding = validated.operatorsById.get(operatorId)!;
    const runtimeState = replayOperators.get(operatorId);
    operators.set(operatorId, {
      operatorId,
      sessionId: binding.sessionId,
      topologicalIndex: topologicalIndex.get(operatorId)!,
      upstreamOperatorIds: uniqueOperatorIds(
        (validated.incoming.get(operatorId) ?? []).map((edge) => edge.fromOperatorId),
        compareOperators,
      ),
      downstreamOperatorIds: uniqueOperatorIds(
        (validated.outgoing.get(operatorId) ?? []).map((edge) => edge.toOperatorId),
        compareOperators,
      ),
      emittedRecordIds: [],
      receivedRouteIds: [],
      ...(runtimeState ? { runtimeState: cloneOperatorState(runtimeState) } : {}),
    });
  }

  const edges = new Map<string, AgentGraphTraceEdgeState>();
  for (const edge of validated.edges) {
    edges.set(edge.edgeId, {
      ...edge,
      routeIds: [],
      sourceRecordIds: [],
    });
  }

  const routes: AgentGraphTraceRoute[] = [];
  for (const record of orderedRecords) {
    operators.get(record.operatorId)!.emittedRecordIds.push(record.recordId);
    const outgoing = [...(validated.outgoing.get(record.operatorId) ?? [])].sort(
      (a, b) =>
        compareOperators(a.toOperatorId, b.toOperatorId) ||
        compareAgentGraphIdentity(a.edgeId, b.edgeId),
    );
    for (const edge of outgoing) {
      const route: AgentGraphTraceRoute = {
        schemaVersion: AGENT_GRAPH_TRACE_SCHEMA_VERSION,
        routeId: traceRouteId(input.topology.graphId, edge, record.recordId),
        graphId: input.topology.graphId,
        edgeId: edge.edgeId,
        sourceOperatorId: edge.fromOperatorId,
        targetOperatorId: edge.toOperatorId,
        sourceActivationId: record.activationId,
        sourceRecordId: record.recordId,
        eventTime: record.eventTime,
      };
      routes.push(route);
      edges.get(edge.edgeId)!.routeIds.push(route.routeId);
      edges.get(edge.edgeId)!.sourceRecordIds.push(record.recordId);
      operators.get(edge.toOperatorId)!.receivedRouteIds.push(route.routeId);
    }
  }

  return {
    schemaVersion: AGENT_GRAPH_TRACE_SCHEMA_VERSION,
    graphId: input.topology.graphId,
    topologyFingerprint,
    topologicalOrder: [...validated.topologicalOrder],
    rootOperatorIds: validated.topologicalOrder.filter(
      (operatorId) => (validated.incoming.get(operatorId) ?? []).length === 0,
    ),
    sinkOperatorIds: validated.topologicalOrder.filter(
      (operatorId) => (validated.outgoing.get(operatorId) ?? []).length === 0,
    ),
    recordIds: replay.appliedRecordIds,
    operators: Object.fromEntries(operators),
    edges: Object.fromEntries(edges),
    routes,
  };
}

function fingerprintTopology(graphId: string, topology: ValidatedTopology): string {
  return stableHash({
    schemaVersion: AGENT_GRAPH_TRACE_SCHEMA_VERSION,
    graphId,
    operators: [...topology.operatorsById.values()]
      .map(({ operatorId, sessionId }) => ({ operatorId, sessionId }))
      .sort((a, b) => compareAgentGraphIdentity(a.operatorId, b.operatorId)),
    edges: topology.edges
      .map(({ edgeId, fromOperatorId, toOperatorId }) => ({
        edgeId,
        fromOperatorId,
        toOperatorId,
      }))
      .sort(compareEdges),
  });
}

function validateTopology(topology: AgentGraphTraceTopology): ValidatedTopology {
  if (!topology.graphId.trim()) throw new Error('Trace graph id must not be empty');

  const operatorsById = new Map<string, AgentGraphOperatorBinding>();
  const operatorBySession = new Map<string, string>();
  for (const operator of topology.operators) {
    if (!operator.operatorId.trim()) throw new Error('Trace operator id must not be empty');
    if (!operator.sessionId.trim()) throw new Error('Trace operator session id must not be empty');
    if (operatorsById.has(operator.operatorId)) {
      throw new Error(`Duplicate trace operator ${operator.operatorId}`);
    }
    const sessionOwner = operatorBySession.get(operator.sessionId);
    if (sessionOwner) {
      throw new Error(
        `Session ${operator.sessionId} is bound to trace operators ${sessionOwner} and ${operator.operatorId}`,
      );
    }
    operatorsById.set(operator.operatorId, {
      operatorId: operator.operatorId,
      sessionId: operator.sessionId,
    });
    operatorBySession.set(operator.sessionId, operator.operatorId);
  }

  const edgeIds = new Set<string>();
  const endpointPairs = new Set<string>();
  const incoming = new Map<string, AgentGraphTraceEdge[]>();
  const outgoing = new Map<string, AgentGraphTraceEdge[]>();
  const edges = topology.edges
    .map(({ edgeId, fromOperatorId, toOperatorId }) => ({
      edgeId,
      fromOperatorId,
      toOperatorId,
    }))
    .sort(compareEdges);
  for (const edge of edges) {
    if (!edge.edgeId.trim()) throw new Error('Trace edge id must not be empty');
    if (edgeIds.has(edge.edgeId)) throw new Error(`Duplicate trace edge ${edge.edgeId}`);
    edgeIds.add(edge.edgeId);
    if (!operatorsById.has(edge.fromOperatorId)) {
      throw new Error(`Trace edge ${edge.edgeId} has unknown source ${edge.fromOperatorId}`);
    }
    if (!operatorsById.has(edge.toOperatorId)) {
      throw new Error(`Trace edge ${edge.edgeId} has unknown target ${edge.toOperatorId}`);
    }
    if (edge.fromOperatorId === edge.toOperatorId) {
      throw new Error(`Trace edge ${edge.edgeId} cannot be a self-loop`);
    }
    const endpointPair = `${edge.fromOperatorId}\0${edge.toOperatorId}`;
    if (endpointPairs.has(endpointPair)) {
      throw new Error(
        `Trace graph has multiple edges from ${edge.fromOperatorId} to ${edge.toOperatorId}`,
      );
    }
    endpointPairs.add(endpointPair);
    addEdge(outgoing, edge.fromOperatorId, edge);
    addEdge(incoming, edge.toOperatorId, edge);
  }

  const topologicalOrder = topologicalSort(operatorsById, outgoing, incoming);
  return { operatorsById, edges, incoming, outgoing, topologicalOrder };
}

function topologicalSort(
  operatorsById: ReadonlyMap<string, AgentGraphOperatorBinding>,
  outgoing: ReadonlyMap<string, readonly AgentGraphTraceEdge[]>,
  incoming: ReadonlyMap<string, readonly AgentGraphTraceEdge[]>,
): string[] {
  const remainingIncoming = new Map(
    [...operatorsById.keys()].map((operatorId) => [
      operatorId,
      (incoming.get(operatorId) ?? []).length,
    ]),
  );
  const ready = [...operatorsById.keys()]
    .filter((operatorId) => remainingIncoming.get(operatorId) === 0)
    .sort(compareAgentGraphIdentity);
  const ordered: string[] = [];

  while (ready.length > 0) {
    const operatorId = ready.shift()!;
    ordered.push(operatorId);
    for (const edge of [...(outgoing.get(operatorId) ?? [])].sort(compareEdges)) {
      const remaining = remainingIncoming.get(edge.toOperatorId)! - 1;
      remainingIncoming.set(edge.toOperatorId, remaining);
      if (remaining === 0) {
        insertSorted(ready, edge.toOperatorId);
      }
    }
  }

  if (ordered.length !== operatorsById.size) {
    const cyclic = [...operatorsById.keys()]
      .filter((operatorId) => !ordered.includes(operatorId))
      .sort(compareAgentGraphIdentity);
    throw new Error(`Trace graph contains a cycle involving: ${cyclic.join(', ')}`);
  }
  return ordered;
}

function addEdge(
  index: Map<string, AgentGraphTraceEdge[]>,
  operatorId: string,
  edge: AgentGraphTraceEdge,
): void {
  const edges = index.get(operatorId) ?? [];
  edges.push(edge);
  index.set(operatorId, edges);
}

function uniqueOperatorIds(
  operatorIds: readonly string[],
  compare: (a: string, b: string) => number,
): string[] {
  return [...new Set(operatorIds)].sort(compare);
}

function compareEdges(a: AgentGraphTraceEdge, b: AgentGraphTraceEdge): number {
  return (
    compareAgentGraphIdentity(a.fromOperatorId, b.fromOperatorId) ||
    compareAgentGraphIdentity(a.toOperatorId, b.toOperatorId) ||
    compareAgentGraphIdentity(a.edgeId, b.edgeId)
  );
}

function insertSorted(values: string[], value: string): void {
  const index = values.findIndex((candidate) => compareAgentGraphIdentity(value, candidate) < 0);
  if (index === -1) values.push(value);
  else values.splice(index, 0, value);
}

function traceRouteId(graphId: string, edge: AgentGraphTraceEdge, sourceRecordId: string): string {
  const hash = stableHash({
    schemaVersion: AGENT_GRAPH_TRACE_SCHEMA_VERSION,
    graphId,
    edgeId: edge.edgeId,
    fromOperatorId: edge.fromOperatorId,
    toOperatorId: edge.toOperatorId,
    sourceRecordId,
  });
  return `graph_route_${hash.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function cloneOperatorState(state: AgentGraphOperatorState): AgentGraphOperatorState {
  return {
    ...state,
    activations: Object.fromEntries(
      Object.entries(state.activations).map(([activationId, activation]) => [
        activationId,
        { ...activation },
      ]),
    ),
  };
}
