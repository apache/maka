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
  type WorkHubStopClarificationReason,
} from './workhub-route-policy.js';
import type {
  OperationError,
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationCandidatesResult,
} from '@maka/runtime-host/protocol';

/**
 * A Host operation the Coordination port could not complete. It lives beside
 * the port interface rather than beside its Desktop implementation, so a
 * caller can tell a refusal from a fault without depending on the adapter.
 */
export class WorkHubCoordinationFailure extends Error {
  constructor(
    readonly code: OperationError<'workhub.coordination.act'>['code'],
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubCoordinationFailure';
  }
}

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

export type WorkHubDelegationExecutionState =
  | 'accepted'
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'recovering';

export interface WorkHubDelegationReference {
  readonly delegationId: string;
  readonly targetSessionId: string;
  /** Stable delegated work identity; targetTurnId is only its admission location. */
  readonly targetMessageId: string;
  readonly targetTurnId: string;
}

export interface WorkHubDelegationFeedback {
  readonly delegationId: string;
  readonly state: WorkHubDelegationExecutionState;
}

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
  assignment?: {
    readonly actionId: string;
    readonly delegationId: string;
    readonly targetSessionId: string;
    readonly targetSessionName: string;
    readonly targetMessageId: string;
    readonly targetTurnId: string;
    readonly feedbackState: WorkHubDelegationExecutionState;
    readonly linkState: WorkHubDelegationLinkState;
    readonly createdNew?: true;
  };
  stop?: {
    readonly targetSessionId: string;
    readonly targetSessionName: string;
    readonly outcome?: Extract<WorkHubCoordinationActResult, { disposition: 'stop_work' }>['outcome'];
  };
  updatedAt: number;
}

export type WorkHubDelegationLinkState = 'active' | 'superseded' | 'aborted' | 'stopped';

/** Unbounded, rebuildable linkage state kept separate from the bounded timeline. */
export interface WorkHubActiveDelegation {
  readonly actionId: string;
  readonly targetSessionId: string;
  readonly sequence: number;
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
  retryAction?: true;
  explicitTarget?: WorkHubSessionTarget;
  correction?: WorkHubCorrectionContext;
}

export interface WorkHubCorrectionContext {
  from: WorkHubSessionTarget;
  sourceActionId: string;
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
      reason?: 'ambiguous_command' | WorkHubStopClarificationReason;
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
  | {
      kind: 'stop';
      requestId: string;
      target: WorkHubSessionTarget;
      outcome: Extract<WorkHubCoordinationActResult, { disposition: 'stop_work' }>['outcome'];
      targetTurnId?: string;
    }
) & { strategyId: WorkHubRoutingStrategyId };

/**
 * Internal seam. The renderer bridge is the production adapter; interface
 * tests use an in-memory adapter.
 */
export interface WorkHubSessionPort {
  list(): Promise<WorkHubSessionFacts[]>;
  /**
   * Rebuilds a bounded recent conversation from the authoritative Session
   * transcripts. Missing transcripts are omitted rather than copied elsewhere.
   */
  recentTurns(targets: readonly WorkHubSessionTarget[]): Promise<WorkHubProjectedTurn[]>;
  /**
   * Rebuilds exact target-Turn execution facts for durable delegation links.
   * The target Session remains authoritative; results are read-only and may
   * conservatively report `recovering` while that authority is unavailable.
   */
  delegationFeedback(
    references: readonly WorkHubDelegationReference[],
  ): Promise<readonly WorkHubDelegationFeedback[]>;
  /**
   * Returns rebuildable routing evidence read from the authoritative Session
   * log. Implementations must not persist a second writable copy of it.
   */
  routingEvidence(
    targets: readonly WorkHubSessionTarget[],
  ): Promise<Array<{ target: WorkHubSessionTarget; originPrompt?: string }>>;
  subscribe(handler: () => void): () => void;
}

