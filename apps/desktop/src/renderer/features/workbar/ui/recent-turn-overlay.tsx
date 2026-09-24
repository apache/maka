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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, MessageSquare, Minus, Terminal } from '@maka/ui/icons';
import { Button, MarkdownBody, ProgressCard, progressStatusCopy, applyLiveTurnBufferEvent, type LiveTurnBuffer, type LiveTurnProjection, useUiLocale } from '@maka/ui';
import { redactSecrets } from '@maka/core/redaction';
import { isInFlightToolStatus } from '@maka/core/tool-result-status';
import type { SessionSummary } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import { activeHostTurn } from '../../../application/contracts/session-execution.js';
import { useWorkbarServices } from '../services-context.js';

const COPY: Record<UiLocale, {
  processingFor: (elapsed: number) => string;
  noReply: string;
  runningTool: string;
  finishedTool: string;
  waiting: string;
  readFailed: string;
  minimize: string;
  restore: string;
  partial: string;
}> = {
  'zh-CN': {
    processingFor: (elapsed) => elapsed < 60
      ? `已处理 ${elapsed} 秒` : `已处理 ${Math.floor(elapsed / 60)} 分钟 ${elapsed % 60} 秒`,
    noReply: '暂无最近回复', runningTool: '正在运行', finishedTool: '运行了', waiting: '等待下一步…', readFailed: '暂时无法读取最近回复',
    minimize: '收起输入区', restore: '继续输入',
    partial: '这里只显示部分回复，完整内容请查看对话。',
  },
  'zh-TW': {
    processingFor: (elapsed) => elapsed < 60
      ? `已處理 ${elapsed} 秒` : `已處理 ${Math.floor(elapsed / 60)} 分鐘 ${elapsed % 60} 秒`,
    noReply: '尚無最近回覆', runningTool: '正在執行', finishedTool: '執行了', waiting: '等待下一步…', readFailed: '暫時無法讀取最近回覆',
    minimize: '收起輸入區', restore: '繼續輸入',
    partial: '這裡只顯示部分回覆，完整內容請查看對話。',
  },
  en: {
    processingFor: (elapsed) => elapsed < 60
      ? `Working for ${elapsed}s` : `Working for ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`,
    noReply: 'No recent reply', runningTool: 'Running', finishedTool: 'Ran', waiting: 'Waiting for the next step…', readFailed: 'Unable to load the latest reply',
    minimize: 'Minimize composer', restore: 'Continue typing',
    partial: 'Only part of this reply is shown. Open the conversation for the full content.',
  },
};

const MAX_VISIBLE_TEXT = 16_000;

type RecentItem =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; text: string; busy: boolean; readsFiles: boolean };

function boundedText(text: string): string {
  return redactSecrets(text).slice(0, MAX_VISIBLE_TEXT);
}

function visibleLiveItems(turn: LiveTurnProjection | undefined): RecentItem[] | undefined {
  return turn?.steps.flatMap((step) => (step.contentOrder ?? ['text', 'tools']).flatMap((kind): RecentItem[] => {
    if (kind === 'text' && step.text?.text.trim()) {
      return [{ kind: 'text' as const, id: `${step.stepId}:text`, text: step.text.text }];
    }
    if (kind === 'tools') {
      return step.tools.filter((tool) => tool.modelVisibility !== 'hidden').map((tool) => ({
        kind: 'tool' as const, id: tool.toolUseId,
        text: tool.displayName || tool.toolName, busy: isInFlightToolStatus(tool.status),
        readsFiles: /read|file|open/i.test(tool.toolName),
      }));
    }
    return [];
  }));
}

