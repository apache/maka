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

import { HostGoalEventWaitBridge, type HostGoalEventWaitSources } from './goal-event-waits.js';
import type { GoalWaitSnapshot } from '@maka/storage/event-wait-bridge';
import { randomUUID } from 'node:crypto';
import {
  sameGoalControlLease,
  type GoalAuthorityRecord,
  type GoalControlLease as DurableGoalControlLease,
  type GoalCurrentExecution,
  type GoalPendingContinuation,
  type GoalState as DurableGoalState,
} from '@maka/core/goal';
import { type StoredMessage } from '@maka/core/session';
import {
  GoalContinuationCoordinator,
  type GoalSessionCloseOperation,
  type GoalObservedTurnStart,
  type GoalTurnAdmission,
  type GoalTurnOutcome,
} from '@maka/runtime/goal-continuation';
import {
  GoalManager,
  TERMINAL_GOAL_STATUSES,
  type GoalCheckpoint,
  type GoalControlLease,
  type GoalState,
} from '@maka/runtime/goal-state';
import { buildGoalTools } from '@maka/runtime/goal-tools';
import { type GoalEvaluatorResource } from '@maka/runtime/goal-evaluator';
import { type MakaTool } from '@maka/runtime/tool-runtime';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  authenticateInteractiveGoalAuthorityWriter,
  type GoalAuthoritySnapshot,
  type InteractiveGoalAuthorityWriter,
} from '@maka/storage/goal-authority';
import type {
  GoalArmInput,
  GoalControlInput,
  GoalProjection,
  OperationOutcome,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { HostResidencyKind } from './host-residency-registry.js';
import type { GoalOperationHandlerMap } from './operation-dispatcher.js';
import { projectGoalState } from './goal-projection.js';
import {
  GOAL_EVENT_WAIT_SUMMARY_LIMITS,
  type GoalEventWaitCancelInput,
  type GoalEventWaitCancelResult,
} from '../protocol/goal.js';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  type HostedExecutionAuthority,
  type HostedExecutionCompletion,
  type HostedExecutionCompletionObserver,
  type HostedExecutionObservation,
} from './hosted-execution-authority.js';
import { waitForHostedExecutionTerminal } from './hosted-execution-wait.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { goalTurnOutcomeFromHostedExecution } from './goal-execution-coordinator.js';
import { buildGoalEvaluationContext } from './goal-evaluation-context.js';
import type { GoalFormAnswer, GoalFormToolReference } from './goal-form-evidence.js';

type GoalStores = Pick<ExecutionStoresWriter<'interactive'>, 'sessionStore' | 'agentRunStore'> &
  Partial<Pick<ExecutionStoresWriter<'interactive'>, 'eventWaitStore' | 'runtimeEventStore'>>;

export interface HostGoalCoordinatorOptions {
  readonly store: InteractiveGoalAuthorityWriter;
  readonly stores: GoalStores;
  /** Evidence from one canonical Session transcript snapshot. */
  readonly readSessionContext: (sessionId: string) => Promise<{
    readonly messages: readonly StoredMessage[];
    readonly formAnswers?: readonly GoalFormAnswer[];
    readonly unreadFormTools?: readonly GoalFormToolReference[];
  }>;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly evaluator: GoalEvaluatorResource;
  readonly executions: Pick<HostedExecutionAuthority, 'reconcile' | 'subscribe'>;
  readonly admitTurn: (
    sessionId: string,
    text: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
    eventWait?: GoalPendingContinuation['eventWait'],
  ) => GoalTurnAdmission;
  readonly acquireResidency: (kind?: HostResidencyKind) => RuntimeHostResidency;
  readonly onProjectionChanged: (sessionId: string) => void;
  readonly requestDrain: () => void;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly eventWaitSources?: HostGoalEventWaitSources;
}

export interface HostGoalSessionRetirement {
  commit(): void;
  rollback(): void;
}

/** Durable Runtime Host authority for one Goal generation per Session. */
export class HostGoalCoordinator {
  readonly handlers: GoalOperationHandlerMap = {
    'goal.query': (input) => this.#query(input.sessionId),
    'goal.arm': (input) => this.#arm(input),
    'goal.control': (input) => this.#control(input),
    'goal.event-wait.cancel': (input) => this.#cancelEventWait(input),
  };

