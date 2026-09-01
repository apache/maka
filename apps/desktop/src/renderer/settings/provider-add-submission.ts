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

import {
  PROVIDER_REGISTRY,
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  providerSupportsModelDiscovery,
  validateSlug,
  type ModelInfo,
  type ProviderType,
} from '@maka/core/llm-connections';
import type { CreateConnectionInput, IdentifiedLlmConnection } from '@maka/core/llm-connections';
export type ApiKeyOnboardingRoute =
  | { readonly kind: 'host' }
  | {
      readonly kind: 'legacy';
      readonly reason:
        | 'provider_auth'
        | 'custom_endpoint'
        | 'cloudflare'
        | 'request_headers'
        | 'request_body';
    };

export function shouldShowManagedOnboardingOutcomeUnknown(
  hasSaveUncertainty: boolean,
  busy: boolean,
): boolean {
  return hasSaveUncertainty && !busy;
}

/** Decide the only writer before either writer performs a side effect. */
export function apiKeyOnboardingRoute(input: {
  readonly providerType: ProviderType;
  readonly requestHeaderCount: number;
  readonly hasRequestBodyOverlay: boolean;
}): ApiKeyOnboardingRoute {
  const definition = PROVIDER_REGISTRY[input.providerType];
  if (!providerAuthSupportsApiKey(input.providerType) || definition.authKind !== 'api_key') {
    return { kind: 'legacy', reason: 'provider_auth' };
  }
  if (input.providerType === 'cloudflare-workers-ai') {
    return { kind: 'legacy', reason: 'cloudflare' };
  }
  if (!definition.baseUrl) return { kind: 'legacy', reason: 'custom_endpoint' };
  if (input.requestHeaderCount > 0) return { kind: 'legacy', reason: 'request_headers' };
  if (input.hasRequestBodyOverlay) return { kind: 'legacy', reason: 'request_body' };
  return { kind: 'host' };
}

export function stableOnboardingModels(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => {
    const leftLabel = left.displayName?.trim() || left.id;
    const rightLabel = right.displayName?.trim() || right.id;
    return leftLabel.localeCompare(rightLabel) || left.id.localeCompare(right.id);
  });
}

export function initialOnboardingModelIds(
  models: readonly ModelInfo[],
  recommendedModelId: string,
): string[] {
  if (models.some((model) => model.id === recommendedModelId)) return [recommendedModelId];
  const first = stableOnboardingModels(models)[0];
  return first ? [first.id] : [];
}

/**
 * The two decisions 添加连接 makes that are not layout: which fields a provider
 * type actually demands, and what the caller learns when the catalog fetch
 * that follows creation fails.
 *
 * They live outside the component because both used to carry a relay-only
 * special case, and neither was observable from a test: the form required a
 * hand-typed model id from custom relays alone, and then discarded exactly
 * those relays' discovery failures. Reverting either of those would have left
 * every suite green.
 */

export type AddProviderField = 'slug' | 'apiKey' | 'accountId' | 'baseUrl' | 'form';

export type AddProviderIssue =
  | { readonly field: 'slug'; readonly reason: 'invalid'; readonly detail: string }
  | { readonly field: 'slug'; readonly reason: 'duplicate' }
  | { readonly field: 'apiKey'; readonly reason: 'required' }
  | { readonly field: 'accountId'; readonly reason: 'required' }
  | { readonly field: 'baseUrl'; readonly reason: 'required' }
  | { readonly field: 'form'; readonly reason: 'experimental' };

export interface AddProviderDraft {
  readonly providerType: ProviderType;
  readonly slug: string;
  readonly existingSlugs: readonly string[];
  readonly apiKey: string;
  readonly cloudflareAccountId: string;
  readonly baseUrl: string;
}

/**
 * The field gate, in the order the form reports it — first issue wins, so a
 * user fixes one thing at a time rather than being handed a wall.
 *
 * Reason codes, not sentences: the component owns the localized copy, and a
 * test asserting on `{field, reason}` keeps saying the same thing when the
 * wording changes.
 *
 * There is deliberately no rule for the model id. A provider that ships a
 * recommended default does not ask, and one that does not ship a default can
 * discover its catalog after creation — so requiring a typed id ahead of
 * either would demand a guess about a catalog the app is about to fetch.
 */
export function validateAddProviderDraft(draft: AddProviderDraft): AddProviderIssue | null {
  const defaults = PROVIDER_REGISTRY[draft.providerType];
  const slugIssue = validateSlug(draft.slug);
  if (slugIssue) return { field: 'slug', reason: 'invalid', detail: slugIssue };
  if (draft.existingSlugs.includes(draft.slug)) return { field: 'slug', reason: 'duplicate' };
  const requiresApiKey =
    providerAuthRequiresSecret(draft.providerType) &&
    providerAuthSupportsApiKey(draft.providerType);
  if (requiresApiKey && !draft.apiKey.trim()) return { field: 'apiKey', reason: 'required' };
  const isCloudflareWorkersAi = draft.providerType === 'cloudflare-workers-ai';
  if (isCloudflareWorkersAi && !draft.cloudflareAccountId.trim()) {
    return { field: 'accountId', reason: 'required' };
  }
  // Cloudflare builds its endpoint from the account id above, so it is not
  // missing one — it just has not composed it yet.
  const requiresBaseUrl = !defaults.baseUrl && !isCloudflareWorkersAi;
  if (requiresBaseUrl && !draft.baseUrl.trim()) return { field: 'baseUrl', reason: 'required' };
  if (defaults.status === 'phase3-experimental') return { field: 'form', reason: 'experimental' };
  return null;
}

export interface CreatedProvider {
  readonly connection: IdentifiedLlmConnection;
  /**
   * Present when the catalog fetch that follows creation threw. The connection
   * exists either way — discovery is a convenience on top of a successful
   * create, never a condition of it — so this is something to report, not a
   * failure to roll back.
   */
  readonly modelDiscoveryError?: unknown;
}

export interface ProviderCreationBridge {
  create(input: CreateConnectionInput): Promise<IdentifiedLlmConnection>;
  fetchModels(connection: { readonly connectionId: string; readonly slug: string }): Promise<unknown>;
}

/**
 * Create the connection, then let its catalog answer for itself.
 *
 * Every provider that supports discovery reports its failure. The custom
 * relays used to be the exception — swallowed on the reasoning that a relay
 * may not implement the endpoint — which left the one provider class most
 * likely to be misconfigured with an empty model picker and nothing said.
 */
export async function createProviderWithDiscovery(
  bridge: ProviderCreationBridge,
  input: CreateConnectionInput,
): Promise<CreatedProvider> {
  const connection = await bridge.create(input);
  if (!providerSupportsModelDiscovery(input.providerType)) return { connection };
  try {
    await bridge.fetchModels({ connectionId: connection.connectionId, slug: connection.slug });
  } catch (modelDiscoveryError) {
    return { connection, modelDiscoveryError };
  }
  return { connection };
}
