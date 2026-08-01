import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BackendStopMode } from '@maka/core/backend-types';
import type { AgentRunHeader } from '@maka/core/agent-run';
import {
  messageContentsEqual,
  normalizeMessageContent,
  type MessageContent,
  type SessionEvent,
} from '@maka/core/events';
import { isDeepResearchSession, type SessionHeader, type StoredMessage } from '@maka/core/session';
import {
  classifyTerminalRuntimeLedger,
  RuntimeHostedRootConflictError,
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  RuntimeMessageAuthorityInvariantError,
  RuntimeOwnerCleanupError,
  type RuntimeHostedRootExecutionInput,
  type RuntimeMessageRunIdentity,
  type SessionManager,
} from '@maka/runtime';
import {
  authenticateExecutionStoresWriter,
  isSessionNotFoundError,
  type ExecutionStoresWriter,
  type RootTurnAdmission,
} from '@maka/storage/execution-stores';
import type {
  OperationOutcome,
  TurnQueryInput,
  TurnSnapshot,
  TurnStartInput,
  TurnStopInput,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import {
  type HostMessageRootState,
  type HostMessageSessionHeader,
  type HostMessageStartInput,
  type HostMessageStopClaim,
  type HostMessageStopFence,
  HostMessageCoordinator,
  type QueueFenceResult,
  type RootFollowupBatch,
} from './message-coordinator.js';
import type { ConnectionContext, TurnOperationHandlerMap } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import {
  type RuntimeSessionTransientEvent,
  SessionContinuityCoordinator,
} from './session-continuity-coordinator.js';
import type { HostClientCapabilityCoordinator } from './client-capability-coordinator.js';

type RootTerminalInteractionFence = Pick<
  HostInteractionCoordinator,
  'assertTerminalFence' | 'claimRunClosure'
>;

interface ActiveRootTurn {
  turnId: string;
  runId: string;
  userMessageId: string | null;
  execution?: RuntimeHostedRootExecutionInput;
  startSettled: Deferred;
  done: Promise<void>;
  residency: RuntimeHostResidency;
  stopRequested: boolean;
  messageTransitionCommitted: boolean;
}

type TurnStartOutcome = OperationOutcome<'turn.start'>;

type TurnStartDisposition =
  | { kind: 'complete'; outcome: TurnStartOutcome }
  | { kind: 'await_start'; active: ActiveRootTurn };

type TurnStopOutcome = OperationOutcome<'turn.stop'>;

type TurnStopDisposition =
  | { kind: 'complete'; outcome: TurnStopOutcome }
  | { kind: 'request_stop'; active: ActiveRootTurn }
  | { kind: 'await_terminal'; active: ActiveRootTurn };

interface DeclaredStopFence {
  readonly active: ActiveRootTurn;
  deliverStop(): Promise<void>;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly phase: 'pending' | 'resolved' | 'rejected';
  resolve(): void;
  reject(error: unknown): void;
}

interface RecoverySessionPlan {
  sessionId: string;
  admissions: readonly RootTurnAdmission[];
  missingMessages: readonly RecoveryUserMessage[];
  pendingChildAdmissions: readonly RootTurnAdmission[];
}

export class RootTurnCoordinator {
  readonly handlers: TurnOperationHandlerMap = {
    'turn.start': (input, context) => this.startTurn(input, context),
    'turn.query': (input) => this.queryTurn(input),
    'turn.stop': (input) => this.stopTurn(input),
  };

  readonly #activeBySession = new Map<string, ActiveRootTurn>();
  readonly #recoveryAdmissionsBySession = new Map<string, readonly RootTurnAdmission[]>();
  private readonly stores: ExecutionStoresWriter<'interactive'>;

  constructor(
    private readonly manager: SessionManager,
    stores: ExecutionStoresWriter<'interactive'>,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly rootAdmissionOwner: RootAdmissionOwner,
    private readonly interactions: RootTerminalInteractionFence,
    private readonly messages: HostMessageCoordinator,
    private readonly continuity: SessionContinuityCoordinator,
    private readonly acquireRecoveryResidency: () => RuntimeHostResidency,
    private readonly requestHostDrain: () => void,
    private readonly clientCapabilities?: HostClientCapabilityCoordinator,
  ) {
    this.stores = authenticateExecutionStoresWriter(stores, 'interactive');
  }

  async prepareRecovery(): Promise<void> {
    const sessions = await this.stores.sessionStore.listForRecovery();
    const plans: RecoverySessionPlan[] = [];
    for (const session of sessions) {
      const admissions = await this.rootAdmissionOwner.recoverSession(session.id);
      const messages = await this.stores.sessionStore.readMessagesForRecovery(session.id);
      const runs = await this.stores.agentRunStore.listSessionRunsForRecovery(session.id);
      const runsById = new Map(runs.map((run) => [run.runId, run]));
      for (const run of runs) {
        await this.stores.agentRunStore.readEventsForRecovery(session.id, run.runId);
        await this.stores.runtimeEventStore.readRuntimeEvents(session.id, run.runId);
      }
      const messageIndex = indexRecoveryMessages(messages);
      const pending: RootTurnAdmission[] = [];
      const missingMessages: RecoveryUserMessage[] = [];
      const pendingChildAdmissions: RootTurnAdmission[] = [];
      for (const admission of admissions) {
        const run = runsById.get(admission.runId);
        const userMessages = messageIndex.userMessagesByTurnId.get(admission.turnId) ?? [];
        const messageIdOwners = admission.userMessageId
          ? (messageIndex.messagesById.get(admission.userMessageId) ?? [])
          : [];
        const executionContract = recoveryExecutionContract(admission.execution);
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
          if (userMessages.length > 0) {
            throw new Error(`Admitted Turn ${admission.turnId} must not record a UserMessage`);
          }
          if (!run) {
            pendingChildAdmissions.push(admission);
            continue;
          }
          assertRunMatchesAdmission(run, admission);
          continue;
        }
        if (messageIdOwners.length > 1) {
          throw new Error(
            `Admitted Turn ${admission.turnId} has a duplicated UserMessage identity`,
          );
        }
        const messageIdOwner = messageIdOwners[0];
        if (!run && executionContract.pendingWithoutRun === 'child_recovery_closure') {
          if (userMessages.length > 1) {
            throw new Error(`Admitted Turn ${admission.turnId} has multiple UserMessages`);
          }
          const userMessage = userMessages[0];
          if (userMessage) {
            if (
              messageIdOwner !== userMessage ||
              userMessage.id !== admission.userMessageId ||
              !messageContentsEqual(
                storedUserMessageContent(userMessage),
                admission.normalizedInput,
              )
            ) {
              throw new Error(`Admitted Turn ${admission.turnId} does not match its UserMessage`);
            }
          } else {
            if (messageIdOwner) {
              throw new Error(`Admitted Turn ${admission.turnId} reuses another message identity`);
            }
            const recoveredMessage = recoveryUserMessage(admission);
            missingMessages.push(recoveredMessage);
            indexRecoveryMessage(messageIndex, recoveredMessage);
          }
          pendingChildAdmissions.push(admission);
          continue;
        }
        if (!run) {
          if (userMessages.length > 0 || messageIdOwner) {
            throw new Error(`Admitted Turn ${admission.turnId} has a UserMessage but no Run`);
          }
          pending.push(admission);
          continue;
        }
        assertRunMatchesAdmission(run, admission);
        if (userMessages.length > 1) {
          throw new Error(`Admitted Turn ${admission.turnId} has multiple UserMessages`);
        }
        const userMessage = userMessages[0];
        if (userMessage) {
          if (
            messageIdOwner !== userMessage ||
            userMessage.id !== admission.userMessageId ||
            !messageContentsEqual(storedUserMessageContent(userMessage), admission.normalizedInput)
          ) {
            throw new Error(`Admitted Turn ${admission.turnId} does not match its UserMessage`);
          }
          continue;
        }
        if (messageIdOwner) {
          throw new Error(`Admitted Turn ${admission.turnId} reuses another message identity`);
        }
        const recoveredMessage = recoveryUserMessage(admission);
        missingMessages.push(recoveredMessage);
        indexRecoveryMessage(messageIndex, recoveredMessage);
      }
      if (pending.length > 1) {
        throw new Error(`Session ${session.id} has multiple admitted Turns without Runs`);
      }
      const admission = pending[0];
      if (admission && (session.status === 'archived' || session.isArchived)) {
        throw new Error(`Archived Session ${session.id} has an admitted Turn without a Run`);
      }
      plans.push({
        sessionId: session.id,
        admissions,
        missingMessages,
        pendingChildAdmissions,
      });
    }

    for (const plan of plans) {
      for (const message of plan.missingMessages) {
        await this.stores.sessionStore.appendMessage(plan.sessionId, message);
      }
      for (const admission of plan.pendingChildAdmissions) {
        if (admission.execution.kind === 'external_message') {
          throw new Error('External Message admission cannot use child recovery closure');
        }
        await this.manager.closePendingHostedLinkedChildAdmission({
          sessionId: admission.sessionId,
          turnId: admission.turnId,
          runId: admission.runId,
          admittedAt: admission.admittedAt,
          execution: admission.execution,
        });
      }
      this.#recoveryAdmissionsBySession.set(plan.sessionId, plan.admissions);
    }
  }

  async recover(): Promise<void> {
    for (const [sessionId, admissions] of this.#recoveryAdmissionsBySession) {
      let pending: RootTurnAdmission | undefined;
      for (const admission of admissions) {
        const run = await this.readRunIfPresent(sessionId, admission.runId);
        if (!run) {
          pending = admission;
          continue;
        }
        const snapshot = await this.readCanonicalSnapshot(
          sessionId,
          admission.turnId,
          admission.runId,
          run,
        );
        if (!isTerminalSnapshot(snapshot)) {
          throw new Error(`Startup recovery left Turn ${admission.turnId} non-terminal`);
        }
      }
      const admission = pending;
      if (!admission) continue;
      const input = {
        sessionId,
        turnId: admission.turnId,
        content: normalizeMessageContent(admission.normalizedInput),
      };
      const disposition = await this.sessionAdmission.run(sessionId, (lease) =>
        this.prepareAdmittedTurn(input, admission, this.acquireRecoveryResidency, lease),
      );
      const outcome = await this.resolveStartDisposition(input, disposition);
      if (!outcome.ok) {
        throw new Error(
          `Unable to recover admitted Turn ${admission.turnId}: ${outcome.error.code}`,
        );
      }
    }
    this.#recoveryAdmissionsBySession.clear();
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    while (errors.length === 0) {
      const active = [...this.#activeBySession.entries()];
      if (active.length === 0) break;
      const results = await Promise.allSettled(
        active.map(([sessionId, turn]) => this.stopActiveTurn(sessionId, turn)),
      );
      errors.push(
        ...results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected' && !isShutdownCancelledBackendStart(result.reason),
          )
          .map((result) => result.reason),
      );
    }
    if (this.#activeBySession.size !== 0) {
      errors.push(new Error('Runtime Host execution composition closed with active Turns'));
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Unable to close Runtime Host execution composition');
  }

  async readSessionHeader(sessionId: string): Promise<HostMessageSessionHeader | null> {
    try {
      const header = await this.stores.sessionStore.readHeaderSnapshot(sessionId);
      if (header.conversationCopy?.state === 'preparing') return null;
      return {
        isArchived: header.isArchived || header.status === 'archived',
        unavailableReason: unsupportedSessionModeReason(header),
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) return null;
      throw error;
    }
  }

  readRootState(sessionId: string): HostMessageRootState {
    const active = this.#activeBySession.get(sessionId);
    return active
      ? {
          kind: 'active',
          sessionId,
          turnId: active.turnId,
          runId: active.runId,
        }
      : { kind: 'idle' };
  }

  executeRoot(input: RuntimeHostedRootExecutionInput): Promise<void> {
    return this.runCommand(async () => {
      const canonicalInput = {
        ...input,
        content: normalizeMessageContent(input.content),
      };
      const disposition = await this.sessionAdmission.run(input.sessionId, async (lease) => {
        const existing = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        if (existing) {
          this.rootAdmissionOwner.assertKnownAdmission(existing);
          if (
            existing.runId !== input.runId ||
            existing.userMessageId !== input.userMessageId ||
            !isDeepStrictEqual(existing.execution, input.execution) ||
            !messageContentsEqual(existing.normalizedInput, canonicalInput.content) ||
            existing.sourceMessages.length !== 0
          ) {
            throw new RuntimeMessageAuthorityInvariantError(
              'Hosted root execution identity conflicts with its durable admission',
            );
          }
          return this.prepareAdmittedTurn(
            canonicalInput,
            existing,
            this.acquireRecoveryResidency,
            lease,
            undefined,
            canonicalInput,
          );
        }

        const header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
        if (header.status === 'archived' || header.isArchived) {
          throw new Error('Cannot start a hosted root execution in an archived Session');
        }
        const unavailableReason = unsupportedSessionModeReason(header);
        if (unavailableReason) throw new Error(unavailableReason);
        if (this.#activeBySession.has(input.sessionId)) {
          throw new RuntimeHostedRootConflictError(
            input.sessionId,
            'Session already has an active root Turn',
          );
        }
        if (canonicalInput.admitExecution) {
          let admission: 'executing' | 'cancelled';
          try {
            admission = await canonicalInput.admitExecution();
          } catch (error) {
            throw new HostedRootAdmissionGateError(error);
          }
          if (admission === 'cancelled') {
            throw new HostedRootAdmissionGateError(
              new Error('Turn start was cancelled before runtime admission'),
            );
          }
        }
        const admitted = await this.rootAdmissionOwner.admitRootTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          proposedRunId: input.runId,
          proposedUserMessageId: input.userMessageId,
          execution: input.execution,
          normalizedInput: canonicalInput.content,
          sourceMessages: [],
          admittedAt: Date.now(),
        });
        if (
          admitted.admission.runId !== input.runId ||
          admitted.admission.userMessageId !== input.userMessageId ||
          !isDeepStrictEqual(admitted.admission.execution, input.execution) ||
          !messageContentsEqual(admitted.admission.normalizedInput, canonicalInput.content) ||
          admitted.admission.sourceMessages.length !== 0
        ) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Hosted root execution admission changed identity',
          );
        }
        return this.prepareAdmittedTurn(
          canonicalInput,
          admitted.admission,
          this.acquireRecoveryResidency,
          lease,
          undefined,
          canonicalInput,
        );
      });
      if (disposition.kind === 'complete') {
        if (!disposition.outcome.ok) {
          if (disposition.outcome.error.code === 'session_busy') {
            throw new RuntimeHostedRootConflictError(
              input.sessionId,
              disposition.outcome.error.message,
            );
          }
          throw new RuntimeMessageAuthorityInvariantError(disposition.outcome.error.message);
        }
        return;
      }
      await disposition.active.startSettled.promise;
      await disposition.active.done;
    }).catch((error) => {
      if (error instanceof HostedRootAdmissionGateError) throw error.cause;
      throw error;
    });
  }

  stopRoot(
    identity: RuntimeMessageRunIdentity,
    input: {
      source?: 'stop_button' | 'benchmark_deadline' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<void> {
    return this.runCommand(async () => {
      const declared = await this.sessionAdmission.run(identity.sessionId, (lease) =>
        this.declareStopFence(
          identity,
          () => this.messages.commitStopFence(identity),
          lease,
          input,
        ),
      );
      await declared?.deliverStop();
      await declared?.active.startSettled.promise;
      const disposition = await this.sessionAdmission.run(identity.sessionId, (lease) =>
        this.prepareStopDisposition(identity, () => this.messages.commitStopFence(identity), lease),
      );
      if (disposition.kind === 'complete') {
        if (!disposition.outcome.ok) throw new Error(disposition.outcome.error.message);
        return;
      }
      if (disposition.kind === 'request_stop') {
        await this.deliverRuntimeStopIntent(identity.sessionId, input);
      }
      await disposition.active.done;
    });
  }

  stopSession(
    sessionId: string,
    input: {
      source?: 'stop_button' | 'benchmark_deadline' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<void> {
    return this.runCommand(async () => {
      const declared = await this.sessionAdmission.run(sessionId, (lease) => {
        const active = this.#activeBySession.get(sessionId);
        if (!active) return undefined;
        const identity = {
          sessionId,
          turnId: active.turnId,
          runId: active.runId,
        };
        return this.declareStopFence(
          identity,
          () => this.messages.commitStopFence(identity),
          lease,
          input,
        );
      });
      await declared?.deliverStop();
      await declared?.active.startSettled.promise;
      const disposition = await this.sessionAdmission.run(sessionId, async (lease) => {
        if (!declared) return undefined;
        const identity = {
          sessionId,
          turnId: declared.active.turnId,
          runId: declared.active.runId,
        };
        return this.prepareStopDisposition(
          identity,
          () => this.messages.commitStopFence(identity),
          lease,
        );
      });
      if (!disposition || disposition.kind === 'complete') {
        if (disposition && !disposition.outcome.ok) {
          throw new Error(disposition.outcome.error.message);
        }
        return;
      }
      if (disposition.kind === 'request_stop') {
        await this.deliverRuntimeStopIntent(sessionId, input);
      }
      await disposition.active.done;
    });
  }

  startFromMessage(
    input: HostMessageStartInput,
    admissionLease: SessionAdmissionLease,
  ): Promise<{ readonly turnId: string } | { readonly error: string }> {
    return this.runCommand(async () => {
      const content = normalizeMessageContent(input.content);
      if (
        input.sourceMessage.disposition !== 'turn_started' ||
        !messageContentsEqual(input.sourceMessage.content, content)
      ) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Idle Message start lost its canonical turn_started source',
        );
      }
      if (this.#activeBySession.has(input.sessionId)) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Message authority attempted an idle start while a root Turn was active',
        );
      }
      const binding = await this.clientCapabilities?.bindSession(
        input.sessionId,
        input.initiatingConnectionId,
      );
      if (binding && !binding.ok) return { error: binding.message };

      const turnId = randomUUID();
      const admitted = await this.rootAdmissionOwner.admitRootTurn({
        sessionId: input.sessionId,
        turnId,
        proposedRunId: randomUUID(),
        proposedUserMessageId: input.sourceMessage.messageId,
        execution: { kind: 'external_message' },
        normalizedInput: content,
        sourceMessages: [input.sourceMessage],
        admittedAt: Date.now(),
      });
      if (admitted.kind !== 'admitted') {
        throw new RuntimeMessageAuthorityInvariantError(
          'Fresh Message root Turn identity already existed',
        );
      }
      const disposition = await this.prepareAdmittedTurn(
        { sessionId: input.sessionId, turnId, content },
        admitted.admission,
        this.acquireRecoveryResidency,
        admissionLease,
      );
      if (disposition.kind !== 'await_start') {
        throw new RuntimeMessageAuthorityInvariantError(
          'Fresh Message root Turn did not reserve execution',
        );
      }
      return { turnId };
    });
  }

  claimStop(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
  ): Promise<HostMessageStopClaim> {
    return this.runCommand(async () => {
      const disposition = await this.prepareStopDisposition(input, commitQueueFence, admission);
      if (disposition.kind === 'complete') {
        if (!disposition.outcome.ok) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Message interrupt no longer matched its admitted root Turn',
          );
        }
        return {
          deliverStop: () => Promise.resolve(),
          terminal: Promise.resolve(disposition.outcome.result),
        };
      }
      return {
        deliverStop: () =>
          disposition.kind === 'request_stop'
            ? this.deliverRuntimeStopIntent(input.sessionId)
            : Promise.resolve(),
        terminal: disposition.active.done.then(() =>
          this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId),
        ),
      };
    });
  }

  claimStopFence(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
  ): Promise<HostMessageStopFence> {
    return this.declareStopFence(input, commitQueueFence, admission).then((declared) => ({
      ready: declared?.active.startSettled.promise ?? Promise.resolve(),
      deliverStop: declared?.deliverStop ?? (() => Promise.resolve()),
    }));
  }

  private startTurn(input: TurnStartInput, context: ConnectionContext): Promise<TurnStartOutcome> {
    return this.runCommand(async () => {
      const canonicalInput: TurnStartInput = {
        ...input,
        content: normalizeMessageContent(input.content),
      };
      const disposition = await this.sessionAdmission.run(input.sessionId, async (lease) => {
        const existing = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        if (existing) {
          this.rootAdmissionOwner.assertKnownAdmission(existing);
          if (existing.execution.kind !== 'external_message') {
            return completedStart(
              operationConflict('Turn identity belongs to a different execution kind'),
            );
          }
          if (
            !messageContentsEqual(existing.normalizedInput, canonicalInput.content) ||
            existing.sourceMessages.length !== 0
          ) {
            return completedStart(
              operationConflict('Turn identity was already admitted with a different payload'),
            );
          }
          const existingRun = await this.readRunIfPresent(input.sessionId, existing.runId);
          if (existingRun) {
            const snapshot = await this.readCanonicalSnapshot(
              input.sessionId,
              input.turnId,
              existing.runId,
              existingRun,
            );
            if (isTerminalSnapshot(snapshot)) {
              return completedStart({ ok: true, result: snapshot });
            }
          }
          return this.prepareAdmittedTurn(
            canonicalInput,
            existing,
            context.acquireResidency,
            lease,
          );
        }

        let header: SessionHeader;
        try {
          header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
        } catch (error) {
          if (isSessionNotFoundError(error)) {
            return completedStart(notFound('Session does not exist'));
          }
          throw error;
        }
        if (header.status === 'archived' || header.isArchived) {
          return completedStart(sessionArchived('Cannot start a new Turn in an archived Session'));
        }
        const unavailableReason = unsupportedSessionModeReason(header);
        if (unavailableReason) {
          return completedStart(operationUnavailable(unavailableReason));
        }

        if (this.#activeBySession.has(input.sessionId)) {
          return completedStart(sessionBusy('Session already has an active root Turn'));
        }

        const binding = await this.clientCapabilities?.bindSession(
          input.sessionId,
          context.connectionId,
        );
        if (binding && !binding.ok) {
          return completedStart(operationConflict(binding.message));
        }
        const admission = await this.rootAdmissionOwner.admitRootTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          proposedRunId: randomUUID(),
          proposedUserMessageId: randomUUID(),
          execution: { kind: 'external_message' },
          normalizedInput: canonicalInput.content,
          sourceMessages: [],
          admittedAt: Date.now(),
        });
        if (admission.admission.execution.kind !== 'external_message') {
          return completedStart(
            operationConflict('Turn identity belongs to a different execution kind'),
          );
        }
        if (
          !messageContentsEqual(admission.admission.normalizedInput, canonicalInput.content) ||
          admission.admission.sourceMessages.length !== 0
        ) {
          return completedStart(
            operationConflict('Turn identity was already admitted with a different payload'),
          );
        }
        return this.prepareAdmittedTurn(
          canonicalInput,
          admission.admission,
          context.acquireResidency,
          lease,
        );
      });
      return this.resolveStartDisposition(canonicalInput, disposition);
    });
  }

  private queryTurn(input: TurnQueryInput): Promise<OperationOutcome<'turn.query'>> {
    return this.sessionAdmission.run(input.sessionId, async () => {
      const admission = await this.stores.agentRunStore.readRootTurnAdmission(
        input.sessionId,
        input.turnId,
      );
      if (!admission) return notFound('Turn was not admitted');
      this.rootAdmissionOwner.assertKnownAdmission(admission);
      return {
        ok: true,
        result: await this.readCanonicalSnapshot(input.sessionId, input.turnId, admission.runId),
      };
    });
  }

  private stopTurn(input: TurnStopInput): Promise<OperationOutcome<'turn.stop'>> {
    return this.runCommand(async () => {
      const declared = await this.sessionAdmission.run(input.sessionId, (lease) =>
        this.declareStopFence(input, () => this.messages.commitStopFence(input), lease),
      );
      await declared?.deliverStop();
      await declared?.active.startSettled.promise;
      const disposition = await this.sessionAdmission.run(input.sessionId, (lease) =>
        this.prepareStopDisposition(input, () => this.messages.commitStopFence(input), lease),
      );
      if (disposition.kind === 'complete') return disposition.outcome;
      if (disposition.kind === 'request_stop') {
        await this.deliverRuntimeStopIntent(input.sessionId);
      }
      await disposition.active.done;
      return {
        ok: true,
        result: await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId),
      };
    });
  }

  private async declareStopFence(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
    stopInput: {
      source?: 'stop_button' | 'benchmark_deadline' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<DeclaredStopFence | undefined> {
    const active = this.#activeBySession.get(input.sessionId);
    if (!active || active.turnId !== input.turnId || active.runId !== input.runId) {
      return undefined;
    }
    if (active.startSettled.phase === 'rejected') {
      return { active, deliverStop: () => Promise.resolve() };
    }
    commitQueueFence();
    await this.interactions.claimRunClosure(input, 'turn_stopped', admission);
    const shouldDeliverStop = !active.stopRequested;
    active.stopRequested = true;
    return {
      active,
      deliverStop: () =>
        shouldDeliverStop
          ? this.deliverRuntimeStopIntent(input.sessionId, stopInput)
          : Promise.resolve(),
    };
  }

  private async prepareStopDisposition(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admissionLease: SessionAdmissionLease,
  ): Promise<TurnStopDisposition> {
    const admission = await this.stores.agentRunStore.readRootTurnAdmission(
      input.sessionId,
      input.turnId,
    );
    if (!admission) return { kind: 'complete', outcome: notFound('Turn was not admitted') };
    this.rootAdmissionOwner.assertKnownAdmission(admission);
    if (admission.runId !== input.runId) {
      return {
        kind: 'complete',
        outcome: operationConflict('Run identity does not match the admitted Turn'),
      };
    }

    const snapshot = await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId);
    const active = this.#activeBySession.get(input.sessionId);
    if (isTerminalSnapshot(snapshot)) {
      if (active?.turnId === input.turnId && active.runId === input.runId) {
        commitQueueFence();
        active.stopRequested = true;
        return { kind: 'await_terminal', active };
      }
      return { kind: 'complete', outcome: { ok: true, result: snapshot } };
    }
    if (!active) {
      throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
    }
    if (active.turnId !== input.turnId || active.runId !== input.runId) {
      return {
        kind: 'complete',
        outcome: operationConflict('A different root Turn owns the active Session execution'),
      };
    }

    commitQueueFence();
    await this.interactions.claimRunClosure(input, 'turn_stopped', admissionLease);
    const shouldRequestStop = !active.stopRequested;
    active.stopRequested = true;
    return shouldRequestStop
      ? { kind: 'request_stop', active }
      : { kind: 'await_terminal', active };
  }

  private async prepareAdmittedTurn(
    input: TurnStartInput,
    admission: RootTurnAdmission,
    acquireResidency: () => RuntimeHostResidency,
    admissionLease: SessionAdmissionLease,
    replacing?: ActiveRootTurn,
    execution?: RuntimeHostedRootExecutionInput,
  ): Promise<TurnStartDisposition> {
    if (admission.sessionId !== input.sessionId || admission.turnId !== input.turnId) {
      throw new Error('Root Turn admission identity does not match its input');
    }
    const { runId } = admission;
    const existingRun = await this.readRunIfPresent(input.sessionId, runId);
    if (replacing && existingRun) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Fresh follow-up root Turn unexpectedly had an existing Run',
      );
    }
    if (existingRun) {
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        runId,
        existingRun,
      );
      if (isTerminalSnapshot(snapshot)) return completedStart({ ok: true, result: snapshot });
      const active = this.#activeBySession.get(input.sessionId);
      if (active?.turnId === input.turnId && active.runId === runId) {
        return { kind: 'await_start', active };
      }
      if (active) return completedStart(sessionBusy('Session already has an active root Turn'));
      throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
    }

    const active = this.#activeBySession.get(input.sessionId);
    if (replacing && active !== replacing) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up root replacement lost the previous active Turn',
      );
    }
    if (active && active !== replacing) {
      if (active.turnId !== input.turnId || active.runId !== runId) {
        return completedStart(sessionBusy('Session already has an active root Turn'));
      }
      return { kind: 'await_start', active };
    }

    const residency = acquireResidency();
    const messageIdentity = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId,
    };
    let messageReserved = false;
    try {
      this.messages.reserveRootTurn(messageIdentity);
      messageReserved = true;
      await this.continuity.holdTerminalPublication(
        input.sessionId,
        input.turnId,
        runId,
        admissionLease,
      );
    } catch (error) {
      if (messageReserved) this.messages.abandonRootReservation(messageIdentity);
      residency.release();
      throw error;
    }
    const startSettled = deferred();
    const entry: ActiveRootTurn = {
      turnId: input.turnId,
      runId,
      userMessageId: admission.userMessageId,
      ...(execution ? { execution } : {}),
      startSettled,
      done: Promise.resolve(),
      residency,
      stopRequested: false,
      messageTransitionCommitted: false,
    };
    if (replacing && this.#activeBySession.get(input.sessionId) !== replacing) {
      residency.release();
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up root replacement changed during execution reservation',
      );
    }
    this.#activeBySession.set(input.sessionId, entry);
    entry.done = this.drainTurn(input, entry, startSettled);
    void entry.done.catch(() => undefined);
    return { kind: 'await_start', active: entry };
  }

  private async resolveStartDisposition(
    input: TurnStartInput,
    disposition: TurnStartDisposition,
  ): Promise<TurnStartOutcome> {
    if (disposition.kind === 'complete') return disposition.outcome;
    await disposition.active.startSettled.promise;
    let result = await this.readCanonicalSnapshot(
      input.sessionId,
      input.turnId,
      disposition.active.runId,
    );
    if (isTerminalSnapshot(result)) {
      await disposition.active.done;
      result = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        disposition.active.runId,
      );
    }
    return {
      ok: true,
      result,
    };
  }

  private async drainTurn(
    input: TurnStartInput,
    active: ActiveRootTurn,
    startSettled: Deferred,
  ): Promise<void> {
    let terminalTransitionStarted = false;
    try {
      const stream = active.execution
        ? active.execution.start({
            runId: active.runId,
            userMessageId: active.userMessageId,
            onRunStarted: async () => {
              await this.manager.commitRevisionVersion(input.sessionId);
              await this.continuity.refreshCanonical(input.sessionId);
              startSettled.resolve();
              await active.execution?.onReady?.();
            },
          })
        : this.manager.sendMessage(
            input.sessionId,
            { turnId: input.turnId, ...normalizeMessageContent(input.content) },
            {
              runId: active.runId,
              userMessageId: active.userMessageId ?? undefined,
              durability: 'required',
              onRunStarted: async (startedRunId) => {
                if (startedRunId !== active.runId) {
                  throw new Error('Runtime started a different Run than the admitted identity');
                }
                await this.manager.commitRevisionVersion(input.sessionId);
                await this.continuity.refreshCanonical(input.sessionId);
                startSettled.resolve();
              },
            },
          );
      for await (const event of stream) {
        if (active.execution?.onEvent) {
          try {
            active.execution.onEvent(event);
          } catch {
            // Presentation observers do not participate in execution authority.
          }
        }
        if (isRuntimeSessionTransientEvent(event)) {
          await this.continuity.acceptRuntimeEvent(input.sessionId, active.runId, event);
        } else if (isInteractionAnswerAck(event)) {
          await this.continuity.refreshCanonical(input.sessionId);
        } else if (event.type === 'user_question_request') {
          this.continuity.enqueueCanonicalRefresh(input.sessionId);
        }
      }
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        active.runId,
      );
      await this.assertCompletedExecutionIdentity(input, active);
      if (!isTerminalSnapshot(snapshot)) {
        throw new Error('Runtime Turn drained without a canonical terminal fact');
      }
      if (snapshot.status === 'cancelled' && active.stopRequested) {
        startSettled.resolve();
      }
      terminalTransitionStarted = true;
      await this.completeTerminalTransition(input.sessionId, active);
    } catch (error) {
      let containedRunFailure = false;
      let executionAuditFailure: unknown;
      if (!terminalTransitionStarted) {
        try {
          const snapshot = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            active.runId,
          );
          if (isTerminalSnapshot(snapshot)) {
            try {
              await this.assertCompletedExecutionIdentity(input, active);
            } catch (auditFailure) {
              executionAuditFailure = auditFailure;
            }
            terminalTransitionStarted = true;
            await this.completeTerminalTransition(input.sessionId, active);
            containedRunFailure =
              executionAuditFailure === undefined &&
              startSettled.phase === 'resolved' &&
              ((!active.stopRequested &&
                snapshot.status === 'failed' &&
                isContainableRunFailure(error)) ||
                (active.stopRequested &&
                  snapshot.status === 'cancelled' &&
                  isStoppedInteractionAdmission(error)));
          }
        } catch {
          // Preserve the execution error unless identity audit found a stronger failure.
        }
      }
      if (containedRunFailure) return;
      const commandFailure = executionAuditFailure ?? error;
      startSettled.reject(commandFailure);
      this.requestHostDrain();
      throw commandFailure;
    } finally {
      let releaseRootOwnership = active.messageTransitionCommitted;
      if (!active.messageTransitionCommitted) {
        try {
          this.messages.abandonRootReservation({
            sessionId: input.sessionId,
            turnId: active.turnId,
            runId: active.runId,
          });
          releaseRootOwnership = true;
        } catch {
          this.requestHostDrain();
        }
      }
      if (releaseRootOwnership) {
        if (this.#activeBySession.get(input.sessionId) === active) {
          this.#activeBySession.delete(input.sessionId);
        }
        active.residency.release();
      }
    }
  }

  private completeTerminalTransition(sessionId: string, active: ActiveRootTurn): Promise<void> {
    return this.sessionAdmission.run(sessionId, async (lease) => {
      if (this.#activeBySession.get(sessionId) !== active) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Terminal root Turn no longer owns the Session',
        );
      }
      const identity = {
        sessionId,
        turnId: active.turnId,
        runId: active.runId,
      };
      await this.interactions.assertTerminalFence(identity, lease);
      const batch = this.messages.beginTerminalTransition(identity);
      await this.continuity.publishTerminalProjection(
        sessionId,
        active.turnId,
        active.runId,
        lease,
      );
      if (batch.sources.length === 0) {
        this.messages.completeIdle(batch);
        active.messageTransitionCommitted = true;
        this.#activeBySession.delete(sessionId);
        return;
      }
      await this.startFollowupBatch(batch, active, lease);
    });
  }

  private async startFollowupBatch(
    batch: RootFollowupBatch,
    previous: ActiveRootTurn,
    admissionLease: SessionAdmissionLease,
  ): Promise<void> {
    const initiatingConnectionId = batch.initiatingConnectionId;
    if (!initiatingConnectionId) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up batch lost its initiating Client identity',
      );
    }
    // A confirmed follow-up must become a durable root even when a Session
    // provider is unavailable. Lost tools are omitted while ephemeral
    // capabilities bind to the Client that submitted this follow-up.
    await this.clientCapabilities?.bindConfirmedFollowup(batch.sessionId, initiatingConnectionId);

    const turnId = randomUUID();
    const admitted = await this.rootAdmissionOwner.admitRootTurn({
      sessionId: batch.sessionId,
      turnId,
      proposedRunId: randomUUID(),
      proposedUserMessageId: randomUUID(),
      execution: { kind: 'external_message' },
      normalizedInput: batch.content,
      sourceMessages: batch.sources,
      admittedAt: Date.now(),
    });
    if (admitted.kind !== 'admitted') {
      throw new RuntimeMessageAuthorityInvariantError(
        'Fresh follow-up root Turn identity already existed',
      );
    }

    const nextIdentity = {
      sessionId: batch.sessionId,
      turnId,
      runId: admitted.admission.runId,
    };
    this.messages.commitNextRoot(batch, nextIdentity);
    previous.messageTransitionCommitted = true;
    if (this.#activeBySession.get(batch.sessionId) !== previous) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up transition lost the previous root Turn',
      );
    }
    const disposition = await this.prepareAdmittedTurn(
      {
        sessionId: batch.sessionId,
        turnId,
        content: admitted.admission.normalizedInput,
      },
      admitted.admission,
      this.acquireRecoveryResidency,
      admissionLease,
      previous,
    );
    if (disposition.kind !== 'await_start') {
      throw new RuntimeMessageAuthorityInvariantError(
        'Fresh follow-up root Turn did not reserve execution',
      );
    }
  }

  private async deliverRuntimeStopIntent(
    sessionId: string,
    input: {
      source?: 'stop_button' | 'benchmark_deadline' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = { source: 'stop_button' },
  ): Promise<void> {
    await this.manager.deliverHostedRootStop(sessionId, input);
  }

  private async stopActiveTurn(sessionId: string, active: ActiveRootTurn): Promise<void> {
    const outcome = await this.stopTurn({
      sessionId,
      turnId: active.turnId,
      runId: active.runId,
    });
    if (!outcome.ok) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Unable to stop active root Turn during shutdown: ${outcome.error.code}`,
      );
    }
  }

  private async readCanonicalSnapshot(
    sessionId: string,
    turnId: string,
    runId: string,
    knownRun?: AgentRunHeader,
  ): Promise<TurnSnapshot> {
    const run = knownRun ?? (await this.readRunIfPresent(sessionId, runId));
    if (!run) return { sessionId, turnId, runId, status: 'admitted' };
    if (run.turnId !== turnId) {
      throw new Error('Admitted Turn identity does not match its Run header');
    }

    const [runEvents, runtimeEvents] = await Promise.all([
      this.stores.agentRunStore.readEvents(sessionId, runId),
      this.stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId),
    ]);
    const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
    if (terminal.kind === 'fact') {
      const fact = terminal.fact;
      if (fact.runStatus === 'completed') {
        return {
          sessionId,
          turnId,
          runId,
          status: 'completed',
          terminalEventId: fact.terminalEvent.id,
        };
      }
      if (fact.runStatus === 'failed') {
        if (!fact.failureClass) throw new Error('Failed terminal fact has no failure class');
        return {
          sessionId,
          turnId,
          runId,
          status: 'failed',
          terminalEventId: fact.terminalEvent.id,
          failureClass: fact.failureClass,
        };
      }
      if (!fact.abortSource) throw new Error('Cancelled terminal fact has no abort source');
      return {
        sessionId,
        turnId,
        runId,
        status: 'cancelled',
        terminalEventId: fact.terminalEvent.id,
        abortSource: fact.abortSource,
      };
    }
    if (terminal.kind !== 'none') {
      throw new Error('Runtime ledger does not contain one canonical terminal fact');
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Terminal Run header has no canonical terminal RuntimeEvent');
    }
    if (run.status !== 'created' && !runEvents.some((event) => event.type === 'run_started')) {
      throw new Error('Non-created Run has no durable start fact');
    }
    return { sessionId, turnId, runId, status: run.status };
  }

  private async readRunIfPresent(
    sessionId: string,
    runId: string,
  ): Promise<AgentRunHeader | undefined> {
    try {
      return await this.stores.agentRunStore.readRun(sessionId, runId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async assertCompletedExecutionIdentity(
    input: TurnStartInput,
    active: ActiveRootTurn,
  ): Promise<void> {
    if (!active.execution) return;
    const completedRun = await this.readRunIfPresent(input.sessionId, active.runId);
    if (!completedRun) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Hosted root execution completed without its admitted Run',
      );
    }
    assertRunMatchesExecution(completedRun, input.turnId, active.execution.execution);
  }

  private async runCommand<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof RuntimeHostedRootConflictError) &&
        !(error instanceof HostedRootAdmissionGateError)
      ) {
        this.requestHostDrain();
      }
      throw error;
    }
  }
}

class HostedRootAdmissionGateError extends Error {
  readonly name = 'HostedRootAdmissionGateError';

  constructor(readonly cause: unknown) {
    super('Hosted root execution was rejected before durable admission', {
      cause,
    });
  }
}

type RecoveryUserMessage = Extract<StoredMessage, { type: 'user' }>;

interface RecoveryMessageIndex {
  userMessagesByTurnId: Map<string, RecoveryUserMessage[]>;
  messagesById: Map<string, StoredMessage[]>;
}

function recoveryUserMessage(admission: RootTurnAdmission): RecoveryUserMessage {
  if (!admission.userMessageId) {
    throw new Error(`Admitted Turn ${admission.turnId} does not own a UserMessage`);
  }
  return {
    type: 'user',
    id: admission.userMessageId,
    turnId: admission.turnId,
    ts: admission.admittedAt,
    ...normalizeMessageContent(admission.normalizedInput),
  };
}

function assertRunMatchesAdmission(run: AgentRunHeader, admission: RootTurnAdmission): void {
  assertRunMatchesExecution(run, admission.turnId, admission.execution);
}

function assertRunMatchesExecution(
  run: AgentRunHeader,
  turnId: string,
  execution: RootTurnAdmission['execution'],
): void {
  if (run.turnId !== turnId) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Admitted Turn ${turnId} does not match Run ${run.runId}`,
    );
  }
  switch (execution.kind) {
    case 'external_message':
      return;
    case 'linked_child_initial':
    case 'claimed_agent_graph_intent':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.resumedFromRunId === undefined && run.retriedFromRunId === undefined) return;
      break;
    case 'linked_child_resume':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.resumedFromRunId === execution.sourceRunId && run.retriedFromRunId === undefined) {
        return;
      }
      break;
    case 'linked_child_provider_retry':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.retriedFromRunId === execution.sourceRunId && run.resumedFromRunId === undefined) {
        return;
      }
      break;
    default:
      assertNever(execution);
  }
  throw new RuntimeMessageAuthorityInvariantError(
    `Admitted Turn ${turnId} changed its child execution lineage`,
  );
}

