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

import { hostQuery, type AgentObservation } from './bridge';
import { effect, Overlay, safeAreaInsets, signal, Text, View, token } from 'nsh';
import { createNavStack, NavStack, Toast, ToastStack } from 'nsh/base';
import { isAvailable, TabBar, type TabBarItem } from 'nsh/mobile';
import { tr } from './locale';
import { ChatListScreen } from './screens/chats/ChatListScreen';
import { ChatScreen } from './screens/chats/ChatScreen';
import { DiffScreen } from './screens/chats/DiffScreen';
import { ProjectFilesScreen } from './screens/chats/ProjectFilesScreen';
import { InboxScreen } from './screens/inbox/InboxScreen';
import { ReviewDetailScreen } from './screens/inbox/ReviewDetailScreen';
import { AdvancedConnectSheet } from './screens/onboarding/AdvancedConnectSheet';
import { ConfirmDeviceScreen } from './screens/onboarding/ConfirmDeviceScreen';
import { ScanScreen } from './screens/onboarding/ScanScreen';
import { WelcomeScreen } from './screens/onboarding/WelcomeScreen';
import { ComputerSettingsScreen } from './screens/settings/ComputerSettingsScreen';
import { DeviceDetailScreen } from './screens/settings/DeviceDetailScreen';
import type { HostSettingDomain } from './screens/settings/hostSettingDomains';
import {
  SubagentsSettingsScreen,
  SubagentEditor,
} from './screens/settings/SubagentsSettingsScreen';
import {
  PluginsSettingsScreen,
  PluginDetailScreen,
} from './screens/settings/PluginsSettingsScreen';
import {
  McpSettingsScreen,
  McpServerEditor,
  type McpTarget,
} from './screens/settings/McpSettingsScreen';
import {
  SkillsSettingsScreen,
  SkillDetailScreen,
  type SkillTarget,
} from './screens/settings/SkillsSettingsScreen';
import { GeneralSettingsScreen } from './screens/settings/GeneralSettingsScreen';
import { ModelsSettingsScreen, ProviderPicker } from './screens/settings/ModelsSettingsScreen';
import {
  ConnectionFormScreen,
  type ConnectionTarget,
} from './screens/settings/ConnectionFormScreen';
import { ConnectionModelScreen } from './screens/settings/ConnectionModelScreen';
import { WebSearchSettingsScreen } from './screens/settings/WebSearchSettingsScreen';
import { NetworkSettingsScreen } from './screens/settings/NetworkSettingsScreen';
import { SettingsRootScreen } from './screens/settings/SettingsRootScreen';
import type { ParsedDiffFile } from './state/chat';
import {
  closeAddComputerFlow,
  currentDeepLink,
  showToast,
  clearDeepLink,
  currentPendingTicket,
  currentToastMessage,
  dismissToast,
  hasPairedHosts,
  hostBootstrapError,
  isBootstrapped,
  isPairingModalOpen,
  startHostPool,
  hostById,
} from './state/hostPool';
import { startInboxStore, totalPendingCount, type InboxItem } from './state/inbox';
import { hapticSelection } from './state/preferences';
import { findScopedSession, startSessionsStore, type ScopedSession } from './state/sessions';
import { type } from './theme/tokens';
import { BannerNotice } from './ui';

type OnboardingRoute = { name: 'welcome' } | { name: 'scan' } | { name: 'confirm' };
type ChatsRoute =
  | { name: 'list' }
  | { name: 'chat'; item: ScopedSession }
  | { name: 'files'; item: ScopedSession }
  | { name: 'diff'; item: ScopedSession; file: ParsedDiffFile };
