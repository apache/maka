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

import type {
  ConnectionCatalogEntry,
  ConnectionCatalogEntryDraft,
  ConnectionCatalogSnapshot,
  ConnectionModel,
} from '@maka/core/runtime-policy';
import type { E2eFixtureScenario } from '@maka/core/e2e-fixture';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';

interface ConnectionSeed {
  readonly draft: ConnectionCatalogEntryDraft;
  readonly apiKey?: string;
  readonly modelInventory?: {
    readonly models: readonly ConnectionModel[];
    readonly fetchedAt: number;
  };
  readonly verifiedAt?: string;
  readonly verifiedModelId?: string;
}

interface CatalogSeedPlan {
  readonly connections: readonly ConnectionSeed[];
  readonly defaultTarget: { readonly slug: string; readonly modelId: string };
}

const ZAI_MODELS: readonly ConnectionModel[] = [
  fixtureModel('glm-4.5', { functionCalling: true }, 128_000),
  fixtureModel('glm-4.5-air', { functionCalling: true }, 128_000),
  fixtureModel('glm-4.6', { reasoning: true, functionCalling: true }, 200_000),
  fixtureModel('glm-4.7', { reasoning: true, functionCalling: true }, 200_000),
  fixtureModel('glm-5', { reasoning: true, functionCalling: true }, 200_000),
  fixtureModel('glm-5-turbo', { reasoning: true, functionCalling: true }, 200_000),
  fixtureModel('glm-5.1', { vision: true, reasoning: true, functionCalling: true }, 1_000_000),
];

export async function seedSettingsConnectionCatalog(
  workspaceRoot: string,
  now: number,
  scenario: E2eFixtureScenario,
): Promise<void> {
  const showEmptyConnectionFirst = scenario === 'settings-connections';
  const zai = zaiSeed(now);
  const empty = emptySeed(showEmptyConnectionFirst);
  const connections = showEmptyConnectionFirst ? [empty, zai] : [zai, empty];
  await seedCatalog(workspaceRoot, {
    connections,
    defaultTarget: { slug: 'zai-live', modelId: 'glm-5.1' },
  });
}

function zaiSeed(now: number): ConnectionSeed {
  return {
    draft: {
      slug: 'zai-live',
      name: 'Z.ai Live Fixture',
      providerType: 'zai-coding-plan',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      enabled: true,
      enabledModelIds: ZAI_MODELS.map(({ id }) => id),
    },
    apiKey: 'fixture-key-zai-live',
    modelInventory: { models: ZAI_MODELS, fetchedAt: now - 5 * 60_000 },
    verifiedAt: new Date(now - 4 * 60_000).toISOString(),
    verifiedModelId: 'glm-5.1',
  };
}

function emptySeed(withCredential: boolean): ConnectionSeed {
  return {
    draft: {
      slug: 'no-models',
      name: 'No Models Fixture',
      providerType: 'custom',
      baseUrl: 'https://empty.example.test/v1',
      defaultApiProtocol: 'openai-chat',
      enabled: true,
      enabledModelIds: [],
    },
    ...(withCredential ? { apiKey: 'fixture-key-no-models' } : {}),
  };
}

async function seedCatalog(workspaceRoot: string, plan: CatalogSeedPlan): Promise<void> {
  const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('Connection fixture could not acquire its storage root');
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    let snapshot = await stores.connectionCatalog.getSnapshot();
    for (const seed of plan.connections) snapshot = await addConnection(stores, snapshot, seed);
    const defaultConnection = connectionBySlug(snapshot, plan.defaultTarget.slug);
    const result = await stores.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: snapshot.revision,
      target: {
        connectionId: defaultConnection.connectionId,
        modelId: plan.defaultTarget.modelId,
      },
    });
    requireCommitted(result, `set default ${plan.defaultTarget.slug}`);
  } finally {
    await owner.close();
  }
}

async function addConnection(
  stores: RuntimePolicyStoresWriter,
  snapshot: ConnectionCatalogSnapshot,
  seed: ConnectionSeed,
): Promise<ConnectionCatalogSnapshot> {
  const created = await stores.connectionCatalog.create({
    expectedCatalogRevision: snapshot.revision,
    connection: seed.draft,
  });
  snapshot = requireCommitted(created, `create ${seed.draft.slug}`);
  const connection = connectionBySlug(snapshot, seed.draft.slug);

  if (seed.apiKey) await setCredential(stores, connection, seed.apiKey);
  if (seed.modelInventory) {
    const prepared = await stores.operations.beginModelFetch(connection.connectionId);
    if (prepared.kind !== 'ready') fail(seed.draft.slug, 'begin model fetch', prepared.kind);
    const completed = await stores.operations.completeModelFetch(prepared.ticket, {
      ...seed.modelInventory,
      source: 'fetched',
    });
    snapshot = requireCommitted(completed, `complete model fetch for ${seed.draft.slug}`);
  }
  if (seed.verifiedAt) {
    const prepared = await stores.operations.beginConnectionTest(
      connection.connectionId,
      seed.verifiedModelId ?? null,
    );
    if (prepared.kind !== 'ready') fail(seed.draft.slug, 'begin connection test', prepared.kind);
    const completed = await stores.operations.completeConnectionTest(prepared.ticket, {
      status: 'verified',
      checkedAt: seed.verifiedAt,
    });
    snapshot = requireCommitted(completed, `complete connection test for ${seed.draft.slug}`);
  }
  return snapshot;
}

async function setCredential(
  stores: RuntimePolicyStoresWriter,
  connection: ConnectionCatalogEntry,
  secret: string,
): Promise<void> {
  const result = await stores.credentialVault.set({
    locator: {
      scope: 'connection',
      connectionId: connection.connectionId,
      kind: 'api_key',
    },
    expected: null,
    secret,
  });
  if (result.kind !== 'committed') fail(connection.slug, 'set credential', result.kind);
}

function requireCommitted<T extends { readonly kind: string; readonly snapshot?: ConnectionCatalogSnapshot }>(
  result: T,
  operation: string,
): ConnectionCatalogSnapshot {
  if (result.kind !== 'committed' || !result.snapshot) {
    throw new Error(`Connection fixture could not ${operation}: ${result.kind}`);
  }
  return result.snapshot;
}

function connectionBySlug(
  snapshot: ConnectionCatalogSnapshot,
  slug: string,
): ConnectionCatalogEntry {
  const connection = snapshot.connections.find((candidate) => candidate.slug === slug);
  if (!connection) throw new Error(`Connection fixture lost committed entry ${slug}`);
  return connection;
}

function fail(slug: string, operation: string, outcome: string): never {
  throw new Error(`Connection fixture could not ${operation} for ${slug}: ${outcome}`);
}

function fixtureModel(
  id: string,
  capabilities: NonNullable<ConnectionModel['capabilities']>,
  contextWindow: number,
): ConnectionModel {
  return { id, capabilities, contextWindow };
}
