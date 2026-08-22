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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  OAUTH_LOGIN_MAX_RESPONSE_BYTES,
  OAUTH_LOGIN_MAX_TOKEN_CHARS,
  OAuthTokenEndpointError,
  decodeOAuthInitialTokenPayload,
  requestOAuthTokenEndpointJson,
  isDeterministicOAuthCredentialRejection,
} from '../oauth-login.js';
import { isOAuthEnrollmentProviderEnabled } from '../oauth-provider-contracts.js';

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

describe('OAuth initial token decoder', () => {
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
  it('honors the Codex opt-out flag while keeping xAI enabled', () => {
    const environment = { MAKA_CODEX_SUBSCRIPTION_EXPERIMENTAL: '0' };
    assert.equal(isOAuthEnrollmentProviderEnabled('openai-codex', environment), false);
    assert.equal(isOAuthEnrollmentProviderEnabled('xai-oauth', environment), true);
    assert.equal(isOAuthEnrollmentProviderEnabled('openai-codex', {}), true);
  });
});

const TOKEN_ENDPOINT = 'https://auth.example/oauth/token';
const TOKEN_REQUEST_INIT: RequestInit = {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=refresh_token',
};

describe('OAuth token endpoint transport', () => {
  it('bounds a streamed response even without content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(OAUTH_LOGIN_MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    await assert.rejects(
      requestOAuthTokenEndpointJson({
        endpoint: TOKEN_ENDPOINT,
        init: TOKEN_REQUEST_INIT,
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
      requestOAuthTokenEndpointJson({
        endpoint: TOKEN_ENDPOINT,
        init: TOKEN_REQUEST_INIT,
        signal: new AbortController().signal,
        fetchFn: async () => new Response(stream),
      }),
      (error) => assertEndpointError(error, 'outcome_unknown', 200),
    );
  });

  it('classifies invalid JSON received through EOF as an invalid response', async () => {
    await assert.rejects(
      requestOAuthTokenEndpointJson({
        endpoint: TOKEN_ENDPOINT,
        init: TOKEN_REQUEST_INIT,
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
      requestOAuthTokenEndpointJson({
        endpoint: TOKEN_ENDPOINT,
        init: TOKEN_REQUEST_INIT,
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
      requestOAuthTokenEndpointJson({
        endpoint: TOKEN_ENDPOINT,
        init: TOKEN_REQUEST_INIT,
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
      requestOAuthTokenEndpointJson({
        endpoint: TOKEN_ENDPOINT,
        init: TOKEN_REQUEST_INIT,
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
      requestOAuthTokenEndpointJson({
        endpoint: TOKEN_ENDPOINT,
        init: TOKEN_REQUEST_INIT,
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
