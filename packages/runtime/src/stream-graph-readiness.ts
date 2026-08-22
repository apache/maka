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
import type {
  AgentGraphActivationState,
  AgentGraphActivationStatus,
  AgentGraphRecord,
} from './stream-graph-projection.js';
import { compareAgentGraphIdentity } from './stream-graph-identity.js';
import {
  buildAgentGraphTraceSnapshot,
  type AgentGraphTraceOperatorState,
  type AgentGraphTraceRoute,
  type AgentGraphTraceSnapshot,
  type AgentGraphTraceTopology,
} from './stream-graph-trace.js';

export const AGENT_GRAPH_READINESS_SCHEMA_VERSION = 1 as const;

export interface AgentGraphMapReadinessPolicy {
  readinessId: string;
  operatorId: string;
  kind: 'map';
}

/**
 * One immutable activation selected from a direct upstream operator.
 *
 * Requiring an explicit frontier prevents a later follow-up activation in the
 * same Session from silently changing the meaning of an all-settled join.
 */
export interface AgentGraphSealedActivationInput {
  operatorId: string;
  activationId: string;
}

export interface AgentGraphAllSettledReadinessPolicy {
  readinessId: string;
  operatorId: string;
  kind: 'all_settled';
  inputs: readonly AgentGraphSealedActivationInput[];
}

export type AgentGraphReadinessPolicy =
  | AgentGraphMapReadinessPolicy
  | AgentGraphAllSettledReadinessPolicy;

export type AgentGraphRunnableIntentPolicyKind = AgentGraphReadinessPolicy['kind'] | 'supervisor';

export type AgentGraphReadinessWait =
  | {
      kind: 'input_route';
      upstreamOperatorIds: string[];
    }
  | {
      kind: 'activation_missing';
      operatorId: string;
      activationId: string;
    }
  | {
      kind: 'activation_running';
      operatorId: string;
      activationId: string;
    };

/**
 * A deterministic candidate for later admission, not execution authority.
 *
 * A future control-plane slice must durably claim an intent before invoking
 * Agent runtime actions. Recomputing this projection alone never starts work.
 */
export interface AgentGraphRunnableIntent {
  schemaVersion: typeof AGENT_GRAPH_READINESS_SCHEMA_VERSION;
  intentId: string;
  graphId: string;
  readinessContextFingerprint: string;
  policyFingerprint: string;
  readinessId: string;
  operatorId: string;
  targetSessionId: string;
  policyKind: AgentGraphRunnableIntentPolicyKind;
  triggerRouteIds: string[];
  triggerRecordIds: string[];
}

export interface AgentGraphOperatorReadinessState {
  readinessId: string;
  operatorId: string;
  policyKind: AgentGraphReadinessPolicy['kind'];
  policyFingerprint: string;
  readinessContextFingerprint: string;
  status: 'waiting' | 'runnable';
  waitingFor: AgentGraphReadinessWait[];
  intents: AgentGraphRunnableIntent[];
  sealedInputs?: AgentGraphSealedActivationInput[];
}

/**
 * Bounded side view for the always-on main-agent supervisor.
 *
 * Every local readiness state appears here. The supervisor observes the same
 * deterministic result but is not consulted while the result is derived.
 */
export interface AgentGraphSupervisorReadinessObservation {
  graphId: string;
  topologyFingerprint: string;
  readinessId: string;
  operatorId: string;
  policyKind: AgentGraphReadinessPolicy['kind'];
  policyFingerprint: string;
  readinessContextFingerprint: string;
  status: AgentGraphOperatorReadinessState['status'];
  intentIds: string[];
  waitingFor: AgentGraphReadinessWait[];
}

export interface AgentGraphReadinessSnapshot {
  schemaVersion: typeof AGENT_GRAPH_READINESS_SCHEMA_VERSION;
  graphId: string;
  topologyFingerprint: string;
  trace: AgentGraphTraceSnapshot;
  readiness: Record<string, AgentGraphOperatorReadinessState>;
  supervisorView: AgentGraphSupervisorReadinessObservation[];
}

export interface BuildAgentGraphReadinessSnapshotInput {
  topology: AgentGraphTraceTopology;
  records: readonly AgentGraphRecord[];
  policies: readonly AgentGraphReadinessPolicy[];
}

type NormalizedReadinessPolicy =
  | AgentGraphMapReadinessPolicy
  | (Omit<AgentGraphAllSettledReadinessPolicy, 'inputs'> & {
      inputs: AgentGraphSealedActivationInput[];
    });

