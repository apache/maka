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
  batch,
  Clipboard,
  cleanup,
  createAnimatedValue,
  effect,
  platform,
  reduceMotion,
  Scroll,
  signal,
  Text,
  untracked,
  View,
  type InputRef,
  type JSX,
  type ScrollRef,
} from 'nsh';
import { Button, ContextMenu, Input, Menu, MenuItem } from 'nsh/base';
import type {
  AgentCreated,
  AgentRoomHistoryPage,
  AgentRoomMember,
  AgentRoomMessage,
  AgentSession,
  AgentSessionChanged,
  AgentWorkspaceSelection,
  HistoryPosition,
  SettingsAssistantPreferences,
} from '../../../../packages/plugin-sdk/src/index.js';
import { createBrowsing } from './browsing';
import { HostProvider, searchSessions, type Host, type Output } from './host';
import { Icon } from './Icon';
import { tr, currentLocale } from './locale';
import {
  Header,
  SidebarTitleRow,
  C,
  bodyTextStyle,
  captionTextStyle,
  controlStyle,
  controlFocusStyle,
  floatingStyle,
  menuRowHoverStyle,
  menuRowStyle,
  inputTextStyle,
  type BrowserHeader,
} from './ui';
import { ownTitleBar } from './chrome';
import { WorkspacePicker } from './WorkspacePicker';
import { ModalDialog, DialogHeader, DialogFooter } from './ModalDialog';
import { LoadingIndicator } from './Loading';
import { MarkdownBody } from './MarkdownBody';
import { sessionIdFromLink } from './skillTokenText';
import { HistoryAttachments } from './Attachments';
import { ImageViewer } from './ImageViewer';
import type { ImagePreview } from './ImageThumbnail';
import { RoomComposer, type RoomComposerHandle } from './RoomComposer';
import {
  RoomDeliveryStrip,
  RoomMembersModal,
  RoomPinnedBar,
  RoomRosterBar,
  RoomSearchPanel,
} from './RoomPanels';
import {
  roomAuthorSession,
  roomAvatarColor,
  roomAvatarInitial,
  roomDayKey,
  roomResult,
  workspaceTailName,
} from './roomMessage';
import { ProfileAvatar } from './ProfileAvatar';

const reasonText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const QUICK_REACTIONS = ['👍', '✅', '👀'] as const;

export function createRoomPeople(host: Host) {
  const known = signal(new Map<string, AgentSession>());
  const participants = signal(new Map<string, AgentRoomMember>());
  const unavailableIds = new Set<string>();
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  const remember = (sessions: AgentSession[]) => {
    if (!alive || sessions.length === 0) return;
    known.set(new Map([...known(), ...sessions.map((session) => [session.id, session] as const)]));
  };

  const rememberParticipants = (items: readonly AgentRoomMember[]) => {
    if (!alive || items.length === 0) return;
    const next = new Map(participants());
    for (const item of items) {
      next.set(item.sessionId, item);
      if (item.unavailable) unavailableIds.add(item.sessionId);
    }
    participants.set(next);
  };

  return {
    known,
    participants,
    remember,
    rememberParticipants,
    name: (id: string) => {
      const p = participants().get(id);
      if (p) return p.unavailable ? tr('Deleted session') : p.title;
      return known().get(id)?.title ?? (unavailableIds.has(id) ? tr('Deleted session') : id);
    },
    async resolveNames(ids: string[]) {
      const missing = [...new Set(ids)].filter(
        (id) => !participants().has(id) && !known().has(id) && !unavailableIds.has(id),
      );
      if (missing.length === 0) return;
      const settled = await Promise.allSettled(
        missing.map(
          async (sessionId) => (await host.query('agent', 'observe', { sessionId })).session,
        ),
      );
      const found: AgentSession[] = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!;
        if (result.status === 'fulfilled') found.push(result.value);
        else unavailableIds.add(missing[i]!);
      }
      remember(found);
    },
    async searchSessions(query: string) {
      const sessions = await searchSessions(host, 'agent', query);
      remember(sessions);
      return sessions;
    },
  };
}

