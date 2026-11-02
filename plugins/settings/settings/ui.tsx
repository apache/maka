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

import { cleanup, effect, keymap, signal, untracked, type JSX } from 'nsh';
import type { UiModule, UiViewProps } from '../../../packages/plugin-sdk/src/workbench.js';
import type {
  SettingsPageInput,
  SettingsPageNavigation,
  SettingsRoute,
  SettingsViewInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { ModelSettings } from '../../../products/maka/workbench/app/ModelSettings';
import { ConnectionSettings } from '../../../products/maka/workbench/app/ConnectionSettings';
import { GeneralSettings } from '../../../products/maka/workbench/app/GeneralSettings';
import { NetworkSettings } from '../../../products/maka/workbench/app/NetworkSettings';
import { PluginSettings } from '../../../products/maka/workbench/app/PluginSettings';
import { SkillSettings } from '../../../products/maka/workbench/app/SkillSettings';
import { McpSettings } from '../../../products/maka/workbench/app/McpSettings';
import { createSkillSettings } from '../../../products/maka/workbench/app/skillSettingsState';
import { createMcpSettings } from '../../../products/maka/workbench/app/mcpSettingsState';
import { createConfigurationWorkspace } from '../../../products/maka/workbench/app/ConfigurationScope';
import {
  createModelSettings,
  type ModelSettingsSnapshot,
} from '../../../products/maka/workbench/app/settings';
import {
  createGeneralSettings,
  type GeneralSettingsSnapshot,
} from '../../../products/maka/workbench/app/generalSettingsState';
import {
  createNetworkSettings,
  type NetworkSettingsSnapshot,
} from '../../../products/maka/workbench/app/networkSettingsState';
import {
  createPluginSettings,
  type PluginSettingsSnapshot,
} from '../../../products/maka/workbench/app/pluginSettingsState';
import { createSettingsOperations } from '../../../products/maka/workbench/app/settingsOperations';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import { appearance, initializeAppearance } from '../../../products/maka/workbench/app/appearance';
import {
  initializeUiScale,
  uiScale,
  type UiScaleSnapshot,
} from '../../../products/maka/workbench/app/uiScale';
import { sameValue } from '../../shared/value';
import { createHost, HostProvider } from '../../../products/maka/workbench/app/host';

import { createPendingRecovery } from '../../../products/maka/workbench/app/pendingRecovery';

type Snapshot = {
  route: SettingsRoute | null;
  connections: ModelSettingsSnapshot;
  general: GeneralSettingsSnapshot;
  network: NetworkSettingsSnapshot;
  plugins: PluginSettingsSnapshot;
  scale: UiScaleSnapshot;
};
type PageOwner = {
  activate(): void;
  deactivate(): void;
  navigation(): string;
  back(): boolean;
};

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  const restored = context.restored as Snapshot | null;
  const runtime = context.runtime;
  const host = createHost(context.application);
  const operations = createSettingsOperations(host);
  const defaultRoute: SettingsRoute = { instance: context.instance, id: 'connections' };
  const route = signal<SettingsRoute | null>(restored?.route ?? defaultRoute);
  const mounted = new Map<string, number>();
  const active = (id: string) => () => (mounted.get(id) ?? 0) > 0;
  const views = new Set<SettingsViewInput>();
  const changed = () => {
    for (const view of views) view.changed();
  };
  const connections = createModelSettings(
    host,
    changed,
    operations,
    active('connections'),
    undefined,
    restored?.connections,
  );
  const general = createGeneralSettings(
    host,
    operations,
    active('general'),
    restored?.general,
    (locale) => runtime.setLocale(locale),
  );
  const network = createNetworkSettings(host, operations, active('network'), restored?.network);
  const plugins = createPluginSettings(
    host,
    operations,
    active('plugins'),
    runtime,
    context,
    restored?.plugins,
  );
  const configurationWorkspace = createConfigurationWorkspace(operations);
  const skills = createSkillSettings(host, operations, configurationWorkspace);
  const mcp = createMcpSettings(host, operations, configurationWorkspace);
  initializeAppearance();
  initializeUiScale(restored?.scale);
  void general.initializeLanguage().catch(operations.report);
  effect(() => {
    currentLocale.set(context.locale());
  });
  const mountPage = (
    id: string,
    owner: PageOwner,
    props: UiViewProps<JSX.Element>,
    navigation: SettingsPageNavigation,
    render: () => JSX.Element,
  ) => {
    mounted.set(id, (mounted.get(id) ?? 0) + 1);
    owner.activate();
    const parent = (props.input as SettingsPageInput | undefined)?.settings;
    if (parent) cleanup(parent.attach(navigation));
    cleanup(() => {
      const remaining = (mounted.get(id) ?? 1) - 1;
      if (remaining === 0) mounted.delete(id);
      else mounted.set(id, remaining);
      if (remaining === 0) owner.deactivate();
    });
    return <HostProvider value={host}>{render()}</HostProvider>;
  };
  const recover = () =>
    operations.recover(async (original, value) => {
      if (original.endpoint === 'agent' && original.method === 'updateGlobalInstructions')
        await general.recovered(value);
      else if (original.endpoint === 'skills') skills.recovered();
      else if (original.endpoint === 'agent' && original.method === 'manageMcpServer')
        mcp.recovered();
      else if (original.endpoint === 'agent' && original.method === 'selectWorkspace')
        configurationWorkspace.recovered(value);
      else if (original.endpoint === 'management') plugins.reset();
      else if (original.method === 'updateAssistantPreferences') general.reset();
      else if (original.method === 'updateNetwork') network.reset();
      else {
        connections.reset();
        changed();
      }
    });
  createPendingRecovery({
    pending: () => !operations.pendingKnown() || operations.pending().length > 0,
    blocked: operations.busy,
    recover,
  });
  const invokeOwn = (id: string, argument?: string) => {
    const command = runtime
      .contributions()
      .find((item) => item.id === id && sameValue(item.instance.instance, context.instance));
    if (command)
      void runtime.invoke(command, { sessionId: null, argument }).catch(operations.report);
  };
  cleanup(
    keymap.bind(
      {
        'mod+0': () => invokeOwn('uiScaleReset'),
        'mod+alt+0': () => invokeOwn('uiScaleReset'),
        'mod+shift+plus': () => invokeOwn('appearanceTextSize', '+1'),
      },
      { when: 'always' },
    ),
  );
  return {
    exports: {
      appearanceTextSize: {
        kind: 'command',
        enabled: ({ argument }) =>
          appearance.supported && (argument === '+1' || argument === '-1' || argument === '0'),
        run({ argument }) {
          const step = argument === '+1' ? 1 : argument === '-1' ? -1 : argument === '0' ? 0 : null;
          if (step === null) throw new Error('Invalid text size command argument.');
          appearance.stepTextSize(step);
        },
      },
      uiScaleReset: {
        kind: 'command',
        enabled: () => uiScale.supported && uiScale.ready() && !uiScale.saving(),
        run: () => uiScale.resetAndSave(),
      },
      Settings: {
        kind: 'view',
        contract: 'maka.settings',
        render(props) {
          const input = props.input as SettingsViewInput;
          let restoreOpen = restored !== null && input.opened();
          effect(() => {
            if (!input.opened()) return;
            untracked(() => {
              if (restoreOpen) restoreOpen = false;
              else {
                route.set(defaultRoute);
                if (input.model) connections.openModel(input.model);
              }
            });
          });
          views.add(input);
          cleanup(() => views.delete(input));
          return (
            <HostProvider value={host}>
              <If when={input.opened()}>
                <ModelSettings
                  context={context}
                  input={input}
                  route={route}
                  defaultRoute={defaultRoute}
                  operations={operations}
                />
              </If>
            </HostProvider>
          );
        },
      },
      general: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'general',
            general,
            props,
            {
              title: general.title,
              nested: () => general.editor() !== null,
              navigation: general.navigation,
              back: general.back,
              backLabel: () => tr('Back from general settings'),
              busy: operations.busy,
            },
            () => <GeneralSettings owner={general} />,
          ),
      },
      connections: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'connections',
            connections,
            props,
            {
              title: () =>
                ({
                  connections: tr('Connections & models'),
                  providers: tr('Add connection'),
                  connection: tr('Connection settings'),
                  models: tr('Connection models'),
                  model: tr('Model settings'),
                })[connections.page()],
              nested: () => connections.page() !== 'connections' || !!connections.confirmation(),
              navigation: connections.navigation,
              back: connections.back,
              backLabel: () => tr('Back from connection settings'),
              busy: operations.busy,
            },
            () => <ConnectionSettings owner={connections} />,
          ),
      },
      skills: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'skills',
            skills,
            props,
            {
              title: () =>
                skills.screen() === 'add'
                  ? tr('Add skills')
                  : skills.screen() === 'detail'
                    ? tr('Skill details')
                    : tr('Skills'),
              nested: () => skills.screen() !== 'library' || !!skills.deleting(),
              navigation: skills.navigation,
              back: skills.back,
              busy: operations.busy,
            },
            () => <SkillSettings owner={skills} />,
          ),
      },
      mcp: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'mcp',
            mcp,
            props,
            {
              title: () =>
                mcp.editor()
                  ? mcp.editor()!.original
                    ? tr('Edit MCP server')
                    : tr('Add MCP server')
                  : tr('MCP servers'),
              nested: () => !!mcp.editor() || !!mcp.deleting(),
              navigation: mcp.navigation,
              back: mcp.back,
              busy: operations.busy,
            },
            () => <McpSettings owner={mcp} />,
          ),
      },
      network: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'network',
            network,
            props,
            {
              title: network.title,
              nested: () => false,
              navigation: network.navigation,
              back: network.back,
              busy: operations.busy,
            },
            () => <NetworkSettings owner={network} />,
          ),
      },
      plugins: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'plugins',
            plugins,
            props,
            {
              title: plugins.title,
              nested: () => plugins.selected() !== null,
              navigation: plugins.navigation,
              back: plugins.back,
              backLabel: () => tr('Back from plugins settings'),
              busy: () => operations.busy() || plugins.rootUi.busy(),
            },
            () => <PluginSettings owner={plugins} />,
          ),
      },
    },
    async prepareReload(): Promise<Snapshot> {
      do {
        await Promise.all([operations.whenIdle(), plugins.rootUi.whenIdle(), uiScale.whenIdle()]);
      } while (operations.busy() || plugins.rootUi.busy() || uiScale.saving());
      return {
        route: route(),
        connections: connections.snapshot(),
        general: general.snapshot(),
        network: network.snapshotState(),
        plugins: plugins.snapshot(),
        scale: uiScale.snapshot(),
      };
    },
  };
};
