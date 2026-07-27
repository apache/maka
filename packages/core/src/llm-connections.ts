/**
 * LLM provider connection metadata.
 *
 * Connection records are stored on disk without secrets. API keys and OAuth
 * tokens live in the desktop credential store, keyed by connection slug.
 */

import type { BackendKind } from './session.js';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_REGISTRY,
  READY_PROVIDER_TYPES,
  RECOMMENDED_PROVIDER_TYPES,
  isWiredOAuthProvider,
  normalizeProviderType,
  type ProviderCatalogGroup,
  type ProviderCategory,
  type ProviderDefaults,
  type ProviderRuntimeAdapter,
  type ProviderType,
} from './provider-registry.js';

export type { BackendKind } from './session.js';
export {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_REGISTRY,
  READY_PROVIDER_TYPES,
  RECOMMENDED_PROVIDER_TYPES,
  isWiredOAuthProvider,
  normalizeProviderType,
};
export type {
  ProviderCatalogGroup,
  ProviderCategory,
  ProviderDefaults,
  ProviderRuntimeAdapter,
  ProviderType,
};

export type ConnectionAuth =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'optional_api_key'; apiKey?: string }
  | { kind: 'oauth_token'; oauthToken: string; expiresAt?: number }
  | { kind: 'none' };

export interface ModelInfo {
  id: string;
  displayName?: string;
  /** Account-advertised request wire when one provider exposes multiple model protocols. */
  apiProtocol?: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: {
    chat?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    functionCalling?: boolean;
    imageGeneration?: boolean;
  };
}

export type ModelDiscoverySource = 'fetched' | 'fallback';

export interface ModelDiscoveryResult {
  models: ModelInfo[];
  source: ModelDiscoverySource;
  /** Unix ms timestamp when this list was produced. */
  fetchedAt: number;
}

export type ConnectionLastTestStatus = 'verified' | 'needs_reauth' | 'error';

export interface LlmConnection {
  slug: string;
  name: string;
  providerType: ProviderType;
  baseUrl?: string;
  defaultModel: string;
  enabled: boolean;
  /** Model ids shown in model pickers. Legacy connections omit this and enable only their default model. */
  enabledModelIds?: string[];
  models?: ModelInfo[];
  modelSource?: ModelDiscoverySource;
  /** Unix ms timestamp for the last successful model discovery result. */
  modelsFetchedAt?: number;
  lastTestStatus?: ConnectionLastTestStatus;
  /** ISO timestamp of the last explicit connection test. */
  lastTestAt?: string;
  /** Generalized status message; never persist raw provider responses or secrets. */
  lastTestMessage?: string;
  createdAt: number;
  updatedAt: number;
  extras?: Record<string, unknown>;
}

/**
 * Return the model ids exposed by a connection, preserving the invariant that
 * its default model is always enabled. Missing legacy state intentionally
 * resolves to the default model only, never the full discovered catalog.
 */