  readonly manager: GoalManager;
  readonly continuation: GoalContinuationCoordinator;
  readonly tools: readonly MakaTool[];
  readonly #store: InteractiveGoalAuthorityWriter;
  readonly #stores: GoalStores;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #residencies = new Map<string, RuntimeHostResidency>();
  readonly #onProjectionChanged: (sessionId: string) => void;
  readonly #newId: () => string;
  readonly #requestDrain: () => void;
  readonly #acquireResidency: HostGoalCoordinatorOptions['acquireResidency'];
  readonly #executions: Pick<HostedExecutionAuthority, 'reconcile' | 'subscribe'>;
  readonly #authorityBySession = new Map<string, GoalAuthoritySnapshot>();
  /**
   * Token count per Session as of the last continuation read, which is what a
   * settling Turn reports so the Goal can measure its budget. It is not a
   * baseline for a new Goal: only evaluation context reads refresh it. A Session that
   * has never run one has no entry, and `tokensBaselinePending` on the Goal is
   * what carries that until the first Turn carrying it settles.
   */
  readonly #tokenCache = new Map<string, number>();
  readonly #recoveryWaits = new Set<Promise<void>>();
  readonly #recoveryAbort = new AbortController();
  readonly #queuedAuthorityCommits = new Map<
    string,
    {
      readonly expectedAuthorityRevision: number | null;
      readonly nextAuthorityRevision: number;
      record: GoalAuthorityRecord | null;
      started: boolean;
    }
  >();
  #persistenceLane: Promise<void> = Promise.resolve();
  #persistenceFailure: unknown;
  readonly eventWaitBridge?: HostGoalEventWaitBridge;
  #jointLane: Promise<unknown> = Promise.resolve();
  #jointBusy = false;
  readonly #deferredGoalChanges: Array<[DurableGoalState, DurableGoalControlLease]> = [];
  #prepared = false;
  #draining = false;

