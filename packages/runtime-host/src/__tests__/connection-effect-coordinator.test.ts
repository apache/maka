import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogEntryDraft,
  CredentialStatus,
} from '@maka/core/runtime-policy';
import { serializeOAuthSubscriptionTokens } from '@maka/runtime/subscription-credentials';
import { type ConnectionEffectFetchTransport } from '@maka/runtime/network/scoped-fetch-transport';
import { type ConnectionTestEffectOutcome } from '@maka/runtime/connection-effect-outcome';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { HostConnectionEffectCoordinator } from '../server/connection-effect-coordinator.js';
import { HostOAuthExecutionAuthority } from '../server/oauth-execution-authority.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

const context: ConnectionContext = {
  hostEpoch: 'connection-effect-test-epoch',
  connectionId: 'connection-effect-test-client',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('verifies a first-run API key without persisting a connection or credential', async () => {
  await withFixture(async ({ stores }) => {
    let observed: { slug: string; secret: string } | undefined;
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async (connection, secret) => {
        observed = { slug: connection.slug, secret };
        return { ok: true, models: [{ id: 'verified-model' }] };
      },
    });

    const result = await coordinator.handlers['connection.onboarding.verify'](
      { providerType: 'openai', apiKey: 'first-run-secret' },
      context,
    );

    assert.deepEqual(result, {
      ok: true,
      result: { kind: 'verified', models: [{ id: 'verified-model' }] },
    });
    assert.deepEqual(observed, { slug: 'openai', secret: 'first-run-secret' });
    assert.deepEqual((await stores.connectionCatalog.getSnapshot()).connections, []);
    assert.deepEqual((await stores.credentialVault.getSnapshot()).entries, []);
  });
});

test('saves a verified first-run target through the canonical Host authorities', async () => {
  await withFixture(async ({ stores }) => {
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => 123,
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async () => ({
        ok: true,
        models: [{ id: 'first-model' }, { id: 'second-model' }],
      }),
    });

    const result = await coordinator.handlers['connection.onboarding.save'](
      {
        providerType: 'openai',
        apiKey: 'first-run-secret',
        enabledModelIds: ['second-model'],
      },
      context,
    );

    assert.deepEqual(result, { ok: true, result: { kind: 'saved' } });
    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.connections.length, 1);
    assert.deepEqual(catalog.connections[0]?.models, [
      { id: 'first-model' },
      { id: 'second-model' },
    ]);
    assert.deepEqual(catalog.connections[0]?.enabledModelIds, ['second-model']);
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: catalog.connections[0]?.connectionId,
      modelId: 'second-model',
    });
    const credential = (await stores.credentialVault.getSnapshot()).entries[0];
    assert.equal(credential?.configured, true);
    assert.doesNotMatch(JSON.stringify(credential), /first-run-secret/u);
  });
});

test('re-enables an existing connection without replacing another default target', async () => {
  await withFixture(async ({ stores }) => {
    const defaultConnection = await createConnection(
      stores,
      0,
      connectionDraft('existing-default', 'ollama'),
    );
    const defaulted = await stores.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: 1,
      target: { connectionId: defaultConnection.connectionId, modelId: 'gpt-5' },
    });
    assert.equal(defaulted.kind, 'committed');
    const disabledConnection = await createConnection(stores, 2, {
      slug: 'openai',
      name: 'OpenAI',
      providerType: 'openai',
      enabled: false,
      enabledModelIds: [],
    });
    await setConnectionCredential(stores, disabledConnection, 'stored-secret');
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => 456,
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async (connection, secret) => {
        assert.equal(connection.enabled, false);
        assert.equal(secret, 'stored-secret');
        return { ok: true, models: [{ id: 'restored-model' }] };
      },
    });

    const result = await coordinator.handlers['connection.onboarding.save'](
      {
        providerType: 'openai',
        apiKey: null,
        enabledModelIds: ['restored-model'],
      },
      context,
    );

    assert.deepEqual(result, { ok: true, result: { kind: 'saved' } });
    const catalog = await stores.connectionCatalog.getSnapshot();
    const restored = catalog.connections.find(
      ({ connectionId }) => connectionId === disabledConnection.connectionId,
    );
    assert.equal(restored?.enabled, true);
    assert.deepEqual(restored?.enabledModelIds, ['restored-model']);
    assert.deepEqual(catalog.defaultTarget, {
      connectionId: defaultConnection.connectionId,
      modelId: 'gpt-5',
    });
  });
});

