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
  effectiveBaseUrl,
  PROVIDER_DEFAULTS,
  type LlmConnection,
} from '@maka/core/llm-connections';
import {
  lookupModelProviderOverride,
  modelMetadataIdsForProvider,
} from '@maka/core/model-metadata';
import { redactSecrets } from '@maka/core/display-redaction';

export interface ProviderEndpointPresentation {
  /** The effective base endpoint, with any display-facing credentials masked. */
  value: string | null;
  /** Whether the connection detail page should offer an endpoint editor. */
  editable: boolean;
  /** Explains an absent concrete value without making the row disappear. */
  emptyState: 'managed' | 'missing';
  /**
   * The displayed value is the connection-level base endpoint, but some models
   * route through model-level endpoint overrides before a request, so an
   * individual model may use a different address. Present only when the
   * connection itself configures no baseUrl — a configured baseUrl wins over
   * every model-level override at runtime, so then the row is the exact truth.
   */
  modelOverrides?: true;
}

/**
 * Resolve the endpoint fact shown on a provider connection detail page.
 *
 * Visibility and editability are deliberately separate. Built-in providers
 * still own their fixed URL, but the user needs to see it to distinguish
 * similarly named access paths and regions. Custom relays and local runtimes
 * keep the existing editor because their address genuinely belongs to the
 * connection. Derived endpoints (for example Cloudflare account URLs) are
 * concrete once persisted, but are never hand-edited here.
 */
export function providerEndpointPresentation(
  connection: {
    providerType: LlmConnection['providerType'];
    baseUrl?: string;
  },
): ProviderEndpointPresentation {
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const effective = effectiveBaseUrl(connection).trim();
  const value = endpointForDisplay(effective);
  const editable = defaults.authKind !== 'oauth_token'
    && !defaults.baseUrlTemplate
    && (!defaults.baseUrl || defaults.category === 'local');

  return {
    value: value || null,
    editable,
    emptyState: defaults.authKind === 'oauth_token' ? 'managed' : 'missing',
    ...(providerRoutesModelsElsewhere(connection) ? { modelOverrides: true as const } : {}),
  };
}

/** The override table is immutable generated data, so a per-provider verdict is stable. */
const modelOverrideRouteCache = new Map<LlmConnection['providerType'], boolean>();

/**
 * Whether the runtime may route some of this connection's models through a
 * different endpoint than the connection-level base. Mirrors
 * `resolveModelRuntime`: a configured baseUrl always wins, and only without
 * one can a model-level override replace the provider default.
 */
function providerRoutesModelsElsewhere(
  connection: { providerType: LlmConnection['providerType']; baseUrl?: string },
): boolean {
  if (connection.baseUrl?.trim()) return false;
  const defaultBaseUrl = PROVIDER_DEFAULTS[connection.providerType]?.baseUrl;
  if (!defaultBaseUrl) return false;
  const cached = modelOverrideRouteCache.get(connection.providerType);
  if (cached !== undefined) return cached;
  let routes = false;
  for (const modelId of modelMetadataIdsForProvider(connection.providerType)) {
    const api = lookupModelProviderOverride(connection.providerType, modelId)?.api;
    if (api && api !== defaultBaseUrl) {
      routes = true;
      break;
    }
  }
  modelOverrideRouteCache.set(connection.providerType, routes);
  return routes;
}

/**
 * Whether a persisted endpoint embeds credentials: URL userinfo, or any query
 * parameter at all — a relay may name a credential parameter arbitrarily, so
 * the mere presence of a query string makes the value credential-shaped for
 * display. The endpoint editor uses this to gate its input behind a masked
 * state instead of prefilling the raw value into a plain text field.
 */
export function endpointCarriesCredentials(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value.trim());
    return Boolean(parsed.username || parsed.password) || parsed.search !== '';
  } catch {
    return false;
  }
}

function endpointForDisplay(value: string): string {
  if (!value) return value;
  // Base URL secrets hide in three places: userinfo, query values under
  // arbitrary key names, and (rarely) path-embedded tokens. URL parsing
  // redacts the first two deterministically; the shared redactor sweeps
  // whatever remains.
  try {
    const parsed = new URL(value);
    const carriesUserinfo = Boolean(parsed.username || parsed.password);
    parsed.username = '';
    parsed.password = '';
    // A base URL's query string has no display-safe semantics: a relay may put
    // a credential under any key name (`key`, `client_secret`, ...), so mask
    // every value and keep the key names to preserve the endpoint's shape.
    // Rebuild by hand — URLSearchParams would percent-encode `<redacted>`.
    const queryKeys = [...parsed.searchParams.keys()];
    if (queryKeys.length > 0) parsed.search = '';
    // Keep one marker so the user can still tell that the saved endpoint
    // carries embedded credentials.
    let display = carriesUserinfo
      ? parsed.href.replace(`${parsed.protocol}//`, `${parsed.protocol}//<redacted>@`)
      : parsed.href;
    if (queryKeys.length > 0) {
      display += `?${queryKeys.map((key) => `${key}=<redacted>`).join('&')}`;
    }
    return redactSecrets(display);
  } catch {
    // Persistence already validates provider base URLs. A legacy malformed
    // value still gets best-effort masking rather than disappearing.
    return redactSecrets(value);
  }
}
