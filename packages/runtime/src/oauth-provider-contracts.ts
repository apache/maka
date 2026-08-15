export type OAuthEnrollmentProvider = 'claude-subscription' | 'openai-codex' | 'xai-oauth';

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

/**
 * The local device-authorization window (`expires_at`) elapsed before the
 * user approved. Distinct from a provider rejection: the user simply did
 * not complete authorization in time. Host surfaces map this to
 * `authorization_failed`, never `provider_rejected`.
 */
export class OAuthDeviceAuthorizationExpiredError extends Error {
  constructor() {
    super('Device authorization expired');
    this.name = 'OAuthDeviceAuthorizationExpiredError';
  }
}

export const OAUTH_MAX_TOKEN_CHARS = 32 * 1024;

export const OAUTH_PROVIDER_CONTRACTS = {
  'claude-subscription': {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizationEndpoint: 'https://claude.com/cai/oauth/authorize',
    tokenEndpoint: 'https://platform.claude.com/v1/oauth/token',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    // `user:inference` is what authorizes Messages API calls; without it the
    // granted token is session-scoped only and every inference request fails
    // with `permission_error: OAuth token does not meet scope requirement
    // any_of(..., user:inference, ...)`. The consent screen renders it as
    // "Contribute to your Claude subscription usage".
    scope: 'user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    tokenUserAgent: 'claude-cli/2.1.153 (external, cli)',
    presentation: 'paste-code',
    experimentalEnvironmentVariable: 'MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL',
  },
  'openai-codex': {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    tokenUserAgent: 'maka-desktop/0.1.0 (oauth-subscription)',
    // ChatGPT device-code flow (official codex CLI): request a one-time
    // user code, verify at `deviceVerifyUrl`, poll `deviceauth/token`,
    // then exchange the returned authorization code with this redirect URI.
    deviceAuthBaseUrl: 'https://auth.openai.com/api/accounts',
    deviceVerifyUrl: 'https://auth.openai.com/codex/device',
    deviceRedirectUri: 'https://auth.openai.com/deviceauth/callback',
    experimentalEnvironmentVariable: 'MAKA_CODEX_SUBSCRIPTION_EXPERIMENTAL',
  },
  'xai-oauth': {
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize',
    deviceEndpoint: 'https://auth.x.ai/oauth2/device/code',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    redirectUri: 'http://127.0.0.1:56121/callback',
    scope: 'openid profile email offline_access grok-cli:access api:access',
    presentation: 'loopback',
    authorizationExtras: [['plan', 'generic']] as ReadonlyArray<readonly [string, string]>,
    deviceGrant: 'urn:ietf:params:oauth:grant-type:device_code',
    defaultTokenLifetimeSeconds: 3_600,
  },
} as const;

export function isOAuthEnrollmentProviderEnabled(
  provider: OAuthEnrollmentProvider,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (provider === 'xai-oauth') return true;
  return environment[OAUTH_PROVIDER_CONTRACTS[provider].experimentalEnvironmentVariable] !== '0';
}

/**
 * Reads an OAuth JSON object without closing it against additive provider fields.
 * Accessors and symbol keys remain invalid because decoding must not execute input code.
 */
export function requireOAuthDataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new OAuthTokenEndpointError('invalid_response');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new OAuthTokenEndpointError('invalid_response');
    }
    record[key] = descriptor.value;
  }
  return record;
}

export function requireOAuthBoundedString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value;
}

export function optionalOAuthBoundedString(value: unknown, maxChars: number): string | undefined {
  return value === undefined ? undefined : requireOAuthBoundedString(value, maxChars);
}

export function requireOAuthPositiveInteger(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new OAuthTokenEndpointError('invalid_response');
  }
  return value as number;
}

export function oauthExpiresAt(now: number, expiresInSeconds: number, status?: number): number {
  const expiresAt = now + expiresInSeconds * 1_000;
  if (!Number.isFinite(now) || now < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new OAuthTokenEndpointError('invalid_response', status);
  }
  return expiresAt;
}
