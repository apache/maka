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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ICON_SIZE,
  AlertTriangle,
  ArrowRight,
} from './icons.js';
import { DeepResearchEmptyHero, EmptyChatHero } from './chat-empty-hero.js';
import type { ChatModelChoice } from './chat-model-helpers.js';
import { PromptAnchorRail, type PromptAnchorRailTurn } from './prompt-anchor-rail.js';
import { useMessageSelectionQuote } from './use-message-selection-quote.js';
import type { DeepResearchClientProgress } from '@maka/core/deep-research-run';
import type { ProviderType } from '@maka/core/llm-connections';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { ShellRunUpdate } from '@maka/core/events';
import { isDeepResearchSession } from '@maka/core/explore-agent';
import { Button, ButtonGroup, ChatMessageList, EmptyState, Spinner } from '@astryxdesign/core';
import { useChatLayoutContext } from '@astryxdesign/core/Chat';
import { useLayer } from '@astryxdesign/core/Layer';
import { materializeChat } from './materialize.js';
import { useTranscriptProjection } from './use-transcript-projection.js';
import type { LiveTurnProjection } from './live-turn-projection.js';
import {
  ModelProviderRetryIndicator,
  LocalizedChatMessage,
  TurnRunningStatus,
  TurnView,
  type ReadAttachmentBytes,
  type TurnFooterActionMeta,
  type TurnPresentationDeriver,
} from './chat-turn.js';
import { useChatScroll } from './use-chat-scroll.js';
import { useTurnVirtualizer } from './use-turn-virtualizer.js';
import { placeChatConversationItems } from './chat-conversation-items.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { SessionContextLayer, type SessionContextGoal } from './session-context-layer.js';

export interface LiveContentActivationSnapshot {
  turnId: string;
  entries: ReadonlyMap<string, string>;
}

