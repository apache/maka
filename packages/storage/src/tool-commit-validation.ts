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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { validateToolLedgerEventLane } from '@maka/core/tool-ledger-scanner';
import type {
  CommitToolPreparedInput,
  CommitToolOutcomeInput,
  ToolOperationRecord,
} from './runtime-event-store-contract.js';

export function assertPreparedInput(input: CommitToolPreparedInput): void {
  if (input.journalEventId !== `${input.operationId}_prepared`) {
    throw new Error('T1 journal identity must be derived from the tool operation');
  }
  assertNoReservedRecoveryFact(input.runtimeEvent);
  assertNoReservedRecoveryFact(input.dispatchRuntimeEvent);
  const content = input.runtimeEvent.content;
  if (content?.kind !== 'function_call')
    throw new Error('T1 requires a function_call RuntimeEvent');
  if (content.id !== input.providerToolCallId || content.name !== input.toolName) {
    throw new Error('T1 RuntimeEvent identity does not match the tool operation');
  }
  let derivedArgsHash: string;
  try {
    derivedArgsHash = canonicalToolArgsHash(content.name, content.args);
  } catch {
    throw new Error('T1 argument hash does not match its canonical function call');
  }
  if (
    derivedArgsHash !== input.canonicalArgsHash ||
    validateToolLedgerEventLane(input.runtimeEvent).ok !== true
  ) {
    throw new Error('T1 argument hash does not match its canonical function call');
  }
  const dispatch = input.dispatchRuntimeEvent.actions?.toolDispatch;
  if (
    !dispatch ||
    input.dispatchRuntimeEvent.content !== undefined ||
    input.dispatchRuntimeEvent.partial ||
    dispatch.operationId !== input.operationId ||
    dispatch.providerToolCallId !== input.providerToolCallId ||
    dispatch.toolName !== input.toolName ||
    dispatch.canonicalArgsHash !== input.canonicalArgsHash ||
    dispatch.recoveryMode !== input.recoveryMode ||
    validateToolLedgerEventLane(input.dispatchRuntimeEvent).ok !== true
  ) {
    throw new Error('T1 requires a matching tool-dispatch RuntimeEvent');
  }
  assertSameRuntimeIdentity(input.runtimeEvent, input.dispatchRuntimeEvent, 'T1');
}

export function assertOutcomeInput(input: CommitToolOutcomeInput): void {
  if (input.journalEventId !== `${input.operationId}_outcome`) {
    throw new Error('T2 journal identity must be derived from the tool operation');
  }
  assertNoReservedRecoveryFact(input.runtimeEvent);
  const content = input.runtimeEvent.content;
  if (content?.kind !== 'function_response') {
    throw new Error('T2 requires a function_response RuntimeEvent');
  }
  if (
    input.runtimeEvent.refs?.operationId !== input.operationId ||
    input.runtimeEvent.refs?.toolCallId !== content.id
  ) {
    throw new Error(
      'T2 requires operation and tool-call refs on the function_response RuntimeEvent',
    );
  }
  if (validateToolLedgerEventLane(input.runtimeEvent).ok !== true) {
    throw new Error('T2 requires one canonical function-response semantic lane');
  }
}

export function assertPreparedIdentity(
  operation: ToolOperationRecord,
  input: CommitToolPreparedInput,
): void {
  const event = input.runtimeEvent;
  const matches =
    operation.invocationId === event.invocationId &&
    operation.runId === event.runId &&
    operation.turnId === event.turnId &&
    operation.providerToolCallId === input.providerToolCallId &&
    operation.toolName === input.toolName &&
    operation.canonicalArgsHash === input.canonicalArgsHash &&
    operation.recoveryMode === input.recoveryMode &&
    operation.callEventId === event.id &&
    operation.dispatchEventId === input.dispatchRuntimeEvent.id;
  if (!matches) throw new Error(`Tool operation identity conflict for ${input.operationId}`);
}

export function assertSameRuntimeIdentity(
  first: RuntimeEvent,
  second: RuntimeEvent,
  boundary: string,
): void {
  if (
    first.sessionId !== second.sessionId ||
    first.invocationId !== second.invocationId ||
    first.runId !== second.runId ||
    first.turnId !== second.turnId
  ) {
    throw new Error(`${boundary} RuntimeEvents do not share one execution identity`);
  }
}

export function assertOutcomeIdentity(operation: ToolOperationRecord, event: RuntimeEvent): void {
  const content = event.content;
  const matches =
    content?.kind === 'function_response' &&
    operation.invocationId === event.invocationId &&
    operation.runId === event.runId &&
    operation.turnId === event.turnId &&
    operation.providerToolCallId === content.id &&
    operation.toolName === content.name;
  if (!matches)
    throw new Error(`Tool operation outcome identity conflict for ${operation.operationId}`);
}

function assertNoReservedRecoveryFact(event: RuntimeEvent): void {
  if (event.actions?.toolRecovery !== undefined)
    throw new Error('Tool recovery facts require the atomic recovery bundle writer');
}
