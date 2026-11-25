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

import { tr } from './locale';
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
            ? (wsPath.split('/').filter(Boolean).pop() ?? tr('Workspace'))
            : tr('Default workspace'));
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
    if (active) return tr('{name} · Online', { name: active.hostName });
    const total = props.hostState().hosts.length;
    return total > 0
      ? tr('{count, plural, one {# paired computer} other {# paired computers}}', { count: total })
      : tr('No connected Host');
  };

  const renderSessionRow = (sess: () => AgentSession, indented = false) => {
    const actions = () => [
      { id: 'rename', label: tr('Rename'), icon: 'pencil' },
      {
        id: 'pin',
        label: sess().pinned ? tr('Unpin') : tr('Pin'),
        icon: 'pin',
      },
      {
        id: 'archive',
        label: sess().archived ? tr('Restore') : tr('Archive'),
        icon: 'archivebox',
      },
      { id: 'delete', label: tr('Delete'), icon: 'trash', destructive: true },
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
            title: tr('Rename conversation'),
            input: { defaultValue: session.title, required: true, selectTextOnFocus: true },
            actions: [
              { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
              { id: 'save', label: tr('Save') },
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
            (await confirmDestructive(tr('Permanently delete this conversation?'), tr('Delete'))) &&
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
                accessibilityLabel={tr('Conversation: {title}', { title: sess().title })}
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
                  {sess().kind === 'room' ? tr('# {title}', { title: sess().title }) : sess().title}
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
              accessibilityLabel={tr('Show or hide sub-conversations for {title}', {
                title: sess().title,
              })}
              onPress={() => {
                const cur = collapsedParents();
                collapsedParents.set({ ...cur, [sess().id]: !cur[sess().id] });
              }}
              style={{ paddingHorizontal: 5, paddingVertical: 4 }}
            >
              <Text style={{ fontSize: 11.5, color: token('subdued') }}>
                {tr('{count} {arrow}', {
                  count: childrenOf(sess().id).length,
                  arrow: collapsedParents()[sess().id] ? '▸' : '▾',
                })}
              </Text>
            </View>
          </If>

          <MenuButton
            items={actions()}
            onSelect={select}
            accessibilityLabel={tr('Actions for {title}', { title: sess().title })}
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
        <Text style={{ fontSize: 22, fontWeight: '700', color: token('foreground') }}>
          {tr('Maka')}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <If when={hasAgentEndpoint(props.hostState().active)}>
            <View
              role="button"
              accessibilityLabel={tr('New conversation')}
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
            accessibilityLabel={tr('Add remote Host')}
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
              {tr('Pair')}
            </Text>
          </View>
          <View
            role="button"
            accessibilityLabel={tr('Settings')}
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
            accessibilityLabel={tr('Search conversations')}
            value={props.catalogQuery()}
            onChange={({ value }: { value: string }) => props.onCatalogQueryChange(value)}
            placeholder={tr('Search conversations…')}
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
                { id: 'all', label: tr('All') },
                {
                  id: 'needs_you',
                  label:
                    props.needsYouCount() > 0
                      ? tr('Needs attention {count}', { count: props.needsYouCount() })
                      : tr('Needs attention'),
                },
                { id: 'archived', label: tr('Archived') },
              ] as const
            ).map((tab) => (
              <View
                role="button"
                accessibilityLabel={tr('Filter: {label}', { label: tab.label })}
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
          accessibilityLabel={tr('Open Maka Bot')}
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
              {tr('Maka Bot')}
            </Text>
            <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
              {props.hostState().active
                ? tr('Open your remote workspaces')
                : tr('Connect a Host to sync conversations')}
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
              {tr('Connect your first computer')}
            </Text>
            <Text style={{ fontSize: 13.5, lineHeight: 20, color: token('muted-foreground') }}>
              {tr(
                'Scan the Maka Desktop pairing QR code or paste a maka://pair/v1 link to open your projects and Agent conversations.',
              )}
            </Text>
            <View
              role="button"
              accessibilityLabel={tr('Pair your first computer')}
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
                {tr('Scan or paste a pairing link')}
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
                    accessibilityLabel={tr('New room')}
                    onPress={props.onOpenNewRoom}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 8,
                      backgroundColor: token('hover'),
                    }}
                  >
                    <Text style={{ fontSize: 11.5, color: token('muted-foreground') }}>
                      {tr('+ Room')}
                    </Text>
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
                        {tr('Pin')}
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
                            accessibilityLabel={
                              collapsedProjects()[group().key]
                                ? tr('Expand {name}', { name: group().name })
                                : tr('Collapse {name}', { name: group().name })
                            }
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
                            accessibilityLabel={tr('New conversation in {name}', {
                              name: group().name,
                            })}
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
                                  {tr('Tap + to start a conversation')}
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
                      accessibilityLabel={tr('Load more conversations')}
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
                        {tr('Load more conversations')}
                      </Text>
                    </View>
                  </If>
                </View>
              </If>

              {/* Non-Agent Host fallback row (e.g. minimal hostLogs-only Host) */}
              <If when={!hasAgentEndpoint(props.hostState().active)}>
                <View
                  role="button"
                  accessibilityLabel={tr('Open workspace on {name}', { name: hostItem().hostName })}
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
                    {tr('Open live workspace →')}
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
              accessibilityLabel={tr('Show or hide saved offline computers')}
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
                {tr('Saved computers · {count}', { count: offlineHosts().length })}
              </Text>
            </View>

            <If when={offlineExpanded()}>
              <View style={{ gap: 4 }}>
                <Each of={offlineHosts()} key={(h) => h.rootId}>
                  {(hostItem) => (
                    <View
                      role="button"
                      accessibilityLabel={tr('Host: {name}', { name: hostItem().hostName })}
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
                          {tr('Saved · Tap to connect')}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 13, color: token('subdued') }}>
                        {tr('Connect ›')}
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
            accessibilityLabel={tr('Automations')}
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
              {tr('Schedules and automations')}
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
          accessibilityLabel={tr('Switch computer filter')}
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
            {props.hostState().filter.kind === 'all_computers' ? tr('All') : tr('One Host')}
          </Text>
        </View>
      </View>
    </View>
  );
}
