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

import { cleanup, computed, effect, safeAreaInsets, Scroll, signal, View, token } from 'nsh';
import { MenuButton, NavPage, type MenuButtonItem } from 'nsh/base';
import { Switch } from 'nsh/mobile';
import { pathLabel } from '../../bridge';
import { languagePreferenceBusy, languagePreferenceError, tr } from '../../locale';
import {
  activeHostInfo,
  hostPath,
  hostStatusKind,
  hostStatusText,
  openAddComputerFlow,
  savedHosts,
  isHostConnected,
} from '../../state/hostPool';
import {
  appearancePreference,
  hapticsEnabled,
  saveAppearancePreference,
  saveHapticsEnabled,
  type AppearancePreference,
} from '../../state/preferences';
import { settingsRpc } from '../../state/settings/rpc';
import { spacing } from '../../theme/tokens';
import {
  BannerNotice,
  GroupRow,
  Icon,
  IconBadge,
  InsetGroup,
  ScreenHeader,
  StatusDot,
} from '../../ui';
import {
  buildLanguageMenuItems,
  currentLanguageDisplayName,
  onSelectLanguageId,
} from '../onboarding/LanguageMenuTrigger';
import { HOST_SETTING_DOMAINS, type HostSettingDomain } from './hostSettingDomains';

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

const DOMAIN_ORDER = [
  { domain: 'general', badgeToken: 'offline' },
  { domain: 'models', badgeToken: 'primary' },
  { domain: 'subagents', badgeToken: 'indigo' },
  { domain: 'plugins', badgeToken: 'purple' },
  { domain: 'mcp', badgeToken: 'teal' },
  { domain: 'skills', badgeToken: 'success' },
  { domain: 'web_search', badgeToken: 'primary' },
  { domain: 'network', badgeToken: 'warning' },
] as const;

export function SettingsRootScreen(props: {
  onOpenComputer: (rootId: string) => void;
  onOpenDevice: (rootId: string) => void;
  onOpenHostSetting: (domain: HostSettingDomain, rootId: string) => void;
}) {
  const insets = safeAreaInsets();

  const defaultModels = signal<Record<string, string>>({});
  const connectionKey = computed(() =>
    JSON.stringify(
      savedHosts().flatMap(({ rootId }) => {
        const info = activeHostInfo(rootId);
        return info?.endpoints.includes('settings') ? [[rootId, info.generation]] : [];
      }),
    ),
  );
  effect(() => {
    const targets = JSON.parse(connectionKey()) as Array<[string, number]>;
    if (savedHosts().length < 2) return;
    let alive = true;
    cleanup(() => {
      alive = false;
    });
    defaultModels.set({});
    for (const [rootId] of targets) {
      const rpc = settingsRpc(rootId);
      void rpc
        .query('settings', 'connections', { kind: 'start' })
        .then(async (page) => {
          if (!alive || page.kind !== 'ready' || !page.defaultTarget) return;
          const model = await rpc.query('settings', 'resolveModel', page.defaultTarget);
          if (alive && model.kind === 'ready')
            defaultModels.update((prev) => ({ ...prev, [rootId]: model.choice.label }));
        })
        .catch((cause) => {
          if (alive) console.warn('Default model unavailable', cause);
        });
    }
  });
  const hostSubtitle = (rootId: string): string => {
    const info = activeHostInfo(rootId);
    const model = defaultModels()[rootId];
    if (info && model) return tr('Connected') + ' · ' + model;
    if (info && savedHosts().length > 1)
      return tr('Connected') + ' · ' + pathLabel(hostPath(info.rootId), info.transport);
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
          contentStyle={{
            paddingTop: 12,
            paddingBottom: insets().bottom + spacing.tabBarClearance,
          }}
        >
          <If when={languagePreferenceError()}>
            <BannerNotice tone="destructive" title={languagePreferenceError()!} />
          </If>

          {/* Section 1: Paired Computers */}
          <InsetGroup header={savedHosts().length > 1 ? tr('Paired Computers') : undefined}>
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
                  divider={savedHosts().length > 1}
                  accessibilityLabel={tr('Computer: {name}', { name: host().hostName })}
                  onPress={() =>
                    savedHosts().length === 1
                      ? props.onOpenDevice(host().rootId)
                      : props.onOpenComputer(host().rootId)
                  }
                />
              )}
            </Each>
            <If when={savedHosts().length > 1}>
              <GroupRow
                leading={<Icon name="plus" color={token('primary')} size={18} strokeWidth={2.2} />}
                title={tr('Add Computer…')}
                tone="primary"
                onPress={openAddComputerFlow}
              />
            </If>
          </InsetGroup>

          <If when={savedHosts().length === 1}>
            <HostSettingsRows rootId={savedHosts()[0].rootId} onOpen={props.onOpenHostSetting} />
          </If>

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
        </Scroll>
      </View>
    </NavPage>
  );
}

export function HostSettingsRows(props: {
  rootId: string;
  onOpen: (domain: HostSettingDomain, rootId: string) => void;
}) {
  return (
    <InsetGroup
      header={tr('Computer Settings')}
      footer={
        !isHostConnected(props.rootId)
          ? tr('Reconnect this computer to read and edit its settings.')
          : undefined
      }
    >
      <Each of={DOMAIN_ORDER} key={(entry) => entry.domain}>
        {(entry, index) => {
          const meta = () => HOST_SETTING_DOMAINS[entry().domain];
          return (
            <GroupRow
              leading={
                <IconBadge
                  name={meta().icon}
                  background={token(entry().badgeToken)}
                  size={28}
                  iconSize={15}
                />
              }
              title={meta().title()}
              chevron
              disabled={!isHostConnected(props.rootId)}
              divider={index() < DOMAIN_ORDER.length - 1}
              onPress={() => props.onOpen(entry().domain, props.rootId)}
            />
          );
        }}
      </Each>
    </InsetGroup>
  );
}
