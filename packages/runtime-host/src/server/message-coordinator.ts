import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SteeringLease } from '@maka/core/backend-types';
import {
  aggregateMessageContents,
  messageContentsEqual,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  RuntimeMessageAuthorityInvariantError,
  type RuntimeMessageAuthority,
  type RuntimeMessageRunIdentity,
  type RuntimeMessageRunOwner,
} from '@maka/runtime/message-authority';
import {
  normalizeRootTurnAdmissionPayload,
  type ImmutableSteeringMessageProof,
  type MessageReceiptStore,
  type RootTurnSourceMessage,
  type RootTurnSourceMessageReceipt,
} from '@maka/storage/execution-stores';
import {
  MESSAGE_QUEUE_MAX_ENTRIES,
  MESSAGE_QUEUE_PROJECTION_MAX_BYTES,
  MESSAGE_OPERATION_RESULT_MAX_BYTES,
  MESSAGE_OPERATION_SPECS,
  type MessagePlacement,
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
import { messageContentDigest } from './message-content-digest.js';
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
}

export interface HostMessagePreparationInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly content: MessageContent;
  readonly placement: MessagePlacement;
  readonly initiatingConnectionId: string;
}

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
  ): Promise<{ readonly turnId: string } | { readonly error: string }>;
  prepareMessage(
    input: HostMessagePreparationInput,
  ): Promise<
    | { readonly kind: 'ready'; readonly content: MessageContent }
    | { readonly kind: 'rejected'; readonly error: string }
  >;
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
  readonly receipts: MessageReceiptStore;
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
  readonly content: MessageContent;
  readonly modelContent: MessageContent;
  readonly initiatingConnectionId: string;
  readonly placement: MessagePlacement;
  readonly disposition: 'steering' | 'followup';
  readonly generation: number;
  readonly residency: RuntimeHostResidency;
  state: 'queued' | 'in_flight' | 'released';
  leaseId?: string;
}

interface BoundRun extends RuntimeMessageRunIdentity {
  readonly generation: number;
  released: boolean;
}

interface InterruptReceipt {
  readonly payload: TurnInterruptInput;
  readonly result: Promise<MessageOutcome<TurnInterruptResult>>;
}

interface PendingSubmit {
  readonly payload: CanonicalSubmitPayload;
  readonly result: Promise<MessageOutcome<TurnMessageSubmitResult>>;
}

interface PendingRetract {
  readonly payload: QueueRetractInput;
  readonly result: Promise<MessageOutcome<QueueRetractResult>>;
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
  interruptReceipts: Map<string, InterruptReceipt>;
}

export type RootFollowupSource = RootTurnSourceMessage & {
  readonly disposition: 'steering' | 'followup';
};

export interface RootFollowupBatch {
  readonly transitionId: string;
  readonly sessionId: string;
  readonly previousTurnId: string;
  readonly initiatingConnectionId: string | undefined;
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

/** The sole in-memory message authority for one Runtime Host Epoch. */
export class HostMessageCoordinator implements RuntimeMessageAuthority {
  readonly handlers: MessageOperationHandlerMap = {
    'turn.message.submit': (input, context) => this.submit(input, context),
    'queue.retract': (input) => this.retract(input),
    'turn.interrupt': (input) => this.interrupt(input),
  };

  readonly #hostEpoch: string;
  readonly #root: HostMessageRootPort;
  readonly #durableProof: HostMessageDurableProofReader;
  readonly #receipts: MessageReceiptStore;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #requestDrain: () => void;
  readonly #onProjectionChanged: (sessionId: string) => void;
  readonly #createId: () => string;
  readonly #preflightSessionSnapshot: CandidateSnapshotPreflight;
  readonly #sessions = new Map<string, SessionState>();
  readonly #pendingSubmits = new Map<string, PendingSubmit>();
  readonly #pendingRetracts = new Map<string, PendingRetract>();
  #draining = false;
  #failStopped = false;