export function connectionEnabledModelIds(connection: {
  defaultModel?: unknown;
  enabledModelIds?: unknown;
}): string[] {
  const candidates = [
    connection.defaultModel,
    ...(Array.isArray(connection.enabledModelIds) ? connection.enabledModelIds : []),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const id = candidate.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * After a successful live model discovery, keep the connection usable.
 *
 * Fetching models used to leave a stale `defaultModel` (e.g. retired
 * `moonshot-v1-*` fallbacks) that is absent from the live inventory. The
 * readiness gate then fails with `model_not_enabled` — the "pull models and
 * the connection breaks" regression. Prefer an already-enabled id that is
 * still live; otherwise take the first discovered id.
 */
export function reconcileConnectionAfterModelFetch(
  connection: {
    defaultModel?: unknown;
    enabledModelIds?: unknown;
  },
  models: readonly { id?: unknown }[],
): {
  defaultModel: string;
  enabledModelIds: string[];
} {
  const liveIds: string[] = [];
  const live = new Set<string>();
  for (const model of models) {
    if (typeof model?.id !== 'string') continue;
    const id = model.id.trim();
    if (!id || live.has(id)) continue;
    live.add(id);
    liveIds.push(id);
  }

  const previousDefault =
    typeof connection.defaultModel === 'string' ? connection.defaultModel.trim() : '';
  const previousEnabled = connectionEnabledModelIds(connection);

  if (liveIds.length === 0) {
    const defaultModel = previousDefault;
    return {
      defaultModel,
      enabledModelIds: connectionEnabledModelIds({
        defaultModel,
        enabledModelIds: previousEnabled,
      }),
    };
  }

  const defaultModel =
    (previousDefault && live.has(previousDefault) ? previousDefault : undefined) ??
    previousEnabled.find((id) => live.has(id)) ??
    liveIds[0]!;

  // Keep previously enabled ids that still exist live, plus the (possibly
  // repaired) default. Do not auto-enable the entire discovered catalog.
  const keptEnabled = previousEnabled.filter((id) => live.has(id) || id === defaultModel);
  return {
    defaultModel,
    enabledModelIds: connectionEnabledModelIds({
      defaultModel,
      enabledModelIds: keptEnabled,
    }),
  };
}

export type ConnectionTestErrorClass =
  | 'auth'
  | 'timeout'
  | 'provider_unavailable'
  | 'network'
  | 'unknown';

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  modelTested?: string;
  errorMessage?: string;
  statusCode?: number;
  errorClass?: ConnectionTestErrorClass;
}

export const CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS = new Set(['gpt-5-codex']);

export const PROVIDER_DEFAULTS = PROVIDER_REGISTRY;

export function providerAuthRequiresSecret(providerType: ProviderType): boolean {
  const authKind = PROVIDER_DEFAULTS[providerType]?.authKind;
  return authKind === 'api_key' || authKind === 'oauth_token';
}

export function providerAuthSupportsApiKey(providerType: ProviderType): boolean {
  const authKind = PROVIDER_DEFAULTS[providerType]?.authKind;
  return authKind === 'api_key' || authKind === 'optional_api_key';
}

export function backendKindOf(c: Pick<LlmConnection, 'providerType'>): BackendKind {
  // Unknown providerType (legacy seed, or a connection persisted on a branch
  // that registers a provider this build doesn't know) → treat as non-real,
  // matching `isFakeBackend` in connection-readiness.ts.
  return PROVIDER_DEFAULTS[c.providerType]?.backendKind ?? 'fake';
}

export function effectiveBaseUrl(c: Pick<LlmConnection, 'providerType' | 'baseUrl'>): string {
  if (c.baseUrl && c.baseUrl.trim()) return c.baseUrl.trim();
  return PROVIDER_DEFAULTS[c.providerType]?.baseUrl ?? '';
}

/**
 * Reduce a submitted connection `baseUrl` to the value that should be persisted,
 * or `undefined` if nothing should be stored.
 *
 * The add-form and edit-form pre-fill `defaults.baseUrl` and submit it verbatim
 * when the user does not customize the field. Storing that default as an
 * explicit override would pin the connection to the current default —
 * `effectiveBaseUrl` honors the explicit value first, so future default changes
 * would not reach it. Only a real override (non-empty and differing from the
 * current default) is persisted; the empty/whitespace and equals-default cases
 * collapse to `undefined` so the connection reads back through the live default.
 */
export function persistedBaseUrl(
  providerType: ProviderType,
  baseUrl: string | undefined | null,
): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  if (trimmed === PROVIDER_DEFAULTS[providerType]?.baseUrl) return undefined;
  return trimmed;
}

export function validateSlug(slug: string): string | null {
  if (!slug.trim()) return 'Slug is required';
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    return 'Slug must be lowercase letters, digits, and hyphens';
  }
  if (slug.length > 64) return 'Slug must be 64 characters or fewer';
  return null;
}

