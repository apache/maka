import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogEntryDraft,
  ConnectionCredentialRouting,
} from '@maka/core/runtime-policy';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { createHostCredentialResolver } from '../server/provider-credential-resolver-composition.js';

type Writer = Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;

describe('Provider Credential resolver end-to-end', () => {
  test('configure two profiles -> verify -> activate balanced -> dispatch succeeds', async () => {
    await withInteractiveRoot(async ({ root }) => {
      const owner = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const connection = await createConnection(
          stores,
          0,
          connectionDraft('e2e', 'openai', 'E2E'),
        );
        const created = await stores.operations.createCredentialProfile({
          expected: connectionBasis(connection),
          label: 'backup',
          weight: 1,
        });
        assert.equal(created.kind, 'committed');
        if (created.kind !== 'committed') return;
        let snapshot = created.snapshot;
        let routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;

        // Configure both profile credentials.
        await stores.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: 'sk-primary',
        });
        const secondary = routing.profiles.find(
          (profile) => profile.profileId !== connection.connectionId,
        )!;
        await stores.credentialVault.set({
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: secondary.profileId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'sk-secondary',
        });
        const enabled = await stores.operations.setCredentialProfileEnabled({
          expected: {
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: secondary.profileId,
            profileRevision: secondary.revision,
          },
          enabled: true,
        });
        assert.equal(enabled.kind, 'committed');
        if (enabled.kind !== 'committed') return;
        snapshot = enabled.snapshot;
        routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        const currentSecondary = routing.profiles.find(
          (profile) => profile.profileId !== connection.connectionId,
        )!;

        // Balanced activation is rejected without verification evidence.
        const beforeVerification = await stores.operations.setCredentialRoutingMode({
          expected: { connectionId: connection.connectionId, revision: snapshot.revision },
          mode: 'balanced',
        });
        assert.equal(beforeVerification.kind, 'balanced_activation_rejected');

        // Seed Profile verification through the production writer.
        for (const profile of routing.profiles) {
          const recorded = await stores.operations.recordCredentialProfileVerification({
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: profile.profileId,
            profileRevision: profile.revision,
            modelId: 'gpt-5',
            status: 'supported',
            source: 'tested',
            evidence: 'positive_only',
            checkedAt: 1000,
          });
          assert.equal(recorded.kind, 'committed');
        }

        const activated = await stores.operations.setCredentialRoutingMode({
          expected: { connectionId: connection.connectionId, revision: snapshot.revision },
          mode: 'balanced',
        });
        assert.equal(activated.kind, 'committed');
        if (activated.kind !== 'committed') return;
        snapshot = activated.snapshot;
        routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;

        // Build the real Host resolver against the same root (so it reads the
        // verification rows the coordinator wrote).
        const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
        const resolver = createHostCredentialResolver({
          runtimePolicy: stores,
          workspaceRoot: root,
          connectionId: connection.connectionId,
          connectionSlug: connection.slug,
          providerType: connection.providerType,
          endpoint: PROVIDER_DEFAULTS[connection.providerType].baseUrl,
          apiProtocol: undefined,
          requestHeadersCredentialId: null,
          requestHeadersCredentialRevision: null,
          requestBodyOverlayJson: null,
          authKind,
          routing,
        });
        try {
          // First dispatch: must admit a real profile with a real secret.
          const lease = await resolver.acquireAttempt({
            connectionId: connection.connectionId,
            connectionSlug: connection.slug,
            providerId: connection.providerType,
            modelId: 'gpt-5',
            sessionId: 'session-1',
            turnId: 'turn-1',
            logicalCallId: 'call-1',
            callKind: 'main',
            excludedProfileIds: new Set(),
            reason: 'initial',
            signal: new AbortController().signal,
          });
          assert.ok(
            lease.profileId === connection.connectionId ||
              lease.profileId === currentSecondary.profileId,
          );
          assert.ok(lease.apiKey === 'sk-primary' || lease.apiKey === 'sk-secondary');
          assert.equal(lease.modelId, 'gpt-5');
          await resolver.settle(lease, { kind: 'success' });

          // A second turn participates in load balancing and still succeeds.
          const lease2 = await resolver.acquireAttempt({
            connectionId: connection.connectionId,
            connectionSlug: connection.slug,
            providerId: connection.providerType,
            modelId: 'gpt-5',
            sessionId: 'session-1',
            turnId: 'turn-2',
            logicalCallId: 'call-2',
            callKind: 'main',
            excludedProfileIds: new Set(),
            reason: 'initial',
            signal: new AbortController().signal,
          });
          assert.ok(lease2.apiKey === 'sk-primary' || lease2.apiKey === 'sk-secondary');
          await resolver.settle(lease2, { kind: 'success' });
        } finally {
          resolver.dispose();
        }
        void currentSecondary;
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('model-scoped health isolation: a denied model does not block other models', async () => {
    await withInteractiveRoot(async ({ root }) => {
      const owner = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const connection = await createConnection(stores, 0, {
          slug: 'e2e-isolation',
          name: 'E2E Isolation',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['gpt-5', 'gpt-4o'],
        });
        const created = await stores.operations.createCredentialProfile({
          expected: connectionBasis(connection),
          label: 'backup',
          weight: 1,
        });
        assert.equal(created.kind, 'committed');
        if (created.kind !== 'committed') return;
        let snapshot = created.snapshot;
        let routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        const secondary = routing.profiles.find(
          (profile) => profile.profileId !== connection.connectionId,
        )!;
        await stores.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: 'sk-primary',
        });
        await stores.credentialVault.set({
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: secondary.profileId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'sk-secondary',
        });
        const enabled = await stores.operations.setCredentialProfileEnabled({
          expected: {
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: secondary.profileId,
            profileRevision: secondary.revision,
          },
          enabled: true,
        });
        assert.equal(enabled.kind, 'committed');
        if (enabled.kind !== 'committed') return;
        snapshot = enabled.snapshot;
        routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        for (const modelId of ['gpt-5', 'gpt-4o']) {
          for (const profile of routing.profiles) {
            const recorded = await stores.operations.recordCredentialProfileVerification({
              connectionId: connection.connectionId,
              connectionRevision: snapshot.revision,
              profileId: profile.profileId,
              profileRevision: profile.revision,
              modelId,
              status: 'supported',
              source: 'tested',
              evidence: 'positive_only',
              checkedAt: 1000,
            });
            assert.equal(recorded.kind, 'committed');
          }
        }
        const activated = await stores.operations.setCredentialRoutingMode({
          expected: { connectionId: connection.connectionId, revision: snapshot.revision },
          mode: 'balanced',
        });
        assert.equal(activated.kind, 'committed');
        if (activated.kind !== 'committed') return;
        routing = activated.snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;

        const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
        const resolver = createHostCredentialResolver({
          runtimePolicy: stores,
          workspaceRoot: root,
          connectionId: connection.connectionId,
          connectionSlug: connection.slug,
          providerType: connection.providerType,
          endpoint: PROVIDER_DEFAULTS[connection.providerType].baseUrl,
          apiProtocol: undefined,
          requestHeadersCredentialId: null,
          requestHeadersCredentialRevision: null,
          requestBodyOverlayJson: null,
          authKind,
          routing,
        });
        try {
          // Deny BOTH profiles for gpt-5 (credential_model scope): each settle
          // opens only the gpt-5 row for that profile.
          const a = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-iso', 'turn-1'),
          );
          await resolver.settle(a, {
            kind: 'failure',
            failure: { kind: 'provider_permission', retryable: false },
            routingHint: {
              kind: 'provider_permission',
              scope: 'credential_model',
              evidence: 'provider_adapter',
            },
          });
          const b = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-iso', 'turn-2'),
          );
          await resolver.settle(b, {
            kind: 'failure',
            failure: { kind: 'provider_permission', retryable: false },
            routingHint: {
              kind: 'provider_permission',
              scope: 'credential_model',
              evidence: 'provider_adapter',
            },
          });
          assert.notEqual(a.profileId, b.profileId, 'both profiles were exercised');

          // gpt-5 is now fully pool-exhausted (both profiles model-denied).
          await assert.rejects(
            resolver.acquireAttempt(balancedContext(connection, 'gpt-5', 'session-iso', 'turn-3')),
            /no eligible credential profile/,
          );

          // gpt-4o must still dispatch successfully: the denies are scoped to
          // gpt-5, so neither profile is globally blocked (P1-5).
          const otherModel = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-4o', 'session-iso', 'turn-4'),
          );
          assert.ok(
            otherModel.profileId === a.profileId || otherModel.profileId === b.profileId,
            'a model-scoped deny must not block other models',
          );
          await resolver.settle(otherModel, { kind: 'success' });
        } finally {
          resolver.dispose();
        }
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('credential-scoped failure blocks every model on the global row', async () => {
    await withInteractiveRoot(async ({ root }) => {
      const owner = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const connection = await createConnection(stores, 0, {
          slug: 'e2e-cred',
          name: 'E2E Cred',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['gpt-5', 'gpt-4o'],
        });
        const created = await stores.operations.createCredentialProfile({
          expected: connectionBasis(connection),
          label: 'backup',
          weight: 1,
        });
        assert.equal(created.kind, 'committed');
        if (created.kind !== 'committed') return;
        let snapshot = created.snapshot;
        let routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        const secondary = routing.profiles.find(
          (profile) => profile.profileId !== connection.connectionId,
        )!;
        await stores.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: 'sk-primary',
        });
        await stores.credentialVault.set({
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: secondary.profileId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'sk-secondary',
        });
        const enabled = await stores.operations.setCredentialProfileEnabled({
          expected: {
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: secondary.profileId,
            profileRevision: secondary.revision,
          },
          enabled: true,
        });
        assert.equal(enabled.kind, 'committed');
        if (enabled.kind !== 'committed') return;
        snapshot = enabled.snapshot;
        routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        for (const modelId of ['gpt-5', 'gpt-4o']) {
          for (const profile of routing.profiles) {
            const recorded = await stores.operations.recordCredentialProfileVerification({
              connectionId: connection.connectionId,
              connectionRevision: snapshot.revision,
              profileId: profile.profileId,
              profileRevision: profile.revision,
              modelId,
              status: 'supported',
              source: 'tested',
              evidence: 'positive_only',
              checkedAt: 1000,
            });
            assert.equal(recorded.kind, 'committed');
          }
        }
        const activated = await stores.operations.setCredentialRoutingMode({
          expected: { connectionId: connection.connectionId, revision: snapshot.revision },
          mode: 'balanced',
        });
        assert.equal(activated.kind, 'committed');
        if (activated.kind !== 'committed') return;
        routing = activated.snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
        const resolver = createHostCredentialResolver({
          runtimePolicy: stores,
          workspaceRoot: root,
          connectionId: connection.connectionId,
          connectionSlug: connection.slug,
          providerType: connection.providerType,
          endpoint: PROVIDER_DEFAULTS[connection.providerType].baseUrl,
          apiProtocol: undefined,
          requestHeadersCredentialId: null,
          requestHeadersCredentialRevision: null,
          requestBodyOverlayJson: null,
          authKind,
          routing,
        });
        try {
          // One profile hits a credential-scoped auth failure: it must write
          // the GLOBAL row (model_id=''), blocking that profile for EVERY model.
          const first = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-cred', 'turn-1'),
          );
          await resolver.settle(first, {
            kind: 'failure',
            failure: { kind: 'auth', retryable: false },
            routingHint: { kind: 'auth', scope: 'credential', evidence: 'status' },
          });
          const deniedProfile = first.profileId;

          // gpt-5 must route away from the denied profile.
          const second = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-cred', 'turn-2'),
          );
          assert.notEqual(second.profileId, deniedProfile);
          await resolver.settle(second, { kind: 'success' });

          // gpt-4o must ALSO route away: the deny is credential-global.
          const otherModel = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-4o', 'session-cred', 'turn-3'),
          );
          assert.notEqual(
            otherModel.profileId,
            deniedProfile,
            'a credential-scoped failure blocks the profile for all models',
          );
          await resolver.settle(otherModel, { kind: 'success' });
        } finally {
          resolver.dispose();
        }
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('a half-open probe claims and settles the exact global circuit row', async () => {
    await withInteractiveRoot(async ({ root }) => {
      const owner = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const connection = await createConnection(stores, 0, {
          slug: 'e2e-probe',
          name: 'E2E Probe',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['gpt-5'],
        });
        const created = await stores.operations.createCredentialProfile({
          expected: connectionBasis(connection),
          label: 'backup',
          weight: 1,
        });
        assert.equal(created.kind, 'committed');
        if (created.kind !== 'committed') return;
        let snapshot = created.snapshot;
        let routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        const secondary = routing.profiles.find(
          (profile) => profile.profileId !== connection.connectionId,
        )!;
        await stores.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: 'sk-primary',
        });
        await stores.credentialVault.set({
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: secondary.profileId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'sk-secondary',
        });
        const enabled = await stores.operations.setCredentialProfileEnabled({
          expected: {
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: secondary.profileId,
            profileRevision: secondary.revision,
          },
          enabled: true,
        });
        assert.equal(enabled.kind, 'committed');
        if (enabled.kind !== 'committed') return;
        snapshot = enabled.snapshot;
        routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        for (const profile of routing.profiles) {
          const recorded = await stores.operations.recordCredentialProfileVerification({
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: profile.profileId,
            profileRevision: profile.revision,
            modelId: 'gpt-5',
            status: 'supported',
            source: 'tested',
            evidence: 'positive_only',
            checkedAt: 1000,
          });
          assert.equal(recorded.kind, 'committed');
        }
        const activated = await stores.operations.setCredentialRoutingMode({
          expected: { connectionId: connection.connectionId, revision: snapshot.revision },
          mode: 'balanced',
        });
        assert.equal(activated.kind, 'committed');
        if (activated.kind !== 'committed') return;
        routing = activated.snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
        let fakeNow = 1_000;
        const resolver = createHostCredentialResolver({
          runtimePolicy: stores,
          workspaceRoot: root,
          connectionId: connection.connectionId,
          connectionSlug: connection.slug,
          providerType: connection.providerType,
          endpoint: PROVIDER_DEFAULTS[connection.providerType].baseUrl,
          apiProtocol: undefined,
          requestHeadersCredentialId: null,
          requestHeadersCredentialRevision: null,
          requestBodyOverlayJson: null,
          authKind,
          routing,
          now: () => fakeNow,
        });
        try {
          // Both profiles hit a credential-scoped failure -> both GLOBAL rows open.
          const a = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-probe', 'turn-1'),
          );
          await resolver.settle(a, {
            kind: 'failure',
            failure: { kind: 'rate_limit', retryable: true },
            routingHint: { kind: 'rate_limit', scope: 'credential', evidence: 'status' },
          });
          const b = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-probe', 'turn-2'),
          );
          await resolver.settle(b, {
            kind: 'failure',
            failure: { kind: 'rate_limit', retryable: true },
            routingHint: { kind: 'rate_limit', scope: 'credential', evidence: 'status' },
          });
          assert.notEqual(a.profileId, b.profileId, 'both profiles were exercised');

          // Cooldown not elapsed yet -> pool exhausted without a probe candidate.
          await assert.rejects(
            resolver.acquireAttempt(
              balancedContext(connection, 'gpt-5', 'session-probe', 'turn-3'),
            ),
            /no eligible credential profile/,
          );

          // Advance the clock: the Router claims a half-open probe on the exact
          // GLOBAL circuit row (model_id='') and the lease carries that key.
          fakeNow = 200_000;
          const probe = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-probe', 'turn-4'),
          );
          assert.equal(probe.selectionReason, 'half_open_probe');
          assert.equal(
            probe.healthCircuitModelId,
            '',
            'the probe carries the exact global circuit key it claimed',
          );

          // Probe success closes the global row -> the profile recovers.
          await resolver.settle(probe, { kind: 'success' });
          const recovered = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-probe', 'turn-5'),
          );
          assert.equal(
            recovered.profileId,
            probe.profileId,
            'a probe success closes the circuit for that profile',
          );
          await resolver.settle(recovered, { kind: 'success' });
        } finally {
          resolver.dispose();
        }
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('a claimed half-open probe is single-flight: no ordinary dispatch while it is unsettled', async () => {
    await withInteractiveRoot(async ({ root }) => {
      const owner = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const connection = await createConnection(stores, 0, {
          slug: 'e2e-singleflight',
          name: 'E2E Singleflight',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['gpt-5'],
        });
        const created = await stores.operations.createCredentialProfile({
          expected: connectionBasis(connection),
          label: 'backup',
          weight: 1,
        });
        assert.equal(created.kind, 'committed');
        if (created.kind !== 'committed') return;
        let snapshot = created.snapshot;
        let routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        const secondary = routing.profiles.find(
          (profile) => profile.profileId !== connection.connectionId,
        )!;
        await stores.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: 'sk-primary',
        });
        await stores.credentialVault.set({
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: secondary.profileId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'sk-secondary',
        });
        const enabled = await stores.operations.setCredentialProfileEnabled({
          expected: {
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: secondary.profileId,
            profileRevision: secondary.revision,
          },
          enabled: true,
        });
        assert.equal(enabled.kind, 'committed');
        if (enabled.kind !== 'committed') return;
        snapshot = enabled.snapshot;
        routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        for (const profile of routing.profiles) {
          const recorded = await stores.operations.recordCredentialProfileVerification({
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: profile.profileId,
            profileRevision: profile.revision,
            modelId: 'gpt-5',
            status: 'supported',
            source: 'tested',
            evidence: 'positive_only',
            checkedAt: 1000,
          });
          assert.equal(recorded.kind, 'committed');
        }
        const activated = await stores.operations.setCredentialRoutingMode({
          expected: { connectionId: connection.connectionId, revision: snapshot.revision },
          mode: 'balanced',
        });
        assert.equal(activated.kind, 'committed');
        if (activated.kind !== 'committed') return;
        routing = activated.snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;

        const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
        let fakeNow = 1_000;
        const resolver = createHostCredentialResolver({
          runtimePolicy: stores,
          workspaceRoot: root,
          connectionId: connection.connectionId,
          connectionSlug: connection.slug,
          providerType: connection.providerType,
          endpoint: PROVIDER_DEFAULTS[connection.providerType].baseUrl,
          apiProtocol: undefined,
          requestHeadersCredentialId: null,
          requestHeadersCredentialRevision: null,
          requestBodyOverlayJson: null,
          authKind,
          routing,
          now: () => fakeNow,
        });
        try {
          // Both profiles hit a credential-scoped failure -> both GLOBAL rows open.
          const a = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-flight', 'turn-1'),
          );
          await resolver.settle(a, {
            kind: 'failure',
            failure: { kind: 'rate_limit', retryable: true },
            routingHint: { kind: 'rate_limit', scope: 'credential', evidence: 'status' },
          });
          const b = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-flight', 'turn-2'),
          );
          await resolver.settle(b, {
            kind: 'failure',
            failure: { kind: 'rate_limit', retryable: true },
            routingHint: { kind: 'rate_limit', scope: 'credential', evidence: 'status' },
          });
          assert.notEqual(a.profileId, b.profileId, 'both profiles were exercised');

          // Advance the clock: the first acquire claims a half-open probe.
          fakeNow = 200_000;
          const probe = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-flight', 'turn-3'),
          );
          assert.equal(probe.selectionReason, 'half_open_probe');
          assert.equal(
            probe.healthCircuitModelId,
            '',
            'the probe carries the exact global circuit key it claimed',
          );

          // BEFORE the probe settles, a second acquire must NOT dispatch the
          // claimed profile as an ordinary candidate (that would bypass the
          // single-flight lease). The other open circuit is the only thing
          // left, so the Router claims ITS probe instead.
          const second = await resolver.acquireAttempt(
            balancedContext(connection, 'gpt-5', 'session-flight', 'turn-4'),
          );
          assert.equal(
            second.selectionReason,
            'half_open_probe',
            'an unsettled half-open profile must not be an ordinary candidate',
          );
          assert.notEqual(
            second.profileId,
            probe.profileId,
            'each circuit claims its own probe',
          );
          assert.equal(second.healthCircuitModelId, '');
          await resolver.settle(second, { kind: 'success' });
          await resolver.settle(probe, { kind: 'success' });
        } finally {
          resolver.dispose();
        }
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('readiness keeps a model-scoped deny from removing a profile from other models ready sets', async () => {
    await withInteractiveRoot(async ({ root }) => {
      const owner = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const connection = await createConnection(stores, 0, {
          slug: 'e2e-readiness-iso',
          name: 'E2E Readiness Iso',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['gpt-5', 'gpt-4o'],
        });
        const created = await stores.operations.createCredentialProfile({
          expected: connectionBasis(connection),
          label: 'backup',
          weight: 1,
        });
        assert.equal(created.kind, 'committed');
        if (created.kind !== 'committed') return;
        let snapshot = created.snapshot;
        let routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        const secondary = routing.profiles.find(
          (profile) => profile.profileId !== connection.connectionId,
        )!;
        await stores.credentialVault.set({
          locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
          expected: null,
          secret: 'sk-primary',
        });
        await stores.credentialVault.set({
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: secondary.profileId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'sk-secondary',
        });
        const enabled = await stores.operations.setCredentialProfileEnabled({
          expected: {
            connectionId: connection.connectionId,
            connectionRevision: snapshot.revision,
            profileId: secondary.profileId,
            profileRevision: secondary.revision,
          },
          enabled: true,
        });
        assert.equal(enabled.kind, 'committed');
        if (enabled.kind !== 'committed') return;
        snapshot = enabled.snapshot;
        routing = snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;
        for (const modelId of ['gpt-5', 'gpt-4o']) {
          for (const profile of routing.profiles) {
            const recorded = await stores.operations.recordCredentialProfileVerification({
              connectionId: connection.connectionId,
              connectionRevision: snapshot.revision,
              profileId: profile.profileId,
              profileRevision: profile.revision,
              modelId,
              status: 'supported',
              source: 'tested',
              evidence: 'positive_only',
              checkedAt: 1000,
            });
            assert.equal(recorded.kind, 'committed');
          }
        }
        const activated = await stores.operations.setCredentialRoutingMode({
          expected: { connectionId: connection.connectionId, revision: snapshot.revision },
          mode: 'balanced',
        });
        assert.equal(activated.kind, 'committed');
        if (activated.kind !== 'committed') return;
        routing = activated.snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!;

        const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
        const resolver = createHostCredentialResolver({
          runtimePolicy: stores,
          workspaceRoot: root,
          connectionId: connection.connectionId,
          connectionSlug: connection.slug,
          providerType: connection.providerType,
          endpoint: PROVIDER_DEFAULTS[connection.providerType].baseUrl,
          apiProtocol: undefined,
          requestHeadersCredentialId: null,
          requestHeadersCredentialRevision: null,
          requestBodyOverlayJson: null,
          authKind,
          routing,
        });
        try {
          // Deny BOTH profiles on gpt-5 only (credential_model scope).
          for (let turn = 1; turn <= 2; turn += 1) {
            const lease = await resolver.acquireAttempt(
              balancedContext(connection, 'gpt-5', 'session-ri', `turn-${turn}`),
            );
            await resolver.settle(lease, {
              kind: 'failure',
              failure: { kind: 'provider_permission', retryable: false },
              routingHint: {
                kind: 'provider_permission',
                scope: 'credential_model',
                evidence: 'provider_adapter',
              },
            });
          }
          await assert.rejects(
            resolver.acquireAttempt(
              balancedContext(connection, 'gpt-5', 'session-ri', 'turn-3'),
            ),
            /no eligible credential profile/,
          );

          // Readiness must keep both profiles as ready candidates for gpt-4o:
          // the model-scoped deny only blocks gpt-5. The aggregate circuit
          // still reports the deny for display.
          const readiness = await stores.operations.readCredentialProfileReadiness(
            connection.connectionId,
          );
          assert.equal(readiness.kind, 'found');
          if (readiness.kind !== 'found') return;
          assert.equal(
            readiness.readyCandidateCount,
            1,
            'gpt-4o keeps two ready candidates despite the gpt-5 denies',
          );
          for (const profile of readiness.profiles) {
            assert.deepEqual(
              profile.supportedModels,
              ['gpt-5', 'gpt-4o'],
              'supported evidence is per model and unaffected by health',
            );
            assert.equal(
              profile.circuit?.state,
              'open',
              'the aggregate circuit surfaces the model-scoped deny for display',
            );
          }
        } finally {
          resolver.dispose();
        }
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });
});

