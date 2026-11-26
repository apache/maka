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
  cleanup,
  createAnimatedValue,
  Easing,
  effect,
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
import { Button, ContextMenu, Input, MenuItem } from 'nsh/base';
import type {
  AgentCreated,
  AgentRoomHistoryPage,
  AgentRoomMember,
  AgentRoomMessage,
  AgentSession,
  AgentSessionChanged,
  AgentWorkspaceSelection,
  HistoryPosition,
} from '../../../../packages/plugin-sdk/src/index.js';
import { createBrowsing } from './browsing';
import { HostProvider, searchSessions, type Host, type Output } from './host';
import { InlineCallout, RegionEmptyError } from './Feedback';
import { Icon } from './Icon';
import { SidebarUpdateButton } from './SidebarUpdateButton';
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
import { sessionIdFromLink } from './skillTokenText';
import { ImageViewer } from './ImageViewer';
import type { ImagePreview } from './ImageThumbnail';
import { RoomComposer, type RoomComposerHandle } from './RoomComposer';
import { RoomMessageRow } from './RoomMessageRow';
import {
  RoomEmptySeating,
  RoomHeaderControls,
  RoomMembersModal,
  RoomWorkingFooter,
} from './RoomPanels';
import {
  applyRoomWatchUpdate,
  createSerialQueue,
  isGroupContinuation,
  roomAuthorSession,
  roomAvatarColor,
  roomAvatarInitial,
  roomDayKey,
  roomResult,
  workspaceTailName,
  type RoomWatchState,
} from './roomMessage';
import { motionEnabled, ROOM_SPRING } from './roomMotion';

type RoomManageOutput = Output<'agent', 'roomManage'>;
const reasonText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

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
      const [rooms, conversations] = await Promise.all([
        searchSessions(host, 'room', query),
        searchSessions(host, 'agent', query),
      ]);
      const found = [...rooms, ...conversations];
      remember(found);
      return found;
    },
  };
}

/** Mini overlapping avatar stack for a Room row in the left sidebar. */
function SidebarRoomGlyph(props: { members: readonly AgentRoomMember[]; pinned: boolean }) {
  const active = () => props.members.filter((m) => !m.unavailable).slice(0, 3);
  return (
    <If
      when={active().length > 0}
      else={
        <Icon
          name={props.pinned ? 'pin' : 'rooms'}
          size={14}
          color={props.pinned ? C.accentText : C.muted}
        />
      }
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 16 }}>
        <Each of={active()} key={(m) => m.sessionId}>
          {(member, idx) => (
            <View
              style={{
                marginLeft: idx() === 0 ? 0 : -5,
                width: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: roomAvatarColor(member().sessionId),
                borderWidth: 1,
                borderColor: C.chrome,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 8, fontWeight: '600', color: '#FFFFFF' }}>
                {roomAvatarInitial(member().title)}
              </Text>
            </View>
          )}
        </Each>
        <If when={props.pinned}>
          <View style={{ marginLeft: 3 }}>
            <Icon name="pin" size={10} color={C.accentText} />
          </View>
        </If>
      </View>
    </If>
  );
}