test('leaves canonical onboarding state unchanged when the durable intent cannot be published', {
  skip: process.platform === 'win32',
}, async () => {
  await withFixture(async ({ root, stores }) => {
    const connection = await createConnection(stores, 0, connectionDraft('openai', 'openai'));
    await setConnectionCredential(stores, connection, 'old-secret');
    await recordVerifiedConnection(stores, connection);
    let invalidations = 0;
    const coordinator = onboardingCoordinator(stores, () => {
      invalidations += 1;
    });
    const syncMock = await failFileHandleSync(root, 1);
    try {
      assert.deepEqual(
        await coordinator.handlers['connection.onboarding.save'](
          {
            providerType: 'openai',
            apiKey: 'new-secret',
            enabledModelIds: ['new-model'],
          },
          context,
        ),
        {
          ok: false,
          error: {
            code: 'persistence_failed',
            message: 'Connection effect persistence failed',
          },
        },
      );
    } finally {
      syncMock.mock.restore();
    }

    const catalog = await stores.connectionCatalog.getSnapshot();
    const unchanged = catalog.connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    assert.equal(unchanged?.lastTest?.status, 'verified');
    assert.deepEqual(unchanged?.enabledModelIds, ['gpt-5']);
    assert.equal(
      (await stores.operations.exportCredentialMaterial(connectionCredential(connection)))?.secret,
      'old-secret',
    );
    assert.equal(invalidations, 0);
  });
});

test('recovers a durable onboarding intent instead of rolling back a partial publication', {
  skip: process.platform === 'win32',
}, async () => {
  await withFixture(async ({ root, stores }) => {
    const connection = await createConnection(stores, 0, connectionDraft('openai', 'openai'));
    await setConnectionCredential(stores, connection, 'old-secret');
    await recordVerifiedConnection(stores, connection);
    let invalidations = 0;
    const coordinator = onboardingCoordinator(stores, () => {
      invalidations += 1;
    });
    const syncMock = await failFileHandleSync(root, 5);
    try {
      assert.deepEqual(
        await coordinator.handlers['connection.onboarding.save'](
          {
            providerType: 'openai',
            apiKey: 'new-secret',
            enabledModelIds: ['new-model'],
          },
          context,
        ),
        {
          ok: false,
          error: {
            code: 'commit_outcome_unknown',
            message: 'Connection effect commit outcome is unknown',
          },
        },
      );
    } finally {
      syncMock.mock.restore();
    }

    const catalog = await stores.connectionCatalog.getSnapshot();
    const recovered = catalog.connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    assert.equal(recovered?.lastTest, undefined);
    assert.deepEqual(recovered?.enabledModelIds, ['new-model']);
    assert.deepEqual(recovered?.models, [{ id: 'new-model' }]);
    assert.equal(
      (await stores.operations.exportCredentialMaterial(connectionCredential(connection)))?.secret,
      'new-secret',
    );
    assert.equal(invalidations, 1);
  });
});

test('invalidates a verified result when onboarding rotates only the credential', async () => {
  await withFixture(async ({ stores }) => {
    const connection = await createConnection(stores, 0, connectionDraft('openai', 'openai'));
    await setConnectionCredential(stores, connection, 'old-secret');
    await recordFetchedModel(stores, connection, 'gpt-5');
    await recordVerifiedConnection(stores, connection);
    const coordinator = onboardingCoordinator(stores, () => undefined, 'gpt-5');

    assert.deepEqual(
      await coordinator.handlers['connection.onboarding.save'](
        {
          providerType: 'openai',
          apiKey: 'new-secret',
          enabledModelIds: ['gpt-5'],
        },
        context,
      ),
      { ok: true, result: { kind: 'saved' } },
    );

    const updated = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    assert.equal(updated?.lastTest, undefined);
    assert.equal(
      (await stores.operations.exportCredentialMaterial(connectionCredential(connection)))?.secret,
      'new-secret',
    );
  });
});

