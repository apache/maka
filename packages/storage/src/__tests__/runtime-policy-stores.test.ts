import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, mock, test } from 'node:test';
import {
  createDefaultRuntimePolicy,
  type ConnectionCatalogEntry,
  type ConnectionCatalogEntryDraft,
  type ConnectionVersionBasis,
  type CredentialLocator,
  type CredentialStatus,
  type CredentialVersionBasis,
  type MutateRuntimePolicyInput,
  type RuntimePolicy,
} from '@maka/core/runtime-policy';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import {
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
  test('persists extra request bodies and resolves custom headers as secret execution material', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(stores, 0, {
        ...connectionDraft('customized-openai', 'openai', 'Customized OpenAI'),
        requestBodyOverlay: { provider: { order: ['primary'] } },
      });
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: 'provider-secret',
      });
      assert.deepEqual(
        await stores.operations.replaceConnectionRequestHeaders(connection.connectionId, [
          { name: 'X-Tenant', value: 'tenant-a' },
        ]),
        { kind: 'committed', names: ['X-Tenant'] },
      );
      assert.deepEqual(
        await stores.operations.replaceConnectionRequestHeaders(connection.connectionId, [
          { name: 'x-tenant' },
          { name: 'X-Title', value: 'Maka' },
        ]),
        { kind: 'committed', names: ['x-tenant', 'X-Title'] },
      );
      assert.deepEqual(
        await stores.operations.getConnectionRequestHeaders(connection.connectionId),
        { names: ['x-tenant', 'X-Title'] },
      );

      const resolved = await stores.operations.resolveExecutionConnection(connection.slug);
      assert.equal(resolved.kind, 'ready');
      if (resolved.kind !== 'ready') return;
      assert.deepEqual(resolved.connection.requestBodyOverlay, {
        provider: { order: ['primary'] },
      });
      assert.equal(
        resolved.secretMaterial.requestHeaders?.secret,
        JSON.stringify({ 'x-tenant': 'tenant-a', 'X-Title': 'Maka' }),
      );

      const updated = await stores.connectionCatalog.update({
        expected: connectionBasis(resolved.connection),
        changes: {
          name: resolved.connection.name,
          enabled: resolved.connection.enabled,
          enabledModelIds: resolved.connection.enabledModelIds,
          requestBodyOverlay: null,
        },
      });
      assert.equal(updated.kind, 'committed');
      if (updated.kind === 'committed') {
        assert.equal(updated.snapshot.connections[0]?.requestBodyOverlay, undefined);
      }
    });
  });

  test('carries, replaces, clears, and endpoint-retires the typed capability table', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const declared = {
        'relay-model': {
          thinkingLevels: ['minimal', 'low'] as const,
          vision: true,
          contextWindow: 128_000,
        },
      };
      // Create persists the typed projection — and only the projection
      // (the extras bag never entered the picture).
      const connection = await createConnection(stores, 0, {
        ...connectionDraft('my-relay', 'openai-compatible', 'My Relay'),
        baseUrl: 'https://relay.example/v1',
        enabledModelIds: ['relay-model'],
        relayModelProfiles: declared,
      });
      assert.deepEqual(connection.relayModelProfiles, declared);

      // Replacement is total: a new table swaps in, null clears.
      const replaced = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes: {
          name: connection.name,
          baseUrl: connection.baseUrl,
          enabled: true,
          enabledModelIds: ['relay-model'],
          relayModelProfiles: { 'relay-model': { vision: false } },
        },
      });
      assert.equal(replaced.kind, 'committed');
      if (replaced.kind !== 'committed') return;
      const afterReplace = replaced.snapshot.connections[0];
      assert.deepEqual(afterReplace?.relayModelProfiles, { 'relay-model': { vision: false } });

      const cleared = await stores.connectionCatalog.update({
        expected: connectionBasis(afterReplace!),
        changes: {
          name: connection.name,
          baseUrl: connection.baseUrl,
          enabled: true,
          enabledModelIds: ['relay-model'],
          relayModelProfiles: null,
        },
      });
      assert.equal(cleared.kind, 'committed');
      if (cleared.kind !== 'committed') return;
      const afterClear = cleared.snapshot.connections[0];
      assert.equal(afterClear?.relayModelProfiles, undefined);

      // An absent key leaves the table untouched (name-only saves stay
      // capability-blind), and an UNANNOUNCED endpoint change retires the
      // table along with the fetched inventory: the new baseUrl fronts
      // different models, and the old declarations must not outlive them.
      const retained = await stores.connectionCatalog.update({
        expected: connectionBasis(afterClear!),
        changes: {
          name: connection.name,
          baseUrl: connection.baseUrl,
          enabled: true,
          enabledModelIds: ['relay-model'],
          relayModelProfiles: declared,
        },
      });
      assert.equal(retained.kind, 'committed');
      if (retained.kind !== 'committed') return;
      const nameOnly = await stores.connectionCatalog.update({
        expected: connectionBasis(retained.snapshot.connections[0]!),
        changes: {
          name: 'Renamed Relay',
          baseUrl: connection.baseUrl,
          enabled: true,
          enabledModelIds: ['relay-model'],
        },
      });
      assert.equal(nameOnly.kind, 'committed');
      if (nameOnly.kind !== 'committed') return;
      assert.deepEqual(nameOnly.snapshot.connections[0]?.relayModelProfiles, declared);

      const endpointMoved = await stores.connectionCatalog.update({
        expected: connectionBasis(nameOnly.snapshot.connections[0]!),
        changes: {
          name: 'Renamed Relay',
          baseUrl: 'https://other-relay.example/v1',
          enabled: true,
          enabledModelIds: ['relay-model'],
        },
      });
      assert.equal(endpointMoved.kind, 'committed');
      if (endpointMoved.kind !== 'committed') return;
      assert.equal(endpointMoved.snapshot.connections[0]?.relayModelProfiles, undefined);
      assert.deepEqual(endpointMoved.snapshot.connections[0]?.models, []);

      // …unless the same update submits a table of its own — then the table
      // belongs to the NEW endpoint and is stored. Config import relies on
      // this exact single-call shape.
      const movedWithTable = await stores.connectionCatalog.update({
        expected: connectionBasis(endpointMoved.snapshot.connections[0]!),
        changes: {
          name: 'Renamed Relay',
          baseUrl: 'https://third-relay.example/v1',
          enabled: true,
          enabledModelIds: ['relay-model'],
          relayModelProfiles: declared,
        },
      });
      assert.equal(movedWithTable.kind, 'committed');
      if (movedWithTable.kind !== 'committed') return;
      assert.deepEqual(movedWithTable.snapshot.connections[0]?.relayModelProfiles, declared);
      assert.deepEqual(movedWithTable.snapshot.connections[0]?.models, []);
    });
  });

  test('an untouched profile table is pruned to the new enabled-model selection', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const declared = {
        'relay-model': { vision: true as const },
        'relay-model-2': { contextWindow: 64_000 as const },
      };
      const connection = await createConnection(stores, 0, {
        ...connectionDraft('prune-relay', 'openai-compatible', 'Prune Relay'),
        baseUrl: 'https://relay.example/v1',
        enabledModelIds: ['relay-model', 'relay-model-2'],
        relayModelProfiles: declared,
      });
      assert.deepEqual(connection.relayModelProfiles, declared);

      const disabled = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes: {
          name: connection.name,
          baseUrl: connection.baseUrl,
          enabled: true,
          enabledModelIds: ['relay-model'],
        },
      });
      assert.equal(disabled.kind, 'committed');
      if (disabled.kind !== 'committed') return;
      // No profile instruction rode along, so the ⊆ enabledModelIds rule is
      // the store's job: the disabled model's declaration is gone, never
      // stranded as a stale key the settings page cannot see.
      assert.deepEqual(disabled.snapshot.connections[0]?.relayModelProfiles, {
        'relay-model': { vision: true },
      });

      // Pruning everything degrades to "no table" — never a stored `{}`.
      const allDisabled = await stores.connectionCatalog.update({
        expected: connectionBasis(disabled.snapshot.connections[0]!),
        changes: {
          name: connection.name,
          baseUrl: connection.baseUrl,
          enabled: true,
          enabledModelIds: [],
        },
      });
      assert.equal(allDisabled.kind, 'committed');
      if (allDisabled.kind !== 'committed') return;
      assert.equal(allDisabled.snapshot.connections[0]?.relayModelProfiles, undefined);
    });
  });

  // The migrating half of this behaviour is covered in @maka/core: seeding an
  // OAuth credential for the provider that declares aliases is refused here,
  // since the vault only accepts client-supplied OAuth for GitHub Copilot.
  test('a relay keeps its own ids opaque through a model refresh', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      // Same ids, different provider. A relay may serve `claude-*` names as its
      // own identifiers, so nothing here may be rewritten on Anthropic's behalf.
      const connection = await createConnection(stores, 0, {
        ...connectionDraft('alias-relay', 'openai-compatible', 'Alias Relay'),
        baseUrl: 'https://relay.example/v1',
        enabledModelIds: ['claude-haiku-4-5-20251001'],
        relayModelProfiles: { 'claude-haiku-4-5-20251001': { vision: true } },
      });

      const credential = await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: 'sk-relay',
      });
      assert.equal(credential.kind, 'committed');

      const fetch = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(fetch.kind, 'ready');
      if (fetch.kind !== 'ready') return;

      const discovered = await stores.operations.completeModelFetch(fetch.ticket, {
        models: [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }],
        source: 'fetched',
        fetchedAt: 1_800_000_000_000,
      });
      assert.equal(discovered.kind, 'committed');
      if (discovered.kind !== 'committed') return;
      // Repaired against the live list like any other id, not migrated.
      assert.deepEqual(discovered.snapshot.connections[0]?.enabledModelIds, ['claude-opus-5']);
    });
  });

  test('a model refresh prunes profiles for models the inventory retired', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(stores, 0, {
        ...connectionDraft('refresh-relay', 'openai-compatible', 'Refresh Relay'),
        baseUrl: 'https://relay.example/v1',
        enabledModelIds: ['model-a', 'model-b'],
        relayModelProfiles: {
          'model-a': { vision: true },
          'model-b': { contextWindow: 64_000 },
        },
      });
      assert.deepEqual(connection.relayModelProfiles, {
        'model-a': { vision: true },
        'model-b': { contextWindow: 64_000 },
      });

      // A /models fetch needs a credential first — discovery is refused for
      // credential-less connections before any of this runs.
      const credential = await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: 'sk-refresh',
      });
      assert.equal(credential.kind, 'committed');

      // The /models refresh drops model-a from the live inventory. The
      // refresh write bypasses the canonical decoder — without pruning the
      // table, model-a's profile would persist and every later canonical
      // read would reject the document.
      const fetch = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(fetch.kind, 'ready');
      if (fetch.kind !== 'ready') return;
      const discovered = await stores.operations.completeModelFetch(fetch.ticket, {
        models: [{ id: 'model-b' }],
        source: 'fetched',
        fetchedAt: 43,
      });
      assert.equal(discovered.kind, 'committed');
      if (discovered.kind !== 'committed') return;
      const after = discovered.snapshot.connections[0];
      assert.deepEqual(after?.enabledModelIds, ['model-b']);
      assert.deepEqual(after?.relayModelProfiles, { 'model-b': { contextWindow: 64_000 } });

      // The document must survive a canonical reload: the next mutation
      // re-decodes persisted state, and a stranding here would have raised
      // invalid_document instead of committing.
      const roundtrip = await stores.connectionCatalog.update({
        expected: connectionBasis(after!),
        changes: {
          name: connection.name,
          baseUrl: connection.baseUrl,
          enabled: true,
          enabledModelIds: ['model-b'],
        },
      });
      assert.equal(roundtrip.kind, 'committed');
      if (roundtrip.kind !== 'committed') return;
      assert.deepEqual(roundtrip.snapshot.connections[0]?.relayModelProfiles, {
        'model-b': { contextWindow: 64_000 },
      });
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
        relayModelProfiles: null,
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
          relayModelProfiles: null,
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
          relayModelProfiles: null,
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
    skip:
      process.platform === 'win32'
        ? 'POSIX permissions are required to inject a persistence failure'
        : false,
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
    skip:
      process.platform === 'win32'
        ? 'POSIX permissions are required to inject a persistence failure'
        : false,
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
    skip:
      process.platform === 'win32'
        ? 'POSIX permissions are required to inject a persistence failure'
        : false,
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

  test('commits effects when proxy representation or GET-irrelevant body settings change', async () => {
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

      const current = completed.snapshot.connections[0]!;
      const modelFetch = await stores.operations.beginModelFetch(current.connectionId);
      assert.equal(modelFetch.kind, 'ready');
      if (modelFetch.kind !== 'ready') return;
      const bodyUpdate = await stores.connectionCatalog.update({
        expected: connectionBasis(current),
        changes: {
          name: current.name,
          enabled: current.enabled,
          enabledModelIds: current.enabledModelIds,
          requestBodyOverlay: { provider: { only: ['deepseek'] } },
        },
      });
      assert.equal(bodyUpdate.kind, 'committed');
      assert.equal(
        (
          await stores.operations.completeModelFetch(modelFetch.ticket, {
            models: [{ id: 'gpt-5' }],
            source: 'fetched',
            fetchedAt: 2,
          })
        ).kind,
        'committed',
      );
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
          relayModelProfiles: null,
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
          relayModelProfiles: null,
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
    skip:
      process.platform === 'win32'
        ? 'POSIX permissions are required to inject a persistence failure'
        : false,
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

  test('blocks WebFetch while privacy mode is active', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const policy = await stores.runtimePolicy.mutate({
        expectedRevision: 0,
        operation: { kind: 'set_privacy', value: { incognitoActive: true } },
      });
      assert.equal(policy.kind, 'committed');

      assert.deepEqual(await stores.operations.resolveWebFetchExecution(), {
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
          relayModelProfiles: null,
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
    skip:
      process.platform === 'win32'
        ? 'POSIX permissions are required to inject a persistence failure'
        : false,
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
          relayModelProfiles: null,
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

  test('rejects forged leases, forged facades, and operations after interactive lease close', async () => {
    await assert.rejects(
      () =>
        openInteractiveRuntimePolicyStoresForWrite({} as StorageRootLease<'interactive', 'write'>),
      isInvalidLease,
    );

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

  test('declares Credential Profile CRUD with fail-closed lifecycle semantics', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('profiles', 'openai', 'Profiles'),
      );
      // Adding the first secondary Profile materializes the implicit primary
      // (profileId === connectionId) and keeps mode=legacy_primary.
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const afterCreate = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      );
      assert.ok(afterCreate?.credentialRouting);
      const routing = afterCreate!.credentialRouting!;
      assert.equal(routing.mode, 'legacy_primary');
      assert.equal(routing.strategy, 'smooth_weighted_round_robin');
      assert.equal(routing.profiles.length, 2);
      const primary = routing.profiles.find(
        (profile) => profile.profileId === connection.connectionId,
      );
      assert.deepEqual(
        { label: primary?.label, enabled: primary?.enabled, weight: primary?.weight },
        { label: 'primary', enabled: true, weight: 1 },
      );
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      );
      assert.ok(secondary);
      assert.equal(secondary.enabled, false, 'a new Profile is created disabled');
      assert.equal(secondary.label, 'backup');
      assert.equal(secondary.weight, 1);

      // Label conflict is case-insensitive.
      const conflict = await stores.operations.createCredentialProfile({
        expected: { connectionId: connection.connectionId, revision: afterCreate!.revision },
        label: 'BACKUP',
        weight: 2,
      });
      assert.equal(conflict.kind, 'profile_label_conflict');

      // Updating label and weight bumps only the target Profile.
      const updated = await stores.operations.updateCredentialProfile({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: afterCreate!.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        label: 'backup-2',
        weight: 2,
      });
      assert.equal(updated.kind, 'committed');
      if (updated.kind !== 'committed') return;
      const updatedRouting = updated.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      const updatedSecondary = updatedRouting.profiles.find(
        (profile) => profile.profileId === secondary.profileId,
      )!;
      assert.equal(updatedSecondary.label, 'backup-2');
      assert.equal(updatedSecondary.weight, 2);
      assert.equal(updatedSecondary.revision, secondary.revision + 1);

      // Stale profile basis is rejected (current connection revision, stale
      // profile revision).
      const stale = await stores.operations.updateCredentialProfile({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: updated.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        weight: 3,
      });
      assert.equal(stale.kind, 'profile_stale');

      // Enabling a Profile is an explicit step.
      const enabled = await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: updated.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: updatedSecondary.revision,
        },
        enabled: true,
      });
      assert.equal(enabled.kind, 'committed');

      // Removing the primary is forbidden; the reserved identity survives.
      const removePrimary = await stores.operations.removeCredentialProfile({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: enabled.snapshot.revision,
          profileId: connection.connectionId,
          profileRevision: 1,
        },
      });
      assert.equal(removePrimary.kind, 'primary_not_removable');
    });
  });

  test('rejects profile creation for providers without profile-capable auth', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const provider = (
        Object.keys(PROVIDER_DEFAULTS) as Array<keyof typeof PROVIDER_DEFAULTS>
      ).find((candidate) => PROVIDER_DEFAULTS[candidate].authKind === 'none');
      assert.ok(provider, 'fixture expects at least one authKind=none provider');
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('no-auth', provider, 'No auth'),
      );
      const result = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(result.kind, 'auth_not_supported');
    });
  });

  test('balanced activation requires configured credentials and preserves primary', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('balanced', 'openai', 'Balanced'),
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
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;

      // Balanced activation is rejected while credentials are unconfigured.
      const rejected = await stores.operations.setCredentialRoutingMode({
        expected: { connectionId: connection.connectionId, revision: snapshot.revision },
        mode: 'balanced',
      });
      assert.equal(rejected.kind, 'balanced_activation_rejected');

      // Configure the primary credential only.
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      const stillRejected = await stores.operations.setCredentialRoutingMode({
        expected: { connectionId: connection.connectionId, revision: snapshot.revision },
        mode: 'balanced',
      });
      assert.equal(stillRejected.kind, 'balanced_activation_rejected');

      // Configure the secondary credential too.
      await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: connection.connectionId,
          profileId: secondary.profileId,
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
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
      routing = snapshot.connections.find((item) => item.connectionId === connection.connectionId)!
        .credentialRouting!;

      // Balanced activation is still rejected while no profile has
      // verification evidence: credentials alone must never produce a
      // configuration whose first dispatch is guaranteed to pool-exhaust.
      const noVerification = await stores.operations.setCredentialRoutingMode({
        expected: { connectionId: connection.connectionId, revision: snapshot.revision },
        mode: 'balanced',
      });
      assert.equal(noVerification.kind, 'balanced_activation_rejected');

      // Seed Profile verification through the production writer (RFC 4.5).
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
      assert.equal(
        activated.snapshot.connections.find(
          (item) => item.connectionId === connection.connectionId,
        )!.credentialRouting!.mode,
        'balanced',
      );

      // Switching back to legacy_primary is a plain CAS write.
      const back = await stores.operations.setCredentialRoutingMode({
        expected: { connectionId: connection.connectionId, revision: activated.snapshot.revision },
        mode: 'legacy_primary',
      });
      assert.equal(back.kind, 'committed');
    });
  });

  test('removing a secondary profile deletes its vault credential and never the primary', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('remove-profile', 'openai', 'Remove profile'),
      );
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;
      const locator = {
        scope: 'connection_profile' as const,
        connectionId: connection.connectionId,
        profileId: secondary.profileId,
        kind: 'api_key' as const,
      };
      await stores.credentialVault.set({ locator, expected: null, secret: '[redacted]' });

      const removed = await stores.operations.removeCredentialProfile({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: created.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
      });
      assert.equal(removed.kind, 'committed');
      if (removed.kind !== 'committed') return;
      const afterRemove = removed.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!;
      assert.ok(afterRemove.credentialRouting);
      assert.equal(afterRemove.credentialRouting.profiles.length, 1);
      assert.equal(afterRemove.credentialRouting.profiles[0]!.profileId, connection.connectionId);
      const status = await stores.credentialVault.getStatus(locator);
      assert.equal(
        status.kind,
        'connection_not_found',
        'a removed profile locator is no longer a valid credential target',
      );
      assert.equal(
        (await stores.credentialVault.getSnapshot()).entries.length,
        0,
        'secondary vault credential is deleted on profile removal',
      );
    });
  });

  test('connection removal cleans up primary and secondary profile credentials', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('cleanup', 'openai', 'Cleanup'),
      );
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: connection.connectionId,
          profileId: secondary.profileId,
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
      });
      assert.equal(
        (await stores.credentialVault.getSnapshot()).entries.length,
        2,
        'both locators are configured before removal',
      );

      const current = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!;
      const removed = await stores.connectionCatalog.remove({
        expected: connectionBasis(current),
      });
      assert.equal(removed.kind, 'committed');
      assert.equal(
        (await stores.credentialVault.getSnapshot()).entries.length,
        0,
        'connection removal deletes primary and profile credentials',
      );
    });
  });

  test('lazy-migrates catalog v1 to v2 only on the first profile mutation', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const connection = await createConnection(
          stores,
          0,
          connectionDraft('lazy-v1', 'openai', 'Lazy v1'),
        );
        const catalogPath = join(root, 'connection-catalog.json');
        const vaultPath = join(root, 'credential-vault.json');
        const catalogV1 = JSON.parse(await readFile(catalogPath, 'utf8'));
        assert.equal(catalogV1.schemaVersion, 1, 'legacy connection stays v1');
        await assert.rejects(
          readFile(vaultPath, 'utf8'),
          /ENOENT/,
          'an empty vault is not persisted until the first credential write',
        );

        // A profile mutation forces catalog v2; the vault stays v1 until a
        // secondary locator mutation.
        const created = await stores.operations.createCredentialProfile({
          expected: connectionBasis(connection),
          label: 'backup',
          weight: 1,
        });
        assert.equal(created.kind, 'committed');
        const catalogV2 = JSON.parse(await readFile(catalogPath, 'utf8')) as {
          schemaVersion: number;
          connections: readonly ConnectionCatalogEntry[];
        };
        assert.equal(
          catalogV2.schemaVersion,
          2,
          'catalog is persisted as v2 after profile mutation',
        );
        await assert.rejects(
          readFile(vaultPath, 'utf8'),
          /ENOENT/,
          'catalog v2 alone does not force vault persistence',
        );

        const routing = catalogV2.connections[0]!.credentialRouting!;
        assert.equal(routing.profiles.length, 2);

        // The secondary locator mutation forces vault v2.
        const secondary = routing.profiles.find(
          (profile) => profile.profileId !== connection.connectionId,
        );
        assert.ok(secondary);
        await stores.credentialVault.set({
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: secondary.profileId,
            kind: 'api_key',
          },
          expected: null,
          secret: '[redacted]',
        });
        const vaultV2 = JSON.parse(await readFile(vaultPath, 'utf8'));
        assert.equal(
          vaultV2.schemaVersion,
          2,
          'vault is persisted as v2 after secondary locator mutation',
        );
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('reads v1 catalog documents as implicit primary without rewriting', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      // Hand-write a v1 catalog + v1 vault to simulate a legacy install.
      const connectionId = '00000000-0000-4000-8000-000000000001';
      await writeFile(
        join(root, 'connection-catalog.json'),
        JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          defaultTarget: { connectionId, modelId: 'gpt-5' },
          connections: [
            {
              connectionId,
              revision: 1,
              slug: 'legacy',
              name: 'Legacy',
              providerType: 'openai',
              enabled: true,
              enabledModelIds: ['gpt-5'],
              models: [],
            },
          ],
        }),
        'utf8',
      );
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const snapshot = await stores.connectionCatalog.getSnapshot();
        assert.equal(snapshot.connections.length, 1);
        assert.equal(
          snapshot.connections[0]!.credentialRouting,
          undefined,
          'v1 is implicit primary',
        );
        const raw = JSON.parse(await readFile(join(root, 'connection-catalog.json'), 'utf8'));
        assert.equal(raw.schemaVersion, 1, 'recovery must not rewrite a v1 catalog');
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('rejects unknown v1/v2 future document schema versions fail-closed', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      await writeFile(
        join(root, 'connection-catalog.json'),
        JSON.stringify({ schemaVersion: 99, revision: 0, defaultTarget: null, connections: [] }),
        'utf8',
      );
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        await assert.rejects(
          openInteractiveRuntimePolicyStoresForWrite(owner.lease),
          isStoreError('invalid_document'),
        );
      } finally {
        if (!owner.closed) await owner.close();
      }
    });
  });

  test('rejects connection_profile credential writes that bypass Catalog authority', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('authority', 'openai', 'Authority'),
      );
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const snapshot = created.snapshot;
      const routing = snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;

      // (a) Nonexistent profile on an existing connection -> connection_not_found.
      const ghost = await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: connection.connectionId,
          profileId: '00000000-0000-4000-8000-00000000dead',
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
      });
      assert.equal(ghost.kind, 'connection_not_found');

      // (b) The primary identity smuggled through the profile scope is rejected.
      await assert.rejects(
        stores.credentialVault.set({
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: '[redacted]',
        }),
        isStoreError('invalid_credential_input'),
      );

      // (c) Nonexistent connection -> connection_not_found.
      const badConnection = await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: '00000000-0000-4000-8000-00000000beef',
          profileId: secondary.profileId,
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
      });
      assert.equal(badConnection.kind, 'connection_not_found');

      // (d) A valid secondary profile credential is accepted.
      const ok = await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: connection.connectionId,
          profileId: secondary.profileId,
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
      });
      assert.equal(ok.kind, 'committed');

      // (e) Deleting a ghost profile credential is refused too.
      const ghostDelete = await stores.credentialVault.delete({
        expected: {
          locator: {
            scope: 'connection_profile',
            connectionId: connection.connectionId,
            profileId: '00000000-0000-4000-8000-00000000dead',
            kind: 'api_key',
          },
          credentialId: '00000000-0000-4000-8000-00000000deed',
          revision: 1,
        },
      });
      assert.equal(ghostDelete.kind, 'connection_not_found');
    });
  });

  test('verification writer is CAS-bound and balanced activation requires current evidence', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('verify', 'openai', 'Verify'),
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
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;

      // Configure credentials for both profiles.
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: connection.connectionId,
          profileId: secondary.profileId,
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
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
      routing = snapshot.connections.find((item) => item.connectionId === connection.connectionId)!
        .credentialRouting!;
      const currentSecondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;

      // A stale connection revision is rejected (CAS-bound writer).
      const stale = await stores.operations.recordCredentialProfileVerification({
        connectionId: connection.connectionId,
        connectionRevision: snapshot.revision - 1,
        profileId: currentSecondary.profileId,
        profileRevision: currentSecondary.revision,
        modelId: 'gpt-5',
        status: 'supported',
        source: 'tested',
        evidence: 'positive_only',
        checkedAt: 1000,
      });
      assert.equal(stale.kind, 'connection_stale');

      // Activation is still rejected (only primary has evidence).
      await stores.operations.recordCredentialProfileVerification({
        connectionId: connection.connectionId,
        connectionRevision: snapshot.revision,
        profileId: connection.connectionId,
        profileRevision: 1,
        modelId: 'gpt-5',
        status: 'supported',
        source: 'tested',
        evidence: 'positive_only',
        checkedAt: 1000,
      });
      const onlyPrimary = await stores.operations.setCredentialRoutingMode({
        expected: { connectionId: connection.connectionId, revision: snapshot.revision },
        mode: 'balanced',
      });
      assert.equal(onlyPrimary.kind, 'balanced_activation_rejected');

      // Secondary evidence completes the gate.
      const recorded = await stores.operations.recordCredentialProfileVerification({
        connectionId: connection.connectionId,
        connectionRevision: snapshot.revision,
        profileId: currentSecondary.profileId,
        profileRevision: currentSecondary.revision,
        modelId: 'gpt-5',
        status: 'supported',
        source: 'tested',
        evidence: 'positive_only',
        checkedAt: 1000,
      });
      assert.equal(recorded.kind, 'committed');
      const activated = await stores.operations.setCredentialRoutingMode({
        expected: { connectionId: connection.connectionId, revision: snapshot.revision },
        mode: 'balanced',
      });
      assert.equal(activated.kind, 'committed');
    });
  });

  test('profile test success writes verification and readiness exposes the evidence', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('profile-test', 'openai', 'Profile test'),
      );
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;

      // Newly created profiles are disabled. A disabled profile can be tested
      // once its credential is configured (RFC 11.1: verify first, enable
      // later), but without a credential it is refused.
      const unconfigured = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        'gpt-5',
      );
      assert.equal(unconfigured.kind, 'credential_not_configured');

      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: connection.connectionId,
          profileId: secondary.profileId,
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
      });

      // Still disabled: a test now succeeds and writes verification evidence
      // without changing the enabled state.
      const prepared = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        'gpt-5',
      );
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') return;
      const checkedAt = '2024-06-01T00:00:00.000Z';
      const completed = await stores.operations.completeConnectionProfileTest(prepared.ticket, {
        summary: { status: 'verified', checkedAt },
        modelId: 'gpt-5',
      });
      assert.deepEqual(completed, { kind: 'committed', verification: 'recorded' });
      const stillDisabled = await stores.connectionCatalog.getSnapshot();
      assert.equal(
        stillDisabled.connections
          .find((item) => item.connectionId === connection.connectionId)!
          .credentialRouting!.profiles.find(
            (profile) => profile.profileId === secondary.profileId,
          )!.enabled,
        false,
      );

      const enabled = await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: created.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        enabled: true,
      });
      assert.equal(enabled.kind, 'committed');
      if (enabled.kind !== 'committed') return;

      const preparedAgain = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        'gpt-5',
      );
      assert.equal(preparedAgain.kind, 'ready');
      if (preparedAgain.kind !== 'ready') return;
      await stores.operations.completeConnectionProfileTest(preparedAgain.ticket, {
        summary: { status: 'verified', checkedAt },
        modelId: 'gpt-5',
      });

      const readiness = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(readiness.kind, 'found');
      if (readiness.kind !== 'found') return;
      const secondaryReadiness = readiness.profiles.find(
        (profile) => profile.profileId === secondary.profileId,
      );
      assert.ok(secondaryReadiness);
      assert.equal(secondaryReadiness?.primary, false);
      assert.equal(secondaryReadiness?.enabled, true);
      assert.equal(secondaryReadiness?.credentialConfigured, true);
      assert.deepEqual(secondaryReadiness?.supportedModels, ['gpt-5']);
      assert.deepEqual(secondaryReadiness?.lastTest, {
        status: 'verified',
        checkedAt,
      });
      const primaryReadiness = readiness.profiles.find(
        (profile) => profile.profileId === connection.connectionId,
      );
      assert.deepEqual(primaryReadiness?.supportedModels, []);
      assert.equal(readiness.readyCandidateCount, 0);
    });
  });

  test('profile test failure never writes verification and reports not_recorded', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('profile-test-fail', 'openai', 'Profile test fail'),
      );
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
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
        secret: '[redacted]',
      });
      await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: created.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        enabled: true,
      });
      const prepared = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        null,
      );
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') return;
      const failed = await stores.operations.completeConnectionProfileTest(prepared.ticket, {
        summary: {
          status: 'error',
          checkedAt: '2024-06-01T00:00:00.000Z',
          errorClass: 'provider_unavailable',
        },
        modelId: null,
      });
      assert.deepEqual(failed, { kind: 'committed', verification: 'not_recorded' });

      const readiness = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(readiness.kind, 'found');
      if (readiness.kind !== 'found') return;
      const secondaryReadiness = readiness.profiles.find(
        (profile) => profile.profileId === secondary.profileId,
      );
      assert.deepEqual(secondaryReadiness?.supportedModels, []);
      assert.equal(secondaryReadiness?.lastTest, null);
    });
  });

  test('profile test completion is superseded when profile or credential basis changed', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('profile-stale', 'openai', 'Profile stale'),
      );
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;
      const locator = {
        scope: 'connection_profile',
        connectionId: connection.connectionId,
        profileId: secondary.profileId,
        kind: 'api_key',
      } as const;
      await stores.credentialVault.set({ locator, expected: null, secret: '[redacted]' });
      const enabled = await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: created.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        enabled: true,
      });
      assert.equal(enabled.kind, 'committed');
      if (enabled.kind !== 'committed') return;
      const enabledRevision = enabled.snapshot.revision;

      // A profile revision bump (label edit) after begin must supersede.
      const prepared = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        'gpt-5',
      );
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') return;
      const edited = await stores.operations.updateCredentialProfile({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: enabledRevision,
          profileId: secondary.profileId,
          profileRevision: enabled.snapshot.connections
            .find((item) => item.connectionId === connection.connectionId)!
            .credentialRouting!.profiles.find(
              (profile) => profile.profileId === secondary.profileId,
            )!.revision,
        },
        label: 'renamed',
      });
      assert.equal(edited.kind, 'committed');
      const staleProfile = await stores.operations.completeConnectionProfileTest(prepared.ticket, {
        summary: { status: 'verified', checkedAt: '2024-06-01T00:00:00.000Z' },
        modelId: 'gpt-5',
      });
      assert.deepEqual(staleProfile, { kind: 'superseded', changed: ['connection'] });

      // A credential replacement after begin must supersede (credential domain).
      const second = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        'gpt-5',
      );
      assert.equal(second.kind, 'ready');
      if (second.kind !== 'ready') return;
      const status = await stores.credentialVault.getStatus(locator);
      assert.equal(status.kind, 'status');
      if (status.kind !== 'status') return;
      await stores.credentialVault.set({
        locator,
        expected: { credentialId: status.status.credentialId!, revision: status.status.revision! },
        secret: '[redacted-rotated]',
      });
      const staleCredential = await stores.operations.completeConnectionProfileTest(
        second.ticket,
        {
          summary: { status: 'verified', checkedAt: '2024-06-01T00:00:00.000Z' },
          modelId: 'gpt-5',
        },
      );
      assert.deepEqual(staleCredential, { kind: 'superseded', changed: ['credential'] });
    });
  });

  test('profile test preparation rejects unknown, disabled and unconfigured profiles', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('profile-reject', 'openai', 'Profile reject'),
      );
      const ghost = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        '00000000-0000-4000-8000-000000000099',
        'gpt-5',
      );
      assert.equal(ghost.kind, 'profile_not_found');

      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;
      // Default: disabled and unconfigured -> refused for the missing
      // credential; the disabled state alone never blocks a test.
      const unconfigured = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        'gpt-5',
      );
      assert.equal(unconfigured.kind, 'credential_not_configured');

      await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: connection.connectionId,
          profileId: secondary.profileId,
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
      });
      await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: created.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        enabled: true,
      });
      const ghostConnection = await stores.operations.beginConnectionProfileTest(
        '00000000-0000-4000-8000-000000000077',
        '00000000-0000-4000-8000-000000000077',
        'gpt-5',
      );
      assert.equal(ghostConnection.kind, 'connection_not_found');

      // A non-canonical test model is a codec rejection.
      await assert.rejects(
        () =>
          stores.operations.beginConnectionProfileTest(
            connection.connectionId,
            secondary.profileId,
            'injected-model',
          ),
        isStoreError('invalid_connection_input'),
      );
    });
  });

  test('profile model fetch upserts the enabled intersection and merges catalog metadata without deletion', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('profile-fetch', 'openai', 'Profile fetch'),
      );
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
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
        secret: '[redacted]',
      });
      await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: created.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        enabled: true,
      });
      const seeded = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(seeded.kind, 'ready');
      if (seeded.kind !== 'ready') return;
      await stores.operations.completeModelFetch(seeded.ticket, {
        models: [{ id: 'gpt-5' }],
        source: 'fetched',
        fetchedAt: 1000,
      });
      const prepared = await stores.operations.beginConnectionProfileModelFetch(
        connection.connectionId,
        secondary.profileId,
      );
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') return;
      // gpt-5 is enabled and present; gpt-6 is new metadata; claude-x is
      // neither enabled nor inventoried — it must not create evidence and the
      // missing enabled model must not drive any deletion.
      const completed = await stores.operations.completeConnectionProfileModelFetch(
        prepared.ticket,
        {
          models: [{ id: 'gpt-5' }, { id: 'gpt-6' }, { id: 'claude-x' }],
          source: 'fetched',
          fetchedAt: 2000,
        },
        'positive_only',
      );
      assert.equal(completed.kind, 'committed');
      if (completed.kind !== 'committed') return;
      assert.equal(completed.verification, 'recorded');

      const readiness = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(readiness.kind, 'found');
      if (readiness.kind !== 'found') return;
      const secondaryReadiness = readiness.profiles.find(
        (profile) => profile.profileId === secondary.profileId,
      );
      assert.deepEqual(secondaryReadiness?.supportedModels, ['gpt-5']);

      // Catalog merge appended only the new metadata; enabled models and the
      // primary's inventory were untouched.
      const snapshot = await stores.connectionCatalog.getSnapshot();
      const current = snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!;
      assert.deepEqual(
        current.models.map((model) => model.id),
        ['gpt-5', 'gpt-6', 'claude-x'],
      );
      assert.deepEqual(current.enabledModelIds, ['gpt-5']);
    });
  });

  test('authoritative profile discovery replaces the basis set for dropped models', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        {
          ...connectionDraft('profile-auth', 'openai', 'Profile auth'),
          enabledModelIds: ['gpt-5', 'gpt-6'],
        },
      );
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
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
        secret: '[redacted]',
      });
      await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: created.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        enabled: true,
      });
      const seeded = await stores.operations.beginModelFetch(connection.connectionId);
      assert.equal(seeded.kind, 'ready');
      if (seeded.kind !== 'ready') return;
      await stores.operations.completeModelFetch(seeded.ticket, {
        models: [{ id: 'gpt-5' }, { id: 'gpt-6' }],
        source: 'fetched',
        fetchedAt: 1000,
      });
      const first = await stores.operations.beginConnectionProfileModelFetch(
        connection.connectionId,
        secondary.profileId,
      );
      assert.equal(first.kind, 'ready');
      if (first.kind !== 'ready') return;
      await stores.operations.completeConnectionProfileModelFetch(
        first.ticket,
        { models: [{ id: 'gpt-5' }, { id: 'gpt-6' }], source: 'fetched', fetchedAt: 2000 },
        'authoritative',
      );
      const second = await stores.operations.beginConnectionProfileModelFetch(
        connection.connectionId,
        secondary.profileId,
      );
      assert.equal(second.kind, 'ready');
      if (second.kind !== 'ready') return;
      await stores.operations.completeConnectionProfileModelFetch(
        second.ticket,
        { models: [{ id: 'gpt-5' }], source: 'fetched', fetchedAt: 3000 },
        'authoritative',
      );
      const readiness = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(readiness.kind, 'found');
      if (readiness.kind !== 'found') return;
      const secondaryReadiness = readiness.profiles.find(
        (profile) => profile.profileId === secondary.profileId,
      );
      assert.deepEqual(secondaryReadiness?.supportedModels, ['gpt-5']);
    });
  });

  test('readiness projects routing mode, circuits and ready candidate counts', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('readiness', 'openai', 'Readiness'),
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
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      await stores.credentialVault.set({
        locator: {
          scope: 'connection_profile',
          connectionId: connection.connectionId,
          profileId: secondary.profileId,
          kind: 'api_key',
        },
        expected: null,
        secret: '[redacted]',
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
      routing = snapshot.connections.find((item) => item.connectionId === connection.connectionId)!
        .credentialRouting!;
      for (const profile of routing.profiles) {
        await stores.operations.recordCredentialProfileVerification({
          connectionId: connection.connectionId,
          connectionRevision: snapshot.revision,
          profileId: profile.profileId,
          profileRevision: profile.revision,
          modelId: 'gpt-5',
          status: 'supported',
          source: 'tested',
          evidence: 'positive_only',
          checkedAt: 1000,
          testSummary: { status: 'verified', checkedAt: '2024-06-01T00:00:00.000Z' },
        });
      }
      const activated = await stores.operations.setCredentialRoutingMode({
        expected: { connectionId: connection.connectionId, revision: snapshot.revision },
        mode: 'balanced',
      });
      assert.equal(activated.kind, 'committed');

      const readiness = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(readiness.kind, 'found');
      if (readiness.kind !== 'found') return;
      assert.equal(readiness.routingMode, 'balanced');
      assert.equal(readiness.connectionRevision, activated.snapshot.revision);
      assert.equal(readiness.readyCandidateCount, 1);
      assert.equal(readiness.profiles.length, 2);
      for (const profile of readiness.profiles) {
        assert.equal(profile.credentialConfigured, true);
        assert.deepEqual(profile.supportedModels, ['gpt-5']);
        assert.equal(profile.circuit, null);
        assert.equal(profile.lastTest?.status, 'verified');
      }
      const primary = readiness.profiles.find((profile) => profile.primary);
      assert.ok(primary);
      assert.equal(primary.profileId, connection.connectionId);
    });
  });

  test('profile test completion must match the ticket model basis', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        {
          ...connectionDraft('profile-forge', 'openai', 'Profile forge'),
          enabledModelIds: ['gpt-5', 'gpt-6'],
        },
      );
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
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
        secret: '[redacted]',
      });

      // A ticket pinned to gpt-5 must not accept evidence for gpt-6.
      const prepared = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        'gpt-5',
      );
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') return;
      const forged = await stores.operations.completeConnectionProfileTest(prepared.ticket, {
        summary: { status: 'verified', checkedAt: '2024-06-01T00:00:00.000Z' },
        modelId: 'gpt-6',
      });
      assert.equal(forged.kind, 'invalid_request');
      const readiness = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(readiness.kind, 'found');
      if (readiness.kind !== 'found') return;
      const secondaryReadiness = readiness.profiles.find(
        (profile) => profile.profileId === secondary.profileId,
      );
      assert.deepEqual(secondaryReadiness?.supportedModels, []);

      // A default-model ticket still must not accept a non-canonical model.
      const defaultTicket = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        null,
      );
      assert.equal(defaultTicket.kind, 'ready');
      if (defaultTicket.kind !== 'ready') return;
      const nonCanonical = await stores.operations.completeConnectionProfileTest(
        defaultTicket.ticket,
        {
          summary: { status: 'verified', checkedAt: '2024-06-01T00:00:00.000Z' },
          modelId: 'injected-model',
        },
      );
      assert.equal(nonCanonical.kind, 'invalid_request');
    });
  });

  test('authoritative discovery revokes evidence across digest groups and empty intersections', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        {
          ...connectionDraft('profile-auth2', 'openai', 'Profile auth2'),
          enabledModelIds: ['gpt-5', 'gpt-6'],
        },
      );
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
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
        secret: '[redacted]',
      });
      const first = await stores.operations.beginConnectionProfileModelFetch(
        connection.connectionId,
        secondary.profileId,
      );
      assert.equal(first.kind, 'ready');
      if (first.kind !== 'ready') return;
      await stores.operations.completeConnectionProfileModelFetch(
        first.ticket,
        { models: [{ id: 'gpt-5' }, { id: 'gpt-6' }], source: 'fetched', fetchedAt: 2000 },
        'authoritative',
      );

      // An authoritative discovery whose intersection with the enabled set is
      // EMPTY must still clear the previous evidence, not keep it alive.
      const empty = await stores.operations.beginConnectionProfileModelFetch(
        connection.connectionId,
        secondary.profileId,
      );
      assert.equal(empty.kind, 'ready');
      if (empty.kind !== 'ready') return;
      await stores.operations.completeConnectionProfileModelFetch(
        empty.ticket,
        { models: [{ id: 'gpt-7' }], source: 'fetched', fetchedAt: 3000 },
        'authoritative',
      );
      const cleared = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(cleared.kind, 'found');
      if (cleared.kind !== 'found') return;
      const clearedSecondary = cleared.profiles.find(
        (profile) => profile.profileId === secondary.profileId,
      );
      assert.deepEqual(clearedSecondary?.supportedModels, []);
    });
  });

  test('readiness matches the current execution digest and surfaces global circuits', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('profile-digest', 'openai', 'Profile digest'),
      );
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      const secondary = routing.profiles.find(
        (profile) => profile.profileId !== connection.connectionId,
      )!;
      const locator = {
        scope: 'connection_profile',
        connectionId: connection.connectionId,
        profileId: secondary.profileId,
        kind: 'api_key',
      } as const;
      await stores.credentialVault.set({ locator, expected: null, secret: '[redacted]' });
      await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: created.snapshot.revision,
          profileId: secondary.profileId,
          profileRevision: secondary.revision,
        },
        enabled: true,
      });
      const prepared = await stores.operations.beginConnectionProfileTest(
        connection.connectionId,
        secondary.profileId,
        'gpt-5',
      );
      assert.equal(prepared.kind, 'ready');
      if (prepared.kind !== 'ready') return;
      await stores.operations.completeConnectionProfileTest(prepared.ticket, {
        summary: { status: 'verified', checkedAt: '2024-06-01T00:00:00.000Z' },
        modelId: 'gpt-5',
      });
      const ready = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(ready.kind, 'found');
      if (ready.kind !== 'found') return;
      assert.deepEqual(
        ready.profiles.find((profile) => profile.profileId === secondary.profileId)
          ?.supportedModels,
        ['gpt-5'],
      );

      // Changing the request-body overlay changes the execution basis digest:
      // the old supported evidence no longer matches and must disappear from
      // readiness, exactly as the Router would refuse to dispatch on it.
      await stores.operations.replaceConnectionRequestHeaders(
        connection.connectionId,
        [{ name: 'X-Tenant', value: 'tenant-b' }],
      );
      const stale = await stores.operations.readCredentialProfileReadiness(
        connection.connectionId,
      );
      assert.equal(stale.kind, 'found');
      if (stale.kind !== 'found') return;
      assert.deepEqual(
        stale.profiles.find((profile) => profile.profileId === secondary.profileId)
          ?.supportedModels,
        [],
      );
      assert.equal(stale.readyCandidateCount, 0);
    });
  });

  test('legacy_primary execution resolve fails closed on an explicitly disabled primary', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('legacy-primary-off', 'openai', 'Legacy primary off'),
      );
      await stores.credentialVault.set({
        locator: connectionCredential(connection, 'api_key'),
        expected: null,
        secret: '[redacted]',
      });
      const created = await stores.operations.createCredentialProfile({
        expected: connectionBasis(connection),
        label: 'backup',
        weight: 1,
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const routing = created.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
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
        secret: '[redacted]',
      });

      // Enabled primary resolves normally through the legacy path.
      const ready = await stores.operations.resolveExecutionConnection(connection.slug);
      assert.equal(ready.kind, 'ready');

      // Explicitly disable the primary: the legacy fast path must fail closed
      // instead of dispatching the primary or silently using the secondary.
      const snapshot = await stores.connectionCatalog.getSnapshot();
      const current = snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!;
      const disabled = await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: current.revision,
          profileId: connection.connectionId,
          profileRevision: current.credentialRouting!.profiles.find(
            (profile) => profile.profileId === connection.connectionId,
          )!.revision,
        },
        enabled: false,
      });
      assert.equal(disabled.kind, 'committed');
      assert.deepEqual(await stores.operations.resolveExecutionConnection(connection.slug), {
        kind: 'profile_disabled',
      });
    });
  });

  test('materialize primary routing is idempotent and auth-aware', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('materialize', 'openai', 'Materialize'),
      );
      // Implicit primary: no routing declaration yet.
      const before = await stores.connectionCatalog.getSnapshot();
      assert.equal(
        before.connections.find((item) => item.connectionId === connection.connectionId)
          ?.credentialRouting,
        undefined,
      );

      // First materialization creates the explicit primary routing.
      const materialized = await stores.operations.materializePrimaryCredentialProfile(
        connection.connectionId,
      );
      assert.equal(materialized.kind, 'committed');
      const routing = materialized.snapshot.connections.find(
        (item) => item.connectionId === connection.connectionId,
      )!.credentialRouting!;
      assert.equal(routing.mode, 'legacy_primary');
      assert.equal(routing.profiles.length, 1);
      assert.equal(routing.profiles[0]?.profileId, connection.connectionId);
      assert.equal(routing.profiles[0]?.enabled, true);

      // Second materialization is idempotent: same revision, no new writes.
      const again = await stores.operations.materializePrimaryCredentialProfile(
        connection.connectionId,
      );
      assert.equal(again.kind, 'committed');
      assert.equal(again.snapshot.revision, materialized.snapshot.revision);

      // The materialized primary is a real profile: it can be disabled and
      // tested through the normal authority paths.
      const disabled = await stores.operations.setCredentialProfileEnabled({
        expected: {
          connectionId: connection.connectionId,
          connectionRevision: materialized.snapshot.revision,
          profileId: connection.connectionId,
          profileRevision: routing.profiles[0]!.revision,
        },
        enabled: false,
      });
      assert.equal(disabled.kind, 'committed');
      assert.deepEqual(await stores.operations.resolveExecutionConnection(connection.slug), {
        kind: 'profile_disabled',
      });

      // Auth-less providers cannot materialize a profile routing.
      const noneCatalog = await stores.connectionCatalog.getSnapshot();
      const none = await createConnection(
        stores,
        noneCatalog.revision,
        connectionDraft('materialize-none', 'ollama', 'Materialize none'),
      );
      const rejected = await stores.operations.materializePrimaryCredentialProfile(
        none.connectionId,
      );
      assert.equal(rejected.kind, 'auth_not_supported');
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
  kind: 'api_key' | 'oauth_token' | 'request_headers',
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
