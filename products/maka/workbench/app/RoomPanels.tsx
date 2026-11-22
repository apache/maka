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

import { effect, platform, signal, Text, View, type JSX } from 'nsh';
import { Button, Input, Menu, Popover } from 'nsh/base';
import type {
  AgentCreated,
  AgentRoomDeliveryState,
  AgentRoomMember,
  AgentRoomMessage,
  AgentSession,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Host, Output } from './host';
import { Icon } from './Icon';
import { LoadingIndicator, ShimmerText } from './Loading';
import { ModalDialog, DialogHeader, DialogFooter } from './ModalDialog';
import { tr } from './locale';
import {
  formatRoomPreviewText,
  roomAvatarColor,
  roomAvatarInitial,
  roomDeliveryReasonKey,
  roomResult,
} from './roomMessage';
import { motionEnabled, popupMotionProps, useBreathingStyle } from './roomMotion';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlFocusStyle,
  controlStyle,
  floatingStyle,
  inputTextStyle,
  textTooltip,
} from './ui';

type PresetSummary = Output<'agent', 'presets'>[number];
type SearchMatch = Output<'agent', 'roomSearch'>['items'][number];

/** Only mounted while a member is actively working, keeping idle rooms at 0fps. */
function BreathingMemberRing() {
  const pulse = useBreathingStyle(false);
  return (
    <View
      accessibilityElementsHidden
      style={[
        {
          position: 'absolute',
          top: -2,
          left: -2,
          right: -2,
          bottom: -2,
          borderRadius: 13,
          borderWidth: 1.5,
          borderColor: C.accent,
          pointerEvents: 'none',
        },
        pulse,
      ]}
    />
  );
}

/** Only mounted while a member is waiting on human approval, keeping idle rooms at 0fps. */
function BreathingWaitingDot() {
  const pulse = useBreathingStyle(true);
  return (
    <View
      accessibilityElementsHidden
      style={[
        {
          position: 'absolute',
          right: -1,
          bottom: -1,
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: C.warning,
          borderWidth: 1.5,
          borderColor: C.background,
          pointerEvents: 'none',
        },
        pulse,
      ]}
    />
  );
}

