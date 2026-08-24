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
import type { SandboxBoundaryRequestEvent, UserQuestionRequestEvent } from '@maka/core/events';
import {
  isInteractionAnswerValidForRequest,
  projectInteractionSandboxBoundaryRequest,
  projectInteractionQuestionRequest,
  type InteractionCanonicalOutcome,
} from '@maka/core/interaction';
import type {
  SandboxBoundaryRequest,
  SandboxBoundarySettlement,
} from '@maka/core/sandbox-boundary';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionContinuationIdentity,
  type RuntimeInteractionRunClosureReason,
  type RuntimeInteractionRunIdentity,
  type RuntimeInteractionRunOwner,
  type RuntimeSandboxBoundaryContinuation,
  type RuntimeUserQuestionContinuation,
} from '@maka/runtime/interaction-authority';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
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
  projectInteractionRecord,
  projectSandboxBoundaryInteraction,
  projectSessionInteractions,
  questionCanonicalOutcome,
  runtimeQuestionOutcome,
} from './interaction-projection.js';
import type { InteractionOperationHandlerMap } from './operation-dispatcher.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import type { SessionPresenceReader } from './session-presence.js';

export interface HostInteractionCoordinatorOptions {
  readonly store: InteractiveInteractionStoreWriterFacade;
  readonly sandboxBoundaries: Pick<
    ExecutionSessionWriter,
    | 'createSandboxBoundaryRequest'
    | 'readSandboxBoundaryRequest'
    | 'listPendingSandboxBoundaryRequests'
    | 'settleSandboxBoundaryRequest'
    | 'listHeaders'
  >;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly sessions: SessionPresenceReader;
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
  readonly onSandboxBoundarySettled: (sessionId: string) => Promise<void> | void;
}

interface RunClosure {
  readonly reason: RuntimeInteractionRunClosureReason;
  readonly task: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  phase: 'claimed' | 'running' | 'settled' | 'failed';
}

interface BoundRun extends RuntimeInteractionRunIdentity {
  closure?: RunClosure;
  bound: boolean;
  released: boolean;
}

interface LiveEntryBase {
  readonly run: BoundRun;
  phase: 'admitting' | 'live';
}

interface LiveQuestionEntry extends LiveEntryBase {
  readonly kind: 'question';
  readonly request: StoredInteractionRequest;
  readonly continuation: RuntimeUserQuestionContinuation;
}

interface LiveSandboxBoundaryEntry extends LiveEntryBase {
  readonly kind: 'sandbox_boundary';
  readonly boundaryRequest: SandboxBoundaryRequest;
  readonly continuation: RuntimeSandboxBoundaryContinuation;
}

type LiveEntry = LiveQuestionEntry | LiveSandboxBoundaryEntry;

interface CommittedEntry {
  readonly entry: LiveQuestionEntry;
  readonly outcome: StoredInteractionOutcome;
}

interface SettledSandboxBoundaryEntry {
  readonly entry: LiveSandboxBoundaryEntry;
  readonly settlement: SandboxBoundarySettlement;
}

/** Host-epoch authority for durable Runtime Interactions. */
export class HostInteractionCoordinator implements RuntimeInteractionAuthority {
  readonly handlers: InteractionOperationHandlerMap = {
    'interaction.query': (input) => this.#query(input.sessionId, input.interactionId),
    'interaction.answer': (input) => this.#answer(input),
  };

  readonly #store: InteractiveInteractionStoreWriterFacade;
  readonly #sandboxBoundaries: HostInteractionCoordinatorOptions['sandboxBoundaries'];
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #sessions: SessionPresenceReader;
  readonly #now: () => number;
  readonly #preflightSessionSnapshot: HostInteractionCoordinatorOptions['preflightSessionSnapshot'];
  readonly #refreshCanonicalContinuity: HostInteractionCoordinatorOptions['refreshCanonicalContinuity'];
  readonly #onPoison: HostInteractionCoordinatorOptions['onPoison'];
  readonly #onSandboxBoundarySettled: HostInteractionCoordinatorOptions['onSandboxBoundarySettled'];
  readonly #runs = new Map<string, BoundRun>();
  readonly #live = new Map<string, LiveEntry>();
  #accepting = true;
  #poisoned: RuntimeInteractionFailStopError | undefined;

