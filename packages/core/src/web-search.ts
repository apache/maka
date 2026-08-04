/**
 * Pure WebSearch contracts shared by the explicit UI query and agent-tool
 * paths. One configured provider handles a query; failures are returned as
 * closed reasons rather than silently rotating providers.
 *
 * The active execution owner controls credentials, provider calls, and the
 * incognito gate. Renderer results contain normalized title, URL, and snippet
 * fields and never expose cleartext credentials or raw provider errors.
 */

/** Closed enum of search execution sources. */
export const WEB_SEARCH_PROVIDERS = ['model', 'tavily'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];
export const WEB_SEARCH_CREDENTIAL_PROVIDERS = ['tavily'] as const;
export type WebSearchCredentialProvider = (typeof WEB_SEARCH_CREDENTIAL_PROVIDERS)[number];

/** Renderer-safe result row. No raw HTML, no provider tag soup. */
export interface WebSearchResultRow {
  readonly provider: WebSearchProvider;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** Hostname extracted from `url` so the renderer doesn't reparse. */
  readonly source: string;
}

export type WebSearchErrorReason =
  | 'invalid_query'
  | 'incognito_active'
  | 'not_configured'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'network_error'
  | 'timeout'
  | 'unsupported_provider'
  | 'experimental_disabled';

/** Discriminated response: success = array, error = typed object. */
export type WebSearchResponse =
  | {
      readonly ok: true;
      readonly provider?: WebSearchProvider;
      readonly results: ReadonlyArray<WebSearchResultRow>;
    }
  | { readonly ok: false; readonly reason: WebSearchErrorReason; readonly message: string };

export const WEB_SEARCH_QUERY_MAX_CHARS = 200;
export const WEB_SEARCH_DEFAULT_LIMIT = 5;
export const WEB_SEARCH_MAX_LIMIT = 10;

export const WEB_SEARCH_CREDENTIAL_STATUSES = [
  'untested',
  'valid',
  'invalid_credentials',
  'rate_limited',
  'network_error',
  'timeout',
  'not_configured',
] as const;

export type WebSearchCredentialStatus = (typeof WEB_SEARCH_CREDENTIAL_STATUSES)[number];

export const WEB_SEARCH_CREDENTIAL_SOURCES = ['none', 'saved', 'env'] as const;
export type WebSearchCredentialSource = (typeof WEB_SEARCH_CREDENTIAL_SOURCES)[number];

/**
 * Settings-layer placeholder for a stored API key. The renderer may
 * see this when the settings store mirrors back the current value;
 * an update that comes back with exactly this token MUST preserve
 * the existing token instead of overwriting it. Same pattern as the
 * existing bot token / proxy password mask in Maka.
 */
export const MASKED_TOKEN_SENTINEL = '••••••';

/** Returns `null` when the raw value isn't a usable query. */
export function normalizeWebSearchQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > WEB_SEARCH_QUERY_MAX_CHARS) {
    return trimmed.slice(0, WEB_SEARCH_QUERY_MAX_CHARS);
  }
  return trimmed;
}

/** Clamps `raw` to `[1, WEB_SEARCH_MAX_LIMIT]`, default `WEB_SEARCH_DEFAULT_LIMIT`. */
export function normalizeWebSearchLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return WEB_SEARCH_DEFAULT_LIMIT;
  const rounded = Math.trunc(raw);
  if (rounded < 1) return 1;
  if (rounded > WEB_SEARCH_MAX_LIMIT) return WEB_SEARCH_MAX_LIMIT;
  return rounded;
}

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === 'string' && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Settings shape persisted in `settings.json`. The `apiKey` field is
 * stored in cleartext on disk (settings store sees the raw value);
 * the IPC store boundary returns the masked sentinel to the renderer
 * for display. An update where `apiKey === MASKED_TOKEN_SENTINEL`
 * means "keep current" — the store preserves it.
 */
export interface WebSearchProviderSettings {
  readonly apiKey: string;
  /** Renderer-safe credential source. Never carries the secret value. */
  readonly credentialSource: WebSearchCredentialSource;
  /**
   * Monotonic local version for saved credentials. Async test/query results
   * carry the version they observed; stale results must not overwrite status
   * for a newer key.
   */
  readonly credentialVersion: number;
  readonly credentialStatus: WebSearchCredentialStatus;
  readonly credentialCheckedAt?: string;
}

export interface WebSearchSettings {
  readonly enabled: boolean;
  readonly defaultProvider: WebSearchProvider;
  readonly providers: { readonly tavily: WebSearchProviderSettings };
}

export type WebSearchSettingsPatch = Partial<{
  enabled: boolean;
  defaultProvider: WebSearchProvider;
  providers: Partial<{
    tavily: Partial<WebSearchProviderSettings>;
  }>;
}>;

export function defaultWebSearchSettings(): WebSearchSettings {
  return {
    enabled: false,
    defaultProvider: 'model',
    providers: {
      tavily: {
        apiKey: '',
        credentialSource: 'none',
        credentialVersion: 0,
        credentialStatus: 'untested',
      },
    },
  };
}

