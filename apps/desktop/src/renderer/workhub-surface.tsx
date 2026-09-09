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

import { useContext, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  Skeleton,
} from '@astryxdesign/core';
import { Button } from '@astryxdesign/core/Button';
import type { UiLocale } from '@maka/core/ui-locale';
import { ChatSurfaceLayout } from '@maka/ui';
import {
  ExpectedOperationError,
  reportUnexpectedError,
} from './application/contracts/operation-diagnostics.js';
import {
  type WorkHubController,
  type WorkHubCoordinationTurn,
  type WorkHubDelegationLinkState,
  type WorkHubProjection,
  type WorkHubSessionSummary,
  type WorkHubSubmission,
  type WorkHubSubmitInput,
} from './workhub-controller.js';
import type { AttachmentRef } from '@maka/core/events';
import { WorkHubCoordinationFailure } from './workhub-coordination-port.js';
import {
  WorkHubSendLease,
  type WorkHubSendAttempt,
} from './workhub-send-lease.js';
import { WorkHubHighlightContext, WorkHubHighlightProvider, workHubIdentityHue, WorkHubNavigationRail, WorkHubPromptRail, WorkHubComposer, type WorkHubComposerServices, type WorkHubComposerSelection } from './features/workhub/index.js';
import { getWorkHubCopy, getWorkHubRailCopy } from './locales/workhub-copy.js';

export { workHubAmbiguousCommandPrompt } from './locales/workhub-copy.js';

export interface WorkHubConversationTurn {
  requestId: string;
  text: string;
  state: 'routing' | 'settled' | 'failed';
  outcome?: WorkHubSubmission;
  failure?: WorkHubSurfaceFailure;
  submissionContext?: WorkHubComposerSelection & { attachments?: AttachmentRef[] };
}

export type WorkHubSurfaceFailure =
  | 'candidates_changed'
  | 'linked_correction_unavailable'
  | 'target_waiting'
  | 'action_changed'
  | 'delivery_failed';

export class WorkHubSurfaceRouteGate {
  #pending = false;

  get pending(): boolean {
    return this.#pending;
  }

  async run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.#pending) return undefined;
    this.#pending = true;
    try {
      return await operation();
    } finally {
      this.#pending = false;
    }
  }
}

export class WorkHubProjectionRefreshGate {
  #generation = 0;

  begin(): () => boolean {
    const generation = ++this.#generation;
    return () => generation === this.#generation;
  }

  invalidate(): void {
    this.#generation += 1;
  }
}

export function workHubSubmissionClearsDraft(
  result: WorkHubSubmission | undefined,
): boolean {
  return Boolean(result && result.kind !== 'waiting');
}

export function workHubSurfaceFailure(error: unknown): WorkHubSurfaceFailure {
  if (
    error instanceof ExpectedOperationError &&
    (error.code === 'candidates_changed' || error.code === 'linked_correction_unavailable')
  ) {
    return error.code;
  }
  if (error instanceof WorkHubCoordinationFailure) {
    if (error.code === 'operation_conflict') return 'action_changed';
    if (error.code === 'candidate_set_stale' || error.code === 'not_found' || error.code === 'session_archived') {
      return 'candidates_changed';
    }
    if (error.code === 'session_busy') return 'target_waiting';
    return 'delivery_failed';
  }
  reportUnexpectedError('workhub:submission', error);
  return 'delivery_failed';
}

export function visibleWorkHubConversation(
  coordination: readonly WorkHubCoordinationTurn[],
  local: readonly WorkHubConversationTurn[],
): {
  coordination: readonly WorkHubCoordinationTurn[];
  local: readonly WorkHubConversationTurn[];
} {
  const localByRequestId = new Map(local.map((turn) => [turn.requestId, turn]));
  const committedTurnIds = new Set(coordination.filter((turn) =>
    turn.result !== undefined || turn.assignment || turn.resume || turn.stop,
  ).map((turn) => turn.turnId));
  const visibleCoordination = coordination.filter(
    (turn) => {
      const localTurn = localByRequestId.get(turn.turnId);
      return !localTurn ||
        (committedTurnIds.has(turn.turnId) && (localTurn.state === 'failed' || localTurn.state === 'routing')) ||
        localTurn.outcome?.kind === 'discussion' ||
        localTurn.outcome?.kind === 'submitted' ||
        localTurn.outcome?.kind === 'stop' || localTurn.outcome?.kind === 'resume';
    },
  );
  const coordinationTurnIds = new Set(coordination.map(({ turnId }) => turnId));
  const visibleLocal = local.filter(
    (turn) =>
      !coordinationTurnIds.has(turn.requestId) ||
      ((!committedTurnIds.has(turn.requestId) || (turn.state !== 'failed' && turn.state !== 'routing')) &&
        turn.outcome?.kind !== 'discussion' &&
        turn.outcome?.kind !== 'submitted' &&
        turn.outcome?.kind !== 'stop' && turn.outcome?.kind !== 'resume'),
  );
  return { coordination: visibleCoordination, local: visibleLocal };
}