  constructor(options: HostGoalCoordinatorOptions) {
    this.#store = authenticateInteractiveGoalAuthorityWriter(options.store);
    this.#stores = options.stores;
    this.#sessionAdmission = options.sessionAdmission;
    this.#onProjectionChanged = options.onProjectionChanged;
    const now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#requestDrain = options.requestDrain;
    this.#acquireResidency = options.acquireResidency;
    this.#executions = options.executions;
    this.manager = new GoalManager({
      generateId: this.#newId,
      now,
      onChange: (goal, controlLease) => {
        this.#enqueueGoalState(goal, controlLease);
        this.#syncResidency(goal, options.acquireResidency);
        this.#onProjectionChanged(goal.sessionId);
      },
    });
    const tokenCache = this.#tokenCache;
    this.continuation = new GoalContinuationCoordinator({
      goalManager: this.manager,
      eventWait: {
        isGated: (sessionId) => !!this.#authorityBySession.get(sessionId)?.record.activeEventWait,
        ownsSource: (sessionId, turnId, controlLease) => {
          const record = this.#authorityBySession.get(sessionId)?.record;
          const gate = record?.activeEventWait;
          return (
            record?.goal.status === 'active' &&
            !!gate &&
            !gate.settled &&
            gate.sourceExecution.sessionId === sessionId &&
            gate.sourceExecution.turnId === turnId &&
            sameGoalControlLease(gate.controlLease, controlLease) &&
            sameGoalControlLease(record.controlLease, controlLease)
          );
        },
        settleCompleted: async (sessionId, turnId, controlLease) => {
          if (!this.eventWaitBridge) throw new Error('Event wait persistence is unavailable');
          await this.eventWaitBridge.settleCompleted(sessionId, turnId, controlLease);
        },
      },
      mutateGoal: (operation) =>
        this.#mutateGoal(() =>
          operation({
            recordPendingContinuation: (pending) =>
              this.#recordPendingContinuation(pending, () => this.#flushGoalPersistence()),
          }),
        ),
      acquireActivity: () => this.#acquireResidency(),
      evaluator: options.evaluator,
      getRecentContext: async (sessionId) => {
        const controlLease = this.manager.getControlLease(sessionId);
        const { messages, formAnswers, unreadFormTools } =
          await options.readSessionContext(sessionId);
        if (controlLease && this.manager.matchesControlLease(sessionId, controlLease)) {
          tokenCache.set(sessionId, tokenCount(messages));
        }
        return buildGoalEvaluationContext(messages, formAnswers, unreadFormTools);
      },
      getTokenCount: (sessionId) => tokenCache.get(sessionId) ?? 0,
      admitTurn: options.admitTurn,
      durability: {
        flush: (sessionId) => this.#flushGoalState(sessionId),
        recordPendingContinuation: (pending) => this.#recordPendingContinuation(pending),
        clearPendingContinuation: (sessionId, controlLease) =>
          this.#clearPendingContinuation(sessionId, controlLease),
        recordCurrentExecution: (current) => this.#recordCurrentExecution(current),
        settleCurrentExecution: (sessionId, turnId) =>
          this.#settleCurrentExecution(sessionId, turnId),
      },
    });
    if (options.stores.eventWaitStore && options.stores.runtimeEventStore) {
      this.eventWaitBridge = new HostGoalEventWaitBridge(
        {
          stores: {
            eventWaitStore: options.stores.eventWaitStore,
            runtimeEventStore: options.stores.runtimeEventStore,
            agentRunStore: options.stores.agentRunStore,
          },
          authority: (sessionId) => this.#authorityBySession.get(sessionId),
          changed: this.#onProjectionChanged,
          mutate: (sessionId, operation) => this.#mutateWait(sessionId, operation),
          settleAdditional: (sessionId, tokensNow, controlLease) =>
            this.#mutateGoal(async () => {
              const goal = this.manager.get(sessionId);
              if (
                goal?.status === 'active' &&
                this.manager.matchesControlLease(sessionId, controlLease)
              )
                this.manager.settleTurn(sessionId, {
                  checkpoint: { goalId: goal.id, revision: goal.revision },
                  verdict: 'continue',
                  tokensNow,
                  reason: goal.lastReason ?? 'Explicit event wait remains outstanding.',
                });
            }),
          getTokens: async (sessionId, throughTurnId) => {
            const { messages } = await options.readSessionContext(sessionId);
            return tokenCount(messages, throughTurnId);
          },
          gate: (sessionId) => this.continuation.gateEventWait(sessionId),
          canRegister: (sessionId, turnId) =>
            this.continuation.mutationStanding(sessionId, turnId).kind === 'held',
          deliver: (pending) => this.continuation.recoverPendingContinuation(pending),
          pause: (sessionId, reason, controlLease, waitId) =>
            this.#mutateGoal(async () => {
              if (
                !this.manager.matchesControlLease(sessionId, controlLease) ||
                this.#authorityBySession.get(sessionId)?.record.activeEventWait?.waitId !== waitId
              )
                return;
              this.manager.pause(sessionId, { reason });
              this.continuation.invalidateSession(sessionId);
            }),
          onError: (error) => {
            this.#persistenceFailure ??= error;
            this.#requestDrain();
          },
          now,
          newId: this.#newId,
        },
        options.eventWaitSources,
      );
    }
    this.tools = Object.freeze([
      ...buildGoalTools({
        goalManager: this.manager,
        goalContinuation: this.continuation,
        isAvailable: () => !this.#draining,
        // These tool implementations execute inside the same lane as joint writes.
        flush: () => this.#flushGoalPersistence(),
        now,
      }).map(
        (tool): MakaTool => ({
          ...tool,
          impl: (input, context) => this.#mutateGoal(() => tool.impl(input, context)),
        }),
      ),
      ...(this.eventWaitBridge?.tools ?? []),
    ]);
  }

  async prepareRecovery(): Promise<void> {
    if (this.#prepared) return;
    for (const snapshot of await this.#store.list()) {
      const { goal, controlLease } = snapshot.record;
      try {
        const header = await this.#stores.sessionStore.readHeaderSnapshot(goal.sessionId);
        if (header.isArchived) {
          await this.#deleteOrphanedAuthority(snapshot);
          continue;
        }
      } catch (error) {
        if (!isSessionNotFoundError(error)) throw error;
        await this.#deleteOrphanedAuthority(snapshot);
        continue;
      }
      if (this.#authorityBySession.has(goal.sessionId)) {
        throw new Error(`Session ${goal.sessionId} has duplicate durable Goal authority`);
      }
      this.#authorityBySession.set(goal.sessionId, snapshot);
      this.manager.restore(goal, controlLease);
      this.#syncResidency(goal, this.#acquireResidency);
    }
    this.#prepared = true;
  }

  /**
   * Resume the Goal loop where the last Host epoch left it.
   *
   * A durable Goal with no execution of its own is either between
   * continuations or has never run at all, and `status` cannot tell those
   * apart: `goal.arm` persists an `active` Goal that takes hold on the user's
   * next Turn, and arming alone starts nothing. Telling them apart is the
   * continuation's own rule — only a settled Turn ever starts a Goal driving,
   * so only a Goal a Turn has carried has a drive to restore — and
   * `recoverActiveGoal` holds it for every caller. Recovery hands it each
   * Goal and lets it decide, rather than keeping a second copy of the rule
   * here that a later change could contradict. An execution that was in
   * flight is its own proof of carrying, so that branch recovers directly.
   */
  async recover(): Promise<void> {
    if (!this.#prepared) throw new Error('Goal recovery was not prepared');
    for (const snapshot of this.#authorityBySession.values()) {
      if (snapshot.record.currentExecution) {
        await this.#recoverCurrentExecution(snapshot.record.currentExecution);
      } else if (snapshot.record.pendingContinuation) {
        this.continuation.recoverPendingContinuation(snapshot.record.pendingContinuation);
      } else {
        this.continuation.recoverActiveGoal(snapshot.record.goal.sessionId);
      }
    }
    await this.eventWaitBridge?.start();
  }

  readProjection(sessionId: string): Promise<GoalProjection | null> {
    // Canonical/query callers hold the Session lane. Do not wait for the
    // mutation lane here: a committed wait write can have a delayed receipt
    // while Root admission must still publish and start. #project rechecks the
    // adopted binding after I/O and excludes durably admitted/suppressed waits.
    return this.#project(sessionId);
  }

  async #project(sessionId: string): Promise<GoalProjection | null> {
    const authority = this.#authorityBySession.get(sessionId);
    const gate = authority?.record.activeEventWait;
    const wait =
      gate && this.#stores.eventWaitStore
        ? await this.#stores.eventWaitStore.read({ sessionId, waitId: gate.waitId })
        : undefined;
    const goal = this.manager.get(sessionId);
    if (!goal) return null;
    const projection = projectGoalState(goal);
    const current = this.#authorityBySession.get(sessionId);
    if (
      !wait ||
      !gate ||
      !current ||
      current.record.activeEventWait?.waitId !== gate.waitId ||
      !sameGoalControlLease(current.record.controlLease, wait.record.goalControlLease) ||
      !this.manager.matchesControlLease(sessionId, wait.record.goalControlLease) ||
      wait.record.delivery ||
      wait.record.status === 'cancelled' ||
      !['active', 'waiting'].includes(goal.status)
    )
      return projection;
    const r = wait.record,
      observation = r.observation;
    // Checking is an attempt reservation, not a new source fact. Its retained
    // checkpoint describes the last completed observation until this read settles.
    const observationOutcome =
      observation?.outcome === 'checking' && observation.lastObservedAt !== null
        ? observation.consecutiveErrors > 0
          ? 'unknown'
          : 'pending'
        : observation?.outcome;
    return {
      ...projection,
      eventWait: {
        waitId: r.waitId,
        controlGeneration: r.goalControlLease.generation,
        waitRevision: wait.authorityRevision,
        resource: {
          providerId: r.resource.providerId,
          resourceType: r.resource.resourceType,
          resourceId: truncateUtf8(
            r.resource.resourceId,
            GOAL_EVENT_WAIT_SUMMARY_LIMITS.resourceIdBytes,
            '…',
          ),
        },
        reason: gate.reason,
        deadlineAt: r.deadlineAt,
        phase: r.status === 'waiting' ? 'observing' : 'awaiting_admission',
        observation:
          r.status !== 'waiting'
            ? null
            : {
                state:
                  observationOutcome === 'unknown'
                    ? 'unknown'
                    : observationOutcome === 'pending'
                      ? 'pending'
                      : 'checking',
                lastObservedAt: observation?.lastObservedAt ?? null,
                reasonCode: observation?.reason
                  ? truncateUtf8(
                      observation.reason,
                      GOAL_EVENT_WAIT_SUMMARY_LIMITS.reasonCodeBytes,
                      '…',
                    )
                  : null,
              },
        outcome:
          r.status === 'resolved'
            ? r.resolution.outcome
            : r.status === 'expired'
              ? 'expired'
              : null,
      },
    };
  }

  #cancelEventWait(
    input: GoalEventWaitCancelInput,
  ): Promise<OperationOutcome<'goal.event-wait.cancel'>> {
    return this.#sessionAdmission.run(input.sessionId, () =>
      this.#mutateGoal(async () => {
        if (this.#draining) return hostDraining();
        let header;
        try {
          header = await this.#stores.sessionStore.readHeaderSnapshot(input.sessionId);
        } catch (error) {
          if (isSessionNotFoundError(error)) return notFound('Session does not exist');
          throw error;
        }
        if (header.isArchived) return sessionArchived('Archived Session cannot cancel a wait');
        const wait = await this.#stores.eventWaitStore?.read({
          sessionId: input.sessionId,
          waitId: input.waitId,
        });
        const current = this.#authorityBySession.get(input.sessionId)?.record;
        let outcome: GoalEventWaitCancelResult['outcome'] = 'conflict';
        if (
          wait?.record.goalControlLease.goalId === input.goalId &&
          wait.record.goalControlLease.generation === input.controlGeneration
        ) {
          if (wait.record.delivery?.kind === 'admitted') outcome = 'already_admitted';
          else if (
            wait.record.status === 'cancelled' ||
            wait.record.delivery?.kind === 'suppressed'
          )
            outcome = 'already_cancelled';
          else if (
            current?.activeEventWait?.waitId === input.waitId &&
            current.goal.id === input.goalId &&
            current.controlLease.generation === input.controlGeneration &&
            current.goal.revision === input.expectedGoalRevision
          ) {
            this.manager.pause(input.sessionId, {
              reason: 'Event wait cancelled. The background task keeps running.',
            });
            this.continuation.invalidateSession(input.sessionId);
            await this.#flushGoalPersistence();
            outcome = 'cancelled';
          }
        }
        return {
          ok: true,
          result: {
            sessionId: input.sessionId,
            outcome,
            goal: await this.#project(input.sessionId),
          },
        };
      }),
    );
  }

  beginObservedTurn(sessionId: string, turnId: string): GoalObservedTurnStart {
    return this.continuation.beginObservedTurn(sessionId, turnId);
  }

  begin(input: HostedExecutionObservation): HostedExecutionCompletionObserver | undefined {
    if (input.descriptor.kind === 'goal' || input.descriptor.kind === 'context_compact') {
      return undefined;
    }
    const registration = this.continuation.beginObservedTurn(input.sessionId, input.turnId);
    if (registration.kind !== 'registered') return undefined;
    return (completion) =>
      registration.settle(goalOutcomeFromCompletion(completion)).catch((error) => {
        this.#persistenceFailure ??= error;
        this.#requestDrain();
      });
  }

  matchesActive(
    sessionId: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
  ): boolean {
    return (
      this.manager.matchesActive(sessionId, checkpoint) &&
      this.manager.matchesControlLease(sessionId, controlLease)
    );
  }

  hasLiveGoal(sessionId: string): boolean {
    const goal = this.manager.get(sessionId);
    return goal !== undefined && !TERMINAL_GOAL_STATUSES.has(goal.status);
  }

  async beginSessionRetirement(
    sessionIds: readonly string[],
    kind: 'archive' | 'remove',
  ): Promise<HostGoalSessionRetirement> {
    const unique = [...new Set(sessionIds)];
    if (unique.some((sessionId) => this.hasLiveGoal(sessionId))) {
      throw new Error('Session retirement cannot revoke a live Goal');
    }
    const operations = new Map<string, GoalSessionCloseOperation>();
    for (const sessionId of unique) {
      operations.set(sessionId, this.continuation.beginSessionClose(sessionId, kind));
    }
    try {
      await Promise.all(unique.map((sessionId) => this.#flushGoalState(sessionId)));
    } catch (error) {
      for (const operation of operations.values()) operation.rollback();
      throw error;
    }
    let settled = false;
    return Object.freeze({
      commit: () => {
        if (settled) return;
        settled = true;
        for (const sessionId of unique) {
          operations.get(sessionId)?.commit();
          this.#authorityBySession.delete(sessionId);
          this.#tokenCache.delete(sessionId);
          if (this.manager.remove(sessionId)) this.#onProjectionChanged(sessionId);
        }
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        for (const operation of operations.values()) operation.rollback();
      },
    });
  }

  unarchiveSessions(sessionIds: readonly string[]): void {
    for (const sessionId of new Set(sessionIds)) {
      this.continuation.unarchiveSession(sessionId);
    }
  }

  holdForHandoff():
    | {
        settled(): Promise<void>;
        residencies(
          executions: readonly { sessionId: string; turnId: string; runId: string }[],
        ): Promise<readonly RuntimeHostResidency[] | undefined>;
        release(): void;
      }
    | undefined {
    if (this.#draining) return undefined;
    const hold = this.continuation.holdForHandoff();
    if (!hold) return undefined;
    const settled = async () => {
      await hold.settled();
      await this.#flushGoalState();
    };
    return {
      settled,
      release: hold.release,
      residencies: async (executions) => {
        await settled();
        if (this.#draining) return undefined;
        for (const [sessionId] of this.#residencies) {
          const authority = this.#authorityBySession.get(sessionId);
          if (!authority) return undefined;
          const current = authority.record.currentExecution;
          const paused = executions.find((execution) => execution.sessionId === sessionId);
          // An observed external turn is not a durable Goal execution. Its
          // in-memory completion registration cannot be silently discarded.
          if (
            paused &&
            (!current ||
              current.execution.turnId !== paused.turnId ||
              current.execution.runId !== paused.runId)
          )
            return undefined;
          if (current && !paused) return undefined;
          if (current && !this.matchesActive(sessionId, current.checkpoint, current.controlLease))
            return undefined;
        }
        return [...this.#residencies.values()];
      },
    };
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#recoveryAbort.abort();
    this.eventWaitBridge?.beginDrain();
    this.continuation.dispose();
    this.manager.dispose();
    this.#tokenCache.clear();
    for (const residency of this.#residencies.values()) residency.release();
    this.#residencies.clear();
  }

  close(): Promise<void> {
    this.beginDrain();
    return Promise.all([
      this.continuation.close(),
      this.eventWaitBridge?.close(),
      this.#jointLane,
      this.#flushGoalState(),
      ...this.#recoveryWaits,
    ]).then(() => undefined);
  }

  #query(sessionId: string): Promise<OperationOutcome<'goal.query'>> {
    return this.#sessionAdmission.run(sessionId, async () => {
      await this.#flushGoalState(sessionId);
      try {
        await this.#stores.sessionStore.readHeaderSnapshot(sessionId);
      } catch (error) {
        if (isSessionNotFoundError(error)) return notFound('Session does not exist');
        throw error;
      }
      return {
        ok: true,
        result: { sessionId, goal: await this.readProjection(sessionId) },
      };
    });
  }

  /**
   * Arm a Goal from outside a Turn — the Host's own entry point for a user who
   * asked for one, next to the GoalSet tool the model uses from inside a Turn.
   *
   * It creates the Goal and nothing else. There is deliberately no continuation
   * scheduled here: a Goal armed with no Turn running takes effect on the next
   * Turn, which `beginObservedTurn` binds to the live control lease, and the
   * loop starts when that Turn settles. Arming does not itself start spending.
   *
   * A Turn already in flight keeps the standing it registered with — it was
   * bound before this Goal existed, so it settles outside the Goal, and the one
   * after it is the first the Goal drives.
   */
  #arm(input: GoalArmInput): Promise<OperationOutcome<'goal.arm'>> {
    return this.#sessionAdmission.run(input.sessionId, () =>
      this.#mutateGoal(async () => {
        // Admission is a queue, and the composition begins to drain without
        // waiting for it to empty. An arm let through before that can still be
        // waiting behind another operation when the Goal manager is disposed,
        // and it is the one operation here that would answer by creating state:
        // the others read a manager that no longer holds anything and say so.
        if (this.#draining) return hostDraining();
        let header;
        try {
          header = await this.#stores.sessionStore.readHeaderSnapshot(input.sessionId);
        } catch (error) {
          if (isSessionNotFoundError(error)) return notFound('Session does not exist');
          throw error;
        }
        if (header.isArchived) {
          return sessionArchived('Archived Session cannot be given a Goal');
        }
        const created = this.manager.create(input.sessionId, input.condition, {
          armed: true,
          ...(input.maxIterations === null ? {} : { maxIterations: input.maxIterations }),
          ...(input.tokenBudget === null ? {} : { tokenBudget: input.tokenBudget }),
        });
        if (created.kind === 'unfinished') {
          return operationConflict(
            `Session already has an unfinished Goal in status ${created.goal.status}`,
          );
        }
        return {
          ok: true,
          result: { sessionId: input.sessionId, goal: projectGoalState(created.goal) },
        };
      }),
    );
  }

  #control(input: GoalControlInput): Promise<OperationOutcome<'goal.control'>> {
    return this.#sessionAdmission.run(input.sessionId, () =>
      this.#mutateGoal(async () => {
        let header;
        try {
          header = await this.#stores.sessionStore.readHeaderSnapshot(input.sessionId);
        } catch (error) {
          if (isSessionNotFoundError(error)) return notFound('Session does not exist');
          throw error;
        }
        if (header.isArchived) {
          return sessionArchived('Archived Session Goal state cannot be controlled');
        }
        const current = this.manager.get(input.sessionId);
        if (!current) return notFound('Session has no Goal in this Host Epoch');
        if (current.id !== input.goalId || current.revision !== input.expectedRevision) {
          return operationConflict('Goal generation or revision no longer matches');
        }

        let changed: GoalState | undefined;
        if (input.action === 'pause') {
          changed = this.manager.pause(input.sessionId);
          if (changed) this.continuation.invalidateSession(input.sessionId);
        } else if (input.action === 'resume') {
          changed = this.continuation.resumeFromControl(input.sessionId, {
            goalId: current.id,
            revision: current.revision,
          });
        } else {
          changed = this.manager.clear(input.sessionId);
          if (changed) this.continuation.invalidateSession(input.sessionId);
        }
        if (!changed) {
          return operationConflict(`Goal cannot ${input.action} from status ${current.status}`);
        }
        return {
          ok: true,
          result: { sessionId: input.sessionId, goal: projectGoalState(changed) },
        };
      }),
    );
  }

  #enqueueGoalState(goal: DurableGoalState, controlLease: DurableGoalControlLease): void {
    if (this.#jointBusy) {
      this.#deferredGoalChanges.push([goal, controlLease]);
      return;
    }
    const current = this.#authorityBySession.get(goal.sessionId);
    this.#enqueueAuthorityCommit(goal.sessionId, {
      schemaVersion: 1,
      goal,
      controlLease,
      ...(current?.record.activeEventWait &&
      sameGoalControlLease(current.record.controlLease, controlLease) &&
      ['active', 'waiting'].includes(goal.status)
        ? { activeEventWait: current.record.activeEventWait }
        : {}),
      currentExecution:
        current?.record.goal.id === goal.id && goal.revision >= current.record.goal.revision
          ? current.record.currentExecution
          : null,
      pendingContinuation:
        current?.record.goal.id === goal.id &&
        sameGoalControlLease(current.record.controlLease, controlLease) &&
        ['active', 'waiting'].includes(goal.status) &&
        current.record.pendingContinuation &&
        (goal.revision === current.record.goal.revision || current.record.activeEventWait)
          ? {
              ...current.record.pendingContinuation,
              checkpoint: { goalId: goal.id, revision: goal.revision },
            }
          : null,
    });
  }

  async #recordPendingContinuation(
    pending: GoalPendingContinuation,
    flush: () => Promise<void> = () => this.#flushGoalState(),
  ): Promise<void> {
    const sessionId = this.manager.getSessionIdByGoalId(pending.checkpoint.goalId);
    const authority = sessionId ? this.#authorityBySession.get(sessionId) : undefined;
    if (
      !authority ||
      authority.record.goal.id !== pending.checkpoint.goalId ||
      !sameGoalControlLease(authority.record.controlLease, pending.controlLease) ||
      authority.record.goal.revision !== pending.checkpoint.revision
    ) {
      throw new Error('Goal pending continuation no longer matches its durable authority');
    }
    this.#enqueueAuthorityCommit(sessionId!, {
      ...authority.record,
      currentExecution: null,
      pendingContinuation: pending,
    });
    await flush();
  }

  #clearPendingContinuation(sessionId: string, controlLease: GoalControlLease): Promise<void> {
    return this.#mutateGoal(() => {
      const authority = this.#authorityBySession.get(sessionId);
      if (
        !authority ||
        !sameGoalControlLease(authority.record.controlLease, controlLease) ||
        !authority.record.pendingContinuation
      ) {
        return;
      }
      this.#enqueueAuthorityCommit(sessionId, {
        ...authority.record,
        pendingContinuation: null,
      });
    });
  }

  #recordCurrentExecution(current: GoalCurrentExecution): Promise<void> {
    return this.#mutateGoal(() => {
      const authority = this.#authorityBySession.get(current.execution.sessionId);
      if (
        !authority ||
        authority.record.goal.id !== current.checkpoint.goalId ||
        !sameGoalControlLease(authority.record.controlLease, current.controlLease)
      ) {
        throw new Error('Goal execution no longer matches its durable authority');
      }
      this.#enqueueAuthorityCommit(current.execution.sessionId, {
        ...authority.record,
        currentExecution: current,
        pendingContinuation: null,
      });
    });
  }

  async #recoverCurrentExecution(current: GoalCurrentExecution): Promise<void> {
    const durableAdmission = await this.#stores.agentRunStore.readRootTurnAdmission(
      current.execution.sessionId,
      current.execution.turnId,
    );
    if (!durableAdmission) {
      await this.#settleCurrentExecution(current.execution.sessionId, current.execution.turnId);
      this.continuation.recoverActiveGoal(current.execution.sessionId);
      return;
    }
    const registration = this.continuation.recoverCurrentExecution(current);
    if (registration.kind !== 'registered') {
      await this.#settleCurrentExecution(current.execution.sessionId, current.execution.turnId);
      this.continuation.recoverActiveGoal(current.execution.sessionId);
      return;
    }
    let markReconciled!: () => void;
    const firstReconciliation = new Promise<void>((resolve) => {
      markReconciled = resolve;
    });
    const settlement = waitForHostedExecutionTerminal(
      this.#executions,
      current.execution,
      { ...current.execution, status: 'admitted' },
      {
        abortSignal: this.#recoveryAbort.signal,
        onReconciled: markReconciled,
      },
    ).then((terminal) => registration.settle(goalTurnOutcomeFromHostedExecution(terminal)));
    this.#trackRecoveryWait(settlement);
    await Promise.race([firstReconciliation, settlement]);
  }

  #trackRecoveryWait(wait: Promise<void>): void {
    const tracked = wait
      .catch((error) => {
        if (this.#draining && isAbortError(error)) return;
        this.#persistenceFailure ??= error;
        this.#requestDrain();
      })
      .finally(() => this.#recoveryWaits.delete(tracked));
    this.#recoveryWaits.add(tracked);
  }

  #settleCurrentExecution(sessionId: string, turnId: string): Promise<void> {
    return this.#mutateGoal(() => {
      // A revoked registration can finish while a new wait commit is awaiting acknowledgement.
      // Read the adopted authority inside the lane before clearing this Turn's ownership.
      const authority = this.#authorityBySession.get(sessionId);
      if (!authority || authority.record.currentExecution?.execution.turnId !== turnId) return;
      this.#enqueueAuthorityCommit(sessionId, {
        ...authority.record,
        currentExecution: null,
      });
    });
  }

  #enqueueAuthorityCommit(sessionId: string, record: GoalAuthorityRecord | null): void {
    const current = this.#authorityBySession.get(sessionId);
    const queued = this.#queuedAuthorityCommits.get(sessionId);
    if (
      queued &&
      !queued.started &&
      queued.record !== null &&
      record !== null &&
      queued.record.goal.id === record.goal.id &&
      queued.record.goal.revision === record.goal.revision &&
      queued.record.pendingContinuation === null &&
      record.pendingContinuation !== null
    ) {
      // GoalManager emits its state transition synchronously. A continuation
      // is recorded immediately afterwards, so coalesce both records before
      // the persistence lane starts. The authority writer then commits the
      // revised Goal and its frozen continuation in one transaction.
      queued.record = record;
      this.#authorityBySession.set(sessionId, {
        authorityRevision: queued.nextAuthorityRevision,
        record,
      });
      return;
    }
    const expectedAuthorityRevision = current?.authorityRevision ?? null;
    const nextAuthorityRevision = (expectedAuthorityRevision ?? -1) + 1;
    if (record === null) {
      this.#authorityBySession.delete(sessionId);
    } else {
      this.#authorityBySession.set(sessionId, {
        authorityRevision: nextAuthorityRevision,
        record,
      });
    }
    const residency = this.#acquireResidency();
    const pending = {
      expectedAuthorityRevision,
      nextAuthorityRevision,
      record,
      started: false,
    };
    this.#queuedAuthorityCommits.set(sessionId, pending);
    const commit = this.#persistenceLane
      .then(async () => {
        pending.started = true;
        const committedRecord = pending.record;
        let result;
        try {
          result = await this.#store.commit({
            sessionId,
            expectedAuthorityRevision: pending.expectedAuthorityRevision,
            record: committedRecord,
          });
        } catch (error) {
          const currentExecution = committedRecord?.currentExecution;
          throw new Error(
            `Unable to persist Goal authority for Session ${sessionId}, Goal revision ${String(committedRecord?.goal.revision)}, execution checkpoint ${String(currentExecution?.checkpoint.revision)}, control generations ${String(currentExecution?.controlLease.generation)}/${String(committedRecord?.controlLease.generation)}`,
            { cause: error },
          );
        }
        if (result.kind === 'revision_conflict') {
          throw new Error(
            `Goal authority revision conflict for Session ${sessionId}: expected ${String(expectedAuthorityRevision)}, actual ${String(result.actualAuthorityRevision)}`,
          );
        }
        if (committedRecord === null) {
          if (result.snapshot !== null) {
            throw new Error(`Goal authority deletion retained Session ${sessionId}`);
          }
        } else if (result.snapshot?.authorityRevision !== pending.nextAuthorityRevision) {
          throw new Error(`Goal authority changed its committed revision for Session ${sessionId}`);
        }
      })
      .finally(() => {
        if (this.#queuedAuthorityCommits.get(sessionId) === pending) {
          this.#queuedAuthorityCommits.delete(sessionId);
        }
      });
    this.#persistenceLane = commit
      .catch((error) => {
        this.#persistenceFailure ??= error;
        this.#requestDrain();
      })
      .finally(() => residency.release());
  }

  #mutateGoal<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.#jointLane.then(async () => {
      await this.#flushGoalPersistence();
      const result = await operation();
      await this.#flushGoalPersistence();
      return result;
    });
    this.#jointLane = task.catch(() => undefined);
    return task;
  }

  #mutateWait(
    sessionId: string,
    operation: () => Promise<GoalWaitSnapshot>,
  ): Promise<GoalWaitSnapshot> {
    const task = this.#jointLane.then(async () => {
      this.#jointBusy = true;
      try {
        // This task owns the joint lane; only prior ordinary writes can be awaited here.
        await this.#flushGoalPersistence();
        const result = await operation();
        this.#adoptWaitAuthority(result.goal);
        return result;
      } finally {
        this.#jointBusy = false;
        for (const [goal, lease] of this.#deferredGoalChanges.splice(0))
          this.#enqueueGoalState(goal, lease);
      }
    });
    this.#jointLane = task.catch(() => undefined);
    return task;
  }
  #adoptWaitAuthority(snapshot: GoalAuthoritySnapshot): void {
    const current = this.#authorityBySession.get(snapshot.record.goal.sessionId);
    // Root admission may commit while an idempotent queue operation is returning.
    if (current && current.authorityRevision > snapshot.authorityRevision) return;
    this.#authorityBySession.set(snapshot.record.goal.sessionId, snapshot);
    // A control operation may have changed the live manager while I/O was pending.
    if (!this.#deferredGoalChanges.some(([g]) => g.sessionId === snapshot.record.goal.sessionId)) {
      this.manager.adoptAuthority(snapshot.record.goal, snapshot.record.controlLease);
      this.#syncResidency(snapshot.record.goal, this.#acquireResidency);
    }
    this.#onProjectionChanged(snapshot.record.goal.sessionId);
  }
  async admitted(input: HostedExecutionObservation): Promise<void> {
    if (input.descriptor.kind !== 'goal' || !input.descriptor.eventWait) return;
    const snapshot = await this.#store.read(input.sessionId);
    if (!snapshot) throw new Error('Admitted event wait lost Goal authority');
    this.#adoptWaitAuthority(snapshot);
  }

  async #deleteOrphanedAuthority(snapshot: GoalAuthoritySnapshot): Promise<void> {
    const result = await this.#store.commit({
      sessionId: snapshot.record.goal.sessionId,
      expectedAuthorityRevision: snapshot.authorityRevision,
      record: null,
    });
    if (result.kind === 'revision_conflict') {
      throw new Error(
        `Goal authority changed during recovery for Session ${snapshot.record.goal.sessionId}`,
      );
    }
  }

  async #flushGoalState(_sessionId?: string): Promise<void> {
    // A control change made during a joint operation is enqueued in its finally block.
    // Acknowledge it only after that operation and the resulting ordinary write finish.
    await this.#jointLane;
    await this.#flushGoalPersistence();
  }

  async #flushGoalPersistence(): Promise<void> {
    await this.#persistenceLane;
    if (this.#persistenceFailure !== undefined) throw this.#persistenceFailure;
  }

  #syncResidency(goal: GoalState, acquire: HostGoalCoordinatorOptions['acquireResidency']): void {
    const retained = this.#residencies.get(goal.sessionId);
    if (!TERMINAL_GOAL_STATUSES.has(goal.status)) {
      if (!retained && !this.#draining) this.#residencies.set(goal.sessionId, acquire('idle'));
      return;
    }
    retained?.release();
    this.#residencies.delete(goal.sessionId);
  }
}