/**
 * PR-UI-IPC-1 (@kenji msg 35260e29 + 2e495eb7): connection `baseUrl`
 * scheme allowlist gate.
 *
 * The renderer can submit any string for `CreateConnectionInput.baseUrl`
 * / `UpdateConnectionInput.baseUrl`; the AI SDK fetch downstream
 * normally rejects non-HTTP schemes, but the IPC boundary should
 * not depend on that. A successful persist of a bogus baseUrl
 * (`javascript:`, `file:///etc/passwd`, garbage) means the bad URL
 * lives on disk and could later be loaded into an HTTP client
 * configured to honor it (or worse, leak the user's API key to an
 * attacker-controlled scheme handler).
 *
 * This is a credentials-exfiltration boundary, not a usability gate
 * — we intentionally do NOT block private-network / localhost URLs
 * (Ollama, LM Studio, vLLM and other local providers need
 * `http://localhost:11434`, `http://127.0.0.1:8000`, etc. to work).
 * Provider/setupMode-specific further restrictions are a separate
 * future PR.
 *
 * **Pair with `normalizeConnectionBaseUrl` for the IPC site.**
 * This function only validates; it does NOT trim or canonicalize.
 * The IPC handler should use `normalizeConnectionBaseUrl` so the
 * store only ever sees the canonical form (trimmed URL or
 * undefined) — not raw whitespace-padded input. See @kenji msg
 * 8755ffb3.
 *
 * Accepts:
 *   - `undefined` / empty string / whitespace-only: no override,
 *     fall back to provider default. Returns `null` (valid). The
 *     caller treats this as "user wants the provider's canonical
 *     baseUrl".
 *   - `http:` / `https:` schemes parsing as valid `URL` (case-
 *     insensitive scheme via WHATWG URL spec).
 *
 * Rejects (returns error message):
 *   - Any other scheme (`file:`, `javascript:`, `data:`, `vbscript:`,
 *     `chrome-extension:`, `app:`, `maka:`, custom).
 *   - Malformed URL strings the `URL` constructor throws on.
 *   - Pathological lengths (> 2048 chars — defense against
 *     adversarial inputs; real-world baseUrls are < 100 chars).
 *
 * Returns `null` on accept, an error string on reject. Mirrors
 * `validateSlug`'s shape.
 */
export function validateConnectionBaseUrl(baseUrl: string | undefined | null): string | null {
  // No baseUrl override is valid — the caller falls back to the
  // provider default.
  if (baseUrl === undefined || baseUrl === null) return null;
  const trimmed = baseUrl.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 2048) {
    return 'baseUrl must be 2048 characters or fewer';
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'baseUrl must be a valid URL';
  }
  // Closed scheme allowlist. `URL.protocol` includes the trailing
  // colon and is lowercased by the WHATWG URL spec for special
  // schemes.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `baseUrl scheme '${parsed.protocol}' is not allowed (use http: or https:)`;
  }
  return null;
}

/**
 * PR-UI-IPC-1 review fixup v2 (@kenji msg 8755ffb3 + 6b638e08):
 * IPC-site chokepoint that BOTH validates AND normalizes `baseUrl`.
 * Replaces the raw-input passthrough that the validate-only path
 * allowed.
 *
 * The blocker the original v1 had:
 *   - `validateConnectionBaseUrl('   ')` returned `null` ("valid"),
 *     but the IPC handler then passed the raw `'   '` to the store,
 *     which on `update` treats truthy string as set-override and
 *     could persist whitespace.
 *   - `validateConnectionBaseUrl('  https://api.openai.com  ')`
 *     returned `null`, but the store persisted the whitespace-
 *     padded raw string.
 *
 * Caller contract:
 *
 * The caller calls this helper ONLY when it has a string value
 * (the IPC handler already decides whether `baseUrl` is in the
 * patch at all; absent / undefined means "don't touch" for
 * update, "use provider default" for create — neither needs
 * validation).
 *
 * Return shape:
 *   - `{ ok: false, error }` — bad scheme / malformed / oversize.
 *   - `{ ok: true, value: '<trimmed URL>' }` — accepted override.
 *     Caller sets the store payload's `baseUrl` to this value.
 *   - `{ ok: true, value: '' }` — EXPLICIT CLEAR INTENT (user
 *     typed whitespace meaning "remove my override"). Caller must
 *     preserve this as `''` so the store's existing clear semantics
 *     (`patch.baseUrl !== undefined ? patch.baseUrl || undefined :
 *     current.baseUrl`) treat it as "clear existing override". DO
 *     NOT convert to `undefined` — that would be "don't touch" and
 *     silently swallow the user's clear intent.
 *
 * The trim is the only canonicalization performed. We deliberately
 * do NOT change scheme/host case, strip default ports, drop
 * fragments, etc. — that's a different normalization (URL
 * canonicalization) and could surprise users who deliberately
 * configured `https://Example.com:443/V1`. Trim is the minimum
 * needed to prevent whitespace from becoming a stored override.
 */