test('rejects an oversized final catalog before publishing a recovery intent', async () => {
  await withFixture(async ({ root, stores }) => {
    const existing = {
      schemaVersion: 1,
      revision: 1,
      defaultTarget: null,
      connections: [
        largeCatalogConnection('00000000-0000-4000-8000-000000000001', 'bulk-a', 2_048),
        largeCatalogConnection('00000000-0000-4000-8000-000000000002', 'bulk-b', 1_400),
      ],
    };
    const bytes = `${JSON.stringify(existing, null, 2)}\n`;
    assert.ok(Buffer.byteLength(bytes) < 4 * 1024 * 1024);
    await writeFile(join(root, 'connection-catalog.json'), bytes, { mode: 0o600 });
    assert.equal((await stores.connectionCatalog.getSnapshot()).connections.length, 2);

    const discovered = largeCatalogModels('onboarding', 512);
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async () => ({ ok: true, models: discovered }),
    });
    assert.deepEqual(
      await coordinator.handlers['connection.onboarding.save'](
        {
          providerType: 'openai',
          apiKey: 'capacity-secret',
          enabledModelIds: [discovered[0]!.id],
        },
        context,
      ),
      {
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Connection effect request is invalid',
        },
      },
    );

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.connections.length, 2);
    assert.equal(
      catalog.connections.some(({ slug }) => slug === 'openai'),
      false,
    );
  });
});

test('serializes one connection, runs different connections concurrently, and continues after provider failure', async () => {
  await withFixture(async ({ stores }) => {
    const first = await createConnection(stores, 0, connectionDraft('queue-first', 'ollama'));
    const second = await createConnection(stores, 1, connectionDraft('queue-second', 'ollama'));
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondStarted = deferred<void>();
    const otherStarted = deferred<void>();
    const starts: string[] = [];
    let firstConnectionRuns = 0;
    let transportCloses = 0;

    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      createTransport: () =>
        recordingTransport(() => {
          transportCloses += 1;
        }),
      runModelDiscovery: async (connection) => {
        if (connection.connectionId === second.connectionId) {
          starts.push('other');
          otherStarted.resolve(undefined);
          return { ok: true, models: [{ id: 'other-model' }] };
        }
        firstConnectionRuns += 1;
        if (firstConnectionRuns === 1) {
          starts.push('first');
          firstStarted.resolve(undefined);
          await releaseFirst.promise;
          return { ok: false, error: { kind: 'network' } };
        }
        starts.push('second');
        secondStarted.resolve(undefined);
        return { ok: true, models: [{ id: 'recovered-model' }] };
      },
    });

    const failed = coordinator.handlers['connection.models.fetch'](
      { connectionId: first.connectionId },
      context,
    );
    const recovered = coordinator.handlers['connection.models.fetch'](
      { connectionId: first.connectionId },
      context,
    );
    const concurrent = coordinator.handlers['connection.models.fetch'](
      { connectionId: second.connectionId },
      context,
    );

    await Promise.all([firstStarted.promise, otherStarted.promise]);
    assert.deepEqual(starts, ['first', 'other']);
    releaseFirst.resolve(undefined);
    await secondStarted.promise;

    assert.deepEqual(await failed, {
      ok: true,
      result: { kind: 'failed', errorClass: 'network' },
    });
    assert.equal((await recovered).ok, true);
    assert.equal((await concurrent).ok, true);
    assert.deepEqual(starts, ['first', 'other', 'second']);
    assert.equal(transportCloses, 3);

    const snapshot = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(
      snapshot.connections.find(({ connectionId }) => connectionId === first.connectionId)?.models,
      [{ id: 'recovered-model' }],
    );
    assert.deepEqual(
      snapshot.connections.find(({ connectionId }) => connectionId === second.connectionId)?.models,
      [{ id: 'other-model' }],
    );
  });
});

