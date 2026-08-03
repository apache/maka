/**
 * Contract for the shared CredentialStore (workspace credentials.json)
 * as the single OAuth token authority for desktop subscription services
 * (#1125). Service behavior is exercised through public APIs; the
 * remaining source checks cover architecture and startup ordering.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { SubscriptionActionResult } from '@maka/core';
import { AntigravitySubscriptionService } from '../oauth/antigravity-subscription-service.js';
import { ClaudeSubscriptionService } from '../oauth/claude-subscription-service.js';
import { CursorSubscriptionService } from '../oauth/cursor-subscription-service.js';
import { OpenAiCodexService } from '../oauth/openai-codex-service.js';
import type { SharedOAuthCredentialStore } from '../oauth/shared-credential-bridge.js';
import { XaiOAuthService } from '../oauth/xai-oauth-service.js';

interface OAuthServiceContract {
  getAccountState(): Promise<object>;
  getAccessTokenInternal(): Promise<string | null>;
  refreshTokens(): Promise<SubscriptionActionResult>;
  logout(): Promise<SubscriptionActionResult>;
}

interface ServiceCase {
  name: string;
  slug: string;
  legacyFile?: string;
  initialTokens: Record<string, unknown>;
  refresh: {
    accessToken: string;
    response: Record<string, unknown>;
  };
  create(input: {
    userDataDir: string;
    credentialStore: SharedOAuthCredentialStore;
    fetchFn: typeof fetch;
  }): OAuthServiceContract;
}

const NOW = 1_700_000_000_000;
const codexAccessToken = jwt({
  sub: 'codex-subject',
  'https://api.openai.com/auth': { chatgpt_account_id: 'codex-account' },
});
const refreshedCodexAccessToken = jwt({
  sub: 'refreshed-codex-subject',
  'https://api.openai.com/auth': { chatgpt_account_id: 'codex-account' },
});

const STORE_AUTHORITY_SERVICES: ServiceCase[] = [
  {
    name: 'Claude',
    slug: 'claude-subscription',
    legacyFile: '.claude_subscription_token',
    initialTokens: {
      access_token: 'claude-access',
      refresh_token: 'claude-refresh',
      expires_at: NOW + 3_600_000,
      token_type: 'Bearer',
      scope: 'user:sessions:claude_code',
      account_uuid: 'claude-account',
    },
    refresh: {
      accessToken: 'claude-access-refreshed',
      response: {
        access_token: 'claude-access-refreshed',
        refresh_token: 'claude-refresh-refreshed',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'user:sessions:claude_code',
        account: { uuid: 'claude-account' },
      },
    },
    create: (input) =>
      new ClaudeSubscriptionService({
        ...input,
        now: () => NOW,
        openExternal: async () => undefined,
      }),
  },
  {
    name: 'Codex',
    slug: 'codex-subscription',
    legacyFile: '.codex_subscription_token',
    initialTokens: {
      access_token: codexAccessToken,
      refresh_token: 'codex-refresh',
      expires_at: NOW + 3_600_000,
      account_id: 'codex-account',
    },
    refresh: {
      accessToken: refreshedCodexAccessToken,
      response: {
        access_token: refreshedCodexAccessToken,
        refresh_token: 'codex-refresh-refreshed',
        expires_in: 3600,
      },
    },
    create: (input) =>
      new OpenAiCodexService({
        ...input,
        now: () => NOW,
        openExternal: async () => undefined,
      }),
  },
  {
    name: 'Cursor',
    slug: 'cursor-subscription',
    legacyFile: '.cursor_subscription_token',
    initialTokens: {
      access_token: 'cursor-access',
      refresh_token: 'cursor-refresh',
      expires_at: NOW + 3_600_000,
    },
    refresh: {
      accessToken: 'cursor-access-refreshed',
      response: {
        accessToken: 'cursor-access-refreshed',
        refreshToken: 'cursor-refresh-refreshed',
      },
    },
    create: (input) =>
      new CursorSubscriptionService({
        ...input,
        now: () => NOW,
        openExternal: async () => undefined,
        sleepFn: async () => undefined,
      }),
  },
  {
    name: 'Antigravity',
    slug: 'antigravity-subscription',
    legacyFile: '.antigravity_subscription_token',
    initialTokens: {
      access_token: 'antigravity-access',
      refresh_token: 'antigravity-refresh',
      expires_at: NOW + 3_600_000,
    },
    refresh: {
      accessToken: 'antigravity-access-refreshed',
      response: {
        access_token: 'antigravity-access-refreshed',
        expires_in: 3600,
      },
    },
    create: (input) =>
      new AntigravitySubscriptionService({
        ...input,
        now: () => NOW,
        openExternal: async () => undefined,
      }),
  },
  {
    name: 'xAI',
    slug: 'xai-oauth',
    initialTokens: {
      access_token: 'xai-access',
      refresh_token: 'xai-refresh',
      expires_at: NOW + 3_600_000,
      token_type: 'Bearer',
    },
    refresh: {
      accessToken: 'xai-access-refreshed',
      response: {
        access_token: 'xai-access-refreshed',
        refresh_token: 'xai-refresh-refreshed',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    },
    create: ({ credentialStore, fetchFn }) =>
      new XaiOAuthService({
        credentialStore,
        fetchFn,
        now: () => NOW,
        openExternal: async () => undefined,
      }),
  },
];

const tempRoots: string[] = [];

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('OAuth subscription token authority (shared CredentialStore)', () => {
  for (const serviceCase of STORE_AUTHORITY_SERVICES) {
    it(`${serviceCase.name} reads account state and logs out through its shared credential`, async () => {
      const userDataDir = await makeUserDataDir();
      const credentials = createMemoryCredentialStore();
      credentials.set(serviceCase.slug, 'oauth_token', JSON.stringify(serviceCase.initialTokens));
      credentials.set(serviceCase.slug, 'api_key', 'api-key-must-survive');
      const legacyFile = serviceCase.legacyFile
        ? join(userDataDir, serviceCase.legacyFile)
        : undefined;
      if (legacyFile) await writeFile(legacyFile, 'legacy-encrypted-token');
      const service = serviceCase.create({
        userDataDir,
        credentialStore: credentials.store,
        fetchFn: async () => assert.fail('account-state and logout must not use the network'),
      });

      const state = await service.getAccountState();
      assert.equal('runtimeState' in state && state.runtimeState, 'authenticated');
      const serializedState = JSON.stringify(state);
      assert.doesNotMatch(serializedState, /access_token|refresh_token|id_token/);
      assert.equal(serializedState.includes(String(serviceCase.initialTokens.access_token)), false);

      assert.deepEqual(await service.logout(), { ok: true });
      assert.equal(credentials.get(serviceCase.slug, 'oauth_token'), null);
      assert.equal(credentials.get(serviceCase.slug, 'api_key'), 'api-key-must-survive');
      if (legacyFile) await assert.rejects(stat(legacyFile), { code: 'ENOENT' });
    });

    const refresh = serviceCase.refresh;

    for (const entryPoint of ['explicit', 'automatic'] as const) {
      it(`${serviceCase.name} refreshes an expired credential through ${entryPoint} refresh`, async () => {
        const userDataDir = await makeUserDataDir();
        const credentials = createMemoryCredentialStore();
        credentials.set(
          serviceCase.slug,
          'oauth_token',
          JSON.stringify({ ...serviceCase.initialTokens, expires_at: NOW - 1 }),
        );
        let fetchCalls = 0;
        const service = serviceCase.create({
          userDataDir,
          credentialStore: credentials.store,
          fetchFn: async () => {
            fetchCalls += 1;
            return Response.json(refresh.response);
          },
        });

        const result = entryPoint === 'explicit'
          ? await service.refreshTokens()
          : await service.getAccessTokenInternal();

        if (entryPoint === 'explicit') assert.deepEqual(result, { ok: true });
        else assert.equal(result, refresh.accessToken);
        assert.equal(fetchCalls, 1);
        const persisted = JSON.parse(
          credentials.get(serviceCase.slug, 'oauth_token') ?? 'null',
        ) as { access_token?: string };
        assert.equal(persisted.access_token, refresh.accessToken);
        assert.equal(await service.getAccessTokenInternal(), refresh.accessToken);
        assert.equal(fetchCalls, 1, 'a fresh shared token must not trigger a second refresh');
      });
    }

    for (const entryPoint of ['explicit', 'automatic'] as const) {
      it(`${serviceCase.name} keeps a credential replaced during ${entryPoint} refresh`, async () => {
        const userDataDir = await makeUserDataDir();
        const credentials = createMemoryCredentialStore();
        credentials.set(
          serviceCase.slug,
          'oauth_token',
          JSON.stringify({ ...serviceCase.initialTokens, expires_at: NOW - 1 }),
        );
        const winner = {
          ...serviceCase.initialTokens,
          access_token: `${serviceCase.name.toLowerCase()}-winner-access`,
          expires_at: NOW + 3_600_000,
        };
        credentials.replaceAfterNextRead(
          serviceCase.slug,
          'oauth_token',
          JSON.stringify(winner),
        );
        let fetchCalls = 0;
        const service = serviceCase.create({
          userDataDir,
          credentialStore: credentials.store,
          fetchFn: async () => {
            fetchCalls += 1;
            return Response.json(refresh.response);
          },
        });

        const result = entryPoint === 'explicit'
          ? await service.refreshTokens()
          : await service.getAccessTokenInternal();

        if (entryPoint === 'explicit') {
          assert.deepEqual(result, { ok: true });
        } else {
          assert.equal(result, winner.access_token);
        }
        assert.equal(
          fetchCalls,
          0,
          'a credential superseded before lease acquisition must not present its stale rotating refresh token',
        );
        assert.deepEqual(
          JSON.parse(credentials.get(serviceCase.slug, 'oauth_token') ?? 'null'),
          winner,
        );
      });
    }
  }

  for (const serviceCase of STORE_AUTHORITY_SERVICES.slice(0, 2)) {
    it(`${serviceCase.name} reports shared credential read failures as storage_failed`, async () => {
      const userDataDir = await makeUserDataDir();
      const service = serviceCase.create({
        userDataDir,
        credentialStore: {
          getSecret: async () => {
            throw new Error('credential store unavailable');
          },
          setSecret: async () => undefined,
          deleteSecret: async () => undefined,
        },
        fetchFn: async () => assert.fail('a failed credential read must not use the network'),
      });

      const state = await service.getAccountState();
      assert.equal('runtimeState' in state && state.runtimeState, 'storage_failed');
      assert.match('errorMessage' in state ? String(state.errorMessage) : '', /凭据|credentials\.json/);
    });

    it(`${serviceCase.name} reports a corrupt shared credential as storage_failed without deleting it`, async () => {
      const userDataDir = await makeUserDataDir();
      const credentials = createMemoryCredentialStore();
      credentials.set(serviceCase.slug, 'oauth_token', 'not-json');
      const service = serviceCase.create({
        userDataDir,
        credentialStore: credentials.store,
        fetchFn: async () => assert.fail('a corrupt credential read must not use the network'),
      });

      const state = await service.getAccountState();
      assert.equal('runtimeState' in state && state.runtimeState, 'storage_failed');
      assert.equal(credentials.get(serviceCase.slug, 'oauth_token'), 'not-json');
    });
  }

  it('Claude does not report login success when the shared credential write fails', async () => {
    const service = new ClaudeSubscriptionService({
      userDataDir: await makeUserDataDir(),
      openExternal: async () => undefined,
      now: () => NOW,
      fetchFn: async () =>
        Response.json({
          access_token: 'claude-access',
          refresh_token: 'claude-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'user:sessions:claude_code',
          account: { uuid: 'claude-account' },
        }),
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {
          throw new Error('credential store unavailable');
        },
        deleteSecret: async () => undefined,
      },
    });

    const verifier = 'a'.repeat(43);
    const result = await service.completeAuthorization('recovered-from-paste', `code#${verifier}`);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.reason, 'storage_failed');
  });

  it('Claude login writes the exchanged token to its shared credential', async () => {
    const credentials = createMemoryCredentialStore();
    const userDataDir = await makeUserDataDir();
    const service = new ClaudeSubscriptionService({
      userDataDir,
      openExternal: async () => undefined,
      now: () => NOW,
      fetchFn: async (input) => {
        if (String(input).includes('/v1/oauth/token')) {
          return Response.json({
            access_token: 'claude-login-access',
            refresh_token: 'claude-login-refresh',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'user:sessions:claude_code',
            account: { uuid: 'claude-login-account' },
          });
        }
        return Response.json({ account: { uuid: 'claude-login-account' } });
      },
      credentialStore: credentials.store,
    });

    const verifier = 'b'.repeat(43);
    assert.deepEqual(
      await service.completeAuthorization('recovered-from-paste', `code#${verifier}`),
      { ok: true },
    );
    const stored = JSON.parse(
      credentials.get('claude-subscription', 'oauth_token') ?? 'null',
    ) as { access_token?: string };
    assert.equal(stored.access_token, 'claude-login-access');
    assert.equal(credentials.get('codex-subscription', 'oauth_token'), null);
    await assert.rejects(stat(join(userDataDir, '.claude_subscription_token')), { code: 'ENOENT' });
  });

  it('Codex login writes the device-auth exchange result to its shared credential', async () => {
    const credentials = createMemoryCredentialStore();
    const userDataDir = await makeUserDataDir();
    let openedUrl: string | undefined;
    const service = new OpenAiCodexService({
      userDataDir,
      openExternal: async (url) => {
        openedUrl = url;
      },
      now: () => NOW,
      sleep: async () => {},
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith('/deviceauth/usercode')) {
          return Response.json({
            device_auth_id: 'deviceauth-codex-login',
            user_code: 'CODE-1234',
            interval: '5',
            expires_at: new Date(NOW + 600_000).toISOString(),
          });
        }
        if (url.endsWith('/deviceauth/token')) {
          return Response.json({
            authorization_code: 'codex-login-code',
            code_challenge: 'challenge',
            code_verifier: 'codex-login-verifier',
          });
        }
        if (url.endsWith('/oauth/token')) {
          return Response.json({
            access_token: jwt({
              sub: 'codex-login-subject',
              'https://api.openai.com/auth': { chatgpt_account_id: 'codex-login-account' },
            }),
            refresh_token: 'codex-login-refresh',
            expires_in: 3600,
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      },
      credentialStore: credentials.store,
    });

    const authorization = await service.getAuthorizationUrl();
    assert.ok('authRequestId' in authorization);
    const authRequestId = authorization.authRequestId;
    try {
      assert.deepEqual(await service.openAuthorizationUrl(authRequestId), { ok: true });
      // The verification page is the fixed server-owned device URL; no
      // local loopback callback is involved.
      assert.equal(openedUrl, 'https://auth.openai.com/codex/device');

      assert.deepEqual(await service.completeAuthorization(authRequestId), { ok: true });
      const stored = JSON.parse(
        credentials.get('codex-subscription', 'oauth_token') ?? 'null',
      ) as { account_id?: string };
      assert.equal(stored.account_id, 'codex-login-account');
      assert.equal(credentials.get('claude-subscription', 'oauth_token'), null);
      await assert.rejects(stat(join(userDataDir, '.codex_subscription_token')), { code: 'ENOENT' });
    } finally {
      service.cancelAuthorization(authRequestId);
    }
  });

  it('Codex login does not revive an authorization cancelled while the browser opens', async () => {
    let finishOpening!: () => void;
    const opening = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    const service = new OpenAiCodexService({
      userDataDir: await makeUserDataDir(),
      openExternal: async () => opening,
      credentialStore: createMemoryCredentialStore().store,
      fetchFn: async (url) => {
        if (String(url).endsWith('/deviceauth/usercode')) {
          return Response.json({
            device_auth_id: 'deviceauth-cancel-open',
            user_code: 'CODE-CANCEL',
            interval: '5',
            expires_at: new Date(NOW + 600_000).toISOString(),
          });
        }
        assert.fail(`unexpected fetch ${String(url)}`);
      },
    });
    const authorization = await service.getAuthorizationUrl();
    assert.ok('authRequestId' in authorization);

    const opened = service.openAuthorizationUrl(authorization.authRequestId);
    service.cancelAuthorization(authorization.authRequestId);
    finishOpening();

    assert.deepEqual(await opened, {
      ok: false,
      reason: 'authorization_cancelled',
      message: 'Codex 授权已取消。',
    });
    assert.deepEqual(await service.getAccountState(), {
      provider: 'openai-codex',
      runtimeState: 'not_logged_in',
    });
  });

  it('Cursor login writes the successful poll result to its shared credential', async () => {
    const credentials = createMemoryCredentialStore();
    const userDataDir = await makeUserDataDir();
    const service = new CursorSubscriptionService({
      userDataDir,
      openExternal: async () => undefined,
      now: () => NOW,
      sleepFn: async () => undefined,
      fetchFn: async () =>
        Response.json({
          accessToken: 'cursor-login-access',
          refreshToken: 'cursor-login-refresh',
        }),
      credentialStore: credentials.store,
    });

    const authorization = await service.getAuthorizationUrl();
    assert.ok('authRequestId' in authorization);
    assert.deepEqual(await service.completeAuthorization(authorization.authRequestId), { ok: true });
    const stored = JSON.parse(
      credentials.get('cursor-subscription', 'oauth_token') ?? 'null',
    ) as { access_token?: string };
    assert.equal(stored.access_token, 'cursor-login-access');
    assert.equal(credentials.get('codex-subscription', 'oauth_token'), null);
    await assert.rejects(stat(join(userDataDir, '.cursor_subscription_token')), { code: 'ENOENT' });
  });

});

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.signature`;
}

async function makeUserDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-oauth-service-contract-'));
  tempRoots.push(root);
  return root;
}

function createMemoryCredentialStore(): {
  store: SharedOAuthCredentialStore;
  get(slug: string, kind: 'api_key' | 'oauth_token'): string | null;
  set(slug: string, kind: 'api_key' | 'oauth_token', value: string): void;
  replaceAfterNextRead(
    slug: string,
    kind: 'api_key' | 'oauth_token',
    value: string,
  ): void;
} {
  const secrets = new Map<string, string>();
  const key = (slug: string, kind: string): string => `${slug}\0${kind}`;
  let replacementAfterNextRead: { key: string; value: string } | undefined;
  return {
    store: {
      getSecret: async (slug, kind) => {
        const storedKey = key(slug, kind);
        const current = secrets.get(storedKey) ?? null;
        if (replacementAfterNextRead?.key === storedKey) {
          secrets.set(storedKey, replacementAfterNextRead.value);
          replacementAfterNextRead = undefined;
        }
        return current;
      },
      setSecret: async (slug, kind, value) => {
        secrets.set(key(slug, kind), value);
      },
      deleteSecret: async (slug, kind) => {
        if (kind !== undefined) {
          secrets.delete(key(slug, kind));
          return;
        }
        for (const storedKey of secrets.keys()) {
          if (storedKey.startsWith(`${slug}\0`)) secrets.delete(storedKey);
        }
      },
      compareAndSetSecret: async (slug, kind, expected, value) => {
        const current = secrets.get(key(slug, kind)) ?? null;
        if (current !== expected) return { committed: false, current };
        secrets.set(key(slug, kind), value);
        return { committed: true };
      },
    },
    get: (slug, kind) => secrets.get(key(slug, kind)) ?? null,
    set: (slug, kind, value) => {
      secrets.set(key(slug, kind), value);
    },
    replaceAfterNextRead: (slug, kind, value) => {
      replacementAfterNextRead = { key: key(slug, kind), value };
    },
  };
}