/** Single-line header controls: overlapping member avatars, overlay Pins & Search popovers, and actions menu. */
export function RoomHeaderControls(props: {
  sessionId: string;
  host: Host;
  members(): readonly AgentRoomMember[];
  pinned(): readonly AgentRoomMessage[];
  inspecting(): string | null;
  name(id: string): string;
  onOpenAgent(id: string): void;
  onOpenMembers(): void;
  onJump(messageId: string): void;
  onUnpin(messageId: string): void;
  menuItems?: JSX.Element;
}) {
  const pinnedOpen = signal(false);
  const searchOpen = signal(false);
  const activeMembers = () => props.members().filter((m) => !m.unavailable);
  const shownMembers = () => activeMembers().slice(0, 5);
  const overflowCount = () => Math.max(0, activeMembers().length - 5);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {/* Overlapping member avatar stack */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 4 }}>
        <Each of={shownMembers()} key={(m) => m.sessionId}>
          {(member, index) => {
            const isWorking = () => member().activity === 'working';
            const isWaiting = () =>
              member().activity === 'waiting' || (member().pendingInteractions ?? 0) > 0;
            const isInspected = () => props.inspecting() === member().sessionId;
            const tip = () => {
              const status = isWaiting()
                ? tr('Delivery waiting')
                : isWorking()
                  ? tr('Delivery working')
                  : null;
              return status ? member().title + ' · ' + status : member().title;
            };
            return (
              <View
                style={{
                  position: 'relative',
                  marginLeft: index() === 0 ? 0 : -6,
                  zIndex: isInspected() ? 6 : 5 - index(),
                }}
              >
                <If when={isWorking() && !isInspected()}>
                  <BreathingMemberRing />
                </If>
                <Button
                  accessibilityLabel={member().title}
                  tooltip={textTooltip(tip)}
                  onPress={() => props.onOpenAgent(member().sessionId)}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    backgroundColor: roomAvatarColor(member().sessionId),
                    borderWidth: 2,
                    borderColor: isInspected() ? C.accent : C.background,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  hoverStyle={{ borderColor: C.accent }}
                  focusStyle={controlFocusStyle()}
                >
                  <Text style={{ fontSize: 10, fontWeight: '600', color: '#FFFFFF' }}>
                    {roomAvatarInitial(member().title)}
                  </Text>
                </Button>
                <If when={isWaiting()}>
                  <BreathingWaitingDot />
                </If>
              </View>
            );
          }}
        </Each>
        <Button
          accessibilityLabel={tr('Room members')}
          tooltip={textTooltip(() => tr('Room members'))}
          onPress={props.onOpenMembers}
          style={{
            marginLeft: shownMembers().length > 0 ? -4 : 0,
            zIndex: 7,
            minWidth: 22,
            height: 22,
            paddingHorizontal: overflowCount() > 0 ? 5 : 0,
            borderRadius: 11,
            backgroundColor: C.surface,
            borderWidth: 1.5,
            borderColor: C.background,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={controlFocusStyle()}
        >
          <If when={overflowCount() > 0} else={<Icon name="plus" size={11} color={C.secondary} />}>
            <Text style={{ fontSize: 10, fontWeight: '600', color: C.secondary }}>
              {'+' + String(overflowCount())}
            </Text>
          </If>
        </Button>
      </View>

      {/* Overlay Pinned popover (only when pins exist, with a quiet dot instead of noisy count) */}
      <If when={props.pinned().length > 0}>
        <Popover
          open={pinnedOpen()}
          onOpenChange={({ open }) => {
            pinnedOpen.set(open);
            if (open) searchOpen.set(false);
          }}
          placement="bottom"
          align="end"
          offset={6}
          margin={10}
          popupClass={
            motionEnabled()
              ? 'transition-all duration-150 ease-[cubic-bezier(0.18,0.82,0.24,1)]'
              : undefined
          }
          {...popupMotionProps('down')}
          popupStyle={{ ...floatingStyle(), width: 340, maxHeight: 360, padding: 12, gap: 8 }}
          trigger={
            <Button
              accessibilityLabel={tr('Pinned messages')}
              tooltip={textTooltip(() => tr('Pinned messages'))}
              style={{
                ...controlStyle,
                minHeight: 26,
                height: 26,
                width: 26,
                paddingHorizontal: 0,
                position: 'relative',
                backgroundColor: pinnedOpen() ? C.surface : 'transparent',
              }}
              hoverStyle={{ backgroundColor: C.surface }}
              focusStyle={controlFocusStyle()}
            >
              <Icon name="pin" size={13} color={pinnedOpen() ? C.accent : C.muted} />
              <View
                accessibilityElementsHidden
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  width: 5,
                  height: 5,
                  borderRadius: 2.5,
                  backgroundColor: C.accent,
                }}
              />
            </Button>
          }
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="pin" size={12} color={C.accent} />
            <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.text, flex: 1 }}>
              {tr('Pinned messages')}
            </Text>
          </View>
          <View style={{ gap: 6 }}>
            <Each of={props.pinned()} key={(m) => m.id}>
              {(msg) => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Button
                    accessibilityLabel={
                      formatRoomPreviewText(msg().content.text) || tr('View replied message')
                    }
                    onPress={() => {
                      pinnedOpen.set(false);
                      props.onJump(msg().id);
                    }}
                    style={{
                      flex: 1,
                      borderLeftWidth: 2,
                      borderLeftColor: C.accent,
                      paddingLeft: 8,
                      paddingVertical: 4,
                      borderRadius: 4,
                    }}
                    hoverStyle={{ backgroundColor: C.surface }}
                  >
                    <Text style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 2 }]}>
                      {formatRoomPreviewText(msg().content.text)}
                    </Text>
                  </Button>
                  <Button
                    accessibilityLabel={tr('Unpin message')}
                    onPress={() => props.onUnpin(msg().id)}
                    style={{ ...controlStyle, minHeight: 22, width: 22, paddingHorizontal: 0 }}
                    hoverStyle={{ backgroundColor: C.surface }}
                  >
                    <Icon name="close" size={11} color={C.muted} />
                  </Button>
                </View>
              )}
            </Each>
          </View>
        </Popover>
      </If>

      {/* Overlay Search popover (never pushes message timeline) */}
      <Popover
        open={searchOpen()}
        onOpenChange={({ open }) => {
          searchOpen.set(open);
          if (open) pinnedOpen.set(false);
        }}
        placement="bottom"
        align="end"
        offset={6}
        margin={10}
        popupClass={
          motionEnabled()
            ? 'transition-all duration-150 ease-[cubic-bezier(0.18,0.82,0.24,1)]'
            : undefined
        }
        {...popupMotionProps('down')}
        popupStyle={{ ...floatingStyle(), width: 340, maxHeight: 380, padding: 10, gap: 8 }}
        trigger={
          <Button
            accessibilityLabel={tr('Search messages')}
            tooltip={textTooltip(() => tr('Search messages'))}
            style={{
              ...controlStyle,
              minHeight: 26,
              height: 26,
              width: 26,
              paddingHorizontal: 0,
              backgroundColor: searchOpen() ? C.surface : 'transparent',
            }}
            hoverStyle={{ backgroundColor: C.surface }}
            focusStyle={controlFocusStyle()}
          >
            <Icon name="search" size={13} color={searchOpen() ? C.accent : C.muted} />
          </Button>
        }
      >
        <RoomSearchPopoverBody
          sessionId={props.sessionId}
          host={props.host}
          name={props.name}
          onJump={(id) => {
            searchOpen.set(false);
            props.onJump(id);
          }}
        />
      </Popover>

      <If when={Boolean(props.menuItems)}>
        <Menu
          align="end"
          offset={4}
          margin={8}
          popupStyle={floatingStyle()}
          trigger={
            <Button
              accessibilityLabel={tr('Room actions')}
              style={{
                ...controlStyle,
                minHeight: 26,
                height: 26,
                width: 26,
                paddingHorizontal: 0,
              }}
              hoverStyle={{ backgroundColor: C.surface }}
              focusStyle={controlFocusStyle()}
            >
              <Icon name="more" size={14} color={C.muted} />
            </Button>
          }
        >
          {props.menuItems}
        </Menu>
      </If>
    </View>
  );
}

