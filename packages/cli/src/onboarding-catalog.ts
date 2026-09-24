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
  CATALOG_PROVIDER_TYPES,
  MODEL_API_PROTOCOL_LABELS,
  MODEL_API_PROTOCOLS,
  PROVIDER_REGISTRY,
  providerAuthSupportsApiKey,
} from '@maka/core/llm-connections';
import type { ConnectionOnboardingTarget } from '@maka/core/runtime-policy';
import type { OnboardableProvider } from './pi-tui-contracts.js';

export function listApiKeyOnboardableProviders(): OnboardableProvider[] {
  // Custom connections have no built-in base URL and stay listed: `requiresBaseUrl`
  // tells the wizard to collect an endpoint before the API key. The original
  // phase-1 wizard filtered every empty-baseUrl provider out because it had no
  // base-URL step to offer (#1254); that step exists now (#3405). Providers
  // whose endpoint is derived rather than user-supplied (cloudflare-workers-ai
  // interpolates an account id into a URL template) are still excluded — a
  // plain base-URL prompt cannot onboard them.
  return CATALOG_PROVIDER_TYPES.filter((providerType) => {
    if (!providerAuthSupportsApiKey(providerType)) return false;
    const definition = PROVIDER_REGISTRY[providerType];
    return Boolean(definition.baseUrl) || definition.category === 'custom';
  }).flatMap((providerType): OnboardableProvider[] => {
    const definition = PROVIDER_REGISTRY[providerType];
    const entry = {
      providerType,
      label: definition.label,
      requiresBaseUrl: !definition.baseUrl,
      setupMethod: 'api_key' as const,
    };
    if (providerType !== 'custom') return [entry];
    return MODEL_API_PROTOCOLS.map((defaultApiProtocol) => ({
      ...entry,
      defaultApiProtocol,
      label: `${definition.label} (${MODEL_API_PROTOCOL_LABELS[defaultApiProtocol]})`,
    }));
  });
}

export function onboardingCreateTarget(
  provider: Pick<OnboardableProvider, 'providerType' | 'defaultApiProtocol'>,
): Extract<ConnectionOnboardingTarget, { readonly kind: 'create' }> {
  return {
    kind: 'create',
    providerType: provider.providerType,
    ...(provider.defaultApiProtocol === undefined
      ? {}
      : { defaultApiProtocol: provider.defaultApiProtocol }),
  };
}