type InboxRoute = { name: 'list' } | { name: 'review'; item: InboxItem };
type SettingsRoute =
  | { name: 'preset'; rootId: string; presetId: string | null }
  | { name: 'plugin'; rootId: string; instance: string[] }
  | { name: 'mcpServer'; rootId: string; target: McpTarget }
  | { name: 'skill'; rootId: string; target: SkillTarget }
  | { name: 'root' }
  | { name: 'device'; rootId: string }
  | { name: 'computer'; rootId: string }
  | { name: 'hostSetting'; domain: HostSettingDomain; rootId: string; backLabel?: string }
  | { name: 'providers'; rootId: string; catalogRevision: number }
  | { name: 'connection'; rootId: string; target: ConnectionTarget; backLabel?: string }
  | {
      name: 'model';
      rootId: string;
      connectionId: string;
      modelId: string;
      connectionName: string;
    };

function OnboardingFlow(props: { isModal: boolean }) {
  const nav = createNavStack<OnboardingRoute>([{ name: 'welcome' }]);

  const pushConfirm = () => {
    const routes = nav.routes();
    if (routes[routes.length - 1]?.name !== 'confirm') {
      nav.push({ name: 'confirm' });
    }
  };

  effect(() => {
    if (!currentPendingTicket()) {
      const routes = nav.routes();
      if (routes[routes.length - 1]?.name === 'confirm') {
        nav.popToRoot();
      }
    }
  });

  effect(() => {
    const link = currentDeepLink();
    if (link?.target === 'scan') {
      clearDeepLink();
      const routes = nav.routes();
      if (routes[routes.length - 1]?.name !== 'scan') {
        nav.push({ name: 'scan' });
      }
    }
  });

  return (
    <View style={{ flex: 1, backgroundColor: token('canvas') }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => {
          if (route.name === 'scan') {
            return <ScanScreen onBack={() => nav.pop()} onTicketReady={pushConfirm} />;
          }
          if (route.name === 'confirm') {
            return (
              <ConfirmDeviceScreen
                onCancelled={() => nav.popToRoot()}
                onConfirmed={() => nav.popToRoot()}
              />
            );
          }
          return (
            <WelcomeScreen
              onStartScan={() => nav.push({ name: 'scan' })}
              onCloseModal={props.isModal ? closeAddComputerFlow : undefined}
            />
          );
        }}
      </NavStack>
      <AdvancedConnectSheet onTicketReady={pushConfirm} />
    </View>
  );
}

