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

import {
  createGitHubCopilotAccountTokens,
  GITHUB_COPILOT_DEFAULT_API_ENDPOINT,
  isSupportedGitHubCopilotAccountToken,
  type OAuthSubscriptionTokens,
} from './subscription-credentials.js';
import { fetchGitHubCopilotModels } from './model-fetcher.js';
import { ConnectionEffectHttpError } from './connection-effect-outcome.js';
import {
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

const COPILOT = OAUTH_PROVIDER_CONTRACTS['github-copilot'];
const MAX_TOKEN_LIFETIME_SECONDS = 366 * 24 * 60 * 60;

/**
 * A GitHub account authorized the grant, and the Copilot API then refused it —
 * an account without a live subscription, or one whose organization withholds
 * Copilot. The credential is real and the authorization succeeded, so this is
 * the provider refusing the account rather than a failed login. Only a proven
 * refusal reaches here: a catalog the account can read but that lists nothing,
 * or a deterministic 401/403 from the Copilot API.
 */
export class GitHubCopilotEntitlementError extends Error {
  constructor(options?: ErrorOptions) {
    super('GitHub account exposes no usable Copilot model', options);
    this.name = 'GitHubCopilotEntitlementError';
  }
}

/**
 * The entitlement question could not be answered — a timeout, a dropped
 * connection, a rate limit, a 5xx, or a response the client could not read.
 *
 * This must never be reported as an ineligible account: nothing about the
 * subscription was learned, no credential was committed, and the same login
 * will usually succeed on the next attempt. The provider status is preserved
 * for diagnosis, and the Host maps this to a retryable authorization failure.
 */
export class GitHubCopilotEntitlementUnavailableError extends Error {
  constructor(
    readonly status: number | undefined,
    options?: ErrorOptions,
  ) {
    super(
      status === undefined
        ? 'GitHub Copilot entitlement could not be verified'
        : `GitHub Copilot entitlement could not be verified (${status})`,
      options,
    );
    this.name = 'GitHubCopilotEntitlementUnavailableError';
  }
}

/**
 * RFC 8628 device authorization for a GitHub account that carries a Copilot
 * subscription. The account token this yields is what
 * `createGitHubCopilotAccountTokens` already expects — the enrollment replaces
 * where that token comes from (previously `gh auth token` or a fine-grained
 * PAT), not what is done with it.
 */
export interface GitHubCopilotDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

export interface StartGitHubCopilotDeviceAuthorizationInput {
  readonly fetchFn: typeof fetch;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface PollGitHubCopilotDeviceAuthorizationInput
  extends StartGitHubCopilotDeviceAuthorizationInput {
  readonly authorization: GitHubCopilotDeviceAuthorization;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Runs immediately before one token request becomes non-cancellable. */
  readonly onPollAdmission?: () => void;
  /** Runs after a retryable response restores the cancellation boundary. */
  readonly onPollRetry?: () => void;
}

export async function startGitHubCopilotDeviceAuthorization(
  input: StartGitHubCopilotDeviceAuthorizationInput,
): Promise<GitHubCopilotDeviceAuthorization> {
  const response = await requestOAuthEndpointJson({
    endpoint: COPILOT.deviceEndpoint,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: COPILOT.clientId,
        scope: COPILOT.scope,
      }).toString(),
    },
    fetchFn: input.fetchFn,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  if (!response.ok) throw new OAuthTokenEndpointError('provider_rejected', response.status);
  const payload = requireOAuthDataRecord(response.payload);
  // GitHub answers a malformed device request with HTTP 200 and an `error`
  // body, so an ok status alone does not mean an authorization was issued.
  const rejection = providerErrorCode(payload);
  if (rejection) throw new OAuthTokenEndpointError('provider_rejected', response.status);
  const deviceCode = requireOAuthBoundedString(payload.device_code, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const userCode = requireOAuthBoundedString(payload.user_code, 1_024);
  const verificationUrl = requireOAuthBoundedString(payload.verification_uri, 8_192);
  assertGitHubVerificationUrl(verificationUrl);
  const now = input.now?.() ?? Date.now();
  const expiresIn = requireOAuthPositiveInteger(payload.expires_in, 24 * 60 * 60);
  const intervalSeconds =
    payload.interval === undefined ? 5 : requireOAuthPositiveInteger(payload.interval, 300);
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresAt: oauthExpiresAt(now, expiresIn, response.status),
    intervalMs: intervalSeconds * 1_000,
  };
}

export async function pollGitHubCopilotDeviceAuthorization(
  input: PollGitHubCopilotDeviceAuthorizationInput,
): Promise<OAuthSubscriptionTokens> {
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? abortableSleep;
  let intervalMs = input.authorization.intervalMs;
  for (;;) {
    // Sleep at most until the window elapses, then re-check so no request is
    // issued after the device code expired locally.
    const remaining = input.authorization.expiresAt - now();
    if (remaining <= 0) throw new OAuthDeviceAuthorizationExpiredError();
    await sleep(Math.min(intervalMs, remaining), input.signal);
    input.signal.throwIfAborted();
    if (now() >= input.authorization.expiresAt) {
      throw new OAuthDeviceAuthorizationExpiredError();
    }
    input.onPollAdmission?.();
    const response = await requestOAuthEndpointJson({
      endpoint: COPILOT.tokenEndpoint,
      init: {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: COPILOT.clientId,
          device_code: input.authorization.deviceCode,
          grant_type: COPILOT.deviceGrant,
        }).toString(),
      },
      fetchFn: input.fetchFn,
      // One token request is not cancellable: an abort between the grant being
      // spent and the token being read would strand a usable credential.
      signal: new AbortController().signal,
      timeoutMs: input.timeoutMs,
    });
    if (!response.ok) throw new OAuthTokenEndpointError('provider_rejected', response.status);
    const payload = requireOAuthDataRecord(response.payload);
    // Unlike xAI, GitHub reports pending/slow_down as HTTP 200 with an `error`
    // body, so the error code must be read before the success shape.
    const code = providerErrorCode(payload);
    if (code === 'authorization_pending') {
      input.onPollRetry?.();
      input.signal.throwIfAborted();
      continue;
    }
    if (code === 'slow_down') {
      const advertised = payload.interval;
      intervalMs =
        advertised === undefined
          ? Math.min(intervalMs + 5_000, 5 * 60 * 1_000)
          : requireOAuthPositiveInteger(advertised, 300) * 1_000;
      input.onPollRetry?.();
      input.signal.throwIfAborted();
      continue;
    }
    // A denial is the account refusing; `expired_token` only means the user did
    // not finish in time, which the host maps to authorization_failed instead.
    if (code === 'access_denied')
      throw new OAuthTokenEndpointError('invalid_grant', response.status);
    if (code === 'expired_token') throw new OAuthDeviceAuthorizationExpiredError();
    if (code) throw new OAuthTokenEndpointError('provider_rejected', response.status);
    return decodeGitHubCopilotAccountToken(payload, now);
  }
}