  constructor(options: HostInteractionCoordinatorOptions) {
    this.#store = authenticateInteractionStoreWriter(options.store);
    this.#sandboxBoundaries = options.sandboxBoundaries;
    this.#sessionAdmission = options.sessionAdmission;
    this.#sessions = options.sessions;
    this.#now = options.now ?? Date.now;
    this.#preflightSessionSnapshot = options.preflightSessionSnapshot;
    this.#refreshCanonicalContinuity = options.refreshCanonicalContinuity;
    this.#onPoison = options.onPoison;
    this.#onSandboxBoundarySettled = options.onSandboxBoundarySettled;
  }

  bindRun(identity: RuntimeInteractionRunIdentity): RuntimeInteractionRunOwner {
    this.#throwIfPoisoned();
    const key = runKey(identity);
    const existing = this.#runs.get(key);
    if (existing?.bound) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction Run is already bound: ${identity.sessionId}/${identity.turnId}/${identity.runId}`,
        ),
      );
    }
    if (!this.#accepting && !existing) {
      throw new RuntimeInteractionAdmissionRejectedError(identity.runId, 'authority_draining');
    }

    const run =
      existing ??
      ({
        ...identity,
        bound: false,
        released: false,
      } satisfies BoundRun);
    run.bound = true;
    if (!existing) this.#runs.set(key, run);
    return Object.freeze({
      ...identity,
      acceptUserQuestionRequest: (
        input: Parameters<RuntimeInteractionRunOwner['acceptUserQuestionRequest']>[0],
      ) => this.#acceptUserQuestionRequest(run, input),
      acceptSandboxBoundaryRequest: (
        input: Parameters<RuntimeInteractionRunOwner['acceptSandboxBoundaryRequest']>[0],
      ) => this.#acceptSandboxBoundaryRequest(run, input),
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

  async hasPendingSession(sessionId: string): Promise<boolean> {
    this.#throwIfPoisoned();
    for (const entry of this.#live.values()) {
      if (entry.run.sessionId === sessionId) return true;
    }
    return (
      (await this.#readPending({ sessionId })).length > 0 ||
      (await this.#readPendingSandboxBoundaries(sessionId)).length > 0
    );
  }

  assertTerminalFence(
    identity: RuntimeInteractionRunIdentity,
    admission: SessionAdmissionLease,
  ): Promise<void> {
    return observed(
      this.#sessionAdmission.runAdmitted(identity.sessionId, admission, async () => {
        this.#throwIfPoisoned();
        this.#reapSettledUnboundClosureRun(identity);
        if (this.#runs.has(runKey(identity))) {
          throw this.#poison(
            new RuntimeInteractionInvariantError(
              `Interaction Run ${identity.runId} reached its terminal fence before release`,
            ),
          );
        }
        for (const entry of this.#live.values()) {
          if (runKey(entry.run) !== runKey(identity)) continue;
          throw this.#poison(
            new RuntimeInteractionInvariantError(
              `Interaction Run ${identity.runId} reached its terminal fence with a live continuation`,
            ),
          );
        }
        const pending = await this.#readPending(identity);
        const pendingSandboxBoundaries = (
          await this.#readPendingSandboxBoundaries(identity.sessionId)
        ).filter((request) => sameSandboxBoundaryRun(request, identity));
        if (pending.length === 0 && pendingSandboxBoundaries.length === 0) return;
        throw this.#poison(
          new RuntimeInteractionInvariantError(
            `Interaction Run ${identity.runId} reached its terminal fence with durable pending requests`,
          ),
        );
      }),
    );
  }

  claimRunClosure(
    identity: RuntimeInteractionRunIdentity,
    reason: RuntimeInteractionRunClosureReason,
    admission: SessionAdmissionLease,
  ): Promise<void> {
    try {
      this.#throwIfPoisoned();
      const key = runKey(identity);
      let run = this.#runs.get(key);
      if (!run) {
        run = {
          ...identity,
          bound: false,
          released: false,
        };
        this.#runs.set(key, run);
      } else if (!sameRun(run, identity)) {
        throw this.#poison(
          new RuntimeInteractionInvariantError(
            `Interaction Run closure claim lost exact ownership for ${identity.runId}`,
          ),
        );
      }
      const closure = this.#claimRunClosure(run, reason);
      const execution = this.#sessionAdmission.runAdmitted(identity.sessionId, admission, () =>
        this.#executeRunClosure(run, closure, admission),
      );
      void execution.catch((error: unknown) => {
        this.#failClaimedRunClosure(closure, error);
      });
      return observed(execution);
    } catch (error) {
      return rejected(error);
    }
  }

  async close(): Promise<void> {
    this.beginDrain();
    this.#throwIfPoisoned();
    const pending = await this.#readPending();
    const pendingSandboxBoundaries = await this.#readAllPendingSandboxBoundaries();
    if (this.#live.size === 0 && pending.length === 0 && pendingSandboxBoundaries.length === 0) {
      this.#reapSettledUnboundClosureRuns();
    }
    if (
      this.#runs.size !== 0 ||
      this.#live.size !== 0 ||
      pending.length !== 0 ||
      pendingSandboxBoundaries.length !== 0
    ) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          'Interaction coordinator closed with active Runs, live continuations, or durable pending requests',
        ),
      );
    }
  }

  #reapSettledUnboundClosureRuns(): void {
    for (const run of [...this.#runs.values()]) {
      if (run.bound || run.closure?.phase !== 'settled') continue;
      this.#releaseRun(run);
    }
  }

  #reapSettledUnboundClosureRun(identity: RuntimeInteractionRunIdentity): void {
    const run = this.#runs.get(runKey(identity));
    if (!run || run.bound || run.closure?.phase !== 'settled') return;
    this.#releaseRun(run);
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

  #acceptSandboxBoundaryRequest(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['acceptSandboxBoundaryRequest']>[0],
  ): Promise<void> {
    try {
      this.#assertAcceptable(run, input.request, input.continuation);
      return observed(
        this.#sessionAdmission
          .run(run.sessionId, (admission) => this.#establishSandboxBoundary(run, input, admission))
          .catch((error: unknown) => {
            if (error instanceof RuntimeInteractionAdmissionRejectedError) throw error;
            throw this.#poison(error);
          }),
      );
    } catch (error) {
      return rejected(error);
    }
  }

  #accept(run: BoundRun, candidate: Omit<LiveQuestionEntry, 'run' | 'phase'>): Promise<void> {
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
    const entry: LiveQuestionEntry = { ...candidate, run, phase: 'admitting' };
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
    entry: LiveQuestionEntry,
    admission: SessionAdmissionLease,
  ): Promise<void> {
    this.#throwIfPoisoned();
    if (!this.#accepting) {
      this.#discardAdmitting(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'authority_draining',
      );
    }
    if (entry.run.closure) {
      this.#discardClosedAdmission(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'run_closed',
        entry.run.closure.reason,
      );
    }
    const pending = await this.#readPending({ sessionId: entry.request.sessionId });
    const sandboxBoundaries = await this.#readPendingSandboxBoundaries(entry.request.sessionId);
    if (pending.length + sandboxBoundaries.length > INTERACTION_MAX_PENDING_PER_SESSION) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Session ${entry.request.sessionId} exceeds the pending Interaction limit`,
        ),
      );
    }
    const alreadyPending = pending.some(
      (candidate) => candidate.requestId === entry.request.requestId,
    );
    if (
      !alreadyPending &&
      pending.length + sandboxBoundaries.length === INTERACTION_MAX_PENDING_PER_SESSION
    ) {
      this.#discardAdmitting(entry);
      throw new RuntimeInteractionAdmissionRejectedError(
        entry.request.requestId,
        'capacity_exceeded',
      );
    }
    const projection = projectSessionInteractions(
      alreadyPending ? pending : [...pending, entry.request],
      sandboxBoundaries,
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
    return;
  }

  async #establishSandboxBoundary(
    run: BoundRun,
    input: Parameters<RuntimeInteractionRunOwner['acceptSandboxBoundaryRequest']>[0],
    admission: SessionAdmissionLease,
  ): Promise<void> {
    this.#throwIfPoisoned();
    this.#assertRunOpen(run, input.request.requestId);
    if (!this.#accepting) {
      throw new RuntimeInteractionAdmissionRejectedError(
        input.request.requestId,
        'authority_draining',
      );
    }
    let projectedRequest: ReturnType<typeof projectInteractionSandboxBoundaryRequest>;
    try {
      projectedRequest = projectInteractionSandboxBoundaryRequest(input.request);
      if (projectedRequest.justification.trim() !== projectedRequest.justification) {
        throw new Error('Sandbox boundary justification is not canonical');
      }
    } catch {
      throw new RuntimeInteractionAdmissionRejectedError(
        input.request.requestId,
        'invalid_request',
      );
    }
    if (await this.#readSandboxBoundary(run.sessionId, input.request.requestId)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Sandbox boundary ${input.request.requestId} was published before Host admission`,
        ),
      );
    }
    if (this.#live.has(input.request.requestId)) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction ${input.request.requestId} was accepted twice`,
        ),
      );
    }
    const questions = await this.#readPending({ sessionId: run.sessionId });
    const sandboxBoundaries = await this.#readPendingSandboxBoundaries(run.sessionId);
    if (questions.length + sandboxBoundaries.length >= INTERACTION_MAX_PENDING_PER_SESSION) {
      throw new RuntimeInteractionAdmissionRejectedError(
        input.request.requestId,
        'capacity_exceeded',
      );
    }
    const candidate: SandboxBoundaryRequest = {
      sessionId: run.sessionId,
      requestId: input.request.requestId,
      status: 'pending',
      baseRevision: 0,
      expansion: projectedRequest.expansion,
      justification: projectedRequest.justification,
      createdAt: input.request.ts,
      turnId: run.turnId,
      runId: run.runId,
    };
    const projection = projectSessionInteractions(questions, [...sandboxBoundaries, candidate]);
    if (!(await this.#preflightSessionSnapshot(run.sessionId, projection, admission))) {
      throw new RuntimeInteractionAdmissionRejectedError(
        input.request.requestId,
        'capacity_exceeded',
      );
    }
    const boundaryRequest = await this.#createSandboxBoundaryRequest({
      sessionId: run.sessionId,
      requestId: input.request.requestId,
      turnId: run.turnId,
      runId: run.runId,
      expansion: projectedRequest.expansion,
      justification: projectedRequest.justification,
    });
    if (
      boundaryRequest.status !== 'pending' ||
      boundaryRequest.turnId !== run.turnId ||
      boundaryRequest.runId !== run.runId ||
      !isDeepStrictEqual(boundaryRequest.expansion, projectedRequest.expansion) ||
      boundaryRequest.justification !== projectedRequest.justification
    ) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Canonical sandbox boundary request conflicts with ${input.request.requestId}`,
        ),
      );
    }
    const entry: LiveSandboxBoundaryEntry = {
      kind: 'sandbox_boundary',
      run,
      boundaryRequest,
      continuation: input.continuation,
      phase: 'live',
    };
    this.#live.set(boundaryRequest.requestId, entry);
    await this.#refreshCanonicalContinuity(run.sessionId, admission);
    this.#throwIfPoisoned();
  }

  #query(
    sessionId: string,
    interactionId: string,
  ): ReturnType<InteractionOperationHandlerMap['interaction.query']> {
    return observed(
      this.#sessionAdmission.run(sessionId, async () => {
        if ((await this.#sessions.probeSessionRemoval(sessionId)).kind !== 'present') {
          return interactionNotFound();
        }
        const record = await this.#readInteraction(interactionId);
        if (record) {
          return record.request.sessionId === sessionId
            ? { ok: true, result: projectInteractionRecord(record) }
            : interactionNotFound();
        }
        const sandboxBoundary = await this.#readSandboxBoundary(sessionId, interactionId);
        return sandboxBoundary
          ? { ok: true, result: projectSandboxBoundaryInteraction(sandboxBoundary) }
          : interactionNotFound();
      }),
    );
  }

  #answer(
    input: InteractionAnswerInput,
  ): ReturnType<InteractionOperationHandlerMap['interaction.answer']> {
    return observed(
      (async () => {
        this.#throwIfPoisoned();
        return this.#sessionAdmission.run(input.sessionId, async (admission) => {
          this.#throwIfPoisoned();
          if ((await this.#sessions.probeSessionRemoval(input.sessionId)).kind !== 'present') {
            return interactionNotFound();
          }
          const record = await this.#readInteraction(input.interactionId);
          if (record) {
            if (record.request.sessionId !== input.sessionId) return interactionNotFound();
            return this.#answerQuestion(record, input.answer, admission);
          }
          const sandboxBoundary = await this.#readSandboxBoundary(
            input.sessionId,
            input.interactionId,
          );
          return sandboxBoundary
            ? this.#answerSandboxBoundary(sandboxBoundary, input.answer, admission)
            : interactionNotFound();
        });
      })().catch((error: unknown) => {
        if (isExpectedRuntimeError(error)) throw error;
        throw this.#poison(error);
      }),
    );
  }

  async #answerQuestion(
    record: InteractionRecord,
    answer: InteractionAnswerInput['answer'],
    admission: SessionAdmissionLease,
  ) {
    if (record.request.request.kind === 'sandbox_boundary') {
      return record.outcome
        ? interactionAlreadyResolved()
        : operationConflict('Sandbox boundary authority is not stored in InteractionStore');
    }
    if (record.outcome) return answerOutcome(recordWithOutcome(record), answer);
    if (record.request.request.kind !== 'question' || answer.kind !== 'question') {
      return operationConflict('Interaction answer does not match the pending request');
    }
    if (!isInteractionAnswerValidForRequest(record.request.request, answer)) {
      return operationConflict('Interaction answer does not match the pending request');
    }
    const entry = this.#requireLiveQuestion(record.request);
    const outcome = await this.#commitAnswer(
      entry,
      questionCanonicalOutcome(answer, this.#now()),
      admission,
    );
    return answerOutcome({ request: record.request, outcome }, answer);
  }

  async #answerSandboxBoundary(
    request: SandboxBoundaryRequest,
    answer: InteractionAnswerInput['answer'],
    admission: SessionAdmissionLease,
  ) {
    const snapshot = projectSandboxBoundaryInteraction(request);
    if (snapshot.status !== 'pending') {
      if (
        snapshot.status === 'answered' &&
        snapshot.outcome.kind === 'sandbox_boundary_decision' &&
        answer.kind === 'sandbox_boundary' &&
        snapshot.outcome.decision === answer.decision
      ) {
        return { ok: true, result: snapshot } as const;
      }
      return interactionAlreadyResolved();
    }
    if (answer.kind !== 'sandbox_boundary') {
      return operationConflict('Interaction answer does not match the pending request');
    }
    const entry = this.#requireLiveSandboxBoundary(request);
    const settlement = await this.#settleSandboxBoundary({
      sessionId: request.sessionId,
      requestId: request.requestId,
      decision: answer.decision,
    });
    await this.#refreshCanonicalContinuity(request.sessionId, admission);
    this.#throwIfPoisoned();
    await this.#applySandboxBoundaryDecisionAndDelete(entry, settlement);
    await this.#onSandboxBoundarySettled(request.sessionId);
    const result = projectSandboxBoundaryInteraction(settlement.request);
    if (result.status !== 'answered') {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Sandbox boundary answer ${request.requestId} did not produce an answered Interaction`,
        ),
      );
    }
    return { ok: true, result } as const;
  }

  async #commitAnswer(
    entry: LiveQuestionEntry,
    candidate: Extract<InteractionCanonicalOutcome, { kind: 'question_answer' }>,
    admission: SessionAdmissionLease,
  ): Promise<StoredInteractionOutcome> {
    const target = await this.#commitOutcome(entry.request, candidate);
    await this.#refreshCanonicalContinuity(entry.request.sessionId, admission);
    this.#throwIfPoisoned();
    await this.#applyAndDelete(entry, target);
    return target;
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
      const existing = run.closure;
      const closure = this.#claimRunClosure(run, reason);
      if (!existing) {
        const scheduled = this.#sessionAdmission.run(run.sessionId, (admission) =>
          this.#executeRunClosure(run, closure, admission),
        );
        void scheduled.catch((error: unknown) => {
          this.#failClaimedRunClosure(closure, error);
        });
      }
      return closure.task;
    } catch (error) {
      return rejected(error);
    }
  }

  #claimRunClosure(run: BoundRun, reason: RuntimeInteractionRunClosureReason): RunClosure {
    if (run.closure) return run.closure;

    let resolveClosure!: () => void;
    let rejectClosure!: (error: unknown) => void;
    const closureTask = new Promise<void>((resolve, reject) => {
      resolveClosure = resolve;
      rejectClosure = reject;
    });
    const closure: RunClosure = {
      reason,
      task: observed(closureTask),
      resolve: resolveClosure,
      reject: rejectClosure,
      phase: 'claimed',
    };
    run.closure = closure;
    return closure;
  }

  async #executeRunClosure(
    run: BoundRun,
    closure: RunClosure,
    admission: SessionAdmissionLease,
  ): Promise<void> {
    if (closure.phase === 'settled') return;
    if (closure.phase === 'failed' || closure.phase === 'running') {
      await closure.task;
      return;
    }
    closure.phase = 'running';
    try {
      this.#throwIfPoisoned();
      await Promise.all(
        [...this.#live.values()]
          .filter((entry) => entry.run === run && entry.phase === 'live')
          .map((entry) => entry.continuation.waitForPublication()),
      );
      this.#throwIfPoisoned();
      for (const entry of [...this.#live.values()]) {
        if (entry.kind === 'question' && entry.run === run && entry.phase === 'admitting') {
          this.#discardAdmitting(entry);
        }
      }
      const pending = await this.#readPending(runIdentity(run));
      const committed: CommittedEntry[] = [];
      for (const request of pending.sort(compareStoredInteractionRequests)) {
        const entry = this.#requireLiveQuestion(request);
        committed.push({
          entry,
          outcome: await this.#commitOutcome(request, {
            kind: 'closure',
            reason: closure.reason,
            committedAt: this.#now(),
          }),
        });
      }
      const settledSandboxBoundaries: SettledSandboxBoundaryEntry[] = [];
      const pendingSandboxBoundaries = (
        await this.#readPendingSandboxBoundaries(run.sessionId)
      ).filter((request) => sameSandboxBoundaryRun(request, run));
      for (const request of pendingSandboxBoundaries) {
        const entry = this.#requireLiveSandboxBoundary(request);
        settledSandboxBoundaries.push({
          entry,
          settlement: await this.#settleSandboxBoundary({
            sessionId: request.sessionId,
            requestId: request.requestId,
            decision: 'deny',
            closureReason: closure.reason,
          }),
        });
      }
      await this.#refreshCanonicalContinuity(run.sessionId, admission);
      this.#throwIfPoisoned();
      for (const item of committed) await this.#applyAndDelete(item.entry, item.outcome);
      for (const item of settledSandboxBoundaries) {
        await this.#applySandboxBoundaryClosureAndDelete(
          item.entry,
          item.settlement,
          closure.reason,
        );
      }
      for (const entry of this.#live.values()) {
        if (entry.run === run) {
          throw this.#poison(
            new RuntimeInteractionInvariantError(
              `Interaction Run ${run.runId} closed with a live continuation`,
            ),
          );
        }
      }
      closure.phase = 'settled';
      closure.resolve();
    } catch (error) {
      const failure =
        error instanceof RuntimeInteractionFailStopError ? error : this.#poison(error);
      closure.phase = 'failed';
      closure.reject(failure);
      throw failure;
    }
  }

  #failClaimedRunClosure(closure: RunClosure, error: unknown): void {
    if (closure.phase !== 'claimed') return;
    const failure = error instanceof RuntimeInteractionFailStopError ? error : this.#poison(error);
    closure.phase = 'failed';
    closure.reject(failure);
  }

  #releaseRun(run: BoundRun): void {
    this.#throwIfPoisoned();
    if (run.released) return;
    this.#assertOwnedRun(run);
    if (run.closure?.phase !== 'settled') {
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
      const sessions = new Map<
        string,
        {
          questions: StoredInteractionRequest[];
          sandboxBoundaries: SandboxBoundaryRequest[];
        }
      >();
      const pendingQuestions = await this.#readPending();
      const pendingSandboxBoundaries = await this.#readAllPendingSandboxBoundaries();
      for (const request of pendingQuestions) {
        const requests = sessions.get(request.sessionId);
        if (requests) requests.questions.push(request);
        else sessions.set(request.sessionId, { questions: [request], sandboxBoundaries: [] });
      }
      for (const request of pendingSandboxBoundaries) {
        const requests = sessions.get(request.sessionId);
        if (requests) requests.sandboxBoundaries.push(request);
        else sessions.set(request.sessionId, { questions: [], sandboxBoundaries: [request] });
      }
      for (const [sessionId, requests] of sessions) {
        if (
          requests.questions.length + requests.sandboxBoundaries.length >
          INTERACTION_MAX_PENDING_PER_SESSION
        ) {
          throw new RuntimeInteractionInvariantError(
            `Session ${sessionId} exceeds the pending Interaction limit`,
          );
        }
        await this.#sessionAdmission.run(sessionId, async (admission) => {
          for (const request of requests.questions.sort(compareStoredInteractionRequests)) {
            await this.#commitOutcome(request, {
              kind: 'closure',
              reason: 'host_restarted',
              committedAt: this.#now(),
            });
          }
          for (const request of requests.sandboxBoundaries) {
            await this.#settleSandboxBoundary({
              sessionId,
              requestId: request.requestId,
              decision: 'deny',
              closureReason: 'host_restarted',
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

  async #readSandboxBoundary(
    sessionId: string,
    requestId: string,
  ): Promise<SandboxBoundaryRequest | undefined> {
    this.#throwIfPoisoned();
    try {
      return await this.#sandboxBoundaries.readSandboxBoundaryRequest(sessionId, requestId);
    } catch (error) {
      throw this.#poison(error);
    }
  }

  async #createSandboxBoundaryRequest(
    input: Parameters<ExecutionSessionWriter['createSandboxBoundaryRequest']>[0],
  ): Promise<SandboxBoundaryRequest> {
    this.#throwIfPoisoned();
    try {
      const request = await this.#sandboxBoundaries.createSandboxBoundaryRequest(input);
      this.#throwIfPoisoned();
      return request;
    } catch (error) {
      throw this.#poison(error);
    }
  }

  async #readPendingSandboxBoundaries(sessionId: string): Promise<SandboxBoundaryRequest[]> {
    this.#throwIfPoisoned();
    try {
      return await this.#sandboxBoundaries.listPendingSandboxBoundaryRequests(sessionId);
    } catch (error) {
      throw this.#poison(error);
    }
  }

  async #readAllPendingSandboxBoundaries(): Promise<SandboxBoundaryRequest[]> {
    this.#throwIfPoisoned();
    try {
      const headers = await this.#sandboxBoundaries.listHeaders();
      const pending = await Promise.all(
        headers.map((header) =>
          this.#sandboxBoundaries.listPendingSandboxBoundaryRequests(header.id),
        ),
      );
      return pending.flat();
    } catch (error) {
      throw this.#poison(error);
    }
  }

  async #settleSandboxBoundary(
    input: Parameters<ExecutionSessionWriter['settleSandboxBoundaryRequest']>[0],
  ): Promise<SandboxBoundarySettlement> {
    this.#throwIfPoisoned();
    try {
      const settlement = await this.#sandboxBoundaries.settleSandboxBoundaryRequest(input);
      this.#throwIfPoisoned();
      return settlement;
    } catch (error) {
      throw this.#poison(error);
    }
  }

  async #applyAndDelete(
    entry: LiveQuestionEntry,
    outcome: StoredInteractionOutcome,
  ): Promise<void> {
    this.#throwIfPoisoned();
    if (this.#live.get(entry.request.requestId) !== entry || entry.phase !== 'live') {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Live Interaction identity changed for ${entry.request.requestId}`,
        ),
      );
    }
    try {
      const projected = runtimeQuestionOutcome(outcome.outcome);
      if (projected.kind === 'closure') {
        await entry.continuation.applyClosure(projected.reason);
      } else {
        await entry.continuation.applyAnswer(projected.answer);
      }
    } catch (error) {
      throw this.#poison(error);
    }
    this.#live.delete(entry.request.requestId);
  }

  async #applySandboxBoundaryDecisionAndDelete(
    entry: LiveSandboxBoundaryEntry,
    settlement: SandboxBoundarySettlement,
  ): Promise<void> {
    this.#assertLiveSandboxBoundarySettlement(entry, settlement);
    try {
      await entry.continuation.applyDecision(settlement);
    } catch (error) {
      throw this.#poison(error);
    }
    this.#live.delete(entry.boundaryRequest.requestId);
  }

  async #applySandboxBoundaryClosureAndDelete(
    entry: LiveSandboxBoundaryEntry,
    settlement: SandboxBoundarySettlement,
    reason: RuntimeInteractionRunClosureReason,
  ): Promise<void> {
    this.#assertLiveSandboxBoundarySettlement(entry, settlement);
    if (settlement.request.status !== 'denied' || settlement.request.outcomeReason !== reason) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Sandbox boundary closure ${entry.boundaryRequest.requestId} did not commit exact closure`,
        ),
      );
    }
    try {
      await entry.continuation.applyClosure(reason);
    } catch (error) {
      throw this.#poison(error);
    }
    this.#live.delete(entry.boundaryRequest.requestId);
  }

  #assertLiveSandboxBoundarySettlement(
    entry: LiveSandboxBoundaryEntry,
    settlement: SandboxBoundarySettlement,
  ): void {
    if (
      this.#live.get(entry.boundaryRequest.requestId) !== entry ||
      entry.phase !== 'live' ||
      settlement.request.status === 'pending' ||
      !sameSandboxBoundaryIdentity(entry.boundaryRequest, settlement.request)
    ) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Live sandbox boundary identity changed for ${entry.boundaryRequest.requestId}`,
        ),
      );
    }
  }

  #requireLiveQuestion(request: StoredInteractionRequest): LiveQuestionEntry {
    const entry = this.#live.get(request.requestId);
    if (
      !entry ||
      entry.kind !== 'question' ||
      entry.phase !== 'live' ||
      !isDeepStrictEqual(entry.request, request)
    ) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Pending question Interaction ${request.requestId} has no exact live continuation`,
        ),
      );
    }
    return entry;
  }

  #requireLiveSandboxBoundary(request: SandboxBoundaryRequest): LiveSandboxBoundaryEntry {
    const entry = this.#live.get(request.requestId);
    if (
      !entry ||
      entry.kind !== 'sandbox_boundary' ||
      entry.phase !== 'live' ||
      !sameSandboxBoundaryIdentity(entry.boundaryRequest, request)
    ) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Pending sandbox boundary ${request.requestId} has no exact live continuation`,
        ),
      );
    }
    return entry;
  }

  #assertAcceptable(
    run: BoundRun,
    request: Pick<UserQuestionRequestEvent, 'requestId' | 'turnId'>,
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

  #discardAdmitting(entry: LiveQuestionEntry): void {
    if (entry.phase !== 'admitting' || this.#live.get(entry.request.requestId) !== entry) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction admission identity changed for ${entry.request.requestId}`,
        ),
      );
    }
    this.#live.delete(entry.request.requestId);
  }

  #discardClosedAdmission(entry: LiveQuestionEntry): void {
    const owned = this.#live.get(entry.request.requestId);
    if (owned === undefined) return;
    if (owned !== entry) {
      throw this.#poison(
        new RuntimeInteractionInvariantError(
          `Interaction admission identity changed for ${entry.request.requestId}`,
        ),
      );
    }
    this.#discardAdmitting(entry);
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

function interactionNotFound() {
  return {
    ok: false,
    error: { code: 'not_found', message: 'Interaction was not found' },
  } as const;
}

function operationConflict(message: string) {
  return {
    ok: false,
    error: { code: 'operation_conflict', message },
  } as const;
}

function interactionAlreadyResolved() {
  return {
    ok: false,
    error: { code: 'already_resolved', message: 'Interaction was already resolved' },
  } as const;
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

function sameSandboxBoundaryRun(
  request: SandboxBoundaryRequest,
  identity: RuntimeInteractionRunIdentity,
): boolean {
  return (
    request.sessionId === identity.sessionId &&
    request.turnId === identity.turnId &&
    request.runId === identity.runId
  );
}

function sameSandboxBoundaryIdentity(
  expected: SandboxBoundaryRequest,
  actual: SandboxBoundaryRequest,
): boolean {
  return (
    expected.sessionId === actual.sessionId &&
    expected.requestId === actual.requestId &&
    expected.baseRevision === actual.baseRevision &&
    expected.turnId === actual.turnId &&
    expected.runId === actual.runId &&
    expected.createdAt === actual.createdAt &&
    expected.justification === actual.justification &&
    isDeepStrictEqual(expected.expansion, actual.expansion)
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
