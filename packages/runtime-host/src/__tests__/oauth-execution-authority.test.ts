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
import { randomUUID } from 'node:crypto';
import { open, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import {
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '@maka/runtime/subscription-credentials';
import { type ProxiedFetchTransport } from '@maka/runtime/network/scoped-fetch-transport';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyCredentialMaterial,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  createHostOAuthModelFetch,
  HostOAuthExecutionAuthority,
  OAuthExecutionCredentialError,
  type HostOAuthExecutionBinding,
} from '../server/oauth-execution-authority.js';

const CONNECTION_SLUG = 'host-oauth-execution';
const MODEL_ID = 'gpt-5';
const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const FIXED_NOW = 1_785_600_000_000;

test('one OAuth generation singleflights refresh and persists its lease with canonical CAS', async () => {
  await withCopilotCredential(expiredTokens('access-v1'), async (fixture) => {
    const before = fixture.material;
    const binding = fixture.authority.bind({
      providerType: 'github-copilot',
      connectionSlug: CONNECTION_SLUG,
      material: before,
      createRefreshTransport: () => testRefreshTransport(unexpectedFetch),
    });

    const [first, second] = await Promise.all([binding.resolve(), binding.resolve()]);

    assert.deepEqual(first, expiredTokens('access-v1'));
    assert.deepEqual(second, first);
    const after = await readMaterial(fixture.stores);
    assert.equal(after.credentialId, before.credentialId);
    assert.equal(after.revision, before.revision + 2);
    assert.equal(after.secret, before.secret);
  });
});

test('an active OAuth binding cannot use a credential generation replaced by the user', async () => {
  await withCopilotCredential(currentTokens('old-access'), async (fixture) => {
    const oldBinding = fixture.authority.bind({
      providerType: 'github-copilot',
      connectionSlug: CONNECTION_SLUG,
      material: fixture.material,
      createRefreshTransport: () => testRefreshTransport(unexpectedFetch),
    });
    const replacement = currentTokens('replacement-access');
    const replaced = await fixture.stores.credentialVault.set({
      locator: fixture.material.locator,
      expected: {
        credentialId: fixture.material.credentialId,
        revision: fixture.material.revision,
      },
      secret: serializeOAuthSubscriptionTokens(replacement),
    });
    assert.equal(replaced.kind, 'committed');
    const replacementMaterial = await readMaterial(fixture.stores);
    const newBinding = fixture.authority.bind({
      providerType: 'github-copilot',
      connectionSlug: CONNECTION_SLUG,
      material: replacementMaterial,
      createRefreshTransport: () => testRefreshTransport(unexpectedFetch),
    });

    assert.deepEqual(await newBinding.resolve(), replacement);
    await assert.rejects(
      () => oldBinding.resolve(),
      (error) =>
        error instanceof OAuthExecutionCredentialError && error.code === 'credential_superseded',
    );
    const canonical = await readMaterial(fixture.stores);
    assert.equal(canonical.secret, replacementMaterial.secret);
    assert.equal(canonical.revision, replacementMaterial.revision);
  });
});

test('request abort stops waiting for shared OAuth resolution without dispatching the model call', async () => {
  const pending = deferred<OAuthSubscriptionTokens>();
  const tokens = currentTokens(codexAccessToken('account-v1'));
  let modelCalls = 0;
  let resolveCalls = 0;
  const modelFetch = createHostOAuthModelFetch({
    binding: {
      providerType: 'openai-codex',
      connectionSlug: CONNECTION_SLUG,
      resolve: async () => {
        resolveCalls += 1;
        return pending.promise;
      },
    },
    initialTokens: tokens,
    connection: {
      slug: CONNECTION_SLUG,
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.6-sol',
    },
    sessionId: 'abort-session',
    modelId: 'gpt-5.6-sol',
    fetchFn: async () => {
      modelCalls += 1;
      return Response.json({ ok: true });
    },
  });
  const controller = new AbortController();
  const reason = new Error('run stopped');
  const request = modelFetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    signal: controller.signal,
    body: JSON.stringify({ input: [] }),
  });

  controller.abort(reason);
  await assert.rejects(request, (error) => error === reason);
  assert.equal(modelCalls, 0);
  pending.resolve(tokens);
  await pending.promise;

  const alreadyAborted = new AbortController();
  const earlierReason = new Error('run was already stopped');
  alreadyAborted.abort(earlierReason);
  await assert.rejects(
    () =>
      modelFetch('https://chatgpt.com/backend-api/codex/responses', {
        signal: alreadyAborted.signal,
      }),
    (error) => error === earlierReason,
  );
  assert.equal(resolveCalls, 1);
  assert.equal(modelCalls, 0);
});

