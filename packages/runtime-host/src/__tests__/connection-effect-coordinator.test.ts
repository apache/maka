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

import { deferred } from '@maka/core/test-only/async-primitives';
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
import { CONNECTION_CATALOG_MAX_CONNECTIONS } from '@maka/core/runtime-policy';
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
import { resolveExecutionTarget } from '../server/execution-model-authority.js';
import type { ConnectionOnboardingSaveResult, OperationOutcome } from '../protocol/index.js';

const context: ConnectionContext = {
  hostEpoch: 'connection-effect-test-epoch',
  connectionId: 'connection-effect-test-client',
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
      {
        target: { kind: 'create', providerType: 'openai' },
        apiKey: 'first-run-secret',
        baseUrl: null,
      },
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

test('adopts serialized OAuth material with every model the Host verifies', async () => {
  await withFixture(async ({ stores }) => {
    const importedSecret = serializeOAuthSubscriptionTokens({
      access_token: 'gho_import_a',
      refresh_token: 'gho_import_a',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
    let discoverySecret = '';
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async (_connection, secret) => {
        discoverySecret = secret;
        return { ok: true, models: [{ id: 'copilot-a' }, { id: 'copilot-b' }] };
      },
    });

    const adopted = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'create', providerType: 'github-copilot' },
        apiKey: importedSecret,
        baseUrl: null,
        enabledModelIds: [],
      },
      context,
    );

    assertSaved(adopted);
    assert.equal(discoverySecret, 'gho_import_a');
    const updated = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ providerType }) => providerType === 'github-copilot',
    );
    assert.ok(updated);
    assert.deepEqual(updated.enabledModelIds, ['copilot-a', 'copilot-b']);
    assert.equal(
      (
        await stores.operations.exportCredentialMaterial({
          scope: 'connection',
          connectionId: updated.connectionId,
          kind: 'oauth_token',
        })
      )?.secret,
      importedSecret,
    );
  });
});

test('a blocked local adoption cannot overwrite a newer interactive OAuth login', async () => {
  await withFixture(async ({ stores }) => {
    const connection = await createConnection(
      stores,
      0,
      connectionDraft('copilot-race', 'github-copilot'),
    );
    const importA = serializeOAuthSubscriptionTokens({
      access_token: 'gho_import_a',
      refresh_token: 'gho_import_a',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
    const loginB = serializeOAuthSubscriptionTokens({
      access_token: 'gho_login_b',
      refresh_token: 'gho_login_b',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
    const discoveryStarted = deferred<void>();
    const releaseDiscovery = deferred<void>();
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async (_connection, secret) => {
        assert.equal(secret, 'gho_import_a');
        discoveryStarted.resolve();
        await releaseDiscovery.promise;
        return { ok: true, models: [{ id: 'copilot-import-model' }] };
      },
    });

    const adoption = coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: importA,
        baseUrl: null,
        enabledModelIds: [],
      },
      context,
    );
    await discoveryStarted.promise;

    const interactive = await stores.operations.beginInteractiveOAuthLogin({
      attemptId: 'interactive-login-b',
      target: { kind: 'existing', connectionId: connection.connectionId },
    });
    assert.equal(interactive.kind, 'ready');
    if (interactive.kind !== 'ready') throw new Error('Interactive login did not start');
    const committed = await stores.operations.completeInteractiveOAuthLogin(
      interactive.ticket,
      loginB,
    );
    assert.equal(committed.kind, 'committed');

    releaseDiscovery.resolve();
    assert.deepEqual(await adoption, {
      ok: true,
      result: { kind: 'rejected', reason: 'superseded' },
    });
    assert.equal(
      (
        await stores.operations.exportCredentialMaterial({
          scope: 'connection',
          connectionId: connection.connectionId,
          kind: 'oauth_token',
        })
      )?.secret,
      loginB,
    );
    const after = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    assert.equal(
      after?.models.some(({ id }) => id === 'copilot-import-model'),
      false,
    );
  });
});

