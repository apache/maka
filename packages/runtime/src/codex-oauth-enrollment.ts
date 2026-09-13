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
  requestOAuthTokenEndpointJson,
} from './oauth-login.js';
import {
  OAUTH_PROVIDER_CONTRACTS,
  OAuthDeviceAuthorizationExpiredError,
  requireOAuthBoundedString,
  requireOAuthDataRecord,
} from './oauth-provider-contracts.js';

const CODEX = OAUTH_PROVIDER_CONTRACTS['openai-codex'];

const CODEX_DEVICE_USERCODE_ENDPOINT = `${CODEX.deviceAuthBaseUrl}/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_ENDPOINT = `${CODEX.deviceAuthBaseUrl}/deviceauth/token`;

export interface CodexDeviceAuthorization {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

/** Result of a successful device-auth poll: the authorization code + PKCE verifier to exchange. */
export interface CodexDeviceAuthorizationGrant {
  readonly authorizationCode: string;
  readonly codeVerifier: string;
}

export interface StartCodexDeviceAuthorizationInput {
  readonly fetchFn: typeof fetch;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface PollCodexDeviceAuthorizationInput extends StartCodexDeviceAuthorizationInput {
  readonly authorization: CodexDeviceAuthorization;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Runs immediately before one token request becomes non-cancellable. */
  readonly onPollAdmission?: () => void;
  /** Runs after a retryable response restores the cancellation boundary. */
  readonly onPollRetry?: () => void;
}

export interface ExchangeCodexDeviceAuthorizationCodeInput {
  readonly grant: CodexDeviceAuthorizationGrant;
  readonly fetchFn: typeof fetch;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * Request a one-time ChatGPT device code (`POST /deviceauth/usercode`).
 * Mirrors the official codex CLI (`codex-rs login/src/device_code_auth.rs`):
 * the verification page is the fixed server-owned `auth.openai.com/codex/device`
 * URL, and the user enters the returned `user_code` there.
 */
export async function startCodexDeviceAuthorization(
  input: StartCodexDeviceAuthorizationInput,
): Promise<CodexDeviceAuthorization> {
  const response = await requestOAuthEndpointJson({
    endpoint: CODEX_DEVICE_USERCODE_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX.clientId }),
    },
    fetchFn: input.fetchFn,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  if (!response.ok) throw new OAuthTokenEndpointError('provider_rejected', response.status);
  const payload = requireOAuthDataRecord(response.payload);
  const deviceAuthId = requireOAuthBoundedString(payload.device_auth_id, 1_024);
  // The official CLI decoder accepts both `user_code` and `usercode`
  // (codex-rs login/src/device_code_auth.rs serde aliases).
  const userCode = requireOAuthBoundedString(payload.user_code ?? payload.usercode, 1_024);
  const intervalSeconds = deviceIntervalSeconds(payload.interval);
  const now = input.now?.() ?? Date.now();
  return {
    deviceAuthId,
    userCode,
    verificationUrl: CODEX.deviceVerifyUrl,
    expiresAt: deviceExpiry(payload.expires_at, now),
    intervalMs: intervalSeconds * 1_000,
  };
}

/**
 * Poll `POST /deviceauth/token` until the browser approval lands. Mirrors
 * the official CLI: 403/404 means still pending (retry after the interval),
 * 200 returns `{authorization_code, code_challenge, code_verifier}`.
 *
 * The poll never issues a request once the local `expires_at` has passed:
 * it polls first, then sleeps at most until the boundary, and re-checks on
 * every loop. A 200 issued while the code was still valid is honored even
 * if it arrives just past the boundary (the grant was created in-window).
 * An elapsed window throws `OAuthDeviceAuthorizationExpiredError` — the
 * caller distinguishes "user did not finish in time" from a provider
 * rejection.
 *
 * After `onPollAdmission`, the in-flight request uses an independent
 * AbortSignal so a caller cancellation cannot discard a poll that has
 * already consumed the one-time device code; the per-request intrinsic
 * deadline still bounds it.
 */
export async function pollCodexDeviceAuthorization(
  input: PollCodexDeviceAuthorizationInput,
): Promise<CodexDeviceAuthorizationGrant> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? abortableSleep;
  for (;;) {
    if (now() >= input.authorization.expiresAt) {
      throw new OAuthDeviceAuthorizationExpiredError();
    }
    input.signal.throwIfAborted();
    input.onPollAdmission?.();
    const response = await requestOAuthEndpointJson({
      endpoint: CODEX_DEVICE_TOKEN_ENDPOINT,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: input.authorization.deviceAuthId,
          user_code: input.authorization.userCode,
        }),
      },
      fetchFn: input.fetchFn,
      // The admitted request must complete even if the caller cancels;
      // the per-request deadline still bounds it.
      signal: new AbortController().signal,
      timeoutMs: input.timeoutMs,
    });
    if (response.ok) {
      const payload = requireOAuthDataRecord(response.payload);
      const authorizationCode = requireOAuthBoundedString(
        payload.authorization_code,
        OAUTH_LOGIN_MAX_TOKEN_CHARS,
      );
      const codeVerifier = requireOAuthBoundedString(
        payload.code_verifier,
        OAUTH_LOGIN_MAX_TOKEN_CHARS,
      );
      return { authorizationCode, codeVerifier };
    }
    // 403/404 = still pending (per the official CLI); anything else is a
    // hard failure.
    if (response.status === 403 || response.status === 404) {
      input.onPollRetry?.();
      input.signal.throwIfAborted();
      // Sleep at most until the window elapses; the loop-top check then
      // stops polling once expired.
      const remaining = input.authorization.expiresAt - now();
      if (remaining <= 0) throw new OAuthDeviceAuthorizationExpiredError();
      await sleep(Math.min(input.authorization.intervalMs, remaining), input.signal);
      continue;
    }
    throw new OAuthTokenEndpointError('provider_rejected', response.status);
  }
}

/**
 * Exchange the device-auth authorization code at the token endpoint with
 * the fixed deviceauth redirect URI. The device flow uses a server-issued
 * PKCE verifier (returned by the poll), so it cannot reuse the loopback
 * `exchangeOAuthAuthorizationCode` path (which pins `redirect_uri` to a
 * local loopback host).
 */
export async function exchangeCodexDeviceAuthorizationCode(
  input: ExchangeCodexDeviceAuthorizationCodeInput,
): Promise<OAuthSubscriptionTokens> {
  if (input.signal.aborted) throw new OAuthTokenEndpointError('aborted');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX.clientId,
    code: input.grant.authorizationCode,
    code_verifier: input.grant.codeVerifier,
    redirect_uri: CODEX.deviceRedirectUri,
  });
  const { payload, status } = await requestOAuthTokenEndpointJson({
    endpoint: CODEX.tokenEndpoint,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': CODEX.tokenUserAgent,
      },
      body: body.toString(),
    },
    fetchFn: input.fetchFn,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  try {
    return decodeOAuthInitialTokenPayload('openai-codex', payload, input.now?.() ?? Date.now());
  } catch (error) {
    const category = error instanceof OAuthTokenEndpointError ? error.category : 'invalid_response';
    throw new OAuthTokenEndpointError(category, status);
  }
}

/** The deviceauth response returns `interval` as a numeric string. */
function deviceIntervalSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  throw new OAuthTokenEndpointError('invalid_response');
}

/** `expires_at` arrives as an ISO-8601 UTC string; fall back to 15 minutes. */
function deviceExpiry(value: unknown, now: number): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  return now + 15 * 60 * 1_000;
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
