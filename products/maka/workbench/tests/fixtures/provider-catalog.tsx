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

const summary = (
  name: string,
  label: string,
  options: {
    packageId?: string;
    customEndpoint?: boolean;
    interactive?: boolean;
  } = {},
) => {
  const packageId = options.packageId ?? 'maka.providers';
  return {
    identity: { packageId, entryId: packageId, scope: 'profile', name },
    label,
    customEndpoint: options.customEndpoint ?? false,
    authentication: [
      {
        label: options.interactive ? `Sign in with ${label}` : 'API key',
        interactive: options.interactive ?? false,
      },
    ],
  };
};

const PROVIDERS = [
  summary('chatgpt', 'ChatGPT Subscription', { packageId: 'maka.codex', interactive: true }),
  summary('openai', 'OpenAI'),
  summary('anthropic', 'Anthropic'),
  summary('google', 'Google Gemini'),
  summary('deepseek', 'DeepSeek'),
  summary('openrouter', 'OpenRouter'),
  summary('kimi-coding-plan', 'Kimi Coding Plan'),
  summary('mistral', 'Mistral'),
  summary('togetherai', 'Together AI'),
  summary('openai-compatible', 'Chat Completions', { customEndpoint: true }),
  summary('ollama', 'Ollama'),
  summary('acme-sso', 'Acme SSO', { packageId: 'acme.plugin', interactive: true }),
  summary('acme-relay', 'Acme Relay', { packageId: 'acme.plugin', customEndpoint: true }),
];

function Fixture() {
  currentLocale.set('en');
  const application = {
    pendingSettings: async () => [],
    refresh: async () => {},
    settingsMutation: async () => {
      throw new Error('Unexpected mutation');
    },
    async query(endpoint: string, method: string, input: any) {
      if (method === 'assistantPreferences') return { revision: 1, language: 'auto' };
      if (endpoint === 'agent' && method === 'externalAgents') {
        return {
          target: {
            source: { stateDomain: 'profile', deployment: 'root', namespace: ['agent'] },
            path: ['externalAgents'],
          },
          configured: true,
          runtimes: [{ id: 'codex', name: 'Codex', enabled: false, usageLimits: false }],
          state: { kind: 'ready' as const, runtimes: [] },
        };
      }
      if (method === 'connections') {
        return {
          kind: 'page',
          revision: 1,
          next: null,
          defaultTarget: null,
          connections: [],
        };
      }
      if (method === 'models') {
        return {
          kind: 'ready',
          revision: 1,
          next: null,
          choices: [],
          defaultModel: { kind: 'none' },
        };
      }
      if (method === 'providers') {
        return { providers: PROVIDERS, next: null };
      }
      if (method === 'provider') {
        const match = PROVIDERS.find(
          (item) =>
            item.identity.packageId === input.packageId && item.identity.name === input.name,
        );
        if (!match) throw new Error(`Unknown provider ${input.name}`);
        return {
          identity: match.identity,
          descriptor: {
            label: match.label,
            anonymous: false,
            customEndpoint: match.customEndpoint,
            discovery: true,
            configurationSchema: { properties: {} },
            configurationDefaults: match.customEndpoint
              ? {}
              : { baseUrl: `https://${match.identity.name}.example.com/v1` },
            authentication: match.authentication.map((item) => ({
              id: item.interactive ? 'oauth' : 'api-key',
              interactive: item.interactive,
              label: item.label,
            })),
          },
        };
      }
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
      <If when={opened()} else={<Text>Back in app</Text>}>
        {settingsView.render({ context, runtime: context.runtime, input: viewInput })}
      </If>
    </View>
  );
}

mount(() => <Fixture />);
