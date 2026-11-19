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

import { cleanup, keymap, mount, signal, type JSX } from 'nsh';
import type {
  UiContext,
  UiHost,
  UiViewProps,
} from '../../../../../packages/plugin-sdk/src/workbench';
import type { SettingsViewInput } from '../../../../../packages/plugin-sdk/src/workbench-views';
import { activate } from '../../../../../plugins/settings/settings/ui';
import { currentLocale } from '../../app/locale';

function Fixture() {
  currentLocale.set('en');
  const provider = {
    entryId: 'maka.openai',
    name: 'openai',
    packageId: 'maka.openai',
    scope: 'profile',
  };
  const definition = {
    identity: provider,
    descriptor: {
      label: 'OpenAI',
      anonymous: false,
      customEndpoint: true,
      discovery: true,
      configurationDefaults: { baseUrl: 'https://api.openai.com/v1' },
      authentication: [{ id: 'api-key', interactive: false, label: 'API key' }],
    },
  };
  const revision = 1;
  const catalogRevision = 1;
  const modelIds = ['gpt-4.1', 'gpt-4.1-mini'];
  const basis = () => ({ connectionId: 'openai', revision });
  const sourceRef = { stateDomain: 'profile', deployment: 'root', revision: 1 };
  const externalRuntimes = [
    { id: 'codex' as const, name: 'Codex', enabled: true, usageLimits: false },
    { id: 'claude' as const, name: 'Claude Code', enabled: false, usageLimits: false },
  ];
  const externalStatuses = [
    {
      id: 'codex',
      installation: { kind: 'available' as const, version: '0.42.0' },
      authentication: { kind: 'authenticated' as const, source: 'cli' },
      models: { kind: 'ready' as const, count: 5 },
    },
  ];
  let holdExternal = true;
  let releaseExternal: (() => void) | null = null;

  const application = {
    pendingSettings: async () => [],
    refresh: async () => {},
    async query(endpoint: string, method: string, input: any) {
      if (method === 'assistantPreferences') return { revision: 1, language: 'auto' };
      if (endpoint === 'management' && method === 'read')
        return { source: { reference: sourceRef } };
      if (endpoint === 'agent' && method === 'externalAgents') {
        if (holdExternal) {
          await new Promise<void>((resolve) => {
            releaseExternal = resolve;
          });
        }
        return {
          target: {
            source: { stateDomain: 'profile', deployment: 'root', namespace: ['agent'] },
            path: ['externalAgents'],
          },
          configured: true,
          runtimes: externalRuntimes,
          state: input?.inspect
            ? { kind: 'enabled' as const }
            : { kind: 'ready' as const, runtimes: externalStatuses },
        };
      }
      if (method === 'connections')
        return {
          kind: 'page',
          revision: catalogRevision,
          next: null,
          defaultTarget: { connectionId: 'openai', modelId: 'gpt-4.1' },
          connections: [
            {
              basis: basis(),
              name: 'OpenAI',
              slug: 'openai',
              provider,
              enabled: true,
              enabledModelCount: modelIds.length,
              editable: true,
            },
          ],
        };
      if (method === 'models') {
        const choice = (modelId: string) => ({
          selection: { connectionId: 'openai', modelId },
          connectionName: 'OpenAI',
          label: modelId,
          thinkingLevels: ['off', 'medium', 'high'],
          defaultThinkingLevel: 'medium',
          limits: { contextWindow: 128000, maxOutputTokens: 16384 },
        });
        return {
          kind: 'ready',
          revision: catalogRevision,
          next: null,
          choices: modelIds.map(choice),
        };
      }
      if (method === 'provider') return definition;
      if (method === 'connection')
        return {
          kind: 'ready',
          name: 'OpenAI',
          enabled: true,
          target: {
            ...basis(),
            slug: 'openai',
            provider,
            configuration: definition.descriptor.configurationDefaults,
          },
          editing: {
            discoveredModelIds: modelIds,
            enabledModelIds: modelIds,
            modelOverrides: {},
            requestBodyOverlay: null,
          },
        };
      if (method === 'credentialStatus')
        return {
          kind: 'status',
          status: {
            locator: { scope: 'connection', connectionId: 'openai', kind: 'provider' },
            configured: true,
            credentialId: 'cred-1',
            revision: 1,
            updatedAt: null,
          },
        };
      if (method === 'resolveModel')
        return {
          kind: 'ready',
          defaults: {
            label: 'GPT-4.1',
            contextWindow: 128000,
            inputLimit: 128000,
            maxOutputTokens: 16384,
            compactionThreshold: null,
            thinkingLevels: ['off', 'medium', 'high'],
            defaultThinkingLevel: 'medium',
            codeMode: true,
            applyPatch: true,
            catalogMatched: true,
          },
          choice: {
            selection: { ...basis(), modelId: input.modelId },
            thinkingLevels: ['off', 'medium', 'high'],
            defaultThinkingLevel: 'medium',
            limits: { contextWindow: 128000, maxOutputTokens: 16384 },
          },
        };
      if (method === 'catalogModels') return { models: [], after: null };
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
    restored: {
      route: { instance, id: 'external-agents' },
      connections: {
        page: 'connection',
        connections: [],
        providers: [],
        connectionQuery: 'stale-filter',
        providerQuery: '',
        modelQuery: '',
        revision: null,
        defaultTarget: null,
        next: null,
        providerNext: null,
        editor: null,
        model: null,
        credential: null,
        discovery: 'idle',
        confirmation: null,
        initialModel: null,
      },
    },
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
  let targetPage: string | undefined;
  const viewInput: SettingsViewInput = {
    opened,
    get page() {
      return targetPage;
    },
    close() {
      opened.set(false);
    },
  };

  cleanup(
    keymap.bind(
      {
        f6: () => {
          holdExternal = true;
        },
        f7: () => {
          holdExternal = false;
          const finish = releaseExternal;
          releaseExternal = null;
          finish?.();
        },
        f8: () => {
          opened.set(false);
          targetPage = 'external-agents';
          opened.set(true);
        },
      },
      { when: 'always' },
    ),
  );

  return settingsView.render({ context, runtime: context.runtime, input: viewInput });
}

mount(() => <Fixture />);
