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
import { ChatMessage, ChatMessageBubble, ChatMessageList } from '@astryxdesign/core';
import { Button } from '@astryxdesign/core/Button';
import type { UiLocale } from '@maka/core/ui-locale';
import { ChatSurfaceLayout, Composer } from '@maka/ui';
import type {
  WorkHubController,
  WorkHubProjection,
  WorkHubProjectedTurn,
  WorkHubSessionSummary,
  WorkHubSubmission,
  WorkHubSubmitInput,
} from './workhub-controller.js';
import { boundedWorkHubTimelineText } from './workhub-controller.js';

export interface WorkHubConversationTurn {
  requestId: string;
  text: string;
  state: 'routing' | 'settled' | 'failed';
  outcome?: WorkHubSubmission;
}

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

export function workHubSubmissionCanCorrect(
  result: WorkHubSubmission,
): result is Extract<WorkHubSubmission, { kind: 'submitted' }> {
  return result.kind === 'submitted' && !result.steered;
}

export async function submitWorkHubSurfaceInput(input: {
  controller: WorkHubController;
  input: WorkHubSubmitInput;
}): Promise<WorkHubSubmission> {
  return input.controller.submit(input.input);
}

export function visibleWorkHubProjectedTurns(
  projected: readonly WorkHubProjectedTurn[],
  local: readonly WorkHubConversationTurn[],
): WorkHubProjectedTurn[] {
  const localTurnCounts = new Map<string, number>();
  for (const turn of local) {
    if (turn.outcome?.kind !== 'submitted') continue;
    const key = projectedTurnKey(turn.outcome.target, turn.outcome.turnId, turn.text);
    localTurnCounts.set(key, (localTurnCounts.get(key) ?? 0) + 1);
  }
  const visible: WorkHubProjectedTurn[] = [];
  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const turn = projected[index]!;
    const key = projectedTurnKey(turn.target, turn.turnId, turn.text);
    const remaining = localTurnCounts.get(key) ?? 0;
    if (remaining > 0) {
      localTurnCounts.set(key, remaining - 1);
    } else {
      visible.push(turn);
    }
  }
  return visible.reverse();
}

function projectedTurnKey(
  target: { sessionId: string },
  turnId: string,
  text: string,
): string {
  return JSON.stringify([
    target.sessionId,
    turnId,
    boundedWorkHubTimelineText(text),
  ]);
}

export function projectedWorkHubTurnPresentation(
  state: WorkHubProjectedTurn['state'],
  archived: boolean,
  locale: UiLocale,
): { heading: string; state: string } {
  const copy = workHubCopy(locale);
  return {
    heading: archived ? copy.archivedSessionRecord : copy.sessionRecord,
    state: copy.turnStates[state],
  };
}

/**
 * A transient conversation projection over ordinary Sessions.
 *
 * This surface deliberately does not persist its own transcript. Session and
 * Runtime remain authoritative; local turns only keep WorkHub conversational
 * while the surface is mounted.
 */
