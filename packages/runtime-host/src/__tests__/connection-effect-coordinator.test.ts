import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogEntryDraft,
  CredentialStatus,
} from '@maka/core/runtime-policy';
import {
  serializeOAuthSubscriptionTokens,
  type ConnectionEffectFetchTransport,
  type ConnectionTestEffectOutcome,
} from '@maka/runtime';
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