/** One read-only projection of the current or most recently settled turn. */
export function RecentTurnOverlay(props: {
  sessionId: string;
  sourceSession?: SessionSummary;
  hidden?: boolean;
  onHeightChange(height: number): void;
  minimized?: boolean;
  onMinimize?(): void;
  onRestore?(): void;
  onExit(): void;
  onOpenConversation(turnId?: string): void;
}) {
  const { sideChat } = useWorkbarServices();
  const locale = useUiLocale();
  const copy = COPY[locale];
  const progress = progressStatusCopy[locale];
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef({ turnId: '', top: 0, follow: false });
  const [expanded, setExpanded] = useState(false);
  const [observed, setObserved] = useState(false);
  const [runningTurnId, setRunningTurnId] = useState<string | null | undefined>();
  const [interruptedTurnId, setInterruptedTurnId] = useState<string>();
  const [failedTurnId, setFailedTurnId] = useState<string>();
  const [awaitingInput, setAwaitingInput] = useState(false);
  const [liveTurns, setLiveTurns] = useState<LiveTurnBuffer>();
  const [settledReply, setSettledReply] = useState<{ turnId: string; revision: number; text?: string }>();
  const [readError, setReadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const lastLive = liveTurns?.at(-1);
  const running = runningTurnId === undefined
    ? Boolean(props.sourceSession?.runningTurnIds?.length || (lastLive && !lastLive.terminal))
    : runningTurnId !== null;
  const activeLive = runningTurnId ? liveTurns?.find((turn) => turn.turnId === runningTurnId) : lastLive;
  const lastLiveTurnId = lastLive?.turnId;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => props.onHeightChange(Math.ceil(root.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => { observer.disconnect(); props.onHeightChange(0); };
  }, [props.onHeightChange]);

  useEffect(() => {
    let disposed = false;
    const offEvents = sideChat.subscribeEvents(props.sessionId, (event) => {
      if (disposed) return;
      if (event.type === 'abort' || event.type === 'error') setInterruptedTurnId(event.turnId);
      if (event.type === 'error') setFailedTurnId(event.turnId);
      setLiveTurns((current) => applyLiveTurnBufferEvent(current, event, locale)?.slice(-2));
    }, () => { if (!disposed) setObserved(true); }, () => { if (!disposed) setObserved(true); }, (projection) => {
      if (disposed || !projection?.available) return;
      setRunningTurnId(activeHostTurn(projection)?.turnId ?? null);
      setAwaitingInput(activeHostTurn(projection)?.status === 'waiting_for_user');
    });
    const offChanges = sideChat.subscribeSessionChanges((change) => {
      if (!disposed && change.sessionId === props.sessionId) setRevision((value) => value + 1);
    });
    return () => { disposed = true; offEvents(); offChanges(); };
  }, [sideChat, props.sessionId, locale]);

  useEffect(() => {
    if (!observed || running) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const load = async () => {
      try {
        const turns = await sideChat.listTurns(props.sessionId);
        const turnId = lastLiveTurnId ?? turns.at(-1)?.turnId;
        if (!turnId) return;
        const result = await sideChat.readSettledMessages(props.sessionId, { requiredTurnId: turnId });
        if (disposed) return;
        if (!result.settled) {
          if (++attempts < 6) retryTimer = setTimeout(() => void load(), 700);
          return;
        }
        const answer = result.messages.filter((message) => message.type === 'assistant' && message.turnId === turnId).at(-1);
        setSettledReply({ turnId, revision, text: answer?.type === 'assistant' ? answer.text : undefined });
        setReadError(false);
      } catch {
        if (!disposed) setReadError(true);
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(retryTimer); };
  }, [sideChat, props.sessionId, observed, running, lastLiveTurnId, revision]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const startedAt = activeLive?.startedAt ?? props.sourceSession?.statusUpdatedAt;
  const elapsed = startedAt && now >= startedAt && now - startedAt < 24 * 60 * 60 * 1_000
    ? Math.floor((now - startedAt) / 1_000) : undefined;
  const settledText = settledReply?.revision === revision &&
    (!lastLiveTurnId || settledReply.turnId === lastLiveTurnId) ? settledReply.text : undefined;
  const interrupted = !running && lastLiveTurnId && interruptedTurnId === lastLiveTurnId;
  const needsAttention = awaitingInput || (!running && (readError || props.sourceSession?.status === 'blocked' ||
    (lastLiveTurnId && failedTurnId === lastLiveTurnId)));
  const label = needsAttention ? progress.attention : running ? elapsed === undefined ? progress.working : copy.processingFor(elapsed)
    : interrupted || props.sourceSession?.status === 'aborted' ? progress.paused : progress.finished;
  // A stopped turn may never write an assistant text_complete. Keep its
  // bounded live projection until a persisted answer replaces it.
  const allLiveItems = running || (!settledText && activeLive?.terminal) ? visibleLiveItems(activeLive) : undefined;
  const liveItems = allLiveItems?.slice(-12);
  const truncated = (allLiveItems?.length ?? 0) > 12 ||
    (liveItems?.some((item) => redactSecrets(item.text).length > MAX_VISIBLE_TEXT) ?? false) ||
    (!liveItems?.length && redactSecrets(settledText ?? '').length > MAX_VISIBLE_TEXT);
  const displayedTurnId = runningTurnId ?? lastLiveTurnId ?? settledReply?.turnId;
  const showingContent = expanded && !props.minimized && !props.hidden;

  useLayoutEffect(() => {
    if (!displayedTurnId || !showingContent || !contentRef.current) return;
    const el = contentRef.current;
    const reading = readingRef.current;
    if (reading.turnId !== displayedTurnId) {
      Object.assign(reading, { turnId: displayedTurnId, top: 0, follow: running });
    }
    // This child's layout effect runs before WorkbarHost applies the focused
    // width. Restore after all layout effects, before paint, so a temporary
    // split width cannot reflow Markdown and move the saved reading position.
    queueMicrotask(() => {
      el.scrollTop = running && reading.follow ? el.scrollHeight : reading.top;
    });
  }, [showingContent, displayedTurnId, running, activeLive, settledText]);

  if (props.hidden) return <div ref={rootRef} hidden />;

  return <div ref={rootRef} className="maka-recent-turn-overlay"
    data-minimized={props.minimized || undefined} data-expanded={!props.minimized && expanded || undefined}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      props.onExit();
    }}>
    <ProgressCard label={label} status={props.minimized ? `${label} · ${copy.restore}` : label} active={running}
      primaryAction={{
        label: props.minimized ? `${label} · ${copy.restore}` : label,
        expanded: props.minimized ? undefined : expanded,
        controls: props.minimized ? undefined : 'maka-focused-recent-turn-content',
        icon: props.minimized ? <MessageSquare size={12} aria-hidden="true" />
          : expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />,
        onClick: () => {
          if (props.minimized) { props.onRestore?.(); return; }
          setExpanded((value) => !value);
        },
      }}
      secondaryAction={!props.minimized && props.onMinimize ? {
        label: copy.minimize, icon: <Minus size={12} aria-hidden="true" />, onClick: props.onMinimize,
      } : undefined} />
    {showingContent && <>
    <div className="maka-recent-turn-navigation">
      {truncated && <p role="note">{copy.partial}</p>}
      <Button size="sm" variant="ghost" label={progress.openConversation} onClick={() => props.onOpenConversation(displayedTurnId)}>{progress.openConversation}</Button>
    </div>
    <div id="maka-focused-recent-turn-content" className="maka-recent-turn-content" ref={contentRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        readingRef.current.top = el.scrollTop;
        readingRef.current.follow = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}>
      {liveItems?.length ? liveItems.map((item) => item.kind === 'text'
        ? <div key={item.id} className="maka-recent-turn-message"><MarkdownBody text={boundedText(item.text)} density="compact" /></div>
        : <div key={item.id} className="maka-recent-turn-tool">
          {item.readsFiles ? <FolderOpen size={16} aria-hidden="true" /> : <Terminal size={16} aria-hidden="true" />}
          <span>{item.busy ? copy.runningTool : copy.finishedTool} {boundedText(item.text)}</span></div>)
        : running ? <p className="maka-recent-turn-placeholder">{copy.waiting}</p>
      : <div className="maka-recent-turn-message">
          {settledText ? <MarkdownBody text={boundedText(settledText)} density="compact" />
            : <p className="maka-recent-turn-placeholder">{readError ? copy.readFailed : copy.noReply}</p>}
        </div>}
    </div></>}
  </div>;
}