function MainTabShell() {
  const activeTab = signal(0);
  const chatsNav = createNavStack<ChatsRoute>([{ name: 'list' }]);
  const inboxNav = createNavStack<InboxRoute>([{ name: 'list' }]);
  const modelSettingsRevision = signal(0);
  const modelSettingsChanged = () => modelSettingsRevision.update((value) => value + 1);
  const settingsNav = createNavStack<SettingsRoute>([{ name: 'root' }]);

  const tabItems = (): TabBarItem[] => {
    const pending = totalPendingCount();
    return [
      {
        title: tr('Chats'),
        icon: 'bubble.left.and.bubble.right',
      },
      {
        title: tr('Pending'),
        icon: pending > 0 ? 'tray.full' : 'tray',
        badge: pending > 0 ? String(pending) : undefined,
      },
      {
        title: tr('Settings'),
        icon: 'gearshape',
      },
    ];
  };

  effect(() => {
    const link = currentDeepLink();
    if (!link || link.target === 'scan') return;
    clearDeepLink();
    if (link.target === 'chats') activeTab.set(0);
    else if (link.target === 'pending') activeTab.set(1);
    else if (link.target === 'settings') activeTab.set(2);
  });

  const handleTabChange = (index: number) => {
    hapticSelection();
    if (index === activeTab()) {
      if (index === 0) chatsNav.popToRoot();
      else if (index === 1) inboxNav.popToRoot();
      else if (index === 2) settingsNav.popToRoot();
      return;
    }
    activeTab.set(index);
  };

  const jumpToConversation = (rootId: string, sessionId: string, hostName: string) => {
    void (async () => {
      const existing = findScopedSession(rootId, sessionId);
      const item: ScopedSession = existing ?? {
        key: rootId + '::' + sessionId,
        rootId,
        hostName,
        session: (
          await hostQuery<AgentObservation>('agent', 'observe', { sessionId }, undefined, rootId)
        ).session,
      };
      chatsNav.setRoutes([{ name: 'list' }, { name: 'chat', item }]);
      activeTab.set(0);
    })().catch((cause) => showToast(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
      {/* Tab 1: Chats */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          display: activeTab() === 0 ? 'flex' : 'none',
        }}
      >
        <NavStack state={chatsNav} style={{ flex: 1 }}>
          {(route) => {
            if (route.name === 'chat') {
              return (
                <ChatScreen
                  item={route.item}
                  onBack={() => chatsNav.pop()}
                  onOpenProjectFiles={(item) => chatsNav.push({ name: 'files', item })}
                />
              );
            }
            if (route.name === 'files') {
              return (
                <ProjectFilesScreen
                  item={route.item}
                  onBack={() => chatsNav.pop()}
                  onOpenDiff={(file) => chatsNav.push({ name: 'diff', item: route.item, file })}
                  onQuotedBackToChat={() => chatsNav.pop()}
                />
              );
            }
            if (route.name === 'diff') {
              return (
                <DiffScreen
                  rootId={route.item.rootId}
                  sessionId={route.item.session.id}
                  file={route.file}
                  onBack={() => chatsNav.pop()}
                  onQuotedBackToChat={() => chatsNav.pop(2)}
                />
              );
            }
            return (
              <ChatListScreen onOpenSession={(item) => chatsNav.push({ name: 'chat', item })} />
            );
          }}
        </NavStack>
      </View>

      {/* Tab 2: Pending Inbox */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          display: activeTab() === 1 ? 'flex' : 'none',
        }}
      >
        <NavStack state={inboxNav} style={{ flex: 1 }}>
          {(route) => {
            if (route.name === 'review') {
              return (
                <ReviewDetailScreen
                  item={route.item}
                  onBack={() => inboxNav.pop()}
                  onOpenConversation={jumpToConversation}
                />
              );
            }
            return <InboxScreen onOpenItem={(item) => inboxNav.push({ name: 'review', item })} />;
          }}
        </NavStack>
      </View>

      {/* Tab 3: Settings */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          display: activeTab() === 2 ? 'flex' : 'none',
        }}
      >
        <NavStack state={settingsNav} style={{ flex: 1 }}>
          {(route) => {
            if (route.name === 'computer') {
              return (
                <ComputerSettingsScreen
                  rootId={route.rootId}
                  onBack={() => settingsNav.pop()}
                  onOpen={(domain, rootId) =>
                    settingsNav.push({
                      name: 'hostSetting',
                      domain,
                      rootId,
                      backLabel: hostById(rootId)?.hostName,
                    })
                  }
                />
              );
            }
            if (route.name === 'device') {
              return <DeviceDetailScreen rootId={route.rootId} onBack={() => settingsNav.pop()} />;
            }
            const active = () =>
              !isPairingModalOpen() && activeTab() === 2 && settingsNav.routes().at(-1) === route;
            const back = () => settingsNav.pop();
            if (route.name === 'providers') {
              return (
                <ProviderPicker
                  active={active}
                  rootId={route.rootId}
                  backLabel={tr('Models & Connections')}
                  onBack={back}
                  onSelect={(provider) =>
                    settingsNav.push({
                      name: 'connection',
                      rootId: route.rootId,
                      target: { provider, catalogRevision: route.catalogRevision },
                      backLabel: tr('Provider'),
                    })
                  }
                />
              );
            }
            if (route.name === 'connection') {
              return (
                <ConnectionFormScreen
                  active={active}
                  rootId={route.rootId}
                  onBack={back}
                  target={route.target}
                  backLabel={route.backLabel ?? tr('Models & Connections')}
                  version={modelSettingsRevision()}
                  onChanged={modelSettingsChanged}
                  openModel={(connectionId, connectionName, modelId) =>
                    settingsNav.push({
                      name: 'model',
                      rootId: route.rootId,
                      connectionId,
                      connectionName,
                      modelId,
                    })
                  }
                />
              );
            }
            if (route.name === 'model') {
              return (
                <ConnectionModelScreen
                  active={active}
                  rootId={route.rootId}
                  onBack={back}
                  backLabel={route.connectionName}
                  connectionId={route.connectionId}
                  modelId={route.modelId}
                  onSaved={modelSettingsChanged}
                />
              );
            }
            if (route.name === 'preset')
              return (
                <SubagentEditor
                  rootId={route.rootId}
                  active={active}
                  onBack={back}
                  presetId={route.presetId}
                />
              );
            if (route.name === 'plugin')
              return (
                <PluginDetailScreen
                  rootId={route.rootId}
                  active={active}
                  onBack={back}
                  instance={route.instance}
                />
              );
            if (route.name === 'mcpServer')
              return (
                <McpServerEditor
                  rootId={route.rootId}
                  active={active}
                  onBack={back}
                  target={route.target}
                />
              );
            if (route.name === 'skill')
              return (
                <SkillDetailScreen
                  rootId={route.rootId}
                  active={active}
                  onBack={back}
                  target={route.target}
                />
              );
            if (route.name === 'hostSetting') {
              const backLabel = route.backLabel ?? tr('Settings');
              switch (route.domain) {
                case 'subagents':
                  return (
                    <SubagentsSettingsScreen
                      rootId={route.rootId}
                      active={active}
                      onBack={back}
                      backLabel={backLabel}
                      open={(presetId) =>
                        settingsNav.push({ name: 'preset', rootId: route.rootId, presetId })
                      }
                    />
                  );
                case 'plugins':
                  return (
                    <PluginsSettingsScreen
                      rootId={route.rootId}
                      active={active}
                      onBack={back}
                      backLabel={backLabel}
                      open={(instance) =>
                        settingsNav.push({ name: 'plugin', rootId: route.rootId, instance })
                      }
                    />
                  );
                case 'mcp':
                  return (
                    <McpSettingsScreen
                      rootId={route.rootId}
                      active={active}
                      onBack={back}
                      backLabel={backLabel}
                      open={(target) =>
                        settingsNav.push({ name: 'mcpServer', rootId: route.rootId, target })
                      }
                    />
                  );
                case 'skills':
                  return (
                    <SkillsSettingsScreen
                      rootId={route.rootId}
                      active={active}
                      onBack={back}
                      backLabel={backLabel}
                      open={(target) =>
                        settingsNav.push({ name: 'skill', rootId: route.rootId, target })
                      }
                    />
                  );
                case 'general':
                  return (
                    <GeneralSettingsScreen
                      active={active}
                      rootId={route.rootId}
                      onBack={back}
                      backLabel={backLabel}
                    />
                  );
                case 'models':
                  return (
                    <ModelsSettingsScreen
                      active={active}
                      rootId={route.rootId}
                      onBack={back}
                      backLabel={backLabel}
                      revision={modelSettingsRevision()}
                      openConnection={(row) =>
                        settingsNav.push({
                          name: 'connection',
                          rootId: route.rootId,
                          target: { connectionId: row.basis.connectionId },
                        })
                      }
                      openProviders={(catalogRevision) =>
                        settingsNav.push({
                          name: 'providers',
                          rootId: route.rootId,
                          catalogRevision,
                        })
                      }
                    />
                  );
                case 'network':
                  return (
                    <NetworkSettingsScreen
                      active={active}
                      rootId={route.rootId}
                      onBack={back}
                      backLabel={backLabel}
                    />
                  );
                case 'web_search':
                  return (
                    <WebSearchSettingsScreen
                      active={active}
                      rootId={route.rootId}
                      onBack={back}
                      backLabel={backLabel}
                    />
                  );
              }
            }
            return (
              <SettingsRootScreen
                onOpenComputer={(rootId) => settingsNav.push({ name: 'computer', rootId })}
                onOpenDevice={(rootId) => settingsNav.push({ name: 'device', rootId })}
                onOpenHostSetting={(domain, rootId) =>
                  settingsNav.push({ name: 'hostSetting', domain, rootId })
                }
              />
            );
          }}
        </NavStack>
      </View>

      <If
        when={
          (activeTab() === 0 && chatsNav.routes().length === 1) ||
          (activeTab() === 1 && inboxNav.routes().length === 1) ||
          (activeTab() === 2 && settingsNav.routes().length === 1)
        }
      >
        {/* Native iOS UITabBar (Liquid Glass on iOS 26+) */}
        <If
          when={isAvailable}
          else={
            <View
              testID="main-tab-bar"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: 54,
                backgroundColor: token('surface'),
                borderTopWidth: 0.5,
                borderTopColor: token('separator'),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-around',
              }}
            >
              <Each of={tabItems()} key={(item) => item.title}>
                {(item, index) => (
                  <View
                    role="button"
                    accessibilityLabel={item().title}
                    onPress={() => handleTabChange(index())}
                    style={{
                      flex: 1,
                      minHeight: 44,
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexDirection: 'row',
                      gap: 4,
                    }}
                  >
                    <Text
                      style={{
                        ...type.footnote,
                        fontWeight: activeTab() === index() ? '600' : '400',
                        color:
                          activeTab() === index() ? token('primary') : token('muted-foreground'),
                      }}
                    >
                      {item().title}
                    </Text>
                    <If when={item().badge}>
                      <Text
                        style={{
                          ...type.caption,
                          fontWeight: '700',
                          color: token('primary'),
                        }}
                      >
                        {item().badge}
                      </Text>
                    </If>
                  </View>
                )}
              </Each>
            </View>
          }
        >
          <TabBar
            testID="main-tab-bar"
            items={tabItems()}
            selectedIndex={activeTab()}
            onChange={({ index }) => handleTabChange(index)}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
            }}
          />
        </If>
      </If>
    </View>
  );
}

