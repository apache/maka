/**
 * Static-analysis + unit tests for the OpenAI Codex subscription
 * OAuth service (PR-MODEL-OAUTH-ALL-0).
 *
 * Pins the params (clientId, scopes, extras, redirect URI, PKCE
 * shape) to the upstream openai-codex-auth values, plus the JWT
 * account-id extraction.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import {
  CODEX_OAUTH_CONFIG,
  buildCodexAuthorizationUrl,
  extractAccountClaims,
  pkceChallengeFromVerifier,
} from '../oauth/openai-codex-helpers.js';
import { base64urlEncode } from '@maka/core';

describe('Codex subscription OAuth config (upstream openai-codex-auth pattern)', () => {
  it('pins clientId, endpoints, redirect URI, scopes and extras', () => {
    assert.equal(CODEX_OAUTH_CONFIG.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(CODEX_OAUTH_CONFIG.authUrl, 'https://auth.openai.com/oauth/authorize');
    assert.equal(CODEX_OAUTH_CONFIG.tokenUrl, 'https://auth.openai.com/oauth/token');
    assert.equal(CODEX_OAUTH_CONFIG.redirectUri, 'http://localhost:1455/auth/callback');
    assert.equal(CODEX_OAUTH_CONFIG.scopes, 'openid profile email offline_access');
    assert.equal(CODEX_OAUTH_CONFIG.callbackPort, 1455);
    const extrasMap = new Map(CODEX_OAUTH_CONFIG.extras);
    assert.equal(extrasMap.get('codex_cli_simplified_flow'), 'true');
    assert.equal(extrasMap.get('originator'), 'codex_cli_rs');
  });

  it('built authorize URL includes every required parameter', () => {
    const url = new URL(
      buildCodexAuthorizationUrl({
        clientId: CODEX_OAUTH_CONFIG.clientId,
        authorizeEndpoint: CODEX_OAUTH_CONFIG.authUrl,
        redirectUri: CODEX_OAUTH_CONFIG.redirectUri,
        scope: CODEX_OAUTH_CONFIG.scopes,
        state: 'pinned-state',
        challenge: 'pinned-challenge',
        extras: CODEX_OAUTH_CONFIG.extras,
      }),
    );
    assert.equal(url.origin + url.pathname, CODEX_OAUTH_CONFIG.authUrl);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), CODEX_OAUTH_CONFIG.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), CODEX_OAUTH_CONFIG.redirectUri);
    assert.equal(url.searchParams.get('scope'), CODEX_OAUTH_CONFIG.scopes);
    assert.equal(url.searchParams.get('code_challenge'), 'pinned-challenge');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'pinned-state');
    assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
    assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
  });

  it('PKCE challenge matches the standard S256 transform (RFC 7636 §4.2)', () => {
    const verifier = 'fixed-pkce-verifier-1234567890';
    const got = pkceChallengeFromVerifier(verifier);
    const expected = base64urlEncode(
      new Uint8Array(createHash('sha256').update(verifier, 'utf8').digest()),
    );
    assert.equal(got, expected);
    // The expected value should be base64url (no padding, only A-Za-z0-9_-).
    assert.match(got, /^[A-Za-z0-9_-]+$/);
  });
});

describe('Codex JWT account-id extraction', () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none' })));
    const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    return `${header}.${body}.signature`;
  }

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

  it('prefers ChatGPT organization/account claims over JWT sub for backend account routing', () => {
    const access = makeJwt({ sub: 'sub-not-chatgpt-account' });
    const id = makeJwt({
      sub: 'id-sub-not-chatgpt-account',
      organizations: [{ id: 'org_chatgpt_account' }],
    });
    const claims = extractAccountClaims(access, id);
    assert.equal(claims.accountId, 'org_chatgpt_account');
  });

  it('throws when neither token contains an account id', () => {
    const access = makeJwt({});
    assert.throws(() => extractAccountClaims(access), /account ID/i);
  });
});
