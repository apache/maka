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

export const AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION = 1 as const;

export type AgentGraphSupervisorWakeStatus =
  | 'pending'
  | 'running'
  | 'waiting_permission'
  | 'delivered'
  | 'superseded'
  | 'retryable_failed';

export interface AgentGraphSupervisorWakeRecord {
  schemaVersion: typeof AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION;
  graphId: string;
  wakeId: string;
  snapshotVersion: string;
  rootSessionId: string;
  status: AgentGraphSupervisorWakeStatus;
  attemptCount: number;
  currentAttemptId?: string;
  currentTurnId?: string;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentGraphSupervisorWakeAttemptRecord {
  graphId: string;
  wakeId: string;
  attemptId: string;
  turnId: string;
  status: 'running' | 'waiting_permission' | 'delivered' | 'superseded' | 'retryable_failed';
  failureReason?: string;
  startedAt: number;
  completedAt?: number;
}

export interface ClaimAgentGraphSupervisorWakeRequest {
  schemaVersion: typeof AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION;
  graphId: string;
  wakeId: string;
  snapshotVersion: string;
  rootSessionId: string;
}

export interface BeginAgentGraphSupervisorWakeAttemptRequest {
  graphId: string;
  wakeId: string;
  attemptId: string;
  turnId: string;
}

export interface CompleteAgentGraphSupervisorWakeAttemptRequest {
  graphId: string;
  wakeId: string;
  attemptId: string;
  status: 'waiting_permission' | 'delivered' | 'superseded' | 'retryable_failed';
  failureReason?: string;
}

export interface SupersedeAgentGraphSupervisorWakesRequest {
  rootSessionIds: readonly string[];
  /** Optional exact graph identities; omitted means every graph under the roots. */
  graphIds?: readonly string[];
  reason: string;
}

export interface AgentGraphSupervisorWakeStore {
  claimAgentGraphSupervisorWake(
    request: ClaimAgentGraphSupervisorWakeRequest,
  ): Promise<{ wake: AgentGraphSupervisorWakeRecord; created: boolean }>;
  beginAgentGraphSupervisorWakeAttempt(
    request: BeginAgentGraphSupervisorWakeAttemptRequest,
  ): Promise<{
    wake: AgentGraphSupervisorWakeRecord;
    attempt?: AgentGraphSupervisorWakeAttemptRecord;
    acquired: boolean;
  }>;
  completeAgentGraphSupervisorWakeAttempt(
    request: CompleteAgentGraphSupervisorWakeAttemptRequest,
  ): Promise<AgentGraphSupervisorWakeRecord>;
  supersedeAgentGraphSupervisorWakes(
    request: SupersedeAgentGraphSupervisorWakesRequest,
  ): Promise<number>;
  readAgentGraphSupervisorWake(
    graphId: string,
    wakeId: string,
  ): Promise<AgentGraphSupervisorWakeRecord | undefined>;
  listAgentGraphSupervisorWakeAttempts(
    graphId: string,
    wakeId: string,
  ): Promise<AgentGraphSupervisorWakeAttemptRecord[]>;
  listUnsettledAgentGraphSupervisorWakes(): Promise<AgentGraphSupervisorWakeRecord[]>;
  listRetryableAgentGraphSupervisorWakes(): Promise<AgentGraphSupervisorWakeRecord[]>;
  recoverAgentGraphSupervisorWakes(): Promise<number>;
}