export function buildAgentGraphReadinessSnapshot(
  input: BuildAgentGraphReadinessSnapshotInput,
): AgentGraphReadinessSnapshot {
  const trace = buildAgentGraphTraceSnapshot({
    topology: input.topology,
    records: input.records,
  });
  const operatorsById = new Map(Object.entries(trace.operators));
  const policies = normalizeAndValidatePolicies(input.policies, operatorsById);
  const routesById = new Map(trace.routes.map((route) => [route.routeId, route]));
  const readiness = new Map<string, AgentGraphOperatorReadinessState>();

  for (const policy of policies) {
    const policyFingerprint = stableHash({
      schemaVersion: AGENT_GRAPH_READINESS_SCHEMA_VERSION,
      policy,
    });
    const readinessContextFingerprint = fingerprintReadinessContext(
      trace,
      operatorsById.get(policy.operatorId)!,
      policyFingerprint,
    );
    const state =
      policy.kind === 'map'
        ? evaluateMapReadiness(
            trace,
            operatorsById.get(policy.operatorId)!,
            policy,
            policyFingerprint,
            readinessContextFingerprint,
            routesById,
          )
        : evaluateAllSettledReadiness(
            trace,
            operatorsById,
            policy,
            policyFingerprint,
            readinessContextFingerprint,
          );
    readiness.set(policy.readinessId, state);
  }

  const supervisorView = [...readiness.values()].map(
    (state): AgentGraphSupervisorReadinessObservation => ({
      graphId: trace.graphId,
      topologyFingerprint: trace.topologyFingerprint,
      readinessId: state.readinessId,
      operatorId: state.operatorId,
      policyKind: state.policyKind,
      policyFingerprint: state.policyFingerprint,
      readinessContextFingerprint: state.readinessContextFingerprint,
      status: state.status,
      intentIds: state.intents.map((intent) => intent.intentId),
      waitingFor: state.waitingFor.map(cloneWait),
    }),
  );

  return {
    schemaVersion: AGENT_GRAPH_READINESS_SCHEMA_VERSION,
    graphId: trace.graphId,
    topologyFingerprint: trace.topologyFingerprint,
    trace,
    readiness: Object.fromEntries(readiness),
    supervisorView,
  };
}

function evaluateMapReadiness(
  trace: AgentGraphTraceSnapshot,
  operator: AgentGraphTraceOperatorState,
  policy: AgentGraphMapReadinessPolicy,
  policyFingerprint: string,
  readinessContextFingerprint: string,
  routesById: ReadonlyMap<string, AgentGraphTraceRoute>,
): AgentGraphOperatorReadinessState {
  const routes = operator.receivedRouteIds.map((routeId) => {
    const route = routesById.get(routeId);
    if (!route || route.targetOperatorId !== policy.operatorId) {
      throw new Error(`Invalid route ${routeId} in operator ${policy.operatorId} inbox`);
    }
    return route;
  });
  const intents = routes.map((route) =>
    runnableIntent(trace, policy, policyFingerprint, readinessContextFingerprint, [route]),
  );

  return {
    readinessId: policy.readinessId,
    operatorId: policy.operatorId,
    policyKind: policy.kind,
    policyFingerprint,
    readinessContextFingerprint,
    status: intents.length > 0 ? 'runnable' : 'waiting',
    waitingFor:
      intents.length > 0
        ? []
        : [
            {
              kind: 'input_route',
              upstreamOperatorIds: [...operator.upstreamOperatorIds],
            },
          ],
    intents,
  };
}

