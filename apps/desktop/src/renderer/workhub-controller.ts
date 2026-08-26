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

/**
 * WorkHub is a projection and routing surface over ordinary Sessions.
 * Session and Runtime remain authoritative for transcript, execution, state,
 * permissions, interactions, and recovery.
 */

import {
  createWorkHubRoutePolicy,
  type WorkHubRouteEvidence,
  workHubNewSessionName,
} from './workhub-route-policy.js';
import type {
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationCandidatesResult,
} from '@maka/runtime-host/protocol';

export interface WorkHubSessionTarget {
  sessionId: string;
}

export type WorkHubSessionState =
  | 'active'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'aborted';

export interface WorkHubSessionFacts {
  target: WorkHubSessionTarget;
  projectName: string;
  sessionName: string;
  kind: 'ordinary' | 'internal' | 'subagent';
  archived: boolean;
  state: WorkHubSessionState;
  /** Authoritative live Turn IDs when the Session catalog provides them. */
  runningTurnIds?: readonly string[];
  latestResult?: string;
  updatedAt: number;
}

export type WorkHubSessionSummary = Omit<WorkHubSessionFacts, 'kind' | 'runningTurnIds'>;

export type WorkHubProjectedTurnState = 'running' | 'completed' | 'aborted' | 'failed';

export interface WorkHubProjectedTurn {
  messageId: string;
  target: WorkHubSessionTarget;
  turnId: string;
  text: string;
  state: WorkHubProjectedTurnState;
  result?: string;
  updatedAt: number;
}

export interface WorkHubCoordinationTurn {
  messageId: string;
  turnId: string;
  text: string;
  state: WorkHubProjectedTurnState;
  result?: string;
  updatedAt: number;
}

const WORKHUB_TIMELINE_TEXT_LIMIT = 600;

export function boundedWorkHubTimelineText(value: string): string {
  const text = value.trim();
  const chars = Array.from(text);
  return chars.length <= WORKHUB_TIMELINE_TEXT_LIMIT
    ? text
    : `${chars.slice(0, WORKHUB_TIMELINE_TEXT_LIMIT - 1).join('')}…`;
}

export interface WorkHubProjection {
  sessions: WorkHubSessionSummary[];
  turns: WorkHubProjectedTurn[];
}

export interface WorkHubSubmitInput {
  requestId: string;
  text: string;
  explicitTarget?: WorkHubSessionTarget;
  correction?: WorkHubCorrectionContext;
}

export interface WorkHubCorrectionContext {
  from: WorkHubSessionTarget;
  turnId?: string;
  steered?: true;
}

export interface WorkHubReadInput {
  focus?: WorkHubSessionTarget;
}

export const WORKHUB_ROUTING_STRATEGY_ID = 'wh-r2.4-session-context-continuity' as const;
export type WorkHubRoutingStrategyId = typeof WORKHUB_ROUTING_STRATEGY_ID;

export type WorkHubSubmission = (
  | {
      kind: 'submitted';
      requestId: string;
      target: WorkHubSessionTarget;
      turnId: string;
      steered?: true;
      evidence: WorkHubRouteEvidence | 'new_session';
      correctedFrom?: WorkHubSessionTarget;
    }
  | {
      kind: 'clarification';
      requestId: string;
      text: string;
      options: Array<Pick<WorkHubSessionSummary, 'target' | 'projectName' | 'sessionName'>>;
      correction?: WorkHubCorrectionContext;
    }
  | {
      kind: 'discussion';
      requestId: string;
      text: string;
    }
  | {
      kind: 'waiting';
      requestId: string;
      text: string;
      target: WorkHubSessionTarget;
    }
) & { strategyId: WorkHubRoutingStrategyId };

/**
 * Internal seam. The renderer bridge is the production adapter; interface
 * tests use an in-memory adapter.
 */
