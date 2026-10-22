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

import type { ObservedEventWaitRecord } from '@maka/core/event-wait';
import type { ShellRunRecord, ShellRunStore } from '@maka/core/shell-run';
import { validateToolLedgerEventLane } from '@maka/core/tool-ledger-scanner';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type { ExecutionRuntimeEventReader } from '@maka/storage/execution-stores';
import { parseShellRunResourceRef } from '@maka/runtime/shell-run-contract';
import type { EventWaitObservationAccess } from './event-wait-adapter.js';

export const SHELL_RUN_WAIT_SOURCE = Object.freeze({
  providerId: 'shell_run',
  resourceType: 'background_task',
  conditionType: 'terminal',
  conditionVersion: 1,
});
export type ShellRunWaitFact = Pick<
  ShellRunRecord,
  | 'sessionId'
  | 'shellRunId'
  | 'sourceRunId'
  | 'sourceTurnId'
  | 'sourceToolCallId'
  | 'startedAt'
  | 'status'
  | 'completedAt'
  | 'exitCode'
  | 'failureMessage'
>;
export type ShellRunWaitRead =
  | { kind: 'allowed'; fact: ShellRunWaitFact }
  | { kind: 'revoked'; reason: string };

export function validateShellRunWait(wait: ObservedEventWaitRecord): string {
  const target = parseShellRunResourceRef(wait.resource.resourceId);
  if (
    !target ||
    wait.resource.providerId !== SHELL_RUN_WAIT_SOURCE.providerId ||
    wait.resource.resourceType !== SHELL_RUN_WAIT_SOURCE.resourceType ||
    wait.resource.connectionId !== null ||
    wait.condition.typeId !== SHELL_RUN_WAIT_SOURCE.conditionType ||
    wait.condition.version !== 1 ||
    Object.keys(wait.condition.parameters).length !== 0
  )
    throw new TypeError('Unsupported background task condition');
  return target.shellRunId;
}

/** Reads the same Host's stores. Neither a reference nor the wait is an access credential. */
export class ShellRunEventWaitAccess {
  constructor(
    private readonly shellRuns: Pick<ShellRunStore, 'readShellRun'>,
    private readonly events: Pick<
      ExecutionRuntimeEventReader,
      'readToolProvenanceEvents' | 'readRunInvocation'
    >,
  ) {}

  async authorize(
    wait: ObservedEventWaitRecord,
    signal: AbortSignal,
  ): Promise<EventWaitObservationAccess> {
    const result = await this.read(wait, signal);
    return result.kind === 'allowed' ? { kind: 'allowed', context: null } : result;
  }