export function mergeWebSearchSettings(
  current: WebSearchSettings,
  patch: WebSearchSettingsPatch | undefined,
): WebSearchSettings {
  if (!patch) return current;
  const tavilyPatch = patch.providers?.tavily;
  const candidateProvider = patch.defaultProvider;
  const nextProvider: WebSearchProvider = isWebSearchProvider(candidateProvider)
    ? candidateProvider
    : current.defaultProvider;
  // Mask-sentinel preservation lives here so the IPC boundary does
  // not have to special-case the round-tripped masked value.
  const nextApiKey =
    tavilyPatch && typeof tavilyPatch.apiKey === 'string'
      ? reconcileMaskedToken(current.providers.tavily.apiKey, tavilyPatch.apiKey)
      : current.providers.tavily.apiKey;
  const currentCredentialVersion = normalizeCredentialVersion(
    current.providers.tavily.credentialVersion,
  );
  const explicitCredentialCheckedAt =
    tavilyPatch &&
    typeof tavilyPatch.credentialCheckedAt === 'string' &&
    tavilyPatch.credentialCheckedAt.length <= 64
      ? tavilyPatch.credentialCheckedAt
      : undefined;
  const apiKeyChanged =
    tavilyPatch &&
    typeof tavilyPatch.apiKey === 'string' &&
    tavilyPatch.apiKey !== MASKED_TOKEN_SENTINEL &&
    nextApiKey !== current.providers.tavily.apiKey;
  const nextCredentialVersion = apiKeyChanged
    ? currentCredentialVersion + 1
    : currentCredentialVersion;
  const patchCredentialVersion = tavilyPatch
    ? normalizeOptionalCredentialVersion(tavilyPatch.credentialVersion)
    : undefined;
  const hasExplicitCredentialStatus =
    tavilyPatch &&
    isWebSearchCredentialStatus(tavilyPatch.credentialStatus) &&
    (patchCredentialVersion === undefined || patchCredentialVersion === currentCredentialVersion);
  const credentialStatus = hasExplicitCredentialStatus
    ? tavilyPatch.credentialStatus
    : apiKeyChanged
      ? 'untested'
      : current.providers.tavily.credentialStatus;
  const credentialCheckedAt = hasExplicitCredentialStatus
    ? explicitCredentialCheckedAt
    : apiKeyChanged
      ? undefined
      : current.providers.tavily.credentialCheckedAt;
  return {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    defaultProvider: nextProvider,
    providers: {
      tavily: {
        apiKey: nextApiKey,
        credentialSource: webSearchCredentialSourceFromStoredKey(nextApiKey),
        credentialVersion: nextCredentialVersion,
        credentialStatus,
        ...(credentialCheckedAt ? { credentialCheckedAt } : {}),
      },
    },
  };
}

export function normalizeWebSearchSettings(settings: WebSearchSettings): WebSearchSettings {
  const enabled = settings.enabled === true;
  const defaultProvider = isWebSearchProvider(settings.defaultProvider)
    ? settings.defaultProvider
    : 'model';
  // Cap apiKey length defensively. Tavily keys are < 64 chars; anything
  // longer is almost certainly garbage that would break log redaction.
  const rawApiKey = settings.providers?.tavily?.apiKey;
  const apiKey = typeof rawApiKey === 'string' && rawApiKey.length <= 256 ? rawApiKey : '';
  const rawCredentialStatus = settings.providers?.tavily?.credentialStatus;
  const credentialStatus = isWebSearchCredentialStatus(rawCredentialStatus)
    ? rawCredentialStatus
    : 'untested';
  const rawCredentialCheckedAt = settings.providers?.tavily?.credentialCheckedAt;
  const credentialCheckedAt =
    typeof rawCredentialCheckedAt === 'string' && rawCredentialCheckedAt.length <= 64
      ? rawCredentialCheckedAt
      : undefined;
  const credentialVersion = normalizeCredentialVersion(
    settings.providers?.tavily?.credentialVersion,
  );
  return {
    enabled,
    defaultProvider,
    providers: {
      tavily: {
        apiKey,
        credentialSource: webSearchCredentialSourceFromStoredKey(apiKey),
        credentialVersion,
        credentialStatus,
        ...(credentialCheckedAt ? { credentialCheckedAt } : {}),
      },
    },
  };
}

/**
 * Helper for the IPC store boundary: given a (possibly stale)
 * persisted token and the renderer-sent update token, choose which
 * to persist. Renderer sending exactly the mask means "keep current".
 */
export function reconcileMaskedToken(persisted: string, candidate: string): string {
  if (candidate === MASKED_TOKEN_SENTINEL) return persisted;
  return candidate;
}

/** Returns the rendered representation (masked when non-empty). */
export function maskedTokenForDisplay(persisted: string): string {
  return persisted.length === 0 ? '' : MASKED_TOKEN_SENTINEL;
}

export function isWebSearchCredentialStatus(value: unknown): value is WebSearchCredentialStatus {
  return (
    typeof value === 'string' &&
    (WEB_SEARCH_CREDENTIAL_STATUSES as readonly string[]).includes(value)
  );
}

export function isWebSearchCredentialSource(value: unknown): value is WebSearchCredentialSource {
  return (
    typeof value === 'string' &&
    (WEB_SEARCH_CREDENTIAL_SOURCES as readonly string[]).includes(value)
  );
}

export function webSearchCredentialSourceFromStoredKey(apiKey: string): WebSearchCredentialSource {
  return apiKey.length > 0 ? 'saved' : 'none';
}

export function webSearchCredentialStatusFromResponse(
  response: WebSearchResponse,
): WebSearchCredentialStatus {
  if (response.ok) return 'valid';
  if (isWebSearchCredentialStatus(response.reason)) return response.reason;
  return 'network_error';
}

function normalizeCredentialVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 0;
  return value;
}

function normalizeOptionalCredentialVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return normalizeCredentialVersion(value);
}
