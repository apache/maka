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

import { randomBytes } from 'node:crypto';
import type { OAuthSubscriptionTokens } from '../subscription-credentials.js';
import { requestOAuthEndpointJson, type OAuthEndpointJsonResponse } from '../oauth-login.js';
import {
  OAuthDeviceAuthorizationExpiredError,
  OAuthTokenEndpointError,
  requireOAuthBoundedString,
  requireOAuthDataRecord,
  OAUTH_MAX_TOKEN_CHARS,
} from '../oauth-provider-contracts.js';
import { TRAE, record } from './protocol.js';

export interface TraeDeviceAuthorization {
  deviceCode: string;
  ticket: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
}
interface AuthorizationInput {
  fetchFn: typeof fetch;
  signal: AbortSignal;
  now?: () => number;
}

async function request(
  method: string,
  deviceCode: string,
  body: unknown,
  input: { fetchFn: typeof fetch; signal?: AbortSignal },
): Promise<OAuthEndpointJsonResponse> {
  return requestOAuthEndpointJson({
    endpoint: `${TRAE.authBaseUrl}${TRAE.authPath}${method}`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'ByteDanceCLI/1.0',
        'x-real-psm': `bytecloud.auth.${deviceCode}`,
      },
      body: JSON.stringify(body),
      redirect: 'error',
    },
    fetchFn: input.fetchFn,
    signal: input.signal,
  });
}

function responseData(response: OAuthEndpointJsonResponse): Record<string, unknown> {
  const envelope = requireOAuthDataRecord(response.payload);
  if (!response.ok || envelope.code !== 0) {
    throw new OAuthTokenEndpointError(
      response.status === 401 || response.status === 403 ? 'invalid_token' : 'provider_rejected',
      response.status,
    );
  }
  return requireOAuthDataRecord(envelope.data);
}

export async function startTraeDeviceAuthorization(
  input: AuthorizationInput,
): Promise<TraeDeviceAuthorization> {
  const deviceCode = randomBytes(16).toString('hex');
  const data = responseData(
    await request('cli_registration', deviceCode, { device_code: deviceCode }, input),
  );
  const verificationUrl = requireOAuthBoundedString(data.service_account_create_url, 8192);
  let url: URL;
  try {
    url = new URL(verificationUrl);
  } catch {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'cloud.bytedance.net' ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  const now = input.now?.() ?? Date.now();
  const expiresAt = data.expire_at === undefined ? now + 300_000 : absoluteExpiry(data.expire_at);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 24 * 60 * 60 * 1000
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return {
    deviceCode,
    verificationUrl,
    expiresAt,
    ticket: requireOAuthBoundedString(data.ticket, OAUTH_MAX_TOKEN_CHARS),
    userCode: data.code === undefined ? '' : requireOAuthBoundedString(data.code, 1024),
  };
}

export async function pollTraeDeviceAuthorization(
  input: AuthorizationInput & {
    authorization: TraeDeviceAuthorization;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    onPollAdmission?: () => void;
    onPollRetry?: () => void;
  },
): Promise<OAuthSubscriptionTokens> {
  const now = input.now ?? Date.now;
  for (;;) {
    const remaining = input.authorization.expiresAt - now();
    if (remaining <= 0) throw new OAuthDeviceAuthorizationExpiredError();
    await (input.sleep ?? sleep)(Math.min(2000, remaining), input.signal);
    input.signal.throwIfAborted();
    if (now() >= input.authorization.expiresAt) throw new OAuthDeviceAuthorizationExpiredError();
    input.onPollAdmission?.();
    // A successful grant is committed even when cancel arrives while polling.
    const response = await request(
      'cli_login_polling',
      input.authorization.deviceCode,
      { ticket: input.authorization.ticket },
      { fetchFn: input.fetchFn },
    );
    const envelope = requireOAuthDataRecord(response.payload);
    if (response.status === 400 && envelope.message === 'authorization_pending') {
      input.onPollRetry?.();
      input.signal.throwIfAborted();
      continue;
    }
    if (envelope.message === 'access_denied')
      throw new OAuthTokenEndpointError('invalid_grant', response.status);
    if (envelope.message === 'expired_ticket' || envelope.message === 'invalid_ticket')
      throw new OAuthDeviceAuthorizationExpiredError();
    const data = responseData(response);
    return decodeTokens(data.token_info, input.authorization.deviceCode, now());
  }
}

export async function refreshTraeTokens(input: {
  tokens: OAuthSubscriptionTokens;
  fetchFn: typeof fetch;
  now: () => number;
  signal?: AbortSignal;
}): Promise<OAuthSubscriptionTokens> {
  const deviceCode = requireOAuthBoundedString(input.tokens.device_code, 128);
  const data = responseData(
    await request(
      'get_user_access_token',
      deviceCode,
      { refresh_token: input.tokens.refresh_token },
      input,
    ),
  );
  return decodeTokens(data, deviceCode, input.now());
}

function decodeTokens(value: unknown, deviceCode: string, now: number): OAuthSubscriptionTokens {
  const data = requireOAuthDataRecord(value);
  const accessToken = requireOAuthBoundedString(data.access_token, OAUTH_MAX_TOKEN_CHARS);
  const refreshToken = requireOAuthBoundedString(data.refresh_token, OAUTH_MAX_TOKEN_CHARS);
  let expiresAt: number | undefined;
  if (data.expire_at !== undefined) expiresAt = absoluteExpiry(data.expire_at);
  else if (typeof data.expires_in === 'number') expiresAt = now + data.expires_in * 1000;
  else {
    // JWT expiry is a refresh hint only; server-side auth remains authoritative.
    try {
      const payload = record(
        JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString()),
      );
      if (typeof payload?.exp === 'number') expiresAt = payload.exp * 1000;
    } catch {
      /* Invalid expiry must never produce a permanently valid credential. */
    }
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt! <= now)
    throw new OAuthTokenEndpointError('invalid_response');
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt!,
    device_code: deviceCode,
  };
}

/** ByteCloud returns epoch milliseconds; older responses also use epoch seconds. */
function absoluteExpiry(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new OAuthTokenEndpointError('invalid_response');
  return value < 10_000_000_000 ? value * 1000 : value;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
