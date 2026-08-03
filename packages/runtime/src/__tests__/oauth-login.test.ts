import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  OAUTH_LOGIN_MAX_RESPONSE_BYTES,
  OAUTH_LOGIN_MAX_TOKEN_CHARS,
  OAUTH_LOGIN_PROVIDER_CONFIG,
  OAuthTokenEndpointError,
  buildOAuthLoginAuthorization,
  decodeOAuthInitialTokenPayload,
  exchangeOAuthAuthorizationCode,
  isDeterministicOAuthCredentialRejection,
} from '../oauth-login.js';
import { isOAuthEnrollmentProviderEnabled } from '../oauth-provider-contracts.js';

const VERIFIER = 'v'.repeat(43);
const STATE = 's'.repeat(43);
const NOW = 1_800_000_000_000;

function assertEndpointError(
  error: unknown,
  category: OAuthTokenEndpointError['category'],
  status?: number,
): boolean {
  assert.ok(error instanceof OAuthTokenEndpointError);
  assert.equal(error.category, category);
  assert.equal(error.status, status);
  assert.deepEqual(Object.keys(error).sort(), ['category', 'name', 'status']);
  return true;
}

describe('OAuth login authorization', () => {
  it('builds Claude paste presentation with independent verifier and state', () => {
    const result = buildOAuthLoginAuthorization({
      provider: 'claude-subscription',
      verifier: VERIFIER,
      state: STATE,
    });
    const url = new URL(result.authorizationUrl);
    assert.equal(result.presentation, 'paste-code');
    assert.equal(
      url.origin + url.pathname,
      OAUTH_LOGIN_PROVIDER_CONFIG['claude-subscription'].authorizationEndpoint,
    );
    assert.equal(url.searchParams.get('state'), STATE);
    assert.notEqual(url.searchParams.get('state'), VERIFIER);
    assert.equal(url.searchParams.get('code'), 'true');
    assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
  });

  it('uses the caller-owned Codex loopback redirect in authorization URL', () => {
    const redirectUri = 'http://127.0.0.1:49152/oauth/callback';
    const result = buildOAuthLoginAuthorization({
      provider: 'openai-codex',
      verifier: VERIFIER,
      state: STATE,
      redirectUri,
    });
    const url = new URL(result.authorizationUrl);
    assert.equal(result.presentation, 'loopback');
    assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
    assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
    assert.equal(
      url.searchParams.get('scope'),
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
    );
  });

  it('pins xAI PKCE authorization to the allowlisted Grok CLI redirect', () => {
    const redirectUri = 'http://127.0.0.1:56121/callback';
    const result = buildOAuthLoginAuthorization({
      provider: 'xai-oauth',
      verifier: VERIFIER,
      state: STATE,
      redirectUri,
    });
    const url = new URL(result.authorizationUrl);
    assert.equal(result.presentation, 'loopback');
    assert.equal(url.origin + url.pathname, 'https://auth.x.ai/oauth2/authorize');
    assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(url.searchParams.get('plan'), 'generic');
    assert.equal(
      url.searchParams.get('scope'),
      'openid profile email offline_access grok-cli:access api:access',
    );
    assert.throws(
      () =>
        buildOAuthLoginAuthorization({
          provider: 'xai-oauth',
          verifier: VERIFIER,
          state: STATE,
          redirectUri: 'http://127.0.0.1:56122/callback',
        }),
      (error) => assertEndpointError(error, 'invalid_response'),
    );
  });

  it('rejects low-entropy state and non-loopback Codex redirects', () => {
    assert.throws(
      () =>
        buildOAuthLoginAuthorization({
          provider: 'claude-subscription',
          verifier: VERIFIER,
          state: 'short',
        }),
      (error) => assertEndpointError(error, 'invalid_response'),
    );
    assert.throws(
      () =>
        buildOAuthLoginAuthorization({
          provider: 'openai-codex',
          verifier: VERIFIER,
          state: STATE,
          redirectUri: 'https://example.test/callback',
        }),
      (error) => assertEndpointError(error, 'invalid_response'),
    );
  });
});

describe('OAuth initial token decoder', () => {
  it('accepts a closed Claude token record and computes a finite expiry', () => {
    assert.deepEqual(
      decodeOAuthInitialTokenPayload(
        'claude-subscription',
        {
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'user:sessions:claude_code',
          account: { uuid: 'account-1' },
        },
        NOW,
      ),
      {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: NOW + 3_600_000,
        token_type: 'Bearer',
        scope: 'user:sessions:claude_code',
        account_uuid: 'account-1',
      },
    );
  });

  it('ignores additive provider fields while validating bounded token fields', () => {
    const base = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 };
    assert.deepEqual(
      decodeOAuthInitialTokenPayload(
        'openai-codex',
        { ...base, provider_extension: { rollout: 'next' } },
        NOW,
      ),
      {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: NOW + 3_600_000,
      },
    );
    for (const payload of [
      { ...base, access_token: 'x'.repeat(OAUTH_LOGIN_MAX_TOKEN_CHARS + 1) },
      { ...base, id_token: 'x'.repeat(OAUTH_LOGIN_MAX_TOKEN_CHARS + 1) },
      { ...base, expires_in: 0 },
      { ...base, expires_in: Number.POSITIVE_INFINITY },
    ]) {
      assert.throws(
        () => decodeOAuthInitialTokenPayload('openai-codex', payload, NOW),
        (error) => assertEndpointError(error, 'invalid_response'),
      );
    }
  });
});

