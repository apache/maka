import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
    await coordinator.replaceModelFacts({
      'ollama:custom-model': { contextWindow: 65_000, apiProtocol: 'openai-responses' },
    });
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
