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

import { mount, signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { ConnectionSettings } from '../../app/ConnectionSettings';
import { createExternalAgentSettings } from '../../app/externalAgentSettingsState';
import { HostProvider, type Host } from '../../app/host';
import { currentLocale } from '../../app/locale';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import { ModelSelect } from '../../app/ModelSelect';
import type { ModelBackend, ModelChoice, ModelDetails } from '../../app/modelSelection';
import { createModelSettings } from '../../app/settings';
import { createSettingsOperations } from '../../app/settingsOperations';

function Fixture() {
  installWorkbenchLocaleCatalog();
  currentLocale.set('en');
  const sourceRef = { stateDomain: 'profile', deployment: 'root', revision: 1 };
  const connections = [
    {
      basis: { connectionId: 'anthropic-1', revision: 1 },
      slug: 'anthropic',
      name: 'Anthropic',
      provider: {
        packageId: 'maka.providers',
        entryId: 'maka.providers',
        scope: 'profile',
        name: 'anthropic',
      },
      enabled: true,
      enabledModelCount: 3,
      editable: true,
      usageLimits: false,
    },
    {
      basis: { connectionId: 'codex-1', revision: 1 },
      slug: 'chatgpt',
      name: 'ChatGPT',
      provider: {
        packageId: 'maka.codex',
        entryId: 'maka.codex',
        scope: 'profile',
        name: 'chatgpt',
      },
      enabled: false,
      enabledModelCount: 2,
      editable: true,
      usageLimits: false,
    },
    {
      basis: { connectionId: 'plugin-1', revision: 1 },
      slug: 'acme',
      name: 'Acme Relay',
      provider: {
        packageId: 'acme.custom-plugin',
        entryId: 'acme.custom-plugin',
        scope: 'profile',
        name: 'openai',
      },
      enabled: true,
      enabledModelCount: 1,
      editable: true,
      usageLimits: false,
    },
  ];
  const providers = [
    {
      identity: {
        packageId: 'maka.codex',
        entryId: 'maka.codex',
        scope: 'profile',
        name: 'chatgpt',
      },
      label: 'ChatGPT Subscription',
      customEndpoint: false,
      authentication: [{ label: 'Sign in', interactive: true }],
    },
    {
      identity: {
        packageId: 'maka.providers',
        entryId: 'maka.providers',
        scope: 'profile',
        name: 'openai-compatible',
      },
      label: 'Chat Completions',
      customEndpoint: true,
      authentication: [{ label: 'API key', interactive: false }],
    },
    {
      identity: {
        packageId: 'maka.providers',
        entryId: 'maka.providers',
        scope: 'profile',
        name: 'google',
      },
      label: 'Google Gemini',
      customEndpoint: false,
      authentication: [{ label: 'API key', interactive: false }],
    },
    {
      identity: {
        packageId: 'maka.providers',
        entryId: 'maka.providers',
        scope: 'profile',
        name: 'deepseek',
      },
      label: 'DeepSeek',
      customEndpoint: false,
      authentication: [{ label: 'API key', interactive: false }],
    },
    {
      identity: {
        packageId: 'acme.custom-plugin',
        entryId: 'acme.custom-plugin',
        scope: 'profile',
        name: 'custom',
      },
      label: 'Acme Provider',
      customEndpoint: false,
      authentication: [{ label: 'API key', interactive: false }],
    },
  ];
  const runtimes = [
    { id: 'antigravity', name: 'Antigravity', enabled: true, usageLimits: false },
    { id: 'codex', name: 'Codex', enabled: true, usageLimits: false },
    { id: 'claude', name: 'Claude Code', enabled: false, usageLimits: false },
    { id: 'custom-cli', name: 'Zebra CLI', enabled: true, usageLimits: false },
  ];

  const agentChoices: ModelChoice[] = [
    {
      label: 'Claude Sonnet 4',
      sourceName: 'Anthropic',
      selection: {
        kind: 'model',
        connectionId: 'anthropic-1',
        modelId: 'claude-sonnet-4',
        thinkingLevel: null,
      },
      thinkingLevels: [],
      defaultThinkingLevel: null,
    },
    {
      label: 'Acme Model',
      sourceName: 'Acme Relay',
      selection: {
        kind: 'model',
        connectionId: 'plugin-1',
        modelId: 'acme-1',
        thinkingLevel: null,
      },
      thinkingLevels: [],
      defaultThinkingLevel: null,
    },
    {
      label: 'Gemini 4',
      sourceName: 'Native CLI · Antigravity',
      selection: {
        kind: 'executor',
        selection: {
          executor: 'external',
          settings: { runtime: 'antigravity', model: 'gemini-4', thinkingLevel: null },
        },
      },
      thinkingLevels: [],
      defaultThinkingLevel: null,
    },
  ];
  const backend = signal<ModelBackend | null>(agentChoices[0].selection);
  const modelMenuInstance = signal<number | null>(null);
  let menuSerial = 0;

  const host = {
    pendingSettings: async () => [],
    refresh: async () => {},
    subscribe: async () => {
      let sent = false;
      return {
        next: async () => {
          if (sent) return new Promise<null>(() => {});
          sent = true;
          return {
            kind: 'ready',
            revision: 'r1',
            choices: agentChoices,
            next: null,
            refreshing: false,
          };
        },
        close: async () => {},
      };
    },
    query: async (endpoint: string, method: string, input: any) => {
      if (endpoint === 'management' && method === 'read') {
        return { source: { reference: sourceRef } };
      }
      if (endpoint === 'agent' && method === 'models') {
        return {
          kind: 'ready',
          revision: 'r1',
          next: null,
          choices: agentChoices,
          refreshing: false,
        };
      }
      if (endpoint === 'settings' && method === 'connections') {
        return {
          kind: 'ready',
          revision: 1,
          next: null,
          defaultTarget: { connectionId: 'anthropic-1', modelId: 'claude-sonnet-4' },
          connections,
        };
      }
      if (endpoint === 'settings' && method === 'models') {
        return {
          kind: 'ready',
          revision: 1,
          next: null,
          defaultModel: {
            kind: 'ready',
            choice: {
              selection: { connectionId: 'anthropic-1', modelId: 'claude-sonnet-4' },
              connectionName: 'Anthropic',
              label: 'Claude Sonnet 4',
              thinkingLevels: [],
            },
          },
          choices: [
            {
              selection: { connectionId: 'anthropic-1', modelId: 'claude-sonnet-4' },
              connectionName: 'Anthropic',
              label: 'Claude Sonnet 4',
              thinkingLevels: [],
            },
          ],
        };
      }
      if (endpoint === 'settings' && method === 'providers') {
        return { providers, next: null };
      }
      if (endpoint === 'agent' && method === 'externalAgents') {
        return {
          target: {
            source: { stateDomain: 'profile', deployment: 'root', namespace: ['agent'] },
            path: ['external'],
          },
          configured: true,
          runtimes,
          state: input?.inspect
            ? { kind: 'enabled' }
            : {
                kind: 'ready',
                runtimes: [
                  {
                    id: 'antigravity',
                    name: 'Antigravity',
                    installation: { kind: 'available', version: '1.0.0' },
                    authentication: { kind: 'authenticated', source: 'cli' },
                    models: { kind: 'ready', count: 4 },
                  },
                  {
                    id: 'codex',
                    name: 'Codex',
                    installation: { kind: 'available', version: '0.42.0' },
                    authentication: { kind: 'authenticated', source: 'cli' },
                    models: { kind: 'ready', count: 3 },
                  },
                  {
                    id: 'custom-cli',
                    name: 'Zebra CLI',
                    installation: { kind: 'available', version: '0.1.0' },
                    authentication: { kind: 'authenticated', source: 'cli' },
                    models: { kind: 'ready', count: 1 },
                  },
                ],
              },
        };
      }
      throw new Error(`Unexpected query ${endpoint}.${method}`);
    },
  } as unknown as Host;

  const operations = createSettingsOperations(host);
  const models = createModelSettings(host, operations, () => true);
  const externalAgents = createExternalAgentSettings(host, operations, () => true);
  models.activate();
  externalAgents.activate();

  const modelDetails = (): ModelDetails => ({ kind: 'ready', choice: agentChoices[0] });

  return (
    <HostProvider value={host}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            id="add-provider"
            accessibilityLabel="Add connection"
            onPress={models.newConnection}
          >
            <Text>Add connection</Text>
          </Button>
          <ModelSelect
            owner={{
              sessionId: 's1',
              backend,
              modelDetails,
              refreshModel: async () => {},
            }}
            instance={modelMenuInstance}
            current={() => true}
            toggle={() => modelMenuInstance.set(modelMenuInstance() === null ? ++menuSerial : null)}
            close={(expected) => {
              if (modelMenuInstance() !== expected) return false;
              modelMenuInstance.set(null);
              return true;
            }}
            select={async (_expected, next) => {
              backend.set(next);
            }}
            manage={({ instance: expected }) => {
              if (modelMenuInstance() === expected) modelMenuInstance.set(null);
            }}
          />
        </View>
        <ConnectionSettings owner={models} externalAgents={externalAgents} />
      </View>
    </HostProvider>
  );
}

mount(() => <Fixture />);
