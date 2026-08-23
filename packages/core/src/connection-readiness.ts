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
 * Connection readiness — pure, sync judgment shared by task-submission
 * readiness, the onboarding state machine, and legacy-session health
 * projection.
 *
 * Source of truth for "is this LlmConnection ready to send a message
 * right now?". Caller is responsible for resolving async inputs
 * (credential lookup → boolean) before calling; this module never
 * touches the credential store, filesystem, or IPC.
 *
 * The single helper here is the only place these criteria live:
 *   - the provider is one this build knows
 *   - `enabled === true`
 *   - has usable secret OR provider's `authKind === 'none'`
 *   - effective model exists (caller's `requestedModel` if provided,
 *     otherwise `connection.defaultModel`)
 *   - effective model is enabled by the user — which is the whole of the
 *     authorization. A catalog Maka happens to hold neither adds a model to it
 *     nor takes one away; see `authorizeConnectionModel` (#1584)
 *
 * Product readiness projections must call this helper rather than
 * reimplementing the criteria.
 */

import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  providerAuthRequiresSecret,
  providerDefaultsOf,
  authorizeConnectionModel,
  type LlmConnection,
} from './llm-connections.js';
import { isModelExplicitlyUnsupportedForChat } from './model-catalog.js';
import { isRetiredProvider } from './provider-registry.js';

/**
 * Canonical reasons why an LlmConnection is not ready to send.
 *
 * Kept in core so the taxonomy stays stable across readiness and onboarding
 * surfaces.
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
  | 'fake_backend'
  | 'provider_retired';

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
 *   1. `providerType` is not in the registry → `fake_backend`
 *   2. the provider is retired → `provider_retired`
 *   3. `enabled === false` → `connection_disabled`
 *   4. `authKind !== 'none' && !hasSecret` → `missing_api_key`
 *   5. effective model is empty/missing → `missing_model`
 *   6. no models are enabled → `empty_model_list`
 *   7. effective model is not enabled → `model_not_enabled`
 *   8. effective model is explicitly not chat-capable → `model_not_chat_capable`
 *
 * "Effective model" = `requestedModel ?? connection.defaultModel`.
 */
export function isConnectionReady(input: IsConnectionReadyInput): IsConnectionReadyResult {
  const { connection, hasSecret, requestedModel } = input;

  if (!isKnownProvider(connection)) {
    return { ready: false, reason: 'fake_backend' };
  }
  // Ahead of every other check: a retired provider has no Runtime adapter, so
  // the send would be admitted here and only fail deep in model construction.
  // Nothing about the connection can make it sendable again.
  if (isRetiredProvider(connection.providerType)) {
    return { ready: false, reason: 'provider_retired' };
  }
  if (!connection.enabled) {
    return { ready: false, reason: 'connection_disabled' };
  }
  if (providerAuthRequiresSecret(connection.providerType) && !hasSecret) {
    return { ready: false, reason: 'missing_api_key' };
  }
  const model = (requestedModel || connection.defaultModel)?.trim();
  if (!model) {
    return { ready: false, reason: 'missing_model' };
  }
  if (connectionEnabledModelIds(connection).length === 0) {
    return { ready: false, reason: 'empty_model_list' };
  }
  const authorized = authorizeConnectionModel(connection, model);
  if (!authorized) {
    return { ready: false, reason: 'model_not_enabled' };
  }
  // Capabilities are facts wherever they came from: a row that marks a model
  // image-only rules it out of chat regardless of which catalog carried it.
  // Absence from a catalog is not a capability and is not checked — the
  // provider answers for its own account (#1584).
  if (isModelExplicitlyUnsupportedForChat(authorized)) {
    return { ready: false, reason: 'model_not_chat_capable' };
  }
  return { ready: true, model };
}

/**
 * Pre-readiness normalization for ChatGPT-subscription (Codex)
 * connections: models the subscription cannot serve are filtered out of
 * the enabled list and the default falls back to the first servable
 * model, so the readiness gate below judges the models that would
 * actually be used. Pure; returns the input unchanged for non-Codex
 * providers. Moved from the former desktop send gate (#1038) so onboarding
 * and the session compatibility projection share one normalization.
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
 * Whether a connection is backed by a real LLM provider.
 *
 * Since the in-process `fake` backend was retired (#3211) every registered
 * provider runs on `ai-sdk`, so this is exactly "is this `providerType` one
 * the build knows". An unknown one (legacy seed, future provider not yet in
 * PROVIDER_DEFAULTS) is treated as non-real — onboarding then routes the user
 * to the add-provider flow which will rebuild a real connection.
 *
 * @kenji PR110a review gate: telemetry / lastTestStatus must NOT
 * influence this judgment. A connection that cannot describe its provider is
 * still unusable when it happens to carry `lastTestStatus: 'verified'`.
 */
export function isRealConnection(connection: Pick<LlmConnection, 'providerType'>): boolean {
  return isKnownProvider(connection);
}

function isKnownProvider(connection: Pick<LlmConnection, 'providerType'>): boolean {
  return providerDefaultsOf(connection.providerType) !== undefined;
}