test('reconciles a published OAuth lease claim before the next demand', async () => {
  await withSeededOAuthCredential(
    'openai-codex',
    expiredTokens('claim-v1', 'account-v1'),
    async (fixture) => {
      let refreshCalls = 0;
      const providerFetch = successfulCodexRefresh(() => {
        refreshCalls += 1;
      });
      const binding = fixture.authority.bind({
        providerType: 'openai-codex',
        connectionSlug: CONNECTION_SLUG,
        material: fixture.material,
        createRefreshTransport: () => testRefreshTransport(providerFetch),
      });
      let leaseNow = FIXED_NOW;
      const nowMock = mock.method(Date, 'now', () => leaseNow);
      try {
        await withPublishedSyncFailure(fixture.root, 2, async () => {
          await assert.rejects(() => binding.resolve(), isOAuthError('persistence_failed'));
        });
        assert.equal(refreshCalls, 0);
        const secondBinding = fixture.authority.bind({
          providerType: 'openai-codex',
          connectionSlug: CONNECTION_SLUG,
          material: await readMaterial(fixture.stores),
          createRefreshTransport: () => testRefreshTransport(providerFetch),
        });
        leaseNow += 30_001;
        const [first, second] = await Promise.all([binding.resolve(), secondBinding.resolve()]);
        assert.equal(first.access_token, codexAccessToken('account-v2'));
        assert.equal(second.access_token, codexAccessToken('account-v2'));
        assert.equal(refreshCalls, 1);
      } finally {
        nowMock.mock.restore();
      }
    },
  );
});

test('reconciles a published OAuth refresh finalization before the next demand', async () => {
  await withSeededOAuthCredential(
    'openai-codex',
    expiredTokens('finalize-v1', 'account-v1'),
    async (fixture) => {
      let refreshCalls = 0;
      const providerFetch = successfulCodexRefresh(() => {
        refreshCalls += 1;
      });
      const binding = fixture.authority.bind({
        providerType: 'openai-codex',
        connectionSlug: CONNECTION_SLUG,
        material: fixture.material,
        createRefreshTransport: () => testRefreshTransport(providerFetch),
      });

      await withPublishedSyncFailure(fixture.root, 4, async () => {
        await assert.rejects(() => binding.resolve(), isOAuthError('persistence_failed'));
      });
      assert.equal((await binding.resolve()).access_token, codexAccessToken('account-v2'));
      assert.equal(refreshCalls, 1);
    },
  );
});

test('reconciles a published OAuth lease release before retrying refresh', async () => {
  await withSeededOAuthCredential(
    'openai-codex',
    expiredTokens('release-v1', 'account-v1'),
    async (fixture) => {
      let refreshCalls = 0;
      const providerFetch: typeof fetch = async (url) => {
        assert.equal(String(url), CODEX_TOKEN_ENDPOINT);
        refreshCalls += 1;
        return refreshCalls === 1
          ? Response.json({ error: 'temporary failure' }, { status: 503 })
          : Response.json({
              access_token: codexAccessToken('account-v2'),
              refresh_token: 'refresh-v2',
              expires_in: 3_600,
            });
      };
      const binding = fixture.authority.bind({
        providerType: 'openai-codex',
        connectionSlug: CONNECTION_SLUG,
        material: fixture.material,
        createRefreshTransport: () => testRefreshTransport(providerFetch),
      });

      await withPublishedSyncFailure(fixture.root, 4, async () => {
        await assert.rejects(() => binding.resolve(), isOAuthError('persistence_failed'));
      });
      assert.equal((await binding.resolve()).access_token, codexAccessToken('account-v2'));
      assert.equal(refreshCalls, 2);
    },
  );
});

test('Codex request auth and account identity advance from the same token snapshot', async () => {
  const observed: Headers[] = [];
  let tokens = currentTokens(codexAccessToken('account-v1'));
  const binding: HostOAuthExecutionBinding = {
    providerType: 'openai-codex',
    connectionSlug: CONNECTION_SLUG,
    resolve: async () => tokens,
  };
  const modelFetch = createHostOAuthModelFetch({
    binding,
    initialTokens: tokens,
    connection: {
      slug: CONNECTION_SLUG,
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.6-sol',
    },
    sessionId: 'codex-session',
    modelId: 'gpt-5.6-sol',
    fetchFn: async (_url, init) => {
      observed.push(new Headers(init?.headers));
      return Response.json({ ok: true });
    },
  });
  const request = {
    method: 'POST',
    headers: {
      authorization: 'Bearer stale-sdk-token',
      'ChatGPT-Account-Id': 'stale-account',
    },
    body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
  } satisfies RequestInit;

  await modelFetch('https://chatgpt.com/backend-api/codex/responses', request);
  tokens = currentTokens(codexAccessToken('account-v2'));
  await modelFetch('https://chatgpt.com/backend-api/codex/responses', request);

  assert.equal(observed[0]?.get('authorization'), `Bearer ${codexAccessToken('account-v1')}`);
  assert.equal(observed[0]?.get('ChatGPT-Account-Id'), 'account-v1');
  assert.equal(observed[1]?.get('authorization'), `Bearer ${codexAccessToken('account-v2')}`);
  assert.equal(observed[1]?.get('ChatGPT-Account-Id'), 'account-v2');
  assert.equal(observed[1]?.get('session_id'), 'codex-session');
});

