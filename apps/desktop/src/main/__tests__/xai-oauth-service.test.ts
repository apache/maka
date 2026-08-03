import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PENDING_AUTHORIZATION_TTL_MS } from '@maka/core';
import { XaiOAuthService } from '../oauth/xai-oauth-service.js';

describe('XaiOAuthService', () => {
  test('starts the Grok CLI PKCE flow without exposing its URL or verifier', async () => {
    const opened: string[] = [];
    const service = createService({ opened });
    const result = await service.getAuthorizationUrl();

    assert.equal('ok' in result, false);
    if ('ok' in result) return;
    assert.equal(typeof result.authRequestId, 'string');
    assert.match(result.stateHint, /^[A-Za-z0-9_-]{8}$/);
    assert.equal('url' in result, false);
    assert.equal('verifier' in result, false);

    assert.deepEqual(await service.openAuthorizationUrl(result.authRequestId), { ok: true });
    const url = new URL(opened[0]!);
    assert.equal(url.origin + url.pathname, 'https://auth.x.ai/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:56121/callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('plan'), 'generic');
    assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    service.cancelAuthorization(result.authRequestId);
  });

  test('captures the loopback callback, exchanges the code, and persists tokens', async () => {
    const opened: string[] = [];
    const requests: Array<{ url: string; body: URLSearchParams }> = [];
    const store = memoryCredentialStore();
    const service = createService({
      opened,
      store,
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
        return Response.json({
          access_token: 'xai-access-token',
          refresh_token: 'xai-refresh-token',
          expires_in: 21_600,
          id_token: 'xai-id-token',
        });
      },
    });
    const authorization = await service.getAuthorizationUrl();
    assert.equal('ok' in authorization, false);
    if ('ok' in authorization) return;
    await service.openAuthorizationUrl(authorization.authRequestId);
    const state = new URL(opened[0]!).searchParams.get('state');
    assert.ok(state);

    const completion = service.completeAuthorization(authorization.authRequestId);
    const callback = await fetch(
      `http://127.0.0.1:56121/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 200);
    assert.deepEqual(await completion, { ok: true });

    assert.equal(requests[0]?.url, 'https://auth.x.ai/oauth2/token');
    assert.deepEqual(Object.fromEntries(requests[0]!.body), {
      grant_type: 'authorization_code',
      client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
      code: 'authorization-code',
      code_verifier: requests[0]!.body.get('code_verifier'),
      redirect_uri: 'http://127.0.0.1:56121/callback',
    });
    assert.match(requests[0]!.body.get('code_verifier') ?? '', /^[A-Za-z0-9_-]{43,128}$/);
    assert.deepEqual(await service.getAccountState(), {
      provider: 'xai-oauth',
      runtimeState: 'authenticated',
    });
    assert.equal(store.read()?.access_token, 'xai-access-token');
    assert.equal(store.read()?.refresh_token, 'xai-refresh-token');
  });

  test('rejects a mismatched callback state without consuming the pending login', async () => {
    const opened: string[] = [];
    const service = createService({ opened });
    const authorization = await service.getAuthorizationUrl();
    assert.equal('ok' in authorization, false);
    if ('ok' in authorization) return;
    await service.openAuthorizationUrl(authorization.authRequestId);

    const rejected = await fetch('http://127.0.0.1:56121/callback?code=stolen&state=wrong');
    assert.equal(rejected.status, 400);
    const state = new URL(opened[0]!).searchParams.get('state');
    assert.ok(state);
    const completion = service.completeAuthorization(authorization.authRequestId);
    await fetch(
      `http://127.0.0.1:56121/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    );
    assert.deepEqual(await completion, { ok: true });
  });

  test('maps provider denial and local cancellation to distinct safe outcomes', async () => {
    const opened: string[] = [];
    const denied = createService({ opened });
    const deniedAuth = await denied.getAuthorizationUrl();
    assert.equal('ok' in deniedAuth, false);
    if ('ok' in deniedAuth) return;
    await denied.openAuthorizationUrl(deniedAuth.authRequestId);
    const state = new URL(opened[0]!).searchParams.get('state');
    assert.ok(state);
    const denial = denied.completeAuthorization(deniedAuth.authRequestId);
    await fetch(
      `http://127.0.0.1:56121/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    assert.deepEqual(await denial, {
      ok: false,
      reason: 'authorization_denied',
      message: 'xAI 授权被拒绝，请重新登录并允许访问。',
    });

    const cancelled = createService();
    const cancelledAuth = await cancelled.getAuthorizationUrl();
    assert.equal('ok' in cancelledAuth, false);
    if ('ok' in cancelledAuth) return;
    const completion = cancelled.completeAuthorization(cancelledAuth.authRequestId);
    cancelled.cancelAuthorization(cancelledAuth.authRequestId);
    assert.deepEqual(await completion, {
      ok: false,
      reason: 'authorization_cancelled',
      message: 'xAI 授权已取消。',
    });
  });

  test('does not revive a cancelled authorization after the browser finishes opening', async () => {
    const browserOpened = deferred<void>();
    const service = new XaiOAuthService({
      credentialStore: memoryCredentialStore().store,
      openExternal: async () => browserOpened.promise,
      fetchFn: async () => assert.fail('a cancelled login must not exchange a token'),
    });
    const authorization = await service.getAuthorizationUrl();
    assert.equal('ok' in authorization, false);
    if ('ok' in authorization) return;
    const opening = service.openAuthorizationUrl(authorization.authRequestId);
    service.cancelAuthorization(authorization.authRequestId);
    browserOpened.resolve();

    assert.deepEqual(await opening, {
      ok: false,
      reason: 'authorization_cancelled',
      message: 'xAI 授权已取消。',
    });
    assert.deepEqual(await service.getAccountState(), {
      provider: 'xai-oauth',
      runtimeState: 'not_logged_in',
    });
  });

  test('expires an abandoned PKCE authorization', async () => {
    let now = 10_000;
    const service = createService({ now: () => now });
    const authorization = await service.getAuthorizationUrl();
    assert.equal('ok' in authorization, false);
    if ('ok' in authorization) return;
    now += PENDING_AUTHORIZATION_TTL_MS + 1;
    assert.deepEqual(await service.openAuthorizationUrl(authorization.authRequestId), {
      ok: false,
      reason: 'authorization_expired',
      message: 'xAI 授权请求已过期，请重新登录。',
    });
  });
});

function createService(input: {
  opened?: string[];
  store?: ReturnType<typeof memoryCredentialStore>;
  fetchFn?: typeof fetch;
  now?: () => number;
} = {}): XaiOAuthService {
  const store = input.store ?? memoryCredentialStore();
  return new XaiOAuthService({
    credentialStore: store.store,
    openExternal: async (url) => {
      input.opened?.push(url);
    },
    now: input.now,
    fetchFn: input.fetchFn ?? (async () =>
      Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 21_600,
      })),
  });
}

function memoryCredentialStore() {
  let stored: string | null = null;
  return {
    store: {
      getSecret: async () => stored,
      setSecret: async (_slug: string, _kind: 'oauth_token', value: string) => {
        stored = value;
      },
      deleteSecret: async () => {
        stored = null;
      },
      compareAndSetSecret: async (
        _slug: string,
        _kind: 'oauth_token',
        expected: string | null,
        value: string,
      ) => {
        if (stored !== expected) return { committed: false as const, current: stored };
        stored = value;
        return { committed: true as const };
      },
    },
    read: () => stored ? JSON.parse(stored) as Record<string, unknown> : null,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
