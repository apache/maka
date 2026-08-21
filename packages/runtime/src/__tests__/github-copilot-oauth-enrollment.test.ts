import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OAuthTokenEndpointError } from '../oauth-login.js';
import { OAuthDeviceAuthorizationExpiredError } from '../oauth-provider-contracts.js';
import {
  pollGitHubCopilotDeviceAuthorization,
  startGitHubCopilotDeviceAuthorization,
  type GitHubCopilotDeviceAuthorization,
} from '../github-copilot-oauth-enrollment.js';

const NOW = 1_800_000_000_000;

function authorization(
  overrides: Partial<GitHubCopilotDeviceAuthorization> = {},
): GitHubCopilotDeviceAuthorization {
  return {
    deviceCode: 'device-code',
    userCode: 'ABCD-1234',
    verificationUrl: 'https://github.com/login/device',
    expiresAt: NOW + 900_000,
    intervalMs: 5_000,
    ...overrides,
  };
}

const immediateSleep = async () => {};

test('device authorization decodes the GitHub grant and bounds its window', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchFn: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), body: String(init?.body ?? '') });
    return Response.json({
      device_code: 'device-code',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
      // Additive provider fields must not close the decoder.
      verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
    });
  };

  const result = await startGitHubCopilotDeviceAuthorization({
    fetchFn,
    signal: new AbortController().signal,
    now: () => NOW,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://github.com/login/device/code');
  assert.match(requests[0]?.body ?? '', /client_id=Iv1\.b507a08c87ecfe98/);
  // Only read:user is requested: the grant must not be able to reach code.
  assert.match(requests[0]?.body ?? '', /scope=read%3Auser/);
  assert.deepEqual(result, {
    deviceCode: 'device-code',
    userCode: 'ABCD-1234',
    verificationUrl: 'https://github.com/login/device',
    expiresAt: NOW + 900_000,
    intervalMs: 5_000,
  });
});

test('device authorization rejects an error body returned with HTTP 200', async () => {
  const fetchFn: typeof fetch = async () => Response.json({ error: 'unauthorized_client' });
  await assert.rejects(
    startGitHubCopilotDeviceAuthorization({
      fetchFn,
      signal: new AbortController().signal,
      now: () => NOW,
    }),
    (error: unknown) =>
      error instanceof OAuthTokenEndpointError && error.category === 'provider_rejected',
  );
});

test('device authorization refuses a verification URL outside github.com', async () => {
  const fetchFn: typeof fetch = async () =>
    Response.json({
      device_code: 'device-code',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com.evil.example/login/device',
      expires_in: 900,
    });
  await assert.rejects(
    startGitHubCopilotDeviceAuthorization({
      fetchFn,
      signal: new AbortController().signal,
      now: () => NOW,
    }),
    (error: unknown) =>
      error instanceof OAuthTokenEndpointError && error.category === 'invalid_response',
  );
});

test('polling treats HTTP 200 authorization_pending and slow_down as retries', async () => {
  const delays: number[] = [];
  let polls = 0;
  const fetchFn: typeof fetch = async () => {
    polls += 1;
    if (polls === 1) return Response.json({ error: 'authorization_pending' });
    if (polls === 2) return Response.json({ error: 'slow_down', interval: 10 });
    return Response.json({ access_token: 'gho_account_token', token_type: 'bearer' });
  };

  const tokens = await pollGitHubCopilotDeviceAuthorization({
    authorization: authorization(),
    fetchFn,
    signal: new AbortController().signal,
    now: () => NOW,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(polls, 3);
  // The advertised slow_down interval replaces the previous cadence.
  assert.deepEqual(delays, [5_000, 5_000, 10_000]);
  assert.equal(tokens.access_token, 'gho_account_token');
  assert.equal(tokens.refresh_token, 'gho_account_token');
  assert.equal(tokens.base_url, 'https://api.githubcopilot.com');
});

test('polling rejects a token that is not a GitHub account credential', async () => {
  const fetchFn: typeof fetch = async () => Response.json({ access_token: 'ghp_classic_pat' });
  await assert.rejects(
    pollGitHubCopilotDeviceAuthorization({
      authorization: authorization(),
      fetchFn,
      signal: new AbortController().signal,
      now: () => NOW,
      sleep: immediateSleep,
    }),
    (error: unknown) =>
      error instanceof OAuthTokenEndpointError && error.category === 'invalid_response',
  );
});

test('polling separates a user denial from an elapsed authorization window', async () => {
  const denied: typeof fetch = async () => Response.json({ error: 'access_denied' });
  await assert.rejects(
    pollGitHubCopilotDeviceAuthorization({
      authorization: authorization(),
      fetchFn: denied,
      signal: new AbortController().signal,
      now: () => NOW,
      sleep: immediateSleep,
    }),
    (error: unknown) =>
      error instanceof OAuthTokenEndpointError && error.category === 'invalid_grant',
  );

  const expired: typeof fetch = async () => Response.json({ error: 'expired_token' });
  await assert.rejects(
    pollGitHubCopilotDeviceAuthorization({
      authorization: authorization(),
      fetchFn: expired,
      signal: new AbortController().signal,
      now: () => NOW,
      sleep: immediateSleep,
    }),
    (error: unknown) => error instanceof OAuthDeviceAuthorizationExpiredError,
  );
});

test('polling stops before issuing a request once the local window elapsed', async () => {
  let polls = 0;
  const fetchFn: typeof fetch = async () => {
    polls += 1;
    return Response.json({ access_token: 'gho_account_token' });
  };
  await assert.rejects(
    pollGitHubCopilotDeviceAuthorization({
      authorization: authorization({ expiresAt: NOW }),
      fetchFn,
      signal: new AbortController().signal,
      now: () => NOW,
      sleep: immediateSleep,
    }),
    (error: unknown) => error instanceof OAuthDeviceAuthorizationExpiredError,
  );
  assert.equal(polls, 0);
});