test('a Codex 401 force-refreshes canonical credentials and replays once', async () => {
  const staleAccess = codexAccessToken('account-v1');
  const refreshedAccess = codexAccessToken('account-v2');
  await withSeededOAuthCredential('openai-codex', currentTokens(staleAccess), async (fixture) => {
    let refreshCalls = 0;
    const modelHeaders: Headers[] = [];
    const providerFetch: typeof fetch = async (url, init) => {
      if (String(url) === CODEX_TOKEN_ENDPOINT) {
        refreshCalls += 1;
        return Response.json({
          access_token: refreshedAccess,
          refresh_token: 'rotated-refresh',
          expires_in: 3_600,
        });
      }
      modelHeaders.push(new Headers(init?.headers));
      return modelHeaders.length === 1
        ? Response.json({ error: 'token invalidated' }, { status: 401 })
        : Response.json({ ok: true });
    };
    const binding = fixture.authority.bind({
      providerType: 'openai-codex',
      connectionSlug: CONNECTION_SLUG,
      material: fixture.material,
      createRefreshTransport: () => testRefreshTransport(providerFetch),
    });
    const initialTokens = await binding.resolve();
    const modelFetch = createHostOAuthModelFetch({
      binding,
      initialTokens,
      connection: {
        slug: CONNECTION_SLUG,
        providerType: 'openai-codex',
        defaultModel: 'gpt-5.6-sol',
      },
      sessionId: 'codex-401-session',
      modelId: 'gpt-5.6-sol',
      fetchFn: providerFetch,
    });

    const response = await modelFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [] }),
    });

    assert.equal(response.ok, true);
    assert.equal(refreshCalls, 1);
    assert.equal(modelHeaders.length, 2);
    assert.equal(modelHeaders[1]?.get('authorization'), `Bearer ${refreshedAccess}`);
    assert.equal(modelHeaders[1]?.get('ChatGPT-Account-Id'), 'account-v2');
    const canonical = JSON.parse(
      (await readMaterial(fixture.stores)).secret,
    ) as OAuthSubscriptionTokens;
    assert.equal(canonical.access_token, refreshedAccess);
    assert.equal(canonical.refresh_token, 'rotated-refresh');
  });
});

test('concurrent forced refreshes join one Host credential refresh', async () => {
  const staleAccess = codexAccessToken('account-v1');
  const refreshedAccess = codexAccessToken('account-v2');
  await withSeededOAuthCredential('openai-codex', currentTokens(staleAccess), async (fixture) => {
    const refreshResponse = deferred<Response>();
    let refreshCalls = 0;
    const binding = fixture.authority.bind({
      providerType: 'openai-codex',
      connectionSlug: CONNECTION_SLUG,
      material: fixture.material,
      createRefreshTransport: () =>
        testRefreshTransport(async (url) => {
          assert.equal(String(url), CODEX_TOKEN_ENDPOINT);
          refreshCalls += 1;
          return refreshResponse.promise;
        }),
    });

    const first = binding.forceRefresh!();
    await new Promise((resolve) => setImmediate(resolve));
    const second = binding.forceRefresh!();
    refreshResponse.resolve(
      Response.json({
        access_token: refreshedAccess,
        refresh_token: 'rotated-refresh',
        expires_in: 3_600,
      }),
    );

    const [firstTokens, secondTokens] = await Promise.all([first, second]);
    assert.equal(refreshCalls, 1);
    assert.equal(firstTokens.access_token, refreshedAccess);
    assert.equal(secondTokens.access_token, refreshedAccess);
  });
});

interface CopilotCredentialFixture {
  readonly root: string;
  readonly stores: RuntimePolicyStoresWriter;
  readonly authority: HostOAuthExecutionAuthority;
  readonly material: RuntimePolicyCredentialMaterial;
}

