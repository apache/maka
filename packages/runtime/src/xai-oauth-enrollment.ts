import type { OAuthSubscriptionTokens } from './subscription-credentials.js';
import {
  decodeOAuthInitialTokenPayload,
  OAUTH_LOGIN_MAX_TOKEN_CHARS,
  OAuthTokenEndpointError,
  requestOAuthEndpointJson,
} from './oauth-login.js';

const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_DEVICE_ENDPOINT = 'https://auth.x.ai/oauth2/device/code';
const XAI_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

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
    endpoint: XAI_DEVICE_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPE,
        referrer: 'maka',
      }).toString(),
    },
    fetchFn: input.fetchFn,
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  if (!response.ok) throw new OAuthTokenEndpointError('provider_rejected', response.status);
  const payload = closedRecord(response.payload, [
    'device_code',
    'user_code',
    'verification_uri',
    'verification_uri_complete',
    'expires_in',
    'interval',
  ]);
  const deviceCode = requiredString(payload.device_code, OAUTH_LOGIN_MAX_TOKEN_CHARS);
  const userCode = requiredString(payload.user_code, 1_024);
  const verificationUrl = requiredString(
    payload.verification_uri_complete ?? payload.verification_uri,
    8_192,
  );
  assertXaiVerificationUrl(verificationUrl);
  const now = input.now?.() ?? Date.now();
  const expiresIn = positiveInteger(payload.expires_in, 24 * 60 * 60);
  const intervalSeconds =
    payload.interval === undefined ? 5 : positiveInteger(payload.interval, 300);
  const expiresAt = now + expiresIn * 1_000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new OAuthTokenEndpointError('invalid_response', response.status);
  }
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
      throw new OAuthTokenEndpointError('invalid_grant');
    }
    await sleep(intervalMs, input.signal);
    input.signal.throwIfAborted();
    input.onPollAdmission?.();
    const response = await requestOAuthEndpointJson({
      endpoint: XAI_TOKEN_ENDPOINT,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: XAI_DEVICE_GRANT,
          client_id: XAI_CLIENT_ID,
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
    if (code === 'access_denied' || code === 'authorization_denied' || code === 'expired_token') {
      throw new OAuthTokenEndpointError('invalid_grant', response.status);
    }
    throw new OAuthTokenEndpointError('provider_rejected', response.status);
  }
}

function closedRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return record;
}

function requiredString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value;
}

function positiveInteger(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value as number;
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
