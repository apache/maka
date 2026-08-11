/**
 * Connection readiness — pure, sync judgment shared between the
 * send-path (chat-readiness.ts) and the onboarding state machine
 * (onboarding.ts). PR110a.
 *
 * Source of truth for "is this LlmConnection ready to send a message
 * right now?". Caller is responsible for resolving async inputs
 * (credential lookup → boolean) before calling; this module never
 * touches the credential store, filesystem, or IPC.
 *
 * The single helper here is the only place these criteria live:
 *   - real backend (not `fake`)
 *   - `enabled === true`
 *   - provider auth path is send-wired (Claude subscription is wired;
 *     other OAuth providers stay blocked until their runtime path lands)
 *   - has usable secret OR provider's `authKind === 'none'`
 *   - effective model exists (caller's `requestedModel` if provided,
 *     otherwise `connection.defaultModel`)
 *   - effective model is enabled by the user
 *   - effective model is in `connection.models` (when that list is
 *     enumerated)
 *
 * @kenji + @xuan PR110a review gate: send-path / onboarding / quick
 * chat must call this helper rather than reimplementing the criteria.
 */

import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  isWiredOAuthProvider,
  providerAuthRequiresSecret,
  type LlmConnection,
} from './llm-connections.js';
import { isModelExplicitlyUnsupportedForChat } from './model-catalog.js';

/**
 * Canonical reasons why an LlmConnection is not ready to send.
 *
 * Moved from `apps/desktop/src/main/chat-readiness.ts` to keep the
 * taxonomy stable across the send path and onboarding surfaces.
 * Adding a new reason MUST update both this enum AND the matching
 * `OnboardingState` mapping in `onboarding.ts`.
 */
export type ChatConfigurationReason =
  | 'missing_default_connection'
  | 'connection_missing'
  | 'connection_disabled'
  | 'missing_api_key'
  | 'missing_model'
  | 'empty_model_list'
  | 'model_not_enabled'
  | 'model_not_chat_capable'
  | 'oauth_subscription_not_wired'
  | 'fake_backend';

export type IsConnectionReadyResult =
  | { ready: true; model: string }
  | { ready: false; reason: ChatConfigurationReason };

export interface IsConnectionReadyInput {
  /** The connection to evaluate. */
  connection: LlmConnection;
  /**
   * Whether a usable secret exists for this connection. The caller is
   * responsible for resolving this asynchronously (credential store /
   * IPC) before calling — the helper itself is pure & sync. Providers
   * whose `authKind === 'none'` bypass this check entirely (the helper
   * treats `hasSecret` as irrelevant in that case).
   */
  hasSecret: boolean;
  /**
   * Optional override. When set, the helper validates THIS model
   * against the connection's enabled list. When omitted, it validates
   * `connection.defaultModel`. Same helper covers both the default send
   * path and a `sessions:create` that names an explicit model — no parallel
   * helpers needed.
   */
  requestedModel?: string;
}

/**
 * Pure, sync. Returns `{ ready: true, model }` with the effective
 * model id resolved, or `{ ready: false, reason }` for the first
 * failing criterion (in the order documented below). The order
 * matters: callers may use the returned reason to drive UI fix paths
 * (e.g. onboarding state derivation), so changing the order is a
 * contract change.
 *
 * Order:
 *   1. backend is `fake` → `fake_backend`
 *   2. `enabled === false` → `connection_disabled`
 *   3. unsupported OAuth provider → `oauth_subscription_not_wired`
 *   4. `authKind !== 'none' && !hasSecret` → `missing_api_key`
 *   5. effective model is empty/missing → `missing_model`
 *   6. no models are enabled → `empty_model_list`
 *   7. effective model is not enabled → `model_not_enabled`
 *   8. `connection.models` is enumerated but empty → `empty_model_list`
 *   9. effective model is not in `connection.models` → `model_not_enabled`
 *  10. effective model is explicitly not chat-capable → `model_not_chat_capable`
 *
 * "Effective model" = `requestedModel ?? connection.defaultModel`.
 */
