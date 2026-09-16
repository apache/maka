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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import type { ModelOverride } from '@maka/core/model-thinking';
import { RuntimePolicyCoordinator } from '../runtime-policy/coordinator.js';

test('one connection declaration survives discovery, disabling, clearing fields and restart', async () => {
  await withCatalog(async (root, owner) => {
    const first = await create(owner, 'first');
    const second = await create(owner, 'second');
    const saved = await update(owner, first, {
      contextWindow: 64000,
      compactionThreshold: 48000,
      vision: true,
    });
    assert.equal(saved.kind, 'committed');
    const resolved = await owner.resolveExecutionConnection({
      kind: 'catalog_slug',
      connectionSlug: first.slug,
    });
    assert.equal(resolved.kind, 'ready');
    if (resolved.kind !== 'ready') return;
    assert.equal(resolved.connection.models.find((m) => m.id === 'manual')?.contextWindow, 64000);
    const other = await owner.resolveExecutionConnection({
      kind: 'catalog_slug',
      connectionSlug: second.slug,
    });
    assert.equal(other.kind, 'ready');
    if (other.kind === 'ready')
      assert.equal(
        other.connection.models.find((m) => m.id === 'manual')?.contextWindow,
        undefined,
      );

    const fetched = await owner.beginModelFetch(first.connectionId);
    assert.equal(fetched.kind, 'ready');
    if (fetched.kind !== 'ready') return;
    assert.equal(
      (
        await owner.completeModelFetch(fetched.ticket, {
          models: [{ id: 'remote' }],
          source: 'fetched',
          fetchedAt: 1,
        })
      ).kind,
      'committed',
    );
    const fresh = (await owner.getCatalogSnapshot()).connections.find(
      (c) => c.connectionId === first.connectionId,
    )!;
    assert.equal((await update(owner, fresh, {}, [])).kind, 'committed');
    const restarted = new RuntimePolicyCoordinator((operation) => operation(root));
    const snapshot = await restarted.getCatalogSnapshot();
    const persisted = snapshot.connections.find((c) => c.connectionId === first.connectionId)!;
    assert.deepEqual(persisted.modelOverrides, { manual: {} });
    assert.deepEqual(persisted.enabledModelIds, []);
    assert.deepEqual(persisted.models, [{ id: 'remote' }]);
    assert.equal(
      snapshot.connections.find((c) => c.connectionId === second.connectionId)?.modelOverrides,
      undefined,
    );
    assert.equal((await update(owner, fresh, { vision: false })).kind, 'connection_stale');
    assert.deepEqual(
      (await restarted.getCatalogSnapshot()).connections.find(
        (c) => c.connectionId === first.connectionId,
      )?.modelOverrides,
      { manual: {} },
    );
  });
});

test('schema one converts both old declarations once and ignores the old file after atomic save', async () => {
  await withCatalog(async (root, owner) => {
    const connection = await create(owner, 'legacy');
    const path = join(root, 'connection-catalog.json');
    const document = JSON.parse(await readFile(path, 'utf8'));
    document.schemaVersion = 1;
    document.connections[0].relayModelProfiles = {
      manual: { contextWindow: 32000, vision: false },
    };
    await writeFile(path, JSON.stringify(document));
    await writeFile(
      join(root, 'model-facts.json'),
      JSON.stringify({
        schemaVersion: 1,
        overrides: { 'ollama:manual': { contextWindow: 64000, capabilities: { vision: true } } },
      }),
    );
    const migrated = (await owner.getCatalogSnapshot()).connections[0]!;
    assert.deepEqual(migrated.modelOverrides, {
      manual: {
        contextWindow: 64000,
        compactionThreshold: 64000,
        vision: false,
      },
    });
    assert.equal(
      (await update(owner, migrated, { ...migrated.modelOverrides?.manual, contextWindow: 128000 }))
        .kind,
      'committed',
    );
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 2);
    await writeFile(join(root, 'model-facts.json'), '{broken legacy input');
    const restarted = new RuntimePolicyCoordinator((operation) => operation(root));
    assert.deepEqual((await restarted.getCatalogSnapshot()).connections[0]?.modelOverrides, {
      manual: { contextWindow: 128000, compactionThreshold: 64000, vision: false },
    });
    assert.equal(connection.connectionId, migrated.connectionId);
  });
});

