import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { googleApiUrl, googleV1BetaBaseUrl } from '../provider-urls.js';

describe('googleV1BetaBaseUrl', () => {
  // Force a single /v1beta suffix so a bare-root override self-heals and an
  // already-versioned root is idempotent.

  test('normalizes bare-root / versioned / trailing-slash / custom-proxy inputs to a single /v1beta', () => {
    const root = 'https://generativelanguage.googleapis.com';
    assert.equal(
      googleV1BetaBaseUrl(root),
      `${root}/v1beta`,
      'bare root gains /v1beta (self-heal)',
    );
    assert.equal(
      googleV1BetaBaseUrl(`${root}/v1beta`),
      `${root}/v1beta`,
      'already-versioned root is idempotent',
    );
    assert.equal(
      googleV1BetaBaseUrl(`${root}/`),
      `${root}/v1beta`,
      'trailing slash is stripped before re-appending /v1beta',
    );
    assert.equal(
      googleV1BetaBaseUrl(`${root}/v1beta/`),
      `${root}/v1beta`,
      'trailing slash on a versioned root is stripped',
    );
    assert.equal(
      googleV1BetaBaseUrl('https://my-gemini-proxy.example.com/v1beta'),
      'https://my-gemini-proxy.example.com/v1beta',
      'already-versioned custom override is idempotent',
    );
    assert.equal(
      googleV1BetaBaseUrl('https://my-gemini-proxy.example.com/'),
      'https://my-gemini-proxy.example.com/v1beta',
      'custom override omitting /v1beta gets it filled in',
    );
  });

  test('does not double /v1beta', () => {
    assert.equal(
      googleV1BetaBaseUrl('https://generativelanguage.googleapis.com/v1beta'),
      'https://generativelanguage.googleapis.com/v1beta',
      'a single /v1beta stays single',
    );
  });
});

describe('googleApiUrl', () => {
  test('appends a path + ?key= to a /v1beta base URL without doubling the version segment', () => {
    const root = 'https://generativelanguage.googleapis.com/v1beta';
    assert.equal(
      googleApiUrl(root, '/models', 'k'),
      `${root}/models?key=k`,
      'versioned root + path, no doubled /v1beta',
    );
    assert.equal(
      googleApiUrl(`${root}/`, '/models', 'k'),
      `${root}/models?key=k`,
      'trailing slash on base URL is stripped',
    );
    assert.equal(
      googleApiUrl(root, 'models', 'k'),
      `${root}/models?key=k`,
      'path without a leading slash gets one',
    );
    assert.equal(
      googleApiUrl(root, '/models/gemini-2.5-flash:generateContent', 'k'),
      `${root}/models/gemini-2.5-flash:generateContent?key=k`,
      'generateContent probe path is preserved',
    );
    assert.equal(
      googleApiUrl(root, '/models', 'k ey+'),
      `${root}/models?key=k%20ey%2B`,
      'api key is URL-encoded into the query string',
    );
  });

  test('normalizes a bare-root base URL to /v1beta so a stale stored default self-heals', () => {
    const bare = 'https://generativelanguage.googleapis.com';
    assert.equal(
      googleApiUrl(bare, '/models', 'k'),
      'https://generativelanguage.googleapis.com/v1beta/models?key=k',
      'bare root is normalized to /v1beta before the path is appended',
    );
  });
});
