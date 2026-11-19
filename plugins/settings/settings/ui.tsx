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

import { cleanup, effect, keymap, lifecycle, platform, signal, untracked, type JSX } from 'nsh';
import type { UiModule, UiViewProps } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type SettingsPageInput,
  type SettingsPageNavigation,
  type SettingsRoute,
  type SettingsViewInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { ModelSettings } from '../../../products/maka/workbench/app/ModelSettings';
import { dictationPreferences } from '../../../products/maka/workbench/app/dictationPreferences';
import { LoadingIndicator } from '../../../products/maka/workbench/app/Loading';
import { SettingsProblem } from '../../../products/maka/workbench/app/SettingsPage';
import { ConnectionSettings } from '../../../products/maka/workbench/app/ConnectionSettings';
import { GeneralSettings } from '../../../products/maka/workbench/app/GeneralSettings';
import { NetworkSettings } from '../../../products/maka/workbench/app/NetworkSettings';
import { WebSearchSettings } from '../../../products/maka/workbench/app/WebSearchSettings';
import { createWebSearchSettings } from '../../../products/maka/workbench/app/webSearchSettingsState';
import { CommunityPlugins } from '../../../products/maka/workbench/app/CommunityPlugins';
import { PluginSettings } from '../../../products/maka/workbench/app/PluginSettings';
import { SkillSettings } from '../../../products/maka/workbench/app/SkillSettings';
import { createExternalAgentSettings } from '../../../products/maka/workbench/app/externalAgentSettingsState';
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
import { providerLabel } from '../../../products/maka/workbench/app/settingsLabels';
import { appearance, initializeAppearance } from '../../../products/maka/workbench/app/appearance';
import { initializeComposerToolbar } from '../../../products/maka/workbench/app/composerToolbar';
import {
  initializeUiScale,
  uiScale,
  type UiScaleSnapshot,
} from '../../../products/maka/workbench/app/uiScale';
import { sameValue } from '../../shared/value';
import { createHost, HostProvider } from '../../../products/maka/workbench/app/host';

import { createPendingRecovery } from '../../../products/maka/workbench/app/pendingRecovery';

import { SubagentSettings } from '../../../products/maka/workbench/app/SubagentSettings';
import {
  createPresetSettings,
  type PresetSettingsSnapshot,
} from '../../../products/maka/workbench/app/presetSettingsState';