async function withCopilotCredential(
  tokens: OAuthSubscriptionTokens,
  run: (fixture: CopilotCredentialFixture) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-oauth-execution-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: CONNECTION_SLUG,
        name: 'Host OAuth execution',
        providerType: 'github-copilot',
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const configured = await stores.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'oauth_token',
      },
      expected: null,
      secret: serializeOAuthSubscriptionTokens(tokens),
    });
    assert.equal(configured.kind, 'committed');
    await run({
      root: capability.canonicalPath,
      stores,
      authority: new HostOAuthExecutionAuthority(stores),
      material: await readMaterial(stores),
    });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function withSeededOAuthCredential(
  providerType: 'openai-codex' | 'openai-codex',
  tokens: OAuthSubscriptionTokens,
  run: (fixture: CopilotCredentialFixture) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-host-oauth-seeded-'));
  const capability = await resolveStorageRoot({
    path: join(base, 'interactive'),
    kind: 'interactive',
  });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: CONNECTION_SLUG,
        name: 'Host OAuth execution',
        providerType,
        enabled: true,
        enabledModelIds: [MODEL_ID],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    await writeFile(
      join(capability.canonicalPath, 'credential-vault.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          revision: 1,
          entries: [
            {
              locator: {
                scope: 'connection',
                connectionId: connection.connectionId,
                kind: 'oauth_token',
              },
              credentialId: randomUUID(),
              revision: 1,
              secret: serializeOAuthSubscriptionTokens(tokens),
              updatedAt: FIXED_NOW,
            },
          ],
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await run({
      root: capability.canonicalPath,
      stores,
      authority: new HostOAuthExecutionAuthority(stores, () => FIXED_NOW),
      material: await readMaterial(stores),
    });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function readMaterial(
  stores: RuntimePolicyStoresWriter,
): Promise<RuntimePolicyCredentialMaterial> {
  const resolved = await stores.operations.resolveExecutionConnection(CONNECTION_SLUG);
  assert.equal(resolved.kind, 'ready');
  if (resolved.kind !== 'ready' || !resolved.secretMaterial.connection) {
    throw new Error('OAuth execution material was not ready');
  }
  return resolved.secretMaterial.connection;
}

function expiredTokens(accessToken: string, accountUuid?: string): OAuthSubscriptionTokens {
  return {
    access_token: accessToken,
    refresh_token: `${accessToken}-refresh`,
    expires_at: 0,
    ...(accountUuid ? { account_uuid: accountUuid } : {}),
  };
}

function currentTokens(accessToken: string, accountUuid?: string): OAuthSubscriptionTokens {
  return {
    access_token: accessToken,
    refresh_token: `${accessToken}-refresh`,
    expires_at: Number.MAX_SAFE_INTEGER,
    ...(accountUuid ? { account_uuid: accountUuid } : {}),
  };
}

function claudeConnection(): RuntimeExecutionConnection {
  return {
    slug: CONNECTION_SLUG,
    providerType: 'openai-codex',
    defaultModel: 'claude-sonnet-4-5',
  };
}

function claudeRequest(): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer stale-sdk-token',
      'x-api-key': 'stale-sdk-token',
    },
    body: JSON.stringify({
      stream: false,
      system: 'Use the Host prompt.',
      messages: [{ role: 'user', content: 'hello' }],
    }),
  };
}

function successfulCodexRefresh(onRefresh: () => void): typeof fetch {
  return async (url) => {
    assert.equal(String(url), CODEX_TOKEN_ENDPOINT);
    onRefresh();
    return Response.json({
      access_token: codexAccessToken('account-v2'),
      refresh_token: 'refresh-v2',
      expires_in: 3_600,
    });
  };
}

async function withPublishedSyncFailure(
  root: string,
  failingCall: number,
  run: () => Promise<void>,
): Promise<void> {
  const probe = await open(root, 'r');
  const prototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
  const originalSync = prototype.sync;
  await probe.close();
  let syncCalls = 0;
  const syncMock = mock.method(prototype, 'sync', async function (this: typeof probe) {
    syncCalls += 1;
    if (syncCalls === failingCall) throw new Error('injected published OAuth commit failure');
    return originalSync.call(this);
  });
  try {
    await run();
    assert.equal(syncCalls, failingCall);
  } finally {
    syncMock.mock.restore();
  }
}

function isOAuthError(code: OAuthExecutionCredentialError['code']): (error: unknown) => boolean {
  return (error) => error instanceof OAuthExecutionCredentialError && error.code === code;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function claudeIdentity(body: Record<string, unknown> | undefined): Record<string, unknown> {
  assert.ok(body);
  const metadata = body.metadata as { user_id?: unknown } | undefined;
  if (!metadata || typeof metadata.user_id !== 'string') {
    throw new Error('Claude cloak metadata did not contain a user identity');
  }
  return JSON.parse(metadata.user_id) as Record<string, unknown>;
}

function codexAccessToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `header.${payload}.signature`;
}

const unexpectedFetch: typeof fetch = async () => {
  throw new Error('GitHub Copilot credential refresh must not perform provider I/O');
};

function testRefreshTransport(fetchFn: typeof fetch): ProxiedFetchTransport {
  return { fetch: fetchFn, close: async () => undefined };
}
