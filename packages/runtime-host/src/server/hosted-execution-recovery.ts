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
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import {
  runtimeInvocationOutcome,
  type RootExecutionDescriptor,
  type RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
import {
  messageContentsEqual,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { StoredMessage } from '@maka/core/session';
import { projectRuntimeEventUserMessage } from '@maka/runtime/runtime-event-read-model';
import {
  admittedPromptEventId,
  RuntimeMessageAuthorityInvariantError,
} from '@maka/runtime/message-authority';
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
  readonly assertScheduledTaskAdmission?: (
    admission: RootTurnAdmission,
    state: 'pending_fire_required' | 'run_recorded',
  ) => Promise<void>;
}

/** Validates and repairs durable admission/message relationships before execution replay. */
export async function prepareHostedExecutionRecovery(
  input: PrepareHostedExecutionRecoveryInput,
): Promise<readonly HostedExecutionRecoveryPlan[]> {
  // listHeaders() avoids listForRecovery()'s discarded per-Session message
  // pre-read. The messages an admission is checked against are the Session's
  // own RuntimeEvents: the ledger is where a Turn's user message is committed,
  // so it is also the only place a missing one can be detected.
  const sessions = await input.stores.sessionStore.listHeaders();
  const prepared: PreparedRecoverySession[] = [];
  for (const session of sessions) {
    const admissions = await input.rootAdmissions.recoverSession(session.id);
    const runs = await input.stores.runtimeEventStore.listSessionInvocations(session.id);
    const runsById = new Map(runs.map((run) => [run.runId, run]));
    for (const run of runs) {
      await input.stores.agentRunStore.readEventsForRecovery(session.id, run.runId);
      await input.stores.runtimeEventStore.readRuntimeEvents(session.id, run.runId);
    }
    const messageIndex = indexRecoveryMessages(
      recoveryUserMessagesFromLedger(
        await input.stores.runtimeEventStore.readSessionRuntimeEvents(session.id),
      ),
    );
    const replayAdmissions: RootTurnAdmission[] = [];
    const rootReplayAdmissions: RootTurnAdmission[] = [];
    const pendingRecoveryClosures: PendingRecoveryClosure[] = [];
    for (const admission of admissions) {
      const run = runsById.get(admission.runId);
      const logical =
        run && (await readLogicalRuntimeExecution(input.stores.runtimeEventStore, admission, run));
      if (logical?.pendingHandoff) {
        replayAdmissions.push(admission);
        rootReplayAdmissions.push(admission);
      }
      const admittedMessageId = admittedPromptEventId(admission.runId, admission.userMessageId);
      // Whether the prompt is on the ledger is a question about the Turn, not
      // about the id it landed under: a Run written by an older build derived
      // that id differently, and matching on the id would read its prompt as
      // missing and record a second one.
      const rootUserMessages = messageIndex.userMessagesByTurnId.get(admission.turnId) ?? [];
      const messageIdOwners = messageIndex.messagesById.get(admittedMessageId) ?? [];
      if (messageIdOwners.length > 1) {
        throw new Error(`Admitted Turn ${admission.turnId} has a duplicated UserMessage identity`);
      }
      const messageIdOwner = messageIdOwners[0];
      const executionContract = recoveryExecutionContract(admission.execution);
      if (
        admission.execution.kind === 'scheduled_task' &&
        (!logical || runtimeInvocationOutcome(logical.tip) === undefined)
      ) {
        if (!input.assertScheduledTaskAdmission) {
          throw new RuntimeMessageAuthorityInvariantError(
            'ScheduledTask recovery admission has no canonical authority validator',
          );
        }
        await input.assertScheduledTaskAdmission(
          admission,
          run === undefined ? 'pending_fire_required' : 'run_recorded',
        );
      }
      if (!executionContract.allowsQueueSources && admission.sourceMessages.length !== 0) {
        throw new Error(
          `Admitted Turn ${admission.turnId} has queue-independent execution with Message queue sources`,
        );
      }
      const requiresUserMessage =
        executionContract.requiresUserMessage &&
        !(executionContract.allowsQueueSources && admission.sourceMessages.length > 1);
      if (requiresUserMessage !== (admission.userMessageId !== null)) {
        throw new Error(
          `Admitted Turn ${admission.turnId} has an invalid UserMessage execution contract`,
        );
      }
      if (admission.userMessageId === null) {
        if (admission.sourceMessages.length > 0) {
          await verifyQueueSourceMessages(admission, messageIndex, input.stores.agentRunStore);
        }
        if (!run) {
          if (executionContract.pendingWithoutRun === 'host_recovery_closure') {
            pendingRecoveryClosures.push({ admission });
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
        if (executionContract.requiresUserMessage) {
          const recorded = verifyUserMessage(admission, rootUserMessages, messageIdOwner);
          await recordAdmittedUserMessage(input.stores, admission, run, recorded);
        }
        continue;
      }
      if (!run && executionContract.pendingWithoutRun === 'host_recovery_closure') {
        // The closure below opens this Turn's invocation, so it is also what
        // writes the message the crashed admission never got to record.
        const recorded = verifyUserMessage(admission, rootUserMessages, messageIdOwner);
        pendingRecoveryClosures.push({
          admission,
          ...(recorded ? {} : { writesUserMessage: true }),
        });
        continue;
      }
      if (!run) {
        // Every remaining path replays the admission, and a replay opens the
        // Turn with the admission's own message id — writing the message here
        // would only race the Run that owns it.
        verifyUserMessage(admission, rootUserMessages, messageIdOwner);
        replayAdmissions.push(admission);
        if (executionContract.pendingWithoutRun !== 'domain_replay') {
          rootReplayAdmissions.push(admission);
        }
        continue;
      }
      await input.projection.assertRunIdentityAndContinuation(
        run,
        admission.turnId,
        admission.execution,
      );
      await recordAdmittedUserMessage(
        input.stores,
        admission,
        run,
        verifyUserMessage(admission, rootUserMessages, messageIdOwner),
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
      pendingRecoveryClosures,
    });
  }

  for (const plan of prepared) {
    for (const { admission, writesUserMessage } of plan.pendingRecoveryClosures) {
      if (!usesHostRecoveryClosure(admission.execution)) {
        throw new Error('Execution domain cannot use Host recovery closure');
      }
      const origin = hostedExecutionMessageOrigin(admission.execution);
      await input.runtime.closePendingHostedAdmission({
        sessionId: admission.sessionId,
        turnId: admission.turnId,
        runId: admission.runId,
        admittedAt: admission.admittedAt,
        execution: admission.execution,
        ...(writesUserMessage && admission.userMessageId
          ? {
              userMessage: {
                id: admission.userMessageId,
                content: requireHostedExecutionMessageContent(admission),
                ...(origin ? { origin } : {}),
              },
            }
          : {}),
      });
    }
  }
  return prepared.map(({ sessionId, admissions, rootReplayAdmission }) => ({
    sessionId,
    admissions,
    ...(rootReplayAdmission ? { rootReplayAdmission } : {}),
  }));
}

/**
 * The message a crashed Turn was admitted with, written into the Run that had
 * already opened for it.
 *
 * A Run records its own user message right after its opening fact, so a Run
 * that exists without one crashed between those two writes. Nothing else will
 * write it now: the terminal fact recovery is about to append would seal the
 * Turn without ever saying what the user asked for.
 *
 * The admission's normalized input is what goes in, not its queue sources: a
 * Root folded from several Messages ran as one prompt, and that is the prompt
 * the Turn was executed with.
 */
async function recordAdmittedUserMessage(
  stores: ExecutionStoresWriter<'interactive'>,
  admission: RootTurnAdmission,
  run: RuntimeInvocationRecord,
  ledgerHasMessage: boolean,
): Promise<void> {
  if (run.terminalEvent) return;
  const content = requireHostedExecutionMessageContent(admission);
  const origin = hostedExecutionMessageOrigin(admission.execution);
  const event: RuntimeEvent = {
    id: admittedPromptEventId(admission.runId, admission.userMessageId),
    sessionId: admission.sessionId,
    invocationId: run.invocationId,
    runId: run.runId,
    turnId: admission.turnId,
    ts: admission.admittedAt,
    partial: false,
    role: 'user',
    author: origin ? 'host' : 'user',
    content: { kind: 'text', ...content, ...(origin ? { origin } : {}) },
  };
  if (!ledgerHasMessage) {
    await stores.runtimeEventStore.appendRuntimeEvent(admission.sessionId, run.runId, event);
  }
  // The Turn never reached the commit that carries these, and no later path
  // recomputes them: the connection lock is one-way and the preview is a write.
  // Committed even when the ledger already holds the message, because the two
  // are separate writes and a crash between them leaves exactly that state.
  const message = projectRuntimeEventUserMessage(event, event.id);
  if (message) {
    await stores.sessionStore.commitMessageCatalogProjection(admission.sessionId, message);
  }
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
  readonly pendingRecoveryClosures: readonly PendingRecoveryClosure[];
}

interface PendingRecoveryClosure {
  readonly admission: RootTurnAdmission;
  /** The ledger has no message for this admission; the closure records it. */
  readonly writesUserMessage?: true;
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

/**
 * Whether the ledger already carries this admission's message, throwing when
 * what it carries contradicts the admission.
 */
function verifyUserMessage(
  admission: RootTurnAdmission,
  rootUserMessages: readonly RecoveryUserMessage[],
  messageIdOwner: StoredMessage | undefined,
): boolean {
  if (rootUserMessages.length > 1) {
    throw new Error(`Admitted Turn ${admission.turnId} has multiple UserMessages`);
  }
  const userMessage = rootUserMessages[0];
  if (userMessage) {
    if (
      (messageIdOwner !== undefined && messageIdOwner !== userMessage) ||
      !recoveryUserMessageOriginMatches(userMessage, admission.execution) ||
      !messageContentsEqual(
        normalizeMessageContent(userMessage),
        requireHostedExecutionMessageContent(admission),
      )
    ) {
      throw new Error(`Admitted Turn ${admission.turnId} does not match its UserMessage`);
    }
    return true;
  }
  if (messageIdOwner) {
    throw new Error(`Admitted Turn ${admission.turnId} reuses another message identity`);
  }
  return false;
}

/**
 * The prompts a Session's ledger holds, as the transcript presents them.
 *
 * Recovery reads the raw events rather than the read model: a Session it is
 * about to repair may be exactly the one whose projection is still incomplete.
 * Steering is excluded — it is typed as a user message but is something said
 * into a Turn that was already admitted, so it is never the Turn's own prompt.
 */
function recoveryUserMessagesFromLedger(
  events: readonly RuntimeEvent[],
): readonly RecoveryUserMessage[] {
  const messages: RecoveryUserMessage[] = [];
  for (const event of events) {
    if (event.role !== 'user' || event.content?.kind !== 'text' || event.partial) continue;
    const projected: RecoveryUserMessage | undefined = projectRuntimeEventUserMessage(
      event,
      event.id,
    );
    if (projected && projected.steeringEventId === undefined) messages.push(projected);
  }
  return messages;
}

async function verifyQueueSourceMessages(
  admission: RootTurnAdmission,
  index: RecoveryMessageIndex,
  proofReader: Pick<
    ExecutionStoresWriter<'interactive'>['agentRunStore'],
    'readRootTurnSourceMessageReceipt'
  >,
): Promise<void> {
  for (const source of admission.sourceMessages) {
    const owners = index.messagesById.get(source.messageId) ?? [];
    if (owners.length === 0) {
      const proof = await proofReader.readRootTurnSourceMessageReceipt(
        admission.sessionId,
        source.messageId,
      );
      if (
        !proof ||
        proof.admission.sessionId !== admission.sessionId ||
        proof.admission.turnId !== admission.turnId ||
        proof.admission.runId !== admission.runId ||
        proof.sourceMessage.messageId !== source.messageId ||
        !messageContentsEqual(proof.sourceMessage.content, source.content)
      ) {
        throw new Error(
          `Admitted Turn ${admission.turnId} has no durable proof for queue source ${source.messageId}`,
        );
      }
      continue;
    }
    if (
      owners.length !== 1 ||
      owners[0]?.type !== 'user' ||
      owners[0].turnId !== admission.turnId ||
      !messageContentsEqual(normalizeMessageContent(owners[0]), source.content)
    ) {
      throw new Error(
        `Admitted Turn ${admission.turnId} does not match queue source ${source.messageId}`,
      );
    }
  }
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
    case 'workhub_coordination':
      return contract(
        execution.operation !== 'action',
        true,
        execution.operation === 'action' ? 'host_recovery_closure' : 'root_replay',
      );
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
      | 'workhub_coordination'
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
    (execution.kind === 'workhub_coordination' && execution.operation === 'action') ||
    execution.kind === 'legacy_automation' ||
    execution.kind === 'goal' ||
    execution.kind === 'agent_graph_supervisor_wake' ||
    execution.kind === 'linked_child_initial' ||
    execution.kind === 'linked_child_resume' ||
    execution.kind === 'claimed_agent_graph_intent' ||
    execution.kind === 'linked_child_provider_retry'
  );
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