test('rejects a semantically invalid onboarding endpoint in Storage before discovery', async () => {
  await withFixture(async ({ stores }) => {
    let discoveryRuns = 0;
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async () => {
        discoveryRuns += 1;
        return { ok: true, models: [{ id: 'must-not-be-observed' }] };
      },
    });

    assert.deepEqual(
      await coordinator.handlers['connection.onboarding.verify'](
        {
          target: { kind: 'create', providerType: 'openai-compatible' },
          apiKey: 'relay-secret',
          baseUrl: 'ftp://relay.example.test/v1',
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
    assert.equal(discoveryRuns, 0);
    assert.deepEqual((await stores.connectionCatalog.getSnapshot()).connections, []);
  });
});

test('creates multiple accounts with Host-owned identities without changing the default', async () => {
  await withFixture(async ({ stores }) => {
    const coordinator = onboardingCoordinator(stores, () => undefined, 'gpt-5');
    const save = () =>
      coordinator.handlers['connection.onboarding.save'](
        {
          target: { kind: 'create', providerType: 'openai' },
          apiKey: 'account-secret',
          baseUrl: null,
          enabledModelIds: ['gpt-5'],
        },
        context,
      );

    const first = await save();
    const second = await save();
    assertSaved(first);
    assertSaved(second);
    assert.notEqual(first.result.connection.connectionId, second.result.connection.connectionId);
    assert.equal(first.result.connection.slug, 'openai');
    assert.equal(second.result.connection.slug, 'openai-2');

    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.deepEqual(
      catalog.connections.map(({ connectionId, slug }) => ({ connectionId, slug })),
      [
        { connectionId: first.result.connection.connectionId, slug: 'openai' },
        { connectionId: second.result.connection.connectionId, slug: 'openai-2' },
      ],
    );
    assert.equal(catalog.defaultTarget?.connectionId, first.result.connection.connectionId);
  });
});

test('two create tickets cannot commit the same planned slug', async () => {
  await withFixture(async ({ stores }) => {
    const input = {
      target: { kind: 'create', providerType: 'openai' } as const,
      baseUrl: null,
    };
    const first = await stores.operations.beginConnectionOnboarding(input);
    const second = await stores.operations.beginConnectionOnboarding(input);
    assert.equal(first.kind, 'ready');
    assert.equal(second.kind, 'ready');
    if (first.kind !== 'ready' || second.kind !== 'ready') return;
    assert.equal(first.candidate.slug, 'openai');
    assert.equal(second.candidate.slug, 'openai');
    assert.notEqual(first.candidate.connectionId, second.candidate.connectionId);

    const completion = {
      suppliedSecret: 'secret',
      enabledModelIds: ['gpt-5'],
      discovery: { models: [{ id: 'gpt-5' }], source: 'fetched' as const, fetchedAt: 1 },
    };
    const committed = await stores.operations.completeConnectionOnboarding(
      first.ticket,
      completion,
    );
    assert.equal(committed.kind, 'committed');
    const superseded = await stores.operations.completeConnectionOnboarding(
      second.ticket,
      completion,
    );
    assert.deepEqual(superseded, { kind: 'superseded', changed: ['connection'] });
  });
});

test('onboards a caller-named connection with the requested slug and display name', async () => {
  await withFixture(async ({ stores }) => {
    const coordinator = onboardingCoordinator(stores, () => undefined, 'gpt-5');
    const saved = await coordinator.handlers['connection.onboarding.save'](
      {
        target: {
          kind: 'create',
          providerType: 'openai',
          slug: 'openai-work',
          name: 'Work OpenAI',
        },
        apiKey: 'sk-live',
        baseUrl: null,
        enabledModelIds: ['gpt-5'],
      },
      context,
    );
    assertSaved(saved);
    assert.equal(saved.result.connection.slug, 'openai-work');
    const catalog = await stores.connectionCatalog.getSnapshot();
    const created = catalog.connections.find(({ slug }) => slug === 'openai-work');
    assert.equal(created?.name, 'Work OpenAI');

    // An unnamed follow-up still derives its identity from the catalog — the
    // requested slug never collides with it because the catalog did take it.
    const derived = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'create', providerType: 'openai' },
        apiKey: 'sk-live-2',
        baseUrl: null,
        enabledModelIds: ['gpt-5'],
      },
      context,
    );
    assertSaved(derived);
    assert.equal(derived.result.connection.slug, 'openai');
  });
});

