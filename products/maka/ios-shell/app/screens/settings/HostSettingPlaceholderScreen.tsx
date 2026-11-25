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
import { tr } from '../../locale';
import {
  activeHostInfo,
  connectSavedHost,
  hostById,
  hostStatusKind,
  hostStatusText,
  isHostConnected,
} from '../../state/hostPool';
import { spacing, type } from '../../theme/tokens';
import {
  ActionButton,
  IconBadge,
  InsetGroup,
  ScreenHeader,
  StatusDot,
  type IconName,
} from '../../ui';

export type HostSettingDomain =
  | 'general'
  | 'models'
  | 'subagents'
  | 'plugins'
  | 'mcp'
  | 'skills'
  | 'web_search'
  | 'network';

interface DomainMeta {
  title: () => string;
  description: () => string;
  icon: IconName;
  endpoint: string;
}

export const HOST_SETTING_DOMAINS: Record<HostSettingDomain, DomainMeta> = {
  general: {
    title: () => tr('General'),
    description: () =>
      tr(
        'Manage global instructions (AGENTS.md), conversation compaction prompts, and predictive input on this computer.',
      ),
    icon: 'sliders',
    endpoint: 'settings',
  },
  models: {
    title: () => tr('Models & Connections'),
    description: () =>
      tr(
        'Configure model providers, API keys, default models, thinking effort, and external agents on this computer.',
      ),
    icon: 'sparkles',
    endpoint: 'settings',
  },
  subagents: {
    title: () => tr('Subagents'),
    description: () =>
      tr('Create and edit reusable subagent presets and model assignments on this computer.'),
    icon: 'users',
    endpoint: 'agent',
  },
  plugins: {
    title: () => tr('Plugins'),
    description: () =>
      tr('Enable, configure, or install Maka Host plugins running on this computer.'),
    icon: 'puzzle',
    endpoint: 'management',
  },
  mcp: {
    title: () => tr('MCP'),
    description: () =>
      tr('Inspect and manage global and workspace MCP server connections on this computer.'),
    icon: 'plug',
    endpoint: 'agent',
  },
  skills: {
    title: () => tr('Skills'),
    description: () =>
      tr('Browse installed skills, inspect SKILL.md instructions, and manage skill sources.'),
    icon: 'book',
    endpoint: 'skills',
  },
  web_search: {
    title: () => tr('Web Search'),
    description: () =>
      tr('Configure search providers and manage search API keys for this computer.'),
    icon: 'globe',
    endpoint: 'web',
  },
  network: {
    title: () => tr('Network Proxy'),
    description: () =>
      tr('Configure outbound HTTP/SOCKS proxy settings and credentials for this computer.'),
    icon: 'network',
    endpoint: 'settings',
  },
};

export function HostSettingPlaceholderScreen(props: {
  domain: HostSettingDomain;
  rootId: string;
  onBack: () => void;
}) {
  const insets = safeAreaInsets();
  const meta = () => HOST_SETTING_DOMAINS[props.domain];
  const host = () => hostById(props.rootId);
  const conn = () => activeHostInfo(props.rootId);
  const endpointReady = () => !!conn()?.endpoints.includes(meta().endpoint);

  return (
    <NavPage
      style={{ flex: 1 }}
      title={meta().title()}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      header={
        <ScreenHeader title={meta().title()} backLabel={tr('Settings')} onBack={props.onBack} />
      }
    >
      <View style={{ flex: 1, backgroundColor: token('grouped-bg') }}>
        <Scroll
          style={{ flex: 1 }}
          contentStyle={{
            paddingTop: 20,
            paddingBottom: Math.max(insets().bottom, 20) + 24,
          }}
        >
          <InsetGroup header={tr('Target computer')}>
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 14,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <IconBadge name={meta().icon} background={token('primary')} size={34} iconSize={18} />
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text style={{ ...type.headline, color: token('foreground') }}>
                  {host()?.hostName ?? props.rootId}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <StatusDot kind={hostStatusKind(props.rootId)} size={7} />
                  <Text style={{ ...type.footnote, color: token('muted-foreground') }}>
                    {hostStatusText(props.rootId)}
                  </Text>
                </View>
              </View>
            </View>
          </InsetGroup>

          <InsetGroup
            header={tr('Overview')}
            footer={
              isHostConnected(props.rootId)
                ? endpointReady()
                  ? tr('This computer advertises the required configuration endpoint.')
                  : tr('This computer does not currently advertise the {endpoint} endpoint.', {
                      endpoint: meta().endpoint,
                    })
                : tr('Reconnect this computer to read and edit its settings.')
            }
          >
            <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
              <Text style={{ ...type.subheadline, color: token('foreground'), lineHeight: 21 }}>
                {meta().description()}
              </Text>
            </View>
          </InsetGroup>

          <If when={!isHostConnected(props.rootId)}>
            <View style={{ paddingHorizontal: spacing.pageX }}>
              <ActionButton
                title={tr('Reconnect')}
                onPress={() => void connectSavedHost(props.rootId)}
              />
            </View>
          </If>
        </Scroll>
      </View>
    </NavPage>
  );
}
