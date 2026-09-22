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

import { useContext, useMemo, type ComponentProps } from 'react';
import { ChatView, useUiLocale } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import { Button, Link, Text } from '@astryxdesign/core';
import { WorkHubHighlightContext, useWorkHubIdentityHue } from './workhub-work-identity.js';
import type { WorkHubDelegationState, WorkHubLinkedWork } from '../model/linked-work.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';
import { deriveWorkHubTurnPresentation } from '../model/turn-presentation.js';

export function WorkHubDelegationStatus(props: {
  work: WorkHubLinkedWork;
  locale: UiLocale;
  showName?: boolean;
}) {
  const { work } = props;
  const copy = workHubLiveCopy[props.locale];
  if (work.operation) {
    const operation = work.operation === 'stop' ? copy.stopAction : copy.resumeAction;
    const state = work.operationState ?? 'pending';
    const outcome = work.operationOutcome;
    const label = state === 'pending' ? copy.actionPending : state === 'failed' ? copy.actionFailed
      : outcome === 'stop_delivered' ? copy.stopDelivered
      : outcome === 'already_terminal' ? copy.alreadyTerminal
      : outcome === 'cancelled_pending' ? copy.pendingCancelled
      : outcome === 'already_running' ? copy.alreadyRunning : copy.resumeStarted;
    return <Text type="supporting" color="secondary" className="workhub-delegation-status" role="status" data-work-operation={work.operation}>
      {props.showName ? `${work.targetSessionName}: ` : ''}{operation} · {label}
    </Text>;
  }
  const state = work.state ?? 'accepted';
  const stateLabel = {
    accepted: copy.delegationAccepted,
    running: copy.delegationRunning,
    waiting_for_user: copy.delegationWaiting,
    completed: copy.delegationCompleted,
    failed: copy.delegationFailed,
    aborted: copy.delegationAborted,
    recovering: copy.delegationRecovering,
  }[state];
  return <Text type="supporting" color="secondary" className="workhub-delegation-status" role="status" data-work-state={state}>
    {props.showName ? `${work.targetSessionName}: ` : ''}{stateLabel}
  </Text>;
}

