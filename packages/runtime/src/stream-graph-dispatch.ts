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

import type { AgentGraphIntentClaim } from '@maka/core/agent-graph-control';
import type { SessionEvent } from '@maka/core/events';
import type {
  ClaimedAgentGraphIntentResult,
  RunClaimedAgentGraphIntentInput,
} from './session-manager.js';
import type { AgentGraphProjection } from './stream-graph-projection.js';
import type {
  AgentGraphReadinessSnapshot,
  AgentGraphRunnableIntent,
} from './stream-graph-readiness.js';

export interface AgentGraphIntentExecutor {
  runClaimedAgentGraphIntent(
    input: RunClaimedAgentGraphIntentInput,
  ): Promise<ClaimedAgentGraphIntentResult>;
}

export interface AgentGraphSupervisorObservation {
  projection: AgentGraphProjection;
  readiness: AgentGraphReadinessSnapshot;
  claims: readonly AgentGraphIntentClaim[];
}

export interface AgentGraphSupervisorActivationReady {
  intent: AgentGraphRunnableIntent;
  claim: AgentGraphIntentClaim;
  runtime: Parameters<NonNullable<RunClaimedAgentGraphIntentInput['onReady']>>[0];
}

export interface AgentGraphSupervisorRuntimeEvent {
  intent: AgentGraphRunnableIntent;
  claim: AgentGraphIntentClaim;
  event: SessionEvent;
}

/**
 * Presentation-only observer for the main-agent supervisor.
 *
 * The driver never awaits these callbacks and ignores observer failures, so
 * supervision stays beside the graph instead of becoming a data-path gate.
 */
export interface AgentGraphSupervisorObserver {
  onObservation?(observation: AgentGraphSupervisorObservation): void | Promise<void>;
  onActivationReady?(activation: AgentGraphSupervisorActivationReady): void | Promise<void>;
  onRuntimeEvent?(event: AgentGraphSupervisorRuntimeEvent): void | Promise<void>;
  onReconciliationFailure?(
    failure: import('./stream-graph-schedule-reconcile.js').AgentGraphScheduleReconciliationFailure,
  ): void | Promise<void>;
}

export interface AgentGraphDispatchedActivation {
  intent: AgentGraphRunnableIntent;
  claim: AgentGraphIntentClaim;
  claimCreated: boolean;
  result: ClaimedAgentGraphIntentResult;
}