function RoomSearchPopoverBody(props: {
  sessionId: string;
  host: Host;
  name(id: string): string;
  onJump(messageId: string): void;
}) {
  const query = signal('');
  const results = signal<SearchMatch[]>([]);
  const loading = signal(false);
  const error = signal('');
  let gen = 0;

  effect(() => {
    const q = query().trim();
    const current = ++gen;
    if (!q) {
      results.set([]);
      loading.set(false);
      error.set('');
      return;
    }
    loading.set(true);
    error.set('');
    void props.host
      .query('agent', 'roomSearch', { sessionId: props.sessionId, query: q, limit: 25 })
      .then((res) => {
        if (current === gen) results.set(res.items);
      })
      .catch((reason) => {
        if (current === gen) error.set(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current === gen) loading.set(false);
      });
  });

  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 8,
          height: 30,
          borderRadius: 8,
          backgroundColor: C.surface,
        }}
      >
        <Icon name="search" size={13} color={C.muted} />
        <Input
          autoFocus={platform.idiom !== 'terminal'}
          accessibilityLabel={tr('Search messages')}
          placeholder={tr('Search messages…')}
          value={query()}
          onChange={({ value }) => query.set(value)}
          style={{ ...captionTextStyle, color: C.text, flex: 1 }}
        />
        <If when={loading()}>
          <LoadingIndicator size={12} />
        </If>
      </View>
      <If when={Boolean(error())}>
        <Text style={{ ...captionTextStyle, color: C.warning }}>{error()}</Text>
      </If>
      <If when={!loading() && Boolean(query().trim()) && results().length === 0}>
        <Text style={{ ...captionTextStyle, color: C.muted, paddingHorizontal: 4 }}>
          {tr('No matching messages')}
        </Text>
      </If>
      <If when={results().length > 0}>
        <View style={{ gap: 4 }}>
          <Each of={results().slice(0, 8)} key={(m) => m.message.id}>
            {(match) => (
              <Button
                accessibilityLabel={formatRoomPreviewText(match().snippet)}
                onPress={() => props.onJump(match().message.id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: 6,
                }}
                hoverStyle={{ backgroundColor: C.surface }}
              >
                <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.secondary }}>
                  {(() => {
                    const author = match().message.author;
                    return author.kind === 'human'
                      ? tr('You')
                      : props.name(author.execution.sessionId);
                  })()}
                </Text>
                <Text
                  style={[{ ...captionTextStyle, color: C.text, flex: 1 }, { numberOfLines: 1 }]}
                >
                  {formatRoomPreviewText(match().snippet)}
                </Text>
              </Button>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

