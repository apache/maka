import { createHash } from 'node:crypto';
import { base64urlEncode } from '@maka/core';
import type { OAuthSubscriptionTokens } from './subscription-credentials.js';

export type OAuthLoginProvider = 'claude-subscription' | 'openai-codex';
export type OAuthInitialTokenProvider = OAuthLoginProvider | 'xai-oauth';
export type OAuthLoginPresentationKind = 'paste-code' | 'loopback';

export const OAUTH_LOGIN_MAX_RESPONSE_BYTES = 64 * 1024;
export const OAUTH_LOGIN_MAX_TOKEN_CHARS = 32 * 1024;
export const OAUTH_LOGIN_DEFAULT_TIMEOUT_MS = 15_000;

export const OAUTH_LOGIN_PROVIDER_CONFIG = {
  'claude-subscription': {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizationEndpoint: 'https://claude.com/cai/oauth/authorize',
    tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    scope: 'user:sessions:claude_code user:mcp_servers user:file_upload',
    tokenUserAgent: 'claude-cli/2.1.153 (external, cli)',
    presentation: 'paste-code',
  },
  'openai-codex': {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    scope: 'openid profile email offline_access',
    tokenUserAgent: 'maka-desktop/0.1.0 (oauth-subscription)',
    presentation: 'loopback',
    authorizationExtras: [
      ['codex_cli_simplified_flow', 'true'],
      ['originator', 'codex_cli_rs'],
    ] as ReadonlyArray<readonly [string, string]>,
  },
} as const;

export interface OAuthLoginAuthorizationInput {
  provider: OAuthLoginProvider;
  verifier: string;
  state: string;
  /** Required for Codex because the Host owns the loopback listener. */
  redirectUri?: string;
}

export interface OAuthLoginAuthorization {
  authorizationUrl: string;
  presentation: OAuthLoginPresentationKind;
}

export type OAuthTokenEndpointErrorCategory =
  | 'invalid_grant'
  | 'invalid_token'
  | 'provider_rejected'
  | 'invalid_response'
  | 'response_too_large'
  | 'aborted'
  | 'outcome_unknown';

/** Safe to cross an ownership boundary: it never retains a response body or cause. */
export class OAuthTokenEndpointError extends Error {
  constructor(
    readonly category: OAuthTokenEndpointErrorCategory,
    readonly status?: number,
  ) {
    super(
      status === undefined
        ? `OAuth token endpoint failed: ${category}.`
        : `OAuth token endpoint failed (${status}): ${category}.`,
    );
    this.name = 'OAuthTokenEndpointError';
  }
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

export interface CodexAuthorizationConfig {
  clientId: string;
  authorizeEndpoint: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  extras: ReadonlyArray<readonly [string, string]>;
}

export function buildCodexAuthorizationUrl(config: CodexAuthorizationConfig): string {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('code_challenge', config.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', config.state);
  for (const [key, value] of config.extras) url.searchParams.set(key, value);
  return url.toString();
}

export function buildOAuthLoginAuthorization(
  input: OAuthLoginAuthorizationInput,
): OAuthLoginAuthorization {
  assertPkceVerifier(input.verifier);
  assertOAuthState(input.state);
  const config = OAUTH_LOGIN_PROVIDER_CONFIG[input.provider];
  const redirectUri = resolveRedirectUri(input.provider, input.redirectUri);
  if (input.provider === 'openai-codex') {
    const codexConfig = OAUTH_LOGIN_PROVIDER_CONFIG['openai-codex'];
    return {
      authorizationUrl: buildCodexAuthorizationUrl({
        clientId: codexConfig.clientId,
        authorizeEndpoint: codexConfig.authorizationEndpoint,
        redirectUri,
        scope: codexConfig.scope,
        state: input.state,
        challenge: pkceChallengeFromVerifier(input.verifier),
        extras: codexConfig.authorizationExtras,
      }),
      presentation: codexConfig.presentation,
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
  /** Required for Codex and must equal the URI used to build its authorization URL. */
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
  const record = requireClosedRecord(
    payload,
    provider === 'claude-subscription'
      ? ['access_token', 'refresh_token', 'expires_in', 'token_type', 'scope', 'account']
      : ['access_token', 'refresh_token', 'expires_in', 'id_token', 'token_type', 'scope'],
  );
  const accessToken = requireToken(record.access_token);
  const refreshToken = requireToken(record.refresh_token);
  const expiresAt = expiresAtFromExpiresIn(now, requireExpiresIn(record.expires_in));

  if (provider === 'claude-subscription') {
    const account =
      record.account === undefined ? undefined : requireClosedRecord(record.account, ['uuid']);
    const tokenType = optionalBoundedString(record.token_type, 256);
    const scope = optionalBoundedString(record.scope, 4 * 1024);
    const accountUuid = account ? optionalBoundedString(account.uuid, 1024) : undefined;
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      ...(tokenType !== undefined ? { token_type: tokenType } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(accountUuid !== undefined ? { account_uuid: accountUuid } : {}),
    };
  }

  const idToken = optionalBoundedString(record.id_token, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const tokenType = optionalBoundedString(record.token_type, 256);
  const scope = optionalBoundedString(record.scope, 4 * 1024);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    ...(idToken !== undefined ? { id_token: idToken } : {}),
    ...(tokenType !== undefined ? { token_type: tokenType } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

export async function oauthTokenEndpointErrorFromResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<OAuthTokenEndpointError> {
  let category: OAuthTokenEndpointErrorCategory = 'provider_rejected';
  try {
    const payload = await readBoundedOAuthJson(response, signal);
    const code = findProviderErrorCode(payload);
    if (code === 'invalid_grant' || code === 'invalid_token') category = code;
  } catch (error) {
    if (error instanceof OAuthTokenEndpointError && error.category === 'response_too_large') {
      category = 'response_too_large';
    }
    if (error instanceof OAuthTokenEndpointError && error.category === 'outcome_unknown') {
      return new OAuthTokenEndpointError('outcome_unknown', response.status);
    }
  }
  return new OAuthTokenEndpointError(category, response.status);
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
  if (input.provider === 'claude-subscription') {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': config.tokenUserAgent },
      body: JSON.stringify({ ...common, state: input.state }),
    };
  }
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.tokenUserAgent,
    },
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

function requireClosedRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  const allowed = new Set(allowedKeys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new OAuthTokenEndpointError('invalid_response');
    }
    record[key] = descriptor.value;
  }
  return record;
}

function requireToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > OAUTH_LOGIN_MAX_TOKEN_CHARS
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value;
}

function optionalBoundedString(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value;
}

function requireExpiresIn(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > 366 * 24 * 60 * 60
  ) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value as number;
}

function expiresAtFromExpiresIn(now: number, expiresIn: number): number {
  const expiresAt = now + expiresIn * 1000;
  if (!Number.isFinite(now) || now < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return expiresAt;
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
