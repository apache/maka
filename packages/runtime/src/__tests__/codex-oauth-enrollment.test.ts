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
  exchangeCodexDeviceAuthorizationCode,
  pollCodexDeviceAuthorization,
  startCodexDeviceAuthorization,
} from '../codex-oauth-enrollment.js';

const NOW = 1_800_000_000_000;

test('Codex device enrollment requests a one-time user code from the official endpoints', async () => {
  const requests: string[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(String(url).endsWith('/api/accounts/deviceauth/usercode'), true);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
    return Response.json({
      device_auth_id: 'deviceauth_abc',
      user_code: 'CODE-1234',
      interval: '5',
      expires_at: new Date(NOW + 600_000).toISOString(),
    });
  };
  const authorization = await startCodexDeviceAuthorization({
    fetchFn,
    signal: new AbortController().signal,
    now: () => NOW,
  });
  assert.deepEqual(authorization, {
    deviceAuthId: 'deviceauth_abc',
    userCode: 'CODE-1234',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: NOW + 600_000,
    intervalMs: 5_000,
  });
  assert.equal(requests.length, 1);
});

test('Codex device enrollment rejects a failed usercode request', async () => {
  await assert.rejects(
    () =>
      startCodexDeviceAuthorization({
        fetchFn: async () => Response.json({ error: 'boom' }, { status: 500 }),
        signal: new AbortController().signal,
        now: () => NOW,
      }),
    (error: unknown) =>
      error instanceof OAuthTokenEndpointError && error.category === 'provider_rejected',
  );
});

test('Codex device polling retries through pending and returns the grant on approval', async () => {
  let polls = 0;
  const fetchFn: typeof fetch = async (url) => {
    if (String(url).endsWith('/deviceauth/token')) {
      polls += 1;
      if (polls === 1) {
        return Response.json(
          {
            error: {
              message: 'Device authorization is pending',
              code: 'deviceauth_authorization_pending',
            },
          },
          { status: 403 },
        );
      }
      return Response.json({
        authorization_code: 'device-auth-code',
        code_challenge: 'challenge',
        code_verifier: 'device-verifier',
      });
    }
    throw new Error(`Unexpected URL ${String(url)}`);
  };
  const authorization = {
    deviceAuthId: 'deviceauth_abc',
    userCode: 'CODE-1234',
    verificationUrl: 'https://auth.openai.com/codex/device',
    expiresAt: NOW + 60_000,
    intervalMs: 1_000,
  };
  const grant = await pollCodexDeviceAuthorization({
    authorization,
    fetchFn,
    signal: new AbortController().signal,
    now: () => NOW,
    sleep: async () => undefined,
  });
  assert.deepEqual(grant, {
    authorizationCode: 'device-auth-code',
    codeVerifier: 'device-verifier',
  });
  assert.equal(polls, 2);
});

test('Codex device polling stops once the device code expires', async () => {
  await assert.rejects(
    () =>
      pollCodexDeviceAuthorization({
        authorization: {
          deviceAuthId: 'deviceauth_expired',
          userCode: 'CODE-EXP',
          verificationUrl: 'https://auth.openai.com/codex/device',
          expiresAt: NOW - 1,
          intervalMs: 1_000,
        },
        fetchFn: async () => {
          throw new Error('must not be fetched');
        },
        signal: new AbortController().signal,
        now: () => NOW,
      }),
    (error: unknown) => error instanceof OAuthDeviceAuthorizationExpiredError,
  );
});

test('Codex device polling never issues a request after the window elapses mid-sleep', async () => {
  let polls = 0;
  let now = NOW;
  await assert.rejects(
    () =>
      pollCodexDeviceAuthorization({
        authorization: {
          deviceAuthId: 'deviceauth_mid',
          userCode: 'CODE-MID',
          verificationUrl: 'https://auth.openai.com/codex/device',
          expiresAt: NOW + 5_000,
          intervalMs: 5_000,
        },
        fetchFn: async () => {
          polls += 1;
          return Response.json(
            { error: { code: 'deviceauth_authorization_pending' } },
            { status: 403 },
          );
        },
        signal: new AbortController().signal,
        now: () => now,
        sleep: async () => {
          now = NOW + 10_000;
        },
      }),
    (error: unknown) => error instanceof OAuthDeviceAuthorizationExpiredError,
  );
  // One in-window poll happened; the post-sleep check must have stopped
  // the loop before a second (out-of-window) request.
  assert.equal(polls, 1);
});

test('Codex device polling completes an admitted request even if the caller cancels', async () => {
  const controller = new AbortController();
  let markAdmitted!: () => void;
  const admitted = new Promise<void>((resolve) => {
    markAdmitted = resolve;
  });
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const polling = pollCodexDeviceAuthorization({
    authorization: {
      deviceAuthId: 'deviceauth_admit',
      userCode: 'CODE-ADM',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: NOW + 60_000,
      intervalMs: 1_000,
    },
    fetchFn: async (_url, init) => {
      const requestSignal = init?.signal;
      assert.ok(requestSignal);
      markAdmitted();
      assert.equal(requestSignal.aborted, false);
      return response;
    },
    signal: controller.signal,
    now: () => NOW,
    sleep: async () => undefined,
    onPollAdmission: () => {
      markAdmitted();
    },
  });

  await admitted;
  controller.abort();
  resolveResponse(
    Response.json({
      authorization_code: 'late-but-in-window',
      code_challenge: 'c',
      code_verifier: 'v',
    }),
  );
  assert.deepEqual(await polling, {
    authorizationCode: 'late-but-in-window',
    codeVerifier: 'v',
  });
});

test('Codex device authorization code exchange posts to the token endpoint with the deviceauth redirect URI', async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const fetchFn: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), body: String(init?.body) });
    return Response.json({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id-token',
      expires_in: 3_600,
      token_type: 'Bearer',
    });
  };
  const tokens = await exchangeCodexDeviceAuthorizationCode({
    grant: { authorizationCode: 'device-auth-code', codeVerifier: 'device-verifier' },
    fetchFn,
    signal: new AbortController().signal,
    now: () => NOW,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://auth.openai.com/oauth/token');
  const form = new URLSearchParams(requests[0]!.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(form.get('code'), 'device-auth-code');
  assert.equal(form.get('code_verifier'), 'device-verifier');
  assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  assert.deepEqual(tokens, {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: NOW + 3_600_000,
    id_token: 'id-token',
    token_type: 'Bearer',
  });
});

test('Codex device authorization code exchange maps a rejected grant to provider_rejected', async () => {
  await assert.rejects(
    () =>
      exchangeCodexDeviceAuthorizationCode({
        grant: { authorizationCode: 'bad-code', codeVerifier: 'bad-verifier' },
        fetchFn: async () =>
          Response.json(
            { error: { message: 'Invalid code', type: 'invalid_request_error' } },
            { status: 400 },
          ),
        signal: new AbortController().signal,
        now: () => NOW,
      }),
    (error: unknown) =>
      error instanceof OAuthTokenEndpointError && error.category === 'provider_rejected',
  );
});

test('Codex device enrollment accepts the usercode alias', async () => {
  const authorization = await startCodexDeviceAuthorization({
    fetchFn: async () =>
      Response.json({
        device_auth_id: 'deviceauth-alias',
        usercode: 'ALIAS-CODE',
        interval: '5',
        expires_at: new Date(NOW + 600_000).toISOString(),
      }),
    signal: new AbortController().signal,
    now: () => NOW,
  });
  assert.equal(authorization.userCode, 'ALIAS-CODE');
});