function assertTrustedAgentIdentity(
  run: AgentRunHeader,
  turnId: string,
  execution: Exclude<RootTurnAdmission['execution'], { kind: 'external_message' }>,
): void {
  if (run.agentId !== execution.agentId || run.agentName !== execution.agentName) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Admitted Turn ${turnId} changed its trusted agent identity`,
    );
  }
}

interface RecoveryExecutionContract {
  allowsQueueSources: boolean;
  requiresUserMessage: boolean;
  pendingWithoutRun: 'root_replay' | 'child_recovery_closure';
}

function recoveryExecutionContract(
  execution: RootTurnAdmission['execution'],
): RecoveryExecutionContract {
  switch (execution.kind) {
    case 'external_message':
      return {
        allowsQueueSources: true,
        requiresUserMessage: true,
        pendingWithoutRun: 'root_replay',
      };
    case 'linked_child_initial':
    case 'linked_child_resume':
    case 'claimed_agent_graph_intent':
      return {
        allowsQueueSources: false,
        requiresUserMessage: true,
        pendingWithoutRun: 'child_recovery_closure',
      };
    case 'linked_child_provider_retry':
      return {
        allowsQueueSources: false,
        requiresUserMessage: false,
        pendingWithoutRun: 'child_recovery_closure',
      };
    default:
      return assertNever(execution);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported root execution descriptor: ${JSON.stringify(value)}`);
}

