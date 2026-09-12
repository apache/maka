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

import { useContext, useMemo, useState, type ComponentProps, type CSSProperties } from 'react';
import { ChatView, useUiLocale } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import { Button, Link, Text } from '@astryxdesign/core';
import { WorkHubHighlightContext, workHubIdentityHue } from './workhub-work-identity.js';
import type { WorkHubDelegationState, WorkHubLinkedWork } from '../model/linked-work.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';

export function WorkHubDelegationStatus(props: {
  work: WorkHubLinkedWork;
  locale: UiLocale;
  showName?: boolean;
}) {
  const { work } = props;
  const copy = workHubLiveCopy[props.locale];
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
  const locale = useUiLocale();
  const copy = workHubLiveCopy[locale];
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  async function loadHistory(edge: 'older' | 'newer') {
    if (loadingHistory) return;
    setLoadingHistory(true);
    setHistoryError(false);
    try { await chat.onPrefetchHistory?.(edge); }
    catch { setHistoryError(true); }
    finally { setLoadingHistory(false); }
  }
  // A coordination turn can delegate to several Works. Keep every label and
  // leave its shared bar neutral rather than attributing the entire turn to one.
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
  const promptRailDecorations = useMemo(() => new Map([...workByTurn].map(([turnId, sessionId]) => [turnId, {
    accentColor: `oklch(var(--workhub-${highlight.sessionId === sessionId ? 'highlight' : 'tone'}) ${workHubIdentityHue(sessionId)})`,
    highlighted: highlight.sessionId === sessionId,
  }])), [workByTurn, highlight.sessionId]);
  const promptTextByTurn = new Map(chat.messages?.flatMap((message) => message.type === 'user' ? [[message.turnId, message.text.slice(0, 80)] as const] : []));
  const turnDecorations = new Map([...worksByTurn].map(([turnId, works]) => [turnId, {
    accentColor: promptRailDecorations.get(turnId)?.accentColor,
    promptStatus: <>{works.map((work, index) => <span key={work.id}>
      {index > 0 ? ' / ' : ''}<WorkHubDelegationStatus work={work} locale={locale} showName={works.length > 1} />
    </span>)}</>,
    messageRail: works.length === 1 ? <Button
      variant="ghost" isIconOnly icon={<span aria-hidden="true" />} className="workhub-message-rail"
      label={`${copy.filterConversation}: ${works[0]!.targetSessionName} · ${promptTextByTurn.get(turnId) ?? turnId}`}
      tooltip={`${copy.filterConversation}: ${works[0]!.targetSessionName}`}
      aria-pressed={highlight.selectedWork?.sessionId === works[0]!.targetSessionId}
      onMouseEnter={() => highlight.highlight(works[0]!.targetSessionId)}
      onMouseLeave={() => highlight.highlight(undefined)}
      onFocus={() => highlight.highlight(works[0]!.targetSessionId)}
      onBlur={() => highlight.highlight(undefined)}
      onClick={() => highlight.toggleWork({ sessionId: works[0]!.targetSessionId, name: works[0]!.targetSessionName })}
    /> : undefined,
    header: <div className="workhub-turn-heading">
      {works.map((work) => <Link
        key={work.targetSessionId}
        type="supporting" color="inherit"
        className="workhub-work-identity workhub-turn-label"
        style={{ '--workhub-work-hue': workHubIdentityHue(work.targetSessionId) } as CSSProperties}
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
  const navigationTurn = [...chat.messages].reverse().find((message) =>
    message.turnId && worksByTurn.get(message.turnId)?.some((work) => work.targetSessionId === highlight.navigationWork?.sessionId))?.turnId;
  return <>
    {selected && <div className="workhub-conversation-filter" role="region" aria-label={copy.filterConversation}>
      <Text type="supporting">{selected.name}</Text>
      <Button variant="ghost" label={copy.clearConversationFilter} onClick={() => highlight.selectWork(undefined)} />
      {chat.hasOlderHistory && <Button variant="ghost" label={copy.olderConversations} isDisabled={loadingHistory} onClick={() => void loadHistory('older')} />}
      {chat.hasNewerHistory && <Button variant="ghost" label={copy.newerConversations} isDisabled={loadingHistory} onClick={() => void loadHistory('newer')} />}
      {historyError && <span role="alert">{copy.controlFailed}</span>}
    </div>}
    <ChatView {...chat}
    scrollTargetTurn={navigationTurn && highlight.navigationWork ? { turnId: navigationTurn, nonce: highlight.navigationWork.nonce, preserveFocus: true } : chat.scrollTargetTurn}
    messages={messages}
    liveTurns={liveTurns}
    transientMessages={selected ? chat.transientMessages?.filter((message) => message.hostTurnId && matchingTurns.has(message.hostTurnId)) : chat.transientMessages}
    activeTurn={activeTurn}
    emptyOverride={selected ? <p>{copy.noWorkConversation}</p> : chat.emptyOverride}
    onRetainWindow={selected ? undefined : chat.onRetainWindow}
    onPrefetchHistory={selected ? undefined : chat.onPrefetchHistory}
    turnDecorations={turnDecorations}
    promptRailDecorations={promptRailDecorations}
    onPromptRailHighlight={(turnId) => highlight.highlight(turnId ? workByTurn.get(turnId) : undefined)}

  /></>;
}
