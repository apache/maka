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

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { redactSecrets } from '@maka/core/redaction';
import type { OAuthSubscriptionTokens } from '../subscription-credentials.js';
import { requestOAuthEndpointJson } from '../oauth-login.js';
import {
  OAuthTokenEndpointError,
  requireOAuthBoundedString,
  OAUTH_MAX_TOKEN_CHARS,
} from '../oauth-provider-contracts.js';
import { record } from './protocol.js';
import {
  TRAE_PUBLIC_VERSION,
  traePublicAuthOrigins,
  traePublicProfile,
  type TraePublicAccount,
  type TraePublicIdentity,
} from './public-protocol.js';

interface Input {
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
}

const ISSUER_VERDICT_MAX_CHARS = 160;

interface IssuerVerdict {
  readonly code?: string;
  readonly message?: string;
}

/**
 * A Trae issuer refusal, carrying the issuer's own error code and a bounded,
 * redacted message on top of the category. `20401 Device limit reached` and
 * `10101 Invalid param` share one HTTP status family; only the verdict tells
 * the user which one to act on. The response body itself is never retained.
 */
export class TraeTokenEndpointError extends OAuthTokenEndpointError {
  readonly providerCode: string | undefined;

  constructor(
    category: ConstructorParameters<typeof OAuthTokenEndpointError>[0],
    status: number | undefined,
    verdict: IssuerVerdict | undefined,
  ) {
    super(category, status);
    this.name = 'TraeTokenEndpointError';
    this.providerCode = verdict?.code;
    const text = [verdict?.code === undefined ? '' : `Trae ${verdict.code}`, verdict?.message ?? '']
      .filter((part) => part.length > 0)
      .join(': ');
    if (text.length > 0) this.message = `${this.message} ${text}`;
  }
}

function verdictText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = redactSecrets(String(value))
    .replaceAll(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .slice(0, ISSUER_VERDICT_MAX_CHARS);
  return text.length > 0 ? text : undefined;
}

/** The issuer's refusal when the payload carries one; `undefined` for a clean answer. */
function issuerVerdict(root: Record<string, unknown>): IssuerVerdict | undefined {
  const raw = record(root.ResponseMetadata)?.Error ?? root.Error;
  if (raw) {
    const error = record(raw);
    const code = verdictText(error?.Code ?? error?.code);
    const message = verdictText(error ? (error.Message ?? error.message) : raw);
    return {
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
    };
  }
  if (typeof root.code === 'number' && root.code !== 0) {
    const message = verdictText(root.message);
    return { code: String(root.code), ...(message === undefined ? {} : { message }) };
  }
  return undefined;
}

async function post(
  endpoint: string,
  body: unknown,
  input: Input,
  token?: string,
): Promise<Record<string, unknown>> {
  const response = await requestOAuthEndpointJson({
    endpoint,
    fetchFn: input.fetchFn,
    signal: input.signal,
    init: {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': `Trae/${TRAE_PUBLIC_VERSION}`,
        ...(token ? { 'x-cloudide-token': token } : {}),
      },
      body: JSON.stringify(body),
    },
  });
  const root = record(response.payload);
  const verdict = root ? issuerVerdict(root) : undefined;
  if (!response.ok || !root || verdict) {
    throw new TraeTokenEndpointError(
      response.status === 401 || response.status === 403 ? 'invalid_token' : 'provider_rejected',
      response.status,
      verdict,
    );
  }
  return record(root.Result) ?? record(root.result) ?? record(root.data) ?? root;
}

function decodeTokens(
  data: Record<string, unknown>,
  identity: TraePublicIdentity,
  now: number,
  previousRefresh?: string,
): OAuthSubscriptionTokens {
  const absolute = data.TokenExpireAt ?? data.tokenExpireAt;
  const duration = data.TokenExpireDuration ?? data.tokenExpireDuration;
  const expiresAt =
    typeof absolute === 'number' && absolute > 0
      ? absolute < 1e12
        ? absolute * 1000
        : absolute
      : typeof duration === 'number'
        ? now + duration * 1000
        : NaN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 366 * 86400000) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return {
    access_token: requireOAuthBoundedString(
      data.Token ?? data.AccessToken ?? data.accessToken ?? data.token,
      OAUTH_MAX_TOKEN_CHARS,
    ),
    refresh_token: requireOAuthBoundedString(
      data.RefreshToken ?? data.refreshToken ?? previousRefresh,
      OAUTH_MAX_TOKEN_CHARS,
    ),
    expires_at: expiresAt,
    trae: identity,
  };
}

