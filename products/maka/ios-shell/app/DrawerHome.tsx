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

import { Scroll, signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import {
  hasAgentEndpoint,
  type AgentProject,
  type AgentSession,
  type HostStateSnapshot,
  type SavedHostItem,
} from './bridge';
import { palette } from './theme';

export interface DrawerHomeProps {
  hostState: () => HostStateSnapshot;
  projects: () => AgentProject[];
  sessions: () => AgentSession[];
  activeSessionId: () => string | null;
  pendingCount: () => number;
  statusBanner: () => string | null;
  bottomPad: () => number;
  onSelectSession: (session: AgentSession) => void;
  onOpenBot: () => void;
  onOpenActiveWorkspace: () => void;
  onConnectHost: (host: SavedHostItem) => void;
  onSwitchFilter: () => void;
  onOpenPairing: () => void;
  onOpenNewSession: () => void;
  onOpenAutomations: () => void;
  onOpenSettings: () => void;
  onCloseDrawer?: () => void;
}

function statusDotColor(activity: AgentSession['activity']): string {
  if (activity === 'waiting') return palette().waiting;
  if (activity === 'working') return palette().working;
  return palette().ink3;
}

export function DrawerHome(props: DrawerHomeProps) {
  const searchQuery = signal('');
  const collapsedProjects = signal<Record<string, boolean>>({});
  const collapsedParents = signal<Record<string, boolean>>({});
  const offlineExpanded = signal(true);

  const filteredSessions = (): AgentSession[] => {
    const q = searchQuery().trim().toLowerCase();
    const all = props.sessions();
    if (!q) return all;
    return all.filter((s) => s.title.toLowerCase().includes(q));
  };

  const rootSessions = (): AgentSession[] => filteredSessions().filter((s) => !s.parentSessionId);

  const childrenOf = (parentId: string): AgentSession[] =>
    filteredSessions().filter((s) => s.parentSessionId === parentId);

  const projectGroups = (): { key: string; name: string; sessions: AgentSession[] }[] => {
    const roots = rootSessions();
    const projMap = new Map<string, string>();
    for (const p of props.projects()) {
      projMap.set(p.reference.id, p.name);
      if (p.path) projMap.set(p.path, p.name);
    }
    const groups = new Map<string, { key: string; name: string; sessions: AgentSession[] }>();
    for (const s of roots) {
      const key = s.workspace?.projectId ?? s.workspace?.path ?? '__default__';
      const name =
        projMap.get(key) ??
        s.workspace?.name ??
        (s.workspace?.path
          ? (s.workspace.path.split('/').filter(Boolean).pop() ?? '工作区')
          : '默认工作区');
      const existing = groups.get(key);
      if (existing) {
        existing.sessions.push(s);
      } else {
        groups.set(key, { key, name, sessions: [s] });
      }
    }
    return Array.from(groups.values());
  };

  const visibleHosts = (): SavedHostItem[] => {
    const hs = props.hostState();
    if (hs.filter.kind === 'single_computer') {
      const targetId = hs.filter.root_id;
      return hs.hosts.filter((h) => h.rootId === targetId);
    }
    return hs.hosts;
  };

  const onlineHosts = (): SavedHostItem[] => visibleHosts().filter((h) => h.connected);
  const offlineHosts = (): SavedHostItem[] => visibleHosts().filter((h) => !h.connected);

  const activeHostLabel = (): string => {
    const active = props.hostState().active;
    if (active) return active.hostName + ' · 在线';
    const total = props.hostState().hosts.length;
    return total > 0 ? String(total) + ' 台已配对电脑' : '未连接电脑';
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette().drawerBg }}>
      {/* Top Bar */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 18,
          paddingTop: 10,
          paddingBottom: 8,
        }}
      >
        <Text style={{ fontSize: 26, fontWeight: '700', color: palette().ink }}>Maka</Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <If when={hasAgentEndpoint(props.hostState().active)}>
            <View
              role="button"
              accessibilityLabel="New session"
              onPress={props.onOpenNewSession}
              style={{
                minWidth: 36,
                minHeight: 36,
                paddingHorizontal: 10,
                borderRadius: 18,
                backgroundColor: palette().rowHover,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>＋</Text>
            </View>
          </If>

          <View
            role="button"
            accessibilityLabel="Automations"
            onPress={props.onOpenAutomations}
            style={{
              minWidth: 36,
              minHeight: 36,
              paddingHorizontal: 10,
              borderRadius: 18,
              backgroundColor: palette().rowHover,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 13, color: palette().ink2 }}>定时</Text>
          </View>

          <View
            role="button"
            accessibilityLabel="Settings"
            onPress={props.onOpenSettings}
            style={{
              minWidth: 36,
              minHeight: 36,
              paddingHorizontal: 10,
              borderRadius: 18,
              backgroundColor: palette().rowHover,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 13, color: palette().ink2 }}>设置</Text>
          </View>
        </View>
      </View>

      {/* Search Bar */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
        <Input
          accessibilityLabel="Search sessions"
          value={searchQuery()}
          onChange={({ value }: { value: string }) => searchQuery.set(value)}
          placeholder="搜索会话或项目"
          style={{
            minHeight: 40,
            borderRadius: 12,
            backgroundColor: palette().surface,
            borderWidth: 1,
            borderColor: palette().line,
            paddingHorizontal: 14,
            color: palette().ink,
            fontSize: 14.5,
          }}
        />
      </View>

      <If when={props.statusBanner() !== null}>
        <View
          style={{
            marginHorizontal: 16,
            marginBottom: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 11,
            backgroundColor: palette().accentSoft,
          }}
        >
          <Text style={{ fontSize: 12.5, color: palette().ink }}>{props.statusBanner()}</Text>
        </View>
      </If>

      {/* Borderless Spatial Tree */}
      <Scroll
        style={{ flex: 1 }}
        contentStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 4 }}
      >
        {/* Conditional Pending Attention Indicator (0px when empty or cold-start) */}
        <If when={props.hostState().hosts.length > 0 && props.pendingCount() > 0}>
          <View
            role="button"
            accessibilityLabel="Open pending approval"
            onPress={props.onOpenActiveWorkspace}
            style={{
              marginHorizontal: 4,
              marginBottom: 6,
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderRadius: 13,
              backgroundColor: palette().rowActive,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: palette().waiting,
                }}
              />
              <Text style={{ fontSize: 13.5, fontWeight: '600', color: palette().ink }}>
                {'待你确认 · ' + String(props.pendingCount()) + ' 项'}
              </Text>
            </View>
            <Text style={{ fontSize: 12.5, color: palette().ink2 }}>查看 ›</Text>
          </View>
        </If>

        {/* Single-Row Maka Bot (borderless spatial row) */}
        <View
          role="button"
          accessibilityLabel="Open Maka Bot"
          onPress={props.onOpenBot}
          style={{
            minHeight: 44,
            paddingHorizontal: 10,
            paddingVertical: 9,
            borderRadius: 11,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                backgroundColor: palette().primaryBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 13.5, fontWeight: '700', color: palette().primaryText }}>
                M
              </Text>
            </View>
            <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>Maka Bot</Text>
          </View>
          <Text style={{ fontSize: 12, color: palette().ink3 }}>全局助手 ›</Text>
        </View>

        {/* Empty Cold-Start Onboarding */}
        <If when={props.hostState().hosts.length === 0}>
          <View
            style={{
              marginTop: 12,
              marginHorizontal: 4,
              padding: 18,
              borderRadius: 18,
              backgroundColor: palette().surface,
              borderWidth: 1,
              borderColor: palette().line,
              gap: 10,
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: palette().ink }}>
              连接你的第一台电脑
            </Text>
            <Text style={{ fontSize: 13, lineHeight: 19, color: palette().ink2 }}>
              扫描桌面端 Maka 配对码，或粘贴 maka://pair/v1 链接，核对 6 位数字后即刻接管所有会话。
            </Text>
            <View
              role="button"
              accessibilityLabel="Start pairing"
              onPress={props.onOpenPairing}
              style={{
                marginTop: 4,
                minHeight: 42,
                borderRadius: 21,
                backgroundColor: palette().primaryBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 14.5, fontWeight: '600', color: palette().primaryText }}>
                配对远端电脑
              </Text>
            </View>
          </View>
        </If>

        {/* Online Host Spatial Tree */}
        <Each of={onlineHosts()} key={(h) => h.rootId}>
          {(hostItem) => (
            <View style={{ marginTop: 10, gap: 2 }}>
              {/* Host Section Header (borderless) */}
              <View
                role="button"
                accessibilityLabel={'Host ' + hostItem().hostName}
                onPress={props.onOpenActiveWorkspace}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: palette().online,
                    }}
                  />
                  <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink2 }}>
                    {hostItem().hostName}
                  </Text>
                </View>
                <Text style={{ fontSize: 11.5, color: palette().online }}>在线</Text>
              </View>

              {/* Real Agent Projects & Sessions Tree */}
              <If when={hasAgentEndpoint(props.hostState().active)}>
                <View style={{ gap: 4 }}>
                  <If when={projectGroups().length === 0}>
                    <View
                      role="button"
                      accessibilityLabel="Create first session"
                      onPress={props.onOpenNewSession}
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: 10,
                        backgroundColor: palette().rowHover,
                      }}
                    >
                      <Text style={{ fontSize: 13, color: palette().ink2 }}>
                        暂无会话 · 点击新建对话
                      </Text>
                    </View>
                  </If>

                  <Each of={projectGroups()} key={(g) => g.key}>
                    {(group) => (
                      <View style={{ gap: 2 }}>
                        <View
                          role="button"
                          accessibilityLabel={'Project ' + group().name}
                          onPress={() => {
                            const cur = collapsedProjects();
                            collapsedProjects.set({
                              ...cur,
                              [group().key]: !cur[group().key],
                            });
                          }}
                          style={{
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <Text style={{ fontSize: 11, color: palette().ink3 }}>
                            {collapsedProjects()[group().key] ? '▸' : '▾'}
                          </Text>
                          <Text style={{ fontSize: 13, fontWeight: '600', color: palette().ink2 }}>
                            {group().name}
                          </Text>
                        </View>

                        <If when={!collapsedProjects()[group().key]}>
                          <View
                            style={{
                              marginLeft: 14,
                              paddingLeft: 10,
                              borderLeftWidth: 1,
                              borderLeftColor: palette().guideLine,
                              gap: 2,
                            }}
                          >
                            <Each of={group().sessions} key={(s) => s.id}>
                              {(sess) => (
                                <View style={{ gap: 2 }}>
                                  <View
                                    role="button"
                                    accessibilityLabel={'Session ' + sess().title}
                                    onPress={() => props.onSelectSession(sess())}
                                    style={{
                                      minHeight: 40,
                                      paddingHorizontal: 10,
                                      paddingVertical: 8,
                                      borderRadius: 10,
                                      backgroundColor:
                                        props.activeSessionId() === sess().id
                                          ? palette().rowActive
                                          : 'transparent',
                                      flexDirection: 'row',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      gap: 8,
                                    }}
                                  >
                                    <View
                                      style={{
                                        flex: 1,
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: 8,
                                      }}
                                    >
                                      <If when={sess().kind === 'room'}>
                                        <Text
                                          style={{
                                            fontSize: 12,
                                            fontWeight: '700',
                                            color: palette().ink2,
                                          }}
                                        >
                                          #
                                        </Text>
                                      </If>
                                      <If when={sess().kind !== 'room'}>
                                        <View
                                          style={{
                                            width: 6,
                                            height: 6,
                                            borderRadius: 3,
                                            backgroundColor: statusDotColor(sess().activity),
                                          }}
                                        />
                                      </If>
                                      <Text
                                        style={{
                                          flex: 1,
                                          fontSize: 14.5,
                                          fontWeight:
                                            props.activeSessionId() === sess().id ? '600' : '400',
                                          color: palette().ink,
                                        }}
                                      >
                                        {sess().title}
                                      </Text>
                                    </View>

                                    <If when={childrenOf(sess().id).length > 0}>
                                      <View
                                        role="button"
                                        accessibilityLabel={'Toggle children ' + sess().id}
                                        onPress={() => {
                                          const cur = collapsedParents();
                                          collapsedParents.set({
                                            ...cur,
                                            [sess().id]: !cur[sess().id],
                                          });
                                        }}
                                        style={{ paddingHorizontal: 6, paddingVertical: 2 }}
                                      >
                                        <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                                          {String(childrenOf(sess().id).length) +
                                            (collapsedParents()[sess().id] ? ' ▸' : ' ▾')}
                                        </Text>
                                      </View>
                                    </If>
                                  </View>

                                  {/* Indented sub-sessions */}
                                  <If
                                    when={
                                      childrenOf(sess().id).length > 0 &&
                                      !collapsedParents()[sess().id]
                                    }
                                  >
                                    <View
                                      style={{
                                        marginLeft: 12,
                                        paddingLeft: 10,
                                        borderLeftWidth: 1,
                                        borderLeftColor: palette().guideLine,
                                        gap: 2,
                                      }}
                                    >
                                      <Each of={childrenOf(sess().id)} key={(c) => c.id}>
                                        {(child) => (
                                          <View
                                            role="button"
                                            accessibilityLabel={'Session ' + child().title}
                                            onPress={() => props.onSelectSession(child())}
                                            style={{
                                              minHeight: 36,
                                              paddingHorizontal: 10,
                                              paddingVertical: 6,
                                              borderRadius: 9,
                                              backgroundColor:
                                                props.activeSessionId() === child().id
                                                  ? palette().rowActive
                                                  : 'transparent',
                                              flexDirection: 'row',
                                              alignItems: 'center',
                                              gap: 7,
                                            }}
                                          >
                                            <View
                                              style={{
                                                width: 5,
                                                height: 5,
                                                borderRadius: 3,
                                                backgroundColor: statusDotColor(child().activity),
                                              }}
                                            />
                                            <Text
                                              style={{
                                                flex: 1,
                                                fontSize: 13.5,
                                                color: palette().ink2,
                                              }}
                                            >
                                              {child().title}
                                            </Text>
                                          </View>
                                        )}
                                      </Each>
                                    </View>
                                  </If>
                                </View>
                              )}
                            </Each>
                          </View>
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              </If>

              {/* Non-Agent Host fallback row (e.g. minimal hostLogs-only Host) */}
              <If when={!hasAgentEndpoint(props.hostState().active)}>
                <View
                  role="button"
                  accessibilityLabel={'Open workspace ' + hostItem().hostName}
                  onPress={props.onOpenActiveWorkspace}
                  style={{
                    marginLeft: 14,
                    paddingLeft: 10,
                    paddingVertical: 8,
                    borderLeftWidth: 1,
                    borderLeftColor: palette().guideLine,
                  }}
                >
                  <Text style={{ fontSize: 14, color: palette().ink }}>
                    已连接 · 点击进入工作区 ›
                  </Text>
                </View>
              </If>
            </View>
          )}
        </Each>

        {/* Collapsible Offline / Saved Hosts */}
        <If when={offlineHosts().length > 0}>
          <View style={{ marginTop: 12, gap: 2 }}>
            <View
              role="button"
              accessibilityLabel="Toggle offline hosts"
              onPress={() => offlineExpanded.set(!offlineExpanded())}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Text style={{ fontSize: 11, color: palette().ink3 }}>
                {offlineExpanded() ? '▾' : '▸'}
              </Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: palette().ink3 }}>
                {'已保存电脑 (' + String(offlineHosts().length) + ')'}
              </Text>
            </View>

            <If when={offlineExpanded()}>
              <Each of={offlineHosts()} key={(h) => h.rootId}>
                {(item) => (
                  <View
                    role="button"
                    accessibilityLabel={'Host ' + item().hostName}
                    onPress={() => props.onConnectHost(item())}
                    style={{
                      minHeight: 44,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 11,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          backgroundColor: palette().offline,
                        }}
                      />
                      <View style={{ gap: 1 }}>
                        <Text style={{ fontSize: 14.5, fontWeight: '500', color: palette().ink }}>
                          {item().hostName}
                        </Text>
                        <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                          已保存 · 点击连接
                        </Text>
                      </View>
                    </View>
                    <Text style={{ fontSize: 13, color: palette().ink3 }}>›</Text>
                  </View>
                )}
              </Each>
            </If>
          </View>
        </If>
      </Scroll>

      {/* Bottom Thumb-Zone Liquid Glass Host Switcher + Pair CTA */}
      <View
        style={{
          paddingHorizontal: 14,
          paddingTop: 10,
          paddingBottom: props.bottomPad(),
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <View
          role="button"
          accessibilityLabel="Switch host filter"
          onPress={props.onSwitchFilter}
          style={{
            flex: 1,
            minHeight: 44,
            paddingHorizontal: 14,
            borderRadius: 22,
            backgroundColor: palette().glassBg,
            borderWidth: 1,
            borderColor: palette().glassBorder,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ fontSize: 13.5, fontWeight: '600', color: palette().ink }}>
            {activeHostLabel()}
          </Text>
          <Text style={{ fontSize: 12, color: palette().ink2 }}>
            {props.hostState().filter.kind === 'all_computers' ? '全部' : '单台'}
          </Text>
        </View>

        <View
          role="button"
          accessibilityLabel="Pair new computer"
          onPress={props.onOpenPairing}
          style={{
            minWidth: 44,
            minHeight: 44,
            borderRadius: 22,
            backgroundColor: palette().primaryBg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 19, fontWeight: '600', color: palette().primaryText }}>＋</Text>
        </View>
      </View>
    </View>
  );
}
