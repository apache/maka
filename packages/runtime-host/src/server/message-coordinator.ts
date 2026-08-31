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

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SteeringLease } from '@maka/core/backend-types';
import {
  aggregateMessageContents,
  messageContentDigest,
  messageContentsEqual,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { TurnOrchestration } from '@maka/core/runtime-inputs';
import type { SkillInvocationResult } from '@maka/core/skill-invocation';
import {
  RuntimeMessageAuthorityInvariantError,
  type RuntimeMessageAuthority,
  type RuntimeMessageRunIdentity,
  type RuntimeMessageRunOwner,
} from '@maka/runtime/message-authority';
import {
  normalizeRootTurnAdmissionPayload,
  rootTurnAdmissionRecordFits,
  submittedTurnIntentsEqual,
  type ImmutableSteeringMessageProof,
  type MarkMessagesHandedOffInput,
  type MessageAdmissionStore,
  type PendingMessageAdmission,
  type RootTurnSourceMessage,
  type RootTurnSourceMessageReceipt,
  type SubmittedTurnIntent,
} from '@maka/storage/execution-stores';
import type { HostOperationErrorCode, OperationSpec } from '../protocol/operation-spec.js';
import {
  MESSAGE_QUEUE_MAX_ENTRIES,
  MESSAGE_QUEUE_PROJECTION_MAX_BYTES,
  MESSAGE_OPERATION_RESULT_MAX_BYTES,
  MESSAGE_OPERATION_SPECS,
  type MessagePlacement,
  type QueueEntriesReorderInput,
  type QueueEntryPromoteInput,
  type QueueEntryRetractInput,
  type QueueEntryUpdateInput,
  type QueueMutationResult,
  type QueueRetractInput,
  type QueueRetractResult,
  type QueuedMessageSnapshot,
  type RetractedMessageSnapshot,
  type SessionInteractionProjection,
  type SessionMessageQueueProjection,
  type SteeringMessageSnapshot,
  type TurnInterruptInput,
  type TurnInterruptResult,
  type TurnMessageSubmitInput,
  type TurnMessageSubmitResult,
  type TurnSnapshot,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import { worstCaseFailedTurnSnapshot } from './canonical-turn-snapshot.js';
import { worstCaseMessageQueueProjection } from './message-queue-capacity.js';
import type { ConnectionContext, MessageOperationHandlerMap } from './operation-dispatcher.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';

type MessageOperationErrorCode =
  | 'host_draining'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'outcome_unknown';

type MessageOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: MessageOperationErrorCode; readonly message: string };
    };

const EMPTY_SKILL_INVOCATION: SkillInvocationResult = {
  loaded: [],
  failed: [],
  receipts: [],
};

export interface HostMessageSessionHeader {
  readonly isArchived: boolean;
  readonly unavailableReason?: string;
}

export type HostMessageRootState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reserved' }
  | ({ readonly kind: 'active' } & RuntimeMessageRunIdentity);

export interface HostMessageStartInput {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly sourceMessage: RootTurnSourceMessage;
  readonly initiatingConnectionId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly skillIds?: readonly string[];
  /** A durable preparation recovered before root admission committed. */
  readonly preparedSkillInvocation?: SkillInvocationResult;
  readonly turnOrchestration?: TurnOrchestration;
}

/**
 * Starting a Turn from a Message either admits it, reports Skill resolution
 * the client can act on, or fails with an opaque reason.
 */
export type HostMessageStartOutcome =
  | { readonly turnId: string; readonly skillInvocation: SkillInvocationResult }
  | { readonly blocked: SkillInvocationResult }
  | { readonly error: string };

export interface HostMessageRecoveryBatch {
  readonly sessionId: string;
  readonly content: MessageContent;
  readonly submittedContent: MessageContent;
  readonly sources: readonly RootTurnSourceMessage[];
  /** Steering is bound to the exact root identity chosen before it became durable. */
  readonly rootIdentity?: Pick<RuntimeMessageRunIdentity, 'turnId' | 'runId'>;
  /**
   * What the recovered Message asked of its Turn. Only a lone Message can
   * carry one — exact-Turn intent needs an idle Session and opens its own root
   * Turn — and without it the recovered Turn silently runs under the Session
   * default instead of the graph or swarm that was requested.
   */
  readonly submittedIntent?: SubmittedTurnIntent;
}

export interface HostMessagePreparationInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly content: MessageContent;
  readonly placement: MessagePlacement;
}

export type HostMessagePreparationOutcome =
  | {
      readonly kind: 'ready';
      readonly content: MessageContent;
      readonly skillInvocation: SkillInvocationResult;
    }
  | {
      readonly kind: 'rejected';
      readonly error: string;
      readonly skillInvocation?: SkillInvocationResult;
    };

export interface HostMessageStopClaim {
  readonly deliverStop: () => Promise<void>;
  readonly terminal: Promise<TurnSnapshot>;
}

export interface HostMessageStopFence {
  readonly ready: Promise<void>;
  deliverStop(): Promise<void>;
}

/** Root execution operations that must share the message coordinator's Session gate. */
export interface HostMessageRootPort {
  readSessionHeader(sessionId: string): Promise<HostMessageSessionHeader | null>;
  readRootState(sessionId: string): Promise<HostMessageRootState> | HostMessageRootState;
  claimStopFence(
    input: Omit<TurnInterruptInput, 'originHostEpoch' | 'interruptId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
  ): Promise<HostMessageStopFence>;
  startFromMessage(
    input: HostMessageStartInput,
    admission: SessionAdmissionLease,
    commitAdmission: (
      canonicalContent: MessageContent,
      skillInvocation: SkillInvocationResult,
    ) => Promise<void>,
  ): Promise<HostMessageStartOutcome>;
  startRecoveredMessages?(
    input: HostMessageRecoveryBatch,
    admission: SessionAdmissionLease,
  ): Promise<{ readonly turnId: string } | { readonly error: string }>;
  prepareMessage(input: HostMessagePreparationInput): Promise<HostMessagePreparationOutcome>;
  claimStop(
    input: Omit<TurnInterruptInput, 'originHostEpoch' | 'interruptId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
  ): Promise<HostMessageStopClaim>;
}

/** Existing durable facts used only to prove an earlier Host Epoch's submit disposition. */
export interface HostMessageDurableProofReader {
  readRootTurnSourceMessageReceipt(
    sessionId: string,
    messageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined>;
  readImmutableSteeringMessageProof(
    sessionId: string,
    messageId: string,
  ): Promise<ImmutableSteeringMessageProof | undefined>;
}

export interface HostMessageCoordinatorOptions {
  readonly hostEpoch: string;
  readonly root: HostMessageRootPort;
  readonly durableProof: HostMessageDurableProofReader;
  readonly admissions: MessageAdmissionStore;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly requestDrain?: () => void;
  readonly preflightSessionSnapshot: CandidateSnapshotPreflight;
  readonly onProjectionChanged?: (sessionId: string) => void;
  readonly createId?: () => string;
}

export type CandidateSnapshotPreflight = (
  sessionId: string,
  candidate: {
    readonly queue?: SessionMessageQueueProjection;
    readonly interactions?: SessionInteractionProjection;
  },
) => Promise<boolean> | boolean;

interface LiveEntry {
  readonly entryId: string;
  readonly messageId: string;
  readonly admissionTurnId: string;
  readonly admissionRunId: string;
  readonly admittedAt: number;
  content: MessageContent;
  modelContent: MessageContent;
  submittedContentDigest: `sha256:${string}`;
  readonly submittedPlacement: MessagePlacement;
  skillInvocation: SkillInvocationResult;
  readonly placement: MessagePlacement;
  readonly disposition: 'steering' | 'followup';
  generation: number;
  readonly residency: RuntimeHostResidency;
  state: 'queued' | 'in_flight' | 'released';
  leaseId?: string;
}

interface BoundRun extends RuntimeMessageRunIdentity {
  readonly generation: number;
  released: boolean;
}

interface PendingInterrupt {
  readonly payload: TurnInterruptInput;
  readonly result: Promise<MessageOutcome<TurnInterruptResult>>;
}

interface PendingSubmit {
  readonly payload: CanonicalSubmitPayload;
  readonly result: Promise<MessageOutcome<TurnMessageSubmitResult>>;
}

type QueuedMutationKind = 'retract' | 'retract_entry' | 'promote' | 'update_entry' | 'reorder';

type MessageOperationKind = QueuedMutationKind | 'submit' | 'interrupt';

interface PendingQueuedMutation {
  readonly payload: object;
  readonly result: Promise<MessageOutcome<unknown>>;
}

interface CompletedOperation {
  readonly payload: object;
  readonly result: object;
}

interface QueuedMutationOptions<
  I extends { readonly originHostEpoch: string; readonly sessionId: string },
  R,
> {
  readonly spec: OperationSpec<I, R, HostOperationErrorCode>;
  readonly operationKind: QueuedMutationKind;
  readonly operationId: string;
  readonly verb: string;
  readonly input: I;
  readonly execute: () => Promise<MessageOutcome<R>>;
}

interface InterruptDeferred {
  readonly promise: Promise<MessageOutcome<TurnInterruptResult>>;
  resolve(result: MessageOutcome<TurnInterruptResult>): void;
  reject(error: unknown): void;
}

interface TerminalTransition {
  readonly transitionId: string;
  readonly identity: RuntimeMessageRunIdentity;
  readonly entries: readonly LiveEntry[];
}

interface SessionState {
  readonly sessionId: string;
  revision: number;
  generation: number;
  phase: 'open' | 'closed';
  steering: LiveEntry[];
  inFlight: Map<string, LiveEntry>;
  followup: LiveEntry[];
  reservedRoot?: RuntimeMessageRunIdentity;
  run?: BoundRun;
  transition?: TerminalTransition;
  stopFence?: {
    readonly identity: RuntimeMessageRunIdentity;
    readonly result: QueueFenceResult;
  };
  pendingInterrupts: Map<string, PendingInterrupt>;
}

export type RootFollowupSource = RootTurnSourceMessage & {
  readonly disposition: 'steering' | 'followup';
};

export interface RootFollowupBatch {
  readonly transitionId: string;
  readonly sessionId: string;
  readonly previousTurnId: string;
  readonly content: MessageContent;
  readonly submittedContent: MessageContent;
  readonly sources: readonly RootFollowupSource[];
}

export interface QueueFenceResult {
  readonly queueRevision: number;
  readonly retracted: readonly RetractedMessageSnapshot[];
}

/**
 * How many times a submit re-runs admission after its preflight snapshot went
 * stale. Steering consumption (pull/ack/nack) happens outside the admission
 * lock, so the queue can change while a submit awaits its preflight; the
 * change is transient and a fresh pass succeeds. The cap bounds how long a
 * contended submit waits before reporting session_busy.
 */
const SUBMIT_ADMISSION_RETRY_LIMIT = 4;
const HOST_EPOCH_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** The sole in-memory message authority for one Runtime Host Epoch. */
export class HostMessageCoordinator implements RuntimeMessageAuthority {
  readonly handlers: MessageOperationHandlerMap = {
    'turn.message.query': (input) => this.queryMessages(input),
    'turn.message.execution.query': (input) => this.queryMessageExecutions(input),
    'turn.message.submit': (input, context) => this.submit(input, context),
    'queue.retract': (input) => this.retract(input),
    'queue.entry.retract': (input) => this.retractQueuedEntry(input),
    'queue.entry.promote': (input) => this.promoteQueuedEntry(input),
    'queue.entry.update': (input) => this.updateQueuedEntry(input),
    'queue.entries.reorder': (input) => this.reorderQueuedEntries(input),
    'turn.interrupt': (input) => this.interrupt(input),
  };