test('beginDrain rejects new effects while close waits for an already accepted effect', async () => {
  await withFixture(async ({ stores }) => {
    const connection = await createConnection(stores, 0, connectionDraft('drain', 'ollama'));
    const started = deferred<void>();
    const release = deferred<void>();
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      runModelDiscovery: async () => {
        started.resolve(undefined);
        await release.promise;
        return { ok: true, models: [{ id: 'accepted-model' }] };
      },
    });

    const accepted = coordinator.handlers['connection.models.fetch'](
      { connectionId: connection.connectionId },
      context,
    );
    await started.promise;
    coordinator.beginDrain();

    assert.deepEqual(
      await coordinator.handlers['connection.models.fetch'](
        { connectionId: connection.connectionId },
        context,
      ),
      {
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      },
    );

    let closeSettled = false;
    const close = coordinator.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    assert.equal(closeSettled, false);

    release.resolve(undefined);
    assert.equal((await accepted).ok, true);
    await close;
    assert.equal(closeSettled, true);
  });
});

test('provider discovery failure preserves the existing catalog and returns no secret', async () => {
  await withFixture(async ({ stores }) => {
    const connection = await createConnection(stores, 0, connectionDraft('discovery', 'openai'));
    const secret = 'discovery-credential-must-not-escape';
    await setConnectionCredential(stores, connection, secret);
    let run = 0;
    let invalidations = 0;
    let transportCloses = 0;
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => 123,
      onCommittedMutation: () => {
        invalidations += 1;
      },
      createTransport: () =>
        recordingTransport(() => {
          transportCloses += 1;
        }),
      runModelDiscovery: async (_connection, apiKey) => {
        assert.equal(apiKey, secret);
        run += 1;
        if (run === 1) return { ok: true, models: [{ id: 'cached-model' }] };
        return { ok: false, error: { kind: 'auth' } };
      },
    });

    const seeded = await coordinator.handlers['connection.models.fetch'](
      { connectionId: connection.connectionId },
      context,
    );
    assert.equal(seeded.ok, true);
    const beforeFailure = await stores.connectionCatalog.getSnapshot();

    const failed = await coordinator.handlers['connection.models.fetch'](
      { connectionId: connection.connectionId },
      context,
    );

    assert.deepEqual(failed, {
      ok: true,
      result: { kind: 'failed', errorClass: 'auth' },
    });
    assert.deepEqual(await stores.connectionCatalog.getSnapshot(), beforeFailure);
    assert.equal(invalidations, 1);
    assert.equal(transportCloses, 2);
    assertRedacted(failed, [secret]);
    assertRedacted(beforeFailure, [secret]);
  });
});

test('OAuth connection effects resolve the canonical access token instead of sending the vault payload', async () => {
  await withFixture(async ({ stores }) => {
    const connection = await createConnection(
      stores,
      0,
      connectionDraft('oauth-effects', 'openai-codex'),
    );
    const accessToken = 'oauth-access-token-must-not-escape';
    const storedCredential = serializeOAuthSubscriptionTokens({
      access_token: accessToken,
      refresh_token: 'oauth-refresh-token-must-not-escape',
      expires_at: Date.now() + 60 * 60_000,
    });
    const enrollment = await stores.operations.beginInteractiveOAuthLogin(connection.connectionId);
    assert.equal(enrollment.kind, 'ready');
    if (enrollment.kind !== 'ready') throw new Error('OAuth enrollment did not start');
    const credential = await stores.operations.completeInteractiveOAuthLogin(
      enrollment.ticket,
      storedCredential,
    );
    assert.equal(credential.kind, 'committed');
    let transportCloses = 0;
    let receivedDiscoverySecret = '';
    let receivedTestSecret = '';
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      createTransport: () =>
        recordingTransport(() => {
          transportCloses += 1;
        }),
      runModelDiscovery: async (_connection, secret) => {
        receivedDiscoverySecret = secret;
        return { ok: true, models: [{ id: 'gpt-5.6-terra' }] };
      },
      runConnectionTest: async (_connection, secret) => {
        receivedTestSecret = secret;
        return { ok: true, modelId: 'gpt-5.6-terra', latencyMs: 3 };
      },
    });

    const discovery = await coordinator.handlers['connection.models.fetch'](
      { connectionId: connection.connectionId },
      context,
    );
    const tested = await coordinator.handlers['connection.test.run'](
      { connectionId: connection.connectionId, modelId: 'gpt-5.6-terra' },
      context,
    );

    assert.equal(discovery.ok, true);
    assert.equal(tested.ok, true);
    assert.equal(receivedDiscoverySecret, accessToken);
    assert.equal(receivedTestSecret, accessToken);
    assert.notEqual(receivedDiscoverySecret, storedCredential);
    assert.notEqual(receivedTestSecret, storedCredential);
    assert.equal(transportCloses, 2);
    assertRedacted(discovery, [accessToken, storedCredential]);
    assertRedacted(tested, [accessToken, storedCredential]);
  });
});