export function ChatView(props: {
  messages: StoredMessage[];
  messageLoading?: boolean;
  liveTurn?: LiveTurnProjection;
  /** Live display content already present when the host activated this conversation surface. */
  initialLiveContentSnapshot?: LiveContentActivationSnapshot;
  shellRunUpdates?: readonly ShellRunUpdate[];
  /** Called once the streaming bubble has displayed the final text and can hand off to history. */
  onStreamingSettled?(messageId?: string): void;
  /**
   * True while the live turn's running status line (spinner · working phrase ·
   * elapsed clock) should show, as the trailing entry of the tail turn.
   *
   * One flag for the whole turn, replacing the #646 pair that split the wait
   * into a first-token cue and a mid-turn one and showed neither once the turn
   * had live content on screen. That split answered "is the model between
   * steps?"; the question a user actually asks during a five-minute tool run is
   * "is anything still happening at all?", and nothing on screen answered it.
   */
  runningStatus?: boolean;
  activeSession?: SessionSummary;
  /** Durable Deep Research projection supplied by the host for visible progress and resume state. */
  deepResearchRun?: DeepResearchClientProgress;
  /** Explicitly starts a normal implementation task from a completed read-only research run. */
  onContinueDeepResearchHandoff?(run: DeepResearchClientProgress): void;
  activeConnectionLabel?: string;
  activeModel?: string;
  activeModelLabel?: string;
  /** Renders a provider brand mark next to the model name in the chat tab. */
  activeProviderType?: ProviderType;
  /** Optional renderer for the provider mark; supplied by the desktop app to
   *  avoid bringing the full provider SVG library into @maka/ui. */
  renderProviderMark?(type: ProviderType): ReactNode;
  modelChoices?: ChatModelChoice[];
  modelChangePending?: boolean;
  onModelChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
  /** Personalized user label shown on user messages. Falls back to "你". */
  userLabel?: string;
  /**
   * PR-MEMORY-VISIBILITY-INDICATOR-0 — true when the agent is reading
   * local MEMORY.md content into the system prompt this session.
   * Drives a subtle pill in the chat header so the user remembers
   * memory is in effect (kenji `19b0996f` boundary: no implicit
   * durable memory; xuan `c06e13f` MVP + yuejing PR-MEMORY-PROMPT-
   * INJECT-0 wiring).
   */
  memoryActive?: boolean;
  /** Click target for the memory pill — usually opens Settings · 记忆. */
  onOpenMemorySettings?(): void;
  /**
   * When the user has no real LLM connection configured, the empty state
   * defers to this slot. App renders `<OnboardingHero>` here; if undefined,
   * the regular prompt-suggestion hero shows.
   */
  emptyOverride?: ReactNode;
  /** Session-owned records anchored after a durable conversation turn. */
  conversationItems?: ReadonlyArray<{
    id: string;
    afterTurnId: string;
    renderWhenAnchorMissing?: boolean;
    content: ReactNode;
  }>;
  /**
   * Active autonomous-goal indicator for the session, or undefined when no
   * goal is running. Surfaces the loop (turn counter, elapsed, tokens) with
   * pause/resume/clear affordances so a token-burning goal is never invisible
   * or uncontrollable — this IS the desktop kill switch. `onClear` stops
   * autonomous continuation; `onPause`/`onResume` control it without a model
   * turn.
   */
  goalIndicator?: SessionContextGoal;
  /** Error from loading the active session's persisted message log. */
  messageLoadError?: string;
  messageLoadRetryPending?: boolean;
  onRetryMessages?(): void;
  /**
   * Per-turn presentation the consumer derives from the turns this view
   * projected: footer actions, failed-turn labels, lineage badges, and which
   * turn may be safely resumed. Action policy and enum-to-Chinese translation
   * stay outside `@maka/ui`, but they read the SAME turn objects the transcript
   * projection produced — so a turn the projection did not move can be answered
   * from the consumer's cache, and the props a memoized `TurnView` compares
   * keep identity for free rather than being interned afterwards (#2030).
   *
   * Called during render, once per projection step. It must be pure and
   * idempotent for identical turns.
   *
   * It must also carry a cache that outlives a single render — the whole point
   * is answering an unmoved turn from that cache. Purity and idempotence do not
   * imply it: a deriver rebuilt in the render body satisfies both and silently
   * gives back every re-render this projection exists to avoid, with no test
   * turning red. Supply it from a hook that holds the derivation in a ref (see
   * `useAppShellTurnPresentation`); the one-shot form is for callers with no
   * render loop at all, such as stories.
   */
  deriveTurnPresentation?: TurnPresentationDeriver;
  onTurnFooterAction?: (turnId: string, actionId: TurnFooterActionMeta['id']) => void;
  /**
   * Edit-and-resend for a user turn. Desktop owns revision draft creation
   * (branch-before + composer refill); ChatView only forwards the click.
   */
  onEditUserMessage?: (turnId: string) => void;
  /**
   * The safe-resume affordance, minus its target: which turn may be resumed is
   * `deriveTurnPresentation`'s answer, so the shell supplies only the state and
   * the callback and this view pairs them with that turn.
   */
  safeResumeAction?: {
    pending: boolean;
    detail?: string;
    onResume(): void;
  };
  onLineageBadgeClick?: (targetTurnId: string) => void;
  /**
   * Search-result navigation target. The desktop shell owns session
   * switching and hands the matched turn id here after selection; the
   * chat view only scrolls/highlights the already-rendered turn.
   */
  scrollTargetTurn?: { turnId: string; nonce: number };
  scrollBehavior: ScrollBehavior;
  hasOlderHistory?: boolean;
  historyLoadPending?: boolean;
  onLoadEarlierHistory?(): Promise<void> | void;
  returnToLatest?: {
    label: string;
    isPending: boolean;
    onClick(): Promise<void> | void;
  };
  transcriptTurnIndex?: ReadonlyArray<{ turnId: string; sequence: number; label: string }>;
  onLoadTranscriptTurn?(target: { turnId: string; sequence: number }): void;
  /**
   * PR109f: when the active session is a branched session
   * (`parentSessionId` set on its summary), show a banner above the
   * chat surface so the user knows they're in a derived conversation
   * and can jump back to the parent.
   *
   * Renderer (main.tsx) resolves the parent name from the connections /
   * sessions list — @maka/ui never queries the storage layer directly.
   */
  branchBanner?: {
    parentSessionId: string;
    parentSessionName: string;
    /**
     * Set when the branch starting point was an aborted turn. UI shows
     * "从中断前分支" copy so the user understands the branch starts
     * from before the cancel point, not from the abort itself.
     */
    fromAbortedTurn?: boolean;
  };
  onBranchBannerClick?: (parentSessionId: string) => void;
  /** Edit-and-resend versions stay in one conversation slot. */
  revisionNavigation?: {
    current: number;
    total: number;
    previousSessionId?: string;
    nextSessionId?: string;
  };
  onRevisionNavigate?: (sessionId: string) => void;
  /**
   * Host reader for image attachment bytes, threaded to each turn's user-message
   * thumbnails. The desktop shell passes its preload `attachments.readBytes`;
   * non-desktop hosts omit it and image thumbnails stay in their pending
   * skeleton. Keeps @maka/ui host-agnostic with no direct host-global access.
   * Pass an identity-stable reference so the memoized TurnViews keep skipping
   * reconciliation on the hot streaming path.
   */
  onReadAttachmentBytes?: ReadAttachmentBytes;
  /**
   * Open a linked subagent child session in the main chat column (option A).
   * Threaded into linked subagent rows inside ToolTrow.
   * Pass an identity-stable reference so memoized TurnViews keep skipping
   * reconciliation on the hot streaming path (ChatView also ref-wraps this).
   */
  onOpenLinkedSession?(sessionId: string): void;
  onNew(): void;
  onPromptSuggestion?(prompt: string): void;
  /**
   * Codex/Cursor-style "quote this": when set, selecting text in the transcript
   * surfaces a floating action that hands the excerpt (+ its turn) to the host,
   * which stages it as a quote chip on the composer. Omitted by hosts that
   * don't compose quotes. Only selections that resolve to a turn are offered,
   * so `turnId` always arrives.
   */
  onQuoteSelection?(input: { text: string; turnId: string }): void;
  /**
   * Codex/Cursor-style "ask in side panel": when set, selecting text in the
   * transcript surfaces a second floating action that hands the excerpt (+ its
   * turn) to the desktop app, which opens a read-only companion side panel
   * seeded with the quote. Omitted by hosts that don't support the side panel.
   */
  onAskAboutSelection?(input: { text: string; turnId: string }): void;
}) {
  const conversationCopy = getConversationCopy(useUiLocale());
  const copy = conversationCopy.chat;
  // chat survives for the empty-state path; the main message log is driven by
  // `turns` (per @kenji UI-04 turn-grouping projection).
  const drainingMessageIdsKey = JSON.stringify(
    props.liveTurn?.steps.flatMap((step) => step.text ? [step.stepId] : []) ?? [],
  );
  const drainingMessageIds = useMemo(
    () => new Set<string>(JSON.parse(drainingMessageIdsKey) as string[]),
    [drainingMessageIdsKey],
  );
  const visibleMessages = useMemo(
    () => drainingMessageIds.size > 0
      ? props.messages.filter((message) => !(message.type === 'assistant' && drainingMessageIds.has(message.id)))
      : props.messages,
    [drainingMessageIds, props.messages],
  );
  const chat = useMemo(() => materializeChat(visibleMessages), [visibleMessages]);
  // The projection owns the derived turns, so a turn nothing said anything
  // about keeps its object identity and its memoized TurnView skips — across
  // deltas AND across the message refreshes that fire at every step/tool
  // boundary (#2030).
  const turns = useTranscriptProjection({
    sessionId: props.activeSession?.id,
    messages: visibleMessages,
    liveTurn: props.liveTurn,
    shellRunUpdates: props.shellRunUpdates,
  });
  // Derived FROM the projected turns, not beside them: the consumer keys its
  // cache on the turn objects above, so a turn the projection kept hands back
  // the same footer/badge objects and the memoized TurnView skips on every
  // prop at once (#2030). Deriving it from `messages` instead made the
  // transcript a second, independent authority whose outputs then had to be
  // interned by value to line up again.
  const turnPresentation = props.deriveTurnPresentation?.(turns);
  // #642 single render path: the in-flight answer is injected into the tail
  // turn's TurnView (the SAME node as the eventual committed turn) instead of a
  // separate streaming <section>, so live→settled is a data-source swap, not an
  // unmount/mount. The streaming turn is always the last turn: the user message
  // is committed optimistically (showOptimisticUserMessage) before streaming
  // starts, so `materializeTurns` already emits it — with an empty assistant
  // timeline — as `turns[last]`. Only the tail TurnView gets a fresh
  // `liveStreaming` object per delta (→ it alone re-renders); every sibling
  // gets a stable `undefined` and its memo skips. That the sibling's `turn`
  // prop is also stable is the projection's tested contract, not a property
  // inferred from a chain of pure derivations (#2030).
  // A turn is "still live" — and must keep its non-actionable footer placeholder
  // instead of a clickable regenerate/branch — while ANY of text, thinking, OR a
  // tool is in flight. Deriving liveness from streamingText/thinkingText alone
  // let a tool-only step (tool_start with no answer text yet) fall through to the
  // settled branch, whose derived status is `completed`, rendering an actionable
  // footer on a still-running answer (review P2-B). A tool-only tail renders the
  // running tool from its timeline with no empty live bubble.
  // The model-wait indicator keeps the tail turn "live" too, so its footer stays
  // the non-actionable placeholder and the indicator injects into the tail turn
  // (not the fallback section) — it is, by derivation, only ever true when text /
  // thinking / tools are all absent.
  //
  // Terminal liveTurn is evidence overlay only (e.g. empty shell_run still needs
  // pre-handoff chunks). It must NOT block footer actions — keeping evidence and
  // being in-flight are separate signals. Wait indicators alone still mark
  // streaming, but delayed flags can lag one frame past complete; terminal
  // evidence must outrank them so copy/regenerate stay actionable.
  const liveInFlight = !!(props.liveTurn && !props.liveTurn.terminal);
  const streamingActive = liveInFlight || (!props.liveTurn?.terminal && !!props.runningStatus);
  const tailTurnId = liveInFlight
    ? props.liveTurn!.turnId
    : (streamingActive ? turns[turns.length - 1]?.turnId : undefined);
  // One rail tick per turn that carries a user prompt (Codex-style prompt
  // navigation). Memoized so the rail's IntersectionObserver isn't rebuilt
  // on every render.
  const transformedUserTurnIds = useMemo(
    () => new Set(
      props.messages.flatMap((message) =>
        message.type === 'user' &&
        message.displayText !== undefined &&
        message.displayText !== message.text
          ? [message.turnId]
          : [],
      ),
    ),
    [props.messages],
  );
  // The rail's entries change only when a turn's persisted prompt/answer text
  // does, but `turns` gets a new array on every delta. Handing the previous
  // array back when nothing it reads moved keeps the memoized rail — and its
  // transcript-wide IntersectionObserver — out of the streaming path. The
  // per-entry comparison is O(1) per turn because an unaffected turn keeps its
  // object identity, so its text is the same string reference.
  const promptRailTurnsRef = useRef<ReadonlyArray<{ turnId: string; label: string; reply: string }>>([]);
  const loadedPromptRailTurns = useMemo(() => {
    const next = turns
      .filter((turn) => (turn.user?.text ?? '').trim().length > 0)
      .map((turn) => ({
        turnId: turn.turnId,
        label: turn.user?.text ?? '',
        reply: turn.assistant?.text ?? '',
      }));
    const previous = promptRailTurnsRef.current;
    if (
      previous.length === next.length
      && next.every((entry, index) => {
        const prior = previous[index]!;
        return prior.turnId === entry.turnId && prior.label === entry.label && prior.reply === entry.reply;
      })
    ) {
      return previous;
    }
    promptRailTurnsRef.current = next;
    return next;
  }, [turns]);
  const promptRailTurns = useMemo(() => {
    const index = props.transcriptTurnIndex;
    if (!index || index.length === 0) return loadedPromptRailTurns;
    const loadedByTurnId = new Map(loadedPromptRailTurns.map((turn) => [turn.turnId, turn]));
    return index.map((turn) => ({
        ...(loadedByTurnId.get(turn.turnId) ?? {
          turnId: turn.turnId,
          label: turn.label,
          reply: '',
        }),
        sequence: turn.sequence,
      }));
  }, [loadedPromptRailTurns, props.transcriptTurnIndex]);
  // Stable event wrappers (advanced-use-latest): parent handlers are
  // recreated per render upstream; routing through refs keeps the
  // memoized TurnView's function props identity-stable without
  // demanding useCallback discipline from every caller.
  const onTurnFooterActionRef = useRef(props.onTurnFooterAction);
  onTurnFooterActionRef.current = props.onTurnFooterAction;
  const stableTurnFooterAction = useCallback(
    (turnId: string, actionId: TurnFooterActionMeta['id']) => onTurnFooterActionRef.current?.(turnId, actionId),
    [],
  );
  const onEditUserMessageRef = useRef(props.onEditUserMessage);
  onEditUserMessageRef.current = props.onEditUserMessage;
  const stableEditUserMessage = useCallback(
    (turnId: string) => onEditUserMessageRef.current?.(turnId),
    [],
  );
  const onLineageBadgeClickRef = useRef(props.onLineageBadgeClick);
  onLineageBadgeClickRef.current = props.onLineageBadgeClick;
  const stableLineageBadgeClick = useCallback(
    (targetTurnId: string) => onLineageBadgeClickRef.current?.(targetTurnId),
    [],
  );
  const onOpenLinkedSessionRef = useRef(props.onOpenLinkedSession);
  onOpenLinkedSessionRef.current = props.onOpenLinkedSession;
  const stableOpenLinkedSession = useCallback(
    (sessionId: string) => onOpenLinkedSessionRef.current?.(sessionId),
    [],
  );
  const turnIds = useMemo(() => new Set(turns.map((turn) => turn.turnId)), [turns]);
  const conversationItemPlacement = useMemo(() => placeChatConversationItems(
    (props.conversationItems ?? []).map((item) => ({
      afterTurnId: item.afterTurnId,
      renderWhenAnchorMissing: item.renderWhenAnchorMissing,
      value: { id: item.id, content: item.content },
    })),
    turnIds,
  ), [props.conversationItems, turnIds]);
  const turnIdsRef = useRef(turnIds);
  turnIdsRef.current = turnIds;
  const loadTranscriptTurnRef = useRef(props.onLoadTranscriptTurn);
  loadTranscriptTurnRef.current = props.onLoadTranscriptTurn;
  const chatLayout = useChatLayoutContext();
  if (!chatLayout) {
    throw new Error('ChatView must be rendered inside ChatSurfaceLayout');
  }
  const scrollRef = chatLayout.scrollContainerRef;
  const [latestNavigationNonce, setLatestNavigationNonce] = useState(0);
  const orderedTurnIds = useMemo(() => turns.map((turn) => turn.turnId), [turns]);
  const sessionId = props.activeSession?.id;
  const {
    start: mountStart,
    end: mountEnd,
    beforeHeight,
    afterHeight,
    revealTurn,
  } = useTurnVirtualizer({
    sessionId,
    turnIds: orderedTurnIds,
    scrollRef,
    targetTurnId: props.scrollTargetTurn?.turnId,
    targetKey: props.scrollTargetTurn?.nonce,
  });
  const navigatePromptRailFallback = useCallback((turn: PromptAnchorRailTurn) => {
    if (turnIdsRef.current.has(turn.turnId)) revealTurn(turn.turnId);
    else if (turn.sequence !== undefined) {
      loadTranscriptTurnRef.current?.({ turnId: turn.turnId, sequence: turn.sequence });
    }
  }, [revealTurn]);
  const mountedTurns = turns.slice(mountStart, mountEnd);
  const { highlightedTurnId } = useChatScroll({
    scrollRef,
    sessionId: props.activeSession?.id,
    hasTurns: turns.length > 0,
    messages: props.messages,
    target: props.scrollTargetTurn,
    behavior: props.scrollBehavior,
    hasOlderHistory: props.hasOlderHistory,
    historyLoadPending: props.historyLoadPending,
    onLoadEarlierHistory: props.onLoadEarlierHistory,
    latestNavigationNonce,
  });
  const { quote: selectionQuote, clear: clearSelectionQuote } = useMessageSelectionQuote(
    scrollRef,
    Boolean(props.onQuoteSelection || props.onAskAboutSelection),
  );
  const selectionActionsLayer = useLayer({
    mode: 'fixed',
    lightDismiss: true,
    onHide: clearSelectionQuote,
  });
  useEffect(() => {
    if (selectionQuote) selectionActionsLayer.show();
    else selectionActionsLayer.hide();
  }, [selectionQuote, selectionActionsLayer.show, selectionActionsLayer.hide]);
  const selectionActionsLabel = [
    props.onQuoteSelection ? copy.quoteSelection : null,
    props.onAskAboutSelection ? copy.askInSidePanel : null,
  ].filter((label): label is string => label !== null).join(' / ');

  if (!props.activeSession) {
    const conversationItems = props.conversationItems ?? [];
    const emptyContent = props.emptyOverride ?? (
      <EmptyChatHero onPromptSuggestion={props.onPromptSuggestion} userLabel={props.userLabel} />
    );
    return (
      <section
        className="maka-main agents-chat-panel agents-chat-view-root"
        role="region"
        aria-label={conversationCopy.empty.surfaceAriaLabel}
      >
        {/* PR-REMOVE-CHAT-TAB (WAWQAQ msg d401938d 2026-06-23): the
            browser-style session tab + the duplicate "新建对话" plus
            button were removed. The session name lives in the sidebar;
            the new-task button at the top of the sidebar is the
            canonical create-session entry point. The chat header
            keeps the permission-mode switcher only. */}
        {/* PR-MOVE-PERMISSION-MODE: chat header no longer carries the
            permission-mode chips — the picker lives inside the composer's
            left controls so the new-session screen and active-session
            screen share the same "create / pick mode / send" rhythm. */}
        {/* No status strip on the empty-session screen: it has no session, so
            none of the chips (memory / deep-research / goal) can apply. The
            header used to be rendered here anyway, holding a lone spacer, to
            occupy the window titlebar line — which the shell's titlebar row now
            owns. */}
        <ChatMessageList
          className="maka-chat-message-list maka-chatContent"
          emptyState={conversationItems.length === 0 ? emptyContent : undefined}
        >
          {conversationItems.length > 0 ? (
            <>
              {emptyContent}
              {conversationItems.map((item) => <Fragment key={item.id}>{item.content}</Fragment>)}
            </>
          ) : null}
        </ChatMessageList>
      </section>
    );
  }

  const deepResearchActive = isDeepResearchSession(props.activeSession.labels);
  const hasVisibleConversationItem =
    conversationItemPlacement.byTurn.size > 0 || conversationItemPlacement.orphan !== undefined;
  const showEmptyState =
    (chat.length === 0 && !streamingActive && !hasVisibleConversationItem)
    || Boolean(props.messageLoading && chat.length === 0 && !hasVisibleConversationItem);
  const emptyContent = props.messageLoading
    ? (
        <div className="maka-chat-message-loading">
          <Spinner size="md" shade="subtle" label={copy.loading} />
        </div>
      )
    : props.messageLoadError
      ? (
          <EmptyState
            role="alert"
            aria-busy={props.messageLoadRetryPending ? 'true' : undefined}
            icon={<AlertTriangle size={ICON_SIZE.empty} />}
            title={copy.loadFailed}
            description={props.messageLoadError}
            actions={props.onRetryMessages ? (
              <Button
                label={props.messageLoadRetryPending ? copy.loading : copy.retryLoad}
                variant="primary"
                onClick={props.onRetryMessages}
                isDisabled={props.messageLoadRetryPending}
              />
            ) : undefined}
          />
        )
      : props.emptyOverride ?? (
          deepResearchActive ? (
            <DeepResearchEmptyHero onPromptSuggestion={props.onPromptSuggestion} />
          ) : (
            <EmptyChatHero onPromptSuggestion={props.onPromptSuggestion} userLabel={props.userLabel} />
          )
        );

  return (
    <section
      className="maka-main agents-chat-panel agents-chat-view-root"
      role="region"
      aria-label={copy.conversationAriaLabel(props.activeSession.name)}
    >
      {props.returnToLatest ? (
        <div className="maka-transcript-history-controls">
          <Button
            label={props.returnToLatest.label}
            variant="ghost"
            size="sm"
            isDisabled={props.returnToLatest.isPending}
            onClick={() => {
              void Promise.resolve(props.returnToLatest?.onClick()).then(() => {
                setLatestNavigationNonce((nonce) => nonce + 1);
              });
            }}
          />
        </div>
      ) : null}
      <SessionContextLayer
        sessionName={props.activeSession.name}
        branch={props.branchBanner}
        onBranchNavigate={props.onBranchBannerClick}
        revision={props.revisionNavigation}
        onRevisionNavigate={props.onRevisionNavigate}
        memoryActive={props.memoryActive}
        onOpenMemorySettings={props.onOpenMemorySettings}
        deepResearchActive={deepResearchActive}
        goal={props.goalIndicator}
      />
      {deepResearchActive && props.deepResearchRun && (
        <DeepResearchProgressPanel
          run={props.deepResearchRun}
          onContinue={props.onContinueDeepResearchHandoff}
          copy={copy.deepResearchProgress}
        />
      )}
      <div className="maka-chat-shell">
        {/* First child on purpose: the rail pins itself with a sticky anchor,
            and a sticky box only takes an offset from its own static position
            onward. Rendered after the transcript it would stay parked at the
            bottom of the conversation until the reader scrolled there. */}
        <PromptAnchorRail
          turns={promptRailTurns}
          scrollRef={scrollRef}
          onNavigateFallback={navigatePromptRailFallback}
          onNavigateStart={chatLayout.unlockAutoFollow}
        />
        <ChatMessageList
          className="maka-chat-message-list maka-chatContent"
          data-turn-source-count={turns.length}
          isStreaming={streamingActive}
          emptyState={showEmptyState ? emptyContent : undefined}
        >
          {showEmptyState ? null : (
            <>
              {chat.length === 0 && !streamingActive ? emptyContent : null}
              {beforeHeight > 0 && (
                <div
                  aria-hidden="true"
                  className="maka-turn-virtual-spacer"
                  style={{ height: beforeHeight, flex: '0 0 auto', transition: 'none' }}
                />
              )}
              {mountedTurns.map((turn) => {
                return (
                  <div
                    key={turn.turnId}
                    className="maka-turn-virtual-item"
                    data-virtual-turn-id={turn.turnId}
                  >
                    <TurnView
                      turn={turn}
                      userLabel={props.userLabel}
                      footerActions={turnPresentation?.footerActionsByTurn[turn.turnId]}
                      onFooterAction={stableTurnFooterAction}
                      onEditUserMessage={props.onEditUserMessage ? stableEditUserMessage : undefined}
                      editUserMessageTransformed={transformedUserTurnIds.has(turn.turnId)}
                      editUserMessageDisabled={
                        streamingActive || props.activeSession?.status === 'running'
                      }
                      failedReasonLabel={turnPresentation?.failedReasonLabels[turn.turnId]}
                      failedRecoveryLabel={turnPresentation?.failedRecoveryLabels[turn.turnId]}
                      safeResumeAction={turnPresentation?.resumeCandidateTurnId === turn.turnId
                        ? props.safeResumeAction
                        : undefined}
                      lineageBadges={turnPresentation?.lineageBadgesByTurn[turn.turnId]}
                      onLineageBadgeClick={stableLineageBadgeClick}
                      onReadAttachmentBytes={props.onReadAttachmentBytes}
                      onOpenLinkedSession={
                        props.onOpenLinkedSession ? stableOpenLinkedSession : undefined
                      }
                      searchHighlighted={highlightedTurnId === turn.turnId}
                      liveStreaming={
                        turn.turnId === tailTurnId
                          ? {
                              onStreamingSettled: props.onStreamingSettled,
                              runningStatus: props.runningStatus,
                              providerRetry: props.liveTurn?.providerRetry,
                              initialLiveContent: props.liveTurn?.turnId
                                === props.initialLiveContentSnapshot?.turnId
                                ? props.initialLiveContentSnapshot?.entries
                                : undefined,
                            }
                          : undefined
                      }
                    />
                    {conversationItemPlacement.byTurn.get(turn.turnId)?.map((item) => (
                      <Fragment key={item.id}>{item.content}</Fragment>
                    ))}
                  </div>
                );
              })}
              {afterHeight > 0 && (
                <div
                  aria-hidden="true"
                  className="maka-turn-virtual-spacer"
                  style={{ height: afterHeight, flex: '0 0 auto', transition: 'none' }}
                />
              )}
              {/* #642 fallback: streaming began before the optimistic user turn
                  materialized (rare — e.g. an event replay while messages are still
                  loading), so there is no tail turn to inject into. Render the live
                  answer in a bare `.maka-turn` so it isn't dropped. Mutually
                  exclusive with the tail injection above (only fires when
                  `tailTurnId` is undefined), so the answer never double-renders. */}
              {streamingActive && !tailTurnId && (
                <section className="maka-turn" data-live-streaming="true">
                  <LocalizedChatMessage
                    accessibleLabel={conversationCopy.messages.assistantAriaLabel}
                    sender="assistant"
                    className="maka-chat-message maka-assistant-answer"
                  >
                    <div className="maka-assistant-answer-content">
                      {props.liveTurn?.providerRetry ? (
                        <ModelProviderRetryIndicator retry={props.liveTurn.providerRetry} />
                      ) : (
                        /* No turn here means no `startedAt`, so this one shows
                           the working phrase without a clock. */
                        (props.runningStatus && <TurnRunningStatus />)
                      )}
                    </div>
                    <div aria-hidden="true" className="maka-live-turn-footer-placeholder" />
                  </LocalizedChatMessage>
                </section>
              )}
              {conversationItemPlacement.orphan && (
                <Fragment key={conversationItemPlacement.orphan.id}>
                  {conversationItemPlacement.orphan.content}
                </Fragment>
              )}
            </>
          )}
        </ChatMessageList>
        {selectionQuote && (props.onQuoteSelection || props.onAskAboutSelection) ? (
          selectionActionsLayer.render(
            <div
              className="maka-quote-actions"
              // Keep the live selection alive while clicking an action.
              onMouseDown={(event) => event.preventDefault()}
            >
              {/* No icons: the labels already name the actions, so an icon
                  beside each one encodes the same thing twice and buys the
                  width back from the text the layer is covering. */}
              <ButtonGroup
                label={selectionActionsLabel}
                size="sm"
                elevation="med"
              >
                {props.onQuoteSelection ? (
                  <Button
                    type="button"
                    label={copy.quoteSelection}
                    onClick={() => {
                      props.onQuoteSelection?.({
                        text: selectionQuote.text,
                        turnId: selectionQuote.turnId,
                      });
                      clearSelectionQuote();
                      window.getSelection()?.removeAllRanges();
                    }}
                  />
                ) : null}
                {props.onAskAboutSelection ? (
                  <Button
                    type="button"
                    label={copy.askInSidePanel}
                    onClick={() => {
                      props.onAskAboutSelection?.({
                        text: selectionQuote.text,
                        turnId: selectionQuote.turnId,
                      });
                      clearSelectionQuote();
                      window.getSelection()?.removeAllRanges();
                    }}
                  />
                ) : null}
              </ButtonGroup>
            </div>,
            {
              x: selectionQuote.anchor.x,
              y: Math.max(8, selectionQuote.anchor.y - 42),
              style: { transform: 'translateX(-50%)' },
            },
          )
        ) : null}
      </div>
    </section>
  );
}

