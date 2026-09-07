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
import { RuntimePolicyCoordinator } from '../runtime-policy/coordinator.js';

test('runtime policy catalog overlays enabled custom model facts without changing the raw catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-'));
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const created = await coordinator.createConnection({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'custom-openai',
        name: 'Custom OpenAI',
        providerType: 'ollama',
        enabled: true,
        enabledModelIds: ['custom-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    assert.equal(Object.isFrozen(created), true);
    if (created.kind === 'committed') assert.equal(Object.isFrozen(created.snapshot), true);
    await writeModelFacts(root, { 'ollama:custom-model': { contextWindow: 64_000 } });
    const snapshot = await coordinator.getCatalogSnapshot();
    const model = snapshot.connections[0]?.models.find(
      (candidate) => candidate.id === 'custom-model',
    );
    assert.equal(model?.contextWindow, 64_000);
    const prepared = await coordinator.beginConnectionTest(
      snapshot.connections[0]!.connectionId,
      null,
    );
    assert.equal(prepared.kind, 'ready');
    if (prepared.kind === 'ready') {
      const tested = await coordinator.completeConnectionTest(prepared.ticket, {
        status: 'verified',
        checkedAt: '2026-08-01T00:00:00.000Z',
      });
      assert.equal(tested.kind, 'committed');
    }
    assert.equal(
      (await coordinator.getCatalogSnapshot()).connections[0]?.lastTest?.status,
      'verified',
    );
    const restarted = new RuntimePolicyCoordinator((operation) => operation(root));
    const persisted = await restarted.getCatalogSnapshot();
    assert.equal(
      persisted.connections[0]?.models.find((candidate) => candidate.id === 'custom-model')
        ?.contextWindow,
      64_000,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy connection verification survives unrelated model facts overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-legacy-verification-'));
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const connectionId = await createTestConnection(coordinator);
    const prepared = await coordinator.beginConnectionTest(connectionId, null);
    assert.equal(prepared.kind, 'ready');
    if (prepared.kind === 'ready') {
      assert.equal(
        (
          await coordinator.completeConnectionTest(
            prepared.ticket,
            verifiedAt('2026-08-01T00:00:00.000Z'),
          )
        ).kind,
        'committed',
      );
    }

    const catalogPath = join(root, 'connection-catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      connections: Array<Record<string, unknown>>;
    };
    delete catalog.connections[0]!.lastTestModelFactsFingerprint;
    await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`, 'utf8');

    await writeModelFacts(root, { 'openai:unrelated-model': { contextWindow: 64_000 } });
    assert.equal(
      (await coordinator.getCatalogSnapshot()).connections[0]?.lastTest?.status,
      'verified',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('display-only model facts preserve verification and in-flight tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-display-only-'));
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const connectionId = await createTestConnection(coordinator);
    const initial = await coordinator.beginConnectionTest(connectionId, null);
    assert.equal(initial.kind, 'ready');
    if (initial.kind !== 'ready') return;
    assert.equal(
      (
        await coordinator.completeConnectionTest(
          initial.ticket,
          verifiedAt('2026-08-01T00:00:00.000Z'),
        )
      ).kind,
      'committed',
    );

    const inFlight = await coordinator.beginConnectionTest(connectionId, null);
    assert.equal(inFlight.kind, 'ready');
    await writeModelFacts(root, { 'ollama:custom-model': { displayName: 'Friendly name' } });
    assert.equal(
      (await coordinator.getCatalogSnapshot()).connections[0]?.lastTest?.status,
      'verified',
    );
    if (inFlight.kind === 'ready') {
      assert.equal(
        (
          await coordinator.completeConnectionTest(
            inFlight.ticket,
            verifiedAt('2026-08-01T00:01:00.000Z'),
          )
        ).kind,
        'committed',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model fetch keeps an enabled facts-backed model outside provider inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-refresh-'));
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const connectionId = await createTestConnection(coordinator);
    await writeModelFacts(root, {
      'ollama:custom-model': { contextWindow: 64_000 },
      'ollama:unselected-model': { contextWindow: 128_000 },
    });
    const beforeRefresh = await coordinator.getCatalogSnapshot();
    const defaulted = await coordinator.setDefaultTarget({
      expectedCatalogRevision: beforeRefresh.revision,
      target: { connectionId, modelId: 'custom-model' },
    });
    assert.equal(defaulted.kind, 'committed');

    const fetch = await coordinator.beginModelFetch(connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') return;
    const refreshed = await coordinator.completeModelFetch(fetch.ticket, {
      models: [{ id: 'live-model' }],
      source: 'fetched',
      fetchedAt: 1,
    });
    assert.equal(refreshed.kind, 'committed');
    if (refreshed.kind !== 'committed') return;

    const raw = await (
      coordinator as unknown as {
        catalog: {
          read(root: string): Promise<{
            connections: readonly { models: readonly unknown[] }[];
          }>;
        };
      }
    ).catalog.read(root);
    assert.deepEqual(raw.connections[0]?.models, [{ id: 'live-model' }]);
    const projected = refreshed.snapshot.connections[0];
    assert.deepEqual(projected?.enabledModelIds, ['custom-model']);
    assert.deepEqual(refreshed.snapshot.defaultTarget, {
      connectionId,
      modelId: 'custom-model',
    });
    assert.equal(
      projected?.models.find((model) => model.id === 'custom-model')?.contextWindow,
      64_000,
    );
    assert.equal(
      projected?.models.some((model) => model.id === 'unselected-model'),
      false,
    );

    const execution = await coordinator.resolveExecutionConnection({
      kind: 'catalog_slug',
      connectionSlug: 'custom-openai',
    });
    assert.equal(execution.kind, 'ready');
    if (execution.kind === 'ready') {
      assert.equal(
        execution.connection.models?.some((model) => model.id === 'custom-model'),
        true,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model fetch keeps enabled facts-backed models when provider inventory fills the bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-refresh-bound-'));
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const connectionId = await createTestConnection(coordinator);
    await writeModelFacts(root, { 'ollama:custom-model': { contextWindow: 64_000 } });
    const fetch = await coordinator.beginModelFetch(connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') return;
    const refreshed = await coordinator.completeModelFetch(fetch.ticket, {
      models: Array.from({ length: 2_048 }, (_, index) => ({ id: `live-model-${index}` })),
      source: 'fetched',
      fetchedAt: 1,
    });
    assert.equal(refreshed.kind, 'committed');
    if (refreshed.kind !== 'committed') return;
    const projected = refreshed.snapshot.connections[0];
    assert.equal(projected?.models.length, 2_048);
    assert.equal(projected?.models.at(-1)?.id, 'custom-model');
    assert.equal(projected?.models.at(-1)?.contextWindow, 64_000);
    assert.equal(
      projected?.models.some((model) => model.id === 'live-model-2047'),
      false,
    );

    const execution = await coordinator.resolveExecutionConnection({
      kind: 'catalog_slug',
      connectionSlug: 'custom-openai',
    });
    assert.equal(execution.kind, 'ready');
    if (execution.kind === 'ready') {
      const model = execution.connection.models?.find((entry) => entry.id === 'custom-model');
      assert.equal(model?.contextWindow, 64_000);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protocol model facts edits clear verification, supersede tickets, and warn on malformed input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-external-edit-'));
  const emitWarning = process.emitWarning;
  const warnings: string[] = [];
  process.emitWarning = ((warning: string | Error) => {
    warnings.push(String(warning));
  }) as typeof process.emitWarning;
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const connectionId = await createTestConnection(coordinator);
    await writeModelFacts(root, { 'ollama:custom-model': { contextWindow: 64_000 } });
    const verified = await coordinator.beginConnectionTest(connectionId, null);
    assert.equal(verified.kind, 'ready');
    if (verified.kind === 'ready') {
      assert.equal(
        (
          await coordinator.completeConnectionTest(
            verified.ticket,
            verifiedAt('2026-08-01T00:00:00.000Z'),
          )
        ).kind,
        'committed',
      );
    }
    const ticket = await coordinator.beginConnectionTest(connectionId, null);
    assert.equal(ticket.kind, 'ready');
    await writeFile(
      join(root, 'model-facts.json'),
      JSON.stringify({
        schemaVersion: 1,
        overrides: { 'ollama:custom-model': { apiProtocol: 'openai-responses' } },
      }),
      'utf8',
    );
    if (ticket.kind === 'ready') {
      assert.deepEqual(
        await coordinator.completeConnectionTest(
          ticket.ticket,
          verifiedAt('2026-08-01T00:01:00.000Z'),
        ),
        { kind: 'superseded', changed: ['connection'] },
      );
    }
    assert.equal((await coordinator.getCatalogSnapshot()).connections[0]?.lastTest, undefined);

    await writeFile(join(root, 'model-facts.json'), '{not-json}', 'utf8');
    const snapshot = await coordinator.getCatalogSnapshot();
    assert.equal(
      snapshot.connections[0]?.models.find((model) => model.id === 'custom-model')?.contextWindow,
      undefined,
    );
    assert.equal(
      warnings.some((warning) => warning.includes('model-facts.json')),
      true,
    );
  } finally {
    process.emitWarning = emitWarning;
    await rm(root, { recursive: true, force: true });
  }
});

async function createTestConnection(coordinator: RuntimePolicyCoordinator): Promise<string> {
  const created = await coordinator.createConnection({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'custom-openai',
      name: 'Custom OpenAI',
      providerType: 'ollama',
      enabled: true,
      enabledModelIds: ['custom-model'],
    },
  });
  assert.equal(created.kind, 'committed');
  if (created.kind !== 'committed') throw new Error('Expected connection creation to commit');
  return created.snapshot.connections[0]!.connectionId;
}

function verifiedAt(checkedAt: string) {
  return { status: 'verified' as const, checkedAt };
}

async function writeModelFacts(root: string, overrides: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(root, 'model-facts.json'),
    JSON.stringify({ schemaVersion: 1, overrides }),
    'utf8',
  );
}
