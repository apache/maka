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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createFileCredentialStore } from '@maka/storage';

import {
  createGitHubCopilotAccountTokens,
  parseOAuthSubscriptionTokens,
  refreshAndPersistOAuthSubscriptionTokens,
  refreshOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  resolveOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '../subscription-credentials.js';

test('xAI OAuth refresh preserves a rotated refresh token through the shared provider contract', async () => {
  let requestUrl = '';
  let requestBody = '';
  const tokens = await refreshOAuthSubscriptionTokens({
    providerType: 'xai-oauth',
    tokens: {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
      scope: 'openid offline_access',
    },
    now: () => 10_000,
    fetchFn: async (url, init) => {
      requestUrl = String(url);
      requestBody = String(init?.body);
      assert.equal(
        new Headers(init?.headers).get('content-type'),
        'application/x-www-form-urlencoded',
      );
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3_600,
        token_type: 'Bearer',
        scope: 'openid offline_access grok-cli:access api:access',
        provider_extension: { version: 2 },
      });
    },
  });

  assert.equal(requestUrl, 'https://auth.x.ai/oauth2/token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requestBody)), {
    grant_type: 'refresh_token',
    client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
    refresh_token: 'old-refresh',
  });
  assert.deepEqual(tokens, {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_at: 3_610_000,
    token_type: 'Bearer',
    scope: 'openid offline_access grok-cli:access api:access',
  });
});

test('xAI OAuth refresh uses the documented one-hour lifetime when expires_in is omitted', async () => {
  const tokens = await refreshOAuthSubscriptionTokens({
    providerType: 'xai-oauth',
    tokens: {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    },
    now: () => 10_000,
    fetchFn: async () =>
      Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        token_type: 'Bearer',
      }),
  });

  assert.deepEqual(tokens, {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_at: 3_610_000,
    token_type: 'Bearer',
    scope: undefined,
  });
});

describe('GitHub Copilot subscription credentials', () => {
  test('preserves the account-scoped API endpoint in the existing OAuth token record', () => {
    assert.deepEqual(
      parseOAuthSubscriptionTokens(
        JSON.stringify({
          access_token: 'copilot-token',
          refresh_token: 'github-account-token',
          expires_at: 123_000,
          base_url: 'https://api.business.githubcopilot.com',
        }),
      ),
      {
        access_token: 'copilot-token',
        refresh_token: 'github-account-token',
        expires_at: 123_000,
        base_url: 'https://api.business.githubcopilot.com',
      },
    );
  });

  test('stores one direct Copilot-capable GitHub token in the shared OAuth record', () => {
    const tokens = createGitHubCopilotAccountTokens('github-account-token');

    assert.deepEqual(tokens, {
      access_token: 'github-account-token',
      refresh_token: 'github-account-token',
      expires_at: Number.MAX_SAFE_INTEGER,
      token_type: 'Bearer',
      base_url: 'https://api.githubcopilot.com',
    });
  });

  test('resolves the durable direct token without calling the retired exchange endpoint', async () => {
    const stored = JSON.stringify({
      access_token: 'github-account-token',
      refresh_token: 'github-account-token',
      expires_at: Number.MAX_SAFE_INTEGER,
      base_url: 'https://api.githubcopilot.com',
    });
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'github-copilot',
      slug: 'github-copilot',
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async () =>
          assert.fail('durable GitHub tokens do not refresh through a token exchange'),
      },
      now: () => 10_000,
      fetchFn: async () => assert.fail('the retired token exchange must not be called'),
    });

    assert.equal(tokens?.access_token, 'github-account-token');
    assert.equal(tokens?.refresh_token, 'github-account-token');
    assert.equal(tokens?.base_url, 'https://api.githubcopilot.com');
  });
});

