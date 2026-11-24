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

import { copy } from './copy';
import { Scroll, signal, Text, View } from 'nsh';
import { AlertDialog, ContextMenu, Input, MenuButton } from 'nsh/base';
import { confirmDestructive } from './ui';
import {
  hasAgentEndpoint,
  type AgentProject,
  type AgentSession,
  type AgentWorkspaceSelection,
  type HostStateSnapshot,
  type SavedHostItem,
} from './bridge';
import { token } from 'nsh';

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
  if (activity === 'waiting') return token('warning');
  if (activity === 'working') return token('working');
  return token('subdued');
}

export function DrawerHome(props: DrawerHomeProps) {
  const collapsedProjects = signal<Record<string, boolean>>({});
  const collapsedParents = signal<Record<string, boolean>>({});
  const offlineExpanded = signal(true);
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
          (wsPath
            ? (wsPath.split('/').filter(Boolean).pop() ?? copy('Workspace', '工作区', '工作區'))
            : copy('Default workspace', '默认工作区', '預設工作區'));
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
    if (active) return active.hostName + ' · ' + copy('Online', '在线', '在線');
    const total = props.hostState().hosts.length;
    return total > 0
      ? copy(
          `${total} paired ${total === 1 ? 'computer' : 'computers'}`,
          `${total} 台已配对电脑`,
          `${total} 台已配對電腦`,
        )
      : copy('No connected Host', '未连接电脑', '未連接電腦');
  };

  const renderSessionRow = (sess: () => AgentSession, indented = false) => {
    const actions = () => [
      { id: 'rename', label: copy('Rename', '重命名', '重新命名'), icon: 'pencil' },
      {
        id: 'pin',
        label: sess().pinned ? copy('Unpin', '取消置顶', '取消置頂') : copy('Pin', '置顶', '置頂'),
        icon: 'pin',
      },
      {
        id: 'archive',
        label: sess().archived ? copy('Restore', '恢复', '還原') : copy('Archive', '归档', '封存'),
        icon: 'archivebox',
      },
      { id: 'delete', label: copy('Delete', '删除', '刪除'), icon: 'trash', destructive: true },
    ];
    const select = async ({ id }: { id: string }) => {
      const session = sess();
      const anchor = props.hostState().active;
      if (!anchor) return;
      const sameAnchor = () => {
        const active = props.hostState().active;
        return active?.session === anchor.session && active.rootId === anchor.rootId;
      };
      switch (id) {
        case 'rename': {
          const result = await AlertDialog.show({
            title: copy('Rename conversation', '重命名会话', '重新命名對話'),
            input: { defaultValue: session.title, required: true, selectTextOnFocus: true },
            actions: [
              { id: 'cancel', label: copy('Cancel', '取消', '取消'), role: 'cancel' },
              { id: 'save', label: copy('Save', '保存', '儲存') },
            ],
          });
          if (sameAnchor() && result.action === 'save' && result.value?.trim())
            props.onRenameSession(session, result.value.trim());
          break;
        }
        case 'pin':
          props.onTogglePinSession(session);
          break;
        case 'archive':
          props.onChangeSessionLifecycle(session, session.archived ? 'restore' : 'archive');
          break;
        case 'delete':
          if (
            (await confirmDestructive(
              copy('Permanently delete this conversation?', '永久删除此会话？', '永久刪除此對話？'),
              copy('Delete', '删除', '刪除'),
            )) &&
            sameAnchor()
          )
            props.onChangeSessionLifecycle(session, 'remove');
      }
    };

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
              props.activeSessionId() === sess().id ? token('selected') : 'transparent',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <ContextMenu
            items={actions()}
            onSelect={select}
            trigger={
              <View
                role="button"
                accessibilityLabel={'Session ' + sess().title}
                onPress={() => props.onSelectSession(sess())}
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
                    color: indented ? token('muted-foreground') : token('foreground'),
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
                      backgroundColor: token('foreground'),
                    }}
                  />
                </If>
              </View>
            }
          />

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
              <Text style={{ fontSize: 11.5, color: token('subdued') }}>
                {String(childrenOf(sess().id).length) +
                  (collapsedParents()[sess().id] ? ' ▸' : ' ▾')}
              </Text>
            </View>
          </If>

          <MenuButton
            items={actions()}
            onSelect={select}
            accessibilityLabel={'Session actions ' + sess().title}
            class="min-h-11 min-w-11 items-center justify-center"
          >
            <Text class="text-muted-foreground">•••</Text>
          </MenuButton>
        </View>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: token('secondary') }}>
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
        <Text style={{ fontSize: 22, fontWeight: '700', color: token('foreground') }}>Maka</Text>
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
                backgroundColor: token('hover'),
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 19, color: token('foreground') }}>+</Text>
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
              backgroundColor: token('hover'),
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 12.5, fontWeight: '500', color: token('muted-foreground') }}>
              {copy('Pair', '配对', '配對')}
            </Text>
          </View>
          <View
            role="button"
            accessibilityLabel="Settings"
            onPress={props.onOpenSettings}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: token('hover'),
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 16, color: token('muted-foreground') }}>⚙</Text>
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
            placeholder={copy('Search conversations…', '搜索会话标题…', '搜尋對話標題…')}
            style={{
              minHeight: 36,
              borderRadius: 11,
              backgroundColor: token('muted'),
              paddingHorizontal: 12,
              color: token('foreground'),
              fontSize: 14,
            }}
          />

          <View style={{ flexDirection: 'row', gap: 6 }}>
            {(
              [
                { id: 'all', label: copy('All', '全部', '全部') },
                {
                  id: 'needs_you',
                  label:
                    props.needsYouCount() > 0
                      ? copy('Needs attention ', '待处理 ', '待處理 ') +
                        String(props.needsYouCount())
                      : copy('Needs attention', '待处理', '待處理'),
                },
                { id: 'archived', label: copy('Archived', '已归档', '已封存') },
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
                    props.catalogFilter() === tab.id ? token('selected') : token('card'),
                  borderWidth: 1,
                  borderColor:
                    props.catalogFilter() === tab.id ? token('glass-border') : token('border'),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: props.catalogFilter() === tab.id ? '600' : '400',
                    color:
                      props.catalogFilter() === tab.id
                        ? token('foreground')
                        : token('muted-foreground'),
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
              backgroundColor: token('accent-soft'),
            }}
          >
            <Text style={{ fontSize: 12.5, color: token('foreground') }}>
              {props.statusBanner()}
            </Text>
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
            backgroundColor: token('card'),
            borderWidth: 1,
            borderColor: token('border'),
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
              backgroundColor: token('primary'),
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: token('primary-foreground') }}>
              M
            </Text>
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: '600', color: token('foreground') }}>
              Maka Bot
            </Text>
            <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
              {props.hostState().active
                ? copy('Open your remote workspaces', '随时调度所有远端工作区', '開啟遠端工作區')
                : copy(
                    'Connect a Host to sync conversations',
                    '连接电脑后同步跨设备对话',
                    '連接電腦後同步跨裝置對話',
                  )}
            </Text>
          </View>
          <If when={props.needsYouCount() > 0 || props.pendingCount() > 0}>
            <View
              style={{
                minWidth: 20,
                height: 20,
                paddingHorizontal: 6,
                borderRadius: 10,
                backgroundColor: token('warning'),
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: '700', color: token('primary-foreground') }}>
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
              backgroundColor: token('card'),
              borderWidth: 1,
              borderColor: token('border'),
              gap: 10,
            }}
          >
            <Text style={{ fontSize: 16, fontWeight: '600', color: token('foreground') }}>
              {copy('Connect your first computer', '连接你的第一台电脑', '連接你的第一台電腦')}
            </Text>
            <Text style={{ fontSize: 13.5, lineHeight: 20, color: token('muted-foreground') }}>
              {copy(
                'Scan the Maka Desktop pairing QR code or paste a maka://pair/v1 link to open your projects and Agent conversations.',
                '扫描桌面端 Maka 配对二维码，或粘贴 maka://pair/v1 链接，直连你的项目与 Agent 会话。',
                '掃描 Maka 桌面版的配對 QR 碼，或貼上 maka://pair/v1 連結，直接開啟專案與 Agent 對話。',
              )}
            </Text>
            <View
              role="button"
              accessibilityLabel="Pair first computer"
              onPress={props.onOpenPairing}
              style={{
                minHeight: 44,
                borderRadius: 22,
                backgroundColor: token('primary'),
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: 4,
              }}
            >
              <Text
                style={{ fontSize: 14.5, fontWeight: '600', color: token('primary-foreground') }}
              >
                {copy('Scan or paste a pairing link', '扫码或粘贴配对码', '掃描或貼上配對連結')}
              </Text>
            </View>
          </View>
        </If>

        {/* Online Hosts + Borderless Spatial Tree */}
        <Each of={onlineHosts()} key={(h) => h.rootId}>
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
                    backgroundColor: token('success'),
                  }}
                />
                <Text
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    fontWeight: '600',
                    color: token('muted-foreground'),
                  }}
                >
                  {hostItem().hostName}
                </Text>
                <If when={hasAgentEndpoint(props.hostState().active)}>
                  <View
                    role="button"
                    accessibilityLabel="Create new room"
                    onPress={props.onOpenNewRoom}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 8,
                      backgroundColor: token('hover'),
                    }}
                  >
                    <Text style={{ fontSize: 11.5, color: token('muted-foreground') }}>+ Room</Text>
                  </View>
                </If>
              </View>

              <If when={hasAgentEndpoint(props.hostState().active)}>
                <View style={{ gap: 8 }}>
                  {/* Pinned Section */}
                  <If when={pinnedSessions().length > 0}>
                    <View style={{ gap: 3 }}>
                      <Text
                        style={{
                          fontSize: 11.5,
                          fontWeight: '600',
                          color: token('subdued'),
                          paddingHorizontal: 8,
                        }}
                      >
                        {copy('Pin', '置顶', '置頂')}
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
                            <Text style={{ fontSize: 11, color: token('subdued') }}>
                              {collapsedProjects()[group().key] ? '▸' : '▾'}
                            </Text>
                            <Text
                              style={{
                                flex: 1,
                                fontSize: 12.5,
                                fontWeight: '600',
                                color: token('muted-foreground'),
                              }}
                            >
                              {group().name}
                            </Text>
                            <Text style={{ fontSize: 11.5, color: token('subdued') }}>
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
                              backgroundColor: token('hover'),
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Text style={{ fontSize: 16, color: token('muted-foreground') }}>
                              +
                            </Text>
                          </View>
                        </View>

                        <If when={!collapsedProjects()[group().key]}>
                          <View
                            style={{
                              marginLeft: 12,
                              paddingLeft: 10,
                              borderLeftWidth: 1,
                              borderLeftColor: token('separator'),
                              gap: 2,
                            }}
                          >
                            <If when={group().sessions.length === 0}>
                              <View style={{ paddingHorizontal: 10, paddingVertical: 6 }}>
                                <Text style={{ fontSize: 12.5, color: token('subdued') }}>
                                  {copy(
                                    'Tap + to start a conversation',
                                    '点右侧 + 直接开始新对话',
                                    '點一下右側的 + 開始新對話',
                                  )}
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
                                        borderLeftColor: token('separator'),
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
                        backgroundColor: token('card'),
                        borderWidth: 1,
                        borderColor: token('border'),
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 13, color: token('muted-foreground') }}>
                        {copy('Load more conversations', '加载更多会话', '載入更多對話')}
                      </Text>
                    </View>
                  </If>
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
                    borderLeftColor: token('separator'),
                  }}
                >
                  <Text style={{ fontSize: 14.5, color: token('foreground') }}>
                    {copy('Open live workspace →', '打开实时工作区会话 →', '開啟即時工作區對話 →')}
                  </Text>
                </View>
              </If>
            </View>
          )}
        </Each>

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
              <Text style={{ fontSize: 11, color: token('subdued') }}>
                {offlineExpanded() ? '▾' : '▸'}
              </Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: token('subdued') }}>
                {copy('Saved computers · ', '已保存电脑 · ', '已儲存電腦 · ') +
                  String(offlineHosts().length)}
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
                        backgroundColor: token('card'),
                        borderWidth: 1,
                        borderColor: token('border'),
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
                          backgroundColor: token('subdued'),
                        }}
                      />
                      <View style={{ flex: 1, gap: 1 }}>
                        <Text
                          style={{ fontSize: 14.5, fontWeight: '500', color: token('foreground') }}
                        >
                          {hostItem().hostName}
                        </Text>
                        <Text style={{ fontSize: 11.5, color: token('subdued') }}>
                          {copy(
                            'Saved · Tap to connect',
                            '已保存 · 点击连接',
                            '已儲存 · 點一下即可連線',
                          )}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 13, color: token('subdued') }}>
                        {copy('Connect ›', '连线 ›', '連線 ›')}
                      </Text>
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
              backgroundColor: token('card'),
              borderWidth: 1,
              borderColor: token('border'),
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 4,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '500', color: token('foreground') }}>
              {copy('Schedules and automations', '定时任务与自动化', '排程與自動化')}
            </Text>
            <Text style={{ fontSize: 13, color: token('subdued') }}>›</Text>
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
          borderTopColor: token('border'),
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
            minHeight: 40,
            paddingHorizontal: 12,
            borderRadius: 20,
            backgroundColor: token('card'),
            borderWidth: 1,
            borderColor: token('border'),
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
                backgroundColor: props.hostState().active ? token('success') : token('subdued'),
              }}
            />
            <Text style={{ fontSize: 13, fontWeight: '500', color: token('foreground') }}>
              {activeHostLabel()}
            </Text>
          </View>
          <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
            {props.hostState().filter.kind === 'all_computers'
              ? copy('All', '全部', '全部')
              : copy('One Host', '单台', '單台')}
          </Text>
        </View>
      </View>
    </View>
  );
}