test('rejects a requested slug that is already taken, before any discovery runs', async () => {
  await withFixture(async ({ stores }) => {
    const coordinator = onboardingCoordinator(stores, () => undefined, 'gpt-5');
    const saved = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'create', providerType: 'openai', slug: 'openai-work' },
        apiKey: 'sk-live',
        baseUrl: null,
        enabledModelIds: ['gpt-5'],
      },
      context,
    );
    assertSaved(saved);

    const verify = await coordinator.handlers['connection.onboarding.verify'](
      {
        target: { kind: 'create', providerType: 'openai', slug: 'openai-work' },
        apiKey: 'sk-live-2',
        baseUrl: null,
      },
      context,
    );
    assert.equal(verify.ok, true);
    if (!verify.ok) return;
    assert.deepEqual(verify.result, { kind: 'rejected', reason: 'slug_taken' });

    const save = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'create', providerType: 'openai', slug: 'openai-work' },
        apiKey: 'sk-live-2',
        baseUrl: null,
        enabledModelIds: ['gpt-5'],
      },
      context,
    );
    assert.equal(save.ok, true);
    if (!save.ok) return;
    assert.deepEqual(save.result, { kind: 'rejected', reason: 'slug_taken' });
    // Nothing was created: the taken slug still names exactly one connection.
    const catalog = await stores.connectionCatalog.getSnapshot();
    assert.equal(catalog.connections.filter(({ slug }) => slug === 'openai-work').length, 1);
  });
});

test('a requested slug lost mid-flight reports slug_taken, never a silent rename', async () => {
  await withFixture(async ({ stores }) => {
    const requested = {
      target: { kind: 'create', providerType: 'openai', slug: 'openai-work' } as const,
      baseUrl: null,
    };
    const first = await stores.operations.beginConnectionOnboarding(requested);
    const second = await stores.operations.beginConnectionOnboarding(requested);
    assert.equal(first.kind, 'ready');
    assert.equal(second.kind, 'ready');
    if (first.kind !== 'ready' || second.kind !== 'ready') return;
    assert.equal(first.candidate.slug, 'openai-work');
    assert.equal(second.candidate.slug, 'openai-work');

    const completion = {
      suppliedSecret: 'sk-live',
      enabledModelIds: ['gpt-5'],
      discovery: { models: [{ id: 'gpt-5' }], source: 'fetched' as const, fetchedAt: 1 },
    };
    const committed = await stores.operations.completeConnectionOnboarding(
      first.ticket,
      completion,
    );
    assert.equal(committed.kind, 'committed');
    const lost = await stores.operations.completeConnectionOnboarding(second.ticket, completion);
    assert.deepEqual(lost, { kind: 'slug_taken' });
  });
});

test('reports catalog_full both before discovery and when the last slot fills before commit', async () => {
  await withFixture(async ({ root, stores }) => {
    const connections = Array.from(
      { length: CONNECTION_CATALOG_MAX_CONNECTIONS - 1 },
      (_value, index) => ({
        connectionId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        revision: 1,
        slug: `occupied-${index + 1}`,
        name: `Occupied ${index + 1}`,
        providerType: 'openai' as const,
        enabled: false,
        enabledModelIds: [],
        models: [],
      }),
    );
    await writeFile(
      join(root, 'connection-catalog.json'),
      JSON.stringify({ schemaVersion: 1, revision: 1, defaultTarget: null, connections }),
    );

    const begun = await stores.operations.beginConnectionOnboarding({
      target: { kind: 'create', providerType: 'openai' },
      baseUrl: null,
    });
    assert.equal(begun.kind, 'ready');
    if (begun.kind !== 'ready') return;
    await createConnection(stores, 1, connectionDraft('last-slot', 'openai'));

    const completion = await stores.operations.completeConnectionOnboarding(begun.ticket, {
      suppliedSecret: 'secret',
      enabledModelIds: ['gpt-5'],
      discovery: { models: [{ id: 'gpt-5' }], source: 'fetched', fetchedAt: 1 },
    });
    assert.deepEqual(completion, { kind: 'catalog_full' });

    assert.deepEqual(
      await stores.operations.beginConnectionOnboarding({
        target: { kind: 'create', providerType: 'openai' },
        baseUrl: null,
      }),
      { kind: 'catalog_full' },
    );
  });
});

