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

import { effect, Overlay, safeAreaInsets, signal, Text, View, token } from 'nsh';
import { createNavStack, NavStack, Toast, ToastStack } from 'nsh/base';
import { isAvailable, TabBar, type TabBarItem } from 'nsh/mobile';
import { tr } from './locale';
import { ChatDetailScreen, ChatListScreen } from './screens/chats/ChatListScreen';
import { InboxScreen, ReviewDetailScreen } from './screens/inbox/InboxScreen';
import { AdvancedConnectSheet } from './screens/onboarding/AdvancedConnectSheet';
import { ConfirmDeviceScreen } from './screens/onboarding/ConfirmDeviceScreen';
import { ScanScreen } from './screens/onboarding/ScanScreen';
import { WelcomeScreen } from './screens/onboarding/WelcomeScreen';
import { DeviceDetailScreen } from './screens/settings/DeviceDetailScreen';
import {
  HostSettingPlaceholderScreen,
  type HostSettingDomain,
} from './screens/settings/HostSettingPlaceholderScreen';
import { SettingsRootScreen } from './screens/settings/SettingsRootScreen';
import {
  closeAddComputerFlow,
  currentDeepLink,
  currentPendingTicket,
  currentToastMessage,
  dismissToast,
  hasPairedHosts,
  hostBootstrapError,
  isBootstrapped,
  isPairingModalOpen,
  startHostPool,
} from './state/hostPool';
import { startInboxStore, totalPendingCount, type InboxItem } from './state/inbox';
import { hapticSelection } from './state/preferences';
import { startSessionsStore, type ScopedSession } from './state/sessions';
import { type } from './theme/tokens';
import { BannerNotice } from './ui';

type OnboardingRoute = { name: 'welcome' } | { name: 'scan' } | { name: 'confirm' };
type ChatsRoute = { name: 'list' } | { name: 'detail'; item: ScopedSession };
type InboxRoute = { name: 'list' } | { name: 'review'; item: InboxItem };
type SettingsRoute =
  | { name: 'root' }
  | { name: 'device'; rootId: string }
  | { name: 'hostSetting'; domain: HostSettingDomain; rootId: string };

function OnboardingFlow(props: { isModal: boolean }) {
  const nav = createNavStack<OnboardingRoute>([{ name: 'welcome' }]);

  const pushConfirm = () => {
    const routes = nav.routes();
    if (routes[routes.length - 1]?.name !== 'confirm') {
      nav.push({ name: 'confirm' });
    }
  };

  effect(() => {
    // If pairing ticket was cleared while on Confirm, return cleanly to Welcome.
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
    if (!link) return;
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
            if (route.name === 'detail') {
              return <ChatDetailScreen item={route.item} onBack={() => chatsNav.pop()} />;
            }
            return (
              <ChatListScreen onOpenSession={(item) => chatsNav.push({ name: 'detail', item })} />
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
              return <ReviewDetailScreen item={route.item} onBack={() => inboxNav.pop()} />;
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
            if (route.name === 'device') {
              return <DeviceDetailScreen rootId={route.rootId} onBack={() => settingsNav.pop()} />;
            }
            if (route.name === 'hostSetting') {
              return (
                <HostSettingPlaceholderScreen
                  domain={route.domain}
                  rootId={route.rootId}
                  onBack={() => settingsNav.pop()}
                />
              );
            }
            return (
              <SettingsRootScreen
                onOpenDevice={(rootId) => settingsNav.push({ name: 'device', rootId })}
                onOpenHostSetting={(domain, rootId) =>
                  settingsNav.push({ name: 'hostSetting', domain, rootId })
                }
              />
            );
          }}
        </NavStack>
      </View>

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
                      color: activeTab() === index() ? token('primary') : token('muted-foreground'),
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
    </View>
  );
}

export function App() {
  const insets = safeAreaInsets();
  startHostPool();
  startSessionsStore();
  startInboxStore();

  const showOnboarding = () => !hasPairedHosts() || isPairingModalOpen();

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
          <If when={showOnboarding()} else={<MainTabShell />}>
            <OnboardingFlow isModal={hasPairedHosts() && isPairingModalOpen()} />
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