/**
 * The device grant proves a GitHub account, not a Copilot subscription: the
 * token endpoint issues the same account token whether or not Copilot is
 * entitled. Ask the Copilot API what that account can actually reach, so an
 * unusable credential is refused while the login is still in flight instead of
 * being committed and failing later on the first request.
 *
 * Runs on the caller's transport — the same one the grant was obtained over.
 */
export async function verifyGitHubCopilotModelEntitlement(input: {
  readonly tokens: OAuthSubscriptionTokens;
  readonly fetchFn: typeof fetch;
}): Promise<Awaited<ReturnType<typeof fetchGitHubCopilotModels>>> {
  let models: Awaited<ReturnType<typeof fetchGitHubCopilotModels>>;
  try {
    models = await fetchGitHubCopilotModels(
      input.tokens.base_url ?? GITHUB_COPILOT_DEFAULT_API_ENDPOINT,
      input.tokens.access_token,
      input.fetchFn,
    );
  } catch (error) {
    // Only the provider refusing this account is an entitlement answer. A
    // timeout, a dropped connection, a rate limit, a 5xx, or an unreadable
    // body tell us nothing about the subscription, and reporting them as
    // ineligibility would send a paying user back through a device login that
    // was never the problem.
    if (
      error instanceof ConnectionEffectHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new GitHubCopilotEntitlementError({ cause: error });
    }
    throw new GitHubCopilotEntitlementUnavailableError(
      error instanceof ConnectionEffectHttpError ? error.status : undefined,
      { cause: error },
    );
  }
  // A catalog the account could read, listing nothing it may use.
  if (models.length === 0) throw new GitHubCopilotEntitlementError();
  return models;
}

/**
 * The device grant must yield a GitHub OAuth user token (`gho_`/`ghu_`). A
 * classic PAT shape here would mean the flow resolved to something other than
 * the account that authorized it, so it is rejected rather than stored.
 *
 * GitHub returns `expires_in`/`refresh_token` only when the OAuth app has
 * expiring user tokens enabled. That lifetime is carried through verbatim so
 * the credential can be renewed; an expiring token recorded as non-expiring
 * would silently stop working and force another interactive login. An
 * expiring response without a refresh token is unusable for the same reason
 * and is rejected instead of stored.
 */
function decodeGitHubCopilotAccountToken(
  payload: Record<string, unknown>,
  now: () => number,
): OAuthSubscriptionTokens {
  const accessToken = requireOAuthBoundedString(payload.access_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  if (!isSupportedGitHubCopilotAccountToken(accessToken)) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  if (payload.expires_in === undefined) return createGitHubCopilotAccountTokens(accessToken);
  const expiresInSeconds = requireOAuthPositiveInteger(
    payload.expires_in,
    MAX_TOKEN_LIFETIME_SECONDS,
  );
  const refreshToken = requireOAuthBoundedString(
    payload.refresh_token,
    OAUTH_LOGIN_MAX_TOKEN_CHARS,
  );
  return createGitHubCopilotAccountTokens(accessToken, {
    expiresAt: oauthExpiresAt(now(), expiresInSeconds),
    refreshToken,
  });
}

function providerErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const error = (value as Record<string, unknown>).error;
  return typeof error === 'string' ? error.toLowerCase() : undefined;
}

/**
 * The verification URL is handed to the presentation layer, which opens it in
 * the user's browser. Pin it to github.com so a malformed response cannot
 * redirect the user somewhere else to type a code that looks legitimate.
 */
function assertGitHubVerificationUrl(value: string): void {
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
    (url.hostname !== 'github.com' && !url.hostname.endsWith('.github.com'))
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