export function createRoomWorkspace(options: {
  host: Host;
  initial: string | null;
  agentSession(): string | null;
  active(): boolean;
  visible(): boolean;
  browser(): BrowserHeader;
  closeNavigation(): void;
  openAgent(id: string): void;
  openSettings(): void;
  openLink(sessionId: string, target: string, restoreFocus: () => boolean): Promise<void>;
}) {
  const host = options.host;
  const browser = createBrowsing(host, 'room');
  const selected = signal(options.initial);
  const { known, remember, rememberParticipants, name, resolveNames, searchSessions } =
    createRoomPeople(host);
  const error = signal('');
  const searchQuery = signal('');
  const roomFilter = signal<'all' | 'archived'>('all');
  const creating = signal(false);
  const createTitle = signal('');
  const createTopic = signal('');
  const createWorkspace = signal<AgentWorkspaceSelection | null>(null);
  const createWorkspaceLabel = signal('');
  const choosingWorkspace = signal(false);
  const createBusy = signal(false);
  const renaming = signal<AgentSession | null>(null);
  let renameInput: InputRef | undefined;
  let createInput: InputRef | undefined;
  const renameTitle = signal('');
  const removing = signal<AgentSession | null>(null);
  let composer: RoomComposerHandle | null = null;
  let alive = true;
  let navigation = 0;

  effect(() => {
    const sessions = browser.sessions();
    untracked(() => remember(sessions));
  });
  effect(() => {
    browser.setFilter(roomFilter());
  });
  cleanup(() => {
    alive = false;
    navigation++;
  });

  const title = () => (selected() ? known().get(selected()!)?.title : undefined) ?? tr('Rooms');

  const open = async (id: string | null) => {
    const generation = ++navigation;
    try {
      await composer?.flush();
      if (id !== null && !known().has(id)) await resolveNames([id]);
      if (!alive || generation !== navigation) return false;
      selected.set(id);
      error.set('');
      options.closeNavigation();
      return true;
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
      return false;
    }
  };

  const newRoom = () => {
    options.closeNavigation();
    error.set('');
    createTitle.set('');
    createTopic.set('');
    const currentAgent = options.agentSession();
    const currentRoom = selected() ? known().get(selected()!) : undefined;
    if (currentRoom) {
      createWorkspace.set({ kind: 'session', sessionId: currentRoom.id });
      createWorkspaceLabel.set(workspaceTailName(currentRoom.workspace.path));
    } else if (currentAgent) {
      createWorkspace.set({ kind: 'session', sessionId: currentAgent });
      createWorkspaceLabel.set(
        known().get(currentAgent)?.workspace.path
          ? workspaceTailName(known().get(currentAgent)!.workspace.path)
          : '',
      );
      if (!known().has(currentAgent)) {
        void host
          .query('agent', 'observe', { sessionId: currentAgent })
          .then(({ session }) => {
            if (alive && creating()) {
              remember([session]);
              if (!createWorkspaceLabel())
                createWorkspaceLabel.set(workspaceTailName(session.workspace.path));
            }
          })
          .catch(() => {});
      }
    } else {
      createWorkspace.set(null);
      createWorkspaceLabel.set('');
    }
    choosingWorkspace.set(false);
    creating.set(true);
  };

  const create = async (workspace: AgentWorkspaceSelection) => {
    if (createBusy() || !createTitle().trim()) return;
    createBusy.set(true);
    error.set('');
    try {
      const observed = await host.control('create', {
        kind: 'room',
        title: createTitle().trim(),
        labels: [],
        workspace,
      });
      const result = roomResult<AgentCreated>(observed.reply);
      if (result.kind !== 'created') throw new Error(result.kind);
      const topic = createTopic().trim();
      if (topic) {
        try {
          await host.control('roomManage', {
            sessionId: result.session.id,
            action: { kind: 'set_topic', topic },
          });
        } catch {
          // Topic can still be edited in the Room header if setting it fails.
        }
      }
      remember([result.session]);
      if (await open(result.session.id))
        batch(() => {
          creating.set(false);
          choosingWorkspace.set(false);
        });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) createBusy.set(false);
    }
  };

  const submitCreate = async () => {
    const ws = createWorkspace();
    if (ws) await create(ws);
    else choosingWorkspace.set(true);
  };

  const rename = async () => {
    const session = renaming();
    if (!session || createBusy() || !renameTitle().trim()) return;
    createBusy.set(true);
    error.set('');
    try {
      const result = roomResult<{ kind: string; session?: AgentSession; reason?: string }>(
        (
          await host.control('metadata', {
            sessionId: session.id,
            expectedRevision: session.revision,
            title: renameTitle().trim(),
            labels: session.labels,
          })
        ).reply,
      );
      if (!result.session) throw new Error(result.reason ?? result.kind);
      remember([result.session]);
      renaming.set(null);
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) createBusy.set(false);
    }
  };

  const togglePinRoom = async (session: AgentSession) => {
    if (createBusy()) return;
    createBusy.set(true);
    error.set('');
    try {
      const result = roomResult<{ kind: string; session?: AgentSession; reason?: string }>(
        (
          await host.control('metadata', {
            sessionId: session.id,
            expectedRevision: session.revision,
            title: session.title,
            labels: session.labels,
            pinned: !session.pinned,
          })
        ).reply,
      );
      if (!result.session) throw new Error(result.reason ?? result.kind);
      remember([result.session]);
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) createBusy.set(false);
    }
  };

  const changeRoomArchive = async (session: AgentSession, action: 'archive' | 'restore') => {
    if (createBusy()) return;
    createBusy.set(true);
    error.set('');
    try {
      const result = roomResult<AgentSessionChanged>(
        (
          await host.control('changeSession', {
            sessionId: session.id,
            expectedRevision: session.revision,
            action,
          })
        ).reply,
      );
      if (result.kind !== 'changed') throw new Error(result.kind);
      remember([result.session]);
      if (action === 'archive' && selected() === session.id) selected.set(null);
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) createBusy.set(false);
    }
  };

  const remove = async () => {
    const session = removing();
    if (!session || createBusy()) return;
    createBusy.set(true);
    error.set('');
    try {
      const result = roomResult<AgentSessionChanged>(
        (
          await host.control('changeSession', {
            sessionId: session.id,
            expectedRevision: session.revision,
            action: 'remove',
          })
        ).reply,
      );
      if (result.kind !== 'removed') throw new Error(result.kind);
      if (selected() === session.id) selected.set(null);
      const sessions = new Map(known());
      sessions.delete(session.id);
      known.set(sessions);
      removing.set(null);
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) createBusy.set(false);
    }
  };

  const filteredRooms = () => {
    const needle = searchQuery().trim().toLowerCase();
    const list = browser.sessions();
    if (!needle) return list;
    return list.filter(
      (s) =>
        s.title.toLowerCase().includes(needle) || s.workspace.path.toLowerCase().includes(needle),
    );
  };

  const roomActions = (session: AgentSession) => (
    <>
      <RoomMenuItem
        label={tr('Rename room')}
        select={() => {
          options.closeNavigation();
          error.set('');
          renameTitle.set(session.title);
          renaming.set(session);
        }}
      />
      <RoomMenuItem
        label={session.pinned ? tr('Unpin room') : tr('Pin room')}
        select={() => {
          options.closeNavigation();
          void togglePinRoom(session);
        }}
      />
      <RoomMenuItem
        label={session.archived ? tr('Restore room') : tr('Archive room')}
        select={() => {
          options.closeNavigation();
          void changeRoomArchive(session, session.archived ? 'restore' : 'archive');
        }}
      />
      <RoomMenuItem
        label={tr('Delete room')}
        danger
        select={() => {
          options.closeNavigation();
          error.set('');
          removing.set(session);
        }}
      />
    </>
  );

  const navigationView = (
    modeSwitch: JSX.Element,
    pin?: () => void,
    suppressHover?: () => void,
  ) => (
    <HostProvider value={host}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          backgroundColor: C.chrome,
          padding: 12,
          paddingTop: ownTitleBar ? 0 : 12,
          gap: 8,
        }}
      >
        <If when={ownTitleBar && (options.browser().navigationDocked || !!pin)}>
          <SidebarTitleRow
            toggle={options.browser().toggle}
            pin={pin}
            suppressHover={suppressHover}
          />
        </If>
        <Button
          accessibilityLabel={tr('New room')}
          onPress={newRoom}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            padding: 10,
            borderRadius: 10,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="plus" color={C.secondary} />
          <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('New room')}</Text>
        </Button>
        {modeSwitch}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 8,
            paddingVertical: 5,
            borderRadius: 8,
            backgroundColor: C.background,
          }}
        >
          <Icon name="search" size={13} color={C.muted} />
          <Input
            accessibilityLabel={tr('Search rooms…')}
            placeholder={tr('Search rooms…')}
            value={searchQuery()}
            onChange={({ value }) => searchQuery.set(value)}
            style={{ ...captionTextStyle, color: C.text, flex: 1 }}
          />
          <If when={Boolean(searchQuery())}>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={() => searchQuery.set('')}
              style={{ padding: 2 }}
            >
              <Icon name="close" size={12} color={C.muted} />
            </Button>
          </If>
        </View>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <Each of={['all', 'archived'] as const} key={(tab) => tab}>
            {(tab) => (
              <Button
                accessibilityLabel={tab() === 'all' ? tr('Active rooms') : tr('Archived rooms')}
                selected={roomFilter() === tab()}
                onPress={() => roomFilter.set(tab())}
                style={{
                  flex: 1,
                  paddingVertical: 5,
                  borderRadius: 7,
                  alignItems: 'center',
                  backgroundColor: roomFilter() === tab() ? C.surface : 'transparent',
                }}
                hoverStyle={{ backgroundColor: C.surface }}
                focusStyle={controlFocusStyle()}
              >
                <Text
                  style={{
                    ...captionTextStyle,
                    color: roomFilter() === tab() ? C.text : C.muted,
                  }}
                >
                  {tab() === 'all' ? tr('Active rooms') : tr('Archived rooms')}
                </Text>
              </Button>
            )}
          </Each>
        </View>
        <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ gap: 4, paddingTop: 4 }}>
          <Each of={filteredRooms()} key={(session) => session.id}>
            {(session) => (
              <ContextMenu
                offset={4}
                margin={8}
                popupStyle={floatingStyle()}
                trigger={
                  <Button
                    accessibilityLabel={session().title}
                    selected={selected() === session().id}
                    onPress={() => void open(session().id)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 9,
                      borderRadius: 10,
                      backgroundColor: selected() === session().id ? C.surface : 'transparent',
                    }}
                    hoverStyle={{ backgroundColor: C.surface }}
                    focusStyle={controlFocusStyle()}
                  >
                    <Icon
                      name={session().pinned ? 'pin' : 'symbol'}
                      size={14}
                      color={session().pinned ? C.accent : C.muted}
                    />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text
                        style={[
                          {
                            ...bodyTextStyle,
                            color: C.text,
                            fontWeight: selected() === session().id ? '500' : '400',
                          },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {session().title}
                      </Text>
                      <If when={Boolean(session().workspace.path)}>
                        <Text
                          style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}
                        >
                          {workspaceTailName(session().workspace.path)}
                        </Text>
                      </If>
                    </View>
                    <If when={session().hasUnread && selected() !== session().id}>
                      <View
                        style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent }}
                      />
                    </If>
                  </Button>
                }
              >
                {roomActions(session())}
              </ContextMenu>
            )}
          </Each>
          <If when={browser.loading()}>
            <View style={{ padding: 12 }}>
              <LoadingIndicator />
            </View>
          </If>
          <If when={browser.hasMore()}>
            <Button
              accessibilityLabel={tr('Show more')}
              onPress={() => void browser.loadMore()}
              style={controlStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Show more')}</Text>
            </Button>
          </If>
          <If when={browser.error()}>
            <Text style={{ ...captionTextStyle, color: C.warning }}>{browser.error()}</Text>
          </If>
        </Scroll>
        <Button
          accessibilityLabel={tr('Settings')}
          onPress={() => {
            options.closeNavigation();
            options.openSettings();
          }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            padding: 10,
            borderRadius: 10,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="settings" color={C.secondary} />
          <Text style={{ ...bodyTextStyle, color: C.secondary }}>{tr('Settings')}</Text>
        </Button>
      </View>
    </HostProvider>
  );

  const content = () => (
    <HostProvider value={host}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <Header
          title={title()}
          browser={options.browser()}
          commands={() => {}}
          actions={
            selected() && known().has(selected()!) ? (
              <Menu
                align="end"
                offset={4}
                margin={8}
                popupStyle={floatingStyle()}
                trigger={
                  <Button
                    accessibilityLabel={tr('Room actions')}
                    style={controlStyle}
                    hoverStyle={{ backgroundColor: C.surface }}
                    focusStyle={controlFocusStyle()}
                  >
                    <Icon name="more" color={C.muted} />
                  </Button>
                }
              >
                {roomActions(known().get(selected()!)!)}
              </Menu>
            ) : undefined
          }
        />
        <If when={selected() === null}>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <Icon name="symbol" size={32} color={C.muted} />
            <Button
              accessibilityLabel={tr('New room')}
              onPress={newRoom}
              style={{ ...controlStyle, paddingHorizontal: 16, backgroundColor: C.surface }}
              hoverStyle={{ backgroundColor: C.raised }}
            >
              <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('New room')}</Text>
            </Button>
          </View>
        </If>
        {/* Keep RoomTimeline mounted across mode switches so scroll position & loaded pages survive. */}
        <Each of={selected() ? [selected()!] : []} key={(id) => id}>
          {(id) => (
            <RoomTimeline
              sessionId={id()}
              host={host}
              visible={options.visible}
              workspacePath={() => known().get(id())?.workspace.path}
              name={name}
              resolveNames={resolveNames}
              rememberParticipants={rememberParticipants}
              searchSessions={searchSessions}
              openAgent={options.openAgent}
              openLink={(target, restoreFocus) => options.openLink(id(), target, restoreFocus)}
              attach={(handle) => {
                composer = handle;
              }}
            />
          )}
        </Each>
      </View>

      <If when={creating() && !choosingWorkspace()}>
        <ModalDialog
          size="form"
          onOpen={() => createInput?.focus()}
          onCancel={() => {
            if (!createBusy()) creating.set(false);
          }}
        >
          <DialogHeader title={tr('New room')} />
          <View style={{ gap: 10 }}>
            <Input
              accessibilityLabel={tr('Room name')}
              placeholder={tr('Room name')}
              ref={(node) => {
                createInput = node;
              }}
              value={createTitle()}
              onChange={({ value }) => createTitle.set(value)}
              onSubmit={() => void submitCreate()}
              style={{
                ...inputTextStyle,
                color: C.text,
                backgroundColor: C.raised,
                borderRadius: 8,
                padding: 10,
              }}
            />
            <Input
              accessibilityLabel={tr('Room topic (optional)')}
              placeholder={tr('Room topic (optional)')}
              value={createTopic()}
              onChange={({ value }) => createTopic.set(value)}
              onSubmit={() => void submitCreate()}
              style={{
                ...inputTextStyle,
                color: C.text,
                backgroundColor: C.raised,
                borderRadius: 8,
                padding: 10,
              }}
            />
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 8,
                backgroundColor: C.surface,
              }}
            >
              <Icon name="folder" size={14} color={C.muted} />
              <Text
                style={[{ ...captionTextStyle, color: C.secondary, flex: 1 }, { numberOfLines: 1 }]}
              >
                {createWorkspaceLabel() || tr('Choose workspace')}
              </Text>
              <Button
                accessibilityLabel={tr('Change workspace')}
                disabled={createBusy()}
                onPress={() => choosingWorkspace.set(true)}
                style={{ ...controlStyle, minHeight: 24, paddingHorizontal: 8 }}
                hoverStyle={{ backgroundColor: C.raised }}
              >
                <Text style={{ ...captionTextStyle, color: C.accent }}>
                  {tr('Change workspace')}
                </Text>
              </Button>
            </View>
          </View>
          <If when={error()}>
            <Text style={{ color: C.warning }}>{error()}</Text>
          </If>
          <DialogFooter>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={() => creating.set(false)}
              disabled={createBusy()}
              style={controlStyle}
            >
              <Text style={{ color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('New room')}
              onPress={() => void submitCreate()}
              disabled={createBusy() || !createTitle().trim()}
              style={controlStyle}
            >
              <Text style={{ color: C.accent }}>{tr('New room')}</Text>
            </Button>
          </DialogFooter>
        </ModalDialog>
      </If>

      <If when={creating() && choosingWorkspace()}>
        <WorkspacePicker
          instance={1}
          current={() => creating() && choosingWorkspace()}
          close={() => {
            choosingWorkspace.set(false);
            return true;
          }}
          create={async (workspace) => {
            createWorkspace.set(workspace);
            if ('path' in workspace && typeof workspace.path === 'string') {
              createWorkspaceLabel.set(workspaceTailName(workspace.path));
            }
            choosingWorkspace.set(false);
            if (createTitle().trim()) await create(workspace);
          }}
          changed={() => {}}
        />
      </If>

      <If when={renaming()}>
        <ModalDialog
          size="form"
          onOpen={() => renameInput?.focus()}
          onCancel={() => {
            if (!createBusy()) renaming.set(null);
          }}
        >
          <DialogHeader title={tr('Rename room')} />
          <Input
            accessibilityLabel={tr('Room name')}
            ref={(node) => {
              renameInput = node;
            }}
            value={renameTitle()}
            onChange={({ value }) => renameTitle.set(value)}
            onSubmit={() => void rename()}
            style={{
              ...inputTextStyle,
              color: C.text,
              backgroundColor: C.raised,
              borderRadius: 8,
              padding: 10,
            }}
          />
          <If when={error()}>
            <Text style={{ color: C.warning }}>{error()}</Text>
          </If>
          <DialogFooter>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={() => renaming.set(null)}
              disabled={createBusy()}
              style={controlStyle}
            >
              <Text style={{ color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Save')}
              onPress={() => void rename()}
              disabled={createBusy() || !renameTitle().trim()}
              style={controlStyle}
            >
              <Text style={{ color: C.accent }}>{tr('Save')}</Text>
            </Button>
          </DialogFooter>
        </ModalDialog>
      </If>

      <If when={removing()}>
        <ModalDialog
          size="form"
          onCancel={() => {
            if (!createBusy()) removing.set(null);
          }}
        >
          <DialogHeader title={tr('Delete room')} />
          <Text style={{ ...bodyTextStyle, color: C.text }}>
            {tr('Delete “{title}” and its messages?', { title: removing()!.title })}
          </Text>
          <If when={error()}>
            <Text style={{ color: C.warning }}>{error()}</Text>
          </If>
          <DialogFooter>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={() => removing.set(null)}
              disabled={createBusy()}
              style={controlStyle}
            >
              <Text style={{ color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Confirm delete room')}
              onPress={() => void remove()}
              disabled={createBusy()}
              style={controlStyle}
            >
              <Text style={{ color: C.danger }}>{tr('Delete')}</Text>
            </Button>
          </DialogFooter>
        </ModalDialog>
      </If>
    </HostProvider>
  );

  if (options.initial)
    void resolveNames([options.initial]).catch((reason) => error.set(reasonText(reason)));

  return {
    selected,
    title,
    open,
    navigation: navigationView,
    content,
    flush: () => composer?.flush() ?? Promise.resolve(),
    directory: () => (selected() ? known().get(selected()!)?.workspace.path : undefined),
    report: (reason: unknown) => error.set(reasonText(reason)),
  };
}

export function RoomTimeline(props: {
  sessionId: string;
  host: Host;
  visible(): boolean;
  workspacePath?(): string | undefined;
  name(id: string): string;
  resolveNames(ids: string[]): Promise<void>;
  rememberParticipants?(items: readonly AgentRoomMember[]): void;
  searchSessions(query: string): Promise<AgentSession[]>;
  openAgent(id: string): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  attach(handle: RoomComposerHandle | null): void;
}) {
  const openLink: typeof props.openLink = async (target, restoreFocus) => {
    const id = sessionIdFromLink(target);
    if (id !== undefined) props.openAgent(id);
    else await props.openLink(target, restoreFocus);
  };

  const messages = signal<AgentRoomMessage[]>([]);
  const topic = signal('');
  const members = signal<AgentRoomMember[]>([]);
  const pinnedMessages = signal<AgentRoomMessage[]>([]);
  const before = signal<string | null>(null);
  const after = signal<string | null>(null);
  const unseenCount = signal(0);
  const highlightedId = signal<string | null>(null);
  const ready = signal(false);
  const error = signal('');
  const streamBroken = signal(false);
  const loadingEarlier = signal(false);
  const loadingNewer = signal(false);
  const atEnd = signal(true);
  const viewer = signal<ImagePreview | null>(null);
  const searchOpen = signal(false);
  const pinnedOpen = signal(false);
  const membersOpen = signal(false);
  const editingTopic = signal(false);
  const topicDraft = signal('');
  const editingMessageId = signal<string | null>(null);
  const editDraft = signal('');
  const profile = signal<Pick<SettingsAssistantPreferences, 'displayName' | 'avatar'> | null>(null);
  const displayName = () => profile()?.displayName.trim() ?? '';
  const rise = createAnimatedValue(reduceMotion() ? 0 : 8);
  if (!reduceMotion()) void rise.spring(0, { stiffness: 320, damping: 30 });

  let through = 0;
  let watchRevision = 0;
  let alive = true;
  let scroll: ScrollRef | null = null;
  let stream: { next(): Promise<Output<'agent', 'watch'> | null>; close(): Promise<void> } | null =
    null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectBackoff = 1000;
  let composer: RoomComposerHandle | null = null;
  let contentHeight = 0;
  let scrollY = 0;
  let prependAnchor: { height: number; y: number } | null = null;
  let lastMarked: string | null = null;
  let reading: Promise<void> | null = null;
  let reloadingState = false;

  const map = () => new Map(messages().map((message) => [message.id, message]));

  const read = async (position: HistoryPosition): Promise<AgentRoomHistoryPage> => {
    const result = await props.host.query('agent', 'history', {
      sessionId: props.sessionId,
      position,
    });
    if (result.kind !== 'room') throw new Error('Expected Room history.');
    return result.page;
  };

  const refreshState = async () => {
    if (reloadingState) return;
    reloadingState = true;
    try {
      const state = await props.host.query('agent', 'roomState', { sessionId: props.sessionId });
      if (!alive) return;
      batch(() => {
        topic.set(state.topic);
        members.set(state.members);
        pinnedMessages.set(state.pinned);
      });
      props.rememberParticipants?.(state.members);
    } catch {
      // Non-fatal: timeline remains usable even if state refresh races with reconnect.
    } finally {
      reloadingState = false;
    }
  };

  const publish = (page: AgentRoomHistoryPage, mode: 'replace' | 'append' | 'prepend') => {
    if (!alive) return;
    if (page.participants && page.participants.length > 0) {
      props.rememberParticipants?.(page.participants);
    }
    const merged = mode === 'replace' ? page.items : [...messages(), ...page.items];
    batch(() => {
      messages.set(
        [...new Map(merged.map((message) => [message.id, message])).values()].sort(
          (a, b) => a.sequence - b.sequence,
        ),
      );
      if (mode !== 'append') before.set(page.before ?? null);
      if (mode !== 'prepend') after.set(page.after ?? null);
      through = Math.max(through, page.through);
      if (after() === null) unseenCount.set(0);
      ready.set(true);
    });
    const ids = page.items.flatMap((message) => [
      ...message.mentions,
      ...(roomAuthorSession(message) ? [roomAuthorSession(message)!] : []),
    ]);
    void props.resolveNames(ids).catch(() => {});
  };

  const refresh = (): Promise<void> => {
    if (reading) return reading;
    reading = (async () => {
      const current = messages();
      const last = current.at(-1)?.id;
      if (after() !== null) {
        await refreshState();
        return;
      }
      if (!last) {
        publish(await read({ kind: 'tail' }), 'replace');
        await refreshState();
        return;
      }
      let cursor = last;
      do {
        const page = await read({ kind: 'after_message', messageId: cursor });
        publish(page, 'append');
        if (!page.after || !alive) break;
        cursor = page.after;
      } while (alive);
      await refreshState();
    })().finally(() => {
      reading = null;
    });
    return reading;
  };

  // Re-fetch current visible window metadata (deliveryStates, reactions, edits, pins) without jumping scroll.
  const refreshVisibleMetadata = async () => {
    const first = messages()[0]?.id;
    await refreshState();
    if (!alive || !first) return;
    try {
      const page =
        after() === null
          ? await read({ kind: 'tail' })
          : await read({ kind: 'message', messageId: first });
      if (!alive) return;
      if (page.participants && page.participants.length > 0) {
        props.rememberParticipants?.(page.participants);
      }
      const updated = new Map(page.items.map((item) => [item.id, item]));
      messages.set(messages().map((item) => updated.get(item.id) ?? item));
    } catch {
      // Ignore transient refresh failures; next revision will reconcile.
    }
  };

  const latest = async () => {
    try {
      atEnd.set(true);
      unseenCount.set(0);
      publish(await read({ kind: 'tail' }), 'replace');
      await refreshState();
      scroll?.scrollToEnd({ animated: !reduceMotion() });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    }
  };

  const earlier = async () => {
    const cursor = before();
    if (!cursor || loadingEarlier()) return;
    loadingEarlier.set(true);
    try {
      const page = await read({ kind: 'before_message', messageId: cursor });
      prependAnchor = { height: contentHeight, y: scrollY };
      atEnd.set(false);
      publish(page, 'prepend');
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) loadingEarlier.set(false);
    }
  };

  const newer = async () => {
    const cursor = after();
    if (!cursor || loadingNewer()) return;
    loadingNewer.set(true);
    try {
      const page = await read({ kind: 'after_message', messageId: cursor });
      publish(page, 'append');
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) loadingNewer.set(false);
    }
  };

  const flashHighlight = (messageId: string) => {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightedId.set(messageId);
    highlightTimer = setTimeout(() => {
      if (alive && highlightedId() === messageId) highlightedId.set(null);
    }, 2400);
  };

  const focusMessage = async (messageId: string) => {
    try {
      atEnd.set(false);
      publish(await read({ kind: 'around_message', messageId }), 'replace');
      flashHighlight(messageId);
      scroll?.scrollTo({ y: 0, animated: !reduceMotion() });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    }
  };

  const closeStream = async () => {
    const current = stream;
    stream = null;
    if (current) {
      try {
        await current.close();
      } catch {
        // Ignore close errors during reconnect/unmount.
      }
    }
  };

  const start = async (force = false) => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (stream) {
      if (!force) return;
      await closeStream();
    }
    error.set('');
    streamBroken.set(false);
    try {
      const [page] = await Promise.all([read({ kind: 'tail' }), refreshState()]);
      if (!alive) return;
      publish(page, 'replace');
      const opened = await props.host.subscribe('agent', 'watch', {
        sessionId: props.sessionId,
        after: page.through,
      });
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      reconnectBackoff = 1000;
      for (;;) {
        const update = await opened.next();
        if (!alive) break;
        if (update === null) throw new Error(tr('Live updates ended.'));
        if (update.kind === 'room') {
          const rev = update.revision ?? 0;
          if (update.through > through) {
            const delta = update.through - through;
            through = update.through;
            watchRevision = Math.max(watchRevision, rev);
            if (after() !== null) {
              unseenCount.set(unseenCount() + delta);
              await refreshState();
            } else {
              await refresh();
            }
          } else if (rev > watchRevision) {
            watchRevision = rev;
            await refreshVisibleMetadata();
          }
        }
      }
    } catch (reason) {
      if (alive) {
        error.set(reasonText(reason));
        streamBroken.set(true);
        const waitMs = reconnectBackoff;
        reconnectBackoff = Math.min(reconnectBackoff * 2, 10_000);
        reconnectTimer = setTimeout(() => {
          if (alive) void start(true);
        }, waitMs);
      }
    } finally {
      await closeStream();
    }
  };
  void start();

  cleanup(() => {
    alive = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (highlightTimer) clearTimeout(highlightTimer);
    void closeStream();
  });

  effect(() => {
    if (!props.visible()) return;
    let current = true;
    void props.host.query('settings', 'assistantPreferences', {}).then(
      (settings) => {
        if (alive && current) profile.set(settings);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  });

  effect(() => {
    const tail = messages().at(-1)?.id;
    if (!props.visible() || !atEnd() || after() !== null || !tail || lastMarked === tail) return;
    lastMarked = tail;
    void props.host
      .control('markRead', { sessionId: props.sessionId, messageId: tail })
      .then(({ reply }) => roomResult(reply))
      .catch((reason) => {
        if (alive) {
          lastMarked = null;
          error.set(reasonText(reason));
        }
      });
  });

  const runManage = async (action: Record<string, unknown>) => {
    try {
      roomResult(
        (await props.host.control('roomManage', { sessionId: props.sessionId, action })).reply,
      );
      await refreshVisibleMetadata();
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    }
  };

  const toggleReaction = (messageId: string, emoji: string) =>
    void runManage({ kind: 'react', messageId, emoji });

  const togglePin = (messageId: string, pinned: boolean) =>
    void runManage({ kind: pinned ? 'pin' : 'unpin', messageId });

  const saveEdit = async () => {
    const id = editingMessageId();
    const nextText = editDraft().trim();
    if (!id || !nextText) return;
    await runManage({ kind: 'edit_message', messageId: id, text: nextText });
    editingMessageId.set(null);
    editDraft.set('');
  };

  const deleteMessage = (messageId: string) =>
    void runManage({ kind: 'delete_message', messageId });

  const saveTopic = async () => {
    await runManage({ kind: 'set_topic', topic: topicDraft().trim() });
    editingTopic.set(false);
  };

  const time = (at: number) =>
    new Date(at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' });

  const dayLabel = (at: number) => {
    const key = roomDayKey(at);
    const todayKey = roomDayKey(Date.now());
    if (key === todayKey) return tr('Today');
    const yesterdayKey = roomDayKey(Date.now() - 86_400_000);
    if (key === yesterdayKey) return tr('Yesterday');
    return new Date(at).toLocaleDateString(currentLocale(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const hasHumanReacted = (actors: readonly { kind: string }[]) =>
    actors.some((actor) => actor.kind === 'human');

  return (
    <View style={{ flex: 1, minHeight: 0, transform: [{ translateY: rise }] }}>
      <RoomRosterBar
        workspacePath={() => props.workspacePath?.()}
        topic={topic}
        members={members}
        pinnedCount={() => pinnedMessages().length}
        searchOpen={searchOpen}
        pinnedOpen={pinnedOpen}
        onToggleSearch={() => {
          searchOpen.set(!searchOpen());
          if (searchOpen()) pinnedOpen.set(false);
        }}
        onTogglePinned={() => {
          pinnedOpen.set(!pinnedOpen());
          if (pinnedOpen()) searchOpen.set(false);
        }}
        onOpenMembers={() => membersOpen.set(true)}
        onEditTopic={() => {
          topicDraft.set(topic());
          editingTopic.set(true);
        }}
        onOpenAgent={props.openAgent}
      />

      <If when={pinnedOpen() && pinnedMessages().length > 0}>
        <RoomPinnedBar
          pinned={pinnedMessages}
          name={props.name}
          onJump={(id) => {
            pinnedOpen.set(false);
            void focusMessage(id);
          }}
          onUnpin={(id) => togglePin(id, false)}
          onClose={() => pinnedOpen.set(false)}
        />
      </If>

      <If when={searchOpen()}>
        <RoomSearchPanel
          sessionId={props.sessionId}
          host={props.host}
          name={props.name}
          onJump={(id) => void focusMessage(id)}
          onClose={() => searchOpen.set(false)}
        />
      </If>

      <Scroll
        accessibilityLabel={tr('Room messages')}
        ref={(node) => {
          scroll = node;
        }}
        style={{ flex: 1, minHeight: 0 }}
        onScroll={(event) => {
          scrollY = event.offset.y;
          atEnd.set(event.offset.y >= event.contentSize.height - event.size.height - 48);
        }}
        contentStyle={{ paddingHorizontal: 24, paddingVertical: 20 }}
      >
        <View
          style={{ width: '100%', maxWidth: 912, alignSelf: 'center', gap: 18 }}
          onLayout={({ bounds }) => {
            if (prependAnchor) {
              scroll?.scrollTo({
                y: prependAnchor.y + bounds.size.height - prependAnchor.height,
                animated: false,
              });
              prependAnchor = null;
            } else if (atEnd() && after() === null) scroll?.scrollToEnd({ animated: false });
            contentHeight = bounds.size.height;
          }}
        >
          <If when={before()}>
            <Button
              accessibilityLabel={tr('Earlier messages')}
              disabled={loadingEarlier()}
              onPress={() => void earlier()}
              style={{ ...controlStyle, alignSelf: 'center' }}
              hoverStyle={{ backgroundColor: C.surface }}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('Earlier messages')}
              </Text>
            </Button>
          </If>

          <If when={!ready()}>
            <View style={{ padding: 24, alignItems: 'center' }}>
              <LoadingIndicator />
            </View>
          </If>

          <Each of={messages()} key={(message) => message.id}>
            {(message, index) => {
              const showDateDivider = () => {
                if (index() === 0) return true;
                const prev = messages()[index() - 1];
                return !prev || roomDayKey(prev.at) !== roomDayKey(message().at);
              };
              const isDeleted = () => Boolean(message().deletedAt);
              const isHighlighted = () => highlightedId() === message().id;
              const isEditing = () => editingMessageId() === message().id;
              const authorId = () => roomAuthorSession(message());

              return (
                <View style={{ gap: 10 }}>
                  <If when={showDateDivider()}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                        paddingVertical: 4,
                      }}
                    >
                      <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
                      <Text style={{ ...captionTextStyle, color: C.muted }}>
                        {dayLabel(message().at)}
                      </Text>
                      <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
                    </View>
                  </If>

                  <ContextMenu
                    offset={4}
                    margin={8}
                    popupStyle={floatingStyle()}
                    trigger={
                      <View
                        selectable
                        class="group"
                        style={{
                          flexDirection: 'row',
                          gap: 12,
                          paddingHorizontal: 8,
                          paddingVertical: 6,
                          borderRadius: 12,
                          backgroundColor: isHighlighted() ? C.surface : 'transparent',
                        }}
                      >
                        <If
                          when={message().author.kind === 'human'}
                          else={
                            <Button
                              accessibilityLabel={props.name(authorId()!)}
                              onPress={() => props.openAgent(authorId()!)}
                              style={{
                                width: 30,
                                height: 30,
                                borderRadius: 15,
                                backgroundColor: roomAvatarColor(authorId()!),
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <Text style={{ fontSize: 13, fontWeight: '600', color: '#FFFFFF' }}>
                                {roomAvatarInitial(props.name(authorId()!))}
                              </Text>
                            </Button>
                          }
                        >
                          <ProfileAvatar
                            name={displayName()}
                            avatar={profile()?.avatar}
                            size={30}
                          />
                        </If>

                        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <If
                              when={message().author.kind === 'human'}
                              else={
                                <Button
                                  accessibilityLabel={props.name(authorId()!)}
                                  onPress={() => props.openAgent(authorId()!)}
                                  style={{ paddingVertical: 2 }}
                                >
                                  <Text
                                    style={{
                                      ...captionTextStyle,
                                      fontWeight: '600',
                                      color: C.text,
                                    }}
                                  >
                                    {props.name(authorId()!)}
                                  </Text>
                                </Button>
                              }
                            >
                              <Text
                                style={{ ...captionTextStyle, fontWeight: '600', color: C.text }}
                              >
                                {displayName() || tr('You')}
                              </Text>
                            </If>

                            <Text style={{ ...captionTextStyle, color: C.muted }}>
                              {time(message().at)}
                            </Text>
                            <If when={Boolean(message().editedAt) && !isDeleted()}>
                              <Text style={{ ...captionTextStyle, color: C.muted }}>
                                ({tr('Edited')})
                              </Text>
                            </If>
                            <If when={Boolean(message().pinned)}>
                              <Icon name="pin" size={11} color={C.accent} />
                            </If>

                            <View style={{ flex: 1 }} />

                            <If when={!isDeleted()}>
                              <View
                                class={
                                  platform.idiom === 'terminal'
                                    ? undefined
                                    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                                }
                                style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}
                              >
                                <Each of={QUICK_REACTIONS} key={(e) => e}>
                                  {(emoji) => (
                                    <Button
                                      accessibilityLabel={emoji()}
                                      onPress={() => toggleReaction(message().id, emoji())}
                                      style={{
                                        ...controlStyle,
                                        minHeight: 24,
                                        paddingVertical: 2,
                                        paddingHorizontal: 5,
                                      }}
                                      hoverStyle={{ backgroundColor: C.surface }}
                                      focusStyle={controlFocusStyle()}
                                    >
                                      <Text style={{ fontSize: 12 }}>{emoji()}</Text>
                                    </Button>
                                  )}
                                </Each>
                                <Button
                                  accessibilityLabel={tr('Reply to message')}
                                  onPress={() => composer?.reply(message())}
                                  style={{ ...controlStyle, minHeight: 24, paddingVertical: 2 }}
                                  hoverStyle={{ backgroundColor: C.surface }}
                                  focusStyle={controlFocusStyle()}
                                >
                                  <Icon name="undo" size={14} color={C.muted} />
                                </Button>
                              </View>
                            </If>
                          </View>

                          <If when={message().replyTo}>
                            <Button
                              accessibilityLabel={tr('View replied message')}
                              onPress={() => void focusMessage(message().replyTo!)}
                              style={{
                                borderLeftWidth: 2,
                                borderLeftColor: C.line,
                                paddingLeft: 10,
                                paddingVertical: 3,
                              }}
                              hoverStyle={{ backgroundColor: C.surface }}
                            >
                              <Text
                                style={[
                                  { ...captionTextStyle, color: C.secondary },
                                  { numberOfLines: 1 },
                                ]}
                              >
                                {map().get(message().replyTo!)?.content.text ||
                                  tr('View replied message')}
                              </Text>
                            </Button>
                          </If>

                          <If
                            when={
                              !isDeleted() &&
                              message().mentions.length > 0 &&
                              !message().content.text.includes('](maka://session/')
                            }
                          >
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                              <Each of={message().mentions} key={(id) => id}>
                                {(id) => (
                                  <Button
                                    accessibilityLabel={props.name(id())}
                                    onPress={() => props.openAgent(id())}
                                  >
                                    <Text style={{ ...captionTextStyle, color: C.accent }}>
                                      @{props.name(id())}
                                    </Text>
                                  </Button>
                                )}
                              </Each>
                            </View>
                          </If>

                          <If when={isDeleted()}>
                            <Text style={{ ...captionTextStyle, color: C.muted }}>
                              {tr('Message deleted')}
                            </Text>
                          </If>

                          <If when={!isDeleted() && isEditing()}>
                            <View style={{ gap: 8 }}>
                              <Input
                                autoFocus
                                accessibilityLabel={tr('Edit message')}
                                value={editDraft()}
                                onChange={({ value }) => editDraft.set(value)}
                                onSubmit={() => void saveEdit()}
                                style={{
                                  ...inputTextStyle,
                                  color: C.text,
                                  backgroundColor: C.raised,
                                  borderRadius: 8,
                                  padding: 10,
                                }}
                              />
                              <View style={{ flexDirection: 'row', gap: 8 }}>
                                <Button
                                  accessibilityLabel={tr('Save')}
                                  onPress={() => void saveEdit()}
                                  style={{ ...controlStyle, backgroundColor: C.surface }}
                                >
                                  <Text style={{ ...captionTextStyle, color: C.accent }}>
                                    {tr('Save')}
                                  </Text>
                                </Button>
                                <Button
                                  accessibilityLabel={tr('Cancel')}
                                  onPress={() => editingMessageId.set(null)}
                                  style={controlStyle}
                                >
                                  <Text style={{ ...captionTextStyle, color: C.secondary }}>
                                    {tr('Cancel')}
                                  </Text>
                                </Button>
                              </View>
                            </View>
                          </If>

                          <If
                            when={!isDeleted() && !isEditing() && Boolean(message().content.text)}
                          >
                            <MarkdownBody
                              selectable={false}
                              row={() => ({
                                key: message().id + ':' + String(message().editedAt ?? 0),
                                messageId: message().id,
                                field: 'body',
                                role: message().author.kind === 'human' ? 'user' : 'assistant',
                                text: message().content.text,
                                prefix: true,
                                closedAt: message().at,
                              })}
                              sourceId={message().id}
                              sessionId={props.sessionId}
                              openLink={openLink}
                              userScroll={() => {}}
                            />
                          </If>

                          <If when={!isDeleted() && message().content.attachments.length > 0}>
                            <HistoryAttachments
                              sessionId={props.sessionId}
                              through={through}
                              roomMessageId={message().id}
                              attachments={message().content.attachments}
                              preview={(image) => viewer.set(image)}
                              userScroll={() => {}}
                            />
                          </If>

                          <If when={!isDeleted() && (message().reactions?.length ?? 0) > 0}>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                              <Each of={message().reactions ?? []} key={(r) => r.emoji}>
                                {(reaction) => (
                                  <Button
                                    accessibilityLabel={reaction().emoji}
                                    onPress={() => toggleReaction(message().id, reaction().emoji)}
                                    style={{
                                      flexDirection: 'row',
                                      alignItems: 'center',
                                      gap: 4,
                                      paddingHorizontal: 8,
                                      paddingVertical: 2,
                                      borderRadius: 10,
                                      backgroundColor: hasHumanReacted(reaction().actors)
                                        ? C.raised
                                        : C.surface,
                                      borderWidth: 1,
                                      borderColor: hasHumanReacted(reaction().actors)
                                        ? C.accent
                                        : C.line,
                                    }}
                                    hoverStyle={{ backgroundColor: C.raised }}
                                  >
                                    <Text style={{ fontSize: 12 }}>{reaction().emoji}</Text>
                                    <Text style={{ ...captionTextStyle, color: C.secondary }}>
                                      {String(reaction().actors.length)}
                                    </Text>
                                  </Button>
                                )}
                              </Each>
                            </View>
                          </If>

                          <If when={!isDeleted() && (message().deliveryStates?.length ?? 0) > 0}>
                            <RoomDeliveryStrip
                              states={message().deliveryStates!}
                              name={props.name}
                              onOpenAgent={props.openAgent}
                              onJumpMessage={(id) => void focusMessage(id)}
                            />
                          </If>
                        </View>
                      </View>
                    }
                  >
                    <If when={!isDeleted()}>
                      <RoomMenuItem
                        label={tr('Reply to message')}
                        select={() => composer?.reply(message())}
                      />
                      <RoomMenuItem
                        label={message().pinned ? tr('Unpin message') : tr('Pin message')}
                        select={() => togglePin(message().id, !message().pinned)}
                      />
                      <If when={message().content.text}>
                        <RoomMenuItem
                          label={tr('Copy message')}
                          select={() => {
                            void Clipboard.writeText(message().content.text).catch((reason) => {
                              if (alive) error.set(reasonText(reason));
                            });
                          }}
                        />
                      </If>
                      <RoomMenuItem
                        label={tr('Edit message')}
                        select={() => {
                          editDraft.set(message().content.text);
                          editingMessageId.set(message().id);
                        }}
                      />
                      <RoomMenuItem
                        label={tr('Delete message')}
                        danger
                        select={() => deleteMessage(message().id)}
                      />
                    </If>
                  </ContextMenu>
                </View>
              );
            }}
          </Each>

          <If when={after()}>
            <Button
              accessibilityLabel={tr('Newer messages')}
              disabled={loadingNewer()}
              onPress={() => void newer()}
              style={{ ...controlStyle, alignSelf: 'center' }}
              hoverStyle={{ backgroundColor: C.surface }}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {tr('Newer messages')}
              </Text>
            </Button>
          </If>
        </View>
      </Scroll>

      <If when={(!atEnd() || after() !== null) && ready()}>
        <Button
          accessibilityLabel={tr('Latest')}
          onPress={() => void latest()}
          style={{
            ...controlStyle,
            alignSelf: 'center',
            borderRadius: 14,
            paddingHorizontal: 14,
            paddingVertical: 6,
            backgroundColor: unseenCount() > 0 ? C.accent : C.raised,
            marginBottom: 10,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="down" color={unseenCount() > 0 ? C.background : C.secondary} />
            <Text
              style={{
                ...captionTextStyle,
                color: unseenCount() > 0 ? C.background : C.text,
              }}
            >
              {unseenCount() > 0
                ? tr('New messages available') + ' (' + String(unseenCount()) + ')'
                : tr('Latest')}
            </Text>
          </View>
        </Button>
      </If>

      <If when={error()}>
        <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 24, alignItems: 'center' }}>
          <Text style={{ ...captionTextStyle, color: C.warning, flex: 1 }}>{error()}</Text>
          <Button
            accessibilityLabel={tr('Retry')}
            onPress={() => {
              error.set('');
              if (streamBroken()) void start(true);
              else void refresh();
            }}
            style={controlStyle}
          >
            <Text style={{ color: C.accent }}>{tr('Retry')}</Text>
          </Button>
        </View>
      </If>

      <RoomComposer
        sessionId={props.sessionId}
        members={members}
        name={props.name}
        resolveNames={props.resolveNames}
        message={(id) => map().get(id)}
        searchSessions={props.searchSessions}
        openAgent={props.openAgent}
        posted={refresh}
        preview={(image) => viewer.set(image)}
        attach={(handle) => {
          composer = handle;
          props.attach(handle);
        }}
      />

      <If when={membersOpen()}>
        <RoomMembersModal
          sessionId={props.sessionId}
          workspacePath={props.workspacePath?.()}
          host={props.host}
          members={members}
          searchSessions={props.searchSessions}
          onOpenAgent={props.openAgent}
          onChanged={refreshState}
          onClose={() => membersOpen.set(false)}
        />
      </If>

      <If when={editingTopic()}>
        <ModalDialog size="form" onCancel={() => editingTopic.set(false)}>
          <DialogHeader title={tr('Edit room topic')} />
          <Input
            autoFocus
            accessibilityLabel={tr('Room topic')}
            placeholder={tr('Room topic (optional)')}
            value={topicDraft()}
            onChange={({ value }) => topicDraft.set(value)}
            onSubmit={() => void saveTopic()}
            style={{
              ...inputTextStyle,
              color: C.text,
              backgroundColor: C.raised,
              borderRadius: 8,
              padding: 10,
            }}
          />
          <DialogFooter>
            <Button
              accessibilityLabel={tr('Cancel')}
              onPress={() => editingTopic.set(false)}
              style={controlStyle}
            >
              <Text style={{ color: C.secondary }}>{tr('Cancel')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Save')}
              onPress={() => void saveTopic()}
              style={controlStyle}
            >
              <Text style={{ color: C.accent }}>{tr('Save')}</Text>
            </Button>
          </DialogFooter>
        </ModalDialog>
      </If>

      <If when={viewer()}>
        <ImageViewer
          image={{ ...viewer()!, title: tr('Message attachments') }}
          close={() => {
            const original = viewer();
            viewer.set(null);
            original?.restoreFocus?.();
          }}
        />
      </If>
    </View>
  );
}

function RoomMenuItem(props: { label: string; danger?: boolean; select(): void }) {
  return (
    <MenuItem
      accessibilityLabel={props.label}
      onSelect={props.select}
      style={{ ...menuRowStyle(), minWidth: 160 }}
      hoverStyle={menuRowHoverStyle()}
      focusStyle={menuRowHoverStyle()}
    >
      <Text style={{ ...captionTextStyle, color: props.danger ? C.danger : C.text }}>
        {props.label}
      </Text>
    </MenuItem>
  );
}
