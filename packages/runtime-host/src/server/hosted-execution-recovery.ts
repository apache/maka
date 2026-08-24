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

import { isDeepStrictEqual } from 'node:util';
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import {
  messageContentsEqual,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import { RuntimeMessageAuthorityInvariantError } from '@maka/runtime/message-authority';
import { type SessionManager } from '@maka/runtime/session-manager';
import type { ExecutionStoresWriter, RootTurnAdmission } from '@maka/storage/execution-stores';
import type { RootAdmissionOwner } from './root-admission-owner.js';
import type { HostedExecutionProjectionReader } from './hosted-execution-projection.js';

export interface HostedExecutionRecoveryPlan {
  readonly sessionId: string;
  readonly admissions: readonly RootTurnAdmission[];
  readonly rootReplayAdmission?: RootTurnAdmission;
}

export interface PrepareHostedExecutionRecoveryInput {
  readonly stores: ExecutionStoresWriter<'interactive'>;
  readonly rootAdmissions: RootAdmissionOwner;
  readonly projection: HostedExecutionProjectionReader;
  readonly runtime: Pick<SessionManager, 'closePendingHostedAdmission'>;
  readonly assertScheduledTaskAdmission?: (admission: RootTurnAdmission) => Promise<void>;
}

/** Validates and repairs durable admission/message relationships before execution replay. */
export async function prepareHostedExecutionRecovery(
  input: PrepareHostedExecutionRecoveryInput,
): Promise<readonly HostedExecutionRecoveryPlan[]> {
  const sessions = await input.stores.sessionStore.listForRecovery();
  const prepared: PreparedRecoverySession[] = [];
  for (const session of sessions) {
    const admissions = await input.rootAdmissions.recoverSession(session.id);
    const messages = await input.stores.sessionStore.readMessagesForRecovery(session.id);
    const runs = await input.stores.agentRunStore.listSessionRunsForRecovery(session.id);
    const runsById = new Map(runs.map((run) => [run.runId, run]));
    for (const run of runs) {
      await input.stores.agentRunStore.readEventsForRecovery(session.id, run.runId);
      await input.stores.runtimeEventStore.readRuntimeEvents(session.id, run.runId);
    }
    const messageIndex = indexRecoveryMessages(messages);
    const replayAdmissions: RootTurnAdmission[] = [];
    const rootReplayAdmissions: RootTurnAdmission[] = [];
    const missingMessages: RecoveryUserMessage[] = [];
    const pendingRecoveryClosures: RootTurnAdmission[] = [];
    for (const admission of admissions) {
      const run = runsById.get(admission.runId);
      const rootUserMessages = (
        messageIndex.userMessagesByTurnId.get(admission.turnId) ?? []
      ).filter((message) => message.steeringEventId === undefined);
      const messageIdOwners = admission.userMessageId
        ? (messageIndex.messagesById.get(admission.userMessageId) ?? [])
        : [];
      const executionContract = recoveryExecutionContract(admission.execution);
      if (admission.execution.kind === 'scheduled_task' && (!run || !isTerminalRun(run.status))) {
        if (!input.assertScheduledTaskAdmission) {
          throw new RuntimeMessageAuthorityInvariantError(
            'ScheduledTask recovery admission has no canonical authority validator',
          );
        }
        await input.assertScheduledTaskAdmission(admission);
      }
      if (!executionContract.allowsQueueSources && admission.sourceMessages.length !== 0) {
        throw new Error(
          `Admitted Turn ${admission.turnId} has queue-independent execution with Message queue sources`,
        );
      }
      if (executionContract.requiresUserMessage !== (admission.userMessageId !== null)) {
        throw new Error(
          `Admitted Turn ${admission.turnId} has an invalid UserMessage execution contract`,
        );
      }
      if (admission.userMessageId === null) {
        if (rootUserMessages.length > 0) {
          throw new Error(`Admitted Turn ${admission.turnId} must not record a UserMessage`);
        }
        if (!run) {
          if (executionContract.pendingWithoutRun === 'host_recovery_closure') {
            pendingRecoveryClosures.push(admission);
          } else {
            replayAdmissions.push(admission);
            if (executionContract.pendingWithoutRun === 'root_replay') {
              rootReplayAdmissions.push(admission);
            }
          }
          continue;
        }
        if (admission.execution.kind === 'safe_boundary_continuation') {
          input.projection.assertRunIdentity(run, admission.turnId, admission.execution);
        } else {
          await input.projection.assertRunIdentityAndContinuation(
            run,
            admission.turnId,
            admission.execution,
          );
        }
        continue;
      }
      if (messageIdOwners.length > 1) {
        throw new Error(`Admitted Turn ${admission.turnId} has a duplicated UserMessage identity`);
      }
      const messageIdOwner = messageIdOwners[0];
      if (!run && executionContract.pendingWithoutRun === 'host_recovery_closure') {
        verifyOrRecoverUserMessage(
          admission,
          rootUserMessages,
          messageIdOwner,
          missingMessages,
          messageIndex,
        );
        pendingRecoveryClosures.push(admission);
        continue;
      }
      if (!run && executionContract.pendingWithoutRun === 'domain_replay') {
        verifyOrRecoverUserMessage(
          admission,
          rootUserMessages,
          messageIdOwner,
          missingMessages,
          messageIndex,
        );
        replayAdmissions.push(admission);
        continue;
      }
      if (!run) {
        if (rootUserMessages.length > 0 || messageIdOwner) {
          throw new Error(`Admitted Turn ${admission.turnId} has a UserMessage but no Run`);
        }
        replayAdmissions.push(admission);
        rootReplayAdmissions.push(admission);
        continue;
      }
      await input.projection.assertRunIdentityAndContinuation(
        run,
        admission.turnId,
        admission.execution,
      );
      verifyOrRecoverUserMessage(
        admission,
        rootUserMessages,
        messageIdOwner,
        missingMessages,
        messageIndex,
      );
    }
    if (replayAdmissions.length > 1) {
      throw new Error(`Session ${session.id} has multiple admitted Turns without Runs`);
    }
    if (replayAdmissions[0] && session.isArchived) {
      throw new Error(`Archived Session ${session.id} has an admitted Turn without a Run`);
    }
    prepared.push({
      sessionId: session.id,
      admissions,
      ...(rootReplayAdmissions[0] ? { rootReplayAdmission: rootReplayAdmissions[0] } : {}),
      missingMessages,
      pendingRecoveryClosures,
    });
  }

  for (const plan of prepared) {
    for (const message of plan.missingMessages) {
      await input.stores.sessionStore.appendMessage(plan.sessionId, message);
    }
    for (const admission of plan.pendingRecoveryClosures) {
      if (!usesHostRecoveryClosure(admission.execution)) {
        throw new Error('Execution domain cannot use Host recovery closure');
      }
      await input.runtime.closePendingHostedAdmission({
        sessionId: admission.sessionId,
        turnId: admission.turnId,
        runId: admission.runId,
        admittedAt: admission.admittedAt,
        execution: admission.execution,
      });
    }
  }
  return prepared.map(({ sessionId, admissions, rootReplayAdmission }) => ({
    sessionId,
    admissions,
    ...(rootReplayAdmission ? { rootReplayAdmission } : {}),
  }));
}

export function requireHostedExecutionMessageContent(admission: RootTurnAdmission): MessageContent {
  if (admission.normalizedInput === null) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Admitted Turn ${admission.turnId} has no message input`,
    );
  }
  return admission.normalizedInput;
}

export function hostedExecutionMessageOrigin(execution: RootExecutionDescriptor) {
  switch (execution.kind) {
    case 'scheduled_task':
      return {
        kind: 'scheduled_task' as const,
        scheduledTaskId: execution.scheduledTaskId,
      };
    case 'legacy_automation':
      return {
        kind: 'legacy_automation' as const,
        automationId: execution.automationId,
      };
    case 'goal':
      return { kind: 'goal' as const, goalId: execution.goalId };
    case 'agent_graph_supervisor_wake':
      return {
        kind: 'agent_graph' as const,
        graphId: execution.graphId,
        wakeId: execution.wakeId,
        attemptId: execution.attemptId,
      };
    default:
      return undefined;
  }
}

interface PreparedRecoverySession extends HostedExecutionRecoveryPlan {
  readonly missingMessages: readonly RecoveryUserMessage[];
  readonly pendingRecoveryClosures: readonly RootTurnAdmission[];
}

type RecoveryUserMessage = Extract<StoredMessage, { type: 'user' }>;

interface RecoveryMessageIndex {
  readonly userMessagesByTurnId: Map<string, RecoveryUserMessage[]>;
  readonly messagesById: Map<string, StoredMessage[]>;
}

interface RecoveryExecutionContract {
  readonly allowsQueueSources: boolean;
  readonly requiresUserMessage: boolean;
  readonly pendingWithoutRun: 'root_replay' | 'domain_replay' | 'host_recovery_closure';
}

function verifyOrRecoverUserMessage(
  admission: RootTurnAdmission,
  rootUserMessages: readonly RecoveryUserMessage[],
  messageIdOwner: StoredMessage | undefined,
  missingMessages: RecoveryUserMessage[],
  index: RecoveryMessageIndex,
): void {
  if (rootUserMessages.length > 1) {
    throw new Error(`Admitted Turn ${admission.turnId} has multiple UserMessages`);
  }
  const userMessage = rootUserMessages[0];
  if (userMessage) {
    if (
      messageIdOwner !== userMessage ||
      userMessage.id !== admission.userMessageId ||
      !recoveryUserMessageOriginMatches(userMessage, admission.execution) ||
      !messageContentsEqual(
        normalizeMessageContent(userMessage),
        requireHostedExecutionMessageContent(admission),
      )
    ) {
      throw new Error(`Admitted Turn ${admission.turnId} does not match its UserMessage`);
    }
    return;
  }
  if (messageIdOwner) {
    throw new Error(`Admitted Turn ${admission.turnId} reuses another message identity`);
  }
  const recoveredMessage = recoveryUserMessage(admission);
  missingMessages.push(recoveredMessage);
  indexRecoveryMessage(index, recoveredMessage);
}

function recoveryUserMessage(admission: RootTurnAdmission): RecoveryUserMessage {
  if (!admission.userMessageId || !admission.normalizedInput) {
    throw new Error(`Admitted Turn ${admission.turnId} does not own a UserMessage`);
  }
  const origin = hostedExecutionMessageOrigin(admission.execution);
  return {
    type: 'user',
    id: admission.userMessageId,
    turnId: admission.turnId,
    ts: admission.admittedAt,
    ...normalizeMessageContent(admission.normalizedInput),
    ...(origin ? { origin } : {}),
  };
}

function recoveryUserMessageOriginMatches(
  message: RecoveryUserMessage,
  execution: RootExecutionDescriptor,
): boolean {
  const expected = hostedExecutionMessageOrigin(execution);
  return expected === undefined || isDeepStrictEqual(message.origin, expected);
}

function recoveryExecutionContract(execution: RootExecutionDescriptor): RecoveryExecutionContract {
  switch (execution.kind) {
    case 'external_message':
      return contract(true, true, 'root_replay');
    case 'regenerate':
      return contract(false, true, 'root_replay');
    case 'context_compact':
      return contract(false, false, 'root_replay');
    case 'scheduled_task':
      return contract(false, true, 'domain_replay');
    case 'legacy_automation':
      return contract(false, true, 'host_recovery_closure');
    case 'goal':
      return contract(false, true, 'host_recovery_closure');
    case 'safe_boundary_continuation':
      return contract(false, false, 'root_replay');
    case 'agent_graph_supervisor_wake':
    case 'linked_child_initial':
    case 'linked_child_resume':
    case 'claimed_agent_graph_intent':
      return contract(false, true, 'host_recovery_closure');
    case 'linked_child_provider_retry':
      return contract(false, false, 'host_recovery_closure');
    default:
      return assertNever(execution);
  }
}

function contract(
  allowsQueueSources: boolean,
  requiresUserMessage: boolean,
  pendingWithoutRun: RecoveryExecutionContract['pendingWithoutRun'],
): RecoveryExecutionContract {
  return { allowsQueueSources, requiresUserMessage, pendingWithoutRun };
}

function usesHostRecoveryClosure(execution: RootExecutionDescriptor): execution is Extract<
  RootExecutionDescriptor,
  {
    kind:
      | 'goal'
      | 'legacy_automation'
      | 'agent_graph_supervisor_wake'
      | 'linked_child_initial'
      | 'linked_child_resume'
      | 'claimed_agent_graph_intent'
      | 'linked_child_provider_retry';
  }
> {
  return (
    execution.kind === 'legacy_automation' ||
    execution.kind === 'goal' ||
    execution.kind === 'agent_graph_supervisor_wake' ||
    execution.kind === 'linked_child_initial' ||
    execution.kind === 'linked_child_resume' ||
    execution.kind === 'claimed_agent_graph_intent' ||
    execution.kind === 'linked_child_provider_retry'
  );
}

function isTerminalRun(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function indexRecoveryMessages(messages: readonly StoredMessage[]): RecoveryMessageIndex {
  const index: RecoveryMessageIndex = {
    userMessagesByTurnId: new Map(),
    messagesById: new Map(),
  };
  for (const message of messages) indexRecoveryMessage(index, message);
  return index;
}

function indexRecoveryMessage(index: RecoveryMessageIndex, message: StoredMessage): void {
  appendIndexed(index.messagesById, message.id, message);
  if (message.type === 'user') {
    appendIndexed(index.userMessagesByTurnId, message.turnId, message);
  }
}

function appendIndexed<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported root execution descriptor: ${JSON.stringify(value)}`);
}
