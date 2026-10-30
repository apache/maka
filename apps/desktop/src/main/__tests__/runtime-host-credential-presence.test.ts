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

/** #6318 — onboarding 凭据在场的读取失败语义：读失败 = unknown，绝不 = 未配置。 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { RuntimeHostConnectionCatalogSnapshot } from '@maka/runtime-host/client';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import {
  createHostCredentialPresence,
  type HostCredentialPresenceClient,
} from '../runtime-host-credential-presence.js';

const connection: LlmConnection = {
  connectionId: 'connection-1',
  slug: 'primary',
  name: 'Primary',
  providerType: 'custom',
  defaultApiProtocol: 'openai-chat',
  baseUrl: 'https://relay.example/v1',
  defaultModel: 'gpt-5',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

function catalogSnapshot(
  providerType: string,
): RuntimeHostConnectionCatalogSnapshot {
  return {
    revision: 1,
    defaultTarget: null,
    connections: [
      {
        connectionId: 'connection-1',
        revision: 1,
        slug: 'primary',
        name: 'Primary',
        providerType,
        defaultApiProtocol: 'openai-chat',
        baseUrl: 'https://relay.example/v1',
        enabled: true,
        enabledModelIds: ['gpt-5'],
        models: [],
        catalogEntries: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  } as unknown as RuntimeHostConnectionCatalogSnapshot;
}

const configuredStatus = {
  locator: { scope: 'connection', connectionId: 'connection-1', kind: 'api_key' },
  configured: true,
  credentialId: 'cred-1',
  revision: 1,
  updatedAt: 1,
} as const;

const unconfiguredStatus = {
  locator: { scope: 'connection', connectionId: 'connection-1', kind: 'api_key' },
  configured: false,
  credentialId: null,
  revision: null,
  updatedAt: null,
} as const;

function stubClient(
  overrides: Partial<HostCredentialPresenceClient> = {},
  reads = { catalog: 0, query: 0 },
): HostCredentialPresenceClient {
  return {
    loadConnectionCatalog: async () => {
      reads.catalog += 1;
      return catalogSnapshot('custom');
    },
    queryCredential: async () => {
      reads.query += 1;
      return configuredStatus;
    },
    ...overrides,
  };
}

test('a failed catalog read is unknown — never "not configured" (#6318)', async () => {
  const presence = createHostCredentialPresence(
    stubClient({
      loadConnectionCatalog: async () => {
        throw new Error('Host catalog read failed');
      },
    }),
  );
  // 断言：应答 unknown（reject），而不是把读失败折叠成 false=未配置。
  await assert.rejects(presence(connection), /Host catalog read failed/u);
});

test('a failed credential query is unknown — never "not configured" (#6318)', async () => {
  const presence = createHostCredentialPresence(
    stubClient({
      queryCredential: async () => {
        throw new Error('credential vault read failed');
      },
    }),
  );
  await assert.rejects(presence(connection), /credential vault read failed/u);
});

test('an unregistered providerType is unknown — the registry lookup failure propagates', async () => {
  const presence = createHostCredentialPresence(
    stubClient({
      loadConnectionCatalog: async () => catalogSnapshot('no-such-provider'),
    }),
  );
  await assert.rejects(presence(connection), TypeError);
});

test('a successfully read, configured credential answers true', async () => {
  const reads = { catalog: 0, query: 0 };
  const presence = createHostCredentialPresence(stubClient({}, reads));
  assert.equal(await presence(connection), true);
  assert.equal(reads.catalog, 1);
  assert.equal(reads.query, 1);
});

test('a successfully read, absent credential answers false', async () => {
  const reads = { catalog: 0, query: 0 };
  const presence = createHostCredentialPresence(
    stubClient(
      {
        queryCredential: async () => {
          reads.query += 1;
          return unconfiguredStatus;
        },
      },
      reads,
    ),
  );
  assert.equal(await presence(connection), false);
  assert.equal(reads.catalog, 1);
  assert.equal(reads.query, 1);
});

test('a connection absent from a successfully read catalog answers false (confirmed absent)', async () => {
  const presence = createHostCredentialPresence(
    stubClient({
      loadConnectionCatalog: async () => ({
        revision: 1,
        defaultTarget: null,
        connections: [],
      }) as RuntimeHostConnectionCatalogSnapshot,
    }),
  );
  assert.equal(await presence(connection), false);
});

test('providers that need no secret answer true without Host reads', async () => {
  const reads = { catalog: 0, query: 0 };
  const presence = createHostCredentialPresence(stubClient({}, reads));
  assert.equal(
    await presence({ ...connection, providerType: 'no-secret-provider' as never }),
    true,
  );
  assert.equal(reads.catalog, 0);
  assert.equal(reads.query, 0);
});

test('reconnectable read failures keep propagating for the reconnect policy', async () => {
  const presence = createHostCredentialPresence(
    stubClient({
      loadConnectionCatalog: async () => {
        throw new RuntimeHostOperationError(
          'credential.vault.query',
          'host_draining',
          'host is draining',
        );
      },
    }),
  );
  await assert.rejects(
    presence(connection),
    (error: unknown) =>
      error instanceof RuntimeHostOperationError && error.code === 'host_draining',
  );
});