export function normalizeConnectionBaseUrl(
  baseUrl: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  // PR-UI-IPC-1 review fixup v3 (@kenji msg 57ac8a8c): defensive
  // runtime-type guard. TypeScript signature `(input: string)` is
  // a compile-time guarantee, but IPC payloads from the renderer
  // arrive over a process boundary and could be `null` / number /
  // object / array regardless. Without this guard, `baseUrl.trim()`
  // would throw TypeError on non-string and the IPC handler would
  // surface an opaque crash instead of the typed reject the gate
  // promises.
  if (typeof baseUrl !== 'string') {
    return { ok: false, error: 'baseUrl must be a string' };
  }
  // Validate first so bad schemes / malformed / oversize reject
  // before we report a normalized value.
  const error = validateConnectionBaseUrl(baseUrl);
  if (error !== null) {
    return { ok: false, error };
  }
  // Validate accepted. Trim is the only canonicalization. An empty
  // trimmed value is the explicit-clear intent (user typed
  // whitespace = "remove my override"); preserve it as `''` so the
  // store's existing clear semantics fire. The caller must NOT
  // convert this to `undefined` — see contract note above.
  return { ok: true, value: baseUrl.trim() };
}

export interface CreateConnectionInput {
  slug: string;
  name: string;
  providerType: ProviderType;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
}

export interface UpdateConnectionInput {
  name?: string;
  baseUrl?: string;
  defaultModel?: string;
  enabled?: boolean;
  enabledModelIds?: string[];
  apiKey?: string;
  models?: ModelInfo[];
  modelSource?: ModelDiscoverySource;
  modelsFetchedAt?: number;
  lastTestStatus?: ConnectionLastTestStatus;
  lastTestAt?: string;
  lastTestMessage?: string;
}

export function migrateConnectionV1ToV2(old: unknown): LlmConnection {
  const value = old as Partial<LlmConnection> & {
    backend?: string;
    authType?: string;
    slug?: string;
    name?: string;
    defaultModel?: string;
    baseUrl?: string;
    createdAt?: number;
  };
  if (value.providerType) {
    return {
      ...value,
      providerType: normalizeProviderType(value.providerType),
      enabledModelIds: connectionEnabledModelIds(value),
    } as LlmConnection;
  }
  if (!value.slug) throw new Error('Cannot migrate connection without slug');

  const now = Date.now();
  if (value.backend === 'claude' && value.authType === 'oauth_token') {
    return {
      slug: value.slug,
      name: value.name ?? value.slug,
      providerType: 'claude-subscription',
      ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}),
      defaultModel: value.defaultModel || 'claude-sonnet-4-5-20250929',
      enabled: false,
      enabledModelIds: [value.defaultModel || 'claude-sonnet-4-5-20250929'],
      createdAt: value.createdAt ?? now,
      updatedAt: now,
    };
  }

  if (value.backend === 'claude' || value.backend === undefined) {
    return {
      slug: value.slug,
      name: value.name ?? value.slug,
      providerType: 'anthropic',
      ...(value.baseUrl ? { baseUrl: value.baseUrl } : {}),
      defaultModel: value.defaultModel || 'claude-sonnet-4-5-20250929',
      enabled: true,
      enabledModelIds: [value.defaultModel || 'claude-sonnet-4-5-20250929'],
      createdAt: value.createdAt ?? now,
      updatedAt: now,
    };
  }

  throw new Error(`Cannot migrate connection ${value.slug} with backend=${value.backend}`);
}
