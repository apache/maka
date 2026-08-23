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
  pollXaiDeviceAuthorization,
  startXaiDeviceAuthorization,
} from '../xai-oauth-enrollment.js';

const NOW = 1_800_000_000_000;

test('xAI device enrollment bounds authorization and polls through provider backoff', async () => {
  const requests: string[] = [];
  let polls = 0;
  const fetchFn: typeof fetch = async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/device/code')) {
      return Response.json({
        device_code: 'device-code',
        user_code: 'USER-CODE',
        verification_uri_complete: 'https://accounts.x.ai/device?code=USER-CODE',
        expires_in: 600,
        interval: 1,
        provider_extension: { version: 2 },
      });
    }
    polls += 1;
    if (polls === 1) return Response.json({ error: 'authorization_pending' }, { status: 400 });
    if (polls === 2) return Response.json({ error: 'slow_down' }, { status: 400 });
    return Response.json({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3_600,
      token_type: 'Bearer',
      provider_extension: true,
    });
  };
  const signal = new AbortController().signal;
  const authorization = await startXaiDeviceAuthorization({
    fetchFn,
    signal,
    now: () => NOW,
  });
  const delays: number[] = [];
  const tokens = await pollXaiDeviceAuthorization({
    authorization,
    fetchFn,
    signal,
    now: () => NOW,
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  assert.equal(authorization.userCode, 'USER-CODE');
  assert.deepEqual(delays, [1_000, 1_000, 6_000]);
  assert.deepEqual(tokens, {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: NOW + 3_600_000,
    token_type: 'Bearer',
  });
  assert.equal(requests.length, 4);
});

test('xAI device enrollment rejects untrusted presentation URLs', async () => {
  await assert.rejects(
    () =>
      startXaiDeviceAuthorization({
        fetchFn: async () =>
          Response.json({
            device_code: 'device-code',
            user_code: 'USER-CODE',
            verification_uri: 'https://attacker.example/device',
            expires_in: 600,
          }),
        signal: new AbortController().signal,
        now: () => NOW,
      }),
    (error: unknown) =>
      error instanceof OAuthTokenEndpointError && error.category === 'invalid_response',
  );
});

test('xAI token polling completes an admitted request after caller cancellation', async () => {
  const controller = new AbortController();
  let markDispatched!: (signal: AbortSignal) => void;
  const dispatched = new Promise<AbortSignal>((resolve) => {
    markDispatched = resolve;
  });
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const polling = pollXaiDeviceAuthorization({
    authorization: {
      deviceCode: 'device-code',
      userCode: 'USER-CODE',
      verificationUrl: 'https://accounts.x.ai/device',
      expiresAt: NOW + 60_000,
      intervalMs: 1,
    },
    fetchFn: async (_url, init) => {
      const signal = init?.signal;
      assert.ok(signal);
      markDispatched(signal);
      return response;
    },
    signal: controller.signal,
    now: () => NOW,
    sleep: async () => undefined,
  });

  const requestSignal = await dispatched;
  controller.abort();
  assert.equal(requestSignal?.aborted, false);
  resolveResponse(
    Response.json({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3_600,
    }),
  );
  assert.deepEqual(await polling, {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_at: NOW + 3_600_000,
  });
});

test('xAI device polling classifies a local window expiry separately from a provider rejection', async () => {
  await assert.rejects(
    () =>
      pollXaiDeviceAuthorization({
        authorization: {
          deviceCode: 'device-code',
          userCode: 'USER-CODE',
          verificationUrl: 'https://accounts.x.ai/device',
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

test('xAI device polling never issues a request after the window elapses mid-sleep', async () => {
  let now = NOW;
  let polls = 0;
  await assert.rejects(
    () =>
      pollXaiDeviceAuthorization({
        authorization: {
          deviceCode: 'device-code',
          userCode: 'USER-CODE',
          verificationUrl: 'https://accounts.x.ai/device',
          expiresAt: NOW + 1_000,
          intervalMs: 5_000,
        },
        now: () => now,
        signal: new AbortController().signal,
        sleep: async () => {
          now += 5_000;
        },
        fetchFn: async () => {
          polls += 1;
          return Response.json({ error: 'authorization_pending' }, { status: 400 });
        },
      }),
    (error: unknown) => error instanceof OAuthDeviceAuthorizationExpiredError,
  );
  assert.equal(polls, 0);
});
