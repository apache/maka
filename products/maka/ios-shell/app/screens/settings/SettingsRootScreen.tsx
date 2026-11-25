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
import { MenuButton, NavPage, type MenuButtonItem } from 'nsh/base';
import { Switch } from 'nsh/mobile';
import { pathLabel } from '../../bridge';
import { languagePreferenceBusy, languagePreferenceError, tr } from '../../locale';
import {
  activeHostInfo,
  hostById,
  hostStatusKind,
  hostStatusText,
  openAddComputerFlow,
  savedHosts,
  selectedSettingsRootId,
  selectSettingsHost,
} from '../../state/hostPool';
import {
  appearancePreference,
  hapticsEnabled,
  saveAppearancePreference,
  saveHapticsEnabled,
  type AppearancePreference,
} from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import {
  BannerNotice,
  GroupRow,
  Icon,
  IconBadge,
  InsetGroup,
  ScreenHeader,
  StatusDot,
  type IconName,
} from '../../ui';
import {
  buildLanguageMenuItems,
  currentLanguageDisplayName,
  onSelectLanguageId,
} from '../onboarding/LanguageMenuTrigger';
import { HOST_SETTING_DOMAINS, type HostSettingDomain } from './HostSettingPlaceholderScreen';

function appearanceLabel(pref: AppearancePreference): string {
  switch (pref) {
    case 'light':
      return tr('Light');
    case 'dark':
      return tr('Dark');
    default:
      return tr('System');
  }
}

const DOMAIN_ORDER: { domain: HostSettingDomain; badgeToken: string }[] = [
  { domain: 'general', badgeToken: 'offline' },
  { domain: 'models', badgeToken: 'primary' },
  { domain: 'subagents', badgeToken: 'indigo' },
  { domain: 'plugins', badgeToken: 'purple' },
  { domain: 'mcp', badgeToken: 'teal' },
  { domain: 'skills', badgeToken: 'success' },
  { domain: 'web_search', badgeToken: 'primary' },
  { domain: 'network', badgeToken: 'warning' },
];

