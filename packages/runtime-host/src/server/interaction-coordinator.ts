import { isDeepStrictEqual } from 'node:util';
import type { HostedPermissionAdmission } from '@maka/core/backend-types';
import type { AnyPermissionRequestEvent, UserQuestionRequestEvent } from '@maka/core/events';
import {
  InteractionPermissionProjectionError,
  isInteractionAnswerValidForRequest,
  projectInteractionPermissionRequest,
  projectInteractionQuestionRequest,
  type InteractionAnswer,
  type InteractionCanonicalOutcome,
} from '@maka/core/interaction';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionContinuationIdentity,
  type RuntimeInteractionRunClosureReason,
  type RuntimeInteractionRunIdentity,
  type RuntimeInteractionRunOwner,
  type RuntimePermissionContinuation,
  type RuntimePermissionOutcome,
  type RuntimeUserQuestionContinuation,
} from '@maka/runtime';
import {
  authenticateInteractionStoreWriter,
  type CommitInteractionOutcomeResult,
  type EstablishInteractionRequestResult,
  type InteractionRecord,
  type InteractiveInteractionStoreWriterFacade,
  type StoredInteractionOutcome,
  type StoredInteractionRequest,
} from '@maka/storage/interaction-store';
import {
  INTERACTION_MAX_PENDING_PER_SESSION,
  type InteractionAnswerInput,
  type SessionInteractionProjection,
} from '../protocol/index.js';
import {
  answerOutcome,
  compareStoredInteractionRequests,
  permissionCanonicalOutcome,
  permissionInteractionAnswer,
  projectInteractionRecord,
  projectSessionInteractions,
  runtimePermissionOutcome,
  runtimeQuestionOutcome,
  wireCanonicalOutcome,
} from './interaction-projection.js';
import type { InteractionOperationHandlerMap } from './operation-dispatcher.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';

export interface HostInteractionCoordinatorOptions {
  readonly store: InteractiveInteractionStoreWriterFacade;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly now?: () => number;
  readonly preflightSessionSnapshot: (
    sessionId: string,
    interactions: SessionInteractionProjection,
    admission: SessionAdmissionLease,
  ) => Promise<boolean> | boolean;
  readonly refreshCanonicalContinuity: (
    sessionId: string,
    admission: SessionAdmissionLease,
  ) => Promise<void>;
  readonly onPoison: (error: RuntimeInteractionFailStopError) => void;
}

interface RunClosure {
  readonly reason: RuntimeInteractionRunClosureReason;
  readonly task: Promise<void>;
  settled: boolean;
}

interface BoundRun extends RuntimeInteractionRunIdentity {
  closure?: RunClosure;
  readonly rememberedPermissionOutcomes: Map<string, RememberedPermissionOutcome>;
  released: boolean;
}

type RememberedPermissionOutcome = Extract<
  InteractionCanonicalOutcome,
  { kind: 'permission_answer' }
>;

interface LiveEntryBase {
  readonly run: BoundRun;
  readonly request: StoredInteractionRequest;
  phase: 'admitting' | 'live';
}

interface LivePermissionEntry extends LiveEntryBase {
  readonly kind: 'permission';
  readonly continuation: RuntimePermissionContinuation;
}

interface LiveQuestionEntry extends LiveEntryBase {
  readonly kind: 'question';
  readonly continuation: RuntimeUserQuestionContinuation;
}

type LiveEntry = LivePermissionEntry | LiveQuestionEntry;

interface CommittedEntry {
  readonly entry: LiveEntry;
  readonly outcome: StoredInteractionOutcome;
}

/** Host-epoch authority for durable Runtime Interactions. */
export class HostInteractionCoordinator implements RuntimeInteractionAuthority {
  readonly handlers: InteractionOperationHandlerMap = {
    'interaction.query': (input) => this.#query(input.sessionId, input.interactionId),
    'interaction.answer': (input) => this.#answer(input),
  };

  readonly #store: InteractiveInteractionStoreWriterFacade;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #now: () => number;
  readonly #preflightSessionSnapshot: HostInteractionCoordinatorOptions['preflightSessionSnapshot'];
  readonly #refreshCanonicalContinuity: HostInteractionCoordinatorOptions['refreshCanonicalContinuity'];
  readonly #onPoison: HostInteractionCoordinatorOptions['onPoison'];
  readonly #runs = new Map<string, BoundRun>();
  readonly #live = new Map<string, LiveEntry>();
  #accepting = true;
  #poisoned: RuntimeInteractionFailStopError | undefined;

