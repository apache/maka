import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, mock, test } from 'node:test';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogEntryDraft,
  ConnectionVersionBasis,
  CredentialLocator,
  CredentialStatus,
  CredentialVersionBasis,
  MutateRuntimePolicyInput,
  RuntimePolicy,
} from '@maka/core/runtime-policy';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootLease,
} from '../root-authority.js';
import {
  authenticateRuntimePolicyStoresReader,
  authenticateRuntimePolicyStoresWriter,
  openInteractiveRuntimePolicyStoresForRead,
  openInteractiveRuntimePolicyStoresForWrite,
  RuntimePolicyStoreError,
} from '../runtime-policy-stores.js';

const execFileAsync = promisify(execFile);

describe('runtime policy stores', () => {
  test('seeds the canonical inventory for fallback-only providers', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(stores, 0, {
        ...connectionDraft('opencode-free', 'opencode-free', 'OpenCode Free'),
        enabledModelIds: ['big-pickle'],
      });

      assert.deepEqual(
        connection.models,
        PROVIDER_DEFAULTS['opencode-free'].fallbackModels.map((id) => ({ id })),
      );
      assert.equal(connection.modelSource, 'fallback');
      assert.equal(connection.modelsFetchedAt, 0);
    });
  });

  test('commits closed policy mutations, canonicalizes proxy hosts, and preserves connection identity', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const policy = await stores.runtimePolicy.mutate(personalizationMutation(0));
      assert.equal(policy.kind, 'committed');
      assert.deepEqual(
        await stores.runtimePolicy.mutate({
          expectedRevision: 0,
          operation: {
            kind: 'set_memory',
            value: { enabled: false, agentReadEnabled: false },
          },
        }),
        {
          kind: 'revision_conflict',
          expectedRevision: 0,
          actualRevision: 1,
        },
      );
      await assert.rejects(
        () =>
          stores.runtimePolicy.mutate({
            expectedRevision: 1,
            operation: { kind: 'replace_everything', value: {} },
          } as unknown as MutateRuntimePolicyInput),
        isStoreError('invalid_policy_input'),
      );
      for (const host of ['   ', 'proxy\u0000.internal']) {
        await assert.rejects(
          () => stores.runtimePolicy.mutate(networkProxyMutation(1, { host })),
          isStoreError('invalid_policy_input'),
        );
      }
      const proxy = await stores.runtimePolicy.mutate(
        networkProxyMutation(1, {
          host: ' proxy.internal ',
          authEnabled: false,
          username: '',
        }),
      );
      assert.equal(proxy.kind, 'committed');
      if (proxy.kind === 'committed')
        assert.equal(proxy.snapshot.policy.networkProxy.host, 'proxy.internal');

      const connection = await createConnection(stores, 0, {
        ...connectionDraft('openai-main', 'openai', 'OpenAI'),
        baseUrl: 'HTTPS://API.OPENAI.COM:443/v1',
      });
      assert.match(connection.connectionId, UUID_PATTERN);
      assert.equal(connection.baseUrl, undefined);
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.baseUrl,
        undefined,
      );
      assert.deepEqual(connectionBasis(connection), {
        connectionId: connection.connectionId,
        revision: 1,
      });

      const target = { connectionId: connection.connectionId, modelId: 'gpt-5' };
      assert.equal(
        (
          await stores.connectionCatalog.setDefaultTarget({
            expectedCatalogRevision: 1,
            target,
          })
        ).kind,
        'committed',
      );

      const changes = {
        name: 'Renamed',
        baseUrl: ' https://Gateway.EXAMPLE:443/v1 ',
        enabled: true,
        enabledModelIds: ['gpt-5'],
      };
      await assert.rejects(
        () =>
          stores.connectionCatalog.update({
            expected: connectionBasis(connection),
            changes: { ...changes, slug: 'replacement', providerType: 'anthropic' },
          } as never),
        isStoreError('invalid_connection_input'),
      );
      const updated = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes,
      });
      assert.equal(updated.kind, 'committed');
      if (updated.kind !== 'committed') return;
      const current = updated.snapshot.connections[0];
      assert.ok(current);
      assert.equal(current.connectionId, connection.connectionId);
      assert.equal(current.slug, 'openai-main');
      assert.equal(current.providerType, 'openai');
      assert.equal(current.name, 'Renamed');
      assert.equal(current.baseUrl, 'https://gateway.example/v1');
      assert.deepEqual(updated.snapshot.defaultTarget, target);

      const persisted = JSON.parse(
        await readFile(join(root, 'connection-catalog.json'), 'utf8'),
      ) as {
        connections: Array<Record<string, unknown>>;
      };
      assert.equal(persisted.connections[0]?.baseUrl, 'https://gateway.example/v1');
    });
  });

  test('rejects a valid mutation whose combined policy document exceeds its byte limit', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const committed = await stores.runtimePolicy.mutate(personalizationMutation(0));
      assert.equal(committed.kind, 'committed');
      if (committed.kind !== 'committed') return;
      const path = join(root, 'runtime-policy.json');
      const persistedBefore = await readFile(path);

      const entries = Array.from(
        { length: 64 },
        (_, index) => `domain-${index}-${'x'.repeat(480)}`,
      );
      await assert.rejects(
        () =>
          stores.runtimePolicy.mutate(
            networkProxyMutation(1, {
              bypassList: entries.map((entry) => `bypass-${entry}`),
              autoBypassDomains: entries.map((entry) => `auto-${entry}`),
            }),
          ),
        isStoreError('invalid_policy_input'),
      );

      assert.deepEqual(await stores.runtimePolicy.getSnapshot(), committed.snapshot);
      assert.deepEqual(await readFile(path), persistedBefore);
    });
  });

  test('rejects a valid create when the aggregate catalog exceeds its byte limit', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const enabledModelIds = Array.from({ length: 512 }, (_, index) => {
        const prefix = index.toString(36).padStart(4, '0');
        return `${prefix}-${'m'.repeat(507)}`;
      });
      let revision = 0;
      let rejected = false;

      for (let index = 0; index < 32; index += 1) {
        try {
          const result = await stores.connectionCatalog.create({
            expectedCatalogRevision: revision,
            connection: {
              ...connectionDraft(`catalog-cap-${index}`, 'openai', `Catalog cap ${index}`),
              enabledModelIds,
            },
          });
          assert.equal(result.kind, 'committed');
          if (result.kind !== 'committed') {
            throw new Error('catalog capacity setup did not commit');
          }
          revision = result.snapshot.revision;
        } catch (error) {
          assert.ok(isStoreError('invalid_connection_input')(error));
          rejected = true;
          break;
        }
      }

      assert.equal(rejected, true);
      const snapshot = await stores.connectionCatalog.getSnapshot();
      assert.equal(snapshot.revision, revision);
      assert.equal(snapshot.connections.length, revision);
    });
  });

  test('rejects a valid secret when the aggregate vault exceeds its byte limit', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const secret = 's'.repeat(64 * 1024);
      let catalogRevision = 0;
      let vaultRevision = 0;
      let rejected = false;

      for (let index = 0; index < 40; index += 1) {
        const connection = await createConnection(
          stores,
          catalogRevision,
          connectionDraft(`vault-cap-${index}`, 'openai', `Vault cap ${index}`),
        );
        catalogRevision += 1;
        try {
          const result = await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret,
          });
          assert.equal(result.kind, 'committed');
          if (result.kind !== 'committed') {
            throw new Error('vault capacity setup did not commit');
          }
          vaultRevision = result.snapshot.revision;
        } catch (error) {
          assert.ok(isStoreError('invalid_credential_input')(error));
          rejected = true;
          break;
        }
      }

      assert.equal(rejected, true);
      const snapshot = await stores.credentialVault.getSnapshot();
      assert.equal(snapshot.revision, vaultRevision);
      assert.equal(snapshot.entries.length, vaultRevision);
    });
  });

  test('owns endpoints and fails closed on unsafe or unreachable persisted connection state', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const rejected: ConnectionCatalogEntryDraft[] = [
        { ...connectionDraft('ftp', 'openai', 'FTP'), baseUrl: 'ftp://example.com/v1' },
        {
          ...connectionDraft('userinfo', 'openai', 'Userinfo'),
          baseUrl: 'https://user:pass@example.com/v1',
        },
        {
          ...connectionDraft('query', 'openai', 'Query'),
          baseUrl: 'https://example.com/v1?tenant=a',
        },
        {
          ...connectionDraft('fragment', 'openai', 'Fragment'),
          baseUrl: 'https://example.com/v1#models',
        },
        {
          ...connectionDraft('oauth', 'github-copilot', 'OAuth'),
          baseUrl: 'https://example.com/copilot',
        },
      ];
      for (const connection of rejected) {
        await assert.rejects(
          () => stores.connectionCatalog.create({ expectedCatalogRevision: 0, connection }),
          isStoreError('invalid_connection_input'),
        );
      }

      const canonical = await createConnection(stores, 0, {
        ...connectionDraft('canonical', 'openai', 'Canonical'),
        baseUrl: 'HTTPS://Gateway.EXAMPLE:443/v1',
      });
      assert.equal(canonical.baseUrl, 'https://gateway.example/v1');

      const path = join(root, 'connection-catalog.json');
      const document = JSON.parse(await readFile(path, 'utf8')) as {
        connections: Array<Record<string, unknown>>;
      };
      document.connections[0]!.models = [{ id: 'persisted-but-unreachable' }];
      const unreachable = `${JSON.stringify(document)}\n`;
      await writeFile(path, unreachable, 'utf8');
      await assert.rejects(
        () => stores.connectionCatalog.getSnapshot(),
        isStoreError('invalid_document'),
      );
      assert.equal(await readFile(path, 'utf8'), unreachable);
    });
  });

  test('validates credential locators and redacts credential status', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const required = await createConnection(
        stores,
        0,
        connectionDraft('required', 'openai', 'Required key'),
      );

      assert.deepEqual(
        await stores.credentialVault.getStatus({
          scope: 'connection',
          connectionId: '00000000-0000-4000-8000-000000000001',
          kind: 'api_key',
        }),
        { kind: 'connection_not_found' },
      );
      await assert.rejects(
        () => stores.credentialVault.getStatus(connectionCredential(required, 'oauth_token')),
        isStoreError('invalid_credential_input'),
      );

      const apiSecret = 'api-secret-never-redacted-back';
      const proxySecret = 'proxy-secret-never-redacted-back';
      const apiSet = await stores.credentialVault.set({
        locator: connectionCredential(required, 'api_key'),
        expected: null,
        secret: apiSecret,
      });
      assert.equal(apiSet.kind, 'committed');
      const proxySet = await stores.credentialVault.set({
        locator: proxyCredential(),
        expected: null,
        secret: proxySecret,
      });
      assert.equal(proxySet.kind, 'committed');

      const requiredStatus = await getCredentialStatus(
        stores.credentialVault,
        connectionCredential(required, 'api_key'),
      );
      const proxyStatus = await getCredentialStatus(stores.credentialVault, proxyCredential());
      const publicViews = JSON.stringify([
        apiSet,
        proxySet,
        requiredStatus,
        proxyStatus,
        await stores.credentialVault.getSnapshot(),
      ]);
      assert.equal(publicViews.includes(apiSecret), false);
      assert.equal(publicViews.includes(proxySecret), false);
    });
  });

  test('resolves execution connection material from one mutation cut', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const disabled = await createConnection(stores, 0, {
        ...connectionDraft('execution-disabled', 'openai', 'Disabled'),
        enabled: false,
      });
      const required = await createConnection(
        stores,
        1,
        connectionDraft('execution-required', 'openai', 'Required'),
      );
      const optional = await createConnection(
        stores,
        2,
        connectionDraft('execution-optional', 'localai', 'Optional'),
      );
      const none = await createConnection(
        stores,
        3,
        connectionDraft('execution-none', 'ollama', 'None'),
      );

      assert.deepEqual(await stores.operations.resolveExecutionConnection('missing'), {
        kind: 'not_found',
      });
      assert.deepEqual(await stores.operations.resolveExecutionConnection(disabled.slug), {
        kind: 'disabled',
      });

      const missingRequired = await stores.operations.resolveExecutionConnection(required.slug);
      assert.equal(missingRequired.kind, 'credential_not_configured');
      if (missingRequired.kind === 'credential_not_configured') {
        assert.deepEqual(missingRequired.status.locator, connectionCredential(required, 'api_key'));
      }
      for (const connection of [optional, none]) {
        const resolved = await stores.operations.resolveExecutionConnection(connection.slug);
        assert.equal(resolved.kind, 'ready');
        if (resolved.kind === 'ready') assert.deepEqual(resolved.secretMaterial, {});
      }

      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(required, 'api_key'),
            expected: null,
            secret: 'execution-connection-secret',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(0, { host: 'execution.proxy.internal' }),
          )
        ).kind,
        'committed',
      );
      const missingProxy = await stores.operations.resolveExecutionConnection(required.slug);
      assert.equal(missingProxy.kind, 'credential_not_configured');
      if (missingProxy.kind === 'credential_not_configured') {
        assert.deepEqual(missingProxy.status.locator, proxyCredential());
      }

      const [proxySet, resolved] = await Promise.all([
        stores.credentialVault.set({
          locator: proxyCredential(),
          expected: null,
          secret: 'execution-proxy-secret',
        }),
        stores.operations.resolveExecutionConnection(required.slug),
      ]);
      assert.equal(proxySet.kind, 'committed');
      assert.equal(resolved.kind, 'ready');
      if (resolved.kind !== 'ready') return;
      assert.deepEqual(resolved.connection, required);
      assert.equal(resolved.networkProxy.host, 'execution.proxy.internal');
      assert.equal(resolved.secretMaterial.connection?.secret, 'execution-connection-secret');
      assert.equal(resolved.secretMaterial.networkProxy?.secret, 'execution-proxy-secret');
    });
  });

  test('refreshes only the matching OAuth credential generation without invalidating verification', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('oauth-refresh', 'github-copilot', 'OAuth refresh'),
      );
      const locator = connectionCredential(connection, 'oauth_token');
      const originalSecret = JSON.stringify({
        access_token: 'github-access-v1',
        refresh_token: 'github-refresh-v1',
        expires_at: 1,
      });
      const configured = await stores.credentialVault.set({
        locator,
        expected: null,
        secret: originalSecret,
      });
      assert.equal(configured.kind, 'committed');
      if (configured.kind !== 'committed') return;
      await verifyConnection(stores, connection.connectionId, '2026-08-01T00:00:00.000Z');
      const status = await getCredentialStatus(stores.credentialVault, locator);
      const initialRevision = credentialBasis(status).revision;
      const replacementSecret = JSON.stringify({
        access_token: 'github-access-v2',
        refresh_token: 'github-refresh-v2',
        expires_at: Number.MAX_SAFE_INTEGER,
      });

      const refreshed = await stores.operations.compareAndSetOAuthCredential({
        locator: { ...locator, kind: 'oauth_token' },
        expected: credentialExpectation(status),
        secret: replacementSecret,
      });

      assert.equal(refreshed.kind, 'committed');
      if (refreshed.kind !== 'committed') return;
      assert.equal(refreshed.credentialId, credentialBasis(status).credentialId);
      assert.equal(refreshed.revision, initialRevision + 1);
      const refreshedStatus = await getCredentialStatus(stores.credentialVault, locator);
      assert.equal(credentialBasis(refreshedStatus).revision, initialRevision + 1);
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
      );
      const resolved = await stores.operations.resolveExecutionConnection(connection.slug);
      assert.equal(resolved.kind, 'ready');
      if (resolved.kind === 'ready') {
        assert.equal(resolved.secretMaterial.connection?.secret, replacementSecret);
      }

      const stale = await stores.operations.compareAndSetOAuthCredential({
        locator: { ...locator, kind: 'oauth_token' },
        expected: credentialExpectation(status),
        secret: 'stale-refresh-must-not-commit',
      });
      assert.equal(stale.kind, 'superseded');
      const stillResolved = await stores.operations.resolveExecutionConnection(connection.slug);
      assert.equal(stillResolved.kind, 'ready');
      if (stillResolved.kind === 'ready') {
        assert.equal(stillResolved.secretMaterial.connection?.secret, replacementSecret);
      }

      const deleted = await stores.credentialVault.delete({
        expected: credentialBasis(refreshedStatus),
      });
      assert.equal(deleted.kind, 'committed');
      const resurrection = await stores.operations.compareAndSetOAuthCredential({
        locator: { ...locator, kind: 'oauth_token' },
        expected: credentialExpectation(refreshedStatus),
        secret: 'refresh-must-not-recreate-a-deleted-credential',
      });
      assert.equal(resurrection.kind, 'superseded');
      assert.equal((await getCredentialStatus(stores.credentialVault, locator)).configured, false);
    });
  });

  test('conditionally commits discovery and test facts from the latest admitted state with one-shot tickets', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-success', 'openai', 'Effects success'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'effect-secret',
          })
        ).kind,
        'committed',
      );

      assert.deepEqual(
        await stores.operations.beginModelFetch('00000000-0000-4000-8000-000000000001'),
        { kind: 'connection_not_found' },
      );

      const fetch = await stores.operations.beginModelFetch(connection.connectionId);
      const testTicket = await stores.operations.beginConnectionTest(
        connection.connectionId,
        'gpt-5',
      );
      assert.equal(fetch.kind, 'ready');
      assert.equal(testTicket.kind, 'ready');
      if (fetch.kind !== 'ready' || testTicket.kind !== 'ready') return;
      assert.equal(testTicket.modelId, 'gpt-5');
      assert.equal(fetch.secretMaterial.connection?.secret, 'effect-secret');

      await assert.rejects(
        () =>
          stores.operations.completeModelFetch(testTicket.ticket as never, {
            models: [{ id: 'wrong-ticket-must-not-write' }],
            source: 'fetched',
            fetchedAt: 10,
          }),
        isStoreError('invalid_connection_input'),
      );

      const tested = await stores.operations.completeConnectionTest(testTicket.ticket, {
        status: 'needs_reauth',
        checkedAt: '2026-07-29T12:00:00.000Z',
        errorClass: 'auth',
      });
      assert.equal(tested.kind, 'committed');
      if (tested.kind !== 'committed') return;
      assert.deepEqual(tested.snapshot.connections[0]?.lastTest, {
        status: 'needs_reauth',
        checkedAt: '2026-07-29T12:00:00.000Z',
        errorClass: 'auth',
      });

      const discovered = await stores.operations.completeModelFetch(fetch.ticket, {
        models: [{ id: 'gpt-5.1' }, { id: 'gpt-5.2' }],
        source: 'fetched',
        fetchedAt: 42,
      });
      assert.equal(discovered.kind, 'committed');
      if (discovered.kind !== 'committed') return;
      const afterDiscovery = discovered.snapshot.connections[0];
      assert.ok(afterDiscovery);
      assert.deepEqual(afterDiscovery.models, [{ id: 'gpt-5.1' }, { id: 'gpt-5.2' }]);
      assert.deepEqual(afterDiscovery.enabledModelIds, ['gpt-5.1']);
      assert.equal(afterDiscovery.modelSource, 'fetched');
      assert.equal(afterDiscovery.modelsFetchedAt, 42);

      assert.equal(JSON.stringify([tested, discovered]).includes('effect-secret'), false);

      await assert.rejects(
        () =>
          stores.operations.completeModelFetch(fetch.ticket, {
            models: [{ id: 'replay-must-not-write' }],
            source: 'fetched',
            fetchedAt: 43,
          }),
        isStoreError('invalid_connection_input'),
      );
      await assert.rejects(
        () =>
          stores.operations.completeConnectionTest(testTicket.ticket, {
            status: 'verified',
            checkedAt: '2026-07-29T12:01:00.000Z',
          }),
        isStoreError('invalid_connection_input'),
      );
    });
  });

  test('repairs the canonical default target when discovery removes its model', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-default', 'ollama', 'Effects default'),
      );
      const defaultTarget = await stores.connectionCatalog.setDefaultTarget({
        expectedCatalogRevision: 1,
        target: { connectionId: connection.connectionId, modelId: 'gpt-5' },
      });
      assert.equal(defaultTarget.kind, 'committed');

      const prepared = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') return;
      const completed = await stores.operations.completeModelFetch(prepared.ticket, {
        models: [{ id: 'llama3.3' }, { id: 'qwen3' }],
        source: 'fetched',
        fetchedAt: 43,
      });
      assert.equal(completed.kind, 'committed');
      if (completed.kind !== 'committed') return;
      const expected = { connectionId: connection.connectionId, modelId: 'llama3.3' };
      assert.deepEqual(completed.snapshot.defaultTarget, expected);
      assert.deepEqual((await stores.connectionCatalog.getSnapshot()).defaultTarget, expected);
    });
  });

  test('keeps an emptied model selection across the next canonical discovery', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-empty-selection', 'ollama', 'Empty selection'),
      );

      const first = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(first.kind, 'ready');
      if (first.kind !== 'ready') return;
      const seeded = await stores.operations.completeModelFetch(first.ticket, {
        models: [{ id: 'llama3.3' }, { id: 'qwen3' }],
        source: 'fetched',
        fetchedAt: 1,
      });
      assert.equal(seeded.kind, 'committed');

      const current = (await stores.connectionCatalog.getSnapshot()).connections[0]!;
      const emptied = await stores.connectionCatalog.update({
        expected: connectionBasis(current),
        changes: {
          name: current.name,
          baseUrl: current.baseUrl,
          enabled: true,
          enabledModelIds: [],
        },
      });
      assert.equal(emptied.kind, 'committed');

      // Every catalog entry carries a `models` array from birth, so reading
      // "has an inventory" as "the field exists" made this connection look like
      // it had never fetched — and each refresh re-seeded `liveIds[0]` over the
      // selection the user had just emptied.
      const second = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(second.kind, 'ready');
      if (second.kind !== 'ready') return;
      const refetched = await stores.operations.completeModelFetch(second.ticket, {
        models: [{ id: 'llama3.3' }, { id: 'gemma3' }],
        source: 'fetched',
        fetchedAt: 2,
      });
      assert.equal(refetched.kind, 'committed');
      if (refetched.kind !== 'committed') return;
      assert.deepEqual(refetched.snapshot.connections[0]?.enabledModelIds, []);
    });
  });

  test('admits only canonical explicit connection test models', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-test-model', 'openai', 'Effects test model'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'test-model-secret',
          })
        ).kind,
        'committed',
      );

      assert.equal(
        (await stores.operations.beginConnectionTest(connection.connectionId, 'gpt-5')).kind,
        'ready',
      );
      await assert.rejects(
        () => stores.operations.beginConnectionTest(connection.connectionId, 'injected-model'),
        isStoreError('invalid_connection_input'),
      );

      const discovery = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(discovery.kind, 'ready');
      if (discovery.kind !== 'ready') return;
      assert.equal(
        (
          await stores.operations.completeModelFetch(discovery.ticket, {
            models: [{ id: 'canonical-fetched-model' }],
            source: 'fetched',
            fetchedAt: 1,
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.operations.beginConnectionTest(
            connection.connectionId,
            'canonical-fetched-model',
          )
        ).kind,
        'ready',
      );
      await assert.rejects(
        () => stores.operations.beginConnectionTest(connection.connectionId, 'gpt-5'),
        isStoreError('invalid_connection_input'),
      );
      assert.equal(
        (await stores.operations.beginConnectionTest(connection.connectionId, null)).kind,
        'ready',
      );
    });
  });

  test('preserves verified state for equivalent discovery and clears it on model protocol changes', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-model-protocol', 'openai', 'Effects model protocol'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'model-protocol-secret',
          })
        ).kind,
        'committed',
      );

      const initialDiscovery = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(initialDiscovery.kind, 'ready');
      if (initialDiscovery.kind !== 'ready') return;
      assert.equal(
        (
          await stores.operations.completeModelFetch(initialDiscovery.ticket, {
            models: [{ id: 'gpt-5', apiProtocol: 'openai-chat' }],
            source: 'fetched',
            fetchedAt: 1,
          })
        ).kind,
        'committed',
      );
      await verifyConnection(stores, connection.connectionId, '2026-07-29T11:59:00.000Z');

      const equivalentDiscovery = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(equivalentDiscovery.kind, 'ready');
      if (equivalentDiscovery.kind !== 'ready') return;
      const equivalent = await stores.operations.completeModelFetch(equivalentDiscovery.ticket, {
        models: [{ id: 'gpt-5', apiProtocol: 'openai-chat' }],
        source: 'fetched',
        fetchedAt: 2,
      });
      assert.equal(equivalent.kind, 'committed');
      if (equivalent.kind !== 'committed') return;
      assert.deepEqual(equivalent.snapshot.connections[0]?.lastTest, {
        status: 'verified',
        checkedAt: '2026-07-29T11:59:00.000Z',
      });

      const testTicket = await stores.operations.beginConnectionTest(
        connection.connectionId,
        'gpt-5',
      );
      const rediscovery = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(testTicket.kind, 'ready');
      assert.equal(rediscovery.kind, 'ready');
      if (testTicket.kind !== 'ready' || rediscovery.kind !== 'ready') return;

      assert.equal(
        (
          await stores.operations.completeModelFetch(rediscovery.ticket, {
            models: [{ id: 'gpt-5', apiProtocol: 'openai-responses' }],
            source: 'fetched',
            fetchedAt: 3,
          })
        ).kind,
        'committed',
      );
      assert.deepEqual(
        await stores.operations.completeConnectionTest(testTicket.ticket, {
          status: 'verified',
          checkedAt: '2026-07-29T12:00:00.000Z',
        }),
        { kind: 'superseded', changed: ['connection'] },
      );

      const current = (await stores.connectionCatalog.getSnapshot()).connections[0];
      assert.deepEqual(current?.models, [{ id: 'gpt-5', apiProtocol: 'openai-responses' }]);
      assert.equal(current?.lastTest, undefined);
    });
  });

  test('clears verified state when enabled model selection changes', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-selection-invalidation', 'openai', 'Selection invalidation'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'selection-secret',
          })
        ).kind,
        'committed',
      );
      await verifyConnection(stores, connection.connectionId, '2026-07-29T12:10:00.000Z');
      const current = (await stores.connectionCatalog.getSnapshot()).connections[0]!;

      const updated = await stores.connectionCatalog.update({
        expected: connectionBasis(current),
        changes: {
          name: current.name,
          baseUrl: current.baseUrl,
          enabled: true,
          enabledModelIds: ['gpt-5-mini'],
        },
      });
      assert.equal(updated.kind, 'committed');
      if (updated.kind !== 'committed') return;
      assert.equal(updated.snapshot.connections[0]?.lastTest, undefined);
    });
  });

  test('clears verified state only for admitted connection credential mutations', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-credential-invalidation', 'openai', 'Credential invalidation'),
      );
      const locator = connectionCredential(connection, 'api_key');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator,
            expected: null,
            secret: 'credential-v1',
          })
        ).kind,
        'committed',
      );
      await verifyConnection(stores, connection.connectionId, '2026-07-29T12:20:00.000Z');
      const initialStatus = await getCredentialStatus(stores.credentialVault, locator);

      await assert.rejects(
        () =>
          stores.credentialVault.set({
            locator: connectionCredential(connection, 'oauth_token'),
            expected: null,
            secret: 'invalid-oauth-credential',
          }),
        isStoreError('invalid_credential_input'),
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
      );

      const staleSet = await stores.credentialVault.set({
        locator,
        expected: {
          credentialId: credentialBasis(initialStatus).credentialId,
          revision: credentialBasis(initialStatus).revision + 1,
        },
        secret: 'stale-credential',
      });
      assert.equal(staleSet.kind, 'credential_stale');
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
      );

      assert.equal(
        (
          await stores.credentialVault.set({
            locator,
            expected: credentialExpectation(initialStatus),
            secret: 'credential-v2',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );

      await verifyConnection(stores, connection.connectionId, '2026-07-29T12:21:00.000Z');
      const rotatedStatus = await getCredentialStatus(stores.credentialVault, locator);
      const staleDelete = await stores.credentialVault.delete({
        expected: credentialBasis(initialStatus),
      });
      assert.equal(staleDelete.kind, 'credential_stale');
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
      );

      assert.equal(
        (
          await stores.credentialVault.delete({
            expected: credentialBasis(rotatedStatus),
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );
    });
  });

  test('reports unknown outcome when credential persistence fails after clearing verified state', {
    skip: process.platform === 'win32',
  }, async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-credential-failure', 'openai', 'Credential failure'),
      );
      const locator = connectionCredential(connection, 'api_key');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator,
            expected: null,
            secret: 'credential-before-failure',
          })
        ).kind,
        'committed',
      );
      await verifyConnection(stores, connection.connectionId, '2026-07-29T12:30:00.000Z');
      const status = await getCredentialStatus(stores.credentialVault, locator);

      const probe = await open(root, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync: typeof probe.sync;
      };
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let syncCalls = 0;
      const syncMock = mock.method(
        fileHandlePrototype,
        'sync',
        async function (this: typeof probe) {
          syncCalls += 1;
          if (syncCalls === 3) throw new Error('injected credential persistence failure');
          return originalSync.call(this);
        },
      );
      try {
        await assert.rejects(
          () =>
            stores.credentialVault.set({
              locator,
              expected: credentialExpectation(status),
              secret: 'credential-after-failure',
            }),
          isStoreError('commit_outcome_unknown'),
        );
      } finally {
        syncMock.mock.restore();
      }

      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );
      assert.equal(
        (await getCredentialStatus(stores.credentialVault, locator)).revision,
        status.revision,
      );
    });
  });

  test('invalidates verified state only when the effective network proxy basis changes', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-proxy-invalidation', 'openai', 'Proxy invalidation'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'proxy-invalidation-secret',
          })
        ).kind,
        'committed',
      );
      await verifyConnection(stores, connection.connectionId, '2026-07-29T12:40:00.000Z');

      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(0, {
              host: 'proxy-one.internal',
              authEnabled: false,
              username: '',
            }),
          )
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );

      await verifyConnection(stores, connection.connectionId, '2026-07-29T12:41:00.000Z');
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(1, {
              host: 'proxy-two.internal',
              authEnabled: false,
              username: '',
            }),
          )
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );

      await verifyConnection(stores, connection.connectionId, '2026-07-29T12:42:00.000Z');
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(2, {
              host: 'proxy-two.internal',
              authEnabled: false,
              username: '',
              bypassList: ['127.0.0.1'],
              autoBypassDomains: ['localhost'],
            }),
          )
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
      );
    });
  });

  test('validates proxy policy mutations before clearing and reports failed follow-up commits as unknown', {
    skip: process.platform === 'win32',
  }, async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-proxy-policy-failure', 'openai', 'Proxy policy failure'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'proxy-policy-failure-secret',
          })
        ).kind,
        'committed',
      );
      await verifyConnection(stores, connection.connectionId, '2026-07-29T12:50:00.000Z');

      await assert.rejects(
        () => stores.runtimePolicy.mutate(networkProxyMutation(0, { host: '   ' })),
        isStoreError('invalid_policy_input'),
      );
      assert.deepEqual(
        await stores.runtimePolicy.mutate(
          networkProxyMutation(1, {
            host: 'stale.proxy.internal',
            authEnabled: false,
            username: '',
          }),
        ),
        { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 0 },
      );
      const oversizedBypassList = Array.from(
        { length: 100 },
        (_value, index) => `${index}-${'x'.repeat(500)}`,
      );
      await assert.rejects(
        () =>
          stores.runtimePolicy.mutate(
            networkProxyMutation(0, {
              authEnabled: false,
              username: '',
              bypassList: oversizedBypassList,
              autoBypassDomains: [],
            }),
          ),
        isStoreError('invalid_policy_input'),
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
      );

      const probe = await open(root, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync: typeof probe.sync;
      };
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let syncCalls = 0;
      const syncMock = mock.method(
        fileHandlePrototype,
        'sync',
        async function (this: typeof probe) {
          syncCalls += 1;
          if (syncCalls === 3) throw new Error('injected proxy policy persistence failure');
          return originalSync.call(this);
        },
      );
      try {
        await assert.rejects(
          () =>
            stores.runtimePolicy.mutate(
              networkProxyMutation(0, {
                host: 'failed.proxy.internal',
                authEnabled: false,
                username: '',
              }),
            ),
          isStoreError('commit_outcome_unknown'),
        );
      } finally {
        syncMock.mock.restore();
      }

      assert.equal(syncCalls, 3);
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );
      assert.equal((await stores.runtimePolicy.getSnapshot()).revision, 0);
    });
  });

  test('invalidates verified state for active proxy password rotation and deletion', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-proxy-credential', 'openai', 'Proxy credential'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'proxy-credential-connection-secret',
          })
        ).kind,
        'committed',
      );
      await verifyConnection(stores, connection.connectionId, '2026-07-29T13:00:00.000Z');

      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: null,
            secret: 'proxy-password-v1',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
        'an inactive proxy credential is not part of the verification basis',
      );
      assert.equal((await stores.runtimePolicy.mutate(networkProxyMutation(0))).kind, 'committed');
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );

      await verifyConnection(stores, connection.connectionId, '2026-07-29T13:01:00.000Z');
      const initialStatus = await getCredentialStatus(stores.credentialVault, proxyCredential());
      await assert.rejects(
        () =>
          stores.credentialVault.set({
            locator: proxyCredential(),
            expected: credentialExpectation(initialStatus),
            secret: 'x'.repeat(64 * 1024 + 1),
          }),
        isStoreError('invalid_credential_input'),
      );
      const staleSet = await stores.credentialVault.set({
        locator: proxyCredential(),
        expected: {
          credentialId: credentialBasis(initialStatus).credentialId,
          revision: credentialBasis(initialStatus).revision + 1,
        },
        secret: 'stale-proxy-password',
      });
      assert.equal(staleSet.kind, 'credential_stale');
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
      );

      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: credentialExpectation(initialStatus),
            secret: 'proxy-password-v2',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );

      await verifyConnection(stores, connection.connectionId, '2026-07-29T13:02:00.000Z');
      const rotatedStatus = await getCredentialStatus(stores.credentialVault, proxyCredential());
      const staleDelete = await stores.credentialVault.delete({
        expected: credentialBasis(initialStatus),
      });
      assert.equal(staleDelete.kind, 'credential_stale');
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest?.status,
        'verified',
      );

      assert.equal(
        (
          await stores.credentialVault.delete({
            expected: credentialBasis(rotatedStatus),
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );
    });
  });

  test('reports unknown outcome when active proxy password persistence fails after clearing', {
    skip: process.platform === 'win32',
  }, async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-proxy-credential-failure', 'openai', 'Proxy credential failure'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'proxy-failure-connection-secret',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: null,
            secret: 'proxy-password-before-failure',
          })
        ).kind,
        'committed',
      );
      assert.equal((await stores.runtimePolicy.mutate(networkProxyMutation(0))).kind, 'committed');
      await verifyConnection(stores, connection.connectionId, '2026-07-29T13:10:00.000Z');
      const status = await getCredentialStatus(stores.credentialVault, proxyCredential());

      const probe = await open(root, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync: typeof probe.sync;
      };
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let syncCalls = 0;
      const syncMock = mock.method(
        fileHandlePrototype,
        'sync',
        async function (this: typeof probe) {
          syncCalls += 1;
          if (syncCalls === 3) throw new Error('injected proxy credential persistence failure');
          return originalSync.call(this);
        },
      );
      try {
        await assert.rejects(
          () =>
            stores.credentialVault.set({
              locator: proxyCredential(),
              expected: credentialExpectation(status),
              secret: 'proxy-password-after-failure',
            }),
          isStoreError('commit_outcome_unknown'),
        );
      } finally {
        syncMock.mock.restore();
      }

      assert.equal(syncCalls, 3);
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.lastTest,
        undefined,
      );
      assert.equal(
        (await getCredentialStatus(stores.credentialVault, proxyCredential())).revision,
        status.revision,
      );
    });
  });

  test('commits a connection test when a proxy bypass pattern moves between equivalent lists', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-proxy-bypass', 'openai', 'Effects proxy bypass'),
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(connection, 'api_key'),
            expected: null,
            secret: 'proxy-bypass-connection-secret',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(0, {
              bypassList: ['localhost', 'gateway.example'],
              autoBypassDomains: ['127.0.0.1'],
            }),
          )
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: null,
            secret: 'proxy-bypass-secret',
          })
        ).kind,
        'committed',
      );

      const testTicket = await stores.operations.beginConnectionTest(
        connection.connectionId,
        'gpt-5',
      );
      assert.equal(testTicket.kind, 'ready');
      if (testTicket.kind !== 'ready') return;
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(1, {
              bypassList: ['localhost'],
              autoBypassDomains: ['127.0.0.1', 'gateway.example'],
            }),
          )
        ).kind,
        'committed',
      );

      const completed = await stores.operations.completeConnectionTest(testTicket.ticket, {
        status: 'verified',
        checkedAt: '2026-07-29T12:01:00.000Z',
      });
      assert.equal(completed.kind, 'committed');
      if (completed.kind !== 'committed') return;
      assert.deepEqual(completed.snapshot.connections[0]?.lastTest, {
        status: 'verified',
        checkedAt: '2026-07-29T12:01:00.000Z',
      });
    });
  });

  test('supersedes effects on connection, credential, proxy, proxy credential, and slug ABA changes', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      let connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-fence', 'openai', 'Effects fence'),
      );
      const locator = connectionCredential(connection, 'api_key');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator,
            expected: null,
            secret: 'connection-v1',
          })
        ).kind,
        'committed',
      );

      const endpointTicket = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(endpointTicket.kind, 'ready');
      if (endpointTicket.kind !== 'ready') return;
      const endpointUpdate = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes: {
          name: connection.name,
          baseUrl: 'https://gateway.example/v1',
          enabled: true,
          enabledModelIds: connection.enabledModelIds,
        },
      });
      assert.equal(endpointUpdate.kind, 'committed');
      if (endpointUpdate.kind !== 'committed') return;
      connection = endpointUpdate.snapshot.connections[0]!;
      assert.deepEqual(
        await stores.operations.completeModelFetch(endpointTicket.ticket, {
          models: [{ id: 'endpoint-stale' }],
          source: 'fetched',
          fetchedAt: 1,
        }),
        { kind: 'superseded', changed: ['connection'] },
      );

      const modelSelectionTicket = await stores.operations.beginConnectionTest(
        connection.connectionId,
        null,
      );
      assert.equal(modelSelectionTicket.kind, 'ready');
      if (modelSelectionTicket.kind !== 'ready') return;
      const modelSelectionUpdate = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes: {
          name: connection.name,
          baseUrl: connection.baseUrl,
          enabled: true,
          enabledModelIds: ['gpt-5-mini'],
        },
      });
      assert.equal(modelSelectionUpdate.kind, 'committed');
      if (modelSelectionUpdate.kind !== 'committed') return;
      connection = modelSelectionUpdate.snapshot.connections[0]!;
      assert.deepEqual(
        await stores.operations.completeConnectionTest(modelSelectionTicket.ticket, {
          status: 'verified',
          checkedAt: '2026-07-29T12:01:00.000Z',
        }),
        { kind: 'superseded', changed: ['connection'] },
      );

      const credentialTicket = await stores.operations.beginConnectionTest(
        connection.connectionId,
        null,
      );
      assert.equal(credentialTicket.kind, 'ready');
      if (credentialTicket.kind !== 'ready') return;
      const status = await getCredentialStatus(stores.credentialVault, locator);
      assert.equal(
        (
          await stores.credentialVault.set({
            locator,
            expected: credentialExpectation(status),
            secret: 'connection-v2',
          })
        ).kind,
        'committed',
      );
      assert.deepEqual(
        await stores.operations.completeConnectionTest(credentialTicket.ticket, {
          status: 'verified',
          checkedAt: '2026-07-29T12:02:00.000Z',
        }),
        { kind: 'superseded', changed: ['credential'] },
      );

      assert.equal(
        (await stores.runtimePolicy.mutate(networkProxyMutation(0, { host: 'proxy-one.internal' })))
          .kind,
        'committed',
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: null,
            secret: 'proxy-v1',
          })
        ).kind,
        'committed',
      );
      const proxyTicket = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(proxyTicket.kind, 'ready');
      if (proxyTicket.kind !== 'ready') return;
      assert.equal(
        (await stores.runtimePolicy.mutate(networkProxyMutation(1, { host: 'proxy-two.internal' })))
          .kind,
        'committed',
      );
      assert.deepEqual(
        await stores.operations.completeModelFetch(proxyTicket.ticket, {
          models: [{ id: 'proxy-stale' }],
          source: 'fetched',
          fetchedAt: 2,
        }),
        { kind: 'superseded', changed: ['network_proxy'] },
      );

      const proxyCredentialTicket = await stores.operations.beginConnectionTest(
        connection.connectionId,
        null,
      );
      assert.equal(proxyCredentialTicket.kind, 'ready');
      if (proxyCredentialTicket.kind !== 'ready') return;
      const proxyStatus = await getCredentialStatus(stores.credentialVault, proxyCredential());
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: credentialExpectation(proxyStatus),
            secret: 'proxy-v2',
          })
        ).kind,
        'committed',
      );
      assert.deepEqual(
        await stores.operations.completeConnectionTest(proxyCredentialTicket.ticket, {
          status: 'verified',
          checkedAt: '2026-07-29T12:03:00.000Z',
        }),
        { kind: 'superseded', changed: ['credential'] },
      );

      const abaTicket = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(abaTicket.kind, 'ready');
      if (abaTicket.kind !== 'ready') return;
      const removed = await stores.connectionCatalog.remove({
        expected: connectionBasis(connection),
      });
      assert.equal(removed.kind, 'committed');
      if (removed.kind !== 'committed') return;
      const replacement = await createConnection(
        stores,
        removed.snapshot.revision,
        connectionDraft(connection.slug, 'openai', 'Replacement'),
      );
      assert.notEqual(replacement.connectionId, connection.connectionId);
      assert.deepEqual(
        await stores.operations.completeModelFetch(abaTicket.ticket, {
          models: [{ id: 'aba-stale' }],
          source: 'fetched',
          fetchedAt: 3,
        }),
        { kind: 'superseded', changed: ['connection', 'credential'] },
      );
      assert.deepEqual(replacement.models, []);
    });
  });

  test('preserves unknown commit semantics and consumes the completion ticket', {
    skip: process.platform === 'win32',
  }, async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('effects-unknown', 'ollama', 'Effects unknown'),
      );
      const prepared = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') return;
      const result = {
        models: [{ id: 'llama3.3' }],
        source: 'fetched' as const,
        fetchedAt: 99,
      };

      const probe = await open(root, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync: typeof probe.sync;
      };
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      let syncCalls = 0;
      const syncMock = mock.method(
        fileHandlePrototype,
        'sync',
        async function (this: typeof probe) {
          syncCalls += 1;
          if (syncCalls === 2) throw new Error('injected post-publication sync failure');
          return originalSync.call(this);
        },
      );
      try {
        await assert.rejects(
          () => stores.operations.completeModelFetch(prepared.ticket, result),
          isStoreError('commit_outcome_unknown'),
        );
      } finally {
        syncMock.mock.restore();
      }

      assert.equal(syncCalls, 2);
      assert.deepEqual((await stores.connectionCatalog.getSnapshot()).connections[0]?.models, [
        { id: 'llama3.3' },
      ]);
      await assert.rejects(
        () => stores.operations.completeModelFetch(prepared.ticket, result),
        isStoreError('invalid_connection_input'),
      );
    });
  });

  test('allows only Copilot OAuth tokens through the public credential setter', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const claude = await createConnection(
        stores,
        0,
        connectionDraft('public-claude', 'claude-subscription', 'Public Claude'),
      );
      const codex = await createConnection(
        stores,
        1,
        connectionDraft('public-codex', 'openai-codex', 'Public Codex'),
      );
      const copilot = await createConnection(
        stores,
        2,
        connectionDraft('public-copilot', 'github-copilot', 'Public Copilot'),
      );
      const preview = await createConnection(
        stores,
        3,
        connectionDraft('public-preview', 'gemini-cli', 'Public preview'),
      );
      const apiKey = await createConnection(
        stores,
        4,
        connectionDraft('public-api-key', 'openai', 'Public API key'),
      );

      for (const connection of [claude, codex, preview]) {
        await assert.rejects(
          () =>
            stores.credentialVault.set({
              locator: connectionCredential(connection, 'oauth_token'),
              expected: null,
              secret: 'public-oauth-must-be-rejected',
            }),
          isStoreError('invalid_credential_input'),
        );
        assert.equal(
          (
            await getCredentialStatus(
              stores.credentialVault,
              connectionCredential(connection, 'oauth_token'),
            )
          ).configured,
          false,
        );
      }
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(copilot, 'oauth_token'),
            expected: null,
            secret: 'copilot-import',
          })
        ).kind,
        'committed',
      );
      for (const input of [
        {
          locator: connectionCredential(apiKey, 'api_key'),
          expected: null,
          secret: 'api-key-input',
        },
        {
          locator: {
            scope: 'web_search' as const,
            provider: 'tavily' as const,
            kind: 'api_key' as const,
          },
          expected: null,
          secret: 'web-search-input',
        },
        { locator: proxyCredential(), expected: null, secret: 'proxy-input' },
      ]) {
        assert.equal((await stores.credentialVault.set(input)).kind, 'committed');
      }
    });
  });

  test('resolves one atomic WebSearch policy, credential, and proxy execution snapshot', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      assert.deepEqual(await stores.operations.resolveWebSearchExecution(), {
        kind: 'disabled',
        provider: 'model',
      });

      const enabled = await stores.runtimePolicy.mutate({
        expectedRevision: 0,
        operation: {
          kind: 'set_web_search',
          value: { enabled: true, defaultProvider: 'tavily' },
        },
      });
      assert.equal(enabled.kind, 'committed');
      const missingSearchCredential = await stores.operations.resolveWebSearchExecution();
      assert.equal(missingSearchCredential.kind, 'credential_not_configured');
      if (missingSearchCredential.kind !== 'credential_not_configured') return;
      assert.deepEqual(missingSearchCredential.status.locator, {
        scope: 'web_search',
        provider: 'tavily',
        kind: 'api_key',
      });

      assert.equal(
        (
          await stores.credentialVault.set({
            locator: missingSearchCredential.status.locator,
            expected: null,
            secret: 'tavily-execution-secret',
          })
        ).kind,
        'committed',
      );
      const direct = await stores.operations.resolveWebSearchExecution();
      assert.equal(direct.kind, 'ready');
      if (direct.kind !== 'ready' || direct.provider !== 'tavily') return;
      assert.equal(direct.secretMaterial.webSearch.secret, 'tavily-execution-secret');
      assert.equal(direct.secretMaterial.networkProxy, undefined);
      assert.equal(direct.networkProxy.enabled, false);

      const proxied = await stores.runtimePolicy.mutate({
        expectedRevision: 1,
        operation: {
          kind: 'set_network_proxy',
          value: {
            ...direct.networkProxy,
            enabled: true,
            host: 'proxy.example',
            port: 8443,
            authEnabled: true,
            username: 'proxy-user',
          },
        },
      });
      assert.equal(proxied.kind, 'committed');
      const missingProxyCredential = await stores.operations.resolveWebSearchExecution();
      assert.equal(missingProxyCredential.kind, 'credential_not_configured');
      if (missingProxyCredential.kind !== 'credential_not_configured') return;
      assert.deepEqual(missingProxyCredential.status.locator, proxyCredential());

      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: null,
            secret: 'proxy-execution-secret',
          })
        ).kind,
        'committed',
      );
      const ready = await stores.operations.resolveWebSearchExecution();
      assert.equal(ready.kind, 'ready');
      if (ready.kind !== 'ready' || ready.provider !== 'tavily') return;
      assert.equal(ready.secretMaterial.webSearch.secret, 'tavily-execution-secret');
      assert.equal(ready.secretMaterial.networkProxy?.secret, 'proxy-execution-secret');
      assert.equal(ready.networkProxy.host, 'proxy.example');

      const privatePolicy = await stores.runtimePolicy.mutate({
        expectedRevision: 2,
        operation: { kind: 'set_privacy', value: { incognitoActive: true } },
      });
      assert.equal(privatePolicy.kind, 'committed');
      assert.deepEqual(await stores.operations.resolveWebSearchExecution(), {
        kind: 'privacy_mode',
      });
    });
  });

  test('keeps provider-native WebSearch outside the client search credential resolver', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const policy = await stores.runtimePolicy.mutate({
        expectedRevision: 0,
        operation: {
          kind: 'set_web_search',
          value: { enabled: true, defaultProvider: 'model' },
        },
      });
      assert.equal(policy.kind, 'committed');
      assert.deepEqual(await stores.operations.resolveWebSearchExecution(), {
        kind: 'model_native_only',
        provider: 'model',
      });
    });
  });

  test('removes credentials only for a matching connection revision and converges on partial retries', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const original = await createConnection(
        stores,
        0,
        connectionDraft('removable', 'openai', 'Removable'),
      );
      const locator = connectionCredential(original, 'api_key');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator,
            expected: null,
            secret: 'must-survive-stale-remove',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.connectionCatalog.setDefaultTarget({
            expectedCatalogRevision: 1,
            target: { connectionId: original.connectionId, modelId: 'gpt-5' },
          })
        ).kind,
        'committed',
      );
      const updatedResult = await stores.connectionCatalog.update({
        expected: connectionBasis(original),
        changes: {
          name: 'Current revision',
          enabled: true,
          enabledModelIds: ['gpt-5'],
        },
      });
      assert.equal(updatedResult.kind, 'committed');
      if (updatedResult.kind !== 'committed') return;
      const updated = updatedResult.snapshot.connections[0];
      assert.ok(updated);

      const stale = await stores.connectionCatalog.remove({ expected: connectionBasis(original) });
      assert.equal(stale.kind, 'connection_stale');
      assert.deepEqual((await stores.connectionCatalog.getSnapshot()).defaultTarget, {
        connectionId: original.connectionId,
        modelId: 'gpt-5',
      });

      const removed = await stores.connectionCatalog.remove({ expected: connectionBasis(updated) });
      assert.equal(removed.kind, 'committed');
      if (removed.kind !== 'committed') return;
      assert.deepEqual(removed.snapshot.connections, []);
      assert.equal(removed.snapshot.defaultTarget, null);
      assert.deepEqual((await stores.credentialVault.getSnapshot()).entries, []);
      assert.deepEqual(await stores.credentialVault.getStatus(locator), {
        kind: 'connection_not_found',
      });
      const retry = await stores.connectionCatalog.remove({ expected: connectionBasis(updated) });
      assert.equal(retry.kind, 'committed');
      if (retry.kind === 'committed')
        assert.equal(retry.snapshot.revision, removed.snapshot.revision);

      const recreated = await createConnection(
        stores,
        removed.snapshot.revision,
        connectionDraft('removable', 'openai', 'Recreated'),
      );
      assert.notEqual(recreated.connectionId, original.connectionId);
      const recreatedLocator = connectionCredential(recreated, 'api_key');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: recreatedLocator,
            expected: null,
            secret: 'partial-state-secret',
          })
        ).kind,
        'committed',
      );
      const recreatedStatus = await getCredentialStatus(stores.credentialVault, recreatedLocator);
      assert.equal(
        (
          await stores.credentialVault.delete({
            expected: credentialBasis(recreatedStatus),
          })
        ).kind,
        'committed',
      );
      const converged = await stores.connectionCatalog.remove({
        expected: connectionBasis(recreated),
      });
      assert.equal(converged.kind, 'committed');
      if (converged.kind === 'committed') assert.deepEqual(converged.snapshot.connections, []);
      assert.deepEqual((await stores.credentialVault.getSnapshot()).entries, []);
    });
  });

  test('successor recovery removes credentials orphaned by an interrupted connection removal', {
    skip: process.platform === 'win32',
  }, async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const firstOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(firstOwner);
      if (!firstOwner) return;
      const interrupted = await (async () => {
        try {
          const stores = await openInteractiveRuntimePolicyStoresForWrite(firstOwner.lease);
          const connection = await createConnection(
            stores,
            0,
            connectionDraft('interrupted-remove', 'openai', 'Interrupted remove'),
          );
          const locator = connectionCredential(connection, 'api_key');
          assert.equal(
            (
              await stores.credentialVault.set({
                locator,
                expected: null,
                secret: 'cleanup-after-restart',
              })
            ).kind,
            'committed',
          );

          const probe = await open(root, 'r');
          const fileHandlePrototype = Object.getPrototypeOf(probe) as {
            sync: typeof probe.sync;
          };
          const originalSync = fileHandlePrototype.sync;
          await probe.close();
          let syncCalls = 0;
          const syncMock = mock.method(
            fileHandlePrototype,
            'sync',
            async function (this: typeof probe) {
              syncCalls += 1;
              if (syncCalls === 3) throw new Error('injected credential cleanup failure');
              return originalSync.call(this);
            },
          );
          try {
            await assert.rejects(
              stores.connectionCatalog.remove({ expected: connectionBasis(connection) }),
              isStoreError('commit_outcome_unknown'),
            );
          } finally {
            syncMock.mock.restore();
          }

          assert.equal(syncCalls, 3);
          const committedCatalog = await stores.connectionCatalog.getSnapshot();
          assert.deepEqual(committedCatalog.connections, []);
          assert.equal((await stores.credentialVault.getSnapshot()).entries.length, 1);
          return {
            basis: connectionBasis(connection),
            catalogRevision: committedCatalog.revision,
          };
        } finally {
          if (!firstOwner.closed) await firstOwner.close();
        }
      })();

      const successor = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(successor);
      if (!successor) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(successor.lease);
        assert.deepEqual((await stores.credentialVault.getSnapshot()).entries, []);
        const retry = await stores.connectionCatalog.remove({
          expected: interrupted.basis,
        });
        assert.equal(retry.kind, 'committed');
        if (retry.kind === 'committed') {
          assert.equal(retry.snapshot.revision, interrupted.catalogRevision);
        }
      } finally {
        if (!successor.closed) await successor.close();
      }
    });
  });

  test('drains every synchronously admitted ordered mutation before owner close completes', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);

      const first = stores.runtimePolicy.mutate(personalizationMutation(0));
      const second = stores.runtimePolicy.mutate({
        expectedRevision: 1,
        operation: {
          kind: 'set_memory',
          value: { enabled: false, agentReadEnabled: false },
        },
      });
      const third = stores.runtimePolicy.mutate({
        expectedRevision: 2,
        operation: {
          kind: 'set_privacy',
          value: { incognitoActive: true },
        },
      });
      const closing = owner.close();
      assert.equal(owner.closed, true);

      const results = await Promise.all([first, second, third, closing]);
      assert.deepEqual(
        results.slice(0, 3).map((result) => result?.kind),
        ['committed', 'committed', 'committed'],
      );

      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      if (!readerHandle) return;
      try {
        const reader = await openInteractiveRuntimePolicyStoresForRead(readerHandle.lease);
        const snapshot = await reader.runtimePolicy.getSnapshot();
        assert.equal(snapshot.revision, 3);
        assert.deepEqual(snapshot.policy.personalization, {
          displayName: 'Maka',
          assistantTone: 'concise',
        });
        assert.deepEqual(snapshot.policy.memory, { enabled: false, agentReadEnabled: false });
        assert.deepEqual(snapshot.policy.privacy, { incognitoActive: true });
      } finally {
        await readerHandle.close();
      }
    });
  });

  test('fails closed on final symlinks, FIFOs, and oversized documents without changing bytes', {
    skip: process.platform === 'win32',
  }, async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const external = join(root, '..', 'external-policy.json');
      const original = Buffer.from('{"external":true}\n');
      await writeFile(external, original);
      await symlink(external, join(root, 'runtime-policy.json'));
      await assert.rejects(
        () => stores.runtimePolicy.mutate(personalizationMutation(0)),
        isStoreError('invalid_document'),
      );
      assert.deepEqual(await readFile(external), original);
      assert.equal((await lstat(join(root, 'runtime-policy.json'))).isSymbolicLink(), true);
    });

    await withInteractiveOwner(async ({ root, stores }) => {
      const path = join(root, 'runtime-policy.json');
      await execFileAsync('mkfifo', [path]);
      await assert.rejects(
        () => stores.runtimePolicy.getSnapshot(),
        isStoreError('invalid_document'),
      );
      assert.equal((await lstat(path)).isFIFO(), true);
    });

    await withInteractiveOwner(async ({ root, stores }) => {
      const path = join(root, 'runtime-policy.json');
      const original = Buffer.alloc(256 * 1024 + 1, 0x78);
      await writeFile(path, original);
      await assert.rejects(
        () => stores.runtimePolicy.mutate(personalizationMutation(0)),
        isStoreError('invalid_document'),
      );
      assert.deepEqual(await readFile(path), original);
    });
  });

  test('single-flights writer recovery and preserves credential material across owner reopen', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const firstOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(firstOwner);
      if (!firstOwner) return;
      let connection!: ConnectionCatalogEntry;
      let firstStatus!: CredentialStatus;
      const secret = 'persisted-secret-after-recovery';
      const temporaryNames = [
        'runtime-policy.json.11111111-1111-4111-8111-111111111111.tmp',
        'connection-catalog.json.22222222-2222-4222-8222-222222222222.tmp',
        'credential-vault.json.33333333-3333-4333-8333-333333333333.tmp',
      ];
      try {
        await Promise.all([
          writeFile(join(root, temporaryNames[0]!), '{"orphan":true}\n', 'utf8'),
          writeFile(join(root, temporaryNames[1]!), '{"orphan":true}\n', 'utf8'),
          writeFile(join(root, temporaryNames[2]!), 'plaintext-credential-orphan\n', 'utf8'),
        ]);
        const [first, sameLeaseOpen] = await Promise.all([
          openInteractiveRuntimePolicyStoresForWrite(firstOwner.lease),
          openInteractiveRuntimePolicyStoresForWrite(firstOwner.lease),
        ]);
        assert.equal(first, sameLeaseOpen);
        const remaining = new Set(await readdir(root));
        assert.deepEqual(
          temporaryNames.filter((name) => remaining.has(name)),
          [],
        );

        connection = await createConnection(
          first,
          0,
          connectionDraft('reopen', 'openai', 'Reopen'),
        );
        const locator = connectionCredential(connection, 'api_key');
        assert.equal(
          (
            await first.credentialVault.set({
              locator,
              expected: null,
              secret,
            })
          ).kind,
          'committed',
        );
        firstStatus = await getCredentialStatus(first.credentialVault, locator);
        assert.equal(JSON.stringify(firstStatus).includes(secret), false);
      } finally {
        if (!firstOwner.closed) await firstOwner.close();
      }

      const secondOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(secondOwner);
      if (!secondOwner) return;
      try {
        const second = await openInteractiveRuntimePolicyStoresForWrite(secondOwner.lease);
        const resolved = await second.operations.resolveExecutionConnection(connection.slug);
        assert.equal(resolved.kind, 'ready');
        if (resolved.kind !== 'ready') return;
        assert.equal(resolved.secretMaterial.connection?.secret, secret);
        assert.equal(resolved.secretMaterial.connection?.credentialId, firstStatus.credentialId);
      } finally {
        if (!secondOwner.closed) await secondOwner.close();
      }

      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      if (!readerHandle) return;
      try {
        const reader = await openInteractiveRuntimePolicyStoresForRead(readerHandle.lease);
        const publicStatus = await getCredentialStatus(
          reader.credentialVault,
          connectionCredential(connection, 'api_key'),
        );
        assert.equal(publicStatus.credentialId, firstStatus.credentialId);
        const publicViews = JSON.stringify([
          publicStatus,
          await reader.credentialVault.getSnapshot(),
        ]);
        assert.equal(publicViews.includes(secret), false);
      } finally {
        await readerHandle.close();
      }
    });
  });

  test('interactive OAuth login commits only against its frozen connection and credential basis', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const claude = await createConnection(
        stores,
        0,
        connectionDraft('claude-login', 'claude-subscription', 'Claude login'),
      );
      const first = await stores.operations.beginInteractiveOAuthLogin(claude.connectionId);
      const second = await stores.operations.beginInteractiveOAuthLogin(claude.connectionId);
      assert.equal(first.kind, 'ready');
      assert.equal(second.kind, 'ready');
      if (first.kind !== 'ready' || second.kind !== 'ready') return;
      assert.equal(first.secretMaterial.networkProxy, undefined);
      const committed = await stores.operations.completeInteractiveOAuthLogin(
        second.ticket,
        'oauth-secret-v1',
      );
      assert.equal(committed.kind, 'committed');
      assert.deepEqual(
        await stores.operations.completeInteractiveOAuthLogin(first.ticket, 'stale-secret'),
        { kind: 'superseded', changed: ['credential'] },
      );
      const status = await getCredentialStatus(
        stores.credentialVault,
        connectionCredential(claude, 'oauth_token'),
      );
      assert.equal(status.configured, true);
      await assert.rejects(
        () => stores.operations.completeInteractiveOAuthLogin(second.ticket, 'ticket-replay'),
        isStoreError('invalid_credential_input'),
      );

      const beforeUpdate = await stores.operations.beginInteractiveOAuthLogin(claude.connectionId);
      assert.equal(beforeUpdate.kind, 'ready');
      if (beforeUpdate.kind !== 'ready') return;
      const current = (await stores.connectionCatalog.getSnapshot()).connections.find(
        (connection) => connection.connectionId === claude.connectionId,
      );
      assert.ok(current);
      const updated = await stores.connectionCatalog.update({
        expected: connectionBasis(current),
        changes: {
          name: 'Claude renamed',
          enabled: current.enabled,
          enabledModelIds: current.enabledModelIds,
        },
      });
      assert.equal(updated.kind, 'committed');
      assert.deepEqual(
        await stores.operations.completeInteractiveOAuthLogin(
          beforeUpdate.ticket,
          'connection-stale-secret',
        ),
        { kind: 'superseded', changed: ['connection'] },
      );

      const copilot = await createConnection(
        stores,
        2,
        connectionDraft('copilot-import', 'github-copilot', 'Copilot import'),
      );
      assert.deepEqual(await stores.operations.beginInteractiveOAuthLogin(copilot.connectionId), {
        kind: 'provider_action_unavailable',
        availability: 'hidden',
      });
    });
  });

  test('rejects headless leases, forged facades, and operations after interactive lease close', async () => {
    await withTempDir(async (base) => {
      const headlessRoot = join(base, 'headless');
      const headless = await resolveStorageRoot({ path: headlessRoot, kind: 'headless' });
      const before = await snapshotRoot(headlessRoot);
      await assert.rejects(
        () =>
          openInteractiveRuntimePolicyStoresForWrite(
            createHeadlessRootLease(headless, 'write') as unknown as StorageRootLease<
              'interactive',
              'write'
            >,
          ),
        isInvalidLease,
      );
      assert.deepEqual(await snapshotRoot(headlessRoot), before);
    });

    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      assert.equal(authenticateRuntimePolicyStoresWriter(writer), writer);
      assert.throws(() => authenticateRuntimePolicyStoresWriter({ ...writer }), isInvalidLease);
      await owner.close();
      await assert.rejects(() => writer.runtimePolicy.getSnapshot(), isInvalidLease);

      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      if (!readerHandle) return;
      const reader = await openInteractiveRuntimePolicyStoresForRead(readerHandle.lease);
      assert.equal(authenticateRuntimePolicyStoresReader(reader), reader);
      assert.throws(() => authenticateRuntimePolicyStoresReader({ ...reader }), isInvalidLease);
      await readerHandle.close();
      await assert.rejects(() => reader.connectionCatalog.getSnapshot(), isInvalidLease);
    });
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Writer = Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;

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
  return created;
}

