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

import { safeAreaInsets, Scroll, Text, View, token } from 'nsh';
import { NavPage } from 'nsh/base';
import { currentLocale, tr } from '../../locale';
import { hasAgentEndpoint } from '../../bridge';
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
  selectedScopeRootId,
  selectScope,
} from '../../state/hostPool';
import {
  needsAttentionSessions,
  pinnedSessions,
  recentSessions,
  refreshAllSessions,
  sessionSearchQuery,
  sessionsLoading,
  setSessionSearchQuery,
  setShowingArchivedSessions,
  showingArchivedSessions,
  workingSessions,
  type ScopedSession,
} from '../../state/sessions';
import { spacing, type } from '../../theme/tokens';
import {
  BannerNotice,
  EmptyState,
  GroupDivider,
  Icon,
  InsetGroup,
  ScopePills,
  ScreenHeader,
  SearchField,
  StatusDot,
  type ScopePillItem,
} from '../../ui';

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
}) {
  const s = () => props.item.session;
  const workspaceName = () =>
    s().workspace?.name || s().workspace?.path?.split('/').filter(Boolean).pop() || '';
  const attribution = () =>
    workspaceName() ? props.item.hostName + ' · ' + workspaceName() : props.item.hostName;

  const statusKind = () => {
    if (s().activity === 'waiting') return 'waiting' as const;
    if (s().activity === 'working') return 'working' as const;
    return null;
  };

  return (
    <View>
      <View
        role="button"
        accessibilityLabel={tr('Conversation: {title}', { title: s().title })}
        onPress={() => props.onOpen(props.item)}
        class="active:bg-row-pressed transition-colors duration-150"
        style={{
          minHeight: 68,
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
            <Text
              numberOfLines={1}
              style={{
                ...type.headline,
                fontSize: 16,
                color: token('foreground'),
                flex: 1,
              }}
            >
              {s().title}
            </Text>
            <If when={s().updatedAt > 0}>
              <Text
                style={{
                  ...type.caption,
                  fontVariant: ['tabular-nums'],
                  color: token('tertiary-foreground'),
                }}
              >
                {formatRelativeTime(s().updatedAt)}
              </Text>
            </If>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="laptop" color={token('muted-foreground')} size={13} />
            <Text
              numberOfLines={1}
              style={{
                ...type.footnote,
                color: token('muted-foreground'),
                flex: 1,
              }}
            >
              {attribution()}
            </Text>
            <If when={s().kind === 'room'}>
              <Text
                style={{
                  ...type.caption,
                  color: token('primary'),
                }}
              >
                {tr('Room')}
              </Text>
            </If>
          </View>
        </View>

        <Icon
          name="chevronRight"
          color={token('tertiary-foreground')}
          size={16}
          strokeWidth={2.1}
        />
      </View>
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
            />
          )}
        </Each>
      </InsetGroup>
    </If>
  );
}

export function ChatListScreen(props: { onOpenSession: (item: ScopedSession) => void }) {
  const insets = safeAreaInsets();

  const scopeItems = (): ScopePillItem[] => [
    { id: 'all', label: tr('All Computers') },
    ...savedHosts().map((host) => ({
      id: host.rootId,
      label: host.hostName,
      status: hostStatusKind(host.rootId),
    })),
  ];

  const hasAnySessions = () =>
    needsAttentionSessions().length > 0 ||
    workingSessions().length > 0 ||
    pinnedSessions().length > 0 ||
    recentSessions().length > 0;

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
            key: 'add-computer',
            symbol: 'plus',
            label: tr('Add Computer'),
            onPress: openAddComputerFlow,
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
      header={<ScreenHeader title={tr('Chats')} large />}
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          keyboardDismissMode="interactive"
          refreshing={sessionsLoading()}
          onRefresh={() => void refreshAllSessions()}
          contentContainerStyle={{
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

          <If when={savedHosts().length > 0}>
            <ScopePills
              items={scopeItems()}
              selectedId={selectedScopeRootId()}
              onSelect={selectScope}
            />
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
            items={needsAttentionSessions()}
            onOpen={props.onOpenSession}
          />
          <SessionSection
            title={tr('In Progress')}
            items={workingSessions()}
            onOpen={props.onOpenSession}
          />
          <SessionSection
            title={tr('Pinned')}
            items={pinnedSessions()}
            onOpen={props.onOpenSession}
          />
          <SessionSection
            title={showingArchivedSessions() ? tr('Archived') : tr('Recent')}
            items={recentSessions()}
            onOpen={props.onOpenSession}
          />

          <If when={!hasAnySessions()}>
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
          </If>
        </Scroll>
      </View>
    </NavPage>
  );
}

/** Lightweight M1 detail view pushed when tapping a conversation row (M2 expands into full chat). */
export function ChatDetailScreen(props: { item: ScopedSession; onBack: () => void }) {
  const insets = safeAreaInsets();
  const s = () => props.item.session;
  const workspace = () => s().workspace?.name || s().workspace?.path || tr('Default workspace');

  return (
    <NavPage
      style={{ flex: 1 }}
      title={s().title}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      header={<ScreenHeader title={s().title} backLabel={tr('Chats')} onBack={props.onBack} />}
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingTop: 16,
            paddingBottom: Math.max(insets().bottom, 20) + 24,
          }}
        >
          <InsetGroup header={tr('Conversation')}>
            <View style={{ paddingHorizontal: 16, paddingVertical: 14, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StatusDot kind={hostStatusKind(props.item.rootId)} size={8} />
                <Text style={{ ...type.headline, color: token('foreground') }}>
                  {props.item.hostName}
                </Text>
              </View>
              <Text style={{ ...type.subheadline, color: token('muted-foreground') }}>
                {workspace()}
              </Text>
            </View>
          </InsetGroup>
        </Scroll>
      </View>
    </NavPage>
  );
}
