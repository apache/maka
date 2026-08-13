import { createHash } from 'node:crypto';
import { base64urlEncode } from '@maka/core/oauth-subscription';
import type { OAuthSubscriptionTokens } from './subscription-credentials.js';
import {
  OAUTH_MAX_TOKEN_CHARS,
  OAUTH_PROVIDER_CONTRACTS,
  OAuthTokenEndpointError,
  oauthExpiresAt,
  optionalOAuthBoundedString,
  requireOAuthBoundedString,
  requireOAuthDataRecord,
  requireOAuthPositiveInteger,
} from './oauth-provider-contracts.js';

export { OAuthTokenEndpointError } from './oauth-provider-contracts.js';
export type { OAuthTokenEndpointErrorCategory } from './oauth-provider-contracts.js';

export type OAuthLoginProvider = 'claude-subscription' | 'xai-oauth';
export type OAuthInitialTokenProvider = 'claude-subscription' | 'xai-oauth' | 'openai-codex';
export type OAuthLoginPresentationKind = 'paste-code' | 'loopback';

export const OAUTH_LOGIN_MAX_RESPONSE_BYTES = 64 * 1024;
export const OAUTH_LOGIN_MAX_TOKEN_CHARS = OAUTH_MAX_TOKEN_CHARS;
export const OAUTH_LOGIN_DEFAULT_TIMEOUT_MS = 15_000;

const CLAUDE = OAUTH_PROVIDER_CONTRACTS['claude-subscription'];
const XAI = OAUTH_PROVIDER_CONTRACTS['xai-oauth'];

export const OAUTH_LOGIN_PROVIDER_CONFIG = {
  'claude-subscription': {
    clientId: CLAUDE.clientId,
    authorizationEndpoint: CLAUDE.authorizationEndpoint,
    tokenEndpoint: CLAUDE.tokenEndpoint,
    redirectUri: CLAUDE.redirectUri,
    scope: CLAUDE.scope,
    tokenUserAgent: CLAUDE.tokenUserAgent,
    presentation: CLAUDE.presentation,
  },
  'xai-oauth': {
    clientId: XAI.clientId,
    authorizationEndpoint: XAI.authorizationEndpoint,
    tokenEndpoint: XAI.tokenEndpoint,
    redirectUri: XAI.redirectUri,
    scope: XAI.scope,
    presentation: XAI.presentation,
    authorizationExtras: XAI.authorizationExtras,
  },
} as const;

export interface OAuthLoginAuthorizationInput {
  provider: OAuthLoginProvider;
  verifier: string;
  state: string;
  /** Loopback providers must supply the exact redirect URI bound to the listener. */
  redirectUri?: string;
}

export interface OAuthLoginAuthorization {
  authorizationUrl: string;
  presentation: OAuthLoginPresentationKind;
}

export function isDeterministicOAuthCredentialRejection(error: unknown): boolean {
  return (
    error instanceof OAuthTokenEndpointError &&
    (error.category === 'invalid_grant' || error.category === 'invalid_token')
  );
}

export function pkceChallengeFromVerifier(verifier: string): string {
  return base64urlEncode(new Uint8Array(createHash('sha256').update(verifier, 'utf8').digest()));
}

interface LoopbackAuthorizationConfig {
  clientId: string;
  authorizeEndpoint: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  extras: ReadonlyArray<readonly [string, string]> | undefined;
}

