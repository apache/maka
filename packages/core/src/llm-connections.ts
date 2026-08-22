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

/**
 * LLM provider connection metadata.
 *
 * Connection records are stored on disk without secrets. API keys and OAuth
 * tokens live in the desktop credential store, keyed by connection slug.
 */

import type { BackendKind } from './session.js';
import type { RelayModelProfiles } from './model-thinking.js';
import type {
  JsonObject,
  RequestHeaderUpdate,
  SavedRequestHeaders,
} from './request-customization.js';
import { CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS } from './codex-model-compatibility.js';
import {
  CATALOG_PROVIDER_TYPES,
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  OPENCODE_FREE_DEFAULT_MODEL,
  PROVIDER_REGISTRY,
  READY_PROVIDER_TYPES,
  RECOMMENDED_PROVIDER_TYPES,
  type ApplyPatchProtocol,
  type ProviderCatalogGroup,
  type ProviderCategory,
  type ProviderDefaults,
  type ProviderRuntimeAdapter,
  type ProviderResponsesContract,
  type ProviderType,
} from './provider-registry.js';

export type { BackendKind } from './session.js';
export { CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS };
export {
  CATALOG_PROVIDER_TYPES,
  OPENCODE_FREE_DEFAULT_ENABLED_MODELS,
  OPENCODE_FREE_DEFAULT_MODEL,
  PROVIDER_REGISTRY,
  READY_PROVIDER_TYPES,
  RECOMMENDED_PROVIDER_TYPES,
};
export type {
  ApplyPatchProtocol,
  ProviderCatalogGroup,
  ProviderCategory,
  ProviderDefaults,
  ProviderRuntimeAdapter,
  ProviderResponsesContract,
  ProviderType,
};

export function isRelayProviderType(
  providerType: ProviderType,
): providerType is 'openai-compatible' | 'openai-responses-compatible' {
  return PROVIDER_REGISTRY[providerType].relayModelProfiles === true;
}

export type ConnectionAuth =
  | { kind: 'api_key'; apiKey: string }
  | { kind: 'optional_api_key'; apiKey?: string }
  | { kind: 'oauth_token'; oauthToken: string; expiresAt?: number }
  | { kind: 'none' };

