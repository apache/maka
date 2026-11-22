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

import { cleanup, mount, safeAreaInsets, Scroll, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import {
  bootstrap,
  connectHost,
  disconnectHost,
  formatSas,
  hostCall,
  onHostState,
  onPairingUri,
  pairHost,
  parseTicket,
  removeHost,
  setFilter,
  type HostStateSnapshot,
  type ParsedTicketInfo,
  type SavedHostItem,
} from './bridge';
import {
  createBurstController,
  ReactionBurstLayer,
  ReactionPickerBar,
  ReactionPillsRow,
  type ReactionEntry,
} from './Reactions';
import { palette, themeMode, toggleThemeMode } from './theme';

type Route = 'home' | 'chat' | 'pairing' | 'artifact' | 'settings';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  author?: string;
  text: string;
  footnote?: string;
  steps?: string[];
  artifactTitle?: string;
  reactions: ReactionEntry[];
}

interface PendingApproval {
  id: string;
  title: string;
  command: string;
  resolved?: string;
}

interface PendingQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  selected: string;
  answered?: string;
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    text: '帮我检查一下远端 Host 连接状态，并跑一次 hostLogs.read 验证通路。',
    reactions: [{ emoji: '🫡', count: 1, mine: false, fromAgent: true }],
  },
  {
    id: 'm2',
    role: 'agent',
    author: 'Maka',
    text: '已就绪。配对并连接任意远端 Host 后，可以直接在下方发指令或一键验证实时 RPC 通路。',
    footnote: '已检查本机凭据 · 等待远端 Host 指令',
    steps: ['校验本机配对票据格式 (PairingTicketV1)', '确认 Root ID 强一致准入策略 (fail-closed)'],
    artifactTitle: 'platform/remote-client/src/client.rs (+24 -4)',
    reactions: [],
  },
];

const DIFF_LINES = [
  { kind: 'ctx', num: '338', text: 'if connected.source.state_domain != expected_root_id {' },
  { kind: 'add', num: '339', text: '+   let _ = anchor.into_inner().shutdown().await;' },
  { kind: 'add', num: '340', text: '+   return Err(RemoteClientError::RootIdMismatch {' },
  { kind: 'add', num: '341', text: '+       expected: expected_root_id.to_owned(),' },
  { kind: 'add', num: '342', text: '+       actual: connected.source.state_domain,' },
  { kind: 'add', num: '343', text: '+   });' },
  { kind: 'ctx', num: '344', text: '}' },
];