async function verifyConnection(
  stores: Writer,
  connectionId: string,
  checkedAt: string,
): Promise<void> {
  const prepared = await stores.operations.beginConnectionTest(connectionId, null);
  assert.equal(prepared.kind, 'ready');
  if (prepared.kind !== 'ready') throw new Error('connection test preparation did not succeed');
  const completed = await stores.operations.completeConnectionTest(prepared.ticket, {
    status: 'verified',
    checkedAt,
  });
  assert.equal(completed.kind, 'committed');
}

function connectionDraft(
  slug: string,
  providerType: ConnectionCatalogEntryDraft['providerType'],
  name: string,
): ConnectionCatalogEntryDraft {
  return {
    slug,
    name,
    providerType,
    enabled: true,
    enabledModelIds: ['gpt-5'],
  };
}

function connectionBasis(connection: ConnectionCatalogEntry): ConnectionVersionBasis {
  return { connectionId: connection.connectionId, revision: connection.revision };
}

function connectionCredential(
  connection: ConnectionCatalogEntry,
  kind: 'api_key' | 'oauth_token',
): Extract<CredentialLocator, { scope: 'connection' }> {
  return { scope: 'connection', connectionId: connection.connectionId, kind };
}

function proxyCredential(): Extract<CredentialLocator, { scope: 'network_proxy' }> {
  return { scope: 'network_proxy', kind: 'password' };
}

