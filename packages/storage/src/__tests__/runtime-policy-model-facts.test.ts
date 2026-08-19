import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimePolicyCoordinator } from '../runtime-policy/coordinator.js';
import { RuntimePolicyStoreError } from '../runtime-policy/errors.js';
import { MODEL_FACTS_DOCUMENT_MAX_BYTES, ModelFactsDocumentOwner } from '../model-facts-store.js';
import { writeJsonDocument } from '../runtime-policy/document-io.js';

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
    const replaced = await coordinator.replaceModelFacts({
      'ollama:custom-model': { contextWindow: 64_000 },
    });
    assert.equal(Object.isFrozen(replaced), true);
    assert.equal(Object.isFrozen(replaced.overrides), true);
    const facts = await coordinator.getModelFacts();
    assert.equal(Object.isFrozen(facts), true);
    assert.equal(Object.isFrozen(facts.document), true);
    assert.equal(Object.isFrozen(facts.document.overrides), true);
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
    const staleTest = await coordinator.beginConnectionTest(
      snapshot.connections[0]!.connectionId,
      null,
    );
    assert.equal(staleTest.kind, 'ready');
    await coordinator.replaceModelFacts({
      'ollama:custom-model': { contextWindow: 65_000 },
    });
    if (staleTest.kind === 'ready') {
      assert.deepEqual(
        await coordinator.completeConnectionTest(staleTest.ticket, {
          status: 'verified',
          checkedAt: '2026-08-01T00:01:00.000Z',
        }),
        { kind: 'superseded', changed: ['connection'] },
      );
    }
    assert.equal((await coordinator.getCatalogSnapshot()).connections[0]?.lastTest, undefined);
    const restarted = new RuntimePolicyCoordinator((operation) => operation(root));
    const persisted = await restarted.getCatalogSnapshot();
    assert.equal(
      persisted.connections[0]?.models.find((candidate) => candidate.id === 'custom-model')
        ?.contextWindow,
      65_000,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('model fetch keeps an enabled facts-backed model outside provider inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-refresh-'));
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const connectionId = await createTestConnection(coordinator);
    await coordinator.replaceModelFacts({
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

    const execution = await coordinator.resolveExecutionConnection('custom-openai');
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

test('model facts are not persisted when verification invalidation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-invalidation-'));
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const catalogOwner = (
      coordinator as unknown as {
        catalog: { clearAllConnectionLastTests: () => Promise<boolean> };
      }
    ).catalog;
    const original = catalogOwner.clearAllConnectionLastTests;
    catalogOwner.clearAllConnectionLastTests = async () => {
      throw new Error('injected invalidation failure');
    };
    try {
      await assert.rejects(
        () => coordinator.replaceModelFacts({ 'ollama:custom-model': { contextWindow: 64_000 } }),
        (error: unknown) =>
          error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown',
      );
    } finally {
      catalogOwner.clearAllConnectionLastTests = original;
    }
    assert.deepEqual((await coordinator.getModelFacts()).document.overrides, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized replacements preserve existing connection verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-oversized-'));
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

    await assert.rejects(
      () => coordinator.replaceModelFacts(oversizedOverrides()),
      (error: unknown) =>
        error instanceof RuntimePolicyStoreError && error.code === 'invalid_policy_input',
    );
    assert.equal(
      (await coordinator.getCatalogSnapshot()).connections[0]?.lastTest?.status,
      'verified',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external model facts edits clear verification, supersede tickets, and warn on malformed input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-external-edit-'));
  const emitWarning = process.emitWarning;
  const warnings: string[] = [];
  process.emitWarning = ((warning: string | Error) => {
    warnings.push(String(warning));
  }) as typeof process.emitWarning;
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const connectionId = await createTestConnection(coordinator);
    await coordinator.replaceModelFacts({ 'ollama:custom-model': { contextWindow: 64_000 } });
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
        overrides: { 'ollama:custom-model': { contextWindow: 65_000 } },
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

test('a post-publication model facts failure supersedes existing connection-test tickets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-facts-unknown-write-'));
  try {
    const coordinator = new RuntimePolicyCoordinator((operation) => operation(root));
    const connectionId = await createTestConnection(coordinator);
    await coordinator.replaceModelFacts({ 'ollama:custom-model': { contextWindow: 64_000 } });
    const ticket = await coordinator.beginConnectionTest(connectionId, null);
    assert.equal(ticket.kind, 'ready');
    const owner = (coordinator as unknown as { modelFacts: ModelFactsDocumentOwner }).modelFacts;
    const original = owner.writeReplacement;
    owner.writeReplacement = async (writeRoot, document) => {
      await writeJsonDocument(
        writeRoot,
        'model-facts.json',
        document,
        MODEL_FACTS_DOCUMENT_MAX_BYTES,
        async () => {
          throw new Error('injected directory sync failure');
        },
      );
      return document;
    };
    try {
      await assert.rejects(
        () => coordinator.replaceModelFacts({ 'ollama:custom-model': { contextWindow: 65_000 } }),
        (error: unknown) =>
          error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown',
      );
    } finally {
      owner.writeReplacement = original;
    }
    if (ticket.kind === 'ready') {
      assert.deepEqual(
        await coordinator.completeConnectionTest(
          ticket.ticket,
          verifiedAt('2026-08-01T00:01:00.000Z'),
        ),
        { kind: 'superseded', changed: ['connection'] },
      );
    }
    const restarted = new RuntimePolicyCoordinator((operation) => operation(root));
    assert.equal(
      (await restarted.getCatalogSnapshot()).connections[0]?.models.find(
        (model) => model.id === 'custom-model',
      )?.contextWindow,
      65_000,
    );
  } finally {
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

function oversizedOverrides() {
  return Object.fromEntries(
    Array.from({ length: 512 }, (_, index) => [
      `ollama:custom-model-${index}`,
      { description: 'x'.repeat(2_048) },
    ]),
  );
}
