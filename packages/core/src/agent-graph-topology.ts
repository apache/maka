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

export const AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION = 1 as const;

export interface AgentGraphProvisionedEdge {
  edgeId: string;
  fromOperatorId: string;
  toOperatorId: string;
}

/**
 * Durable request for one monotonic graph-topology extension.
 *
 * The request preallocates the first Runtime turn/run identities. The child
 * Session and topology rows are committed together by the workspace metadata
 * control plane, so a retry either observes the whole provision or creates it
 * once.
 */
export interface AgentGraphOperatorProvisionRequest {
  schemaVersion: typeof AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION;
  provisionId: string;
  provisionFingerprint: string;
  graphId: string;
  workId: string;
  agentId: string;
  operatorId: string;
  initialTurnId: string;
  initialRunId: string;
  edges: AgentGraphProvisionedEdge[];
}

export interface AgentGraphOperatorProvision extends AgentGraphOperatorProvisionRequest {
  targetSessionId: string;
  provisionedAt: number;
}

export interface AgentGraphOperatorProvisionResult {
  provision: AgentGraphOperatorProvision;
  created: boolean;
}

export interface AgentGraphTopologyStore {
  listAgentGraphOperatorProvisions(graphId: string): Promise<AgentGraphOperatorProvision[]>;
}

export function isAgentGraphOperatorProvisionRequest(
  value: unknown,
): value is AgentGraphOperatorProvisionRequest {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'provisionId',
      'provisionFingerprint',
      'graphId',
      'workId',
      'agentId',
      'operatorId',
      'initialTurnId',
      'initialRunId',
      'edges',
    ])
  ) {
    return false;
  }
  const request = value as unknown as AgentGraphOperatorProvisionRequest;
  return (
    request.schemaVersion === AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION &&
    /^graph_provision_[a-f0-9]{32}$/.test(request.provisionId) &&
    isSha256Fingerprint(request.provisionFingerprint) &&
    isIdentity(request.graphId) &&
    /^graph_work_[a-f0-9]{32}$/.test(request.workId) &&
    isIdentity(request.agentId) &&
    /^graph_operator_[a-f0-9]{32}$/.test(request.operatorId) &&
    isIdentity(request.initialTurnId) &&
    isIdentity(request.initialRunId) &&
    Array.isArray(request.edges) &&
    request.edges.length <= 64 &&
    request.edges.every(
      (edge) =>
        isExactRecord(edge, ['edgeId', 'fromOperatorId', 'toOperatorId']) &&
        /^graph_edge_[a-f0-9]{32}$/.test(edge.edgeId) &&
        isIdentity(edge.fromOperatorId) &&
        edge.toOperatorId === request.operatorId,
    ) &&
    unique(request.edges.map((edge) => edge.edgeId)) &&
    unique(request.edges.map((edge) => edge.fromOperatorId))
  );
}

export function isAgentGraphOperatorProvision(
  value: unknown,
): value is AgentGraphOperatorProvision {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.prototype.hasOwnProperty.call(value, 'targetSessionId') ||
    !Object.prototype.hasOwnProperty.call(value, 'provisionedAt')
  ) {
    return false;
  }
  const { targetSessionId, provisionedAt, ...request } = value as Record<string, unknown>;
  return (
    isAgentGraphOperatorProvisionRequest(request) &&
    isIdentity(targetSessionId) &&
    typeof provisionedAt === 'number' &&
    Number.isSafeInteger(provisionedAt) &&
    provisionedAt >= 0
  );
}

export function assertAgentGraphOperatorProvisionRequest(
  value: unknown,
): asserts value is AgentGraphOperatorProvisionRequest {
  if (!isAgentGraphOperatorProvisionRequest(value)) {
    throw new Error('Invalid agent graph operator provision request');
  }
}

export function decodeAgentGraphOperatorProvision(value: unknown): AgentGraphOperatorProvision {
  if (!isAgentGraphOperatorProvision(value)) {
    throw new Error('Invalid agent graph operator provision');
  }
  return {
    schemaVersion: value.schemaVersion,
    provisionId: value.provisionId,
    provisionFingerprint: value.provisionFingerprint,
    graphId: value.graphId,
    workId: value.workId,
    agentId: value.agentId,
    operatorId: value.operatorId,
    initialTurnId: value.initialTurnId,
    initialRunId: value.initialRunId,
    edges: value.edges.map((edge) => ({ ...edge })),
    targetSessionId: value.targetSessionId,
    provisionedAt: value.provisionedAt,
  };
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSha256Fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
