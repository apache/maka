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

import { cleanup, effect, safeAreaInsets, Scroll, signal, Text, View, token } from 'nsh';
import { SegmentedControl, isAvailable } from 'nsh/mobile';
import { ThinkingMark, ShimmerText } from '../../ui/ThinkingMark';
import { AlertDialog, ContextMenu, Input, NavPage, Sheet } from 'nsh/base';
import { hasAgentEndpoint } from '../../bridge';
import { currentLocale, tr } from '../../locale';
import {
  connectedHosts,
  connectSavedHost,
  currentDisconnectNotice,
  currentRecoveryNotice,
  dismissDisconnectNotice,
  dismissRecoveryNotice,
  hostById,
  hostStatusKind,
  isHostConnected,
  openAddComputerFlow,
  savedHosts,
  showToast,
  selectedScopeRootId,
  selectScope,
} from '../../state/hostPool';
import {
  deleteSession,
  needsAttentionSessions,
  pinnedSessions,
  recentSessions,
  refreshAllSessions,
  renameSession,
  sessionSearchQuery,
  sessionsLoading,
  setSessionSearchQuery,
  setShowingArchivedSessions,
  showingArchivedSessions,
  togglePinSession,
  workingSessions,
  filteredSessions,
  scopedBots,
  openHostBot,
  roomMembers,
  type ScopedSession,
} from '../../state/sessions';
import { spacing, type } from '../../theme/tokens';
import {
  ActionButton,
  BannerNotice,
  EmptyState,
  GroupDivider,
  GroupRow,
  Icon,
  InsetGroup,
  ScopePills,
  ScreenHeader,
  SearchField,
  StatusDot,
  type ScopePillItem,
} from '../../ui';
import { NewChatSheet } from './NewChatSheet';