  readonly #hostEpoch: string;
  readonly #root: HostMessageRootPort;
  readonly #durableProof: HostMessageDurableProofReader;
  readonly #admissions: MessageAdmissionStore;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #requestDrain: () => void;
  readonly #onProjectionChanged: (sessionId: string) => void;
  readonly #createId: () => string;
  readonly #preflightSessionSnapshot: CandidateSnapshotPreflight;
  readonly #sessions = new Map<string, SessionState>();
  readonly #pendingSubmits = new Map<string, PendingSubmit>();
  readonly #pendingQueuedMutations = new Map<string, PendingQueuedMutation>();
  readonly #completedOperations = new Map<string, CompletedOperation>();
  #draining = false;
  #failStopped = false;

  constructor(options: HostMessageCoordinatorOptions) {
    if (!HOST_EPOCH_PATTERN.test(options.hostEpoch)) {
      throw new RuntimeMessageAuthorityInvariantError('Invalid Host Epoch identity');
    }
    this.#hostEpoch = options.hostEpoch;
    this.#root = options.root;
    this.#durableProof = options.durableProof;
    this.#admissions = options.admissions;
    this.#sessionAdmission = options.sessionAdmission;
    this.#acquireResidency = options.acquireResidency;
    this.#requestDrain = options.requestDrain ?? (() => undefined);
    this.#onProjectionChanged = options.onProjectionChanged ?? (() => undefined);
    this.#createId = options.createId ?? randomUUID;
    this.#preflightSessionSnapshot = options.preflightSessionSnapshot;
  }

  projection(sessionId: string): SessionMessageQueueProjection {
    const state = this.#sessions.get(sessionId);
    if (!state) {
      return { hostEpoch: this.#hostEpoch, queueRevision: 0, steering: [], followup: [] };
    }
    return this.#project(state);
  }

  hasLiveSessionState(sessionId: string): boolean {
    const state = this.#sessions.get(sessionId);
    return state ? hasLiveMessageState(state) : false;
  }

  /**
   * Durable cancellation proof for client-held transient identities. Absence of
   * a tombstone is never delivery or cancellation proof, so only cancelled
   * identities are reported and the client keeps every other row.
   */
  async queryMessages(input: {
    sessionId: string;
    messageIds: readonly string[];
  }): Promise<MessageOutcome<{ cancelledMessageIds: string[] }>> {
    const cancelledMessageIds: string[] = [];
    for (const messageId of input.messageIds) {
      if (await this.#admissions.hasCancelledMessageAdmission(input.sessionId, messageId)) {
        cancelledMessageIds.push(messageId);
      }
    }
    return success({ cancelledMessageIds });
  }

  async queryMessageExecutions(input: {
    sessionId: string;
    messageIds: readonly string[];
  }): Promise<
    MessageOutcome<{
      resolutions: Array<
        | { messageId: string; state: 'pending' }
        | { messageId: string; state: 'cancelled' }
        | { messageId: string; state: 'owned'; turnId: string; runId: string }
      >;
    }>
  > {
    const resolutions: Array<
      | { messageId: string; state: 'pending' }
      | { messageId: string; state: 'cancelled' }
      | { messageId: string; state: 'owned'; turnId: string; runId: string }
    > = [];
    for (const messageId of input.messageIds) {
      const receipt = await this.#durableProof.readRootTurnSourceMessageReceipt(
        input.sessionId,
        messageId,
      );
      if (
        receipt?.admission.sessionId === input.sessionId &&
        receipt.sourceMessage.messageId === messageId
      ) {
        // A root source receipt is the latest durable ownership proof and
        // therefore outranks the steering location from which a Message may
        // have been folded into this successor.
        resolutions.push({
          messageId,
          state: 'owned',
          turnId: receipt.admission.turnId,
          runId: receipt.admission.runId,
        });
        continue;
      }
      const steering = await this.#durableProof.readImmutableSteeringMessageProof(
        input.sessionId,
        messageId,
      );
      if (
        steering?.event.sessionId === input.sessionId &&
        steering.event.refs?.providerEventId === messageId
      ) {
        resolutions.push({
          messageId,
          state: 'owned',
          turnId: steering.event.turnId,
          runId: steering.event.runId,
        });
        continue;
      }
      if (await this.#admissions.hasCancelledMessageAdmission(input.sessionId, messageId)) {
        resolutions.push({ messageId, state: 'cancelled' });
        continue;
      }
      const pending = await this.#admissions.readMessageAdmission(input.sessionId, messageId);
      if (pending?.sessionId === input.sessionId && pending.messageId === messageId) {
        resolutions.push({ messageId, state: 'pending' });
      }
    }
    return success({ resolutions });
  }