function evaluateAllSettledReadiness(
  trace: AgentGraphTraceSnapshot,
  operatorsById: ReadonlyMap<string, AgentGraphTraceOperatorState>,
  policy: Extract<NormalizedReadinessPolicy, { kind: 'all_settled' }>,
  policyFingerprint: string,
  readinessContextFingerprint: string,
): AgentGraphOperatorReadinessState {
  const waitingFor: AgentGraphReadinessWait[] = [];
  const terminalRoutes: AgentGraphTraceRoute[] = [];

  for (const input of policy.inputs) {
    const upstream = operatorsById.get(input.operatorId)!;
    const activation = findActivation(upstream.runtimeState?.activations, input.activationId);
    if (!activation) {
      waitingFor.push({ kind: 'activation_missing', ...input });
      continue;
    }
    if (!isTerminalStatus(activation.status)) {
      waitingFor.push({ kind: 'activation_running', ...input });
      continue;
    }
    if (!activation.terminalRecordId) {
      throw new Error(
        `Settled activation ${input.operatorId}/${input.activationId} has no terminal record`,
      );
    }
    const route = trace.routes.find(
      (candidate) =>
        candidate.sourceOperatorId === input.operatorId &&
        candidate.targetOperatorId === policy.operatorId &&
        candidate.sourceActivationId === input.activationId &&
        candidate.sourceRecordId === activation.terminalRecordId,
    );
    if (!route) {
      throw new Error(
        `Terminal record ${activation.terminalRecordId} is not routed from ${input.operatorId} to ${policy.operatorId}`,
      );
    }
    terminalRoutes.push(route);
  }

  const intents =
    waitingFor.length === 0
      ? [
          runnableIntent(
            trace,
            policy,
            policyFingerprint,
            readinessContextFingerprint,
            terminalRoutes,
          ),
        ]
      : [];
  return {
    readinessId: policy.readinessId,
    operatorId: policy.operatorId,
    policyKind: policy.kind,
    policyFingerprint,
    readinessContextFingerprint,
    status: intents.length > 0 ? 'runnable' : 'waiting',
    waitingFor,
    intents,
    sealedInputs: policy.inputs.map((sealedInput) => ({ ...sealedInput })),
  };
}

function normalizeAndValidatePolicies(
  policies: readonly AgentGraphReadinessPolicy[],
  operators: ReadonlyMap<string, AgentGraphTraceOperatorState>,
): NormalizedReadinessPolicy[] {
  const byReadiness = new Map<string, NormalizedReadinessPolicy>();
  const readinessByOperator = new Map<string, string>();

  for (const policy of policies) {
    const policyKind: unknown = (policy as { kind?: unknown }).kind;
    if (typeof policy.readinessId !== 'string' || !policy.readinessId.trim()) {
      throw new Error('Readiness id must not be empty');
    }
    if (typeof policy.operatorId !== 'string' || !policy.operatorId.trim()) {
      throw new Error('Readiness operator id must not be empty');
    }
    if (policyKind !== 'map' && policyKind !== 'all_settled') {
      throw new Error(`Unsupported graph readiness policy ${String(policyKind)}`);
    }
    if (byReadiness.has(policy.readinessId)) {
      throw new Error(`Duplicate graph readiness ${policy.readinessId}`);
    }
    const existingReadiness = readinessByOperator.get(policy.operatorId);
    if (existingReadiness) {
      throw new Error(
        `Operator ${policy.operatorId} has readiness policies ${existingReadiness} and ${policy.readinessId}`,
      );
    }
    const operator = operators.get(policy.operatorId);
    if (!operator) {
      throw new Error(
        `Readiness ${policy.readinessId} references unknown operator ${policy.operatorId}`,
      );
    }
    if (operator.upstreamOperatorIds.length === 0) {
      throw new Error(
        `Readiness ${policy.readinessId} requires direct upstream input for ${policy.operatorId}`,
      );
    }

    const normalized: NormalizedReadinessPolicy =
      policy.kind === 'map'
        ? {
            readinessId: policy.readinessId,
            operatorId: policy.operatorId,
            kind: 'map',
          }
        : {
            readinessId: policy.readinessId,
            operatorId: policy.operatorId,
            kind: 'all_settled',
            inputs: normalizeSealedInputs(policy),
          };
    if (normalized.kind === 'all_settled') {
      validateAllSettledInputs(normalized, operator.upstreamOperatorIds);
    }
    byReadiness.set(policy.readinessId, normalized);
    readinessByOperator.set(policy.operatorId, policy.readinessId);
  }

  return [...byReadiness.values()].sort((a, b) =>
    compareAgentGraphIdentity(a.readinessId, b.readinessId),
  );
}

function normalizeSealedInputs(
  policy: AgentGraphAllSettledReadinessPolicy,
): AgentGraphSealedActivationInput[] {
  if (!Array.isArray(policy.inputs)) {
    throw new Error(`All-settled readiness ${policy.readinessId} requires sealed inputs`);
  }
  return policy.inputs
    .map((input) => {
      if (
        !input ||
        typeof input.operatorId !== 'string' ||
        typeof input.activationId !== 'string' ||
        !input.operatorId.trim() ||
        !input.activationId.trim()
      ) {
        throw new Error(`All-settled readiness ${policy.readinessId} has an empty input identity`);
      }
      return {
        operatorId: input.operatorId,
        activationId: input.activationId,
      };
    })
    .sort(compareSealedInputs);
}