async function getCredentialStatus(
  vault: Pick<Writer['credentialVault'], 'getStatus'>,
  locator: CredentialLocator,
): Promise<CredentialStatus> {
  const result = await vault.getStatus(locator);
  assert.equal(result.kind, 'status');
  if (result.kind !== 'status') throw new Error('credential status query did not return a status');
  return result.status;
}

function credentialBasis(status: CredentialStatus): CredentialVersionBasis {
  assert.equal(status.configured, true);
  if (!status.configured) throw new Error('credential is not configured');
  return {
    locator: status.locator,
    credentialId: status.credentialId,
    revision: status.revision,
  };
}

function credentialExpectation(status: CredentialStatus): {
  credentialId: string;
  revision: number;
} {
  const basis = credentialBasis(status);
  return { credentialId: basis.credentialId, revision: basis.revision };
}

function personalizationMutation(expectedRevision: number): MutateRuntimePolicyInput {
  return {
    expectedRevision,
    operation: {
      kind: 'set_personalization',
      value: { displayName: 'Maka', assistantTone: 'concise' },
    },
  };
}

function networkProxyMutation(
  expectedRevision: number,
  changes: Partial<RuntimePolicy['networkProxy']> = {},
): MutateRuntimePolicyInput {
  return {
    expectedRevision,
    operation: {
      kind: 'set_network_proxy',
      value: {
        enabled: true,
        protocol: 'http',
        host: '127.0.0.1',
        port: 8080,
        authEnabled: true,
        username: 'proxy-user',
        bypassList: ['localhost'],
        autoBypassDomains: ['127.0.0.1'],
        ...changes,
      },
    },
  };
}

function isStoreError(code: RuntimePolicyStoreError['code']) {
  return (error: unknown) => error instanceof RuntimePolicyStoreError && error.code === code;
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}

async function withInteractiveOwner(
  run: (input: { root: string; stores: Writer }) => Promise<void>,
): Promise<void> {
  await withInteractiveRoot(async ({ root, capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      await run({ root, stores: await openInteractiveRuntimePolicyStoresForWrite(owner.lease) });
    } finally {
      if (!owner.closed) await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (base) => {
    const root = join(base, 'interactive');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  });
}

async function withTempDir(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-'));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function snapshotRoot(root: string): Promise<readonly RootSnapshotEntry[]> {
  const names = (await readdir(root)).sort();
  return Promise.all(
    names.map(async (name) => {
      const path = join(root, name);
      const metadata = await stat(path);
      return {
        name,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        contents: metadata.isFile() ? await readFile(path, 'utf8') : null,
      };
    }),
  );
}

interface RootSnapshotEntry {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly contents: string | null;
}
