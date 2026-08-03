/**
 * Behavior tests for the OpenAI Codex subscription OAuth service
 * (device-code flow).
 *
 * The device-auth protocol endpoints/params are owned and pinned by
 * `@maka/runtime`'s codex-oauth-enrollment tests; this suite exercises
 * the desktop service through its public class surface: user-code
 * surfacing, browser opening, poll completion, expiry/cancellation
 * semantics, strict exchange validation, and shared-credential
 * persistence.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { base64urlEncode } from '@maka/core';
import { OpenAiCodexService } from '../oauth/openai-codex-service.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none' })));
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${header}.${body}.signature`;
}

// ---------------------------------------------------------------
// Behavior tests against a mocked fetch.
// ---------------------------------------------------------------

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

class FakeCredentialStore {
  private readonly map = new Map<string, string>();
  failSetSecret = false;
  async getSecret(slug: string, kind: string): Promise<string | null> {
    return this.map.get(`${slug}:${kind}`) ?? null;
  }
  async setSecret(slug: string, kind: string, value: string): Promise<void> {
    if (this.failSetSecret) throw new Error('simulated credential write failure');
    this.map.set(`${slug}:${kind}`, value);
  }
  async deleteSecret(slug: string, kind?: string): Promise<void> {
    this.map.delete(`${slug}:${kind}`);
  }
  async compareAndSetSecret(
    slug: string,
    kind: string,
    expected: string | null,
    value: string,
  ): Promise<{ committed: true } | { committed: false; current: string | null }> {
    const key = `${slug}:${kind}`;
    const current = this.map.get(key) ?? null;
    if (current !== expected) return { committed: false, current };
    this.map.set(key, value);
    return { committed: true };
  }
  dump(slug: string, kind: string): string | null {
    return this.map.get(`${slug}:${kind}`) ?? null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface DeviceHarnessOptions {
  usercode: Record<string, unknown>;
  usercodeStatus?: number;
  tokenPoll: Array<{ status: number; body: Record<string, unknown> }>;
  tokenExchange: { status: number; body: Record<string, unknown> };
  /** Called right before each poll sleep resolves; tests advance the clock here. */
  onSleep?: () => void;
}

interface DeviceHarness {
  service: OpenAiCodexService;
  requests: RecordedRequest[];
  openedUrls: string[];
  store: FakeCredentialStore;
  advance(ms: number): void;
}

const CLOCK_START = 1_800_000_000_000;

function createHarness(options: DeviceHarnessOptions): DeviceHarness {
  const requests: RecordedRequest[] = [];
  const openedUrls: string[] = [];
  const store = new FakeCredentialStore();
  let clock = CLOCK_START;
  let pollIndex = 0;

  const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers as Record<string, string>) ?? {})) {
      headers[key] = String(value);
    }
    let body: unknown = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, method: init.method ?? 'GET', headers, body });

    if (url.endsWith('/deviceauth/usercode')) {
      return jsonResponse(options.usercode, options.usercodeStatus ?? 200);
    }
    if (url.endsWith('/deviceauth/token')) {
      const step = options.tokenPoll[Math.min(pollIndex, options.tokenPoll.length - 1)]!;
      pollIndex += 1;
      return jsonResponse(step.body, step.status);
    }
    if (url.endsWith('/oauth/token')) {
      return jsonResponse(options.tokenExchange.body, options.tokenExchange.status);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const service = new OpenAiCodexService({
    userDataDir: '/tmp/maka-codex-device-test',
    openExternal: async (url) => {
      openedUrls.push(url);
    },
    credentialStore: store,
    fetchFn: fetchFn as unknown as typeof fetch,
    // Abortable sleep so cancellation can interrupt the poll loop.
    sleep: async (_ms, signal) => {
      options.onSleep?.();
      if (signal.aborted) throw signal.reason ?? new Error('Aborted');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 0);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (signal.aborted) throw signal.reason ?? new Error('Aborted');
    },
    now: () => clock,
  });

  return {
    service,
    requests,
    openedUrls,
    store,
    advance: (ms) => {
      clock += ms;
    },
  };
}

