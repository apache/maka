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
  Clipboard,
  effect,
  openUrl,
  safeAreaInsets,
  Scroll,
  signal,
  Text,
  View,
  token,
  type InputRef,
  type ScrollRef,
} from 'nsh';
import { Input, MenuButton, NavPage, Sheet, TextView, type MenuButtonItem } from 'nsh/base';
import { InputAccessoryView, isAvailable } from 'nsh/mobile';
import { describeChildDecision, describePermissions } from '../../approval';
import type {
  AgentHistoryChunk,
  AgentInteractionRecord,
  AgentModelChoice,
  AgentRoomMessage,
} from '../../bridge';
import { tr } from '../../locale';
import {
  createConversationController,
  getDraft,
  getSavedScrollOffset,
  getSelectedBackend,
  saveScrollOffset,
  setDraft,
} from '../../state/chat';
import { connectSavedHost, hostStatusKind, isHostConnected, showToast } from '../../state/hostPool';
import { hapticSelection } from '../../state/preferences';
import type { ScopedSession } from '../../state/sessions';
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

interface ToolSummaryItem {
  id: string;
  label: string;
  isError: boolean;
}

interface DisplayTurn {
  key: string;
  role: 'user' | 'assistant';
  thinking: string;
  tools: ToolSummaryItem[];
  body: string;
}

function readableToolTitle(tool: NonNullable<AgentHistoryChunk['tool']>): string {
  if (typeof tool.title === 'string' && tool.title.trim()) return tool.title.trim();
  if (tool.title && typeof tool.title === 'object' && typeof tool.title.text === 'string') {
    if (tool.title.text.trim()) return tool.title.text.trim();
  }
  return tool.name || tr('Tool call');
}

function groupHistoryTurns(chunks: readonly AgentHistoryChunk[]): DisplayTurn[] {
  const turns: DisplayTurn[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const ch = chunks[i];
    const role: 'user' | 'assistant' = ch.role === 'user' ? 'user' : 'assistant';
    const prev = turns[turns.length - 1];
    const sameAssistant = role === 'assistant' && prev && prev.role === 'assistant';

    if (role === 'user') {
      const txt = (ch.text || '').trim();
      if (!txt) continue;
      turns.push({
        key: ch.messageId || 'u:' + String(i),
        role: 'user',
        thinking: '',
        tools: [],
        body: txt,
      });
      continue;
    }

    const target: DisplayTurn = sameAssistant
      ? prev
      : {
          key: ch.messageId || ch.turnId || 'a:' + String(i),
          role: 'assistant',
          thinking: '',
          tools: [],
          body: '',
        };
    if (!sameAssistant) turns.push(target);

    if (ch.tool) {
      const id = ch.tool.toolUseId || 'tool:' + String(i);
      const label = readableToolTitle(ch.tool);
      const existing = target.tools.find((t) => t.id === id);
      if (existing) {
        existing.label = label;
        existing.isError = existing.isError || Boolean(ch.tool.isError);
      } else {
        target.tools.push({ id, label, isError: Boolean(ch.tool.isError) });
      }
    } else if (ch.field === 'thinking') {
      const t = (ch.text || '').trim();
      if (t) target.thinking = target.thinking ? target.thinking + '\n\n' + t : t;
    } else {
      const b = (ch.text || '').trim();
      if (b) target.body = target.body ? target.body + '\n\n' + b : b;
    }
  }
  return turns;
}