test('onboards a custom relay end to end: rejects a missing endpoint, discovers and persists a supplied one', async () => {
  await withFixture(async ({ stores }) => {
    let observedBaseUrl: string | undefined;
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => 123,
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async (connection) => {
        observedBaseUrl = connection.baseUrl;
        return { ok: true, models: [{ id: 'relay/model' }] };
      },
    });

    // A relay has no registry endpoint and no existing connection: nothing
    // can answer discovery, so the attempt is rejected before any probe.
    assert.deepEqual(
      await coordinator.handlers['connection.onboarding.verify'](
        {
          target: { kind: 'create', providerType: 'openai-compatible' },
          apiKey: 'relay-secret',
          baseUrl: null,
        },
        context,
      ),
      { ok: true, result: { kind: 'rejected', reason: 'base_url_not_configured' } },
    );
    assert.equal(observedBaseUrl, undefined);

    const saved = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'create', providerType: 'openai-compatible' },
        apiKey: 'relay-secret',
        baseUrl: 'https://relay.example.test/v1',
        enabledModelIds: ['relay/model'],
      },
      context,
    );
    assertSaved(saved);
    assert.equal(saved.result.connection.slug, 'openai-compatible');
    assert.equal(observedBaseUrl, 'https://relay.example.test/v1');

    const connection = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ slug }) => slug === 'openai-compatible',
    );
    assert.equal(connection?.baseUrl, 'https://relay.example.test/v1');
    // Re-verifying with a blank endpoint now reuses the persisted one.
    assert.deepEqual(
      await coordinator.handlers['connection.onboarding.verify'](
        {
          target: {
            kind: 'existing',
            connectionId: saved.result.connection.connectionId,
          },
          apiKey: '',
          baseUrl: null,
        },
        context,
      ),
      { ok: true, result: { kind: 'verified', models: [{ id: 'relay/model' }] } },
    );
  });
});

test('re-onboarding by connection identity edits a Desktop custom-slug relay in place', async () => {
  await withFixture(async ({ stores }) => {
    // Desktop can create a relay under any slug; the wizard resolves that
    // connection's identity and must edit it, not derive a second connection
    // at the canonical slug (#3467 review).
    const connection = await createConnection(stores, 0, {
      ...connectionDraft('my-relay', 'openai-compatible'),
      baseUrl: 'https://relay-a.example.test/v1',
      enabledModelIds: ['relay/model'],
    });
    await setConnectionCredential(stores, connection, 'old-secret');
    let observedBaseUrl: string | undefined;
    let observedSecret: string | undefined;
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => 123,
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async (target, secret) => {
        observedBaseUrl = target.baseUrl;
        observedSecret = secret;
        return { ok: true, models: [{ id: 'relay/model' }] };
      },
    });

    // A blank re-verify against the resolved identity reuses the stored
    // secret and the persisted custom-slug endpoint.
    assert.deepEqual(
      await coordinator.handlers['connection.onboarding.verify'](
        {
          target: { kind: 'existing', connectionId: connection.connectionId },
          apiKey: '',
          baseUrl: null,
        },
        context,
      ),
      { ok: true, result: { kind: 'verified', models: [{ id: 'relay/model' }] } },
    );
    assert.equal(observedBaseUrl, 'https://relay-a.example.test/v1');
    assert.equal(observedSecret, 'old-secret');

    const edited = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: 'new-secret',
        baseUrl: 'https://relay-b.example.test/v1',
        enabledModelIds: ['relay/model'],
      },
      context,
    );
    assertSaved(edited);
    assert.equal(edited.result.connection.connectionId, connection.connectionId);
    assert.equal(edited.result.connection.slug, 'my-relay');
    const catalog = await stores.connectionCatalog.getSnapshot();
    // Edited in place: still exactly one connection, same identity, custom
    // slug preserved, endpoint replaced.
    assert.deepEqual(
      catalog.connections.map(({ connectionId, slug, baseUrl }) => ({
        connectionId,
        slug,
        baseUrl,
      })),
      [
        {
          connectionId: connection.connectionId,
          slug: 'my-relay',
          baseUrl: 'https://relay-b.example.test/v1',
        },
      ],
    );

    // A stale identity is rejected instead of silently creating a duplicate.
    assert.deepEqual(
      await coordinator.handlers['connection.onboarding.verify'](
        {
          target: { kind: 'existing', connectionId: '00000000-0000-4000-8000-00000000dead' },
          apiKey: 'x',
          baseUrl: null,
        },
        context,
      ),
      { ok: true, result: { kind: 'rejected', reason: 'connection_not_found' } },
    );
  });
});

