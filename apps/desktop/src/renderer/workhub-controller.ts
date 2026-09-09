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
  boundedWorkHubText,
  createWorkHubR24RoutingStrategy,
  createWorkHubRoutePolicy,
  boundedRoutingInput,
  readWorkHubRoutingEvidence,
  type WorkHubRoutePolicy,
  type WorkHubRouteEvidence,
  type WorkHubRoutingStrategy,
  type WorkHubRoutingStrategyId,
  type WorkHubStopClarificationReason,
  type WorkHubNamedActionRouteDecision,
  WORKHUB_R24_ROUTING_STRATEGY_ID,
} from './features/workhub/index.js';
import type {
  OperationError,
  WorkHubCoordinationActInput,
  WorkHubCoordinationActResult,
  WorkHubCoordinationCandidatesResult,
} from '@maka/runtime-host/protocol';
import { ExpectedOperationError } from './application/contracts/operation-diagnostics.js';


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
  coordinationActionId?: string;
  attachments?: WorkHubCoordinationActInput['attachments'];
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
  resume?: Extract<WorkHubCoordinationActResult, { disposition: 'resume_work' }>;
  updatedAt: number;
}

export type WorkHubDelegationLinkState = 'active' | 'superseded' | 'aborted' | 'stopped';

const WORKHUB_TIMELINE_TEXT_LIMIT = 600;

export function boundedWorkHubTimelineText(value: string): string {
  return boundedWorkHubText(value, WORKHUB_TIMELINE_TEXT_LIMIT);
}

export interface WorkHubProjection {
  sessions: WorkHubSessionSummary[];
  turns: WorkHubProjectedTurn[];
  /** Current deterministic coordination focus; projection only, never authority. */
  focusSessionId?: string;
}

export interface WorkHubSubmitInput {
  attachments?: WorkHubCoordinationActInput['attachments'];
  newWorkDefaults?: WorkHubCoordinationActInput['newWorkDefaults'];
  requestId: string;
  text: string;
  newSessionFallbackTitle: string;
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

/** @deprecated Prefer the versioned IDs exported by the WorkHub feature. */
export const WORKHUB_ROUTING_STRATEGY_ID = WORKHUB_R24_ROUTING_STRATEGY_ID;
export type { WorkHubRoutingStrategyId } from './features/workhub/index.js';

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
  | {
      kind: 'resume';
      requestId: string;
      target: WorkHubSessionTarget;
      outcome: Extract<WorkHubCoordinationActResult, { disposition: 'resume_work' }>['outcome'];
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
    handler: (turns: readonly WorkHubCoordinationTurn[]) => void,
    onError: (error: unknown) => void,
  ): Promise<{ close(): Promise<void> }>;
  candidates(): Promise<WorkHubCoordinationCandidatesResult>;
  act(input: Omit<WorkHubCoordinationActInput, 'create'>): Promise<WorkHubCoordinationActResult>;
}

export interface WorkHubController {
  read(input?: WorkHubReadInput): Promise<WorkHubProjection>;
  submit(input: WorkHubSubmitInput): Promise<WorkHubSubmission>;
  openConversation(
    handler: (
      turns: readonly WorkHubCoordinationTurn[],
    ) => void,
    onError: (error: unknown) => void,
  ): Promise<{ close(): Promise<void> }>;
  requestClarification(input: {
    turnId: string;
    userText: string;
    assistantText: string;
  }): Promise<{ turnId: string }>;
  subscribe(handler: () => void): () => void;
  resetVisitContext(): void;
}

export type WorkHubExpectedFailureCode =
  | 'candidates_changed'
  | 'linked_correction_unavailable';