export function DeepResearchProgressPanel({
  run,
  onContinue,
  copy = getConversationCopy('zh').chat.deepResearchProgress,
}: {
  run: DeepResearchClientProgress;
  onContinue?: (run: DeepResearchClientProgress) => void;
  copy?: ReturnType<typeof getConversationCopy>['chat']['deepResearchProgress'];
}) {
  const completedItems = run.checklist.filter(
    (item) => item.status === 'completed' || item.status === 'skipped',
  ).length;

  return (
    <section
      className="maka-deep-research-run-panel"
      aria-label={copy.ariaLabel}
      data-status={run.status}
    >
      <div className="maka-deep-research-run-summary">
        <div>
          <strong>{copy.title}</strong>
          <span>
            {run.status === 'completed'
              ? copy.completedSummary
              : copy.activeSummary(run.stage, run.scopeLevel, run.round)}
          </span>
        </div>
        <div className="maka-deep-research-run-actions">
          <span className="maka-deep-research-run-count">
            {completedItems}/{run.checklist.length}
          </span>
          {run.status === 'completed' && run.implementationPrompt && onContinue && (
            <Button
              type="button"
              label={copy.handoffAction}
              endContent={<ArrowRight size={ICON_SIZE.meta} aria-hidden="true" />}
              variant="secondary"
              size="sm"
              className="maka-deep-research-handoff-button"
              onClick={() => onContinue(run)}
              tooltip={copy.handoffTitle}
            />
          )}
        </div>
      </div>
      <div className="maka-deep-research-run-grid">
        <div>
          <h3>{copy.checklistTitle}</h3>
          <ul>
            {run.checklist.map((item) => (
              <li key={item.itemId} data-status={item.status}>
                <span>{item.status === 'completed' ? '✓' : item.status === 'blocked' ? '!' : '·'}</span>
                {item.title}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{copy.reportTitle}</h3>
          <ul>
            {run.reportSections.map((section) => (
              <li key={section.key} data-status={section.status}>
                <span>{section.status === 'completed' ? '✓' : section.status === 'drafted' ? '◐' : '·'}</span>
                {copy.sectionLabels[section.key]}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{copy.inspectedTitle}</h3>
          {run.recentInspectedRefs.length > 0 ? (
            <ul>
              {run.recentInspectedRefs.map((ref, index) => (
                <li key={`${ref.kind}-${ref.locator}-${index}`}>
                  <span>{ref.kind}</span>
                  <code>{ref.locator}</code>
                </li>
              ))}
            </ul>
          ) : <p>{copy.inspectedEmpty}</p>}
        </div>
        <div>
          <h3>{copy.executionTitle}</h3>
          <p>{copy.executionSummary(run.stepsCount, run.artifactsCount)}</p>
          {run.workerRunIds.length > 0 && <p>{copy.workersLabel}: {run.workerRunIds.join(', ')}</p>}
          {run.blockers.length > 0 ? (
            <ul className="maka-deep-research-run-blockers">
              {run.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          ) : <p>{copy.noBlockers}</p>}
        </div>
      </div>
    </section>
  );
}
/**
 * Locale-aware copy bundle for the empty-chat hero. Mirrors the
 * locale split applied to `PROMPT_SUGGESTIONS_BY_LOCALE` (PR-UI-14)
 * so the eyebrow, headline, and intro paragraph don't fall back to
 * Chinese while the chips switch to English.
 *
 * PR-UI-LAYOUT-4 (@yuejing 2026-05-22): time-of-day greeting in the
 * headline, matching the reference screenshot 1 ("晚上好，安静的夜晚适合
 * 深度思考"). The greeting hook is a tiny calm touch but it makes
 * the empty-chat surface read as a welcoming space rather than a
 * generic "start typing" prompt. We bucket the local hour into four
 * windows (morning / noon / afternoon / evening) and render
 * `${greeting}{label}` if the user set a display name, otherwise
 * just the greeting + a softer fallback line.
 */

// PR-MOVE-PERMISSION-MODE: the chat-header `PermissionModeSwitcher`
// radiogroup was deleted. Mode picking now lives inside the composer's
// left-controls as a shared Select (PermissionModeSelect), so the picker
// sits where you actually start typing, matching the reference product.
// Keyboard arrow/Home/End handling is delegated to the Select primitive.