test('a save whose connection changed between discovery and commit is superseded, never mixed', async () => {
  await withFixture(async ({ stores }) => {
    // The #3467 review race: discovery observes relay A/key A, a supported
    // concurrent policy update moves the connection to relay B/key B before
    // the commit, and the save must NOT persist relay B with the model
    // inventory relay A produced.
    const connection = await createConnection(stores, 0, {
      ...connectionDraft('openai-compatible', 'openai-compatible'),
      baseUrl: 'https://relay-a.example.test/v1',
      enabledModelIds: ['relay/original'],
    });
    await setConnectionCredential(stores, connection, 'key-a');

    let releaseDiscovery!: () => void;
    const discoveryPaused = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    let observeDiscovery!: (value: { baseUrl?: string; secret: string }) => void;
    const discoveryObserved = new Promise<{ baseUrl?: string; secret: string }>((resolve) => {
      observeDiscovery = resolve;
    });
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => 999,
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async (target, secret) => {
        observeDiscovery({ baseUrl: target.baseUrl, secret });
        await discoveryPaused;
        return { ok: true, models: [{ id: 'model-from-relay-a' }] };
      },
    });

    const saving = coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: '',
        baseUrl: null,
        enabledModelIds: ['model-from-relay-a'],
      },
      context,
    );
    const observed = await discoveryObserved;
    assert.equal(observed.baseUrl, 'https://relay-a.example.test/v1');
    assert.equal(observed.secret, 'key-a');

    // Concurrent, fully supported policy update while discovery is in flight:
    // move the endpoint and rotate the credential.
    const moved = await stores.connectionCatalog.update({
      expected: { connectionId: connection.connectionId, revision: connection.revision },
      changes: {
        name: connection.name,
        baseUrl: 'https://relay-b.example.test/v1',
        enabled: true,
        enabledModelIds: connection.enabledModelIds,
      },
    });
    assert.equal(moved.kind, 'committed');
    const keyA = await connectionCredentialStatus(stores, connection);
    assert.equal(keyA.configured, true);
    const rotated = await stores.credentialVault.set({
      locator: connectionCredential(connection),
      expected:
        keyA.configured === true
          ? { credentialId: keyA.credentialId, revision: keyA.revision }
          : null,
      secret: 'key-b',
    });
    assert.equal(rotated.kind, 'committed');

    releaseDiscovery();
    assert.deepEqual(await saving, {
      ok: true,
      result: { kind: 'rejected', reason: 'superseded' },
    });

    // Relay B and key B stand untouched; relay A's inventory never landed.
    const after = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    assert.equal(after?.baseUrl, 'https://relay-b.example.test/v1');
    assert.equal(
      after?.models.some(({ id }) => id === 'model-from-relay-a'),
      false,
    );
    assert.deepEqual(after?.enabledModelIds, ['relay/original']);
    assert.equal(
      (await stores.operations.exportCredentialMaterial(connectionCredential(connection)))?.secret,
      'key-b',
    );

    // A retry against the settled state discovers through relay B/key B and
    // commits cleanly.
    const retried = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: '',
        baseUrl: null,
        enabledModelIds: ['model-from-relay-a'],
      },
      context,
    );
    assertSaved(retried);
  });
});