export function WorkHubConversation(props: ComponentProps<typeof ChatView> & { workLinks: readonly WorkHubLinkedWork[]; onOpenWork(sessionId: string): void; promptStates?: ReadonlyMap<string, WorkHubDelegationState> }) {
  const { onOpenWork, workLinks: assignments, promptStates, ...chat } = props;
  const highlight = useContext(WorkHubHighlightContext);
  const workHubIdentityHue = useWorkHubIdentityHue(assignments.map((work) => work.targetSessionId));
  const locale = useUiLocale();
  const copy = workHubLiveCopy[locale];
  // A coordination turn can delegate to several Works. Keep every label and
  // divide its rail evenly, keeping every segment linked to its own Session.
  const worksByTurn = useMemo(() => {
    const grouped = new Map<string, WorkHubLinkedWork[]>();
    for (const work of assignments) {
      const works = grouped.get(work.coordinationTurnId) ?? [];
      if (!works.some((item) => item.targetSessionId === work.targetSessionId)) works.push(work);
      grouped.set(work.coordinationTurnId, works);
    }
    return grouped;
  }, [assignments]);
  const workByTurn = useMemo(() => new Map([...worksByTurn].flatMap(([turnId, works]) =>
    works.length === 1 ? [[turnId, works[0]!.targetSessionId] as const] : [])), [worksByTurn]);
  const promptRailDecorations = useMemo(() => new Map([...worksByTurn].map(([turnId, works]) => {
    const colors = works.map((work) => `oklch(var(--workhub-${highlight.sessionId === work.targetSessionId ? 'highlight' : 'tone'}) ${workHubIdentityHue(work.targetSessionId)})`);
    return [turnId, {
      accentColor: works.length === 1 ? colors[0] : undefined,
      accentBackground: works.length > 1 ? `linear-gradient(to right, ${colors.map((color, index) => `${color} ${index * 100 / colors.length}% ${(index + 1) * 100 / colors.length}%`).join(', ')})` : undefined,
      highlighted: works.some((work) => highlight.sessionId === work.targetSessionId),
    }];
  })), [worksByTurn, highlight.sessionId, workHubIdentityHue]);
  const promptTextByTurn = new Map(chat.messages?.flatMap((message) => message.type === 'user' ? [[message.turnId, message.text.slice(0, 80)] as const] : []));
  const turnDecorations = new Map<string, NonNullable<ComponentProps<typeof ChatView>['turnDecorations']> extends ReadonlyMap<string, infer V> ? V : never>([...worksByTurn].map(([turnId, works]) => [turnId, {
    accentColor: promptRailDecorations.get(turnId)?.accentColor ?? 'transparent',
    promptStatus: <>{works.map((work, index) => <span key={work.id}>
      {index > 0 ? ' / ' : ''}<WorkHubDelegationStatus work={work} locale={locale} showName={works.length > 1} />
    </span>)}</>,
    messageRail: <>{works.map((work, index) => <Button key={work.targetSessionId}
      variant="ghost" isIconOnly icon={<span aria-hidden="true" />} className="workhub-message-rail"
      style={{ insetBlockStart: `${index * 100 / works.length}%`, insetBlockEnd: 'auto', height: `${100 / works.length}%`,
        '--maka-turn-accent': `oklch(var(--workhub-${highlight.sessionId === work.targetSessionId ? 'highlight' : 'tone'}) ${workHubIdentityHue(work.targetSessionId)})`,
      } as CSSProperties}
      data-work-session-id={work.targetSessionId}
      label={`${copy.filterConversation}: ${work.targetSessionName} · ${promptTextByTurn.get(turnId) ?? turnId}`}
      tooltip={`${copy.filterConversation}: ${work.targetSessionName}`}
      aria-pressed={highlight.selectedWork?.sessionId === work.targetSessionId}
      data-work-highlighted={highlight.sessionId === work.targetSessionId}
      onMouseEnter={() => highlight.highlight(work.targetSessionId)}
      onMouseLeave={() => highlight.highlight(undefined)}
      onFocus={() => highlight.highlight(work.targetSessionId)}
      onBlur={() => highlight.highlight(undefined)}
      onClick={() => highlight.toggleWork({ sessionId: work.targetSessionId, name: work.targetSessionName })}
    />)}</>,
    header: <div className="workhub-turn-heading">
      {works.map((work) => <Link
        key={work.targetSessionId}
        type="supporting" color="secondary"
        className="workhub-turn-label"
        data-work-session-id={work.targetSessionId}
        data-work-highlighted={highlight.sessionId === work.targetSessionId}
        aria-label={`${work.workspaceName ? `${work.workspaceName} / ` : ''}${work.targetSessionName} · ${promptTextByTurn.get(turnId) ?? turnId}`}
        onMouseEnter={() => highlight.highlight(work.targetSessionId)}
        onMouseLeave={() => highlight.highlight(undefined)}
        onFocus={() => highlight.highlight(work.targetSessionId)}
        onBlur={() => highlight.highlight(undefined)}
        onClick={() => onOpenWork(work.targetSessionId)}
      >{work.workspaceName ? `${work.workspaceName} / ${work.targetSessionName}` : work.targetSessionName}</Link>)}
    </div>,
  }]));
  for (const [turnId, state] of promptStates ?? []) {
    if (!turnDecorations.has(turnId)) turnDecorations.set(turnId, {
      header: <></>, accentColor: undefined, messageRail: undefined,
      promptStatus: <WorkHubDelegationStatus locale={locale} work={{ id: turnId, coordinationTurnId: turnId, targetSessionId: '', targetSessionName: '', state }} />,
    });
  }
  const selected = highlight.selectedWork;
  const matchingTurns = new Set([...worksByTurn].filter(([, works]) => works.some((work) => work.targetSessionId === selected?.sessionId)).map(([turnId]) => turnId));
  const messages = selected ? chat.messages.filter((message) => message.turnId !== undefined && matchingTurns.has(message.turnId)) : chat.messages;
  const liveTurns = selected ? chat.liveTurns?.filter((turn) => matchingTurns.has(turn.turnId)) : chat.liveTurns;
  const activeTurn = selected && chat.activeTurn && !matchingTurns.has(chat.activeTurn.turnId) ? undefined : chat.activeTurn;
  return <>
    {selected && <div className="workhub-conversation-filter" role="region" aria-label={copy.filterConversation}>
      <Text type="supporting">{selected.name}</Text>
      <Button variant="ghost" label={copy.clearConversationFilter} onClick={() => highlight.selectWork(undefined)} />
    </div>}
    <ChatView {...chat}
    messages={messages}
    liveTurns={liveTurns}
    transientMessages={selected ? chat.transientMessages?.filter((message) => message.hostTurnId && matchingTurns.has(message.hostTurnId)) : chat.transientMessages}
    activeTurn={activeTurn}
    deriveTurnPresentation={(turns) => deriveWorkHubTurnPresentation(turns, locale)}
    emptyOverride={selected ? <p>{copy.noWorkConversation}</p> : chat.emptyOverride}
    turnDecorations={turnDecorations}
    promptRailDecorations={promptRailDecorations}
    onPromptRailHighlight={(turnId) => highlight.highlight(turnId ? workByTurn.get(turnId) : undefined)}

  /></>;
}