function CollapsibleActivity(props: {
  thinking: string;
  tools: readonly ToolSummaryItem[];
  live?: boolean;
}) {
  const expanded = signal(false);

  const summaryText = () => {
    const toolCount = props.tools.length;
    const hasThink = props.thinking.trim().length > 0;
    if (toolCount > 0 && hasThink) {
      return props.live
        ? tr('Thinking · {count} tools running…', { count: toolCount })
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
    <If when={props.thinking.trim().length > 0 || props.tools.length > 0}>
      <View style={{ marginBottom: 8 }}>
        <View
          role="button"
          accessibilityLabel={summaryText()}
          onPress={() => {
            hapticSelection();
            expanded.update((v) => !v);
          }}
          class="active:opacity-70"
          style={{
            alignSelf: 'flex-start',
            minHeight: 32,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 8,
            borderCurve: 'continuous',
            backgroundColor: token('grouped-bg'),
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <If when={props.live}>
            <StatusDot kind="working" size={6} />
          </If>
          <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
            {summaryText()}
          </Text>
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
            <If when={props.thinking.trim().length > 0}>
              <Text
                style={{
                  ...type.footnote,
                  color: token('muted-foreground'),
                  lineHeight: 19,
                }}
              >
                {props.thinking}
              </Text>
            </If>
            <Each of={[...props.tools]} key={(t) => t.id}>
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
          </View>
        </If>
      </View>
    </If>
  );
}

function InlineInteractionCard(props: {
  record: AgentInteractionRecord;
  hostName: string;
  sessionTitle: string;
  busy: boolean;
  onRespond: (answer: Record<string, unknown>, kind: 'success' | 'warning') => void;
}) {
  const customAnswer = signal('');
  const selectedOption = signal<string | null>(null);
  const req = () => props.record.request;

  if (req().kind === 'question') {
    const qReq = req() as Extract<AgentInteractionRecord['request'], { kind: 'question' }>;
    const firstQ = qReq.questions[0];
    return (
      <View
        style={{
          marginVertical: 8,
          borderRadius: spacing.groupRadius,
          borderCurve: 'continuous',
          backgroundColor: token('grouped-bg'),
          padding: 14,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <StatusDot kind="waiting" size={7} />
          <Text style={{ ...type.caption, fontWeight: '600', color: token('warning') }}>
            {tr('Question')}
          </Text>
        </View>
        <Text style={{ ...type.headline, color: token('foreground') }}>
          {firstQ?.question ?? tr('Question waiting for answer')}
        </Text>
        <View style={{ gap: 8 }}>
          <Each of={firstQ?.options ?? []} key={(o) => o.label}>
            {(opt) => {
              const active = () => selectedOption() === opt().label;
              return (
                <View
                  role="button"
                  accessibilityLabel={opt().label}
                  onPress={() => {
                    hapticSelection();
                    selectedOption.set(opt().label);
                    customAnswer.set('');
                  }}
                  style={{
                    minHeight: 42,
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                    borderRadius: 10,
                    borderCurve: 'continuous',
                    backgroundColor: active() ? token('primary-tint') : token('surface'),
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text
                      style={{
                        ...type.subheadlineMedium,
                        color: active() ? token('primary') : token('foreground'),
                      }}
                    >
                      {opt().label}
                    </Text>
                    <If when={opt().description}>
                      <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                        {opt().description}
                      </Text>
                    </If>
                  </View>
                  <If when={active()}>
                    <Icon name="check" color={token('primary')} size={16} strokeWidth={2.4} />
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
        <Input
          accessibilityLabel={tr('Write your own answer')}
          value={customAnswer()}
          placeholder={tr('Or type a custom answer…')}
          onChange={({ value }) => {
            customAnswer.set(value);
            if (value.trim()) selectedOption.set(null);
          }}
          style={{
            minHeight: 40,
            paddingHorizontal: 12,
            borderRadius: 10,
            backgroundColor: token('surface'),
            ...type.subheadline,
            color: token('foreground'),
            placeholderColor: token('muted-foreground'),
          }}
        />
        <ActionButton
          title={tr('Submit Answer')}
          compact
          disabled={props.busy || (!selectedOption() && !customAnswer().trim())}
          onPress={() => {
            const answerText = customAnswer().trim() || selectedOption() || '';
            props.onRespond(
              {
                kind: 'question',
                answers: [{ question: firstQ?.question ?? '', answer: answerText }],
              },
              'success',
            );
          }}
        />
      </View>
    );
  }

  const badge = () => {
    switch (req().kind) {
      case 'permissions':
        return tr('Permission');
      case 'service_approval':
        return tr('Service');
      case 'computer_app':
        return tr('Desktop App');
      case 'session_approval':
        return tr('Approval');
      default:
        return tr('Action Needed');
    }
  };

  const title = () => {
    const r = req();
    if (r.kind === 'permissions') return r.request.reason || tr('Additional permissions requested');
    if (r.kind === 'service_approval')
      return tr('Allow service call {name}?', { name: r.toolName || r.service });
    if (r.kind === 'computer_app') return tr('Allow control of {name}?', { name: r.display.name });
    if (r.kind === 'session_approval') return tr('Approve delegated action?');
    return tr('Allow client capability?');
  };

  const detail = (): { text?: string; mono?: boolean } => {
    const r = req();
    if (r.kind === 'permissions') {
      if (r.request.command?.command) return { text: r.request.command.command, mono: true };
      const desc = describePermissions(r.request.permissions);
      return desc ? { text: desc, mono: false } : {};
    }
    if (r.kind === 'service_approval') return { text: r.service + '.' + r.method, mono: true };
    if (r.kind === 'session_approval') {
      const desc = describeChildDecision(r.answer);
      return desc ? { text: desc, mono: false } : {};
    }
    return {};
  };

  const allowAnswer = (scope: 'once' | 'session'): Record<string, unknown> => {
    const r = req();
    if (r.kind === 'permissions') {
      return {
        kind: 'permissions',
        decision: { decision: 'allow', scope, permissions: r.request.permissions },
      };
    }
    if (r.kind === 'service_approval') return { kind: 'service_approval', decision: 'allow' };
    if (r.kind === 'computer_app') return { kind: 'computer_app', decision: scope };
    if (r.kind === 'session_approval') return { kind: 'session_approval', decision: 'approve' };
    return { kind: 'client_capability', decision: 'allow' };
  };

  const denyAnswer = (): Record<string, unknown> => {
    const r = req();
    if (r.kind === 'permissions') return { kind: 'permissions', decision: { decision: 'deny' } };
    return { kind: r.kind, decision: 'deny' };
  };

  return (
    <View
      style={{
        marginVertical: 8,
        borderRadius: spacing.groupRadius,
        borderCurve: 'continuous',
        backgroundColor: token('grouped-bg'),
        overflow: 'hidden',
      }}
    >
      <ApprovalCard
        badge={badge()}
        sourceLine={props.hostName + ' · ' + props.sessionTitle}
        title={title()}
        detail={detail().text}
        monospaceDetail={detail().mono}
        busy={props.busy}
        allowLabel={tr('Allow once')}
        denyLabel={tr('Deny')}
        onAllow={() => props.onRespond(allowAnswer('once'), 'success')}
        onDeny={() => props.onRespond(denyAnswer(), 'warning')}
      />
      <If when={req().kind === 'permissions' || req().kind === 'computer_app'}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <ActionButton
            title={tr('Allow for this session')}
            variant="secondary"
            compact
            disabled={props.busy}
            onPress={() => props.onRespond(allowAnswer('session'), 'success')}
          />
        </View>
      </If>
    </View>
  );
}

export function ChatScreen(props: {
  item: ScopedSession;
  onBack: () => void;
  onOpenProjectFiles: (item: ScopedSession) => void;
}) {
  const insets = safeAreaInsets();
  const rootId = props.item.rootId;
  const sessionId = props.item.session.id;
  const ctrl = createConversationController(rootId, sessionId);

  const atBottom = signal(true);
  const queueSheetOpen = signal(false);
  let scrollRef: ScrollRef | undefined;
  let inputRef: InputRef | undefined;
  let restoredScroll = false;

  const sessionTitle = () => ctrl.observation()?.session?.title || props.item.session.title;
  const workspaceName = () => {
    const ws = ctrl.observation()?.session?.workspace ?? props.item.session.workspace;
    return ws?.name || ws?.path?.split('/').filter(Boolean).pop() || tr('Default workspace');
  };
  const subtitleLine = () => props.item.hostName + ' · ' + workspaceName();
  const turns = () => groupHistoryTurns(ctrl.chunks());
  const isRunning = () => ctrl.observation()?.run !== null && ctrl.observation()?.run !== undefined;
  const hostOnline = () => isHostConnected(rootId);
  const draft = () => getDraft(rootId, sessionId);
  const hasLivePreview = () => {
    const p = ctrl.livePreview();
    return Boolean(p.body.trim() || p.thinking.trim() || p.tools.length > 0);
  };

  const currentModelLabel = () => {
    const chosen = getSelectedBackend(rootId, sessionId);
    const list = ctrl.models();
    if (chosen && chosen.kind === 'model') {
      const match = list.find(
        (m) => m.selection.kind === 'model' && m.selection.modelId === chosen.modelId,
      );
      return match?.label ?? chosen.modelId;
    }
    return list[0]?.label ?? tr('Model');
  };

  const modelMenuItems = (): MenuButtonItem[] => {
    const chosen = getSelectedBackend(rootId, sessionId);
    return ctrl.models().map((m: AgentModelChoice, idx: number) => {
      const id =
        m.selection.kind === 'model'
          ? 'model:' + m.selection.modelId + ':' + (m.selection.thinkingLevel ?? '')
          : 'exec:' + m.selection.executorId + ':' + String(idx);
      const checked =
        chosen !== null &&
        chosen.kind === m.selection.kind &&
        (chosen.kind === 'model' && m.selection.kind === 'model'
          ? chosen.modelId === m.selection.modelId
          : false);
      return {
        id,
        label: m.label,
        checked,
        singleSelection: true,
      };
    });
  };

  const handleSelectModel = (id: string) => {
    const match = ctrl.models().find((m, idx) => {
      const key =
        m.selection.kind === 'model'
          ? 'model:' + m.selection.modelId + ':' + (m.selection.thinkingLevel ?? '')
          : 'exec:' + m.selection.executorId + ':' + String(idx);
      return key === id;
    });
    if (match) void ctrl.selectModel(match.selection);
  };

  let lastContentHeight = 0;

  const scrollToBottom = (animated = true) => {
    scrollRef?.scrollTo({ y: Math.max(0, lastContentHeight), animated });
    atBottom.set(true);
  };

  // Auto-scroll ONLY while user is anchored at the bottom.
  effect(() => {
    const _len = turns().length;
    const _rooms = ctrl.roomMessages().length;
    const _preview = ctrl.livePreview().body.length;
    const _pending = ctrl.pendingInteractions().length;
    void _len;
    void _rooms;
    void _preview;
    void _pending;
    if (!restoredScroll) {
      const saved = getSavedScrollOffset(rootId, sessionId);
      if (saved > 0) {
        restoredScroll = true;
        setTimeout(() => scrollRef?.scrollTo({ y: saved, animated: false }), 20);
        return;
      }
      restoredScroll = true;
    }
    if (atBottom()) {
      setTimeout(
        () => scrollRef?.scrollTo({ y: Math.max(0, lastContentHeight + 10000), animated: false }),
        16,
      );
    }
  });

  const openFiles = () => {
    hapticSelection();
    props.onOpenProjectFiles({
      ...props.item,
      session: ctrl.observation()?.session ?? props.item.session,
    });
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={sessionTitle()}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      headerTitle={
        isAvailable ? (
          <View style={{ alignItems: 'center', width: 200 }}>
            <Text
              style={{
                ...type.headline,
                fontSize: 15,
                color: token('foreground'),
                textAlign: 'center',
                numberOfLines: 1,
                textOverflow: 'ellipsis',
              }}
            >
              {sessionTitle()}
            </Text>
            <Text
              style={{
                ...type.caption,
                color: token('muted-foreground'),
                textAlign: 'center',
                numberOfLines: 1,
                textOverflow: 'ellipsis',
              }}
            >
              {subtitleLine()}
            </Text>
          </View>
        ) : undefined
      }
      ios={{
        headerRightItems: [
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
          backLabel={tr('Chats')}
          onBack={props.onBack}
          trailing={
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
            </View>
          }
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: token('canvas') }}>
        {/* Compact attribution strip on non-iOS header projection */}
        <If when={!isAvailable}>
          <View
            style={{
              paddingHorizontal: spacing.pageX,
              paddingBottom: 6,
              backgroundColor: token('grouped-bg'),
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <StatusDot kind={hostStatusKind(rootId)} size={7} />
            <Text
              style={{
                ...type.footnote,
                color: token('muted-foreground'),
                flex: 1,
                numberOfLines: 1,
                textOverflow: 'ellipsis',
              }}
            >
              {subtitleLine()}
            </Text>
          </View>
        </If>

        {/* Scrollable Transcript */}
        <Scroll
          ref={(r) => (scrollRef = r)}
          style={{ flex: 1 }}
          keyboardDismissMode="interactive"
          onScroll={(e) => {
            lastContentHeight = e.contentSize.height;
            saveScrollOffset(rootId, sessionId, e.offset.y);
            const distanceFromBottom = e.contentSize.height - (e.offset.y + e.size.height);
            atBottom.set(distanceFromBottom <= 64);
          }}
          contentStyle={{
            paddingHorizontal: spacing.pageX,
            paddingTop: 12,
            paddingBottom: 24,
            gap: 16,
          }}
        >
          <If when={ctrl.error()}>
            <BannerNotice tone="destructive" title={ctrl.error()!} />
          </If>

          <If when={ctrl.beforeCursor() !== null && ctrl.beforeCursor() !== undefined}>
            <View style={{ alignItems: 'center', marginBottom: 4 }}>
              <ActionButton
                title={ctrl.loadingEarlier() ? tr('Loading…') : tr('Load earlier messages')}
                variant="quiet"
                compact
                disabled={ctrl.loadingEarlier()}
                onPress={() => void ctrl.loadEarlier()}
              />
            </View>
          </If>

          {/* Room Messages */}
          <If when={ctrl.isRoom()}>
            <Each of={ctrl.roomMessages()} key={(m) => m.id}>
              {(msg) => {
                const isHuman = () => msg().author.kind === 'human';
                return (
                  <View
                    style={{
                      alignItems: isHuman() ? 'flex-end' : 'flex-start',
                      gap: 4,
                    }}
                  >
                    <If when={!isHuman()}>
                      <Text style={{ ...type.caption, color: token('muted-foreground') }}>
                        {tr('Agent')}
                      </Text>
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
                            markdown={msg().content.text}
                            selectable
                            style={{ color: token('foreground'), fontSize: 16, lineHeight: 24 }}
                            onLinkPress={({ url }) => void openUrl(url)}
                          />
                        }
                      >
                        <Text style={{ ...type.body, color: token('foreground') }}>
                          {msg().content.text}
                        </Text>
                      </If>
                    </View>
                  </View>
                );
              }}
            </Each>
          </If>

          {/* Agent Conversation Turns (Frameless Markdown for Assistant, Tinted Bubble for User) */}
          <If when={!ctrl.isRoom()}>
            <Each of={turns()} key={(t) => t.key}>
              {(turn) => (
                <If
                  when={turn().role === 'user'}
                  else={
                    <View style={{ width: '100%', gap: 4 }}>
                      <CollapsibleActivity thinking={turn().thinking} tools={turn().tools} />
                      <If when={turn().body.length > 0}>
                        <TextView
                          markdown={turn().body}
                          selectable
                          style={{ color: token('foreground'), fontSize: 16, lineHeight: 24 }}
                          onLinkPress={({ url }) => void openUrl(url)}
                        />
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 12,
                            marginTop: 4,
                          }}
                        >
                          <View
                            role="button"
                            accessibilityLabel={tr('Copy reply')}
                            onPress={() => {
                              hapticSelection();
                              void Clipboard.setString(turn().body);
                              showToast(tr('Copied'));
                            }}
                            class="active:opacity-60"
                            style={{
                              minHeight: 32,
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <Icon name="copy" color={token('tertiary-foreground')} size={14} />
                            <Text style={{ ...type.caption, color: token('tertiary-foreground') }}>
                              {tr('Copy')}
                            </Text>
                          </View>
                        </View>
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
                      }}
                    >
                      <Text style={{ ...type.body, color: token('foreground') }}>
                        {turn().body}
                      </Text>
                    </View>
                  </View>
                </If>
              )}
            </Each>
          </If>

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
                  selectable
                  style={{ color: token('foreground'), fontSize: 16, lineHeight: 24 }}
                  onLinkPress={({ url }) => void openUrl(url)}
                />
              </If>
            </View>
          </If>

          {/* Inline Pending Approvals & Questions */}
          <Each of={ctrl.pendingInteractions()} key={(rec) => rec.requestId}>
            {(rec) => (
              <InlineInteractionCard
                record={rec()}
                hostName={props.item.hostName}
                sessionTitle={sessionTitle()}
                busy={Boolean(ctrl.busyInteractionIds()[rec().requestId])}
                onRespond={(answer, kind) =>
                  void ctrl.respondInteraction(rec().requestId, answer, kind)
                }
              />
            )}
          </Each>
        </Scroll>

        {/* Subtle Floating Jump-to-Latest Pill when user scrolled up */}
        <If when={!atBottom() && (isRunning() || hasLivePreview())}>
          <View
            style={{
              position: 'absolute',
              right: 16,
              bottom: Math.max(insets().bottom, 12) + 84,
            }}
          >
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
          <If
            when={hostOnline()}
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
                    {tr('{name} is offline', { name: props.item.hostName })}
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
                  backgroundColor: token('grouped-bg'),
                  justifyContent: 'center',
                }}
              >
                <Input
                  ref={(r) => (inputRef = r)}
                  multiline
                  accessibilityLabel={tr('Message composer')}
                  value={draft()}
                  placeholder={isRunning() ? tr('Queue a follow-up message…') : tr('Message Maka…')}
                  ios={{ inputAccessoryViewID: 'maka-chat-accessory' }}
                  onChange={({ value }) => setDraft(rootId, sessionId, value)}
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

              <View
                role="button"
                accessibilityLabel={isRunning() ? tr('Queue message') : tr('Send message')}
                onPress={() => {
                  if (draft().trim() && !ctrl.sending()) {
                    void ctrl.sendMessage();
                  }
                }}
                class="active:opacity-70"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor:
                    draft().trim() && !ctrl.sending() ? token('primary') : token('surface-muted'),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon
                  name="send"
                  color={
                    draft().trim() && !ctrl.sending()
                      ? token('primary-foreground')
                      : token('tertiary-foreground')
                  }
                  size={18}
                  strokeWidth={2.3}
                />
              </View>
            </View>
          </If>
        </View>

        {/* iOS Keyboard InputAccessoryView: Model pill + Quote Diff + Hide Keyboard */}
        <InputAccessoryView
          nativeID="maka-chat-accessory"
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
            <If when={ctrl.models().length > 0} else={<View style={{ flex: 1 }} />}>
              <MenuButton
                accessibilityLabel={tr('Select model')}
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
                accessibilityLabel={tr('Quote diff')}
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