test('provider state identity follows endpoint, credential, and request-header ownership', async () => {
  await withFixture(async ({ stores }) => {
    const connection = await createConnection(stores, 0, {
      ...connectionDraft('identity-relay', 'openai-compatible'),
      baseUrl: 'https://relay-a.example.test/v1',
    });
    await setConnectionCredential(stores, connection, 'key-a');
    const header = {
      llmConnectionId: connection.connectionId,
      llmConnectionSlug: connection.slug,
      model: 'gpt-5',
    };
    const resolveIdentity = async () =>
      (
        await resolveExecutionTarget(
          header,
          stores,
          new HostOAuthExecutionAuthority(stores),
          () => {
            throw new Error('API-key provider must not create an OAuth refresh transport');
          },
        )
      ).providerStateIdentity;
    const initial = await resolveIdentity();

    const moved = await stores.connectionCatalog.update({
      expected: { connectionId: connection.connectionId, revision: connection.revision },
      changes: {
        name: connection.name,
        baseUrl: 'https://relay-b.example.test/v1',
        enabled: true,
        enabledModelIds: connection.enabledModelIds,
      },
    });
    assert.equal(moved.kind, 'committed');
    const afterEndpoint = await resolveIdentity();
    assert.notEqual(afterEndpoint, initial);

    const status = await connectionCredentialStatus(stores, connection);
    assert.equal(status.configured, true);
    if (!status.configured) return;
    const rotated = await stores.credentialVault.set({
      locator: connectionCredential(connection),
      expected: { credentialId: status.credentialId, revision: status.revision },
      secret: 'key-b',
    });
    assert.equal(rotated.kind, 'committed');
    const afterCredential = await resolveIdentity();
    assert.notEqual(afterCredential, afterEndpoint);

    const headers = await stores.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'request_headers',
      },
      expected: null,
      secret: JSON.stringify({ 'X-Relay-Account': 'account-b' }),
    });
    assert.equal(headers.kind, 'committed');
    const afterHeaders = await resolveIdentity();
    assert.notEqual(afterHeaders, afterCredential);
  });
});

