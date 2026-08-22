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
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  test('upgrades schema v2 with the automatic Host shell default', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const { shell: _shell, ...policyV2 } = createDefaultRuntimePolicy();
      await writeFile(
        join(root, 'runtime-policy.json'),
        `${JSON.stringify({ schemaVersion: 2, revision: 4, policy: policyV2 })}\n`,
      );

      const snapshot = await stores.runtimePolicy.getSnapshot();
      assert.equal(snapshot.revision, 4);
      assert.deepEqual(snapshot.policy.shell, { preference: 'auto', executable: '' });
      const committed = await stores.runtimePolicy.mutate({
        expectedRevision: 4,
        operation: { kind: 'set_shell', value: snapshot.policy.shell },
      });
      assert.equal(committed.kind, 'committed');
      const persisted = JSON.parse(await readFile(join(root, 'runtime-policy.json'), 'utf8')) as {
        schemaVersion: number;
      };
      assert.equal(persisted.schemaVersion, 3);
    });
  });

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
      // Left exactly as the user set it. A refresh migrates only ids it can
      // prove were renamed, and a relay supplies no rename table — so neither
      // `claude-opus-5` nor `claude-haiku-4-5` may replace this one.
      assert.deepEqual(discovered.snapshot.connections[0]?.enabledModelIds, [
        'claude-haiku-4-5-20251001',
      ]);
    });
  });

  test('a model refresh keeps the selection, and an explicit change prunes it', async () => {
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

      // The /models refresh no longer lists model-a. One response is not
      // grounds for deleting a model the user picked (#1584), so the selection
      // and its declaration both stand — and the subset invariant holds
      // because neither side moved.
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
      assert.deepEqual(after?.enabledModelIds, ['model-a', 'model-b']);
      assert.deepEqual(after?.relayModelProfiles, {
        'model-a': { vision: true },
        'model-b': { contextWindow: 64_000 },
      });

      // Unchecking model-a IS a decision, and the update path prunes its
      // declaration with it. The document must also survive a canonical
      // reload: the next mutation re-decodes persisted state, and a stranding
      // here would have raised invalid_document instead of committing.
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

  test('migrates a persisted Gemini CLI default to the remaining supported catalog', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const retiredConnectionId = '11111111-1111-4111-8111-111111111111';
      const googleConnectionId = '22222222-2222-4222-8222-222222222222';
      await writeFile(
        join(root, 'connection-catalog.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          revision: 2,
          defaultTarget: {
            connectionId: retiredConnectionId,
            modelId: 'gemini-2.5-pro',
          },
          connections: [
            {
              connectionId: retiredConnectionId,
              revision: 1,
              slug: 'gemini-account',
              name: 'Gemini account',
              providerType: 'gemini-cli',
              enabled: true,
              enabledModelIds: ['gemini-2.5-pro'],
              models: [],
            },
            {
              connectionId: googleConnectionId,
              revision: 1,
              slug: 'google-api',
              name: 'Google API',
              providerType: 'google',
              enabled: true,
              enabledModelIds: ['gemini-2.5-pro'],
              models: [],
            },
          ],
        })}\n`,
        'utf8',
      );

      const snapshot = await stores.connectionCatalog.getSnapshot();

      assert.equal(snapshot.revision, 2);
      assert.equal(snapshot.defaultTarget, null);
      assert.deepEqual(
        snapshot.connections.map(({ connectionId, providerType }) => ({
          connectionId,
          providerType,
        })),
        [{ connectionId: googleConnectionId, providerType: 'google' }],
      );
      const persisted = JSON.parse(
        await readFile(join(root, 'connection-catalog.json'), 'utf8'),
      ) as {
        connections: Array<{ providerType: string }>;
      };
      assert.deepEqual(
        persisted.connections.map(({ providerType }) => providerType),
        ['gemini-cli', 'google'],
      );
    });
  });

  /**
   * A connection that predates its provider's retirement. `create` refuses to
   * author one now, which is the point — such rows can only arrive by having
   * been written before retirement, so tests reproduce them the same way:
   * appended to the persisted catalog rather than through the mutation API.
   */
  async function seedRetiredConnection(
    root: string,
    stores: Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>,
    slug: string,
    connectionId: string,
    // A retired row that was tested before its provider was retired is the
    // case global invalidation reaches, so seeding one is how that path gets
    // exercised at all.
    lastTest?: { status: 'verified'; checkedAt: string },
  ): Promise<ConnectionCatalogEntry> {
    const path = join(root, 'connection-catalog.json');
    const document = existsSync(path)
      ? (JSON.parse(await readFile(path, 'utf8')) as {
          revision: number;
          connections: Record<string, unknown>[];
        })
      : {
          schemaVersion: 1,
          revision: 0,
          defaultTarget: null,
          connections: [] as Record<string, unknown>[],
        };
    document.revision += 1;
    document.connections.push({
      connectionId,
      revision: 1,
      slug,
      name: slug,
      providerType: 'claude-subscription',
      enabled: true,
      enabledModelIds: ['claude-opus-5'],
      models: [],
      ...(lastTest ? { lastTest } : {}),
    });
    await writeFile(path, `${JSON.stringify(document)}\n`, 'utf8');
    const snapshot = await stores.connectionCatalog.getSnapshot();
    const seeded = snapshot.connections.find(
      (item: ConnectionCatalogEntry) => item.connectionId === connectionId,
    );
    assert.ok(seeded, `${slug} was not readable after seeding`);
    return seeded;
  }

  test('refuses to author or default to a retired provider', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      // Decode and delete are the only paths a retired provider may still take.
      // Authoring one would create a row that can never execute, and committing
      // it as the default would succeed only for the next read to rewrite it to
      // null — which reads to the caller as a lost write, not a refusal.
      await assert.rejects(
        () =>
          stores.connectionCatalog.create({
            expectedCatalogRevision: 0,
            connection: connectionDraft('new-claude', 'claude-subscription', 'New Claude'),
          }),
        isStoreError('invalid_connection_input'),
      );

      const kept = await seedRetiredConnection(
        root,
        stores,
        'kept-claude',
        '55555555-5555-4555-8555-555555555555',
      );
      const snapshot = await stores.connectionCatalog.getSnapshot();
      const target = { connectionId: kept.connectionId, modelId: 'claude-opus-5' };
      assert.deepEqual(
        await stores.connectionCatalog.setDefaultTarget({
          expectedCatalogRevision: snapshot.revision,
          target,
        }),
        { kind: 'invalid_default_target', target },
      );
    });
  });

  test('an OAuth refresh cannot rotate a retained retired credential', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      // The credential this retirement deliberately keeps was written before
      // the provider was retired, so it is seeded the same way the row is.
      // `compareAndSetOAuthCredential` validated only the auth kind, which a
      // retired provider still declares — so a refresh committed and advanced
      // the credential revision. No production caller reaches it today, since
      // execution resolution refuses first; that is precisely why it would
      // have stayed open.
      const retired = await seedRetiredConnection(
        root,
        stores,
        'refresh-claude',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      const locator = {
        scope: 'connection' as const,
        connectionId: retired.connectionId,
        kind: 'oauth_token' as const,
      };
      const vaultPath = join(root, 'credential-vault.json');
      await writeFile(
        vaultPath,
        `${JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          entries: [
            {
              locator,
              credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              revision: 1,
              secret: JSON.stringify({
                access_token: 'legacy',
                expires_at: Number.MAX_SAFE_INTEGER,
              }),
              updatedAt: 1,
            },
          ],
        })}\n`,
        'utf8',
      );
      const seeded = await getCredentialStatus(stores.credentialVault, locator);
      assert.equal(credentialBasis(seeded).revision, 1);

      await assert.rejects(
        () =>
          stores.operations.compareAndSetOAuthCredential({
            locator,
            expected: credentialExpectation(seeded),
            secret: JSON.stringify({
              access_token: 'rotated',
              expires_at: Number.MAX_SAFE_INTEGER,
            }),
          }),
        isStoreError('invalid_connection_input'),
      );

      // The credential is unchanged, which is what keeps it deletable as the
      // thing the user came to remove rather than something Maka rewrote.
      const after = await getCredentialStatus(stores.credentialVault, locator);
      assert.equal(credentialBasis(after).revision, 1);
    });
  });

  test('deleting a retained retired credential leaves its row byte-stable', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      // Deleting the credential is the one write a tombstone must still accept
      // — it is how a user removes the retained token. The deletion itself was
      // never the problem: it invalidated the row's verification on the way
      // out, bumping the revision of a row nothing may rewrite. The global
      // sweep was taught to skip retired rows; this single-connection path is
      // the same invariant reached one connection at a time.
      const retired = await seedRetiredConnection(
        root,
        stores,
        'delete-claude',
        '88888888-8888-4888-8888-888888888888',
        { status: 'verified', checkedAt: '2026-08-01T00:00:00.000Z' },
      );
      assert.ok(retired.lastTest, 'the seeded retired row must carry a verification');

      // Seeded the same way the row is: a retired connection's credential
      // cannot be written through the API that now refuses it.
      const locator = {
        scope: 'connection' as const,
        connectionId: retired.connectionId,
        kind: 'oauth_token' as const,
      };
      await writeFile(
        join(root, 'credential-vault.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          revision: 1,
          entries: [
            {
              locator,
              credentialId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              revision: 1,
              secret: JSON.stringify({
                access_token: 'legacy',
                expires_at: Number.MAX_SAFE_INTEGER,
              }),
              updatedAt: 1,
            },
          ],
        })}\n`,
        'utf8',
      );
      const seeded = await getCredentialStatus(stores.credentialVault, locator);
      assert.equal(credentialBasis(seeded).revision, 1);

      const deleted = await stores.credentialVault.delete({
        expected: credentialBasis(seeded),
      });
      assert.equal(deleted.kind, 'committed');

      const after = await stores.connectionCatalog.getSnapshot();
      const row = after.connections.find((item) => item.slug === 'delete-claude');
      // The credential is gone and the row is exactly as it was — same
      // revision, same verification. A concurrent deletion of the row itself
      // must not have been made stale by removing its credential.
      assert.equal(row?.revision, retired.revision);
      assert.deepEqual(row?.lastTest, retired.lastTest);

      // Control: the same deletion against a live connection must still
      // invalidate it. Without this the test would pass just as well if the
      // guard stopped every invalidation rather than only the retired one.
      const live = await createConnection(
        stores,
        after.revision,
        connectionDraft('delete-live', 'openai', 'Delete Live'),
      );
      const liveLocator = connectionCredential(live, 'api_key');
      await stores.credentialVault.set({
        locator: liveLocator,
        expected: null,
        secret: 'live-key',
      });
      const ticket = await stores.operations.beginConnectionTest(live.connectionId, 'gpt-5');
      assert.equal(ticket.kind, 'ready');
      if (ticket.kind !== 'ready') return;
      await stores.operations.completeConnectionTest(ticket.ticket, {
        status: 'verified',
        checkedAt: '2026-08-03T00:00:00.000Z',
      });
      const liveBefore = (await stores.connectionCatalog.getSnapshot()).connections.find(
        (item) => item.slug === 'delete-live',
      );
      assert.ok(liveBefore?.lastTest, 'the live row must be verified before its credential goes');

      const liveStatus = await getCredentialStatus(stores.credentialVault, liveLocator);
      const liveDeleted = await stores.credentialVault.delete({
        expected: credentialBasis(liveStatus),
      });
      assert.equal(liveDeleted.kind, 'committed');

      const liveAfter = (await stores.connectionCatalog.getSnapshot()).connections.find(
        (item) => item.slug === 'delete-live',
      );
      assert.equal(liveAfter?.lastTest, undefined);
      assert.equal(liveAfter?.revision, liveBefore.revision + 1);
    });
  });

  test('a global proxy change leaves a retained retired row byte-stable', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      // Refusing direct writes was not enough: an indirect one reached the
      // tombstone. Editing the network proxy invalidates every tested
      // connection's verification, which bumped the retired row's revision
      // too — enough to make a deletion started elsewhere fail as stale, from
      // a global setting that has nothing to do with this connection. Its
      // `lastTest` describes a provider that can no longer be tested, so there
      // is nothing there to invalidate either.
      const live = await createConnection(
        stores,
        0,
        connectionDraft('proxy-live', 'openai', 'Proxy Live'),
      );
      const retired = await seedRetiredConnection(
        root,
        stores,
        'proxy-claude',
        '99999999-9999-4999-8999-999999999999',
        { status: 'verified', checkedAt: '2026-08-01T00:00:00.000Z' },
      );
      assert.ok(retired.lastTest, 'the seeded retired row must carry a verification to invalidate');

      await stores.credentialVault.set({
        locator: connectionCredential(live, 'api_key'),
        expected: null,
        secret: 'live-key',
      });
      const ticket = await stores.operations.beginConnectionTest(live.connectionId, 'gpt-5');
      assert.equal(ticket.kind, 'ready');
      if (ticket.kind !== 'ready') return;
      await stores.operations.completeConnectionTest(ticket.ticket, {
        status: 'verified',
        checkedAt: '2026-08-02T00:00:00.000Z',
      });
      const before = await stores.connectionCatalog.getSnapshot();
      const liveBefore = before.connections.find((item) => item.slug === 'proxy-live');
      assert.ok(liveBefore?.lastTest, 'the live row must be verified before the proxy change');

      const policy = await stores.runtimePolicy.getSnapshot();
      const proxied = await stores.runtimePolicy.mutate(
        networkProxyMutation(policy.revision, { host: 'proxy.example' }),
      );
      assert.equal(proxied.kind, 'committed');

      const after = await stores.connectionCatalog.getSnapshot();
      const retiredAfter = after.connections.find((item) => item.slug === 'proxy-claude');
      const liveAfter = after.connections.find((item) => item.slug === 'proxy-live');
      // The live row is invalidated — without this the test would pass by the
      // invalidation doing nothing at all.
      assert.equal(liveAfter?.lastTest, undefined);
      assert.equal(liveAfter?.revision, (liveBefore?.revision ?? 0) + 1);
      // The tombstone is untouched, revision included.
      assert.deepEqual(retiredAfter?.lastTest, retired.lastTest);
      assert.equal(retiredAfter?.revision, retired.revision);
    });
  });

  test('refuses every connection-owned write against a retained retired row', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      // The catalog update guard alone did not establish the tombstone: the
      // credential vault and the request-header replacement are sibling writes
      // that reach the same connection, and both committed against a retired
      // row until they shared one refusal. Each is exercised here because each
      // is separately reachable from a remote client.
      const kept = await seedRetiredConnection(
        root,
        stores,
        'sealed-claude',
        '77777777-7777-4777-8777-777777777777',
      );

      await assert.rejects(
        () =>
          stores.operations.replaceConnectionRequestHeaders(kept.connectionId, [
            { name: 'X-Tenant', value: 'tenant-a' },
          ]),
        isStoreError('invalid_connection_input'),
      );

      await assert.rejects(
        () =>
          stores.credentialVault.set({
            locator: {
              scope: 'connection',
              connectionId: kept.connectionId,
              kind: 'request_headers',
            },
            expected: null,
            secret: JSON.stringify({ 'X-Tenant': 'tenant-a' }),
          }),
        isStoreError('invalid_connection_input'),
      );

      await assert.rejects(
        () =>
          stores.credentialVault.set({
            locator: { scope: 'connection', connectionId: kept.connectionId, kind: 'oauth_token' },
            expected: null,
            secret: 'refreshed-token',
          }),
        isStoreError('invalid_connection_input'),
      );

      // Reading and deleting stay open — that is the whole point of retaining
      // the row, and a refusal that strands the credential would be worse than
      // the writes it prevents.
      const snapshot = await stores.connectionCatalog.getSnapshot();
      const still = snapshot.connections.find((item) => item.slug === 'sealed-claude');
      assert.ok(still, 'refused writes must leave the row readable');
      assert.equal(
        (
          await stores.connectionCatalog.remove({
            expected: { connectionId: kept.connectionId, revision: still.revision },
          })
        ).kind,
        'committed',
      );
    });
  });

  test('refuses to edit a retained retired connection back toward usable', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      // The row is kept so its credential stays visible and deletable, and
      // create and set-default already refuse. Update was the way back in: a
      // retired connection could be re-enabled and become a default candidate
      // again, at which point every downstream refusal is the only thing left
      // between it and a Session. Read and delete remain the exceptions.
      const kept = await seedRetiredConnection(
        root,
        stores,
        'editable-claude',
        '66666666-6666-4666-8666-666666666666',
      );

      await assert.rejects(
        () =>
          stores.connectionCatalog.update({
            expected: { connectionId: kept.connectionId, revision: kept.revision },
            changes: {
              name: kept.name,
              enabled: true,
              enabledModelIds: [...kept.enabledModelIds],
            },
          }),
        isStoreError('invalid_connection_input'),
      );

      // Still readable and still deletable afterwards — refusing the edit must
      // not strand the credential this retirement deliberately retains.
      const snapshot = await stores.connectionCatalog.getSnapshot();
      const still = snapshot.connections.find((item) => item.slug === 'editable-claude');
      assert.ok(still, 'a refused edit must leave the row readable');
      assert.equal(
        (
          await stores.connectionCatalog.remove({
            expected: { connectionId: kept.connectionId, revision: still.revision },
          })
        ).kind,
        'committed',
      );
    });
  });

  test('releases a default target that points at a retained retired connection', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const retiredConnectionId = '33333333-3333-4333-8333-333333333333';
      const openaiConnectionId = '44444444-4444-4444-8444-444444444444';
      await writeFile(
        join(root, 'connection-catalog.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          revision: 2,
          defaultTarget: { connectionId: retiredConnectionId, modelId: 'claude-opus-5' },
          connections: [
            {
              connectionId: retiredConnectionId,
              revision: 1,
              slug: 'claude-subscription',
              name: 'Claude Subscription',
              providerType: 'claude-subscription',
              enabled: true,
              enabledModelIds: ['claude-opus-5'],
              models: [],
            },
            {
              connectionId: openaiConnectionId,
              revision: 1,
              slug: 'openai',
              name: 'OpenAI',
              providerType: 'openai',
              enabled: true,
              enabledModelIds: ['gpt-4.1'],
              models: [],
            },
          ],
        })}\n`,
        'utf8',
      );

      const snapshot = await stores.connectionCatalog.getSnapshot();

      // The connection stays — the user needs it visible to delete it and
      // clear the credential — but it stops being what new Sessions default to.
      assert.equal(snapshot.defaultTarget, null);
      assert.deepEqual(
        snapshot.connections.map(({ connectionId, providerType }) => ({
          connectionId,
          providerType,
        })),
        [
          { connectionId: retiredConnectionId, providerType: 'claude-subscription' },
          { connectionId: openaiConnectionId, providerType: 'openai' },
        ],
      );
    });
  });

  test('rejects a retired Gemini CLI record that collides with a maintained connection identity', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const duplicateConnectionId = '11111111-1111-4111-8111-111111111111';
      await writeFile(
        join(root, 'connection-catalog.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          revision: 2,
          defaultTarget: null,
          connections: [
            {
              connectionId: duplicateConnectionId,
              revision: 1,
              slug: 'gemini-account',
              name: 'Gemini account',
              providerType: 'gemini-cli',
              enabled: true,
              enabledModelIds: ['gemini-2.5-pro'],
              models: [],
            },
            {
              connectionId: duplicateConnectionId,
              revision: 1,
              slug: 'google-api',
              name: 'Google API',
              providerType: 'google',
              enabled: true,
              enabledModelIds: ['gemini-2.5-pro'],
              models: [],
            },
          ],
        })}\n`,
        'utf8',
      );

      await assert.rejects(
        () => stores.connectionCatalog.getSnapshot(),
        isStoreError('invalid_document'),
      );
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
    await withInteractiveOwner(async ({ root, stores }) => {
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

      // A connection stored before its provider was retired keeps its
      // credential, so every readiness signal below `provider_retired` is
      // satisfied and the resolver used to answer `ready` — which is what let a
      // Session be committed against it.
      const retired = await seedRetiredConnection(
        root,
        stores,
        'execution-retired',
        '66666666-6666-4666-8666-666666666666',
      );
      const retiredLogin = await stores.operations.beginInteractiveOAuthLogin(retired.connectionId);
      assert.equal(retiredLogin.kind, 'provider_action_unavailable');
      assert.deepEqual(await stores.operations.resolveExecutionConnection(retired.slug), {
        kind: 'provider_retired',
      });

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
      // Discovery records what the provider reported; it does not re-decide what
      // the user enabled. `gpt-5` was chosen and stays chosen (#1584).
      assert.deepEqual(afterDiscovery.enabledModelIds, ['gpt-5']);
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

  test('keeps the canonical default target when discovery stops listing its model', async () => {
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
      // Silently pointing the workspace default at a different model is its own
      // surprise, and the response that omitted `gpt-5` is one observation of
      // an account it does not fully describe (#1584). The target stands; the
      // picker marks it, and switching stays the user's decision.
      const expected = { connectionId: connection.connectionId, modelId: 'gpt-5' };
      assert.deepEqual(completed.snapshot.defaultTarget, expected);
      assert.deepEqual((await stores.connectionCatalog.getSnapshot()).defaultTarget, expected);
    });
  });

  test('releases the canonical default target when a selection change removes its model', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('selection-default', 'ollama', 'Selection default'),
      );
      const widened = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes: {
          name: connection.name,
          enabled: true,
          enabledModelIds: ['gpt-5', 'llama3.3'],
          relayModelProfiles: null,
        },
      });
      assert.equal(widened.kind, 'committed');
      if (widened.kind !== 'committed') return;
      const widenedEntry = widened.snapshot.connections[0];
      assert.ok(widenedEntry);
      assert.equal(
        (
          await stores.connectionCatalog.setDefaultTarget({
            expectedCatalogRevision: widened.snapshot.revision,
            target: { connectionId: connection.connectionId, modelId: 'gpt-5' },
          })
        ).kind,
        'committed',
      );

      const narrowed = await stores.connectionCatalog.update({
        expected: connectionBasis(widenedEntry),
        changes: {
          name: connection.name,
          enabled: true,
          enabledModelIds: ['llama3.3'],
          relayModelProfiles: null,
        },
      });
      assert.equal(narrowed.kind, 'committed');
      if (narrowed.kind !== 'committed') return;
      // Not `llama3.3`: a surviving member of the set is not the user's answer.
      assert.equal(narrowed.snapshot.defaultTarget, null);
      assert.equal((await stores.connectionCatalog.getSnapshot()).defaultTarget, null);
    });
  });

  test('releases the canonical default target when its connection is disabled', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('default-disabled', 'ollama', 'Default disabled'),
      );
      const catalog = await stores.connectionCatalog.getSnapshot();
      assert.equal(
        (
          await stores.connectionCatalog.setDefaultTarget({
            expectedCatalogRevision: catalog.revision,
            target: { connectionId: connection.connectionId, modelId: 'gpt-5' },
          })
        ).kind,
        'committed',
      );

      const disabled = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes: {
          name: connection.name,
          enabled: false,
          enabledModelIds: connection.enabledModelIds,
          relayModelProfiles: null,
        },
      });
      assert.equal(disabled.kind, 'committed');
      if (disabled.kind !== 'committed') return;
      assert.equal(disabled.snapshot.defaultTarget, null);
      assert.equal((await stores.connectionCatalog.getSnapshot()).defaultTarget, null);
    });
  });

  test('rejects a stated default target that names an unselected model', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('stated-default', 'ollama', 'Stated default'),
      );
      const catalog = await stores.connectionCatalog.getSnapshot();
      const rejected = await stores.connectionCatalog.setDefaultTarget({
        expectedCatalogRevision: catalog.revision,
        target: { connectionId: connection.connectionId, modelId: 'llama3.3' },
      });
      assert.equal(rejected.kind, 'invalid_default_target');
      const unchanged = await stores.connectionCatalog.getSnapshot();
      assert.equal(unchanged.defaultTarget, null);
      assert.equal(unchanged.revision, catalog.revision);
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

  test('admits a test model the user selected or the provider listed, and nothing else', async () => {
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
      // Still selected, so still testable: discovery not mentioning `gpt-5`
      // says something about that response, not about the account (#1584).
      // Testing it is exactly how the user finds out which is true.
      assert.equal(
        (await stores.operations.beginConnectionTest(connection.connectionId, 'gpt-5')).kind,
        'ready',
      );
      // An id from neither source is still refused — the gate rejects strings
      // nobody chose and nobody reported, which is all it ever needed to do.
      await assert.rejects(
        () => stores.operations.beginConnectionTest(connection.connectionId, 'injected-model'),
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
    await withInteractiveOwner(async ({ root, stores }) => {
      const claude = await seedRetiredConnection(
        root,
        stores,
        'public-claude',
        '77777777-7777-4777-8777-777777777777',
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
      const apiKey = await createConnection(
        stores,
        3,
        connectionDraft('public-api-key', 'openai', 'Public API key'),
      );

      for (const connection of [claude, codex]) {
        await assert.rejects(
          () =>
            stores.credentialVault.set({
              locator: connectionCredential(connection, 'oauth_token'),
              expected: null,
              secret: 'public-oauth-must-be-rejected',
            }),
          // Both are refused, for different reasons and at different points:
          // the retired connection is refused as a whole before its credential
          // kind is considered, so it reports the connection as the problem.
          isStoreError(
            connection === claude ? 'invalid_connection_input' : 'invalid_credential_input',
          ),
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
    await withInteractiveOwner(async ({ root, stores }) => {
      const claude = await createConnection(
        stores,
        0,
        connectionDraft('codex-login', 'openai-codex', 'Codex login'),
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

      // A retired provider keeps its stored connection, so the login entry
      // point is reachable and has to refuse on its own.
      const retired = await seedRetiredConnection(
        root,
        stores,
        'claude-retired',
        '88888888-8888-4888-8888-888888888888',
      );
      assert.deepEqual(await stores.operations.beginInteractiveOAuthLogin(retired.connectionId), {
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
