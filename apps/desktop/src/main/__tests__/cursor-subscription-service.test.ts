/**
 * Static-analysis + unit tests for the Cursor subscription OAuth
 * service (PR-MODEL-OAUTH-ALL-0).
 *
 * Pins the login URL params, poll URL shape and refresh URL to
 * the upstream cursor-auth values.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import {
  CURSOR_OAUTH_CONFIG,
  buildCursorLoginUrl,
  getTokenExpiry,
  pkceChallengeFromVerifier,
} from '../oauth/cursor-subscription-helpers.js';
import { base64urlEncode } from '@maka/core';

describe('Cursor subscription OAuth config (upstream cursor-auth pattern)', () => {
  it('pins login / poll / refresh URLs to upstream cursor-auth values', () => {
    assert.equal(CURSOR_OAUTH_CONFIG.loginUrl, 'https://cursor.com/loginDeepControl');
    assert.equal(CURSOR_OAUTH_CONFIG.pollUrl, 'https://api2.cursor.sh/auth/poll');
    assert.equal(
      CURSOR_OAUTH_CONFIG.refreshUrl,
      'https://api2.cursor.sh/auth/exchange_user_api_key',
    );
  });

  it('mirrors upstream poll cadence: 1s baseline, 1.2x backoff, 10s cap, 150 attempts', () => {
    assert.equal(CURSOR_OAUTH_CONFIG.pollBaseDelayMs, 1000);
    assert.equal(CURSOR_OAUTH_CONFIG.pollMaxDelayMs, 10_000);
    assert.equal(CURSOR_OAUTH_CONFIG.pollBackoffMultiplier, 1.2);
    assert.equal(CURSOR_OAUTH_CONFIG.pollMaxAttempts, 150);
  });

  it('built login URL includes challenge, uuid, mode=login, redirectTarget=cli', () => {
    const url = new URL(
      buildCursorLoginUrl({
        loginUrl: CURSOR_OAUTH_CONFIG.loginUrl,
        challenge: 'pinned-challenge',
        uuid: 'pinned-uuid',
      }),
    );
    assert.equal(url.origin + url.pathname, CURSOR_OAUTH_CONFIG.loginUrl);
    assert.equal(url.searchParams.get('challenge'), 'pinned-challenge');
    assert.equal(url.searchParams.get('uuid'), 'pinned-uuid');
    assert.equal(url.searchParams.get('mode'), 'login');
    assert.equal(url.searchParams.get('redirectTarget'), 'cli');
  });

  it('PKCE challenge is base64url(SHA256(verifier))', () => {
    const verifier = 'fixed-cursor-verifier-7890';
    const got = pkceChallengeFromVerifier(verifier);
    const expected = base64urlEncode(
      new Uint8Array(createHash('sha256').update(verifier, 'utf8').digest()),
    );
    assert.equal(got, expected);
    assert.match(got, /^[A-Za-z0-9_-]+$/);
  });

  it('getTokenExpiry returns exp - 5 min when JWT has an exp claim', () => {
    // exp is in seconds; bake a future timestamp 1 hour out.
    const now = 1_700_000_000_000;
    const futureExpSeconds = Math.floor(now / 1000) + 3600;
    const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256' })));
    const payload = base64urlEncode(
      new TextEncoder().encode(JSON.stringify({ exp: futureExpSeconds })),
    );
    const token = `${header}.${payload}.sig`;
    const expiry = getTokenExpiry(token, now);
    assert.equal(expiry, futureExpSeconds * 1000 - 5 * 60 * 1000);
  });

  it('getTokenExpiry falls back to now + 1h when JWT is malformed', () => {
    const now = 1_700_000_000_000;
    const expiry = getTokenExpiry('not-a-jwt', now);
    assert.equal(expiry, now + 3600 * 1000);
  });
});
