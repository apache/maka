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

import { createHash } from 'node:crypto';
import type { RuntimeEvent, ToolRecoveryMode } from '@maka/core/runtime-event';
import { canonicalToolArgsHash as canonicalToolArgsHashCore } from '@maka/core/tool-args-identity';

export type { ToolRecoveryMode } from '@maka/core/runtime-event';

export interface ToolPreparedCommit {
  operationId: string;
  journalEventId: string;
  /** Provider-visible function_call fact; it may pre-exist while permission waits. */
  runtimeEvent: RuntimeEvent;
  /** Canonical, non-model-visible fact that T1 was crossed. */
  dispatchRuntimeEvent: RuntimeEvent;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  committedAt: number;
}

export interface ToolOutcomeCommit {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  committedAt: number;
}

export interface RuntimeCommitResult {
  created: boolean;
  runtimeEventSeq: number;
}

export interface RuntimeCommitSink {
  commitToolPrepared(input: ToolPreparedCommit): Promise<RuntimeCommitResult>;
  commitToolOutcome(input: ToolOutcomeCommit): Promise<RuntimeCommitResult>;
}

export interface ToolOperationIdInput {
  invocationId: string;
  providerToolCallId: string;
}

export function buildToolOperationId(input: ToolOperationIdInput): string {
  if (!input.invocationId || !input.providerToolCallId) {
    throw new Error('Tool operation identity requires invocationId and providerToolCallId');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([input.invocationId, input.providerToolCallId]))
    .digest('hex')
    .slice(0, 32);
  return `toolop_${digest}`;
}

export function canonicalToolArgsHash(toolName: string, normalizedArgs: unknown): string {
  return canonicalToolArgsHashCore(toolName, normalizedArgs);
}