describe('OAuth enrollment policy', () => {
  it('honors Claude and Codex opt-out flags while keeping xAI enabled', () => {
    const environment = {
      MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL: '0',
      MAKA_CODEX_SUBSCRIPTION_EXPERIMENTAL: '0',
    };
    assert.equal(isOAuthEnrollmentProviderEnabled('claude-subscription', environment), false);
    assert.equal(isOAuthEnrollmentProviderEnabled('openai-codex', environment), false);
    assert.equal(isOAuthEnrollmentProviderEnabled('xai-oauth', environment), true);
    assert.equal(isOAuthEnrollmentProviderEnabled('claude-subscription', {}), true);
    assert.equal(isOAuthEnrollmentProviderEnabled('openai-codex', {}), true);
  });
});

describe('OAuth initial code exchange', () => {
  it('exchanges Codex code through a real Response and preserves the supplied redirect', async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      request = { url: String(url), init };
      return new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          id_token: 'id-token',
          expires_in: 120,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    };
    const redirectUri = 'http://localhost:43123/auth/callback';
    const tokens = await exchangeOAuthAuthorizationCode({
      provider: 'openai-codex',
      code: 'authorization-code',
      verifier: VERIFIER,
      state: STATE,
      redirectUri,
      signal: new AbortController().signal,
      fetchFn,
      now: () => NOW,
    });
    assert.equal(tokens.expires_at, NOW + 120_000);
    assert.equal(request?.url, OAUTH_LOGIN_PROVIDER_CONFIG['openai-codex'].tokenEndpoint);
    const body = new URLSearchParams(String(request?.init?.body));
    assert.equal(body.get('redirect_uri'), redirectUri);
    assert.equal(body.get('code_verifier'), VERIFIER);
  });

  it('bounds a streamed response even without content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(OAUTH_LOGIN_MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await assert.rejects(
      exchangeOAuthAuthorizationCode({
        provider: 'claude-subscription',
        code: 'authorization-code',
        verifier: VERIFIER,
        state: STATE,
        signal: new AbortController().signal,
        fetchFn: async () => new Response(stream),
      }),
      (error) => assertEndpointError(error, 'response_too_large', 200),
    );
  });

  it('classifies a success response stream failure before EOF as outcome unknown', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode('{"access_token":"partial'));
          return;
        }
        controller.error(new Error('connection lost'));
      },
    });
    await assert.rejects(
      exchangeOAuthAuthorizationCode({
        provider: 'claude-subscription',
        code: 'authorization-code',
        verifier: VERIFIER,
        state: STATE,
        signal: new AbortController().signal,
        fetchFn: async () => new Response(stream),
      }),
      (error) => assertEndpointError(error, 'outcome_unknown', 200),
    );
  });

  it('classifies invalid JSON received through EOF as an invalid response', async () => {
    await assert.rejects(
      exchangeOAuthAuthorizationCode({
        provider: 'claude-subscription',
        code: 'authorization-code',
        verifier: VERIFIER,
        state: STATE,
        signal: new AbortController().signal,
        fetchFn: async () => new Response('{not-json'),
      }),
      (error) => assertEndpointError(error, 'invalid_response', 200),
    );
  });

  it('does not await cancellation when an oversized stream never settles cancel', {
    timeout: 1_000,
  }, async () => {
    let cancelCalls = 0;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(OAUTH_LOGIN_MAX_RESPONSE_BYTES + 1));
      },
      cancel() {
        cancelCalls += 1;
        markCancelStarted();
        return new Promise<void>(() => undefined);
      },
    });
    await assert.rejects(
      exchangeOAuthAuthorizationCode({
        provider: 'claude-subscription',
        code: 'authorization-code',
        verifier: VERIFIER,
        state: STATE,
        signal: new AbortController().signal,
        fetchFn: async () => new Response(stream),
      }),
      (error) => assertEndpointError(error, 'response_too_large', 200),
    );
    await cancelStarted;
    assert.equal(cancelCalls, 1);
  });

  it('classifies invalid_grant without retaining provider response text', async () => {
    await assert.rejects(
      exchangeOAuthAuthorizationCode({
        provider: 'claude-subscription',
        code: 'authorization-code',
        verifier: VERIFIER,
        state: STATE,
        signal: new AbortController().signal,
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'sensitive provider detail',
            }),
            { status: 400 },
          ),
      }),
      (error) => {
        assertEndpointError(error, 'invalid_grant', 400);
        assert.equal(isDeterministicOAuthCredentialRejection(error), true);
        assert.doesNotMatch(String(error), /sensitive provider detail/);
        return true;
      },
    );
  });

  it('marks reply loss after dispatch as outcome unknown', async () => {
    await assert.rejects(
      exchangeOAuthAuthorizationCode({
        provider: 'openai-codex',
        code: 'authorization-code',
        verifier: VERIFIER,
        state: STATE,
        redirectUri: 'http://localhost:43123/auth/callback',
        signal: new AbortController().signal,
        fetchFn: async () => {
          throw new TypeError('socket closed after write');
        },
      }),
      (error) => assertEndpointError(error, 'outcome_unknown'),
    );
  });

  it('does not await stream cancellation at the bounded timeout', {
    timeout: 1_000,
  }, async () => {
    let cancelCalls = 0;
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      markCancelStarted = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        markCancelStarted();
        return new Promise<void>(() => undefined);
      },
    });
    await assert.rejects(
      exchangeOAuthAuthorizationCode({
        provider: 'claude-subscription',
        code: 'authorization-code',
        verifier: VERIFIER,
        state: STATE,
        signal: new AbortController().signal,
        fetchFn: async () => new Response(stream),
        timeoutMs: 5,
      }),
      (error) => assertEndpointError(error, 'outcome_unknown', 200),
    );
    await cancelStarted;
    assert.equal(cancelCalls, 1);
  });
});