export async function submitWorkHubSurfaceInput(input: {
  controller: WorkHubController;
  input: WorkHubSubmitInput;
}): Promise<WorkHubSubmission> {
  return input.controller.submit(input.input);
}

export async function submitAndRecordWorkHubSurfaceInput(input: {
  controller: WorkHubController;
  request: WorkHubSubmitInput;
  recordedUserText: string;
  summary(result: Exclude<WorkHubSubmission, { kind: 'discussion' }>): string;
  onSummaryError(): void;
}): Promise<WorkHubSubmission> {
  const result = await submitWorkHubSurfaceInput({
    controller: input.controller,
    input: input.request,
  });
  // Waiting is a local, retryable admission result: the request has not been
  // accepted and must not consume the immutable Coordination summary owned by
  // this action identity. A later same-identity retry may still be admitted.
  // Delegations project directly from the Host's atomic delegation_assigned
  // record. Local clarification is submitted as its own admitted Host action.
  if (
    result.kind === 'discussion' ||
    result.kind === 'waiting' ||
    result.kind === 'submitted' ||
    result.kind === 'stop' ||
    result.kind === 'resume'
  ) {
    return result;
  }
  try {
    await input.controller.requestClarification({
      turnId: input.request.requestId,
      userText: input.recordedUserText,
      assistantText: input.summary(result),
    });
  } catch (error) {
    input.onSummaryError();
    throw error;
  }
  return result;
}

export async function submitLeasedWorkHubSurfaceInput(input: {
  lease: WorkHubSendLease;
  text: string;
  preserveDraft?: boolean;
  submit(attempt: WorkHubSendAttempt): Promise<WorkHubSubmission | undefined>;
}): Promise<boolean> {
  const attempt = input.lease.acquireAttempt(input.text);
  const result = await input.submit(attempt);
  if (!result) return false;
  const clearsDraft = input.lease.settle(
    attempt.requestId,
    attempt.text,
    workHubSubmissionClearsDraft(result),
  );
  if (input.preserveDraft && clearsDraft) {
    return false;
  }
  return clearsDraft;
}

/**
 * The persistent Coordination Session transcript is the primary conversation.
 * Ordinary Sessions remain a read-only status/routing projection.
 */
interface WorkHubSurfaceProps {
  controller: WorkHubController;
  leaseScope: string;
  locale: UiLocale;
  initialFocusSessionId?: string;
  composerServices?: WorkHubComposerServices;
  onOpenSession(sessionId: string): void;
}

