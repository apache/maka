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

import type { OAuthSubscriptionTokens } from './subscription-credentials.js';
import {
  decodeOAuthInitialTokenPayload,
  OAUTH_LOGIN_MAX_TOKEN_CHARS,
  OAuthTokenEndpointError,
  requestOAuthEndpointJson,
} from './oauth-login.js';
import {
  OAUTH_PROVIDER_CONTRACTS,
  OAuthDeviceAuthorizationExpiredError,
  oauthExpiresAt,
  requireOAuthBoundedString,
  requireOAuthDataRecord,
  requireOAuthPositiveInteger,
} from './oauth-provider-contracts.js';

const XAI = OAUTH_PROVIDER_CONTRACTS['xai-oauth'];

export interface XaiDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

export interface StartXaiDeviceAuthorizationInput {
  readonly fetchFn: typeof fetch;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface PollXaiDeviceAuthorizationInput extends StartXaiDeviceAuthorizationInput {
  readonly authorization: XaiDeviceAuthorization;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Runs immediately before one token request becomes non-cancellable. */
  readonly onPollAdmission?: () => void;
  /** Runs after a retryable response restores the cancellation boundary. */
  readonly onPollRetry?: () => void;
}

export async function startXaiDeviceAuthorization(
  input: StartXaiDeviceAuthorizationInput,
): Promise<XaiDeviceAuthorization> {
  const response = await requestOAuthEndpointJson({
    endpoint: XAI.deviceEndpoint,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: XAI.clientId,
        scope: XAI.scope,
        referrer: 'maka',
      }).toString(),
    },
    fetchFn: input.fetchFn,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  if (!response.ok) throw new OAuthTokenEndpointError('provider_rejected', response.status);
  const payload = requireOAuthDataRecord(response.payload);
  const deviceCode = requireOAuthBoundedString(payload.device_code, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const userCode = requireOAuthBoundedString(payload.user_code, 1_024);
  const verificationUrl = requireOAuthBoundedString(
    payload.verification_uri_complete ?? payload.verification_uri,
    8_192,
  );
  assertXaiVerificationUrl(verificationUrl);
  const now = input.now?.() ?? Date.now();
  const expiresIn = requireOAuthPositiveInteger(payload.expires_in, 24 * 60 * 60);
  const intervalSeconds =
    payload.interval === undefined ? 5 : requireOAuthPositiveInteger(payload.interval, 300);
  const expiresAt = oauthExpiresAt(now, expiresIn, response.status);
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresAt,
    intervalMs: intervalSeconds * 1_000,
  };
}

export async function pollXaiDeviceAuthorization(
  input: PollXaiDeviceAuthorizationInput,
): Promise<OAuthSubscriptionTokens> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? abortableSleep;
  let intervalMs = input.authorization.intervalMs;
  for (;;) {
    if (now() >= input.authorization.expiresAt) {
      throw new OAuthDeviceAuthorizationExpiredError();
    }
    // Sleep at most until the window elapses, then re-check so no request
    // is issued after the device code expired locally.
    const remaining = input.authorization.expiresAt - now();
    if (remaining <= 0) throw new OAuthDeviceAuthorizationExpiredError();
    await sleep(Math.min(intervalMs, remaining), input.signal);
    input.signal.throwIfAborted();
    if (now() >= input.authorization.expiresAt) {
      throw new OAuthDeviceAuthorizationExpiredError();
    }
    input.onPollAdmission?.();
    const response = await requestOAuthEndpointJson({
      endpoint: XAI.tokenEndpoint,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: XAI.deviceGrant,
          client_id: XAI.clientId,
          device_code: input.authorization.deviceCode,
        }).toString(),
      },
      fetchFn: input.fetchFn,
      signal: new AbortController().signal,
      timeoutMs: input.timeoutMs,
    });
    if (response.ok) {
      return decodeOAuthInitialTokenPayload('xai-oauth', response.payload, now());
    }
    const code = providerErrorCode(response.payload);
    if (code === 'authorization_pending') {
      input.onPollRetry?.();
      input.signal.throwIfAborted();
      continue;
    }
    if (code === 'slow_down') {
      intervalMs = Math.min(intervalMs + 5_000, 5 * 60 * 1_000);
      input.onPollRetry?.();
      input.signal.throwIfAborted();
      continue;
    }
    // Provider denial of the account is a rejection; a server-side
    // "expired_token" just means the user did not finish in time.
    if (code === 'access_denied' || code === 'authorization_denied') {
      throw new OAuthTokenEndpointError('invalid_grant', response.status);
    }
    if (code === 'expired_token') {
      throw new OAuthDeviceAuthorizationExpiredError();
    }
    throw new OAuthTokenEndpointError('provider_rejected', response.status);
  }
}

function providerErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const error = (value as Record<string, unknown>).error;
  return typeof error === 'string' ? error.toLowerCase() : undefined;
}

function assertXaiVerificationUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.hostname !== 'x.ai' && !url.hostname.endsWith('.x.ai'))
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('OAuth login cancelled', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('OAuth login cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