export function SettingsRootScreen(props: {
  onOpenDevice: (rootId: string) => void;
  onOpenHostSetting: (domain: HostSettingDomain, rootId: string) => void;
}) {
  const insets = safeAreaInsets();

  const targetHost = () => {
    const id = selectedSettingsRootId();
    return id ? hostById(id) : undefined;
  };

  const hostSubtitle = (rootId: string): string => {
    const info = activeHostInfo(rootId);
    if (info) return tr('Connected') + ' · ' + pathLabel(info.pathSummary, info.transport);
    return hostStatusText(rootId);
  };

  const appearanceMenuItems = (): MenuButtonItem[] => {
    const current = appearancePreference();
    return [
      { id: 'system', label: tr('System'), checked: current === 'system', singleSelection: true },
      { id: 'light', label: tr('Light'), checked: current === 'light', singleSelection: true },
      { id: 'dark', label: tr('Dark'), checked: current === 'dark', singleSelection: true },
    ];
  };

  const hostSwitcherItems = (): MenuButtonItem[] => {
    const selected = selectedSettingsRootId();
    return savedHosts().map((host) => ({
      id: host.rootId,
      label: host.hostName,
      checked: host.rootId === selected,
      singleSelection: true,
    }));
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={tr('Settings')}
      headerLargeTitle
      headerTransparent
      headerBackgroundOnScroll
      headerShadowVisible={false}
      header={<ScreenHeader title={tr('Settings')} large />}
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingTop: 12,
            paddingBottom: insets().bottom + spacing.tabBarClearance,
          }}
        >
          <If when={languagePreferenceError()}>
            <BannerNotice tone="destructive" title={languagePreferenceError()!} />
          </If>

          {/* Section 1: Paired Computers */}
          <InsetGroup header={tr('Paired Computers')}>
            <Each of={savedHosts()} key={(host) => host.rootId}>
              {(host) => (
                <GroupRow
                  leading={
                    <IconBadge
                      name="laptop"
                      background={token('primary')}
                      size={28}
                      iconSize={16}
                    />
                  }
                  title={host().hostName}
                  subtitle={hostSubtitle(host().rootId)}
                  trailing={<StatusDot kind={hostStatusKind(host().rootId)} size={8} />}
                  chevron
                  divider
                  accessibilityLabel={tr('Computer: {name}', { name: host().hostName })}
                  onPress={() => props.onOpenDevice(host().rootId)}
                />
              )}
            </Each>
            <GroupRow
              leading={<Icon name="plus" color={token('primary')} size={18} strokeWidth={2.2} />}
              title={tr('Add Computer…')}
              tone="primary"
              onPress={openAddComputerFlow}
            />
          </InsetGroup>

          {/* Section 2: This iPhone (Local Preferences) */}
          <InsetGroup header={tr('This iPhone')}>
            <MenuButton
              accessibilityLabel={tr('Language')}
              title={tr('Language')}
              disabled={languagePreferenceBusy()}
              items={buildLanguageMenuItems()}
              onSelect={({ id }) => onSelectLanguageId(id)}
            >
              <GroupRow
                leading={
                  <IconBadge name="globe" background={token('primary')} size={28} iconSize={16} />
                }
                title={tr('Language')}
                value={currentLanguageDisplayName()}
                chevron
                divider
              />
            </MenuButton>

            <MenuButton
              accessibilityLabel={tr('Appearance')}
              title={tr('Appearance')}
              items={appearanceMenuItems()}
              onSelect={({ id }) => {
                if (id === 'system' || id === 'light' || id === 'dark') {
                  void saveAppearancePreference(id);
                }
              }}
            >
              <GroupRow
                leading={
                  <IconBadge
                    name="appearance"
                    background={token('indigo')}
                    size={28}
                    iconSize={16}
                  />
                }
                title={tr('Appearance')}
                value={appearanceLabel(appearancePreference())}
                chevron
                divider
              />
            </MenuButton>

            <GroupRow
              leading={
                <IconBadge name="haptics" background={token('teal')} size={28} iconSize={16} />
              }
              title={tr('Haptic Feedback')}
              trailing={
                <Switch
                  accessibilityLabel={tr('Haptic Feedback')}
                  checked={hapticsEnabled()}
                  onChange={({ checked }) => void saveHapticsEnabled(checked)}
                  style={{ accentColor: token('success') }}
                />
              }
            />
          </InsetGroup>

          {/* Section 3: Computer Settings (Aligned to Desktop) */}
          <If when={targetHost()}>
            <InsetGroup
              header={tr('Computer Settings')}
              headerTrailing={
                savedHosts().length > 1 ? (
                  <MenuButton
                    accessibilityLabel={tr('Switch target computer')}
                    title={tr('Target computer')}
                    items={hostSwitcherItems()}
                    onSelect={({ id }) => selectSettingsHost(id)}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <StatusDot kind={hostStatusKind(targetHost()!.rootId)} size={6} />
                      <Text
                        style={{ ...type.footnote, fontWeight: '600', color: token('primary') }}
                      >
                        {targetHost()!.hostName}
                      </Text>
                      <Icon name="chevronDown" color={token('primary')} size={12} />
                    </View>
                  </MenuButton>
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <StatusDot kind={hostStatusKind(targetHost()!.rootId)} size={6} />
                    <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
                      {targetHost()!.hostName}
                    </Text>
                  </View>
                )
              }
              footer={tr(
                'These settings apply directly to {name} and stay synchronized with Maka Desktop.',
                { name: targetHost()!.hostName },
              )}
            >
              <Each of={DOMAIN_ORDER} key={(entry) => entry.domain}>
                {(entry, index) => {
                  const meta = () => HOST_SETTING_DOMAINS[entry().domain];
                  const badgeBg = () => token(entry().badgeToken);
                  return (
                    <GroupRow
                      leading={
                        <IconBadge
                          name={meta().icon as IconName}
                          background={badgeBg()}
                          size={28}
                          iconSize={15}
                        />
                      }
                      title={meta().title()}
                      chevron
                      divider={index() < DOMAIN_ORDER.length - 1}
                      onPress={() => props.onOpenHostSetting(entry().domain, targetHost()!.rootId)}
                    />
                  );
                }}
              </Each>
            </InsetGroup>
          </If>
        </Scroll>
      </View>
    </NavPage>
  );
}