export interface ModelInfo {
  id: string;
  displayName?: string;
  /** Short upstream description, when the provider advertises one. */
  description?: string;
  /** Account-advertised request wire when one provider exposes multiple model protocols. */
  apiProtocol?: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
  contextWindow?: number;
  /** Maximum provider-visible input tokens, when narrower than contextWindow. */
  inputLimit?: number;
  maxOutputTokens?: number;
  /** Knowledge cutoff reported by the provider or static catalog. */
  knowledgeCutoff?: string;
  /** Whether the model advertises structured JSON output separately from tools. */
  structuredOutput?: boolean;
  /** Date on which the upstream model facts were last refreshed. */
  lastUpdated?: string;
  capabilities?: {
    chat?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    functionCalling?: boolean;
    imageGeneration?: boolean;
    /** Provider-hosted live web search, using this exact model and connection. */
    webSearch?: boolean;
  };
  /** Multimodal input/output support from provider catalog metadata. */
  modalities?: {
    input: Array<'text' | 'image' | 'audio' | 'pdf'>;
    output: Array<'text' | 'image' | 'audio'>;
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

/** Non-secret provider/model configuration required by runtime execution. */
export interface RuntimeExecutionConnection {
  slug: string;
  providerType: ProviderType;
  baseUrl?: string;
  defaultModel: string;
  models?: ModelInfo[];
  /**
   * Per-model user declarations for a custom OpenAI relay: the facts
   * (offered thinking levels, vision enable/disable, context window) that
   * neither the relay's /models report nor built-in metadata can decide
   * (see `RelayModelProfile` in `model-thinking.ts`). First-class and typed —
   * relay models are unknown to metadata and a catalog refresh rewrites
   * `models[]` rows, so declarations live next to the user-edited fields.
   * Invariants enforced at store boundaries: only custom OpenAI relay
   * connections carry profiles, and only for ids in `enabledModelIds`
   * (disabling a model deletes its profile).
   */
  relayModelProfiles?: RelayModelProfiles;
  /** Additional top-level JSON properties added to model request bodies. */
  requestBodyOverlay?: JsonObject;
  /** Free-form, non-secret per-connection data; nothing reads a key unless it is shaped for the connection's provider type. */
  extras?: Record<string, unknown>;
}

export interface LlmConnection extends RuntimeExecutionConnection {
  name: string;
  enabled: boolean;
  /** Model ids shown in model pickers. Legacy connections omit this and enable only their default model. */
  enabledModelIds?: string[];
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
}

/**
 * Read-time normalizer: the model ids a stored connection exposes.
 *
 * A row written before `enabledModelIds` existed carries only `defaultModel`,
 * so reading one resolves to the default model alone — never the full
 * discovered catalog. This is a migration shim for reads, NOT the rule for
 * writes: merging the default into a selection the user just made would
 * re-assert a choice they withdrew. Explicit selections go through
 * `reconcileConnectionAfterEnabledModelsChange`.
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
 * What `connection.models` IS, which is not the same question as where it was
 * written from. This describes a catalog for display; it never decides what a
 * connection may run — see `authorizeConnectionModel`.
 *
 * `modelSource` records provenance: `'fallback'` for the array a connection was
 * seeded with, `'fetched'` once a discovery run replaced it. For a provider
 * whose `modelDiscovery.kind` is `'fallback'` that run replays the array this
 * build shipped, so `'fetched'` is accurate and still describes a snapshot. The
 * predicate for "a provider enumerated this account" is therefore a
 * conjunction, and this is the only place it lives:
 *
 *   - `live` — a provider with a model-list endpoint enumerated this account.
 *     A model missing from it is one this provider did not mention, which is
 *     worth telling the user.
 *   - `snapshot` — the array this build shipped, either as the seed a
 *     connection was created with or replayed by a `kind: 'fallback'`
 *     provider's discovery run. It describes the provider at release, not the
 *     account, so absence from it means nothing at all (#1584).
 *   - `absent` — no catalog, and none asked for. A connection can be created
 *     and used before its first discovery run (#2896).
 *
 * The split is by authority, not by how full the array is: "the provider
 * listed nothing" and "nobody has asked yet" are opposite facts, and an empty
 * array alone cannot tell them apart. `modelSource` can — the codec keeps it
 * present exactly when a run has written this row.
 */
export type ConnectionModelInventory = 'absent' | 'live' | 'snapshot';

/** The `LlmConnection` fields that decide what a connection may run. */
export interface ConnectionModelAuthorityInput {
  readonly providerType: ProviderType;
  readonly enabledModelIds?: readonly string[];
  readonly defaultModel?: string;
  readonly models?: readonly ModelInfo[];
  readonly modelSource?: ModelDiscoverySource;
}

export function classifyConnectionModelInventory(
  connection: ConnectionModelAuthorityInput,
): ConnectionModelInventory {
  if (connection.models === undefined || connection.modelSource === undefined) return 'absent';
  if (!providerSupportsModelDiscovery(connection.providerType)) return 'snapshot';
  return connection.modelSource === 'fetched' ? 'live' : 'snapshot';
}

/**
 * The model this connection runs for this id, or `undefined` if the user never
 * enabled it.
 *
 * `enabledModelIds` is the whole authorization. Only the user writes it, and
 * only through connection settings, so it is the one input that speaks for the
 * account. Everything else Maka holds is an observation: a `/models` response
 * ages, arrives filtered, or — for a provider with no model-list endpoint —
 * never arrives at all. An observation that cannot see a model is not evidence
 * the account cannot run it.
 *
 * So no catalog vetoes the user here. A model the user enabled and no source
 * describes resolves to a bare `ModelInfo`, the request goes out, and the
 * provider answers for its own account. That answer is always more accurate
 * than a refusal Maka synthesizes from a list it may not even have (#1584),
 * and it is what lets a connection work before its first discovery run
 * (#2896). Guessing wrong costs one failed request with the provider's own
 * error on it.
 *
 * `classifyConnectionModelInventory` still says whether a catalog could have
 * seen the model, and the picker uses that to annotate one the provider did
 * not mention. Annotating is not vetoing.
 */
export function authorizeConnectionModel(
  connection: ConnectionModelAuthorityInput,
  modelId: string,
): ModelInfo | undefined {
  const model = modelId.trim();
  if (!model || !connectionEnabledModelIds(connection).includes(model)) return undefined;
  // The one veto: quarantined ids fail in a shape the send cannot surface
  // (e.g. a billed 200 with an empty completion), so the request settling it
  // is not available as the arbiter. See ProviderDefaults.brokenModelIds.
  if (PROVIDER_DEFAULTS[connection.providerType]?.brokenModelIds?.includes(model)) {
    return undefined;
  }
  // The observed row wins wherever it exists: it carries wire metadata such as
  // `apiProtocol`, and capabilities, which a synthesized entry cannot. Absent
  // capabilities already mean "unknown", not "unsupported".
  return connection.models?.find((entry) => entry.id.trim() === model) ?? { id: model };
}

/**
 * THE rule for a connection's model selection:
 * **`defaultModel` is either absent, or a member of `enabledModelIds`.**
 *
 * Applied when the user states a new enabled set. Dropping a model that
 * happens to be the default drops the default with it, rather than moving the
 * default to some other member of the set: which model a new chat starts on is
 * 设置 · 通用's one control, and picking a replacement here would answer that
 * question on the user's behalf from a page that no longer asks it. The
 * connection is then simply not the workspace default — the readiness gate
 * reports `missing_model` for it, which is what it is.
 *
 * The old behavior merged the default back into every write, which made
 * unchecking the default a silent no-op: the recomputed list equalled the
 * current one, the write short-circuited, and the box re-checked itself.
 */
export function reconcileConnectionAfterEnabledModelsChange(
  connection: { defaultModel?: unknown },
  nextEnabledModelIds: readonly unknown[],
): {
  defaultModel: string;
  enabledModelIds: string[];
} {
  const enabled = new Set<string>();
  for (const candidate of nextEnabledModelIds) {
    if (typeof candidate !== 'string') continue;
    const id = candidate.trim();
    if (id) enabled.add(id);
  }
  const previousDefault =
    typeof connection.defaultModel === 'string' ? connection.defaultModel.trim() : '';
  return {
    defaultModel: enabled.has(previousDefault) ? previousDefault : '',
    enabledModelIds: [...enabled],
  };
}

/**
 * After a successful live model discovery, keep the connection usable.
 *
 * Fetching models used to leave a stale `defaultModel` (e.g. retired
 * `moonshot-v1-*` fallbacks) that is absent from the live inventory. The
 * readiness gate then fails with `model_not_enabled` — the "pull models and
 * the connection breaks" regression. Prefer an already-enabled id that is
 * still live; otherwise take the first discovered id.
 *
 * Repair is all this does for a default that is set. An ABSENT default is not
 * a stale one, so there is nothing here to repair: the user cleared it by
 * unchecking that model, and picking a replacement — the first still-enabled
 * id, or the first live one — would re-assert the choice they withdrew on
 * every refresh.
 *
 * The single exception is a connection that has never had models to choose
 * from: four providers ship no `fallbackModels` (LM Studio and the three
 * *-compatible ones), so for them discovery is the only place a first default
 * can come from. `hasModelInventory` marks that case and nothing else — a
 * non-empty inventory, fetched or a cached fallback catalog, means the user
 * has had a list in front of them.
 */
/**
 * Resolve a stored id against one inventory. Whether an id is superseded is a
 * property of the inventory as well as of the caller, so this rewrites only when
 * a caller supplied a table, the stored id is absent, AND its alias is present —
 * the exact case where a literal comparison misreads a rename as a removal.
 */
function supersededModelId(
  modelId: string,
  live: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>> | undefined,
): string {
  if (aliases === undefined || live.has(modelId)) return modelId;
  const alias = aliases[modelId];
  return alias !== undefined && live.has(alias) ? alias : modelId;
}

export function reconcileConnectionAfterModelFetch(
  connection: {
    defaultModel?: unknown;
    enabledModelIds?: unknown;
    /** Whether this connection already had a non-empty inventory before this fetch. */
    hasModelInventory?: boolean;
  },
  models: readonly { id?: unknown }[],
  options?: {
    /**
     * Ids this provider has renamed, mapped to their current form. Omitted by
     * default: model ids are opaque here, so nothing is rewritten unless a
     * caller that knows the provider's naming supplies the table.
     */
    readonly aliases?: Readonly<Record<string, string>>;
  },
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

  // Migrate before matching: a renamed id names a model the inventory still
  // offers, so comparing it literally classifies a live model as retired.
  const previousDefault = supersededModelId(
    typeof connection.defaultModel === 'string' ? connection.defaultModel.trim() : '',
    live,
    options?.aliases,
  );
  // Dedupe after mapping: a connection holding both forms collapses onto one id
  // here, and one of the returns below hands this list back without passing it
  // through connectionEnabledModelIds.
  const previousEnabled = [
    ...new Set(
      connectionEnabledModelIds(connection).map((id) =>
        supersededModelId(id, live, options?.aliases),
      ),
    ),
  ];

  // Seed a first choice only for a connection that has never had a list to
  // pick from: four providers ship no `fallbackModels`, so for them discovery
  // is the only place a first default can come from.
  if (
    !previousDefault &&
    previousEnabled.length === 0 &&
    !connection.hasModelInventory &&
    liveIds.length > 0
  ) {
    return { defaultModel: liveIds[0]!, enabledModelIds: [liveIds[0]!] };
  }

  // Everything the user chose survives the fetch. A response that omits a
  // model is one observation of an account that can change between requests,
  // arrive filtered, or answer for a provider with no model-list endpoint at
  // all — none of which is grounds for deleting a choice the user made. The
  // picker marks an id the provider no longer mentions; unchecking it stays
  // the user's decision (#1584).
  return {
    defaultModel: previousDefault,
    enabledModelIds: connectionEnabledModelIds({
      defaultModel: previousDefault,
      enabledModelIds: previousEnabled,
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

export const PROVIDER_DEFAULTS = PROVIDER_REGISTRY;

/**
 * The registry entry for a provider, or `undefined` when this build does not
 * register one.
 *
 * Sole owner of the question "is this `providerType` one we know". Plain
 * indexing cannot answer it: `PROVIDER_DEFAULTS` is an object literal, so
 * `PROVIDER_DEFAULTS['__proto__']` and `['toString']` resolve to inherited
 * members and read as registered providers. Every recognition site goes
 * through here rather than repeating the own-property check.
 */
export function providerDefaultsOf(providerType: string): ProviderDefaults | undefined {
  return Object.hasOwn(PROVIDER_DEFAULTS, providerType)
    ? PROVIDER_DEFAULTS[providerType as ProviderType]
    : undefined;
}

export function defaultEnabledModelIdsWhenOmitted(
  providerType: ProviderType,
): readonly string[] | undefined {
  return PROVIDER_DEFAULTS[providerType].defaultEnabledModelIds;
}

export function providerAuthRequiresSecret(providerType: ProviderType): boolean {
  const authKind = PROVIDER_DEFAULTS[providerType]?.authKind;
  return authKind === 'api_key' || authKind === 'oauth_token';
}

export function providerAuthSupportsApiKey(providerType: ProviderType): boolean {
  const authKind = PROVIDER_DEFAULTS[providerType]?.authKind;
  return authKind === 'api_key' || authKind === 'optional_api_key';
}

export function providerSupportsModelDiscovery(providerType: ProviderType): boolean {
  const discovery = PROVIDER_DEFAULTS[providerType]?.modelDiscovery;
  return discovery !== undefined && discovery.kind !== 'fallback';
}

/**
 * The backend that runs a connection.
 *
 * Throws for an unknown `providerType` (a legacy seed, or a connection
 * persisted on a branch that registers a provider this build doesn't know).
 * It used to answer `'fake'` there, which was the last live producer of that
 * value (#3211); there is no honest backend to name for a provider this build
 * cannot describe. Callers that need a non-throwing answer are asking whether
 * the connection is usable, not which backend runs it — use `isRealConnection`
 * / `isConnectionReady` from `connection-readiness.ts`.
 */
export function backendKindOf(c: Pick<LlmConnection, 'providerType'>): BackendKind {
  const defaults = providerDefaultsOf(c.providerType);
  if (!defaults) throw new Error(`Unknown providerType: ${c.providerType}`);
  return defaults.backendKind;
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

/** Derive an unused connection slug from a catalog provider type. */
export function deriveConnectionSlug(
  providerType: ProviderType,
  existingSlugs: readonly string[] = [],
): string {
  const base = providerType.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!existingSlugs.includes(base)) return base;

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingSlugs.includes(candidate)) return candidate;
  }
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
  /** When omitted, falls back to the default model alone. */
  enabledModelIds?: string[];
  apiKey?: string;
  relayModelProfiles?: RelayModelProfiles;
  /** Sensitive values are accepted only for initial creation and stored in the credential vault. */
  requestHeaders?: Readonly<Record<string, string>>;
  requestBodyOverlay?: JsonObject;
  extras?: Record<string, unknown>;
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
  /**
   * Replace the whole relay profiles table: absent leaves it untouched,
   * `null` clears it outright, a table replaces it (with the usual rules —
   * only custom OpenAI relays, only for `enabledModelIds`).
   */
  relayModelProfiles?: RelayModelProfiles | null;
  requestBodyOverlay?: JsonObject | null;
  extras?: Record<string, unknown>;
}

export type { RequestHeaderUpdate, SavedRequestHeaders } from './request-customization.js';

export function normalizePersistedConnection(input: unknown): LlmConnection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid connection: expected an object');
  }
  const value = input as Partial<LlmConnection>;
  if (typeof value.providerType !== 'string' || !value.providerType) {
    throw new Error('Invalid connection: providerType is required');
  }
  return {
    ...value,
    enabledModelIds: connectionEnabledModelIds(value),
  } as LlmConnection;
}