test('onboarding probes with the custom request headers the models path sends, and a header rotation supersedes', async () => {
  await withFixture(async ({ stores }) => {
    // A connection that authenticates through a custom header (plus a body
    // overlay) must onboard with the same probe the models path sends —
    // otherwise re-onboarding fails against the very provider that
    // models.fetch reaches fine (#3467 review).
    const headerSecret = 'header-secret-must-not-escape';
    const connection = await createConnection(stores, 0, {
      ...connectionDraft('header-relay', 'openai-compatible'),
      baseUrl: 'https://relay.example.test/v1',
      enabledModelIds: ['relay/model'],
      requestBodyOverlay: { tenant: 'acme' },
    });
    await setConnectionCredential(stores, connection, 'api-key');
    const headersLocator = {
      scope: 'connection' as const,
      connectionId: connection.connectionId,
      kind: 'request_headers' as const,
    };
    const headersSet = await stores.credentialVault.set({
      locator: headersLocator,
      expected: null,
      secret: JSON.stringify({ 'X-Relay-Auth': headerSecret }),
    });
    assert.equal(headersSet.kind, 'committed');

    const probes: Array<{ header: string | null; body: unknown }> = [];
    let releaseDiscovery!: () => void;
    const discoveryPaused = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    let observeDiscovery!: () => void;
    const discoveryObserved = new Promise<void>((resolve) => {
      observeDiscovery = resolve;
    });
    let discoveryRuns = 0;
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => 456,
      createTransport: () => ({
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          probes.push({
            header: request.headers.get('x-relay-auth'),
            body: JSON.parse(await request.text()),
          });
          return new Response('{}', { status: 200 });
        }) as typeof globalThis.fetch,
        close: async () => {},
      }),
      runModelDiscovery: async (_target, _secret, options) => {
        await options.fetch('https://relay.example.test/v1/models', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ probe: true }),
        });
        discoveryRuns += 1;
        if (discoveryRuns === 2) {
          observeDiscovery();
          await discoveryPaused;
        }
        return { ok: true, models: [{ id: 'relay/model' }] };
      },
    });

    const verified = await coordinator.handlers['connection.onboarding.verify'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: '',
        baseUrl: null,
      },
      context,
    );
    assert.equal(verified.ok, true);
    assert.deepEqual(probes, [{ header: headerSecret, body: { probe: true, tenant: 'acme' } }]);
    assertRedacted(verified, [headerSecret]);

    // Rotating the header credential while a save's discovery is in flight
    // invalidates its basis: the committed inventory must describe what the
    // connection would fetch, and that changed under the probe.
    const saving = coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: '',
        baseUrl: null,
        enabledModelIds: ['relay/model'],
      },
      context,
    );
    await discoveryObserved;
    const headerStatus = await stores.credentialVault.getStatus(headersLocator);
    assert.equal(headerStatus.kind === 'status' && headerStatus.status.configured, true);
    if (headerStatus.kind !== 'status' || !headerStatus.status.configured) return;
    const rotated = await stores.credentialVault.set({
      locator: headersLocator,
      expected: {
        credentialId: headerStatus.status.credentialId,
        revision: headerStatus.status.revision,
      },
      secret: JSON.stringify({ 'X-Relay-Auth': 'rotated-header-secret' }),
    });
    assert.equal(rotated.kind, 'committed');
    // The rotation left the catalog row untouched, so this supersede can only
    // come from the header credential joining the discovery basis.
    const row = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    assert.equal(row?.revision, connection.revision);

    releaseDiscovery();
    assert.deepEqual(await saving, {
      ok: true,
      result: { kind: 'rejected', reason: 'superseded' },
    });
    // The save's own probe carried the same customization as the verify's.
    assert.deepEqual(probes[1], probes[0]);
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
        target: { kind: 'create', providerType: 'openai' },
        apiKey: 'first-run-secret',
        baseUrl: null,
        enabledModelIds: ['second-model'],
      },
      context,
    );

    assertSaved(result);
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
        target: { kind: 'existing', connectionId: disabledConnection.connectionId },
        apiKey: null,
        baseUrl: null,
        enabledModelIds: ['restored-model'],
      },
      context,
    );

    assertSaved(result);
    assert.equal(result.result.connection.connectionId, disabledConnection.connectionId);
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
            target: { kind: 'existing', connectionId: connection.connectionId },
            apiKey: 'new-secret',
            baseUrl: null,
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
            target: { kind: 'existing', connectionId: connection.connectionId },
            apiKey: 'new-secret',
            baseUrl: null,
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
    // `gpt-5` was enabled before and discovery did not return it, so the
    // wizard never offered it back — it survives alongside the new pick.
    assert.deepEqual(recovered?.enabledModelIds, ['new-model', 'gpt-5']);
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

    const saved = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: 'new-secret',
        baseUrl: null,
        enabledModelIds: ['gpt-5'],
      },
      context,
    );
    assertSaved(saved);

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

