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

import { batch, effect, signal, Text, View } from 'nsh';
import { Button, Input } from 'nsh/base';
import type {
  AgentCreated,
  AgentRoomDeliveryState,
  AgentRoomMember,
  AgentRoomMessage,
  AgentSession,
} from '../../../../packages/plugin-sdk/src/index.js';
import type { Host, Output } from './host';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { ModalDialog, DialogHeader, DialogFooter } from './ModalDialog';
import { tr } from './locale';
import {
  roomAvatarColor,
  roomAvatarInitial,
  roomDeliveryReasonKey,
  roomResult,
  workspaceTailName,
} from './roomMessage';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlFocusStyle,
  controlStyle,
  inputTextStyle,
} from './ui';

type PresetSummary = Output<'agent', 'presets'>[number];
type SearchMatch = Output<'agent', 'roomSearch'>['items'][number];

/** Compact war-room status bar under the header: workspace badge, topic, live roster & attention banner. */
export function RoomRosterBar(props: {
  workspacePath(): string | undefined;
  topic(): string;
  members(): readonly AgentRoomMember[];
  pinnedCount(): number;
  searchOpen(): boolean;
  pinnedOpen(): boolean;
  onToggleSearch(): void;
  onTogglePinned(): void;
  onOpenMembers(): void;
  onEditTopic(): void;
  onOpenAgent(id: string): void;
}) {
  const activeMembers = () => props.members().filter((m) => !m.unavailable);
  const waitingMembers = () =>
    activeMembers().filter((m) => m.activity === 'waiting' || (m.pendingInteractions ?? 0) > 0);
  const workingCount = () => activeMembers().filter((m) => m.activity === 'working').length;

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.panel }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 20,
          paddingVertical: 8,
          flexWrap: 'wrap',
        }}
      >
        <If when={Boolean(props.workspacePath())}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              paddingHorizontal: 8,
              paddingVertical: 3,
              borderRadius: 6,
              backgroundColor: C.surface,
            }}
          >
            <Icon name="folder" size={12} color={C.muted} />
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {workspaceTailName(props.workspacePath()!)}
            </Text>
          </View>
        </If>

        <Button
          accessibilityLabel={tr('Edit room topic')}
          onPress={props.onEditTopic}
          style={{
            flex: 1,
            minWidth: 120,
            paddingHorizontal: 6,
            paddingVertical: 3,
            borderRadius: 6,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={controlFocusStyle()}
        >
          <Text
            style={[
              {
                ...captionTextStyle,
                color: props.topic() ? C.secondary : C.muted,
              },
              { numberOfLines: 1 },
            ]}
          >
            {props.topic() || tr('Room topic (optional)')}
          </Text>
        </Button>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Each of={activeMembers().slice(0, 6)} key={(m) => m.sessionId}>
            {(member) => (
              <Button
                accessibilityLabel={member().title}
                onPress={() => props.onOpenAgent(member().sessionId)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  borderRadius: 12,
                  backgroundColor: member().activity === 'waiting' ? C.surface : 'transparent',
                  borderWidth: 1,
                  borderColor:
                    member().activity === 'waiting'
                      ? C.warning
                      : member().activity === 'working'
                        ? C.accent
                        : C.line,
                }}
                hoverStyle={{ backgroundColor: C.surface }}
                focusStyle={controlFocusStyle()}
              >
                <View
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    backgroundColor: roomAvatarColor(member().sessionId),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 9, fontWeight: '600', color: '#FFFFFF' }}>
                    {roomAvatarInitial(member().title)}
                  </Text>
                </View>
                <Text
                  style={[
                    { ...captionTextStyle, color: C.text, maxWidth: 110 },
                    { numberOfLines: 1 },
                  ]}
                >
                  {member().title}
                </Text>
                <If when={member().activity === 'working'}>
                  <LoadingIndicator size={10} color={C.accent} />
                </If>
                <If when={member().activity === 'waiting'}>
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: C.warning,
                    }}
                  />
                </If>
              </Button>
            )}
          </Each>

          <Button
            accessibilityLabel={tr('Members')}
            onPress={props.onOpenMembers}
            style={{
              ...controlStyle,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              paddingHorizontal: 8,
              minHeight: 26,
            }}
            hoverStyle={{ backgroundColor: C.surface }}
            focusStyle={controlFocusStyle()}
          >
            <Icon name="plus" size={13} color={C.secondary} />
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {activeMembers().length > 0
                ? String(activeMembers().length) +
                  (workingCount() > 0 ? ' · ' + String(workingCount()) : '')
                : tr('Members')}
            </Text>
          </Button>

          <If when={props.pinnedCount() > 0}>
            <Button
              accessibilityLabel={tr('Pinned messages')}
              onPress={props.onTogglePinned}
              style={{
                ...controlStyle,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 8,
                minHeight: 26,
                backgroundColor: props.pinnedOpen() ? C.surface : 'transparent',
              }}
              hoverStyle={{ backgroundColor: C.surface }}
              focusStyle={controlFocusStyle()}
            >
              <Icon name="pin" size={13} color={props.pinnedOpen() ? C.accent : C.secondary} />
              <Text
                style={{
                  ...captionTextStyle,
                  color: props.pinnedOpen() ? C.accent : C.secondary,
                }}
              >
                {String(props.pinnedCount())}
              </Text>
            </Button>
          </If>

          <Button
            accessibilityLabel={tr('Search messages')}
            onPress={props.onToggleSearch}
            style={{
              ...controlStyle,
              minHeight: 26,
              paddingHorizontal: 7,
              backgroundColor: props.searchOpen() ? C.surface : 'transparent',
            }}
            hoverStyle={{ backgroundColor: C.surface }}
            focusStyle={controlFocusStyle()}
          >
            <Icon name="search" size={14} color={props.searchOpen() ? C.accent : C.secondary} />
          </Button>
        </View>
      </View>

      <If when={waitingMembers().length > 0}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 20,
            paddingVertical: 7,
            backgroundColor: C.surface,
            borderTopWidth: 1,
            borderTopColor: C.line,
          }}
        >
          <Icon name="approval" size={14} color={C.warning} />
          <Text style={{ ...captionTextStyle, color: C.warning, flex: 1 }}>
            {tr('Waiting for your input', {
              names: waitingMembers()
                .map((m) => '@' + m.title)
                .join(', '),
            })}
          </Text>
          <Button
            accessibilityLabel={tr('Open to respond')}
            onPress={() => props.onOpenAgent(waitingMembers()[0]!.sessionId)}
            style={{
              ...controlStyle,
              minHeight: 24,
              paddingHorizontal: 10,
              backgroundColor: C.raised,
            }}
            hoverStyle={{ backgroundColor: C.card }}
            focusStyle={controlFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Open to respond')}</Text>
          </Button>
        </View>
      </If>
    </View>
  );
}