/**
 * Actionable-only delivery alerts on a Room message.
 * Replies and reactions already speak for themselves on the timeline; working/queued
 * belong to member presence. Only waiting / failed / rejected require human attention.
 */
export function RoomDeliveryStrip(props: {
  states: readonly AgentRoomDeliveryState[];
  name(id: string): string;
  align?: 'left' | 'right';
  onOpenAgent(id: string): void;
}) {
  const actionable = () =>
    props.states.filter(
      (s) =>
        s.kind === 'waiting' ||
        s.kind === 'failed' ||
        (s.kind === 'rejected' && s.reason !== 'agent_room_self_mention'),
    );

  return (
    <If when={actionable().length > 0}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: props.align === 'right' ? 'flex-end' : 'flex-start',
          gap: 6,
          marginTop: 4,
        }}
      >
        <Each of={actionable()} key={(s) => s.sessionId + ':' + s.kind}>
          {(st) => {
            const targetName = () => props.name(st().sessionId);
            const label = () => {
              const s = st();
              switch (s.kind) {
                case 'waiting':
                  return tr('Delivery waiting');
                case 'failed':
                  return s.reason ?? tr('Delivery failed');
                case 'rejected': {
                  const key = roomDeliveryReasonKey(s.reason);
                  return key ? tr(key) : s.reason;
                }
                default:
                  return '';
              }
            };
            const color = () => (st().kind === 'waiting' ? C.warning : C.danger);
            return (
              <Button
                accessibilityLabel={targetName() + ': ' + label()}
                onPress={() => props.onOpenAgent(st().sessionId)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  backgroundColor: color() + '16',
                }}
                hoverStyle={{ backgroundColor: color() + '24' }}
                focusStyle={controlFocusStyle()}
              >
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: color(),
                  }}
                />
                <Text style={{ fontSize: 11.5, color: color() }}>
                  {'@' + targetName() + ' · ' + label()}
                </Text>
              </Button>
            );
          }}
        </Each>
      </View>
    </If>
  );
}

/** Calm single-line organic presence indicator at the bottom of the timeline when Agents are working. */
export function RoomWorkingFooter(props: {
  members(): readonly AgentRoomMember[];
  onOpenAgent(id: string): void;
}) {
  const working = () => props.members().filter((m) => !m.unavailable && m.activity === 'working');
  const summary = () =>
    tr('Members working', {
      names: working()
        .map((m) => m.title)
        .join(', '),
    });
  return (
    <If when={working().length > 0}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingLeft: 48,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Each of={working().slice(0, 3)} key={(m) => m.sessionId}>
            {(member, idx) => {
              const pulse = useBreathingStyle(false);
              return (
                <Button
                  accessibilityLabel={member().title}
                  onPress={() => props.onOpenAgent(member().sessionId)}
                  style={[
                    {
                      marginLeft: idx() === 0 ? 0 : -4,
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      backgroundColor: roomAvatarColor(member().sessionId),
                      borderWidth: 1.5,
                      borderColor: C.background,
                      alignItems: 'center',
                      justifyContent: 'center',
                    },
                    pulse,
                  ]}
                >
                  <Text style={{ fontSize: 9, fontWeight: '600', color: '#FFFFFF' }}>
                    {roomAvatarInitial(member().title)}
                  </Text>
                </Button>
              );
            }}
          </Each>
        </View>
        <ShimmerText text={summary()} style={captionTextStyle} />
      </View>
    </If>
  );
}