function validateAllSettledInputs(
  policy: Extract<NormalizedReadinessPolicy, { kind: 'all_settled' }>,
  upstreamOperatorIds: readonly string[],
): void {
  if (policy.inputs.length === 0) {
    throw new Error(`All-settled readiness ${policy.readinessId} requires sealed inputs`);
  }
  const inputOperators = new Set<string>();
  for (const input of policy.inputs) {
    if (inputOperators.has(input.operatorId)) {
      throw new Error(
        `All-settled readiness ${policy.readinessId} repeats upstream ${input.operatorId}`,
      );
    }
    if (!upstreamOperatorIds.includes(input.operatorId)) {
      throw new Error(
        `All-settled readiness ${policy.readinessId} input ${input.operatorId} is not directly upstream of ${policy.operatorId}`,
      );
    }
    inputOperators.add(input.operatorId);
  }
  const missing = upstreamOperatorIds.filter((operatorId) => !inputOperators.has(operatorId));
  if (missing.length > 0) {
    throw new Error(
      `All-settled readiness ${policy.readinessId} does not seal upstream: ${missing.join(', ')}`,
    );
  }
}

function runnableIntent(
  trace: AgentGraphTraceSnapshot,
  policy: NormalizedReadinessPolicy,
  policyFingerprint: string,
  readinessContextFingerprint: string,
  triggerRoutes: readonly AgentGraphTraceRoute[],
): AgentGraphRunnableIntent {
  const targetSessionId = trace.operators[policy.operatorId]!.sessionId;
  const triggerRouteIds = triggerRoutes.map((route) => route.routeId);
  const triggerRecordIds = triggerRoutes.map((route) => route.sourceRecordId);
  const hash = stableHash({
    schemaVersion: AGENT_GRAPH_READINESS_SCHEMA_VERSION,
    graphId: trace.graphId,
    readinessContextFingerprint,
    policyFingerprint,
    readinessId: policy.readinessId,
    operatorId: policy.operatorId,
    targetSessionId,
    policyKind: policy.kind,
    triggerRouteIds,
    triggerRecordIds,
  });
  return {
    schemaVersion: AGENT_GRAPH_READINESS_SCHEMA_VERSION,
    intentId: `graph_intent_${hash.slice('sha256:'.length, 'sha256:'.length + 32)}`,
    graphId: trace.graphId,
    readinessContextFingerprint,
    policyFingerprint,
    readinessId: policy.readinessId,
    operatorId: policy.operatorId,
    targetSessionId,
    policyKind: policy.kind,
    triggerRouteIds,
    triggerRecordIds,
  };
}

function fingerprintReadinessContext(
  trace: AgentGraphTraceSnapshot,
  operator: AgentGraphTraceOperatorState,
  policyFingerprint: string,
): string {
  const incomingEdges = Object.values(trace.edges)
    .filter((edge) => edge.toOperatorId === operator.operatorId)
    .map(({ edgeId, fromOperatorId, toOperatorId }) => ({
      edgeId,
      fromOperatorId,
      toOperatorId,
    }))
    .sort(
      (a, b) =>
        compareAgentGraphIdentity(a.fromOperatorId, b.fromOperatorId) ||
        compareAgentGraphIdentity(a.toOperatorId, b.toOperatorId) ||
        compareAgentGraphIdentity(a.edgeId, b.edgeId),
    );
  return stableHash({
    schemaVersion: AGENT_GRAPH_READINESS_SCHEMA_VERSION,
    graphId: trace.graphId,
    targetOperator: {
      operatorId: operator.operatorId,
      sessionId: operator.sessionId,
    },
    incomingEdges,
    policyFingerprint,
  });
}

function findActivation(
  activations: Record<string, AgentGraphActivationState> | undefined,
  activationId: string,
): AgentGraphActivationState | undefined {
  return Object.entries(activations ?? {}).find(([id]) => id === activationId)?.[1];
}

function isTerminalStatus(status: AgentGraphActivationStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'aborted' || status === 'cancelled'
  );
}

function compareSealedInputs(
  a: AgentGraphSealedActivationInput,
  b: AgentGraphSealedActivationInput,
): number {
  return (
    compareAgentGraphIdentity(a.operatorId, b.operatorId) ||
    compareAgentGraphIdentity(a.activationId, b.activationId)
  );
}

function cloneWait(wait: AgentGraphReadinessWait): AgentGraphReadinessWait {
  return wait.kind === 'input_route'
    ? { ...wait, upstreamOperatorIds: [...wait.upstreamOperatorIds] }
    : { ...wait };
}
