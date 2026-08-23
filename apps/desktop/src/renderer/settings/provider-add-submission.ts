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
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  providerSupportsModelDiscovery,
  validateSlug,
  type ProviderType,
} from '@maka/core/llm-connections';
import type { CreateConnectionInput, LlmConnection } from '@maka/core/llm-connections';

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
  const defaults = PROVIDER_DEFAULTS[draft.providerType];
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
  readonly connection: LlmConnection;
  /**
   * Present when the catalog fetch that follows creation threw. The connection
   * exists either way — discovery is a convenience on top of a successful
   * create, never a condition of it — so this is something to report, not a
   * failure to roll back.
   */
  readonly modelDiscoveryError?: unknown;
}

export interface ProviderCreationBridge {
  create(input: CreateConnectionInput): Promise<LlmConnection>;
  fetchModels(slug: string): Promise<unknown>;
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
    await bridge.fetchModels(connection.slug);
  } catch (modelDiscoveryError) {
    return { connection, modelDiscoveryError };
  }
  return { connection };
}