  constructor(options: HostInteractionCoordinatorOptions) {
    this.#store = authenticateInteractionStoreWriter(options.store);
    this.#sessionAdmission = options.sessionAdmission;
    this.#now = options.now ?? Date.now;
    this.#preflightSessionSnapshot = options.preflightSessionSnapshot;
    this.#refreshCanonicalContinuity = options.refreshCanonicalContinuity;
    this.#onPoison = options.onPoison;
  }

  bindRun(identity: RuntimeInteractionRunIdentity): RuntimeInteractionRunOwner {
    this.#throwIfPoisoned();
    if (!this.#accepting) {
      throw new RuntimeInteractionAdmissionRejectedError(identity.runId, 'authority_draining');
    }
    const key = runKey(identity);
    if (this.#runs.has(key)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction Run is already bound: ${identity.sessionId}/${identity.turnId}/${identity.runId}`,
        ),
      );
    }

    const run: BoundRun = {
      ...identity,
      rememberedPermissionOutcomes: new Map(),
      released: false,
    };
    this.#runs.set(key, run);
    return Object.freeze({
      ...identity,
      acceptPermissionRequest: (
        input: Parameters<RuntimeInteractionRunOwner['acceptPermissionRequest']>[0],
      ) => this.#acceptPermissionRequest(run, input),
      commitPermissionAnswer: (
        input: Parameters<RuntimeInteractionRunOwner['commitPermissionAnswer']>[0],
      ) => this.#commitPermissionAnswer(run, input),
      commitPermissionTimeout: (
        input: Parameters<RuntimeInteractionRunOwner['commitPermissionTimeout']>[0],
      ) => this.#commitPermissionTimeout(run, input),
      acceptUserQuestionRequest: (
        input: Parameters<RuntimeInteractionRunOwner['acceptUserQuestionRequest']>[0],
      ) => this.#acceptUserQuestionRequest(run, input),
      close: (reason: RuntimeInteractionRunClosureReason) => this.#closeRun(run, reason),
      release: () => this.#releaseRun(run),
    });
  }

  beginDrain(): void {
    this.#accepting = false;
  }

  isPoisoned(): boolean {
    return this.#poisoned !== undefined;
  }

  recoverPendingAfterHostRestart(): Promise<void> {
    return observed(this.#recoverPendingAfterHostRestart());
  }

  assertTerminalFence(
    identity: RuntimeInteractionRunIdentity,
    admission: SessionAdmissionLease,
  ): Promise<void> {
    this.#throwIfPoisoned();
    if (this.#runs.has(runKey(identity))) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction Run ${identity.runId} reached its terminal fence before release`,
        ),
      );
    }
    for (const entry of this.#live.values()) {
      if (sameRun(entry.request, identity)) {
        throw this.#poison(
          new RuntimeInteractionInvariantError(
            `Interaction Run ${identity.runId} reached its terminal fence with a live continuation`,
          ),
        );
      }
    }
    return observed(
      this.#sessionAdmission.runAdmitted(identity.sessionId, admission, async () => {
        this.#throwIfPoisoned();
        const pending = await this.#readPending(identity);
        if (pending.length !== 0) {
          throw this.#poison(
            new RuntimeInteractionInvariantError(
              `Interaction Run ${identity.runId} reached its terminal fence with durable pending requests`,
            ),
          );
        }
      }),
    );
  }

  async close(): Promise<void> {
    this.beginDrain();
    this.#throwIfPoisoned();
    const pending = await this.#readPending();
    if (this.#runs.size !== 0 || this.#live.size !== 0 || pending.length !== 0) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          'Interaction coordinator closed with active Runs, live continuations, or durable pending requests',
        ),
      );
    }
  }

  #acceptPermissionRequest(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['acceptPermissionRequest']>[0],
  ): Promise<HostedPermissionAdmission> {
    try {
      this.#assertAcceptable(run, input.request, input.continuation);
      let request: ReturnType<typeof projectInteractionPermissionRequest>;
      try {
        request = projectInteractionPermissionRequest(input.request);
      } catch (error) {
        if (!(error instanceof InteractionPermissionProjectionError)) throw error;
        return rejected(
          new RuntimeInteractionAdmissionRejectedError(
            input.continuation.requestId,
            'invalid_request',
          ),
        );
      }
      if (
        input.rememberScopeId !== undefined &&
        (request.prompt.kind !== 'tool_permission' || !request.prompt.rememberForTurnAllowed)
      ) {
        return rejected(
          new RuntimeInteractionAdmissionRejectedError(
            input.continuation.requestId,
            'invalid_request',
          ),
        );
      }
      return this.#accept(run, {
        kind: 'permission',
        request: {
          ...runIdentity(run),
          requestId: input.continuation.requestId,
          createdAt: input.request.ts,
          request,
          ...(input.rememberScopeId === undefined
            ? {}
            : { rememberScopeId: input.rememberScopeId }),
        },
        continuation: input.continuation,
      });
    } catch (error) {
      return rejected(error);
    }
  }

  #acceptUserQuestionRequest(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['acceptUserQuestionRequest']>[0],
  ): Promise<void> {
    try {
      this.#assertAcceptable(run, input.request, input.continuation);
      let request: ReturnType<typeof projectInteractionQuestionRequest>;
      try {
        request = projectInteractionQuestionRequest({
          toolUseId: input.request.toolUseId,
          questions: input.request.questions,
        });
      } catch {
        return rejected(
          new RuntimeInteractionAdmissionRejectedError(
            input.continuation.requestId,
            'invalid_request',
          ),
        );
      }
      return observed(
        this.#accept(run, {
          kind: 'question',
          request: {
            ...runIdentity(run),
            requestId: input.continuation.requestId,
            createdAt: input.request.ts,
            request,
          },
          continuation: input.continuation,
        }).then(() => undefined),
      );
    } catch (error) {
      return rejected(error);
    }
  }

  #accept(
    run: BoundRun,
    candidate:
      | Omit<LivePermissionEntry, 'run' | 'phase'>
      | Omit<LiveQuestionEntry, 'run' | 'phase'>,
  ): Promise<HostedPermissionAdmission> {
    this.#throwIfPoisoned();
    this.#assertRunOpen(run, candidate.request.requestId);
    if (!this.#accepting) {
      return rejected(
        new RuntimeInteractionAdmissionRejectedError(
          candidate.request.requestId,
          'authority_draining',
        ),
      );
    }
    if (this.#live.has(candidate.request.requestId)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction ${candidate.request.requestId} was accepted twice`,
        ),
      );
    }
    const entry = { ...candidate, run, phase: 'admitting' as const } as LiveEntry;
    this.#live.set(entry.request.requestId, entry);
    return observed(
      this.#sessionAdmission
        .run(entry.request.sessionId, (admission) => this.#establishAdmitted(entry, admission))
        .catch((error: unknown) => {
          if (error instanceof RuntimeInteractionAdmissionRejectedError) throw error;
          throw this.#poison(error);
        }),
    );
  }

  async #establishAdmitted(
    entry: LiveEntry,
    admission: SessionAdmissionLease,
  ): Promise<HostedPermissionAdmission> {
    this.#throwIfPoisoned();
    if (!this.#accepting) {
      this.#discardAdmitting(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'authority_draining',
      );
    }
    if (entry.run.closure) {
      this.#discardAdmitting(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'run_closed',
        entry.run.closure.reason,
      );
    }
    if (entry.kind === 'permission' && entry.request.rememberScopeId !== undefined) {
      const remembered = entry.run.rememberedPermissionOutcomes.get(entry.request.rememberScopeId);
      if (remembered) {
        const established = await this.#establishRequest(entry.request);
        if (established.kind === 'not_published') {
          this.#discardAdmitting(entry);
          throw new RuntimeInteractionAdmissionRejectedError(
            entry.request.requestId,
            'not_published',
            established.failure,
          );
        }
        if (established.record.outcome) {
          this.#discardAdmitting(entry);
          throw new RuntimeInteractionAdmissionRejectedError(
            entry.request.requestId,
            'request_settled',
          );
        }
        entry.phase = 'live';
        await this.#commitSingle(entry, remembered, admission);
        return { state: 'settled' };
      }
    }
    const pending = await this.#readPending({ sessionId: entry.request.sessionId });
    if (pending.length > INTERACTION_MAX_PENDING_PER_SESSION) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Session ${entry.request.sessionId} exceeds the pending Interaction limit`,
        ),
      );
    }
    const alreadyPending = pending.some(
      (candidate) => candidate.requestId === entry.request.requestId,
    );
    if (!alreadyPending && pending.length === INTERACTION_MAX_PENDING_PER_SESSION) {
      this.#discardAdmitting(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'capacity_exceeded',
      );
    }
    const projection = projectSessionInteractions(
      alreadyPending ? pending : [...pending, entry.request],
    );
    if (!(await this.#preflightSessionSnapshot(entry.request.sessionId, projection, admission))) {
      this.#discardAdmitting(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'capacity_exceeded',
      );
    }

    const established = await this.#establishRequest(entry.request);
    if (established.kind === 'not_published') {
      this.#discardAdmitting(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'not_published',
        established.failure,
      );
    }
    if (established.record.outcome) {
      this.#discardAdmitting(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'request_settled',
      );
    }
    entry.phase = 'live';
    await this.#refreshCanonicalContinuity(entry.request.sessionId, admission);
    this.#throwIfPoisoned();
    return { state: 'pending' };
  }

  #commitPermissionAnswer(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['commitPermissionAnswer']>[0],
  ): Promise<RuntimePermissionOutcome> {
    return observed(
      this.#sessionAdmission
        .run(run.sessionId, async (admission) => {
          const record = await this.#readContinuationRecord(run, input.continuation);
          const answer = permissionInteractionAnswer(input.answer);
          this.#assertRuntimeAnswer(record.request, answer);
          if (record.outcome) return runtimePermissionOutcome(record.outcome.outcome);
          const entry = this.#requirePermissionEntry(run, input.continuation, record.request);
          const outcome = await this.#commitAnswer(
            entry,
            permissionCanonicalOutcome(input.answer, this.#now()),
            admission,
          );
          return runtimePermissionOutcome(outcome.outcome);
        })
        .catch((error: unknown) => {
          if (isExpectedRuntimeError(error)) throw error;
          throw this.#poison(error);
        }),
    );
  }

  #commitPermissionTimeout(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['commitPermissionTimeout']>[0],
  ): Promise<RuntimePermissionOutcome> {
    return observed(
      this.#sessionAdmission
        .run(run.sessionId, async (admission) => {
          const record = await this.#readContinuationRecord(run, input.continuation);
          if (record.outcome) return runtimePermissionOutcome(record.outcome.outcome);
          const entry = this.#requirePermissionEntry(run, input.continuation, record.request);
          const outcome = await this.#commitSingle(
            entry,
            { kind: 'closure', reason: 'timed_out', committedAt: this.#now() },
            admission,
          );
          return runtimePermissionOutcome(outcome.outcome);
        })
        .catch((error: unknown) => {
          if (isExpectedRuntimeError(error)) throw error;
          throw this.#poison(error);
        }),
    );
  }

  #query(
    sessionId: string,
    interactionId: string,
  ): ReturnType<InteractionOperationHandlerMap['interaction.query']> {
    return observed(
      this.#sessionAdmission.run(sessionId, async () => {
        const record = await this.#readInteraction(interactionId);
        return record?.request.sessionId === sessionId
          ? { ok: true, result: projectInteractionRecord(record) }
          : {
              ok: false,
              error: { code: 'not_found', message: 'Interaction was not found' },
            };
      }),
    );
  }

  #answer(
    input: InteractionAnswerInput,
  ): ReturnType<InteractionOperationHandlerMap['interaction.answer']> {
    return observed(
      (async () => {
        this.#throwIfPoisoned();
        const routed = await this.#readInteraction(input.interactionId);
        if (!routed) {
          return {
            ok: false,
            error: { code: 'not_found', message: 'Interaction was not found' },
          } as const;
        }
        return this.#sessionAdmission.run(routed.request.sessionId, async (admission) => {
          this.#throwIfPoisoned();
          const record = await this.#readInteraction(input.interactionId);
          if (!record) {
            throw this.#poison(
              new RuntimeInteractionInvariantError(
                `Interaction ${input.interactionId} disappeared during answer arbitration`,
              ),
            );
          }
          this.#assertExactRequest(routed.request, record.request);
          if (record.outcome) return answerOutcome(recordWithOutcome(record), input.answer);
          if (!isInteractionAnswerValidForRequest(record.request.request, input.answer)) {
            return {
              ok: false,
              error: {
                code: 'operation_conflict',
                message: 'Interaction answer does not match the pending request',
              },
            } as const;
          }
          const entry = this.#requireLiveEntry(record.request);
          const outcome = await this.#commitAnswer(
            entry,
            wireCanonicalOutcome(input.answer, this.#now()),
            admission,
          );
          return answerOutcome({ request: record.request, outcome }, input.answer);
        });
      })().catch((error: unknown) => {
        if (isExpectedRuntimeError(error)) throw error;
        throw this.#poison(error);
      }),
    );
  }

  async #commitAnswer(
    entry: LiveEntry,
    candidate: Exclude<InteractionCanonicalOutcome, { kind: 'closure' }>,
    admission: SessionAdmissionLease,
  ): Promise<StoredInteractionOutcome> {
    if (
      candidate.kind === 'permission_answer' &&
      candidate.rememberForTurn &&
      entry.request.rememberScopeId === undefined
    ) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Remembered permission ${entry.request.requestId} has no remember scope`,
        ),
      );
    }

    const target = await this.#commitOutcome(entry.request, candidate);
    const committed: CommittedEntry[] = [{ entry, outcome: target }];
    if (
      candidate.kind === 'permission_answer' &&
      candidate.rememberForTurn &&
      target.outcome.kind === 'permission_answer' &&
      target.outcome.rememberForTurn
    ) {
      const pending = await this.#readPending({
        sessionId: entry.request.sessionId,
        turnId: entry.request.turnId,
        runId: entry.request.runId,
        kind: 'permission',
      });
      const siblings = pending
        .filter(
          (request) =>
            request.rememberScopeId !== undefined &&
            request.rememberScopeId === entry.request.rememberScopeId,
        )
        .sort(compareStoredInteractionRequests);
      for (const request of siblings) {
        const sibling = this.#requireLiveEntry(request);
        committed.push({
          entry: sibling,
          outcome: await this.#commitOutcome(request, target.outcome),
        });
      }
      if (target.outcome.decision === 'allow' && entry.request.rememberScopeId !== undefined) {
        entry.run.rememberedPermissionOutcomes.set(entry.request.rememberScopeId, target.outcome);
      }
    }
    await this.#refreshCanonicalContinuity(entry.request.sessionId, admission);
    this.#throwIfPoisoned();
    for (const item of committed.sort((left, right) =>
      compareStoredInteractionRequests(left.entry.request, right.entry.request),
    )) {
      await this.#applyAndDelete(item.entry, item.outcome);
    }
    return target;
  }

  async #commitSingle(
    entry: LiveEntry,
    candidate: InteractionCanonicalOutcome,
    admission: SessionAdmissionLease,
  ): Promise<StoredInteractionOutcome> {
    const outcome = await this.#commitOutcome(entry.request, candidate);
    await this.#refreshCanonicalContinuity(entry.request.sessionId, admission);
    this.#throwIfPoisoned();
    await this.#applyAndDelete(entry, outcome);
    return outcome;
  }

  #closeRun(run: BoundRun, reason: RuntimeInteractionRunClosureReason): Promise<void> {
    try {
      this.#assertOwnedRun(run);
      this.#throwIfPoisoned();
      if (run.released) {
        throw this.#poison(
          new RuntimeInteractionInvariantError(
            `Released Interaction Run ${run.runId} cannot close`,
          ),
        );
      }
      if (run.closure) {
        if (run.closure.reason !== reason) {
          throw this.#poison(
            new RuntimeInteractionInvariantError(
              `Interaction Run ${run.runId} received conflicting close reasons`,
            ),
          );
        }
        return run.closure.task;
      }

      const closure = {} as RunClosure;
      const task = this.#sessionAdmission
        .run(run.sessionId, async (admission) => {
          this.#throwIfPoisoned();
          const pending = await this.#readPending(runIdentity(run));
          const committed: CommittedEntry[] = [];
          for (const request of pending.sort(compareStoredInteractionRequests)) {
            const entry = this.#requireLiveEntry(request);
            committed.push({
              entry,
              outcome: await this.#commitOutcome(request, {
                kind: 'closure',
                reason,
                committedAt: this.#now(),
              }),
            });
          }
          await this.#refreshCanonicalContinuity(run.sessionId, admission);
          this.#throwIfPoisoned();
          for (const item of committed) await this.#applyAndDelete(item.entry, item.outcome);
          for (const entry of this.#live.values()) {
            if (entry.run === run) {
              throw this.#poison(
                new RuntimeInteractionInvariantError(
                  `Interaction Run ${run.runId} closed with a live continuation`,
                ),
              );
            }
          }
          closure.settled = true;
        })
        .catch((error: unknown) => {
          if (error instanceof RuntimeInteractionFailStopError) throw error;
          throw this.#poison(error);
        });
      Object.assign(closure, { reason, task: observed(task), settled: false });
      run.closure = closure;
      return closure.task;
    } catch (error) {
      return rejected(error);
    }
  }

  #releaseRun(run: BoundRun): void {
    this.#throwIfPoisoned();
    if (run.released) return;
    this.#assertOwnedRun(run);
    if (!run.closure?.settled) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction Run ${run.runId} was released before durable close settled`,
        ),
      );
    }
    for (const entry of this.#live.values()) {
      if (entry.run === run) {
        throw this.#poison(
          new RuntimeInteractionInvariantError(
            `Interaction Run ${run.runId} was released with a live continuation`,
          ),
        );
      }
    }
    run.released = true;
    run.rememberedPermissionOutcomes.clear();
    this.#runs.delete(runKey(run));
  }

  async #recoverPendingAfterHostRestart(): Promise<void> {
    this.#throwIfPoisoned();
    if (this.#runs.size !== 0 || this.#live.size !== 0) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          'Interaction restart recovery began after Runtime Runs were bound',
        ),
      );
    }
    try {
      const pending = await this.#readPending();
      const sessions = new Map<string, StoredInteractionRequest[]>();
      for (const request of pending) {
        const requests = sessions.get(request.sessionId);
        if (requests) requests.push(request);
        else sessions.set(request.sessionId, [request]);
      }
      for (const [sessionId, requests] of sessions) {
        if (requests.length > INTERACTION_MAX_PENDING_PER_SESSION) {
          throw new RuntimeInteractionInvariantError(
            `Session ${sessionId} exceeds the pending Interaction limit`,
          );
        }
        await this.#sessionAdmission.run(sessionId, async (admission) => {
          for (const request of requests.sort(compareStoredInteractionRequests)) {
            await this.#commitOutcome(request, {
              kind: 'closure',
              reason: 'host_restarted',
              committedAt: this.#now(),
            });
          }
          await this.#refreshCanonicalContinuity(sessionId, admission);
          this.#throwIfPoisoned();
        });
      }
    } catch (error) {
      throw this.#poison(error);
    }
  }

  async #establishRequest(
    candidate: StoredInteractionRequest,
  ): Promise<
    | { readonly kind: 'stable'; readonly record: InteractionRecord }
    | { readonly kind: 'not_published'; readonly failure: unknown }
  > {
    this.#throwIfPoisoned();
    let result: EstablishInteractionRequestResult;
    try {
      result = await this.#store.establishRequest(candidate);
    } catch (error) {
      throw this.#poison(error);
    }
    this.#throwIfPoisoned();
    if (result.status === 'definitely_not_published') {
      return { kind: 'not_published', failure: result.failure };
    }
    if (result.status !== 'stable') throw this.#poison(result.failure);
    if (!result.matches) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Canonical Interaction request conflicts with ${candidate.requestId}`,
        ),
      );
    }
    this.#assertExactRequest(candidate, result.record.request);
    return { kind: 'stable', record: result.record };
  }

  async #commitOutcome(
    request: StoredInteractionRequest,
    candidate: InteractionCanonicalOutcome,
  ): Promise<StoredInteractionOutcome> {
    this.#throwIfPoisoned();
    let result: CommitInteractionOutcomeResult;
    try {
      result = await this.#store.commitOutcome(request.requestId, candidate);
    } catch (error) {
      throw this.#poison(error);
    }
    this.#throwIfPoisoned();
    if (result.status !== 'stable') throw this.#poison(result.failure);
    this.#assertExactRequest(request, result.record.request);
    this.#assertOutcomeIdentity(request, result.record.outcome);
    return result.record.outcome;
  }

  async #readContinuationRecord(
    run: BoundRun,
    continuation: RuntimeInteractionContinuationIdentity,
  ): Promise<InteractionRecord> {
    this.#assertRunOpen(run, continuation.requestId);
    if (continuation.turnId !== run.turnId || continuation.runId !== run.runId) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction continuation does not match Run ${run.runId}`,
        ),
      );
    }
    const record = await this.#readInteraction(continuation.requestId);
    if (!record || !continuationMatches(record.request, run, continuation)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction continuation identity changed for ${continuation.requestId}`,
        ),
      );
    }
    return record;
  }

  async #readInteraction(requestId: string): Promise<InteractionRecord | undefined> {
    this.#throwIfPoisoned();
    try {
      return await this.#store.readInteraction(requestId);
    } catch (error) {
      throw this.#poison(error);
    }
  }

  async #readPending(
    filter?: Parameters<InteractiveInteractionStoreWriterFacade['listPending']>[0],
  ): Promise<StoredInteractionRequest[]> {
    this.#throwIfPoisoned();
    try {
      return await this.#store.listPending(filter);
    } catch (error) {
      throw this.#poison(error);
    }
  }

  async #applyAndDelete(entry: LiveEntry, outcome: StoredInteractionOutcome): Promise<void> {
    this.#throwIfPoisoned();
    if (this.#live.get(entry.request.requestId) !== entry || entry.phase !== 'live') {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Live Interaction identity changed for ${entry.request.requestId}`,
        ),
      );
    }
    try {
      if (entry.kind === 'permission') {
        const projected = runtimePermissionOutcome(outcome.outcome);
        if (projected.kind === 'closure') {
          await entry.continuation.applyClosure(projected.reason);
        } else {
          await entry.continuation.applyAnswer(projected.answer);
        }
      } else {
        const projected = runtimeQuestionOutcome(outcome.outcome);
        if (projected.kind === 'closure') {
          await entry.continuation.applyClosure(projected.reason);
        } else {
          await entry.continuation.applyAnswer(projected.answer);
        }
      }
    } catch (error) {
      throw this.#poison(error);
    }
    this.#live.delete(entry.request.requestId);
  }

  #requireLiveEntry(request: StoredInteractionRequest): LiveEntry {
    const entry = this.#live.get(request.requestId);
    if (!entry || entry.phase !== 'live' || !isDeepStrictEqual(entry.request, request)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Pending Interaction ${request.requestId} has no exact live continuation`,
        ),
      );
    }
    return entry;
  }

  #requirePermissionEntry(
    run: BoundRun,
    continuation: RuntimePermissionContinuation,
    request: StoredInteractionRequest,
  ): LivePermissionEntry {
    const entry = this.#requireLiveEntry(request);
    if (entry.kind !== 'permission' || entry.run !== run || entry.continuation !== continuation) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction ${request.requestId} is not the owned permission continuation`,
        ),
      );
    }
    return entry;
  }

  #assertAcceptable(
    run: BoundRun,
    request: Pick<AnyPermissionRequestEvent | UserQuestionRequestEvent, 'requestId' | 'turnId'>,
    continuation: RuntimeInteractionContinuationIdentity,
  ): void {
    this.#assertRunOpen(run, continuation.requestId);
    if (
      request.requestId !== continuation.requestId ||
      request.turnId !== run.turnId ||
      continuation.turnId !== run.turnId ||
      continuation.runId !== run.runId
    ) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction continuation does not match Run ${run.runId}`,
        ),
      );
    }
  }

  #assertRuntimeAnswer(request: StoredInteractionRequest, answer: InteractionAnswer): void {
    if (!isInteractionAnswerValidForRequest(request.request, answer)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Runtime answer does not match Interaction ${request.requestId}`,
        ),
      );
    }
    if (
      answer.kind === 'permission' &&
      answer.rememberForTurn &&
      request.rememberScopeId === undefined
    ) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Remembered permission ${request.requestId} has no remember scope`,
        ),
      );
    }
  }

  #assertRunOpen(run: BoundRun, requestId: string): void {
    this.#assertOwnedRun(run);
    this.#throwIfPoisoned();
    if (run.released) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(`Interaction Run ${run.runId} is already released`),
      );
    }
    if (run.closure) {
      throw new RuntimeInteractionAdmissionRejectedError(
        requestId,
        'run_closed',
        run.closure.reason,
      );
    }
  }

  #assertOwnedRun(run: BoundRun): void {
    if (this.#runs.get(runKey(run)) !== run) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(`Interaction Run ownership changed for ${run.runId}`),
      );
    }
  }

  #assertExactRequest(expected: StoredInteractionRequest, actual: StoredInteractionRequest): void {
    if (!isDeepStrictEqual(expected, actual)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Canonical Interaction request conflicts with ${expected.requestId}`,
        ),
      );
    }
  }

  #assertOutcomeIdentity(
    request: StoredInteractionRequest,
    outcome: StoredInteractionOutcome,
  ): void {
    if (!sameInteraction(request, outcome)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Canonical Interaction outcome identity changed for ${request.requestId}`,
        ),
      );
    }
  }

  #discardAdmitting(entry: LiveEntry): void {
    if (entry.phase !== 'admitting' || this.#live.get(entry.request.requestId) !== entry) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction admission identity changed for ${entry.request.requestId}`,
        ),
      );
    }
    this.#live.delete(entry.request.requestId);
  }

  #throwIfPoisoned(): void {
    if (this.#poisoned) throw this.#poisoned;
  }

  #poison(cause: unknown): RuntimeInteractionFailStopError {
    if (this.#poisoned) return this.#poisoned;
    const error =
      cause instanceof RuntimeInteractionFailStopError
        ? cause
        : new RuntimeInteractionFailStopError(
            'Runtime Host Interaction coordinator entered fail-stop',
            cause,
          );
    this.#poisoned = error;
    this.#accepting = false;
    try {
      this.#onPoison(error);
    } catch {
      // The first authority failure remains canonical; composition owns poison handling.
    }
    return error;
  }
}