describe('OAuth refresh response validation', () => {
  const nearExpiryStored = JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: 1_000, // already past `now` below → refresh path runs
  });

  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  for (const [name, body] of [
    ['empty object', {}],
    ['empty access token', { access_token: '', expires_in: 3600 }],
    ['missing expiry', { access_token: 'new-access' }],
    ['non-numeric expiry', { access_token: 'new-access', expires_in: 'soon' }],
    ['non-positive expiry', { access_token: 'new-access', expires_in: 0 }],
  ] as const) {
    test(`a 200 refresh with ${name} never replaces the stored token`, async () => {
      const writes: string[] = [];
      const tokens = await resolveOAuthSubscriptionTokens({
        providerType: 'openai-codex',
        slug: 'openai-codex',
        credentialStore: {
          getSecret: async () => nearExpiryStored,
          setSecret: async (_slug, _kind, value) => {
            writes.push(value);
          },
        },
        now: () => 10_000_000,
        fetchFn: async () => okResponse(body),
      });

      assert.equal(tokens, null, 'an invalid refresh payload must surface as a refresh failure');
      assert.deepEqual(
        writes,
        [],
        'the still-working stored record must not be overwritten with garbage',
      );
    });
  }

  test('a rotated refresh token that is an empty string keeps the previous refresh token', async () => {
    const writes: string[] = [];
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: 'openai-codex',
      credentialStore: {
        getSecret: async () => nearExpiryStored,
        setSecret: async (_slug, _kind, value) => {
          writes.push(value);
        },
      },
      now: () => 10_000_000,
      fetchFn: async () =>
        okResponse({ access_token: 'new-access', refresh_token: '', expires_in: 3600 }),
    });

    assert.equal(tokens?.access_token, 'new-access');
    assert.equal(tokens?.refresh_token, 'old-refresh');
    assert.equal(writes.length, 1);
  });
});