  constructor(options: HostMessageCoordinatorOptions) {
    if (options.hostEpoch.length === 0 || options.hostEpoch.length > 128) {
      throw new RuntimeMessageAuthorityInvariantError('Invalid Host Epoch identity');
    }
    this.#hostEpoch = options.hostEpoch;
    this.#root = options.root;
    this.#durableProof = options.durableProof;
    this.#receipts = options.receipts;
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
    const entries = sameInitiatingClientPrefix(state.followup);
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
      initiatingConnectionId: entries[0]?.initiatingConnectionId,
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
    if (!isCurrentEpoch) return this.#submitAdmitted(input, payload, context.connectionId);
    const key = operationKey(input.sessionId, input.messageId);
    const result = this.#submitAdmitted(input, payload, context.connectionId);
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
  ): Promise<MessageOutcome<TurnMessageSubmitResult>> {
    return this.#sessionAdmission.run(input.sessionId, async (admission) => {
      if (this.#failStopped) {
        return failure('host_draining', 'Runtime Host message authority has failed');
      }
      const isCurrentEpoch = input.originHostEpoch === this.#hostEpoch;
      if (isCurrentEpoch) {
        const receipt = await this.#readSubmitReceipt(input.sessionId, input.messageId);
        if (this.#failStopped) {
          return failure('host_draining', 'Runtime Host message authority has failed');
        }
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
          const sourceMessage: RootTurnSourceMessage = {
            messageId: input.messageId,
            content: payload.content,
            submittedContentDigest: messageContentDigest(payload.content),
            placement: input.placement,
            disposition: 'turn_started',
          };
          const started = await this.#root.startFromMessage(
            {
              sessionId: input.sessionId,
              content: payload.content,
              sourceMessage,
              initiatingConnectionId,
            },
            admission,
          );
          if ('error' in started) {
            return failure('operation_conflict', started.error);
          }
          if (!isEntityId(started.turnId)) {
            throw new RuntimeMessageAuthorityInvariantError(
              'Started Turn identity is not encodable',
            );
          }
          const result = { disposition: 'turn_started', turnId: started.turnId } as const;
          return success(result);
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
        if (allLiveEntries(state).length >= MESSAGE_QUEUE_MAX_ENTRIES) {
          return failure('session_busy', 'Message queue capacity is full');
        }
        const disposition = input.placement === 'current_turn' ? 'steering' : 'followup';
        const prepared = await this.#root.prepareMessage({
          sessionId: input.sessionId,
          turnId: rootState.turnId,
          content: payload.content,
          placement: input.placement,
          initiatingConnectionId,
        });
        if (prepared.kind === 'rejected') {
          return failure('operation_conflict', prepared.error);
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
        const prospectiveSources = [
          ...[...state.inFlight.values(), ...state.steering, ...state.followup].map(
            sourceFromEntry,
          ),
          {
            messageId: input.messageId,
            content: prepared.content,
            submittedContentDigest: messageContentDigest(payload.content),
            placement: input.placement,
            disposition,
          },
        ] satisfies RootTurnSourceMessage[];
        if (!rootAdmissionPayloadFits(prospectiveSources)) {
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
        const result = { disposition, queueRevision: candidateRevision + 1 } as const;
        const residency = this.#acquireResidency();
        const entry: LiveEntry = {
          entryId,
          messageId: input.messageId,
          content: payload.content,
          modelContent: prepared.content,
          initiatingConnectionId,
          placement: input.placement,
          disposition,
          generation: state.generation,
          residency,
          state: 'queued',
        };
        if (disposition === 'steering') state.steering.push(entry);
        else state.followup.push(entry);
        this.#mutated(state);
        try {
          await this.#commitReceipt('submit', input.sessionId, input.messageId, payload, result);
        } catch (error) {
          this.#failStop();
          throw error;
        }
        return success(result);
      }
    });
  }

  private retract(input: QueueRetractInput): Promise<MessageOutcome<QueueRetractResult>> {
    const isCurrentEpoch = input.originHostEpoch === this.#hostEpoch;
    if (isCurrentEpoch) {
      const pending = this.#pendingRetracts.get(operationKey(input.sessionId, input.retractId));
      if (pending) {
        return samePayload(pending.payload, input)
          ? pending.result
          : Promise.resolve(
              failure('operation_conflict', 'Retract identity has a different payload'),
            );
      }
    }
    if (this.#failStopped) {
      return Promise.resolve(failure('host_draining', 'Runtime Host message authority has failed'));
    }
    if (!isCurrentEpoch) {
      return Promise.resolve(
        failure('outcome_unknown', 'Retract outcome is not durable across Host Epochs'),
      );
    }
    const key = operationKey(input.sessionId, input.retractId);
    const result = this.#retractAdmitted(input);
    this.#pendingRetracts.set(key, { payload: input, result });
    void result.then(
      () => this.#deletePendingRetract(key, result),
      () => this.#deletePendingRetract(key, result),
    );
    return result;
  }

  #retractAdmitted(input: QueueRetractInput): Promise<MessageOutcome<QueueRetractResult>> {
    return this.#sessionAdmission.run(input.sessionId, async () => {
      if (this.#failStopped) {
        return failure('host_draining', 'Runtime Host message authority has failed');
      }
      const receipt = await this.#readRetractReceipt(input.sessionId, input.retractId);
      if (this.#failStopped) {
        return failure('host_draining', 'Runtime Host message authority has failed');
      }
      if (receipt) {
        return samePayload(receipt.payload, input)
          ? success(receipt.result)
          : failure('operation_conflict', 'Retract identity has a different payload');
      }
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
      const retracted = this.#retractQueued(state);
      if (retracted.length > 0) this.#mutated(state);
      if (!isDeepStrictEqual(result, { queueRevision: state.revision, retracted })) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Retract mutation did not match its prepared result',
        );
      }
      this.#maybeReclaim(input.sessionId, state);
      try {
        await this.#commitReceipt('retract', input.sessionId, input.retractId, input, result);
      } catch (error) {
        this.#failStop();
        throw error;
      }
      return success(result);
    });
  }

  private async interrupt(input: TurnInterruptInput): Promise<MessageOutcome<TurnInterruptResult>> {
    if (input.originHostEpoch !== this.#hostEpoch) {
      return failure('outcome_unknown', 'Interrupt outcome is not durable across Host Epochs');
    }
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    const durableReceipt = await this.#readInterruptReceipt(input.sessionId, input.interruptId);
    if (this.#failStopped) {
      return failure('host_draining', 'Runtime Host message authority has failed');
    }
    if (durableReceipt) {
      return samePayload(durableReceipt.payload, input)
        ? durableReceipt.result
        : failure('operation_conflict', 'Interrupt identity has a different payload');
    }
    const admitted = await this.#sessionAdmission.run(input.sessionId, async (admission) => {
      if (this.#failStopped) {
        return {
          kind: 'conflict' as const,
          result: failure('host_draining', 'Runtime Host message authority has failed'),
        };
      }
      const prior = this.#sessions.get(input.sessionId)?.interruptReceipts.get(input.interruptId);
      if (prior) {
        return samePayload(prior.payload, input)
          ? { kind: 'receipt' as const, result: prior.result }
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
      state.interruptReceipts.set(input.interruptId, {
        payload: input,
        result: deferred.promise,
      });
      try {
        const rootState = await this.#root.readRootState(input.sessionId);
        if (this.#failStopped) {
          const result = failure('host_draining', 'Runtime Host message authority has failed');
          this.#deleteInterruptReceipt(input.sessionId, state, input.interruptId);
          deferred.resolve(result);
          return { kind: 'receipt' as const, result: deferred.promise };
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
          await this.#commitReceipt('interrupt', input.sessionId, input.interruptId, input, result);
          this.#deleteInterruptReceipt(input.sessionId, state, input.interruptId);
          deferred.resolve(result);
          return { kind: 'receipt' as const, result: deferred.promise };
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
        this.#deleteInterruptReceipt(input.sessionId, state, input.interruptId);
        deferred.reject(error);
        throw error;
      }
    });

    if (admitted.kind === 'conflict') return admitted.result;
    if (admitted.kind === 'receipt') return admitted.result;
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
      if (state) this.#deleteInterruptReceipt(input.sessionId, state, input.interruptId);
      admitted.deferred.reject(error);
      throw error;
    }
    try {
      const turn = await claim.terminal;
      const result = success({ ...admitted.fence, turn });
      try {
        await this.#commitReceipt('interrupt', input.sessionId, input.interruptId, input, result);
      } catch (error) {
        this.#failStop();
        throw error;
      }
      const state = this.#sessions.get(input.sessionId);
      if (state) this.#deleteInterruptReceipt(input.sessionId, state, input.interruptId);
      admitted.deferred.resolve(result);
      return result;
    } catch (error) {
      const state = this.#sessions.get(input.sessionId);
      if (state) this.#deleteInterruptReceipt(input.sessionId, state, input.interruptId);
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
      if (source.disposition === 'turn_started') {
        return success({ disposition: 'turn_started', turnId: receipt.admission.turnId });
      }
      return failure(
        'outcome_unknown',
        'Durable message proof does not include the original queue revision',
      );
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

  async #readSubmitReceipt(
    sessionId: string,
    messageId: string,
  ): Promise<{ payload: CanonicalSubmitPayload; result: TurnMessageSubmitResult } | undefined> {
    const receipt = await this.#receipts.read(this.#hostEpoch, 'submit', sessionId, messageId);
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
        `Invalid durable submit receipt: ${error instanceof Error ? error.message : 'malformed'}`,
      );
    }
  }

  async #readRetractReceipt(
    sessionId: string,
    retractId: string,
  ): Promise<{ payload: QueueRetractInput; result: QueueRetractResult } | undefined> {
    const receipt = await this.#receipts.read(this.#hostEpoch, 'retract', sessionId, retractId);
    if (!receipt) return undefined;
    try {
      return {
        payload: MESSAGE_OPERATION_SPECS['queue.retract'].decodeInput(receipt.payload),
        result: MESSAGE_OPERATION_SPECS['queue.retract'].decodeOutput(receipt.result),
      };
    } catch (error) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Invalid durable retract receipt: ${error instanceof Error ? error.message : 'malformed'}`,
      );
    }
  }

  async #readInterruptReceipt(
    sessionId: string,
    interruptId: string,
  ): Promise<
    { payload: TurnInterruptInput; result: MessageOutcome<TurnInterruptResult> } | undefined
  > {
    const receipt = await this.#receipts.read(this.#hostEpoch, 'interrupt', sessionId, interruptId);
    if (!receipt) return undefined;
    try {
      return {
        payload: MESSAGE_OPERATION_SPECS['turn.interrupt'].decodeInput(receipt.payload),
        result: decodeInterruptReceiptOutcome(receipt.result),
      };
    } catch (error) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Invalid durable interrupt receipt: ${error instanceof Error ? error.message : 'malformed'}`,
      );
    }
  }

  async #commitReceipt(
    operation: 'submit' | 'retract' | 'interrupt',
    sessionId: string,
    operationId: string,
    payload: object,
    result: object,
  ): Promise<void> {
    const receipt = { payload, result };
    const committed = await this.#receipts.commit(
      this.#hostEpoch,
      operation,
      sessionId,
      operationId,
      receipt,
    );
    if (!isDeepStrictEqual(committed, receipt)) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Durable message receipt publication returned an ambiguous outcome',
      );
    }
  }

  #deletePendingSubmit(
    key: string,
    result: Promise<MessageOutcome<TurnMessageSubmitResult>>,
  ): void {
    if (this.#pendingSubmits.get(key)?.result === result) this.#pendingSubmits.delete(key);
  }

  #deletePendingRetract(key: string, result: Promise<MessageOutcome<QueueRetractResult>>): void {
    if (this.#pendingRetracts.get(key)?.result === result) this.#pendingRetracts.delete(key);
  }

  #deleteInterruptReceipt(sessionId: string, state: SessionState, interruptId: string): void {
    state.interruptReceipts.delete(interruptId);
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
        submittedContentDigest: messageContentDigest(entry.content),
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
      transition.entries[0]?.initiatingConnectionId !== batch.initiatingConnectionId ||
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
        interruptReceipts: new Map(),
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
      state.interruptReceipts.size === 0
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
      followup: followup.map(queuedSnapshot),
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

function decodeInterruptReceiptOutcome(value: unknown): MessageOutcome<TurnInterruptResult> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Interrupt receipt outcome is not an object');
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
    throw new Error('Invalid interrupt receipt outcome');
  }
  const error = record.error as Record<string, unknown>;
  if (
    Object.keys(error).length !== 2 ||
    error.code !== 'operation_conflict' ||
    typeof error.message !== 'string'
  ) {
    throw new Error('Invalid interrupt receipt error');
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
    source.placement === input.placement
  );
}