function formatRelativeTime(timestampMs: number): string {
  if (!timestampMs) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return tr('Now');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return tr('{count}m', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return tr('{count}h', { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return tr('{count}d', { count: diffDay });
  try {
    return new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(
      new Date(timestampMs),
    );
  } catch {
    return '';
  }
}

function SessionRow(props: {
  item: ScopedSession;
  divider: boolean;
  onOpen: (item: ScopedSession) => void;
  onRequestRename: (item: ScopedSession) => void;
}) {
  const s = () => props.item.session;
  const workspaceName = () =>
    s().workspace?.name || s().workspace?.path?.split('/').filter(Boolean).pop() || '';
  const showComputer = () => savedHosts().length > 1 && selectedScopeRootId() === 'all';
  const attribution = () =>
    [showComputer() ? props.item.hostName : '', workspaceName()].filter(Boolean).join(' · ');

  const memberSummary = signal('');
  effect(() => {
    const { rootId, session } = props.item;
    if (session.kind !== 'room' || !isHostConnected(rootId)) return;
    let cancelled = false;
    cleanup(() => {
      cancelled = true;
    });
    void roomMembers(rootId, session.id)
      .then((members) => {
        if (!cancelled) memberSummary.set(members.map((member) => member.title).join(', '));
      })
      .catch((cause) => {
        if (!cancelled) console.warn('Room members unavailable', cause);
      });
  });

  const statusKind = () => {
    if (s().activity === 'waiting') return 'waiting' as const;
    return null;
  };

  const confirmDelete = async () => {
    const { action } = await AlertDialog.show({
      title: tr('Delete conversation?'),
      description: tr('“{title}” on {computer} will be permanently deleted.', {
        title: s().title,
        computer: props.item.hostName,
      }),
      actions: [
        { id: 'cancel', label: tr('Cancel'), role: 'cancel' },
        { id: 'delete', label: tr('Delete'), role: 'destructive' },
      ],
    });
    if (action === 'delete') {
      await deleteSession(props.item);
    }
  };

  const rowTrigger = (
    <View
      role="button"
      accessibilityLabel={tr('Conversation: {title}', { title: s().title })}
      onPress={() => props.onOpen(props.item)}
      class="active:bg-row-pressed transition-colors duration-150"
      style={{
        minHeight: 70,
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <If when={statusKind()}>
            <StatusDot kind={statusKind()!} size={8} />
          </If>
          <If when={s().kind === 'room'}>
            <Icon name="users" color={token('muted-foreground')} size={14} />
          </If>
          <If when={s().activity === 'working'}>
            <ThinkingMark size={14} />
          </If>
          <If when={s().pinned && s().activity === 'idle'}>
            <Icon name="pin" color={token('primary')} size={13} />
          </If>
          <Text
            style={{
              ...type.headline,
              fontSize: 16,
              color: token('foreground'),
              flex: 1,
              numberOfLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {s().title}
          </Text>
          <If when={s().updatedAt > 0}>
            <Text
              style={{
                ...type.caption,
                fontVariant: ['tabular-nums'],
                color: token('muted-foreground'),
              }}
            >
              {formatRelativeTime(s().updatedAt)}
            </Text>
          </If>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <If when={showComputer()}>
            <Icon name="laptop" color={token('muted-foreground')} size={13} />
          </If>
          <Text
            style={{
              ...type.footnote,
              color: token('muted-foreground'),
              flex: 1,
              numberOfLines: 1,
              textOverflow: 'ellipsis',
            }}
          >
            {attribution()}
          </Text>
          <If when={s().activity === 'waiting'}>
            <Text style={{ ...type.caption, fontWeight: '600', color: token('warning') }}>
              {tr('Needs approval')}
            </Text>
          </If>
          <If when={s().activity === 'working'}>
            <ShimmerText text={tr('Running')} style={type.caption} surface="surface" />
          </If>
          <If when={s().kind === 'room' && s().activity === 'idle'}>
            <Text style={{ ...type.caption, color: token('primary') }}>{tr('Room')}</Text>
          </If>
        </View>
      </View>

      <Icon name="chevronRight" color={token('tertiary-foreground')} size={16} strokeWidth={2.1} />
    </View>
  );

  return (
    <View>
      <ContextMenu
        title={s().title}
        items={[
          {
            id: 'pin',
            label: s().pinned ? tr('Unpin') : tr('Pin'),
            icon: s().pinned ? 'pin.slash' : 'pin',
          },
          {
            id: 'rename',
            label: tr('Rename'),
            icon: 'pencil',
          },
          {
            id: 'delete',
            label: tr('Delete'),
            icon: 'trash',
            destructive: true,
          },
        ]}
        onSelect={({ id }) => {
          if (id === 'pin') void togglePinSession(props.item);
          else if (id === 'rename') props.onRequestRename(props.item);
          else if (id === 'delete') void confirmDelete();
        }}
        trigger={rowTrigger}
      />
      <If when={props.divider}>
        <GroupDivider inset={16} />
      </If>
    </View>
  );
}

function SessionSection(props: {
  title: string;
  items: readonly ScopedSession[];
  onOpen: (item: ScopedSession) => void;
  onRequestRename: (item: ScopedSession) => void;
}) {
  return (
    <If when={props.items.length > 0}>
      <InsetGroup header={props.title}>
        <Each of={[...props.items]} key={(item) => item.key}>
          {(item, index) => (
            <SessionRow
              item={item()}
              divider={index() < props.items.length - 1}
              onOpen={props.onOpen}
              onRequestRename={props.onRequestRename}
            />
          )}
        </Each>
      </InsetGroup>
    </If>
  );
}

export function ChatListScreen(props: { onOpenSession: (item: ScopedSession) => void }) {
  const insets = safeAreaInsets();
  const newChatOpen = signal(false);
  const renamingItem = signal<ScopedSession | null>(null);
  const renameValue = signal('');
  const renamingBusy = signal(false);

  const category = signal(0);
  const hasRooms = () => filteredSessions().some((item) => item.session.kind === 'room');
  const inCategory = (items: ScopedSession[]) =>
    !hasRooms() || category() === 0
      ? items
      : items.filter((item) => item.session.kind === (category() === 2 ? 'room' : 'agent'));
  const canCompose = () =>
    connectedHosts().some(
      (c) =>
        hasAgentEndpoint(c.connection) &&
        (selectedScopeRootId() === 'all' || c.host.rootId === selectedScopeRootId()),
    );
  const botStrip = () => savedHosts().length > 1 && selectedScopeRootId() === 'all';
  const openBot = async (rootId: string, hostName: string) => {
    try {
      props.onOpenSession(await openHostBot(rootId, hostName));
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const scopeItems = (): ScopePillItem[] => [
    { id: 'all', label: tr('All') },
    ...savedHosts().map((host) => ({
      id: host.rootId,
      label: host.hostName,
      status: hostStatusKind(host.rootId),
    })),
  ];

  const hasAnySessions = () =>
    inCategory(needsAttentionSessions()).length > 0 ||
    inCategory(workingSessions()).length > 0 ||
    inCategory(pinnedSessions()).length > 0 ||
    inCategory(recentSessions()).length > 0;

  const selectedOfflineHost = () => {
    const scope = selectedScopeRootId();
    if (scope === 'all') {
      const hosts = savedHosts();
      return hosts.length > 0 && hosts.every((h) => !isHostConnected(h.rootId)) ? hosts[0] : null;
    }
    const host = hostById(scope);
    return host && !isHostConnected(host.rootId) ? host : null;
  };

  const connectedNonAgentHost = () => {
    const online = connectedHosts();
    if (!online.length) return null;
    const scope = selectedScopeRootId();
    const scoped = scope === 'all' ? online : online.filter((c) => c.host.rootId === scope);
    if (scoped.length > 0 && scoped.every((c) => !hasAgentEndpoint(c.connection))) {
      return scoped[0].host;
    }
    return null;
  };

  const recoveryBannerText = () => {
    const rec = currentRecoveryNotice();
    if (!rec) return '';
    return rec.pending > 0
      ? tr(
          'Recovered {settled, plural, one {# result} other {# results}}. {pending, plural, one {# operation is} other {# operations are}} still unconfirmed. No automatic retry.',
          { settled: rec.settled, pending: rec.pending },
        )
      : tr(
          'Recovered {settled, plural, one {# result} other {# results}}. Check the synced conversation.',
          { settled: rec.settled },
        );
  };

  const openRename = (item: ScopedSession) => {
    renameValue.set(item.session.title);
    renamingItem.set(item);
  };

  const submitRename = async () => {
    const item = renamingItem();
    if (!item || renamingBusy()) return;
    renamingBusy.set(true);
    try {
      const ok = await renameSession(item, renameValue());
      if (ok) renamingItem.set(null);
    } finally {
      renamingBusy.set(false);
    }
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={tr('Chats')}
      headerLargeTitle
      headerTransparent
      headerBackgroundOnScroll
      headerShadowVisible={false}
      ios={{
        headerRightItems: [
          {
            key: 'compose',
            symbol: 'square.and.pencil',
            label: tr('New Chat'),
            onPress: () => {
              if (canCompose()) newChatOpen.set(true);
              else openAddComputerFlow();
            },
          },
          {
            key: 'filter-menu',
            symbol: 'ellipsis.circle',
            label: tr('More'),
            menu: [
              {
                label: showingArchivedSessions()
                  ? tr('Show active chats')
                  : tr('Show archived chats'),
                onSelect: () => setShowingArchivedSessions(!showingArchivedSessions()),
              },
              {
                label: tr('Add Computer…'),
                onSelect: openAddComputerFlow,
              },
            ],
          },
        ],
      }}
      header={
        <ScreenHeader
          title={tr('Chats')}
          large
          trailing={
            <If when={canCompose()}>
              <View
                role="button"
                accessibilityLabel={tr('New Chat')}
                onPress={() => newChatOpen.set(true)}
                style={{
                  minHeight: 44,
                  minWidth: 44,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="compose" color={token('primary')} size={20} />
              </View>
            </If>
          }
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          keyboardDismissMode="interactive"
          refreshing={sessionsLoading()}
          onRefresh={() => void refreshAllSessions()}
          contentStyle={{
            flexGrow: 1,
            paddingTop: 8,
            paddingBottom: insets().bottom + spacing.tabBarClearance,
          }}
        >
          <SearchField
            value={sessionSearchQuery()}
            placeholder={tr('Search chats or projects')}
            clearLabel={tr('Clear search')}
            onChange={setSessionSearchQuery}
          />

          <If when={savedHosts().length > 1}>
            <ScopePills
              items={scopeItems()}
              selectedId={selectedScopeRootId()}
              onSelect={selectScope}
            />
          </If>

          <If
            when={
              !showingArchivedSessions() &&
              scopedBots().length > 0 &&
              (!hasRooms() || category() !== 2)
            }
          >
            <Scroll
              horizontal={botStrip()}
              scrollbar={false}
              style={{ flexGrow: 0, flexShrink: 0, marginBottom: 12 }}
              contentStyle={{ paddingHorizontal: spacing.pageX }}
            >
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Each of={scopedBots()} key={(bot) => bot.host.rootId}>
                  {(bot) => (
                    <View
                      style={{
                        flexGrow: botStrip() ? 0 : 1,
                        borderRadius: 12,
                        backgroundColor: token('surface'),
                        overflow: 'hidden',
                      }}
                    >
                      <GroupRow
                        leading={
                          bot().session?.session.activity === 'working' ? (
                            <ThinkingMark />
                          ) : (
                            <Icon name="sparkles" color={token('primary')} size={16} />
                          )
                        }
                        title={
                          botStrip() ? tr('{name} Bot', { name: bot().host.hostName }) : 'Maka Bot'
                        }
                        accessibilityLabel={
                          botStrip() ? 'Maka Bot · ' + bot().host.hostName : 'Maka Bot'
                        }
                        subtitle={botStrip() ? undefined : bot().outbox?.preview || undefined}
                        trailing={
                          bot().session?.session.activity === 'working' ? (
                            <ShimmerText
                              text={tr('Running')}
                              style={type.caption}
                              surface="surface"
                            />
                          ) : (bot().outbox?.through ?? 0) > (bot().outbox?.readThrough ?? 0) ||
                            bot().session?.session.hasUnread ? (
                            <StatusDot kind="working" size={7} />
                          ) : undefined
                        }
                        chevron={!botStrip()}
                        onPress={() => void openBot(bot().host.rootId, bot().host.hostName)}
                      />
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
          </If>

          <If when={hasRooms()}>
            <If
              when={isAvailable}
              else={
                <ScopePills
                  items={[
                    { id: '0', label: tr('All') },
                    { id: '1', label: tr('Chats') },
                    { id: '2', label: tr('Rooms') },
                  ]}
                  selectedId={String(category())}
                  onSelect={(id) => category.set(Number(id))}
                />
              }
            >
              <View style={{ paddingHorizontal: spacing.pageX, marginBottom: 12 }}>
                <SegmentedControl
                  items={[{ title: tr('All') }, { title: tr('Chats') }, { title: tr('Rooms') }]}
                  selectedIndex={category()}
                  onChange={({ index }) => category.set(index)}
                />
              </View>
            </If>
          </If>

          <If when={currentRecoveryNotice()}>
            <BannerNotice
              tone="info"
              title={recoveryBannerText()}
              onDismiss={dismissRecoveryNotice}
            />
          </If>

          <If when={currentDisconnectNotice()}>
            <BannerNotice
              tone="warning"
              title={tr('Computer disconnected')}
              detail={currentDisconnectNotice()!.reason}
              actionLabel={currentDisconnectNotice()!.rootId ? tr('Reconnect') : undefined}
              onAction={
                currentDisconnectNotice()!.rootId
                  ? () => void connectSavedHost(currentDisconnectNotice()!.rootId!)
                  : undefined
              }
              onDismiss={dismissDisconnectNotice}
            />
          </If>

          <SessionSection
            title={tr('Needs Attention')}
            items={inCategory(needsAttentionSessions())}
            onOpen={props.onOpenSession}
            onRequestRename={openRename}
          />
          <SessionSection
            title={tr('Running')}
            items={inCategory(workingSessions())}
            onOpen={props.onOpenSession}
            onRequestRename={openRename}
          />
          <SessionSection
            title={tr('Pinned')}
            items={inCategory(pinnedSessions())}
            onOpen={props.onOpenSession}
            onRequestRename={openRename}
          />
          <SessionSection
            title={showingArchivedSessions() ? tr('Archived') : tr('Recent')}
            items={inCategory(recentSessions())}
            onOpen={props.onOpenSession}
            onRequestRename={openRename}
          />

          <If when={!hasAnySessions()}>
            <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 40 }}>
              <If
                when={selectedOfflineHost()}
                else={
                  <If
                    when={connectedNonAgentHost()}
                    else={
                      <EmptyState
                        icon="chat"
                        title={
                          sessionSearchQuery().trim()
                            ? tr('No matching chats')
                            : tr('No conversations yet')
                        }
                        subtitle={
                          sessionSearchQuery().trim()
                            ? tr('Try a different search term or switch the computer filter.')
                            : tr(
                                'Start a conversation on any connected computer and it will appear here automatically.',
                              )
                        }
                        actionTitle={
                          !sessionSearchQuery().trim() && canCompose() ? tr('New Chat') : undefined
                        }
                        onAction={
                          !sessionSearchQuery().trim() && canCompose()
                            ? () => newChatOpen.set(true)
                            : undefined
                        }
                      />
                    }
                  >
                    <EmptyState
                      icon="laptop"
                      tint="success"
                      title={tr('{name} · Online', { name: connectedNonAgentHost()!.hostName })}
                      subtitle={tr(
                        'This computer is connected, and Agent conversations are not enabled on it.',
                      )}
                    />
                  </If>
                }
              >
                <EmptyState
                  icon="laptop"
                  tint="muted"
                  title={tr('{name} is offline', { name: selectedOfflineHost()!.hostName })}
                  subtitle={tr('Reconnect to sync your conversations from this computer.')}
                  actionTitle={tr('Reconnect')}
                  onAction={() => void connectSavedHost(selectedOfflineHost()!.rootId)}
                />
              </If>
            </View>
          </If>
        </Scroll>

        <NewChatSheet
          open={newChatOpen()}
          onClose={() => newChatOpen.set(false)}
          onCreated={(created) => props.onOpenSession(created)}
        />

        {/* Rename Conversation Sheet */}
        <Sheet
          open={renamingItem() !== null}
          accessibilityLabel={tr('Rename conversation')}
          detents={['medium']}
          defaultDetent="medium"
          grabber
          closeOnSwipe
          onOpenChange={({ open }) => {
            if (!open) renamingItem.set(null);
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
              paddingBottom: 14,
            }}
          >
            <Text style={{ ...type.headline, color: token('foreground') }}>
              {tr('Rename conversation')}
            </Text>
            <View
              role="button"
              accessibilityLabel={tr('Cancel')}
              onPress={() => renamingItem.set(null)}
              style={{ minHeight: 36, paddingHorizontal: 8, justifyContent: 'center' }}
            >
              <Text style={{ ...type.bodyMedium, color: token('primary') }}>{tr('Cancel')}</Text>
            </View>
          </View>
          <InsetGroup elevated>
            <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}>
              <Input
                accessibilityLabel={tr('Conversation title')}
                value={renameValue()}
                placeholder={tr('Conversation title')}
                onChange={({ value }) => renameValue.set(value)}
                style={{
                  minHeight: 40,
                  ...type.body,
                  color: token('foreground'),
                  placeholderColor: token('muted-foreground'),
                  backgroundColor: 'transparent',
                }}
              />
            </View>
          </InsetGroup>
          <View style={{ paddingHorizontal: spacing.pageX }}>
            <ActionButton
              title={tr('Save')}
              disabled={renamingBusy() || !renameValue().trim()}
              onPress={() => void submitRename()}
            />
          </View>
        </Sheet>
      </View>
    </NavPage>
  );
}