type Snapshot = {
  presets?: PresetSettingsSnapshot;
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
  /** Reads the page's data again unless a draft is open. */
  refresh?(): void;
};

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  const restored = context.restored as Snapshot | null;
  const runtime = context.runtime;
  const host = createHost(context.application);
  const operations = createSettingsOperations(host);
  const defaultRoute: SettingsRoute = { instance: context.instance, id: 'connections' };
  const isOwnExternalAgents = (candidate: SettingsRoute | null | undefined) =>
    candidate?.id === 'external-agents' && sameValue(candidate.instance, context.instance);
  const route = signal<SettingsRoute | null>(
    restored?.route
      ? isOwnExternalAgents(restored.route)
        ? defaultRoute
        : restored.route
      : defaultRoute,
  );
  const restoredConnections: ModelSettingsSnapshot | undefined =
    isOwnExternalAgents(restored?.route) && restored?.connections
      ? {
          ...restored.connections,
          page: 'connections',
          connectionQuery: '',
          editor: null,
          model: null,
          credential: null,
          discovery: 'idle',
          confirmation: null,
          initialModel: null,
        }
      : restored?.connections;
  const mounted = new Map<string, number>();
  const active = (id: string) => () => (mounted.get(id) ?? 0) > 0;
  const connections = createModelSettings(
    host,
    operations,
    active('connections'),
    undefined,
    restoredConnections,
    undefined,
    platform.os === 'macos' && platform.idiom !== 'terminal'
      ? dictationPreferences.enableForConnection
      : undefined,
  );
  const general = createGeneralSettings(
    host,
    operations,
    active('general'),
    restored?.general,
    (locale) => runtime.setLocale(locale),
  );
  const webSearch = createWebSearchSettings(host, operations, active('web-search'));
  const network = createNetworkSettings(host, operations, active('network'), restored?.network);
  const plugins = createPluginSettings(
    host,
    operations,
    () => active('plugins')() || active('marketplace')(),
    runtime,
    context,
    restored?.plugins,
  );
  const externalAgents = createExternalAgentSettings(host, operations, active('connections'));
  const modelsOwner: PageOwner = {
    activate() {
      connections.activate();
      externalAgents.activate();
    },
    deactivate() {
      connections.deactivate();
      externalAgents.deactivate();
    },
    navigation: () => JSON.stringify([connections.navigation(), externalAgents.navigation()]),
    back() {
      if (externalAgents.confirmation()) return externalAgents.back();
      return connections.back();
    },
    refresh() {
      connections.refresh();
      if (connections.page() === 'connections') externalAgents.refresh();
    },
  };
  const presets = createPresetSettings(host, operations, restored?.presets);
  const configurationWorkspace = createConfigurationWorkspace(operations);
  const skills = createSkillSettings(host, operations, configurationWorkspace);
  const mcp = createMcpSettings(host, operations, configurationWorkspace);
  initializeAppearance();
  initializeComposerToolbar();
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
    let foreground = untracked(lifecycle) === 'active';
    effect(() => {
      const now = lifecycle() === 'active';
      if (now && !foreground) untracked(() => owner.refresh?.());
      foreground = now;
    });
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
      else if (
        original.endpoint === 'agent' &&
        ['createPreset', 'updatePreset', 'deletePreset'].includes(original.method)
      )
        await presets.recovered(value);
      else if (original.endpoint === 'web') await webSearch.load();
      else if (original.endpoint === 'skills') skills.recovered();
      else if (original.endpoint === 'agent' && original.method === 'manageMcpServer')
        mcp.recovered();
      else if (original.endpoint === 'agent' && original.method === 'selectWorkspace')
        configurationWorkspace.recovered(value);
      else if (original.endpoint === 'management') {
        if (original.method === 'configureBatch') await host.refresh();
        plugins.reset();
        externalAgents.reset();
      } else if (original.method === 'updateAssistantPreferences') general.reset();
      else if (original.method === 'updateNetwork') network.reset();
      else {
        connections.reset();
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
              if (input.page) {
                if (input.page === 'external-agents') {
                  route.set(defaultRoute);
                  if (externalAgents.confirmation()) externalAgents.cancel(externalAgents.action());
                  connections.leave(() => {
                    connections.connectionQuery.set('');
                    connections.reset();
                  });
                } else {
                  route.set({ instance: context.instance, id: input.page });
                }
                restoreOpen = false;
              } else if (restoreOpen) restoreOpen = false;
              else {
                route.set(defaultRoute);
                if (input.model) connections.openModel(input.model);
              }
            });
          });
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
        render: (props) => {
          const adding = signal(false);
          const finish = () => {
            adding.set(false);
            form.deactivate();
          };
          const form = createModelSettings(host, operations, adding, undefined, undefined, (id) => {
            finish();
            void dictationPreferences.save('connection', id);
          });
          const open = async () => {
            adding.set(false);
            form.reset();
            adding.set(true);
            // Creation needs the current catalog revision before the editor opens.
            await form.loadConnections();
            if (!adding() || form.revision() === null) return;
            form.newConnection();
            await form.chooseProvider({
              packageId: 'maka.providers',
              entryId: 'maka.providers',
              scope: 'profile',
              name: 'deepseek',
            });
          };
          const back = () => {
            if (!adding()) return general.back();
            if (
              form.discardTarget() ||
              form.confirmation() ||
              form.page() === 'advanced' ||
              form.page() === 'model'
            )
              return form.back();
            form.leave(finish);
            return false;
          };
          return mountPage(
            'general',
            general,
            props,
            {
              title: () =>
                adding()
                  ? form.page() === 'advanced'
                    ? tr('Advanced')
                    : tr('Add a DeepSeek connection')
                  : general.title(),
              nested: () => general.editor() !== null,
              navigation: () => (adding() ? form.navigation() : general.navigation()),
              back,
              leave: (next) => (adding() ? form.leave(next) : general.leave(next)),
              backLabel: () => tr('Back from general settings'),
              busy: operations.navigationBusy,
            },
            () => (
              <If
                when={adding()}
                else={<GeneralSettings owner={general} addConnection={() => void open()} />}
              >
                <If
                  when={form.editor() !== null}
                  else={
                    <If when={!!operations.error()} else={<LoadingIndicator />}>
                      <SettingsProblem message={operations.error()} retry={() => void open()} />
                    </If>
                  }
                >
                  <ConnectionSettings owner={form} />
                </If>
              </If>
            ),
          );
        },
      },
      connections: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'connections',
            modelsOwner,
            props,
            {
              title: () => {
                if (externalAgents.confirmation()) return externalAgents.title();
                const editor = connections.editor();
                const model = connections.model();
                switch (connections.page()) {
                  case 'connections':
                    return tr('Models');
                  case 'providers':
                    return tr('Add connection');
                  case 'connection':
                    return (
                      editor?.baseline?.name ??
                      providerLabel(editor?.provider.descriptor.label ?? '')
                    );
                  case 'advanced':
                    return tr('Advanced');
                  case 'model':
                    return model?.originalId === null
                      ? tr('Add model')
                      : model?.label.trim() || model?.originalId || '';
                }
              },
              action: () =>
                connections.page() === 'connections' &&
                !connections.confirmation() &&
                !externalAgents.confirmation()
                  ? {
                      label: tr('Add connection'),
                      run: connections.newConnection,
                      disabled: connections.loading(),
                    }
                  : null,
              nested: () =>
                connections.page() !== 'connections' ||
                !!connections.confirmation() ||
                !!externalAgents.confirmation(),
              navigation: modelsOwner.navigation,
              back: modelsOwner.back,
              leave: (next) => {
                if (externalAgents.confirmation()) externalAgents.cancel(externalAgents.action());
                connections.leave(next);
              },
              backLabel: () => tr('Back from connection settings'),
              busy: operations.navigationBusy,
            },
            () => <ConnectionSettings owner={connections} externalAgents={externalAgents} />,
          ),
      },
      subagents: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'subagents',
            presets,
            props,
            {
              title: () => tr('Subagents'),
              action: () =>
                !presets.editor()
                  ? {
                      label: tr('Add subagent'),
                      run: () => void presets.open(null),
                      disabled: presets.loading() || presets.busy(),
                    }
                  : null,
              nested: () => !!presets.editor(),
              navigation: presets.navigation,
              back: presets.back,
              leave: presets.leave,
              busy: presets.busy,
            },
            () => <SubagentSettings owner={presets} />,
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
                    ? (skills.document()?.entry.name ?? tr('Skill details'))
                    : tr('Skills'),
              action: () =>
                skills.screen() === 'library' && !skills.deleting() && skills.page()?.writable
                  ? { label: tr('Add skills'), run: skills.add, disabled: skills.loading() }
                  : null,
              nested: () => skills.screen() !== 'library' || !!skills.deleting(),
              navigation: skills.navigation,
              back: skills.back,
              busy: operations.navigationBusy,
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
              action: () =>
                !mcp.editor() && !mcp.deleting()
                  ? {
                      label: tr('Add MCP server'),
                      run: () => mcp.open(null),
                      disabled: mcp.loading() || !mcp.inventory()?.locations.length,
                    }
                  : null,
              nested: () => !!mcp.editor() || !!mcp.deleting(),
              navigation: mcp.navigation,
              back: mcp.back,
              leave: mcp.leave,
              busy: operations.navigationBusy,
            },
            () => <McpSettings owner={mcp} />,
          ),
      },
      'web-search': {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'web-search',
            webSearch,
            props,
            {
              title: webSearch.title,
              nested: () => false,
              navigation: webSearch.navigation,
              back: webSearch.back,
              leave: webSearch.leave,
              busy: operations.navigationBusy,
            },
            () => <WebSearchSettings owner={webSearch} />,
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
              leave: network.leave,
              busy: operations.navigationBusy,
            },
            () => <NetworkSettings owner={network} />,
          ),
      },
      marketplace: {
        kind: 'settings',
        render: (props) =>
          mountPage(
            'marketplace',
            plugins,
            props,
            {
              title: () => tr('Plugin marketplace'),
              nested: () => false,
              navigation: () => 'marketplace',
              back: () => true,
              busy: operations.navigationBusy,
            },
            () => <CommunityPlugins owner={plugins} />,
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
              leave: plugins.leave,
              backLabel: () => tr('Back from plugins settings'),
              busy: () => operations.navigationBusy() || plugins.rootUi.busy(),
            },
            () => (
              <PluginSettings
                owner={plugins}
                quickTool={(instance) =>
                  runtime
                    .contributions()
                    .some(
                      (item) =>
                        item.declaration.kind === 'view' &&
                        item.declaration.contract === quickToolView.id &&
                        sameValue(item.instance.instance, instance.instance),
                    )
                }
              />
            ),
          ),
      },
    },
    async prepareReload(): Promise<Snapshot> {
      do {
        await Promise.all([
          operations.whenIdle(),
          plugins.rootUi.whenIdle(),
          uiScale.whenIdle(),
          appearance.whenIdle(),
        ]);
      } while (
        operations.busy() ||
        plugins.rootUi.busy() ||
        uiScale.saving() ||
        appearance.saving()
      );
      return {
        route: route(),
        presets: presets.snapshot(),
        connections: connections.snapshot(),
        general: general.snapshot(),
        network: network.snapshotState(),
        plugins: plugins.snapshot(),
        scale: uiScale.snapshot(),
      };
    },
  };
};