function sourceFromEntry(entry: LiveEntry): RootFollowupSource {
  return {
    messageId: entry.messageId,
    content: normalizeMessageContent(entry.modelContent),
    submittedContentDigest: messageContentDigest(entry.content),
    placement: entry.placement,
    disposition: entry.disposition,
  };
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
}

function canonicalSubmitPayload(input: TurnMessageSubmitInput): CanonicalSubmitPayload {
  return {
    originHostEpoch: input.originHostEpoch,
    sessionId: input.sessionId,
    messageId: input.messageId,
    content: normalizeMessageContent(input.content),
    placement: input.placement,
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

function sameInitiatingClientPrefix(entries: readonly LiveEntry[]): LiveEntry[] {
  const initiatingConnectionId = entries[0]?.initiatingConnectionId;
  if (!initiatingConnectionId) return [];
  const boundary = entries.findIndex(
    (entry) => entry.initiatingConnectionId !== initiatingConnectionId,
  );
  return entries.slice(0, boundary === -1 ? entries.length : boundary);
}

function rootAdmissionPayloadFits(sources: readonly RootTurnSourceMessage[]): boolean {
  try {
    const content = aggregateMessageContent(sources.map((source) => source.content));
    normalizeRootTurnAdmissionPayload(content, sources);
    return true;
  } catch {
    return false;
  }
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