async function startLogin(h: DeviceHarness): Promise<{ authRequestId: string; stateHint: string }> {
  const payload = await h.service.getAuthorizationUrl();
  if (!('authRequestId' in payload)) {
    assert.fail(`expected authRequestId payload, got ${JSON.stringify(payload)}`);
  }
  const opened = await h.service.openAuthorizationUrl(payload.authRequestId);
  assert.deepEqual(opened, { ok: true });
  return { authRequestId: payload.authRequestId, stateHint: payload.stateHint };
}

describe('Codex device-auth login flow', () => {
  it('requests a one-time user code and surfaces it as stateHint', async () => {
    const h = createHarness({
      usercode: {
        device_auth_id: 'deviceauth_abc123',
        user_code: 'ABCD-1234',
        interval: '5',
        expires_at: '2099-01-01T00:00:00.000+00:00',
      },
      tokenPoll: [{ status: 200, body: { authorization_code: 'ac', code_verifier: 'v' } }],
      tokenExchange: { status: 200, body: {} },
    });
    const payload = await h.service.getAuthorizationUrl();
    if (!('authRequestId' in payload)) {
      assert.fail('expected authRequestId payload');
      return;
    }
    assert.equal(payload.stateHint, 'ABCD-1234');
    const usercodeReq = h.requests.find((r) => r.url.endsWith('/deviceauth/usercode'));
    assert.ok(usercodeReq);
    assert.equal(usercodeReq.method, 'POST');
    assert.deepEqual(usercodeReq.body, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
  });

  it('reports a usercode endpoint failure as a failed action result', async () => {
    const h = createHarness({
      usercode: {},
      usercodeStatus: 500,
      tokenPoll: [{ status: 200, body: {} }],
      tokenExchange: { status: 200, body: {} },
    });
    const result = await h.service.getAuthorizationUrl();
    assert.ok('ok' in result && result.ok === false);
    assert.equal(result.reason, 'token_exchange_failed');
  });

  it('opens the verify URL and completes the full device login', async () => {
    const h = createHarness({
      usercode: {
        device_auth_id: 'deviceauth_abc123',
        user_code: 'ABCD-1234',
        interval: '5',
        expires_at: '2099-01-01T00:00:00.000+00:00',
      },
      tokenPoll: [
        { status: 403, body: { error: { code: 'deviceauth_authorization_pending' } } },
        {
          status: 200,
          body: {
            authorization_code: 'authcode_xyz',
            code_challenge: 'challenge',
            code_verifier: 'verifier_123',
          },
        },
      ],
      tokenExchange: {
        status: 200,
        body: {
          access_token: makeJwt({
            sub: 'sub-ok',
            'https://api.openai.com/auth': { chatgpt_account_id: 'acct_ok' },
          }),
          refresh_token: 'refresh_ok',
          id_token: makeJwt({ email: 'dev@example.test' }),
          expires_in: 3600,
        },
      },
    });

    const { authRequestId } = await startLogin(h);
    // The verification page is the fixed server-owned device URL.
    assert.deepEqual(h.openedUrls, ['https://auth.openai.com/codex/device']);

    const complete = await h.service.completeAuthorization(authRequestId);
    assert.deepEqual(complete, { ok: true });

    // The device-auth protocol (poll body, exchange form, redirect URI) is
    // pinned by codex-oauth-enrollment.test.ts; here we only verify the
    // desktop lifecycle: pending retry then exchange happened and the
    // credential landed.
    const polls = h.requests.filter((r) => r.url.endsWith('/deviceauth/token'));
    assert.equal(polls.length, 2);
    assert.ok(h.requests.some((r) => r.url.endsWith('/oauth/token')));

    // Tokens persisted; account state reflects the claims.
    const state = await h.service.getAccountState();
    assert.equal(state.runtimeState, 'authenticated');
    assert.equal(state.accountId, 'acct_ok');
    assert.equal(state.email, 'dev@example.test');
  });

  it('times out while polling when the user never approves', async () => {
    const h = createHarness({
      usercode: {
        device_auth_id: 'deviceauth_expired',
        user_code: 'CODE-0001',
        interval: '5',
        expires_at: new Date(CLOCK_START + 5_000).toISOString(),
      },
      tokenPoll: [{ status: 403, body: { error: { code: 'deviceauth_authorization_pending' } } }],
      tokenExchange: { status: 200, body: {} },
      onSleep: () => h.advance(10_000),
    });
    const { authRequestId } = await startLogin(h);
    const complete = await h.service.completeAuthorization(authRequestId);
    assert.ok('ok' in complete && complete.ok === false);
    assert.equal(complete.reason, 'authorization_expired');
  });

  it('reports completion after cancellation as authorization_pending', async () => {
    const h = createHarness({
      usercode: {
        device_auth_id: 'deviceauth_cancel',
        user_code: 'CODE-0002',
        interval: '5',
        expires_at: '2099-01-01T00:00:00.000+00:00',
      },
      tokenPoll: [{ status: 403, body: { error: { code: 'deviceauth_authorization_pending' } } }],
      tokenExchange: { status: 200, body: {} },
    });
    const { authRequestId } = await startLogin(h);
    // Cancel aborts the poll and disposes the pending session; a later
    // completion reports the session is gone (matches the xAI service).
    h.service.cancelAuthorization(authRequestId);
    const complete = await h.service.completeAuthorization(authRequestId);
    assert.ok('ok' in complete && complete.ok === false);
    assert.equal(complete.reason, 'authorization_pending');
  });

  it('rejects completion before the verification page is opened', async () => {
    const h = createHarness({
      usercode: {
        device_auth_id: 'deviceauth_none',
        user_code: 'CODE-0003',
        interval: '5',
        expires_at: '2099-01-01T00:00:00.000+00:00',
      },
      tokenPoll: [{ status: 200, body: {} }],
      tokenExchange: { status: 200, body: {} },
    });
    const payload = await h.service.getAuthorizationUrl();
    if (!('authRequestId' in payload)) {
      assert.fail('expected authRequestId payload');
      return;
    }
    const complete = await h.service.completeAuthorization(payload.authRequestId);
    assert.ok('ok' in complete && complete.ok === false);
    assert.equal(complete.reason, 'authorization_pending');
  });

  it('rejects a malformed 200 exchange response without writing a credential', async () => {
    const h = createHarness({
      usercode: {
        device_auth_id: 'deviceauth_malformed',
        user_code: 'CODE-0004',
        interval: '5',
        expires_at: '2099-01-01T00:00:00.000+00:00',
      },
      tokenPoll: [{ status: 200, body: { authorization_code: 'ac', code_verifier: 'v' } }],
      // 200 but missing refresh_token / expires_in: must fail validation,
      // never report success and persist an unparseable credential.
      tokenExchange: { status: 200, body: { access_token: makeJwt({ sub: 'sub-malformed' }) } },
    });
    const { authRequestId } = await startLogin(h);
    const complete = await h.service.completeAuthorization(authRequestId);
    assert.ok('ok' in complete && complete.ok === false);
    assert.equal(complete.reason, 'token_exchange_failed');
    assert.equal(h.store.dump('codex-subscription', 'oauth_token'), null);
  });

  it('maps a device window expiry to the authorization_expired UI reason', async () => {
    const h = createHarness({
      usercode: {
        device_auth_id: 'deviceauth_expiremid',
        user_code: 'CODE-0005',
        interval: '5',
        expires_at: new Date(CLOCK_START + 5_000).toISOString(),
      },
      tokenPoll: [{ status: 403, body: { error: { code: 'deviceauth_authorization_pending' } } }],
      tokenExchange: { status: 200, body: {} },
      // The first (and only) poll returns pending; the sleep then advances
      // the clock past expiry. The no-fetch-after-expiry behavior itself is
      // pinned by codex-oauth-enrollment.test.ts; here we only assert the
      // desktop surfaces it as a user-facing expiry, not a rejection.
      onSleep: () => h.advance(10_000),
    });
    const { authRequestId } = await startLogin(h);
    const complete = await h.service.completeAuthorization(authRequestId);
    assert.ok('ok' in complete && complete.ok === false);
    assert.equal(complete.reason, 'authorization_expired');
  });

  it('reports a credential write failure as storage_failed without reporting success', async () => {
    const h = createHarness({
      usercode: {
        device_auth_id: 'deviceauth_storefail',
        user_code: 'CODE-0006',
        interval: '5',
        expires_at: '2099-01-01T00:00:00.000+00:00',
      },
      tokenPoll: [{ status: 200, body: { authorization_code: 'ac', code_verifier: 'v' } }],
      tokenExchange: {
        status: 200,
        body: {
          access_token: makeJwt({ sub: 'sub-storefail' }),
          refresh_token: 'refresh-storefail',
          expires_in: 3600,
        },
      },
    });
    h.store.failSetSecret = true;
    const { authRequestId } = await startLogin(h);
    const complete = await h.service.completeAuthorization(authRequestId);
    assert.ok('ok' in complete && complete.ok === false);
    assert.equal(complete.reason, 'storage_failed');
  });

  it('exchanges and persists a grant even when cancelled after the poll consumed it', async () => {
    const store = new FakeCredentialStore();
    let releasePoll!: (response: Response) => void;
    const pollResponse = new Promise<Response>((resolve) => {
      releasePoll = resolve;
    });
    let exchanges = 0;
    const service = new OpenAiCodexService({
      userDataDir: '/tmp/maka-codex-deferred',
      openExternal: async () => undefined,
      credentialStore: store,
      now: () => CLOCK_START,
      sleep: async () => undefined,
      fetchFn: async (url) => {
        if (String(url).endsWith('/deviceauth/usercode')) {
          return jsonResponse({
            device_auth_id: 'deviceauth-deferred',
            user_code: 'CODE-DEF',
            interval: '5',
            expires_at: new Date(CLOCK_START + 600_000).toISOString(),
          });
        }
        if (String(url).endsWith('/deviceauth/token')) {
          return pollResponse;
        }
        if (String(url).endsWith('/oauth/token')) {
          exchanges += 1;
          return jsonResponse({
            access_token: makeJwt({
              sub: 'sub-def',
              'https://api.openai.com/auth': { chatgpt_account_id: 'acct-def' },
            }),
            refresh_token: 'refresh-def',
            expires_in: 3600,
          });
        }
        throw new Error(`Unexpected fetch ${String(url)}`);
      },
    });
    const payload = await service.getAuthorizationUrl();
    if (!('authRequestId' in payload)) {
      assert.fail('expected authRequestId payload');
      return;
    }
    const opened = await service.openAuthorizationUrl(payload.authRequestId);
    assert.deepEqual(opened, { ok: true });
    const completion = service.completeAuthorization(payload.authRequestId);
    // The poll is in flight (admitted). Cancelling must not discard the
    // one-time authorization code once the poll has consumed it.
    service.cancelAuthorization(payload.authRequestId);
    releasePoll(
      jsonResponse({
        authorization_code: 'one-time-code',
        code_challenge: 'c',
        code_verifier: 'server-verifier',
      }),
    );
    assert.deepEqual(await completion, { ok: true });
    assert.equal(exchanges, 1);
    assert.ok(store.dump('codex-subscription', 'oauth_token') !== null);
  });
});