export interface WorkHubCoordinationPort {
  open(
    handler: (
      turns: readonly WorkHubCoordinationTurn[],
      activeDelegations: readonly WorkHubActiveDelegation[],
    ) => void,
    onError: (error: unknown) => void,
  ): Promise<{ close(): Promise<void> }>;
  record(input: {
    turnId: string;
    userText: string;
    assistantText: string;
  }): Promise<{ turnId: string }>;
  candidates(): Promise<WorkHubCoordinationCandidatesResult>;
  act(input: Omit<WorkHubCoordinationActInput, 'create'>): Promise<WorkHubCoordinationActResult>;
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

export function createWorkHubController(deps: {
  sessions: WorkHubSessionPort;
  coordination: WorkHubCoordinationPort;
}): WorkHubController {
  const { coordination } = deps;
  let routePolicy = createWorkHubRoutePolicy();
  let focusReadVersion = 0;
  let pendingFocusReadVersion: number | undefined;
  const activeActionIdsBySessionId = new Map<string, string[]>();
  const removeActiveAction = (sessionId: string, actionId: string) => {
    const remaining = (activeActionIdsBySessionId.get(sessionId) ?? []).filter(
      (candidate) => candidate !== actionId,
    );
    if (remaining.length === 0) {
      activeActionIdsBySessionId.delete(sessionId);
      return;
    }
    activeActionIdsBySessionId.set(sessionId, remaining);
  };
  const addActiveAction = (sessionId: string, actionId: string) => {
    const active = activeActionIdsBySessionId.get(sessionId) ?? [];
    if (!active.includes(actionId)) {
      activeActionIdsBySessionId.set(sessionId, [...active, actionId]);
    }
  };
  const correctionFor = (from: WorkHubSessionTarget): WorkHubCorrectionContext => {
    const sourceActionId = activeActionIdsBySessionId.get(from.sessionId)?.at(-1);
    if (!sourceActionId) {
      throw new Error('WorkHub linked correction requires an active durable delegation');
    }
    return { from, sourceActionId };
  };
  const reconcileActiveDelegations = (
    activeDelegations: readonly WorkHubActiveDelegation[],
  ) => {
    activeActionIdsBySessionId.clear();
    for (const delegation of [...activeDelegations].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      addActiveAction(delegation.targetSessionId, delegation.actionId);
    }
  };
  const reconcileFocus = (
    policy: ReturnType<typeof createWorkHubRoutePolicy>,
    sessions: readonly WorkHubSessionFacts[],
  ) => {
    policy.initializeFocus(sessions
      .filter((session) => session.kind === 'ordinary' && !session.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => session.target));
  };
  const completeSubmission = (
    input: WorkHubSubmitInput,
    policy: ReturnType<typeof createWorkHubRoutePolicy>,
    admitted: Extract<
      WorkHubCoordinationActResult,
      { disposition: 'delegate_existing' | 'create_new' | 'replace' }
    >,
    evidence: WorkHubRouteEvidence | 'new_session',
    correction: WorkHubCorrectionContext | undefined,
  ): Extract<WorkHubSubmission, { kind: 'submitted' }> => {
    const target = { sessionId: admitted.targetSessionId };
    if (correction) {
      removeActiveAction(correction.from.sessionId, correction.sourceActionId);
    }
    addActiveAction(target.sessionId, input.requestId);
    policy.rememberTarget(target);
    return {
      kind: 'submitted',
      strategyId: WORKHUB_ROUTING_STRATEGY_ID,
      requestId: input.requestId,
      target,
      turnId: admitted.targetTurnId,
      ...(admitted.steered ? { steered: true as const } : {}),
      evidence,
      ...(correction ? { correctedFrom: correction.from } : {}),
    };
  };
  return {
    async openConversation(handler, onError) {
      let disposed = false;
      let generation = 0;
      let latestTurns: readonly WorkHubCoordinationTurn[] = [];

      const refreshFeedback = async () => {
        const refreshGeneration = ++generation;
        const turns = latestTurns;
        const references = turns.flatMap((turn) =>
          turn.assignment
            ? [{
                delegationId: turn.assignment.delegationId,
                targetSessionId: turn.assignment.targetSessionId,
                targetMessageId: turn.assignment.targetMessageId,
                targetTurnId: turn.assignment.targetTurnId,
              }]
            : [],
        );
        if (references.length === 0) return;
        let feedback: readonly WorkHubDelegationFeedback[];
        try {
          feedback = await deps.sessions.delegationFeedback(references);
        } catch {
          feedback = references.map(({ delegationId }) => ({
            delegationId,
            state: 'recovering',
          }));
        }
        if (disposed || refreshGeneration !== generation || turns !== latestTurns) return;
        const feedbackByDelegationId = new Map(
          feedback.map((entry) => [entry.delegationId, entry]),
        );
        handler(turns.map((turn) => {
          if (!turn.assignment) return turn;
          const next = feedbackByDelegationId.get(turn.assignment.delegationId);
          return next
            ? { ...turn, assignment: { ...turn.assignment, feedbackState: next.state } }
            : turn;
        }));
      };

      const unsubscribe = deps.sessions.subscribe(() => {
        void refreshFeedback();
      });
      let handle: { close(): Promise<void> } | undefined;
      try {
        handle = await coordination.open((turns, activeDelegations) => {
          if (disposed) return;
          reconcileActiveDelegations(activeDelegations);
          latestTurns = turns;
          generation += 1;
          // The atomic assignment is already durable acknowledgement, so emit
          // it immediately before enriching it with target-owned lifecycle.
          handler(turns);
          void refreshFeedback();
        }, onError);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return {
        async close() {
          disposed = true;
          generation += 1;
          unsubscribe();
          await handle?.close();
        },
      };
    },
    async recordConversationTurn(input) {
      if (input.disposition === 'clarify') {
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
        const facts = await deps.sessions.list();
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
      const sessions = await deps.sessions.list();
      reconcileFocus(submissionPolicy, sessions);
      const ordinary = sessions.filter((session) => session.kind === 'ordinary');
      const stopDecision = submissionPolicy.resolveStop({
        text: input.text,
        sessions: ordinary,
      });
      if (stopDecision.kind !== 'not_requested') {
        if (stopDecision.kind === 'clarification') {
          return {
            kind: 'clarification',
            strategyId: WORKHUB_ROUTING_STRATEGY_ID,
            requestId: input.requestId,
            text: input.text,
            options: [],
            reason: stopDecision.reason,
          };
        }
        const { target } = stopDecision;
        let admitted;
        try {
          admitted = await coordination.act({
            actionId: input.requestId,
            userText: input.text,
            proposal: {
              disposition: 'stop_work',
              // Only the Session the reference resolved to. Which delegation
              // that Session still owns is the Host's to decide, under the
              // lease that ends it.
              expects: { targetSessionId: target.sessionId },
            },
            confirmation: { kind: 'user_stop' },
          });
        } catch (error) {
          // The Gate refusing the stop is an answer, not a fault: it is the
          // only party that can say the Session owns no single stoppable
          // delegation. Anything else is a real failure and still throws.
          if (
            error instanceof WorkHubCoordinationFailure &&
            error.code === 'operation_conflict'
          ) {
            return {
              kind: 'clarification',
              strategyId: WORKHUB_ROUTING_STRATEGY_ID,
              requestId: input.requestId,
              text: input.text,
              options: [],
              reason: 'stop_target_unavailable',
            };
          }
          throw error;
        }
        if (admitted.disposition !== 'stop_work') {
          throw new Error('WorkHub Action Gate returned an unexpected disposition');
        }
        return {
          kind: 'stop',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          target,
          outcome: admitted.outcome,
          ...(admitted.targetTurnId ? { targetTurnId: admitted.targetTurnId } : {}),
        };
      }
      const candidateSet = await coordination.candidates();
      const candidateBySessionId = new Map(
        candidateSet.candidates.map((candidate) => [candidate.sessionId, candidate]),
      );
      // Archived Sessions remain visible as historical work, but Runtime Host
      // rejects new root Turns for them. In production the Runtime-owned
      // candidate set is the only target namespace the strategy can see.
      const routable = ordinary.filter(
        (session) =>
          !session.archived &&
          candidateBySessionId.has(session.target.sessionId),
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
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(correction ? { correction } : {}),
        };
      }
      if (decision.kind === 'discussion') {
        await coordination.act({
          actionId: input.requestId,
          userText: input.text,
          proposal: { disposition: 'answer_here' },
        });
        return {
          kind: 'discussion',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
        };
      }
      const correction = input.correction ??
        (decision.correctedFrom ? correctionFor(decision.correctedFrom) : undefined);
      if (decision.kind === 'new_session') {
        const { title } = decision;
        const admitted = await coordination.act(correction
          ? {
              actionId: input.requestId,
              userText: input.text,
              confirmation: { kind: 'user_correction' },
              proposal: {
                disposition: 'replace',
                replacesActionId: correction.sourceActionId,
                target: { disposition: 'create_new', title },
              },
            }
          : {
              actionId: input.requestId,
              userText: input.text,
              proposal: { disposition: 'create_new', title },
            });
        if (
          (!correction && admitted.disposition !== 'create_new') ||
          (correction &&
            (admitted.disposition !== 'replace' ||
              admitted.replacementDisposition !== 'create_new'))
        ) {
          throw new Error('WorkHub Action Gate returned an unexpected disposition');
        }
        if (admitted.disposition !== 'create_new' && admitted.disposition !== 'replace') {
          throw new Error('WorkHub Action Gate returned an unexpected disposition');
        }
        return completeSubmission(
          input,
          submissionPolicy,
          admitted,
          'new_session',
          correction,
        );
      }
      const target = decision.target;
      const targetSession = routable.find(
        (session) => session.target.sessionId === target.sessionId,
      );
      if (!targetSession) {
        throw new Error('WorkHub target Session is unavailable');
      }
      if (targetSession?.state === 'waiting_for_user' && !input.retryAction) {
        return {
          kind: 'waiting',
          strategyId: WORKHUB_ROUTING_STRATEGY_ID,
          requestId: input.requestId,
          text: input.text,
          target,
        };
      }
      const candidate = candidateBySessionId.get(target.sessionId);
      if (!candidate) {
        throw new Error('WorkHub target Session is unavailable');
      }
      const action: WorkHubCoordinationActInput = correction
        ? {
            actionId: input.requestId,
            userText: input.text,
            candidateSetId: candidateSet.candidateSetId,
            confirmation: { kind: 'user_correction' },
            proposal: {
              disposition: 'replace',
              replacesActionId: correction.sourceActionId,
              target: {
                disposition: 'delegate_existing',
                candidateRef: candidate.candidateRef,
              },
            },
          }
        : {
            actionId: input.requestId,
            userText: input.text,
            candidateSetId: candidateSet.candidateSetId,
            proposal: {
              disposition: 'delegate_existing',
              candidateRef: candidate.candidateRef,
            },
          };
      const admitted = await coordination.act(action);
      if (
        (!correction && admitted.disposition !== 'delegate_existing') ||
        (correction &&
          (admitted.disposition !== 'replace' ||
            admitted.replacementDisposition !== 'delegate_existing'))
      ) {
        throw new Error('WorkHub Action Gate returned an unexpected disposition');
      }
      if (admitted.disposition !== 'delegate_existing' && admitted.disposition !== 'replace') {
        throw new Error('WorkHub Action Gate returned an unexpected disposition');
      }
      return completeSubmission(
        input,
        submissionPolicy,
        admitted,
        decision.evidence,
        correction,
      );
    },
    resetVisitContext() {
      focusReadVersion += 1;
      pendingFocusReadVersion = undefined;
      routePolicy = routePolicy.newVisit();
    },
  };
}
