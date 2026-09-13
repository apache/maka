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

export const AGENT_GRAPH_EPOCH_SCHEMA_VERSION = 1 as const;

/** Durable identity of one Agent Graph lifetime within a root Session. */
export interface AgentGraphEpochBinding {
  readonly schemaVersion: typeof AGENT_GRAPH_EPOCH_SCHEMA_VERSION;
  readonly rootSessionId: string;
  readonly epoch: number;
  readonly graphId: string;
  readonly createdAt: number;
}

export interface ResolveAgentGraphEpochRequest {
  readonly rootSessionId: string;
  /** Existing deterministic graph identity exposed as virtual epoch 1 when absent. */
  readonly legacyGraphId: string;
}

export interface AdvanceAgentGraphEpochRequest {
  readonly rootSessionId: string;
  readonly expectedEpoch: number;
  readonly expectedGraphId: string;
  readonly nextGraphId: string;
}

export interface AgentGraphEpochPageRequest {
  readonly rootSessionId: string;
  readonly beforeEpoch?: number;
  readonly limit: number;
}

export interface AgentGraphEpochPage {
  readonly epochs: readonly AgentGraphEpochBinding[];
  readonly nextBeforeEpoch: number | null;
  /**
   * Current epoch observed by the same read as the page rows, or null when the
   * store holds no durable rows for the root Session. Keeping this on the page
   * prevents a rollover between two reads from splitting the current marker
   * from the directory it annotates.
   */
  readonly currentEpoch: number | null;
}

/**
 * Root-to-graph identity authority.
 *
 * Lifecycle remains owned by schedule/runtime facts. Callers may advance only
 * after proving the expected graph is terminal and quiescent; this store
 * linearizes that already-authorized identity transition.
 */
export interface AgentGraphEpochStore {
  resolveCurrentAgentGraphEpoch(
    request: ResolveAgentGraphEpochRequest,
  ): Promise<AgentGraphEpochBinding>;
  advanceAgentGraphEpoch(request: AdvanceAgentGraphEpochRequest): Promise<AgentGraphEpochBinding>;
  readAgentGraphEpochByGraphId(graphId: string): Promise<AgentGraphEpochBinding | undefined>;
  listAgentGraphEpochPage(request: AgentGraphEpochPageRequest): Promise<AgentGraphEpochPage>;
  listAgentGraphEpochs(rootSessionId: string): Promise<AgentGraphEpochBinding[]>;
}

export class AgentGraphEpochConflictError extends Error {
  readonly name = 'AgentGraphEpochConflictError';
}

export function assertResolveAgentGraphEpochRequest(
  value: unknown,
): asserts value is ResolveAgentGraphEpochRequest {
  if (
    !isRecord(value) ||
    !isCanonicalIdentity(value.rootSessionId) ||
    !isGraphId(value.legacyGraphId)
  ) {
    throw new Error('Invalid Agent Graph epoch resolution request');
  }
}

export function assertAdvanceAgentGraphEpochRequest(
  value: unknown,
): asserts value is AdvanceAgentGraphEpochRequest {
  if (
    !isRecord(value) ||
    !isCanonicalIdentity(value.rootSessionId) ||
    !Number.isSafeInteger(value.expectedEpoch) ||
    (value.expectedEpoch as number) < 1 ||
    !isGraphId(value.expectedGraphId) ||
    !isGraphId(value.nextGraphId) ||
    value.expectedGraphId === value.nextGraphId
  ) {
    throw new Error('Invalid Agent Graph epoch advance request');
  }
}

export function decodeAgentGraphEpochBinding(value: unknown): AgentGraphEpochBinding {
  if (
    !isRecord(value) ||
    value.schemaVersion !== AGENT_GRAPH_EPOCH_SCHEMA_VERSION ||
    !isCanonicalIdentity(value.rootSessionId) ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !isGraphId(value.graphId) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0
  ) {
    throw new Error('Invalid Agent Graph epoch binding');
  }
  return {
    schemaVersion: AGENT_GRAPH_EPOCH_SCHEMA_VERSION,
    rootSessionId: value.rootSessionId,
    epoch: value.epoch as number,
    graphId: value.graphId,
    createdAt: value.createdAt as number,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isGraphId(value: unknown): value is string {
  return isCanonicalIdentity(value) && value.startsWith('agent_graph_');
}
