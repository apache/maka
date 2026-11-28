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
  cleanup,
  computed,
  effect,
  keyboardFrame,
  keymap,
  List,
  openUrl,
  reduceMotion,
  safeAreaInsets,
  Scroll,
  signal,
  Text,
  View,
  token,
  windowSize,
  type Accessor,
  type JSX,
  type InputRef,
  type ListRef,
} from 'nsh';
import { Button, Input, MenuButton, NavPage, Sheet, TextView, type MenuButtonItem } from 'nsh/base';
import { InputAccessoryView } from 'nsh/mobile';
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
  type HistoryRowAddress,
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
  type SendDelivery,
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
  glassSurfaceStyle,
  Icon,
  ScreenHeader,
  StatusDot,
} from '../../ui';

import { createAttachmentPreview } from '../../state/attachmentPreview';
import { createAttachmentComposer, type DraftAttachment } from '../../state/attachments';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';
import {
  AttachmentMenu,
  AttachmentMenuGlyph,
  AttachmentStrip,
  HistoryAttachments,
  type OnAttachmentPreview,
  UploadedAttachments,
  attachmentPickerItems,
  attachmentStripReserve,
} from './AttachmentStrip';
import { DraftQuoteStrip, HistoryQuotes, MessageBody, ReplyActions } from './ChatQuotes';
import { SideQuestionList } from './ChatSideQuestions';
import {
  ComposerPendingDock,
  QueueSendMenu,
  pendingDockLimits,
  type QueueEdit,
} from './ComposerPendingDock';

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
  attachments?: {
    items: NonNullable<AgentHistoryChunk['attachments']>;
    position: HistoryRowAddress;
  };
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
      if (row.text || ch.quotes?.length || ch.attachments?.length) {
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
          attachments: ch.attachments?.length
            ? { items: ch.attachments, position: ch.position }
            : undefined,
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

function UserBubble(props: { children?: JSX.Element }) {
  return (
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
        {props.children}
      </View>
    </View>
  );
}

function RoomTranscriptItem(props: { message: AgentRoomMessage; onPreview: OnAttachmentPreview }) {
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
        <If when={props.message.content.text}>
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
        </If>
        <If when={props.message.deletedAt == null}>
          <HistoryAttachments
            items={props.message.content.attachments}
            source={(_, attachmentIndex) => ({
              kind: 'room',
              messageId: props.message.id,
              attachmentIndex,
            })}
            onPreview={props.onPreview}
          />
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
  const queueExpanded = signal(false);
  const composerSheet = signal<'quotes' | 'pending' | 'attachments' | null>(null);
  const openQueue = () => {
    queueExpanded.set(true);
    composerSheet.set('pending');
  };
  const followLatest = signal(true);
  let transcriptRef: ListRef | undefined;
  let pagingDrag: number | undefined;
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
  const canQueue = () => !sideDraft && isRunning() && ctrl.canDeliver();
  const hostOnline = () => isHostConnected(rootId);
  const connectionProgress = () => hostConnectionProgress(rootId);
  const draft = () => getDraft(rootId, sessionId);
  const quotes = () => (sideDraft ? sideDraft.quotes() : draft().quotes);
  const links = () => (sideDraft ? [] : draft().links);
  const composerText = () => (sideDraft ? sideDraft.text() : draft().input.text);
  const editComposer = (text: string) =>
    sideDraft ? sideDraft.text.set(text) : setDraft(rootId, sessionId, text);
  const quoteLimitReached = () => quotes().length >= quoteLimit;
  const canSend = () => (sideDraft ? sideDraft.canSend() : ctrl.canDeliver());
  const send = (delivery: SendDelivery = 'steer') => {
    if (!canSend()) return;
    if (sideDraft) void sideDraft.submit();
    else
      void ctrl.sendMessage(delivery).then((sent) => {
        if (sent && props.active()) scrollToBottom(false);
      });
  };
  let unbindSend: (() => void) | undefined;
  const unbindComposerSend = () => {
    unbindSend?.();
    unbindSend = undefined;
  };
  cleanup(unbindComposerSend);
  const bindComposerSend = () => {
    unbindComposerSend();
    unbindSend = keymap.bind(
      'mod+enter',
      () => {
        if (props.active()) send();
      },
      { when: 'always' },
    );
  };

  const sendButton = () => (
    <View
      role="button"
      accessibilityLabel={tr('Send message')}
      hitSlop={4}
      disabled={!canSend()}
      onPress={() => send()}
      activeStyle={{ backgroundColor: token('glass-primary-pressed-bg') }}
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: canSend() ? token('glass-accent') : token('surface-muted'),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon
        name="send"
        color={canSend() ? token('surface') : token('tertiary-foreground')}
        size={18}
        strokeWidth={2.3}
      />
    </View>
  );

  const generation = computed(() => activeHostInfo(rootId)?.generation);
  const attachments = sideDraft
    ? undefined
    : createAttachmentComposer(rootId, sessionId, props.active, generation);
  const preview = createAttachmentPreview(rootId, sessionId, props.active, generation);
  const openPreview = (request: Parameters<typeof preview.open>[0]) => {
    inputRef?.blur();
    composerSheet.set(null);
    void preview.open(request);
  };
  const openRemotePreview: OnAttachmentPreview = (info, source) =>
    openPreview({ info, location: { kind: 'remote', source } });
  const openDraftPreview = (item: DraftAttachment) => {
    const location = item.local
      ? { kind: 'local' as const, url: item.local.url }
      : item.kind === 'ready'
        ? { kind: 'remote' as const, source: { kind: 'uploaded' as const, id: item.info.id } }
        : undefined;
    if (location) openPreview({ info: item.info, draftKey: item.key, location });
  };
  effect(() => {
    const image = preview.state()?.request;
    if (image?.draftKey === undefined) return;
    const item = attachments?.items().find(({ key }) => key === image.draftKey);
    if (!item || (image.location.kind === 'local' && item.local?.url !== image.location.url)) {
      preview.close();
    }
  });
  const removePreviewedDraft = () => {
    const key = preview.state()?.request.draftKey;
    if (key === undefined) return;
    preview.close();
    attachments?.remove(key);
  };
  const attachmentCount = () => attachments?.items().length ?? 0;
  const attachmentFailed = () =>
    attachments?.items().some((item) => item.kind === 'failed') ?? false;
  const attachmentLabel = () =>
    tr(attachmentFailed() ? 'Attachments ({count}) · Upload failed' : 'Attachments ({count})', {
      count: attachmentCount(),
    });
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
          <If
            when={
              props.turn.bodies.length && (!hasMoreBefore() || props.turn.key !== turns()[0]?.key)
            }
          >
            <ReplyActions
              bodies={props.turn.bodies}
              loadBodies={props.turn.folded ? () => fullReply(props.turn.folded!) : undefined}
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
      <UserBubble>
        <HistoryQuotes quotes={props.turn.quotes ?? []} />
        <Each of={props.turn.bodies} key={(row) => row.key}>
          {(row) => (
            <MessageBody row={row()} limitReached={quoteLimitReached()} onQuote={quoteMessage} />
          )}
        </Each>
        <If when={props.turn.attachments}>
          {(attachmentRow) => (
            <HistoryAttachments
              items={attachmentRow().items}
              source={(_, attachmentIndex) => {
                const fence = ctrl.historyFence();
                if (fence) {
                  return {
                    kind: 'history',
                    through: fence.through ?? 0,
                    position: attachmentRow().position,
                    attachmentIndex,
                  };
                }
              }}
              onPreview={openRemotePreview}
            />
          )}
        </If>
      </UserBubble>
    </If>
  );

  const canBringBack = () => !!props.mainChat && side();
  const bringBackLabel = () => tr('Bring to Main Draft');

  return (
    <NavPage
      style={{ flex: 1 }}
      title={sessionTitle()}
      headerBackVisible={!sideDraft?.busy()}
      popOnBack={!sideDraft?.busy()}
      hidesBottomBarWhenPushed
      headerTransparent
      headerBackgroundOnScroll
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
              ...(canBringBack()
                ? [
                    {
                      key: 'bring-main',
                      symbol: 'link',
                      label: bringBackLabel(),
                      onPress: () => void bringBack(),
                    },
                  ]
                : []),
              {
                key: 'more',
                symbol: 'ellipsis.circle',
                label: tr('More'),
                menu: [
                  { label: tr('Files & Changes'), onSelect: openFiles },
                  ...(canAskSide()
                    ? [{ label: tr('All Side Questions'), onSelect: showAllSides }]
                    : []),
                  ...(ctrl.queuedMessages().length > 0
                    ? [
                        {
                          label: tr('Queued Messages ({count})', {
                            count: ctrl.queuedMessages().length,
                          }),
                          onSelect: openQueue,
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
          compact
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
                <If when={canBringBack()}>
                  <Button
                    accessibilityLabel={bringBackLabel()}
                    onPress={() => void bringBack()}
                    class="active:opacity-60"
                    style={{
                      width: 44,
                      height: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name="link" color={token('primary')} size={20} />
                  </Button>
                </If>
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
      <ChatContent />
    </NavPage>
  );

  function ChatContent() {
    // The page scope includes a transparent UIKit bar, but not the in-flow fallback header.
    const insets = safeAreaInsets();
    const composerLayout = signal<{ compact: boolean; height: number } | undefined>(undefined);
    const contextHeight = signal(26);
    const contextGap = 6;
    const transcriptGap = 16;
    const keyboardHeight = () => keyboardFrame().height;
    // The keyboard frame already covers the home indicator; the page's safe area doesn't change.
    const bottomInset = () => keyboardHeight() || insets().bottom;

    const pageHeight = signal(windowSize().height);
    const left = () => Math.max(spacing.pageX, insets().left);
    const right = () => Math.max(spacing.pageX, insets().right);
    const hasReferences = () => !ctrl.isRoom() && !!(quotes().length || links().length);
    const queueEditor = signal<QueueEdit | null>(null);
    const queueCount = () => ctrl.queuedMessages().length;
    const hasQueueDock = () => !!(queueCount() || queueEditor() || ctrl.queueError());
    const hasDeliveryDock = () => !!(ctrl.pendingSends().length || ctrl.steeringMessages().length);
    const hasPendingDock = () => !sideDraft && (hasQueueDock() || hasDeliveryDock());
    const pendingDockLabel = () =>
      queueCount() ? tr('Queued Messages ({count})', { count: queueCount() }) : tr('Pending');
    const showLatest = () => !atBottom() && hasLivePreview();
    const jumpToLatest = () => scrollToBottom(!reduceMotion());

    // Leave room for the input at full height, context and at least two lines of transcript.
    // On short pages the secondary controls move into a menu, not on top of the reader.
    const compact = computed(
      () =>
        pageHeight() - insets().top - bottomInset() <
        228 +
          (attachmentCount() ? attachmentStripReserve() : 0) +
          (hasReferences() ? (canAskFromTray() ? 152 : 104) : 0) +
          // Reserve the expanded dock too, so opening it cannot change the mode.
          (hasQueueDock() && !sideDraft ? pendingDockLimits.queue : 0) +
          (hasDeliveryDock() && !sideDraft ? pendingDockLimits.delivery : 0) +
          (hasLivePreview() ? 44 : 0),
    );
    const inlineDock = () => composerSheet() !== 'pending' && (!compact() || !!queueEditor());
    effect(() => {
      // A keyboard-only resize must not reparent the focused editor.
      // An actual rotation to a short page may move it to the sheet.
      if (queueEditor() && pageHeight() < 400 && composerSheet() === null)
        composerSheet.set('pending');
    });
    const bottomGap = () => (compact() ? 6 : 8);
    const composerMinHeight = 48;
    const composerHeight = () => {
      const measured = composerLayout();
      if (measured?.compact === compact()) return measured.height;
      return compact() ? composerMinHeight + bottomGap() : 92;
    };
    // List keeps a gap even before its empty footer slot. Reuse that space on short pages.
    const tailGap = () =>
      compact() && !hasLivePreview() && !inlineInteractions().length ? 4 - transcriptGap : 8;
    const compactItems = (): MenuButtonItem[] => [
      ...(attachments ? attachmentPickerItems(!attachments.canPick()) : []),
      ...(attachmentCount()
        ? [
            {
              id: 'attachments',
              label: attachmentLabel(),
              icon: attachmentFailed() ? 'exclamationmark.triangle' : 'paperclip',
            },
          ]
        : []),
      ...(hasReferences() ? [{ id: 'quotes', label: tr('Quote'), icon: 'quote.bubble' }] : []),
      ...(hasPendingDock() && !inlineDock()
        ? [{ id: 'pending', label: pendingDockLabel(), icon: 'tray' }]
        : []),
      ...(showLatest()
        ? [{ id: 'latest', label: tr('Scroll to latest'), icon: 'arrow.down' }]
        : []),
    ];
    const quoteStrip = () => (
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
          hostOnline() && canAskFromTray()
            ? {
                ask: () => {
                  composerSheet.set(null);
                  askSide(traySource);
                },
                send: () => {
                  composerSheet.set(null);
                  send();
                },
                canSend: canSend(),
                queue: canQueue()
                  ? () => {
                      composerSheet.set(null);
                      send('queue');
                    }
                  : undefined,
              }
            : undefined
        }
      />
    );

    const pendingDock = (inSheet: boolean) => (
      <ComposerPendingDock
        ctrl={ctrl}
        editor={queueEditor}
        inSheet={inSheet}
        expanded={queueExpanded()}
        onExpandedChange={queueExpanded.set}
        running={isRunning()}
        generation={generation()}
        onPreview={openRemotePreview}
        focusComposer={() => {
          composerSheet.set(null);
          inputRef?.focus();
        }}
      />
    );

    function ComposerSheet(props: {
      title: string;
      scrollId: string;
      onClose: () => void;
      editing?: boolean;
      children: JSX.Element;
    }) {
      return (
        <Sheet
          open
          accessibilityLabel={props.title}
          closeOnSwipe={!props.editing}
          closeOnBackdropPress={!props.editing}
          closeOnEscape={!props.editing}
          onOpenChange={({ open }) => {
            if (!open) props.onClose();
          }}
          popupStyle={{
            backgroundColor: token('grouped-bg'),
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: left(),
            paddingRight: right(),
            // Sheet clears the keyboard inset for its children. Bound the
            // scrolling viewport using the owning page's keyboard frame.
            bottom: keyboardHeight() || undefined,
            maxHeight: Math.max(0, windowSize().height - insets().top - bottomInset()),
          }}
        >
          <If when={!props.editing}>
            <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
              <ActionButton
                title={tr('Done')}
                variant="glassQuiet"
                compact
                minHeight={spacing.rowMinHeight}
                onPress={props.onClose}
              />
            </View>
          </If>
          <Scroll
            testID={props.scrollId}
            style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
            keyboardShouldPersistTaps="handled"
          >
            {props.children}
          </Scroll>
        </Sheet>
      );
    }

    return (
      <View
        onLayout={({ bounds }) => pageHeight.set(bounds.size.height)}
        style={{ flex: 1, backgroundColor: token('canvas') }}
      >
        <List
          ref={(ref) => (transcriptRef = ref)}
          testID="chat-transcript"
          each={transcript()}
          keyExtractor={(item) => item.key}
          estimatedItemSize={100}
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={followLatest() ? { autoscrollToBottomThreshold: 64 } : {}}
          onLoadMoreAtStart={loadEarlierFromDrag}
          loadMoreAtStartThreshold={0.2}
          onScrollDragStart={({ offset }) => {
            pagingDrag =
              ctrl.loading() || ctrl.loadingEarlier() || ctrl.earlierFailed()
                ? undefined
                : generation();
            // UIKit reports a drag even when a short transcript only bounces.
            if (offset.y <= 1 && !transcriptCanScroll) loadEarlierFromDrag();
          }}
          onScroll={({ offset, delta, size, contentSize }) => {
            transcriptCanScroll = contentSize.height - size.height > 1;
            const nearEnd = contentSize.height - offset.y - size.height <= 64;
            atBottom.set(nearEnd);
            if (!transcriptCanScroll && !ctrl.loadingEarlier()) followLatest.set(true);
            if (delta.y < 0 && !nearEnd) followLatest.set(false);
            if (delta.y > 0 && nearEnd) followLatest.set(true);
            if (delta.y < 0 && offset.y <= size.height * 0.2) loadEarlierFromDrag();
          }}
          onScrollEnd={() => {
            pagingDrag = undefined;
          }}
          contentStyle={{
            paddingLeft: left(),
            paddingRight: right(),
            // Keep the start gutter stable when the pill hides so reading position doesn't move.
            paddingTop: insets().top + contextHeight() + contextGap * 2,
            paddingBottom: composerHeight() + bottomInset() + tailGap(),
            gap: transcriptGap,
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
              <If when={ctrl.loadingEarlier()}>
                <Text
                  style={{
                    ...type.footnote,
                    color: token('muted-foreground'),
                    textAlign: 'center',
                  }}
                >
                  {tr('Loading…')}
                </Text>
              </If>
              <If when={ctrl.earlierFailed() && hasMoreBefore()}>
                <View style={{ alignItems: 'center' }}>
                  <ActionButton
                    title={tr('Retry')}
                    variant="quiet"
                    compact
                    onPress={() => startEarlier(true)}
                  />
                </View>
              </If>
            </View>
          }
          footer={
            <View style={{ gap: 16 }}>
              <Each of={ctrl.optimisticSends()} key={(send) => send.id}>
                {(send) => (
                  <UserBubble>
                    <HistoryQuotes
                      quotes={send().draft.quotes.map(({ reference }) => ({
                        ...reference,
                        truncated: false,
                      }))}
                    />
                    <If when={send().draft.input.text}>
                      <Text style={{ ...type.body, color: token('foreground') }}>
                        {send().draft.input.text}
                      </Text>
                    </If>
                    <Each of={send().draft.links} key={(link) => link.id}>
                      {(link) => (
                        <Text style={{ ...type.body, color: token('primary') }}>
                          {link().title}
                        </Text>
                      )}
                    </Each>
                    <UploadedAttachments
                      items={send().draft.attachments}
                      onPreview={openRemotePreview}
                    />
                  </UserBubble>
                )}
              </Each>
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
                  <RoomTranscriptItem
                    message={(row() as RoomTranscriptRow).message}
                    onPreview={openRemotePreview}
                  />
                </If>
              )}
            </Each>
          )}
        </List>

        <If when={!compact()}>
          <View
            style={{
              position: 'absolute',
              top: insets().top + contextGap,
              left: left(),
              right: right(),
              alignItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <View
              testID="chat-context"
              onLayout={({ bounds }) => contextHeight.set(Math.ceil(bounds.size.height))}
              style={{
                ...glassSurfaceStyle(spacing.pillRadius),
                maxWidth: '100%',
                paddingHorizontal: 10,
                paddingVertical: 3,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                pointerEvents: 'none',
              }}
            >
              <StatusDot kind={hostStatusKind(rootId)} size={7} />
              <Text
                style={{
                  ...type.footnote,
                  color: token('glass-muted'),
                  minWidth: 0,
                  flexShrink: 1,
                  numberOfLines: 1,
                  textOverflow: 'ellipsis',
                }}
              >
                {subtitleLine()}
              </Text>
            </View>
          </View>
        </If>

        <View
          testID="chat-composer"
          onLayout={({ bounds }) =>
            composerLayout.set({ compact: compact(), height: Math.ceil(bounds.size.height) })
          }
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            marginBottom: keyboardHeight() > 0 ? 'env(keyboard-inset-height)' : insets().bottom,
            paddingLeft: left(),
            paddingRight: right(),
            paddingBottom: bottomGap(),
            pointerEvents: 'box-none',
          }}
        >
          <If when={!compact() && showLatest()}>
            <View
              role="button"
              accessibilityLabel={tr('Scroll to latest')}
              hitSlop={2}
              onPress={jumpToLatest}
              activeStyle={{ backgroundColor: token('glass-action-pressed-bg') }}
              style={{
                ...glassSurfaceStyle(20),
                alignSelf: 'center',
                marginBottom: 8,
                width: 40,
                height: 40,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="arrowDown" color={token('glass-foreground')} size={18} />
            </View>
          </If>

          <If when={inlineDock() && hasPendingDock()}>{pendingDock(false)}</If>
          <If when={!compact() && hasReferences()}>{quoteStrip()}</If>
          <If when={attachments && !compact() && attachmentCount()}>
            <AttachmentStrip composer={attachments!} onPreview={openDraftPreview} />
          </If>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: 8,
              pointerEvents: 'box-none',
            }}
          >
            <If when={attachments && !compact()}>
              <AttachmentMenu composer={attachments!} failed={attachmentFailed()} />
            </If>
            <If when={compact() && compactItems().length}>
              <MenuButton
                testID="chat-composer-actions"
                accessibilityLabel={tr('Composer actions')}
                items={compactItems()}
                onSelect={({ id }) => {
                  if (id === 'latest') jumpToLatest();
                  else if (id === 'quotes') composerSheet.set('quotes');
                  else if (id === 'attachments') composerSheet.set('attachments');
                  else if (id === 'photos' || id === 'files') void attachments?.pick(id);
                  else if (id === 'pending') openQueue();
                }}
                activeStyle={{ backgroundColor: token('glass-pressed-bg') }}
                style={{
                  ...glassSurfaceStyle(22),
                  width: 44,
                  height: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <AttachmentMenuGlyph compact failed={attachmentFailed()} />
              </MenuButton>
            </If>
            <If
              when={hostOnline()}
              else={
                <If
                  when={connectionProgress()}
                  else={
                    <View
                      style={{
                        ...glassSurfaceStyle(22),
                        flex: 1,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        minHeight: 44,
                        paddingHorizontal: 12,
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                        <StatusDot kind="offline" size={8} />
                        <Text
                          style={{
                            ...type.subheadline,
                            color: token('glass-muted'),
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
                        variant="glassSecondary"
                        compact
                        minHeight={spacing.rowMinHeight}
                        onPress={() => void connectSavedHost(rootId)}
                      />
                    </View>
                  }
                >
                  {(progress) => (
                    <View
                      style={{
                        ...glassSurfaceStyle(22),
                        flex: 1,
                        minHeight: 44,
                        paddingHorizontal: 12,
                        justifyContent: 'center',
                      }}
                    >
                      <ConnectionProgress kind={progress()} surface="glass" />
                    </View>
                  )}
                </If>
              }
            >
              <View
                style={{
                  flex: 1,
                  minWidth: 0,
                  flexDirection: 'row',
                  alignItems: 'flex-end',
                  gap: 8,
                  pointerEvents: 'box-none',
                }}
              >
                <View
                  testID="chat-composer-input"
                  accessible={false}
                  onPress={!sideDraft?.busy() ? () => inputRef?.focus() : undefined}
                  style={{
                    ...glassSurfaceStyle(24),
                    ...(sideDraft && { borderColor: token('primary'), borderWidth: 1 }),
                    flex: 1,
                    minWidth: 0,
                    minHeight: composerMinHeight,
                    maxHeight: compact() ? composerMinHeight : 132,
                    paddingLeft: 16,
                    paddingRight: 6,
                    paddingVertical: 5,
                    flexDirection: 'row',
                    alignItems: 'flex-end',
                    gap: 5,
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
                        : isRunning() && !compact()
                          ? tr('Steer or message…')
                          : tr('Message…')
                    }
                    disabled={sideDraft?.busy()}
                    ios={sideDraft ? undefined : { inputAccessoryViewID: accessoryId }}
                    onFocus={bindComposerSend}
                    onBlur={unbindComposerSend}
                    onChange={({ value }) => editComposer(value)}
                    style={{
                      ...type.body,
                      color: token('glass-foreground'),
                      placeholderColor: token('glass-muted'),
                      backgroundColor: 'transparent',
                      flex: 1,
                      minWidth: 0,
                      alignSelf: 'center',
                      maxHeight: compact() ? 30 : 116,
                    }}
                  />
                  <If when={compact() || !canAskFromTray()}>
                    <QueueSendMenu
                      trigger={sendButton()}
                      onQueue={canQueue() ? () => send('queue') : undefined}
                      disabled={!canSend()}
                    />
                  </If>
                </View>

                <If when={isRunning()}>
                  <View
                    role="button"
                    accessibilityLabel={tr('Stop Run')}
                    onPress={() => void ctrl.stopRun()}
                    activeStyle={{ backgroundColor: token('glass-action-bg') }}
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 22,
                      backgroundColor: token('surface-elevated'),
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name="stop" color={token('glass-destructive')} size={16} />
                  </View>
                </If>
              </View>
            </If>
          </View>
        </View>

        <If when={!sideDraft}>
          <InputAccessoryView nativeID={accessoryId} style={{ backgroundColor: 'transparent' }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                minHeight: 48,
                paddingLeft: left(),
                paddingRight: right(),
                gap: 8,
              }}
            >
              <If
                when={!ctrl.isRoom() && ctrl.models().length > 0}
                else={<View style={{ flex: 1 }} />}
              >
                <MenuButton
                  testID="chat-keyboard-model"
                  accessibilityLabel={tr('Select model')}
                  disabled={!!ctrl.selectingModel() || ctrl.sending()}
                  title={tr('Model')}
                  items={modelMenuItems()}
                  onSelect={({ id }) => handleSelectModel(id)}
                  // The native menu button covers its host, not the inset glass.
                  style={{ flexShrink: 1, paddingVertical: 4 }}
                >
                  <View
                    testID="chat-keyboard-model-glass"
                    style={{
                      ...glassSurfaceStyle(18),
                      minHeight: 36,
                      paddingHorizontal: 10,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                      maxWidth: 210,
                    }}
                  >
                    <Icon name="sparkles" color={token('glass-foreground')} size={14} />
                    <Text
                      style={{
                        ...type.caption,
                        fontWeight: '600',
                        color: token('glass-foreground'),
                        minWidth: 0,
                        flexShrink: 1,
                        numberOfLines: 1,
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {currentModelLabel()}
                    </Text>
                    <Icon name="chevronDown" color={token('glass-foreground')} size={12} />
                  </View>
                </MenuButton>
              </If>

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View
                  role="button"
                  accessibilityLabel={ctrl.isRoom() ? tr('Changes') : tr('Quote diff')}
                  hitSlop={{ top: 4, bottom: 4 }}
                  onPress={() => {
                    inputRef?.blur();
                    openFiles();
                  }}
                  activeStyle={{ backgroundColor: token('glass-pressed-bg') }}
                  style={{
                    ...glassSurfaceStyle(18),
                    minWidth: 44,
                    minHeight: 36,
                    paddingHorizontal: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <Icon name="diff" color={token('glass-foreground')} size={14} />
                  <Text
                    style={{ ...type.caption, fontWeight: '600', color: token('glass-foreground') }}
                  >
                    {tr('Changes')}
                  </Text>
                </View>

                <View
                  role="button"
                  accessibilityLabel={tr('Dismiss keyboard')}
                  hitSlop={4}
                  onPress={() => inputRef?.blur()}
                  activeStyle={{ backgroundColor: token('glass-pressed-bg') }}
                  style={{
                    ...glassSurfaceStyle(18),
                    width: 36,
                    height: 36,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="keyboardDown" color={token('glass-foreground')} size={18} />
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

        <If when={composerSheet() === 'quotes'}>
          <ComposerSheet
            title={tr('Quote')}
            scrollId="chat-quote-sheet-scroll"
            onClose={() => composerSheet.set(null)}
          >
            {quoteStrip()}
          </ComposerSheet>
        </If>

        <If when={attachments && composerSheet() === 'attachments'}>
          <ComposerSheet
            title={attachmentLabel()}
            scrollId="chat-attachments-sheet-scroll"
            onClose={() => composerSheet.set(null)}
          >
            <AttachmentStrip composer={attachments!} onPreview={openDraftPreview} sheet />
          </ComposerSheet>
        </If>

        <If when={composerSheet() === 'pending'}>
          <ComposerSheet
            title={tr('Pending')}
            scrollId="chat-pending-sheet-scroll"
            editing={!!queueEditor()}
            onClose={() => composerSheet.set(null)}
          >
            {pendingDock(true)}
          </ComposerSheet>
        </If>
        <If when={preview.state() !== null}>
          <AttachmentPreviewModal
            preview={preview}
            onRemove={
              preview.state()?.request.draftKey === undefined ? undefined : removePreviewedDraft
            }
          />
        </If>
      </View>
    );
  }
}