/** Distinctive quiet seating table shown in a fresh, empty Room. */
export function RoomEmptySeating(props: {
  members(): readonly AgentRoomMember[];
  onOpenAgent(id: string): void;
  onOpenMembers(): void;
}) {
  const active = () => props.members().filter((m) => !m.unavailable);
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 72,
        gap: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <If
          when={active().length > 0}
          else={
            <Each of={[0, 1, 2]} key={(i) => i}>
              {() => (
                <Button
                  accessibilityLabel={tr('Room members')}
                  onPress={props.onOpenMembers}
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 19,
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: C.line,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  hoverStyle={{ backgroundColor: C.surface, borderColor: C.accent }}
                >
                  <Icon name="plus" size={14} color={C.muted} />
                </Button>
              )}
            </Each>
          }
        >
          <Each of={active().slice(0, 6)} key={(m) => m.sessionId}>
            {(member) => (
              <Button
                accessibilityLabel={member().title}
                tooltip={textTooltip(() => member().title)}
                onPress={() => props.onOpenAgent(member().sessionId)}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  backgroundColor: roomAvatarColor(member().sessionId),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                hoverStyle={{ opacity: 0.9 }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: '#FFFFFF' }}>
                  {roomAvatarInitial(member().title)}
                </Text>
              </Button>
            )}
          </Each>
        </If>
      </View>
      <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Take a seat hint')}</Text>
    </View>
  );
}

