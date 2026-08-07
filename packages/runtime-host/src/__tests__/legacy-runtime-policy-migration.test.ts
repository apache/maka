import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createConnectionStore,
  createFileCredentialStore,
  createSettingsStore,
} from '@maka/storage';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { migrateLegacyRuntimePolicy } from '../server/legacy-runtime-policy-migration.js';

const JOURNAL_FILE = '.runtime-host-m5-migration.json';

test('imports legacy execution policy from its configuration root', async () => {
  await withMigrationRoot(async ({ root, legacyConfigurationRoot, stores }) => {
    const legacy = createConnectionStore(legacyConfigurationRoot);
    await legacy.create({
      slug: 'legacy-openai',
      name: 'Legacy OpenAI',
      providerType: 'openai',
      defaultModel: 'gpt-4.1',
    });
    await legacy.update('legacy-openai', {
      models: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
      lastTestStatus: 'verified',
      lastTestAt: '2027-01-15T08:00:01.000Z',
    });
    await legacy.setDefault('legacy-openai');
    await createFileCredentialStore(legacyConfigurationRoot).setSecret(
      'legacy-openai',
      'api_key',
      'legacy-api-key',
    );
    await createSettingsStore(legacyConfigurationRoot).update({
      personalization: { displayName: 'Legacy User', assistantTone: 'precise' },
      network: {
        proxy: {
          enabled: true,
          protocol: 'http',
          host: '127.0.0.1',
          port: 8080,
          authEnabled: true,
          username: 'legacy-user',
          password: 'legacy-proxy-password',
        },
      },
      webSearch: {
        enabled: true,
        defaultProvider: 'tavily',
        providers: { tavily: { apiKey: 'legacy-tavily-key' } },
      },
    });

    await migrateLegacyRuntimePolicy({ workspaceRoot: root, legacyConfigurationRoot, stores });

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.connections.length, 1);
    const connection = catalog.connections[0]!;
    assert.equal(connection.slug, 'legacy-openai');
    assert.deepEqual(connection.models, [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }]);
    assert.equal(connection.lastTest?.status, 'verified');
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: connection.connectionId,
      modelId: 'gpt-4.1',
    });

    const execution = await stores.operations.resolveExecutionConnection('legacy-openai');
    assert.equal(execution.kind, 'ready');
    if (execution.kind === 'ready') {
      assert.equal(execution.secretMaterial.connection?.secret, 'legacy-api-key');
    }
    const webSearch = await stores.operations.resolveWebSearchExecution();
    assert.equal(webSearch.kind, 'ready');
    if (webSearch.kind === 'ready') {
      assert.equal(webSearch.secretMaterial.webSearch.secret, 'legacy-tavily-key');
      assert.equal(webSearch.secretMaterial.networkProxy?.secret, 'legacy-proxy-password');
    }
    const policy = await stores.runtimePolicy.getSnapshot();
    assert.deepEqual(policy.policy.personalization, {
      displayName: 'Legacy User',
      assistantTone: 'precise',
    });
    assert.equal(policy.policy.networkProxy.host, '127.0.0.1');
    assert.equal(policy.policy.webSearch.defaultProvider, 'tavily');
    await assertJournalRemoved(root);
  });
});

test('keeps an established Runtime Host policy authoritative over legacy files', async () => {
  await withMigrationRoot(async ({ root, legacyConfigurationRoot, stores }) => {
    await createConnectionStore(legacyConfigurationRoot).create({
      slug: 'legacy-openai',
      name: 'Legacy OpenAI',
      providerType: 'openai',
      defaultModel: 'gpt-4.1',
    });
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'canonical-deepseek',
        name: 'Canonical DeepSeek',
        providerType: 'deepseek',
        enabled: true,
        enabledModelIds: ['deepseek-chat'],
      },
    });
    assert.equal(created.kind, 'committed');

    await migrateLegacyRuntimePolicy({ workspaceRoot: root, legacyConfigurationRoot, stores });

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(
      catalog.connections.map(({ slug }) => slug),
      ['canonical-deepseek'],
    );
    await assertJournalRemoved(root);
  });
});

test('resumes a journaled migration without duplicating committed Connections', async () => {
  await withMigrationRoot(async ({ root, legacyConfigurationRoot, stores }) => {
    const legacy = createConnectionStore(legacyConfigurationRoot);
    await legacy.create({
      slug: 'legacy-openai',
      name: 'Legacy OpenAI',
      providerType: 'openai',
      defaultModel: 'gpt-4.1',
    });
    await legacy.setDefault('legacy-openai');
    await createFileCredentialStore(legacyConfigurationRoot).setSecret(
      'legacy-openai',
      'api_key',
      'legacy-api-key',
    );
    const partiallyImported = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'legacy-openai',
        name: 'Legacy OpenAI',
        providerType: 'openai',
        enabled: true,
        enabledModelIds: ['gpt-4.1'],
      },
    });
    assert.equal(partiallyImported.kind, 'committed');
    await writeFile(
      join(root, JOURNAL_FILE),
      `${JSON.stringify({ version: 1, state: 'importing' })}\n`,
      'utf8',
    );

    await migrateLegacyRuntimePolicy({ workspaceRoot: root, legacyConfigurationRoot, stores });

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.connections.length, 1);
    assert.equal(catalog.connections[0]?.slug, 'legacy-openai');
    assert.equal(catalog.defaultTarget?.modelId, 'gpt-4.1');
    const execution = await stores.operations.resolveExecutionConnection('legacy-openai');
    assert.equal(execution.kind, 'ready');
    if (execution.kind === 'ready') {
      assert.equal(execution.secretMaterial.connection?.secret, 'legacy-api-key');
    }
    await assertJournalRemoved(root);
  });
});

test('upgrades only the untouched historical free bootstrap during import', async () => {
  for (const seed of [
    {
      defaultModel: 'big-pickle',
      enabledModelIds: ['big-pickle'],
    },
    {
      defaultModel: 'nemotron-3-ultra-free',
      enabledModelIds: ['nemotron-3-ultra-free'],
      extras: { makaBootstrap: { id: 'opencode-free', version: 2 } },
    },
  ]) {
    await withMigrationRoot(async ({ root, legacyConfigurationRoot, stores }) => {
      const legacy = createConnectionStore(legacyConfigurationRoot);
      await legacy.create({
        slug: 'opencode-free',
        name: 'OpenCode Free',
        providerType: 'opencode-free',
        ...seed,
      });
      await legacy.setDefault('opencode-free');

      await migrateLegacyRuntimePolicy({ workspaceRoot: root, legacyConfigurationRoot, stores });

      const catalog = await stores.connectionCatalog.getSnapshot();
      assert.deepEqual(catalog.connections[0]?.enabledModelIds, [
        'nemotron-3-ultra-free',
        'mimo-v2.5-free',
        'deepseek-v4-flash-free',
      ]);
      assert.equal(catalog.defaultTarget?.modelId, 'nemotron-3-ultra-free');
    });
  }
});

async function withMigrationRoot(
  run: (input: {
    root: string;
    legacyConfigurationRoot: string;
    stores: Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-migration-'));
  const root = join(base, 'workspace');
  const legacyConfigurationRoot = join(base, 'configuration');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    await run({ root, legacyConfigurationRoot, stores });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function assertJournalRemoved(root: string): Promise<void> {
  await assert.rejects(access(join(root, JOURNAL_FILE)), { code: 'ENOENT' });
}
