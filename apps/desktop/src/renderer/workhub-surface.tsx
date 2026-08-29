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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  Skeleton,
} from '@astryxdesign/core';
import { Button } from '@astryxdesign/core/Button';
import type { UiLocale } from '@maka/core/ui-locale';
import { ChatSurfaceLayout, Composer } from '@maka/ui';
import type {
  WorkHubController,
  WorkHubCoordinationTurn,
  WorkHubProjection,
  WorkHubSessionSummary,
  WorkHubSubmission,
  WorkHubSubmitInput,
} from './workhub-controller.js';
import {
  WorkHubSendLease,
  type WorkHubSendAttempt,
} from './workhub-send-lease.js';
import { WorkHubCoordinationFailure } from './workhub-coordination-port.js';

export interface WorkHubConversationTurn {
  requestId: string;
  text: string;
  state: 'routing' | 'settled' | 'failed';
  outcome?: WorkHubSubmission;
  failure?: WorkHubSurfaceFailure;
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
  if (error instanceof WorkHubCoordinationFailure) {
    if (error.code === 'operation_conflict') return 'action_changed';
    if (error.code === 'not_found' || error.code === 'session_archived') {
      return 'candidates_changed';
    }
    if (error.code === 'session_busy') return 'target_waiting';
    return 'delivery_failed';
  }
  const message = error instanceof Error ? error.message : '';
  if (
    /candidates changed|not in the admitted candidate set|source or target is not in/iu.test(
      message,
    )
  ) {
    return 'candidates_changed';
  }
  if (/linked correction requires persistent delegation support/iu.test(message)) {
    return 'linked_correction_unavailable';
  }
  if (/waiting for user input/iu.test(message)) return 'target_waiting';
  if (/identity belongs to a different proposal/iu.test(message)) {
    return 'action_changed';
  }
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
  const visibleCoordination = coordination.filter(
    (turn) =>
      localByRequestId.get(turn.turnId)?.outcome?.kind === 'discussion' ||
      !localByRequestId.has(turn.turnId),
  );
  const coordinationTurnIds = new Set(coordination.map(({ turnId }) => turnId));
  const visibleLocal = local.filter(
    (turn) => turn.outcome?.kind !== 'discussion' || !coordinationTurnIds.has(turn.requestId),
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
  // record. Only local clarification still needs the generic summary path.
  if (
    result.kind === 'discussion' ||
    result.kind === 'waiting' ||
    result.kind === 'submitted'
  ) {
    return result;
  }
  try {
    await input.controller.recordConversationTurn({
      turnId: input.request.requestId,
      userText: input.recordedUserText,
      assistantText: input.summary(result),
      disposition: result.kind === 'clarification' ? 'clarify' : 'summary',
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
export function WorkHubSurface(props: {
  controller: WorkHubController;
  leaseScope: string;
  locale: UiLocale;
  initialFocusSessionId?: string;
  onOpenSession(sessionId: string): void;
}) {
  const copy = workHubCopy(props.locale);
  const [projection, setProjection] = useState<WorkHubProjection>({ sessions: [], turns: [] });
  const [coordinationTurns, setCoordinationTurns] = useState<readonly WorkHubCoordinationTurn[]>([]);
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
        setCoordinationTurns(next);
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
    input: WorkHubSubmitInput,
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
          request: input,
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
        if (result.kind === 'submitted') await refresh();
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

  const send = useCallback(async (value: string) => {
    const text = value.trim();
    if (!text || !initialLoadSettled || !conversationReady || routeGate.pending) return false;
    return submitLeasedWorkHubSurfaceInput({
      lease: sendLease,
      text,
      submit: async (attempt) => {
        const { requestId } = attempt;
        setTurns((current) => current.some((turn) => turn.requestId === requestId)
          ? current.map((turn) => turn.requestId === requestId
            ? { requestId, text: attempt.text, state: 'routing' }
            : turn)
          : [...current, { requestId, text: attempt.text, state: 'routing' }]);
        return route({
          requestId,
          text: attempt.text,
          ...(attempt.retrying ? { retryAction: true as const } : {}),
        });
      },
    });
  }, [conversationReady, initialLoadSettled, route, routeGate, sendLease]);
  const visible = visibleWorkHubConversation(coordinationTurns, turns);
  const visibleCoordinationTurns = visible.coordination;
  const visibleLocalTurns = visible.local;
  const conversationEmpty = visibleCoordinationTurns.length === 0 && visibleLocalTurns.length === 0;
  const surfaceReady = initialLoadSettled && conversationReady;

  return (
    <ChatSurfaceLayout
      className="workhub-surface"
      composer={(
        <Composer
          draftKey="workhub"
          draftPersistence={sendLease}
          onSend={send}
          onStop={() => {}}
          sendBlocked={pending || !surfaceReady}
          modelLabel="WorkHub"
        />
      )}
    >
      <main className="maka-main agents-chat-panel agents-chat-view-root workhub-timeline" aria-label="WorkHub">
        <header className="workhub-header">
          <div>
            <h1>WorkHub</h1>
            <p>{copy.subtitle}</p>
          </div>
          <span>{surfaceReady
            ? copy.workCount(projection.sessions.length)
            : copy.loading}</span>
        </header>

        <div className="maka-chat-shell">
          <ChatMessageList
            className="maka-chat-message-list maka-chatContent workhub-message-list"
            density="compact"
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
                  <CoordinationTurnView
                    key={turn.messageId}
                    turn={turn}
                    copy={copy}
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
      </main>
    </ChatSurfaceLayout>
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
  const copy = workHubCopy(props.locale);
  const resolving = props.state === 'resolving';
  return (
    <ChatSurfaceLayout
      className="workhub-surface"
      composer={(
        <Composer
          draftKey="workhub"
          onSend={async () => false}
          onStop={() => {}}
          sendBlocked
          modelLabel="WorkHub"
        />
      )}
    >
      <main
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
            density="compact"
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
      </main>
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

function CoordinationTurnView(props: {
  turn: WorkHubCoordinationTurn;
  copy: ReturnType<typeof workHubCopy>;
}) {
  return (
    <WorkHubMessageFrame text={props.turn.text} state={props.turn.state} projected>
      {props.turn.assignment ? (
        <p className="workhub-result">
          {props.copy.sentTo} {props.turn.assignment.targetSessionName} · {props.copy.accepted}
        </p>
      ) : props.turn.result ? (
        <p className="workhub-result">{props.turn.result}</p>
      ) : props.turn.state === 'running' ? (
        <p className="workhub-status" role="status">{props.copy.answering}</p>
      ) : (
        <p className="workhub-error" role="alert">
          {props.copy.turnStates[props.turn.state]}
        </p>
      )}
    </WorkHubMessageFrame>
  );
}

export function workHubCoordinationSummary(
  result: Exclude<WorkHubSubmission, { kind: 'discussion' }>,
  projection: WorkHubProjection,
  copy: ReturnType<typeof workHubCopy>,
): string {
  if (result.kind === 'clarification') {
    return `${copy.chooseWork} ${result.options.map(({ sessionName }) => sessionName).join('、')}`;
  }
  if (result.kind === 'waiting') {
    return `${copy.waitingForDecision} ${copy.requestNotSent}`;
  }
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
  copy: ReturnType<typeof workHubCopy>;
  pending: boolean;
  onChoose(target: { sessionId: string }): void;
  onOpenSession(sessionId: string): void;
}) {
  const { turn, copy } = props;
  const submitted = turn.outcome?.kind === 'submitted' ? turn.outcome : undefined;
  const target = submitted
    ? props.projection.sessions.find((session) => session.target.sessionId === submitted.target.sessionId)
    : undefined;

  return (
    <WorkHubMessageFrame text={turn.text} state={turn.state}>
          {turn.state === 'routing' ? (
            <p className="workhub-status" role="status">{copy.routing}</p>
          ) : turn.state === 'failed' ? (
            <p className="workhub-error" role="alert">
              {copy.submitFailures[turn.failure ?? 'delivery_failed']}
            </p>
          ) : turn.outcome?.kind === 'clarification' ? (
            <>
              <p>{copy.chooseWork}</p>
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
          ) : submitted ? (
            <SubmittedWorkView
              session={target}
              targetSessionId={submitted.target.sessionId}
              heading={copy.sentTo}
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
  text: string;
  state: string;
  projected?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`workhub-turn${props.projected ? ' workhub-projected-turn' : ''}`}
      data-state={props.state}
    >
      <ChatMessage sender="user" density="compact" className="workhub-message">
        <ChatMessageBubble className="maka-chat-message-bubble maka-chat-message-bubble-user workhub-user-bubble">
          <p>{props.text}</p>
        </ChatMessageBubble>
      </ChatMessage>
      <ChatMessage sender="assistant" density="compact" className="workhub-message">
        <ChatMessageBubble
          variant="ghost"
          width="100%"
          className="maka-chat-message-bubble maka-chat-message-bubble-assistant workhub-assistant-bubble"
        >
          {props.children}
        </ChatMessageBubble>
      </ChatMessage>
    </section>
  );
}

function SubmittedWorkView(props: {
  session: WorkHubSessionSummary | undefined;
  targetSessionId: string;
  heading: string;
  state: string;
  result: string | undefined;
  copy: ReturnType<typeof workHubCopy>;
  onOpenSession(sessionId: string): void;
}) {
  const { session, copy } = props;
  return (
    <div className="workhub-submitted">
      <p>{props.heading}</p>
      <Button
        label={`${session?.sessionName ?? copy.sessionFallback}, ${props.state}`}
        variant="ghost"
        width="100%"
        onClick={() => props.onOpenSession(props.targetSessionId)}
        endContent={<span className="workhub-submitted-state">{props.state}</span>}>
        <span className="workhub-submitted-session">
          <strong>{session?.sessionName ?? copy.sessionFallback}</strong>
          {session?.projectName ? <small>{session.projectName}</small> : null}
        </span>
      </Button>
      {props.result ? <p className="workhub-result">{props.result}</p> : null}
    </div>
  );
}

function workHubCopy(locale: UiLocale) {
  if (locale === 'zh') {
    return {
      locale,
      subtitle: '在一个入口里继续、创建和查看普通 Session',
      emptyTitle: '从这里继续所有工作',
      emptyBody: (count: number) => count > 0
        ? `WorkHub 会根据已有 ${count} 个 Session 判断目标；不确定时会先询问你。`
        : '提出一个明确目标，WorkHub 会创建普通 Session 并把结果带回这里。',
      workCount: (count: number) => `${count} 项工作`, clarification: '选择工作',
      chooseWork: '这条输入可能与多项工作有关，请选择目标：',
      discussionStayed: '这条内容暂时保留在 WorkHub，没有创建或改动 Session。',
      discussionHint: '提出明确的执行目标后，我会把它交给对应的 Session。',
      answering: '正在回答…',
      choseWork: (name: string) => `选择“${name}”`,
      sentTo: '已交给：', accepted: '已接收', sessionFallback: '普通 Session',
      waitingForDecision: '这项工作正在等待你的决定。',
      requestNotSent: '新请求尚未发送；处理原 Session 中的交互后可以再次发送。',
      routing: '正在判断应该交给哪个 Session…', loadFailed: '无法读取已有工作。',
      loading: '正在读取已有工作…',
      preparing: '正在准备 WorkHub…', unavailable: '暂不可用',
      coordinationFailedTitle: 'WorkHub 暂时无法启动',
      coordinationFailedBody: '请检查当前 Runtime Host 的默认模型配置，然后重试。',
      retry: '重试',
      submitFailures: {
        candidates_changed: '工作列表已变化，请重新发送以使用最新目标。',
        linked_correction_unavailable: '跨 Session 更正将在持久委托关联完成后开放；请先打开原 Session 停止当前工作。',
        target_waiting: '目标 Session 正在等待你的处理；请先打开并完成该交互。',
        action_changed: '这次操作已发生变化，请重新发送。',
        delivery_failed: '输入未能送达，请重试。',
      }, scrollToBottom: '滚动到底部', archived: '已归档',
      states: { active: '活跃', running: '进行中', waiting_for_user: '等待你', blocked: '受阻', aborted: '已中止' },
      turnStates: { running: '进行中', completed: '已完成', aborted: '已中止', failed: '失败' },
    } as const;
  }
  return {
    locale,
    subtitle: 'Continue, create, and review ordinary Sessions from one place',
    emptyTitle: 'Continue all work from here',
    emptyBody: (count: number) => count > 0
      ? `WorkHub routes against ${count} existing Session${count === 1 ? '' : 's'} and asks when the target is unclear.`
      : 'State a clear goal and WorkHub will create an ordinary Session and bring its result back here.',
    workCount: (count: number) => `${count} work item${count === 1 ? '' : 's'}`, clarification: 'Choose work',
    chooseWork: 'This input may relate to more than one task. Choose a target:',
    discussionStayed: 'This stayed in WorkHub without creating or changing a Session.',
    discussionHint: 'State an executable goal and I will hand it to the owning Session.',
    answering: 'Answering…',
    choseWork: (name: string) => `Choose “${name}”`,
    sentTo: 'Sent to:', accepted: 'Accepted', sessionFallback: 'Ordinary Session',
    waitingForDecision: 'This work is waiting for your decision.',
    requestNotSent: 'The new request was not sent. Resolve the interaction in its Session, then send again.',
    routing: 'Choosing the right Session…', loadFailed: 'Could not read existing work.',
    loading: 'Loading existing work…',
    preparing: 'Preparing WorkHub…', unavailable: 'Unavailable',
    coordinationFailedTitle: 'WorkHub could not start',
    coordinationFailedBody: 'Check the default model for the current Runtime Host, then retry.',
    retry: 'Retry',
    submitFailures: {
      candidates_changed: 'The work list changed. Send again to use the latest targets.',
      linked_correction_unavailable: 'Cross-Session correction will be available with persistent delegation. Open the original Session to stop its current work first.',
      target_waiting: 'The target Session needs your input. Open it and resolve that interaction first.',
      action_changed: 'This action changed. Send it again.',
      delivery_failed: 'The input could not be delivered. Try again.',
    }, scrollToBottom: 'Scroll to bottom', archived: 'Archived',
    states: { active: 'Active', running: 'Running', waiting_for_user: 'Waiting for you', blocked: 'Blocked', aborted: 'Aborted' },
    turnStates: { running: 'Running', completed: 'Completed', aborted: 'Aborted', failed: 'Failed' },
  } as const;
}