test('connection test derives a persisted summary from one bounded projection', async () => {
  await withFixture(async ({ stores }) => {
    const connection = await createConnection(stores, 0, connectionDraft('test-failure', 'openai'));
    const secret = 'test-credential-must-not-escape';
    await setConnectionCredential(stores, connection, secret);
    let transportCloses = 0;
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => Date.parse('2026-07-29T12:00:00.000Z'),
      createTransport: () =>
        recordingTransport(() => {
          transportCloses += 1;
        }),
      runConnectionTest: async (_connection, apiKey, _options, modelId) => {
        assert.equal(apiKey, secret);
        assert.equal(modelId, 'gpt-5');
        return {
          ok: false,
          error: { kind: 'auth', statusCode: 401 },
          modelId: 'gpt-5',
          latencyMs: 17,
        };
      },
    });

    const outcome = await coordinator.handlers['connection.test.run'](
      { connectionId: connection.connectionId, modelId: 'gpt-5' },
      context,
    );

    assert.equal(outcome.ok, true);
    if (!outcome.ok || outcome.result.kind !== 'committed') {
      throw new Error('connection test did not commit');
    }
    assert.deepEqual(outcome.result.test, {
      kind: 'failed',
      checkedAt: '2026-07-29T12:00:00.000Z',
      modelId: 'gpt-5',
      latencyMs: 17,
      statusCode: 401,
      errorClass: 'auth',
    });
    assert.equal(transportCloses, 1);

    const persisted = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(persisted.connections[0]?.lastTest, {
      status: 'needs_reauth',
      checkedAt: outcome.result.test.checkedAt,
      errorClass: 'auth',
    });
    assertRedacted(outcome, [secret]);
    assertRedacted(persisted, [secret]);
  });
});

test('projects credential changes during provider I/O as semantic superseded and closes transport', async () => {
  await withFixture(async ({ stores }) => {
    const connection = await createConnection(stores, 0, connectionDraft('superseded', 'openai'));
    await setConnectionCredential(stores, connection, 'credential-v1');
    const started = deferred<void>();
    const release = deferred<void>();
    let transportCloses = 0;
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      createTransport: () =>
        recordingTransport(() => {
          transportCloses += 1;
        }),
      runConnectionTest: async () => {
        started.resolve(undefined);
        await release.promise;
        return {
          ok: true,
          modelId: 'gpt-5',
          latencyMs: 9,
        };
      },
    });

    const pending = coordinator.handlers['connection.test.run'](
      { connectionId: connection.connectionId, modelId: 'gpt-5' },
      context,
    );
    await started.promise;
    const status = await connectionCredentialStatus(stores, connection);
    assert.equal(status.configured, true);
    if (!status.configured) throw new Error('connection credential was not configured');
    assert.equal(
      (
        await stores.credentialVault.set({
          locator: connectionCredential(connection),
          expected: { credentialId: status.credentialId, revision: status.revision },
          secret: 'credential-v2',
        })
      ).kind,
      'committed',
    );
    release.resolve(undefined);

    assert.deepEqual(await pending, {
      ok: true,
      result: { kind: 'superseded', changed: ['credential'] },
    });
    assert.equal(transportCloses, 1);
    assert.equal(
      (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
      undefined,
    );
  });
});

type Writer = RuntimePolicyStoresWriter;