describe('OAuth refresh persistence transaction', () => {
  test('a read-only store fails before starting a remote refresh', async () => {
    const stored = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    let refreshCalls = 0;

    const result = await refreshAndPersistOAuthSubscriptionTokens({
      slug: 'openai-codex',
      credentialStore: { getSecret: async () => stored },
      refreshTokens: async () => {
        refreshCalls += 1;
        return {
          access_token: 'discarded-access',
          refresh_token: 'discarded-refresh',
          expires_at: 20_000_000,
        };
      },
    });

    assert.equal(result.outcome, 'storage-failed');
    assert.equal(refreshCalls, 0, 'a refresh must not rotate tokens that cannot be persisted');
  });

  test('resolve accepts a store whose only write capability is compare-and-set', async () => {
    const stored = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    let current: string | null = stored;
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: 'openai-codex',
      credentialStore: {
        getSecret: async () => current,
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          if (expected !== current) return { committed: false, current };
          current = value;
          return { committed: true };
        },
      },
      now: () => 10_000_000,
      fetchFn: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        }) as unknown as Response,
    });

    assert.equal(tokens?.access_token, 'new-access');
    assert.equal(parseOAuthSubscriptionTokens(current ?? '')?.access_token, 'new-access');
  });

  test('near-expiry resolve keeps its first read as the refresh commit basis', async () => {
    const initial = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    const winner = JSON.stringify({
      access_token: 'winner-access',
      refresh_token: 'winner-refresh',
      expires_at: 20_000_000,
    });
    let current = initial;
    let reads = 0;
    const committedValues: string[] = [];
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      slug: 'openai-codex',
      credentialStore: {
        getSecret: async () => {
          reads += 1;
          if (reads === 2) current = winner;
          return current;
        },
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          if (expected !== current) return { committed: false, current };
          committedValues.push(value);
          current = value;
          return { committed: true };
        },
      },
      now: () => 10_000_000,
      fetchFn: async () => {
        current = winner;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'redundant-access',
            refresh_token: 'redundant-refresh',
            expires_in: 3600,
          }),
        } as unknown as Response;
      },
    });

    assert.equal(tokens?.access_token, 'winner-access');
    assert.equal(
      committedValues.some(
        (value) => parseOAuthSubscriptionTokens(value)?.access_token === 'redundant-access',
      ),
      false,
      'a resolve triggered by the old basis must not commit its redundant refresh over the winner',
    );
    assert.equal(current, winner);
  });

  test('a custom automatic refresh keeps its expiry-decision read as the commit basis', async () => {
    const initial = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expires_at: 1_000,
    });
    const winner = JSON.stringify({
      access_token: 'winner-access',
      refresh_token: 'winner-refresh',
      expires_at: 20_000_000,
    });
    let current = initial;
    const committedValues: string[] = [];

    const result = await resolveAndPersistOAuthSubscriptionTokens({
      slug: 'test-subscription',
      credentialStore: {
        getSecret: async () => current,
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          if (expected !== current) return { committed: false, current };
          committedValues.push(value);
          current = value;
          return { committed: true };
        },
      },
      now: () => 10_000_000,
      refreshSkewMs: 0,
      refreshTokens: async () => {
        current = winner;
        return {
          access_token: 'redundant-access',
          refresh_token: 'redundant-refresh',
          expires_at: 20_000_000,
        };
      },
    });

    assert.equal(result.outcome, 'superseded');
    assert.equal(
      result.outcome === 'superseded' ? result.tokens.access_token : null,
      'winner-access',
    );
    assert.equal(
      committedValues.some(
        (value) => parseOAuthSubscriptionTokens(value)?.access_token === 'redundant-access',
      ),
      false,
      'the old expiry-decision basis must not commit its redundant refresh over the winner',
    );
    assert.equal(current, winner);
  });

  test('a logout from another store stays terminal while refresh is in flight', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-oauth-refresh-'));
    try {
      const refreshingStore = createFileCredentialStore(dir);
      const logoutStore = createFileCredentialStore(dir);
      const stored = JSON.stringify({
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: 1_000,
      });
      await refreshingStore.setSecret('openai-codex', 'oauth_token', stored);

      let releaseRefresh!: (response: Response) => void;
      let markRefreshStarted!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      const refreshResponse = new Promise<Response>((resolve) => {
        releaseRefresh = resolve;
      });
      const resolving = resolveOAuthSubscriptionTokens({
        providerType: 'openai-codex',
        slug: 'openai-codex',
        credentialStore: refreshingStore,
        now: () => 10_000_000,
        fetchFn: async () => {
          markRefreshStarted();
          return refreshResponse;
        },
      });

      await refreshStarted;
      await logoutStore.deleteSecret('openai-codex', 'oauth_token');
      releaseRefresh({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      } as unknown as Response);

      assert.equal(await resolving, null);
      assert.equal(await logoutStore.getSecret('openai-codex', 'oauth_token'), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a stale refresh lease is recoverable after its owner exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-oauth-refresh-'));
    try {
      const store = createFileCredentialStore(dir);
      await store.setSecret(
        'openai-codex',
        'oauth_token',
        JSON.stringify({
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          expires_at: 1_000,
          _refresh_lock: { id: 'crashed-process', expires_at: Date.now() - 1 },
        }),
      );
      let refreshCalls = 0;

      const result = await refreshAndPersistOAuthSubscriptionTokens({
        slug: 'openai-codex',
        credentialStore: store,
        refreshTokens: async () => {
          refreshCalls += 1;
          return {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_at: 20_000_000,
          };
        },
      });

      assert.equal(result.outcome, 'refreshed');
      assert.equal(refreshCalls, 1);
      assert.equal(
        parseOAuthSubscriptionTokens((await store.getSecret('openai-codex', 'oauth_token')) ?? '')
          ?.access_token,
        'new-access',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a failed refresh releases its lease so a later request can retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-oauth-refresh-'));
    try {
      const store = createFileCredentialStore(dir);
      const stored = JSON.stringify({
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: 1_000,
      });
      await store.setSecret('openai-codex', 'oauth_token', stored);

      const failed = await refreshAndPersistOAuthSubscriptionTokens({
        slug: 'openai-codex',
        credentialStore: store,
        refreshTokens: async () => {
          throw new Error('temporary network failure');
        },
      });
      assert.equal(failed.outcome, 'refresh-failed');
      assert.equal(await store.getSecret('openai-codex', 'oauth_token'), stored);

      const retried = await refreshAndPersistOAuthSubscriptionTokens({
        slug: 'openai-codex',
        credentialStore: store,
        refreshTokens: async () => ({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_at: 20_000_000,
        }),
      });
      assert.equal(retried.outcome, 'refreshed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('aborts a remote refresh before its credential lease can expire', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    let current = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'rotating-refresh',
      expires_at: 1_000,
    });
    let observedSignal: AbortSignal | undefined;
    let releaseRemote!: () => void;
    let rejectRemote!: (reason?: unknown) => void;
    const remoteSettled = new Promise<OAuthSubscriptionTokens>((resolve, reject) => {
      rejectRemote = reject;
      releaseRemote = () =>
        resolve({
          access_token: 'late-access',
          refresh_token: 'late-refresh',
          expires_at: 20_000_000,
        });
    });
    const refreshTokens = async (
      _tokens: OAuthSubscriptionTokens,
      signal?: AbortSignal,
    ): Promise<OAuthSubscriptionTokens> => {
      observedSignal = signal;
      signal?.addEventListener('abort', () => rejectRemote(signal.reason), { once: true });
      return remoteSettled;
    };
    const pending = refreshAndPersistOAuthSubscriptionTokens({
      slug: 'xai-oauth',
      credentialStore: {
        getSecret: async () => current,
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          if (current !== expected) return { committed: false, current };
          current = value;
          return { committed: true };
        },
      },
      refreshTokens,
    });

    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(29_999);
    await new Promise((resolve) => setImmediate(resolve));
    const wasAborted = observedSignal?.aborted ?? false;
    if (!wasAborted) releaseRemote();
    const result = await pending;

    assert.equal(wasAborted, true, 'the remote refresh must be cancelled before the 30s lease');
    assert.equal(result.outcome, 'refresh-failed');
    assert.equal(parseOAuthSubscriptionTokens(current)?.access_token, 'old-access');
  });

  test('preserves lease finalization time when claiming the credential is delayed', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    let current = JSON.stringify({
      access_token: 'old-access',
      refresh_token: 'rotating-refresh',
      expires_at: 1_000,
    });
    let claimDelayed = false;
    let leaseExpiresAt = 0;
    let observedSignal: AbortSignal | undefined;
    let rejectRemote!: (reason?: unknown) => void;
    const remoteSettled = new Promise<OAuthSubscriptionTokens>((_resolve, reject) => {
      rejectRemote = reject;
    });
    const pending = refreshAndPersistOAuthSubscriptionTokens({
      slug: 'xai-oauth',
      credentialStore: {
        getSecret: async () => current,
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          if (current !== expected) return { committed: false, current };
          if (!claimDelayed) {
            claimDelayed = true;
            leaseExpiresAt = (JSON.parse(value) as { _refresh_lock: { expires_at: number } })
              ._refresh_lock.expires_at;
            context.mock.timers.tick(9_000);
          }
          current = value;
          return { committed: true };
        },
      },
      refreshTokens: async (_tokens, signal) => {
        observedSignal = signal;
        signal.addEventListener('abort', () => rejectRemote(signal.reason), { once: true });
        return remoteSettled;
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(11_000);
    await new Promise((resolve) => setImmediate(resolve));
    const wasAborted = observedSignal?.aborted ?? false;
    if (!wasAborted) rejectRemote(new Error('release the RED-path refresh'));
    const result = await pending;

    assert.equal(wasAborted, true);
    assert.ok(
      leaseExpiresAt - Date.now() >= 10_000,
      'the remote refresh must stop with enough lease time left to persist or release it',
    );
    assert.equal(result.outcome, 'refresh-failed');
    assert.equal(parseOAuthSubscriptionTokens(current)?.access_token, 'old-access');
  });

  test('two concurrent refreshes perform one remote rotation and converge on its token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-oauth-refresh-'));
    try {
      const storeA = createFileCredentialStore(dir);
      const storeB = createFileCredentialStore(dir);
      const stored = JSON.stringify({
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: 1_000,
      });
      await storeA.setSecret('openai-codex', 'oauth_token', stored);

      let refreshCalls = 0;
      let markRefreshStarted!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        markRefreshStarted = resolve;
      });
      let releaseRefresh!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const run = (store: typeof storeA) =>
        refreshAndPersistOAuthSubscriptionTokens({
          slug: 'openai-codex',
          credentialStore: store,
          refreshTokens: async () => {
            refreshCalls += 1;
            markRefreshStarted();
            await released;
            return {
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_at: 20_000_000,
            };
          },
        });

      const pendingA = run(storeA);
      await refreshStarted;
      const pendingB = run(storeB);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        refreshCalls,
        1,
        'a rotating refresh token must be presented to the provider only once',
      );
      releaseRefresh();
      const results = await Promise.all([pendingA, pendingB]);

      assert.deepEqual(results.map((result) => result.outcome).sort(), ['refreshed', 'superseded']);
      const winner = results.find((result) => result.outcome === 'refreshed');
      const loser = results.find((result) => result.outcome === 'superseded');
      assert.ok(winner?.outcome === 'refreshed');
      assert.ok(loser?.outcome === 'superseded');
      assert.deepEqual(loser.tokens, winner.tokens);
      assert.deepEqual(
        parseOAuthSubscriptionTokens((await storeA.getSecret('openai-codex', 'oauth_token')) ?? ''),
        winner.tokens,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
