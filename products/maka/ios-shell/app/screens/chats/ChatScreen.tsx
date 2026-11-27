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

import {
  computed,
  effect,
  List,
  openUrl,
  safeAreaInsets,
  Scroll,
  signal,
  Text,
  View,
  token,
  type Accessor,
  type InputRef,
  type ListRef,
} from 'nsh';
import { Button, Input, MenuButton, NavPage, Sheet, TextView, type MenuButtonItem } from 'nsh/base';
import { InputAccessoryView, isAvailable } from 'nsh/mobile';
import {
  approvalControls,
  approvalDetail,
  approvalOutcome,
  interactionBadge,
  interactionTitle,
} from '../../approval';
import {
  hostQuery,
  type AgentHistoryChunk,
  type AgentInteractionRecord,
  type AgentObservation,
  type AgentRoomMessage,
  type AgentSession,
} from '../../bridge';
import { approvalFeedback } from '../../ui/ApprovalCard';
import { ConnectionProgress } from '../../ui/ConnectionProgress';
import { TranscriptSkeleton } from '../../ui/Skeleton';
import { ThinkingMark, ShimmerText } from '../../ui/ThinkingMark';
import { QuestionForm } from '../../ui/QuestionForm';
import { currentLocale, formatCount, tr } from '../../locale';
import {
  appendDraftQuote,
  appendSideLink,
  assembleHistoryRows,
  backendKey,
  clearDraftQuotes,
  conversationKey,
  draftQuote,
  createConversationController,
  displayModelKey,
  getDraft,
  historyAddressKey,
  historyQuote,
  historyTurnKey,
  quoteLimit,
  removeDraftLink,
  removeDraftQuote,
  setDraft,
  type DraftQuote,
  type SideAnchor,
  type HistoryRow,
  type HistoryFence,
} from '../../state/chat';
import {
  activeHostInfo,
  connectSavedHost,
  hostById,
  hostConnectionProgress,
  hostStatusKind,
  isHostConnected,
  savedHosts,
  showToast,
} from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import { isBotSession, watchSideQuestions, type ScopedSession } from '../../state/sessions';
import {
  createSideDraft,
  sideDraftAnchor,
  type SideDraftSource,
  type SideDraftRequest,
} from '../../state/sideQuestions';
import { spacing, type } from '../../theme/tokens';
import {
  ActionButton,
  ApprovalCard,
  BannerNotice,
  GroupRow,
  Icon,
  InsetGroup,
  ScreenHeader,
  StatusDot,
} from '../../ui';

import { DraftQuoteStrip, HistoryQuotes, MessageBody, ReplyActions } from './ChatQuotes';
import { SideQuestionList } from './ChatSideQuestions';

interface ToolSummaryItem {
  id: string;
  label: string;
  isError: boolean;
}

interface DisplayTurn {
  kind: 'agent';
  key: string;
  role: 'user' | 'assistant';
  activityKey: string;
  thinking: string;
  tools: Map<string, ToolSummaryItem>;
  bodies: HistoryRow[];
  folded?: AgentHistoryChunk;
  groups: AgentHistoryChunk[];
  quotes?: AgentHistoryChunk['quotes'];
}

interface RoomTranscriptRow {
  kind: 'room';
  key: string;
  message: AgentRoomMessage;
}

function collectActivity(
  activity: Pick<DisplayTurn, 'tools' | 'thinking' | 'bodies'>,
  row: HistoryRow,
) {
  const ch = row.first;
  if (ch.tool) {
    const id = ch.tool.toolUseId || row.key;
    const label = readableToolTitle(ch.tool);
    const existing = activity.tools.get(id);
    if (existing) {
      existing.label = label;
      existing.isError ||= Boolean(ch.tool.result?.isError);
    } else {
      activity.tools.set(id, { id, label, isError: Boolean(ch.tool.result?.isError) });
    }
  } else if (ch.field === 'thinking' && row.text) {
    activity.thinking += (activity.thinking ? '\n\n' : '') + row.text;
  } else if (row.text) {
    activity.bodies.push(row);
  }
}

function readableToolTitle(tool: NonNullable<AgentHistoryChunk['tool']>): string {
  return (
    tool.call?.title?.translations?.[currentLocale()] ??
    tool.call?.title?.fallback ??
    tool.call?.name ??
    tr('Tool call')
  );
}

function groupHistoryTurns(chunks: readonly AgentHistoryChunk[]): DisplayTurn[] {
  const turns: DisplayTurn[] = [];
  let lastTurn: string | null = null;
  for (const row of assembleHistoryRows(chunks)) {
    const ch = row.first;
    if (ch.role === 'user' && !ch.work) {
      if (row.text || ch.quotes?.length) {
        turns.push({
          kind: 'agent',
          key: row.key,
          role: 'user',
          activityKey: row.key,
          thinking: '',
          tools: new Map(),
          groups: [],
          bodies: row.text ? [row] : [],
          quotes: ch.quotes,
        });
      }
      continue;
    }

    let target = turns.at(-1);
    const turn = historyTurnKey(ch);
    if (target?.role !== 'assistant' || lastTurn !== turn) {
      target = {
        kind: 'agent',
        key: row.key,
        role: 'assistant',
        activityKey: turn ?? row.key,
        thinking: '',
        tools: new Map(),
        bodies: [],
        groups: [],
      };
      turns.push(target);
    }
    lastTurn = turn;
    if (ch.foldedWork) target.folded ??= ch;
    if (ch.work) target.groups.push(ch);
    else collectActivity(target, row);
    // Use a surviving message as the list key even when older tools are
    // prepended to this group.
    if (target.bodies.length) target.key = target.bodies.at(-1)!.key;
  }
  return turns;
}

type Activity = Pick<DisplayTurn, 'thinking' | 'tools' | 'bodies'>;
type ActivityRead = {
  generation: number;
  fingerprint: string;
  kind: 'loading' | 'failed' | 'ready';
  value?: Activity;
};

