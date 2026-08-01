import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE,
  ANTIGRAVITY_OAUTH_CONFIG,
  GOOGLE_CLIENT_ID,
  buildAntigravityAuthorizationUrl,
} from '../oauth/antigravity-subscription-helpers.js';
import { AntigravitySubscriptionService } from '../oauth/antigravity-subscription-service.js';

describe('Antigravity subscription preview', () => {
  it('keeps the unconfigured preview on the standard Google PKCE flow', () => {
    assert.equal(GOOGLE_CLIENT_ID, '');
    assert.equal(ANTIGRAVITY_OAUTH_CONFIG.status, 'preview');
    assert.equal(ANTIGRAVITY_OAUTH_CONFIG.hasClientId, false);

    const url = new URL(
      buildAntigravityAuthorizationUrl({
        clientId: 'fixture-client',
        authorizeEndpoint: ANTIGRAVITY_OAUTH_CONFIG.authUrl,
        redirectUri: ANTIGRAVITY_OAUTH_CONFIG.redirectUri,
        scope: ANTIGRAVITY_OAUTH_CONFIG.scopes,
        state: 'pinned-state',
        challenge: 'pinned-challenge',
      }),
    );
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'pinned-state');
  });

  it('fails closed through the public API while no client id is bundled', async () => {
    const service = new AntigravitySubscriptionService({
      userDataDir: '/unused',
      openExternal: async () => undefined,
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async () => {},
      },
    });

    const result = await service.getAuthorizationUrl();
    assert.deepEqual(result, ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE);
    assert.equal(result.ok, false);
    assert.match(result.message, /Google client_id/);
  });
});