export function App() {
  const insets = safeAreaInsets();
  startHostPool();
  startSessionsStore();
  startInboxStore();

  return (
    <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
      <If
        when={isBootstrapped()}
        else={<View style={{ flex: 1, backgroundColor: token('canvas') }} />}
      >
        <View style={{ flex: 1 }}>
          <If when={hostBootstrapError()}>
            <View style={{ paddingTop: insets().top + 16 }}>
              <BannerNotice tone="destructive" title={hostBootstrapError()!} />
            </View>
          </If>
          <If when={hasPairedHosts()}>
            <View style={{ flex: 1 }}>
              <MainTabShell />
            </View>
          </If>
          <If when={!hasPairedHosts() || isPairingModalOpen()}>
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
              <OnboardingFlow isModal={hasPairedHosts()} />
            </View>
          </If>
        </View>
      </If>

      <Overlay
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          alignItems: 'center',
          paddingTop: insets().top + 8,
          pointerEvents: 'box-none',
        }}
      >
        <ToastStack placement="topCenter" style={{ width: 320 }}>
          <If when={currentToastMessage()}>
            <Toast
              onDismissRequest={dismissToast}
              style={{
                borderRadius: 14,
                borderCurve: 'continuous',
                backgroundColor: token('surface-elevated'),
                paddingHorizontal: 16,
                paddingVertical: 12,
              }}
            >
              <View onPress={dismissToast}>
                <Text
                  style={{
                    ...type.subheadlineMedium,
                    color: token('foreground'),
                    textAlign: 'center',
                  }}
                >
                  {currentToastMessage()}
                </Text>
              </View>
            </Toast>
          </If>
        </ToastStack>
      </Overlay>
    </View>
  );
}