export function WorkHubSurface(props: WorkHubSurfaceProps) {
  const copy = getWorkHubCopy(props.locale);
  const railCopy = getWorkHubRailCopy(props.locale);
  const [projection, setProjection] = useState<WorkHubProjection>({ sessions: [], turns: [] });
  const [coordination, setCoordination] = useState<{
    readonly turns: readonly WorkHubCoordinationTurn[];
    readonly delegatedSessionIds: readonly string[];
  }>({ turns: [], delegatedSessionIds: [] });
  const [turns, setTurns] = useState<WorkHubConversationTurn[]>([]);
  const [pending, setPending] = useState(false);
  const [initialLoadSettled, setInitialLoadSettled] = useState(false);
  const [conversationReady, setConversationReady] = useState(false);
  // React state paints the lock; the gate closes the same-frame window before
  // a rerender can disable Composer and clarification controls.
  const routeGate = useRef(new WorkHubSurfaceRouteGate()).current;
  const refreshGate = useRef(new WorkHubProjectionRefreshGate()).current;
  const sendLease = useRef(new WorkHubSendLease({ scope: props.leaseScope })).current;
  const [loadError, setLoadError] = useState(false);
  const [conversationError, setConversationError] = useState(false);
  const refresh = useCallback(async (focusSessionId?: string) => {
    const isLatest = refreshGate.begin();
    try {
      const next = await props.controller.read(focusSessionId
        ? { focus: { sessionId: focusSessionId } }
        : undefined);
      if (!isLatest()) return;
      setProjection(next);
      setLoadError(false);
      setInitialLoadSettled(true);
    } catch {
      if (!isLatest()) return;
      setLoadError(true);
      setInitialLoadSettled(true);
    }
  }, [props.controller, refreshGate]);

  useEffect(() => {
    void refresh(props.initialFocusSessionId);
    const unsubscribe = props.controller.subscribe(() => void refresh());
    return () => {
      refreshGate.invalidate();
      unsubscribe();
      props.controller.resetVisitContext();
    };
  }, [props.controller, props.initialFocusSessionId, refresh, refreshGate]);

  useEffect(() => {
    let disposed = false;
    let handle: { close(): Promise<void> } | undefined;
    setConversationReady(false);
    setConversationError(false);
    void props.controller.openConversation(
      (next) => {
        if (disposed) return;
        setCoordination({
          turns: next,
          delegatedSessionIds: [...next].sort((left, right) => right.updatedAt - left.updatedAt).flatMap(
            (turn) => turn.assignment?.linkState === 'active' ? [turn.assignment.targetSessionId] : [],
          ),
        });
        setConversationReady(true);
        setConversationError(false);
      },
      () => {
        if (disposed) return;
        setConversationReady(true);
        setConversationError(true);
      },
    ).then((opened) => {
      if (disposed) void opened.close().catch(() => undefined);
      else handle = opened;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      void handle?.close().catch(() => undefined);
    };
  }, [props.controller]);

  const route = useCallback(async (
    input: Omit<WorkHubSubmitInput, 'newSessionFallbackTitle'>,
    localRequestId: string = input.requestId,
    recordedUserText: string = input.text,
  ): Promise<WorkHubSubmission | undefined> => {
    return routeGate.run(async () => {
      setPending(true);
      setTurns((current) => current.map((turn) =>
        turn.requestId === localRequestId
          ? { ...turn, state: 'routing', outcome: undefined }
          : turn,
      ));
      try {
        const result = await submitAndRecordWorkHubSurfaceInput({
          controller: props.controller,
          request: { ...input, newSessionFallbackTitle: copy.newSessionFallbackTitle },
          recordedUserText,
          summary: (result) => workHubCoordinationSummary(result, projection, copy),
          // Clarification remains a local transcript write; delegated sends
          // are projected directly from the Host-owned assignment record.
          onSummaryError: () => setConversationError(true),
        });
        setTurns((current) => current.map((turn) =>
          turn.requestId === localRequestId
            ? { ...turn, state: 'settled', outcome: result }
            : turn,
        ));
        if (result.kind === 'submitted' || result.kind === 'stop' || result.kind === 'resume')
          await refresh();
        return result;
      } catch (error) {
        if (isTerminalWorkHubSurfaceFailure(error)) {
          sendLease.abandon(input.requestId);
        }
        setTurns((current) => current.map((turn) =>
          turn.requestId === localRequestId
            ? {
                ...turn,
                state: 'failed',
                outcome: undefined,
                failure: workHubSurfaceFailure(error),
              }
            : turn,
        ));
        return undefined;
      } finally {
        setPending(false);
      }
    });
  }, [copy, projection, props.controller, refresh, routeGate]);

  const send = useCallback(async (value: string, selection: WorkHubComposerSelection, onAccepted?: () => void) => {
    const text = value.trim();
    if (!text || !initialLoadSettled || !conversationReady || routeGate.pending) return false;
    const submissionContext = selection;
    const accepted = await submitLeasedWorkHubSurfaceInput({
      lease: sendLease,
      text,
      submit: async (attempt) => {
        const { requestId } = attempt;
        setTurns((current) => current.some((turn) => turn.requestId === requestId)
          ? current.map((turn) => turn.requestId === requestId
            ? { requestId, text: attempt.text, state: 'routing', submissionContext }
            : turn)
          : [...current, { requestId, text: attempt.text, state: 'routing', submissionContext }]);
        const result = await route({
          requestId,
          text: attempt.text,
          ...submissionContext,
          ...(attempt.retrying ? { retryAction: true as const } : {}),
        });
        if (workHubSubmissionClearsDraft(result)) onAccepted?.();
        return result;
      },
    });
    return accepted;
  }, [conversationReady, initialLoadSettled, route, routeGate, sendLease]);
  const visible = visibleWorkHubConversation(coordination.turns, turns);
  const visibleCoordinationTurns = visible.coordination;
  const visibleLocalTurns = visible.local;
  const conversationEmpty = visibleCoordinationTurns.length === 0 && visibleLocalTurns.length === 0;
  const surfaceReady = initialLoadSettled && conversationReady;

  return (
    <WorkHubHighlightProvider>
    <ChatSurfaceLayout
      className="workhub-surface"
      composer={(
        <WorkHubComposer
          services={props.composerServices ? {
            ...props.composerServices,
            sessions: props.composerServices.sessions.filter((session) => projection.sessions.some((work) => work.target.sessionId === session.id)),
          } : undefined}
          locale={props.locale}
          attachmentScope={props.leaseScope}
          draftKey="workhub"
          draftPersistence={sendLease}
          onSend={send}
          onStop={() => {}}
          sendBlocked={pending || !surfaceReady}
          modelLabel="WorkHub"
          showStaticModelUnavailableStatus={false}
        />
      )}
    >
      <section className="maka-main agents-chat-panel agents-chat-view-root workhub-timeline" aria-label="WorkHub">
        <header className="workhub-header">
          <div>
            <h1>WorkHub</h1>
            <p>{copy.subtitle}</p>
          </div>
          <span>{surfaceReady
            ? copy.workCount(projection.sessions.length)
            : copy.loading}</span>
        </header>

        <div className="workhub-body">
          <WorkHubNavigationRail
            locale={props.locale}
            sessions={projection.sessions}
            focusSessionId={projection.focusSessionId}
            delegatedSessionIds={coordination.delegatedSessionIds}
            copy={railCopy}
            onOpenSession={props.onOpenSession}
          />

          <div className="maka-chat-shell workhub-conversation-shell">
            <WorkHubPromptRail turns={[
              ...visibleCoordinationTurns.map((turn) => ({
                turnId: `workhub-message-${turn.messageId}`,
                label: turn.text,
                reply: turn.result,
                sessionId: turn.assignment?.targetSessionId ?? turn.stop?.targetSessionId,
              })),
              ...visibleLocalTurns.map((turn) => ({
                turnId: `workhub-request-${turn.requestId}`,
                label: turn.text,
                sessionId: turn.outcome?.kind === 'submitted' || turn.outcome?.kind === 'stop' || turn.outcome?.kind === 'resume'
                  ? turn.outcome.target.sessionId : undefined,
              })),
            ]} />
            <ChatMessageList
              className="maka-chat-message-list maka-chatContent workhub-message-list"
              gap={4}
              isStreaming={pending}
            >
            {!surfaceReady ? (
              <WorkHubLoadingState label={copy.loading} />
            ) : conversationEmpty && !loadError && !conversationError ? (
              <div className="workhub-empty">
                <h2>{copy.emptyTitle}</h2>
                <p>{copy.emptyBody(projection.sessions.length)}</p>
              </div>
            ) : (
              <div className="workhub-turns">
                {loadError || conversationError ? (
                  <div className="workhub-empty" role="alert">{copy.loadFailed}</div>
                ) : null}
                {visibleCoordinationTurns.map((turn) => (
                  <WorkHubCoordinationTurnView
                    key={turn.messageId}
                    turn={turn}
                    projection={projection}
                    locale={props.locale}
                    onOpenSession={props.onOpenSession}
                  />
                ))}
                {visibleLocalTurns.map((turn) => (
                  <WorkHubTurnView
                    key={turn.requestId}
                    turn={turn}
                    projection={projection}
                    copy={copy}
                    pending={pending}
                    onChoose={(target) => {
                      const selected = projection.sessions.find(
                        (session) => session.target.sessionId === target.sessionId,
                      );
                      void submitLeasedWorkHubSurfaceInput({
                        lease: sendLease,
                        text: turn.text,
                        preserveDraft: true,
                        submit: (attempt) => route({
                          requestId: attempt.requestId,
                          text: attempt.text,
                          ...turn.submissionContext,
                          explicitTarget: target,
                          ...(attempt.retrying ? { retryAction: true as const } : {}),
                          ...(turn.outcome?.kind === 'clarification' && turn.outcome.correction
                            ? { correction: turn.outcome.correction }
                            : {}),
                        }, turn.requestId, copy.choseWork(
                          selected?.sessionName ?? copy.sessionFallback,
                        )),
                      });
                    }}
                    onOpenSession={props.onOpenSession}
                  />
                ))}
              </div>
            )}
            </ChatMessageList>
          </div>
        </div>
      </section>
    </ChatSurfaceLayout>
    </WorkHubHighlightProvider>
  );
}

function isTerminalWorkHubSurfaceFailure(error: unknown): boolean {
  return (
    error instanceof WorkHubCoordinationFailure &&
    (error.code === 'operation_conflict' ||
      error.code === 'not_found' ||
      error.code === 'session_archived' ||
      error.code === 'unauthorized')
  );
}

/** Visible lifecycle state while the active Host's Coordination Session is unavailable. */
export function WorkHubCoordinationStatus(props: {
  locale: UiLocale;
  state: 'resolving' | 'failed';
  onRetry(): void;
}) {
  const copy = getWorkHubCopy(props.locale);
  const resolving = props.state === 'resolving';
  return (
    <ChatSurfaceLayout
      className="workhub-surface"
      composer={(
        <WorkHubComposer
          locale={props.locale}
          draftKey="workhub"
          onSend={async () => false}
          onStop={() => {}}
          sendBlocked
          modelLabel="WorkHub"
          showStaticModelUnavailableStatus={false}
        />
      )}
    >
      <section
        className="maka-main agents-chat-panel agents-chat-view-root workhub-timeline"
        aria-label="WorkHub"
      >
        <header className="workhub-header">
          <div>
            <h1>WorkHub</h1>
            <p>{copy.subtitle}</p>
          </div>
          <span>{resolving ? copy.preparing : copy.unavailable}</span>
        </header>
        <div className="maka-chat-shell">
          <ChatMessageList
            className="maka-chat-message-list maka-chatContent workhub-message-list"
            gap={4}
            isStreaming={resolving}
          >
            {resolving ? (
              <WorkHubLoadingState label={copy.preparing} />
            ) : (
              <div className="workhub-empty" role="alert">
                <h2>{copy.coordinationFailedTitle}</h2>
                <p>{copy.coordinationFailedBody}</p>
                <Button
                  className="workhub-coordination-retry"
                  variant="primary"
                  label={copy.retry}
                  onClick={props.onRetry}
                />
              </div>
            )}
          </ChatMessageList>
        </div>
      </section>
    </ChatSurfaceLayout>
  );
}

function WorkHubLoadingState(props: { label: string }) {
  return (
    <div
      className="workhub-turns workhub-loading"
      role="status"
      aria-busy="true"
      aria-label={props.label}
    >
      {[0, 1].map((index) => (
        <div key={index} className="workhub-turn workhub-loading-turn" aria-hidden="true">
          <div className="workhub-loading-user">
            <Skeleton width="38%" height={44} radius="rounded" index={index * 3} />
          </div>
          <Skeleton width="28%" height={12} radius="rounded" index={index * 3 + 1} />
          <Skeleton width="100%" height={72} radius={3} index={index * 3 + 2} />
        </div>
      ))}
    </div>
  );
}

/** @internal Presentational seam for durable Coordination turns. */
export function WorkHubCoordinationTurnView(props: {
  turn: WorkHubCoordinationTurn;
  projection: WorkHubProjection;
  locale: UiLocale;
  onOpenSession(sessionId: string): void;
}) {
  const copy = getWorkHubCopy(props.locale);
  const assignment = props.turn.assignment;
  const session = assignment
    ? props.projection.sessions.find(
        (candidate) => candidate.target.sessionId === assignment.targetSessionId,
      )
    : undefined;
  const stoppedSession = props.turn.stop
    ? props.projection.sessions.find(
        (candidate) => candidate.target.sessionId === props.turn.stop!.targetSessionId,
      )
    : undefined;
  return (
    <WorkHubMessageFrame
      anchorId={`workhub-message-${props.turn.messageId}`}
      text={props.turn.text}
      attachments={props.turn.attachments}
      state={props.turn.stop?.outcome ?? (assignment?.linkState === 'active'
        ? assignment.feedbackState
        : assignment?.linkState ?? props.turn.state)}
      linkState={assignment?.linkState}
      projected
      work={assignment || props.turn.stop ? {
        sessionId: assignment?.targetSessionId ?? props.turn.stop!.targetSessionId,
        name: session?.sessionName ?? stoppedSession?.sessionName ?? assignment?.targetSessionName ?? props.turn.stop!.targetSessionName,
        projectName: session?.projectName ?? stoppedSession?.projectName,
      } : undefined}
      onOpenSession={props.onOpenSession}
    >
      {props.turn.stop ? (
        <SubmittedWorkView
          session={stoppedSession}
          targetSessionId={props.turn.stop.targetSessionId}
          fallbackName={props.turn.stop.targetSessionName}
          heading={props.turn.stop.outcome
            ? copy.stopOutcomes[props.turn.stop.outcome]
            : copy.stoppingWork}
          state={props.turn.stop.outcome === 'not_owned'
            ? copy.openSessionToStop
            : props.turn.stop.outcome
              ? copy.stopRecorded
              : copy.stopping}
          result={undefined}
          copy={copy}
          onOpenSession={props.onOpenSession}
        />
      ) : props.turn.resume ? (
        <SubmittedWorkView
          session={props.projection.sessions.find(
            (candidate) => candidate.target.sessionId === props.turn.resume!.targetSessionId,
          )}
          targetSessionId={props.turn.resume.targetSessionId}
          heading={copy.resumeOutcomes[props.turn.resume.outcome]}
          state={copy.resumeRequested}
          result={undefined}
          copy={copy}
          onOpenSession={props.onOpenSession}
        />
      ) : assignment ? (
        <SubmittedWorkView
          session={session}
          targetSessionId={assignment.targetSessionId}
          fallbackName={assignment.targetSessionName}
          heading={assignment.createdNew ? copy.createdWork : copy.sentTo}
          state={assignment.linkState === 'active'
            ? copy.assignmentLinkStates.active(copy.delegationStates[assignment.feedbackState])
            : copy.assignmentLinkStates[assignment.linkState]}
          result={undefined}
          copy={copy}
          onOpenSession={props.onOpenSession}
        />
      ) : props.turn.result ? (
        <p className="workhub-result">{props.turn.result}</p>
      ) : props.turn.state === 'running' ? (
        <p className="workhub-status" role="status">{copy.answering}</p>
      ) : (
        <p className="workhub-error" role="alert">
          {props.turn.coordinationActionId
            ? copy.actionConfirmationIncomplete : copy.turnStates[props.turn.state]}
        </p>
      )}
    </WorkHubMessageFrame>
  );
}

/**
 * A stop clarification has to say what WorkHub could not decide. Every reason
 * here is a distinct dead end for the user — an unnamed target, a name that
 * fits several Sessions, and a Session the Host will not stop because it owns
 * no single delegation a stop can reach.
 */
function workHubClarificationPrompt(
  reason: Extract<WorkHubSubmission, { kind: 'clarification' }>['reason'],
  copy: ReturnType<typeof getWorkHubCopy>,
): string | undefined {
  if (reason === 'ambiguous_command') return copy.confirmCommand;
  if (reason === 'stop_target_required') return copy.stopTargetRequired;
  if (reason === 'stop_target_ambiguous') return copy.stopTargetAmbiguous;
  if (reason === 'stop_target_unavailable') return copy.stopTargetUnavailable;
  if (reason === 'resume_target_required') return copy.resumeTargetRequired;
  if (reason === 'resume_target_ambiguous') return copy.resumeTargetAmbiguous;
  if (reason === 'resume_target_unavailable') return copy.resumeTargetUnavailable;
  if (reason === 'resume_operation_unavailable') return copy.resumeOperationUnavailable;
  if (reason === 'resume_host_recovering') return copy.resumeHostRecovering;
  return undefined;
}

export function workHubCoordinationSummary(
  result: Exclude<WorkHubSubmission, { kind: 'discussion' }>,
  projection: WorkHubProjection,
  copy: ReturnType<typeof getWorkHubCopy>,
): string {
  if (result.kind === 'clarification') {
    const prompt = workHubClarificationPrompt(result.reason, copy);
    if (prompt) {
      return result.options.length > 0
        ? `${prompt} ${result.options.map(({ sessionName }) => sessionName).join('、')}`
        : prompt;
    }
    return `${copy.chooseWork} ${result.options.map(({ sessionName }) => sessionName).join('、')}`;
  }
  if (result.kind === 'waiting') {
    return copy.waitingSummary;
  }
  if (result.kind === 'stop') return copy.stopOutcomes[result.outcome];
  if (result.kind === 'resume') return copy.resumeRequested;
  const target = projection.sessions.find(
    (session) => session.target.sessionId === result.target.sessionId,
  );
  const name = target?.sessionName ?? copy.sessionFallback;
  const state = target
    ? target.archived
      ? copy.archived
      : copy.states[target.state]
    : copy.accepted;
  return `${copy.sentTo} ${name} · ${state}`;
}

function WorkHubTurnView(props: {
  turn: WorkHubConversationTurn;
  projection: WorkHubProjection;
  copy: ReturnType<typeof getWorkHubCopy>;
  pending: boolean;
  onChoose(target: { sessionId: string }): void;
  onOpenSession(sessionId: string): void;
}) {
  const { turn, copy } = props;
  const submitted = turn.outcome?.kind === 'submitted' ? turn.outcome : undefined;
  const stopped = turn.outcome?.kind === 'stop' ? turn.outcome : undefined;
  const resumed = turn.outcome?.kind === 'resume' ? turn.outcome : undefined;
  const target = submitted
    ? props.projection.sessions.find((session) => session.target.sessionId === submitted.target.sessionId)
    : undefined;

  return (
    <WorkHubMessageFrame
      anchorId={`workhub-request-${turn.requestId}`}
      text={turn.text}
      attachments={turn.submissionContext?.attachments}
      state={turn.state}
      work={submitted ? {
        sessionId: submitted.target.sessionId,
        name: target?.sessionName ?? copy.sessionFallback,
        projectName: target?.projectName,
      } : undefined}
      onOpenSession={props.onOpenSession}
    >
          {turn.state === 'routing' ? (
            <p className="workhub-status" role="status">{copy.routing}</p>
          ) : turn.state === 'failed' ? (
            <p className="workhub-error" role="alert">
              {copy.submitFailures[turn.failure ?? 'delivery_failed']}
            </p>
          ) : turn.outcome?.kind === 'clarification' ? (
            <>
              <p>{workHubClarificationPrompt(turn.outcome.reason, copy) ?? copy.chooseWork}</p>
              {turn.outcome.options.length > 0 ? (
                <div className="workhub-clarification" aria-label={copy.clarification}>
                  {turn.outcome.options.map((option) => (
                    <Button
                      key={option.target.sessionId}
                      label={`${option.sessionName}, ${option.projectName}`}
                      variant="ghost"
                      width="100%"
                      isDisabled={props.pending}
                      onClick={() => props.onChoose(option.target)}
                      endContent={
                        <small className="workhub-option-project">{option.projectName}</small>
                      }>
                      <strong>{option.sessionName}</strong>
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          ) : turn.outcome?.kind === 'discussion' ? (
            <>
              <p>{copy.discussionStayed}</p>
              <small>{copy.discussionHint}</small>
            </>
          ) : turn.outcome?.kind === 'waiting' ? (
            <div className="workhub-waiting" role="status">
              <p>{copy.waitingForDecision}</p>
              <small>{copy.requestNotSent}</small>
            </div>
          ) : stopped ? (
            <SubmittedWorkView
              session={props.projection.sessions.find(
                (session) => session.target.sessionId === stopped.target.sessionId,
              )}
              targetSessionId={stopped.target.sessionId}
              heading={copy.stopOutcomes[stopped.outcome]}
              state={stopped.outcome === 'not_owned' ? copy.openSessionToStop : copy.stopRecorded}
              result={undefined}
              copy={copy}
              onOpenSession={props.onOpenSession}
            />
          ) : resumed ? (
            <SubmittedWorkView
              session={props.projection.sessions.find(
                (session) => session.target.sessionId === resumed.target.sessionId,
              )}
              targetSessionId={resumed.target.sessionId}
              heading={copy.resumeOutcomes[resumed.outcome]}
              state=""
              result={undefined}
              copy={copy}
              onOpenSession={props.onOpenSession}
            />
          ) : submitted ? (
            <SubmittedWorkView
              session={target}
              targetSessionId={submitted.target.sessionId}
              heading={submitted.evidence === 'new_session' ? copy.createdWork : copy.sentTo}
              state={target
                ? (target.archived ? copy.archived : copy.states[target.state])
                : copy.accepted}
              result={target?.latestResult}
              copy={copy}
              onOpenSession={props.onOpenSession}
            />
          ) : null}
    </WorkHubMessageFrame>
  );
}

function WorkHubMessageFrame(props: {
  anchorId: string;
  text: string;
  attachments?: AttachmentRef[];
  state: string;
  linkState?: WorkHubDelegationLinkState;
  projected?: boolean;
  work?: { sessionId: string; name: string; projectName?: string };
  onOpenSession?(sessionId: string): void;
  children: ReactNode;
}) {
  const highlight = useContext(WorkHubHighlightContext);
  const work = props.work;
  const rail = work ? (
    <span
      className="workhub-work-rail"
      aria-hidden="true"
      onMouseEnter={() => highlight.highlight(work.sessionId)}
      onMouseLeave={() => highlight.highlight(undefined)}
    />
  ) : null;
  return (
    <section
      className={`workhub-turn${props.projected ? ' workhub-projected-turn' : ''}${props.work ? ' workhub-bound-turn' : ''}`}
      style={props.work ? { '--workhub-work-hue': workHubIdentityHue(props.work.sessionId) } as CSSProperties : undefined}
      aria-label={props.text}
      data-turn-id={props.anchorId}
      data-transcript-turn-id={props.anchorId}
      data-work-session-id={props.work?.sessionId}
      data-work-highlighted={Boolean(work && highlight.sessionId === work.sessionId)}
      data-state={props.state}
      data-link-state={props.linkState}
    >
      {props.work ? (
        <div className="workhub-message-identity">
          <Button
            variant="ghost"
            label={[props.work.projectName, props.work.name].filter(Boolean).join(' / ')}
            onMouseEnter={() => highlight.highlight(work!.sessionId)}
            onMouseLeave={() => highlight.highlight(undefined)}
            onFocus={() => highlight.highlight(work!.sessionId)}
            onBlur={() => highlight.highlight(undefined)}
            onClick={() => props.onOpenSession?.(props.work!.sessionId)}
          >
            {props.work.projectName ? <span>{props.work.projectName}<span aria-hidden="true"> / </span></span> : null}
            <strong>{props.work.name}</strong>
          </Button>
        </div>
      ) : null}
      <ChatMessage sender="user" className="workhub-message">
        <ChatMessageBubble className="maka-chat-message-bubble maka-chat-message-bubble-user workhub-user-bubble">
          {rail}
          <p>{props.text}</p>
          {props.attachments?.length ? <ul className="workhub-message-attachments">{props.attachments.map((attachment, index) => <li key={index}>{attachment.name}</li>)}</ul> : null}
        </ChatMessageBubble>
      </ChatMessage>
      <ChatMessage sender="assistant" className="workhub-message">
        <ChatMessageBubble
          variant="ghost"
          width="100%"
          className="maka-chat-message-bubble maka-chat-message-bubble-assistant workhub-assistant-bubble"
        >
          {rail}
          {props.children}
        </ChatMessageBubble>
      </ChatMessage>
    </section>
  );
}

function SubmittedWorkView(props: {
  session: WorkHubSessionSummary | undefined;
  targetSessionId: string;
  fallbackName?: string;
  heading: string;
  state: string;
  result: string | undefined;
  copy: ReturnType<typeof getWorkHubCopy>;
  onOpenSession(sessionId: string): void;
}) {
  const { session, copy } = props;
  const sessionName = session?.sessionName ?? props.fallbackName ?? copy.sessionFallback;
  return (
    <div className="workhub-submitted">
      <p>{props.heading}</p>
      <Button
        label={`${sessionName}, ${props.state}`}
        variant="ghost"
        width="100%"
        onClick={() => props.onOpenSession(props.targetSessionId)}
        endContent={<span className="workhub-submitted-state">{props.state}</span>}>
        <span className="workhub-submitted-session">
          <strong>{sessionName}</strong>
          {session?.projectName ? <small>{session.projectName}</small> : null}
        </span>
      </Button>
      {props.result ? <p className="workhub-result">{props.result}</p> : null}
    </div>
  );
}