/** Modal for managing Room roster: add existing sessions, remove members, or spawn from Preset. */
export function RoomMembersModal(props: {
  sessionId: string;
  workspacePath: string | undefined;
  host: Host;
  members(): readonly AgentRoomMember[];
  searchSessions(query: string): Promise<AgentSession[]>;
  onOpenAgent(id: string): void;
  onChanged(): Promise<void>;
  onClose(): void;
}) {
  const query = signal('');
  const candidates = signal<AgentSession[]>([]);
  const presets = signal<PresetSummary[]>([]);
  const useWorktree = signal(false);
  const busy = signal(false);
  const error = signal('');
  let gen = 0;

  void props.host
    .query('agent', 'presets', {})
    .then((list) => presets.set(list))
    .catch(() => {});

  effect(() => {
    const q = query();
    const current = ++gen;
    void props
      .searchSessions(q)
      .then((list) => {
        if (current === gen) candidates.set(list);
      })
      .catch(() => {});
  });

  const activeMembers = () => props.members().filter((m) => !m.unavailable);
  const memberIds = () => new Set(activeMembers().map((m) => m.sessionId));
  const addableSessions = () =>
    candidates()
      .filter((s) => !s.archived && s.kind !== 'room' && !memberIds().has(s.id))
      .slice(0, 8);

  const addMember = async (memberSessionId: string) => {
    busy.set(true);
    error.set('');
    try {
      roomResult(
        (
          await props.host.control('roomManage', {
            sessionId: props.sessionId,
            action: { kind: 'add_members', memberSessionIds: [memberSessionId] },
          })
        ).reply,
      );
      await props.onChanged();
    } catch (reason) {
      error.set(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.set(false);
    }
  };

  const removeMember = async (memberSessionId: string) => {
    busy.set(true);
    error.set('');
    try {
      roomResult(
        (
          await props.host.control('roomManage', {
            sessionId: props.sessionId,
            action: { kind: 'remove_members', memberSessionIds: [memberSessionId] },
          })
        ).reply,
      );
      await props.onChanged();
    } catch (reason) {
      error.set(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.set(false);
    }
  };

  const spawnPreset = async (preset: PresetSummary) => {
    busy.set(true);
    error.set('');
    try {
      const workspace =
        useWorktree() && props.workspacePath
          ? { kind: 'worktree' as const, path: props.workspacePath }
          : { kind: 'session' as const, sessionId: props.sessionId };
      const created = roomResult<AgentCreated>(
        (
          await props.host.control('create', {
            kind: 'agent',
            title: preset.name,
            labels: [],
            presetId: preset.id,
            workspace,
          })
        ).reply,
      );
      if (created.kind !== 'created') throw new Error(created.kind);
      roomResult(
        (
          await props.host.control('roomManage', {
            sessionId: props.sessionId,
            action: {
              kind: 'add_members',
              memberSessionIds: [created.session.id],
            },
          })
        ).reply,
      );
      await props.onChanged();
    } catch (reason) {
      error.set(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.set(false);
    }
  };

  return (
    <ModalDialog size="form" onCancel={props.onClose}>
      <DialogHeader title={tr('Room members')} />
      <View style={{ gap: 12 }}>
        <If when={activeMembers().length === 0}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('No members yet')}</Text>
        </If>
        <Each of={activeMembers()} key={(m) => m.sessionId}>
          {(member) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: C.raised,
              }}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: roomAvatarColor(member().sessionId),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: '600', color: '#FFFFFF' }}>
                  {roomAvatarInitial(member().title)}
                </Text>
              </View>
              <Button
                accessibilityLabel={member().title}
                onPress={() => {
                  props.onClose();
                  props.onOpenAgent(member().sessionId);
                }}
                style={{ flex: 1, minWidth: 0 }}
              >
                <Text style={[{ ...bodyTextStyle, color: C.text }, { numberOfLines: 1 }]}>
                  {member().title}
                </Text>
                <If when={Boolean(member().presetName)}>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>{member().presetName}</Text>
                </If>
              </Button>
              <Button
                accessibilityLabel={tr('Remove member')}
                disabled={busy()}
                onPress={() => void removeMember(member().sessionId)}
                style={{ ...controlStyle, minHeight: 24 }}
                hoverStyle={{ backgroundColor: C.surface }}
              >
                <Icon name="close" size={13} color={C.muted} />
              </Button>
            </View>
          )}
        </Each>

        <View style={{ gap: 6, paddingTop: 4, borderTopWidth: 1, borderTopColor: C.line }}>
          <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.secondary }}>
            {tr('Add member')}
          </Text>
          <Input
            accessibilityLabel={tr('Search sessions…')}
            placeholder={tr('Search sessions…')}
            value={query()}
            onChange={({ value }) => query.set(value)}
            style={{
              ...inputTextStyle,
              color: C.text,
              backgroundColor: C.raised,
              borderRadius: 8,
              padding: 8,
            }}
          />
          <Each of={addableSessions()} key={(s) => s.id}>
            {(session) => (
              <Button
                accessibilityLabel={session().title}
                disabled={busy()}
                onPress={() => void addMember(session().id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 8,
                }}
                hoverStyle={{ backgroundColor: C.surface }}
              >
                <Icon name="plus" size={13} color={C.accent} />
                <Text style={[{ ...bodyTextStyle, color: C.text, flex: 1 }, { numberOfLines: 1 }]}>
                  {session().title}
                </Text>
              </Button>
            )}
          </Each>
        </View>

        <If when={presets().length > 0}>
          <View style={{ gap: 6, paddingTop: 4, borderTopWidth: 1, borderTopColor: C.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.secondary, flex: 1 }}>
                {tr('Spawn from preset')}
              </Text>
              <Button
                accessibilityLabel={tr('Use isolated worktree')}
                onPress={() => useWorktree.set(!useWorktree())}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 6,
                  backgroundColor: useWorktree() ? C.surface : 'transparent',
                  borderWidth: 1,
                  borderColor: useWorktree() ? C.accent : C.line,
                }}
              >
                <Icon name="gitBranch" size={12} color={useWorktree() ? C.accent : C.muted} />
                <Text
                  style={{
                    ...captionTextStyle,
                    color: useWorktree() ? C.accent : C.muted,
                  }}
                >
                  {tr('Use isolated worktree')}
                </Text>
              </Button>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <Each of={presets()} key={(p) => p.id}>
                {(preset) => (
                  <Button
                    accessibilityLabel={preset().name}
                    disabled={busy()}
                    onPress={() => void spawnPreset(preset())}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 5,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 8,
                      backgroundColor: C.raised,
                    }}
                    hoverStyle={{ backgroundColor: C.surface }}
                  >
                    <Icon name="plus" size={12} color={C.accent} />
                    <Text style={{ ...captionTextStyle, color: C.text }}>{preset().name}</Text>
                  </Button>
                )}
              </Each>
            </View>
          </View>
        </If>

        <If when={Boolean(error())}>
          <Text style={{ ...captionTextStyle, color: C.warning }}>{error()}</Text>
        </If>
      </View>
      <DialogFooter>
        <Button
          accessibilityLabel={tr('Close')}
          onPress={props.onClose}
          disabled={busy()}
          style={controlStyle}
        >
          <Text style={{ color: C.secondary }}>{tr('Close')}</Text>
        </Button>
      </DialogFooter>
    </ModalDialog>
  );
}
