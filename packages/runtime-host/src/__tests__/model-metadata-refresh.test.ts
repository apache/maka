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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { installRefreshedModelMetadata, lookupModelMetadata } from '@maka/core/model-metadata';
import { MODELS_DEV_PROVIDERS } from '@maka/core/models-dev-projection';
import type { ProxiedFetchProxy } from '@maka/runtime/network/scoped-fetch-transport';
import type {
  ResolveHostOutboundExecutionResult,
  RuntimePolicyOperationCoordinator,
} from '@maka/storage/runtime-policy-stores';
import { startHostModelMetadataRefresh } from '../server/model-metadata-refresh.js';

/** Read before any install, so a snapshot refresh cannot make it a stale literal. */
const BUNDLED_OPUS_NAME = lookupModelMetadata('anthropic', 'claude-opus-4-5').displayName;

test('a refreshed catalog replaces the bundled metadata before clients are told', async (t) => {
  t.after(() => installRefreshedModelMetadata(undefined));
  const announced: string[] = [];
  const refresh = startHostModelMetadataRefresh({
    policy: resolver(ready()),
    publish: () => {
      announced.push(lookupModelMetadata('anthropic', 'refreshed-model').displayName ?? '');
    },
    createFetchTransport: () => respondWith(JSON.stringify(catalogFixture())),
  });

  await refresh.settled;

  assert.deepEqual(announced, ['Refreshed Model']);
  assert.equal(
    lookupModelMetadata('anthropic', 'refreshed-model').displayName,
    'Refreshed Model',
    'the refreshed table answers lookups',
  );
});

test('a refresh drops every model the bundled snapshot described on its own', async (t) => {
  t.after(() => installRefreshedModelMetadata(undefined));
  const refresh = startHostModelMetadataRefresh({
    policy: resolver(ready()),
    publish: () => {},
    createFetchTransport: () => respondWith(JSON.stringify(catalogFixture())),
  });

  await refresh.settled;

  assert.equal(typeof BUNDLED_OPUS_NAME, 'string');
  assert.equal(
    lookupModelMetadata('anthropic', 'claude-opus-4-5').displayName,
    undefined,
    'a model upstream no longer lists stops being described by models.dev',
  );
});

test('an upstream shape the projection refuses keeps the bundled snapshot', async (t) => {
  t.after(() => installRefreshedModelMetadata(undefined));
  const catalog = catalogFixture();
  catalog.anthropic.models['refreshed-model'].modalities = {
    input: ['hologram'],
    output: ['text'],
  };
  let announced = 0;
  const refresh = startHostModelMetadataRefresh({
    policy: resolver(ready()),
    publish: () => {
      announced += 1;
    },
    createFetchTransport: () => respondWith(JSON.stringify(catalog)),
  });

  await refresh.settled;

  assert.equal(announced, 0);
  assert.equal(lookupModelMetadata('anthropic', 'refreshed-model').displayName, undefined);
  assert.equal(lookupModelMetadata('anthropic', 'claude-opus-4-5').displayName, BUNDLED_OPUS_NAME);
});

test('a failed fetch keeps the bundled snapshot and announces nothing', async (t) => {
  t.after(() => installRefreshedModelMetadata(undefined));
  let announced = 0;
  let closed = 0;
  const refresh = startHostModelMetadataRefresh({
    policy: resolver(ready()),
    publish: () => {
      announced += 1;
    },
    createFetchTransport: () => ({
      fetch: async () => {
        throw new Error('offline');
      },
      close: async () => {
        closed += 1;
      },
    }),
  });

  await refresh.settled;

  assert.equal(announced, 0);
  assert.equal(closed, 1, 'the transport is closed even when the fetch throws');
  assert.equal(lookupModelMetadata('anthropic', 'claude-opus-4-5').displayName, BUNDLED_OPUS_NAME);
});

test('privacy mode refuses the refresh before any transport exists', async () => {
  let transportCreated = false;
  const refresh = startHostModelMetadataRefresh({
    policy: resolver({ kind: 'privacy_mode' }),
    publish: () => assert.fail('privacy mode must not announce a refresh'),
    createFetchTransport: () => {
      transportCreated = true;
      throw new Error('transport must not be created');
    },
  });

  await refresh.settled;

  assert.equal(transportCreated, false);
});

test('the refresh goes out over the resolved proxy snapshot', async (t) => {
  t.after(() => installRefreshedModelMetadata(undefined));
  const networkProxy = {
    ...createDefaultRuntimePolicy().networkProxy,
    enabled: true,
    protocol: 'http' as const,
    host: 'proxy.example',
    port: 8080,
    authEnabled: true,
    username: 'proxy-user',
    bypassList: ['direct.example'],
  };
  let proxy: ProxiedFetchProxy | null | undefined;
  const refresh = startHostModelMetadataRefresh({
    policy: resolver({
      kind: 'ready',
      networkProxy,
      secretMaterial: {
        networkProxy: {
          locator: { scope: 'network_proxy', kind: 'password' },
          credentialId: 'proxy-credential',
          revision: 1,
          secret: 'proxy-secret',
        },
      },
    }),
    publish: () => {},
    createFetchTransport: (candidate) => {
      proxy = candidate;
      return respondWith(JSON.stringify(catalogFixture()));
    },
  });

  await refresh.settled;

  assert.deepEqual(proxy, {
    enabled: true,
    type: 'http',
    host: 'proxy.example',
    port: 8080,
    username: 'proxy-user',
    password: 'proxy-secret',
    bypassList: [...networkProxy.bypassList, ...networkProxy.autoBypassDomains],
  });
});

function ready(): ResolveHostOutboundExecutionResult {
  return {
    kind: 'ready',
    networkProxy: createDefaultRuntimePolicy().networkProxy,
    secretMaterial: {},
  };
}

function resolver(
  result: ResolveHostOutboundExecutionResult,
): Pick<RuntimePolicyOperationCoordinator, 'resolveHostOutboundExecution'> {
  return { resolveHostOutboundExecution: async () => result };
}

function respondWith(body: string) {
  return {
    fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    close: async () => {},
  };
}

interface FixtureModel {
  name: string;
  reasoning: boolean;
  tool_call: boolean;
  limit: { context: number; output: number };
  modalities: { input: string[]; output: string[] };
}

/**
 * A whole models.dev response: the projection refuses a partial one, so every
 * provider Maka reads has to be present with at least one model.
 */
function catalogFixture(): Record<
  string,
  { id: string; name: string; doc: string; models: Record<string, FixtureModel> }
> {
  const catalog: Record<
    string,
    { id: string; name: string; doc: string; models: Record<string, FixtureModel> }
  > = {};
  for (const sourceId of new Set(Object.values(MODELS_DEV_PROVIDERS))) {
    catalog[sourceId] = {
      id: sourceId,
      name: sourceId,
      doc: `https://models.dev/${sourceId}`,
      models: { 'refreshed-model': model() },
    };
  }
  return catalog;
}

function model(): FixtureModel {
  return {
    name: 'Refreshed Model',
    reasoning: false,
    tool_call: true,
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  };
}