test('onboarding keeps what its wizard never offered and prunes what it did', async () => {
  await withFixture(async ({ stores }) => {
    // Two rules meet here. `relayModelProfiles` is scoped to `enabledModelIds`
    // — the canonical decoder rejects a table keyed by a model the selection
    // dropped, and this write path bypasses that decoder, so the subset
    // invariant has to hold on the way out or the document cannot be read
    // back. And a model the wizard never listed was never offered for the user
    // to keep, so not re-picking it is not a decision to drop it (#1584).
    const connection = await createConnection(stores, 0, {
      ...connectionDraft('openai-compatible', 'openai-compatible'),
      baseUrl: 'https://relay.example.test/v1',
      enabledModelIds: ['kept-model', 'dropped-model'],
      relayModelProfiles: {
        'kept-model': { contextWindow: 128_000 },
        'dropped-model': { contextWindow: 262_144 },
      },
    });
    await setConnectionCredential(stores, connection, 'old-secret');
    const coordinator = onboardingCoordinator(stores, () => undefined, 'kept-model');

    const firstSave = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: 'new-secret',
        baseUrl: null,
        enabledModelIds: ['kept-model'],
      },
      context,
    );
    assertSaved(firstSave);

    const updated = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    // `dropped-model` is absent from what discovery returned, so the wizard
    // could not show it: it survives, and so does its declaration.
    assert.deepEqual(updated?.enabledModelIds, ['kept-model', 'dropped-model']);
    assert.deepEqual(updated?.relayModelProfiles, {
      'kept-model': { contextWindow: 128_000 },
      'dropped-model': { contextWindow: 262_144 },
    });
    // The real failure was on the next read, not on the write.
    assert.deepEqual(
      (await stores.connectionCatalog.getSnapshot()).connections.map(({ slug }) => slug),
      ['openai-compatible'],
    );

    // Declarations are endpoint-keyed, like the update path enforces: a
    // re-onboarding that swaps the relay URL must not carry the old relay's
    // profile table onto the new one.
    const secondSave = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: '',
        baseUrl: 'https://relay-b.example.test/v1',
        enabledModelIds: ['kept-model'],
      },
      context,
    );
    assertSaved(secondSave);
    const swapped = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    assert.equal(swapped?.baseUrl, 'https://relay-b.example.test/v1');
    assert.equal(swapped?.relayModelProfiles, undefined);
  });
});

test('onboarding drops a declaration for a model the wizard offered and the user unchecked', async () => {
  await withFixture(async ({ stores }) => {
    // The other half: discovery listed this model, so the wizard showed it and
    // leaving it unticked IS the decision. Its declaration goes with it, or the
    // persisted table would key a model the selection no longer holds.
    const connection = await createConnection(stores, 0, {
      ...connectionDraft('openai-compatible', 'openai-compatible'),
      baseUrl: 'https://relay.example.test/v1',
      enabledModelIds: ['kept-model', 'unchecked-model'],
      relayModelProfiles: {
        'kept-model': { contextWindow: 128_000 },
        'unchecked-model': { contextWindow: 262_144 },
      },
    });
    await setConnectionCredential(stores, connection, 'old-secret');
    const coordinator = new HostConnectionEffectCoordinator({
      stores,
      activation: new RuntimePolicyActivationGate(),
      oauthCredentials: new HostOAuthExecutionAuthority(stores),
      now: () => 789,
      createTransport: () => recordingTransport(() => undefined),
      runModelDiscovery: async () => ({
        ok: true,
        models: [{ id: 'kept-model' }, { id: 'unchecked-model' }],
      }),
    });

    const saved = await coordinator.handlers['connection.onboarding.save'](
      {
        target: { kind: 'existing', connectionId: connection.connectionId },
        apiKey: 'new-secret',
        baseUrl: null,
        enabledModelIds: ['kept-model'],
      },
      context,
    );
    assertSaved(saved);

    const updated = (await stores.connectionCatalog.getSnapshot()).connections.find(
      ({ connectionId }) => connectionId === connection.connectionId,
    );
    assert.deepEqual(updated?.enabledModelIds, ['kept-model']);
    assert.deepEqual(updated?.relayModelProfiles, { 'kept-model': { contextWindow: 128_000 } });
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
          target: { kind: 'create', providerType: 'openai' },
          apiKey: 'capacity-secret',
          baseUrl: null,
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
    const enrollment = await stores.operations.beginInteractiveOAuthLogin({
      attemptId: 'connection-effect-oauth',
      target: { kind: 'existing', connectionId: connection.connectionId },
    });
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
function assertRedacted(value: unknown, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const text of forbidden) assert.equal(serialized.includes(text), false);
}

function assertSaved(value: OperationOutcome<'connection.onboarding.save'>): asserts value is {
  readonly ok: true;
  readonly result: Extract<ConnectionOnboardingSaveResult, { readonly kind: 'saved' }>;
} {
  assert.equal(value.ok, true);
  if (!value.ok) return;
  assert.equal(value.result.kind, 'saved');
}
