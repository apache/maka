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
  type AgentWorkspaceSelection,
  type HostStateSnapshot,
  type SavedHostItem,
} from './bridge';
import { palette } from './theme';

export type CatalogFilterMode = 'all' | 'needs_you' | 'archived';

export interface ProjectGroupItem {
  key: string;
  name: string;
  projectId: string | null;
  path: string | null;
  sessions: AgentSession[];
}

export interface DrawerHomeProps {
  hostState: () => HostStateSnapshot;
  projects: () => AgentProject[];
  sessions: () => AgentSession[];
  catalogFilter: () => CatalogFilterMode;
  catalogQuery: () => string;
  needsYouCount: () => number;
  hasMoreSessions: () => boolean;
  activeSessionId: () => string | null;
  pendingCount: () => number;
  statusBanner: () => string | null;
  bottomPad: () => number;
  onSelectSession: (session: AgentSession) => void;
  onStartDraft: (workspace?: { selection: AgentWorkspaceSelection; label: string }) => void;
  onOpenNewRoom: () => void;
  onCatalogFilterChange: (filter: CatalogFilterMode) => void;
  onCatalogQueryChange: (query: string) => void;
  onLoadMoreSessions: () => void;
  onRenameSession: (session: AgentSession, nextTitle: string) => void;
  onTogglePinSession: (session: AgentSession) => void;
  onChangeSessionLifecycle: (
    session: AgentSession,
    action: 'archive' | 'restore' | 'remove',
  ) => void;
  onOpenBot: () => void;
  onOpenActiveWorkspace: () => void;
  onConnectHost: (host: SavedHostItem) => void;
  onSwitchFilter: () => void;
  onOpenPairing: () => void;
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
  const collapsedProjects = signal<Record<string, boolean>>({});
  const collapsedParents = signal<Record<string, boolean>>({});
  const offlineExpanded = signal(true);
  const actionMenuSessionId = signal<string | null>(null);
  const renamingSessionId = signal<string | null>(null);
  const renameDraft = signal('');
  const confirmDeleteSessionId = signal<string | null>(null);

  const visibleSessions = (): AgentSession[] => props.sessions();

  const loadedIds = (): Set<string> => new Set(visibleSessions().map((s) => s.id));

  // Treat sessions whose parent isn't in the loaded page as top-level orphans so no session vanishes.
  const topLevelSessions = (): AgentSession[] => {
    const ids = loadedIds();
    return visibleSessions().filter((s) => !s.parentSessionId || !ids.has(s.parentSessionId));
  };

  const pinnedSessions = (): AgentSession[] =>
    topLevelSessions().filter((s) => s.pinned && !s.archived);

  const unpinnedTopLevel = (): AgentSession[] =>
    topLevelSessions().filter((s) => !(s.pinned && !s.archived));

  const childrenOf = (parentId: string): AgentSession[] =>
    visibleSessions().filter((s) => s.parentSessionId === parentId);

  const projectGroups = (): ProjectGroupItem[] => {
    const roots = unpinnedTopLevel();
    const groups = new Map<string, ProjectGroupItem>();
    const pathToKey = new Map<string, string>();

    // Always include all registered non-archived projects (even with 0 sessions) so
    // users can tap '+' next to any project to start a Draft immediately like Desktop.
    if (props.catalogFilter() === 'all' && props.catalogQuery().trim().length === 0) {
      for (const p of props.projects()) {
        if (p.archived) continue;
        const key = p.reference.id;
        groups.set(key, {
          key,
          name: p.name,
          projectId: p.reference.id,
          path: p.path,
          sessions: [],
        });
        if (p.path) {
          pathToKey.set(p.path, key);
        }
      }
    }

    for (const s of roots) {
      const wsProjectId = s.workspace?.projectId ?? null;
      const wsPath = s.workspace?.path ?? null;
      const existingKey =
        (wsProjectId && groups.has(wsProjectId) ? wsProjectId : null) ??
        (wsPath ? (pathToKey.get(wsPath) ?? null) : null);
      const key = existingKey ?? wsProjectId ?? wsPath ?? '__default__';
      const existing = groups.get(key);
      if (existing) {
        existing.sessions.push(s);
      } else {
        const name =
          s.workspace?.name ??
          (wsPath ? (wsPath.split('/').filter(Boolean).pop() ?? '工作区') : '默认工作区');
        groups.set(key, {
          key,
          name,
          projectId: wsProjectId,
          path: wsPath,
          sessions: [s],
        });
      }
    }
    return Array.from(groups.values());
  };