function indexRecoveryMessages(messages: readonly StoredMessage[]): RecoveryMessageIndex {
  const index: RecoveryMessageIndex = {
    userMessagesByTurnId: new Map(),
    messagesById: new Map(),
  };
  for (const message of messages) indexRecoveryMessage(index, message);
  return index;
}

function storedUserMessageContent(message: RecoveryUserMessage): MessageContent {
  return normalizeMessageContent(message);
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

function deferred(): Deferred {
  let phase: Deferred['phase'] = 'pending';
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    get phase() {
      return phase;
    },
    resolve: () => {
      if (phase !== 'pending') return;
      phase = 'resolved';
      resolvePromise();
    },
    reject: (error) => {
      if (phase !== 'pending') return;
      phase = 'rejected';
      rejectPromise(error);
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function unsupportedSessionModeReason(
  header: Pick<SessionHeader, 'collaborationMode' | 'labels'>,
): string | undefined {
  if (header.collaborationMode === 'plan') {
    return 'Plan sessions are not yet supported by Runtime Host.';
  }
  if (isDeepResearchSession(header.labels)) {
    return 'Deep Research sessions are not yet supported by Runtime Host.';
  }
  return undefined;
}

function isTerminalSnapshot(snapshot: TurnSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

function isShutdownCancelledBackendStart(error: unknown): boolean {
  // The Host began draining while a Turn was still starting its backend, so
  // the interaction bind was rejected with authority_draining. The Turn never
  // ran; its drain rejects with this FailStopError and the Host is already
  // shutting down. Treating it as a shutdown failure would fail the whole
  // Host close — it is the expected consequence of stopping mid-start, not a
  // resource that failed to close.
  return (
    error instanceof RuntimeInteractionFailStopError &&
    error.authorityFailure instanceof RuntimeInteractionAdmissionRejectedError &&
    error.authorityFailure.reason === 'authority_draining'
  );
}

function isContainableRunFailure(error: unknown): error is Error {
  return (
    error instanceof Error &&
    !(error instanceof RuntimeOwnerCleanupError) &&
    !(error instanceof RuntimeMessageAuthorityInvariantError) &&
    !(error instanceof RuntimeInteractionInvariantError) &&
    !(error instanceof RuntimeInteractionFailStopError)
  );
}

function isStoppedInteractionAdmission(
  error: unknown,
): error is RuntimeInteractionAdmissionRejectedError {
  return (
    error instanceof RuntimeInteractionAdmissionRejectedError &&
    error.reason === 'run_closed' &&
    error.closureReason === 'turn_stopped'
  );
}

function isRuntimeSessionTransientEvent(
  event: SessionEvent,
): event is RuntimeSessionTransientEvent {
  return (
    event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'tool_start' ||
    event.type === 'tool_output_delta' ||
    event.type === 'tool_progress' ||
    event.type === 'tool_result'
  );
}

function isInteractionAnswerAck(event: SessionEvent): boolean {
  return event.type === 'user_question_answer_ack';
}

function completedStart(outcome: TurnStartOutcome): TurnStartDisposition {
  return { kind: 'complete', outcome };
}

function notFound(message: string) {
  return { ok: false, error: { code: 'not_found', message } } as const;
}

function sessionBusy(message: string) {
  return { ok: false, error: { code: 'session_busy', message } } as const;
}

function sessionArchived(message: string) {
  return { ok: false, error: { code: 'session_archived', message } } as const;
}

function operationUnavailable(message: string) {
  return {
    ok: false,
    error: { code: 'operation_unavailable', message },
  } as const;
}

function operationConflict(message: string) {
  return { ok: false, error: { code: 'operation_conflict', message } } as const;
}
