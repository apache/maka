/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OAuthTokenEndpointError } from '../oauth-login.js';
import { OAuthDeviceAuthorizationExpiredError } from '../oauth-provider-contracts.js';
import {
  GitHubCopilotEntitlementError,
  GitHubCopilotEntitlementUnavailableError,
  pollGitHubCopilotDeviceAuthorization,
  startGitHubCopilotDeviceAuthorization,
  verifyGitHubCopilotModelEntitlement,
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

test('polling records the lifetime GitHub returned instead of a non-expiring token', async () => {
  const fetchFn: typeof fetch = async () =>
    Response.json({
      access_token: 'gho_expiring_token',
      expires_in: 28_800,
      refresh_token: 'ghr_renewal_token',
      refresh_token_expires_in: 15_897_600,
      token_type: 'bearer',
    });

  const tokens = await pollGitHubCopilotDeviceAuthorization({
    authorization: authorization(),
    fetchFn,
    signal: new AbortController().signal,
    now: () => NOW,
    sleep: immediateSleep,
  });

  assert.equal(tokens.access_token, 'gho_expiring_token');
  // The renewal credential must be the refresh token, not a copy of the access
  // token: without it the connection would die at expiry.
  assert.equal(tokens.refresh_token, 'ghr_renewal_token');
  assert.equal(tokens.expires_at, NOW + 28_800_000);
});

test('polling rejects an expiring grant that carries no refresh token', async () => {
  const fetchFn: typeof fetch = async () =>
    Response.json({ access_token: 'gho_expiring_token', expires_in: 28_800 });
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

const ENTITLED_TOKENS = {
  access_token: 'gho_account_token',
  refresh_token: 'gho_account_token',
  expires_at: Number.MAX_SAFE_INTEGER,
  base_url: 'https://api.githubcopilot.com',
};

function copilotModelsResponse(models: readonly { id: string }[]): Response {
  return Response.json({
    data: models.map((model) => ({
      ...model,
      model_picker_enabled: true,
      supported_endpoints: ['/responses'],
      policy: { state: 'enabled' },
      capabilities: {
        limits: { max_prompt_tokens: 128_000, max_output_tokens: 16_000 },
        supports: { tool_calls: true },
      },
    })),
  });
}

test('entitlement accepts an account whose catalog lists a usable model', async () => {
  await verifyGitHubCopilotModelEntitlement({
    tokens: ENTITLED_TOKENS,
    fetchFn: async () => copilotModelsResponse([{ id: 'gpt-5.4' }]),
  });
});

test('entitlement refuses an account the provider proved ineligible', async () => {
  // An empty catalog the account could read, and the two statuses that are the
  // provider refusing this account rather than failing to answer.
  const proofs: ReadonlyArray<() => Response> = [
    () => copilotModelsResponse([]),
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 403 }),
  ];
  for (const respond of proofs) {
    await assert.rejects(
      verifyGitHubCopilotModelEntitlement({
        tokens: ENTITLED_TOKENS,
        fetchFn: async () => respond(),
      }),
      (error: unknown) => error instanceof GitHubCopilotEntitlementError,
    );
  }
});

test('entitlement does not call a subscribed account ineligible when it cannot ask', async () => {
  // None of these say anything about the subscription. Reporting them as
  // ineligibility would send a paying user back through a device login that
  // was never the problem.
  const unanswered: ReadonlyArray<{ readonly status?: number; readonly fetchFn: typeof fetch }> = [
    { status: 429, fetchFn: async () => new Response(null, { status: 429 }) },
    { status: 500, fetchFn: async () => new Response(null, { status: 500 }) },
    { status: 503, fetchFn: async () => new Response(null, { status: 503 }) },
    {
      fetchFn: async () => {
        throw new DOMException('The operation was aborted', 'TimeoutError');
      },
    },
    {
      fetchFn: async () => {
        throw new TypeError('fetch failed');
      },
    },
    {
      fetchFn: async () =>
        new Response('not json', { headers: { 'content-type': 'application/json' } }),
    },
  ];
  for (const { status, fetchFn } of unanswered) {
    await assert.rejects(
      verifyGitHubCopilotModelEntitlement({ tokens: ENTITLED_TOKENS, fetchFn }),
      (error: unknown) =>
        error instanceof GitHubCopilotEntitlementUnavailableError &&
        !(error instanceof GitHubCopilotEntitlementError) &&
        error.status === status,
    );
  }
});
