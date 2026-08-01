import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  XaiOAuthService,
  type XaiOAuthServiceDeps,
} from '../oauth/xai-oauth-service.js';

describe('XaiOAuthService', () => {
  test('starts RFC 8628 device authorization without exposing the verification URL or device code', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const service = new XaiOAuthService({
      credentialStore: memoryCredentialStore(),
      openExternal: async () => assert.fail('start must not open the browser'),
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return Response.json({
          device_code: 'secret-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://x.ai/device',
          verification_uri_complete: 'https://x.ai/device?user_code=ABCD-EFGH',
          expires_in: 900,
          interval: 5,
        });
      },
    });

    const result = await service.getAuthorizationUrl();

    assert.equal('ok' in result, false);
    if ('ok' in result) return;
    assert.equal(result.stateHint, 'ABCD-EFGH');
    assert.equal(typeof result.authRequestId, 'string');
    assert.equal('url' in result, false);
    assert.equal('device_code' in result, false);
    assert.deepEqual(requests, [
      {
        url: 'https://auth.x.ai/oauth2/device/code',
        body: new URLSearchParams({
          client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
          scope: 'openid profile email offline_access grok-cli:access api:access',
          referrer: 'maka',
        }).toString(),
      },
    ]);
  });

  test('opens the trusted complete URL and handles pending, slowdown, and token persistence', async () => {
    const opened: string[] = [];
    const delays: number[] = [];
    const tokenBodies: string[] = [];
    let tokenAttempt = 0;
    const store = memoryCredentialStore();
    const service = new XaiOAuthService({
      credentialStore: store,
      openExternal: async (url) => {
        opened.push(url);
      },
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      now: () => 10_000,
      fetchFn: async (url, init) => {
        if (String(url).endsWith('/device/code')) {
          return Response.json({
            device_code: 'secret-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://x.ai/device',
            verification_uri_complete: 'https://x.ai/device?user_code=ABCD-EFGH',
            expires_in: 900,
            interval: 5,
          });
        }
        tokenBodies.push(String(init?.body));
        tokenAttempt += 1;
        if (tokenAttempt === 1) {
          return Response.json({ error: 'authorization_pending' }, { status: 400 });
        }
        if (tokenAttempt === 2) {
          return Response.json({ error: 'slow_down' }, { status: 400 });
        }
        return Response.json({
          access_token: 'xai-access-token',
          refresh_token: 'xai-refresh-token',
          expires_in: 3_600,
          token_type: 'Bearer',
          scope: 'openid offline_access grok-cli:access api:access',
        });
      },
    });

    const authorization = await service.getAuthorizationUrl();
    assert.equal('ok' in authorization, false);
    if ('ok' in authorization) return;
    assert.deepEqual(await service.openAuthorizationUrl(authorization.authRequestId), { ok: true });
    assert.deepEqual(await service.completeAuthorization(authorization.authRequestId), { ok: true });

    assert.deepEqual(opened, ['https://x.ai/device?user_code=ABCD-EFGH']);
    assert.deepEqual(delays, [5_000, 5_000, 10_000]);
    assert.deepEqual(
      tokenBodies.map((body) => Object.fromEntries(new URLSearchParams(body))),
      Array.from({ length: 3 }, () => ({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
        device_code: 'secret-device-code',
      })),
    );
    const state = await service.getAccountState();
    assert.deepEqual(state, { provider: 'xai-oauth', runtimeState: 'authenticated' });
    assert.equal('access_token' in state, false);
    assert.equal('refresh_token' in state, false);
  });

  test('rejects a provider-supplied verification URL outside the xAI HTTPS allowlist', async () => {
    const service = new XaiOAuthService({
      credentialStore: memoryCredentialStore(),
      openExternal: async () => assert.fail('an untrusted URL must never be opened'),
      fetchFn: async () =>
        Response.json({
          device_code: 'secret-device-code',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://example.com/device',
          expires_in: 900,
        }),
    });

    const result = await service.getAuthorizationUrl();
    assert.deepEqual(result, {
      ok: false,
      reason: 'token_exchange_failed',
      message: 'xAI 返回了不受信任的授权地址。',
    });
  });

  test('maps provider denial and local cancellation to distinct safe outcomes', async () => {
    const create = (tokenResponse: () => Promise<Response>, sleep: XaiOAuthServiceDeps['sleep']) =>
      new XaiOAuthService({
        credentialStore: memoryCredentialStore(),
        openExternal: async () => undefined,
        sleep,
        fetchFn: async (url) =>
          String(url).endsWith('/device/code')
            ? Response.json({
                device_code: 'secret-device-code',
                user_code: 'ABCD-EFGH',
                verification_uri: 'https://x.ai/device',
                expires_in: 900,
                interval: 5,
              })
            : tokenResponse(),
      });

    const denied = create(
      async () => Response.json({ error: 'access_denied' }, { status: 400 }),
      async () => undefined,
    );
    const deniedAuth = await denied.getAuthorizationUrl();
    assert.equal('ok' in deniedAuth, false);
    if ('ok' in deniedAuth) return;
    await denied.openAuthorizationUrl(deniedAuth.authRequestId);
    assert.deepEqual(await denied.completeAuthorization(deniedAuth.authRequestId), {
      ok: false,
      reason: 'authorization_denied',
      message: 'xAI 授权被拒绝，请重新登录并允许访问。',
    });

    const cancelled = create(
      async () => assert.fail('cancellation during the wait must not poll the token endpoint'),
      async (_delayMs, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
        }),
    );
    const cancelledAuth = await cancelled.getAuthorizationUrl();
    assert.equal('ok' in cancelledAuth, false);
    if ('ok' in cancelledAuth) return;
    await cancelled.openAuthorizationUrl(cancelledAuth.authRequestId);
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
    let pollAttempts = 0;
    const service = new XaiOAuthService({
      credentialStore: memoryCredentialStore(),
      openExternal: async () => browserOpened.promise,
      sleep: async () => {
        pollAttempts += 1;
      },
      fetchFn: async (url) => {
        if (String(url).endsWith('/device/code')) {
          return Response.json({
            device_code: 'secret-device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://x.ai/device',
            expires_in: 900,
            interval: 5,
          });
        }
        return assert.fail('a cancelled authorization must not poll the token endpoint');
      },
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
    assert.equal(pollAttempts, 0);
    assert.deepEqual(await service.getAccountState(), {
      provider: 'xai-oauth',
      runtimeState: 'not_logged_in',
    });
  });

  test('maps an expired device code to the expiry outcome', async () => {
    const service = new XaiOAuthService({
      credentialStore: memoryCredentialStore(),
      openExternal: async () => undefined,
      sleep: async () => undefined,
      fetchFn: async (url) =>
        String(url).endsWith('/device/code')
          ? Response.json({
              device_code: 'secret-device-code',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://accounts.x.ai/oauth2/device',
              expires_in: 900,
              interval: 5,
            })
          : Response.json({ error: 'expired_token' }, { status: 400 }),
    });

    const authorization = await service.getAuthorizationUrl();
    assert.equal('ok' in authorization, false);
    if ('ok' in authorization) return;
    await service.openAuthorizationUrl(authorization.authRequestId);
    assert.deepEqual(await service.completeAuthorization(authorization.authRequestId), {
      ok: false,
      reason: 'authorization_expired',
      message: 'xAI 授权请求已过期，请重新登录。',
    });
  });
});

function memoryCredentialStore() {
  let stored: string | null = null;
  return {
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