/** Build a loopback (authorization-code) authorize URL with PKCE S256. */
function buildLoopbackAuthorizationUrl(config: LoopbackAuthorizationConfig): string {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('code_challenge', config.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', config.state);
  for (const [key, value] of config.extras ?? []) url.searchParams.set(key, value);
  return url.toString();
}

export function buildOAuthLoginAuthorization(
  input: OAuthLoginAuthorizationInput,
): OAuthLoginAuthorization {
  assertPkceVerifier(input.verifier);
  assertOAuthState(input.state);
  const config = OAUTH_LOGIN_PROVIDER_CONFIG[input.provider];
  const redirectUri = resolveRedirectUri(input.provider, input.redirectUri);
  if (input.provider !== 'claude-subscription') {
    const loopbackConfig = OAUTH_LOGIN_PROVIDER_CONFIG[input.provider];
    return {
      authorizationUrl: buildLoopbackAuthorizationUrl({
        clientId: loopbackConfig.clientId,
        authorizeEndpoint: loopbackConfig.authorizationEndpoint,
        redirectUri,
        scope: loopbackConfig.scope,
        state: input.state,
        challenge: pkceChallengeFromVerifier(input.verifier),
        extras: loopbackConfig.authorizationExtras,
      }),
      presentation: loopbackConfig.presentation,
    };
  }
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('code_challenge', pkceChallengeFromVerifier(input.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code', 'true');
  return { authorizationUrl: url.toString(), presentation: config.presentation };
}

export interface ExchangeOAuthAuthorizationCodeInput {
  provider: OAuthLoginProvider;
  code: string;
  verifier: string;
  state: string;
  /** Loopback providers must pass the URI used to build the authorization URL. */
  redirectUri?: string;
  signal: AbortSignal;
  fetchFn: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface OAuthTokenEndpointJsonRequestInput {
  endpoint: string;
  init: RequestInit;
  fetchFn: typeof fetch;
  /** Optional caller cancellation; the endpoint deadline remains independently enforced. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OAuthTokenEndpointJsonResponse {
  payload: unknown;
  status: number;
}

export interface OAuthEndpointJsonResponse extends OAuthTokenEndpointJsonResponse {
  ok: boolean;
}

export async function exchangeOAuthAuthorizationCode(
  input: ExchangeOAuthAuthorizationCodeInput,
): Promise<OAuthSubscriptionTokens> {
  assertOpaqueValue('authorization code', input.code, 8 * 1024);
  assertPkceVerifier(input.verifier);
  assertOAuthState(input.state);
  const redirectUri = resolveRedirectUri(input.provider, input.redirectUri);
  if (input.signal.aborted) throw new OAuthTokenEndpointError('aborted');

  const config = OAUTH_LOGIN_PROVIDER_CONFIG[input.provider];
  const { payload, status } = await requestOAuthTokenEndpointJson({
    endpoint: config.tokenEndpoint,
    init: buildTokenRequest(input, redirectUri),
    fetchFn: input.fetchFn,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  try {
    return decodeOAuthInitialTokenPayload(input.provider, payload, input.now?.() ?? Date.now());
  } catch (error) {
    const category = error instanceof OAuthTokenEndpointError ? error.category : 'invalid_response';
    throw new OAuthTokenEndpointError(category, status);
  }
}

/**
 * Executes one token-endpoint effect under an intrinsic deadline and only
 * returns JSON after the bounded response body reaches EOF.
 */
export async function requestOAuthTokenEndpointJson(
  input: OAuthTokenEndpointJsonRequestInput,
): Promise<OAuthTokenEndpointJsonResponse> {
  const response = await requestOAuthEndpointJson(input);
  if (!response.ok) {
    const code = findProviderErrorCode(response.payload);
    const category =
      code === 'invalid_grant' || code === 'invalid_token' ? code : 'provider_rejected';
    throw new OAuthTokenEndpointError(category, response.status);
  }
  return { payload: response.payload, status: response.status };
}

export async function requestOAuthEndpointJson(
  input: OAuthTokenEndpointJsonRequestInput,
): Promise<OAuthEndpointJsonResponse> {
  const timeoutMs = input.timeoutMs ?? OAUTH_LOGIN_DEFAULT_TIMEOUT_MS;
  assertTokenEndpointTimeout(timeoutMs);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (controller.signal.aborted) throw new OAuthTokenEndpointError('outcome_unknown');
    let response: Response;
    try {
      response = await raceWithAbort(
        input.fetchFn(input.endpoint, { ...input.init, signal: controller.signal }),
        controller.signal,
      );
    } catch {
      throw new OAuthTokenEndpointError('outcome_unknown');
    }
    return {
      payload: await readBoundedOAuthJson(response, controller.signal),
      status: response.status,
      ok: response.ok,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', onAbort);
  }
}

export function decodeOAuthInitialTokenPayload(
  provider: OAuthInitialTokenProvider,
  payload: unknown,
  now = Date.now(),
): OAuthSubscriptionTokens {
  if (!Number.isFinite(now) || now < 0) throw new OAuthTokenEndpointError('invalid_response');
  const record = requireOAuthDataRecord(payload);
  const accessToken = requireOAuthBoundedString(record.access_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const refreshToken = requireOAuthBoundedString(record.refresh_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const expiresAt = oauthExpiresAt(
    now,
    requireOAuthPositiveInteger(record.expires_in, 366 * 24 * 60 * 60),
  );

  if (provider === 'claude-subscription') {
    const account =
      record.account === undefined ? undefined : requireOAuthDataRecord(record.account);
    const tokenType = optionalOAuthBoundedString(record.token_type, 256);
    const scope = optionalOAuthBoundedString(record.scope, 4 * 1024);
    const accountUuid = account ? optionalOAuthBoundedString(account.uuid, 1024) : undefined;
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      ...(tokenType !== undefined ? { token_type: tokenType } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(accountUuid !== undefined ? { account_uuid: accountUuid } : {}),
    };
  }

  const idToken = optionalOAuthBoundedString(record.id_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const tokenType = optionalOAuthBoundedString(record.token_type, 256);
  const scope = optionalOAuthBoundedString(record.scope, 4 * 1024);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    ...(idToken !== undefined ? { id_token: idToken } : {}),
    ...(tokenType !== undefined ? { token_type: tokenType } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

function buildTokenRequest(
  input: ExchangeOAuthAuthorizationCodeInput,
  redirectUri: string,
): RequestInit {
  const config = OAUTH_LOGIN_PROVIDER_CONFIG[input.provider];
  const common = {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: redirectUri,
  };
  const tokenHeaders: Record<string, string> = {
    'Content-Type':
      input.provider === 'claude-subscription'
        ? 'application/json'
        : 'application/x-www-form-urlencoded',
  };
  if ('tokenUserAgent' in config) tokenHeaders['User-Agent'] = config.tokenUserAgent;
  if (input.provider === 'claude-subscription') {
    return {
      method: 'POST',
      headers: tokenHeaders,
      body: JSON.stringify({ ...common, state: input.state }),
    };
  }
  return {
    method: 'POST',
    headers: tokenHeaders,
    body: new URLSearchParams(common).toString(),
  };
}

function resolveRedirectUri(provider: OAuthLoginProvider, redirectUri?: string): string {
  if (provider === 'claude-subscription') {
    if (
      redirectUri !== undefined &&
      redirectUri !== OAUTH_LOGIN_PROVIDER_CONFIG[provider].redirectUri
    ) {
      throw new OAuthTokenEndpointError('invalid_response');
    }
    return OAUTH_LOGIN_PROVIDER_CONFIG[provider].redirectUri;
  }
  if (!redirectUri) throw new OAuthTokenEndpointError('invalid_response');
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  if (
    parsed.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  if (
    provider === 'xai-oauth' &&
    parsed.toString() !== OAUTH_LOGIN_PROVIDER_CONFIG['xai-oauth'].redirectUri
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return parsed.toString();
}

function assertPkceVerifier(verifier: string): void {
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
}

function assertOAuthState(state: string): void {
  if (state.length < 22 || state.length > 128 || !/^[A-Za-z0-9_-]+$/.test(state)) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
}

function assertOpaqueValue(_name: string, value: string, maxChars: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
}

function assertTokenEndpointTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
}

export async function readBoundedOAuthJson(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > OAUTH_LOGIN_MAX_RESPONSE_BYTES) {
      cancelBodyBestEffort(response.body);
      throw new OAuthTokenEndpointError('response_too_large', response.status);
    }
  }
  if (!response.body) throw new OAuthTokenEndpointError('invalid_response', response.status);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new OAuthTokenEndpointError('invalid_response', response.status);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cancelScheduled = false;
  let reachedEof = false;
  try {
    while (true) {
      const result = await readStreamChunk(reader, signal);
      if (result.done) {
        reachedEof = true;
        break;
      }
      total += result.value.byteLength;
      if (total > OAUTH_LOGIN_MAX_RESPONSE_BYTES) {
        cancelScheduled = true;
        cancelReaderBestEffort(reader);
        throw new OAuthTokenEndpointError('response_too_large', response.status);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof OAuthTokenEndpointError) {
      throw error.status === undefined
        ? new OAuthTokenEndpointError(error.category, response.status)
        : error;
    }
    throw new OAuthTokenEndpointError('outcome_unknown', response.status);
  } finally {
    if (!cancelScheduled && (reachedEof || !signal?.aborted)) {
      try {
        reader.releaseLock();
      } catch {
        // A failed stream may leave a read pending. Lock cleanup cannot
        // hold up or replace the exchange verdict.
      }
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new OAuthTokenEndpointError('invalid_response', response.status);
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    try {
      return await reader.read();
    } catch {
      throw new OAuthTokenEndpointError('outcome_unknown');
    }
  }
  if (signal.aborted) {
    cancelReaderBestEffort(reader);
    throw new OAuthTokenEndpointError('outcome_unknown');
  }
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new OAuthTokenEndpointError('outcome_unknown'));
      cancelReaderBestEffort(reader);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader
      .read()
      .then(resolve, () => reject(new OAuthTokenEndpointError('outcome_unknown')))
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  queueMicrotask(() => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cancellation is cleanup only and cannot replace the exchange verdict.
    }
  });
}

function cancelBodyBestEffort(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  queueMicrotask(() => {
    try {
      void body.cancel().catch(() => undefined);
    } catch {
      // Cancellation is cleanup only and cannot replace the endpoint verdict.
    }
  });
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new OAuthTokenEndpointError('outcome_unknown');
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OAuthTokenEndpointError('outcome_unknown'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function findProviderErrorCode(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error.toLowerCase();
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const nested = record.error as Record<string, unknown>;
    for (const value of [nested.code, nested.type]) {
      if (typeof value === 'string') return value.toLowerCase();
    }
  }
  if (typeof record.code === 'string') return record.code.toLowerCase();
  return undefined;
}