export function WorkHubSurface(props: {
  controller: WorkHubController;
  locale: UiLocale;
  onOpenSession(sessionId: string): void;
}) {
  const copy = workHubCopy(props.locale);
  const [projection, setProjection] = useState<WorkHubProjection>({ sessions: [], turns: [] });
  const [turns, setTurns] = useState<WorkHubConversationTurn[]>([]);
  const [pending, setPending] = useState(false);
  // React state paints the lock; the gate closes the same-frame window before
  // a rerender can disable Composer and clarification controls.
  const routeGate = useRef(new WorkHubSurfaceRouteGate()).current;
  const refreshGate = useRef(new WorkHubProjectionRefreshGate()).current;
  const [loadError, setLoadError] = useState(false);
  const refresh = useCallback(async () => {
    const isLatest = refreshGate.begin();
    try {
      const next = await props.controller.read();
      if (!isLatest()) return;
      setProjection(next);
      setLoadError(false);
    } catch {
      if (!isLatest()) return;
      setLoadError(true);
    }
  }, [props.controller, refreshGate]);

  useEffect(() => {
    void refresh();
    const unsubscribe = props.controller.subscribe(() => void refresh());
    return () => {
      refreshGate.invalidate();
      unsubscribe();
    };
  }, [props.controller, refresh, refreshGate]);

  const route = useCallback(async (
    input: WorkHubSubmitInput,
  ): Promise<WorkHubSubmission | undefined> => {
    return routeGate.run(async () => {
      setPending(true);
      setTurns((current) => current.map((turn) =>
        turn.requestId === input.requestId
          ? { ...turn, state: 'routing', outcome: undefined }
          : turn,
      ));
      try {
        const result = await submitWorkHubSurfaceInput({
          controller: props.controller,
          input,
        });
        setTurns((current) => current.map((turn) =>
          turn.requestId === input.requestId
            ? { ...turn, state: 'settled', outcome: result }
            : turn,
        ));
        if (result.kind === 'submitted') await refresh();
        return result;
      } catch {
        setTurns((current) => current.map((turn) =>
          turn.requestId === input.requestId
            ? { ...turn, state: 'failed', outcome: undefined }
            : turn,
        ));
        return undefined;
      } finally {
        setPending(false);
      }
    });
  }, [props.controller, refresh, routeGate]);

  const send = useCallback(async (value: string) => {
    const text = value.trim();
    if (!text || routeGate.pending) return false;
    const requestId = crypto.randomUUID();
    setTurns((current) => [...current, { requestId, text, state: 'routing' }]);
    const result = await route({ requestId, text });
    // Composer clears only accepted drafts. Waiting, delivery failures, and a
    // ref-blocked duplicate keep the exact text available for retry.
    return workHubSubmissionClearsDraft(result);
  }, [route, routeGate]);
  const projectedTurns = visibleWorkHubProjectedTurns(projection.turns, turns);
  const conversationEmpty = projectedTurns.length === 0 && turns.length === 0;

  return (
    <ChatSurfaceLayout
      className="workhub-surface"
      conversationKey="workhub"
      composer={(
        <Composer
          draftKey="workhub"
          onSend={send}
          onStop={() => {}}
          sendBlocked={pending}
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
          <span>{copy.workCount(projection.sessions.length)}</span>
        </header>

        <div className="maka-chat-shell">
          <ChatMessageList
            className="maka-chat-message-list maka-chatContent workhub-message-list"
            density="compact"
            gap={4}
            isStreaming={pending}
          >
            {loadError ? (
              <div className="workhub-empty" role="alert">{copy.loadFailed}</div>
            ) : conversationEmpty ? (
              <div className="workhub-empty">
                <h2>{copy.emptyTitle}</h2>
                <p>{copy.emptyBody(projection.sessions.length)}</p>
              </div>
            ) : (
              <div className="workhub-turns">
                {projectedTurns.map((turn) => (
                  <ProjectedWorkHubTurnView
                    key={`${turn.target.sessionId}:${turn.messageId}`}
                    turn={turn}
                    projection={projection}
                    copy={copy}
                    onOpenSession={props.onOpenSession}
                  />
                ))}
                {turns.map((turn) => (
                  <WorkHubTurnView
                    key={turn.requestId}
                    turn={turn}
                    projection={projection}
                    copy={copy}
                    pending={pending}
                    onChoose={(target) => void route({
                      requestId: turn.requestId,
                      text: turn.text,
                      explicitTarget: target,
                    })}
                    onCorrect={(from, target) => void route({
                      requestId: turn.requestId,
                      text: turn.text,
                      explicitTarget: target,
                      correction: {
                        from: from.target,
                        turnId: from.turnId,
                        ...(from.steered ? { steered: true } : {}),
                      },
                    })}
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

function ProjectedWorkHubTurnView(props: {
  turn: WorkHubProjectedTurn;
  projection: WorkHubProjection;
  copy: ReturnType<typeof workHubCopy>;
  onOpenSession(sessionId: string): void;
}) {
  const session = props.projection.sessions.find(
    (candidate) => candidate.target.sessionId === props.turn.target.sessionId,
  );
  const presentation = projectedWorkHubTurnPresentation(
    props.turn.state,
    session?.archived ?? false,
    props.copy.locale,
  );
  return (
    <WorkHubMessageFrame text={props.turn.text} state="settled" projected>
      <SubmittedWorkView
        session={session}
        correctedFrom={undefined}
        targetSessionId={props.turn.target.sessionId}
        heading={presentation.heading}
        state={presentation.state}
        result={props.turn.result}
        copy={props.copy}
        correctionOptions={[]}
        pending={false}
        onOpenSession={props.onOpenSession}
      />
    </WorkHubMessageFrame>
  );
}

function WorkHubTurnView(props: {
  turn: WorkHubConversationTurn;
  projection: WorkHubProjection;
  copy: ReturnType<typeof workHubCopy>;
  pending: boolean;
  onChoose(target: { sessionId: string }): void;
  onCorrect(
    from: Extract<WorkHubSubmission, { kind: 'submitted' }>,
    target: { sessionId: string },
  ): void;
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
            <p className="workhub-error" role="alert">{copy.submitFailed}</p>
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
              correctedFrom={submitted.correctedFrom
                ? props.projection.sessions.find(
                    (session) =>
                      session.target.sessionId === submitted.correctedFrom?.sessionId,
                  )
                : undefined}
              targetSessionId={submitted.target.sessionId}
              heading={copy.sentTo}
              state={target
                ? (target.archived ? copy.archived : copy.states[target.state])
                : copy.accepted}
              result={target?.latestResult}
              copy={copy}
              correctionOptions={workHubSubmissionCanCorrect(submitted)
                ? props.projection.sessions.filter(
                    (session) =>
                      !session.archived &&
                      session.target.sessionId !== submitted.target.sessionId,
                  )
                : []}
              pending={props.pending}
              onCorrect={(target) => props.onCorrect(submitted, target)}
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
        <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant workhub-assistant-bubble">
          {props.children}
        </ChatMessageBubble>
      </ChatMessage>
    </section>
  );
}

function SubmittedWorkView(props: {
  session: WorkHubSessionSummary | undefined;
  correctedFrom: WorkHubSessionSummary | undefined;
  targetSessionId: string;
  heading: string;
  state: string;
  result: string | undefined;
  copy: ReturnType<typeof workHubCopy>;
  correctionOptions: WorkHubSessionSummary[];
  pending: boolean;
  onCorrect?(target: { sessionId: string }): void;
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
      {props.correctedFrom ? (
        <small className="workhub-correction-note">
          {copy.correctedFrom(props.correctedFrom.sessionName)}
        </small>
      ) : null}
      {props.result ? <p className="workhub-result">{props.result}</p> : null}
      {props.correctionOptions.length > 0 ? (
        <details className="workhub-correction">
          <summary>{copy.correctTarget}</summary>
          <div>
            {props.correctionOptions.map((option) => (
              <Button
                key={option.target.sessionId}
                label={`${option.sessionName}, ${option.projectName}`}
                variant="ghost"
                width="100%"
                isDisabled={props.pending}
                onClick={() => props.onCorrect?.(option.target)}
                endContent={
                  <small className="workhub-option-project">{option.projectName}</small>
                }>
                <strong>{option.sessionName}</strong>
              </Button>
            ))}
          </div>
        </details>
      ) : null}
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
      sentTo: '已交给：', accepted: '已接收', sessionFallback: '普通 Session',
      sessionRecord: '来自 Session：',
      archivedSessionRecord: '来自已归档 Session：',
      correctTarget: '更正目标',
      correctedFrom: (name: string) => `已从“${name}”更正`,
      waitingForDecision: '这项工作正在等待你的决定。',
      requestNotSent: '新请求尚未发送；处理原 Session 中的交互后可以再次发送。',
      routing: '正在判断应该交给哪个 Session…', loadFailed: '无法读取已有工作。',
      submitFailed: '输入未能送达，请重试。', scrollToBottom: '滚动到底部', archived: '已归档',
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
    sentTo: 'Sent to:', accepted: 'Accepted', sessionFallback: 'Ordinary Session',
    sessionRecord: 'From Session:',
    archivedSessionRecord: 'From archived Session:',
    correctTarget: 'Correct target',
    correctedFrom: (name: string) => `Corrected from “${name}”`,
    waitingForDecision: 'This work is waiting for your decision.',
    requestNotSent: 'The new request was not sent. Resolve the interaction in its Session, then send again.',
    routing: 'Choosing the right Session…', loadFailed: 'Could not read existing work.',
    submitFailed: 'The input could not be delivered. Try again.', scrollToBottom: 'Scroll to bottom', archived: 'Archived',
    states: { active: 'Active', running: 'Running', waiting_for_user: 'Waiting for you', blocked: 'Blocked', aborted: 'Aborted' },
    turnStates: { running: 'Running', completed: 'Completed', aborted: 'Aborted', failed: 'Failed' },
  } as const;
}
