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

import type { AgentGraphScheduleControlStore } from '@maka/core/agent-graph-schedule';
import type { AgentGraphEpochStore } from '@maka/core/agent-graph-epoch';
import type { AgentGraphSupervisorWakeStore } from '@maka/core/agent-graph-supervisor-wake';
import type { AgentGraphClientProjectionStore } from '@maka/core/agent-graph-client-projection';
import type { AgentGraphTimelineMetadataStore } from '@maka/core/agent-graph-timeline';
import type {
  ExecutionSessionWriter,
  ExecutionAgentRunWriter,
  ExecutionRuntimeEventWriter,
} from './execution-stores.js';
import type { InteractionStoreWriter } from './interaction-store.js';
import type { GoalAuthorityRepository } from './goal-authority.js';

/** Graph and Session creation/retirement share one transaction authority. */
export interface ExecutionGraphStore
  extends AgentGraphScheduleControlStore,
    AgentGraphEpochStore,
    AgentGraphSupervisorWakeStore,
    AgentGraphClientProjectionStore,
    AgentGraphTimelineMetadataStore {
  listTombstonedSessionIdsAmong(sessionIds: readonly string[]): Promise<string[]>;
  purgeAgentGraphControlState(graphId: string): Promise<number>;
  purgeAgentGraphEpochs(rootSessionId: string): Promise<number>;
  close(): void | Promise<void>;
}

/**
 * An indivisible consistency domain, not independently replaceable CRUD stores.
 * WorkHub assignment, graph provisioning, and Session/Goal retirement must
 * commit against the same authority. Implementations own those transactions.
 * Raw handles never enter Runtime: trusted composition wraps the whole group
 * in authenticated, lease-scoped capabilities.
 */
export interface ExecutionPersistence {
  readonly sessionStore: ExecutionSessionWriter;
  readonly agentRunStore: ExecutionAgentRunWriter;
  readonly runtimeEventStore: ExecutionRuntimeEventWriter;
  readonly interactionStore: InteractionStoreWriter & { close(): void };
  readonly graphControlStore: ExecutionGraphStore;
  readonly goalStore: GoalAuthorityRepository;
  purgeConversationOperationalState(sessionId: string): Promise<void>;
  /** Closes every owned handle; idempotent, including after a partial open. */
  close(): Promise<void>;
}

export interface ExecutionPersistenceProvider {
  /** Trusted process configuration only; never chosen by a client request. */
  open(input: {
    readonly rootId: string;
    readonly canonicalPath: string;
  }): Promise<ExecutionPersistence>;
}

/** Explicit allowlist: the graph facade must not expose adapter SQL/backup methods. */
export const EXECUTION_GRAPH_METHODS = [
  'claimAgentGraphIntent',
  'readAgentGraphIntentClaim',
  'listAgentGraphIntentClaims',
  'commitAgentGraphScheduleUpdate',
  'listAgentGraphScheduleUpdates',
  'claimAgentGraphIntentAtScheduleRevision',
  'beginAgentGraphIntentExecutionAtScheduleRevision',
  'cancelAgentGraphIntentExecution',
  'listAgentGraphOperatorProvisions',
  'resolveCurrentAgentGraphEpoch',
  'advanceAgentGraphEpoch',
  'readAgentGraphEpochByGraphId',
  'listAgentGraphEpochPage',
  'listAgentGraphEpochs',
  'claimAgentGraphSupervisorWake',
  'beginAgentGraphSupervisorWakeAttempt',
  'completeAgentGraphSupervisorWakeAttempt',
  'supersedeAgentGraphSupervisorWakes',
  'readAgentGraphSupervisorWake',
  'listAgentGraphSupervisorWakeAttempts',
  'listUnsettledAgentGraphSupervisorWakes',
  'listRetryableAgentGraphSupervisorWakes',
  'recoverAgentGraphSupervisorWakes',
  'commitAgentGraphClientProjection',
  'readAgentGraphClientProjection',
  'readAgentGraphClientOperatorProjection',
  'readAgentGraphClientProjectionWithOperator',
  'listAgentGraphClientTerminalActivities',
  'listAgentGraphClientClaimAdmissions',
  'readAgentGraphTimelineMetadata',
  'listTombstonedSessionIdsAmong',
  'purgeAgentGraphControlState',
  'purgeAgentGraphEpochs',
] as const satisfies readonly (keyof ExecutionGraphStore)[];