  const offlineHosts = (): SavedHostItem[] => {
    const { active, filter, hosts } = props.hostState();
    if (!active) return hosts;
    if (filter.kind === 'single_computer') return [];
    return hosts.filter((h) => h.rootId !== active.rootId);
  };

  const canSwitchHostFilter = () => {
    const { active, filter } = props.hostState();
    return active !== null || filter.kind === 'single_computer';
  };

  const activeHostLabel = (): string => {
    const active = props.hostState().active;
    if (active) return active.hostName + ' · 在线';
    const total = props.hostState().hosts.length;
    return total > 0 ? String(total) + ' 台已配对电脑' : '未连接电脑';
  };

  const renderSessionRow = (sess: () => AgentSession, indented = false) => {
    const isMenuOpen = () => actionMenuSessionId() === sess().id;
    const isRenaming = () => renamingSessionId() === sess().id;
    const isConfirmDelete = () => confirmDeleteSessionId() === sess().id;

    return (
      <View style={{ gap: 4 }}>
        <View
          style={{
            minHeight: indented ? 36 : 40,
            paddingLeft: 10,
            paddingRight: 4,
            paddingVertical: indented ? 5 : 6,
            borderRadius: indented ? 9 : 11,
            backgroundColor:
              props.activeSessionId() === sess().id ? palette().rowActive : 'transparent',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <View
            role="button"
            accessibilityLabel={'Session ' + sess().title}
            onPress={() => {
              actionMenuSessionId.set(null);
              renamingSessionId.set(null);
              confirmDeleteSessionId.set(null);
              props.onSelectSession(sess());
            }}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              minHeight: 28,
            }}
          >
            <View
              style={{
                width: indented ? 5 : 6,
                height: indented ? 5 : 6,
                borderRadius: 3,
                backgroundColor: statusDotColor(sess().activity),
              }}
            />
            <Text
              style={{
                flex: 1,
                fontSize: indented ? 13.5 : 14.5,
                fontWeight:
                  props.activeSessionId() === sess().id || sess().hasUnread ? '600' : '400',
                color: indented ? palette().ink2 : palette().ink,
              }}
            >
              {(sess().kind === 'room' ? '# ' : '') + sess().title}
            </Text>
            <If when={sess().hasUnread}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: palette().ink,
                }}
              />
            </If>
          </View>

          <If when={!indented && childrenOf(sess().id).length > 0}>
            <View
              role="button"
              accessibilityLabel={'Toggle sub-sessions ' + sess().id}
              onPress={() => {
                const cur = collapsedParents();
                collapsedParents.set({ ...cur, [sess().id]: !cur[sess().id] });
              }}
              style={{ paddingHorizontal: 5, paddingVertical: 4 }}
            >
              <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                {String(childrenOf(sess().id).length) +
                  (collapsedParents()[sess().id] ? ' ▸' : ' ▾')}
              </Text>
            </View>
          </If>