test('independent limits survive restart and conflicting saves leave the document untouched', async () => {
  await withCatalog(async (root, owner) => {
    let connection = await create(owner, 'limits');
    const fetched = await owner.beginModelFetch(connection.connectionId);
    assert.equal(fetched.kind, 'ready');
    if (fetched.kind !== 'ready') throw new Error('fetch unavailable');
    await owner.completeModelFetch(fetched.ticket, {
      models: [{ id: 'manual', contextWindow: 64000, inputLimit: 32000 }],
      source: 'fetched',
      fetchedAt: 1,
    });
    for (const override of [
      { contextWindow: 200000, inputLimit: 160000 },
      { contextWindow: 200000 },
      { inputLimit: 48000 },
      {},
    ]) {
      connection = (await owner.getCatalogSnapshot()).connections[0]!;
      assert.equal((await update(owner, connection, override)).kind, 'committed');
      owner = new RuntimePolicyCoordinator((operation) => operation(root));
      connection = (await owner.getCatalogSnapshot()).connections[0]!;
      assert.deepEqual(connection.modelOverrides?.manual, override);
      const resolved = await owner.resolveExecutionConnection({
        kind: 'catalog_slug',
        connectionSlug: 'limits',
      });
      assert.equal(resolved.kind, 'ready');
      if (resolved.kind !== 'ready') throw new Error('execution unavailable');
      const model = resolved.connection.models.find((model) => model.id === 'manual')!;
      assert.equal(model.contextWindow, override.contextWindow ?? 64000);
      assert.equal(model.inputLimit, override.inputLimit ?? 32000);
    }
    const path = join(root, 'connection-catalog.json');
    const before = await readFile(path, 'utf8');
    await assert.rejects(
      update(owner, connection, { contextWindow: 16000 }),
      /input limit exceeds/i,
    );
    assert.equal(await readFile(path, 'utf8'), before);
  });
});

test('only execution-affecting declarations invalidate connection test tickets', async () => {
  await withCatalog(async (_root, owner) => {
    let connection = await create(owner, 'tested');
    const displayTest = await owner.beginConnectionTest(connection.connectionId, 'manual');
    assert.equal(displayTest.kind, 'ready');
    assert.equal((await update(owner, connection, { displayName: 'Friendly' })).kind, 'committed');
    if (displayTest.kind === 'ready')
      assert.equal(
        (
          await owner.completeConnectionTest(displayTest.ticket, {
            status: 'verified',
            checkedAt: '2026-09-12T00:00:00.000Z',
          })
        ).kind,
        'committed',
      );
    connection = (await owner.getCatalogSnapshot()).connections[0]!;
    const protocolTest = await owner.beginConnectionTest(connection.connectionId, 'manual');
    assert.equal(protocolTest.kind, 'ready');
    assert.equal(
      (await update(owner, connection, { apiProtocol: 'openai-responses' })).kind,
      'committed',
    );
    if (protocolTest.kind === 'ready')
      assert.equal(
        (
          await owner.completeConnectionTest(protocolTest.ticket, {
            status: 'verified',
            checkedAt: '2026-09-12T00:01:00.000Z',
          })
        ).kind,
        'superseded',
      );
    assert.equal((await owner.getCatalogSnapshot()).connections[0]?.lastTest, undefined);
  });
});

async function create(
  owner: RuntimePolicyCoordinator,
  slug: string,
): Promise<ConnectionCatalogEntry> {
  const result = await owner.createConnection({
    expectedCatalogRevision: (await owner.getCatalogSnapshot()).revision,
    connection: {
      slug,
      name: slug,
      providerType: 'ollama',
      enabled: true,
      enabledModelIds: ['manual'],
    },
  });
  assert.equal(result.kind, 'committed');
  if (result.kind !== 'committed') throw new Error('creation failed');
  return result.snapshot.connections.find((c) => c.slug === slug)!;
}

function update(
  owner: RuntimePolicyCoordinator,
  connection: ConnectionCatalogEntry,
  override: ModelOverride,
  enabledModelIds: readonly string[] = connection.enabledModelIds,
) {
  return owner.updateConnection({
    expected: { connectionId: connection.connectionId, revision: connection.revision },
    changes: {
      name: connection.name,
      enabled: connection.enabled,
      enabledModelIds,
      modelOverrides: { manual: override },
    },
  });
}

async function withCatalog(run: (root: string, owner: RuntimePolicyCoordinator) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'maka-model-overrides-'));
  try {
    await run(root, new RuntimePolicyCoordinator((operation) => operation(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