  async read(wait: ObservedEventWaitRecord, signal: AbortSignal): Promise<ShellRunWaitRead> {
    const taskId = validateShellRunWait(wait);
    signal.throwIfAborted();
    let task: ShellRunRecord;
    try {
      task = await this.shellRuns.readShellRun(wait.sessionId, taskId);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return { kind: 'revoked', reason: 'shell_run_missing' };
      throw error;
    }
    if (task.sessionId !== wait.sessionId || task.shellRunId !== taskId || !task.sourceRunId)
      return { kind: 'revoked', reason: 'shell_run_identity_invalid' };
    if (task.visibility === 'user') return { kind: 'revoked', reason: 'shell_run_access_revoked' };
    const invocation = await this.events.readRunInvocation(wait.sessionId, task.sourceRunId);
    if (
      !invocation ||
      invocation.turnId !== task.sourceTurnId ||
      invocation.opening.route.provenance !== 'runtime' ||
      invocation.opening.route.backendKind !== 'ai-sdk'
    )
      return { kind: 'revoked', reason: 'shell_run_provenance_invalid' };
    const proof = await this.events.readToolProvenanceEvents(
      wait.sessionId,
      task.sourceRunId,
      task.sourceToolCallId,
      { maxRecords: 8, maxBytes: 2 * 1024 * 1024 },
    );
    signal.throwIfAborted();
    if (proof.status !== 'complete')
      return { kind: 'revoked', reason: 'shell_run_provenance_unavailable' };
    const facts = proof.records;
    const calls = facts.filter((e) => e.content?.kind === 'function_call');
    const dispatches = facts.filter((e) => e.actions?.toolDispatch);
    const outcomes = facts.filter((e) => e.content?.kind === 'function_response');
    const call = calls[0]?.content,
      dispatch = dispatches[0]?.actions?.toolDispatch,
      outcome = outcomes[0]?.content;
    if (
      calls.length !== 1 ||
      dispatches.length !== 1 ||
      outcomes.length !== 1 ||
      call?.kind !== 'function_call' ||
      outcome?.kind !== 'function_response' ||
      !dispatch ||
      facts.some(
        (e) =>
          !validateToolLedgerEventLane(e).ok ||
          e.partial ||
          e.sessionId !== wait.sessionId ||
          e.runId !== task.sourceRunId ||
          e.turnId !== task.sourceTurnId ||
          e.invocationId !== invocation.invocationId,
      ) ||
      call.id !== task.sourceToolCallId ||
      outcome.id !== call.id ||
      dispatch.providerToolCallId !== call.id ||
      call.name !== 'Bash' ||
      outcome.name !== 'Bash' ||
      dispatch.toolName !== 'Bash' ||
      call.providerExecuted === true ||
      outcome.providerExecuted === true ||
      dispatch.protocol !== 't1_after_preflight_v1' ||
      dispatch.canonicalArgsHash !== canonicalToolArgsHash('Bash', call.args) ||
      outcomes[0]?.refs?.operationId !== dispatch.operationId ||
      facts.indexOf(calls[0]!) >= facts.indexOf(dispatches[0]!) ||
      facts.indexOf(dispatches[0]!) >= facts.indexOf(outcomes[0]!) ||
      !isBackgroundCall(call.args) ||
      !isTaskResult(outcome.result, wait.resource.resourceId)
    )
      return { kind: 'revoked', reason: 'shell_run_provenance_invalid' };
    // Proof reads may suspend. Recheck the live resource binding after them;
    // a registration-time snapshot cannot authorize a later admission.
    let current: ShellRunRecord;
    try {
      current = await this.shellRuns.readShellRun(wait.sessionId, taskId);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return { kind: 'revoked', reason: 'shell_run_missing' };
      throw error;
    }
    signal.throwIfAborted();
    if (current.visibility === 'user')
      return { kind: 'revoked', reason: 'shell_run_access_revoked' };
    if (
      current.sessionId !== task.sessionId ||
      current.shellRunId !== task.shellRunId ||
      current.sourceRunId !== task.sourceRunId ||
      current.sourceTurnId !== task.sourceTurnId ||
      current.sourceToolCallId !== task.sourceToolCallId ||
      current.startedAt !== task.startedAt
    )
      return { kind: 'revoked', reason: 'shell_run_identity_invalid' };
    task = current;
    // Canonical immutable T2 retains the original outcome even after its model
    // projection is archived/pruned. Never authorize from a placeholder or UI row.
    const {
      sessionId,
      shellRunId,
      sourceRunId,
      sourceTurnId,
      sourceToolCallId,
      startedAt,
      status,
      completedAt,
      exitCode,
      failureMessage,
    } = task;
    return {
      kind: 'allowed',
      fact: {
        sessionId,
        shellRunId,
        sourceRunId,
        sourceTurnId,
        sourceToolCallId,
        startedAt,
        status,
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(failureMessage === undefined ? {} : { failureMessage }),
      },
    };
  }
}
function isBackgroundCall(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'run_in_background' in value &&
    value.run_in_background === true
  );
}
function isTaskResult(value: unknown, ref: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'shell_run' &&
    'ref' in value &&
    value.ref === ref
  );
}