  retireSessions(sessionIds: readonly string[]): void {
    for (const sessionId of new Set(sessionIds)) {
      const state = this.#sessions.get(sessionId);
      if (state && hasLiveMessageState(state)) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Cannot retire a Session with live Message state',
        );
      }
      this.#sessions.delete(sessionId);
    }
  }

  bindRun(identity: RuntimeMessageRunIdentity): RuntimeMessageRunOwner {
    const state = this.#state(identity.sessionId);
    const exactPreStartStop =
      state.stopFence !== undefined && sameRun(state.stopFence.identity, identity);
    if (state.phase !== 'open' && !exactPreStartStop) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Message Run bound while admission was closed',
      );
    }
    if (!state.reservedRoot || !sameRun(state.reservedRoot, identity) || state.run) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Message Run ${identity.runId} was not the exact reserved root identity`,
      );
    }
    const run: BoundRun = { ...identity, generation: state.generation, released: false };
    state.run = run;
    return Object.freeze({
      ...identity,
      pull: () => this.#pull(run),
      ack: (leaseIds: readonly string[]) => this.#ack(run, leaseIds),
      nack: (leaseIds: readonly string[]) => this.#nack(run, leaseIds),
      release: () => this.#releaseRun(run),
    });
  }

  reserveRootTurn(identity: RuntimeMessageRunIdentity): void {
    const state = this.#state(identity.sessionId);
    if (state.reservedRoot) {
      if (sameRun(state.reservedRoot, identity)) return;
      throw new RuntimeMessageAuthorityInvariantError('Session already reserved another root Turn');
    }
    if (state.run || state.transition) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Cannot reserve a root Turn during live ownership',
      );
    }
    state.reservedRoot = { ...identity };
    state.phase = 'open';
  }

  abandonRootReservation(identity: RuntimeMessageRunIdentity): void {
    const state = this.#requireState(identity.sessionId);
    if (!state.reservedRoot || !sameRun(state.reservedRoot, identity) || state.run) {
      throw new RuntimeMessageAuthorityInvariantError('Root reservation cannot be abandoned');
    }
    if (state.transition || allLiveEntries(state).length !== 0) {
      this.#failStop();
      throw new RuntimeMessageAuthorityInvariantError(
        'Root reservation with confirmed Message effects cannot be abandoned',
      );
    }
    state.reservedRoot = undefined;
    state.stopFence = undefined;
    state.phase = 'closed';
    this.#maybeReclaim(identity.sessionId, state);
  }

  beginTerminalTransition(identity: RuntimeMessageRunIdentity): RootFollowupBatch {
    const state = this.#requireState(identity.sessionId);
    const run = state.run;
    if (
      !state.reservedRoot ||
      !sameRun(state.reservedRoot, identity) ||
      !run ||
      !sameRun(run, identity) ||
      !run.released
    ) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Terminal transition requires a released exact root owner',
      );
    }
    if (state.inFlight.size !== 0 || state.transition) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Terminal transition began before in-flight steering settled',
      );
    }
    if (state.phase !== 'open' && !state.stopFence) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Terminal transition found closed admission without a stop fence',
      );
    }
    if (this.#draining && !state.stopFence) {
      this.#commitQueueFence(identity);
    }
    state.phase = 'closed';
    const folded = state.steering.splice(0);
    for (const entry of folded) entry.state = 'queued';
    if (folded.length > 0) {
      state.followup.unshift(...folded);
      this.#mutated(state);
    }
    state.run = undefined;
    const entries = nextSuccessorItems(state.followup);
    const followup = canonicalFollowupBatch(entries);
    const transition: TerminalTransition = {
      transitionId: this.#createId(),
      identity: { ...identity },
      entries,
    };
    state.transition = transition;
    return {
      transitionId: transition.transitionId,
      sessionId: identity.sessionId,
      previousTurnId: identity.turnId,
      content: followup.content,
      submittedContent: followup.submittedContent,
      sources: followup.sources,
    };
  }

  commitNextRoot(batch: RootFollowupBatch, identity: RuntimeMessageRunIdentity): void {
    const state = this.#requireTransition(batch);
    if (identity.sessionId !== batch.sessionId) {
      throw new RuntimeMessageAuthorityInvariantError('Next root identity changed Session');
    }
    this.#commitTransition(state);
    state.generation += 1;
    for (const entry of allLiveEntries(state)) entry.generation = state.generation;
    state.reservedRoot = { ...identity };
    state.phase = 'open';
    this.#mutated(state);
  }

  completeIdle(batch: RootFollowupBatch): void {
    const state = this.#requireTransition(batch);
    if (batch.sources.length !== 0) {
      throw new RuntimeMessageAuthorityInvariantError('Cannot become idle with a follow-up batch');
    }
    this.#commitTransition(state);
    state.generation += 1;
    state.reservedRoot = undefined;
    state.phase = 'open';
    this.#mutated(state);
    this.#maybeReclaim(batch.sessionId, state);
  }

  beginDrain(): void {
    this.#draining = true;
  }

  /**
   * Commit the root-admission proof before Runtime activation. The in-memory
   * queue never owns this transition: it only projects the durable result.
   */
  async handoffRootSources(input: {
    sessionId: string;
    turnId: string;
    runId: string;
    messageIds: readonly string[];
  }): Promise<void> {
    const handoff: string[] = [];
    const provenRootMessages: Array<
      NonNullable<MarkMessagesHandedOffInput['provenRootMessages']>[number]
    > = [];
    for (const messageId of new Set(input.messageIds)) {
      handoff.push(messageId);
      provenRootMessages.push(await this.#readProvenRootMessage(input, messageId));
    }
    await this.#admissions.markMessagesHandedOff({
      sessionId: input.sessionId,
      messageIds: handoff,
      turnId: input.turnId,
      ...(provenRootMessages.length > 0 ? { provenRootMessages } : {}),
    });
  }

  /** Materialize proof-owned transcript history in both normal and recovery paths. */
  async materializeMessageHandoffsForRun(input: {
    sessionId: string;
    turnId: string;
    runId: string;
    messageIds: readonly string[];
  }): Promise<void> {
    const messageIds = new Set<string>();
    const provenRootMessages: Array<
      NonNullable<MarkMessagesHandedOffInput['provenRootMessages']>[number]
    > = [];
    const provenSteeringMessages: Array<
      NonNullable<MarkMessagesHandedOffInput['provenSteeringMessages']>[number]
    > = [];
    const admissions = await this.#admissions.listMessageAdmissions(input.sessionId);
    for (const messageId of new Set(input.messageIds)) {
      messageIds.add(messageId);
      provenRootMessages.push(await this.#readProvenRootMessage(input, messageId));
    }
    for (const admission of admissions) {
      if (admission.disposition !== 'steering') {
        continue;
      }
      const proof = await this.#durableProof.readImmutableSteeringMessageProof(
        input.sessionId,
        admission.messageId,
      );
      if (proof?.event.turnId === input.turnId && proof.event.runId === input.runId) {
        messageIds.add(admission.messageId);
        provenSteeringMessages.push({
          messageId: admission.messageId,
          admissionTurnId: admission.turnId,
          admissionRunId: admission.runId,
          executionTurnId: proof.event.turnId,
          eventId: proof.event.id,
          eventTs: proof.event.ts,
          content: admission.content,
          admittedAt: admission.admittedAt,
        });
      }
    }
    await this.#admissions.markMessagesHandedOff({
      sessionId: input.sessionId,
      messageIds: [...messageIds],
      turnId: input.turnId,
      ...(provenRootMessages.length > 0 ? { provenRootMessages } : {}),
      ...(provenSteeringMessages.length > 0 ? { provenSteeringMessages } : {}),
    });
  }

  async #readProvenRootMessage(
    input: { readonly sessionId: string; readonly turnId: string; readonly runId: string },
    messageId: string,
  ): Promise<NonNullable<MarkMessagesHandedOffInput['provenRootMessages']>[number]> {
    const proof = await this.#durableProof.readRootTurnSourceMessageReceipt(
      input.sessionId,
      messageId,
    );
    if (
      !proof ||
      proof.admission.sessionId !== input.sessionId ||
      proof.admission.turnId !== input.turnId ||
      proof.admission.runId !== input.runId ||
      proof.sourceMessage.messageId !== messageId
    ) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Root admission does not prove Message handoff ${messageId}`,
      );
    }
    return {
      messageId,
      content: proof.sourceMessage.content,
      admittedAt: proof.admission.admittedAt,
    };
  }

  async cancelMessages(sessionId: string, messageIds: readonly string[]): Promise<void> {
    await this.#admissions.cancelMessageAdmissions(sessionId, messageIds);
  }

  async recoverPendingAfterHostRestart(sessionIds: readonly string[]): Promise<void> {
    await this.consumePendingAdmissions(sessionIds);
  }

  /** Consume canonical pending admissions without creating a second admission. */
  async consumePendingAdmissions(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of new Set(sessionIds)) {
      await this.#sessionAdmission.run(sessionId, (admission) =>
        this.#consumePendingAdmissions(sessionId, admission),
      );
    }
  }

  /** Consume pending admissions while the caller still owns this Session's admission lease. */
  consumePendingAdmissionsAdmitted(
    sessionId: string,
    admission: SessionAdmissionLease,
  ): Promise<void> {
    return this.#sessionAdmission.runAdmitted(sessionId, admission, () =>
      this.#consumePendingAdmissions(sessionId, admission),
    );
  }

  async #consumePendingAdmissions(
    sessionId: string,
    admissionLease: SessionAdmissionLease,
  ): Promise<void> {
    const admissions = await this.#admissions.listMessageAdmissions(sessionId);
    if (admissions.length === 0) return;
    const pending = [] as PendingMessageAdmission[];
    for (const admission of admissions) {
      const source = await this.#durableProof.readRootTurnSourceMessageReceipt(
        sessionId,
        admission.messageId,
      );
      if (
        source?.admission.turnId === admission.turnId &&
        source.admission.runId === admission.runId &&
        source.sourceMessage.messageId === admission.messageId
      ) {
        await this.materializeMessageHandoffsForRun({
          sessionId,
          turnId: source.admission.turnId,
          runId: source.admission.runId,
          messageIds: [admission.messageId],
        });
      } else {
        const steering = await this.#durableProof.readImmutableSteeringMessageProof(
          sessionId,
          admission.messageId,
        );
        if (steering) {
          await this.materializeMessageHandoffsForRun({
            sessionId,
            turnId: steering.event.turnId,
            runId: steering.event.runId,
            messageIds: [],
          });
        } else {
          pending.push(admission);
        }
      }
    }
    if (pending.length === 0) return;
    const rootState = await this.#root.readRootState(sessionId);
    if (rootState.kind !== 'active') {
      if (rootState.kind !== 'idle') return;
      if (!this.#root.startRecoveredMessages) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Message recovery authority is unavailable',
        );
      }
      const recoveryBatch = nextRecoveredSuccessorItems(pending);
      const started = await this.#root.startRecoveredMessages(
        {
          sessionId,
          content: aggregateMessageContents(recoveryBatch.map((entry) => entry.content)),
          submittedContent: aggregateMessageContents(recoveryBatch.map((entry) => entry.content)),
          sources: recoveryBatch.map(pendingMessageSource),
          ...pendingSteeringRootIdentity(recoveryBatch),
          ...(recoveryBatch.length === 1 && recoveryBatch[0]!.submittedIntent
            ? { submittedIntent: recoveryBatch[0]!.submittedIntent }
            : {}),
        },
        admissionLease,
      );
      if ('error' in started) {
        throw new RuntimeMessageAuthorityInvariantError(
          `Durable Message recovery failed: ${started.error}`,
        );
      }
      const recoveredMessageIds = new Set(recoveryBatch.map((entry) => entry.messageId));
      const remaining = pending.filter((entry) => !recoveredMessageIds.has(entry.messageId));
      if (remaining.length > 0) {
        const active = await this.#root.readRootState(sessionId);
        if (active.kind !== 'active') {
          throw new RuntimeMessageAuthorityInvariantError(
            'Recovered successor did not become the active root Turn',
          );
        }
        this.#restorePendingAdmissions(sessionId, active, remaining);
      }
      return;
    }
    this.#restorePendingAdmissions(sessionId, rootState, pending);
  }

  #restorePendingAdmissions(
    sessionId: string,
    rootState: RuntimeMessageRunIdentity & { readonly kind: 'active' },
    pending: readonly PendingMessageAdmission[],
  ): void {
    if (!this.#sessions.has(sessionId)) this.#state(sessionId);
    const state = this.#requireState(sessionId);
    if (!state.reservedRoot) this.reserveRootTurn(rootState);
    if (!sameRun(state.reservedRoot!, rootState)) return;
    for (const admission of pending) {
      const existing = allLiveEntries(state).find(
        (entry) => entry.messageId === admission.messageId,
      );
      if (existing) continue;
      const residency = this.#acquireResidency();
      const entry: LiveEntry = {
        entryId: this.#createId(),
        messageId: admission.messageId,
        admissionTurnId: admission.turnId,
        admissionRunId: admission.runId,
        admittedAt: admission.admittedAt,
        content: submittedProjectionContent(admission.content),
        modelContent: admission.content,
        submittedContentDigest: admission.submittedContentDigest,
        submittedPlacement: admission.submittedPlacement,
        skillInvocation: admission.skillInvocation,
        placement: admission.placement,
        disposition: admission.disposition,
        generation: state.generation,
        residency,
        state: 'queued',
      };
      if (entry.disposition === 'steering') state.steering.push(entry);
      else state.followup.push(entry);
      this.#mutated(state);
    }
  }

  commitStopFence(identity: RuntimeMessageRunIdentity): QueueFenceResult {
    return this.#commitQueueFence(identity);
  }

  async close(): Promise<void> {
    this.beginDrain();
    for (const state of this.#sessions.values()) {
      if (
        state.run ||
        state.reservedRoot ||
        state.transition ||
        allLiveEntries(state).length !== 0
      ) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Message coordinator closed with a live owner, entry, or transition',
        );
      }
    }
    this.#sessions.clear();
  }

  private submit(
    input: TurnMessageSubmitInput,
    context: ConnectionContext,
    admission?: SessionAdmissionLease,
  ): Promise<MessageOutcome<TurnMessageSubmitResult>> {
    const payload = canonicalSubmitPayload(input);
    const isCurrentEpoch = input.originHostEpoch === this.#hostEpoch;
    if (isCurrentEpoch) {
      const pending = this.#pendingSubmits.get(operationKey(input.sessionId, input.messageId));
      if (pending) {
        return samePayload(pending.payload, payload)
          ? pending.result
          : Promise.resolve(
              failure('operation_conflict', 'Message identity has a different payload'),
            );
      }
    }
    if (this.#failStopped) {
      return Promise.resolve(failure('host_draining', 'Runtime Host message authority has failed'));
    }
    if (!isCurrentEpoch) {
      return this.#submitAdmitted(input, payload, context.connectionId, admission);
    }
    const key = operationKey(input.sessionId, input.messageId);
    const result = this.#submitAdmitted(input, payload, context.connectionId, admission);
    this.#pendingSubmits.set(key, { payload, result });
    void result.then(
      () => this.#deletePendingSubmit(key, result),
      () => this.#deletePendingSubmit(key, result),
    );
    return result;
  }

  #submitAdmitted(
    input: TurnMessageSubmitInput,
    payload: CanonicalSubmitPayload,
    initiatingConnectionId: string,
    admittedLease?: SessionAdmissionLease,
  ): Promise<MessageOutcome<TurnMessageSubmitResult>> {
    const execute = async (
      admission: SessionAdmissionLease,
    ): Promise<MessageOutcome<TurnMessageSubmitResult>> => {
      if (this.#failStopped) {
        return failure('host_draining', 'Runtime Host message authority has failed');
      }
      const isCurrentEpoch = input.originHostEpoch === this.#hostEpoch;
      if (isCurrentEpoch) {
        const receipt = await this.#readCompletedSubmit(input.sessionId, input.messageId);
        if (receipt) {
          return samePayload(receipt.payload, payload)
            ? success(receipt.result)
            : failure('operation_conflict', 'Message identity has a different payload');
        }
      }
      const durableProof = await this.#queryDurableSubmitProof(input, payload);
      if (this.#failStopped) {
        return failure('host_draining', 'Runtime Host message authority has failed');
      }
      if (durableProof) return durableProof;
      if (!isCurrentEpoch) {
        return failure(
          'outcome_unknown',
          'Message disposition cannot be proven in this Host Epoch',
        );
      }
      if (this.#draining) {
        return failure('host_draining', 'Runtime Host is draining');
      }
      // A Turn consumes steering out of the queue outside the admission lock
      // (#pull/#ack/#nack), so a submit's preflight snapshot can go stale while
      // it awaits. That is transient: re-read the queue and re-run admission
      // instead of surfacing a spurious session_busy to the client.
      let preparedForRoot:
        | {
            readonly identity: RuntimeMessageRunIdentity;
            readonly outcome: HostMessagePreparationOutcome;
          }
        | undefined;
      for (let attempt = 0; ; attempt++) {
        const header = await this.#root.readSessionHeader(input.sessionId);
        if (this.#failStopped) {
          return failure('host_draining', 'Runtime Host message authority has failed');
        }
        if (!header) return failure('not_found', 'Session does not exist');
        if (header.isArchived) return failure('session_archived', 'Session is archived');
        if (header.unavailableReason) {
          return failure('operation_unavailable', header.unavailableReason);
        }
        const rootState = await this.#root.readRootState(input.sessionId);
        if (this.#failStopped) {
          return failure('host_draining', 'Runtime Host message authority has failed');
        }
        if (rootState.kind === 'idle') {
          const existingState = this.#sessions.get(input.sessionId);
          if (existingState && hasLiveMessageState(existingState)) {
            throw new RuntimeMessageAuthorityInvariantError(
              'Root reported idle while the message authority retained live state',
            );
          }
          const intent = submittedTurnIntent(payload);
          const sourceMessage: RootTurnSourceMessage = {
            messageId: input.messageId,
            content: payload.content,
            submittedContentDigest: messageContentDigest(payload.content),
            submittedPlacement: input.placement,
            ...(intent ? { submittedIntent: intent } : {}),
            placement: input.placement,
            disposition: 'turn_started',
          };
          const pendingAdmission = await this.#admissions.readMessageAdmission(
            input.sessionId,
            input.messageId,
          );
          if (
            pendingAdmission &&
            (pendingAdmission.submittedContentDigest !== messageContentDigest(payload.content) ||
              pendingAdmission.submittedPlacement !== input.placement ||
              !submittedTurnIntentsEqual(pendingAdmission.submittedIntent, intent))
          ) {
            return failure('operation_conflict', 'Message admission has a different payload');
          }
          const turnId = pendingAdmission?.turnId ?? this.#createId();
          const runId = pendingAdmission?.runId ?? this.#createId();
          const started = await this.#root.startFromMessage(
            {
              sessionId: input.sessionId,
              content: pendingAdmission?.content ?? payload.content,
              sourceMessage,
              initiatingConnectionId,
              turnId,
              runId,
              ...(pendingAdmission
                ? { preparedSkillInvocation: pendingAdmission.skillInvocation }
                : payload.skillIds.length > 0
                  ? { skillIds: payload.skillIds }
                  : {}),
              ...(payload.turnOrchestration
                ? { turnOrchestration: payload.turnOrchestration }
                : {}),
            },
            admission,
            async (canonicalContent, skillInvocation) => {
              await this.#admissions.commitMessageAdmission({
                sessionId: input.sessionId,
                turnId,
                runId,
                messageId: input.messageId,
                content: canonicalContent,
                submittedContentDigest: messageContentDigest(payload.content),
                submittedPlacement: input.placement,
                placement: 'current_turn',
                disposition: 'steering',
                ...(intent ? { submittedIntent: intent } : {}),
                skillInvocation,
                admittedAt: pendingAdmission?.admittedAt ?? Date.now(),
              });
            },
          );
          if ('error' in started) {
            return failure('operation_conflict', started.error);
          }
          // A blocked Skill invocation admitted nothing: it is not remembered as
          // a completed submit, so the same identity can be submitted again once
          // the Skill resolves.
          if ('blocked' in started) {
            return success({
              disposition: 'blocked',
              skillInvocation: started.blocked,
            } as const);
          }
          if (!isEntityId(started.turnId)) {
            throw new RuntimeMessageAuthorityInvariantError(
              'Started Turn identity is not encodable',
            );
          }
          const result = {
            disposition: 'turn_started',
            turnId: started.turnId,
            skillInvocation: started.skillInvocation ?? EMPTY_SKILL_INVOCATION,
          } as const;
          return success(result);
        }
        if (requiresExactTurn(payload)) {
          return failure(
            'session_busy',
            'An explicit Skill or orchestrated Message needs an idle Session',
          );
        }
        if (rootState.kind === 'reserved') {
          return failure('session_busy', 'A Goal continuation is reserving the next root Turn');
        }
        const state = this.#requireState(input.sessionId);
        if (state.phase !== 'open') {
          return failure('session_busy', 'Message admission is closed for the active generation');
        }
        if (!state.reservedRoot || !sameRun(state.reservedRoot, rootState)) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Root state does not match message reservation',
          );
        }
        const existingEntry = allLiveEntries(state).find(
          (entry) => entry.messageId === input.messageId,
        );
        if (existingEntry) {
          const existingAdmission = await this.#admissions.readMessageAdmission(
            input.sessionId,
            input.messageId,
          );
          if (
            !existingAdmission ||
            existingAdmission.submittedContentDigest !== messageContentDigest(payload.content) ||
            existingAdmission.submittedPlacement !== input.placement
          ) {
            return failure('operation_conflict', 'Message admission has a different payload');
          }
          const result = {
            disposition: existingEntry.disposition,
            queueRevision: state.revision,
            skillInvocation: existingEntry.skillInvocation,
          } as const;
          this.#rememberCompletedOperation(
            'submit',
            input.sessionId,
            input.messageId,
            payload,
            result,
          );
          return success(result);
        }
        const disposition = input.placement === 'current_turn' ? 'steering' : 'followup';
        const prepared =
          preparedForRoot && sameRun(preparedForRoot.identity, rootState)
            ? preparedForRoot.outcome
            : await this.#root.prepareMessage({
                sessionId: input.sessionId,
                turnId: rootState.turnId,
                content: payload.content,
                placement: input.placement,
              });
        preparedForRoot = { identity: rootState, outcome: prepared };
        if (prepared.kind === 'rejected') {
          if (prepared.skillInvocation) {
            return success({
              disposition: 'blocked',
              skillInvocation: prepared.skillInvocation,
            } as const);
          }
          return failure('operation_conflict', prepared.error);
        }
        if (allLiveEntries(state).length >= MESSAGE_QUEUE_MAX_ENTRIES) {
          return failure('session_busy', 'Message queue capacity is full');
        }
        const candidateRevision = state.revision;
        const candidateGeneration = state.generation;
        const entryId = this.#createId();
        if (!isEntityId(entryId)) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Message entry identity is not encodable',
          );
        }
        const candidateEntry: QueuedMessageSnapshot = {
          entryId,
          messageId: input.messageId,
          content: payload.content,
          placement: input.placement,
          state: 'queued',
        };
        const current = this.#project(state);
        const candidate: SessionMessageQueueProjection = {
          ...current,
          queueRevision: state.revision + 1,
          steering:
            disposition === 'steering'
              ? [
                  ...[...state.inFlight.values()].map(inFlightSnapshot),
                  ...state.steering.map(queuedSteeringSnapshot),
                  { ...candidateEntry, placement: 'current_turn' },
                ]
              : current.steering,
          followup:
            disposition === 'followup' ? [...current.followup, candidateEntry] : current.followup,
        };
        if (!projectionFitsEveryEntryState(candidate)) {
          return failure('session_busy', 'Message queue projection capacity is full');
        }
        if (!(await this.#preflightSessionSnapshot(input.sessionId, { queue: candidate }))) {
          return failure('session_busy', 'Session projection capacity is full');
        }
        if (!interruptResultFits(candidate, rootState)) {
          return failure('session_busy', 'Message queue interrupt result capacity is full');
        }
        const candidateSource = {
          messageId: input.messageId,
          content: prepared.content,
          submittedContentDigest: messageContentDigest(payload.content),
          submittedPlacement: input.placement,
          skillInvocation: prepared.skillInvocation,
          placement: input.placement,
          disposition,
        } satisfies RootTurnSourceMessage;
        const prospectiveSteering = [...state.inFlight.values(), ...state.steering].map(
          sourceFromEntry,
        );
        const prospectiveFollowup = state.followup.map(sourceFromEntry);
        if (disposition === 'steering') prospectiveSteering.push(candidateSource);
        else prospectiveFollowup.push(candidateSource);
        if (
          !successorAdmissionsFit(
            input.sessionId,
            rootState.turnId,
            prospectiveSteering,
            prospectiveFollowup,
          )
        ) {
          return failure('session_busy', 'Message queue cannot form a durable follow-up Turn');
        }
        if (
          state.phase !== 'open' ||
          state.revision !== candidateRevision ||
          state.generation !== candidateGeneration ||
          !state.reservedRoot ||
          !sameRun(state.reservedRoot, rootState)
        ) {
          if (attempt >= SUBMIT_ADMISSION_RETRY_LIMIT) {
            return failure('session_busy', 'Message queue changed during admission');
          }
          continue;
        }
        const result = {
          disposition,
          queueRevision: candidateRevision + 1,
          skillInvocation: prepared.skillInvocation,
        } as const;
        const messageAdmission: PendingMessageAdmission = {
          sessionId: input.sessionId,
          turnId: rootState.turnId,
          runId: rootState.runId,
          messageId: input.messageId,
          content: prepared.content,
          submittedContentDigest: messageContentDigest(payload.content),
          submittedPlacement: input.placement,
          placement: input.placement,
          disposition,
          skillInvocation: prepared.skillInvocation,
          admittedAt: Date.now(),
        };
        await this.#admissions.commitMessageAdmission(messageAdmission);
        const residency = this.#acquireResidency();
        const entry: LiveEntry = {
          entryId,
          messageId: input.messageId,
          admissionTurnId: rootState.turnId,
          admissionRunId: rootState.runId,
          admittedAt: messageAdmission.admittedAt,
          content: payload.content,
          modelContent: prepared.content,
          submittedContentDigest: messageAdmission.submittedContentDigest,
          submittedPlacement: messageAdmission.submittedPlacement,
          skillInvocation: messageAdmission.skillInvocation,
          placement: input.placement,
          disposition,
          generation: state.generation,
          residency,
          state: 'queued',
        };
        if (disposition === 'steering') state.steering.push(entry);
        else state.followup.push(entry);
        this.#mutated(state);
        this.#rememberCompletedOperation(
          'submit',
          input.sessionId,
          input.messageId,
          payload,
          result,
        );
        return success(result);
      }
    };
    return admittedLease
      ? this.#sessionAdmission.runAdmitted(input.sessionId, admittedLease, () =>
          execute(admittedLease),
        )
      : this.#sessionAdmission.run(input.sessionId, execute);
  }

  private retract(input: QueueRetractInput): Promise<MessageOutcome<QueueRetractResult>> {
    return this.#runQueuedMutation({
      spec: MESSAGE_OPERATION_SPECS['queue.retract'],
      operationKind: 'retract',
      operationId: input.retractId,
      verb: 'Retract',
      input,
      execute: () => this.#retractAdmitted(input),
    });
  }

  async #retractAdmitted(input: QueueRetractInput): Promise<MessageOutcome<QueueRetractResult>> {
    const header = await this.#root.readSessionHeader(input.sessionId);
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    if (!header) return failure('not_found', 'Session does not exist');
    if (header.isArchived) return failure('session_archived', 'Session is archived');
    const state = this.#state(input.sessionId);
    if (
      !retractionResultFits(
        state,
        state.revision + (queuedEntryCount(state) > 0 ? 1 : 0),
        MESSAGE_OPERATION_RESULT_MAX_BYTES,
      )
    ) {
      return failure('session_busy', 'Retract result exceeds protocol capacity');
    }
    const queued = [...state.steering, ...state.followup];
    const result = {
      queueRevision: state.revision + (queued.length > 0 ? 1 : 0),
      retracted: queued.map(retractedSnapshot),
    };
    await this.#admissions.cancelMessageAdmissions(
      input.sessionId,
      queued.map((entry) => entry.messageId),
    );
    const retracted = this.#retractQueued(state);
    if (retracted.length > 0) this.#mutated(state);
    if (!isDeepStrictEqual(result, { queueRevision: state.revision, retracted })) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Retract mutation did not match its prepared result',
      );
    }
    this.#maybeReclaim(input.sessionId, state);
    this.#rememberCompletedOperation('retract', input.sessionId, input.retractId, input, result);
    return success(result);
  }

  private retractQueuedEntry(
    input: QueueEntryRetractInput,
  ): Promise<MessageOutcome<QueueMutationResult>> {
    return this.#runQueuedMutation({
      spec: MESSAGE_OPERATION_SPECS['queue.entry.retract'],
      operationKind: 'retract_entry',
      operationId: input.retractId,
      verb: 'Retract',
      input,
      execute: () => this.#retractQueuedEntryAdmitted(input),
    });
  }

  private promoteQueuedEntry(
    input: QueueEntryPromoteInput,
  ): Promise<MessageOutcome<QueueMutationResult>> {
    return this.#runQueuedMutation({
      spec: MESSAGE_OPERATION_SPECS['queue.entry.promote'],
      operationKind: 'promote',
      operationId: input.promoteId,
      verb: 'Promote',
      input,
      execute: () => this.#promoteQueuedEntryAdmitted(input),
    });
  }

  private updateQueuedEntry(
    input: QueueEntryUpdateInput,
  ): Promise<MessageOutcome<QueueMutationResult>> {
    return this.#runQueuedMutation({
      spec: MESSAGE_OPERATION_SPECS['queue.entry.update'],
      operationKind: 'update_entry',
      operationId: input.updateId,
      verb: 'Update',
      input,
      execute: () => this.#updateQueuedEntryAdmitted(input),
    });
  }

  private reorderQueuedEntries(
    input: QueueEntriesReorderInput,
  ): Promise<MessageOutcome<QueueMutationResult>> {
    return this.#runQueuedMutation({
      spec: MESSAGE_OPERATION_SPECS['queue.entries.reorder'],
      operationKind: 'reorder',
      operationId: input.reorderId,
      verb: 'Reorder',
      input,
      execute: () => this.#reorderQueuedEntriesAdmitted(input),
    });
  }

  #runQueuedMutation<I extends { readonly originHostEpoch: string; readonly sessionId: string }, R>(
    options: QueuedMutationOptions<I, R>,
  ): Promise<MessageOutcome<R>> {
    const { input } = options;
    const isCurrentEpoch = input.originHostEpoch === this.#hostEpoch;
    const key = queuedMutationKey(options.operationKind, input.sessionId, options.operationId);
    if (isCurrentEpoch) {
      const pending = this.#pendingQueuedMutations.get(key);
      if (pending) {
        return samePayload(pending.payload, input)
          ? (pending.result as Promise<MessageOutcome<R>>)
          : Promise.resolve(
              failure('operation_conflict', `${options.verb} identity has a different payload`),
            );
      }
    }
    if (this.#failStopped) {
      return Promise.resolve(failure('host_draining', 'Runtime Host message authority has failed'));
    }
    if (!isCurrentEpoch) {
      return Promise.resolve(
        failure('outcome_unknown', `${options.verb} outcome is not durable across Host Epochs`),
      );
    }
    const result = this.#admitQueuedMutation(options);
    this.#pendingQueuedMutations.set(key, { payload: input, result });
    void result.then(
      () => this.#deletePendingQueuedMutation(key, result),
      () => this.#deletePendingQueuedMutation(key, result),
    );
    return result;
  }

  #admitQueuedMutation<
    I extends { readonly originHostEpoch: string; readonly sessionId: string },
    R,
  >(options: QueuedMutationOptions<I, R>): Promise<MessageOutcome<R>> {
    return this.#sessionAdmission.run(options.input.sessionId, async () => {
      if (this.#failStopped) {
        return failure('host_draining', 'Runtime Host message authority has failed');
      }
      const receipt = await this.#readCompletedQueuedMutation(options);
      if (receipt) {
        return samePayload(receipt.payload, options.input)
          ? success(receipt.result)
          : failure('operation_conflict', `${options.verb} identity has a different payload`);
      }
      return options.execute();
    });
  }

  async #readCompletedQueuedMutation<
    I extends { readonly originHostEpoch: string; readonly sessionId: string },
    R,
  >(
    options: QueuedMutationOptions<I, R>,
  ): Promise<{ readonly payload: I; readonly result: R } | undefined> {
    const receipt = this.#completedOperations.get(
      queuedMutationKey(options.operationKind, options.input.sessionId, options.operationId),
    );
    if (!receipt) return undefined;
    try {
      return {
        payload: options.spec.decodeInput(receipt.payload),
        result: options.spec.decodeOutput(receipt.result),
      };
    } catch (error) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Invalid queued mutation replay outcome: ${
          error instanceof Error ? error.message : 'malformed'
        }`,
      );
    }
  }

  #deletePendingQueuedMutation(key: string, result: Promise<MessageOutcome<unknown>>): void {
    if (this.#pendingQueuedMutations.get(key)?.result === result) {
      this.#pendingQueuedMutations.delete(key);
    }
  }

  async #retractQueuedEntryAdmitted(
    input: QueueEntryRetractInput,
  ): Promise<MessageOutcome<QueueMutationResult>> {
    const header = await this.#root.readSessionHeader(input.sessionId);
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    if (!header) return failure('not_found', 'Session does not exist');
    if (header.isArchived) return failure('session_archived', 'Session is archived');
    const state = this.#state(input.sessionId);
    if (state.transition) {
      return failure('operation_conflict', 'Message queue is draining into the next Turn');
    }
    const queued = findQueuedEntry(state, input.entryId);
    if (!queued) {
      if ([...state.inFlight.values()].some((entry) => entry.entryId === input.entryId)) {
        return failure('operation_conflict', 'Message entry is already being delivered');
      }
      return failure('not_found', 'Message queue entry does not exist');
    }
    await this.#admissions.cancelMessageAdmissions(input.sessionId, [queued.entry.messageId]);
    queued.remove();
    this.#releaseEntry(queued.entry);
    this.#mutated(state);
    this.#maybeReclaim(input.sessionId, state);
    const result = { queueRevision: state.revision };
    this.#rememberCompletedOperation(
      'retract_entry',
      input.sessionId,
      input.retractId,
      input,
      result,
    );
    return success(result);
  }

  async #promoteQueuedEntryAdmitted(
    input: QueueEntryPromoteInput,
  ): Promise<MessageOutcome<QueueMutationResult>> {
    const header = await this.#root.readSessionHeader(input.sessionId);
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    if (!header) return failure('not_found', 'Session does not exist');
    if (header.isArchived) return failure('session_archived', 'Session is archived');
    const rootState = await this.#root.readRootState(input.sessionId);
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    if (rootState.kind !== 'active') {
      return failure('operation_conflict', 'No active Turn can accept steering');
    }
    const state = this.#state(input.sessionId);
    if (state.phase !== 'open') {
      return failure('session_busy', 'Message admission is closed for the active generation');
    }
    if (state.transition) {
      return failure('operation_conflict', 'Message queue is draining into the next Turn');
    }
    if (!state.reservedRoot || !sameRun(state.reservedRoot, rootState)) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Root state does not match message reservation',
      );
    }
    const index = state.followup.findIndex((entry) => entry.entryId === input.entryId);
    const entry = index === -1 ? undefined : state.followup[index];
    if (!entry) {
      if (state.steering.some((queued) => queued.entryId === input.entryId)) {
        return failure('operation_conflict', 'Message entry already steers the active Turn');
      }
      if ([...state.inFlight.values()].some((queued) => queued.entryId === input.entryId)) {
        return failure('operation_conflict', 'Message entry is already being delivered');
      }
      return failure('not_found', 'Message queue entry does not exist');
    }
    const promotedSource = {
      ...sourceFromEntry(entry),
      placement: 'current_turn',
      disposition: 'steering',
    } satisfies RootTurnSourceMessage;
    const prospectiveSteering = [...state.inFlight.values(), ...state.steering].map(
      sourceFromEntry,
    );
    prospectiveSteering.push(promotedSource);
    const prospectiveFollowup = state.followup
      .filter((queued) => queued !== entry)
      .map(sourceFromEntry);
    if (
      !successorAdmissionsFit(
        input.sessionId,
        state.reservedRoot.turnId,
        prospectiveSteering,
        prospectiveFollowup,
      )
    ) {
      return failure('session_busy', 'Promoted Message exceeds steering admission capacity');
    }
    await this.#admissions.updateMessageAdmission({
      sessionId: input.sessionId,
      turnId: entry.admissionTurnId,
      runId: entry.admissionRunId,
      messageId: entry.messageId,
      content: entry.modelContent,
      submittedContentDigest: entry.submittedContentDigest,
      submittedPlacement: entry.submittedPlacement,
      placement: 'current_turn',
      disposition: 'steering',
      skillInvocation: entry.skillInvocation,
      admittedAt: entry.admittedAt,
    });
    state.followup.splice(index, 1);
    state.steering.push({ ...entry, placement: 'current_turn', disposition: 'steering' });
    this.#mutated(state);
    const result = { queueRevision: state.revision };
    this.#rememberCompletedOperation('promote', input.sessionId, input.promoteId, input, result);
    return success(result);
  }

  async #updateQueuedEntryAdmitted(
    input: QueueEntryUpdateInput,
  ): Promise<MessageOutcome<QueueMutationResult>> {
    const header = await this.#root.readSessionHeader(input.sessionId);
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    if (!header) return failure('not_found', 'Session does not exist');
    if (header.isArchived) return failure('session_archived', 'Session is archived');
    const state = this.#state(input.sessionId);
    if (state.transition) {
      return failure('operation_conflict', 'Message queue is draining into the next Turn');
    }
    const queued = findQueuedEntry(state, input.entryId);
    if (!queued) {
      if ([...state.inFlight.values()].some((entry) => entry.entryId === input.entryId)) {
        return failure('operation_conflict', 'Message entry is already being delivered');
      }
      return failure('not_found', 'Message queue entry does not exist');
    }
    if (state.revision !== input.expectedQueueRevision) {
      return failure('operation_conflict', 'Message queue changed since editing began');
    }
    if (!state.reservedRoot) {
      throw new RuntimeMessageAuthorityInvariantError('Queued entry has no root Turn reservation');
    }
    const currentRevision = state.revision;
    const content = normalizeMessageContent({
      ...queued.entry.content,
      text: input.text,
      displayText: input.text,
      inlineReferences: relocateInlineReferences(queued.entry.content.inlineReferences, input.text),
    });
    const prepared = await this.#root.prepareMessage({
      sessionId: input.sessionId,
      turnId: state.reservedRoot.turnId,
      content,
      placement: queued.entry.placement,
    });
    if (prepared.kind === 'rejected') return failure('operation_conflict', prepared.error);
    const modelContent = prepared.content;
    const candidate = this.#project(state);
    const updateSnapshot = <T extends SteeringMessageSnapshot | QueuedMessageSnapshot>(
      entry: T,
    ): T =>
      entry.entryId === input.entryId && entry.state === 'queued' ? { ...entry, content } : entry;
    const updatedProjection = {
      ...candidate,
      queueRevision: candidate.queueRevision + 1,
      steering: candidate.steering.map(updateSnapshot),
      followup: candidate.followup.map(updateSnapshot),
    };
    if (!projectionFitsEveryEntryState(updatedProjection)) {
      return failure('session_busy', 'Message queue projection capacity is full');
    }
    const updatedSource = (entry: LiveEntry): RootTurnSourceMessage =>
      entry === queued.entry
        ? {
            ...sourceFromEntry(entry),
            content: modelContent,
            submittedContentDigest: messageContentDigest(content),
            skillInvocation: prepared.skillInvocation,
          }
        : sourceFromEntry(entry);
    const steeringSources = [...state.inFlight.values(), ...state.steering].map(updatedSource);
    const followupSources = state.followup.map(updatedSource);
    if (
      !successorAdmissionsFit(
        input.sessionId,
        state.reservedRoot.turnId,
        steeringSources,
        followupSources,
      )
    ) {
      return failure('session_busy', 'Message queue mutation exceeds root admission capacity');
    }
    if (!(await this.#preflightSessionSnapshot(input.sessionId, { queue: updatedProjection }))) {
      return failure('session_busy', 'Session projection capacity is full');
    }
    if (
      state.revision !== currentRevision ||
      findQueuedEntry(state, input.entryId)?.entry !== queued.entry
    ) {
      return failure('session_busy', 'Message queue changed during update');
    }
    const admission = await this.#admissions.readMessageAdmission(
      input.sessionId,
      queued.entry.messageId,
    );
    await this.#admissions.updateMessageAdmission({
      sessionId: input.sessionId,
      turnId: queued.entry.admissionTurnId,
      runId: queued.entry.admissionRunId,
      messageId: queued.entry.messageId,
      content: modelContent,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: admission?.submittedPlacement ?? queued.entry.placement,
      placement: queued.entry.placement,
      disposition: queued.entry.disposition,
      skillInvocation: prepared.skillInvocation,
      admittedAt: queued.entry.admittedAt,
    });
    queued.entry.content = content;
    queued.entry.modelContent = modelContent;
    queued.entry.submittedContentDigest = messageContentDigest(content);
    queued.entry.skillInvocation = prepared.skillInvocation;
    this.#mutated(state);
    const result = { queueRevision: state.revision };
    this.#rememberCompletedOperation(
      'update_entry',
      input.sessionId,
      input.updateId,
      input,
      result,
    );
    return success(result);
  }

  async #reorderQueuedEntriesAdmitted(
    input: QueueEntriesReorderInput,
  ): Promise<MessageOutcome<QueueMutationResult>> {
    const header = await this.#root.readSessionHeader(input.sessionId);
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    if (!header) return failure('not_found', 'Session does not exist');
    if (header.isArchived) return failure('session_archived', 'Session is archived');
    const state = this.#state(input.sessionId);
    if (state.transition) {
      return failure('operation_conflict', 'Message queue is draining into the next Turn');
    }
    const current = state.followup;
    if (input.entryIds.length !== current.length) {
      return failure('operation_conflict', 'Message queue changed since the reorder was issued');
    }
    const byId = new Map(current.map((entry) => [entry.entryId, entry]));
    const reordered: LiveEntry[] = [];
    for (const entryId of input.entryIds) {
      const entry = byId.get(entryId);
      if (!entry) {
        return failure('operation_conflict', 'Message queue changed since the reorder was issued');
      }
      reordered.push(entry);
    }
    if (reordered.some((entry, index) => current[index] !== entry)) {
      await this.#admissions.reorderMessageAdmissions(
        input.sessionId,
        reordered.map((entry) => entry.messageId),
      );
      state.followup = reordered;
      this.#mutated(state);
    }
    const result = { queueRevision: state.revision };
    this.#rememberCompletedOperation('reorder', input.sessionId, input.reorderId, input, result);
    return success(result);
  }

  private async interrupt(input: TurnInterruptInput): Promise<MessageOutcome<TurnInterruptResult>> {
    if (input.originHostEpoch !== this.#hostEpoch) {
      return failure('outcome_unknown', 'Interrupt outcome is not durable across Host Epochs');
    }
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    const completed = await this.#readCompletedInterrupt(input.sessionId, input.interruptId);
    if (completed) {
      return samePayload(completed.payload, input)
        ? completed.result
        : failure('operation_conflict', 'Interrupt identity has a different payload');
    }
    const admitted = await this.#sessionAdmission.run(input.sessionId, async (admission) => {
      if (this.#failStopped) {
        return {
          kind: 'conflict' as const,
          result: failure('host_draining', 'Runtime Host message authority has failed'),
        };
      }
      const prior = this.#sessions.get(input.sessionId)?.pendingInterrupts.get(input.interruptId);
      if (prior) {
        return samePayload(prior.payload, input)
          ? { kind: 'replay' as const, result: prior.result }
          : {
              kind: 'conflict' as const,
              result: failure('operation_conflict', 'Interrupt identity has a different payload'),
            };
      }

      const header = await this.#root.readSessionHeader(input.sessionId);
      if (this.#failStopped) {
        return {
          kind: 'conflict' as const,
          result: failure('host_draining', 'Runtime Host message authority has failed'),
        };
      }
      if (!header) {
        return {
          kind: 'conflict' as const,
          result: failure('not_found', 'Session does not exist'),
        };
      }
      if (header.isArchived) {
        return {
          kind: 'conflict' as const,
          result: failure('session_archived', 'Session is archived'),
        };
      }
      const state = this.#state(input.sessionId);
      const deferred = interruptDeferred();
      state.pendingInterrupts.set(input.interruptId, {
        payload: input,
        result: deferred.promise,
      });
      try {
        const rootState = await this.#root.readRootState(input.sessionId);
        if (this.#failStopped) {
          const result = failure('host_draining', 'Runtime Host message authority has failed');
          this.#deletePendingInterrupt(input.sessionId, state, input.interruptId);
          deferred.resolve(result);
          return { kind: 'replay' as const, result: deferred.promise };
        }
        if (
          rootState.kind !== 'active' ||
          rootState.sessionId !== input.sessionId ||
          rootState.turnId !== input.turnId ||
          rootState.runId !== input.runId
        ) {
          const result = failure(
            'operation_conflict',
            'Interrupt does not match the active root Turn',
          );
          this.#rememberCompletedOperation(
            'interrupt',
            input.sessionId,
            input.interruptId,
            input,
            result,
          );
          this.#deletePendingInterrupt(input.sessionId, state, input.interruptId);
          deferred.resolve(result);
          return { kind: 'replay' as const, result: deferred.promise };
        }
        let fence: QueueFenceResult | undefined;
        const stopFence = await this.#root.claimStopFence(
          { sessionId: input.sessionId, turnId: input.turnId, runId: input.runId },
          () => {
            if (this.#failStopped) {
              throw new RuntimeMessageAuthorityInvariantError(
                'Message authority failed before the stop fence commit',
              );
            }
            fence ??= this.#commitQueueFence(rootState);
            return fence;
          },
          admission,
        );
        if (!fence) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Root stop declaration omitted queue fence commit',
          );
        }
        return {
          kind: 'owner' as const,
          ready: stopFence.ready,
          deliverStop: stopFence.deliverStop,
          fence,
          deferred,
        };
      } catch (error) {
        this.#deletePendingInterrupt(input.sessionId, state, input.interruptId);
        deferred.reject(error);
        throw error;
      }
    });

    if (admitted.kind === 'conflict') return admitted.result;
    if (admitted.kind === 'replay') return admitted.result;
    let claim: HostMessageStopClaim;
    try {
      try {
        await admitted.deliverStop();
      } catch (error) {
        this.#failStop();
        throw error;
      }
      await admitted.ready;
      claim = await this.#sessionAdmission.run(input.sessionId, (admission) => {
        if (this.#failStopped) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Message authority failed before the exact stop claim',
          );
        }
        return this.#root.claimStop(
          { sessionId: input.sessionId, turnId: input.turnId, runId: input.runId },
          () => admitted.fence,
          admission,
        );
      });
    } catch (error) {
      const state = this.#sessions.get(input.sessionId);
      if (state) this.#deletePendingInterrupt(input.sessionId, state, input.interruptId);
      admitted.deferred.reject(error);
      throw error;
    }
    try {
      const turn = await claim.terminal;
      const result = success({ ...admitted.fence, turn });
      this.#rememberCompletedOperation(
        'interrupt',
        input.sessionId,
        input.interruptId,
        input,
        result,
      );
      const state = this.#sessions.get(input.sessionId);
      if (state) this.#deletePendingInterrupt(input.sessionId, state, input.interruptId);
      admitted.deferred.resolve(result);
      return result;
    } catch (error) {
      const state = this.#sessions.get(input.sessionId);
      if (state) this.#deletePendingInterrupt(input.sessionId, state, input.interruptId);
      admitted.deferred.reject(error);
      throw error;
    }
  }

  async #queryDurableSubmitProof(
    input: TurnMessageSubmitInput,
    payload: CanonicalSubmitPayload,
  ): Promise<MessageOutcome<TurnMessageSubmitResult> | undefined> {
    const receipt = await this.#durableProof.readRootTurnSourceMessageReceipt(
      input.sessionId,
      input.messageId,
    );
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    if (receipt) {
      const source = receipt.sourceMessage;
      if (!sameSourcePayload(receipt, payload)) {
        return failure('operation_conflict', 'Durable message receipt has a different payload');
      }
      const skillInvocation =
        source.skillInvocation ?? receipt.admission.skillInvocation ?? EMPTY_SKILL_INVOCATION;
      if (source.disposition === 'turn_started') {
        return success({
          disposition: 'turn_started',
          turnId: receipt.admission.turnId,
          skillInvocation,
        });
      }
      return success({
        disposition: source.disposition,
        skillInvocation,
      });
    }
    const steeringProof = await this.#durableProof.readImmutableSteeringMessageProof(
      input.sessionId,
      input.messageId,
    );
    const event = steeringProof?.event;
    if (event) {
      const durableDigest = event.refs?.sourceMessageDigest;
      if (
        input.placement !== 'current_turn' ||
        event.content?.kind !== 'text' ||
        (durableDigest !== undefined
          ? durableDigest !== messageContentDigest(payload.content)
          : !messageContentsEqual(runtimeEventContent(event.content), payload.content))
      ) {
        return failure('operation_conflict', 'Durable steering fact has a different payload');
      }
      return failure(
        'outcome_unknown',
        'Durable steering proof does not include the original queue revision',
      );
    }
    return undefined;
  }

  async #readCompletedSubmit(
    sessionId: string,
    messageId: string,
  ): Promise<{ payload: CanonicalSubmitPayload; result: TurnMessageSubmitResult } | undefined> {
    const receipt = this.#completedOperations.get(
      queuedMutationKey('submit', sessionId, messageId),
    );
    if (!receipt) return undefined;
    try {
      return {
        payload: canonicalSubmitPayload(
          MESSAGE_OPERATION_SPECS['turn.message.submit'].decodeInput(receipt.payload),
        ),
        result: MESSAGE_OPERATION_SPECS['turn.message.submit'].decodeOutput(receipt.result),
      };
    } catch (error) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Invalid submit replay outcome: ${error instanceof Error ? error.message : 'malformed'}`,
      );
    }
  }

  async #readCompletedInterrupt(
    sessionId: string,
    interruptId: string,
  ): Promise<
    { payload: TurnInterruptInput; result: MessageOutcome<TurnInterruptResult> } | undefined
  > {
    const receipt = this.#completedOperations.get(
      queuedMutationKey('interrupt', sessionId, interruptId),
    );
    if (!receipt) return undefined;
    try {
      return {
        payload: MESSAGE_OPERATION_SPECS['turn.interrupt'].decodeInput(receipt.payload),
        result: decodeCompletedInterruptOutcome(receipt.result),
      };
    } catch (error) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Invalid interrupt replay outcome: ${error instanceof Error ? error.message : 'malformed'}`,
      );
    }
  }

  #rememberCompletedOperation(
    operation: MessageOperationKind,
    sessionId: string,
    operationId: string,
    payload: object,
    result: object,
  ): void {
    const key = queuedMutationKey(operation, sessionId, operationId);
    const receipt = { payload: structuredClone(payload), result: structuredClone(result) };
    const committed = this.#completedOperations.get(key);
    if (committed && !isDeepStrictEqual(committed, receipt)) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Message operation replay identity has an ambiguous outcome',
      );
    }
    this.#completedOperations.set(key, committed ?? receipt);
  }

  #deletePendingSubmit(
    key: string,
    result: Promise<MessageOutcome<TurnMessageSubmitResult>>,
  ): void {
    if (this.#pendingSubmits.get(key)?.result === result) this.#pendingSubmits.delete(key);
  }

  #deletePendingInterrupt(sessionId: string, state: SessionState, interruptId: string): void {
    state.pendingInterrupts.delete(interruptId);
    this.#maybeReclaim(sessionId, state);
  }

  #failStop(): void {
    if (this.#failStopped) return;
    this.#failStopped = true;
    this.beginDrain();
    try {
      this.#requestDrain();
    } catch {
      // The coordinator remains fail-stopped even if the Host drain signal itself fails.
    }
  }

  #pull(run: BoundRun): readonly SteeringLease[] {
    this.#assertRun(run);
    const state = this.#requireState(run.sessionId);
    if (state.phase !== 'open' || run.generation !== state.generation) return [];
    const entries = state.steering.splice(0);
    if (entries.length === 0) return [];
    const leases = entries.map((entry): SteeringLease => {
      const leaseId = this.#createId();
      entry.state = 'in_flight';
      entry.leaseId = leaseId;
      state.inFlight.set(leaseId, entry);
      return {
        id: leaseId,
        messageId: entry.messageId,
        content: normalizeMessageContent(entry.modelContent),
        submittedContentDigest: entry.submittedContentDigest,
      };
    });
    this.#mutated(state);
    return leases;
  }

  #ack(run: BoundRun, leaseIds: readonly string[]): void {
    this.#assertRun(run);
    const state = this.#requireState(run.sessionId);
    let changed = false;
    for (const leaseId of uniqueLeaseIds(leaseIds)) {
      const entry = state.inFlight.get(leaseId);
      if (!entry) continue;
      state.inFlight.delete(leaseId);
      this.#releaseEntry(entry);
      changed = true;
    }
    if (changed) this.#mutated(state);
  }

  #nack(run: BoundRun, leaseIds: readonly string[]): void {
    this.#assertRun(run);
    const state = this.#requireState(run.sessionId);
    const returned: LiveEntry[] = [];
    let changed = false;
    for (const leaseId of uniqueLeaseIds(leaseIds)) {
      const entry = state.inFlight.get(leaseId);
      if (!entry) continue;
      state.inFlight.delete(leaseId);
      entry.leaseId = undefined;
      if (
        state.phase === 'open' &&
        run.generation === state.generation &&
        entry.generation === state.generation
      ) {
        entry.state = 'queued';
        returned.push(entry);
      } else {
        this.#releaseEntry(entry);
      }
      changed = true;
    }
    if (returned.length > 0) state.steering.unshift(...returned);
    if (changed) this.#mutated(state);
  }

  #releaseRun(run: BoundRun): void {
    this.#assertRun(run);
    const state = this.#requireState(run.sessionId);
    if (state.inFlight.size !== 0) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Message Run released with in-flight steering',
      );
    }
    run.released = true;
  }

  #commitQueueFence(identity: RuntimeMessageRunIdentity): QueueFenceResult {
    const state = this.#requireState(identity.sessionId);
    if (state.transition) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Stop fence cannot replace a terminal transition',
      );
    }
    const existing = state.stopFence;
    if (existing) {
      if (!sameRun(existing.identity, identity)) {
        throw new RuntimeMessageAuthorityInvariantError('Stop fence belongs to another root Turn');
      }
      return existing.result;
    }
    if (!state.reservedRoot || !sameRun(state.reservedRoot, identity)) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Stop fence does not match the reserved root Turn',
      );
    }
    if (!interruptResultFits(this.#project(state), identity)) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Stop fence interrupt result exceeds protocol capacity',
      );
    }
    state.phase = 'closed';
    const retracted = this.#retractQueued(state);
    state.generation += 1;
    this.#mutated(state);
    const result = { queueRevision: state.revision, retracted };
    state.stopFence = { identity: { ...identity }, result };
    return result;
  }

  #retractQueued(state: SessionState): RetractedMessageSnapshot[] {
    const entries = [...state.steering, ...state.followup];
    state.steering = [];
    state.followup = [];
    for (const entry of entries) this.#releaseEntry(entry);
    return entries.map(retractedSnapshot);
  }

  #commitTransition(state: SessionState): void {
    const transition = state.transition;
    if (!transition) throw new RuntimeMessageAuthorityInvariantError('Missing terminal transition');
    if (transition.entries.some((entry, index) => state.followup[index] !== entry)) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Terminal transition no longer owns the queued follow-up prefix',
      );
    }
    for (const entry of transition.entries) this.#releaseEntry(entry);
    state.followup.splice(0, transition.entries.length);
    state.transition = undefined;
    state.reservedRoot = undefined;
    state.stopFence = undefined;
  }

  #requireTransition(batch: RootFollowupBatch): SessionState {
    const state = this.#requireState(batch.sessionId);
    const transition = state.transition;
    if (
      !transition ||
      transition.transitionId !== batch.transitionId ||
      transition.identity.turnId !== batch.previousTurnId ||
      !isDeepStrictEqual(transition.entries.map(sourceFromEntry), batch.sources) ||
      !messageContentsEqual(
        aggregateMessageContent(transition.entries.map((entry) => entry.modelContent)),
        batch.content,
      ) ||
      !messageContentsEqual(
        aggregateMessageContent(transition.entries.map((entry) => entry.content)),
        batch.submittedContent,
      )
    ) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up batch does not own the transition',
      );
    }
    return state;
  }

  #assertRun(run: BoundRun): void {
    const state = this.#requireState(run.sessionId);
    if (run.released || state.run !== run) {
      throw new RuntimeMessageAuthorityInvariantError(`Message Run ${run.runId} is not live`);
    }
  }

  #state(sessionId: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        revision: 0,
        generation: 0,
        phase: 'open',
        steering: [],
        inFlight: new Map(),
        followup: [],
        pendingInterrupts: new Map(),
      };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #requireState(sessionId: string): SessionState {
    const state = this.#sessions.get(sessionId);
    if (!state)
      throw new RuntimeMessageAuthorityInvariantError(`Unknown message Session ${sessionId}`);
    return state;
  }

  #mutated(state: SessionState): void {
    state.revision += 1;
    this.#onProjectionChanged(state.sessionId);
  }

  #maybeReclaim(sessionId: string, state: SessionState): void {
    if (
      this.#sessions.get(sessionId) === state &&
      !hasLiveMessageState(state) &&
      !state.stopFence &&
      state.pendingInterrupts.size === 0
    ) {
      this.#sessions.delete(sessionId);
    }
  }

  #project(
    state: SessionState,
    steering: readonly LiveEntry[] = state.steering,
    followup: readonly LiveEntry[] = state.followup,
  ): SessionMessageQueueProjection {
    return {
      hostEpoch: this.#hostEpoch,
      queueRevision: state.revision,
      steering: [
        ...[...state.inFlight.values()].map(inFlightSnapshot),
        ...steering.map(queuedSteeringSnapshot),
      ],
      followup: followup.map(queuedFollowupSnapshot),
    };
  }

  #releaseEntry(entry: LiveEntry): void {
    if (entry.state === 'released') return;
    entry.state = 'released';
    entry.leaseId = undefined;
    entry.residency.release();
  }
}

function success<T>(result: T): MessageOutcome<T> {
  return { ok: true, result };
}

function failure(
  code: MessageOperationErrorCode,
  message: string,
): {
  readonly ok: false;
  readonly error: { readonly code: MessageOperationErrorCode; readonly message: string };
} {
  return { ok: false, error: { code, message } };
}

function operationKey(sessionId: string, operationId: string): string {
  return `${sessionId}\0${operationId}`;
}

function queuedMutationKey(
  kind: MessageOperationKind,
  sessionId: string,
  operationId: string,
): string {
  return `${kind}\0${sessionId}\0${operationId}`;
}

function findQueuedEntry(
  state: SessionState,
  entryId: string,
): { readonly entry: LiveEntry; remove(): void } | undefined {
  for (const queue of [state.steering, state.followup]) {
    const index = queue.findIndex((entry) => entry.entryId === entryId);
    const entry = index === -1 ? undefined : queue[index];
    if (!entry) continue;
    return { entry, remove: () => queue.splice(index, 1) };
  }
  return undefined;
}

function relocateInlineReferences(
  references: MessageContent['inlineReferences'],
  text: string,
): MessageContent['inlineReferences'] {
  if (!references) return undefined;
  const relocated = references
    .flatMap((reference) => {
      if (
        text.slice(reference.start, reference.start + reference.value.length) === reference.value
      ) {
        return [reference];
      }
      const first = text.indexOf(reference.value);
      if (first === -1 || text.indexOf(reference.value, first + reference.value.length) !== -1) {
        return [];
      }
      return [{ ...reference, start: first }];
    })
    .sort((left, right) => left.start - right.start || right.value.length - left.value.length);
  const nonOverlapping: NonNullable<MessageContent['inlineReferences']> = [];
  for (const reference of relocated) {
    const previous = nonOverlapping.at(-1);
    if (previous && reference.start < previous.start + previous.value.length) continue;
    nonOverlapping.push(reference);
  }
  return nonOverlapping;
}

function decodeCompletedInterruptOutcome(value: unknown): MessageOutcome<TurnInterruptResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Interrupt replay outcome is not an object');
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true && Object.keys(record).length === 2 && Object.hasOwn(record, 'result')) {
    return success(MESSAGE_OPERATION_SPECS['turn.interrupt'].decodeOutput(record.result));
  }
  if (
    record.ok !== false ||
    Object.keys(record).length !== 2 ||
    !record.error ||
    typeof record.error !== 'object' ||
    Array.isArray(record.error)
  ) {
    throw new Error('Invalid interrupt replay outcome');
  }
  const error = record.error as Record<string, unknown>;
  if (
    Object.keys(error).length !== 2 ||
    error.code !== 'operation_conflict' ||
    typeof error.message !== 'string'
  ) {
    throw new Error('Invalid interrupt replay error');
  }
  return failure(error.code, error.message);
}

function interruptDeferred(): InterruptDeferred {
  let resolve!: (result: MessageOutcome<TurnInterruptResult>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<MessageOutcome<TurnInterruptResult>>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function samePayload(left: object, right: object): boolean {
  return isDeepStrictEqual(left, right);
}

function sameRun(left: RuntimeMessageRunIdentity, right: RuntimeMessageRunIdentity): boolean {
  return (
    left.sessionId === right.sessionId && left.turnId === right.turnId && left.runId === right.runId
  );
}

/**
 * Whether a durable receipt answers the submit being retried. The receipt's own
 * record of the exact-Turn intent is authoritative; a receipt that carries none
 * was written for a submit that asked for none, so any intent now is a
 * different request.
 */
function sameSourcePayload(
  receipt: RootTurnSourceMessageReceipt,
  input: CanonicalSubmitPayload,
): boolean {
  const source = receipt.sourceMessage;
  const execution = receipt.admission.execution;
  const durableDigest =
    source.submittedContentDigest ??
    (receipt.admission.sourceMessages.length === 1 &&
    execution.kind === 'external_message' &&
    execution.inputDigest
      ? execution.inputDigest
      : undefined);
  return (
    source.messageId === input.messageId &&
    (durableDigest
      ? durableDigest === messageContentDigest(input.content)
      : messageContentsEqual(source.content, input.content)) &&
    (source.submittedPlacement ?? source.placement) === input.placement &&
    submittedTurnIntentsEqual(source.submittedIntent, submittedTurnIntent(input))
  );
}

function sourceFromEntry(entry: LiveEntry): RootFollowupSource {
  return {
    messageId: entry.messageId,
    content: normalizeMessageContent(entry.modelContent),
    submittedContentDigest: entry.submittedContentDigest,
    submittedPlacement: entry.submittedPlacement,
    skillInvocation: entry.skillInvocation,
    placement: entry.placement,
    disposition: entry.disposition,
  };
}

function pendingMessageSource(admission: PendingMessageAdmission): RootTurnSourceMessage {
  return {
    messageId: admission.messageId,
    content: normalizeMessageContent(admission.content),
    submittedContentDigest: admission.submittedContentDigest,
    submittedPlacement: admission.submittedPlacement,
    ...(admission.submittedIntent ? { submittedIntent: admission.submittedIntent } : {}),
    skillInvocation: admission.skillInvocation,
    placement: admission.placement,
    disposition: admission.disposition,
  };
}

function pendingSteeringRootIdentity(
  pending: readonly PendingMessageAdmission[],
): Pick<HostMessageRecoveryBatch, 'rootIdentity'> {
  const steering = pending.filter(
    (entry) => entry.disposition === 'steering' && entry.submittedPlacement === 'current_turn',
  );
  const first = steering[0];
  if (!first) return {};
  if (steering.some((entry) => entry.turnId !== first.turnId || entry.runId !== first.runId)) {
    throw new RuntimeMessageAuthorityInvariantError(
      'Pending steering admissions disagree on their root identity',
    );
  }
  return { rootIdentity: { turnId: first.turnId, runId: first.runId } };
}

function submittedProjectionContent(content: MessageContent): MessageContent {
  const normalized = normalizeMessageContent(content);
  const text = normalized.displayText ?? normalized.text;
  return normalizeMessageContent({ ...normalized, text, displayText: text });
}

function queuedSnapshot(entry: LiveEntry): QueuedMessageSnapshot {
  return {
    entryId: entry.entryId,
    messageId: entry.messageId,
    content: normalizeMessageContent(entry.content),
    placement: entry.placement,
    state: 'queued',
  };
}

function queuedSteeringSnapshot(entry: LiveEntry): SteeringMessageSnapshot {
  if (entry.placement !== 'current_turn') {
    throw new RuntimeMessageAuthorityInvariantError('Steering entry lost current-turn placement');
  }
  return { ...queuedSnapshot(entry), placement: 'current_turn' };
}

/**
 * Queue position, not origin: an entry in the followup queue is a next-turn
 * message by definition, including a steering entry the run never pulled and
 * the terminal transition folded ahead of the followups. Where the message was
 * originally aimed stays on `disposition` and on the durable
 * {@link sourceFromEntry} record. Reporting a folded entry as `current_turn`
 * here makes the projection fail its own wire decode, which takes the Host
 * down through the session continuity snapshot (#3530).
 */
function queuedFollowupSnapshot(entry: LiveEntry): QueuedMessageSnapshot {
  return { ...queuedSnapshot(entry), placement: 'next_turn' };
}

function inFlightSnapshot(entry: LiveEntry): SteeringMessageSnapshot {
  if (entry.placement !== 'current_turn') {
    throw new RuntimeMessageAuthorityInvariantError('In-flight entry lost current-turn placement');
  }
  return {
    entryId: entry.entryId,
    messageId: entry.messageId,
    content: normalizeMessageContent(entry.content),
    placement: 'current_turn',
    state: 'in_flight',
  };
}

function retractedSnapshot(entry: LiveEntry): RetractedMessageSnapshot {
  return { ...queuedSnapshot(entry), state: 'retracted' };
}

function uniqueLeaseIds(leaseIds: readonly string[]): readonly string[] {
  return [...new Set(leaseIds)];
}

function allLiveEntries(state: SessionState): LiveEntry[] {
  return [...new Set([...state.steering, ...state.inFlight.values(), ...state.followup])].filter(
    (entry) => entry.state !== 'released',
  );
}

function hasLiveMessageState(state: SessionState): boolean {
  return Boolean(
    state.reservedRoot || state.run || state.transition || allLiveEntries(state).length !== 0,
  );
}

function queuedEntryCount(state: SessionState): number {
  return state.steering.length + state.followup.length;
}

function projectionFitsEveryEntryState(projection: SessionMessageQueueProjection): boolean {
  return fitsEncodedByteLimit(
    worstCaseMessageQueueProjection(projection),
    MESSAGE_QUEUE_PROJECTION_MAX_BYTES,
  );
}

function retractionResultFits(
  state: SessionState,
  queueRevision: number,
  maxBytes: number,
): boolean {
  const retracted = [...state.steering, ...state.followup].map(retractedSnapshot);
  return fitsEncodedByteLimit({ queueRevision, retracted }, maxBytes);
}

function fitsEncodedByteLimit(value: unknown, maxBytes: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

function isEntityId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

interface CanonicalSubmitPayload {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly content: MessageContent;
  readonly placement: MessagePlacement;
  readonly skillIds: readonly string[];
  readonly turnOrchestration?: TurnOrchestration;
}

function canonicalSubmitPayload(input: TurnMessageSubmitInput): CanonicalSubmitPayload {
  return {
    originHostEpoch: input.originHostEpoch,
    sessionId: input.sessionId,
    messageId: input.messageId,
    content: normalizeMessageContent(input.content),
    placement: input.placement,
    skillIds: [...(input.skillIds ?? [])],
    ...(input.turnOrchestration ? { turnOrchestration: input.turnOrchestration } : {}),
  };
}

/**
 * Exact-Turn intent. Explicit Skill ids and an orchestration override describe
 * how one Turn runs, so they have no queued form and need an idle Session.
 * A `/skill:` token in the text is not exact-Turn intent: message preparation
 * expands it on the queued path too.
 */
function requiresExactTurn(payload: CanonicalSubmitPayload): boolean {
  return payload.skillIds.length > 0 || payload.turnOrchestration !== undefined;
}

/**
 * The exact-Turn intent as the durable value every record keeps, or undefined
 * when the submit asked for none. Content and placement say nothing about how a
 * Turn runs, so this is the rest of what makes a submit the same submit:
 * without it, a retry under one Message identity can change the execution mode
 * and still be answered with the earlier Turn's success.
 */
function submittedTurnIntent(payload: CanonicalSubmitPayload): SubmittedTurnIntent | undefined {
  if (!requiresExactTurn(payload)) return undefined;
  return {
    skillIds: payload.skillIds,
    ...(payload.turnOrchestration ? { turnOrchestration: payload.turnOrchestration } : {}),
  };
}

function aggregateMessageContent(contents: readonly MessageContent[]): MessageContent {
  return aggregateMessageContents(contents);
}

function canonicalFollowupBatch(entries: readonly LiveEntry[]): {
  readonly content: MessageContent;
  readonly submittedContent: MessageContent;
  readonly sources: readonly RootFollowupSource[];
} {
  if (entries.length === 0) {
    return { content: { text: '' }, submittedContent: { text: '' }, sources: [] };
  }
  const sources = entries.map(sourceFromEntry);
  const content = aggregateMessageContent(entries.map((entry) => entry.modelContent));
  const submittedContent = aggregateMessageContent(entries.map((entry) => entry.content));
  try {
    const { normalizedInput } = normalizeRootTurnAdmissionPayload(content, sources);
    return { content: normalizedInput, submittedContent, sources };
  } catch {
    throw new RuntimeMessageAuthorityInvariantError(
      'Accepted follow-up batch violates the durable root admission contract',
    );
  }
}

/**
 * One explicit next-turn Message owns one successor root Turn. Steering that
 * missed the final provider boundary is different: those entries all targeted
 * the finishing Turn, so keep their correction context together in the first
 * successor rather than turning each interjection into unrelated future work.
 */
function nextSuccessorItems<
  T extends { readonly disposition: 'steering' | 'followup' | 'turn_started' },
>(entries: readonly T[]): T[] {
  if (entries.length === 0) return [];
  if (entries[0]!.disposition !== 'steering') return [entries[0]!];
  const steering: T[] = [];
  for (const entry of entries) {
    if (entry.disposition !== 'steering') break;
    steering.push(entry);
  }
  return steering;
}

function nextRecoveredSuccessorItems(
  pending: readonly PendingMessageAdmission[],
): PendingMessageAdmission[] {
  const steeringIntent = pending.filter(
    (entry) => entry.disposition === 'steering' || entry.submittedPlacement === 'current_turn',
  );
  const first = steeringIntent[0];
  if (first) {
    const firstHasRootIdentity = hasNativeSteeringRootIdentity(first);
    const compatible: PendingMessageAdmission[] = [];
    for (const entry of steeringIntent) {
      if (hasNativeSteeringRootIdentity(entry) !== firstHasRootIdentity) break;
      if (firstHasRootIdentity && (entry.turnId !== first.turnId || entry.runId !== first.runId)) {
        break;
      }
      compatible.push(entry);
    }
    return compatible;
  }
  return pending.length > 0 ? [pending[0]!] : [];
}

function hasNativeSteeringRootIdentity(admission: PendingMessageAdmission): boolean {
  return admission.disposition === 'steering' && admission.submittedPlacement === 'current_turn';
}

function rootAdmissionPayloadFits(
  sessionId: string,
  previousTurnId: string,
  sources: readonly RootTurnSourceMessage[],
): boolean {
  try {
    const content = aggregateMessageContent(sources.map((source) => source.content));
    const worstCaseId = 'i'.repeat(128);
    return rootTurnAdmissionRecordFits({
      sessionId,
      turnId: worstCaseId,
      proposedRunId: worstCaseId,
      proposedUserMessageId: sources.length === 1 ? worstCaseId : null,
      execution: {
        kind: 'external_message',
        inputDigest: `sha256:${'f'.repeat(64)}`,
      },
      previousRootTurnId: previousTurnId,
      normalizedInput: content,
      sourceMessages: sources,
      admittedAt: Number.MAX_SAFE_INTEGER,
    });
  } catch {
    return false;
  }
}

function successorAdmissionsFit(
  sessionId: string,
  previousTurnId: string,
  steering: readonly RootTurnSourceMessage[],
  followup: readonly RootTurnSourceMessage[],
): boolean {
  return (
    (steering.length === 0 || rootAdmissionPayloadFits(sessionId, previousTurnId, steering)) &&
    followup.every((source) => rootAdmissionPayloadFits(sessionId, previousTurnId, [source]))
  );
}

function interruptResultFits(
  projection: SessionMessageQueueProjection,
  identity: RuntimeMessageRunIdentity,
): boolean {
  const retracted = [...projection.steering, ...projection.followup]
    .filter((entry) => entry.state === 'queued')
    .map((entry): RetractedMessageSnapshot => ({ ...entry, state: 'retracted' }));
  const worstCaseTurn = worstCaseFailedTurnSnapshot(identity);
  return fitsEncodedByteLimit(
    { queueRevision: Number.MAX_SAFE_INTEGER, retracted, turn: worstCaseTurn },
    MESSAGE_OPERATION_RESULT_MAX_BYTES,
  );
}

function runtimeEventContent(
  content: Extract<RuntimeEvent['content'], { kind: 'text' }>,
): MessageContent {
  return normalizeMessageContent(content);
}