function tokenCount(messages: readonly StoredMessage[], throughTurnId?: string): number {
  // Root admission can release the Session before Goal settlement reads its facts.
  // Keep later user Turns out of this Turn's baseline, including when the wait
  // source spans multiple physical Runs through handoff.
  let end = messages.length;
  if (throughTurnId !== undefined) {
    while (end > 0) {
      const message = messages[end - 1]!;
      if ('turnId' in message && message.turnId === throughTurnId) break;
      end--;
    }
  }
  if (throughTurnId !== undefined && end === 0)
    throw new Error('Completed Goal Turn is missing from token accounting facts');
  return messages.slice(0, end).reduce((total, message) => {
    if (message.type !== 'token_usage') return total;
    return total + (message.total ?? message.input + message.output);
  }, 0);
}

function notFound(message: string) {
  return { ok: false as const, error: { code: 'not_found' as const, message } };
}

function sessionArchived(message: string) {
  return {
    ok: false as const,
    error: { code: 'session_archived' as const, message },
  };
}

function operationConflict(message: string) {
  return {
    ok: false as const,
    error: { code: 'operation_conflict' as const, message },
  };
}

function hostDraining() {
  return {
    ok: false as const,
    error: { code: 'host_draining' as const, message: 'Runtime Host is draining' },
  };
}

function goalOutcomeFromCompletion(completion: HostedExecutionCompletion): GoalTurnOutcome {
  return completion.kind === 'terminal'
    ? goalTurnOutcomeFromHostedExecution(completion.snapshot)
    : {
        kind: 'errored',
        turnId: completion.execution.turnId,
        reason: completion.reason,
      };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
