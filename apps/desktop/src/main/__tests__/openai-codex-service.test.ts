/**
 * Static-analysis + behavior tests for the OpenAI Codex subscription
 * OAuth service (device-code flow).
 *
 * Pins the endpoints/params to the official codex CLI device-auth flow
 * (codex-rs login/src/device_code_auth.rs), plus the JWT account-id
 * extraction and the end-to-end device login behavior against a
 * mocked fetch.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CODEX_OAUTH_CONFIG,
  extractAccountClaims,
} from '../oauth/openai-codex-helpers.js';
import { base64urlEncode } from '@maka/core';
import { OpenAiCodexService } from '../oauth/openai-codex-service.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none' })));
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${header}.${body}.signature`;
}

describe('Codex OAuth config (official codex CLI device-auth flow)', () => {
  it('pins clientId, token endpoint, device-auth endpoints and verify URL', () => {
    assert.equal(CODEX_OAUTH_CONFIG.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(CODEX_OAUTH_CONFIG.tokenEndpoint, 'https://auth.openai.com/oauth/token');
    assert.equal(CODEX_OAUTH_CONFIG.deviceAuthBaseUrl, 'https://auth.openai.com/api/accounts');
    assert.equal(CODEX_OAUTH_CONFIG.deviceVerifyUrl, 'https://auth.openai.com/codex/device');
    assert.equal(
      CODEX_OAUTH_CONFIG.deviceRedirectUri,
      'https://auth.openai.com/deviceauth/callback',
    );
    assert.equal(CODEX_OAUTH_CONFIG.scopes, 'openid profile email offline_access');
  });
});

describe('Codex JWT account-id extraction', () => {
  it('reads the OpenAI-specific chatgpt_account_id claim from the access token', () => {
    const token = makeJwt({
      sub: 'fallback-sub',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_pinned' },
    });
    const claims = extractAccountClaims(token);
    assert.equal(claims.accountId, 'acct_pinned');
  });

  it('falls back to sub when the chatgpt_account_id claim is missing', () => {
    const token = makeJwt({ sub: 'fallback-sub-only' });
    const claims = extractAccountClaims(token);
    assert.equal(claims.accountId, 'fallback-sub-only');
  });

  it('extracts email + plan from the access token when present', () => {
    const token = makeJwt({
      sub: 'sub-1',
      email: 'user@example.test',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_x',
        chatgpt_plan_type: 'plus',
      },
    });
    const claims = extractAccountClaims(token);
    assert.equal(claims.email, 'user@example.test');
    assert.equal(claims.plan, 'plus');
    assert.equal(claims.accountId, 'acct_x');
  });

  it('fills picture + email from id_token when access token does not carry them', () => {
    const access = makeJwt({ sub: 'sub-2' });
    const id = makeJwt({
      picture: 'https://example.test/avatar.png',
      email: 'fill@example.test',
    });
    const claims = extractAccountClaims(access, id);
    assert.equal(claims.picture, 'https://example.test/avatar.png');
    assert.equal(claims.email, 'fill@example.test');
    assert.equal(claims.accountId, 'sub-2');
  });

  it('throws when neither token contains an account id', () => {
    const access = makeJwt({});
    assert.throws(() => extractAccountClaims(access), /account ID/i);
  });
});

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
  async getSecret(slug: string, kind: string): Promise<string | null> {
    return this.map.get(`${slug}:${kind}`) ?? null;
  }
  async setSecret(slug: string, kind: string, value: string): Promise<void> {
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
  advance(ms: number): void;
}

const CLOCK_START = 1_800_000_000_000;

function createHarness(options: DeviceHarnessOptions): DeviceHarness {
  const requests: RecordedRequest[] = [];
  const openedUrls: string[] = [];
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
    credentialStore: new FakeCredentialStore(),
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

    // Poll hit 403 (pending) then 200.
    const polls = h.requests.filter((r) => r.url.endsWith('/deviceauth/token'));
    assert.equal(polls.length, 2);
    assert.deepEqual(polls[0]!.body, { device_auth_id: 'deviceauth_abc123', user_code: 'ABCD-1234' });

    // Authorization-code exchange uses the deviceauth redirect URI + PKCE verifier.
    const exchange = h.requests.find((r) => r.url.endsWith('/oauth/token'));
    assert.ok(exchange);
    const form = new URLSearchParams(exchange.body as string);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(form.get('code'), 'authcode_xyz');
    assert.equal(form.get('code_verifier'), 'verifier_123');
    assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');

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
});