function App() {
  const insets = safeAreaInsets();
  const route = signal<Route>('home');
  const hostState = signal<HostStateSnapshot>({
    devicePeerId: '',
    filter: { kind: 'all_computers' },
    hosts: [],
    active: null,
  });
  const statusBanner = signal<string | null>(null);
  const busy = signal(false);

  // Pairing screen state
  const ticketUri = signal('');
  const parsedTicket = signal<ParsedTicketInfo | null>(null);
  const pairingError = signal<string | null>(null);
  const showTechDetails = signal(false);

  // Chat screen state
  const messages = signal<ChatMessage[]>(INITIAL_MESSAGES);
  const expandedFootnotes = signal<Record<string, boolean>>({});
  const activeReactionMsgId = signal<string | null>(null);
  const composerDraft = signal('');
  const quotedLine = signal<string | null>(null);
  const approval = signal<PendingApproval | null>({
    id: 'ap1',
    title: '允许执行远端日志读取？',
    command: 'hostLogs.read({ position: tail })',
  });
  const showMoreApproval = signal(false);
  const question = signal<PendingQuestion | null>(null);
  const burst = createBurstController();

  // Settings screen state
  const autoDailySummary = signal(true);
  const autoReconnect = signal(true);

  const refreshBootstrap = () => {
    bootstrap().then(
      (snap) => {
        hostState.set(snap);
        statusBanner.set(null);
      },
      (err: Error) => statusBanner.set(err.message),
    );
  };

  refreshBootstrap();

  const offState = onHostState((snap) => hostState.set(snap));
  const offLink = onPairingUri((uri) => {
    ticketUri.set(uri);
    route.set('pairing');
    runParseTicket(uri);
  });
  cleanup(() => {
    offState();
    offLink();
  });

  const runParseTicket = (rawUri?: string) => {
    const uri = (rawUri ?? ticketUri()).trim();
    pairingError.set(null);
    if (!uri) {
      parsedTicket.set(null);
      pairingError.set('请粘贴或扫描 maka://pair/v1 配对码');
      return;
    }
    busy.set(true);
    parseTicket(uri).then(
      (info) => {
        parsedTicket.set(info);
        pairingError.set(null);
        busy.set(false);
      },
      (err: Error) => {
        parsedTicket.set(null);
        pairingError.set(err.message);
        busy.set(false);
      },
    );
  };

  const runPairConfirm = () => {
    const uri = ticketUri().trim();
    if (!uri) return;
    busy.set(true);
    pairingError.set(null);
    pairHost(uri).then(
      (res) => {
        hostState.set(res.state);
        busy.set(false);
        ticketUri.set('');
        parsedTicket.set(null);
        statusBanner.set('已连接 ' + (res.state.active?.hostName ?? '远端 Host'));
        route.set('chat');
      },
      (err: Error) => {
        pairingError.set(err.message);
        busy.set(false);
      },
    );
  };

  const runConnectSaved = (hostItem: SavedHostItem) => {
    busy.set(true);
    statusBanner.set(null);
    connectHost(hostItem.rootId).then(
      (snap) => {
        hostState.set(snap);
        busy.set(false);
        route.set('chat');
      },
      (err: Error) => {
        statusBanner.set(err.message);
        busy.set(false);
      },
    );
  };

  const runVerifyLiveRpc = () => {
    const active = hostState().active;
    if (!active) {
      statusBanner.set('尚未连接远端 Host');
      return;
    }
    const targetEndpoint = active.endpoints.includes('hostLogs') ? 'hostLogs' : active.endpoints[0];
    if (!targetEndpoint) {
      statusBanner.set('远端 Host 未暴露可用端点');
      return;
    }
    busy.set(true);
    hostCall(targetEndpoint, 'read', { position: { kind: 'tail' } }).then(
      (res) => {
        busy.set(false);
        const msgId = 'm-rpc-' + String(Date.now());
        messages.set([
          ...messages(),
          {
            id: msgId,
            role: 'agent',
            author: active.hostName,
            text:
              '实时 RPC 校验通过 (' +
              targetEndpoint +
              '.read)，收到 ' +
              String(res.events.length) +
              ' 条远端响应帧。',
            footnote: '已通过 ' + active.hostName + ' · Root ' + active.rootId.slice(0, 8),
            reactions: [{ emoji: '👍', count: 1, mine: false, fromAgent: true }],
          },
        ]);
      },
      (err: Error) => {
        busy.set(false);
        statusBanner.set('RPC 失败: ' + err.message);
      },
    );
  };

  const toggleReaction = (msgId: string, emoji: string) => {
    const next = messages().map((m) => {
      if (m.id !== msgId) return m;
      const existing = m.reactions.find((r) => r.emoji === emoji);
      let updated: ReactionEntry[];
      if (existing) {
        if (existing.mine) {
          updated =
            existing.count <= 1
              ? m.reactions.filter((r) => r.emoji !== emoji)
              : m.reactions.map((r) =>
                  r.emoji === emoji ? { ...r, count: r.count - 1, mine: false } : r,
                );
        } else {
          burst.trigger(emoji);
          updated = m.reactions.map((r) =>
            r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r,
          );
        }
      } else {
        burst.trigger(emoji);
        updated = [...m.reactions, { emoji, count: 1, mine: true }];
      }
      return { ...m, reactions: updated };
    });
    messages.set(next);
    activeReactionMsgId.set(null);
  };

  const sendMessage = () => {
    const text = composerDraft().trim();
    if (!text) return;
    const quote = quotedLine();
    const content = quote ? '> ' + quote + '\n' + text : text;
    composerDraft.set('');
    quotedLine.set(null);
    messages.set([
      ...messages(),
      {
        id: 'u-' + String(Date.now()),
        role: 'user',
        text: content,
        reactions: [{ emoji: '👀', count: 1, mine: false, fromAgent: true }],
      },
    ]);
    if (hostState().active) {
      runVerifyLiveRpc();
    }
  };

  const resolveApproval = (decision: string) => {
    const cur = approval();
    if (!cur) return;
    approval.set({ ...cur, resolved: decision });
    showMoreApproval.set(false);
    if (decision.startsWith('已允许') && hostState().active) {
      runVerifyLiveRpc();
    }
  };

  const activeHostLabel = () => {
    const active = hostState().active;
    if (active) return active.hostName + ' · 在线';
    const total = hostState().hosts.length;
    return total > 0 ? String(total) + ' 台已配对电脑' : '未连接电脑';
  };

  const pendingCount = () => {
    const ap = approval();
    return ap && !ap.resolved ? 1 : 0;
  };

  const topPad = () => Math.max(insets().top, 16);
  const bottomPad = () => Math.max(insets().bottom, 16);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: palette().bg,
        paddingTop: topPad(),
      }}
    >
      {/* ---------------- HOME ---------------- */}
      <If when={route() === 'home'}>
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 20,
              paddingVertical: 12,
            }}
          >
            <Text style={{ fontSize: 28, fontWeight: '700', color: palette().ink }}>Maka</Text>
            <View
              role="button"
              accessibilityLabel="Settings"
              onPress={() => route.set('settings')}
              style={{
                minWidth: 44,
                minHeight: 44,
                borderRadius: 22,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 15, color: palette().ink2 }}>设置</Text>
            </View>
          </View>

          <If when={statusBanner() !== null}>
            <View
              style={{
                marginHorizontal: 16,
                marginBottom: 8,
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 12,
                backgroundColor: palette().accentSoft,
              }}
            >
              <Text style={{ fontSize: 13, color: palette().accent }}>{statusBanner()}</Text>
            </View>
          </If>

          <Scroll
            style={{ flex: 1 }}
            contentStyle={{ paddingHorizontal: 16, paddingBottom: 100, gap: 14 }}
          >
            {/* Conditional cross-host pending inbox (0px when empty) */}
            <If when={pendingCount() > 0}>
              <View
                role="button"
                accessibilityLabel="Open pending approval"
                onPress={() => route.set('chat')}
                style={{
                  padding: 14,
                  borderRadius: 16,
                  backgroundColor: palette().warnSoft,
                  borderWidth: 1,
                  borderColor: palette().warn,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: palette().warn }}>
                    待确认 · 1 项操作
                  </Text>
                  <Text style={{ fontSize: 13, color: palette().ink2 }}>
                    {approval()?.command ?? ''}
                  </Text>
                </View>
                <Text style={{ fontSize: 13, fontWeight: '600', color: palette().warn }}>
                  查看 →
                </Text>
              </View>
            </If>

            {/* Single-row Maka Bot */}
            <View
              role="button"
              accessibilityLabel="Open Maka Bot"
              onPress={() => route.set('chat')}
              style={{
                minHeight: 54,
                paddingHorizontal: 14,
                paddingVertical: 12,
                borderRadius: 16,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <View style={{ gap: 2 }}>
                <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>
                  Maka Bot
                </Text>
                <Text style={{ fontSize: 13, color: palette().ink2 }}>跨电脑对话与即时指令</Text>
              </View>
              <Text style={{ fontSize: 14, color: palette().ink3 }}>›</Text>
            </View>

            {/* Paired Remote Hosts (max 2 levels) */}
            <View style={{ gap: 8 }}>
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: '600',
                  color: palette().ink3,
                  paddingHorizontal: 4,
                }}
              >
                远端电脑
              </Text>
              <If when={hostState().hosts.length === 0}>
                <View
                  style={{
                    padding: 18,
                    borderRadius: 16,
                    backgroundColor: palette().surface,
                    borderWidth: 1,
                    borderColor: palette().line,
                    gap: 10,
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
                    连接你的第一台电脑
                  </Text>
                  <Text style={{ fontSize: 14, color: palette().ink2 }}>
                    在桌面端运行 maka peer pair-ticket，扫码或粘贴配对链接即可安全接入。
                  </Text>
                  <View
                    role="button"
                    accessibilityLabel="Pair first computer"
                    onPress={() => route.set('pairing')}
                    style={{
                      minHeight: 44,
                      borderRadius: 12,
                      backgroundColor: palette().accent,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 15, fontWeight: '600', color: palette().accentText }}>
                      连接新电脑
                    </Text>
                  </View>
                </View>
              </If>

              <Each of={hostState().hosts} key={(h) => h.rootId}>
                {(item) => (
                  <View
                    role="button"
                    accessibilityLabel={'Host ' + item().hostName}
                    onPress={() => (item().connected ? route.set('chat') : runConnectSaved(item()))}
                    style={{
                      minHeight: 58,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      borderRadius: 16,
                      backgroundColor: palette().surface,
                      borderWidth: 1,
                      borderColor: item().connected ? palette().accent : palette().line,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>
                        {item().hostName}
                      </Text>
                      <Text
                        style={{
                          fontSize: 12,
                          color: item().connected ? palette().ok : palette().ink3,
                        }}
                      >
                        {item().connected ? '已连接 · 点击进入工作区' : '已保存 · 点击连接'}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 14, color: palette().ink3 }}>›</Text>
                  </View>
                )}
              </Each>
            </View>
          </Scroll>

          {/* Bottom thumb-zone Host Switcher Pill + Pair CTA */}
          <View
            style={{
              paddingHorizontal: 16,
              paddingTop: 10,
              paddingBottom: bottomPad(),
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <View
              role="button"
              accessibilityLabel="Switch host filter"
              onPress={() => {
                const cur = hostState().filter;
                const first = hostState().hosts[0];
                const nextFilter =
                  cur.kind === 'all_computers' && first
                    ? ({ kind: 'single_computer', root_id: first.rootId } as const)
                    : ({ kind: 'all_computers' } as const);
                setFilter(nextFilter).then(
                  (s) => {
                    hostState.set(s);
                    statusBanner.set(null);
                  },
                  (err: Error) => statusBanner.set(err.message),
                );
              }}
              style={{
                flex: 1,
                minHeight: 46,
                paddingHorizontal: 16,
                borderRadius: 23,
                backgroundColor: palette().glassBg,
                borderWidth: 1,
                borderColor: palette().glassBorder,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: palette().ink }}>
                {activeHostLabel()}
              </Text>
              <Text style={{ fontSize: 12, color: palette().ink2 }}>
                {hostState().filter.kind === 'all_computers' ? '全部' : '单台'}
              </Text>
            </View>

            <View
              role="button"
              accessibilityLabel="Pair new computer"
              onPress={() => route.set('pairing')}
              style={{
                minWidth: 46,
                minHeight: 46,
                paddingHorizontal: 14,
                borderRadius: 23,
                backgroundColor: palette().accent,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 18, fontWeight: '700', color: palette().accentText }}>
                ＋
              </Text>
            </View>
          </View>
        </View>
      </If>

      {/* ---------------- CHAT ---------------- */}
      <If when={route() === 'chat'}>
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: palette().line,
            }}
          >
            <View
              role="button"
              accessibilityLabel="Back to home"
              onPress={() => route.set('home')}
              style={{
                minWidth: 44,
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 6,
              }}
            >
              <Text style={{ fontSize: 16, color: palette().accent }}>‹ 返回</Text>
            </View>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>
                {hostState().active?.hostName ?? 'Maka Bot'}
              </Text>
              <Text
                style={{ fontSize: 12, color: hostState().active ? palette().ok : palette().ink3 }}
              >
                {hostState().active ? '远端 Host 已就绪' : '本地预览会话'}
              </Text>
            </View>
            <View
              role="button"
              accessibilityLabel="Verify live Host RPC"
              onPress={runVerifyLiveRpc}
              style={{
                minWidth: 44,
                minHeight: 44,
                justifyContent: 'center',
                alignItems: 'flex-end',
                paddingHorizontal: 6,
              }}
            >
              <Text style={{ fontSize: 13, color: palette().accent }}>检测</Text>
            </View>
          </View>

          <If when={statusBanner() !== null}>
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                backgroundColor: palette().accentSoft,
              }}
            >
              <Text style={{ fontSize: 12, color: palette().accent }}>{statusBanner()}</Text>
            </View>
          </If>

          <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 16, paddingBottom: 24 }}>
            <Each of={messages()} key={(m) => m.id}>
              {(msg) => (
                <View
                  style={{
                    alignItems: msg().role === 'user' ? 'flex-end' : 'flex-start',
                    gap: 6,
                  }}
                >
                  <If when={msg().role === 'user'}>
                    <View
                      role="button"
                      accessibilityLabel={'Message ' + msg().id}
                      onPress={() => activeReactionMsgId.set(msg().id)}
                      style={{
                        maxWidth: '82%',
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: 18,
                        backgroundColor: palette().userBubble,
                      }}
                    >
                      <Text
                        style={{ fontSize: 16, lineHeight: 23, color: palette().userBubbleText }}
                      >
                        {msg().text}
                      </Text>
                    </View>
                  </If>

                  <If when={msg().role === 'agent'}>
                    <View style={{ width: '100%', gap: 6 }}>
                      <View
                        role="button"
                        accessibilityLabel={'Agent message ' + msg().id}
                        onPress={() => activeReactionMsgId.set(msg().id)}
                        style={{ gap: 6 }}
                      >
                        <Text style={{ fontSize: 16, lineHeight: 24, color: palette().ink }}>
                          {msg().text}
                        </Text>
                      </View>

                      {/* Collapsed 1-line living work footnote */}
                      <If when={!!msg().footnote}>
                        <View
                          role="button"
                          accessibilityLabel={'Toggle work details ' + msg().id}
                          onPress={() => {
                            const cur = expandedFootnotes();
                            expandedFootnotes.set({ ...cur, [msg().id]: !cur[msg().id] });
                          }}
                          style={{ paddingVertical: 4 }}
                        >
                          <Text style={{ fontSize: 12.5, color: palette().ink3 }}>
                            {(expandedFootnotes()[msg().id] ? '▾ ' : '▸ ') + (msg().footnote ?? '')}
                          </Text>
                        </View>
                      </If>

                      <If when={!!expandedFootnotes()[msg().id] && !!msg().steps}>
                        <View
                          style={{
                            paddingLeft: 12,
                            borderLeftWidth: 2,
                            borderLeftColor: palette().line,
                            gap: 4,
                          }}
                        >
                          <Each of={msg().steps ?? []} key={(s) => s}>
                            {(step) => (
                              <Text style={{ fontSize: 12.5, color: palette().ink2 }}>
                                • {step()}
                              </Text>
                            )}
                          </Each>
                        </View>
                      </If>

                      <If when={!!msg().artifactTitle}>
                        <View
                          role="button"
                          accessibilityLabel="Open diff artifact"
                          onPress={() => route.set('artifact')}
                          style={{
                            alignSelf: 'flex-start',
                            paddingHorizontal: 12,
                            paddingVertical: 8,
                            borderRadius: 12,
                            backgroundColor: palette().surface,
                            borderWidth: 1,
                            borderColor: palette().line,
                          }}
                        >
                          <Text style={{ fontSize: 13, color: palette().accent }}>
                            {msg().artifactTitle} ›
                          </Text>
                        </View>
                      </If>
                    </View>
                  </If>

                  <If when={activeReactionMsgId() === msg().id}>
                    <ReactionPickerBar
                      onPick={(emoji) => toggleReaction(msg().id, emoji)}
                      onDismiss={() => activeReactionMsgId.set(null)}
                    />
                  </If>

                  <ReactionPillsRow
                    reactions={msg().reactions}
                    onToggle={(emoji) => toggleReaction(msg().id, emoji)}
                    onRetryWithNewIdea={() => {
                      composerDraft.set('换一个更直接的思路重新处理');
                    }}
                  />
                </View>
              )}
            </Each>
          </Scroll>

          <ReactionBurstLayer burst={burst} />

          {/* Docked bottom Permission Approval surface */}
          <If when={approval() !== null && !approval()?.resolved}>
            <View
              style={{
                marginHorizontal: 12,
                marginBottom: 8,
                padding: 14,
                borderRadius: 18,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
                gap: 10,
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
                {approval()?.title ?? ''}
              </Text>
              <Text style={{ fontSize: 13, color: palette().ink2 }}>
                {approval()?.command ?? ''}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View
                  role="button"
                  accessibilityLabel="Allow once"
                  onPress={() => resolveApproval('已允许本次')}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 12,
                    backgroundColor: palette().accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '600', color: palette().accentText }}>
                    允许本次
                  </Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel="Deny approval"
                  onPress={() => resolveApproval('已拒绝')}
                  style={{
                    minWidth: 72,
                    minHeight: 44,
                    borderRadius: 12,
                    backgroundColor: palette().dangerSoft,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingHorizontal: 14,
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '600', color: palette().danger }}>
                    拒绝
                  </Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel="More approval durations"
                  onPress={() => showMoreApproval.set(!showMoreApproval())}
                  style={{
                    minWidth: 44,
                    minHeight: 44,
                    borderRadius: 12,
                    backgroundColor: palette().surfaceRaised,
                    alignItems: 'center',
                    justifyContent: 'center',
                    paddingHorizontal: 10,
                  }}
                >
                  <Text style={{ fontSize: 13, color: palette().ink2 }}>更多</Text>
                </View>
              </View>
              <If when={showMoreApproval()}>
                <View
                  role="button"
                  accessibilityLabel="Allow for session"
                  onPress={() => resolveApproval('已允许本会话')}
                  style={{
                    minHeight: 40,
                    borderRadius: 10,
                    backgroundColor: palette().surfaceRaised,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 13, color: palette().ink }}>本会话始终允许</Text>
                </View>
              </If>
            </View>
          </If>

          {/* Morphs into 1-line resolved record */}
          <If when={approval() !== null && !!approval()?.resolved}>
            <View style={{ paddingHorizontal: 16, paddingBottom: 6 }}>
              <Text style={{ fontSize: 12, color: palette().ink3 }}>
                ✓ {approval()?.resolved} · {approval()?.command}
              </Text>
            </View>
          </If>

          {/* Optional AskUserQuestion thumb surface */}
          <If when={question() !== null && !question()?.answered}>
            <View
              style={{
                marginHorizontal: 12,
                marginBottom: 8,
                padding: 14,
                borderRadius: 18,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
                gap: 8,
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
                {question()?.prompt ?? ''}
              </Text>
              <Each of={question()?.options ?? []} key={(o) => o.id}>
                {(opt) => (
                  <View
                    role="button"
                    accessibilityLabel={opt().label}
                    onPress={() => {
                      const q = question();
                      if (q) question.set({ ...q, selected: opt().id, answered: opt().label });
                    }}
                    style={{
                      minHeight: 44,
                      paddingHorizontal: 12,
                      borderRadius: 12,
                      backgroundColor: palette().surfaceRaised,
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 14, color: palette().ink }}>{opt().label}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>

          {/* Quoted diff line banner */}
          <If when={quotedLine() !== null}>
            <View
              style={{
                marginHorizontal: 16,
                marginBottom: 6,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 10,
                backgroundColor: palette().surfaceRaised,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ flex: 1, fontSize: 12, color: palette().ink2 }}>
                引用: {quotedLine()}
              </Text>
              <View
                role="button"
                accessibilityLabel="Clear quote"
                onPress={() => quotedLine.set(null)}
              >
                <Text style={{ fontSize: 13, color: palette().ink3, paddingLeft: 8 }}>✕</Text>
              </View>
            </View>
          </If>

          {/* Lean single-row Composer */}
          <View
            style={{
              paddingHorizontal: 12,
              paddingTop: 8,
              paddingBottom: bottomPad(),
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <Input
                value={composerDraft()}
                placeholder="给 Maka 发消息…"
                onChange={({ value }) => composerDraft.set(value)}
                style={{
                  minHeight: 44,
                  borderRadius: 22,
                  paddingHorizontal: 14,
                  backgroundColor: palette().surface,
                  color: palette().ink,
                  fontSize: 16,
                }}
              />
            </View>
            <View
              role="button"
              accessibilityLabel="Send message"
              onPress={sendMessage}
              style={{
                minWidth: 44,
                minHeight: 44,
                borderRadius: 22,
                backgroundColor: composerDraft().trim()
                  ? palette().accent
                  : palette().surfaceRaised,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: '700',
                  color: composerDraft().trim() ? palette().accentText : palette().ink3,
                }}
              >
                ↑
              </Text>
            </View>
          </View>
        </View>
      </If>

      {/* ---------------- PAIRING (Minimal 6-digit SAS) ---------------- */}
      <If when={route() === 'pairing'}>
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <View
              role="button"
              accessibilityLabel="Close pairing"
              onPress={() => route.set('home')}
              style={{
                minWidth: 44,
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 6,
              }}
            >
              <Text style={{ fontSize: 16, color: palette().accent }}>取消</Text>
            </View>
            <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>连接电脑</Text>
            <View
              role="button"
              accessibilityLabel="Toggle technical pairing info"
              onPress={() => showTechDetails.set(!showTechDetails())}
              style={{
                minWidth: 44,
                minHeight: 44,
                justifyContent: 'center',
                alignItems: 'flex-end',
                paddingHorizontal: 6,
              }}
            >
              <Text style={{ fontSize: 15, color: palette().ink2 }}>ⓘ</Text>
            </View>
          </View>

          <Scroll style={{ flex: 1 }} contentStyle={{ padding: 20, gap: 16 }}>
            <Text style={{ fontSize: 14, color: palette().ink2 }}>
              粘贴桌面端生成的 maka://pair/v1 配对链接（或扫描二维码后自动填入）。
            </Text>

            <Input
              value={ticketUri()}
              placeholder="maka://pair/v1?payload=..."
              onChange={({ value }) => ticketUri.set(value)}
              style={{
                minHeight: 46,
                borderRadius: 12,
                paddingHorizontal: 12,
                backgroundColor: palette().surface,
                color: palette().ink,
                fontSize: 14,
              }}
            />

            <View
              role="button"
              accessibilityLabel="Verify pairing ticket"
              onPress={() => runParseTicket()}
              style={{
                minHeight: 46,
                borderRadius: 14,
                backgroundColor: palette().surfaceRaised,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
                解析并计算 6 位核对码
              </Text>
            </View>

            <If when={pairingError() !== null}>
              <View
                style={{
                  padding: 12,
                  borderRadius: 12,
                  backgroundColor: palette().dangerSoft,
                }}
              >
                <Text style={{ fontSize: 13, color: palette().danger }}>{pairingError()}</Text>
              </View>
            </If>

            <If when={parsedTicket() !== null}>
              <View
                style={{
                  padding: 20,
                  borderRadius: 20,
                  backgroundColor: palette().surface,
                  borderWidth: 1,
                  borderColor: palette().line,
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <Text style={{ fontSize: 14, color: palette().ink2 }}>
                  核对桌面端 {parsedTicket()?.hostName ?? ''} 上的 6 位数字
                </Text>
                <Text
                  style={{
                    fontSize: 36,
                    fontWeight: '700',
                    letterSpacing: 4,
                    color: palette().ink,
                  }}
                >
                  {formatSas(parsedTicket()?.sasCode ?? '')}
                </Text>

                <If when={showTechDetails()}>
                  <View
                    style={{
                      width: '100%',
                      gap: 4,
                      paddingTop: 8,
                      borderTopWidth: 1,
                      borderTopColor: palette().line,
                    }}
                  >
                    <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                      Root: {parsedTicket()?.rootId ?? ''}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                      Peer: {parsedTicket()?.peerId ?? ''}
                    </Text>
                    <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                      Endpoint: {(parsedTicket()?.endpoints ?? []).join(', ')}
                    </Text>
                  </View>
                </If>

                <View
                  role="button"
                  accessibilityLabel="Confirm pairing and connect"
                  onPress={runPairConfirm}
                  style={{
                    width: '100%',
                    minHeight: 48,
                    borderRadius: 14,
                    backgroundColor: palette().accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: 6,
                  }}
                >
                  <Text style={{ fontSize: 16, fontWeight: '600', color: palette().accentText }}>
                    {busy() ? '正在验证并连接…' : '数字一致，连接这台电脑'}
                  </Text>
                </View>
              </View>
            </If>
          </Scroll>
        </View>
      </If>

      {/* ---------------- ARTIFACT VIEWER (Readonly Diff) ---------------- */}
      <If when={route() === 'artifact'}>
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: palette().line,
            }}
          >
            <View
              role="button"
              accessibilityLabel="Close artifact viewer"
              onPress={() => route.set('chat')}
              style={{
                minWidth: 44,
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 6,
              }}
            >
              <Text style={{ fontSize: 16, color: palette().accent }}>完成</Text>
            </View>
            <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>client.rs</Text>
            <View style={{ minWidth: 44 }} />
          </View>

          <Scroll style={{ flex: 1 }} contentStyle={{ padding: 14, gap: 4 }}>
            <Text style={{ fontSize: 12, color: palette().ink3, marginBottom: 8 }}>
              轻点任意一行可引用发给 Maka
            </Text>
            <Each of={DIFF_LINES} key={(l) => l.num}>
              {(line) => (
                <View
                  role="button"
                  accessibilityLabel={'Quote diff line ' + line().num}
                  onPress={() => {
                    quotedLine.set('client.rs:' + line().num + ' ' + line().text.trim());
                    route.set('chat');
                  }}
                  style={{
                    flexDirection: 'row',
                    gap: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 8,
                    backgroundColor:
                      line().kind === 'add'
                        ? palette().diffAddBg
                        : line().kind === 'del'
                          ? palette().diffDelBg
                          : 'transparent',
                  }}
                >
                  <Text style={{ width: 32, fontSize: 12, color: palette().ink3 }}>
                    {line().num}
                  </Text>
                  <Text
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color:
                        line().kind === 'add'
                          ? palette().diffAddInk
                          : line().kind === 'del'
                            ? palette().diffDelInk
                            : palette().ink,
                    }}
                  >
                    {line().text}
                  </Text>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </If>

      {/* ---------------- SETTINGS ---------------- */}
      <If when={route() === 'settings'}>
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: palette().line,
            }}
          >
            <View
              role="button"
              accessibilityLabel="Back from settings"
              onPress={() => route.set('home')}
              style={{
                minWidth: 44,
                minHeight: 44,
                justifyContent: 'center',
                paddingHorizontal: 6,
              }}
            >
              <Text style={{ fontSize: 16, color: palette().accent }}>‹ 返回</Text>
            </View>
            <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>设置</Text>
            <View style={{ minWidth: 44 }} />
          </View>

          <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 16 }}>
            {/* Appearance */}
            <View
              style={{
                borderRadius: 16,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
                padding: 14,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ fontSize: 15, color: palette().ink }}>外观主题</Text>
              <View
                role="button"
                accessibilityLabel="Toggle theme"
                onPress={toggleThemeMode}
                style={{
                  minHeight: 36,
                  paddingHorizontal: 12,
                  borderRadius: 10,
                  backgroundColor: palette().surfaceRaised,
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 14, color: palette().accent }}>
                  {themeMode() === 'dark' ? '深石墨暗色' : '暖纸白亮色'}
                </Text>
              </View>
            </View>

            {/* Automations (moved cleanly into Settings) */}
            <View
              style={{
                borderRadius: 16,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
                padding: 14,
                gap: 12,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: palette().ink3 }}>
                自动化开关
              </Text>
              <View
                role="button"
                accessibilityLabel="Toggle daily summary"
                onPress={() => autoDailySummary.set(!autoDailySummary())}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  minHeight: 38,
                }}
              >
                <Text style={{ fontSize: 15, color: palette().ink }}>每日变更摘要</Text>
                <Text
                  style={{
                    fontSize: 14,
                    color: autoDailySummary() ? palette().ok : palette().ink3,
                  }}
                >
                  {autoDailySummary() ? '开启' : '关闭'}
                </Text>
              </View>
              <View
                role="button"
                accessibilityLabel="Toggle auto reconnect"
                onPress={() => autoReconnect.set(!autoReconnect())}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  minHeight: 38,
                }}
              >
                <Text style={{ fontSize: 15, color: palette().ink }}>切网自动重连</Text>
                <Text
                  style={{ fontSize: 14, color: autoReconnect() ? palette().ok : palette().ink3 }}
                >
                  {autoReconnect() ? '开启' : '关闭'}
                </Text>
              </View>
            </View>

            {/* Saved Hosts management */}
            <View
              style={{
                borderRadius: 16,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
                padding: 14,
                gap: 10,
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: palette().ink3 }}>
                已配对电脑
              </Text>
              <If when={hostState().active !== null}>
                <View
                  role="button"
                  accessibilityLabel="Disconnect active host"
                  onPress={() =>
                    disconnectHost().then(
                      (s) => {
                        hostState.set(s);
                        statusBanner.set(null);
                      },
                      (err: Error) => statusBanner.set(err.message),
                    )
                  }
                  style={{
                    minHeight: 42,
                    borderRadius: 10,
                    backgroundColor: palette().warnSoft,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '600', color: palette().warn }}>
                    断开当前连接 ({hostState().active?.hostName ?? ''})
                  </Text>
                </View>
              </If>
              <Each of={hostState().hosts} key={(h) => h.rootId}>
                {(item) => (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      minHeight: 44,
                    }}
                  >
                    <Text style={{ fontSize: 15, color: palette().ink }}>{item().hostName}</Text>
                    <View
                      role="button"
                      accessibilityLabel={'Remove ' + item().hostName}
                      onPress={() =>
                        removeHost(item().rootId).then(
                          (s) => {
                            hostState.set(s);
                            statusBanner.set(null);
                          },
                          (err: Error) => statusBanner.set(err.message),
                        )
                      }
                      style={{ paddingHorizontal: 10, paddingVertical: 6 }}
                    >
                      <Text style={{ fontSize: 13, color: palette().danger }}>移除</Text>
                    </View>
                  </View>
                )}
              </Each>
            </View>
          </Scroll>
        </View>
      </If>
    </View>
  );
}

mount(App);