function CollapsibleActivity(props: {
  thinking: string;
  tools: readonly ToolSummaryItem[];
  live?: boolean;
  folded?: AgentHistoryChunk;
  groups?: readonly AgentHistoryChunk[];
  history?: {
    expanded: boolean;
    detail?: ActivityRead;
    onToggle: () => void;
    onRetry: () => void;
  };
  limitReached?: boolean;
  onQuote?: (row: HistoryRow, text: string) => boolean;
}) {
  const localExpanded = signal(false);
  const expanded = () => props.history?.expanded ?? localExpanded();
  const summary = () => {
    const work = props.folded?.foldedWork;
    if (work) return work;
    let thoughts = 0;
    let tools = 0;
    for (const { work } of props.groups ?? []) {
      thoughts += work!.thoughts;
      tools += work!.tools;
    }
    return { thoughts, tools };
  };
  const detail = () => props.history?.detail?.value;
  const thinking = () => [props.thinking, detail()?.thinking].filter(Boolean).join('\n\n');
  const tools = () => [...props.tools, ...(detail()?.tools.values() ?? [])];

  const summaryText = () => {
    const counts = summary();
    const toolCount = props.tools.length + counts.tools;
    const hasThink = counts.thoughts > 0 || props.thinking.trim().length > 0;
    if (toolCount > 0 && hasThink) {
      return props.live
        ? tr('Thinking · {count, plural, one {# tool running} other {# tools running}}…', {
            count: toolCount,
          })
        : tr('Thought process · {count, plural, one {# tool} other {# tools}}', {
            count: toolCount,
          });
    }
    if (toolCount > 0) {
      return props.live
        ? tr('Running {count, plural, one {# tool} other {# tools}}…', { count: toolCount })
        : tr('Used {count, plural, one {# tool} other {# tools}}', { count: toolCount });
    }
    return props.live ? tr('Thinking…') : tr('Thought process');
  };

  return (
    <If
      when={
        props.live ||
        props.folded ||
        props.groups?.length ||
        props.thinking.trim().length > 0 ||
        props.tools.length > 0
      }
    >
      <View style={{ marginBottom: 8 }}>
        <View
          role="button"
          accessibilityLabel={summaryText()}
          onPress={() => {
            hapticSelection();
            if (props.history) props.history.onToggle();
            else localExpanded.update((value) => !value);
          }}
          class="active:opacity-70"
          style={{
            alignSelf: 'flex-start',
            minHeight: 32,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 8,
            borderCurve: 'continuous',
            backgroundColor: token('inline-card'),
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <If
            when={props.live}
            else={
              <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
                {summaryText()}
              </Text>
            }
          >
            <ThinkingMark size={14} />
            <ShimmerText text={summaryText()} style={type.footnote} surface="inline-card" />
          </If>
          <Icon
            name={expanded() ? 'chevronDown' : 'chevronRight'}
            color={token('tertiary-foreground')}
            size={13}
          />
        </View>

        <If when={expanded()}>
          <View
            style={{
              marginTop: 6,
              paddingLeft: 12,
              borderLeftWidth: 2,
              borderLeftColor: token('separator'),
              gap: 6,
            }}
          >
            <If when={props.history?.detail?.kind === 'loading' && !detail()}>
              <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
                {tr('Loading…')}
              </Text>
            </If>
            <If when={props.history?.detail?.kind === 'failed'}>
              <ActionButton
                title={tr('Retry')}
                variant="quiet"
                compact
                onPress={() => props.history?.onRetry()}
              />
            </If>
            <If when={thinking().trim().length > 0}>
              <Text
                style={{
                  ...type.footnote,
                  color: token('muted-foreground'),
                  lineHeight: 19,
                }}
              >
                {thinking()}
              </Text>
            </If>
            <Each of={tools()} key={(t) => t.id}>
              {(tool) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <StatusDot kind={tool().isError ? 'error' : 'online'} size={6} />
                  <Text
                    style={{
                      ...type.footnote,
                      color: tool().isError ? token('destructive') : token('muted-foreground'),
                      flex: 1,
                      numberOfLines: 2,
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {tool().label}
                  </Text>
                </View>
              )}
            </Each>
            <If when={props.onQuote}>
              {(quote) => (
                <Each of={detail()?.bodies ?? []} key={(row) => row.key}>
                  {(row) => (
                    <MessageBody
                      row={row()}
                      limitReached={props.limitReached ?? false}
                      onQuote={quote()}
                    />
                  )}
                </Each>
              )}
            </If>
          </View>
        </If>
      </View>
    </If>
  );
}

function RoomTranscriptItem(props: { message: AgentRoomMessage }) {
  const isHuman = () => props.message.author.kind === 'human';
  return (
    <View
      style={{
        alignItems: isHuman() ? 'flex-end' : 'flex-start',
        gap: 4,
      }}
    >
      <If when={!isHuman()}>
        <Text style={{ ...type.caption, color: token('muted-foreground') }}>{tr('Agent')}</Text>
      </If>
      <View
        style={
          isHuman()
            ? {
                maxWidth: '84%',
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 18,
                borderCurve: 'continuous',
                backgroundColor: token('user-bubble-tint'),
              }
            : { width: '100%' }
        }
      >
        <If
          when={isHuman()}
          else={
            <TextView
              markdown={props.message.content.text}
              selectable
              styles={{
                paragraph: {
                  color: token('foreground'),
                  fontSize: 16,
                  lineHeight: 24,
                },
              }}
              onLinkPress={({ url }) => void openUrl(url)}
            />
          }
        >
          <Text style={{ ...type.body, color: token('foreground') }}>
            {props.message.content.text}
          </Text>
        </If>
      </View>
    </View>
  );
}

function InlineInteractionCard(props: {
  record: AgentInteractionRecord;
  hostName: string;
  sessionTitle: string;
  busy: boolean;
  accepted?: boolean;
  onRespond: (answer: Record<string, unknown>, kind: 'success' | 'warning') => void;
}) {
  const req = () => props.record.request;
  const request = req();
  if (request.kind === 'question') {
    return (
      <QuestionForm
        questions={request.questions}
        busy={props.busy}
        submit={(answer) => props.onRespond(answer, 'success')}
      />
    );
  }
  if (request.kind === 'form' || request.kind === 'system_permission') {
    return <Text>{tr('Review on Desktop')}</Text>;
  }

  const badge = () => interactionBadge(req().kind);
  const title = () => interactionTitle(req(), props.sessionTitle);

  const detail = () => approvalDetail(req());
  const controls = () => approvalControls(req());

  return (
    <View
      style={{
        marginVertical: 8,
        borderRadius: spacing.groupRadius,
        borderCurve: 'continuous',
        backgroundColor: token('inline-card'),
        overflow: 'hidden',
      }}
    >
      <ApprovalCard
        badge={badge()}
        inline
        accepted={props.accepted}
        sourceLine={savedHosts().length > 1 ? props.hostName + ' · ' + props.sessionTitle : ''}
        title={title()}
        detail={[detail().command, detail().permissions].filter(Boolean).join('\n')}
        monospaceDetail={!detail().permissions}
        busy={props.busy}
        allowLabel={controls().primary?.label}
        denyLabel={tr('Deny')}
        onAllow={
          controls().primary
            ? () => props.onRespond(controls().primary!.answer, 'success')
            : undefined
        }
        onDeny={controls().deny ? () => props.onRespond(controls().deny!, 'warning') : undefined}
        onAllowSession={
          controls().session ? () => props.onRespond(controls().session!, 'success') : undefined
        }
      />
    </View>
  );
}

export function ChatScreen(
  props: {
    item: ScopedSession;
    active: Accessor<boolean>;
    onBack: () => void;
  } & (
    | {
        mainChat?: ScopedSession;
        onOpenProjectFiles: (item: ScopedSession) => void;
        onAskSideQuestion: (request: SideDraftRequest) => void;
        onOpenSideQuestion: (main: ScopedSession, session: AgentSession) => void;
        pendingSide?: never;
      }
    | {
        pendingSide: {
          request: SideDraftRequest;
          onConnectionChanged: () => void;
          onForked: (
            session: AgentSession,
            question: string,
            quotes: readonly DraftQuote[],
            observed: AgentObservation,
          ) => void;
        };
        mainChat?: never;
        onOpenProjectFiles?: never;
        onAskSideQuestion?: never;
        onOpenSideQuestion?: never;
      }
  ),
) {
  const insets = safeAreaInsets();
  const rootId = props.item.rootId;
  const sessionId = props.item.session.id;
  const pending = props.pendingSide;
  const sideDraft =
    pending &&
    createSideDraft(pending.request, props.active, pending.onConnectionChanged, pending.onForked);
  const ctrl = createConversationController(rootId, props.item.session, props.active, !pending);
  const feedback = approvalFeedback<{
    record: AgentInteractionRecord;
    index: number;
    accepted: boolean;
  }>();
  const inlineInteractions = () => {
    const pending = ctrl.pendingInteractions();
    const settled = feedback.outcome();
    if (!settled || pending.some(({ requestId }) => requestId === settled.record.requestId))
      return pending;
    const rows = [...pending];
    rows.splice(settled.index, 0, settled.record);
    return rows;
  };

  const atBottom = signal(true);
  const queueSheetOpen = signal(false);
  const followLatest = signal(true);
  let transcriptRef: ListRef | undefined;
  let pagingDrag: number | undefined;
  let lastTranscriptScroll:
    | { generation: number | undefined; height: number; viewport: number; y: number }
    | undefined;
  let transcriptCanScroll = false;
  let inputRef: InputRef | undefined;
  let openedTranscript = false;

  const session = () => ctrl.observation()?.session ?? props.item.session;
  const side = () => !!session().branch?.side;
  const sessionTitle = () => (sideDraft ? tr('Side Question') : session().title);
  const hostName = () => hostById(rootId)?.hostName ?? props.item.hostName;
  const subtitleLine = () => {
    const main = pending?.request.main ?? props.mainChat;
    if (main) return tr('Side Question · {title}', { title: main.session.title });
    if (side()) return tr('Side Question');
    const workspace =
      session().workspace?.path?.split('/').filter(Boolean).pop() || tr('Default workspace');
    return savedHosts().length > 1 ? hostName() + ' · ' + workspace : workspace;
  };
  const accessoryId = 'maka-chat-accessory:' + conversationKey(rootId, sessionId);
  const turns = computed(() => groupHistoryTurns(ctrl.chunks()));
  const hasMoreBefore = ctrl.hasMoreBefore;
  const transcript = computed<readonly (DisplayTurn | RoomTranscriptRow)[]>(() =>
    ctrl.isRoom()
      ? ctrl.roomMessages().map((message) => ({ kind: 'room' as const, key: message.id, message }))
      : turns(),
  );
  const isRunning = () => ctrl.observation()?.run != null;
  const hostOnline = () => isHostConnected(rootId);
  const connectionProgress = () => hostConnectionProgress(rootId);
  const draft = () => getDraft(rootId, sessionId);
  const quotes = () => (sideDraft ? sideDraft.quotes() : draft().quotes);
  const links = () => (sideDraft ? [] : draft().links);
  const composerText = () => (sideDraft ? sideDraft.text() : draft().input.text);
  const editComposer = (text: string) =>
    sideDraft ? sideDraft.text.set(text) : setDraft(rootId, sessionId, text);
  const quoteLimitReached = () => quotes().length >= quoteLimit;
  const canSend = () =>
    sideDraft ? sideDraft.canSend() : ctrl.hasDraftContent() && !ctrl.sending();
  const send = () => {
    if (sideDraft) void sideDraft.submit();
    else
      void ctrl.sendMessage().then((sent) => {
        if (sent && props.active()) scrollToBottom(false);
      });
  };

  const generation = computed(() => activeHostInfo(rootId)?.generation);
  const canAskSide = computed(
    () =>
      !sideDraft &&
      generation() != null &&
      session().kind === 'agent' &&
      !ctrl.isRoom() &&
      !side() &&
      !isBotSession(rootId, sessionId),
  );
  const rowAnchor = (row: HistoryRow): SideAnchor | undefined => {
    const body = row.first;
    if (
      body.position &&
      body.role === 'assistant' &&
      body.field === 'body' &&
      !body.sourceCitation &&
      (body.finalOutput || body.position.kind !== 'live')
    )
      return { position: body.position, order: body.order };
  };
  const replyAnchor = (rows: readonly HistoryRow[]) => {
    const row = rows.findLast((row) => rowAnchor(row));
    return row && rowAnchor(row);
  };
  const quoteMessage = (row: HistoryRow, text: string, combined?: readonly HistoryRow[]) => {
    if (ctrl.isRoom()) return false;
    const reference = historyQuote(row, text);
    const anchor = combined
      ? combined.every(rowAnchor)
        ? replyAnchor(combined)
        : undefined
      : rowAnchor(row);
    if (combined) reference.sourceMessageId = undefined;
    if (!appendDraftQuote(rootId, sessionId, row.key, reference, anchor)) return false;
    hapticSelection();
    inputRef?.blur();
    return true;
  };
  const sideCatalog = pending?.request.catalog ?? watchSideQuestions(props.item, canAskSide);
  const traySource = { kind: 'tray' } as const;
  const canAskFromTray = computed(() => canAskSide() && !!sideDraftAnchor(traySource, quotes()));
  const askSide = (source: SideDraftSource, selected?: DraftQuote) => {
    const connection = generation();
    if (!canAskSide() || connection == null || !props.onAskSideQuestion) return false;
    const current = source.kind === 'row' ? quotes().filter(({ anchor }) => anchor) : quotes();
    const next =
      selected &&
      !current.some(
        ({ sourceKey, reference }) =>
          sourceKey === selected.sourceKey && reference.text === selected.reference.text,
      )
        ? [...current, selected]
        : current;
    if (next.length > quoteLimit) {
      showToast(tr('Quote limit reached ({count})', { count: quoteLimit }));
      return false;
    }
    if (!sideDraftAnchor(source, next)) return false;
    inputRef?.blur();
    props.onAskSideQuestion({
      main: { ...props.item, session: session() },
      generation: connection,
      source,
      quotes: next,
      catalog: sideCatalog,
      pendingModel: () => ctrl.selectingModel()?.done,
    });
    return true;
  };
  const askAboutRow = (row: HistoryRow, selection?: string) => {
    const anchor = rowAnchor(row);
    return (
      !!anchor &&
      askSide(
        { kind: 'row', anchor },
        selection ? draftQuote(row.key, historyQuote(row, selection), anchor) : undefined,
      )
    );
  };
  const askAboutReply = (rows: readonly HistoryRow[]) => {
    const anchor = replyAnchor(rows);
    if (anchor) askSide({ kind: 'row', anchor });
  };

  const sideList = signal<{ kind: 'all' } | { kind: 'anchor'; key: string } | null>(null);
  const sideAtAnchor = computed(() => {
    const groups = new Map<string, AgentSession[]>();
    for (const session of sideCatalog.sessions() ?? []) {
      const anchor = session.branch?.position;
      if (anchor?.kind !== 'through_source_turn') continue;
      const key = historyAddressKey(anchor.position);
      const group = groups.get(key);
      if (group) group.push(session);
      else groups.set(key, [session]);
    }
    return groups;
  });
  const sideRows = () => {
    const list = sideList();
    return list?.kind === 'anchor' ? (sideAtAnchor().get(list.key) ?? []) : sideCatalog.sessions();
  };
  const openSide = (sideSession: AgentSession) => {
    sideList.set(null);
    inputRef?.blur();
    props.onOpenSideQuestion?.({ ...props.item, session: session() }, sideSession);
  };
  let checkingMain = false;
  const bringBack = async () => {
    const main = props.mainChat;
    if (!main || checkingMain) return;
    const connection = generation();
    if (connection == null) {
      showToast(tr('Computer is offline'));
      return;
    }
    const sessionId = main.session.id;
    const current = () => props.active() && generation() === connection;
    checkingMain = true;
    try {
      const { session: source } = await hostQuery<AgentObservation>(
        'agent',
        'observe',
        { sessionId },
        undefined,
        rootId,
      );
      if (!current()) return;
      if (source.id !== sessionId) throw new Error('Host observed a different conversation');
      appendSideLink(rootId, sessionId, session());
      props.onBack();
    } catch (cause) {
      if (!current()) return;
      console.warn('Could not read the main conversation', cause);
      showToast(tr('The main conversation is no longer available.'));
    } finally {
      checkingMain = false;
    }
  };
  const showAllSides = () => {
    inputRef?.blur();
    sideList.set({ kind: 'all' });
  };
  effect(() => {
    generation();
    sideList.set(null);
  });
  const hasLivePreview = () => {
    const p = ctrl.livePreview();
    return isRunning() || Boolean(p.body.trim() || p.thinking.trim() || p.tools.length > 0);
  };

  const currentModelLabel = () => {
    const chosen = ctrl.selectedBackend();
    if (!chosen) return tr('Default');
    const key = displayModelKey(chosen);
    return (
      ctrl.models().find((model) => displayModelKey(model.selection) === key)?.label ??
      (chosen.kind === 'model' ? chosen.modelId : chosen.selection.executor)
    );
  };

  const modelMenuItems = (): MenuButtonItem[] => {
    const chosen = ctrl.selectedBackend();
    const selectedKey = chosen ? displayModelKey(chosen) : null;
    return ctrl.models().map((model) => {
      const id = backendKey(model.selection);
      return {
        id,
        label: model.label,
        checked: displayModelKey(model.selection) === selectedKey,
        singleSelection: true,
      };
    });
  };

  const handleSelectModel = (id: string) => {
    const match = ctrl.models().find((model) => backendKey(model.selection) === id);
    if (match) void ctrl.selectModel(match.selection);
  };

  const scrollToBottom = (animated = true) => {
    followLatest.set(true);
    transcriptRef?.scrollToEnd({ animated });
    atBottom.set(true);
  };

  const startEarlier = (retry = false) => {
    if (
      !props.active() ||
      ctrl.loading() ||
      !hasMoreBefore() ||
      ctrl.loadingEarlier() ||
      ctrl.earlierFailed() !== retry
    )
      return;
    pagingDrag = undefined;
    const restoreShortTail = !transcriptCanScroll && followLatest();
    const connection = generation();
    followLatest.set(false);
    void ctrl.loadEarlier(retry).then(async () => {
      if (!restoreShortTail || !props.active() || generation() !== connection) return;
      const position = await transcriptRef?.measureScrollPosition();
      if (
        props.active() &&
        generation() === connection &&
        !ctrl.loadingEarlier() &&
        !transcriptCanScroll &&
        (!position || (position.index === 0 && position.offset <= 1))
      ) {
        followLatest.set(true);
      }
    });
  };
  const loadEarlierFromDrag = () => {
    if (props.active() && pagingDrag !== undefined && pagingDrag === generation()) startEarlier();
  };

  effect(() => {
    if (openedTranscript || !ctrl.historyLoaded()) return;
    openedTranscript = true;
    scrollToBottom(false);
  });

  const expandedTurns = signal<ReadonlySet<string>>(new Set());
  const activityReads = signal<Record<string, ActivityRead | undefined>>({});
  const turnPages = new Map<
    string,
    {
      generation: number;
      read: Promise<AgentHistoryChunk[] | undefined>;
    }
  >();
  const toggleActivity = (key: string) =>
    expandedTurns.update((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const liveFence = () => {
    const fence = ctrl.historyFence();
    if (props.active() && fence?.generation === generation()) return fence;
  };
  const readFoldedTurn = (anchor: AgentHistoryChunk, fence: HistoryFence) => {
    const key = anchor.runId ?? historyAddressKey(anchor.position);
    const existing = turnPages.get(key);
    if (existing?.generation === fence.generation) return existing.read;
    const read = ctrl.readHistoryDetail(anchor, 'turn', fence, () => true);
    const entry = { generation: fence.generation, read };
    turnPages.set(key, entry);
    const forget = () => {
      if (turnPages.get(key) === entry) turnPages.delete(key);
    };
    void read.then((rows) => {
      if (!rows) forget();
    }, forget);
    return read;
  };
  const fullReply = async (anchor: AgentHistoryChunk) => {
    const fence = liveFence();
    if (!fence) return;
    const rows = await readFoldedTurn(anchor, fence);
    if (!rows || liveFence()?.generation !== fence.generation) return;
    return assembleHistoryRows(rows).filter(
      ({ first, text }) =>
        text && !first.work && !first.tool && first.role !== 'user' && first.field === 'body',
    );
  };

  const activityTurns = computed(
    () =>
      new Map(
        turns()
          .filter((turn) => turn.folded || turn.groups.length)
          .map((turn) => [turn.activityKey, turn]),
      ),
  );
  const activityFingerprint = (turn: DisplayTurn, fence: HistoryFence) =>
    JSON.stringify([
      fence.generation,
      turn.folded
        ? ['folded', turn.folded.runId, turn.folded.foldedWork]
        : turn.groups.map((row) => [
            historyAddressKey(row.position),
            row.work,
            row.timing?.finished ? null : fence.through,
          ]),
    ]);
  const readActivity = async (turn: DisplayTurn, fence: HistoryFence, fingerprint: string) => {
    const key = turn.activityKey;
    const update = (state: ActivityRead | undefined) =>
      activityReads.update((reads) => ({ ...reads, [key]: state }));
    const previous = activityReads()[key];
    if (previous?.kind === 'loading' && previous.generation === fence.generation) return;
    const cached = previous?.generation === fence.generation ? previous : undefined;
    const request: ActivityRead = {
      kind: 'loading',
      fingerprint,
      generation: fence.generation,
      value: cached?.value,
    };
    // Finish this read at its own fence. Changes that arrive in flight are
    // picked up once, at the latest fence, after publishing this result.
    const current = () =>
      activityReads()[key] === request &&
      liveFence()?.generation === fence.generation &&
      activityTurns().has(key);
    update(request);
    try {
      const value: Activity = { thinking: '', tools: new Map(), bodies: [] };
      const rows = turn.folded ? await readFoldedTurn(turn.folded, fence) : turn.groups;
      if (!rows || !current()) return;
      // Turn pages can split a prose row; join it before collecting it.
      for (const row of assembleHistoryRows(rows)) {
        const anchor = row.first;
        if (anchor.work) {
          const steps = await ctrl.readHistoryDetail(anchor, 'steps', fence, () => !!current());
          if (!steps || !current()) return;
          for (const step of assembleHistoryRows(steps)) collectActivity(value, step);
        } else if (anchor.role !== 'user' && !anchor.finalOutput) {
          collectActivity(value, row);
        }
      }
      if (current()) update({ ...request, kind: 'ready', value });
    } catch (cause) {
      if (current()) {
        update({ ...request, kind: 'failed' });
        showToast(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (activityReads()[key] === request) update(cached);
    }
  };
  effect(() => {
    const expanded = expandedTurns();
    if (!expanded.size) return;
    const fence = liveFence();
    if (!fence) return;
    const byKey = activityTurns();
    const reads = activityReads();
    for (const key of expanded) {
      const turn = byKey.get(key);
      if (!turn) continue;
      const fingerprint = activityFingerprint(turn, fence);
      if (reads[key]?.fingerprint !== fingerprint) void readActivity(turn, fence, fingerprint);
    }
  });
  const retryActivity = (key: string) => {
    const fence = liveFence();
    const turn = activityTurns().get(key);
    if (fence && turn) void readActivity(turn, fence, activityFingerprint(turn, fence));
  };
  const activityDetail = (key: string) => {
    const read = activityReads()[key];
    if (read?.generation === generation()) return read;
  };

  const openFiles = () => {
    hapticSelection();
    props.onOpenProjectFiles?.({
      ...props.item,
      session: ctrl.observation()?.session ?? props.item.session,
    });
  };

  const AgentTranscriptItem = (props: { turn: DisplayTurn }) => (
    <If
      when={props.turn.role === 'user'}
      else={
        <View style={{ width: '100%', gap: 4 }}>
          <Text style={{ ...type.caption, color: token('muted-foreground') }}>Maka</Text>
          <CollapsibleActivity
            thinking={props.turn.thinking}
            tools={[...props.turn.tools.values()]}
            folded={props.turn.folded}
            groups={props.turn.groups}
            history={{
              expanded: expandedTurns().has(props.turn.activityKey),
              detail: activityDetail(props.turn.activityKey),
              onToggle: () => toggleActivity(props.turn.activityKey),
              onRetry: () => retryActivity(props.turn.activityKey),
            }}
            limitReached={quoteLimitReached()}
            onQuote={quoteMessage}
          />
          <Each of={props.turn.bodies} key={(row) => row.key}>
            {(row) => (
              <View style={{ gap: 2 }}>
                <MessageBody
                  row={row()}
                  limitReached={quoteLimitReached()}
                  onQuote={quoteMessage}
                  onAskSide={canAskSide() && rowAnchor(row()) ? askAboutRow : undefined}
                />
                <If
                  when={
                    canAskSide() && row().first.position
                      ? sideAtAnchor().get(historyAddressKey(row().first.position))
                      : undefined
                  }
                >
                  {(items) => (
                    <Button
                      accessibilityLabel={
                        items().some((item) => item.activity === 'waiting')
                          ? tr('{title} · Waiting for your response', {
                              title: tr('Side questions ({count})', {
                                count: items().length,
                              }),
                            })
                          : tr('Side questions ({count})', { count: items().length })
                      }
                      class="active:opacity-60"
                      style={{
                        minHeight: 44,
                        minWidth: 44,
                        alignSelf: 'flex-start',
                        justifyContent: 'center',
                      }}
                      onPress={() =>
                        items().length === 1
                          ? openSide(items()[0])
                          : sideList.set({
                              kind: 'anchor',
                              key: historyAddressKey(row().first.position),
                            })
                      }
                    >
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          borderRadius: 12,
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          backgroundColor: token('inline-card'),
                        }}
                      >
                        <Icon name="sideQuestion" size={14} color={token('muted-foreground')} />
                        <Text style={{ ...type.footnote, color: token('foreground') }}>
                          {formatCount(items().length)}
                        </Text>
                        <If when={items().some((item) => item.activity === 'waiting')}>
                          <StatusDot kind="waiting" size={7} />
                        </If>
                      </View>
                    </Button>
                  )}
                </If>
              </View>
            )}
          </Each>
          <If when={props.turn.bodies.length}>
            <ReplyActions
              bodies={props.turn.bodies}
              needsFullReply={Boolean(props.turn.folded)}
              startsAtPageBoundary={hasMoreBefore() && props.turn.key === turns()[0]?.key}
              loadBodies={
                props.turn.folded && liveFence() ? () => fullReply(props.turn.folded!) : undefined
              }
              limitReached={quoteLimitReached()}
              onQuote={quoteMessage}
              onAskSide={
                canAskSide() && replyAnchor(props.turn.bodies)
                  ? () => askAboutReply(props.turn.bodies)
                  : undefined
              }
            />
          </If>
        </View>
      }
    >
      <View style={{ alignItems: 'flex-end' }}>
        <View
          style={{
            maxWidth: '84%',
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 18,
            borderCurve: 'continuous',
            backgroundColor: token('user-bubble-tint'),
            gap: 4,
          }}
        >
          <HistoryQuotes quotes={props.turn.quotes ?? []} />
          <Each of={props.turn.bodies} key={(row) => row.key}>
            {(row) => (
              <MessageBody row={row()} limitReached={quoteLimitReached()} onQuote={quoteMessage} />
            )}
          </Each>
        </View>
      </View>
    </If>
  );

  return (
    <NavPage
      style={{ flex: 1 }}
      title={sessionTitle()}
      headerBackVisible={!sideDraft?.busy()}
      popOnBack={!sideDraft?.busy()}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      ios={{
        headerRightItems: sideDraft
          ? []
          : [
              {
                key: 'files',
                symbol: 'folder',
                label: tr('Files & Changes'),
                onPress: openFiles,
              },
              {
                key: 'more',
                symbol: 'ellipsis.circle',
                label: tr('More'),
                menu: [
                  { label: tr('Files & Changes'), onSelect: openFiles },
                  ...(canAskSide()
                    ? [{ label: tr('All Side Questions'), onSelect: showAllSides }]
                    : []),
                  ...(ctrl.queue().entries.length > 0
                    ? [
                        {
                          label: tr('Queued Messages ({count})', {
                            count: ctrl.queue().entries.length,
                          }),
                          onSelect: () => queueSheetOpen.set(true),
                        },
                      ]
                    : []),
                  ...(isRunning()
                    ? [{ label: tr('Stop Run'), onSelect: () => void ctrl.stopRun() }]
                    : []),
                  { label: tr('Refresh'), onSelect: () => void ctrl.refreshAll() },
                ],
              },
            ],
      }}
      header={
        <ScreenHeader
          title={sessionTitle()}
          backLabel={sideDraft ? tr('Cancel') : props.mainChat ? tr('Back') : tr('Chats')}
          onBack={sideDraft?.busy() ? undefined : props.onBack}
          trailing={
            sideDraft ? undefined : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <View
                  role="button"
                  accessibilityLabel={tr('Files & Changes')}
                  onPress={openFiles}
                  style={{
                    minHeight: 44,
                    minWidth: 44,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="folder" color={token('primary')} size={20} />
                </View>
                <If when={canAskSide()}>
                  <MenuButton
                    accessibilityLabel={tr('More')}
                    items={[
                      {
                        id: 'side-questions',
                        label: tr('All Side Questions'),
                        icon: 'bubble.left.and.bubble.right',
                      },
                    ]}
                    onSelect={showAllSides}
                  >
                    <View
                      style={{
                        minHeight: 44,
                        minWidth: 44,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Icon name="more" size={20} color={token('primary')} />
                    </View>
                  </MenuButton>
                </If>
              </View>
            )
          }
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: token('canvas') }}>
        {/* The native nav bar fits its own title between the actual UIKit items. */}
        <View
          style={{
            paddingLeft: Math.max(spacing.pageX, insets().left),
            paddingRight: Math.max(spacing.pageX, insets().right),
            paddingBottom: 6,
            backgroundColor: token('grouped-bg'),
            flexDirection: 'row',
            justifyContent: isAvailable ? 'center' : 'flex-start',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <StatusDot kind={hostStatusKind(rootId)} size={7} />
          <Text
            style={{
              ...type.footnote,
              color: token('muted-foreground'),
              minWidth: 0,
              flexShrink: 1,
              numberOfLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {subtitleLine()}
          </Text>
        </View>

        <If when={props.mainChat && side()}>
          <View style={{ paddingHorizontal: spacing.pageX, alignItems: 'flex-start' }}>
            <ActionButton
              title={tr('Bring to Main Draft')}
              icon="link"
              compact
              minHeight={44}
              variant="quiet"
              onPress={() => void bringBack()}
            />
          </View>
        </If>

        <List
          ref={(ref) => (transcriptRef = ref)}
          testID="chat-transcript"
          each={transcript()}
          keyExtractor={(item) => item.key}
          estimatedItemSize={100}
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={followLatest() ? { autoscrollToBottomThreshold: 64 } : {}}
          onLoadMoreAtStart={() => {
            if (transcriptCanScroll) loadEarlierFromDrag();
          }}
          loadMoreAtStartThreshold={0.2}
          onScrollDragStart={() => {
            pagingDrag =
              ctrl.loading() || ctrl.loadingEarlier() || ctrl.earlierFailed()
                ? undefined
                : generation();
          }}
          onScroll={({ offset, delta, size, contentSize }) => {
            const gen = generation();
            const previous = lastTranscriptScroll;
            lastTranscriptScroll = {
              generation: gen,
              height: contentSize.height,
              viewport: size.height,
              y: offset.y,
            };
            transcriptCanScroll = contentSize.height - size.height > 1;
            const nearEnd = contentSize.height - offset.y - size.height <= 64;
            atBottom.set(nearEnd);
            if (!transcriptCanScroll && !ctrl.loadingEarlier()) followLatest.set(true);
            if (delta.y < 0 && !nearEnd) followLatest.set(false);
            if (delta.y > 0 && nearEnd) followLatest.set(true);
            if (delta.y >= 0) return;
            if (!transcriptCanScroll) {
              if (offset.y < -1) loadEarlierFromDrag();
              return;
            }
            const edge = size.height * 0.2;
            if (offset.y <= edge) {
              if (pagingDrag !== undefined) {
                loadEarlierFromDrag();
              } else if (previous && previous.generation === gen && offset.y < previous.y) {
                const sameLayout =
                  previous.height === contentSize.height && previous.viewport === size.height;
                const crossedEdge = sameLayout && previous.y > edge;
                const reachedTop = offset.y <= 1 && previous.y > 1;
                if (crossedEdge || reachedTop) startEarlier();
              }
            }
          }}
          onScrollEnd={() => {
            pagingDrag = undefined;
          }}
          contentStyle={{
            paddingHorizontal: spacing.pageX,
            paddingTop: 12,
            paddingBottom: 24,
            gap: 16,
          }}
          empty={
            <If
              when={
                !pending &&
                hostOnline() &&
                ctrl.loading() &&
                !ctrl.historyLoaded() &&
                !hasLivePreview() &&
                inlineInteractions().length === 0 &&
                !ctrl.error()
              }
            >
              <TranscriptSkeleton />
            </If>
          }
          header={
            <View style={{ gap: 8 }}>
              <If when={sideDraft?.error() ?? ctrl.error()}>
                {(message) => (
                  <BannerNotice
                    tone={sideDraft?.uncertain() ? 'warning' : 'destructive'}
                    title={message()}
                    actionLabel={sideDraft?.uncertain() ? tr('View All Side Questions') : undefined}
                    onAction={showAllSides}
                  />
                )}
              </If>
              <If when={hasMoreBefore() && !ctrl.loading()}>
                <View style={{ alignItems: 'center' }}>
                  <ActionButton
                    title={
                      ctrl.loadingEarlier()
                        ? tr('Loading…')
                        : ctrl.earlierFailed()
                          ? tr('Retry')
                          : tr('Load earlier')
                    }
                    variant="quiet"
                    compact
                    minHeight={44}
                    disabled={ctrl.loadingEarlier() || generation() == null}
                    onPress={() => startEarlier(ctrl.earlierFailed())}
                  />
                </View>
              </If>
            </View>
          }
          footer={
            <View style={{ gap: 16 }}>
              {/* Live Streaming Preview */}
              <If when={hasLivePreview()}>
                <View style={{ width: '100%', gap: 4 }}>
                  <CollapsibleActivity
                    thinking={ctrl.livePreview().thinking}
                    tools={ctrl.livePreview().tools.map((t) => ({
                      id: t.toolUseId,
                      label: t.name,
                      isError: false,
                    }))}
                    live
                  />
                  <If when={ctrl.livePreview().body.trim().length > 0}>
                    <TextView
                      markdown={ctrl.livePreview().body}
                      classes={{ codeBlockHeader: 'px-3 text-foreground' }}
                      codeBlockActions={[{ id: 'copy', label: tr('Copy') }]}
                      selectable
                      styles={{
                        paragraph: { color: token('foreground'), fontSize: 16, lineHeight: 24 },
                      }}
                      onLinkPress={({ url }) => void openUrl(url)}
                    />
                  </If>
                </View>
              </If>

              {/* Inline Pending Approvals & Questions */}
              <Each of={inlineInteractions()} key={(rec) => rec.requestId}>
                {(rec, index) => (
                  <InlineInteractionCard
                    record={rec()}
                    hostName={hostName()}
                    sessionTitle={sessionTitle()}
                    accepted={
                      feedback.outcome()?.record.requestId === rec().requestId
                        ? feedback.outcome()?.accepted
                        : undefined
                    }
                    busy={Boolean(ctrl.busyInteractionIds()[rec().requestId])}
                    onRespond={async (answer) => {
                      const record = rec();
                      const position = index();
                      const result = await ctrl.respondInteraction(record.requestId, answer);
                      const accepted = approvalOutcome(result?.outcome);
                      if (accepted !== null) feedback.show({ record, index: position, accepted });
                    }}
                  />
                )}
              </Each>
            </View>
          }
        >
          {(item) => (
            <Each of={[item()]} key={(row) => row.key}>
              {(row) => (
                <If
                  when={row().kind === 'room'}
                  else={<AgentTranscriptItem turn={row() as DisplayTurn} />}
                >
                  <RoomTranscriptItem message={(row() as RoomTranscriptRow).message} />
                </If>
              )}
            </Each>
          )}
        </List>

        {/* Subtle Floating Jump-to-Latest Pill when user scrolled up */}
        <View>
          <If when={!atBottom() && (isRunning() || hasLivePreview())}>
            <View style={{ position: 'absolute', right: 16, bottom: 8 }}>
              <View
                role="button"
                accessibilityLabel={tr('Scroll to latest')}
                onPress={() => scrollToBottom(true)}
                class="active:opacity-75"
                style={{
                  minHeight: 36,
                  paddingHorizontal: 12,
                  borderRadius: 18,
                  backgroundColor: token('surface-elevated'),
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <Icon name="arrowDown" color={token('primary')} size={15} />
                <Text style={{ ...type.caption, fontWeight: '600', color: token('primary') }}>
                  {tr('Latest')}
                </Text>
              </View>
            </View>
          </If>
        </View>

        {/* Queued Messages Compact Pill */}
        <If when={ctrl.queue().entries.length > 0}>
          <View
            style={{
              paddingHorizontal: spacing.pageX,
              paddingBottom: 6,
            }}
          >
            <View
              role="button"
              accessibilityLabel={tr('Queued Messages ({count})', {
                count: ctrl.queue().entries.length,
              })}
              onPress={() => {
                hapticSelection();
                queueSheetOpen.set(true);
              }}
              class="active:opacity-75"
              style={{
                minHeight: 36,
                paddingHorizontal: 12,
                borderRadius: 10,
                borderCurve: 'continuous',
                backgroundColor: token('grouped-bg'),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 }}>
                <Icon name="queue" color={token('primary')} size={15} />
                <Text
                  style={{
                    ...type.footnote,
                    fontWeight: '500',
                    color: token('foreground'),
                    flex: 1,
                    numberOfLines: 1,
                    textOverflow: 'ellipsis',
                  }}
                >
                  {tr('{count, plural, one {# message queued} other {# messages queued}}', {
                    count: ctrl.queue().entries.length,
                  })}
                </Text>
              </View>
              <Icon name="chevronRight" color={token('tertiary-foreground')} size={14} />
            </View>
          </View>
        </If>

        {/* Bottom Composer or Offline Notice */}
        <View
          style={{
            paddingHorizontal: spacing.pageX,
            paddingTop: 8,
            paddingBottom: Math.max(insets().bottom, 12) + 4,
            backgroundColor: token('canvas'),
            borderTopWidth: spacing.hairline,
            borderTopColor: token('separator'),
          }}
        >
          <If when={!ctrl.isRoom() && (quotes().length || links().length)}>
            <DraftQuoteStrip
              quotes={quotes()}
              links={links()}
              disabled={sideDraft?.busy()}
              onClearQuotes={() =>
                sideDraft ? sideDraft.quotes.set([]) : clearDraftQuotes(rootId, sessionId)
              }
              onRemoveQuote={(id) =>
                sideDraft
                  ? sideDraft.quotes.update((items) => items.filter((item) => item.id !== id))
                  : removeDraftQuote(rootId, sessionId, id)
              }
              onRemoveLink={(id) => removeDraftLink(rootId, sessionId, id)}
              mainActions={
                canAskFromTray()
                  ? { ask: () => askSide(traySource), send, canSend: canSend() }
                  : undefined
              }
            />
          </If>
          <If
            when={hostOnline()}
            else={
              <If
                when={connectionProgress()}
                else={
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      minHeight: 44,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                      <StatusDot kind="offline" size={8} />
                      <Text
                        style={{
                          ...type.subheadline,
                          color: token('muted-foreground'),
                          flex: 1,
                          numberOfLines: 1,
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {tr('{name} is offline', { name: hostName() })}
                      </Text>
                    </View>
                    <ActionButton
                      title={tr('Reconnect')}
                      variant="secondary"
                      compact
                      onPress={() => void connectSavedHost(rootId)}
                    />
                  </View>
                }
              >
                {(progress) => (
                  <View style={{ minHeight: 44, justifyContent: 'center' }}>
                    <ConnectionProgress kind={progress()} surface="canvas" />
                  </View>
                )}
              </If>
            }
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-end',
                gap: 8,
              }}
            >
              <View
                style={{
                  flex: 1,
                  minHeight: 42,
                  maxHeight: 132,
                  paddingHorizontal: 14,
                  paddingVertical: 6,
                  borderRadius: 21,
                  borderCurve: 'continuous',
                  backgroundColor: sideDraft ? token('inline-card') : token('surface'),
                  borderWidth: sideDraft ? 1 : 0,
                  borderColor: token('border'),
                  justifyContent: 'center',
                }}
              >
                <Input
                  ref={(r) => (inputRef = r)}
                  multiline
                  accessibilityLabel={tr('Message composer')}
                  value={composerText()}
                  placeholder={
                    sideDraft
                      ? tr('Your question')
                      : isRunning()
                        ? tr('Queue a follow-up message…')
                        : tr('Message Maka…')
                  }
                  disabled={sideDraft?.busy()}
                  ios={sideDraft ? undefined : { inputAccessoryViewID: accessoryId }}
                  onChange={({ value }) => editComposer(value)}
                  style={{
                    ...type.body,
                    color: token('foreground'),
                    placeholderColor: token('muted-foreground'),
                    backgroundColor: 'transparent',
                    maxHeight: 116,
                  }}
                />
              </View>

              <If when={isRunning()}>
                <View
                  role="button"
                  accessibilityLabel={tr('Stop Run')}
                  onPress={() => void ctrl.stopRun()}
                  class="active:opacity-70"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: token('destructive-tint'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="stop" color={token('destructive')} size={16} />
                </View>
              </If>

              <If when={!canAskFromTray()}>
                <View
                  role="button"
                  accessibilityLabel={isRunning() ? tr('Queue message') : tr('Send message')}
                  disabled={!canSend()}
                  onPress={send}
                  class="active:opacity-70"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 20,
                    backgroundColor: canSend() ? token('primary') : token('surface-muted'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon
                    name="send"
                    color={canSend() ? token('primary-foreground') : token('tertiary-foreground')}
                    size={18}
                    strokeWidth={2.3}
                  />
                </View>
              </If>
            </View>
          </If>
        </View>

        {/* iOS Keyboard InputAccessoryView: Model pill + Quote Diff + Hide Keyboard */}
        <If when={!sideDraft}>
          <InputAccessoryView
            nativeID={accessoryId}
            style={{
              backgroundColor: token('surface'),
              borderTopWidth: spacing.hairline,
              borderTopColor: token('separator'),
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: 12,
                paddingVertical: 6,
                gap: 8,
              }}
            >
              <If
                when={!ctrl.isRoom() && ctrl.models().length > 0}
                else={<View style={{ flex: 1 }} />}
              >
                <MenuButton
                  accessibilityLabel={tr('Select model')}
                  disabled={!!ctrl.selectingModel() || ctrl.sending()}
                  title={tr('Model')}
                  items={modelMenuItems()}
                  onSelect={({ id }) => handleSelectModel(id)}
                >
                  <View
                    style={{
                      minHeight: 32,
                      paddingHorizontal: 10,
                      borderRadius: 16,
                      backgroundColor: token('grouped-bg'),
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                      maxWidth: 210,
                    }}
                  >
                    <Icon name="sparkles" color={token('primary')} size={14} />
                    <Text
                      style={{
                        ...type.caption,
                        fontWeight: '600',
                        color: token('foreground'),
                        numberOfLines: 1,
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {currentModelLabel()}
                    </Text>
                    <Icon name="chevronDown" color={token('tertiary-foreground')} size={12} />
                  </View>
                </MenuButton>
              </If>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View
                  role="button"
                  accessibilityLabel={ctrl.isRoom() ? tr('Changes') : tr('Quote diff')}
                  onPress={() => {
                    inputRef?.blur();
                    openFiles();
                  }}
                  style={{
                    minHeight: 32,
                    paddingHorizontal: 10,
                    borderRadius: 16,
                    backgroundColor: token('grouped-bg'),
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <Icon name="diff" color={token('primary')} size={14} />
                  <Text style={{ ...type.caption, fontWeight: '600', color: token('primary') }}>
                    {tr('Changes')}
                  </Text>
                </View>

                <View
                  role="button"
                  accessibilityLabel={tr('Dismiss keyboard')}
                  onPress={() => inputRef?.blur()}
                  style={{
                    width: 34,
                    height: 32,
                    borderRadius: 16,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="keyboardDown" color={token('muted-foreground')} size={18} />
                </View>
              </View>
            </View>
          </InputAccessoryView>
        </If>

        <If when={canAskSide() || sideDraft?.uncertain()}>
          <SideQuestionList
            open={sideList() !== null}
            title={
              sideList()?.kind === 'anchor'
                ? tr('Side questions ({count})', { count: sideRows()?.length ?? 0 })
                : tr('All Side Questions')
            }
            sessions={sideRows()}
            error={sideCatalog.error()}
            onClose={() => sideList.set(null)}
            onOpen={sideDraft ? undefined : openSide}
          />
        </If>

        {/* Queued Messages Sheet */}
        <Sheet
          open={queueSheetOpen()}
          accessibilityLabel={tr('Queued Messages')}
          detents={['medium', 'large']}
          defaultDetent="medium"
          grabber
          closeOnSwipe
          onOpenChange={({ open }) => {
            if (!open) queueSheetOpen.set(false);
          }}
          backdropStyle={{ backgroundColor: token('scrim') }}
          popupStyle={{
            backgroundColor: token('grouped-bg'),
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderCurve: 'continuous',
            paddingTop: 4,
          }}
          grabberStyle={{
            width: 36,
            height: 5,
            borderRadius: 3,
            alignSelf: 'center',
            backgroundColor: token('tertiary-foreground'),
            marginTop: 6,
            marginBottom: 4,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: spacing.pageX,
              paddingTop: 6,
              paddingBottom: 12,
            }}
          >
            <Text style={{ ...type.headline, color: token('foreground') }}>
              {tr('Queued Messages')}
            </Text>
            <View
              role="button"
              accessibilityLabel={tr('Done')}
              onPress={() => queueSheetOpen.set(false)}
              style={{ minHeight: 36, paddingHorizontal: 8, justifyContent: 'center' }}
            >
              <Text style={{ ...type.bodyMedium, color: token('primary') }}>{tr('Done')}</Text>
            </View>
          </View>
          <Scroll style={{ flex: 1 }} contentStyle={{ paddingBottom: 32 }}>
            <InsetGroup elevated>
              <Each of={ctrl.queue().entries} key={(entry) => entry.messageId}>
                {(entry, index) => (
                  <GroupRow
                    title={entry().preview || tr('Queued turn')}
                    subtitle={
                      entry().kind === 'in_flight'
                        ? tr('Running now')
                        : tr('Waiting for current turn')
                    }
                    trailing={
                      entry().kind !== 'in_flight' ? (
                        <View
                          role="button"
                          accessibilityLabel={tr('Remove queued message')}
                          onPress={() => void ctrl.cancelQueuedMessage(entry().messageId)}
                          style={{
                            minHeight: 32,
                            paddingHorizontal: 10,
                            borderRadius: 8,
                            backgroundColor: token('destructive-tint'),
                            justifyContent: 'center',
                          }}
                        >
                          <Text
                            style={{
                              ...type.caption,
                              fontWeight: '600',
                              color: token('destructive'),
                            }}
                          >
                            {tr('Remove')}
                          </Text>
                        </View>
                      ) : undefined
                    }
                    divider={index() < ctrl.queue().entries.length - 1}
                  />
                )}
              </Each>
            </InsetGroup>
          </Scroll>
        </Sheet>
      </View>
    </NavPage>
  );
}