export async function refreshTraePublicTokens(
  input: Input & { tokens: OAuthSubscriptionTokens },
): Promise<OAuthSubscriptionTokens> {
  const identity = input.tokens.trae;
  if (!identity) throw new OAuthTokenEndpointError('invalid_response');
  const profile = traePublicProfile(identity.account);
  const data = await post(
    `${identity.authOrigin ?? profile.authOrigin}/cloudide/api/v3/trae/oauth/ExchangeToken`,
    {
      ClientID: profile.clientId,
      RefreshToken: input.tokens.refresh_token,
      ClientSecret: '-',
      UserID: '',
    },
    input,
    input.tokens.access_token,
  );
  return decodeTokens(data, identity, input.now?.() ?? Date.now(), input.tokens.refresh_token);
}

/** Host-owned loopback/PKCE flow. Only the authorization URL crosses the presentation bridge. */
export async function loginTraePublicAccount(
  input: Input & {
    account: TraePublicAccount;
    present: (url: string) => Promise<void>;
    onExchange?: () => void;
    timeoutMs?: number;
    /** The device this install is to Trae; a fresh random pair when absent. */
    device?: Pick<TraePublicIdentity, 'machineId' | 'deviceId'>;
  },
): Promise<OAuthSubscriptionTokens> {
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(input.timeoutMs ?? 600000),
  ]);
  signal.throwIfAborted();
  const profile = traePublicProfile(input.account);
  const identity: TraePublicIdentity = {
    account: input.account,
    ...(input.device ?? { machineId: randomUUID(), deviceId: randomBytes(16).toString('hex') }),
  };
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const traceId = randomUUID();
  // Trae's authorization page accepts only `http://127.0.0.1:<port>/authorize` as the
  // callback and rejects any other path before it makes a single request, so the
  // response is bound by the login trace id the page always echoes back instead.
  const callbackPath = '/authorize';
  let accept!: (query: URLSearchParams) => void;
  let reject!: (error: unknown) => void;
  const callback = new Promise<URLSearchParams>((resolve, fail) => {
    accept = resolve;
    reject = fail;
  });
  void callback.catch(() => {});
  let consumed = false;
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('referrer-policy', 'no-referrer');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (
      req.method !== 'GET' ||
      url.pathname !== callbackPath ||
      consumed ||
      (req.url?.length ?? 0) > 32768
    ) {
      res.writeHead(404).end('Not found');
      return;
    }
    const trace = url.searchParams.get('login_trace_id') ?? url.searchParams.get('loginTraceID');
    if (trace !== traceId) {
      res.writeHead(400).end('Invalid authorization response');
      return;
    }
    consumed = true;
    res.end('Authorization received. Return to Maka to finish signing in.');
    accept(url.searchParams);
  });
  const onAbort = () => {
    reject(signal.reason);
    server.close();
    server.closeAllConnections();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise<void>((resolve, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', fail);
        resolve();
      });
    });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not start Trae callback listener');
    const guidanceOrigins =
      profile.region === 'cn'
        ? ['https://api.trae.cn', 'https://api.trae.com.cn', 'https://www.trae.cn']
        : ['https://api.marscode.com', 'https://api.trae.ai', 'https://www.trae.ai'];
    let rawHost: unknown;
    for (const origin of guidanceOrigins) {
      try {
        const guidance = await post(
          `${origin}/cloudide/api/v3/trae/GetLoginGuidance`,
          { loginTraceID: traceId, login_trace_id: traceId },
          { ...input, signal },
        );
        rawHost = guidance.LoginHost ?? guidance.loginHost;
        if (typeof rawHost === 'string') break;
      } catch {
        signal.throwIfAborted();
      }
    }
    const loginOrigin =
      typeof rawHost === 'string'
        ? new URL(rawHost.includes('://') ? rawHost : `https://${rawHost}`)
        : new URL(profile.loginOrigin);
    const allowedHosts =
      profile.region === 'cn' ? ['www.trae.cn', 'www.trae.com.cn'] : ['www.trae.ai'];
    if (
      loginOrigin.protocol !== 'https:' ||
      loginOrigin.username ||
      loginOrigin.password ||
      loginOrigin.port ||
      !allowedHosts.includes(loginOrigin.hostname)
    ) {
      throw new OAuthTokenEndpointError('invalid_response');
    }
    const authorization = new URL('/authorization', loginOrigin.origin);
    authorization.search = new URLSearchParams({
      login_version: '1',
      auth_from: profile.solo ? 'solo' : 'trae',
      ...(profile.solo ? { hide_saas_login: 'true' } : {}),
      login_channel: 'native_ide',
      plugin_version: 'local',
      auth_type: 'local',
      client_id: profile.clientId,
      redirect: '0',
      login_trace_id: traceId,
      auth_callback_url: `http://127.0.0.1:${address.port}${callbackPath}`,
      machine_id: identity.machineId,
      device_id: identity.deviceId,
      x_machine_id: identity.machineId,
      x_device_id: identity.deviceId,
      x_device_brand: 'PC',
      x_device_type:
        process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
      x_os_version: process.platform,
      x_env: '',
      x_app_version: TRAE_PUBLIC_VERSION,
      x_app_type: 'stable',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    await input.present(authorization.toString());
    const query = await callback;
    signal.throwIfAborted();
    const region = (
      query.get('userRegion') ??
      query.get('user_region') ??
      query.get('loginRegion') ??
      ''
    ).toLowerCase();
    const tag = (query.get('userTag') ?? query.get('user_tag') ?? '')
      .toLowerCase()
      .replaceAll(/[-_]/g, '');
    const actualRegion =
      tag === 'usttp' ? 'us' : ['cn', 'sg', 'us'].includes(region) ? region : undefined;
    // US accounts are refused outright: their gateway does not expose the
    // native chat API Maka relies on, so a login there could never converse.
    if (actualRegion === 'us')
      throw new Error('Trae account region is US, which Maka does not support');
    if (actualRegion && actualRegion !== profile.region)
      throw new Error(
        `Trae account region differs from the selected connection: the account is ${actualRegion.toUpperCase()}, the connection is ${profile.region.toUpperCase()}`,
      );
    let code =
      query.get('AuthCode') ?? query.get('authCode') ?? query.get('auth_code') ?? query.get('code');
    const rawInfo = query.get('authCodeInfo') ?? query.get('auth_code_info');
    if (!code && rawInfo) {
      let info: Record<string, unknown> | undefined;
      try {
        info = record(JSON.parse(rawInfo));
      } catch {
        throw new OAuthTokenEndpointError('invalid_response');
      }
      code = String(info?.AuthCode ?? info?.authCode ?? info?.code ?? '');
    }
    input.onExchange?.();
    if (code) {
      requireOAuthBoundedString(code, OAUTH_MAX_TOKEN_CHARS);
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const exchange = {
        ClientID: profile.clientId,
        AuthCode: code,
        CodeVerifier: verifier,
        IDEVersion: TRAE_PUBLIC_VERSION,
        DeviceInfo: {
          DeviceID: identity.deviceId,
          MachineID: identity.machineId,
          PlatformCode: profile.solo ? 'SOLO_PC' : 'IDE_PC',
          DeviceType: 'PC',
          DeviceName: 'Maka',
          DeviceModel: 'PC',
          ClientVersion: TRAE_PUBLIC_VERSION,
          DevicePublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
          DeviceBrand: 'PC',
          DeviceCPU: '',
          OSInfo: process.platform,
          OSVersion: process.platform,
        },
      };
      // International accounts exchange on the global issuers in order: one
      // that does not know the code answers 400 and the next is tried.
      let failure: unknown;
      for (const authOrigin of traePublicAuthOrigins(input.account)) {
        try {
          const data = await post(`${authOrigin}/trae/api/v3/oauth/ExchangeToken`, exchange, {
            ...input,
            signal,
          });
          return decodeTokens(data, { ...identity, authOrigin }, input.now?.() ?? Date.now());
        } catch (error) {
          signal.throwIfAborted();
          // The first issuer's verdict is the one reported: a later issuer only
          // ever sees a code the first one already consumed, and answers for that.
          failure ??= error;
          // 401/403 is a verdict on the account (device limit, suspension), not
          // on the issuer: the code was recognised and refused, so no other
          // issuer can do better with it.
          if (error instanceof OAuthTokenEndpointError && error.category === 'invalid_token') break;
        }
      }
      throw failure;
    }
    // Older CN authorization returns a refresh token instead of an authorization code.
    let jwt: Record<string, unknown> | undefined;
    try {
      jwt = record(JSON.parse(query.get('userJwt') ?? '{}'));
    } catch {
      throw new OAuthTokenEndpointError('invalid_response');
    }
    const refreshToken = requireOAuthBoundedString(
      query.get('refreshToken') ?? jwt?.RefreshToken,
      OAUTH_MAX_TOKEN_CHARS,
    );
    return refreshTraePublicTokens({
      ...input,
      signal,
      tokens: {
        access_token: typeof jwt?.Token === 'string' ? jwt.Token : '',
        refresh_token: refreshToken,
        expires_at: 0,
        trae: { ...identity, authOrigin: traePublicAuthOrigins(input.account)[0]! },
      },
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections();
  }
}