/** Expandable list of pinned Room conclusions with one-click jump. */
export function RoomPinnedBar(props: {
  pinned(): readonly AgentRoomMessage[];
  name(id: string): string;
  onJump(messageId: string): void;
  onUnpin(messageId: string): void;
  onClose(): void;
}) {
  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: C.line,
        backgroundColor: C.surface,
        paddingHorizontal: 20,
        paddingVertical: 10,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="pin" size={13} color={C.accent} />
        <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.text, flex: 1 }}>
          {tr('Pinned messages')}
        </Text>
        <Button
          accessibilityLabel={tr('Cancel')}
          onPress={props.onClose}
          style={{ ...controlStyle, minHeight: 22 }}
        >
          <Icon name="close" size={13} color={C.muted} />
        </Button>
      </View>
      <Each of={props.pinned()} key={(m) => m.id}>
        {(msg) => (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Button
              accessibilityLabel={msg().content.text || tr('View replied message')}
              onPress={() => props.onJump(msg().id)}
              style={{
                flex: 1,
                borderLeftWidth: 2,
                borderLeftColor: C.accent,
                paddingLeft: 10,
                paddingVertical: 4,
              }}
              hoverStyle={{ backgroundColor: C.raised }}
            >
              <Text style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 2 }]}>
                {msg().content.text}
              </Text>
            </Button>
            <Button
              accessibilityLabel={tr('Unpin message')}
              onPress={() => props.onUnpin(msg().id)}
              style={{ ...controlStyle, minHeight: 22 }}
              hoverStyle={{ backgroundColor: C.raised }}
            >
              <Icon name="close" size={12} color={C.muted} />
            </Button>
          </View>
        )}
      </Each>
    </View>
  );
}