export interface WorkHubSessionPort {
  list(): Promise<WorkHubSessionFacts[]>;
  /**
   * Lists Sessions with per-target catalog coverage. A target missing from a
   * partial multi-Host list is not authoritatively absent.
   */
  listCatalog?(): Promise<{
    sessions: WorkHubSessionFacts[];
    isCompleteFor(target: WorkHubSessionTarget): boolean;
  }>;
  /**
   * Rebuilds a bounded recent conversation from the authoritative Session
   * transcripts. Missing transcripts are omitted rather than copied elsewhere.
   */
  recentTurns(targets: readonly WorkHubSessionTarget[]): Promise<WorkHubProjectedTurn[]>;
  /**
   * Returns rebuildable routing evidence read from the authoritative Session
   * log. Implementations must not persist a second writable copy of it.
   */
  routingEvidence(
    targets: readonly WorkHubSessionTarget[],
  ): Promise<Array<{ target: WorkHubSessionTarget; originPrompt?: string }>>;
  create(input: { name: string }): Promise<WorkHubSessionFacts>;
  reserveTurnId(): string;
  submit(
    target: WorkHubSessionTarget,
    text: string,
    turnId: string,
  ): Promise<{ turnId: string; steered?: true }>;
  reconcileSubmission(
    target: WorkHubSessionTarget,
    reservedTurnId: string,
  ): Promise<
    | { kind: 'root'; turnId: string }
    | { kind: 'steered' }
    | { kind: 'unknown' }
  >;
  stop(target: WorkHubSessionTarget, expectedTurnId: string): Promise<void>;
  subscribe(handler: () => void): () => void;
}

export interface WorkHubCoordinationPort {
  open(
    handler: (turns: readonly WorkHubCoordinationTurn[]) => void,
    onError: (error: unknown) => void,
  ): Promise<{ close(): Promise<void> }>;
  answer(input: { turnId: string; text: string }): Promise<{ turnId: string }>;
  record(input: {
    turnId: string;
    userText: string;
    assistantText: string;
  }): Promise<{ turnId: string }>;
  candidates(): Promise<WorkHubCoordinationCandidatesResult>;
  act(input: Omit<WorkHubCoordinationActInput, 'create'>): Promise<WorkHubCoordinationActResult>;
}

export class WorkHubSessionSubmitError extends Error {
  constructor(
    message: string,
    readonly admission: 'rejected' | 'unknown',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkHubSessionSubmitError';
  }
}

export interface WorkHubController {
  read(input?: WorkHubReadInput): Promise<WorkHubProjection>;
  submit(input: WorkHubSubmitInput): Promise<WorkHubSubmission>;
  openConversation(
    handler: (turns: readonly WorkHubCoordinationTurn[]) => void,
    onError: (error: unknown) => void,
  ): Promise<{ close(): Promise<void> }>;
  recordConversationTurn(input: {
    turnId: string;
    userText: string;
    assistantText: string;
    disposition?: 'clarify' | 'summary';
  }): Promise<{ turnId: string }>;
  subscribe(handler: () => void): () => void;
  resetVisitContext(): void;
}

const MAX_TRACKED_WORKHUB_ROOTS = 32;

interface WorkHubRootOwnership {
  order: number;
  turnId: string;
}

interface WorkHubPendingAdmission extends WorkHubRootOwnership {
  state: 'in_flight' | 'uncertain';
}

interface WorkHubOwnershipTombstone {
  order: number;
  stoppedTurnIds: Set<string>;
}

export function createWorkHubController(deps: {
  sessions: WorkHubSessionPort;
  coordination: WorkHubCoordinationPort;
}): WorkHubController {
  return createWorkHubControllerImplementation(deps);
}

/** @internal Transitional R2.4 regression harness; application code must use the Action Gate. */
export function createLegacyWorkHubControllerForTests(deps: {
  sessions: WorkHubSessionPort;
}): WorkHubController {
  return createWorkHubControllerImplementation(deps);
}