export function isConnectionReady(input: IsConnectionReadyInput): IsConnectionReadyResult {
  const { connection, hasSecret, requestedModel } = input;

  if (isFakeBackend(connection)) {
    return { ready: false, reason: 'fake_backend' };
  }
  if (!connection.enabled) {
    return { ready: false, reason: 'connection_disabled' };
  }
  const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
  if (authKind === 'oauth_token' && !isWiredOAuthProvider(connection.providerType)) {
    return { ready: false, reason: 'oauth_subscription_not_wired' };
  }
  if (providerAuthRequiresSecret(connection.providerType) && !hasSecret) {
    return { ready: false, reason: 'missing_api_key' };
  }
  const model = (requestedModel || connection.defaultModel)?.trim();
  if (!model) {
    return { ready: false, reason: 'missing_model' };
  }
  const enabledModelIds = new Set(connectionEnabledModelIds(connection));
  if (enabledModelIds.size === 0) {
    return { ready: false, reason: 'empty_model_list' };
  }
  if (!enabledModelIds.has(model)) {
    return { ready: false, reason: 'model_not_enabled' };
  }
  if (connection.models) {
    const enabled = new Map<string, (typeof connection.models)[number]>();
    for (const entry of connection.models) {
      const id = entry.id.trim();
      if (id) enabled.set(id, entry);
    }
    if (enabled.size === 0) {
      return { ready: false, reason: 'empty_model_list' };
    }
    const modelEntry = enabled.get(model);
    if (!modelEntry) {
      return { ready: false, reason: 'model_not_enabled' };
    }
    if (isModelExplicitlyUnsupportedForChat(modelEntry)) {
      return { ready: false, reason: 'model_not_chat_capable' };
    }
  }
  return { ready: true, model };
}

/**
 * Pre-readiness normalization for ChatGPT-subscription (Codex)
 * connections: models the subscription cannot serve are filtered out of
 * the enabled list and the default falls back to the first servable
 * model, so the readiness gate below judges the models that would
 * actually be used. Pure; returns the input unchanged for non-Codex
 * providers. Moved from the desktop send path (#1038) so the send gate
 * and the session send projection share one normalization.
 */
export function normalizeOpenAiCodexConnection(connection: LlmConnection): LlmConnection {
  if (connection.providerType !== 'openai-codex') return connection;
  const fallbackModels = PROVIDER_DEFAULTS['openai-codex'].fallbackModels;
  const safeModels = (connection.models ?? []).filter(
    (entry) => entry.id && !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id),
  );
  const models = safeModels.length ? safeModels : fallbackModels.map((id) => ({ id }));
  const enabledModelIds = new Set(models.map((entry) => entry.id));
  const defaultModel =
    connection.defaultModel &&
    !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(connection.defaultModel) &&
    enabledModelIds.has(connection.defaultModel)
      ? connection.defaultModel
      : (models[0]?.id ?? fallbackModels[0] ?? connection.defaultModel);
  if (models === connection.models && defaultModel === connection.defaultModel) return connection;
  return { ...connection, defaultModel, models };
}

/**
 * Whether a connection is backed by a real LLM provider (anything
 * whose `backendKind === 'ai-sdk'`), as opposed to the in-process
 * `fake` backend or an unrecognized legacy provider type.
 *
 * @kenji PR110a review gate: telemetry / lastTestStatus must NOT
 * influence this judgment. A `fake` connection that happens to have
 * `lastTestStatus: 'verified'` is still fake. An unknown providerType
 * (legacy seed, future provider not yet in PROVIDER_DEFAULTS) is also
 * treated as non-real — onboarding then routes the user to the
 * add-provider flow which will rebuild a real connection.
 */
export function isRealConnection(connection: Pick<LlmConnection, 'providerType'>): boolean {
  return !isFakeBackend(connection);
}

function isFakeBackend(connection: Pick<LlmConnection, 'providerType'>): boolean {
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  if (!defaults) return true; // unknown providerType → treat as non-real
  return defaults.backendKind === 'fake';
}
