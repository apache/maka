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

import type { RuntimeEvent, ToolRecoveryMode } from '@maka/core/runtime-event';

/** T1/T2 transactions keep their runtime fact and recovery journal inseparable. */
export interface CommitToolPreparedInput {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  dispatchRuntimeEvent: RuntimeEvent;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  committedAt: number;
}

export interface CommitToolOutcomeInput {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  committedAt: number;
}

export interface ToolCommitResult {
  created: boolean;
  runtimeEventSeq: number;
}

/** Storage-owned, immutable append position for an Event within one Session. */
export interface SessionRuntimeEventEntry {
  readonly ordinal: number;
  readonly event: RuntimeEvent;
}

export interface ToolOperationRecord {
  operationId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  currentState: 'prepared' | 'outcome_committed' | 'recovery_completed' | 'recovery_parked';
  callEventId: string;
  dispatchEventId?: string;
  resultEventId?: string;
  version: number;
}
