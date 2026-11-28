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

import { cleanup, keymap, mount, signal, Text, View } from 'nsh';
import type { Host } from '../../app/host';
import { ConnectionSettings } from '../../app/ConnectionSettings';
import { currentLocale } from '../../app/locale';
import { installWorkbenchLocaleCatalog } from '../../app/localeCatalog';
import { createModelSettings } from '../../app/settings';
import { createSettingsOperations } from '../../app/settingsOperations';

installWorkbenchLocaleCatalog();

type StoredConnection = {
  connectionId: string;
  revision: number;
  slug: string;
  name: string;
  provider: { packageId: string; entryId: string; scope: string; name: string };
  configuration: Record<string, unknown>;
  enabled: boolean;
  configured: boolean;
  secret: string | null;
};

const PROVIDERS = {
  openai: {
    identity: {
      packageId: 'maka.openai',
      entryId: 'maka.openai',
      scope: 'profile',
      name: 'openai',
    },
    descriptor: {
      label: 'OpenAI',
      anonymous: false,
      customEndpoint: true,
      discovery: false,
      configurationSchema: { properties: {} },
      configurationDefaults: { baseUrl: 'https://api.openai.com/v1' },
      authentication: [{ id: 'api-key', interactive: false, label: 'API key' }],
    },
  },
  chatgpt: {
    identity: { packageId: 'maka.codex', entryId: 'maka.codex', scope: 'profile', name: 'chatgpt' },
    descriptor: {
      label: 'ChatGPT Subscription',
      anonymous: false,
      customEndpoint: false,
      discovery: false,
      configurationSchema: { properties: {} },
      configurationDefaults: {},
      authentication: [{ id: 'device', interactive: true, label: 'Sign in with ChatGPT' }],
    },
  },
  local: {
    identity: { packageId: 'maka.local', entryId: 'maka.local', scope: 'profile', name: 'local' },
    descriptor: {
      label: 'Local Endpoint',
      anonymous: true,
      customEndpoint: true,
      discovery: false,
      configurationSchema: { properties: {} },
      configurationDefaults: {},
      authentication: [],
    },
  },
};

function Fixture() {
  currentLocale.set('en');
  let catalogRevision = 1;
  const stats = signal({ creates: 0, updates: 0, secrets: 0 });
  const records = new Map<string, StoredConnection>([
    [
      'existing-openai',
      {
        connectionId: 'existing-openai',
        revision: 1,
        slug: 'existing-openai',
        name: 'Existing OpenAI',
        provider: PROVIDERS.openai.identity,
        configuration: { baseUrl: 'https://api.openai.com/v1' },
        enabled: true,
        configured: true,
        secret: 'sk-stored',
      },
    ],
  ]);

  const toDetail = (record: StoredConnection) => ({
    kind: 'ready' as const,
    name: record.name,
    enabled: record.enabled,
    target: {
      connectionId: record.connectionId,
      revision: record.revision,
      slug: record.slug,
      provider: record.provider,
      configuration: record.configuration,
    },
    editing: {
      discoveredModelIds: ['gpt-4.1'],
      enabledModelIds: ['gpt-4.1'],
      modelOverrides: {},
      requestBodyOverlay: null,
    },
  });

  const receipt = (value: unknown) => ({
    operationId: `op-${catalogRevision}`,
    reply: {
      receipt: {
        kind: 'recorded',
        outcome: { kind: 'returned', result: { kind: 'success', value } },
      },
    },
  });

  const host = {
    pendingSettings: async () => [],
    async query(_endpoint: string, method: string, input: any) {
      if (method === 'connections') {
        return {
          kind: 'page',
          revision: catalogRevision,
          next: null,
          defaultTarget: null,
          connections: [...records.values()].map((record) => ({
            basis: { connectionId: record.connectionId, revision: record.revision },
            name: record.name,
            slug: record.slug,
            provider: record.provider,
            enabled: record.enabled,
            enabledModelCount: 1,
            editable: true,
          })),
        };
      }
      if (method === 'models') {
        return {
          kind: 'ready',
          revision: catalogRevision,
          next: null,
          choices: [],
          defaultModel: { kind: 'none' },
        };
      }
      if (method === 'providers') {
        return {
          next: null,
          providers: Object.values(PROVIDERS).map((provider) => ({
            identity: provider.identity,
            label: provider.descriptor.label,
            anonymous: provider.descriptor.anonymous,
            customEndpoint: provider.descriptor.customEndpoint,
            authentication: provider.descriptor.authentication,
          })),
        };
      }
      if (method === 'provider') {
        const match = Object.values(PROVIDERS).find((p) => p.identity.name === input.name);
        if (!match) throw new Error(`Unknown provider ${input.name}`);
        return match;
      }
      if (method === 'connection') {
        const record = records.get(input.connectionId);
        if (!record) return { kind: 'missing' };
        return toDetail(record);
      }
      if (method === 'credentialStatus') {
        const record = records.get(input.locator.connectionId);
        return {
          kind: 'status',
          status: {
            locator: input.locator,
            configured: Boolean(record?.configured),
            credentialId: record?.configured ? `cred-${record.connectionId}` : null,
            revision: record?.configured ? record.revision : null,
            updatedAt: null,
          },
        };
      }
      throw new Error(`Unexpected query ${method}`);
    },
    async settingsMutation(_endpoint: string, method: string, input: any, secret?: string) {
      if (method === 'create') {
        catalogRevision += 1;
        const id = `conn-${input.connection.slug}`;
        const record: StoredConnection = {
          connectionId: id,
          revision: 1,
          slug: input.connection.slug,
          name: input.connection.name,
          provider: input.connection.provider,
          configuration: input.connection.configuration ?? {},
          enabled: input.connection.enabled,
          configured: false,
          secret: null,
        };
        records.set(id, record);
        stats.set({ ...stats(), creates: stats().creates + 1 });
        return receipt({
          kind: 'committed',
          connection: { connectionId: id, revision: record.revision },
        });
      }
      if (method === 'update') {
        const record = records.get(input.expected.connectionId)!;
        catalogRevision += 1;
        record.revision += 1;
        if ('enabled' in input.changes) record.enabled = input.changes.enabled;
        if ('name' in input.changes) record.name = input.changes.name;
        if ('configuration' in input.changes) record.configuration = input.changes.configuration;
        stats.set({ ...stats(), updates: stats().updates + 1 });
        return receipt({
          kind: 'committed',
          connection: { connectionId: record.connectionId, revision: record.revision },
        });
      }
      if (method === 'saveCredential') {
        const record = records.get(input.expected.connectionId)!;
        record.revision += 1;
        record.configured = true;
        record.secret = secret ?? null;
        stats.set({ ...stats(), secrets: stats().secrets + 1 });
        return receipt({ kind: 'saved' });
      }
      throw new Error(`Unexpected mutation ${method}`);
    },
  } as unknown as Host;

  const operations = createSettingsOperations(host);
  operations.pendingKnown.set(true);
  const owner = createModelSettings(host, operations, () => true);

  cleanup(
    keymap.bind(
      {
        f5: () => owner.newConnection(),
        f6: () => owner.back(),
      },
      { when: 'always' },
    ),
  );

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <Text>{`stats:${stats().creates}:${stats().updates}:${stats().secrets}`}</Text>
      <ConnectionSettings owner={owner} />
    </View>
  );
}

mount(() => <Fixture />);