          <View
            role="button"
            accessibilityLabel={'Session actions ' + sess().title}
            onPress={() => {
              confirmDeleteSessionId.set(null);
              renamingSessionId.set(null);
              actionMenuSessionId.set(isMenuOpen() ? null : sess().id);
            }}
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 13, color: palette().ink3 }}>⋯</Text>
          </View>
        </View>

        <If when={isMenuOpen()}>
          <View
            style={{
              marginLeft: 10,
              marginRight: 4,
              padding: 8,
              borderRadius: 12,
              backgroundColor: palette().surface2,
              borderWidth: 1,
              borderColor: palette().line,
              gap: 8,
            }}
          >
            <If when={isRenaming()}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Input
                  accessibilityLabel="Rename session input"
                  value={renameDraft()}
                  onChange={({ value }: { value: string }) => renameDraft.set(value)}
                  placeholder="输入新标题…"
                  style={{
                    flex: 1,
                    minHeight: 34,
                    borderRadius: 8,
                    backgroundColor: palette().surface,
                    borderWidth: 1,
                    borderColor: palette().line,
                    paddingHorizontal: 8,
                    color: palette().ink,
                    fontSize: 13,
                  }}
                />
                <View
                  role="button"
                  accessibilityLabel="Confirm rename session"
                  onPress={() => {
                    const trimmed = renameDraft().trim();
                    if (trimmed.length > 0) {
                      props.onRenameSession(sess(), trimmed);
                      renamingSessionId.set(null);
                      actionMenuSessionId.set(null);
                    }
                  }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 8,
                    backgroundColor: palette().primaryBg,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '600', color: palette().primaryText }}>
                    保存
                  </Text>
                </View>
              </View>
            </If>

            <If when={isConfirmDelete()}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ flex: 1, fontSize: 12, color: palette().danger }}>
                  确认永久删除此会话？
                </Text>
                <View
                  role="button"
                  accessibilityLabel="Cancel delete session"
                  onPress={() => confirmDeleteSessionId.set(null)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 8,
                    backgroundColor: palette().surface,
                  }}
                >
                  <Text style={{ fontSize: 12, color: palette().ink2 }}>取消</Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel="Confirm delete session"
                  onPress={() => {
                    props.onChangeSessionLifecycle(sess(), 'remove');
                    confirmDeleteSessionId.set(null);
                    actionMenuSessionId.set(null);
                  }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 8,
                    backgroundColor: palette().dangerSoft,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '600', color: palette().danger }}>
                    删除
                  </Text>
                </View>
              </View>
            </If>

            <If when={!isRenaming() && !isConfirmDelete()}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <View
                  role="button"
                  accessibilityLabel={'Rename ' + sess().title}
                  onPress={() => {
                    renameDraft.set(sess().title);
                    renamingSessionId.set(sess().id);
                  }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: palette().surface,
                  }}
                >
                  <Text style={{ fontSize: 12, color: palette().ink }}>重命名</Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel={'Pin ' + sess().title}
                  onPress={() => {
                    props.onTogglePinSession(sess());
                    actionMenuSessionId.set(null);
                  }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: palette().surface,
                  }}
                >
                  <Text style={{ fontSize: 12, color: palette().ink }}>
                    {sess().pinned ? '取消置顶' : '置顶'}
                  </Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel={'Archive ' + sess().title}
                  onPress={() => {
                    props.onChangeSessionLifecycle(sess(), sess().archived ? 'restore' : 'archive');
                    actionMenuSessionId.set(null);
                  }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: palette().surface,
                  }}
                >
                  <Text style={{ fontSize: 12, color: palette().ink }}>
                    {sess().archived ? '恢复' : '归档'}
                  </Text>
                </View>
                <View
                  role="button"
                  accessibilityLabel={'Delete ' + sess().title}
                  onPress={() => confirmDeleteSessionId.set(sess().id)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    backgroundColor: palette().dangerSoft,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '600', color: palette().danger }}>
                    删除
                  </Text>
                </View>
              </View>
            </If>
          </View>
        </If>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: palette().drawerBg }}>
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
        <Text style={{ fontSize: 22, fontWeight: '700', color: palette().ink }}>Maka</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <If when={hasAgentEndpoint(props.hostState().active)}>
            <View
              role="button"
              accessibilityLabel="New draft conversation"
              onPress={() => props.onStartDraft()}
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                backgroundColor: palette().rowHover,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 19, color: palette().ink }}>+</Text>
            </View>
          </If>
          <View
            role="button"
            accessibilityLabel="Add remote Host"
            onPress={props.onOpenPairing}
            style={{
              height: 34,
              paddingHorizontal: 10,
              borderRadius: 17,
              backgroundColor: palette().rowHover,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 12.5, fontWeight: '500', color: palette().ink2 }}>配对</Text>
          </View>
          <View
            role="button"
            accessibilityLabel="Settings"
            onPress={props.onOpenSettings}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: palette().rowHover,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 16, color: palette().ink2 }}>⚙</Text>
          </View>
        </View>
      </View>

      {/* Search + Host-driven Catalog Filter Tabs */}
      <If when={hasAgentEndpoint(props.hostState().active)}>
        <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }}>
          <Input
            accessibilityLabel="Search sessions"
            value={props.catalogQuery()}
            onChange={({ value }: { value: string }) => props.onCatalogQueryChange(value)}
            placeholder="搜索会话标题…"
            style={{
              minHeight: 36,
              borderRadius: 11,
              backgroundColor: palette().surface2,
              paddingHorizontal: 12,
              color: palette().ink,
              fontSize: 14,
            }}
          />

          <View style={{ flexDirection: 'row', gap: 6 }}>
            {(
              [
                { id: 'all', label: '全部' },
                {
                  id: 'needs_you',
                  label:
                    props.needsYouCount() > 0
                      ? '待处理 ' + String(props.needsYouCount())
                      : '待处理',
                },
                { id: 'archived', label: '已归档' },
              ] as const
            ).map((tab) => (
              <View
                role="button"
                accessibilityLabel={'Filter ' + tab.id}
                onPress={() => props.onCatalogFilterChange(tab.id)}
                style={{
                  flex: 1,
                  minHeight: 30,
                  borderRadius: 9,
                  backgroundColor:
                    props.catalogFilter() === tab.id ? palette().rowActive : palette().surface,
                  borderWidth: 1,
                  borderColor:
                    props.catalogFilter() === tab.id ? palette().glassBorder : palette().line,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: props.catalogFilter() === tab.id ? '600' : '400',
                    color: props.catalogFilter() === tab.id ? palette().ink : palette().ink2,
                  }}
                >
                  {tab.label}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </If>

      {/* Main Spatial Tree */}
      <Scroll
        style={{ flex: 1, minHeight: 0 }}
        contentStyle={{ paddingHorizontal: 14, gap: 10, paddingBottom: 16 }}
      >
        <If when={props.statusBanner() !== null}>
          <View
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 11,
              backgroundColor: palette().accentSoft,
            }}
          >
            <Text style={{ fontSize: 12.5, color: palette().ink }}>{props.statusBanner()}</Text>
          </View>
        </If>

        {/* Global Entry Row: Maka Bot */}
        <View
          role="button"
          accessibilityLabel="Open Maka Bot"
          onPress={props.onOpenBot}
          style={{
            minHeight: 48,
            paddingHorizontal: 12,
            paddingVertical: 9,
            borderRadius: 13,
            backgroundColor: palette().surface,
            borderWidth: 1,
            borderColor: palette().line,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 11,
          }}
        >
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              backgroundColor: palette().primaryBg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: palette().primaryText }}>M</Text>
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>Maka Bot</Text>
            <Text style={{ fontSize: 12, color: palette().ink2 }}>
              {props.hostState().active ? '随时调度所有远端工作区' : '连接电脑后同步跨设备对话'}
            </Text>
          </View>
          <If when={props.needsYouCount() > 0 || props.pendingCount() > 0}>
            <View
              style={{
                minWidth: 20,
                height: 20,
                paddingHorizontal: 6,
                borderRadius: 10,
                backgroundColor: palette().waiting,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '700', color: '#FFFFFF' }}>
                {String(Math.max(props.needsYouCount(), props.pendingCount()))}
              </Text>
            </View>
          </If>
        </View>

        {/* Cold-start Onboarding when 0 hosts paired */}
        <If when={props.hostState().hosts.length === 0}>
          <View
            style={{
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
            <Text style={{ fontSize: 13.5, lineHeight: 20, color: palette().ink2 }}>
              扫描桌面端 Maka 配对二维码，或粘贴 maka://pair/v1 链接，直连你的项目与 Agent 会话。
            </Text>
            <View
              role="button"
              accessibilityLabel="Pair first computer"
              onPress={props.onOpenPairing}
              style={{
                minHeight: 44,
                borderRadius: 22,
                backgroundColor: palette().primaryBg,
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: 4,
              }}
            >
              <Text style={{ fontSize: 14.5, fontWeight: '600', color: palette().primaryText }}>
                扫码或粘贴配对码
              </Text>
            </View>
          </View>
        </If>

        <If when={props.hostState().active}>
          {(hostItem) => (
            <View style={{ gap: 6 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  paddingHorizontal: 6,
                  paddingTop: 4,
                }}
              >
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: palette().online,
                  }}
                />
                <Text
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    fontWeight: '600',
                    color: palette().ink2,
                  }}
                >
                  {hostItem().hostName}
                </Text>
                <If when={hasAgentEndpoint(hostItem())}>
                  <View
                    role="button"
                    accessibilityLabel="Create new room"
                    onPress={props.onOpenNewRoom}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 8,
                      backgroundColor: palette().rowHover,
                    }}
                  >
                    <Text style={{ fontSize: 11.5, color: palette().ink2 }}>+ Room</Text>
                  </View>
                </If>
              </View>

              <If when={hasAgentEndpoint(hostItem())}>
                <View style={{ gap: 8 }}>
                  {/* Pinned Section */}
                  <If when={pinnedSessions().length > 0}>
                    <View style={{ gap: 3 }}>
                      <Text
                        style={{
                          fontSize: 11.5,
                          fontWeight: '600',
                          color: palette().ink3,
                          paddingHorizontal: 8,
                        }}
                      >
                        置顶
                      </Text>
                      <Each of={pinnedSessions()} key={(s) => s.id}>
                        {(sess) => renderSessionRow(sess)}
                      </Each>
                    </View>
                  </If>

                  {/* Project Groups with Desktop-style trailing '+' */}
                  <Each of={projectGroups()} key={(g) => g.key}>
                    {(group) => (
                      <View style={{ gap: 3 }}>
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            paddingLeft: 8,
                            paddingRight: 4,
                            paddingVertical: 4,
                            gap: 6,
                          }}
                        >
                          <View
                            role="button"
                            accessibilityLabel={'Toggle project ' + group().name}
                            onPress={() => {
                              const cur = collapsedProjects();
                              collapsedProjects.set({
                                ...cur,
                                [group().key]: !cur[group().key],
                              });
                            }}
                            style={{
                              flex: 1,
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <Text style={{ fontSize: 11, color: palette().ink3 }}>
                              {collapsedProjects()[group().key] ? '▸' : '▾'}
                            </Text>
                            <Text
                              style={{
                                flex: 1,
                                fontSize: 12.5,
                                fontWeight: '600',
                                color: palette().ink2,
                              }}
                            >
                              {group().name}
                            </Text>
                            <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                              {String(group().sessions.length)}
                            </Text>
                          </View>

                          <View
                            role="button"
                            accessibilityLabel={'New draft in ' + group().name}
                            onPress={() => {
                              const g = group();
                              if (g.projectId && g.path) {
                                props.onStartDraft({
                                  selection: {
                                    kind: 'project',
                                    projectId: g.projectId,
                                    path: g.path,
                                  },
                                  label: g.name,
                                });
                              } else if (g.path) {
                                props.onStartDraft({
                                  selection: { kind: 'directory', path: g.path },
                                  label: g.name,
                                });
                              } else if (g.sessions[0]) {
                                props.onStartDraft({
                                  selection: { kind: 'session', sessionId: g.sessions[0].id },
                                  label: g.name,
                                });
                              } else {
                                props.onStartDraft();
                              }
                            }}
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: 8,
                              backgroundColor: palette().rowHover,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Text style={{ fontSize: 16, color: palette().ink2 }}>+</Text>
                          </View>
                        </View>

                        <If when={!collapsedProjects()[group().key]}>
                          <View
                            style={{
                              marginLeft: 12,
                              paddingLeft: 10,
                              borderLeftWidth: 1,
                              borderLeftColor: palette().guideLine,
                              gap: 2,
                            }}
                          >
                            <If when={group().sessions.length === 0}>
                              <View style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
                                <Text style={{ fontSize: 12.5, color: palette().ink3 }}>
                                  点右侧 + 直接开始新对话
                                </Text>
                              </View>
                            </If>

                            <Each of={group().sessions} key={(s) => s.id}>
                              {(sess) => (
                                <View style={{ gap: 2 }}>
                                  {renderSessionRow(sess)}

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
                                        {(child) => renderSessionRow(child, true)}
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

                  <If when={props.hasMoreSessions()}>
                    <View
                      role="button"
                      accessibilityLabel="Load more sessions"
                      onPress={props.onLoadMoreSessions}
                      style={{
                        minHeight: 38,
                        borderRadius: 10,
                        backgroundColor: palette().surface,
                        borderWidth: 1,
                        borderColor: palette().line,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 13, color: palette().ink2 }}>加载更多会话</Text>
                    </View>
                  </If>
                </View>
              </If>

              {/* Non-Agent Host fallback row (e.g. minimal hostLogs-only Host) */}
              <If when={!hasAgentEndpoint(hostItem())}>
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
                  <Text style={{ fontSize: 14.5, color: palette().ink }}>打开实时工作区会话 →</Text>
                </View>
              </If>
            </View>
          )}
        </If>

        {/* Offline / Saved Hosts */}
        <If when={offlineHosts().length > 0}>
          <View style={{ gap: 4, paddingTop: 4 }}>
            <View
              role="button"
              accessibilityLabel="Toggle saved offline hosts"
              onPress={() => offlineExpanded.set(!offlineExpanded())}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 6,
                paddingVertical: 4,
              }}
            >
              <Text style={{ fontSize: 11, color: palette().ink3 }}>
                {offlineExpanded() ? '▾' : '▸'}
              </Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: palette().ink3 }}>
                {'已保存电脑 · ' + String(offlineHosts().length)}
              </Text>
            </View>

            <If when={offlineExpanded()}>
              <View style={{ gap: 4 }}>
                <Each of={offlineHosts()} key={(h) => h.rootId}>
                  {(hostItem) => (
                    <View
                      role="button"
                      accessibilityLabel={'Host ' + hostItem().hostName}
                      onPress={() => props.onConnectHost(hostItem())}
                      style={{
                        minHeight: 44,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 12,
                        backgroundColor: palette().surface,
                        borderWidth: 1,
                        borderColor: palette().line,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                      }}
                    >
                      <View
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 4,
                          backgroundColor: palette().ink3,
                        }}
                      />
                      <View style={{ flex: 1, gap: 1 }}>
                        <Text style={{ fontSize: 14.5, fontWeight: '500', color: palette().ink }}>
                          {hostItem().hostName}
                        </Text>
                        <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                          已保存 · 点击连接
                        </Text>
                      </View>
                      <Text style={{ fontSize: 13, color: palette().ink3 }}>连线 ›</Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>
        </If>

        {/* Automations Row */}
        <If when={hasAgentEndpoint(props.hostState().active)}>
          <View
            role="button"
            accessibilityLabel="Automations"
            onPress={props.onOpenAutomations}
            style={{
              minHeight: 44,
              paddingHorizontal: 12,
              paddingVertical: 9,
              borderRadius: 12,
              backgroundColor: palette().surface,
              borderWidth: 1,
              borderColor: palette().line,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 4,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '500', color: palette().ink }}>
              定时任务与自动化
            </Text>
            <Text style={{ fontSize: 13, color: palette().ink3 }}>›</Text>
          </View>
        </If>
      </Scroll>

      {/* Bottom Host Scope Pill */}
      <View
        style={{
          paddingHorizontal: 14,
          paddingTop: 8,
          paddingBottom: props.bottomPad(),
          borderTopWidth: 1,
          borderTopColor: palette().line,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <View
          role={canSwitchHostFilter() ? 'button' : undefined}
          accessibilityLabel={canSwitchHostFilter() ? 'Switch host filter' : undefined}
          onPress={canSwitchHostFilter() ? props.onSwitchFilter : undefined}
          style={{
            flex: 1,
            minHeight: 40,
            paddingHorizontal: 12,
            borderRadius: 20,
            backgroundColor: canSwitchHostFilter() ? palette().surface : undefined,
            borderWidth: canSwitchHostFilter() ? 1 : 0,
            borderColor: palette().line,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: props.hostState().active ? palette().online : palette().ink3,
              }}
            />
            <Text style={{ fontSize: 13, fontWeight: '500', color: palette().ink }}>
              {activeHostLabel()}
            </Text>
          </View>
          <If when={canSwitchHostFilter()}>
            <Text style={{ fontSize: 12, color: palette().ink2 }}>
              {props.hostState().filter.kind === 'all_computers' ? '全部' : '单台'}
            </Text>
          </If>
        </View>
      </View>
    </View>
  );
}
