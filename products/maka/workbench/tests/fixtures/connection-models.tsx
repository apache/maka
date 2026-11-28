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

import { mount, signal, Text, View, type JSX } from 'nsh';
import type {
  UiContext,
  UiHost,
  UiViewProps,
} from '../../../../../packages/plugin-sdk/src/workbench';
import type { SettingsViewInput } from '../../../../../packages/plugin-sdk/src/workbench-views';
import { activate } from '../../../../../plugins/settings/settings/ui';
import { currentLocale } from '../../app/locale';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';

installWorkbenchLocaleCatalog();

function Fixture() {
  currentLocale.set('en');
  const provider = {
    entryId: 'maka.openrouter',
    name: 'openrouter',
    packageId: 'maka.openrouter',
    scope: 'profile',
  };
  const definition = {
    identity: provider,
    descriptor: {
      label: 'OpenRouter',
      anonymous: false,
      customEndpoint: true,
      discovery: true,
      configurationDefaults: { baseUrl: 'https://openrouter.ai/api/v1' },
      authentication: [{ id: 'api-key', interactive: false, label: 'API key' }],
    },
  };
  const discoveredModelIds = Array.from(
    { length: 14 },
    (_, i) => `openai/model-${String(i + 1).padStart(2, '0')}`,
  );
  const manualModelId = 'custom/local-model';
  let revision = 1;
  let enabledModelIds = ['openai/model-01', 'openai/model-02', manualModelId];
  let modelOverrides: Record<string, Record<string, unknown>> = {};
  const updateSummary = signal('updates:0');
  let updateCount = 0;

  const basis = () => ({ connectionId: 'openrouter', revision });

  const application = {
    pendingSettings: async () => [],
    refresh: async () => {},
    async settingsMutation(endpoint: string, method: string, input: any) {
      if (endpoint === 'settings' && method === 'update') {
        updateCount += 1;
        revision += 1;
        if (input.changes.enabledModelIds !== undefined)
          enabledModelIds = [...input.changes.enabledModelIds];
        if (input.changes.modelOverrides !== undefined)
          modelOverrides = { ...input.changes.modelOverrides };
        const keptManual = manualModelId in modelOverrides;
        updateSummary.set(
          `updates:${updateCount};enabled:${enabledModelIds.length};manualKept:${keptManual}`,
        );
        return {
          operationId: `op-${updateCount}`,
          reply: {
            receipt: {
              kind: 'recorded',
              outcome: {
                kind: 'returned',
                result: {
                  kind: 'success',
                  value: { kind: 'committed', connection: basis() },
                },
              },
            },
          },
        };
      }
      throw new Error(`Unexpected mutation ${endpoint}.${method}`);
    },
    async query(endpoint: string, method: string) {
      if (method === 'assistantPreferences') return { revision: 1, language: 'auto' };
      if (endpoint === 'agent' && method === 'externalAgents')
        return {
          target: {
            source: { stateDomain: 'profile', deployment: 'root', namespace: ['agent'] },
            path: ['externalAgents'],
          },
          configured: false,
          runtimes: [],
          state: { kind: 'ready' as const, runtimes: [] },
        };
      if (method === 'connections')
        return {
          kind: 'page',
          revision,
          next: null,
          defaultTarget: { connectionId: 'openrouter', modelId: 'openai/model-01' },
          connections: [
            {
              basis: basis(),
              name: 'OpenRouter',
              slug: 'openrouter',
              provider,
              enabled: true,
              enabledModelCount: enabledModelIds.length,
              editable: true,
            },
          ],
        };
      if (method === 'models')
        return { kind: 'ready', revision, next: null, choices: [], defaultModel: null };
      if (method === 'provider') return definition;
      if (method === 'connection')
        return {
          kind: 'ready',
          name: 'OpenRouter',
          enabled: true,
          target: {
            ...basis(),
            slug: 'openrouter',
            provider,
            configuration: definition.descriptor.configurationDefaults,
          },
          editing: {
            discoveredModelIds,
            enabledModelIds: [...enabledModelIds],
            modelOverrides: { ...modelOverrides },
            requestBodyOverlay: null,
          },
        };
      if (method === 'credentialStatus')
        return {
          kind: 'status',
          status: {
            locator: { scope: 'connection', connectionId: 'openrouter', kind: 'provider' },
            configured: true,
            credentialId: 'cred-1',
            revision: 1,
            updatedAt: null,
          },
        };
      throw new Error(`Unexpected query ${endpoint}.${method}`);
    },
  } as unknown as UiHost;

  const instance = ['settings'];
  const contribution = {
    key: 'connections',
    id: 'connections',
    instance: { instance, path: instance },
    declaration: {
      kind: 'settings',
      title: { fallback: 'Models', translations: { 'zh-CN': '模型', 'zh-TW': '模型' } },
    },
  };

  let activated: ReturnType<typeof activate>;
  const context = {
    instance,
    application,
    services: { management: [{}] },
    operations: { pending: async () => [] },
    locale: () => 'en' as const,
    restored: null,
    runtime: {
      setLocale: () => {},
      contributions: () => [contribution],
      ready: () => true,
      settings: () => [contribution],
      render: (_target: unknown, props: UiViewProps<JSX.Element>) => {
        const entry = activated.exports?.connections;
        if (entry?.kind !== 'settings') throw new Error('Missing connections settings export');
        return entry.render(props);
      },
    },
  } as unknown as UiContext<UiHost, JSX.Element>;

  activated = activate(context);
  const settingsView = activated.exports?.Settings;
  if (settingsView?.kind !== 'view') throw new Error('Missing Settings view contribution');

  const opened = signal(true);
  const viewInput: SettingsViewInput = {
    opened,
    close() {
      opened.set(false);
    },
  };

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <Text style={{ height: 1, opacity: 0 }}>{updateSummary()}</Text>
      <If when={opened()} else={<Text>Back in app</Text>}>
        {settingsView.render({ context, runtime: context.runtime, input: viewInput })}
      </If>
    </View>
  );
}

mount(() => <Fixture />);