function runKey(identity: RuntimeInteractionRunIdentity): string {
  return JSON.stringify([identity.sessionId, identity.turnId, identity.runId]);
}

function runIdentity(identity: RuntimeInteractionRunIdentity): RuntimeInteractionRunIdentity {
  return {
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    runId: identity.runId,
  };
}

function sameRun(
  request: Pick<StoredInteractionRequest, 'sessionId' | 'turnId' | 'runId'>,
  identity: RuntimeInteractionRunIdentity,
): boolean {
  return (
    request.sessionId === identity.sessionId &&
    request.turnId === identity.turnId &&
    request.runId === identity.runId
  );
}

function sameInteraction(
  request: StoredInteractionRequest,
  outcome: StoredInteractionOutcome,
): boolean {
  return sameRun(request, outcome) && request.requestId === outcome.requestId;
}

function continuationMatches(
  request: StoredInteractionRequest,
  run: RuntimeInteractionRunIdentity,
  continuation: RuntimeInteractionContinuationIdentity,
): boolean {
  return (
    sameRun(request, run) &&
    request.requestId === continuation.requestId &&
    continuation.turnId === run.turnId &&
    continuation.runId === run.runId
  );
}

function recordWithOutcome(
  record: InteractionRecord,
): InteractionRecord & { outcome: StoredInteractionOutcome } {
  if (!record.outcome) {
    throw new RuntimeInteractionInvariantError('Expected a resolved Interaction record');
  }
  return { request: record.request, outcome: record.outcome };
}

function isExpectedRuntimeError(error: unknown): boolean {
  return (
    error instanceof RuntimeInteractionAdmissionRejectedError ||
    error instanceof RuntimeInteractionFailStopError
  );
}

function rejected<T>(error: unknown): Promise<T> {
  return observed(Promise.reject(error));
}

function observed<T>(task: Promise<T>): Promise<T> {
  void task.catch(() => undefined);
  return task;
}