export function createRoomWorkspace(options: {
  host: Host;
  initial: string | null;
  agentSession(): string | null;
  active(): boolean;
  visible(): boolean;
  browser(): BrowserHeader;
  inspecting?(): string | null;
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
  const roomMembersMap = signal(new Map<string, AgentRoomMember[]>());
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

  const recordRoomMembers = (roomId: string, items: readonly AgentRoomMember[]) => {
    if (!alive) return;
    rememberParticipants(items);
    const next = new Map(roomMembersMap());
    next.set(roomId, [...items]);
    roomMembersMap.set(next);
  };

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
          // Topic can still be edited in Room actions if setting it fails.
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
    const next = renameTitle().trim();
    if (!session || !next || createBusy()) return;
    createBusy.set(true);
    error.set('');
    try {
      const result = roomResult<{ kind: string; session?: AgentSession; reason?: string }>(
        (
          await host.control('metadata', {
            sessionId: session.id,
            expectedRevision: session.revision,
            title: next,
            labels: session.labels,
            pinned: session.pinned,
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

  const roomActions = (session: AgentSession, extra?: JSX.Element) => (
    <>
      {extra}
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
        <If when={roomFilter() === 'archived'}>
          <Button
            accessibilityLabel={tr('Back to active rooms')}
            onPress={() => roomFilter.set('all')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 8,
              paddingVertical: 5,
              borderRadius: 8,
              backgroundColor: C.surface,
            }}
            hoverStyle={{ backgroundColor: C.raised }}
          >
            <Icon name="back" size={12} color={C.secondary} />
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {tr('Back to active rooms')}
            </Text>
          </Button>
        </If>
        <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ gap: 2, paddingTop: 2 }}>
          <If when={Boolean(browser.error()) && filteredRooms().length > 0}>
            <InlineCallout
              surface="chrome"
              tone="danger"
              message={browser.error()!}
              action={{ label: tr('Retry'), onPress: () => void browser.refresh() }}
              style={{ marginBottom: 4 }}
            />
          </If>
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
                      paddingVertical: 8,
                      borderRadius: 10,
                      backgroundColor: selected() === session().id ? C.surface : 'transparent',
                    }}
                    hoverStyle={{ backgroundColor: C.surface }}
                    focusStyle={controlFocusStyle()}
                  >
                    <SidebarRoomGlyph
                      members={roomMembersMap().get(session().id) ?? []}
                      pinned={session().pinned}
                    />
                    <Text
                      style={[
                        {
                          ...bodyTextStyle,
                          color: selected() === session().id ? C.text : C.secondary,
                          flex: 1,
                          minWidth: 0,
                        },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {session().title}
                    </Text>
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
          <If when={Boolean(browser.error()) && filteredRooms().length === 0 && !browser.loading()}>
            <RegionEmptyError
              compact
              surface="chrome"
              tone="danger"
              title={browser.error()!}
              retry={() => void browser.refresh()}
            />
          </If>
          <If when={roomFilter() === 'all'}>
            <Button
              accessibilityLabel={tr('Archived rooms')}
              onPress={() => roomFilter.set('archived')}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 7,
                marginTop: 6,
                borderRadius: 8,
              }}
              hoverStyle={{ backgroundColor: C.surface }}
              focusStyle={controlFocusStyle()}
            >
              <Icon name="archive" size={13} color={C.muted} />
              <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Archived rooms')}</Text>
            </Button>
          </If>
        </Scroll>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Button
            accessibilityLabel={tr('Settings')}
            onPress={() => {
              options.closeNavigation();
              options.openSettings();
            }}
            style={{
              flex: 1,
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
          <SidebarUpdateButton />
        </View>
      </View>
    </HostProvider>
  );

  const content = () => (
    <HostProvider value={host}>
      <View style={{ flex: 1, minHeight: 0 }}>
        <If when={selected() === null}>
          <Header title={title()} browser={options.browser()} commands={() => {}} />
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <Icon name="rooms" size={32} color={C.muted} />
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
              visible={() => options.active() && options.visible()}
              title={title}
              browser={options.browser}
              inspecting={options.inspecting}
              workspacePath={() => known().get(id())?.workspace.path}
              roomMenuItems={(extra) =>
                known().has(id()) ? roomActions(known().get(id())!, extra) : extra
              }
              name={name}
              resolveNames={resolveNames}
              rememberParticipants={(items) => recordRoomMembers(id(), items)}
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
              accessibilityLabel={tr('Room topic')}
              placeholder={tr('Room topic (optional)')}
              value={createTopic()}
              onChange={({ value }) => createTopic.set(value)}
              onSubmit={() => void submitCreate()}
              style={{
                ...captionTextStyle,
                color: C.text,
                backgroundColor: C.raised,
                borderRadius: 8,
                padding: 10,
              }}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="folder" size={14} color={C.muted} />
              <Text style={{ ...captionTextStyle, color: C.secondary, flex: 1 }}>
                {createWorkspaceLabel() || tr('Choose workspace')}
              </Text>
              <Button
                accessibilityLabel={tr('Change workspace')}
                onPress={() => choosingWorkspace.set(true)}
                style={controlStyle}
                hoverStyle={{ backgroundColor: C.surface }}
              >
                <Text style={{ ...captionTextStyle, color: C.accentText }}>
                  {createWorkspace() ? tr('Change workspace') : tr('Choose workspace')}
                </Text>
              </Button>
            </View>
          </View>
          <If when={error()}>
            <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
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
              <Text style={{ color: C.accentText }}>{tr('New room')}</Text>
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
            <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
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
              <Text style={{ color: C.accentText }}>{tr('Save')}</Text>
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
            <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
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

/** Apply or revert a single human reaction on a specific message without touching other rows. */
function applyHumanReaction(
  list: readonly AgentRoomMessage[],
  messageId: string,
  emoji: string,
  wantAdd: boolean,
): AgentRoomMessage[] {
  return list.map((msg) => {
    if (msg.id !== messageId) return msg;
    const current = msg.reactions ?? [];
    const idx = current.findIndex((r) => r.emoji === emoji);
    if (wantAdd) {
      if (idx < 0) {
        return { ...msg, reactions: [...current, { emoji, actors: [{ kind: 'human' as const }] }] };
      }
      const entry = current[idx]!;
      if (entry.actors.some((a) => a.kind === 'human')) return msg;
      return {
        ...msg,
        reactions: current.map((r, i) =>
          i === idx ? { ...r, actors: [...r.actors, { kind: 'human' as const }] } : r,
        ),
      };
    }
    if (idx < 0) return msg;
    const entry = current[idx]!;
    if (!entry.actors.some((a) => a.kind === 'human')) return msg;
    const remaining = entry.actors.filter((a) => a.kind !== 'human');
    const reactions =
      remaining.length === 0
        ? current.filter((_, i) => i !== idx)
        : current.map((r, i) => (i === idx ? { ...r, actors: remaining } : r));
    return { ...msg, reactions };
  });
}

export function RoomTimeline(props: {
  sessionId: string;
  host: Host;
  visible(): boolean;
  title?(): string;
  browser?(): BrowserHeader;
  inspecting?(): string | null;
  roomMenuItems?(extra?: JSX.Element): JSX.Element;
  workspacePath?(): string | undefined;
  name(id: string): string;
  resolveNames(ids: string[]): Promise<void>;
  rememberParticipants?(items: readonly AgentRoomMember[]): void;
  searchSessions(query: string): Promise<AgentSession[]>;
  openAgent(id: string): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  attach(handle: RoomComposerHandle | null): void;
}) {
  const openLink = async (target: string, restoreFocus: () => boolean) => {
    const sessionId = sessionIdFromLink(target);
    if (sessionId) props.openAgent(sessionId);
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
  const highlightTick = signal(0);
  const reactionBursts = signal(new Map<string, number>());
  const ready = signal(false);
  const error = signal('');
  const streamBroken = signal(false);
  const loadingEarlier = signal(false);
  const loadingNewer = signal(false);
  const atEnd = signal(true);
  const throughSignal = signal(0);
  const viewer = signal<ImagePreview | null>(null);
  const membersOpen = signal(false);
  const editingTopic = signal(false);
  const topicDraft = signal('');
  const editingMessageId = signal<string | null>(null);
  const editDraft = signal('');

  const rise = createAnimatedValue(motionEnabled() ? 6 : 0);
  const fade = createAnimatedValue(motionEnabled() ? 0.92 : 1);
  if (motionEnabled()) {
    void rise.spring(0, ROOM_SPRING.roomSwitch);
    void fade.timing(1, { duration: 160, easing: Easing.out(Easing.cubic) });
  }

  const liveAddedIds = new Set<string>();
  const watchState: RoomWatchState = { through: 0, revision: null };
  const runTimeline = createSerialQueue();
  let alive = true;
  let scroll: ScrollRef | null = null;
  let stream: { next(): Promise<Output<'agent', 'watch'> | null>; close(): Promise<void> } | null =
    null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectBackoff = 1000;
  let composer: RoomComposerHandle | null = null;
  let contentHeight = 0;
  let scrollY = 0;
  let prependAnchor: { height: number; y: number } | null = null;
  let lastMarked: string | null = null;

  const map = () => new Map(messages().map((message) => [message.id, message]));
  const waitingMembers = () =>
    members().filter(
      (m) => !m.unavailable && (m.activity === 'waiting' || (m.pendingInteractions ?? 0) > 0),
    );

  const read = async (position: HistoryPosition): Promise<AgentRoomHistoryPage> => {
    const result = await props.host.query('agent', 'history', {
      sessionId: props.sessionId,
      position,
    });
    if (result.kind !== 'room') throw new Error('Expected Room history.');
    return result.page;
  };

  const loadState = async (): Promise<void> => {
    const state = await props.host.query('agent', 'roomState', { sessionId: props.sessionId });
    if (!alive) return;
    batch(() => {
      topic.set(state.topic);
      members.set(state.members);
      pinnedMessages.set(state.pinned);
    });
    props.rememberParticipants?.(state.members);
  };

  const refreshState = async (): Promise<boolean> => {
    try {
      await loadState();
      return alive;
    } catch {
      return false;
    }
  };

  const loadedSequence = () => messages().at(-1)?.sequence ?? 0;

  const publish = (
    page: AgentRoomHistoryPage,
    mode: 'replace' | 'append' | 'prepend',
    markLive = false,
  ) => {
    if (!alive) return;
    if (page.participants && page.participants.length > 0) {
      props.rememberParticipants?.(page.participants);
    }
    if (markLive) {
      const existingIds = new Set(messages().map((m) => m.id));
      for (const item of page.items) {
        if (!existingIds.has(item.id)) liveAddedIds.add(item.id);
      }
    }
    const merged = mode === 'replace' ? page.items : [...messages(), ...page.items];
    batch(() => {
      const next = [...new Map(merged.map((message) => [message.id, message])).values()].sort(
        (a, b) => a.sequence - b.sequence,
      );
      messages.set(next);
      if (mode !== 'append') before.set(page.before ?? null);
      if (mode !== 'prepend') after.set(page.after ?? null);
      // Never advance watchState.through on prepend or incomplete middle pages, and never roll it
      // backwards if a newer watch frame arrived while this page read was in flight.
      const tailSeq = next.at(-1)?.sequence ?? 0;
      if (mode === 'replace') {
        watchState.through = Math.max(watchState.through, page.through);
      } else if (mode === 'append' && page.after === null) {
        watchState.through = Math.max(watchState.through, tailSeq);
      }
      throughSignal.set(Math.max(throughSignal(), page.through));
      if (after() === null && tailSeq >= watchState.through) unseenCount.set(0);
      ready.set(true);
    });
    const ids = page.items.flatMap((message) => [
      ...message.mentions,
      ...(roomAuthorSession(message) ? [roomAuthorSession(message)!] : []),
    ]);
    void props.resolveNames(ids).catch(() => {});
  };

  const rowOffsets = new Map<string, number>();
  let pendingScrollId: string | null = null;

  const scrollToMessage = (messageId: string): boolean => {
    const y = rowOffsets.get(messageId);
    if (y === undefined || !scroll) return false;
    pendingScrollId = null;
    scroll.scrollTo({ y: Math.max(0, y - 80), animated: !reduceMotion() });
    return true;
  };

  const handleRowLayout = (messageId: string, y: number) => {
    rowOffsets.set(messageId, y);
    if (pendingScrollId === messageId) {
      scrollToMessage(messageId);
    }
  };

  // Walk from the first loaded row up to `upToSequence` so edits/deletes/reactions refresh in-place without evicting earlier rows.
  const refreshVisibleMetadata = async (upToSequence?: number): Promise<boolean> => {
    const loaded = messages();
    const first = loaded[0];
    const last = loaded.at(-1);
    await loadState();
    if (!alive) return false;
    if (!first || !last) return true;
    const stopSeq = upToSequence ?? last.sequence;
    const updated = new Map<string, AgentRoomMessage>();
    const maxPages = Math.ceil(loaded.length / 48) + 2;
    let position: HistoryPosition = { kind: 'message', messageId: first.id };
    for (let i = 0; i < maxPages && alive; i++) {
      const page = await read(position);
      if (!alive) return false;
      if (page.participants?.length) props.rememberParticipants?.(page.participants);
      for (const item of page.items) updated.set(item.id, item);
      const pageLast = page.items.at(-1);
      if (!pageLast || !page.after || pageLast.sequence >= stopSeq) break;
      position = { kind: 'after_message', messageId: pageLast.id };
    }
    if (!alive) return false;
    if (updated.size > 0) {
      messages.set(messages().map((item) => updated.get(item.id) ?? item));
    }
    return true;
  };

  // Runs strictly inside `runTimeline` so paging and watch updates never interleave.
  const refreshLocked = async (
    includeMetadata = false,
    targetThrough?: number,
  ): Promise<boolean> => {
    const current = messages();
    const last = current.at(-1);
    if (after() !== null) {
      if (includeMetadata) return refreshVisibleMetadata();
      await loadState();
      return alive;
    }
    if (!last) {
      publish(await read({ kind: 'tail' }), 'replace', false);
      await loadState();
      return alive && (targetThrough === undefined || loadedSequence() >= targetThrough);
    }
    let cursor = last.id;
    do {
      const page = await read({ kind: 'after_message', messageId: cursor });
      publish(page, 'append', true);
      if (!page.after || !alive) break;
      cursor = page.after;
    } while (alive);
    if (!alive) return false;
    if (includeMetadata) return refreshVisibleMetadata(last.sequence);
    return targetThrough === undefined || loadedSequence() >= targetThrough;
  };

  const refresh = (includeMetadata = false) => runTimeline(() => refreshLocked(includeMetadata));

  const latest = async () => {
    try {
      await runTimeline(async () => {
        atEnd.set(true);
        publish(await read({ kind: 'tail' }), 'replace');
        await refreshState();
      });
      if (alive) scroll?.scrollToEnd({ animated: !reduceMotion() });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    }
  };

  const earlier = async () => {
    if (!before() || loadingEarlier()) return;
    loadingEarlier.set(true);
    try {
      await runTimeline(async () => {
        const cursor = before();
        if (!cursor || !alive) return;
        const page = await read({ kind: 'before_message', messageId: cursor });
        prependAnchor = { height: contentHeight, y: scrollY };
        atEnd.set(false);
        publish(page, 'prepend');
      });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) loadingEarlier.set(false);
    }
  };

  const newer = async () => {
    if (!after() || loadingNewer()) return;
    loadingNewer.set(true);
    try {
      await runTimeline(async () => {
        const cursor = after();
        if (!cursor || !alive) return;
        const page = await read({ kind: 'after_message', messageId: cursor });
        publish(page, 'append');
      });
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    } finally {
      if (alive) loadingNewer.set(false);
    }
  };

  const flashHighlight = (messageId: string) => {
    batch(() => {
      highlightedId.set(messageId);
      highlightTick.set(highlightTick() + 1);
    });
  };

  const focusMessage = async (messageId: string) => {
    try {
      await runTimeline(async () => {
        if (!alive) return;
        if (!map().has(messageId)) {
          atEnd.set(false);
          rowOffsets.clear();
          pendingScrollId = messageId;
          publish(await read({ kind: 'around_message', messageId }), 'replace');
        } else if (!scrollToMessage(messageId)) {
          pendingScrollId = messageId;
        }
      });
      if (alive) flashHighlight(messageId);
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
      // Subscribe and capture the baseline watch revision BEFORE reading history so any edit or
      // retraction committed around the initial read emits a newer revision on this same stream.
      const opened = await props.host.subscribe('agent', 'watch', {
        sessionId: props.sessionId,
        after: 0,
      });
      if (!alive) {
        await opened.close();
        return;
      }
      stream = opened;
      const first = await opened.next();
      if (!alive) return;
      if (first === null || first.kind !== 'room') throw new Error(tr('Live updates ended.'));
      await runTimeline(async () => {
        const [page] = await Promise.all([read({ kind: 'tail' }), loadState()]);
        if (!alive) return;
        publish(page, 'replace');
        watchState.revision = first.revision;
      });
      if (!alive) return;
      reconnectBackoff = 1000;
      for (;;) {
        const update = await opened.next();
        if (!alive) break;
        if (update === null) throw new Error(tr('Live updates ended.'));
        if (update.kind === 'room') {
          const ok = await runTimeline(() =>
            applyRoomWatchUpdate(watchState, update, {
              hasAfterCursor: () => after() !== null,
              loadedThrough: loadedSequence,
              onThrough: (nextThrough) => throughSignal.set(Math.max(throughSignal(), nextThrough)),
              onUnseenDelta: (delta) => unseenCount.set(unseenCount() + delta),
              appendNew: (refreshExisting, targetThrough) =>
                refreshLocked(refreshExisting, targetThrough),
              refreshExisting: () => refreshVisibleMetadata(),
            }),
          );
          if (!ok && alive) throw new Error(tr('Live updates ended.'));
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
    rowOffsets.clear();
    pendingScrollId = null;
    reactionBursts.set(new Map());
    rise.stop();
    fade.stop();
    void closeStream();
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

  const clearReactionBurst = (messageId: string, emoji: string) => {
    const key = messageId + ':' + emoji;
    if (!reactionBursts().has(key)) return;
    const bursts = new Map(reactionBursts());
    bursts.delete(key);
    reactionBursts.set(bursts);
  };

  const toggleReaction = (messageId: string, emoji: string) => {
    const target = messages().find((m) => m.id === messageId);
    if (!target || target.deletedAt) return;
    const hadHuman = Boolean(
      target.reactions?.some((r) => r.emoji === emoji && r.actors.some((a) => a.kind === 'human')),
    );
    const wantAdd = !hadHuman;
    if (wantAdd && motionEnabled()) {
      const key = messageId + ':' + emoji;
      const bursts = new Map(reactionBursts());
      bursts.set(key, (bursts.get(key) ?? 0) + 1);
      reactionBursts.set(bursts);
    }
    messages.set(applyHumanReaction(messages(), messageId, emoji, wantAdd));
    void props.host
      .control('roomManage', {
        sessionId: props.sessionId,
        action: { kind: 'react', messageId, emoji, add: wantAdd },
      })
      .then(({ reply }) => roomResult<RoomManageOutput>(reply))
      .catch((reason) => {
        if (alive) {
          messages.set(applyHumanReaction(messages(), messageId, emoji, !wantAdd));
          clearReactionBurst(messageId, emoji);
          error.set(reasonText(reason));
        }
      });
  };

  const togglePin = (messageId: string, pinned: boolean) => {
    const target = messages().find((m) => m.id === messageId);
    if (!target || target.deletedAt) return;
    messages.set(messages().map((m) => (m.id === messageId ? { ...m, pinned } : m)));
    void props.host
      .control('roomManage', {
        sessionId: props.sessionId,
        action: { kind: pinned ? 'pin' : 'unpin', messageId },
      })
      .then(({ reply }) => {
        roomResult(reply);
        return refreshState();
      })
      .catch((reason) => {
        if (alive) {
          error.set(reasonText(reason));
          void runTimeline(() => refreshVisibleMetadata()).catch(() => {});
        }
      });
  };

  const saveEdit = async () => {
    const id = editingMessageId();
    const nextText = editDraft().trim();
    if (!id || !nextText) return;
    try {
      roomResult<RoomManageOutput>(
        (
          await props.host.control('roomManage', {
            sessionId: props.sessionId,
            action: { kind: 'edit_message', messageId: id, text: nextText },
          })
        ).reply,
      );
      editingMessageId.set(null);
      editDraft.set('');
      // Re-read inside the serial queue instead of patching from the RPC snapshot so a late
      // edit receipt can never overwrite a newer concurrent retraction or edit.
      void runTimeline(() => refreshVisibleMetadata()).catch(() => {});
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    }
  };

  const deleteMessage = (messageId: string) => {
    void props.host
      .control('roomManage', {
        sessionId: props.sessionId,
        action: { kind: 'delete_message', messageId },
      })
      .then(({ reply }) => {
        roomResult<RoomManageOutput>(reply);
        return runTimeline(() => refreshVisibleMetadata());
      })
      .catch((reason) => {
        if (alive) error.set(reasonText(reason));
      });
  };

  const saveTopic = async () => {
    try {
      roomResult<RoomManageOutput>(
        (
          await props.host.control('roomManage', {
            sessionId: props.sessionId,
            action: { kind: 'set_topic', topic: topicDraft().trim() },
          })
        ).reply,
      );
      editingTopic.set(false);
      void refreshState();
    } catch (reason) {
      if (alive) error.set(reasonText(reason));
    }
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
      month: 'short',
      day: 'numeric',
    });
  };

  const roomMenuExtras = () => (
    <>
      <RoomMenuItem
        label={tr('Edit room topic')}
        select={() => {
          topicDraft.set(topic());
          editingTopic.set(true);
        }}
      />
      <RoomMenuItem label={tr('Room members')} select={() => membersOpen.set(true)} />
    </>
  );

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        opacity: fade,
        transform: [{ translateY: rise }],
      }}
    >
      <If when={Boolean(props.browser)}>
        <Header
          title={props.title?.() ?? tr('Rooms')}
          subtitle={topic() || undefined}
          browser={props.browser!()}
          commands={() => {}}
          actions={
            <RoomHeaderControls
              sessionId={props.sessionId}
              host={props.host}
              members={members}
              pinned={pinnedMessages}
              inspecting={() => props.inspecting?.() ?? null}
              name={props.name}
              onOpenAgent={props.openAgent}
              onOpenMembers={() => membersOpen.set(true)}
              onJump={(id) => void focusMessage(id)}
              onUnpin={(id) => togglePin(id, false)}
              menuItems={props.roomMenuItems?.(roomMenuExtras())}
            />
          }
        />
      </If>

      <View style={{ flex: 1, minHeight: 0, position: 'relative' }}>
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
          contentStyle={{ paddingHorizontal: 24, paddingVertical: 18 }}
        >
          <View
            style={{ width: '100%', maxWidth: 912, alignSelf: 'center' }}
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
                style={{ ...controlStyle, alignSelf: 'center', marginBottom: 12 }}
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

            <If when={ready() && messages().length === 0}>
              <RoomEmptySeating
                members={members}
                onOpenAgent={props.openAgent}
                onOpenMembers={() => membersOpen.set(true)}
              />
            </If>

            <Each of={messages()} key={(message) => message.id}>
              {(message, index) => {
                const prev = () => (index() > 0 ? messages()[index() - 1] : undefined);
                const showDate = () => {
                  const p = prev();
                  return !p || roomDayKey(p.at) !== roomDayKey(message().at);
                };
                const continuation = () => isGroupContinuation(prev(), message());
                return (
                  <RoomMessageRow
                    sessionId={props.sessionId}
                    through={throughSignal}
                    message={message}
                    isFirst={() => index() === 0}
                    isContinuation={continuation}
                    showDateDivider={showDate}
                    dayLabel={dayLabel(message().at)}
                    timeLabel={time(message().at)}
                    isLive={() => liveAddedIds.has(message().id)}
                    isHighlighted={() => highlightedId() === message().id}
                    highlightTick={highlightTick}
                    isEditing={() => editingMessageId() === message().id}
                    editDraft={editDraft}
                    setEditDraft={(v) => editDraft.set(v)}
                    inspecting={() => props.inspecting?.() ?? null}
                    repliedMessage={() =>
                      message().replyTo ? map().get(message().replyTo!) : undefined
                    }
                    name={props.name}
                    burstFor={(emoji) => reactionBursts().get(message().id + ':' + emoji) ?? 0}
                    onBurstDone={(emoji) => clearReactionBurst(message().id, emoji)}
                    onRowLayout={handleRowLayout}
                    onError={(reason) => error.set(reasonText(reason))}
                    onReply={(msg) => composer?.reply(msg)}
                    onJump={(id) => void focusMessage(id)}
                    onReact={toggleReaction}
                    onTogglePin={togglePin}
                    onStartEdit={(msg) => {
                      editingMessageId.set(msg.id);
                      editDraft.set(msg.content.text);
                    }}
                    onSaveEdit={() => void saveEdit()}
                    onCancelEdit={() => editingMessageId.set(null)}
                    onDelete={deleteMessage}
                    onOpenAgent={props.openAgent}
                    onOpenLink={openLink}
                    onPreviewImage={(image) => viewer.set(image)}
                    onUserScroll={() => {}}
                  />
                );
              }}
            </Each>

            <If when={after()}>
              <Button
                accessibilityLabel={tr('Newer messages')}
                disabled={loadingNewer()}
                onPress={() => void newer()}
                style={{ ...controlStyle, alignSelf: 'center', marginTop: 12 }}
                hoverStyle={{ backgroundColor: C.surface }}
              >
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('Newer messages')}
                </Text>
              </Button>
            </If>

            <RoomWorkingFooter members={members} onOpenAgent={props.openAgent} />
          </View>
        </Scroll>

        {/* Floating absolute Latest circular button (never shifts scroll height) */}
        <If when={Boolean(after()) || !atEnd() || unseenCount() > 0}>
          <Button
            accessibilityLabel={tr('Latest')}
            onPress={() => void latest()}
            style={{
              position: 'absolute',
              right: 24,
              bottom: 14,
              minWidth: 34,
              height: 34,
              paddingHorizontal: unseenCount() > 0 ? 10 : 0,
              borderRadius: 17,
              backgroundColor: C.floating,
              borderWidth: 1,
              borderColor: C.line,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
            }}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={controlFocusStyle()}
          >
            <Icon name="latest" size={14} color={unseenCount() > 0 ? C.accentText : C.secondary} />
            <If when={unseenCount() > 0}>
              <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.accentText }}>
                {String(unseenCount())}
              </Text>
            </If>
          </Button>
        </If>
      </View>

      <RoomComposer
        sessionId={props.sessionId}
        members={members}
        waitingMembers={waitingMembers}
        streamError={error}
        retryStream={() => {
          error.set('');
          if (streamBroken()) void start(true);
          else
            void refresh().catch((reason) => {
              if (alive) error.set(reasonText(reason));
            });
        }}
        name={props.name}
        resolveNames={props.resolveNames}
        message={(id) => map().get(id)}
        searchSessions={props.searchSessions}
        openAgent={props.openAgent}
        posted={async () => {
          await refresh();
        }}
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
          onChanged={async () => {
            await refreshState();
          }}
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
              <Text style={{ color: C.accentText }}>{tr('Save')}</Text>
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