export function createWorkHubController(deps: {
  sessions: WorkHubSessionPort;
  coordination: WorkHubCoordinationPort;
  routingStrategy?: WorkHubRoutingStrategy;
}): WorkHubController {
  const { coordination } = deps;
  const routingStrategy = deps.routingStrategy ?? createWorkHubR24RoutingStrategy();
  let routePolicy = createWorkHubRoutePolicy();
  let routingTranscript: Array<{ userText: string; assistantText?: string }> = [];
  let focusReadVersion = 0;
  let pendingFocusReadVersion: number | undefined;
  const correctionFor = (
    from: WorkHubSessionTarget,
    candidateBySessionId: ReadonlyMap<string, WorkHubCoordinationCandidatesResult['candidates'][number]>,
  ): WorkHubCorrectionContext => {
    const sourceActionId = candidateBySessionId.get(from.sessionId)?.latestDelegationActionId;
    if (!sourceActionId) {
      throw new ExpectedOperationError<WorkHubExpectedFailureCode>(
        'linked_correction_unavailable',
      );
    }
    return { from, sourceActionId };
  };
  const reconcileFocus = (
    policy: WorkHubRoutePolicy,
    sessions: readonly WorkHubSessionFacts[],
  ) => {
    policy.initializeFocus(sessions
      .filter((session) => session.kind === 'ordinary' && !session.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => session.target));
  };
  const completeSubmission = (
    input: WorkHubSubmitInput,
    policy: WorkHubRoutePolicy,
    admitted: Extract<
      WorkHubCoordinationActResult,
      { disposition: 'delegate_existing' | 'create_new' | 'replace' }
    >,
    evidence: WorkHubRouteEvidence | 'new_session',
    correction: WorkHubCorrectionContext | undefined,
  ): Extract<WorkHubSubmission, { kind: 'submitted' }> => {
    const target = { sessionId: admitted.targetSessionId };
    policy.rememberTarget(target);
    return {
      kind: 'submitted',
      strategyId: routingStrategy.strategyId,
      requestId: input.requestId,
      target,
      turnId: admitted.targetTurnId,
      ...(admitted.steered ? { steered: true as const } : {}),
      evidence,
      ...(correction ? { correctedFrom: correction.from } : {}),
    };
  };
  const submitNamedDelegationAction = async (
    input: WorkHubSubmitInput,
    decision: WorkHubNamedActionRouteDecision,
    kind: 'resume' | 'stop',
    strategyId: WorkHubRoutingStrategyId,
  ): Promise<Extract<WorkHubSubmission, { kind: 'clarification' | 'resume' | 'stop' }> | undefined> => {
    if (decision.kind === 'not_requested') return undefined;
    if (decision.kind === 'clarification') {
      return {
        kind: 'clarification',
        strategyId,
        requestId: input.requestId,
        text: input.text,
        options: [],
        reason: decision.reason,
      };
    }
    const { target } = decision;
    try {
      const candidates = kind === 'resume' ? await coordination.candidates() : undefined;
      const resumesActionId = candidates?.candidates.find(
        (candidate) => candidate.sessionId === target.sessionId,
      )?.latestDelegationActionId;
      if (kind === 'resume' && !resumesActionId) {
        return {
          kind: 'clarification',
          strategyId,
          requestId: input.requestId,
          text: input.text,
          options: [],
          reason: 'resume_target_unavailable',
        };
      }
      const admitted = await coordination.act({
        actionId: input.requestId,
        userText: input.text,
        proposal: kind === 'resume'
          ? {
              disposition: 'resume_work',
              expects: { targetSessionId: target.sessionId },
              resumesActionId: resumesActionId!,
            }
          : { disposition: 'stop_work', expects: { targetSessionId: target.sessionId } },
        ...(kind === 'stop' ? { confirmation: { kind: 'user_stop' as const } } : {}),
      });
      const result = {
        strategyId,
        requestId: input.requestId,
        target,
      };
      if (kind === 'resume' && admitted.disposition === 'resume_work') {
        return {
          ...result,
          kind: 'resume',
          outcome: admitted.outcome,
        };
      }
      if (kind === 'stop' && admitted.disposition === 'stop_work') {
        return {
          ...result,
          kind: 'stop',
          outcome: admitted.outcome,
          ...(admitted.targetTurnId ? { targetTurnId: admitted.targetTurnId } : {}),
        };
      }
      throw new Error('WorkHub Action Gate returned an unexpected disposition');
    } catch (error) {
      if (
        kind === 'resume' &&
        error instanceof WorkHubCoordinationFailure &&
        (error.code === 'operation_unavailable' || error.code === 'host_not_ready')
      ) {
        return {
          kind: 'clarification',
          strategyId,
          requestId: input.requestId,
          text: input.text,
          options: [],
          reason: error.code === 'host_not_ready'
            ? 'resume_host_recovering'
            : 'resume_operation_unavailable',
        };
      }
      if (error instanceof WorkHubCoordinationFailure && error.code === 'operation_conflict') {
        if (!/no active durable delegation|does not identify one active durable delegation/iu.test(
          error.message,
        )) {
          throw error;
        }
        return {
          kind: 'clarification',
          strategyId,
          requestId: input.requestId,
          text: input.text,
          options: [],
          reason: kind === 'resume' ? 'resume_target_unavailable' : 'stop_target_unavailable',
        };
      }
      throw error;
    }
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
        handle = await coordination.open((turns) => {
          if (disposed) return;
          latestTurns = turns;
          routingTranscript = turns.slice(-12).map((turn) => ({
            userText: boundedWorkHubTimelineText(turn.text),
            ...(turn.result
              ? { assistantText: boundedWorkHubTimelineText(turn.result) }
              : {}),
          }));
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
    async requestClarification(input) {
      const result = await coordination.act({
        actionId: input.turnId,
        userText: input.userText,
        proposal: { disposition: 'clarify', assistantText: input.assistantText },
      });
      if (result.disposition !== 'clarify') {
        throw new Error('WorkHub Action Gate returned an unexpected disposition');
      }
      return { turnId: result.coordinationTurnId };
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
        const focusSessionId = readPolicy.focusSnapshot().current?.sessionId;
        return {
          sessions: ordinary
            .map(({ kind: _kind, runningTurnIds: _runningTurnIds, ...session }) => session),
          // Slice 3 renders conversation only from the Coordination Session.
          // Ordinary Session transcripts remain routing evidence, never a
          // second WorkHub conversation source.
          turns: [],
          ...(focusSessionId ? { focusSessionId } : {}),
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
      const resumeDecision = submissionPolicy.resolveResume({
        text: input.text,
        sessions: ordinary,
      });
      const resume = input.attachments?.length ? undefined : await submitNamedDelegationAction(input, resumeDecision, 'resume', routingStrategy.strategyId);
      if (resume) return resume;
      const stopDecision = submissionPolicy.resolveStop({
        text: input.text,
        sessions: ordinary,
      });
      const stop = input.attachments?.length ? undefined : await submitNamedDelegationAction(input, stopDecision, 'stop', routingStrategy.strategyId);
      if (stop) return stop;
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
      const routingInput = boundedRoutingInput({
        text: input.text,
        sessions: routable,
        originPromptBySessionId: new Map(
          routingEvidence.map((entry) => [entry.target.sessionId, entry.originPrompt]),
        ),
        candidateRefBySessionId: new Map(
          candidateSet.candidates.map((candidate) => [candidate.sessionId, candidate.candidateRef]),
        ),
        coordinationTranscript: routingTranscript,
        ...(input.explicitTarget ? { explicitTarget: input.explicitTarget } : {}),
      });
      // Only Policy owns focus and produces proposals. Component output is evidence.
      const decisionPolicy = submissionPolicy.snapshot();
      const evidence = input.explicitTarget ? undefined : await readWorkHubRoutingEvidence(routingStrategy, routingInput);
      const decision = decisionPolicy.resolve({
        text: input.text,
        // Every arm receives the same trusted Policy context. Model input
        // limits must not hide a known Session from exact-name/correction rules.
        sessions: routable,
        originPromptBySessionId: new Map(routingEvidence.map((entry) => [entry.target.sessionId, entry.originPrompt])),
        ...(input.explicitTarget ? { explicitTarget: input.explicitTarget } : {}),
        newSessionFallbackTitle: input.newSessionFallbackTitle,
        ...(evidence ? { interpretation: {
          classification: evidence.classification,
          resolution: evidence.resolution.kind,
          recalledSessionIds: evidence.resolution.kind === 'none' ? [] : evidence.resolution.candidateRefs.flatMap((ref) =>
            [...routingInput.candidateRefBySessionId].filter(([, value]) => value === ref).map(([sessionId]) => sessionId)),
        } } : {}),
      });
      if (decision.kind === 'clarification') {
        const correction = decision.correctedFrom
          ? correctionFor(decision.correctedFrom, candidateBySessionId)
          : undefined;
        return {
          kind: 'clarification',
          strategyId: routingStrategy.strategyId,
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
          ...(input.attachments ? { attachments: input.attachments } : {}),
          proposal: { disposition: 'answer_here' },
        });
        return {
          kind: 'discussion',
          strategyId: routingStrategy.strategyId,
          requestId: input.requestId,
          text: input.text,
        };
      }
      const correction = input.correction ??
        (decision.correctedFrom
          ? correctionFor(decision.correctedFrom, candidateBySessionId)
          : undefined);
      if (decision.kind === 'new_session') {
        const { title } = decision;
        const admitted = await coordination.act(correction
          ? {
              actionId: input.requestId,
              userText: input.text,
          ...(input.attachments ? { attachments: input.attachments } : {}),
              ...(input.newWorkDefaults ? { newWorkDefaults: input.newWorkDefaults } : {}),
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
          ...(input.attachments ? { attachments: input.attachments } : {}),
              ...(input.newWorkDefaults ? { newWorkDefaults: input.newWorkDefaults } : {}),
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
        throw new ExpectedOperationError<WorkHubExpectedFailureCode>('candidates_changed');
      }
      if (targetSession?.state === 'waiting_for_user' && !input.retryAction) {
        return {
          kind: 'waiting',
          strategyId: routingStrategy.strategyId,
          requestId: input.requestId,
          text: input.text,
          target,
        };
      }
      const candidate = candidateBySessionId.get(target.sessionId);
      if (!candidate) {
        throw new ExpectedOperationError<WorkHubExpectedFailureCode>('candidates_changed');
      }
      let action: WorkHubCoordinationActInput = correction
        ? {
            actionId: input.requestId,
            userText: input.text,
          ...(input.attachments ? { attachments: input.attachments } : {}),
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
          ...(input.attachments ? { attachments: input.attachments } : {}),
            candidateSetId: candidateSet.candidateSetId,
            proposal: {
              disposition: 'delegate_existing',
              candidateRef: candidate.candidateRef,
            },
          };
      let admitted: WorkHubCoordinationActResult;
      for (let attempt = 0; ; attempt++) {
        try {
          admitted = await coordination.act(action);
          break;
        } catch (error) {
          if (
            !(error instanceof WorkHubCoordinationFailure) || error.code !== 'candidate_set_stale' ||
            attempt >= 2 || action.proposal.disposition !== 'replace' ||
            action.proposal.target.disposition !== 'delegate_existing'
          ) throw error;
          // Refresh only the opaque reference for the already chosen Session.
          // Do not rerun routing or change action/source identity on this retry.
          const refreshed = await coordination.candidates();
          const sameTarget = refreshed.candidates.find((item) => item.sessionId === target.sessionId);
          if (!sameTarget || sameTarget.sessionName !== candidate.sessionName) throw error;
          action = {
            ...action,
            candidateSetId: refreshed.candidateSetId,
            proposal: {
              ...action.proposal,
              target: { disposition: 'delegate_existing', candidateRef: sameTarget.candidateRef },
            },
          };
        }
      }
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
