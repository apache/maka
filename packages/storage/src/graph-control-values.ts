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

import { assertSafeSessionId } from './session-store-contract.js';
import {
  AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
  type ClaimAgentGraphSupervisorWakeRequest,
  type BeginAgentGraphSupervisorWakeAttemptRequest,
  type CompleteAgentGraphSupervisorWakeAttemptRequest,
} from '@maka/core/agent-graph-supervisor-wake';
import {
  AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION,
  type CommitAgentGraphClientProjectionRequest,
} from '@maka/core/agent-graph-client-projection';
export function assertGraphLookupIdentity(value: string, name: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid agent graph ${name}`);
  }
}

export function assertAgentGraphSupervisorWakeClaim(
  request: ClaimAgentGraphSupervisorWakeRequest,
): void {
  if (request.schemaVersion !== AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION) {
    throw new Error('Invalid agent graph supervisor wake schema');
  }
  assertGraphLookupIdentity(request.graphId, 'graph id');
  assertGraphLookupIdentity(request.wakeId, 'supervisor wake id');
  assertGraphLookupIdentity(request.snapshotVersion, 'snapshot version');
  assertSafeSessionId(request.rootSessionId);
}

export function assertAgentGraphSupervisorWakeAttempt(
  request: BeginAgentGraphSupervisorWakeAttemptRequest,
): void {
  assertGraphLookupIdentity(request.graphId, 'graph id');
  assertGraphLookupIdentity(request.wakeId, 'supervisor wake id');
  assertGraphLookupIdentity(request.attemptId, 'supervisor wake attempt id');
  assertGraphLookupIdentity(request.turnId, 'supervisor wake turn id');
}

export function assertAgentGraphSupervisorWakeCompletion(
  request: CompleteAgentGraphSupervisorWakeAttemptRequest,
): void {
  assertGraphLookupIdentity(request.graphId, 'graph id');
  assertGraphLookupIdentity(request.wakeId, 'supervisor wake id');
  assertGraphLookupIdentity(request.attemptId, 'supervisor wake attempt id');
  if (
    request.status !== 'waiting_permission' &&
    request.status !== 'delivered' &&
    request.status !== 'superseded' &&
    request.status !== 'retryable_failed'
  ) {
    throw new Error('Invalid agent graph supervisor wake completion status');
  }
  if (
    (request.status === 'retryable_failed' || request.status === 'superseded') &&
    (!request.failureReason?.trim() || request.failureReason.length > 4_000)
  ) {
    throw new Error('Agent graph supervisor wake failure reason must be non-empty and bounded');
  }
}

export function assertAgentGraphClientProjectionRequest(
  request: CommitAgentGraphClientProjectionRequest,
): void {
  if (
    request.schemaVersion !== AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION ||
    (request.expectedSnapshotVersion !== null &&
      typeof request.expectedSnapshotVersion !== 'string') ||
    typeof request.replaceOperators !== 'boolean' ||
    !Array.isArray(request.operators) ||
    !Array.isArray(request.terminalActivities) ||
    !Array.isArray(request.activityRecords)
  ) {
    throw new Error('Invalid agent graph client projection request');
  }
  assertGraphLookupIdentity(request.graphId, 'graph id');
  assertSafeSessionId(request.rootSessionId);
  if (request.expectedSnapshotVersion !== null) {
    assertGraphLookupIdentity(request.expectedSnapshotVersion, 'expected snapshot version');
  }
  assertGraphLookupIdentity(request.snapshotVersion, 'snapshot version');
  const operatorIds = new Set<string>();
  for (const operator of request.operators) {
    assertGraphLookupIdentity(operator.operatorId, 'operator id');
    if (operatorIds.has(operator.operatorId)) {
      throw new Error(`Duplicate agent graph client operator ${operator.operatorId}`);
    }
    operatorIds.add(operator.operatorId);
  }
  const terminalIds = new Set<string>();
  for (const terminal of request.terminalActivities) {
    assertGraphLookupIdentity(terminal.recordId, 'terminal record id');
    assertGraphEventTime(terminal.eventTime);
    if (terminalIds.has(terminal.recordId)) {
      throw new Error(`Duplicate agent graph terminal activity ${terminal.recordId}`);
    }
    terminalIds.add(terminal.recordId);
  }
  const activityIds = new Set<string>();
  for (const record of request.activityRecords) {
    assertGraphLookupIdentity(record.recordId, 'activity record id');
    assertGraphEventTime(record.eventTime);
    if (activityIds.has(record.recordId)) {
      throw new Error(`Duplicate agent graph activity ${record.recordId}`);
    }
    activityIds.add(record.recordId);
  }
  if (request.incrementalRecordId !== undefined) {
    assertGraphLookupIdentity(request.incrementalRecordId, 'incremental record id');
    if (request.expectedSnapshotVersion === null || !activityIds.has(request.incrementalRecordId)) {
      throw new Error('Invalid incremental agent graph projection record');
    }
  }
}

export function encodeProjectionPayload(payload: unknown, name: string): string {
  const encoded = JSON.stringify(payload);
  if (encoded === undefined) {
    throw new Error(`Invalid agent graph ${name} payload`);
  }
  return encoded;
}

export function assertGraphEventTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid agent graph terminal activity event time');
  }
}

export function assertGraphIntentId(value: string): void {
  if (!/^graph_intent_[a-f0-9]{32}$/.test(value)) {
    throw new Error('Invalid agent graph intent id');
  }
}