/** Inline full-text search panel inside a Room. */
export function RoomSearchPanel(props: {
  sessionId: string;
  host: Host;
  name(id: string): string;
  onJump(messageId: string): void;
  onClose(): void;
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
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: C.line,
        backgroundColor: C.surface,
        paddingHorizontal: 20,
        paddingVertical: 10,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="search" size={14} color={C.muted} />
        <Input
          autoFocus
          accessibilityLabel={tr('Search messages…')}
          placeholder={tr('Search messages…')}
          value={query()}
          onChange={({ value }) => query.set(value)}
          style={{
            ...inputTextStyle,
            color: C.text,
            flex: 1,
            backgroundColor: C.raised,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        />
        <Button
          accessibilityLabel={tr('Cancel')}
          onPress={props.onClose}
          style={{ ...controlStyle, minHeight: 26 }}
        >
          <Icon name="close" size={14} color={C.muted} />
        </Button>
      </View>
      <If when={loading()}>
        <LoadingIndicator />
      </If>
      <If when={Boolean(error())}>
        <Text style={{ ...captionTextStyle, color: C.warning }}>{error()}</Text>
      </If>
      <If when={!loading() && Boolean(query().trim()) && results().length === 0 && !error()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('No matching messages')}</Text>
      </If>
      <Each of={results().slice(0, 8)} key={(item) => item.message.id}>
        {(item) => {
          const author = () => {
            const a = item().message.author;
            return a.kind === 'human' ? tr('You') : props.name(a.execution.sessionId);
          };
          return (
            <Button
              accessibilityLabel={item().snippet}
              onPress={() => {
                props.onJump(item().message.id);
                props.onClose();
              }}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: C.raised,
                gap: 2,
              }}
              hoverStyle={{ backgroundColor: C.card }}
            >
              <Text style={{ ...captionTextStyle, fontWeight: '600', color: C.secondary }}>
                {author()}
              </Text>
              <Text style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 2 }]}>
                {item().snippet}
              </Text>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}

/** Derived execution strip under a Room message with @mentions. */
export function RoomDeliveryStrip(props: {
  states: readonly AgentRoomDeliveryState[];
  name(id: string): string;
  onOpenAgent(id: string): void;
  onJumpMessage(id: string): void;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 2 }}>
      <Each of={props.states} key={(st) => st.sessionId + ':' + st.kind}>
        {(st) => {
          const label = () => {
            const s = st();
            const who = '@' + props.name(s.sessionId);
            switch (s.kind) {
              case 'queued':
                return who + ' · ' + tr('Delivery queued');
              case 'working':
                return who + ' · ' + tr('Delivery working');
              case 'waiting':
                return who + ' · ' + tr('Delivery waiting');
              case 'replied':
                return who + ' · ' + tr('Delivery replied');
              case 'silent':
                return who + ' · ' + tr('Delivery silent');
              case 'failed':
                return who + ' · ' + tr('Delivery failed');
              case 'stopped':
                return who + ' · ' + tr('Delivery stopped');
              case 'rejected': {
                const key = roomDeliveryReasonKey(s.reason);
                return tr('Mention delivery failed: {reason}', {
                  reason: key ? tr(key) : s.reason,
                });
              }
            }
          };
          const tone = () => {
            switch (st().kind) {
              case 'waiting':
              case 'silent':
              case 'rejected':
              case 'failed':
                return C.warning;
              case 'working':
              case 'replied':
                return C.accent;
              default:
                return C.muted;
            }
          };
          const handlePress = () => {
            const s = st();
            if (s.kind === 'replied') props.onJumpMessage(s.replyMessageId);
            else props.onOpenAgent(s.sessionId);
          };
          return (
            <Button
              accessibilityLabel={label()}
              onPress={handlePress}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 8,
                backgroundColor: C.surface,
              }}
              hoverStyle={{ backgroundColor: C.raised }}
              focusStyle={controlFocusStyle()}
            >
              <If when={st().kind === 'working'}>
                <LoadingIndicator size={10} color={C.accent} />
              </If>
              <If when={st().kind === 'waiting'}>
                <Icon name="approval" size={11} color={C.warning} />
              </If>
              <If when={st().kind === 'replied'}>
                <Icon name="statusSuccess" size={11} color={C.accent} />
              </If>
              <If when={st().kind === 'silent'}>
                <Icon name="statusUnknown" size={11} color={C.warning} />
              </If>
              <If when={st().kind === 'failed' || st().kind === 'rejected'}>
                <Icon name="statusError" size={11} color={C.warning} />
              </If>
              <If when={st().kind === 'stopped'}>
                <Icon name="statusStopped" size={11} color={C.muted} />
              </If>
              <If when={st().kind === 'queued'}>
                <Icon name="queue" size={11} color={C.muted} />
              </If>
              <Text style={{ ...captionTextStyle, color: tone() }}>{label()}</Text>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}

/** Modal to inspect/manage Room roster, add existing sessions, or spawn new Agents from Subagent Presets. */
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
      .filter((s) => !s.archived && s.id !== props.sessionId && !memberIds().has(s.id))
      .slice(0, 6);

  const addMember = async (memberId: string) => {
    if (busy()) return;
    busy.set(true);
    error.set('');
    try {
      roomResult(
        (
          await props.host.control('roomManage', {
            sessionId: props.sessionId,
            action: { kind: 'add_members', memberSessionIds: [memberId] },
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

  const removeMember = async (memberId: string) => {
    if (busy()) return;
    busy.set(true);
    error.set('');
    try {
      roomResult(
        (
          await props.host.control('roomManage', {
            sessionId: props.sessionId,
            action: { kind: 'remove_member', memberSessionId: memberId },
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
    if (busy()) return;
    busy.set(true);
    error.set('');
    try {
      const workspace =
        useWorktree() && props.workspacePath
          ? { kind: 'isolated_git' as const, path: props.workspacePath }
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
              role: preset.name,
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