async function withFixture(
  run: (fixture: { root: string; stores: Writer }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-connection-effects-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    await run({ root, stores });
  } finally {
    try {
      await owner.close();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }
}

async function createConnection(
  stores: Writer,
  expectedCatalogRevision: number,
  connection: ConnectionCatalogEntryDraft,
): Promise<ConnectionCatalogEntry> {
  const result = await stores.connectionCatalog.create({ expectedCatalogRevision, connection });
  assert.equal(result.kind, 'committed');
  if (result.kind !== 'committed') throw new Error('connection creation did not commit');
  const created = result.snapshot.connections.find(({ slug }) => slug === connection.slug);
  assert.ok(created);
  return created;
}

function connectionDraft(
  slug: string,
  providerType: ConnectionCatalogEntryDraft['providerType'],
): ConnectionCatalogEntryDraft {
  return {
    slug,
    name: slug,
    providerType,
    enabled: true,
    enabledModelIds: ['gpt-5'],
  };
}

function connectionCredential(connection: ConnectionCatalogEntry) {
  return {
    scope: 'connection' as const,
    connectionId: connection.connectionId,
    kind: 'api_key' as const,
  };
}

async function setConnectionCredential(
  stores: Writer,
  connection: ConnectionCatalogEntry,
  secret: string,
): Promise<void> {
  const result = await stores.credentialVault.set({
    locator: connectionCredential(connection),
    expected: null,
    secret,
  });
  assert.equal(result.kind, 'committed');
}

async function connectionCredentialStatus(
  stores: Writer,
  connection: ConnectionCatalogEntry,
): Promise<CredentialStatus> {
  const result = await stores.credentialVault.getStatus(connectionCredential(connection));
  assert.equal(result.kind, 'status');
  if (result.kind !== 'status') throw new Error('credential query did not return status');
  return result.status;
}

function onboardingCoordinator(
  stores: Writer,
  onCommittedMutation: () => void,
  modelId = 'new-model',
) {
  return new HostConnectionEffectCoordinator({
    stores,
    activation: new RuntimePolicyActivationGate(),
    oauthCredentials: new HostOAuthExecutionAuthority(stores),
    now: () => 789,
    onCommittedMutation,
    createTransport: () => recordingTransport(() => undefined),
    runModelDiscovery: async () => ({ ok: true, models: [{ id: modelId }] }),
  });
}

async function recordFetchedModel(
  stores: Writer,
  connection: ConnectionCatalogEntry,
  modelId: string,
): Promise<void> {
  const prepared = await stores.operations.beginModelFetch(connection.connectionId);
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') throw new Error('model fetch did not start');
  const completed = await stores.operations.completeModelFetch(prepared.ticket, {
    models: [{ id: modelId }],
    source: 'fetched',
    fetchedAt: 1,
  });
  assert.equal(completed.kind, 'committed');
}

async function recordVerifiedConnection(
  stores: Writer,
  connection: ConnectionCatalogEntry,
): Promise<void> {
  const prepared = await stores.operations.beginConnectionTest(connection.connectionId, 'gpt-5');
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') throw new Error('connection test did not start');
  const completed = await stores.operations.completeConnectionTest(prepared.ticket, {
    status: 'verified',
    checkedAt: '2026-08-07T00:00:00.000Z',
  });
  assert.equal(completed.kind, 'committed');
}

async function failFileHandleSync(root: string, targetCall: number) {
  const probe = await open(root, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
  const originalSync = fileHandlePrototype.sync;
  await probe.close();
  let syncCalls = 0;
  return mock.method(fileHandlePrototype, 'sync', async function (this: typeof probe) {
    syncCalls += 1;
    if (syncCalls === targetCall) throw new Error('injected onboarding persistence failure');
    return originalSync.call(this);
  });
}

function largeCatalogConnection(connectionId: string, slug: string, modelCount: number) {
  return {
    connectionId,
    revision: 1,
    slug,
    name: slug,
    providerType: 'ollama' as const,
    enabled: false,
    enabledModelIds: [],
    models: largeCatalogModels(slug, modelCount),
    modelSource: 'fetched' as const,
    modelsFetchedAt: 1,
  };
}

function largeCatalogModels(prefix: string, count: number) {
  return Array.from({ length: count }, (_value, index) => ({
    id: `${prefix}-${index}-`.padEnd(512, 'x'),
    displayName: 'd'.repeat(512),
  }));
}

function recordingTransport(onClose: () => void): ConnectionEffectFetchTransport {
  return {
    fetch: globalThis.fetch,
    close: async () => {
      onClose();
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function assertRedacted(value: unknown, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const text of forbidden) assert.equal(serialized.includes(text), false);
}