function createWorkHubControllerImplementation(deps: {
  sessions: WorkHubSessionPort;
  coordination?: WorkHubCoordinationPort;
}): WorkHubController {
  const coordination = deps.coordination ?? legacyTestCoordinationPort();
  let routePolicy = createWorkHubRoutePolicy();
  let focusReadVersion = 0;
  let pendingFocusReadVersion: number | undefined;
  const confirmedOwnershipBySessionId = new Map<string, WorkHubRootOwnership>();
  const pendingAdmissionsBySessionId = new Map<string, WorkHubPendingAdmission[]>();
  const ownershipTombstoneBySessionId = new Map<string, WorkHubOwnershipTombstone>();
  const stopAttemptByTurn = new Map<string, Promise<void>>();
  const stopOperationCountBySessionId = new Map<string, number>();
  let ownershipRevision = 0;
  const reconcileFocus = (
    policy: ReturnType<typeof createWorkHubRoutePolicy>,
    sessions: readonly WorkHubSessionFacts[],
  ) => {
    policy.initializeFocus(sessions
      .filter((session) => session.kind === 'ordinary' && !session.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => session.target));
  };
  const correctionFor = (from: WorkHubSessionTarget): WorkHubCorrectionContext => {
    const confirmed = confirmedOwnershipBySessionId.get(from.sessionId);
    const pending = pendingAdmissionsBySessionId.get(from.sessionId);
    const turnId = confirmed?.turnId ?? pending?.at(-1)?.turnId;
    if (!turnId) return { from };
    return {
      from,
      turnId,
    };
  };
  const pendingAdmissions = (sessionId: string): WorkHubPendingAdmission[] =>
    pendingAdmissionsBySessionId.get(sessionId) ?? [];
  const setPendingAdmissions = (
    sessionId: string,
    pending: WorkHubPendingAdmission[],
  ) => {
    ownershipRevision += 1;
    if (pending.length === 0) {
      pendingAdmissionsBySessionId.delete(sessionId);
      return;
    }
    pendingAdmissionsBySessionId.set(
      sessionId,
      [...pending].sort((left, right) => left.order - right.order),
    );
  };
  const trackedRootCount = () => {
    let pendingCount = 0;
    for (const pending of pendingAdmissionsBySessionId.values()) {
      pendingCount += pending.length;
    }
    return confirmedOwnershipBySessionId.size + pendingCount;
  };
  const maybeRetireTombstone = (sessionId: string) => {
    const tombstone = ownershipTombstoneBySessionId.get(sessionId);
    if (!tombstone) return;
    if ((stopOperationCountBySessionId.get(sessionId) ?? 0) > 0) return;
    if (pendingAdmissions(sessionId).some((candidate) => candidate.order <= tombstone.order)) {
      return;
    }
    ownershipTombstoneBySessionId.delete(sessionId);
  };
  const readCatalog = async () => {
    const revisionAtStart = ownershipRevision;
    const catalog = deps.sessions.listCatalog
      ? await deps.sessions.listCatalog()
      : {
          sessions: await deps.sessions.list(),
          isCompleteFor: () => false,
        };
    return {
      catalog,
      // A catalog request that overlapped an ownership mutation may describe
      // the state before that mutation. It remains useful for projection, but
      // it must not authoritatively prune newer ownership or admissions.
      allowAuthoritativePruning: revisionAtStart === ownershipRevision,
    };
  };
  const reconcileConfirmedOwnership = (catalog: {
    sessions: readonly WorkHubSessionFacts[];
    isCompleteFor(target: WorkHubSessionTarget): boolean;
  }, allowAuthoritativePruning: boolean) => {
    if (!allowAuthoritativePruning) return;
    const { sessions } = catalog;
    const sessionById = new Map(sessions.map((session) => [session.target.sessionId, session]));
    for (const [sessionId, ownership] of confirmedOwnershipBySessionId) {
      const session = sessionById.get(sessionId);
      if (
        (!session && catalog.isCompleteFor({ sessionId })) ||
        session?.archived ||
        (session?.runningTurnIds !== undefined &&
          !session.runningTurnIds.includes(ownership.turnId))
      ) {
        if (confirmedOwnershipBySessionId.delete(sessionId)) {
          ownershipRevision += 1;
        }
      }
    }
  };
  const storeOwnershipTombstone = (
    sessionId: string,
    order: number,
    stoppedTurnIds: Iterable<string> = [],
  ) => {
    const existing = ownershipTombstoneBySessionId.get(sessionId);
    if (existing && existing.order > order) return;
    const stopped = new Set(existing?.order === order ? existing.stoppedTurnIds : []);
    for (const turnId of stoppedTurnIds) stopped.add(turnId);
    ownershipTombstoneBySessionId.set(sessionId, {
      order,
      stoppedTurnIds: stopped,
    });
  };
  const reserveOwnedRoot = (
    target: WorkHubSessionTarget,
    turnId: string,
    order: number,
  ) => {
    if (trackedRootCount() >= MAX_TRACKED_WORKHUB_ROOTS) {
      throw new Error('WorkHub has too many unresolved root submissions');
    }
    setPendingAdmissions(target.sessionId, [
      ...pendingAdmissions(target.sessionId),
      { order, turnId, state: 'in_flight' },
    ]);
  };
  const removePendingRoot = (
    target: WorkHubSessionTarget,
    reservedTurnId: string,
    order: number,
  ) => {
    setPendingAdmissions(
      target.sessionId,
      pendingAdmissions(target.sessionId).filter((candidate) =>
        candidate.order !== order || candidate.turnId !== reservedTurnId),
    );
  };
  const markPendingRootUncertain = (
    target: WorkHubSessionTarget,
    reservedTurnId: string,
    order: number,
  ) => {
    setPendingAdmissions(
      target.sessionId,
      pendingAdmissions(target.sessionId).map((candidate) =>
        candidate.order === order && candidate.turnId === reservedTurnId
          ? { ...candidate, state: 'uncertain' }
          : candidate),
    );
  };
  const attemptStop = (
    target: WorkHubSessionTarget,
    turnId: string,
  ): Promise<void> => {
    const key = `${target.sessionId}\0${turnId}`;
    const existing = stopAttemptByTurn.get(key);
    if (existing) return existing;
    stopOperationCountBySessionId.set(
      target.sessionId,
      (stopOperationCountBySessionId.get(target.sessionId) ?? 0) + 1,
    );
    const stopping = deps.sessions.stop(target, turnId).finally(() => {
      stopAttemptByTurn.delete(key);
      const remaining = (stopOperationCountBySessionId.get(target.sessionId) ?? 1) - 1;
      if (remaining === 0) {
        stopOperationCountBySessionId.delete(target.sessionId);
      } else {
        stopOperationCountBySessionId.set(target.sessionId, remaining);
      }
    });
    stopAttemptByTurn.set(key, stopping);
    return stopping;
  };
  const settleOwnedRoot = async (
    target: WorkHubSessionTarget,
    reservedTurnId: string,
    turn: { turnId: string; steered?: true },
    order: number,
  ) => {
    const tombstone = ownershipTombstoneBySessionId.get(target.sessionId);
    let stopped = false;
    let stopFailure: unknown;
    if (!turn.steered && tombstone && tombstone.order >= order) {
      stopped = tombstone.stoppedTurnIds.has(turn.turnId);
      if (!stopped) {
        try {
          const priorStopAttempt = stopAttemptByTurn.get(
            `${target.sessionId}\0${turn.turnId}`,
          );
          if (priorStopAttempt) {
            try {
              await priorStopAttempt;
            } catch {
              // Admission is new evidence. Retry against the admitted root even
              // when the earlier pre-admission Stop failed or observed nothing.
            }
          }
          await attemptStop(target, turn.turnId);
          const currentBarrier = ownershipTombstoneBySessionId.get(target.sessionId);
          if (currentBarrier && currentBarrier.order >= order) {
            storeOwnershipTombstone(target.sessionId, currentBarrier.order, [turn.turnId]);
          }
          stopped = true;
        } catch (error) {
          stopFailure = error;
        }
      }
    }
    removePendingRoot(target, reservedTurnId, order);
    if (!turn.steered && !stopped) {
      const confirmed = confirmedOwnershipBySessionId.get(target.sessionId);
      if (!confirmed || confirmed.order <= order) {
        confirmedOwnershipBySessionId.set(target.sessionId, {
          order,
          turnId: turn.turnId,
        });
        ownershipRevision += 1;
      }
    }
    maybeRetireTombstone(target.sessionId);
    if (stopFailure) throw stopFailure;
  };
  const releasePendingRoot = (
    target: WorkHubSessionTarget,
    reservedTurnId: string,
    order: number,
  ) => {
    removePendingRoot(target, reservedTurnId, order);
    maybeRetireTombstone(target.sessionId);
  };
  const reconcilePendingRoot = async (
    target: WorkHubSessionTarget,
    reservedTurnId: string,
    order: number,
  ): Promise<boolean> => {
    const reconciliation = await deps.sessions.reconcileSubmission(target, reservedTurnId);
    if (reconciliation.kind === 'unknown') return false;
    await settleOwnedRoot(
      target,
      reservedTurnId,
      reconciliation.kind === 'steered'
        ? { turnId: reservedTurnId, steered: true }
        : { turnId: reconciliation.turnId },
      order,
    );
    return true;
  };
  const reconcileUncertainAdmissions = (catalog: {
    sessions: readonly WorkHubSessionFacts[];
    isCompleteFor(target: WorkHubSessionTarget): boolean;
  }, allowAuthoritativePruning: boolean): Promise<void> | undefined => {
    const sessionById = new Map(
      catalog.sessions.map((session) => [session.target.sessionId, session]),
    );
    const uncertain = [...pendingAdmissionsBySessionId.entries()]
      .flatMap(([sessionId, pending]) => pending
        .filter((candidate) => candidate.state === 'uncertain')
        .map((candidate) => ({
          target: { sessionId },
          ...candidate,
        })));
    if (uncertain.length === 0) return undefined;
    return Promise.all(uncertain.map(async ({ target, turnId, order }) => {
      const session = sessionById.get(target.sessionId);
      if (
        allowAuthoritativePruning &&
        (session?.archived || (!session && catalog.isCompleteFor(target)))
      ) {
        releasePendingRoot(target, turnId, order);
        return;
      }
      try {
        await reconcilePendingRoot(target, turnId, order);
      } catch {
        // Failed reconciliation preserves the pending or confirmed ownership.
      }
    })).then(() => undefined);
  };
  const assertSubmissionBarrierOpen = (target: WorkHubSessionTarget) => {
    maybeRetireTombstone(target.sessionId);
    const tombstone = ownershipTombstoneBySessionId.get(target.sessionId);
    const stopCount = stopOperationCountBySessionId.get(target.sessionId) ?? 0;
    const pendingBarrier = tombstone && pendingAdmissions(target.sessionId)
      .some((candidate) => candidate.order <= tombstone.order);
    if (stopCount > 0 || pendingBarrier) {
      throw new Error('WorkHub is still reconciling a correction for this Session');
    }
  };
  const stopOwnedRoots = async (
    correction: WorkHubCorrectionContext,
    order: number,
  ) => {
    if (correction.steered) return;
    const confirmed = confirmedOwnershipBySessionId.get(correction.from.sessionId);
    const pending = pendingAdmissions(correction.from.sessionId);
    const turnIds = new Set<string>();
    const unconfirmedTurnIds = new Set<string>();
    if (correction.turnId) turnIds.add(correction.turnId);
    if (confirmed && confirmed.order < order) {
      turnIds.add(confirmed.turnId);
    }
    for (const candidate of pending) {
      if (candidate.order < order) {
        turnIds.add(candidate.turnId);
        unconfirmedTurnIds.add(candidate.turnId);
      }
    }
    if (turnIds.size === 0) return;
    // Publish only the order barrier before awaiting Host acknowledgements.
    // Individual IDs become tombstoned only after their Stop succeeds.
    storeOwnershipTombstone(correction.from.sessionId, order);
    const failures: unknown[] = [];
    await Promise.all([...turnIds].map(async (turnId) => {
      try {
        await attemptStop(correction.from, turnId);
        const barrier = ownershipTombstoneBySessionId.get(correction.from.sessionId);
        if (barrier && barrier.order >= order && !unconfirmedTurnIds.has(turnId)) {
          storeOwnershipTombstone(correction.from.sessionId, barrier.order, [turnId]);
        }
        const owned = confirmedOwnershipBySessionId.get(correction.from.sessionId);
        if (owned && owned.order < order && owned.turnId === turnId) {
          confirmedOwnershipBySessionId.delete(correction.from.sessionId);
          ownershipRevision += 1;
        }
      } catch (error) {
        failures.push(error);
      }
    }));
    maybeRetireTombstone(correction.from.sessionId);
    if (failures.length > 0) throw failures[0];
  };
  return {
    openConversation(handler, onError) {
      return coordination.open(handler, onError);
    },
    async recordConversationTurn(input) {
      if (deps.coordination && input.disposition === 'clarify') {
        const result = await coordination.act({
          actionId: input.turnId,
          userText: input.userText,
          proposal: {
            disposition: 'clarify',
            assistantText: input.assistantText,
          },
        });
        if (result.disposition !== 'clarify') {
          throw new Error('WorkHub Action Gate returned an unexpected disposition');
        }
        return { turnId: result.coordinationTurnId };
      }
      return coordination.record({
        turnId: input.turnId,
        userText: input.userText,
        assistantText: input.assistantText,
      });
    },
    subscribe(handler) {
      return deps.sessions.subscribe(handler);
    },
    async read(input) {
      const readPolicy = routePolicy;
      let readFocusVersion = focusReadVersion;
      if (input?.focus) {
        readFocusVersion = ++focusReadVersion;
        pendingFocusReadVersion = readFocusVersion;
        readPolicy.rememberTarget(input.focus);
      }
      try {
        const { catalog, allowAuthoritativePruning } =
          await readCatalog();
        reconcileConfirmedOwnership(catalog, allowAuthoritativePruning);
        const reconciliation = reconcileUncertainAdmissions(
          catalog,
          allowAuthoritativePruning,
        );
        if (reconciliation) await reconciliation;
        const facts = catalog.sessions;
        const ordinary = facts
          .filter((session) => session.kind === 'ordinary')
          .sort((left, right) => right.updatedAt - left.updatedAt);
        if (
          readFocusVersion === focusReadVersion &&
          (input?.focus || pendingFocusReadVersion === undefined)
        ) {
          reconcileFocus(readPolicy, facts);
        }
        return {
          sessions: ordinary
            .map(({ kind: _kind, runningTurnIds: _runningTurnIds, ...session }) => session),
          // Slice 3 renders conversation only from the Coordination Session.
          // Ordinary Session transcripts remain routing evidence, never a
          // second WorkHub conversation source.
          turns: [],
        };
      } finally {
        if (input?.focus && pendingFocusReadVersion === readFocusVersion) {
          pendingFocusReadVersion = undefined;
        }
      }
    },
    async submit(input) {
      const submissionPolicy = routePolicy;
      // Reserve the order synchronously, before any await. Corrections are
      // learned only after successful delivery, but their precedence follows
      // user submission order rather than network completion order.
      const submissionOrder = submissionPolicy.reserveSubmissionOrder();
      if (deps.coordination && input.correction) {
        throw new Error(
          'WorkHub linked correction requires persistent delegation support',
        );
      }
      const { catalog, allowAuthoritativePruning } =
        await readCatalog();
      reconcileConfirmedOwnership(catalog, allowAuthoritativePruning);
      const reconciliation = reconcileUncertainAdmissions(
        catalog,
        allowAuthoritativePruning,
      );
      if (reconciliation) await reconciliation;
      const sessions = catalog.sessions;
      reconcileFocus(submissionPolicy, sessions);
      const ordinary = sessions.filter((session) => session.kind === 'ordinary');
      const candidateSet = deps.coordination
        ? await coordination.candidates()
        : undefined;
      const candidateBySessionId = new Map(
        candidateSet?.candidates.map((candidate) => [candidate.sessionId, candidate]),
      );
      // Archived Sessions remain visible as historical work, but Runtime Host
      // rejects new root Turns for them. In production the Runtime-owned
      // candidate set is the only target namespace the strategy can see.
      const routable = ordinary.filter(
        (session) =>
          !session.archived &&
          (!candidateSet || candidateBySessionId.has(session.target.sessionId)),
      );
      const routingEvidence = input.explicitTarget
        ? []
        : await deps.sessions.routingEvidence(routable.map((session) => session.target));
      const decision = submissionPolicy.resolve({
        text: input.text,
        sessions: routable,
        originPromptBySessionId: new Map(
          routingEvidence.map((entry) => [entry.target.sessionId, entry.originPrompt]),
        ),
        ...(input.explicitTarget ? { explicitTarget: input.explicitTarget } : {}),
      });
      if (decision.kind === 'clarification') {
        if (deps.coordination && decision.correctedFrom) {
          throw new Error(
            'WorkHub linked correction requires persistent delegation support',
          );
        }
        const correction = decision.correctedFrom
          ? correctionFor(decision.correctedFrom)
          : undefined;
        return {
          kind: 'clarification',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
          options: decision.options.map((session) => ({
            target: session.target,
            projectName: session.projectName,
            sessionName: session.sessionName,
          })),
          ...(correction ? { correction } : {}),
        };
      }
      if (decision.kind === 'discussion') {
        if (candidateSet) {
          await coordination.act({
            actionId: input.requestId,
            userText: input.text,
            proposal: { disposition: 'answer_here' },
          });
        } else {
          await coordination.answer({
            turnId: input.requestId,
            text: input.text,
          });
        }
        return {
          kind: 'discussion',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
        };
      }
      let target: WorkHubSessionTarget;
      let evidence: Extract<WorkHubSubmission, { kind: 'submitted' }>['evidence'];
      const correction = input.correction ?? (decision.kind === 'target' && decision.correctedFrom
        ? correctionFor(decision.correctedFrom)
        : undefined);
      if (deps.coordination && correction) {
        throw new Error(
          'WorkHub linked correction requires persistent delegation support',
        );
      }
      if (candidateSet && decision.kind === 'new_session') {
        const admitted = await coordination.act({
          actionId: input.requestId,
          userText: input.text,
          proposal: {
            disposition: 'create_new',
            title: workHubNewSessionName(input.text),
          },
        });
        if (admitted.disposition !== 'create_new') {
          throw new Error('WorkHub Action Gate returned an unexpected disposition');
        }
        target = { sessionId: admitted.targetSessionId };
        submissionPolicy.rememberTarget(target);
        return {
          kind: 'submitted',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          target,
          turnId: admitted.targetTurnId,
          ...(admitted.steered ? { steered: true as const } : {}),
          evidence: 'new_session',
        };
      }
      if (decision.kind === 'new_session') {
        const created = await deps.sessions.create({ name: workHubNewSessionName(input.text) });
        if (created.kind !== 'ordinary') {
          throw new Error('WorkHub can only create ordinary Sessions');
        }
        target = created.target;
        evidence = 'new_session';
      } else {
        target = decision.target;
        evidence = correction ? 'route_correction' : decision.evidence;
      }
      const targetSession = routable.find(
        (session) => session.target.sessionId === target.sessionId,
      );
      if (!targetSession && evidence !== 'new_session') {
        throw new Error('WorkHub target Session is unavailable');
      }
      if (targetSession?.state === 'waiting_for_user') {
        return {
          kind: 'waiting',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
          target,
        };
      }
      if (candidateSet) {
        const candidate = candidateBySessionId.get(target.sessionId);
        if (!candidate) {
          throw new Error('WorkHub target Session is unavailable');
        }
        const action: WorkHubCoordinationActInput = {
          actionId: input.requestId,
          userText: input.text,
          candidateSetId: candidateSet.candidateSetId,
          proposal: {
            disposition: 'delegate_existing',
            candidateRef: candidate.candidateRef,
          },
        };
        const admitted = await coordination.act(action);
        if (admitted.disposition !== 'delegate_existing') {
          throw new Error('WorkHub Action Gate returned an unexpected disposition');
        }
        target = { sessionId: admitted.targetSessionId };
        submissionPolicy.rememberTarget(target);
        return {
          kind: 'submitted',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          target,
          turnId: admitted.targetTurnId,
          ...(admitted.steered ? { steered: true as const } : {}),
          evidence,
        };
      }
      if (correction) {
        await stopOwnedRoots(correction, submissionOrder);
      }
      assertSubmissionBarrierOpen(target);
      const reservedTurnId = deps.sessions.reserveTurnId();
      reserveOwnedRoot(target, reservedTurnId, submissionOrder);
      let turn: { turnId: string; steered?: true };
      try {
        turn = await deps.sessions.submit(target, input.text, reservedTurnId);
      } catch (error) {
        if (
          error instanceof WorkHubSessionSubmitError &&
          error.admission === 'rejected'
        ) {
          releasePendingRoot(target, reservedTurnId, submissionOrder);
        } else {
          markPendingRootUncertain(target, reservedTurnId, submissionOrder);
          try {
            await reconcilePendingRoot(target, reservedTurnId, submissionOrder);
          } catch {
            // The original delivery error remains primary. Reconciliation keeps
            // any unresolved admission reachable for a later read/correction.
          }
        }
        throw error;
      }
      await settleOwnedRoot(target, reservedTurnId, turn, submissionOrder);
      submissionPolicy.rememberTarget(target);
      if (correction) {
        submissionPolicy.rememberCorrection(input.text, target, submissionOrder);
      }
      return {
        kind: 'submitted',
        strategyId: WORKHUB_ROUTING_STRATEGY_ID,
        requestId: input.requestId,
        target,
        turnId: turn.turnId,
        ...(turn.steered ? { steered: true as const } : {}),
        evidence,
        ...(correction ? { correctedFrom: correction.from } : {}),
      };
    },
    resetVisitContext() {
      focusReadVersion += 1;
      pendingFocusReadVersion = undefined;
      routePolicy = routePolicy.newVisit();
    },
  };
}

function legacyTestCoordinationPort(): WorkHubCoordinationPort {
  return {
    async open(handler) {
      handler([]);
      return { close: async () => undefined };
    },
    async answer(input) {
      return { turnId: input.turnId };
    },
    async record(input) {
      return { turnId: input.turnId };
    },
    async candidates() {
      throw new Error('The legacy WorkHub test adapter does not expose Action Gate candidates');
    },
    async act() {
      throw new Error('The legacy WorkHub test adapter does not expose Action Gate actions');
    },
  };
}