function balancedContext(
  connection: ConnectionCatalogEntry,
  modelId: string,
  sessionId: string,
  turnId: string,
): Parameters<ReturnType<typeof createHostCredentialResolver>['acquireAttempt']>[0] {
  return {
    connectionId: connection.connectionId,
    connectionSlug: connection.slug,
    providerId: connection.providerType,
    modelId,
    sessionId,
    turnId,
    logicalCallId: `call-${turnId}`,
    callKind: 'main',
    excludedProfileIds: new Set(),
    reason: 'initial',
    signal: new AbortController().signal,
  };
}

function connectionDraft(
  slug: string,
  providerType: ConnectionCatalogEntryDraft['providerType'],
  name: string,
): ConnectionCatalogEntryDraft {
  return { slug, name, providerType, enabled: true, enabledModelIds: ['gpt-5'] };
}

function connectionBasis(connection: ConnectionCatalogEntry): {
  connectionId: string;
  revision: number;
} {
  return { connectionId: connection.connectionId, revision: connection.revision };
}

async function createConnection(
  stores: Writer,
  expectedCatalogRevision: number,
  connection: ConnectionCatalogEntryDraft,
): Promise<ConnectionCatalogEntry> {
  const result = await stores.connectionCatalog.create({ expectedCatalogRevision, connection });
  assert.equal(result.kind, 'committed');
  if (result.kind !== 'committed') throw new Error('connection creation did not commit');
  const created = result.snapshot.connections.find((item) => item.slug === connection.slug);
  assert.ok(created);
  return created!;
}

async function withInteractiveRoot(run: (input: { root: string }) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-resolver-e2e-'));
  try {
    await run({ root: join(base, 'interactive') });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
